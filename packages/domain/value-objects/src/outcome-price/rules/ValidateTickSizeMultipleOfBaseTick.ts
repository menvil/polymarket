import { Result, Ok, Err } from '@polymarket/result';
import { InvalidTickSizeError, ErrorSource } from '@polymarket/errors';
import { OutcomePrice } from '../core/OutcomePrice.js';
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
 * import { ValidateTickSizeMultipleOfBaseTick } from '@polymarket/value-objects/outcome-price';
 *
 * const result = ValidateTickSizeMultipleOfBaseTick.check(new Decimal('0.0002'));
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
   * @param tickSize - Размер тика (уже Decimal - парсинг делается в Facade)
   * @returns Result с валидированным Decimal или InvalidTickSizeError
   *
   * @remarks
   * ВАЖНО: Принимает только Decimal. Парсинг должен быть сделан в Facade через toDecimal().
   *
   * Выполняет две проверки:
   * 1. Базовая валидация через ValidateTickSize (positive, finite, в пределах диапазона)
   * 2. Проверка кратности базовому тику: tickSize % 0.0001 === 0
   *
   * @example
   * ```typescript
   * // ✅ Валидные tickSize (кратны 0.0001)
   * const tick1 = new Decimal('0.0001');
   * ValidateTickSizeMultipleOfBaseTick.check(tick1); // Ok
   *
   * const tick2 = new Decimal('0.0002');
   * ValidateTickSizeMultipleOfBaseTick.check(tick2); // Ok
   *
   * // ❌ Невалидные (не кратны 0.0001)
   * const tick3 = new Decimal('0.00015');
   * ValidateTickSizeMultipleOfBaseTick.check(tick3); // Err: not_multiple_of_base_tick
   * ```
   */
  public static check(
    tickSize: Decimal
  ): Result<Decimal, InvalidTickSizeError> {
    // Шаг 1: Базовая валидация
    const tickResult = ValidateTickSize.check(tickSize);
    if (!tickResult.ok) {
      return tickResult;
    }
    const tickDecimal = tickResult.value;

    // Шаг 2: Проверка кратности
    const BASE_TICK = OutcomePrice.MIN.value();
    const quotient = tickDecimal.div(BASE_TICK);

    if (!quotient.isInteger()) {
      return Err(
        new InvalidTickSizeError(
          (ctx) =>
            `Tick size ${ctx.tickSize} must be multiple of base tick ${ctx.baseTick}`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
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
