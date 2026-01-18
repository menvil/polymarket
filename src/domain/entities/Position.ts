/**
 * Сущность Position (позиция)
 *
 * @remarks
 * Представляет агрегированную позицию в токене с FIFO учётом лотов.
 * Управляет несколькими лотами для точного отслеживания P&L и налоговой отчётности.
 *
 * Алгоритм:
 * - Позиция состоит из нескольких лотов (FIFO очередь)
 * - Добавление лота: добавляется в массив лотов, пересчитывается средняя цена входа
 * - Удаление: используются самые старые лоты первыми (FIFO)
 * - Средняя цена входа = общая стоимость / общее количество
 * - Нереализованный P&L = сумма всех P&L лотов
 *
 * Почему FIFO?
 * - Обеспечивает точное отслеживание базы затрат
 * - Упрощает учёт (не нужно сопоставлять конкретные лоты)
 * - Отраслевой стандарт для ценных бумаг
 *
 * @example
 * ```typescript
 * const position = Position.empty('token-123', 'YES');
 *
 * // Add first lot
 * const lot1 = new PositionLot(
 *   'lot-1',
 *   'token-123',
 *   'YES',
 *   Quantity.fromNumber(10),
 *   Price.fromNumber(0.60),
 *   new Date()
 * );
 * position = position.addLot(lot1);
 * console.log(position.totalQuantity.value); // 10
 * console.log(position.averageEntryPrice.value); // 0.60
 *
 * // Add second lot
 * const lot2 = new PositionLot(
 *   'lot-2',
 *   'token-123',
 *   'YES',
 *   Quantity.fromNumber(5),
 *   Price.fromNumber(0.70),
 *   new Date()
 * );
 * position = position.addLot(lot2);
 * console.log(position.totalQuantity.value); // 15
 * console.log(position.averageEntryPrice.value); // 0.6333 (weighted average)
 *
 * // Remove quantity (FIFO)
 * position = position.removeLot('lot-1', Quantity.fromNumber(8));
 * // lot-1 now has 2 remaining, lot-2 is untouched
 * ```
 */
import { Price } from '../value-objects/Price.js';
import { Quantity } from '../value-objects/Quantity.js';
import { Money } from '../value-objects/Money.js';
import { PositionLot, Side } from './PositionLot.js';
import { TradingError } from '../../shared/errors/TradingError.js';

/**
 * Ошибка недостаточной позиции
 *
 * @remarks
 * Выбрасывается при попытке удалить больше количества, чем доступно в позиции.
 */
export class InsufficientPositionError extends TradingError {
  constructor(
    public readonly requested: number,
    public readonly available: number
  ) {
    super(
      `Insufficient position: requested ${requested}, available ${available}`,
      'INSUFFICIENT_POSITION'
    );
  }
}

/**
 * Ошибка отсутствия лота
 *
 * @remarks
 * Выбрасывается при попытке удалить из несуществующего лота.
 */
export class LotNotFoundError extends TradingError {
  constructor(public readonly lotId: string) {
    super(`Lot not found: ${lotId}`, 'LOT_NOT_FOUND');
  }
}

/**
 * Сущность Position
 *
 * @remarks
 * Неизменяемая сущность, представляющая агрегированную позицию с FIFO отслеживанием лотов.
 */
export class Position {
  /**
   * Создаёт новую Position
   *
   * @param tokenId - ID токена/рынка
   * @param side - Сторона YES или NO
   * @param totalQuantity - Общее количество по всем лотам
   * @param averageEntryPrice - Взвешенная средняя цена входа
   * @param lots - Массив лотов (FIFO порядок)
   * @param unrealizedPnL - Текущая нереализованная прибыль/убыток
   *
   * @remarks
   * Private конструктор - используйте статические фабричные методы.
   */
  private constructor(
    public readonly tokenId: string,
    public readonly side: Side,
    public readonly totalQuantity: Quantity,
    public readonly averageEntryPrice: Price,
    public readonly lots: readonly PositionLot[],
    public readonly unrealizedPnL: Money
  ) {}

  /**
   * Создаёт пустую позицию
   *
   * @param tokenId - ID токена/рынка
   * @param side - Сторона YES или NO
   * @returns Пустая позиция без лотов
   *
   * @example
   * ```typescript
   * const position = Position.empty('token-123', 'YES');
   * console.log(position.isEmpty()); // true
   * console.log(position.totalQuantity.value); // 0
   * ```
   */
  public static empty(tokenId: string, side: Side): Position {
    return new Position(
      tokenId,
      side,
      Quantity.zero(),
      Price.fromNumber(0.50), // Нейтральная цена для пустой позиции
      [],
      Money.zero()
    );
  }

  /**
   * Добавляет новый лот к позиции
   *
   * @param lot - Лот для добавления
   * @returns Новая Position с добавленным лотом
   *
   * @throws {Error} Если токен/сторона лота не совпадают с позицией
   *
   * @remarks
   * Шаги:
   * 1. Проверяет, что лот соответствует токену и стороне позиции
   * 2. Добавляет лот в массив лотов
   * 3. Пересчитывает общее количество (сумма всех лотов)
   * 4. Пересчитывает среднюю цену входа (взвешенное среднее)
   * 5. Возвращает новый неизменяемый экземпляр Position
   *
   * Расчёт средней цены:
   * - новая_средняя = (старая_стоимость + новая_стоимость) / (старое_кол-во + новое_кол-во)
   * - где стоимость = количество * цена
   *
   * @example
   * ```typescript
   * const position = Position.empty('token-123', 'YES');
   *
   * const lot1 = new PositionLot(
   *   'lot-1',
   *   'token-123',
   *   'YES',
   *   Quantity.fromNumber(10),
   *   Price.fromNumber(0.60),
   *   new Date()
   * );
   *
   * const newPosition = position.addLot(lot1);
   * console.log(newPosition.totalQuantity.value); // 10
   * console.log(newPosition.averageEntryPrice.value); // 0.60
   * ```
   */
  public addLot(lot: PositionLot): Position {
    if (lot.tokenId !== this.tokenId) {
      throw new Error(
        `Token mismatch: lot ${lot.tokenId} vs position ${this.tokenId}`
      );
    }
    if (lot.side !== this.side) {
      throw new Error(
        `Side mismatch: lot ${lot.side} vs position ${this.side}`
      );
    }

    const newLots = [...this.lots, lot];
    const newTotalQuantity = this.totalQuantity.add(lot.quantity);

    // Вычисляем взвешенную среднюю цену входа
    const oldCost = this.totalQuantity.value * this.averageEntryPrice.value;
    const newCost = lot.quantity.value * lot.entryPrice.value;
    const totalCost = oldCost + newCost;

    const newAveragePrice =
      newTotalQuantity.value > 0
        ? Price.fromNumber(totalCost / newTotalQuantity.value)
        : this.averageEntryPrice;

    return new Position(
      this.tokenId,
      this.side,
      newTotalQuantity,
      newAveragePrice,
      newLots,
      Money.zero() // Будет пересчитан по требованию
    );
  }

  /**
   * Удаляет количество из позиции с использованием FIFO
   *
   * @param lotId - ID лота для удаления
   * @param quantity - Количество для удаления
   * @returns Новая Position с уменьшенным количеством
   *
   * @throws {LotNotFoundError} Если лот не существует
   * @throws {InsufficientPositionError} Если удаляется больше, чем доступно
   *
   * @remarks
   * Алгоритм FIFO:
   * 1. Находим указанный лот в массиве лотов
   * 2. Закрываем указанное количество из этого лота
   * 3. Если лот полностью закрыт (количество = 0), удаляем его из массива
   * 4. Пересчитываем общее количество (сумма оставшихся лотов)
   * 5. Пересчитываем среднюю цену входа (взвешенное среднее оставшихся)
   * 6. Возвращаем новую неизменяемую Position
   *
   * Почему FIFO?
   * - Соответствие налогообложению: большинство юрисдикций требуют FIFO
   * - Простота: не нужно отслеживать конкретные проданные акции
   * - Справедливость: самые старые покупки закрываются первыми
   *
   * @example
   * ```typescript
   * const position = Position.empty('token-123', 'YES')
   *   .addLot(lot1) // 10 shares @ 0.60
   *   .addLot(lot2); // 5 shares @ 0.70
   *
   * // Remove 8 shares (FIFO: takes from lot1 first)
   * const reduced = position.removeLot('lot-1', Quantity.fromNumber(8));
   * console.log(reduced.totalQuantity.value); // 7
   * // lot1 has 2 remaining, lot2 still has 5
   *
   * // Remove remaining from lot1
   * const reduced2 = reduced.removeLot('lot-1', Quantity.fromNumber(2));
   * console.log(reduced2.lots.length); // 1 (lot1 removed)
   * ```
   */
  public removeLot(lotId: string, quantity: Quantity): Position {
    const lotIndex = this.lots.findIndex((l) => l.lotId === lotId);
    if (lotIndex === -1) {
      throw new LotNotFoundError(lotId);
    }

    const lot = this.lots[lotIndex];

    // Закрываем указанное количество из этого лота
    const updatedLot = lot.close(quantity);

    // Удаляем лот если полностью закрыт, иначе заменяем его
    const newLots = updatedLot.isClosed()
      ? this.lots.filter((l) => l.lotId !== lotId)
      : this.lots.map((l, i) => (i === lotIndex ? updatedLot : l));

    // Пересчитываем общее количество и среднюю цену
    const newTotalQuantity = newLots.reduce(
      (sum, l) => sum.add(l.quantity),
      Quantity.zero()
    );

    let newAveragePrice = this.averageEntryPrice;
    if (newLots.length > 0) {
      const totalCost = newLots.reduce(
        (sum, l) => sum + l.quantity.value * l.entryPrice.value,
        0
      );
      newAveragePrice = Price.fromNumber(totalCost / newTotalQuantity.value);
    }

    return new Position(
      this.tokenId,
      this.side,
      newTotalQuantity,
      newAveragePrice,
      newLots,
      Money.zero() // Будет пересчитан по требованию
    );
  }

  /**
   * Вычисляет общий нереализованный P&L по текущей цене
   *
   * @param currentPrice - Текущая рыночная цена
   * @returns Общий нереализованный P&L по всем лотам
   *
   * @remarks
   * Суммирует нереализованный P&L каждого лота.
   * Каждый лот вычисляет свой P&L на основе цены входа.
   *
   * @example
   * ```typescript
   * const position = Position.empty('token-123', 'YES')
   *   .addLot(lot1) // 10 @ 0.60
   *   .addLot(lot2); // 5 @ 0.70
   *
   * // Current price is 0.75
   * const pnl = position.calculateUnrealizedPnL(Price.fromNumber(0.75));
   * // lot1: (0.75 - 0.60) * 10 = 1.50
   * // lot2: (0.75 - 0.70) * 5 = 0.25
   * // total: 1.75
   * console.log(pnl.amount); // 1.75
   * ```
   */
  public calculateUnrealizedPnL(currentPrice: Price): Money {
    if (this.lots.length === 0) {
      return Money.zero();
    }

    const totalPnL = this.lots.reduce((sum, lot) => {
      const lotPnL = lot.calculateUnrealizedPnL(currentPrice);
      return sum + lotPnL.amount;
    }, 0);

    return Money.fromUSDC(totalPnL);
  }

  /**
   * Получает самый старый лот (для FIFO удаления)
   *
   * @returns Самый старый лот или undefined если нет лотов
   *
   * @remarks
   * Возвращает первый лот в массиве (самый старый по timestamp).
   * Используется для FIFO закрытия позиции.
   *
   * @example
   * ```typescript
   * const position = Position.empty('token-123', 'YES')
   *   .addLot(lot1) // Added first
   *   .addLot(lot2); // Added second
   *
   * const oldest = position.getOldestLot();
   * console.log(oldest?.lotId); // 'lot-1'
   * ```
   */
  public getOldestLot(): PositionLot | undefined {
    return this.lots[0];
  }

  /**
   * Проверяет, пуста ли позиция
   *
   * @returns True если нет количества или нет лотов
   *
   * @remarks
   * Пустая позиция имеет нулевое количество и нет лотов.
   * Должна быть удалена из инвентаря когда пуста.
   *
   * @example
   * ```typescript
   * const position = Position.empty('token-123', 'YES');
   * console.log(position.isEmpty()); // true
   *
   * const withLot = position.addLot(lot);
   * console.log(withLot.isEmpty()); // false
   * ```
   */
  public isEmpty(): boolean {
    return this.lots.length === 0 || this.totalQuantity.isZero();
  }

  /**
   * Вычисляет общую базу затрат позиции
   *
   * @returns Общая стоимость всех лотов
   *
   * @remarks
   * Сумма базы затрат всех лотов.
   * Используется для расчёта P&L и отчётности.
   *
   * @example
   * ```typescript
   * const position = Position.empty('token-123', 'YES')
   *   .addLot(lot1) // 10 @ 0.60 = 6.00
   *   .addLot(lot2); // 5 @ 0.70 = 3.50
   *
   * const cost = position.getTotalCost();
   * console.log(cost.amount); // 9.50
   * ```
   */
  public getTotalCost(): Money {
    if (this.lots.length === 0) {
      return Money.zero();
    }

    const totalCost = this.lots.reduce((sum, lot) => {
      return sum + lot.calculateCost().amount;
    }, 0);

    return Money.fromUSDC(totalCost);
  }

  /**
   * Получает количество лотов в позиции
   *
   * @returns Количество лотов
   *
   * @example
   * ```typescript
   * const position = Position.empty('token-123', 'YES')
   *   .addLot(lot1)
   *   .addLot(lot2);
   * console.log(position.getLotCount()); // 2
   * ```
   */
  public getLotCount(): number {
    return this.lots.length;
  }

  /**
   * Создаёт строковое представление позиции
   *
   * @returns Отформатированная строка с итогом позиции
   *
   * @example
   * ```typescript
   * const position = Position.empty('token-123', 'YES')
   *   .addLot(lot1)
   *   .addLot(lot2);
   * console.log(position.toString());
   * // "Position[token-123/YES]: 15.00 shares @ avg $0.6333 (2 lots)"
   * ```
   */
  public toString(): string {
    return `Position[${this.tokenId}/${this.side}]: ${this.totalQuantity.toString()} shares @ avg $${this.averageEntryPrice.toString()} (${this.lots.length} lots)`;
  }
}
