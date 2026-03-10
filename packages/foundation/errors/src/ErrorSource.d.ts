/**
 * Источник ошибки в цепочке обработки Value Object операций
 *
 * @remarks
 * Enum для явного указания этапа, на котором произошла ошибка.
 * Упрощает отладку и мониторинг, позволяя быстро определить:
 * - Parsing: ошибка парсинга входных данных (toDecimal)
 * - Core Invariant: нарушение инварианта домена (Price.of, Quote.of и т.д.)
 * - Rule Validation: нарушение бизнес-правила (Rules.check)
 * - Math Operation: ошибка математической операции (@polymarket/math)
 * - Service Call: ошибка из вложенного service вызова
 * - Unexpected: неожиданная ошибка (catch-all)
 *
 * **Семантика:**
 * - `source` - это root-field в error context
 * - При rewrap() `source` сохраняется из inner error вместе с `cause`, `reason`, `raw`
 * - Используется для быстрой диагностики без анализа полей `raw`, `cause`, `reason`
 *
 * @example
 * ```typescript
 * // Parsing error
 * const result = toDecimal('amount', 'invalid', 'INVALID_FORMAT', InvalidMoneyError);
 * // result.error.context.source === ErrorSource.PARSING
 *
 * // Core invariant violation
 * const price = PriceService.create(Decimal(-1));
 * // price.error.context.source === ErrorSource.CORE_INVARIANT
 *
 * // Rule validation
 * const result = ValidateMinSize.check(quantity, minSize);
 * // result.error.context.source === ErrorSource.RULE_VALIDATION
 *
 * // Math operation error
 * const result = MathService.divide(a, Decimal(0));
 * // result.error.context.source === ErrorSource.MATH_OPERATION
 *
 * // Service call error
 * const quote = QuoteService.create(timestamp, bid, bidSize, askSize);
 * // Если bid невалиден через PriceService.create:
 * // quote.error.context.source === ErrorSource.SERVICE_CALL
 * ```
 *
 * @public
 */
export declare enum ErrorSource {
    /**
     * Ошибка парсинга входных данных (toDecimal)
     *
     * @remarks
     * Возникает при конвертации string/number в Decimal.
     * Обычно содержит context.raw с невалидным значением.
     */
    PARSING = "parsing",
    /**
     * Нарушение инварианта Core класса
     *
     * @remarks
     * Возникает при вызове Price.of(), Quote.of(), Balance.of() и т.д.
     * Содержит context.reason с типизированной причиной нарушения.
     */
    CORE_INVARIANT = "core_invariant",
    /**
     * Нарушение бизнес-правила (Rules.check)
     *
     * @remarks
     * Возникает при валидации через Rules (ValidateMinSize, ValidateAligned и т.д.).
     * Содержит context.reason с конкретным правилом.
     */
    RULE_VALIDATION = "rule_validation",
    /**
     * Ошибка математической операции
     *
     * @remarks
     * Возникает при вызове @polymarket/math функций (divide, multiply и т.д.).
     * Обычно содержит context.operation и context.values.
     */
    MATH_OPERATION = "math_operation",
    /**
     * Ошибка из вложенного service вызова
     *
     * @remarks
     * Возникает когда один Service вызывает другой и получает Err.
     * Например, QuoteService.create вызывает PriceService.create.
     * Содержит context.cause с оригинальной ошибкой.
     */
    SERVICE_CALL = "service_call",
    /**
     * Ошибка неправильного использования API (developer mistake)
     *
     * @remarks
     * Возникает при нарушении контракта API (TypeError, null/undefined где не ожидалось).
     * Отличается от UNEXPECTED - это баг в коде разработчика, а не runtime issue.
     * Содержит context.reason = 'MISUSE' и context.cause с TypeError.
     *
     * @example
     * ```typescript
     * // TypeError: Cannot read property 'amount' of null
     * const result = MoneyService.add(null, money2);
     * // result.error.context.source === ErrorSource.DEVELOPER_MISUSE
     * ```
     */
    DEVELOPER_MISUSE = "developer_misuse",
    /**
     * Неожиданная ошибка (catch-all)
     *
     * @remarks
     * Используется в catch блоках для непредвиденных ошибок.
     * Содержит context.cause с оригинальным Error объектом.
     */
    UNEXPECTED = "unexpected"
}
//# sourceMappingURL=ErrorSource.d.ts.map