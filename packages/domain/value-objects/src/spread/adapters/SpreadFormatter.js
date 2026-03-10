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
    static format(spread, options = {}) {
        const { decimals = 4, showWidth = true, showMidpoint = false } = options;
        const bidStr = spread.bid().value().toFixed(decimals);
        const askStr = spread.ask().value().toFixed(decimals);
        let result = `${bidStr}-${askStr}`;
        if (showWidth || showMidpoint) {
            const parts = [];
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
    static toBidAskString(spread, decimals = 4) {
        return SpreadFormatter.format(spread, { decimals, showWidth: false });
    }
    /**
     * Форматировать с деталями (width + midpoint)
     *
     * @param spread - Spread для форматирования
     * @param decimals - Количество десятичных знаков
     * @returns Строка вида "0.4800-0.5200 (0.0400, mid: 0.5000)"
     */
    static toDetailedString(spread, decimals = 4) {
        return SpreadFormatter.format(spread, { decimals, showWidth: true, showMidpoint: true });
    }
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
    static toObject(spread) {
        return {
            bid: spread.bid().value(),
            ask: spread.ask().value(),
            width: spread.width(),
            midpoint: spread.mid(),
        };
    }
}
//# sourceMappingURL=SpreadFormatter.js.map