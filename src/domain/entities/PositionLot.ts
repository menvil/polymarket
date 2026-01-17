/**
 * PositionLot entity
 *
 * @remarks
 * Представляет один лот для FIFO (First In, First Out) учёта.
 * Каждый лот отслеживает конкретную покупку по определённой цене и времени.
 * Используется для точного расчёта P&L.
 *
 * Алгоритм:
 * - Каждая сделка создаёт новый лот с ценой входа и количеством
 * - При закрытии позиции используются самые старые лоты (FIFO)
 * - Нереализованный P&L = (текущая цена - цена входа) * количество
 * - Лоты могут быть частично закрыты
 * - Лоты неизменяемы - закрытие создаёт новый экземпляр
 *
 * @example
 * ```typescript
 * const lot = new PositionLot(
 *   'lot-1',
 *   'token-123',
 *   'YES',
 *   Quantity.fromNumber(10),
 *   Price.fromNumber(0.65),
 *   new Date()
 * );
 *
 * // Calculate cost
 * const cost = lot.calculateCost();
 * console.log(cost.amount); // 6.50
 *
 * // Calculate unrealized P&L
 * const pnl = lot.calculateUnrealizedPnL(Price.fromNumber(0.70));
 * console.log(pnl.amount); // 0.50 (profit)
 *
 * // Close partial quantity
 * const closedLot = lot.close(Quantity.fromNumber(5));
 * console.log(closedLot.quantity.value); // 5
 * console.log(closedLot.isClosed()); // true
 * ```
 */
import { Price } from '../value-objects/Price.js';
import { Quantity } from '../value-objects/Quantity.js';
import { Money } from '../value-objects/Money.js';
import { TradingError } from '../../shared/errors/TradingError.js';

/**
 * Сторона позиции
 */
export type Side = 'YES' | 'NO';

/**
 * Ошибка недостаточного количества
 *
 * @remarks
 * Выбрасывается при попытке закрыть больше количества, чем доступно в лоте.
 */
export class InsufficientLotQuantityError extends TradingError {
  constructor(
    public readonly requested: number,
    public readonly available: number
  ) {
    super(
      `Insufficient lot quantity: requested ${requested}, available ${available}`,
      'INSUFFICIENT_LOT_QUANTITY'
    );
  }
}

/**
 * PositionLot entity
 *
 * @remarks
 * Неизменяемая сущность, представляющая один лот в FIFO учёте.
 */
export class PositionLot {
  /**
   * Создаёт новый PositionLot
   *
   * @param lotId - Уникальный идентификатор лота
   * @param tokenId - ID токена/рынка
   * @param side - Сторона YES или NO
   * @param quantity - Количество акций в лоте
   * @param entryPrice - Цена, по которой был куплен этот лот
   * @param timestamp - Когда был создан лот
   *
   * @throws {Error} Если количество отрицательное
   *
   * @example
   * ```typescript
   * const lot = new PositionLot(
   *   'lot-1',
   *   'token-123',
   *   'YES',
   *   Quantity.fromNumber(10),
   *   Price.fromNumber(0.65),
   *   new Date()
   * );
   * ```
   */
  constructor(
    public readonly lotId: string,
    public readonly tokenId: string,
    public readonly side: Side,
    public readonly quantity: Quantity,
    public readonly entryPrice: Price,
    public readonly timestamp: Date
  ) {
    if (quantity.value < 0) {
      throw new Error('Lot quantity must be non-negative');
    }
  }

  /**
   * Вычисляет общую стоимость лота
   *
   * @returns Значение Money, представляющее стоимость (количество * цена входа)
   *
   * @remarks
   * Стоимость = количество * цена входа
   * Это сумма, уплаченная за приобретение лота.
   *
   * @example
   * ```typescript
   * const lot = new PositionLot(
   *   'lot-1',
   *   'token-123',
   *   'YES',
   *   Quantity.fromNumber(10),
   *   Price.fromNumber(0.65),
   *   new Date()
   * );
   * const cost = lot.calculateCost();
   * console.log(cost.amount); // 6.50
   * ```
   */
  public calculateCost(): Money {
    return Money.fromUSDC(this.quantity.value * this.entryPrice.value);
  }

  /**
   * Вычисляет нереализованную прибыль/убыток по текущей цене
   *
   * @param currentPrice - Текущая рыночная цена
   * @returns Значение Money, представляющее нереализованный P&L
   *
   * @remarks
   * Нереализованный P&L = (текущая цена - цена входа) * количество
   * - Положительное значение = прибыль
   * - Отрицательное значение = убыток
   *
   * Для NO позиций P&L инвертирован:
   * - Стоимость входа = количество * (1 - цена входа)
   * - Текущая стоимость = количество * (1 - текущая цена)
   * - P&L = текущая стоимость - стоимость входа
   *
   * @example
   * ```typescript
   * const lot = new PositionLot(
   *   'lot-1',
   *   'token-123',
   *   'YES',
   *   Quantity.fromNumber(10),
   *   Price.fromNumber(0.65),
   *   new Date()
   * );
   *
   * // Price went up - profit
   * const pnl1 = lot.calculateUnrealizedPnL(Price.fromNumber(0.70));
   * console.log(pnl1.amount); // 0.50
   *
   * // Price went down - loss
   * const pnl2 = lot.calculateUnrealizedPnL(Price.fromNumber(0.60));
   * console.log(pnl2.amount); // -0.50
   * ```
   */
  public calculateUnrealizedPnL(currentPrice: Price): Money {
    if (this.side === 'YES') {
      // Для YES: P&L = (текущая - входная) * количество
      const pnl = (currentPrice.value - this.entryPrice.value) * this.quantity.value;
      return Money.fromUSDC(Math.abs(pnl) < 0.000001 ? 0 : pnl);
    } else {
      // Для NO: P&L = (входная - текущая) * количество
      // Потому что стоимость NO токена движется обратно цене
      const pnl = (this.entryPrice.value - currentPrice.value) * this.quantity.value;
      return Money.fromUSDC(Math.abs(pnl) < 0.000001 ? 0 : pnl);
    }
  }

  /**
   * Закрывает часть или весь лот
   *
   * @param closeQuantity - Количество для закрытия из этого лота
   * @returns Новый PositionLot с оставшимся количеством
   *
   * @throws {InsufficientLotQuantityError} Если закрывается больше, чем доступно
   *
   * @remarks
   * Создаёт новый лот с уменьшенным количеством.
   * Если закрывается всё количество, возвращает лот с нулевым количеством.
   * Исходный лот остаётся неизменным (immutable).
   *
   * @example
   * ```typescript
   * const lot = new PositionLot(
   *   'lot-1',
   *   'token-123',
   *   'YES',
   *   Quantity.fromNumber(10),
   *   Price.fromNumber(0.65),
   *   new Date()
   * );
   *
   * // Close partial
   * const remaining = lot.close(Quantity.fromNumber(6));
   * console.log(remaining.quantity.value); // 4
   * console.log(remaining.isClosed()); // false
   *
   * // Close remaining
   * const closed = remaining.close(Quantity.fromNumber(4));
   * console.log(closed.quantity.value); // 0
   * console.log(closed.isClosed()); // true
   * ```
   */
  public close(closeQuantity: Quantity): PositionLot {
    if (closeQuantity.isGreaterThan(this.quantity)) {
      throw new InsufficientLotQuantityError(
        closeQuantity.value,
        this.quantity.value
      );
    }

    const remainingQuantity = this.quantity.subtract(closeQuantity);

    return new PositionLot(
      this.lotId,
      this.tokenId,
      this.side,
      remainingQuantity,
      this.entryPrice,
      this.timestamp
    );
  }

  /**
   * Проверяет, полностью ли закрыт лот
   *
   * @returns True если количество равно нулю
   *
   * @remarks
   * Закрытый лот имеет нулевое количество и должен быть удалён из инвентаря.
   *
   * @example
   * ```typescript
   * const lot = new PositionLot(
   *   'lot-1',
   *   'token-123',
   *   'YES',
   *   Quantity.fromNumber(10),
   *   Price.fromNumber(0.65),
   *   new Date()
   * );
   * console.log(lot.isClosed()); // false
   *
   * const closed = lot.close(Quantity.fromNumber(10));
   * console.log(closed.isClosed()); // true
   * ```
   */
  public isClosed(): boolean {
    return this.quantity.isZero();
  }

  /**
   * Создаёт строковое представление лота
   *
   * @returns Отформатированная строка с деталями лота
   *
   * @example
   * ```typescript
   * const lot = new PositionLot(
   *   'lot-1',
   *   'token-123',
   *   'YES',
   *   Quantity.fromNumber(10),
   *   Price.fromNumber(0.65),
   *   new Date('2024-01-01')
   * );
   * console.log(lot.toString());
   * // "Lot[lot-1]: 10.00 YES @ $0.6500 (2024-01-01)"
   * ```
   */
  public toString(): string {
    return `Lot[${this.lotId}]: ${this.quantity.toString()} ${this.side} @ $${this.entryPrice.toString()} (${this.timestamp.toISOString().split('T')[0]})`;
  }
}
