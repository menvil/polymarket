import { Quote } from '../core/Quote.js';
/**
 * Опции форматирования для котировок
 *
 * @remarks
 * Позволяет настроить формат вывода котировки.
 */
export interface QuoteFormatOptions {
    /**
     * Количество десятичных знаков для цен (по умолчанию: 4)
     */
    priceDecimals?: number;
    /**
     * Количество десятичных знаков для размеров (по умолчанию: 2)
     */
    sizeDecimals?: number;
    /**
     * Включить временную метку в вывод (по умолчанию: false)
     */
    includeTimestamp?: boolean;
    /**
     * Показывать spread (по умолчанию: true в toDetailed, false в других методах)
     */
    includeSpread?: boolean;
    /**
     * Показывать mid price (по умолчанию: true в toDetailed, false в других методах)
     */
    includeMid?: boolean;
    /**
     * Показывать source ID (по умолчанию: false)
     */
    includeSource?: boolean;
    /**
     * Показывать instrument ID (по умолчанию: false)
     */
    includeInstrument?: boolean;
}
/**
 * QuoteFormatter - адаптер для форматирования Quote в читаемый вид
 *
 * @remarks
 * Предоставляет методы для форматирования котировок в различные строковые представления.
 * Все методы "Never Throw" - гарантированно не бросают исключения.
 *
 * Алгоритм:
 * 1. toDisplay() - форматирует в "bid @ size / ask @ size"
 * 2. toShort() - краткий формат "bid/ask"
 * 3. toDetailed() - подробный формат с spread и mid
 * 4. toTable() - табличный формат для консольного вывода
 *
 * @example
 * ```typescript
 * const quote = Quote.of(Price.of(0.48), Price.of(0.52), ...);
 *
 * // Базовый формат
 * console.log(QuoteFormatter.toDisplay(quote));
 * // "0.4800 @ 100.00 / 0.5200 @ 150.00"
 *
 * // Краткий формат
 * console.log(QuoteFormatter.toShort(quote));
 * // "0.4800/0.5200"
 *
 * // Подробный формат
 * console.log(QuoteFormatter.toDetailed(quote));
 * // "Bid: 0.4800 @ 100.00, Ask: 0.5200 @ 150.00, Spread: 0.0400 (8.00%), Mid: 0.5000"
 * ```
 */
export declare class QuoteFormatter {
    /**
     * Форматирует Quote в читаемый вид "bid @ size / ask @ size"
     *
     * @param quote - Quote для форматирования
     * @param options - Опции форматирования
     * @returns Форматированная строка
     *
     * @remarks
     * Метод "Never Throw" - гарантированно не бросает исключения.
     * Для one-sided котировок показывает только доступную сторону.
     *
     * @example
     * ```typescript
     * const quote = Quote.of(Price.of(0.48), Price.of(0.52), Quantity.of(100), Quantity.of(150), Date.now());
     * console.log(QuoteFormatter.toDisplay(quote));
     * // "0.4800 @ 100.00 / 0.5200 @ 150.00"
     *
     * // Bid-only котировка
     * const bidOnly = Quote.of(Price.of(0.50), null, Quantity.of(100), Quantity.of(0), Date.now());
     * console.log(QuoteFormatter.toDisplay(bidOnly));
     * // "0.5000 @ 100.00 / --"
     * ```
     */
    static toDisplay(quote: Quote, options?: QuoteFormatOptions): string;
    /**
     * Форматирует Quote в краткий вид "bid/ask"
     *
     * @param quote - Quote для форматирования
     * @param priceDecimals - Количество десятичных знаков (по умолчанию: 4)
     * @returns Форматированная строка
     *
     * @remarks
     * Метод "Never Throw" - гарантированно не бросает исключения.
     * Показывает только цены без размеров.
     *
     * @example
     * ```typescript
     * const quote = Quote.of(Price.of(0.48), Price.of(0.52), ...);
     * console.log(QuoteFormatter.toShort(quote));
     * // "0.4800/0.5200"
     *
     * console.log(QuoteFormatter.toShort(quote, 2));
     * // "0.48/0.52"
     * ```
     */
    static toShort(quote: Quote, priceDecimals?: number): string;
    /**
     * Форматирует Quote в подробный вид с spread и mid
     *
     * @param quote - Quote для форматирования
     * @param options - Опции форматирования
     * @returns Форматированная строка
     *
     * @remarks
     * Метод "Never Throw" - гарантированно не бросает исключения.
     * Включает spread (абсолютный и процентный) и mid price для двусторонних котировок.
     *
     * @example
     * ```typescript
     * const quote = Quote.of(Price.of(0.48), Price.of(0.52), ...);
     * console.log(QuoteFormatter.toDetailed(quote));
     * // "Bid: 0.4800 @ 100.00, Ask: 0.5200 @ 150.00, Spread: 0.0400 (8.00%), Mid: 0.5000"
     *
     * // С опциями
     * console.log(QuoteFormatter.toDetailed(quote, { includeSpread: false, includeMid: true }));
     * // "Bid: 0.4800 @ 100.00, Ask: 0.5200 @ 150.00, Mid: 0.5000"
     * ```
     */
    static toDetailed(quote: Quote, options?: QuoteFormatOptions): string;
    /**
     * Форматирует Quote в табличный вид для консольного вывода
     *
     * @param quote - Quote для форматирования
     * @param options - Опции форматирования
     * @returns Форматированная строка с переносами строк
     *
     * @remarks
     * Метод "Never Throw" - гарантированно не бросает исключения.
     * Создаёт многострочный вывод в виде таблицы.
     *
     * @example
     * ```typescript
     * const quote = Quote.of(Price.of(0.48), Price.of(0.52), ...);
     * console.log(QuoteFormatter.toTable(quote));
     * // Side   Price    Size
     * // ─────────────────────
     * // Bid    0.4800   100.00
     * // Ask    0.5200   150.00
     * // ─────────────────────
     * // Spread 0.0400   (8.00%)
     * // Mid    0.5000
     * ```
     */
    static toTable(quote: Quote, options?: QuoteFormatOptions): string;
    /**
     * Форматирует spread в читаемый вид
     *
     * @param quote - Quote для форматирования
     * @param includePercentage - Включить процентное значение (по умолчанию: true)
     * @returns Форматированная строка spread или null для one-sided котировок
     *
     * @remarks
     * Метод "Never Throw" - гарантированно не бросает исключения.
     * Возвращает null для one-sided котировок.
     *
     * @example
     * ```typescript
     * const quote = Quote.of(Price.of(0.48), Price.of(0.52), ...);
     * console.log(QuoteFormatter.formatSpread(quote));
     * // "0.0400 (8.00%)"
     *
     * console.log(QuoteFormatter.formatSpread(quote, false));
     * // "0.0400"
     * ```
     */
    static formatSpread(quote: Quote, includePercentage?: boolean): string | null;
    /**
     * Форматирует mid price в читаемый вид
     *
     * @param quote - Quote для форматирования
     * @param decimals - Количество десятичных знаков (по умолчанию: 4)
     * @returns Форматированная строка mid price или null для one-sided котировок
     *
     * @remarks
     * Метод "Never Throw" - гарантированно не бросает исключения.
     * Возвращает null для one-sided котировок.
     *
     * @example
     * ```typescript
     * const quote = Quote.of(Price.of(0.48), Price.of(0.52), ...);
     * console.log(QuoteFormatter.formatMid(quote));
     * // "0.5000"
     *
     * console.log(QuoteFormatter.formatMid(quote, 2));
     * // "0.50"
     * ```
     */
    static formatMid(quote: Quote, decimals?: number): string | null;
    /**
     * Форматирует Quote в компактный вид "price/price @sizexsize"
     *
     * @param quote - Quote для форматирования
     * @param priceDecimals - Количество десятичных знаков для цен (по умолчанию: 2)
     * @param sizeDecimals - Количество десятичных знаков для размеров (по умолчанию: 0)
     * @returns Форматированная строка в компактном формате
     *
     * @remarks
     * Метод "Never Throw" - гарантированно не бросает исключения.
     * Предназначен для вывода котировок в ограниченном пространстве (логи, UI).
     *
     * Формат: "bid/ask @bidSize×askSize"
     * - Цены разделены "/"
     * - Размеры показаны после "@" и разделены "×"
     * - Для one-sided котировок используется "--" для отсутствующей стороны
     *
     * @example
     * ```typescript
     * const quote = Quote.of(Price.of(0.48), Price.of(0.52), Quantity.of(100), Quantity.of(150), Date.now());
     * console.log(QuoteFormatter.formatCompact(quote));
     * // "0.48/0.52 @100×150"
     *
     * // С настройкой точности
     * console.log(QuoteFormatter.formatCompact(quote, 4, 2));
     * // "0.4800/0.5200 @100.00×150.00"
     *
     * // Bid-only котировка
     * const bidOnly = Quote.of(Price.of(0.50), null, Quantity.of(100), Quantity.of(0), Date.now());
     * console.log(QuoteFormatter.formatCompact(bidOnly));
     * // "0.50/-- @100×0"
     * ```
     */
    static formatCompact(quote: Quote, priceDecimals?: number, sizeDecimals?: number): string;
    /**
     * Форматирует Quote с информацией о spread "bid-ask (spread, mid=price)"
     *
     * @param quote - Quote для форматирования
     * @param priceDecimals - Количество десятичных знаков для цен (по умолчанию: 2)
     * @returns Форматированная строка с spread информацией или краткий вид для one-sided
     *
     * @remarks
     * Метод "Never Throw" - гарантированно не бросает исключения.
     * Предназначен для отображения котировки с метриками spread.
     *
     * Формат для two-sided: "bid-ask (spreadBps, mid=midPrice)"
     * - Цены разделены "-"
     * - Spread показан в basis points (bp)
     * - Mid price показан после "mid="
     * - Для one-sided возвращает только доступную сторону
     *
     * @example
     * ```typescript
     * const quote = Quote.of(Price.of(0.48), Price.of(0.52), Quantity.of(100), Quantity.of(150), Date.now());
     * console.log(QuoteFormatter.formatWithSpread(quote));
     * // "0.48-0.52 (400bp, mid=0.50)"
     *
     * // С настройкой точности
     * console.log(QuoteFormatter.formatWithSpread(quote, 4));
     * // "0.4800-0.5200 (400bp, mid=0.5000)"
     *
     * // Bid-only котировка
     * const bidOnly = Quote.of(Price.of(0.50), null, Quantity.of(100), Quantity.of(0), Date.now());
     * console.log(QuoteFormatter.formatWithSpread(bidOnly));
     * // "0.50 (bid only)"
     *
     * // Ask-only котировка
     * const askOnly = Quote.of(null, Price.of(0.52), Quantity.of(0), Quantity.of(150), Date.now());
     * console.log(QuoteFormatter.formatWithSpread(askOnly));
     * // "0.52 (ask only)"
     * ```
     */
    static formatWithSpread(quote: Quote, priceDecimals?: number): string;
}
//# sourceMappingURL=QuoteFormatter.d.ts.map