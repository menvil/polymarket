/**
 * PositionLot - Value Object для лота позиции
 *
 * @remarks
 * Представляет отдельный вход в позицию (lot).
 * Неизменяемый value object для FIFO/LIFO алгоритмов.
 *
 * Используется для:
 * - Расчета P&L при частичном закрытии позиции
 * - Отслеживания цены входа для каждого лота
 * - FIFO/LIFO accounting
 *
 * Инварианты:
 * - quantity должен быть валидным Quantity VO
 * - entryPrice должен быть валидным Price VO
 * - timestamp должен быть валидным Timestamp VO
 * - fee опциональный Fee VO
 *
 * @example
 * ```typescript
 * import { PositionLot } from './PositionLot';
 * import { Price, Quantity, Timestamp, Fee } from '@polymarket/value-objects';
 * import Decimal from 'decimal.js';
 *
 * const lot = PositionLot.create({
 *   quantity: Quantity.of(new Decimal(100)),
 *   entryPrice: Price.of(new Decimal(0.65)),
 *   timestamp: Timestamp.now(),
 *   fee: Fee.of(new Decimal(0.5)),
 * });
 *
 * console.log(`Lot: ${lot.quantity.value} @ ${lot.entryPrice.value}`);
 * console.log(`Is empty: ${lot.isEmpty()}`);
 * ```
 */

import { Price, Quantity, Timestamp, Fee } from '@polymarket/value-objects';

/**
 * Параметры для создания PositionLot
 */
export interface PositionLotParams {
  readonly quantity: Quantity;
  readonly entryPrice: Price;
  readonly timestamp: Timestamp;
  readonly fee?: Fee;
}

/**
 * PositionLot - лот позиции
 *
 * @remarks
 * Immutable value object.
 * Используется в FIFO/LIFO алгоритмах для управления лотами.
 */
export class PositionLot {
  private constructor(
    public readonly quantity: Quantity,
    public readonly entryPrice: Price,
    public readonly timestamp: Timestamp,
    public readonly fee?: Fee
  ) {
    Object.freeze(this);
  }

  /**
   * Создаёт PositionLot
   *
   * @param params - Параметры лота
   * @returns PositionLot
   *
   * @remarks
   * Простой конструктор без валидации - все VO уже валидированы.
   *
   * @example
   * ```typescript
   * const lot = PositionLot.create({
   *   quantity: Quantity.of(new Decimal(100)),
   *   entryPrice: Price.of(new Decimal(0.65)),
   *   timestamp: Timestamp.now(),
   * });
   * ```
   */
  public static create(params: PositionLotParams): PositionLot {
    return new PositionLot(
      params.quantity,
      params.entryPrice,
      params.timestamp,
      params.fee
    );
  }

  /**
   * Проверяет, является ли лот пустым (quantity = 0)
   *
   * @returns true если quantity равен нулю
   *
   * @remarks
   * Пустые лоты появляются после полного закрытия лота в FIFO/LIFO.
   * Обычно они удаляются из массива lots.
   *
   * @example
   * ```typescript
   * if (lot.isEmpty()) {
   *   console.log('Lot fully closed, should be removed');
   * }
   * ```
   */
  public isEmpty(): boolean {
    return this.quantity.isZero();
  }

  /**
   * Создаёт новый лот с обновлённым quantity
   *
   * @param newQuantity - Новый объём
   * @returns Новый PositionLot с обновлённым quantity
   *
   * @remarks
   * Immutability pattern - возвращает новый объект.
   * Используется при частичном закрытии лота.
   *
   * @example
   * ```typescript
   * const originalLot = PositionLot.create({
   *   quantity: Quantity.of(new Decimal(100)),
   *   entryPrice: Price.of(new Decimal(0.65)),
   *   timestamp: Timestamp.now(),
   * });
   *
   * // Частичное закрытие - осталось 60
   * const remainingLot = originalLot.withQuantity(Quantity.of(new Decimal(60)));
   *
   * console.log(originalLot.quantity.value); // 100 (не изменился)
   * console.log(remainingLot.quantity.value); // 60 (новый объект)
   * ```
   */
  public withQuantity(newQuantity: Quantity): PositionLot {
    return PositionLot.create({
      quantity: newQuantity,
      entryPrice: this.entryPrice,
      timestamp: this.timestamp,
      fee: this.fee,
    });
  }

  /**
   * Создаёт новый лот с обновлённым fee
   *
   * @param newFee - Новый fee
   * @returns Новый PositionLot с обновлённым fee
   *
   * @remarks
   * Immutability pattern - возвращает новый объект.
   *
   * @example
   * ```typescript
   * const updatedLot = lot.withFee(Fee.of(new Decimal(1.0)));
   * ```
   */
  public withFee(newFee: Fee): PositionLot {
    return PositionLot.create({
      quantity: this.quantity,
      entryPrice: this.entryPrice,
      timestamp: this.timestamp,
      fee: newFee,
    });
  }

  /**
   * Сравнивает два лота на равенство
   *
   * @param other - Другой PositionLot
   * @returns true если все поля равны
   *
   * @remarks
   * Сравнивает quantity, entryPrice, timestamp.
   * Fee не сравнивается (опционально).
   *
   * @example
   * ```typescript
   * const lot1 = PositionLot.create({ quantity, entryPrice, timestamp });
   * const lot2 = PositionLot.create({ quantity, entryPrice, timestamp });
   * console.log(lot1.equals(lot2)); // true
   * ```
   */
  public equals(other: PositionLot): boolean {
    return (
      this.quantity.equals(other.quantity) &&
      this.entryPrice.equals(other.entryPrice) &&
      this.timestamp.equals(other.timestamp)
    );
  }

  /**
   * Вычисляет notional value лота (quantity * entryPrice)
   *
   * @returns Notional value
   *
   * @remarks
   * Notional = количество * цена входа
   * Используется для расчета weighted average price.
   *
   * @example
   * ```typescript
   * const lot = PositionLot.create({
   *   quantity: Quantity.of(new Decimal(100)),
   *   entryPrice: Price.of(new Decimal(0.65)),
   *   timestamp: Timestamp.now(),
   * });
   *
   * const notional = lot.getNotional();
   * console.log(notional); // 65.0 (100 * 0.65)
   * ```
   */
  public getNotional(): number {
    return this.quantity.value().toNumber() * this.entryPrice.value().toNumber();
  }

  /**
   * Конвертирует в строковое представление
   *
   * @returns Строковое представление лота
   *
   * @example
   * ```typescript
   * console.log(lot.toString());
   * // "100.00 @ 0.6500 (2024-01-15T10:30:00.000Z)"
   * ```
   */
  public toString(): string {
    const qtyStr = this.quantity.value().toFixed(2);
    const priceStr = this.entryPrice.value().toFixed(4);
    const timeStr = new Date(this.timestamp.value).toISOString();
    return `${qtyStr} @ ${priceStr} (${timeStr})`;
  }

  /**
   * Конвертирует в объект для serialization
   *
   * @returns Объектное представление
   *
   * @example
   * ```typescript
   * const obj = lot.toObject();
   * console.log(JSON.stringify(obj));
   * // {"quantity": 100, "entryPrice": 0.65, "timestamp": 1705318200000, "fee": 0.5}
   * ```
   */
  public toObject(): {
    quantity: number;
    entryPrice: number;
    timestamp: number;
    fee?: number;
  } {
    return {
      quantity: this.quantity.value().toNumber(),
      entryPrice: this.entryPrice.value().toNumber(),
      timestamp: this.timestamp.value,
      fee: this.fee?.quantity.amount().value().toNumber(),
    };
  }
}
