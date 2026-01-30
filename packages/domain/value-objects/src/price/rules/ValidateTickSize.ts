import { Result, Ok, Err } from '@polymarket/result';
import { InvalidTickSizeError } from '@polymarket/errors';
import { Price } from '../core/Price.js';
import type { TickSizeErrorReason } from './types.js';
import Decimal from 'decimal.js';

/**
 * Правило: TickSize должен быть валидным для Price
 *
 * @remarks
 * Проверяет базовые свойства tickSize:
 * - Парсится в Decimal
 * - Не NaN
 * - Положительный
 * - Конечный
 * - Не больше чем диапазон (MAX - MIN)
 *
 * НЕ проверяет кратность базовому тику - используй ValidateTickSizeMultipleOfBaseTick.
 *
 * @example
 * ```typescript
 * import { ValidateTickSize } from '@polymarket/value-objects/price';
 *
 * const result = ValidateTickSize.check(0.0001);
 * if (result.ok) {
 *   const tickDecimal = result.value; // Decimal
 * } else {
 *   console.error(result.error.context.reason); // 'parse_error' | 'is_nan' | ...
 * }
 * ```
 */
export class ValidateTickSize {
  /**
   * Проверяет валидность tickSize
   *
   * @param tickSize - Размер тика для проверки
   * @returns Result с валидированным Decimal или InvalidTickSizeError
   *
   * @remarks
   * Возвращает Decimal вместо void для избежания двойного парсинга.
   * Используй result.value в последующих операциях.
   *
   * @example
   * ```typescript
   * const result = ValidateTickSize.check('0.0001');
   * if (!result.ok) {
   *   console.error(result.error.context.field); // 'tickSize'
   *   console.error(result.error.context.reason); // 'parse_error' | 'is_nan' | ...
   *   return;
   * }
   * const tickDecimal = result.value; // Используем в дальнейшем
   * ```
   */
  public static check(
    tickSize: number | string | Decimal
  ): Result<Decimal, InvalidTickSizeError> {
    // Парсинг
    let tickDecimal: Decimal;
    try {
      tickDecimal = tickSize instanceof Decimal ? tickSize : new Decimal(tickSize);
    } catch (error) {
      return Err(
        new InvalidTickSizeError(
          (ctx) => `Tick size is not a valid decimal: ${ctx.tickSize}`,
          {
            code: InvalidTickSizeError.code,
            context: {
              field: 'tickSize',
              reason: 'parse_error' as TickSizeErrorReason,
              tickSize: String(tickSize),
              parseError: error instanceof Error ? error.message : 'unknown'
            }
          }
        )
      );
    }

    // Проверка NaN
    if (tickDecimal.isNaN()) {
      return Err(
        new InvalidTickSizeError(
          () => `Tick size must not be NaN`,
          {
            code: InvalidTickSizeError.code,
            context: {
              field: 'tickSize',
              reason: 'is_nan' as TickSizeErrorReason,
              tickSize: String(tickSize)
            }
          }
        )
      );
    }

    // Проверка Finite
    if (!tickDecimal.isFinite()) {
      return Err(
        new InvalidTickSizeError(
          (ctx) => `Tick size must be finite, got ${ctx.tickSize}`,
          {
            code: InvalidTickSizeError.code,
            context: {
              field: 'tickSize',
              reason: 'not_finite' as TickSizeErrorReason,
              tickSize: tickDecimal.toString()
            }
          }
        )
      );
    }

    // Проверка Positive
    if (tickDecimal.lessThanOrEqualTo(0)) {
      return Err(
        new InvalidTickSizeError(
          (ctx) => `Tick size must be positive, got ${ctx.tickSize}`,
          {
            code: InvalidTickSizeError.code,
            context: {
              field: 'tickSize',
              reason: 'not_positive' as TickSizeErrorReason,
              tickSize: tickDecimal.toString()
            }
          }
        )
      );
    }

    // Проверка максимального размера (арифметическая, не доменная)
    const maxAllowed = Price.maxValue().minus(Price.minValue());
    if (tickDecimal.greaterThan(maxAllowed)) {
      return Err(
        new InvalidTickSizeError(
          (ctx) => `Tick size ${ctx.tickSize} exceeds price range`,
          {
            code: InvalidTickSizeError.code,
            context: {
              field: 'tickSize',
              reason: 'exceeds_range' as TickSizeErrorReason,
              tickSize: tickDecimal.toString(),
              maxAllowed: maxAllowed.toString(),
              minPrice: Price.minValue().toString(),
              maxPrice: Price.maxValue().toString()
            }
          }
        )
      );
    }

    return Ok(tickDecimal);
  }
}
