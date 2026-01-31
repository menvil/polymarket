import { Result, Ok, Err } from '@polymarket/result';
import { InvalidTickSizeError } from '@polymarket/errors';
import { Price } from '../core/Price.js';
import { ValidateTickSize } from './ValidateTickSize.js';
import type { TickSizeMultipleReason } from './types.js';
import type Decimal from 'decimal.js';

/**
 * Правило: TickSize должен быть кратен базовому тику Polymarket
 *
 * @remarks
 * POLYMARKET-СПЕЦИФИЧНОЕ правило.
 * Базовый тик = MIN_PRICE (0.0001).
 *
 * Сначала выполняет базовую валидацию через ValidateTickSize,
 * затем проверяет кратность базовому тику.
 *
 * @example
 * ```typescript
 * import { ValidateTickSizeMultipleOfBaseTick } from '@polymarket/value-objects/price';
 *
 * const result = ValidateTickSizeMultipleOfBaseTick.check(0.0002);
 * if (result.ok) {
 *   console.log('TickSize кратен базовому тику');
 * } else {
 *   console.error(result.error.context.reason); // 'not_multiple_of_base_tick'
 * }
 * ```
 */
export class ValidateTickSizeMultipleOfBaseTick {
  /**
   * Проверяет что tickSize кратен базовому тику (0.0001)
   *
   * @param tickSize - Размер тика для проверки
   * @returns Result с валидированным Decimal или InvalidTickSizeError
   *
   * @remarks
   * Выполняет две проверки:
   * 1. Базовая валидация через ValidateTickSize (positive, finite, в пределах диапазона)
   * 2. Проверка кратности базовому тику: tickSize % 0.0001 === 0
   *
   * @example
   * ```typescript
   * // ✅ Валидные tickSize (кратны 0.0001)
   * ValidateTickSizeMultipleOfBaseTick.check(0.0001); // Ok
   * ValidateTickSizeMultipleOfBaseTick.check(0.0002); // Ok
   * ValidateTickSizeMultipleOfBaseTick.check(0.01);   // Ok
   *
   * // ❌ Невалидные (не кратны 0.0001)
   * ValidateTickSizeMultipleOfBaseTick.check(0.00015); // Err: not_multiple_of_base_tick
   * ValidateTickSizeMultipleOfBaseTick.check(0.003);   // Err: not_multiple_of_base_tick
   * ```
   */
  public static check(
    tickSize: number | string | Decimal
  ): Result<Decimal, InvalidTickSizeError> {
    // Шаг 1: Базовая валидация
    const tickResult = ValidateTickSize.check(tickSize);
    if (!tickResult.ok) {
      return tickResult;
    }
    const tickDecimal = tickResult.value;

    // Шаг 2: Проверка кратности
    const BASE_TICK = Price.minValue();
    const quotient = tickDecimal.div(BASE_TICK);

    if (!quotient.isInteger()) {
      return Err(
        new InvalidTickSizeError(
          (ctx) =>
            `Tick size ${ctx.tickSize} must be multiple of base tick ${ctx.baseTick}`,
          {
            context: {
              field: 'tickSize',
              reason: 'not_multiple_of_base_tick' as TickSizeMultipleReason,
              tickSize: tickDecimal.toString(),
              baseTick: BASE_TICK.toString(),
              quotient: quotient.toString()
            }
          }
        )
      );
    }

    return Ok(tickDecimal);
  }
}
