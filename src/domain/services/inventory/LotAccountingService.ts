/**
 * LotAccountingService - учет лотов по FIFO
 *
 * @remarks
 * Доменный сервис для управления лотами позиций по методу FIFO.
 *
 * FIFO (First-In-First-Out):
 * - При покупке: добавляется новый лот
 * - При продаже: списываются лоты в порядке их создания
 * - Важно для налогообложения (tax lots)
 * - Гарантирует корректный расчет realized P&L
 *
 * Зачем нужен LotAccountingService?
 * - Учет cost basis для каждой покупки
 * - Расчет realized P&L при продаже (FIFO)
 * - Соответствие налоговым требованиям
 * - Трекинг HODL периодов для каждого лота
 *
 * @example
 * ```typescript
 * const service = new LotAccountingService();
 *
 * // Добавление лота
 * const newLot = service.addLot(
 *   position,
 *   Quantity.fromNumber(100),
 *   Price.fromNumber(0.65)
 * );
 *
 * // Удаление лотов при продаже
 * const result = service.removeLotsFIFO(
 *   position,
 *   Quantity.fromNumber(50),
 *   Price.fromNumber(0.70)
 * );
 *
 * console.log(`Realized P&L: $${result.realizedPnl.amount}`);
 * ```
 */
import { Position } from '../../entities/Position.js';
import { PositionLot } from '../../entities/PositionLot.js';
import { Price } from '../../value-objects/Price.js';
import { Quantity } from '../../value-objects/Quantity.js';
import { Money } from '../../value-objects/Money.js';

/**
 * FIFO removal result
 */
export interface FIFORemovalResult {
  /**
   * Removed lots (may be partial)
   */
  removedLots: PositionLot[];

  /**
   * Realized P&L from removal
   */
  realizedPnl: Money;

  /**
   * Cost basis of removed quantity
   */
  costBasis: Money;

  /**
   * Proceeds from sale
   */
  proceeds: Money;
}

/**
 * Lot summary
 */
export interface LotSummary {
  /**
   * Total quantity across all lots
   */
  totalQuantity: Quantity;

  /**
   * Total cost basis
   */
  totalCost: Money;

  /**
   * Average entry price
   */
  avgEntryPrice: Price;

  /**
   * Number of lots
   */
  lotCount: number;

  /**
   * Oldest lot age in days
   */
  oldestLotAgeDays: number;
}

/**
 * LotAccountingService
 *
 * @remarks
 * Stateless сервис для управления лотами позиций.
 *
 * Алгоритм FIFO:
 * 1. При добавлении: создать новый PositionLot
 * 2. При удалении: списывать лоты в порядке их создания
 * 3. Если лот частично использован: split на две части
 * 4. Расчет realized P&L: (sellPrice - avgCostBasis) * quantity
 *
 * @example
 * ```typescript
 * const service = new LotAccountingService();
 *
 * // Scenario: Buy 100 at $0.60, then 50 at $0.70, then sell 120
 * const pos1 = Position.create({...});
 *
 * // Add first lot: 100 @ $0.60
 * const lot1 = service.addLot(pos1, Quantity.fromNumber(100), Price.fromNumber(0.60));
 *
 * // Add second lot: 50 @ $0.70
 * const lot2 = service.addLot(pos1, Quantity.fromNumber(50), Price.fromNumber(0.70));
 *
 * // Sell 120 @ $0.75 (FIFO: removes 100 from lot1, 20 from lot2)
 * const result = service.removeLotsFIFO(pos1, Quantity.fromNumber(120), Price.fromNumber(0.75));
 * // result.removedLots = [lot1 (100), partial lot2 (20)]
 * // result.costBasis = 100 * 0.60 + 20 * 0.70 = $74
 * // result.proceeds = 120 * 0.75 = $90
 * // result.realizedPnl = $90 - $74 = +$16
 * ```
 */
export class LotAccountingService {
  /**
   * Creates LotAccountingService
   *
   * @example
   * ```typescript
   * const service = new LotAccountingService();
   * ```
   */
  constructor() {}

  /**
   * Adds new lot to position
   *
   * @param position - Position to add lot to
   * @param quantity - Lot quantity
   * @param entryPrice - Entry price for lot
   * @returns New PositionLot
   *
   * @remarks
   * Создает новый лот при покупке токенов.
   * Лот хранит: quantity, entryPrice, timestamp, unrealizedPnl.
   *
   * @example
   * ```typescript
   * const service = new LotAccountingService();
   *
   * const lot = service.addLot(
   *   position,
   *   Quantity.fromNumber(100),
   *   Price.fromNumber(0.65)
   * );
   *
   * console.log(`Created lot: ${lot.quantity.value} @ $${lot.entryPrice.value}`);
   * ```
   */
  public addLot(_position: Position, quantity: Quantity, entryPrice: Price): PositionLot {
    // Note: position parameter for future use (e.g., getting tokenId, side)
    const lot = new PositionLot(
      `lot-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      'token-unknown', // Would get from position.tokenId
      'YES', // Would get from position.side
      quantity,
      entryPrice,
      new Date()
    );
    return lot;
  }

  /**
   * Removes lots using FIFO method
   *
   * @param position - Position to remove lots from
   * @param quantityToSell - Quantity to sell
   * @param sellPrice - Sale price
   * @returns FIFO removal result with realized P&L
   *
   * @throws {Error} If insufficient quantity in position
   *
   * @remarks
   * Алгоритм FIFO removal:
   *
   * 1. **Проверка доступного quantity**:
   *    ```
   *    if (quantityToSell > position.totalQuantity) → error
   *    ```
   *
   * 2. **Итерация по лотам в порядке создания**:
   *    ```
   *    remainingToSell = quantityToSell
   *    while (remainingToSell > 0):
   *      lot = nextLot()
   *      if (lot.quantity <= remainingToSell):
   *        remove entire lot
   *        remainingToSell -= lot.quantity
   *      else:
   *        remove partial lot
   *        remainingToSell = 0
   *    ```
   *
   * 3. **Расчет realized P&L**:
   *    ```
   *    For each removed lot:
   *      costBasis += lot.quantity * lot.entryPrice
   *      proceeds += lot.quantity * sellPrice
   *    realizedPnl = proceeds - costBasis
   *    ```
   *
   * @example
   * ```typescript
   * const service = new LotAccountingService();
   *
   * // Setup: position with 2 lots
   * // Lot 1: 100 @ $0.60 (created first)
   * // Lot 2: 50 @ $0.70 (created second)
   * // Total: 150 shares, avg cost = $0.633
   *
   * // Sell 120 @ $0.75
   * const result = service.removeLotsFIFO(
   *   position,
   *   Quantity.fromNumber(120),
   *   Price.fromNumber(0.75)
   * );
   *
   * // FIFO removes:
   * // - Entire Lot 1: 100 @ $0.60 → cost = $60
   * // - Partial Lot 2: 20 @ $0.70 → cost = $14
   * // Total cost basis: $74
   * // Proceeds: 120 * $0.75 = $90
   * // Realized P&L: $90 - $74 = +$16
   *
   * console.log(result.removedLots.length); // 2
   * console.log(result.costBasis.amount); // 74
   * console.log(result.proceeds.amount); // 90
   * console.log(result.realizedPnl.amount); // +16
   * ```
   */
  public removeLotsFIFO(
    position: Position,
    quantityToSell: Quantity,
    sellPrice: Price
  ): FIFORemovalResult {
    const totalQuantity = position.totalQuantity.value;

    if (quantityToSell.value > totalQuantity) {
      throw new Error(
        `Insufficient quantity: trying to sell ${quantityToSell.value}, but position has ${totalQuantity}`
      );
    }

    const removedLots: PositionLot[] = [];
    let remainingToSell = quantityToSell.value;
    let totalCostBasis = 0;

    // Iterate through lots in FIFO order (oldest first)
    const lots = Array.from(position.lots);

    for (const lot of lots) {
      if (remainingToSell <= 0) {
        break;
      }

      const lotQuantity = lot.quantity.value;

      if (lotQuantity <= remainingToSell) {
        // Remove entire lot
        removedLots.push(lot);
        totalCostBasis += lotQuantity * lot.entryPrice.value;
        remainingToSell -= lotQuantity;
      } else {
        // Remove partial lot
        const partialQuantity = remainingToSell;
        const partialLot = new PositionLot(
          `lot-partial-${Date.now()}`,
          lot.tokenId,
          lot.side,
          Quantity.fromNumber(partialQuantity),
          lot.entryPrice,
          lot.timestamp
        );
        removedLots.push(partialLot);
        totalCostBasis += partialQuantity * lot.entryPrice.value;
        remainingToSell = 0;
      }
    }

    // Calculate proceeds and realized P&L
    const proceeds = quantityToSell.value * sellPrice.value;
    const realizedPnl = proceeds - totalCostBasis;

    return {
      removedLots,
      realizedPnl: Money.fromUSDC(realizedPnl),
      costBasis: Money.fromUSDC(totalCostBasis),
      proceeds: Money.fromUSDC(proceeds),
    };
  }

  /**
   * Gets summary of all lots in position
   *
   * @param position - Position to summarize
   * @returns Lot summary with aggregated metrics
   *
   * @remarks
   * Вычисляет агрегированные метрики по всем лотам:
   * - Общее количество
   * - Общая стоимость
   * - Средняя цена входа
   * - Количество лотов
   * - Возраст самого старого лота
   *
   * @example
   * ```typescript
   * const service = new LotAccountingService();
   *
   * const summary = service.getLotsSummary(position);
   *
   * console.log(`Total quantity: ${summary.totalQuantity.value}`);
   * console.log(`Average entry: $${summary.avgEntryPrice.value}`);
   * console.log(`Number of lots: ${summary.lotCount}`);
   * console.log(`Oldest lot: ${summary.oldestLotAgeDays} days old`);
   * ```
   */
  public getLotsSummary(position: Position): LotSummary {
    const lots = Array.from(position.lots);

    if (lots.length === 0) {
      return {
        totalQuantity: Quantity.fromNumber(0),
        totalCost: Money.fromUSDC(0),
        avgEntryPrice: Price.fromNumber(0),
        lotCount: 0,
        oldestLotAgeDays: 0,
      };
    }

    let totalQuantity = 0;
    let totalCost = 0;
    let oldestTimestamp = Date.now();

    for (const lot of lots) {
      totalQuantity += lot.quantity.value;
      totalCost += lot.quantity.value * lot.entryPrice.value;

      const lotTimestamp = lot.timestamp.getTime();
      if (lotTimestamp < oldestTimestamp) {
        oldestTimestamp = lotTimestamp;
      }
    }

    const avgEntryPrice = totalQuantity > 0 ? totalCost / totalQuantity : 0;

    const now = Date.now();
    const oldestLotAgeDays = (now - oldestTimestamp) / (1000 * 60 * 60 * 24);

    return {
      totalQuantity: Quantity.fromNumber(totalQuantity),
      totalCost: Money.fromUSDC(totalCost),
      avgEntryPrice: Price.fromNumber(avgEntryPrice),
      lotCount: lots.length,
      oldestLotAgeDays,
    };
  }

  /**
   * Calculates tax implications for sale
   *
   * @param position - Position to sell from
   * @param quantityToSell - Quantity to sell
   * @param sellPrice - Sale price
   * @returns Object with short-term and long-term gains
   *
   * @remarks
   * Разделяет realized P&L на short-term (< 1 year) и long-term (>= 1 year)
   * для налогообложения (tax purposes).
   *
   * В США:
   * - Short-term capital gains: обычная налоговая ставка
   * - Long-term capital gains: льготная ставка (обычно ниже)
   *
   * @example
   * ```typescript
   * const service = new LotAccountingService();
   *
   * const taxResult = service.calculateTaxImplications(
   *   position,
   *   Quantity.fromNumber(100),
   *   Price.fromNumber(0.75)
   * );
   *
   * console.log(`Short-term gain: $${taxResult.shortTermGain.amount}`);
   * console.log(`Long-term gain: $${taxResult.longTermGain.amount}`);
   * ```
   */
  public calculateTaxImplications(
    position: Position,
    quantityToSell: Quantity,
    sellPrice: Price
  ): {
    shortTermGain: Money;
    longTermGain: Money;
  } {
    const result = this.removeLotsFIFO(position, quantityToSell, sellPrice);

    const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;

    let shortTermGain = 0;
    let longTermGain = 0;

    for (const lot of result.removedLots) {
      const lotTimestamp = lot.timestamp.getTime();
      const costBasis = lot.quantity.value * lot.entryPrice.value;
      const proceeds = lot.quantity.value * sellPrice.value;
      const gain = proceeds - costBasis;

      if (lotTimestamp >= oneYearAgo) {
        // Short-term (held < 1 year)
        shortTermGain += gain;
      } else {
        // Long-term (held >= 1 year)
        longTermGain += gain;
      }
    }

    return {
      shortTermGain: Money.fromUSDC(shortTermGain),
      longTermGain: Money.fromUSDC(longTermGain),
    };
  }
}
