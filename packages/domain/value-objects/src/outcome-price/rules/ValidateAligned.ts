import { Result, Ok, Err } from '@polymarket/result';
import { InvalidOutcomePriceError, InvalidTickSizeError, ErrorSource } from '@polymarket/errors';
import { OutcomePrice } from '../core/OutcomePrice.js';
import { ValidateTickSizeMultipleOfBaseTick } from '../../shared/ValidateTickSizeMultipleOfBaseTick.js';
import type { AlignedErrorReason } from '../../shared/priceRuleTypes.js';
import type Decimal from 'decimal.js';

/**
 * Правило: OutcomePrice должен быть aligned к tickSize
 *
 * @remarks
 * КРИТИЧНАЯ ГАРАНТИЯ: после OutcomePriceService.roundToMarketTick()
 * результат ДОЛЖЕН проходить эту проверку.
 *
 * Проверяет что price кратен tickSize (price % tickSize === 0).
 * Использует div().isInteger() для стабильности на дробных числах.
 *
 * @example
 * ```typescript
 * import { OutcomePriceService, ValidateAligned } from '@polymarket/value-objects/outcome-price';
 *
 * const priceResult = OutcomePriceService.create(0.5);
 * if (!priceResult.ok) return;
 *
 * const alignResult = ValidateAligned.check(priceResult.value, new Decimal(0.0001));
 * if (alignResult.ok) {
 *   console.log('OutcomePrice aligned to tick size');
 * } else {
 *   console.error(alignResult.error.context.reason); // 'not_aligned'
 * }
 * ```
 */
export class ValidateAligned {
  /**
   * Проверяет что price выровнен по tickSize
   *
   * @param price - Цена для проверки
   * @param tickSize - Размер тика (уже Decimal - парсинг делается в Facade)
   * @returns Result<void> или InvalidOutcomePriceError | InvalidTickSizeError
   *
   * @remarks
   * ВАЖНО: Принимает только Decimal. Парсинг должен быть сделан в Facade через toDecimal().
   *
   * Выполняет две проверки:
   * 1. Валидация tickSize через ValidateTickSizeMultipleOfBaseTick (проверяет что кратен базовому тику 0.0001)
   * 2. Проверка кратности: price % tickSize === 0 (через div().isInteger())
   *
   * Возвращает InvalidTickSizeError если tickSize невалидный или не кратен базовому тику.
   * Возвращает InvalidOutcomePriceError если price не кратен tickSize.
   *
   * @example
   * ```typescript
   * const price = OutcomePrice.of(new Decimal(0.5));
   *
   * // ✅ Валидные комбинации
   * ValidateAligned.check(price, new Decimal(0.0001)); // Ok (0.5 % 0.0001 === 0)
   * ValidateAligned.check(price, new Decimal(0.01));   // Ok (0.5 % 0.01 === 0)
   * ValidateAligned.check(price, new Decimal(0.1));    // Ok (0.5 % 0.1 === 0)
   * ValidateAligned.check(price, new Decimal(0.5));    // Ok (0.5 % 0.5 === 0)
   *
   * // ❌ Невалидные (не кратен)
   * ValidateAligned.check(price, new Decimal(0.3));    // Err: not_aligned
   * ValidateAligned.check(price, new Decimal(0.7));    // Err: not_aligned
   * ```
   */
  public static check(
    price: OutcomePrice,
    tickSize: Decimal
  ): Result<void, InvalidOutcomePriceError | InvalidTickSizeError> {
    // Валидация tickSize (проверяет что кратен базовому тику 0.0001)
    const tickResult = ValidateTickSizeMultipleOfBaseTick.check(tickSize, OutcomePrice.MIN.value(), OutcomePrice.MAX.value().minus(OutcomePrice.MIN.value()));
    if (!tickResult.ok) {
      return Err(tickResult.error);
    }
    const tickDecimal = tickResult.value;

    // Проверка кратности через div().isInteger()
    const quotient = price.value().div(tickDecimal);
    if (!quotient.isInteger()) {
      return Err(
        new InvalidOutcomePriceError(
          (ctx) => `OutcomePrice ${ctx.price} is not aligned to tick size ${ctx.tickSize}`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              field: 'price',
              reason: 'not_aligned' as AlignedErrorReason,
              price: price.value().toString(),
              tickSize: tickDecimal.toString()
            }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
