import { Result, Ok, Err } from '@polymarket/result';
import { InvalidQuoteError, ErrorSource } from '@polymarket/errors';
import { OutcomePrice } from '../../outcome-price/core/OutcomePrice.js';
import { Quantity } from '../../quantity/core/Quantity.js';
import { QuoteErrorReason } from '../errors/QuoteErrorReason.js';

/**
 * Проверяет консистентность размеров котировки
 *
 * @remarks
 * Правило: если цена определена, размер должен быть > 0
 *
 * Это бизнес-правило, не инвариант Core:
 * - Core допускает bid с zero bidSize (технически валидно)
 * - Но для market making котировок это невалидно
 *
 * @example
 * ```typescript
 * const result = ValidateQuoteSizes.check(bid, bidSize, ask, askSize);
 * if (!result.ok) {
 *   console.error('Invalid sizes');
 * }
 * ```
 */
export class ValidateQuoteSizes {
  /**
   * Проверяет соответствие размеров ценам
   *
   * @param bid - Цена покупки (может быть null)
   * @param bidSize - Объём покупки
   * @param ask - Цена продажи (может быть null)
   * @param askSize - Объём продажи
   * @returns Result с void или InvalidQuoteError
   *
   * @example
   * ```typescript
   * const bid = OutcomePrice.of(0.50);
   * const bidSize = Quantity.ZERO; // ❌ invalid
   * const ask = OutcomePrice.of(0.51);
   * const askSize = Quantity.of(100);
   *
   * const result = ValidateQuoteSizes.check(bid, bidSize, ask, askSize);
   * // result.ok === false
   * // result.error.context.reason === QuoteErrorReason.BID_SIZE_MUST_BE_POSITIVE
   * ```
   */
  public static check(
    bid: OutcomePrice | null,
    bidSize: Quantity,
    ask: OutcomePrice | null,
    askSize: Quantity
  ): Result<void, InvalidQuoteError> {
    // Если bid определён, bidSize должен быть положительным
    if (bid !== null && !bidSize.isPositive()) {
      return Err(
        new InvalidQuoteError('Bid size must be positive when bid is defined', {
          context: {
            source: ErrorSource.RULE_VALIDATION,
            reason: QuoteErrorReason.BID_SIZE_MUST_BE_POSITIVE,
            bidValue: bid.value().toNumber(),
            bidSize: bidSize.value().toNumber()
          }
        })
      );
    }

    // Если ask определён, askSize должен быть положительным
    if (ask !== null && !askSize.isPositive()) {
      return Err(
        new InvalidQuoteError('Ask size must be positive when ask is defined', {
          context: {
            source: ErrorSource.RULE_VALIDATION,
            reason: QuoteErrorReason.ASK_SIZE_MUST_BE_POSITIVE,
            askValue: ask.value().toNumber(),
            askSize: askSize.value().toNumber()
          }
        })
      );
    }

    return Ok(undefined);
  }
}
