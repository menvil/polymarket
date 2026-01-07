/**
 * SlippageCalculator - расчет проскальзывания
 *
 * @remarks
 * Доменный сервис для расчета ожидаемого slippage при исполнении ордера.
 *
 * Slippage:
 * ```
 * slippage = (executionPrice - expectedPrice) / expectedPrice
 * ```
 *
 * Причины slippage:
 * - Недостаточная ликвидность в ордербуке
 * - Большой размер ордера
 * - Изменение цен между размещением и исполнением
 * - Market impact (влияние крупного ордера на рынок)
 *
 * Зачем нужен SlippageCalculator?
 * - Оценка реальной цены исполнения перед размещением ордера
 * - Расчет worst-case execution price
 * - Оптимизация размера ордера
 * - Решение: market order vs limit order
 *
 * @example
 * ```typescript
 * const calculator = new SlippageCalculator();
 *
 * const slippage = calculator.calculateExpectedSlippage(
 *   orderbook,
 *   'BUY',
 *   Quantity.fromNumber(100)
 * );
 *
 * console.log(`Expected slippage: ${slippage.slippagePercent}%`);
 * console.log(`Average fill price: $${slippage.avgFillPrice.value}`);
 * ```
 */
import { Orderbook } from '../../entities/Orderbook.js';
import { Price } from '../../value-objects/Price.js';
import { Quantity } from '../../value-objects/Quantity.js';
import { Percentage } from '../../value-objects/Percentage.js';
import { ConfigLoader } from '../../../infrastructure/config/ConfigLoader.js';

/**
 * Slippage calculation result
 */
export interface SlippageResult {
  /**
   * Average fill price
   */
  avgFillPrice: Price;

  /**
   * Best price (before slippage)
   */
  bestPrice: Price;

  /**
   * Slippage amount (absolute)
   */
  slippage: number;

  /**
   * Slippage percentage
   */
  slippagePercent: Percentage;

  /**
   * Quantity filled
   */
  filledQuantity: number;

  /**
   * Quantity unfilled (if insufficient liquidity)
   */
  unfilledQuantity: number;

  /**
   * Is order fully fillable
   */
  isFullyFillable: boolean;

  /**
   * Number of price levels crossed
   */
  levelsCrossed: number;
}

/**
 * SlippageCalculator
 *
 * @remarks
 * Stateless сервис для расчета slippage при market orders.
 *
 * Алгоритм:
 * 1. Получить best price (bestBid для SELL, bestAsk для BUY)
 * 2. Симулировать заполнение ордера по уровням ордербука
 * 3. Рассчитать weighted average fill price
 * 4. Вычислить slippage = (avgFillPrice - bestPrice) / bestPrice
 *
 * @example
 * ```typescript
 * const calculator = new SlippageCalculator();
 *
 * // Orderbook:
 * // Ask: $0.66 (50 shares), $0.67 (100 shares), $0.68 (200 shares)
 * // Bid: $0.64 (100 shares)
 *
 * // BUY 120 shares (market order)
 * const slippage = calculator.calculateExpectedSlippage(
 *   orderbook,
 *   'BUY',
 *   Quantity.fromNumber(120)
 * );
 * // Fills: 50 @ $0.66, 70 @ $0.67
 * // avgFillPrice = (50*0.66 + 70*0.67) / 120 = 0.6658
 * // bestPrice = 0.66
 * // slippage = (0.6658 - 0.66) / 0.66 = 0.88%
 * ```
 */
export class SlippageCalculator {
  /**
   * Creates SlippageCalculator
   *
   * @example
   * ```typescript
   * const calculator = new SlippageCalculator();
   * ```
   */
  constructor() {}

  /**
   * Calculates expected slippage for market order
   *
   * @param orderbook - Current orderbook
   * @param side - Order side (BUY or SELL)
   * @param quantity - Order quantity
   * @returns Slippage calculation result
   *
   * @remarks
   * Алгоритм симуляции исполнения:
   *
   * **BUY order**:
   * 1. Берем ask уровни (sorted ascending by price)
   * 2. Заполняем ордер, начиная с лучшего ask:
   *    ```
   *    remainingQty = quantity
   *    while (remainingQty > 0 && levels available):
   *      level = nextAsk()
   *      fillQty = min(remainingQty, level.quantity)
   *      fills.push({price: level.price, qty: fillQty})
   *      remainingQty -= fillQty
   *    ```
   * 3. Рассчитываем weighted average price:
   *    ```
   *    avgPrice = sum(fill.price * fill.qty) / totalFilledQty
   *    ```
   *
   * **SELL order**: аналогично, но используем bid уровни
   *
   * @example
   * ```typescript
   * const calculator = new SlippageCalculator();
   *
   * // Example 1: Small order (no slippage)
   * // Orderbook: Ask $0.66 (100 shares)
   * // BUY 50 shares
   * const slippage1 = calculator.calculateExpectedSlippage(
   *   orderbook,
   *   'BUY',
   *   Quantity.fromNumber(50)
   * );
   * // avgFillPrice = 0.66, slippage = 0%
   *
   * // Example 2: Large order (significant slippage)
   * // Orderbook: Ask $0.66 (50), $0.67 (100), $0.68 (100)
   * // BUY 200 shares
   * const slippage2 = calculator.calculateExpectedSlippage(
   *   orderbook,
   *   'BUY',
   *   Quantity.fromNumber(200)
   * );
   * // Fills: 50 @ 0.66, 100 @ 0.67, 50 @ 0.68
   * // avgFillPrice = (50*0.66 + 100*0.67 + 50*0.68) / 200 = 0.67
   * // slippage = (0.67 - 0.66) / 0.66 = 1.52%
   *
   * // Example 3: Order too large (insufficient liquidity)
   * // Orderbook: Ask $0.66 (100 shares)
   * // BUY 200 shares
   * const slippage3 = calculator.calculateExpectedSlippage(
   *   orderbook,
   *   'BUY',
   *   Quantity.fromNumber(200)
   * );
   * // Fills: 100 @ 0.66
   * // filledQuantity = 100, unfilledQuantity = 100
   * // isFullyFillable = false
   * ```
   */
  public calculateExpectedSlippage(
    orderbook: Orderbook,
    side: 'BUY' | 'SELL',
    quantity: Quantity
  ): SlippageResult {
    const qtyToFill = quantity.value;
    let remainingQty = qtyToFill;
    let totalCost = 0;
    let filledQty = 0;
    let levelsCrossed = 0;

    // Get relevant side of orderbook
    const levels = side === 'BUY' ? orderbook.asks : orderbook.bids;

    if (levels.length === 0) {
      throw new Error(`Orderbook has no ${side === 'BUY' ? 'asks' : 'bids'}`);
    }

    const bestPrice = levels[0].price;

    // Simulate filling order through orderbook levels
    for (const level of levels) {
      if (remainingQty <= 0) {
        break;
      }

      const levelQty = level.quantity.value;
      const fillQty = Math.min(remainingQty, levelQty);

      totalCost += fillQty * level.price.value;
      filledQty += fillQty;
      remainingQty -= fillQty;
      levelsCrossed++;
    }

    const unfilledQty = qtyToFill - filledQty;
    const isFullyFillable = unfilledQty === 0;

    // Calculate average fill price
    const avgFillPrice = filledQty > 0 ? totalCost / filledQty : 0;

    // Calculate slippage
    const slippage = avgFillPrice - bestPrice.value;
    const slippagePercent =
      bestPrice.value > 0 ? (slippage / bestPrice.value) * 100 : 0;

    return {
      avgFillPrice: Price.fromNumber(avgFillPrice),
      bestPrice,
      slippage,
      slippagePercent: Percentage.fromNumber(slippagePercent),
      filledQuantity: filledQty,
      unfilledQuantity: unfilledQty,
      isFullyFillable,
      levelsCrossed,
    };
  }

  /**
   * Calculates maximum size for acceptable slippage
   *
   * @param orderbook - Current orderbook
   * @param side - Order side
   * @param maxSlippagePercent - Maximum acceptable slippage (default: 1%)
   * @returns Maximum quantity that can be filled within slippage limit
   *
   * @remarks
   * Находит максимальный размер ордера, который можно исполнить
   * с slippage не более maxSlippagePercent.
   *
   * Алгоритм:
   * 1. Берем лучшую цену
   * 2. Вычисляем максимально допустимую цену: maxPrice = bestPrice * (1 + maxSlippage)
   * 3. Суммируем liquidity до maxPrice
   *
   * @example
   * ```typescript
   * const calculator = new SlippageCalculator();
   *
   * // Orderbook: Ask $0.66 (100), $0.67 (100), $0.68 (100)
   * // Max slippage: 1%
   *
   * const maxSize = calculator.calculateMaxSizeForSlippage(
   *   orderbook,
   *   'BUY',
   *   1.0 // 1% max slippage
   * );
   * // maxPrice = 0.66 * 1.01 = 0.6666
   * // Can fill: 100 @ 0.66 (within limit)
   * // maxSize = 100
   *
   * console.log(`Max size: ${maxSize.value} shares`);
   * ```
   */
  public calculateMaxSizeForSlippage(
    orderbook: Orderbook,
    side: 'BUY' | 'SELL',
    maxSlippagePercent?: number
  ): Quantity {
    // Use config default if not specified
    const maxSlippage = maxSlippagePercent ??
      ConfigLoader.getInstance().getExecutionConfig().maxSlippagePercent;
    const levels = side === 'BUY' ? orderbook.asks : orderbook.bids;

    if (levels.length === 0) {
      return Quantity.fromNumber(0);
    }

    const bestPrice = levels[0].price.value;
    const maxPrice = bestPrice * (1 + maxSlippage / 100);

    let totalQty = 0;

    for (const level of levels) {
      const levelPrice = level.price.value;

      // For BUY: stop if price > maxPrice
      // For SELL: stop if price < maxPrice (inverted)
      if (side === 'BUY' && levelPrice > maxPrice) {
        break;
      }
      if (side === 'SELL' && levelPrice < maxPrice) {
        break;
      }

      totalQty += level.quantity.value;
    }

    return Quantity.fromNumber(totalQty);
  }

  /**
   * Calculates market impact
   *
   * @param orderbook - Current orderbook
   * @param side - Order side
   * @param quantity - Order quantity
   * @returns Market impact percentage
   *
   * @remarks
   * Market impact = изменение mid-price после исполнения ордера.
   *
   * Упрощенная формула:
   * ```
   * impact = (newMidPrice - oldMidPrice) / oldMidPrice
   * ```
   *
   * @example
   * ```typescript
   * const calculator = new SlippageCalculator();
   *
   * const impact = calculator.calculateMarketImpact(
   *   orderbook,
   *   'BUY',
   *   Quantity.fromNumber(500)
   * );
   *
   * if (impact.value > 2.0) {
   *   console.warn('High market impact! Consider splitting order');
   * }
   * ```
   */
  public calculateMarketImpact(
    orderbook: Orderbook,
    side: 'BUY' | 'SELL',
    quantity: Quantity
  ): Percentage {
    const oldMidPrice = orderbook.getMidPrice();
    if (!oldMidPrice) {
      return Percentage.fromNumber(0);
    }

    // After execution, the best price moves to the fill price
    const slippage = this.calculateExpectedSlippage(orderbook, side, quantity);

    if (!slippage.isFullyFillable) {
      // If order can't be fully filled, impact is very high
      return Percentage.fromNumber(100);
    }

    // Simplified: impact ≈ slippage / 2 (assumes symmetric impact)
    // More accurate models would consider bid-ask spread changes
    const impact = slippage.slippagePercent.value / 2;

    return Percentage.fromNumber(impact);
  }
}
