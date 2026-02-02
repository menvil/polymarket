import { Result, Ok, Err, isErr } from '@polymarket/result';
import Decimal from 'decimal.js';
import { InvalidPercentageError } from '@polymarket/errors';
import { addDecimal, subtractDecimal, multiplyDecimal, divideDecimal } from '@polymarket/math';
import { Percentage } from '../core/Percentage';
import { PercentageInvariantViolation } from '../core/PercentageInvariantViolation';
import { PercentageErrorReason } from '../core/PercentageErrorReason';

// ✅ Импорт централизованных функций из errorUtils
import {
  toDecimal,
  wrapOp,
  rewrap
} from '../../shared/facade/errorUtils';

/**
 * Facade для безопасного создания и операций с Percentage - публичный API
 *
 * @remarks
 * Единая точка входа для всех операций с Percentage.
 * Оркестрирует Core + Math + Rules.
 *
 * **Использует централизованный errorUtils:**
 * - toDecimal() - парсинг с generic типами
 * - wrapOp() - обработка операций
 * - rewrap() - обёртка ошибок с сохранением root-cause
 *
 * **Контракт "Never Throw":**
 * ВСЕ методы PercentageService ГАРАНТИРОВАННО возвращают Result и НИКОГДА не бросают исключения.
 * Любые исключения из @polymarket/math, Core инвариантов или Rules ловятся и преобразуются в Result.Err.
 *
 * **Facade Error Contract:**
 * Любой Err из Facade содержит:
 * - context.op - название операции (верхний уровень)
 * - context.opChain - цепочка операций (внутренние op не теряются)
 * - context.value/factor/divisor - входные параметры (если применимо)
 * - context.raw - сырой ввод (для ошибок парсинга): { field, value }
 * - context.cause - для math-исключений: { name, message, stack? } (root-cause, не перетирается)
 * - context.reason - для инвариантов Core и специальных случаев (root, не перетирается)
 *
 * **Правило возвращаемых типов:**
 * ВСЕ операции возвращают Result<T, InvalidPercentageError>
 * ОЖИДАЕМЫЕ и НЕОЖИДАННЫЕ ошибки обрабатываются через Result
 *
 * Специальные reason значения в context.reason:
 * - INVALID_FORMAT - ошибка парсинга значения
 * - NAN - значение NaN
 * - NON_FINITE - значение не finite (Infinity)
 * - OUT_OF_RANGE_LOW - значение < MIN_PERCENTAGE
 * - OUT_OF_RANGE_HIGH - значение > MAX_PERCENTAGE
 * - DIVISION_BY_ZERO - деление на ноль
 *
 * @example
 * ```typescript
 * import { PercentageService } from '@polymarket/value-objects/percentage';
 *
 * const result = PercentageService.create(50);
 * if (result.ok) {
 *   console.log(result.value.value()); // Decimal(50)
 * } else {
 *   console.error(result.error.message);
 *   console.error(result.error.context.reason); // INVALID_FORMAT, NAN, etc.
 * }
 * ```
 */
export class PercentageService {
  /**
   * Создаёт Percentage с обработкой через Result
   *
   * @param value - Значение процента (number, string, Decimal)
   * @returns Result<Percentage, InvalidPercentageError>
   * @throws Никогда - все ошибки оборачиваются в Result
   *
   * @remarks
   * ПУБЛИЧНЫЙ способ создания Percentage.
   * Возвращает Result вместо исключений.
   *
   * Процесс:
   * 1. Парсит в Decimal через toDecimal('value', value)
   * 2. Вызывает createFromDecimal() (проверит инварианты)
   *
   * Обработка ошибок:
   * - Parse fail (toDecimal error) → InvalidPercentageError(reason: 'INVALID_FORMAT', raw: { field, value })
   * - Invariant fail (PercentageInvariantViolation) → InvalidPercentageError с reason (OUT_OF_RANGE_LOW, OUT_OF_RANGE_HIGH, NAN, NON_FINITE)
   *
   * @example
   * ```typescript
   * const result = PercentageService.create(50);
   * if (result.ok) {
   *   console.log(result.value.value()); // Decimal(50)
   * }
   * ```
   */
  public static create(
    value: number | string | Decimal
  ): Result<Percentage, InvalidPercentageError> {
    // ✅ Использование toDecimal из errorUtils
    const decimalResult = toDecimal(
      'value',
      value,
      PercentageErrorReason.INVALID_FORMAT,
      InvalidPercentageError
    );

    if (isErr(decimalResult)) {
      return Err(rewrap('create', {}, decimalResult.error, InvalidPercentageError));
    }

    return this.createFromDecimal(decimalResult.value, 'create', {});
  }

  /**
   * Создаёт Percentage из десятичной дроби (scale 0-1)
   *
   * @param decimal - Десятичная дробь (0.5 = 50%)
   * @returns Result<Percentage, InvalidPercentageError>
   * @throws Никогда - все ошибки оборачиваются в Result
   *
   * @remarks
   * Конвертирует из десятичной шкалы (0-1) в процентную (0-100).
   *
   * @example
   * ```typescript
   * const result = PercentageService.fromDecimalFraction(0.5);
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 50
   * }
   * ```
   */
  public static fromDecimalFraction(
    decimal: number | string | Decimal
  ): Result<Percentage, InvalidPercentageError> {
    // ✅ Использование toDecimal из errorUtils
    const decimalResult = toDecimal(
      'value',
      decimal,
      PercentageErrorReason.INVALID_FORMAT,
      InvalidPercentageError
    );

    if (isErr(decimalResult)) {
      return Err(rewrap('fromDecimalFraction', {}, decimalResult.error, InvalidPercentageError));
    }

    const percentValue = decimalResult.value.times(100);
    return this.createFromDecimal(percentValue, 'fromDecimalFraction', {});
  }

  /**
   * Создаёт Percentage из базисных пунктов (100 bp = 1%)
   *
   * @param basisPoints - Базисные пункты (5000 bp = 50%)
   * @returns Result<Percentage, InvalidPercentageError>
   * @throws Никогда - все ошибки оборачиваются в Result
   *
   * @remarks
   * Конвертирует из базисных пунктов в процентную шкалу.
   *
   * @example
   * ```typescript
   * const result = PercentageService.fromBasisPoints(5000);
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 50
   * }
   * ```
   */
  public static fromBasisPoints(
    basisPoints: number | string | Decimal
  ): Result<Percentage, InvalidPercentageError> {
    // ✅ Использование toDecimal из errorUtils
    const bpResult = toDecimal(
      'value',
      basisPoints,
      PercentageErrorReason.INVALID_FORMAT,
      InvalidPercentageError
    );

    if (isErr(bpResult)) {
      return Err(rewrap('fromBasisPoints', {}, bpResult.error, InvalidPercentageError));
    }

    const percentValue = bpResult.value.dividedBy(100);
    return this.createFromDecimal(percentValue, 'fromBasisPoints', {});
  }

  /**
   * Создаёт Percentage из Decimal с проверкой инвариантов
   *
   * @param decimal - Значение (уже распарсенный Decimal)
   * @returns Result<Percentage, InvalidPercentageError>
   *
   * @remarks
   * Внутренний helper для использования в wrapOp и math операциях.
   * НЕ парсит - принимает готовый Decimal.
   * Только проверяет инварианты через Percentage.fromDecimal().
   *
   * Ловит PercentageInvariantViolation и мапит через mapInvariantToError:
   * - OUT_OF_RANGE_LOW, OUT_OF_RANGE_HIGH, NON_FINITE, NAN → InvalidPercentageError
   */
  private static createFromDecimal(
    decimal: Decimal,
    op: string = 'createFromDecimal',
    ctx: Record<string, unknown> = {}
  ): Result<Percentage, InvalidPercentageError> {
    try {
      return Ok(Percentage.fromDecimal(decimal));
    } catch (error) {
      if (error instanceof PercentageInvariantViolation) {
        return this.mapInvariantToError(op, {
          ...ctx,
          value: decimal.toString()
        }, error);
      }

      // Unexpected error - возвращаем InvalidPercentageError
      return Err(
        new InvalidPercentageError(`Unexpected error during percentage ${op}`, {
          context: {
            op,
            value: decimal.toString(),
            ...ctx,
            cause: error instanceof Error ? {
              name: error.name,
              message: error.message,
              stack: error.stack
            } : {
              name: 'UnknownError',
              message: String(error)
            }
          }
        })
      );
    }
  }

  /**
   * Мапит PercentageInvariantViolation → InvalidPercentageError
   *
   * @param op - Операция (add/subtract/multiply/divide)
   * @param ctx - Контекст (a, b, result, value, factor, divisor, etc.)
   * @param e - PercentageInvariantViolation из Percentage.fromDecimal()
   * @returns Err(InvalidPercentageError) с reason в context
   *
   * @remarks
   * DRY helper для всех math операций.
   * Все типы PercentageInvariantViolation мапятся в InvalidPercentageError с сохранением reason.
   *
   * **ВАЖНО:** НЕ throw - всегда возвращает Result.
   */
  private static mapInvariantToError(
    op: string,
    ctx: Record<string, unknown>,
    e: PercentageInvariantViolation
  ): Result<never, InvalidPercentageError> {
    const { reason } = e;

    // Все типы инвариантных нарушений мапим в InvalidPercentageError с reason
    return Err(
      new InvalidPercentageError(`Percentage ${op} result is invalid: ${reason}`, {
        context: {
          op,
          ...ctx,
          reason
        }
      })
    );
  }

  /**
   * Складывает два процента
   *
   * @param a - Первый процент
   * @param b - Второй процент
   * @returns Result<Percentage, InvalidPercentageError>
   * @throws Никогда - все ошибки оборачиваются в Result
   *
   * @remarks
   * Процесс:
   * 1. Операция через @polymarket/math
   * 2. Percentage.fromDecimal() (проверит инварианты через createFromDecimal)
   * 3. Маппинг через mapInvariantToError
   *
   * @example
   * ```typescript
   * const result = PercentageService.add(
   *   Percentage.of(25),
   *   Percentage.of(30)
   * );
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 55
   * }
   * ```
   */
  public static add(
    a: Percentage,
    b: Percentage
  ): Result<Percentage, InvalidPercentageError> {
    const ctx = { a: a.value().toString(), b: b.value().toString() };

    // ✅ Использование wrapOp из errorUtils
    return wrapOp(
      'add',
      ctx,
      () => {
        const sum = addDecimal(a.value(), b.value());
        return this.createFromDecimal(sum, 'add', {});
      },
      'percentage',
      InvalidPercentageError
    );
  }

  /**
   * Вычитает один процент из другого
   *
   * @param a - Уменьшаемое
   * @param b - Вычитаемое
   * @returns Result<Percentage, InvalidPercentageError>
   * @throws Никогда - все ошибки оборачиваются в Result
   *
   * @remarks
   * Процесс:
   * 1. Операция через @polymarket/math
   * 2. Percentage.fromDecimal() (проверит инварианты через createFromDecimal)
   * 3. Маппинг через mapInvariantToError
   *
   * @example
   * ```typescript
   * const result = PercentageService.subtract(
   *   Percentage.of(50),
   *   Percentage.of(20)
   * );
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 30
   * }
   * ```
   */
  public static subtract(
    a: Percentage,
    b: Percentage
  ): Result<Percentage, InvalidPercentageError> {
    const ctx = { a: a.value().toString(), b: b.value().toString() };

    // ✅ Использование wrapOp из errorUtils
    return wrapOp(
      'subtract',
      ctx,
      () => {
        const diff = subtractDecimal(a.value(), b.value());
        return this.createFromDecimal(diff, 'subtract', {});
      },
      'percentage',
      InvalidPercentageError
    );
  }

  /**
   * Умножает процент на фактор
   *
   * @param pct - Percentage
   * @param factor - Множитель (number, string, или Decimal)
   * @returns Result<Percentage, InvalidPercentageError>
   * @throws Никогда - все ошибки оборачиваются в Result
   *
   * @remarks
   * Проверяет валидность фактора через парсинг.
   *
   * Алгоритм:
   * 1. Парсинг factor через toDecimal('factor', factor)
   * 2. Умножение через multiplyDecimal() из @polymarket/math
   * 3. Создание Percentage из результата
   *
   * Все ошибки оборачиваются в Result.
   *
   * @example
   * ```typescript
   * const result = PercentageService.multiply(
   *   Percentage.of(50),
   *   2
   * );
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 100
   * }
   * ```
   */
  public static multiply(
    pct: Percentage,
    factor: number | string | Decimal
  ): Result<Percentage, InvalidPercentageError> {
    // ✅ Использование toDecimal из errorUtils
    const factorResult = toDecimal(
      'factor',
      factor,
      PercentageErrorReason.INVALID_FORMAT,
      InvalidPercentageError
    );

    if (isErr(factorResult)) {
      return Err(
        rewrap('multiply', {
          value: pct.value().toString(),
          factor: String(factor)
        }, factorResult.error, InvalidPercentageError)
      );
    }

    const factorDecimal = factorResult.value;
    const ctx = {
      value: pct.value().toString(),
      factor: factorDecimal.toString()
    };

    // ✅ Использование wrapOp из errorUtils
    return wrapOp(
      'multiply',
      ctx,
      () => {
        const product = multiplyDecimal(pct.value(), factorDecimal);
        return this.createFromDecimal(product, 'multiply', {});
      },
      'percentage',
      InvalidPercentageError
    );
  }

  /**
   * Делит процент на делитель
   *
   * @param pct - Percentage
   * @param divisor - Делитель (number, string, или Decimal)
   * @returns Result<Percentage, InvalidPercentageError>
   * @throws Никогда - все ошибки оборачиваются в Result
   *
   * @remarks
   * Проверяет валидность делителя через парсинг.
   *
   * Алгоритм:
   * 1. Парсинг divisor через toDecimal('divisor', divisor)
   * 2. Деление через divideDecimal() из @polymarket/math
   * 3. Создание Percentage из результата
   *
   * Все ошибки оборачиваются в Result.
   *
   * @example
   * ```typescript
   * const result = PercentageService.divide(
   *   Percentage.of(100),
   *   2
   * );
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 50
   * }
   * ```
   */
  public static divide(
    pct: Percentage,
    divisor: number | string | Decimal
  ): Result<Percentage, InvalidPercentageError> {
    // ✅ Использование toDecimal из errorUtils
    const divisorResult = toDecimal(
      'divisor',
      divisor,
      PercentageErrorReason.INVALID_FORMAT,
      InvalidPercentageError
    );

    if (isErr(divisorResult)) {
      return Err(
        rewrap('divide', {
          value: pct.value().toString(),
          divisor: String(divisor)
        }, divisorResult.error, InvalidPercentageError)
      );
    }

    const divisorDecimal = divisorResult.value;
    const ctx = {
      value: pct.value().toString(),
      divisor: divisorDecimal.toString()
    };

    // ✅ Использование wrapOp из errorUtils
    return wrapOp(
      'divide',
      ctx,
      () => {
        const quotient = divideDecimal(pct.value(), divisorDecimal);
        return this.createFromDecimal(quotient, 'divide', {});
      },
      'percentage',
      InvalidPercentageError
    );
  }

  /**
   * Применяет процент к значению
   *
   * @param pct - Percentage для применения
   * @param value - Значение (Decimal)
   * @returns Result<Decimal, InvalidPercentageError>
   * @throws Никогда - все ошибки оборачиваются в Result
   *
   * @remarks
   * Вычисляет: value * (pct / 100)
   * Например: applyTo(50%, 100) = 50
   *
   * @example
   * ```typescript
   * const result = PercentageService.applyTo(
   *   Percentage.of(25),
   *   new Decimal(100)
   * );
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 25
   * }
   * ```
   */
  public static applyTo(
    pct: Percentage,
    value: Decimal
  ): Result<Decimal, InvalidPercentageError> {
    const ctx = {
      percentage: pct.value().toString(),
      value: value.toString()
    };

    // ✅ Использование wrapOp из errorUtils
    return wrapOp(
      'applyTo',
      ctx,
      () => {
        try {
          const decimal = pct.toDecimal(); // pct / 100
          const result = multiplyDecimal(value, decimal);
          return Ok(result);
        } catch (error) {
          // Math error - будет обработан wrapOp
          throw error;
        }
      },
      'percentage',
      InvalidPercentageError
    );
  }
}
