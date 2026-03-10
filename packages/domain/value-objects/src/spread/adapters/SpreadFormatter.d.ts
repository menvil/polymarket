import Decimal from 'decimal.js';
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
export declare class SpreadFormatter {
    /**
     * Форматировать Spread в строку
     *
     * @param spread - Spread для форматирования
     * @param options - Опции форматирования
     * @returns Отформатированная строка
     */
    static format(spread: Spread, options?: SpreadFormatOptions): string;
    /**
     * Форматировать как простую строку bid-ask
     *
     * @param spread - Spread для форматирования
     * @param decimals - Количество десятичных знаков
     * @returns Строка вида "0.4800-0.5200"
     */
    static toBidAskString(spread: Spread, decimals?: number): string;
    /**
     * Форматировать с деталями (width + midpoint)
     *
     * @param spread - Spread для форматирования
     * @param decimals - Количество десятичных знаков
     * @returns Строка вида "0.4800-0.5200 (0.0400, mid: 0.5000)"
     */
    static toDetailedString(spread: Spread, decimals?: number): string;
    /**
     * Форматировать в объект
     *
     * @param spread - Spread для форматирования
     * @returns Объект с bid, ask, width, midpoint как Decimal для сохранения точности
     *
     * @remarks
     * Возвращает Decimal значения вместо number для предотвращения потери точности
     * при сериализации/десериализации. Используй Decimal.toNumber() если нужен number.
     *
     * @example
     * ```typescript
     * const spread = unwrap(SpreadService.fromValues(0.48, 0.52));
     * const obj = SpreadFormatter.toObject(spread);
     * // { bid: Decimal(0.48), ask: Decimal(0.52), width: Decimal(0.04), midpoint: Decimal(0.50) }
     *
     * // Если нужны numbers:
     * const bidNumber = obj.bid.toNumber();
     * ```
     */
    static toObject(spread: Spread): {
        bid: Decimal;
        ask: Decimal;
        width: Decimal;
        midpoint: Decimal;
    };
}
//# sourceMappingURL=SpreadFormatter.d.ts.map