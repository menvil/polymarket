/**
 * Formatter для Side - display formatting
 *
 * @remarks
 * Предоставляет методы для форматирования Side в читаемые строки для UI.
 *
 * Поддерживает различные форматы:
 * - Display string ('Buy', 'Sell')
 * - Uppercase ('BUY', 'SELL')
 * - Lowercase ('buy', 'sell')
 * - Emoji (🟢, 🔴)
 * - Color ('green', 'red')
 *
 * @remarks
 * **Архитектурная заметка:**
 * Методы toEmoji, toColor, toHexColor являются UI-представлением и находятся
 * в domain/value-objects по историческим причинам. В будущем их следует
 * вынести в отдельный ui/formatters или presentation-layer пакет.
 *
 * @example
 * ```typescript
 * import { SideFormatter } from '@polymarket/value-objects';
 *
 * SideFormatter.toDisplay('BUY');    // 'Buy'
 * SideFormatter.toEmoji('BUY');      // '🟢'
 * SideFormatter.toColor('BUY');      // 'green'
 * ```
 */
/**
 * Класс SideFormatter - display formatting
 *
 * @remarks
 * Static-only class. Не создавайте экземпляры.
 */
export class SideFormatter {
    /**
     * Приватный конструктор - запрещает создание экземпляров
     */
    constructor() { }
    /**
     * Форматировать Side для UI display
     *
     * @param side - Side для форматирования
     * @returns Читаемая строка с заглавной буквы
     *
     * @remarks
     * Преобразует в Title Case для UI:
     * - BUY → 'Buy'
     * - SELL → 'Sell'
     *
     * @example
     * ```typescript
     * SideFormatter.toDisplay('BUY');  // 'Buy'
     * SideFormatter.toDisplay('SELL'); // 'Sell'
     *
     * // В UI компоненте
     * <span>{SideFormatter.toDisplay(order.side)}</span>
     * ```
     */
    static toDisplay(side) {
        return side === 'BUY' ? 'Buy' : 'Sell';
    }
    /**
     * Преобразовать в uppercase
     *
     * @param side - Side для преобразования
     * @returns Uppercase строка
     *
     * @remarks
     * Для Side это identity function, но полезно для консистентности API.
     * Гарантирует uppercase даже если в будущем появятся другие форматы.
     *
     * @example
     * ```typescript
     * SideFormatter.toUpperCase('BUY');  // 'BUY'
     * SideFormatter.toUpperCase('SELL'); // 'SELL'
     * ```
     */
    static toUpperCase(side) {
        return side;
    }
    /**
     * Преобразовать в lowercase
     *
     * @param side - Side для преобразования
     * @returns Lowercase<Side> — строго типизированный lowercase вариант
     *
     * @remarks
     * Полезно для некоторых UI сценариев или логирования.
     *
     * @example
     * ```typescript
     * SideFormatter.toLowerCase('BUY');  // 'buy'
     * SideFormatter.toLowerCase('SELL'); // 'sell'
     * ```
     */
    static toLowerCase(side) {
        return side.toLowerCase();
    }
    /**
     * Получить эмодзи представление
     *
     * @param side - Side для преобразования
     * @returns Эмодзи символ
     *
     * @remarks
     * Визуальные индикаторы для UI:
     * - BUY → 🟢 (зелёный круг, покупка, рост)
     * - SELL → 🔴 (красный круг, продажа, падение)
     *
     * @example
     * ```typescript
     * SideFormatter.toEmoji('BUY');  // '🟢'
     * SideFormatter.toEmoji('SELL'); // '🔴'
     *
     * // В UI
     * console.log(`${SideFormatter.toEmoji(order.side)} ${SideFormatter.toDisplay(order.side)}`);
     * // → "🟢 Buy" или "🔴 Sell"
     * ```
     */
    static toEmoji(side) {
        return side === 'BUY' ? '🟢' : '🔴';
    }
    /**
     * Получить CSS color для UI
     *
     * @param side - Side для преобразования
     * @returns CSS color string
     *
     * @remarks
     * Стандартные trading цвета:
     * - BUY → 'green' (покупка, рост)
     * - SELL → 'red' (продажа, падение)
     *
     * @example
     * ```typescript
     * SideFormatter.toColor('BUY');  // 'green'
     * SideFormatter.toColor('SELL'); // 'red'
     *
     * // В React/styled-components
     * <OrderSide color={SideFormatter.toColor(order.side)}>
     *   {SideFormatter.toDisplay(order.side)}
     * </OrderSide>
     * ```
     */
    static toColor(side) {
        return side === 'BUY' ? 'green' : 'red';
    }
    /**
     * Получить hex color code для UI
     *
     * @param side - Side для преобразования
     * @returns Hex color code
     *
     * @remarks
     * Точные hex коды для consistent styling:
     * - BUY → '#22c55e' (tailwind green-500)
     * - SELL → '#ef4444' (tailwind red-500)
     *
     * @example
     * ```typescript
     * SideFormatter.toHexColor('BUY');  // '#22c55e'
     * SideFormatter.toHexColor('SELL'); // '#ef4444'
     *
     * // В CSS-in-JS
     * const styles = {
     *   color: SideFormatter.toHexColor(order.side)
     * };
     * ```
     */
    static toHexColor(side) {
        return side === 'BUY' ? '#22c55e' : '#ef4444';
    }
    /**
     * Форматировать для логирования
     *
     * @param side - Side для форматирования
     * @returns Строка для logs
     *
     * @remarks
     * Включает эмодзи для визуального разделения в консоли.
     *
     * @example
     * ```typescript
     * console.log(`Order: ${SideFormatter.toLogString('BUY')}`);
     * // → "Order: 🟢 BUY"
     * ```
     */
    static toLogString(side) {
        return `${this.toEmoji(side)} ${side}`;
    }
    /**
     * Форматировать с размером для UI
     *
     * @param side - Side для форматирования
     * @param size - Размер заявки/сделки
     * @returns Форматированная строка
     *
     * @remarks
     * Удобный helper для отображения side + size вместе.
     *
     * @example
     * ```typescript
     * SideFormatter.withSize('BUY', 100);  // 'Buy 100'
     * SideFormatter.withSize('SELL', 50);  // 'Sell 50'
     *
     * // В UI
     * <OrderInfo>{SideFormatter.withSize(order.side, order.size.value)}</OrderInfo>
     * ```
     */
    static withSize(side, size) {
        return `${this.toDisplay(side)} ${size}`;
    }
}
//# sourceMappingURL=SideFormatter.js.map