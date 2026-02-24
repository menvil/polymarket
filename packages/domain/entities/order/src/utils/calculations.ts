/**
 * Вычисления для Order
 *
 * @remarks
 * Утилиты для расчетов связанных с заявками:
 * - Notional value (номинальная стоимость)
 * - Remaining size (оставшийся размер)
 * - Fill percentage (процент заполнения)
 *
 * Все функции pure (без side effects).
 * Используют Decimal.js для точных вычислений.
 *
 * @example
 * ```typescript
 * import { getNotional, getRemainingSize } from './calculations';
 * import { Price, Quantity } from '@polymarket/value-objects';
 *
 * const notional = getNotional(Price(0.65), Quantity(100));
 * console.log(notional.toNumber()); // 65.0
 *
 * const remaining = getRemainingSize(Quantity(100), Quantity(30));
 * console.log(remaining.value); // 70
 * ```
 */

import Decimal from 'decimal.js';
import type { Price, Quantity } from '@polymarket/value-objects';

/**
 * Вычисляет номинальную стоимость заявки
 *
 * @param price - Цена заявки
 * @param size - Размер заявки
 * @returns Номинальная стоимость (price * size) как Decimal
 *
 * @remarks
 * Notional = Цена × Размер
 *
 * Для BUY ордеров: Это максимальная сумма необходимая для исполнения
 * Для SELL ордеров: Это сумма которая будет получена при исполнении
 *
 * Использует Decimal.js для точных вычислений без ошибок округления.
 *
 * @example
 * ```typescript
 * const price = Price.fromValue(0.65).value!;
 * const size = Quantity.fromValue(100).value!;
 * const notional = getNotional(price, size);
 * console.log(notional.toNumber()); // 65.0
 * console.log(notional.toString()); // '65'
 * ```
 */
export function getNotional(price: Price, size: Quantity): Decimal {
  return new Decimal(price.value).times(size.value);
}

/**
 * Вычисляет оставшийся незаполненный размер
 *
 * @param size - Исходный размер заявки
 * @param filledSize - Заполненное количество
 * @returns Оставшееся количество для заполнения
 *
 * @remarks
 * Формула: remaining = size - filledSize
 *
 * Возвращает исходный размер если filledSize undefined или 0.
 * Возвращает ноль если заявка полностью заполнена.
 *
 * @example
 * ```typescript
 * const size = Quantity.fromValue(100).value!;
 * const filled = Quantity.fromValue(40).value!;
 * const remaining = getRemainingSize(size, filled);
 * console.log(remaining.value); // 60
 *
 * // Если не заполнено
 * const remaining2 = getRemainingSize(size);
 * console.log(remaining2.value); // 100
 * ```
 */
export function getRemainingSize(size: Quantity, filledSize?: Quantity): Quantity {
  if (!filledSize || filledSize.isZero()) {
    return size;
  }
  const result = size.subtract(filledSize);
  if (!result.ok) {
    // Не должно произойти если filledSize <= size (валидируется в Order.create)
    return size;
  }
  return result.value;
}

/**
 * Вычисляет процент заполнения заявки
 *
 * @param filledSize - Заполненное количество
 * @param size - Исходный размер заявки
 * @returns Процент заполнения (0-100) как Decimal
 *
 * @remarks
 * Формула: (filledSize / size) × 100
 *
 * Возвращает 0 если не было заполнения.
 * Возвращает 100 если заявка полностью заполнена.
 *
 * Использует Decimal.js для точных вычислений.
 *
 * @example
 * ```typescript
 * const filled = Quantity.fromValue(50).value!;
 * const size = Quantity.fromValue(100).value!;
 * const percentage = getFillPercentage(filled, size);
 * console.log(percentage.toFixed(1)); // '50.0'
 * console.log(percentage.toNumber()); // 50
 *
 * // Полностью заполнено
 * const percentage2 = getFillPercentage(size, size);
 * console.log(percentage2.toNumber()); // 100
 * ```
 */
export function getFillPercentage(filledSize: Quantity | undefined, size: Quantity): Decimal {
  if (!filledSize || filledSize.isZero()) {
    return new Decimal(0);
  }
  return new Decimal(filledSize.value).dividedBy(size.value).times(100);
}
