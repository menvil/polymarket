/**
 * Deserializer для Order
 *
 * @remarks
 * Парсит плоский снэпшот (примитивы) в OrderState (value objects),
 * затем вызывает Order.rehydrate(state) для создания агрегата.
 *
 * Разделение ответственности:
 * - OrderDeserializer: парсинг примитивов + валидация формата
 * - Order.rehydrate(): кросс-валидация состояния + создание агрегата
 *
 * @example
 * ```typescript
 * import { OrderDeserializer } from './OrderDeserializer';
 *
 * const snap = { id: 'order-123', asset: '...', side: 'BUY', price: 0.65, size: 100,
 *   status: 'OPEN', timestamp: '2024-01-01T00:00:00.000Z', filledSize: 0, fillIds: [] };
 * const result = OrderDeserializer.fromSnapshot(snap);
 *
 * if (result.ok) {
 *   const order = result.value;
 *   console.log(order.status); // 'OPEN'
 * }
 * ```
 *
 * FUTURE: OrderDeserializer и OrderViewModel находятся в пакете domain entity для удобства.
 * Когда архитектура устоится, их можно перенести в application layer —
 * сериализация/десериализация не является частью доменной логики.
 */
import { Result } from '@polymarket/result';
import { ValidationError } from '@polymarket/errors';
import type { OrderSnapshot } from '../OrderState.js';
import { Order } from '../Order.js';
/**
 * Класс OrderDeserializer — десериализация снэпшотов в Order
 */
export declare abstract class OrderDeserializer {
    /**
     * Десериализует снэпшот в Order
     *
     * @param snap - OrderSnapshot с примитивными значениями
     * @returns Result<Order, ValidationError>
     *
     * @remarks
     * Алгоритм:
     * 1. Парсит все примитивы в value objects (id, asset, side, status, timestamp, fillIds)
     * 2. Строит OrderState из value objects
     * 3. Вызывает Order.rehydrate(state) для кросс-валидации и создания агрегата
     * 4. Конвертирует TradingError → ValidationError для совместимости с внешним API
     *
     * @example
     * ```typescript
     * const result = OrderDeserializer.fromSnapshot({
     *   id: 'order-1', asset: '...', side: 'BUY',
     *   price: 0.65, size: 100, status: 'OPEN',
     *   timestamp: '2024-01-01T00:00:00.000Z',
     *   filledSize: 0, fillIds: [],
     * });
     * ```
     */
    static fromSnapshot(snap: OrderSnapshot): Result<Order, ValidationError>;
    /**
     * Десериализует массив снэпшотов
     *
     * @param snapshots - Массив OrderSnapshot
     * @returns Result<Order[], ValidationError>
     *
     * @remarks
     * Останавливается на первой ошибке.
     *
     * @example
     * ```typescript
     * const result = OrderDeserializer.fromSnapshotArray([snap1, snap2]);
     * if (result.ok) console.log(`Loaded ${result.value.length} orders`);
     * ```
     */
    static fromSnapshotArray(snapshots: readonly OrderSnapshot[]): Result<Order[], ValidationError>;
    /**
     * Десериализует массив с пропуском ошибок
     *
     * @param snapshots - Массив OrderSnapshot
     * @returns Успешно загруженные Order
     *
     * @remarks
     * Пропускает невалидные записи.
     *
     * @example
     * ```typescript
     * const orders = OrderDeserializer.fromSnapshotArrayPartial([snap1, invalidSnap, snap2]);
     * console.log(orders.length); // 2
     * ```
     */
    static fromSnapshotArrayPartial(snapshots: readonly OrderSnapshot[]): Order[];
    /**
     * @deprecated Используйте fromSnapshot() — принимает OrderSnapshot напрямую
     */
    static fromJSON(json: OrderSnapshot): Result<Order, ValidationError>;
    /**
     * @deprecated Используйте fromSnapshotArray()
     */
    static fromJSONArray(jsonArray: readonly OrderSnapshot[]): Result<Order[], ValidationError>;
}
//# sourceMappingURL=OrderDeserializer.d.ts.map