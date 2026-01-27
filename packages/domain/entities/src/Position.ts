/**
 * Сущность Position (Позиция)
 *
 * @remarks
 * Представляет агрегированную позицию в токене с учетом FIFO лотов.
 * Управляет множественными лотами для точного отслеживания P&L и налоговой отчетности.
 *
 * Алгоритм:
 * - Позиция состоит из множественных лотов (FIFO очередь)
 * - Добавление лота: добавляет в массив lots, пересчитывает среднюю цену входа
 * - Удаление: использует самые старые лоты первыми (FIFO)
 * - Средняя цена входа = общая стоимость / общее количество
 * - Нереализованный P&L = сумма всех P&L лотов
 *
 * Почему FIFO?
 * - Требуется большинством налоговых юрисдикций
 * - Обеспечивает точное отслеживание базовой стоимости
 * - Упрощает бухгалтерский учет (не нужно сопоставлять конкретные лоты)
 * - Отраслевой стандарт для ценных бумаг
 *
 * Паттерны проектирования:
 * - Result pattern для всех fallible операций (addLot, removeLot)
 * - Private constructor + static factory method (empty)
 * - Immutability: все операции возвращают новый Position
 *
 * @example
 * ```typescript
 * const position = Position.empty('token-123', 'YES');
 *
 * // Добавляем первый лот (возвращает Result)
 * const lot1Result = PositionLot.create(
 *   'lot-1',
 *   'token-123',
 *   'YES',
 *   Quantity.fromValue(10).value,
 *   Price.fromValue(0.60).value,
 *   Date.now()
 * );
 * if (!lot1Result.ok) {
 *   console.error('Не удалось создать лот:', lot1Result.error.message);
 *   return;
 * }
 *
 * const addResult1 = position.addLot(lot1Result.value);
 * if (!addResult1.ok) {
 *   console.error('Не удалось добавить лот:', addResult1.error.message);
 *   return;
 * }
 *
 * console.log(addResult1.value.totalQuantity.value); // 10
 * console.log(addResult1.value.averageEntryPrice.value); // 0.60
 *
 * // Добавляем второй лот
 * const lot2Result = PositionLot.create(
 *   'lot-2',
 *   'token-123',
 *   'YES',
 *   Quantity.fromValue(5).value,
 *   Price.fromValue(0.70).value,
 *   Date.now()
 * );
 * if (!lot2Result.ok) return;
 *
 * const addResult2 = addResult1.value.addLot(lot2Result.value);
 * if (!addResult2.ok) return;
 *
 * console.log(addResult2.value.totalQuantity.value); // 15
 * console.log(addResult2.value.averageEntryPrice.value); // 0.6333 (средневзвешенная)
 *
 * // Удаляем количество (FIFO, возвращает Result)
 * const removeResult = addResult2.value.removeLot('lot-1', Quantity.fromValue(8).value);
 * if (!removeResult.ok) {
 *   console.error('Не удалось удалить лот:', removeResult.error.message);
 *   return;
 * }
 * // lot-1 теперь имеет 2 оставшихся, lot-2 не тронут
 * ```
 */
import { Price } from '@polymarket/value-objects';
import { Quantity } from '@polymarket/value-objects';
import { Money } from '@polymarket/value-objects';
import { PositionLot, Side, InsufficientLotQuantityError } from './PositionLot.js';
import { TradingError, PositionValidationError } from '@polymarket/errors';
import { Result, Ok, Err } from '@polymarket/result';

/**
 * Ошибка недостаточной позиции
 *
 * @remarks
 * Выбрасывается при попытке удалить больше количества, чем доступно в позиции.
 */
export class InsufficientPositionError extends TradingError {
  public readonly severity = 'low' as const;

  constructor(
    public readonly requested: number,
    public readonly available: number
  ) {
    super(
      `Insufficient position: requested ${requested}, available ${available}`,
      { code: 'INSUFFICIENT_POSITION', context: { requested, available } }
    );
  }
}

/**
 * Ошибка "лот не найден"
 *
 * @remarks
 * Выбрасывается при попытке удалить из несуществующего лота.
 */
export class LotNotFoundError extends TradingError {
  public readonly severity = 'low' as const;

  constructor(public readonly lotId: string) {
    super(`Lot not found: ${lotId}`, { code: 'LOT_NOT_FOUND', context: { lotId } });
  }
}

/**
 * Сущность Position (Позиция)
 *
 * @remarks
 * Неизменяемая сущность, представляющая агрегированную позицию с отслеживанием FIFO лотов.
 */
export class Position {
  /**
   * Создает новую Position
   *
   * @param tokenId - ID токена/рынка
   * @param side - Сторона YES или NO
   * @param totalQuantity - Общее количество по всем лотам
   * @param averageEntryPrice - Средневзвешенная цена входа
   * @param lots - Массив лотов (порядок FIFO)
   * @param unrealizedPnL - Текущий нереализованный прибыль/убыток
   *
   * @remarks
   * Private constructor - используйте статические фабричные методы.
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
   * Создает пустую позицию
   *
   * @param tokenId - ID токена/рынка
   * @param side - Сторона YES или NO
   * @returns Пустая позиция без лотов
   *
   * @remarks
   * Использует нейтральную цену (0.50) для пустой позиции.
   * Price.fromValue(0.50) гарантированно успешен (математическая инвариантность).
   *
   * @example
   * ```typescript
   * const position = Position.empty('token-123', 'YES');
   * console.log(position.isEmpty()); // true
   * console.log(position.totalQuantity.value); // 0
   * ```
   */
  public static empty(tokenId: string, side: Side): Position {
    // Price.fromValue(0.50) гарантированно успешен
    const neutralPriceResult = Price.fromValue(0.50);
    if (!neutralPriceResult.ok) {
      // Это не должно случиться никогда, но для type safety
      throw new Error('Failed to create neutral price for empty position');
    }

    return new Position(
      tokenId,
      side,
      Quantity.zero(),
      neutralPriceResult.value,
      [],
      Money.zero()
    );
  }

  /**
   * Добавляет новый лот к позиции
   *
   * @param lot - Лот для добавления
   * @returns Result с новой Position или ошибкой
   *
   * @remarks
   * Шаги:
   * 1. Валидирует совпадение tokenId и side
   * 2. Добавляет лот в массив
   * 3. Пересчитывает total quantity и average entry price
   * 4. Возвращает новый immutable Position
   *
   * Алгоритм вычисления средней цены:
   * - new_avg = (old_cost + new_cost) / (old_qty + new_qty)
   * - где cost = quantity * price
   *
   * @example
   * ```typescript
   * const position = Position.empty('token-123', 'YES');
   *
   * const lotResult = PositionLot.create(
   *   'lot-1',
   *   'token-123',
   *   'YES',
   *   Quantity.fromValue(10).value,
   *   Price.fromValue(0.60).value,
   *   Date.now()
   * );
   *
   * if (lotResult.ok) {
   *   const result = position.addLot(lotResult.value);
   *   if (result.ok) {
   *     console.log(result.value.totalQuantity.value); // 10
   *     console.log(result.value.averageEntryPrice.value); // 0.60
   *   }
   * }
   * ```
   */
  public addLot(lot: PositionLot): Result<Position, PositionValidationError> {
    // Валидация tokenId
    if (lot.tokenId !== this.tokenId) {
      return Err(
        new PositionValidationError(
          `Token mismatch: lot ${lot.tokenId} vs position ${this.tokenId}`,
          {
            context: {
              lotTokenId: lot.tokenId,
              positionTokenId: this.tokenId,
              lotId: lot.lotId
            }
          }
        )
      );
    }

    // Валидация side
    if (lot.side !== this.side) {
      return Err(
        new PositionValidationError(
          `Side mismatch: lot ${lot.side} vs position ${this.side}`,
          {
            context: {
              lotSide: lot.side,
              positionSide: this.side,
              lotId: lot.lotId
            }
          }
        )
      );
    }

    const newLots = [...this.lots, lot];

    // Add quantities
    const addResult = this.totalQuantity.add(lot.quantity);
    if (!addResult.ok) {
      return Err(
        new PositionValidationError(
          `Failed to add quantities: ${addResult.error.message}`,
          { context: { lotId: lot.lotId, currentQuantity: this.totalQuantity.value, addQuantity: lot.quantity.value } }
        )
      );
    }
    const newTotalQuantity = addResult.value;

    // Calculate weighted average entry price
    const oldCost = this.totalQuantity.value * this.averageEntryPrice.value;
    const newCost = lot.quantity.value * lot.entryPrice.value;
    const totalCost = oldCost + newCost;

    // Математически гарантировано валидно если оба price валидны
    const avgPriceValue = newTotalQuantity.value > 0
      ? totalCost / newTotalQuantity.value
      : 0.5;

    // Используем fromValue() для консистентности
    const newAveragePriceResult = Price.fromValue(avgPriceValue);
    if (!newAveragePriceResult.ok) {
      return Err(
        new PositionValidationError(
          `Failed to calculate average price: ${newAveragePriceResult.error.message}`,
          { context: { avgPriceValue, totalCost, totalQuantity: newTotalQuantity.value } }
        )
      );
    }

    return Ok(
      new Position(
        this.tokenId,
        this.side,
        newTotalQuantity,
        newAveragePriceResult.value,
        newLots,
        Money.zero()
      )
    );
  }

  /**
   * Удаляет количество из позиции используя FIFO
   *
   * @param lotId - ID лота
   * @param quantity - Количество для удаления
   * @returns Result с новой Position или ошибкой
   *
   * @remarks
   * FIFO Алгоритм:
   * 1. Находим указанный лот в массиве
   * 2. Закрываем указанное количество из этого лота (через lot.close())
   * 3. Если лот полностью закрыт (quantity = 0) - удаляем его из массива
   * 4. Пересчитываем total quantity (сумма оставшихся лотов)
   * 5. Пересчитываем average entry price (weighted average оставшихся)
   * 6. Возвращаем новый immutable Position
   *
   * Почему FIFO?
   * - Налоговое соответствие: большинство юрисдикций требуют FIFO
   * - Простота: не нужно отслеживать какие конкретно акции проданы
   * - Справедливость: самые старые покупки закрываются первыми
   *
   * @example
   * ```typescript
   * const position = Position.empty('token-123', 'YES');
   * const result1 = position.addLot(lot1); // 10 shares @ 0.60
   * if (!result1.ok) return;
   * const result2 = result1.value.addLot(lot2); // 5 shares @ 0.70
   * if (!result2.ok) return;
   *
   * // Remove 8 shares (FIFO: takes from lot1 first)
   * const removeResult = result2.value.removeLot('lot-1', Quantity.fromValue(8).value);
   * if (removeResult.ok) {
   *   console.log(removeResult.value.totalQuantity.value); // 7
   *   // lot1 has 2 remaining, lot2 still has 5
   * }
   * ```
   */
  public removeLot(
    lotId: string,
    quantity: Quantity
  ): Result<Position, LotNotFoundError | InsufficientLotQuantityError | PositionValidationError> {
    const lotIndex = this.lots.findIndex((l) => l.lotId === lotId);
    if (lotIndex === -1) {
      return Err(new LotNotFoundError(lotId));
    }

    const lot = this.lots[lotIndex];

    // Close specified quantity from this lot (returns Result)
    const closeResult = lot.close(quantity);
    if (!closeResult.ok) {
      return Err(closeResult.error);  // Propagate error
    }

    const updatedLot = closeResult.value;

    // Remove lot if fully closed, otherwise replace it
    const newLots = updatedLot.isClosed()
      ? this.lots.filter((l) => l.lotId !== lotId)
      : this.lots.map((l, i) => (i === lotIndex ? updatedLot : l));

    // Recalculate total quantity using manual loop to handle Results
    let totalQty = Quantity.zero();
    for (const lot of newLots) {
      const addResult = totalQty.add(lot.quantity);
      if (!addResult.ok) {
        return Err(
          new PositionValidationError(
            `Failed to sum quantities: ${addResult.error.message}`,
            { context: { lotId: lot.lotId } }
          )
        );
      }
      totalQty = addResult.value;
    }
    const newTotalQuantity = totalQty;

    let newAveragePrice = this.averageEntryPrice;
    if (newLots.length > 0) {
      const totalCost = newLots.reduce(
        (sum, l) => sum + l.quantity.value * l.entryPrice.value,
        0
      );
      const avgPriceValue = totalCost / newTotalQuantity.value;

      const priceResult = Price.fromValue(avgPriceValue);
      if (!priceResult.ok) {
        return Err(
          new PositionValidationError(
            `Failed to calculate average price: ${priceResult.error.message}`,
            { context: { avgPriceValue, totalCost } }
          )
        );
      }
      newAveragePrice = priceResult.value;
    }

    return Ok(
      new Position(
        this.tokenId,
        this.side,
        newTotalQuantity,
        newAveragePrice,
        newLots,
        Money.zero()
      )
    );
  }

  /**
   * Вычисляет общий нереализованный P&L по текущей цене
   *
   * @param currentPrice - Текущая рыночная цена
   * @returns Общий нереализованный P&L по всем лотам
   *
   * @remarks
   * Суммирует нереализованный P&L от каждого лота.
   * Каждый лот вычисляет свой собственный P&L на основе цены входа.
   *
   * @example
   * ```typescript
   * const position = Position.empty('token-123', 'YES')
   *   .addLot(lot1) // 10 @ 0.60
   *   .addLot(lot2); // 5 @ 0.70
   *
   * // Текущая цена 0.75
   * const pnl = position.calculateUnrealizedPnL(Price.fromNumber(0.75));
   * // lot1: (0.75 - 0.60) * 10 = 1.50
   * // lot2: (0.75 - 0.70) * 5 = 0.25
   * // итого: 1.75
   * console.log(pnl.amount); // 1.75
   * ```
   */
  public calculateUnrealizedPnL(currentPrice: Price): Money {
    if (this.lots.length === 0) {
      return Money.zero();
    }

    const totalPnL = this.lots.reduce((sum, lot) => {
      const lotPnL = lot.calculateUnrealizedPnL(currentPrice);
      return sum + lotPnL.getAmount();
    }, 0);

    const result = Money.fromValue(totalPnL);
    if (!result.ok) {
      // Это не должно случиться - математически гарантировано валидно
      throw new Error(`Failed to create Money for total P&L: ${result.error.message}`);
    }

    return result.value;
  }

  /**
   * Получает самый старый лот (для удаления FIFO)
   *
   * @returns Самый старый лот или undefined если нет лотов
   *
   * @remarks
   * Возвращает первый лот в массиве (самый старый по timestamp).
   * Используется для закрытия позиции по FIFO.
   *
   * @example
   * ```typescript
   * const position = Position.empty('token-123', 'YES')
   *   .addLot(lot1) // Добавлен первым
   *   .addLot(lot2); // Добавлен вторым
   *
   * const oldest = position.getOldestLot();
   * console.log(oldest?.lotId); // 'lot-1'
   * ```
   */
  public getOldestLot(): PositionLot | undefined {
    return this.lots[0];
  }

  /**
   * Проверяет, пустая ли позиция
   *
   * @returns True если нет количества или нет лотов
   *
   * @remarks
   * Пустая позиция имеет нулевое количество и не имеет лотов.
   * Должна быть удалена из инвентаря когда пустая.
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
   * Вычисляет общую базовую стоимость позиции
   *
   * @returns Общая стоимость всех лотов
   *
   * @remarks
   * Сумма базовой стоимости от всех лотов.
   * Используется для вычисления P&L и отчетности.
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
      return sum + lot.calculateCost().getAmount();
    }, 0);

    const result = Money.fromValue(totalCost);
    if (!result.ok) {
      // Это не должно случиться - математически гарантировано валидно
      throw new Error(`Failed to create Money for total cost: ${result.error.message}`);
    }

    return result.value;
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
   * Создает строковое представление позиции
   *
   * @returns Отформатированная строка с сводкой позиции
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
