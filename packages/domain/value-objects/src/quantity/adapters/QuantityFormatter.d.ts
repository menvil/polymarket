import { Quantity } from '../core/Quantity.js';
import { InvalidDecimalPlacesError } from '@polymarket/errors';
import { Result } from '@polymarket/result';
/**
 * Форматирование Quantity в строки
 */
export declare class QuantityFormatter {
    private static readonly THOUSAND;
    private static readonly MILLION;
    /**
     * Форматирует в string с фиксированным количеством decimal places
     *
     * @param quantity - Количество для форматирования
     * @param decimals - Количество знаков после запятой (default: 2, max: 100)
     * @returns Result с отформатированной строкой или ошибкой
     *
     * @example
     * ```typescript
     * const result = QuantityFormatter.toString(Quantity.of(10.5), 2);
     * if (result.ok) {
     *   console.log(result.value); // "10.50"
     * }
     * ```
     */
    static toString(quantity: Quantity, decimals?: number): Result<string, InvalidDecimalPlacesError>;
    /**
     * Форматирует в компактную строку (без trailing zeros)
     *
     * @param quantity - Количество для форматирования
     * @returns Компактная строка
     *
     * @example
     * ```typescript
     * QuantityFormatter.toCompactString(Quantity.of(10.5)); // "10.5"
     * QuantityFormatter.toCompactString(Quantity.of(10)); // "10"
     * ```
     */
    static toCompactString(quantity: Quantity): string;
    /**
     * Форматирует для отладки
     *
     * @param quantity - Количество для форматирования
     * @returns Debug строка
     *
     * @example
     * ```typescript
     * QuantityFormatter.toDebugString(Quantity.of(10)); // "Quantity(10)"
     * ```
     */
    static toDebugString(quantity: Quantity): string;
    /**
     * Форматирует для отображения с K/M суффиксами
     *
     * @remarks
     * ⚠️ ВНИМАНИЕ: Использует toNumber() → lossy для больших значений.
     * Это форматтер для UI, точность не гарантируется.
     *
     * @param quantity - Количество для форматирования
     * @returns Display строка с суффиксами
     *
     * @example
     * ```typescript
     * QuantityFormatter.toDisplayString(Quantity.of(1500)); // "1.50K"
     * QuantityFormatter.toDisplayString(Quantity.of(1500000)); // "1.50M"
     * QuantityFormatter.toDisplayString(Quantity.of(100)); // "100.00"
     * ```
     */
    static toDisplayString(quantity: Quantity): string;
}
//# sourceMappingURL=QuantityFormatter.d.ts.map