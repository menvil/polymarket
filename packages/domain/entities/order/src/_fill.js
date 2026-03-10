/**
 * Математика исполнений — приватный модуль пакета
 *
 * @remarks
 * Не экспортируется из index.ts.
 * Содержит всю арифметику fill-состояния:
 * - addFill: добавить исполнение с валидацией
 * - isFull: заявка полностью исполнена
 * - emptyFill: начальное состояние
 * - VWAP: взвешенная средняя цена
 */
import { Ok, Err } from '@polymarket/result';
import { Quantity, Price } from '@polymarket/value-objects';
import { TradingError } from '@polymarket/errors';
/**
 * Создаёт пустое fill-состояние для новой заявки
 */
export function emptyFill() {
    return {
        filledSize: Quantity.ZERO,
        averagePrice: undefined,
        fillIds: [],
    };
}
/**
 * Добавляет исполнение к текущему fill-состоянию
 *
 * @param state - Текущее fill-состояние
 * @param fill - Данные нового исполнения
 * @param orderSize - Полный размер заявки (для проверки превышения)
 * @returns Новое fill-состояние или ошибка
 *
 * @remarks
 * Алгоритм:
 * 1. Проверяет что fillSize > 0
 * 2. Проверяет отсутствие дубликата fillId
 * 3. Проверяет что fillSize <= remainingSize
 * 4. Вычисляет новый filledSize
 * 5. Вычисляет VWAP
 */
export function addFill(state, fill, orderSize) {
    if (fill.size.isZero()) {
        return Err(new TradingError('Fill size must be positive', { context: { fillId: fill.id } }));
    }
    if (state.fillIds.includes(fill.id)) {
        return Err(new TradingError(`Duplicate fill id: ${fill.id}`, { context: { fillId: fill.id } }));
    }
    const remaining = orderSize.value().minus(state.filledSize.value());
    if (fill.size.value().gt(remaining)) {
        return Err(new TradingError(`Fill size (${fill.size.value()}) exceeds remaining size (${remaining})`, { context: { fillId: fill.id } }));
    }
    const newFilledSize = Quantity.of(state.filledSize.value().plus(fill.size.value()));
    const newAvgPrice = _vwap(state.filledSize, state.averagePrice, fill.size, fill.price);
    return Ok({
        filledSize: newFilledSize,
        averagePrice: newAvgPrice,
        fillIds: [...state.fillIds, fill.id],
    });
}
/**
 * Проверяет что заявка полностью исполнена
 */
export function isFull(state, orderSize) {
    return state.filledSize.equals(orderSize);
}
/**
 * Взвешенная средняя цена (VWAP)
 *
 * @remarks
 * Формула: (currentSize * currentAvg + newSize * newPrice) / (currentSize + newSize)
 * Если первое исполнение — возвращает newPrice напрямую.
 */
function _vwap(currentSize, currentAvg, newSize, newPrice) {
    if (currentSize.isZero() || !currentAvg) {
        return newPrice;
    }
    const currentNotional = currentSize.value().times(currentAvg.value());
    const newNotional = newSize.value().times(newPrice.value());
    const totalSize = currentSize.value().plus(newSize.value());
    return Price.of(currentNotional.plus(newNotional).dividedBy(totalSize));
}
//# sourceMappingURL=_fill.js.map