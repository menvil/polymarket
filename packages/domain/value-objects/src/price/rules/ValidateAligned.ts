import { Result, Ok, Err } from '@polymarket/result';
import { InvalidPriceError, InvalidTickSizeError } from '@polymarket/errors';
import { Price } from '../core/Price.js';
import { ValidateTickSizeMultipleOfBaseTick } from './ValidateTickSizeMultipleOfBaseTick.js';
import type { AlignedErrorReason } from './types.js';
import type Decimal from 'decimal.js';

/**
 * Правило: Price должен быть aligned к tickSize
 *
 * @remarks
 * КРИТИЧНАЯ ГАРАНТИЯ: после PriceService.roundToMarketTick()
 * результат ДОЛЖЕН проходить эту проверку.
 *
 * Проверяет что price кратен tickSize (price % tickSize === 0).
 * Использует div().isInteger() для стабильности на дробных числах.
 *
 * @example
 * ```typescript
 * import { PriceService, ValidateAligned } from '@polymarket/value-objects/price';
 *
 * const priceResult = PriceService.create(0.5);
 * if (!priceResult.ok) return;
 *
 * const alignResult = ValidateAligned.check(priceResult.value, 0.0001);
 * if (alignResult.ok) {
 *   console.log('Price aligned to tick size');
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
   * @param tickSize - Размер тика
   * @returns Result<void> или InvalidPriceError | InvalidTickSizeError
   *
   * @remarks
   * Выполняет две проверки:
   * 1. Валидация tickSize через ValidateTickSizeMultipleOfBaseTick (проверяет что кратен базовому тику 0.0001)
   * 2. Проверка кратности: price % tickSize === 0 (через div().isInteger())
   *
   * Возвращает InvalidTickSizeError если tickSize невалидный или не кратен базовому тику.
   * Возвращает InvalidPriceError если price не кратен tickSize.
   *
   * @example
   * ```typescript
   * const price = Price.of(0.5);
   *
   * // ✅ Валидные комбинации
   * ValidateAligned.check(price, 0.0001); // Ok (0.5 % 0.0001 === 0)
   * ValidateAligned.check(price, 0.01);   // Ok (0.5 % 0.01 === 0)
   * ValidateAligned.check(price, 0.1);    // Ok (0.5 % 0.1 === 0)
   * ValidateAligned.check(price, 0.5);    // Ok (0.5 % 0.5 === 0)
   *
   * // ❌ Невалидные (не кратен)
   * ValidateAligned.check(price, 0.3);    // Err: not_aligned
   * ValidateAligned.check(price, 0.7);    // Err: not_aligned
   * ```
   */
  public static check(
    price: Price,
    tickSize: number | string | Decimal
  ): Result<void, InvalidPriceError | InvalidTickSizeError> {
    // Валидация tickSize (проверяет что кратен базовому тику 0.0001)
    const tickResult = ValidateTickSizeMultipleOfBaseTick.check(tickSize);
    if (!tickResult.ok) {
      return Err(tickResult.error);
    }
    const tickDecimal = tickResult.value;

    // Проверка кратности через div().isInteger()
    const quotient = price.value().div(tickDecimal);
    if (!quotient.isInteger()) {
      return Err(
        new InvalidPriceError(
          (ctx) => `Price ${ctx.price} is not aligned to tick size ${ctx.tickSize}`,
          {
            context: {
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
