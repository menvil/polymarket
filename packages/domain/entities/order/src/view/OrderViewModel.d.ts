/**
 * View Model для Order
 *
 * @remarks
 * Отвечает за сериализацию Order в различные представления:
 * - JSON для API responses (toJSON)
 * - Читаемая строка для логирования (toReadable)
 * - Summary для UI списков (toSummary)
 *
 * Не содержит бизнес-логики, только форматирование.
 *
 * FUTURE: OrderViewModel находится в пакете domain entity для удобства.
 * Когда архитектура устоится, его можно перенести в application layer —
 * сериализация для API/UI не является частью доменной логики.
 *
 * @example
 * ```typescript
 * import { OrderViewModel } from './OrderViewModel';
 *
 * const json = OrderViewModel.toJSON(order);
 * const readable = OrderViewModel.toReadable(order);
 * const summary = OrderViewModel.toSummary(order);
 * ```
 */
import type { Order } from '../Order.js';
/**
 * Summary представление Order для UI списков
 */
export interface OrderSummary {
    readonly id: string;
    readonly status: string;
    readonly side: string;
    readonly price: number;
    readonly size: number;
    readonly filled: number;
    readonly remaining: number;
    readonly fillPercentage: number;
}
/**
 * Класс OrderViewModel — сериализация Order в различные форматы
 */
export declare abstract class OrderViewModel {
    /**
     * Преобразует Order в JSON для API
     *
     * @param order - Order для сериализации
     * @returns Plain object совместимый с JSON.stringify()
     *
     * @remarks
     * Возвращает flat-формат совместимый с OrderSnapshot + вычисляемые поля.
     * Подходит для передачи через API и для round-trip через OrderDeserializer.fromSnapshot().
     *
     * @example
     * ```typescript
     * const json = OrderViewModel.toJSON(order);
     * console.log(JSON.stringify(json, null, 2));
     * ```
     */
    static toJSON(order: Order): Record<string, unknown>;
    /**
     * Преобразует Order в читаемую строку
     *
     * @param order - Order для форматирования
     * @returns Читаемая строка для логирования
     *
     * @example
     * ```typescript
     * console.log(OrderViewModel.toReadable(order));
     * // "Order[order-123]: BUY 100 @ 0.65 (OPEN) - 30.0% filled"
     * ```
     */
    static toReadable(order: Order): string;
    /**
     * Преобразует Order в summary для UI списков
     *
     * @param order - Order для summary
     * @returns OrderSummary с примитивными типами
     *
     * @remarks
     * Минимальный набор полей для отображения в таблицах/списках.
     *
     * @example
     * ```typescript
     * const summary = OrderViewModel.toSummary(order);
     * console.log(`${summary.id}: ${summary.status}`);
     * ```
     */
    static toSummary(order: Order): OrderSummary;
}
//# sourceMappingURL=OrderViewModel.d.ts.map