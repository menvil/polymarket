/**
 * Типизированные причины ошибок для Quote операций
 *
 * @remarks
 * Используется в InvalidQuoteError.context.reason для дифференциации ошибок
 * на уровне типов вместо строковых констант.
 *
 * Структура:
 * - Инварианты Core (BOTH_SIDES_NULL, BID_GREATER_THAN_ASK, INVALID_TIMESTAMP, INCONSISTENT_BID_SIZE, INCONSISTENT_ASK_SIZE)
 * - Ошибки парсинга (INVALID_FORMAT)
 * - Ошибки компонентов (INVALID_BID, INVALID_ASK, INVALID_BID_SIZE, INVALID_ASK_SIZE)
 * - Бизнес-правила (BID_SIZE_MUST_BE_POSITIVE, ASK_SIZE_MUST_BE_POSITIVE)
 * - Валидация spread (SPREAD_TOO_NARROW, SPREAD_TOO_WIDE)
 * - Market crossing (MARKET_CROSSING)
 *
 * @example
 * ```typescript
 * import { QuoteErrorReason } from '@polymarket/value-objects/quote';
 *
 * if (result.error.context?.reason === QuoteErrorReason.BOTH_SIDES_NULL) {
 *   console.error('Quote must have at least bid or ask');
 * }
 * ```
 */
export enum QuoteErrorReason {
  /** Обе стороны (bid и ask) null */
  BOTH_SIDES_NULL = 'BOTH_SIDES_NULL',

  /** Bid больше ask */
  BID_GREATER_THAN_ASK = 'BID_GREATER_THAN_ASK',

  /** Невалидный timestamp (не finite, не integer, отрицательный, или превышает максимум) */
  INVALID_TIMESTAMP = 'INVALID_TIMESTAMP',

  /** Bid=null но bidSize>0 (структурная несогласованность) */
  INCONSISTENT_BID_SIZE = 'INCONSISTENT_BID_SIZE',

  /** Ask=null но askSize>0 (структурная несогласованность) */
  INCONSISTENT_ASK_SIZE = 'INCONSISTENT_ASK_SIZE',

  /** Ошибка парсинга значения */
  INVALID_FORMAT = 'INVALID_FORMAT',

  /** Невалидный bid price */
  INVALID_BID = 'INVALID_BID',

  /** Невалидный ask price */
  INVALID_ASK = 'INVALID_ASK',

  /** Невалидный bid size */
  INVALID_BID_SIZE = 'INVALID_BID_SIZE',

  /** Невалидный ask size */
  INVALID_ASK_SIZE = 'INVALID_ASK_SIZE',

  /** Bid size должен быть > 0 когда bid определён */
  BID_SIZE_MUST_BE_POSITIVE = 'BID_SIZE_MUST_BE_POSITIVE',

  /** Ask size должен быть > 0 когда ask определён */
  ASK_SIZE_MUST_BE_POSITIVE = 'ASK_SIZE_MUST_BE_POSITIVE',

  /** Spread меньше минимального */
  SPREAD_TOO_NARROW = 'SPREAD_TOO_NARROW',

  /** Spread больше максимального */
  SPREAD_TOO_WIDE = 'SPREAD_TOO_WIDE',

  /** Quote пересекает market */
  MARKET_CROSSING = 'MARKET_CROSSING'
}
