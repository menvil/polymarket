import { Result, Ok, Err } from '@polymarket/result';
import Decimal from 'decimal.js';
import {
  InvalidMoneyError,
  ArithmeticOverflowError,
  InvalidOperandError,
  DivisionByZeroError
} from '@polymarket/errors';
import { addDecimal, subtractDecimal, multiplyDecimal, divideDecimal } from '@polymarket/math';
import { Money, SupportedCurrency } from '../core/Money';
import { MoneyInvariantViolation } from '../core/MoneyInvariantViolation';
import { ValidateFactorForMoneyMultiplication } from '../rules/ValidateFactorForMoneyMultiplication';
import { ValidateDivisorForMoneyDivision } from '../rules/ValidateDivisorForMoneyDivision';
import { MoneyErrorReason } from '../errors/MoneyErrorReason';

/**
 * Facade для безопасного создания и операций с Money - публичный API
 *
 * @remarks
 * Единая точка входа для всех операций с Money.
 * Оркестрирует Core + Math + Rules.
 *
 * **Контракт "Never Throw":**
 * ВСЕ методы MoneyService ГАРАНТИРОВАННО возвращают Result и НИКОГДА не бросают исключения.
 * Любые исключения из @polymarket/math, Core инвариантов или Rules ловятся и преобразуются в Result.Err.
 *
 * **Facade Error Contract:**
 * Любой Err из Facade содержит:
 * - context.op - название операции (верхний уровень)
 * - context.opChain - цепочка операций (внутренние op не теряются)
 * - context.amount/factor/divisor - входные параметры (если применимо)
 * - context.raw - сырой ввод (для ошибок парсинга): { field, value }
 * - context.cause - для math-исключений: { name, message, stack? } (root-cause, не перетирается)
 * - context.reason - для инвариантов Core и специальных случаев (root, не перетирается)
 * - context.currency - валюта
 *
 * **Правило возвращаемых типов:**
 * ВСЕ операции возвращают Result<T, InvalidMoneyError>
 * ОЖИДАЕМЫЕ и НЕОЖИДАННЫЕ ошибки обрабатываются через Result
 *
 * Специальные reason значения в context.reason (MoneyErrorReason enum):
 * - MoneyErrorReason.INVALID_FORMAT - ошибка парсинга значения
 * - MoneyErrorReason.NAN - значение NaN
 * - MoneyErrorReason.NON_FINITE - значение не finite (Infinity)
 * - MoneyErrorReason.EXCEEDS_MAX_AMOUNT - результат превышает максимальную сумму
 * - MoneyErrorReason.CURRENCY_MISMATCH - несовпадение валют в add/subtract
 * - MoneyErrorReason.DIVISION_BY_ZERO - деление на ноль
 * - MoneyErrorReason.UNSUPPORTED_CURRENCY - неподдерживаемая валюта
 * - MoneyErrorReason.NEGATIVE_RESULT - результат операции меньше нуля
 *
 * @example
 * ```typescript
 * import { MoneyService, MoneyErrorReason } from '@polymarket/value-objects/money';
 *
 * const result = MoneyService.create(100, 'USDC');
 * if (result.ok) {
 *   console.log(result.value.amount()); // Decimal(100)
 * } else {
 *   console.error(result.error.message);
 *   console.error(result.error.context.reason); // MoneyErrorReason.INVALID_FORMAT, etc.
 * }
 * ```
 */
export class MoneyService {
  /**
   * Извлекает структурированный cause из любой ошибки
   *
   * @param e - Ошибка (Error или unknown)
   * @returns Структурированный объект cause
   *
   * @remarks
   * - Если e instanceof Error → { name, message, stack }
   * - Иначе → { name: 'UnknownError', message: String(e) }
   */
  private static toCause(e: unknown): { name: string; message: string; stack?: string } {
    if (e instanceof Error) {
      return {
        name: e.name,
        message: e.message,
        stack: e.stack
      };
    }

    return {
      name: 'UnknownError',
      message: String(e)
    };
  }

  /**
   * Безопасно конвертирует number | string | Decimal в Decimal
   *
   * @param field - Имя поля (для структурированного raw)
   * @param input - Входное значение
   * @returns Result<Decimal, InvalidMoneyError>
   *
   * @remarks
   * Нормализует вход и корректно работает с двумя копиями decimal.js:
   * - Primitives (number, string) парсим напрямую
   * - Объекты (Decimal из другой копии) → toString() → парсим
   *
   * При ошибке парсинга → InvalidMoneyError с raw: { field, value } и cause.
   *
   * Не добавляет op в контекст - внешний код добавит через rewrap.
   */
  private static toDecimal(
    field: 'value' | 'factor' | 'divisor',
    input: number | string | Decimal
  ): Result<Decimal, InvalidMoneyError> {
    try {
      // Не пытаемся "распознать" Decimal из другой копии.
      // Нормализуем: primitives парсим напрямую, объекты — через toString().
      let normalized: number | string | undefined;

      if (typeof input === 'number' || typeof input === 'string') {
        normalized = input;
      } else {
        // input это Decimal (возможно из другой копии decimal.js)
        // Безопасно извлекаем toString если он есть
        const obj = input as unknown as { toString?: unknown };
        normalized = typeof obj.toString === 'function' ? obj.toString() : undefined;
      }

      if (normalized === undefined) {
        return Err(
          new InvalidMoneyError('Failed to normalize value: no valid toString()', {
            context: {
              raw: { field, value: String(input) },
              reason: MoneyErrorReason.INVALID_FORMAT
            }
          })
        );
      }

      // normalized точно number | string после проверки выше
      const decimal = new Decimal(normalized);
      return Ok(decimal);
    } catch (error) {
      return Err(
        new InvalidMoneyError(
          error instanceof Error ? error.message : 'Failed to parse value',
          {
            context: {
              raw: { field, value: String(input) },
              cause: this.toCause(error),
              reason: MoneyErrorReason.INVALID_FORMAT
            }
          }
        )
      );
    }
  }

  /**
   * Создаёт InvalidMoneyError для ожидаемых ошибок из @polymarket/math
   *
   * @param op - Название операции
   * @param ctx - Контекст операции (amount, factor, divisor, etc.)
   * @param e - Ошибка из math layer (ТОЛЬКО Error объекты)
   * @returns InvalidMoneyError с полным контекстом
   *
   * @remarks
   * Используется для обработки ожидаемых ошибок:
   * - InvalidOperandError
   * - ArithmeticOverflowError
   * - DivisionByZeroError
   *
   * ВАЖНО: Принимает только Error. Если это не Error - используй unexpectedError.
   */
  private static expectedMathError(
    op: string,
    ctx: Record<string, unknown>,
    e: Error
  ): InvalidMoneyError {
    const cause = this.toCause(e);
    return new InvalidMoneyError(`Money ${op} failed: ${cause.message}`, {
      context: {
        op,
        ...ctx,
        cause
      }
    });
  }

  /**
   * Создаёт InvalidMoneyError для неожиданных ошибок
   *
   * @param op - Название операции
   * @param ctx - Контекст операции
   * @param e - Неожиданная ошибка (any type)
   * @returns InvalidMoneyError с полным контекстом
   *
   * @remarks
   * Используется когда происходит неожиданная ошибка (не из известных типов).
   * Включает полный stack trace для debugging.
   */
  private static unexpectedError(
    op: string,
    ctx: Record<string, unknown>,
    e: unknown
  ): InvalidMoneyError {
    const cause = this.toCause(e);
    return new InvalidMoneyError(`Unexpected error during money ${op}`, {
      context: {
        op,
        ...ctx,
        cause
      }
    });
  }

  /**
   * Проверяет является ли ошибка ожидаемой math-ошибкой
   *
   * @param e - Ошибка для проверки
   * @returns true если это ожидаемая math-ошибка (ArithmeticOverflowError, InvalidOperandError, DivisionByZeroError)
   *
   * @remarks
   * Используется в catch блоках для централизованной классификации ошибок.
   * Проверяет как instanceof, так и name для надёжности.
   *
   * **ВАЖНО: Список ожидаемых ошибок фиксирован.**
   * Если @polymarket/math добавит новые error types, они попадут в unexpected
   * до явного добавления сюда. Это осознанное решение для безопасности.
   *
   * Текущий whitelist:
   * - ArithmeticOverflowError - переполнение при арифметике
   * - InvalidOperandError - невалидный операнд (NaN, Infinity)
   * - DivisionByZeroError - деление на ноль
   */
  private static isExpectedMathError(e: unknown): e is Error {
    return (
      e instanceof Error &&
      (e instanceof ArithmeticOverflowError ||
        e instanceof InvalidOperandError ||
        e instanceof DivisionByZeroError ||
        e.name === 'ArithmeticOverflowError' ||
        e.name === 'InvalidOperandError' ||
        e.name === 'DivisionByZeroError')
    );
  }

  /**
   * Оборачивает InvalidMoneyError с добавлением op и контекста
   *
   * @param op - Название операции (станет верхним в opChain)
   * @param ctx - Дополнительный контекст для добавления (операционные поля: amount, factor, divisor, etc)
   * @param err - Исходная InvalidMoneyError
   * @returns Новая InvalidMoneyError с объединённым контекстом
   *
   * @remarks
   * Простая перепаковка без рефлексии (никогда не бросает exception).
   *
   * Порядок мерджа:
   * 1. inner (err.context) - база из вложенной ошибки
   * 2. ctx - операционные поля (amount, factor, divisor) - перетирают inner
   * 3. op + opChain - строит цепочку операций, НЕ теряя внутренний op
   * 4. preserve root-полей: cause, reason, raw (первопричина не перетирается)
   *
   * **Root-cause semantics:**
   * - cause, reason, raw сохраняются из inner (это первопричина)
   * - opChain накапливает историю операций: [innerOp, ..., op]
   *
   * Это гарантирует:
   * - Операционный контекст (amount, factor) всегда актуален для текущего op
   * - Первопричина (cause, reason, raw) не теряется
   * - История операций сохраняется в opChain
   */
  private static rewrap(
    op: string,
    ctx: Record<string, unknown>,
    err: InvalidMoneyError
  ): InvalidMoneyError {
    const inner = (err.context ?? {}) as Record<string, unknown>;

    // Запрещаем ctx приносить root-поля (защита от случайного перетирания)
    const { cause: _c, reason: _r, raw: _raw, op: _op, opChain: _chain, ...safeCtx } = ctx;

    // 1) мерджим контекст: inner база, safeCtx сверху (без root-полей)
    const merged: Record<string, unknown> = {
      ...inner,
      ...safeCtx
    };

    // 2) opChain строим только тут (единственное место истины)
    const innerChain = Array.isArray(inner.opChain) ? inner.opChain : undefined;
    const filtered = (innerChain?.filter((x) => typeof x === 'string') as string[]) ?? [];
    const base = filtered.length > 0 ? filtered : (typeof inner.op === 'string' ? [inner.op] : []);

    merged.op = op;
    // Не добавляем op в opChain если он уже последний элемент (избегаем дублирования)
    const lastOp = base[base.length - 1];
    merged.opChain = lastOp === op ? base : [...base, op];

    // 3) root-поля сохраняем из inner, если они есть (не перетираются)
    if (inner.cause !== undefined) {
      merged.cause = inner.cause;
    }
    if (inner.reason !== undefined) {
      merged.reason = inner.reason;
    }
    if (inner.raw !== undefined) {
      merged.raw = inner.raw;
    }

    return new InvalidMoneyError(err.message, { context: merged });
  }

  /**
   * Оборачивает facade операцию в try/catch с централизованной обработкой ошибок
   *
   * @param op - Название операции
   * @param ctx - Контекст операции
   * @param fn - Функция выполняющая операцию (может включать math, create, rules)
   * @returns Result с результатом или InvalidMoneyError
   *
   * @remarks
   * Устраняет дублирование try/catch блоков во всех операциях.
   * Автоматически классифицирует ошибки как expected/unexpected.
   * Автоматически rewrap'ает InvalidMoneyError из Result.Err.
   *
   * Обрабатывает четыре типа ошибок/результатов:
   * 1. Result.Err(InvalidMoneyError) (из create/rules) → rewrap с добавлением op
   * 2. throw InvalidMoneyError (из вложенных операций) → rewrap с добавлением op
   * 3. Expected math errors (ArithmeticOverflowError, etc.) → expectedMathError
   * 4. Unexpected errors → unexpectedError
   *
   * @example
   * ```typescript
   * return this.wrapOp('add', { a: a.amount().toString(), b: b.amount().toString() }, () => {
   *   const sum = addDecimal(a.amount(), b.amount());
   *   return this.createFromDecimal(sum, a.currency(), 'add', {});
   * });
   * ```
   */
  private static wrapOp<T>(
    op: string,
    ctx: Record<string, unknown>,
    fn: () => Result<T, InvalidMoneyError>
  ): Result<T, InvalidMoneyError> {
    try {
      const result = fn();
      // Если fn() вернул Err с InvalidMoneyError - rewrap автоматически
      if (!result.ok) {
        return Err(this.rewrap(op, ctx, result.error));
      }
      return result;
    } catch (e) {
      // Если кто-то бросил InvalidMoneyError - rewrap с добавлением контекста
      if (e instanceof InvalidMoneyError) {
        return Err(this.rewrap(op, ctx, e));
      }
      // Ожидаемые math ошибки - прогоняем через rewrap для opChain
      if (this.isExpectedMathError(e)) {
        return Err(this.rewrap(op, ctx, this.expectedMathError(op, ctx, e)));
      }
      // Неожиданные ошибки - прогоняем через rewrap для opChain
      return Err(this.rewrap(op, ctx, this.unexpectedError(op, ctx, e)));
    }
  }

  /**
   * Создаёт Money с обработкой через Result.
   *
   * @param value - Сумма (number, string, Decimal)
   * @param currency - Валюта (default 'USDC')
   * @returns Result<Money, InvalidMoneyError>
   * @throws Никогда - все ошибки оборачиваются в Result
   *
   * @remarks
   * ПУБЛИЧНЫЙ способ создания Money.
   * Возвращает Result вместо исключений.
   *
   * Процесс:
   * 1. Парсит в Decimal через toDecimal('value', value)
   * 2. Вызывает createFromDecimal() (проверит инварианты)
   *
   * Обработка ошибок:
   * - Parse fail (toDecimal error) → InvalidMoneyError(reason: 'INVALID_FORMAT', raw: { field, value })
   * - Invariant fail (MoneyInvariantViolation) → InvalidMoneyError с reason (EXCEEDS_MAX_AMOUNT, NON_FINITE, NAN)
   *
   * @example
   * ```typescript
   * const result = MoneyService.create(100);
   * if (result.ok) {
   *   console.log(result.value.amount());
   * }
   * ```
   */
  public static create(
    value: number | string | Decimal,
    currency: SupportedCurrency = 'USDC'
  ): Result<Money, InvalidMoneyError> {
    // Безопасный парсинг value через toDecimal
    const decimalResult = this.toDecimal('value', value);
    if (!decimalResult.ok) {
      // raw уже внутри err.context.raw от toDecimal
      return Err(this.rewrap('create', { currency }, decimalResult.error));
    }

    // Создание через createFromDecimal (проверит инварианты)
    return this.createFromDecimal(decimalResult.value, currency, 'create', {});
  }

  /**
   * Создаёт Money из Decimal с проверкой инвариантов
   *
   * @param decimal - Значение amount (уже распарсенный Decimal)
   * @param currency - Валюта
   * @returns Result<Money, InvalidMoneyError>
   *
   * @remarks
   * Внутренний helper для использования в wrapOp и math операциях.
   * НЕ парсит - принимает готовый Decimal.
   * Только проверяет инварианты через Money.fromDecimal().
   *
   * Ловит MoneyInvariantViolation и мапит через mapInvariantToOverflow:
   * - EXCEEDS_MAX_AMOUNT, NON_FINITE, NAN → ArithmeticOverflowError
   * - Остальные → InvalidMoneyError (unexpected)
   *
   * Используется в:
   * - add/subtract/multiply/divide для создания результата
   * - create() после парсинга через toDecimal
   */
  private static createFromDecimal(
    decimal: Decimal,
    currency: SupportedCurrency,
    op: string = 'createFromDecimal',
    ctx: Record<string, unknown> = {}
  ): Result<Money, InvalidMoneyError> {
    try {
      return Ok(Money.fromDecimal(decimal, currency));
    } catch (error) {
      if (error instanceof MoneyInvariantViolation) {
        return this.mapInvariantToOverflow(op, {
          ...ctx,
          value: decimal.toString(),
          currency
        }, error);
      }

      // Unexpected error - возвращаем InvalidMoneyError
      return Err(this.unexpectedError(op, { value: decimal.toString(), currency, ...ctx }, error));
    }
  }

  /**
   * Мапит MoneyInvariantViolation → InvalidMoneyError
   *
   * @param op - Операция (add/subtract/multiply/divide)
   * @param ctx - Контекст (a, b, result, amount, factor, divisor, etc.)
   * @param e - MoneyInvariantViolation из Money.fromDecimal()
   * @returns Err(InvalidMoneyError) с reason в context
   *
   * @remarks
   * DRY helper для всех math операций.
   * Все типы MoneyInvariantViolation мапятся в InvalidMoneyError с сохранением reason.
   *
   * **ВАЖНО:** НЕ throw - всегда возвращает Result.
   */
  private static mapInvariantToOverflow(
    op: string,
    ctx: Record<string, unknown>,
    e: MoneyInvariantViolation
  ): Result<never, InvalidMoneyError> {
    const { reason } = e;
    // Все типы инвариантных нарушений мапим в InvalidMoneyError с reason
    return Err(
      new InvalidMoneyError(`Money ${op} result is invalid: ${reason}`, {
        context: {
          op,
          ...ctx,
          reason
        }
      })
    );
  }

  /**
   * Складывает две суммы.
   *
   * @param a - Первая
   * @param b - Вторая
   * @returns Result<Money, InvalidMoneyError>
   * @throws Никогда - все ошибки оборачиваются в Result
   *
   * @remarks
   * Процесс:
   * 1. Проверка валют (ДО wrapOp - это не math error)
   * 2. Операция через @polymarket/math
   * 3. Money.fromDecimal() (проверит инварианты через createFromDecimal)
   * 4. Маппинг через mapInvariantToOverflow
   *
   * Service НЕ проверяет MAX руками.
   *
   * @example
   * ```typescript
   * const result = MoneyService.add(Money.of(100), Money.of(50));
   * if (result.ok) {
   *   console.log(result.value.amount().toNumber()); // 150
   * }
   * ```
   */
  public static add(
    a: Money,
    b: Money
  ): Result<Money, InvalidMoneyError> {
    // Проверка валют ДО wrapOp (это не math error)
    if (!a.hasSameCurrency(b)) {
      return Err(
        new InvalidMoneyError('Cannot add Money with different currencies', {
          context: {
            op: 'add',
            reason: MoneyErrorReason.CURRENCY_MISMATCH,
            expected: a.currency(),
            actual: b.currency()
          }
        })
      );
    }

    const ctx = { a: a.amount().toString(), b: b.amount().toString(), currency: a.currency() };
    return this.wrapOp('add', ctx, () => {
      const sum = addDecimal(a.amount(), b.amount());
      return this.createFromDecimal(sum, a.currency(), 'add', {});
    });
  }

  /**
   * Вычитает одну сумму из другой.
   *
   * @param a - Уменьшаемое
   * @param b - Вычитаемое
   * @returns Result<Money, InvalidMoneyError>
   * @throws Никогда - все ошибки оборачиваются в Result
   *
   * @remarks
   * Процесс:
   * 1. Проверка валют (ДО wrapOp - это не math error)
   * 2. Операция через @polymarket/math
   * 3. Money.fromDecimal() (проверит инварианты через createFromDecimal)
   * 4. Маппинг через mapInvariantToOverflow
   *
   * @example
   * ```typescript
   * const result = MoneyService.subtract(Money.of(100), Money.of(30));
   * if (result.ok) {
   *   console.log(result.value.amount().toNumber()); // 70
   * }
   * ```
   */
  public static subtract(
    a: Money,
    b: Money
  ): Result<Money, InvalidMoneyError> {
    // Проверка валют ДО wrapOp (это не math error)
    if (!a.hasSameCurrency(b)) {
      return Err(
        new InvalidMoneyError('Cannot subtract Money with different currencies', {
          context: {
            op: 'subtract',
            reason: MoneyErrorReason.CURRENCY_MISMATCH,
            expected: a.currency(),
            actual: b.currency()
          }
        })
      );
    }

    const ctx = { a: a.amount().toString(), b: b.amount().toString(), currency: a.currency() };
    return this.wrapOp('subtract', ctx, () => {
      const diff = subtractDecimal(a.amount(), b.amount());
      return this.createFromDecimal(diff, a.currency(), 'subtract', {});
    });
  }

  /**
   * Умножает сумму на фактор.
   *
   * @param m - Money
   * @param factor - Множитель (number, string, или Decimal)
   * @returns Result<Money, InvalidMoneyError>
   * @throws Никогда - все ошибки оборачиваются в Result
   *
   * @remarks
   * Проверяет валидность фактора (не NaN, finite).
   * Service проверяет INPUTS, не результат (делегирует core).
   *
   * Алгоритм:
   * 1. Парсинг factor через toDecimal('factor', factor)
   * 2. Валидация factor через ValidateFactorForMoneyMultiplication (isNaN, isFinite)
   * 3. Умножение через multiplyDecimal() из @polymarket/math
   * 4. Создание Money из результата
   *
   * Все ошибки оборачиваются в Result.
   *
   * @example
   * ```typescript
   * const result = MoneyService.multiply(Money.of(100), 1.5);
   * if (result.ok) {
   *   console.log(result.value.amount().toNumber()); // 150
   * }
   * ```
   */
  public static multiply(
    m: Money,
    factor: number | string | Decimal
  ): Result<Money, InvalidMoneyError> {
    // Безопасный парсинг factor через toDecimal
    const factorResult = this.toDecimal('factor', factor);
    if (!factorResult.ok) {
      return Err(
        this.rewrap('multiply', {
          amount: m.amount().toString(),
          factor: String(factor),
          currency: m.currency()
        }, factorResult.error)
      );
    }

    const factorDecimal = factorResult.value;

    // Валидация через rule (проверяет isNaN, isFinite)
    const validateResult = ValidateFactorForMoneyMultiplication.check(factorDecimal);
    if (!validateResult.ok) {
      return Err(
        this.rewrap('multiply', {
          amount: m.amount().toString(),
          factor: factorDecimal.toString(),
          currency: m.currency()
        }, validateResult.error)
      );
    }

    // Умножение с обработкой ожидаемых арифметических исключений
    const ctx = {
      amount: m.amount().toString(),
      factor: factorDecimal.toString(),
      currency: m.currency()
    };

    return this.wrapOp('multiply', ctx, () => {
      const product = multiplyDecimal(m.amount(), factorDecimal);
      return this.createFromDecimal(product, m.currency(), 'multiply', {});
    });
  }

  /**
   * Делит сумму на делитель.
   *
   * @param m - Money
   * @param divisor - Делитель (number, string, или Decimal)
   * @returns Result<Money, InvalidMoneyError>
   * @throws Никогда - все ошибки оборачиваются в Result
   *
   * @remarks
   * Проверяет валидность делителя (не NaN, finite, не ноль).
   * Service проверяет INPUTS, не результат (делегирует core).
   *
   * Алгоритм:
   * 1. Парсинг divisor через toDecimal('divisor', divisor)
   * 2. Валидация divisor через ValidateDivisorForMoneyDivision (isNaN, isFinite, isZero)
   * 3. Деление через divideDecimal() из @polymarket/math
   * 4. Создание Money из результата
   *
   * Все ошибки оборачиваются в Result.
   *
   * @example
   * ```typescript
   * const result = MoneyService.divide(Money.of(100), 2);
   * if (result.ok) {
   *   console.log(result.value.amount().toNumber()); // 50
   * }
   * ```
   */
  public static divide(
    m: Money,
    divisor: number | string | Decimal
  ): Result<Money, InvalidMoneyError> {
    // Безопасный парсинг divisor через toDecimal
    const divisorResult = this.toDecimal('divisor', divisor);
    if (!divisorResult.ok) {
      return Err(
        this.rewrap('divide', {
          amount: m.amount().toString(),
          divisor: String(divisor),
          currency: m.currency()
        }, divisorResult.error)
      );
    }

    const divisorDecimal = divisorResult.value;

    // Валидация через rule
    const validateResult = ValidateDivisorForMoneyDivision.check(divisorDecimal);
    if (!validateResult.ok) {
      return Err(
        this.rewrap('divide', {
          amount: m.amount().toString(),
          divisor: divisorDecimal.toString(),
          currency: m.currency()
        }, validateResult.error)
      );
    }

    // Деление с обработкой ожидаемых арифметических исключений
    const ctx = {
      amount: m.amount().toString(),
      divisor: divisorDecimal.toString(),
      currency: m.currency()
    };

    return this.wrapOp('divide', ctx, () => {
      const quotient = divideDecimal(m.amount(), divisorDecimal);
      return this.createFromDecimal(quotient, m.currency(), 'divide', {});
    });
  }
}
