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
 * import Decimal from 'decimal.js';
 *
 * const price = Price.of(new Decimal('0.65'));
 * const size = Quantity.of(new Decimal('100'));
 * const notional = getNotional(price, size);
 * console.log(notional.toNumber()); // 65.0
 * ```
 */

import Decimal from 'decimal.js';
import { Quantity } from '@polymarket/value-objects';
import type { Price } from '@polymarket/value-objects';

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
 * @example
 * ```typescript
 * const notional = getNotional(price, size);
 * console.log(notional.toNumber()); // 65.0
 * ```
 */
export function getNotional(price: Price, size: Quantity): Decimal {
  return price.value().times(size.value());
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
 * @example
 * ```typescript
 * const remaining = getRemainingSize(size, filledSize);
 * console.log(remaining.value().toNumber()); // 60
 * ```
 */
export function getRemainingSize(size: Quantity, filledSize?: Quantity): Quantity {
  if (!filledSize || filledSize.isZero()) {
    return size;
  }
  const remaining = size.value().minus(filledSize.value());
  return Quantity.of(remaining);
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
 * @example
 * ```typescript
 * const percentage = getFillPercentage(filled, size);
 * console.log(percentage.toNumber()); // 50
 * ```
 */
export function getFillPercentage(filledSize: Quantity | undefined, size: Quantity): Decimal {
  if (!filledSize || filledSize.isZero()) {
    return new Decimal(0);
  }
  return filledSize.value().dividedBy(size.value()).times(100);
}
