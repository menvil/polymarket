/**
 * Форматирование Ratio в строки
 *
 * @remarks
 * Все методы возвращают Result<string, InvalidRatioError>
 * Поддерживаются форматы:
 * - Decimal: "0.02"
 * - Percent: "2.00%"
 * - Basis points: "200 bps"
 *
 * @example
 * ```typescript
 * const ratio = RatioService.fromPercent(2.5).value;
 *
 * RatioFormatter.toDecimal(ratio); // "0.025"
 * RatioFormatter.toPercent(ratio, 2); // "2.50%"
 * RatioFormatter.toBps(ratio, 0); // "250 bps"
 * ```
 */
import { Result } from '@polymarket/result';
import { InvalidRatioError } from '@polymarket/errors';
import { Ratio } from '../core/Ratio.js';
export declare class RatioFormatter {
    /**
     * Форматировать как decimal string
     *
     * @param ratio - Ratio для форматирования
     * @param decimals - Количество десятичных знаков (по умолчанию 4)
     * @returns Result с отформатированной строкой
     *
     * @example
     * ```typescript
     * const ratio = RatioService.fromPercent(2).value;
     * RatioFormatter.toDecimal(ratio, 4); // "0.0200"
     * ```
     */
    static toDecimal(ratio: Ratio, decimals?: number): Result<string, InvalidRatioError>;
    /**
     * Форматировать как процент
     *
     * @param ratio - Ratio для форматирования
     * @param decimals - Количество десятичных знаков (по умолчанию 2)
     * @returns Result с отформатированной строкой (например, "2.50%")
     *
     * @example
     * ```typescript
     * const ratio = RatioService.fromPercent(2.5).value;
     * RatioFormatter.toPercent(ratio, 2); // "2.50%"
     * RatioFormatter.toPercent(ratio, 1); // "2.5%"
     * ```
     */
    static toPercent(ratio: Ratio, decimals?: number): Result<string, InvalidRatioError>;
    /**
     * Форматировать как basis points
     *
     * @param ratio - Ratio для форматирования
     * @param decimals - Количество десятичных знаков (по умолчанию 0)
     * @returns Result с отформатированной строкой (например, "250 bps")
     *
     * @example
     * ```typescript
     * const ratio = RatioService.fromPercent(2.5).value;
     * RatioFormatter.toBps(ratio, 0); // "250 bps"
     * RatioFormatter.toBps(ratio, 1); // "250.0 bps"
     * ```
     */
    static toBps(ratio: Ratio, decimals?: number): Result<string, InvalidRatioError>;
    /**
     * Парсинг строки в Ratio
     *
     * @remarks
     * Поддерживаются форматы:
     * - "0.02" - decimal
     * - "2%" - percent
     * - "200 bps" - basis points
     *
     * @param input - Строка для парсинга
     * @returns Result с Ratio или InvalidRatioError
     *
     * @example
     * ```typescript
     * RatioFormatter.parse("0.02");   // Ok(Ratio(0.02))
     * RatioFormatter.parse("2%");     // Ok(Ratio(0.02))
     * RatioFormatter.parse("200 bps"); // Ok(Ratio(0.02))
     * RatioFormatter.parse("invalid"); // Err(InvalidRatioError)
     * ```
     */
    /**
     * Проверяет что строка не содержит hex/bin/oct литералы
     *
     * @remarks
     * Decimal.js принимает 0x, 0b, 0o префиксы, но для Ratio это нежелательно
     *
     * @param value - Значение для проверки
     * @returns true если строка содержит недопустимые префиксы
     */
    private static hasInvalidPrefix;
    static parse(input: string): Result<Ratio, InvalidRatioError>;
}
//# sourceMappingURL=RatioFormatter.d.ts.map