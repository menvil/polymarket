/**
 * OrderbookLevel - Value Object для уровня в стакане заявок
 *
 * @remarks
 * Представляет один уровень цены с соответствующим объёмом.
 * Неизменяемый value object.
 *
 * Инварианты:
 * - price должен быть валидным Price VO
 * - quantity должен быть валидным Quantity VO (может быть 0)
 *
 * @example
 * ```typescript
 * import { Price, Quantity } from '@polymarket/value-objects';
 * import { OrderbookLevel } from './OrderbookLevel';
 *
 * const priceResult = Price.fromValue(0.52);
 * const quantityResult = Quantity.fromValue(100);
 *
 * if (priceResult.ok && quantityResult.ok) {
 *   const level = OrderbookLevel.create(priceResult.value, quantityResult.value);
 *   console.log(`Level: ${level.price.value} @ ${level.quantity.value}`);
 * }
 * ```
 */

import type { Price, Quantity } from '@polymarket/value-objects';

/**
 * Уровень в стакане заявок
 *
 * @remarks
 * Immutable value object для одного price level.
 * Используется как в bids, так и в asks.
 */
export class OrderbookLevel {
  private constructor(
    public readonly price: Price,
    public readonly quantity: Quantity
  ) {
    Object.freeze(this);
  }

  /**
   * Создаёт OrderbookLevel
   *
   * @param price - Цена уровня
   * @param quantity - Объём на этом уровне
   * @returns OrderbookLevel
   *
   * @remarks
   * Простой конструктор без валидации - Price и Quantity уже валидированы.
   *
   * @example
   * ```typescript
   * const price = Price.fromValue(0.52).value;
   * const quantity = Quantity.fromValue(100).value;
   * const level = OrderbookLevel.create(price, quantity);
   * ```
   */
  public static create(price: Price, quantity: Quantity): OrderbookLevel {
    return new OrderbookLevel(price, quantity);
  }

  /**
   * Проверяет, является ли уровень пустым (quantity = 0)
   *
   * @returns true если quantity равен нулю
   *
   * @remarks
   * Пустые уровни могут появляться в raw данных и должны фильтроваться
   * при нормализации (в зависимости от NormalizationPolicy).
   *
   * @example
   * ```typescript
   * if (level.isEmpty()) {
   *   console.log('Empty level, should be filtered out');
   * }
   * ```
   */
  public isEmpty(): boolean {
    return this.quantity.isZero();
  }

  /**
   * Создаёт новый уровень с обновлённым quantity
   *
   * @param newQuantity - Новый объём
   * @returns Новый OrderbookLevel с обновлённым quantity
   *
   * @remarks
   * Immutability pattern - возвращает новый объект.
   *
   * @example
   * ```typescript
   * const updated = level.withQuantity(Quantity.fromValue(200).value);
   * console.log(updated.quantity.value); // 200
   * console.log(level.quantity.value); // 100 (оригинал не изменился)
   * ```
   */
  public withQuantity(newQuantity: Quantity): OrderbookLevel {
    return OrderbookLevel.create(this.price, newQuantity);
  }

  /**
   * Сравнивает два уровня на равенство
   *
   * @param other - Другой OrderbookLevel
   * @returns true если price и quantity равны
   *
   * @example
   * ```typescript
   * const level1 = OrderbookLevel.create(price1, qty1);
   * const level2 = OrderbookLevel.create(price1, qty1);
   * console.log(level1.equals(level2)); // true
   * ```
   */
  public equals(other: OrderbookLevel): boolean {
    return (
      this.price.equals(other.price) &&
      this.quantity.equals(other.quantity)
    );
  }

  /**
   * Конвертирует в строковое представление
   *
   * @returns Строковое представление уровня
   *
   * @example
   * ```typescript
   * console.log(level.toString()); // "0.5200 @ 100.00"
   * ```
   */
  public toString(): string {
    return `${this.price.value().toFixed(4)} @ ${this.quantity.value().toFixed(2)}`;
  }

  /**
   * Конвертирует в объект для serialization
   *
   * @returns Объектное представление
   *
   * @example
   * ```typescript
   * const obj = level.toObject();
   * console.log(JSON.stringify(obj));
   * // {"price": 0.52, "quantity": 100}
   * ```
   */
  public toObject(): { price: number; quantity: number } {
    return {
      price: this.price.value().toNumber(),
      quantity: this.quantity.value().toNumber(),
    };
  }
}
