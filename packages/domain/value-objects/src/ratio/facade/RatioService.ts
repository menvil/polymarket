/**
 * Service facade для безопасного создания Ratio
 *
 * @remarks
 * ## Never Throw Contract
 * ВСЕ методы ГАРАНТИРУЮТ возврат Result<T, E> и НИКОГДА не бросают исключения
 *
 * ## Facade Error Contract
 * Каждый Err содержит context с полями:
 * - context.reason: RatioErrorReason (typed enum)
 * - context.op: string (название операции)
 * - context.[field]Value: string (значения, вызвавшие ошибку)
 * - context.source: ErrorSource
 *
 * ## Factory Methods
 * - fromDecimal(): создать из дроби (0.02 для 2%)
 * - fromPercent(): создать из процента (2 для 2%)
 * - fromBps(): создать из basis points (200 для 2%)
 *
 * ## Validation Options
 * - ensureGteMinusOne: проверить, что ratio >= -1 (для операций "1 + ratio")
 * - ensureLteOne: проверить, что ratio <= 1 (для операций "1 - ratio")
 *
 * @example
 * ```typescript
 * // Создание из разных форматов
 * const r1 = RatioService.fromDecimal(0.02); // 2%
 * const r2 = RatioService.fromPercent(2); // 2%
 * const r3 = RatioService.fromBps(200); // 2%
 *
 * // С валидацией для onePlus() operations
 * const markup = RatioService.fromPercent(10, { ensureGteMinusOne: true });
 * if (markup.ok) {
 *   // Безопасно: amount * (1 + ratio) не станет отрицательным
 * }
 *
 * // С валидацией для oneMinus() operations
 * const discount = RatioService.fromPercent(15, { ensureLteOne: true });
 * if (discount.ok) {
 *   // Безопасно: amount * (1 - ratio) не станет отрицательным
 * }
 * ```
 */
import Decimal from 'decimal.js';
import { Result, Ok, Err, isErr } from '@polymarket/result';
import { InvalidRatioError } from '@polymarket/errors';
import { rewrap, toDecimal, wrapOp } from '@polymarket/errors';
import { Ratio } from '../core/Ratio.js';
import { RatioErrorReason } from '../errors/RatioErrorReason.js';
import { ValidateRatioGteMinusOne } from '../rules/ValidateRatioGteMinusOne.js';
import { ValidateRatioLteOne } from '../rules/ValidateRatioLteOne.js';

/**
 * Опции для создания Ratio
 */
export interface RatioCreateOptions {
  /**
   * Проверить, что ratio >= -1
   * Используется для операций типа amount * (1 + ratio)
   */
  ensureGteMinusOne?: boolean;

  /**
   * Проверить, что ratio <= 1
   * Используется для операций типа amount * (1 - ratio)
   */
  ensureLteOne?: boolean;
}

export class RatioService {
  private static readonly SERVICE_NAME = 'RatioService';

  /**
   * Создать Ratio из дроби (fraction)
   *
   * @param value - Дробь: 0.02 для 2%, 0.5 для 50%
   * @param options - Опции валидации
   * @returns Result с Ratio или InvalidRatioError
   *
   * @example
   * ```typescript
   * const ratioResult = RatioService.fromDecimal(0.02);
   * if (ratioResult.ok) {
   *   console.log(ratioResult.value.toDecimal()); // Decimal(0.02)
   * }
   *
   * // С валидацией
   * const validRatio = RatioService.fromDecimal(-0.5, { ensureGteMinusOne: true });
   * // OK: -0.5 >= -1
   *
   * const invalidRatio = RatioService.fromDecimal(-1.5, { ensureGteMinusOne: true });
   * // Err: -1.5 < -1
   * ```
   */
  public static fromDecimal(
    value: number | string | Decimal,
    options?: RatioCreateOptions
  ): Result<Ratio, InvalidRatioError> {
    // Заранее собираем ctx для rewrap
    const ctx = { raw: { field: 'value', value: String(value) } };

    // Step 1: Parse to Decimal
    const decimalResult = toDecimal('value', value, RatioErrorReason.INVALID_FORMAT, InvalidRatioError);
    if (isErr(decimalResult)) {
      return Err(rewrap(this.SERVICE_NAME, 'fromDecimal', ctx, decimalResult.error, InvalidRatioError));
    }
    const decimal = decimalResult.value;

    // Step 2: Optional validation (ensureGteMinusOne)
    if (options?.ensureGteMinusOne) {
      const validationResult = ValidateRatioGteMinusOne.check(decimal, 'fromDecimal');
      if (isErr(validationResult)) {
        return Err(rewrap(this.SERVICE_NAME, 'fromDecimal', ctx, validationResult.error, InvalidRatioError));
      }
    }

    // Step 3: Optional validation (ensureLteOne)
    if (options?.ensureLteOne) {
      const validationResult = ValidateRatioLteOne.check(decimal, 'fromDecimal');
      if (isErr(validationResult)) {
        return Err(rewrap(this.SERVICE_NAME, 'fromDecimal', ctx, validationResult.error, InvalidRatioError));
      }
    }

    // Step 4: Create Ratio (wrapOp catches invariant violations)
    return wrapOp(
      this.SERVICE_NAME,
      'fromDecimal',
      ctx,
      () => {
        const ratio = Ratio.of(decimal);
        return Ok(ratio);
      },
      InvalidRatioError
    );
  }

  /**
   * Создать Ratio из процента (2 для 2%)
   *
   * @param percent - Процент: 2 для 2%, 50 для 50%
   * @param options - Опции валидации
   * @returns Result с Ratio или InvalidRatioError
   *
   * @example
   * ```typescript
   * const ratioResult = RatioService.fromPercent(2); // 2% => 0.02
   * if (ratioResult.ok) {
   *   console.log(ratioResult.value.toDecimal()); // Decimal(0.02)
   * }
   * ```
   */
  public static fromPercent(
    percent: number | string | Decimal,
    options?: RatioCreateOptions
  ): Result<Ratio, InvalidRatioError> {
    // Заранее собираем ctx для rewrap
    const ctx = { raw: { field: 'percent', value: String(percent) } };

    // Step 1: Parse to Decimal
    const decimalResult = toDecimal('percent', percent, RatioErrorReason.INVALID_FORMAT, InvalidRatioError);
    if (isErr(decimalResult)) {
      return Err(rewrap(this.SERVICE_NAME, 'fromPercent', ctx, decimalResult.error, InvalidRatioError));
    }

    // Step 2: Convert percent to fraction (divide by 100)
    const fraction = decimalResult.value.div(100);

    // Step 3: Optional validation (ensureGteMinusOne)
    if (options?.ensureGteMinusOne) {
      const validationResult = ValidateRatioGteMinusOne.check(fraction, 'fromPercent');
      if (isErr(validationResult)) {
        return Err(rewrap(this.SERVICE_NAME, 'fromPercent', ctx, validationResult.error, InvalidRatioError));
      }
    }

    // Step 4: Optional validation (ensureLteOne)
    if (options?.ensureLteOne) {
      const validationResult = ValidateRatioLteOne.check(fraction, 'fromPercent');
      if (isErr(validationResult)) {
        return Err(rewrap(this.SERVICE_NAME, 'fromPercent', ctx, validationResult.error, InvalidRatioError));
      }
    }

    // Step 5: Create Ratio (wrapOp catches invariant violations)
    return wrapOp(
      this.SERVICE_NAME,
      'fromPercent',
      ctx,
      () => {
        const ratio = Ratio.of(fraction);
        return Ok(ratio);
      },
      InvalidRatioError
    );
  }

  /**
   * Создать Ratio из basis points (200 для 2%)
   *
   * @param bps - Basis points: 200 для 2%, 100 для 1%
   * @param options - Опции валидации
   * @returns Result с Ratio или InvalidRatioError
   *
   * @example
   * ```typescript
   * const ratioResult = RatioService.fromBps(200); // 200 bps => 0.02
   * if (ratioResult.ok) {
   *   console.log(ratioResult.value.toDecimal()); // Decimal(0.02)
   * }
   * ```
   */
  public static fromBps(
    bps: number | string | Decimal,
    options?: RatioCreateOptions
  ): Result<Ratio, InvalidRatioError> {
    // Заранее собираем ctx для rewrap
    const ctx = { raw: { field: 'bps', value: String(bps) } };

    // Step 1: Parse to Decimal
    const decimalResult = toDecimal('bps', bps, RatioErrorReason.INVALID_FORMAT, InvalidRatioError);
    if (isErr(decimalResult)) {
      return Err(rewrap(this.SERVICE_NAME, 'fromBps', ctx, decimalResult.error, InvalidRatioError));
    }

    // Step 2: Convert bps to fraction (divide by 10000)
    const fraction = decimalResult.value.div(10000);

    // Step 3: Optional validation (ensureGteMinusOne)
    if (options?.ensureGteMinusOne) {
      const validationResult = ValidateRatioGteMinusOne.check(fraction, 'fromBps');
      if (isErr(validationResult)) {
        return Err(rewrap(this.SERVICE_NAME, 'fromBps', ctx, validationResult.error, InvalidRatioError));
      }
    }

    // Step 4: Optional validation (ensureLteOne)
    if (options?.ensureLteOne) {
      const validationResult = ValidateRatioLteOne.check(fraction, 'fromBps');
      if (isErr(validationResult)) {
        return Err(rewrap(this.SERVICE_NAME, 'fromBps', ctx, validationResult.error, InvalidRatioError));
      }
    }

    // Step 5: Create Ratio (wrapOp catches invariant violations)
    return wrapOp(
      this.SERVICE_NAME,
      'fromBps',
      ctx,
      () => {
        const ratio = Ratio.of(fraction);
        return Ok(ratio);
      },
      InvalidRatioError
    );
  }

  /**
   * Проверить равенство двух Ratio
   *
   * @param a - Первый Ratio
   * @param b - Второй Ratio
   * @returns true если Ratio равны
   *
   * @remarks
   * Простой делегирующий метод для симметрии API с другими Service классами.
   * Используйте напрямую `a.equals(b)` если предпочитаете более короткую запись.
   *
   * @example
   * ```typescript
   * const r1 = RatioService.fromPercent(2);
   * const r2 = RatioService.fromDecimal(0.02);
   * if (r1.ok && r2.ok) {
   *   const isEqual = RatioService.equals(r1.value, r2.value);
   *   console.log(isEqual); // true
   * }
   * ```
   */
  public static equals(a: Ratio, b: Ratio): boolean {
    return a.equals(b);
  }
}
