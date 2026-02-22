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
   * Показывать spread (по умолчанию: true)
   */
  includeSpread?: boolean;

  /**
   * Показывать mid price (по умолчанию: true)
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
 * // Подробный формат (по умолчанию включает spread и mid)
 * console.log(QuoteFormatter.toDetailed(quote));
 * // "Bid: 0.4800 @ 100.00, Ask: 0.5200 @ 150.00, Spread: 0.0400 (8.00%), Mid: 0.5000"
 * ```
 */
export class QuoteFormatter {
  /**
   * Приводит количество десятичных знаков к валидному значению
   *
   * @param decimals - Количество десятичных знаков (может быть невалидным)
   * @param defaultValue - Значение по умолчанию если невалидно
   * @returns Валидное количество десятичных знаков
   *
   * @remarks
   * Проверяет что decimals:
   * - Finite (не NaN, не Infinity)
   * - Integer (целое число)
   * - >= 0 (неотрицательное)
   * - <= 100 (максимальный предел)
   *
   * Если невалидно, возвращает defaultValue.
   *
   * @internal
   */
  private static sanitizeDecimals(decimals: number, defaultValue: number): number {
    if (!Number.isFinite(decimals) || !Number.isInteger(decimals) || decimals < 0) {
      return defaultValue;
    }
    if (decimals > 100) {
      return 100;
    }
    return decimals;
  }
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
    const priceDecimals = QuoteFormatter.sanitizeDecimals(options.priceDecimals ?? 4, 4);
    const sizeDecimals = QuoteFormatter.sanitizeDecimals(options.sizeDecimals ?? 2, 2);

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

    if (options.includeSource) {
      result += ` [Source: ${quote.sourceId()}]`;
    }

    if (options.includeInstrument) {
      result += ` [Instrument: ${quote.instrumentId()}]`;
    }

    return result;
  }

  /**
   * Форматирует Quote в краткий вид "bid/ask"
   *
   * @param quote - Quote для форматирования
   * @param options - Опции форматирования
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
   * console.log(QuoteFormatter.toShort(quote, { priceDecimals: 2 }));
   * // "0.48/0.52"
   * ```
   */
  public static toShort(quote: Quote, options: QuoteFormatOptions = {}): string {
    const safeDecimals = QuoteFormatter.sanitizeDecimals(options.priceDecimals ?? 4, 4);
    const bidStr = quote.hasBid()
      ? quote.bid()!.value().toFixed(safeDecimals)
      : '--';

    const askStr = quote.hasAsk()
      ? quote.ask()!.value().toFixed(safeDecimals)
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
   * // По умолчанию включает spread и mid (includeSpread: true, includeMid: true)
   * console.log(QuoteFormatter.toDetailed(quote));
   * // "Bid: 0.4800 @ 100.00, Ask: 0.5200 @ 150.00, Spread: 0.0400 (8.00%), Mid: 0.5000"
   *
   * // С опциями: выключить spread, оставить mid
   * console.log(QuoteFormatter.toDetailed(quote, { includeSpread: false, includeMid: true }));
   * // "Bid: 0.4800 @ 100.00, Ask: 0.5200 @ 150.00, Mid: 0.5000"
   * ```
   */
  public static toDetailed(quote: Quote, options: QuoteFormatOptions = {}): string {
    const priceDecimals = QuoteFormatter.sanitizeDecimals(options.priceDecimals ?? 4, 4);
    const sizeDecimals = QuoteFormatter.sanitizeDecimals(options.sizeDecimals ?? 2, 2);
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

    const spread = quote.spread();
    if (spread !== null) {
      if (includeSpread) {
        const spreadWidth = spread.width();
        const spreadPct = spread.widthRatio().toDecimal().times(100);
        parts.push(
          `Spread: ${spreadWidth.toFixed(priceDecimals)} (${spreadPct.toFixed(2)}%)`
        );
      }

      if (includeMid) {
        const midDecimal = spread.mid();
        parts.push(`Mid: ${midDecimal.toFixed(priceDecimals)}`);
      }
    }

    if (options.includeTimestamp) {
      const timestamp = new Date(quote.timestampMs().toNumber()).toISOString();
      parts.push(`Time: ${timestamp}`);
    }

    if (options.includeSource) {
      parts.push(`Source: ${quote.sourceId()}`);
    }

    if (options.includeInstrument) {
      parts.push(`Instrument: ${quote.instrumentId()}`);
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
   * Алгоритм выравнивания колонок:
   * 1. Вычисляет максимальную ширину колонки Price (maxPriceWidth) как максимум из:
   *    - Длины заголовка "Price" (5 символов)
   *    - Длины форматированной bid цены
   *    - Длины форматированной ask цены
   * 2. Применяет padEnd(maxPriceWidth) ко всем элементам колонки Price:
   *    - Заголовок "Price"
   *    - Значения bid/ask цен (или "--" для отсутствующих)
   *    - Значение spread (если есть)
   * 3. Это гарантирует корректное выравнивание при любых значениях priceDecimals
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
   *
   * // С большим количеством десятичных знаков (priceDecimals=10)
   * console.log(QuoteFormatter.toTable(quote, { priceDecimals: 10 }));
   * // Side   Price          Size
   * // ────────────────────────────────────────
   * // Bid    0.4800000000   100.00
   * // Ask    0.5200000000   150.00
   * // ────────────────────────────────────────
   * // Spread 0.0400000000 (8.00%)
   * // Mid    0.5000000000
   * ```
   */
  public static toTable(quote: Quote, options: QuoteFormatOptions = {}): string {
    const priceDecimals = QuoteFormatter.sanitizeDecimals(options.priceDecimals ?? 4, 4);
    const sizeDecimals = QuoteFormatter.sanitizeDecimals(options.sizeDecimals ?? 2, 2);

    const lines: string[] = [];

    // Calculate dynamic column width for price
    const bidPrice = quote.hasBid() ? quote.bid()!.value().toFixed(priceDecimals) : '--';
    const askPrice = quote.hasAsk() ? quote.ask()!.value().toFixed(priceDecimals) : '--';
    const priceHeaderWidth = 'Price'.length;
    const maxPriceWidth = Math.max(priceHeaderWidth, bidPrice.length, askPrice.length);

    // Calculate table width: "Side" (4) + "   " (3) + maxPriceWidth + "   " (3) + "Size" (4) = 14 + maxPriceWidth
    const tableWidth = 14 + maxPriceWidth;

    // Calculate metadata lines max width
    let metadataMaxWidth = 0;
    if (options.includeTimestamp) {
      const timestamp = new Date(quote.timestampMs().toNumber()).toISOString();
      metadataMaxWidth = Math.max(metadataMaxWidth, `Time:  ${timestamp}`.length);
    }
    if (options.includeSource) {
      metadataMaxWidth = Math.max(metadataMaxWidth, `Source: ${quote.sourceId()}`.length);
    }
    if (options.includeInstrument) {
      metadataMaxWidth = Math.max(metadataMaxWidth, `Instrument: ${quote.instrumentId()}`.length);
    }

    // Separator should be at least as wide as the widest line (table or metadata)
    const separator = '─'.repeat(Math.max(1, Math.max(tableWidth, metadataMaxWidth)));

    lines.push(`Side   ${'Price'.padEnd(maxPriceWidth)}   Size`);
    lines.push(separator);

    if (quote.hasBid()) {
      const size = quote.bidSize().value().toFixed(sizeDecimals);
      lines.push(`Bid    ${bidPrice.padEnd(maxPriceWidth)}   ${size}`);
    } else {
      lines.push(`Bid    ${'--'.padEnd(maxPriceWidth)}   --`);
    }

    if (quote.hasAsk()) {
      const size = quote.askSize().value().toFixed(sizeDecimals);
      lines.push(`Ask    ${askPrice.padEnd(maxPriceWidth)}   ${size}`);
    } else {
      lines.push(`Ask    ${'--'.padEnd(maxPriceWidth)}   --`);
    }

    const spread = quote.spread();
    const includeSpread = options.includeSpread ?? true;
    const includeMid = options.includeMid ?? true;

    if (spread !== null && (includeSpread || includeMid)) {
      lines.push(separator);

      if (includeSpread) {
        const spreadWidth = spread.width();
        const spreadPct = spread.widthRatio().toDecimal().times(100);
        lines.push(`Spread ${spreadWidth.toFixed(priceDecimals).padEnd(maxPriceWidth)} (${spreadPct.toFixed(2)}%)`);
      }

      if (includeMid) {
        const midDecimal = spread.mid();
        lines.push(`Mid    ${midDecimal.toFixed(priceDecimals)}`);
      }
    }

    // Добавляем separator только если есть хотя бы одно из дополнительных полей
    const hasAdditionalFields = options.includeTimestamp || options.includeSource || options.includeInstrument;
    if (hasAdditionalFields) {
      lines.push(separator);
    }

    if (options.includeTimestamp) {
      const timestamp = new Date(quote.timestampMs().toNumber()).toISOString();
      lines.push(`Time:  ${timestamp}`);
    }

    if (options.includeSource) {
      lines.push(`Source: ${quote.sourceId()}`);
    }

    if (options.includeInstrument) {
      lines.push(`Instrument: ${quote.instrumentId()}`);
    }

    return lines.join('\n');
  }

  /**
   * Форматирует spread в читаемый вид
   *
   * @param quote - Quote для форматирования
   * @param includePercentage - Включить процентное значение (по умолчанию: true)
   * @param decimals - Количество десятичных знаков (по умолчанию: 4)
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
   *
   * console.log(QuoteFormatter.formatSpread(quote, true, 2));
   * // "0.04 (8.00%)"
   * ```
   */
  public static formatSpread(quote: Quote, includePercentage: boolean = true, decimals: number = 4): string | null {
    const spread = quote.spread();
    if (spread === null) {
      return null;
    }

    const safeDecimals = QuoteFormatter.sanitizeDecimals(decimals, 4);
    const spreadWidth = spread.width();
    let result = spreadWidth.toFixed(safeDecimals);

    if (includePercentage) {
      const spreadPct = spread.widthRatio().toDecimal().times(100);
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
    const spread = quote.spread();
    if (spread === null) {
      return null;
    }

    const safeDecimals = QuoteFormatter.sanitizeDecimals(decimals, 4);
    const midDecimal = spread.mid();
    return midDecimal.toFixed(safeDecimals);
  }

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
  public static formatCompact(
    quote: Quote,
    priceDecimals: number = 2,
    sizeDecimals: number = 0
  ): string {
    const safePriceDecimals = QuoteFormatter.sanitizeDecimals(priceDecimals, 2);
    const safeSizeDecimals = QuoteFormatter.sanitizeDecimals(sizeDecimals, 0);

    const bidPrice = quote.hasBid()
      ? quote.bid()!.value().toFixed(safePriceDecimals)
      : '--';

    const askPrice = quote.hasAsk()
      ? quote.ask()!.value().toFixed(safePriceDecimals)
      : '--';

    const bidSize = quote.bidSize().value().toFixed(safeSizeDecimals);
    const askSize = quote.askSize().value().toFixed(safeSizeDecimals);

    return `${bidPrice}/${askPrice} @${bidSize}×${askSize}`;
  }

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
  public static formatWithSpread(quote: Quote, priceDecimals: number = 2): string {
    const safeDecimals = QuoteFormatter.sanitizeDecimals(priceDecimals, 2);

    if (!quote.isTwoSided()) {
      // One-sided котировка
      if (quote.hasBid()) {
        const bidPrice = quote.bid()!.value().toFixed(safeDecimals);
        return `${bidPrice} (bid only)`;
      } else {
        const askPrice = quote.ask()!.value().toFixed(safeDecimals);
        return `${askPrice} (ask only)`;
      }
    }

    // Two-sided котировка
    const bidPrice = quote.bid()!.value().toFixed(safeDecimals);
    const askPrice = quote.ask()!.value().toFixed(safeDecimals);

    const spread = quote.spread();
    if (spread === null) {
      // Не должно произойти для two-sided, но защита на всякий случай
      return `${bidPrice}-${askPrice}`;
    }

    // Spread в basis points (1 bp = 0.01% = 0.0001)
    const spreadWidth = spread.width();
    const spreadBps = spreadWidth.times(10000);

    // Mid price
    const midDecimal = spread.mid();
    const midStr = midDecimal.toFixed(safeDecimals);

    return `${bidPrice}-${askPrice} (${spreadBps.toFixed(0)}bp, mid=${midStr})`;
  }
}
