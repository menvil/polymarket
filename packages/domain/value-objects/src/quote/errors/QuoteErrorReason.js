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
 * - Валидация свежести (QUOTE_TOO_OLD)
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
export var QuoteErrorReason;
(function (QuoteErrorReason) {
    /** Обе стороны (bid и ask) null */
    QuoteErrorReason["BOTH_SIDES_NULL"] = "BOTH_SIDES_NULL";
    /** Bid больше ask */
    QuoteErrorReason["BID_GREATER_THAN_ASK"] = "BID_GREATER_THAN_ASK";
    /** Невалидный timestamp (не finite, не integer, отрицательный, или превышает максимум) */
    QuoteErrorReason["INVALID_TIMESTAMP"] = "INVALID_TIMESTAMP";
    /** Bid=null но bidSize>0 (структурная несогласованность) */
    QuoteErrorReason["INCONSISTENT_BID_SIZE"] = "INCONSISTENT_BID_SIZE";
    /** Ask=null но askSize>0 (структурная несогласованность) */
    QuoteErrorReason["INCONSISTENT_ASK_SIZE"] = "INCONSISTENT_ASK_SIZE";
    /** Ошибка парсинга значения */
    QuoteErrorReason["INVALID_FORMAT"] = "INVALID_FORMAT";
    /** Невалидный bid price */
    QuoteErrorReason["INVALID_BID"] = "INVALID_BID";
    /** Невалидный ask price */
    QuoteErrorReason["INVALID_ASK"] = "INVALID_ASK";
    /** Невалидный bid size */
    QuoteErrorReason["INVALID_BID_SIZE"] = "INVALID_BID_SIZE";
    /** Невалидный ask size */
    QuoteErrorReason["INVALID_ASK_SIZE"] = "INVALID_ASK_SIZE";
    /** Bid size должен быть > 0 когда bid определён */
    QuoteErrorReason["BID_SIZE_MUST_BE_POSITIVE"] = "BID_SIZE_MUST_BE_POSITIVE";
    /** Ask size должен быть > 0 когда ask определён */
    QuoteErrorReason["ASK_SIZE_MUST_BE_POSITIVE"] = "ASK_SIZE_MUST_BE_POSITIVE";
    /** Spread меньше минимального */
    QuoteErrorReason["SPREAD_TOO_NARROW"] = "SPREAD_TOO_NARROW";
    /** Spread больше максимального */
    QuoteErrorReason["SPREAD_TOO_WIDE"] = "SPREAD_TOO_WIDE";
    /** Quote пересекает market */
    QuoteErrorReason["MARKET_CROSSING"] = "MARKET_CROSSING";
    /** Котировка устарела (превышен максимальный возраст) */
    QuoteErrorReason["QUOTE_TOO_OLD"] = "QUOTE_TOO_OLD";
    // ============================================================================
    // Ratio Operations
    // ============================================================================
    /** Операция требует two-sided quote (bid и ask определены) */
    QuoteErrorReason["NOT_TWO_SIDED"] = "NOT_TWO_SIDED";
    /** Midpoint недоступен или равен нулю */
    QuoteErrorReason["MID_UNAVAILABLE"] = "MID_UNAVAILABLE";
    /** Невалидный Ratio объект */
    QuoteErrorReason["INVALID_RATIO"] = "INVALID_RATIO";
    /** Отрицательный Ratio не разрешён для операции (widen/tighten) */
    QuoteErrorReason["NEGATIVE_RATIO_NOT_ALLOWED"] = "NEGATIVE_RATIO_NOT_ALLOWED";
    /** Результат Ratio операции выходит за границы валидных значений */
    QuoteErrorReason["RATIO_OUT_OF_BOUNDS"] = "RATIO_OUT_OF_BOUNDS";
    /** Невалидный size factor для scaleSizesByRatio (должен быть > 0) */
    QuoteErrorReason["INVALID_SIZE_FACTOR"] = "INVALID_SIZE_FACTOR";
})(QuoteErrorReason || (QuoteErrorReason = {}));
//# sourceMappingURL=QuoteErrorReason.js.map