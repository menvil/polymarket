import { Result, Ok, Err } from '@polymarket/result';
import { Quantity, QuantityInvariantViolation } from '../core/Quantity.js';
import {
  InvalidQuantityError,
  DivisionByZeroError,
  ArithmeticOverflowError,
  InvalidOperandError
} from '@polymarket/errors';
import { ValidateResultNonNegative } from '../rules/ValidateResultNonNegative.js';
import { ValidateFactorForQuantityMultiplication } from '../rules/ValidateFactorForQuantityMultiplication.js';
import { ValidateDivisorForQuantityDivision } from '../rules/ValidateDivisorForQuantityDivision.js';
import { ValidateStepSizeForQuantity } from '../rules/ValidateStepSizeForQuantity.js';
import { addDecimal, subtractDecimal, multiplyDecimal, divideDecimal, roundToTick } from '@polymarket/math';
import Decimal from 'decimal.js';

/**
 * Фасад для работы с Quantity
 *
 * @remarks
 * Единая точка входа для всех операций с количествами.
 * Оркестрирует Core + Math + Rules.
 *
 * **Контракт "Never Throw":**
 * ВСЕ методы QuantityService ГАРАНТИРОВАННО возвращают Result и НИКОГДА не бросают исключения.
 * Любые исключения из @polymarket/math, Core инвариантов или Rules ловятся и преобразуются в Result.Err.
 *
 * **Facade Error Contract:**
 * Любой Err из Facade содержит:
 * - context.op - название операции (верхний уровень)
 * - context.opChain - цепочка операций (внутренние op не теряются)
 * - context.quantity - входной quantity (если применимо)
 * - context.divisor|factor|stepSize - входные параметры (если применимо)
 * - context.raw - сырой ввод (для ошибок парсинга): { field, value }
 * - context.cause - для math-исключений: { name, message, stack? } (root-cause, не перетирается)
 * - context.reason - для инвариантов Core (root, не перетирается)
 *
 * **Правило возвращаемых типов:**
 * ВСЕ операции возвращают Result<T, InvalidQuantityError>
 * ОЖИДАЕМЫЕ и НЕОЖИДАННЫЕ ошибки обрабатываются через Result
 */
export class QuantityService {
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
   * Создаёт InvalidQuantityError для ожидаемых ошибок из @polymarket/math
   *
   * @param op - Название операции (используется только для message formatting)
   * @param ctx - Контекст операции (quantity, factor, divisor, etc.)
   * @param e - Ошибка из math layer (ТОЛЬКО Error объекты)
   * @returns InvalidQuantityError с полным контекстом
   *
   * @remarks
   * Используется для обработки ожидаемых ошибок:
   * - InvalidOperandError
   * - ArithmeticOverflowError
   * - DivisionByZeroError
   *
   * ВАЖНО:
   * - Принимает только Error. Если это не Error - используй unexpectedError.
   * - НЕ добавляет op в context - rewrap будет единственным источником op и opChain
   */
  private static expectedMathError(
    op: string,
    ctx: Record<string, unknown>,
    e: Error
  ): InvalidQuantityError {
    const cause = this.toCause(e);
    return new InvalidQuantityError(`${op} failed: ${cause.message}`, {
      context: {
        ...ctx,
        cause
      }
    });
  }

  /**
   * Создаёт InvalidQuantityError для неожиданных ошибок
   *
   * @param op - Название операции (используется только для message formatting)
   * @param ctx - Контекст операции
   * @param e - Неожиданная ошибка (any type)
   * @returns InvalidQuantityError с полным контекстом
   *
   * @remarks
   * Используется когда происходит неожиданная ошибка (не из известных типов).
   * Включает полный stack trace для debugging.
   * НЕ добавляет op в context - rewrap будет единственным источником op и opChain
   */
  private static unexpectedError(
    op: string,
    ctx: Record<string, unknown>,
    e: unknown
  ): InvalidQuantityError {
    const cause = this.toCause(e);
    return new InvalidQuantityError(`Unexpected error during quantity ${op}`, {
      context: {
        ...ctx,
        cause
      }
    });
  }

  /**
   * Обёртывает InvalidQuantityError с добавлением op и контекста
   *
   * @param op - Название операции (станет верхним в opChain)
   * @param ctx - Дополнительный контекст для добавления (операционные поля: quantity, factor, divisor, etc)
   * @param err - Исходная ошибка
   * @returns Новая InvalidQuantityError с объединённым контекстом
   *
   * @remarks
   * Простая перепаковка без рефлексии (никогда не бросает exception).
   *
   * Порядок мерджа:
   * 1. inner (err.context) - база из вложенной ошибки
   * 2. ctx - операционные поля (quantity, factor, divisor) - перетирают inner
   * 3. op + opChain - строит цепочку операций, НЕ теряя внутренний op
   * 4. preserve root-полей: cause, reason, raw (первопричина не перетирается)
   *
   * **Root-cause semantics:**
   * - cause, reason, raw сохраняются из inner (это первопричина)
   * - opChain накапливает историю операций: [innerOp, ..., op]
   *
   * Это гарантирует:
   * - Операционный контекст (quantity, factor) всегда актуален для текущего op
   * - Первопричина (cause, reason, raw) не теряется
   * - История операций сохраняется в opChain
   */
  private static rewrap(
    op: string,
    ctx: Record<string, unknown>,
    err: InvalidQuantityError
  ): InvalidQuantityError {
    const inner = err.context ?? {};

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
    merged.opChain = [...base, op];

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

    return new InvalidQuantityError(err.message, { context: merged });
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
   * Оборачивает facade операцию в try/catch с централизованной обработкой ошибок
   *
   * @param op - Название операции
   * @param ctx - Контекст операции
   * @param fn - Функция выполняющая операцию (может включать math, create, rules)
   * @returns Result с результатом или InvalidQuantityError
   *
   * @remarks
   * Устраняет дублирование try/catch блоков во всех операциях.
   * Автоматически классифицирует ошибки как expected/unexpected.
   * Автоматически rewrap'ает InvalidQuantityError из Result.Err.
   *
   * Обрабатывает четыре типа ошибок/результатов:
   * 1. Result.Err(InvalidQuantityError) (из create/rules) → rewrap с добавлением op
   * 2. throw InvalidQuantityError (из вложенных операций) → rewrap с добавлением op
   * 3. Expected math errors (ArithmeticOverflowError, etc.) → expectedMathError
   * 4. Unexpected errors → unexpectedError
   *
   * @example
   * ```typescript
   * return this.wrapOp('add', { quantity1: '10', quantity2: '20' }, () => {
   *   const sum = addDecimal(qty1.value(), qty2.value());
   *   return this.create(sum); // rewrap автоматический, не нужен ручной
   * });
   * ```
   */
  private static wrapOp<T>(
    op: string,
    ctx: Record<string, unknown>,
    fn: () => Result<T, InvalidQuantityError>
  ): Result<T, InvalidQuantityError> {
    try {
      const result = fn();
      // Если fn() вернул Err с InvalidQuantityError - rewrap автоматически
      if (!result.ok) {
        return Err(this.rewrap(op, ctx, result.error));
      }
      return result;
    } catch (e) {
      // Если кто-то бросил InvalidQuantityError - rewrap с добавлением контекста
      if (e instanceof InvalidQuantityError) {
        return Err(this.rewrap(op, ctx, e));
      }
      // Ожидаемые math ошибки - создаём новую ошибку и оборачиваем через rewrap
      if (this.isExpectedMathError(e)) {
        return Err(this.rewrap(op, ctx, this.expectedMathError(op, ctx, e)));
      }
      // Неожиданные ошибки - создаём новую ошибку и оборачиваем через rewrap
      return Err(this.rewrap(op, ctx, this.unexpectedError(op, ctx, e)));
    }
  }

  /**
   * Безопасно конвертирует number | string | Decimal в Decimal
   *
   * @param field - Имя поля (для структурированного raw)
   * @param input - Входное значение
   * @returns Result<Decimal, InvalidQuantityError>
   *
   * @remarks
   * Нормализует вход и корректно работает с двумя копиями decimal.js:
   * - Primitives (number, string) парсим напрямую
   * - Объекты (Decimal из другой копии) → toString() → парсим
   *
   * При ошибке парсинга → InvalidQuantityError с raw: { field, value } и cause.
   *
   * Не добавляет op в контекст - внешний код добавит через rewrap.
   */
  private static toDecimal(
    field: 'value' | 'factor' | 'divisor' | 'stepSize',
    input: number | string | Decimal
  ): Result<Decimal, InvalidQuantityError> {
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
          new InvalidQuantityError('Failed to normalize value: no valid toString()', {
            context: {
              raw: { field, value: String(input) }
            }
          })
        );
      }

      // normalized точно number | string после проверки выше
      const decimal = new Decimal(normalized);
      return Ok(decimal);
    } catch (error) {
      return Err(
        new InvalidQuantityError(
          error instanceof Error ? error.message : 'Failed to parse value',
          {
            context: {
              raw: { field, value: String(input) },
              cause: this.toCause(error)
            }
          }
        )
      );
    }
  }

  /**
   * Создаёт Quantity с валидацией инвариантов
   *
   * @remarks
   * ПУБЛИЧНЫЙ способ создания Quantity.
   * Возвращает Result вместо исключений.
   *
   * Core инварианты проверяются автоматически через Quantity.fromDecimal():
   * - finite (не NaN, не Infinity)
   * - non-negative (>= 0)
   *
   * Использует toDecimal() для надёжного парсинга без instanceof.
   * Гарантирует Result - никогда не бросает исключения.
   *
   * @param value - Значение для создания (number, string, или Decimal)
   * @returns Result<Quantity, InvalidQuantityError>
   *
   * @example
   * ```typescript
   * const result = QuantityService.create(10);
   * if (!result.ok) {
   *   console.error(result.error.context.op); // 'create'
   * }
   * const qty = result.value;
   * ```
   */
  public static create(value: number | string | Decimal): Result<Quantity, InvalidQuantityError> {
    // Безопасный парсинг value через toDecimal
    const decimalResult = this.toDecimal('value', value);
    if (!decimalResult.ok) {
      // raw уже внутри err.context.raw от toDecimal
      return Err(this.rewrap('create', {}, decimalResult.error));
    }

    try {
      // ВАЖНО: Core получает уже Decimal -> только проверка инвариантов, не парсинг
      const quantity = Quantity.fromDecimal(decimalResult.value);
      return Ok(quantity);
    } catch (error) {
      // QuantityInvariantViolation - доменные ограничения Core
      if (error instanceof QuantityInvariantViolation) {
        return Err(
          new InvalidQuantityError(error.message, {
            context: {
              op: 'create',
              raw: { field: 'value', value: String(value) },
              value: decimalResult.value.toString(),
              reason: error.reason
            }
          })
        );
      }

      // Неожиданная ошибка - unexpectedError создаёт базовую ошибку с cause, rewrap добавляет op
      return Err(
        this.rewrap('create', { value: String(value) }, this.unexpectedError('create', {}, error))
      );
    }
  }

  /**
   * Складывает два количества
   *
   * @remarks
   * Возвращает Result потому что результат может быть non-finite (overflow → Infinity).
   * Оркестрирует: сложение через math → создание Quantity через create() (проверит инварианты)
   *
   * Обработка ошибок:
   * 1. Сложение через addDecimal() (может бросить InvalidOperandError, ArithmeticOverflowError)
   * 2. Создание Quantity через create()
   *
   * Все исключения ловятся и мапятся в Result.Err.
   * Метод никогда не бросает исключения.
   *
   * @param qty1 - Первое количество
   * @param qty2 - Второе количество
   * @returns Result<Quantity, InvalidQuantityError>
   *
   * @example
   * ```typescript
   * const result = QuantityService.add(qty1, qty2);
   * if (!result.ok) {
   *   console.error(result.error.context.op); // 'add'
   * }
   * ```
   */
  public static add(qty1: Quantity, qty2: Quantity): Result<Quantity, InvalidQuantityError> {
    const ctx = { quantity1: qty1.value().toString(), quantity2: qty2.value().toString() };
    return this.wrapOp('add', ctx, () => {
      const sum = addDecimal(qty1.value(), qty2.value());
      return this.create(sum);
    });
  }

  /**
   * Вычитает quantity с проверкой неотрицательности
   *
   * @remarks
   * Оркестрирует: вычитание → валидация non-negative → создание Quantity
   *
   * Обработка ошибок:
   * 1. Вычитание через subtractDecimal() (может бросить InvalidOperandError, ArithmeticOverflowError)
   * 2. Валидация через ValidateResultNonNegative
   * 3. Создание Quantity через create()
   *
   * Все исключения ловятся и мапятся в Result.Err.
   * Метод никогда не бросает исключения.
   *
   * @param qty1 - Уменьшаемое
   * @param qty2 - Вычитаемое
   * @returns Result<Quantity, InvalidQuantityError>
   *
   * @example
   * ```typescript
   * const result = QuantityService.subtract(qty1, qty2);
   * if (!result.ok) {
   *   console.error(result.error.context.op); // 'subtract'
   * }
   * ```
   */
  public static subtract(
    qty1: Quantity,
    qty2: Quantity
  ): Result<Quantity, InvalidQuantityError> {
    const ctx = { quantity1: qty1.value().toString(), quantity2: qty2.value().toString() };
    return this.wrapOp('subtract', ctx, () => {
      const diff = subtractDecimal(qty1.value(), qty2.value());

      const validateResult = ValidateResultNonNegative.check(diff);
      if (!validateResult.ok) {
        // wrapOp автоматически сделает rewrap для любого Err результата
        return Err(validateResult.error);
      }

      return this.create(diff);
    });
  }

  /**
   * Умножает quantity на коэффициент
   *
   * @remarks
   * Оркестрирует: парсинг factor → валидация → умножение → создание Quantity
   * Гарантирует Result - парсинг Decimal обёрнут в toDecimal()
   *
   * @param quantity - Количество для умножения
   * @param factor - Коэффициент (number, string, или Decimal - парсится безопасно)
   * @returns Result<Quantity, InvalidQuantityError>
   *
   * @example
   * ```typescript
   * const result = QuantityService.multiply(qty, 2);
   * if (!result.ok) {
   *   console.error(result.error.context.op); // 'multiply'
   *   console.error(result.error.context.factor); // '2'
   * }
   * ```
   */
  public static multiply(
    quantity: Quantity,
    factor: number | string | Decimal
  ): Result<Quantity, InvalidQuantityError> {
    // Безопасный парсинг factor через toDecimal
    const factorResult = this.toDecimal('factor', factor);
    if (!factorResult.ok) {
      return Err(
        this.rewrap('multiply', {
          quantity: quantity.value().toString(),
          factor: String(factor)
        }, factorResult.error)
      );
    }

    const factorDecimal = factorResult.value;

    // Валидация через rule (проверяет isNaN, isFinite)
    const validateResult = ValidateFactorForQuantityMultiplication.check(factorDecimal);
    if (!validateResult.ok) {
      return Err(
        this.rewrap('multiply', {
          quantity: quantity.value().toString(),
          factor: factorDecimal.toString()
        }, validateResult.error)
      );
    }

    // Умножение с обработкой ожидаемых арифметических исключений
    const ctx = {
      quantity: quantity.value().toString(),
      factor: factorDecimal.toString()
    };

    return this.wrapOp('multiply', ctx, () => {
      const result = multiplyDecimal(quantity.value(), factorDecimal);
      return this.create(result);
    });
  }

  /**
   * Делит quantity на делитель с проверкой
   *
   * @param quantity - Количество для деления
   * @param divisor - Делитель (number, string, или Decimal - парсится безопасно)
   * @returns Result<Quantity, InvalidQuantityError>
   * @throws Никогда - все ошибки оборачиваются в Result
   *
   * @remarks
   * Единый контракт обработки ошибок - все ошибки оборачиваются в Result:
   * - Парсинг divisor → InvalidQuantityError
   * - Валидация divisor → InvalidQuantityError
   * - DivisionByZeroError, InvalidOperandError, ArithmeticOverflowError → InvalidQuantityError с причиной в context.cause
   * - Неожиданные ошибки → InvalidQuantityError с полным контекстом
   * - Результат вне диапазона → InvalidQuantityError
   *
   * Алгоритм:
   * 1. Парсинг divisor в Decimal через toDecimal()
   * 2. Валидация через ValidateDivisorForQuantityDivision (isNaN, isFinite, isZero)
   * 3. Деление через divideDecimal() из @polymarket/math
   * 4. Создание Quantity из результата
   *
   * Все исключения ловятся и мапятся в Result.Err.
   * Метод никогда не бросает исключения.
   *
   * @example
   * ```typescript
   * const result = QuantityService.divide(qty, 2);
   * if (!result.ok) {
   *   console.error(result.error.context.op); // 'divide'
   *   console.error(result.error.context.cause); // { name, message } для исключений
   * }
   * ```
   */
  public static divide(
    quantity: Quantity,
    divisor: number | string | Decimal
  ): Result<Quantity, InvalidQuantityError> {
    // Безопасный парсинг divisor через toDecimal
    const divisorResult = this.toDecimal('divisor', divisor);
    if (!divisorResult.ok) {
      return Err(
        this.rewrap('divide', {
          quantity: quantity.value().toString(),
          divisor: String(divisor)
        }, divisorResult.error)
      );
    }

    const divisorDecimal = divisorResult.value;

    // Валидация через rule
    const validateResult = ValidateDivisorForQuantityDivision.check(divisorDecimal);
    if (!validateResult.ok) {
      return Err(
        this.rewrap('divide', {
          quantity: quantity.value().toString(),
          divisor: divisorDecimal.toString()
        }, validateResult.error)
      );
    }

    // Делим с обработкой ожидаемых арифметических исключений
    const ctx = {
      quantity: quantity.value().toString(),
      divisor: divisorDecimal.toString()
    };

    return this.wrapOp('divide', ctx, () => {
      const result = divideDecimal(quantity.value(), divisorDecimal);
      return this.create(result);
    });
  }

  /**
   * Округляет до шага (step)
   *
   * @remarks
   * Оркестрирует: валидация stepSize → округление → создание Quantity
   *
   * Обработка ошибок:
   * 1. Парсинг stepSize через toDecimal()
   * 2. Валидация через ValidateStepSizeForQuantity
   * 3. Округление через roundToTick() (может бросить InvalidOperandError, ArithmeticOverflowError)
   * 4. Создание Quantity через create()
   *
   * Все исключения ловятся и мапятся в Result.Err.
   * Метод никогда не бросает исключения.
   *
   * @param quantity - Количество для округления
   * @param stepSize - Размер шага для округления (number, string, или Decimal)
   * @param roundingMode - Режим округления (по умолчанию ROUND_HALF_UP)
   * @returns Result<Quantity, InvalidQuantityError>
   *
   * @example
   * ```typescript
   * const result = QuantityService.roundToStep(qty, 0.01);
   * if (!result.ok) {
   *   console.error(result.error.context.op); // 'roundToStep'
   * }
   * ```
   */
  public static roundToStep(
    quantity: Quantity,
    stepSize: number | string | Decimal,
    roundingMode: Decimal.Rounding = Decimal.ROUND_HALF_UP
  ): Result<Quantity, InvalidQuantityError> {
    // Безопасный парсинг stepSize через toDecimal
    const stepSizeResult = this.toDecimal('stepSize', stepSize);
    if (!stepSizeResult.ok) {
      return Err(
        this.rewrap('roundToStep', {
          quantity: quantity.value().toString(),
          stepSize: String(stepSize)
        }, stepSizeResult.error)
      );
    }

    const stepSizeDecimal = stepSizeResult.value;

    // Валидация через rule
    const validateResult = ValidateStepSizeForQuantity.check(stepSizeDecimal);
    if (!validateResult.ok) {
      return Err(
        this.rewrap('roundToStep', {
          quantity: quantity.value().toString(),
          stepSize: stepSizeDecimal.toString()
        }, validateResult.error)
      );
    }

    // Округление через math layer
    const ctx = {
      quantity: quantity.value().toString(),
      stepSize: stepSizeDecimal.toString()
    };

    return this.wrapOp('roundToStep', ctx, () => {
      const rounded = roundToTick(quantity.value(), stepSizeDecimal, roundingMode);
      return this.create(rounded);
    });
  }
}
