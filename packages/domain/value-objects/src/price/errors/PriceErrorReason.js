/**
 * Типизированные причины ошибок для Price операций
 *
 * @remarks
 * Используется в InvalidPriceError.context.reason для дифференциации ошибок
 * на уровне типов вместо строковых констант.
 *
 * @example
 * ```typescript
 * import { PriceErrorReason } from '@polymarket/value-objects/price';
 *
 * if (result.error.context?.reason === PriceErrorReason.NOT_ALIGNED) {
 *   console.error('Price not aligned to tick size');
 * }
 * ```
 */
export var PriceErrorReason;
(function (PriceErrorReason) {
    /** Значение NaN */
    PriceErrorReason["NAN"] = "NAN";
    /** Значение не finite (Infinity, -Infinity) */
    PriceErrorReason["NON_FINITE"] = "NON_FINITE";
    /** Деление на ноль */
    PriceErrorReason["DIVISION_BY_ZERO"] = "DIVISION_BY_ZERO";
    /** Ошибка парсинга значения */
    PriceErrorReason["INVALID_FORMAT"] = "INVALID_FORMAT";
    /** Цена не выровнена по tickSize */
    PriceErrorReason["NOT_ALIGNED"] = "NOT_ALIGNED";
    /** Невалидный tickSize */
    PriceErrorReason["INVALID_TICK_SIZE"] = "INVALID_TICK_SIZE";
    /** Цена вне допустимого диапазона (низкая) */
    PriceErrorReason["OUT_OF_RANGE_LOW"] = "OUT_OF_RANGE_LOW";
    /** Цена вне допустимого диапазона (высокая) */
    PriceErrorReason["OUT_OF_RANGE_HIGH"] = "OUT_OF_RANGE_HIGH";
})(PriceErrorReason || (PriceErrorReason = {}));
//# sourceMappingURL=PriceErrorReason.js.map