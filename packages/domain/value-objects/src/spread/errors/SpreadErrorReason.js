/**
 * Типизированные причины ошибок для Spread
 *
 * @remarks
 * Централизованный enum для всех типов ошибок в Spread module.
 * Используется как в Core (InvariantViolation), так и в Facade (InvalidSpreadError).
 *
 * Аналогично:
 * - MoneyErrorReason (8 значений)
 * - PriceErrorReason (10 значений)
 * - QuantityErrorReason (8 значений)
 */
export var SpreadErrorReason;
(function (SpreadErrorReason) {
    // ============================================================================
    // Invariant Violations (Core)
    // ============================================================================
    /**
     * Bid цена превышает ask цену
     *
     * @remarks
     * Основной инвариант spread: bid <= ask.
     * Нарушение означает кросс рынка (арбитражная ситуация).
     */
    SpreadErrorReason["BID_GREATER_THAN_ASK"] = "BID_GREATER_THAN_ASK";
    /**
     * Bid не является валидным Price объектом
     */
    SpreadErrorReason["INVALID_BID"] = "INVALID_BID";
    /**
     * Ask не является валидным Price объектом
     */
    SpreadErrorReason["INVALID_ASK"] = "INVALID_ASK";
    // ============================================================================
    // Width Constraints (Rules)
    // ============================================================================
    /**
     * Ширина спреда меньше минимальной
     *
     * @remarks
     * Используется в ValidateMinWidth rule.
     */
    SpreadErrorReason["WIDTH_TOO_SMALL"] = "WIDTH_TOO_SMALL";
    /**
     * Ширина спреда превышает максимальную
     *
     * @remarks
     * Используется в ValidateMaxWidth rule.
     */
    SpreadErrorReason["WIDTH_TOO_LARGE"] = "WIDTH_TOO_LARGE";
    // ============================================================================
    // Operation Errors (Facade)
    // ============================================================================
    /**
     * Ошибка парсинга значения
     *
     * @remarks
     * Используется при парсинге входных параметров (bid, ask, amount).
     * Например: невалидный строковый формат, NaN, non-finite values.
     */
    SpreadErrorReason["INVALID_FORMAT"] = "INVALID_FORMAT";
    /**
     * Невалидная величина для операции (tighten/widen/shift)
     *
     * @remarks
     * Amount должен быть:
     * - Finite
     * - Non-negative (для tighten/widen)
     * - Finite (для shift, может быть отрицательным)
     */
    SpreadErrorReason["INVALID_AMOUNT"] = "INVALID_AMOUNT";
    /**
     * Невалидная ширина spread
     *
     * @remarks
     * Width должна быть:
     * - Finite
     * - Non-negative
     * Используется в fromMidAndWidth
     */
    SpreadErrorReason["INVALID_WIDTH"] = "INVALID_WIDTH";
    /**
     * Операция приведёт к выходу за границы валидных значений
     *
     * @remarks
     * Например:
     * - tighten/widen выходит за [MIN_PRICE, MAX_PRICE]
     * - shift выходит за границы
     */
    SpreadErrorReason["OPERATION_OUT_OF_BOUNDS"] = "OPERATION_OUT_OF_BOUNDS";
    // ============================================================================
    // Ratio Operations (Facade)
    // ============================================================================
    /**
     * Операция требует two-sided spread (bid и ask определены)
     *
     * @remarks
     * Используется в Ratio operations (shiftByRatio, widenByRatio, etc.)
     * которые требуют вычисления midpoint.
     */
    SpreadErrorReason["NOT_TWO_SIDED"] = "NOT_TWO_SIDED";
    /**
     * Midpoint недоступен или равен нулю
     *
     * @remarks
     * Используется в getSpreadRatio когда midpoint = 0
     * (теоретически невозможно для Price, но защита).
     */
    SpreadErrorReason["MID_UNAVAILABLE"] = "MID_UNAVAILABLE";
    /**
     * Невалидный Ratio объект
     *
     * @remarks
     * Ratio не является валидным (NaN, Infinity, etc.)
     */
    SpreadErrorReason["INVALID_RATIO"] = "INVALID_RATIO";
    /**
     * Отрицательный Ratio не разрешён для операции
     *
     * @remarks
     * Используется в widenByRatio/tightenByRatio где deltaWidthRatio должен быть >= 0.
     */
    SpreadErrorReason["NEGATIVE_RATIO_NOT_ALLOWED"] = "NEGATIVE_RATIO_NOT_ALLOWED";
    /**
     * Результат Ratio операции выходит за границы валидных значений
     *
     * @remarks
     * После применения Ratio операции результат выходит за границы Price [0.0001, 0.9999]
     * или нарушает bid <= ask инвариант.
     */
    SpreadErrorReason["RATIO_OUT_OF_BOUNDS"] = "RATIO_OUT_OF_BOUNDS";
    // ============================================================================
    // Parse/Serialization Errors (Adapters)
    // ============================================================================
    /**
     * Невалидный JSON при десериализации
     */
    SpreadErrorReason["INVALID_JSON"] = "INVALID_JSON";
    /**
     * Невалидный DTO объект (отсутствуют поля или неверные типы)
     */
    SpreadErrorReason["INVALID_DTO"] = "INVALID_DTO";
})(SpreadErrorReason || (SpreadErrorReason = {}));
//# sourceMappingURL=SpreadErrorReason.js.map