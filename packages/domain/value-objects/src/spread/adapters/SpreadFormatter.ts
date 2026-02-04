import { Spread } from '../core/Spread.js';

/**
 * Опции форматирования для Spread
 */
export interface SpreadFormatOptions {
  /**
   * Количество десятичных знаков (по умолчанию 4)
   */
  decimals?: number;

  /**
   * Показать width в скобках (по умолчанию true)
   */
  showWidth?: boolean;

  /**
   * Показать midpoint (по умолчанию false)
   */
  showMidpoint?: boolean;
}

/**
 * Форматтер для Spread
 *
 * @remarks
 * Отвечает за представление Spread в виде строк для UI.
 * Отделяет технические детали форматирования от domain логики.
 *
 * @example
 * ```typescript
 * const spread = unwrap(SpreadService.fromValues(0.48, 0.52));
 *
 * // Стандартное форматирование
 * SpreadFormatter.format(spread); // "0.4800-0.5200 (0.0400)"
 *
 * // Без ширины
 * SpreadFormatter.format(spread, { showWidth: false }); // "0.4800-0.5200"
 *
 * // С midpoint
 * SpreadFormatter.format(spread, { showMidpoint: true });
 * // "0.4800-0.5200 (0.0400, mid: 0.5000)"
 * ```
 */
export class SpreadFormatter {
  /**
   * Форматировать Spread в строку
   *
   * @param spread - Spread для форматирования
   * @param options - Опции форматирования
   * @returns Отформатированная строка
   */
  public static format(spread: Spread, options: SpreadFormatOptions = {}): string {
    const { decimals = 4, showWidth = true, showMidpoint = false } = options;

    const bidStr = spread.bid().value().toFixed(decimals);
    const askStr = spread.ask().value().toFixed(decimals);
    let result = `${bidStr}-${askStr}`;

    if (showWidth || showMidpoint) {
      const parts: string[] = [];

      if (showWidth) {
        const widthStr = spread.width().toFixed(decimals);
        parts.push(widthStr);
      }

      if (showMidpoint) {
        const midStr = spread.mid().toFixed(decimals);
        parts.push(`mid: ${midStr}`);
      }

      result += ` (${parts.join(', ')})`;
    }

    return result;
  }

  /**
   * Форматировать как простую строку bid-ask
   *
   * @param spread - Spread для форматирования
   * @param decimals - Количество десятичных знаков
   * @returns Строка вида "0.4800-0.5200"
   */
  public static toBidAskString(spread: Spread, decimals: number = 4): string {
    return SpreadFormatter.format(spread, { decimals, showWidth: false });
  }

  /**
   * Форматировать с деталями (width + midpoint)
   *
   * @param spread - Spread для форматирования
   * @param decimals - Количество десятичных знаков
   * @returns Строка вида "0.4800-0.5200 (0.0400, mid: 0.5000)"
   */
  public static toDetailedString(spread: Spread, decimals: number = 4): string {
    return SpreadFormatter.format(spread, { decimals, showWidth: true, showMidpoint: true });
  }

  /**
   * Форматировать в объект
   *
   * @param spread - Spread для форматирования
   * @returns Объект с bid, ask, width, midpoint
   *
   * @example
   * ```typescript
   * const spread = unwrap(SpreadService.fromValues(0.48, 0.52));
   * const obj = SpreadFormatter.toObject(spread);
   * // { bid: 0.48, ask: 0.52, width: 0.04, midpoint: 0.50 }
   * ```
   */
  public static toObject(spread: Spread): {
    bid: number;
    ask: number;
    width: number;
    midpoint: number;
  } {
    return {
      bid: spread.bid().value().toNumber(),
      ask: spread.ask().value().toNumber(),
      width: spread.width().toNumber(),
      midpoint: spread.mid().toNumber(),
    };
  }
}
