/**
 * Типизированные причины ошибок для Money операций
 *
 * @remarks
 * Используется в InvalidMoneyError.context.reason для дифференциации ошибок
 * на уровне типов вместо строковых констант.
 *
 * Преимущества:
 * - Compile-time проверка на опечатки
 * - Автодополнение в IDE
 * - Exhaustive checking в switch statements
 * - Безопасный рефакторинг через "Rename Symbol"
 *
 * @example
 * ```typescript
 * import { MoneyErrorReason } from '@polymarket/value-objects/money';
 *
 * if (result.error.context?.reason === MoneyErrorReason.DIVISION_BY_ZERO) {
 *   // TypeScript знает что это валидное значение
 * }
 * ```
 */
export declare enum MoneyErrorReason {
    /** Значение NaN */
    NAN = "NAN",
    /** Значение не finite (Infinity, -Infinity) */
    NON_FINITE = "NON_FINITE",
    /** Результат операции превышает максимальную сумму */
    EXCEEDS_MAX_AMOUNT = "EXCEEDS_MAX_AMOUNT",
    /** Несовпадение валют в add/subtract операциях */
    CURRENCY_MISMATCH = "CURRENCY_MISMATCH",
    /** Деление на ноль */
    DIVISION_BY_ZERO = "DIVISION_BY_ZERO",
    /** Неподдерживаемая валюта */
    UNSUPPORTED_CURRENCY = "UNSUPPORTED_CURRENCY",
    /** Ошибка парсинга значения */
    INVALID_FORMAT = "INVALID_FORMAT",
    /** Результат операции меньше нуля */
    NEGATIVE_RESULT = "NEGATIVE_RESULT",
    /** Невалидный Ratio для операции */
    INVALID_RATIO = "INVALID_RATIO",
    /** Ratio вне допустимого диапазона для операции */
    RATIO_OUT_OF_RANGE = "RATIO_OUT_OF_RANGE",
    /** Delta для increaseBy приведёт к отрицательному результату (delta < -1) */
    DELTA_LESS_THAN_MINUS_ONE = "DELTA_LESS_THAN_MINUS_ONE"
}
//# sourceMappingURL=MoneyErrorReason.d.ts.map