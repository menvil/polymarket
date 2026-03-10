/**
 * Типизированные причины ошибок Timestamp
 *
 * @remarks
 * Используется в ValidationError.context.reason для идентификации типа ошибки.
 */
export var TimestampErrorReason;
(function (TimestampErrorReason) {
    /**
     * Ошибка парсинга значения
     */
    TimestampErrorReason["INVALID_FORMAT"] = "INVALID_FORMAT";
    /**
     * Значение не является конечным числом (NaN, Infinity)
     */
    TimestampErrorReason["NOT_FINITE"] = "NOT_FINITE";
    /**
     * Значение отрицательное (< 0)
     *
     * @remarks
     * Unix epoch начинается с 0 (1970-01-01T00:00:00Z), поэтому 0 - валидное значение.
     * Проверяем что значение >= 0.
     */
    TimestampErrorReason["NEGATIVE"] = "NEGATIVE";
    /**
     * Значение не является целым числом
     *
     * @remarks
     * Timestamp должен быть integer миллисекундами.
     * Дробные значения не допускаются.
     */
    TimestampErrorReason["NOT_INTEGER"] = "NOT_INTEGER";
    /**
     * Значение выходит за разумные границы
     *
     * @remarks
     * Максимальное значение: 9999999999999 (~год 2286).
     * Значения больше этого, вероятно, являются ошибкой (например, микросекунды вместо миллисекунд).
     */
    TimestampErrorReason["OUT_OF_RANGE"] = "OUT_OF_RANGE";
    /**
     * Невалидная ISO 8601 строка
     */
    TimestampErrorReason["INVALID_ISO"] = "INVALID_ISO";
})(TimestampErrorReason || (TimestampErrorReason = {}));
//# sourceMappingURL=TimestampErrorReason.js.map