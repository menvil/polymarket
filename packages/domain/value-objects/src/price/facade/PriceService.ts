import { Result, Ok, Err } from '@polymarket/result';
import {
  InvalidPriceError,
  ArithmeticOverflowError,
  InvalidOperandError,
  DivisionByZeroError
} from '@polymarket/errors';
import { Price, PriceInvariantViolation } from '../core/Price.js';
import { ValidateTickSizeMultipleOfBaseTick } from '../rules/ValidateTickSizeMultipleOfBaseTick.js';
import { ValidateAligned } from '../rules/ValidateAligned.js';
import { ValidateFactorForPriceMultiplication } from '../rules/ValidateFactorForPriceMultiplication.js';
import { ValidateDivisorForPriceDivision } from '../rules/ValidateDivisorForPriceDivision.js';
import {
  addDecimal,
  subtractDecimal,
  multiplyDecimal,
  divideDecimal,
  roundToTick,
  floorToTick,
  ceilToTick
} from '@polymarket/math';
import Decimal from 'decimal.js';

/**
 * Фасад для работы с Price - публичный API
 *
 * @remarks
 * Единая точка входа для всех операций с ценами.
 * Оркестрирует Core + Math + Rules.
 *
 * **Контракт "Never Throw":**
 * ВСЕ методы PriceService ГАРАНТИРОВАННО возвращают Result и НИКОГДА не бросают исключения.
 * Любые исключения из @polymarket/math, Core инвариантов или Rules ловятся и преобразуются в Result.Err.
 *
 * **Facade Error Contract:**
 * Любой Err из Facade содержит:
 * - context.op - название операции (верхний уровень)
 * - context.opChain - цепочка операций (внутренние op не теряются)
 * - context.price/dividend - входная цена (если применимо)
 * - context.divisor|factor|tickSize - входные параметры (если применимо)
 * - context.raw - сырой ввод (для ошибок парсинга): { field, value }
 * - context.cause - для math-исключений: { name, message, stack? } (root-cause, не перетирается)
 * - context.reason - для инвариантов Core (root, не перетирается)
 *
 * **Правило возвращаемых типов:**
 * ВСЕ операции возвращают Result<T, InvalidPriceError>
 * ОЖИДАЕМЫЕ и НЕОЖИДАННЫЕ ошибки обрабатываются через Result
 *
 * @example
 * ```typescript
 * import { PriceService } from '@polymarket/value-objects/price';
 *
 * const result = PriceService.create(0.5);
 * if (result.ok) {
 *   console.log(result.value.toNumber()); // 0.5
 * } else {
 *   console.error(result.error.message);
 * }
 * ```
 */
export class PriceService {
  /**
   * Константа для арифметических операций - избегаем создания new Decimal(1) каждый раз
   */
  private static readonly ONE = new Decimal(1);

  /**
   * Константа для арифметических операций - избегаем создания new Decimal(2) каждый раз
   */
  private static readonly TWO = new Decimal(2);

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
   * Создаёт InvalidPriceError для ожидаемых ошибок из @polymarket/math
   *
   * @param op - Название операции (используется только для message formatting)
   * @param ctx - Контекст операции (price, factor, divisor, etc.)
   * @param e - Ошибка из math layer (ТОЛЬКО Error объекты)
   * @returns InvalidPriceError с полным контекстом
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
  ): InvalidPriceError {
    const cause = this.toCause(e);
    return new InvalidPriceError(`Price ${op} failed: ${cause.message}`, {
      context: {
        ...ctx,
        cause
      }
    });
  }

  /**
   * Создаёт InvalidPriceError для неожиданных ошибок
   *
   * @param op - Название операции (используется только для message formatting)
   * @param ctx - Контекст операции
   * @param e - Неожиданная ошибка (any type)
   * @returns InvalidPriceError с полным контекстом
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
  ): InvalidPriceError {
    const cause = this.toCause(e);
    return new InvalidPriceError(`Unexpected error during price ${op}`, {
      context: {
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
   * Оборачивает facade операцию в try/catch с централизованной обработкой ошибок
   *
   * @param op - Название операции
   * @param ctx - Контекст операции
   * @param fn - Функция выполняющая операцию (может включать math, create, rules)
   * @returns Result с результатом или InvalidPriceError
   *
   * @remarks
   * Устраняет дублирование try/catch блоков во всех операциях.
   * Автоматически классифицирует ошибки как expected/unexpected.
   * Автоматически rewrap'ает InvalidPriceError из Result.Err.
   *
   * Обрабатывает четыре типа ошибок/результатов:
   * 1. Result.Err(InvalidPriceError) (из create/rules) → rewrap с добавлением op
   * 2. throw InvalidPriceError (из вложенных операций) → rewrap с добавлением op
   * 3. Expected math errors (ArithmeticOverflowError, etc.) → expectedMathError
   * 4. Unexpected errors → unexpectedError
   *
   * @example
   * ```typescript
   * return this.wrapOp('average', { price1: '0.2', price2: '0.8' }, () => {
   *   const sum = addDecimal(price1.value(), price2.value());
   *   const avgValue = divideDecimal(sum, this.TWO);
   *   return this.create(avgValue); // rewrap автоматический, не нужен ручной
   * });
   * ```
   */
  private static wrapOp<T>(
    op: string,
    ctx: Record<string, unknown>,
    fn: () => Result<T, InvalidPriceError>
  ): Result<T, InvalidPriceError> {
    try {
      const result = fn();
      // Если fn() вернул Err с InvalidPriceError - rewrap автоматически
      if (!result.ok) {
        return Err(this.rewrap(op, ctx, result.error));
      }
      return result;
    } catch (e) {
      // Если кто-то бросил InvalidPriceError - rewrap с добавлением контекста
      if (e instanceof InvalidPriceError) {
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
   * Обёртывает InvalidPriceError с добавлением op и контекста
   *
   * @param op - Название операции (станет верхним в opChain)
   * @param ctx - Дополнительный контекст для добавления (операционные поля: price, factor, divisor, etc)
   * @param err - Исходная ошибка
   * @returns Новая InvalidPriceError с объединённым контекстом
   *
   * @remarks
   * Простая перепаковка без рефлексии (никогда не бросает exception).
   *
   * Порядок мерджа:
   * 1. inner (err.context) - база из вложенной ошибки
   * 2. ctx - операционные поля (price, factor, divisor) - перетирают inner
   * 3. op + opChain - строит цепочку операций, НЕ теряя внутренний op
   * 4. preserve root-полей: cause, reason, raw (первопричина не перетирается)
   *
   * **Root-cause semantics:**
   * - cause, reason, raw сохраняются из inner (это первопричина)
   * - opChain накапливает историю операций: [innerOp, ..., op]
   *
   * Это гарантирует:
   * - Операционный контекст (price, factor) всегда актуален для текущего op
   * - Первопричина (cause, reason, raw) не теряется
   * - История операций сохраняется в opChain
   */
  private static rewrap(
    op: string,
    ctx: Record<string, unknown>,
    err: InvalidPriceError
  ): InvalidPriceError {
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

    return new InvalidPriceError(err.message, { context: merged });
  }

  /**
   * Безопасно конвертирует number | string | Decimal в Decimal
   *
   * @param field - Имя поля (для структурированного raw)
   * @param input - Входное значение
   * @returns Result<Decimal, InvalidPriceError>
   *
   * @remarks
   * Нормализует вход и корректно работает с двумя копиями decimal.js:
   * - Primitives (number, string) парсим напрямую
   * - Объекты (Decimal из другой копии) → toString() → парсим
   *
   * При ошибке парсинга → InvalidPriceError с raw: { field, value } и cause.
   *
   * Не добавляет op в контекст - внешний код добавит через rewrap.
   */
  private static toDecimal(
    field: 'value' | 'factor' | 'divisor' | 'tickSize',
    input: number | string | Decimal
  ): Result<Decimal, InvalidPriceError> {
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
          new InvalidPriceError('Failed to normalize value: no valid toString()', {
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
        new InvalidPriceError(
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
   * Создаёт Price из значения (безопасно - никогда не бросает)
   *
   * @remarks
   * ПУБЛИЧНЫЙ способ создания Price.
   * Возвращает Result вместо исключений.
   *
   * Инварианты проверяются автоматически через Price.of():
   * - finite (не NaN, не Infinity)
   * - диапазон [0.0001, 0.9999]
   *
   * @param value - Значение цены (number, string, или Decimal)
   * @returns Result<Price, InvalidPriceError>
   *
   * @example
   * ```typescript
   * const result = PriceService.create(0.5);
   * if (!result.ok) {
   *   console.error(result.error.context.value); // '0.5'
   *   return;
   * }
   * const price = result.value;
   * ```
   */
  public static create(
    value: number | string | Decimal
  ): Result<Price, InvalidPriceError> {
    // Безопасный парсинг value через toDecimal
    const decimalResult = this.toDecimal('value', value);
    if (!decimalResult.ok) {
      // raw уже внутри err.context.raw от toDecimal
      return Err(this.rewrap('create', {}, decimalResult.error));
    }

    try {
      // ВАЖНО: Core получает уже Decimal -> только проверка инвариантов, не парсинг
      const price = Price.fromDecimal(decimalResult.value);
      return Ok(price);
    } catch (error) {
      // PriceInvariantViolation - доменные ограничения Core
      if (error instanceof PriceInvariantViolation) {
        return Err(
          new InvalidPriceError(error.message, {
            context: {
              op: 'create',
              raw: { field: 'value', value: String(value) },
              reason: error.reason
            }
          })
        );
      }

      // Неожиданная ошибка (ctx пустой - rewrap добавит opChain, а root-поля защищены)
      return Err(this.unexpectedError('create', {}, error));
    }
  }

  /**
   * Вычисляет дополнение цены до 1
   *
   * @remarks
   * complement(0.3) = 0.7
   * Используется для вычисления противоположной стороны бинарного маркета.
   *
   * Может вернуть Err если результат выходит за диапазон [0.0001, 0.9999].
   *
   * @param price - Исходная цена
   * @returns Result с дополнением или InvalidPriceError
   *
   * @example
   * ```typescript
   * const price = expectOk(PriceService.create(0.3));
   * const result = PriceService.complement(price);
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 0.7
   * }
   * ```
   */
  public static complement(price: Price): Result<Price, InvalidPriceError> {
    const ctx = { price: price.value().toString() };

    return this.wrapOp('complement', ctx, () => {
      const result = subtractDecimal(this.ONE, price.value());
      return this.create(result); // wrapOp сам сделает rewrap если Err
    });
  }

  /**
   * Вычисляет среднее двух цен
   *
   * @remarks
   * average(0.2, 0.8) = 0.5
   * Используется для вычисления mid-price.
   *
   * @param price1 - Первая цена
   * @param price2 - Вторая цена
   * @returns Result со средним значением или InvalidPriceError
   *
   * @example
   * ```typescript
   * const p1 = expectOk(PriceService.create(0.2));
   * const p2 = expectOk(PriceService.create(0.8));
   * const result = PriceService.average(p1, p2);
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 0.5
   * }
   * ```
   */
  public static average(
    price1: Price,
    price2: Price
  ): Result<Price, InvalidPriceError> {
    const ctx = { price1: price1.value().toString(), price2: price2.value().toString() };

    return this.wrapOp('average', ctx, () => {
      const sum = addDecimal(price1.value(), price2.value());
      const avgValue = divideDecimal(sum, this.TWO);
      return this.create(avgValue); // wrapOp сам сделает rewrap если Err
    });
  }

  /**
   * Умножает цену на множитель
   *
   * @remarks
   * multiply(0.5, 2) = 1.0 (выйдет за диапазон → Err)
   * multiply(0.3, 2) = 0.6
   *
   * Парсит factor через toDecimal, валидирует через rule, выполняет умножение.
   * ВСЕ ошибки (парсинг, валидация, math, инварианты) оборачиваются в InvalidPriceError.
   *
   * @param price - Исходная цена
   * @param factor - Множитель (number, string, или Decimal)
   * @returns Result с результатом или InvalidPriceError
   *
   * @example
   * ```typescript
   * const price = expectOk(PriceService.create(0.3));
   * const result = PriceService.multiply(price, 2);
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 0.6
   * }
   * ```
   */
  public static multiply(
    price: Price,
    factor: number | string | Decimal
  ): Result<Price, InvalidPriceError> {
    // Безопасный парсинг factor через toDecimal
    const factorResult = this.toDecimal('factor', factor);
    if (!factorResult.ok) {
      return Err(
        this.rewrap('multiply', {
          price: price.value().toString(),
          factor: String(factor)
        }, factorResult.error)
      );
    }

    const factorDecimal = factorResult.value;

    // Валидация через rule (проверяет isNaN, isFinite)
    const validateResult = ValidateFactorForPriceMultiplication.check(factorDecimal);
    if (!validateResult.ok) {
      return Err(
        this.rewrap('multiply', {
          price: price.value().toString(),
          factor: factorDecimal.toString()
        }, validateResult.error)
      );
    }

    // Умножение с обработкой ожидаемых арифметических исключений
    const ctx = {
      price: price.value().toString(),
      factor: factorDecimal.toString()
    };

    return this.wrapOp('multiply', ctx, () => {
      const result = multiplyDecimal(price.value(), factorDecimal);
      return this.create(result); // wrapOp сам сделает rewrap если Err
    });
  }

  /**
   * Делит цену на делитель
   *
   * @param price - Исходная цена
   * @param divisor - Делитель (number, string, или Decimal)
   * @returns Result с результатом или InvalidPriceError
   * @throws Никогда - все ошибки оборачиваются в Result
   *
   * @remarks
   * divide(0.6, 2) = 0.3
   * divide(0.5, 0) → Err (проверка через ValidateDivisorForPriceDivision)
   *
   * Алгоритм:
   * 1. Парсинг divisor через toDecimal
   * 2. Валидация divisor через ValidateDivisorForPriceDivision (isNaN, isFinite, isZero)
   * 3. Деление через divideDecimal() из @polymarket/math
   * 4. Создание Price из результата
   *
   * ВСЕ ошибки (парсинг, валидация, math, инварианты) оборачиваются в InvalidPriceError.
   * Метод никогда не бросает исключения.
   *
   * @example
   * ```typescript
   * const price = expectOk(PriceService.create(0.6));
   * const result = PriceService.divide(price, 2);
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 0.3
   * }
   * ```
   */
  public static divide(
    price: Price,
    divisor: number | string | Decimal
  ): Result<Price, InvalidPriceError> {
    // Безопасный парсинг divisor через toDecimal
    const divisorResult = this.toDecimal('divisor', divisor);
    if (!divisorResult.ok) {
      return Err(
        this.rewrap('divide', {
          price: price.value().toString(),
          divisor: String(divisor)
        }, divisorResult.error)
      );
    }

    const divisorDecimal = divisorResult.value;

    // Валидация через rule
    const validateResult = ValidateDivisorForPriceDivision.check(divisorDecimal);
    if (!validateResult.ok) {
      return Err(
        this.rewrap('divide', {
          price: price.value().toString(),
          divisor: divisorDecimal.toString()
        }, validateResult.error)
      );
    }

    // Делим с обработкой ожидаемых арифметических исключений
    const ctx = {
      price: price.value().toString(),
      divisor: divisorDecimal.toString()
    };

    return this.wrapOp('divide', ctx, () => {
      const result = divideDecimal(price.value(), divisorDecimal);
      return this.create(result); // wrapOp сам сделает rewrap если Err
    });
  }

  /**
   * Округляет цену до ближайшего тика
   *
   * @param price - Исходная цена
   * @param tickSize - Размер тика (number, string, или Decimal)
   * @param mode - Режим округления ('nearest' | 'floor' | 'ceil')
   * @returns Result с округлённой ценой или InvalidPriceError
   * @throws Никогда - все ошибки оборачиваются в Result
   *
   * @remarks
   * НЕ требует что price уже aligned.
   * Это функция округления, а не валидации.
   *
   * Режимы округления:
   * - nearest: к ближайшему тику (по умолчанию)
   * - floor: вниз — используй для bid price
   * - ceil: вверх — используй для ask price
   *
   * КОНТРАКТ: результат ДОЛЖЕН проходить ValidateAligned.check()
   *
   * Алгоритм:
   * 1. Парсинг tickSize через toDecimal
   * 2. Валидация tickSize через ValidateTickSizeMultipleOfBaseTick (кратность 0.0001)
   * 3. Выбор направления округления (nearest/floor/ceil)
   * 4. Округление через @polymarket/math функции (roundToTick/floorToTick/ceilToTick)
   * 5. Создание Price из округлённого значения
   *
   * ВСЕ ошибки (парсинг, валидация, math, инварианты) оборачиваются в InvalidPriceError.
   * Метод никогда не бросает исключения.
   *
   * @example
   * ```typescript
   * const price = expectOk(PriceService.create(0.12345));
   * const result = PriceService.roundToMarketTick(price, 0.001);
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 0.123
   * }
   * ```
   */
  public static roundToMarketTick(
    price: Price,
    tickSize: number | string | Decimal,
    mode: 'nearest' | 'floor' | 'ceil' = 'nearest'
  ): Result<Price, InvalidPriceError> {
    // Безопасный парсинг tickSize через toDecimal
    const tickDecimalResult = this.toDecimal('tickSize', tickSize);
    if (!tickDecimalResult.ok) {
      return Err(
        this.rewrap('roundToMarketTick', {
          price: price.value().toString(),
          tickSize: String(tickSize),
          mode
        }, tickDecimalResult.error)
      );
    }

    // Валидация через rule (уже принимает Decimal)
    const tickRes = ValidateTickSizeMultipleOfBaseTick.check(tickDecimalResult.value);
    if (!tickRes.ok) {
      return Err(
        this.rewrap('roundToMarketTick', {
          price: price.value().toString(),
          tickSize: tickDecimalResult.value.toString(),
          mode
        }, tickRes.error)
      );
    }
    const tick = tickRes.value;

    const ctx = {
      price: price.value().toString(),
      tickSize: tick.toString(),
      mode
    };

    return this.wrapOp('roundToMarketTick', ctx, () => {
      let out: Decimal;

      switch (mode) {
        case 'floor':
          out = floorToTick(price.value(), tick);
          break;

        case 'ceil':
          out = ceilToTick(price.value(), tick);
          break;

        case 'nearest':
        default:
          out = roundToTick(price.value(), tick, Decimal.ROUND_HALF_UP);
          break;
      }

      return this.create(out); // wrapOp сам сделает rewrap если Err
    });
  }

  /**
   * Проверяет что price кратен tickSize
   *
   * @remarks
   * Проверяет что price УЖЕ кратен tickSize.
   * Для округления используй roundToMarketTick().
   *
   * Используется для валидации после округления или
   * для проверки входящих данных.
   *
   * ВСЕ ошибки (парсинг tickSize, валидация, alignment) оборачиваются в InvalidPriceError.
   *
   * @param price - Цена для проверки
   * @param tickSize - Размер тика (number, string, или Decimal)
   * @returns Result<void> если кратен, InvalidPriceError если нет
   *
   * @example
   * ```typescript
   * const price = expectOk(PriceService.create(0.5));
   * const result = PriceService.ensureAlignedToMarketTick(price, 0.01);
   * if (result.ok) {
   *   console.log('Price aligned to tick size');
   * } else {
   *   console.error(result.error.context.reason); // 'not_aligned'
   * }
   * ```
   */
  public static ensureAlignedToMarketTick(
    price: Price,
    tickSize: number | string | Decimal
  ): Result<void, InvalidPriceError> {
    // Безопасный парсинг tickSize через toDecimal
    const tickDecimalResult = this.toDecimal('tickSize', tickSize);
    if (!tickDecimalResult.ok) {
      return Err(
        this.rewrap('ensureAlignedToMarketTick', {
          price: price.value().toString(),
          tickSize: String(tickSize)
        }, tickDecimalResult.error)
      );
    }

    // Валидация tickSize через ValidateTickSizeMultipleOfBaseTick (как в roundToMarketTick)
    const tickRes = ValidateTickSizeMultipleOfBaseTick.check(tickDecimalResult.value);
    if (!tickRes.ok) {
      return Err(
        this.rewrap('ensureAlignedToMarketTick', {
          price: price.value().toString(),
          tickSize: tickDecimalResult.value.toString()
        }, tickRes.error)
      );
    }

    const tick = tickRes.value;

    // Проверка alignment
    const result = ValidateAligned.check(price, tick);
    if (!result.ok) {
      return Err(
        this.rewrap('ensureAlignedToMarketTick', {
          price: price.value().toString(),
          tickSize: tick.toString()
        }, result.error)
      );
    }
    return result;
  }
}
