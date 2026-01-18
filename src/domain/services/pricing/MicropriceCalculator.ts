/**
 * MicropriceCalculator - расчет микроцены
 *
 * @remarks
 * Доменный сервис для вычисления microprice из ордербука.
 * Microprice учитывает не только цены, но и объемы на лучших уровнях.
 *
 * Формула:
 * ```
 * microprice = (bidPrice * askSize + askPrice * bidSize) / (bidSize + askSize)
 * ```
 *
 * Интуиция:
 * - Если askSize >> bidSize → microprice ближе к bidPrice (больше давление продавцов)
 * - Если bidSize >> askSize → microprice ближе к askPrice (больше давление покупателей)
 * - Если bidSize = askSize → microprice = midPrice
 *
 * Зачем нужен microprice?
 * - Более точная оценка "моментальной" цены актива
 * - Учитывает дисбаланс ликвидности
 * - Компонент для расчета fair value
 * - Индикатор краткосрочного направления движения цены
 *
 * @example
 * ```typescript
 * const calculator = new MicropriceCalculator();
 *
 * const bids = [
 *   { price: Price.fromNumber(0.64), quantity: Quantity.fromNumber(100) },
 *   { price: Price.fromNumber(0.63), quantity: Quantity.fromNumber(200) },
 * ];
 *
 * const asks = [
 *   { price: Price.fromNumber(0.66), quantity: Quantity.fromNumber(50) },
 *   { price: Price.fromNumber(0.67), quantity: Quantity.fromNumber(150) },
 * ];
 *
 * const microprice = calculator.calculate(bids, asks);
 * console.log(`Microprice: ${microprice.value}`); // ~0.6467
 * ```
 */
import { Price } from '../../value-objects/Price.js';
import { Quantity } from '../../value-objects/Quantity.js';

/**
 * Orderbook level for microprice calculation
 */
export interface OrderbookLevel {
  price: Price;
  quantity: Quantity;
}

/**
 * MicropriceCalculator
 *
 * @remarks
 * Stateless сервис для расчета microprice из bid/ask данных.
 *
 * Алгоритм:
 * 1. Получить лучшие bid и ask уровни
 * 2. Применить формулу: (bidPrice * askQty + askPrice * bidQty) / (bidQty + askQty)
 * 3. Fallback на mid-price если недостаточно данных
 *
 * @example
 * ```typescript
 * const calculator = new MicropriceCalculator();
 *
 * const bids = [
 *   { price: Price.fromNumber(0.64), quantity: Quantity.fromNumber(100) },
 * ];
 * const asks = [
 *   { price: Price.fromNumber(0.66), quantity: Quantity.fromNumber(200) },
 * ];
 *
 * const microprice = calculator.calculate(bids, asks);
 * // microprice = (0.64 * 200 + 0.66 * 100) / (100 + 200)
 * //            = (128 + 66) / 300
 * //            = 194 / 300
 * //            = 0.6467
 * ```
 */
export class MicropriceCalculator {
  /**
   * Creates MicropriceCalculator
   *
   * @example
   * ```typescript
   * const calculator = new MicropriceCalculator();
   * ```
   */
  constructor() {}

  /**
   * Calculates microprice from bids and asks
   *
   * @param bids - Bid levels (sorted descending by price)
   * @param asks - Ask levels (sorted ascending by price)
   * @returns Calculated microprice
   *
   * @throws {Error} If bids or asks are empty
   *
   * @remarks
   * Алгоритм:
   * 1. Проверка наличия bid и ask уровней
   * 2. Извлечение лучших bid/ask (первый элемент каждого массива)
   * 3. Расчет microprice по формуле:
   *    ```
   *    microprice = (bidPrice * askQty + askPrice * bidQty) / (bidQty + askQty)
   *    ```
   * 4. Если объемы нулевые → fallback на mid-price
   *
   * Интерпретация результата:
   * - microprice < midPrice → больше давление продавцов (askSize > bidSize)
   * - microprice > midPrice → больше давление покупателей (bidSize > askSize)
   * - microprice = midPrice → сбалансированный рынок (bidSize = askSize)
   *
   * @example
   * ```typescript
   * const calculator = new MicropriceCalculator();
   *
   * // Сбалансированный рынок
   * const bids1 = [{ price: Price.fromNumber(0.64), quantity: Quantity.fromNumber(100) }];
   * const asks1 = [{ price: Price.fromNumber(0.66), quantity: Quantity.fromNumber(100) }];
   * const micro1 = calculator.calculate(bids1, asks1);
   * // micro1 = (0.64 * 100 + 0.66 * 100) / 200 = 0.65 (= midPrice)
   *
   * // Больше давление продавцов
   * const bids2 = [{ price: Price.fromNumber(0.64), quantity: Quantity.fromNumber(50) }];
   * const asks2 = [{ price: Price.fromNumber(0.66), quantity: Quantity.fromNumber(200) }];
   * const micro2 = calculator.calculate(bids2, asks2);
   * // micro2 = (0.64 * 200 + 0.66 * 50) / 250 = 0.644 (< midPrice = 0.65)
   *
   * // Больше давление покупателей
   * const bids3 = [{ price: Price.fromNumber(0.64), quantity: Quantity.fromNumber(200) }];
   * const asks3 = [{ price: Price.fromNumber(0.66), quantity: Quantity.fromNumber(50) }];
   * const micro3 = calculator.calculate(bids3, asks3);
   * // micro3 = (0.64 * 50 + 0.66 * 200) / 250 = 0.656 (> midPrice = 0.65)
   * ```
   */
  public calculate(bids: OrderbookLevel[], asks: OrderbookLevel[]): Price {
    if (bids.length === 0 || asks.length === 0) {
      throw new Error('Cannot calculate microprice: bids or asks are empty');
    }

    // Get best bid and ask
    const bestBid = bids[0];
    const bestAsk = asks[0];

    const bidPrice = bestBid.price.value;
    const bidQty = bestBid.quantity.value;
    const askPrice = bestAsk.price.value;
    const askQty = bestAsk.quantity.value;

    // Check for zero quantities
    if (bidQty === 0 || askQty === 0) {
      // Fallback to mid-price
      const midPrice = (bidPrice + askPrice) / 2;
      return Price.fromNumber(midPrice);
    }

    // Calculate microprice
    // microprice = (bidPrice * askQty + askPrice * bidQty) / (bidQty + askQty)
    const numerator = bidPrice * askQty + askPrice * bidQty;
    const denominator = bidQty + askQty;

    const microprice = numerator / denominator;

    return Price.fromNumber(microprice);
  }

  /**
   * Calculates microprice directly from price/quantity values
   *
   * @param bidPrice - Best bid price
   * @param bidQuantity - Best bid quantity
   * @param askPrice - Best ask price
   * @param askQuantity - Best ask quantity
   * @returns Calculated microprice
   *
   * @remarks
   * Convenience метод для расчета microprice напрямую из значений.
   * Использует ту же формулу, что и calculate().
   *
   * @example
   * ```typescript
   * const calculator = new MicropriceCalculator();
   *
   * const microprice = calculator.calculateFromValues(
   *   0.64,  // bidPrice
   *   100,   // bidQty
   *   0.66,  // askPrice
   *   200    // askQty
   * );
   *
   * console.log(`Microprice: ${microprice.value}`); // 0.6467
   * ```
   */
  public calculateFromValues(
    bidPrice: number,
    bidQuantity: number,
    askPrice: number,
    askQuantity: number
  ): Price {
    return this.calculate(
      [
        {
          price: Price.fromNumber(bidPrice),
          quantity: Quantity.fromNumber(bidQuantity),
        },
      ],
      [
        {
          price: Price.fromNumber(askPrice),
          quantity: Quantity.fromNumber(askQuantity),
        },
      ]
    );
  }
}
