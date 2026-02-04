import { Quote } from '../core/Quote.js';
import { Price } from '../../price/core/Price.js';

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
   * Показывать spread (по умолчанию: false)
   */
  includeSpread?: boolean;

  /**
   * Показывать mid price (по умолчанию: false)
   */
  includeMid?: boolean;
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
export class QuoteFormatter {
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
  public static toDisplay(quote: Quote, options: QuoteFormatOptions = {}): string {
    const priceDecimals = options.priceDecimals ?? 4;
    const sizeDecimals = options.sizeDecimals ?? 2;

    const bidStr = quote.hasBid()
      ? `${quote.bid()!.value().toFixed(priceDecimals)} @ ${quote.bidSize().value().toFixed(sizeDecimals)}`
      : '--';

    const askStr = quote.hasAsk()
      ? `${quote.ask()!.value().toFixed(priceDecimals)} @ ${quote.askSize().value().toFixed(sizeDecimals)}`
      : '--';

    let result = `${bidStr} / ${askStr}`;

    if (options.includeTimestamp) {
      const timestamp = new Date(quote.timestampMs().toNumber()).toISOString();
      result += ` [${timestamp}]`;
    }

    return result;
  }

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
  public static toShort(quote: Quote, priceDecimals: number = 4): string {
    const bidStr = quote.hasBid()
      ? quote.bid()!.value().toFixed(priceDecimals)
      : '--';

    const askStr = quote.hasAsk()
      ? quote.ask()!.value().toFixed(priceDecimals)
      : '--';

    return `${bidStr}/${askStr}`;
  }

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
  public static toDetailed(quote: Quote, options: QuoteFormatOptions = {}): string {
    const priceDecimals = options.priceDecimals ?? 4;
    const sizeDecimals = options.sizeDecimals ?? 2;
    const includeSpread = options.includeSpread ?? true;
    const includeMid = options.includeMid ?? true;

    const parts: string[] = [];

    if (quote.hasBid()) {
      parts.push(
        `Bid: ${quote.bid()!.value().toFixed(priceDecimals)} @ ${quote.bidSize().value().toFixed(sizeDecimals)}`
      );
    }

    if (quote.hasAsk()) {
      parts.push(
        `Ask: ${quote.ask()!.value().toFixed(priceDecimals)} @ ${quote.askSize().value().toFixed(sizeDecimals)}`
      );
    }

    if (quote.isTwoSided()) {
      if (includeSpread) {
        const spreadWidth = quote.spreadWidth()!;
        const spreadPct = quote.spreadPercentage()!;
        parts.push(
          `Spread: ${spreadWidth.toFixed(priceDecimals)} (${spreadPct.toFixed(2)}%)`
        );
      }

      if (includeMid) {
        const midDecimal = quote.mid()!;
        // SAFETY: mid математически в границах если bid/ask валидны
        const mid = Price.of(midDecimal);
        parts.push(`Mid: ${mid.value().toFixed(priceDecimals)}`);
      }
    }

    if (options.includeTimestamp) {
      const timestamp = new Date(quote.timestampMs().toNumber()).toISOString();
      parts.push(`Time: ${timestamp}`);
    }

    return parts.join(', ');
  }

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
  public static toTable(quote: Quote, options: QuoteFormatOptions = {}): string {
    const priceDecimals = options.priceDecimals ?? 4;
    const sizeDecimals = options.sizeDecimals ?? 2;

    const lines: string[] = [];
    const separator = '─'.repeat(40);

    lines.push('Side   Price    Size');
    lines.push(separator);

    if (quote.hasBid()) {
      const price = quote.bid()!.value().toFixed(priceDecimals);
      const size = quote.bidSize().value().toFixed(sizeDecimals);
      lines.push(`Bid    ${price.padEnd(8)} ${size}`);
    } else {
      lines.push('Bid    --       --');
    }

    if (quote.hasAsk()) {
      const price = quote.ask()!.value().toFixed(priceDecimals);
      const size = quote.askSize().value().toFixed(sizeDecimals);
      lines.push(`Ask    ${price.padEnd(8)} ${size}`);
    } else {
      lines.push('Ask    --       --');
    }

    if (quote.isTwoSided()) {
      lines.push(separator);

      const spreadWidth = quote.spreadWidth()!;
      const spreadPct = quote.spreadPercentage()!;
      lines.push(`Spread ${spreadWidth.toFixed(priceDecimals).padEnd(8)} (${spreadPct.toFixed(2)}%)`);

      const midDecimal = quote.mid()!;
      // SAFETY: mid математически в границах если bid/ask валидны
      const mid = Price.of(midDecimal);
      lines.push(`Mid    ${mid.value().toFixed(priceDecimals)}`);
    }

    if (options.includeTimestamp) {
      lines.push(separator);
      const timestamp = new Date(quote.timestampMs().toNumber()).toISOString();
      lines.push(`Time:  ${timestamp}`);
    }

    return lines.join('\n');
  }

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
  public static formatSpread(quote: Quote, includePercentage: boolean = true): string | null {
    if (!quote.isTwoSided()) {
      return null;
    }

    const spreadWidth = quote.spreadWidth()!;
    let result = spreadWidth.toFixed(4);

    if (includePercentage) {
      const spreadPct = quote.spreadPercentage()!;
      result += ` (${spreadPct.toFixed(2)}%)`;
    }

    return result;
  }

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
  public static formatMid(quote: Quote, decimals: number = 4): string | null {
    if (!quote.isTwoSided()) {
      return null;
    }

    const midDecimal = quote.mid()!;
    return midDecimal.toFixed(decimals);
  }
}
