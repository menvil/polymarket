/**
 * Orderbook entity
 *
 * @remarks
 * Представляет стакан заявок (order book) с бидами и аcками.
 * Предоставляет методы для анализа ликвидности, спреда и расчёта цен.
 *
 * Алгоритм:
 * 1. Хранит отсортированные массивы бидов (по убыванию цены) и асков (по возрастанию)
 * 2. Вычисляет best bid (максимальная цена покупки)
 * 3. Вычисляет best ask (минимальная цена продажи)
 * 4. Рассчитывает mid price = (best bid + best ask) / 2
 * 5. Рассчитывает microprice (взвешенная цена по объёмам)
 * 6. Рассчитывает спред = ask - bid
 *
 * Структура данных:
 * - bids: массив уровней [price, quantity] в порядке убывания цены
 * - asks: массив уровней [price, quantity] в порядке возрастания цены
 * - timestamp: время последнего обновления
 *
 * @example
 * ```typescript
 * const orderbook = Orderbook.create('market-123', {
 *   bids: [
 *     { price: Price.fromNumber(0.52), quantity: Quantity.fromNumber(100) },
 *     { price: Price.fromNumber(0.51), quantity: Quantity.fromNumber(200) }
 *   ],
 *   asks: [
 *     { price: Price.fromNumber(0.53), quantity: Quantity.fromNumber(150) },
 *     { price: Price.fromNumber(0.54), quantity: Quantity.fromNumber(250) }
 *   ]
 * });
 *
 * const bestBid = orderbook.getBestBid(); // 0.52
 * const bestAsk = orderbook.getBestAsk(); // 0.53
 * const spread = orderbook.getSpread(); // Spread(0.52, 0.53)
 * const midPrice = orderbook.getMidPrice(); // 0.525
 * const microprice = orderbook.getMicroprice(); // ~0.524 (weighted)
 * ```
 */
import { Price } from '../../../../../polymarket-v4/src/domain/value-objects/Price';
import { Quantity } from '../../../../../polymarket-v4/src/domain/value-objects/Quantity';
import { Spread } from '../../../../../polymarket-v4/src/domain/value-objects/Spread';

/**
 * Уровень в стакане заявок
 *
 * @remarks
 * Представляет один уровень цены с соответствующим объёмом.
 */
export interface OrderbookLevel {
  price: Price;
  quantity: Quantity;
}

/**
 * Параметры для создания Orderbook
 */
export interface OrderbookData {
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  timestamp?: Date;
}

/**
 * Orderbook entity
 *
 * @remarks
 * Immutable entity representing market order book.
 */
export class Orderbook {
  /**
   * Создаёт новый Orderbook
   *
   * @param marketId - Идентификатор рынка
   * @param bids - Массив bid уровней (отсортирован по убыванию цены)
   * @param asks - Массив ask уровней (отсортирован по возрастанию цены)
   * @param timestamp - Время снимка стакана
   *
   * @remarks
   * Private constructor - используйте статический метод create().
   */
  private constructor(
    public readonly marketId: string,
    public readonly bids: readonly OrderbookLevel[],
    public readonly asks: readonly OrderbookLevel[],
    public readonly timestamp: Date
  ) {}

  /**
   * Создаёт новый Orderbook
   *
   * @param marketId - Идентификатор рынка
   * @param data - Данные стакана (bids, asks, timestamp)
   * @returns Новый Orderbook с отсортированными уровнями
   *
   * @remarks
   * Сортирует bids по убыванию цены, asks по возрастанию.
   * Гарантирует правильный порядок для эффективного доступа к best bid/ask.
   *
   * Алгоритм сортировки:
   * - Bids: [0.55, 0.54, 0.53, ...] (лучший bid первый)
   * - Asks: [0.56, 0.57, 0.58, ...] (лучший ask первый)
   *
   * @example
   * ```typescript
   * const orderbook = Orderbook.create('market-123', {
   *   bids: [
   *     { price: Price.fromNumber(0.52), quantity: Quantity.fromNumber(100) },
   *     { price: Price.fromNumber(0.51), quantity: Quantity.fromNumber(200) }
   *   ],
   *   asks: [
   *     { price: Price.fromNumber(0.53), quantity: Quantity.fromNumber(150) }
   *   ]
   * });
   * ```
   */
  public static create(marketId: string, data: OrderbookData): Orderbook {
    if (!marketId || marketId.trim().length === 0) {
      throw new Error('Market ID cannot be empty');
    }

    // Сортируем bids по убыванию цены (лучший bid первый)
    const sortedBids = [...data.bids].sort((a, b) => b.price.value - a.price.value);

    // Сортируем asks по возрастанию цены (лучший ask первый)
    const sortedAsks = [...data.asks].sort((a, b) => a.price.value - b.price.value);

    return new Orderbook(
      marketId,
      sortedBids,
      sortedAsks,
      data.timestamp || new Date()
    );
  }

  /**
   * Создаёт пустой стакан
   *
   * @param marketId - Идентификатор рынка
   * @returns Пустой Orderbook без уровней
   *
   * @remarks
   * Используется когда нет данных стакана.
   * Все методы вернут null/undefined.
   *
   * @example
   * ```typescript
   * const empty = Orderbook.empty('market-123');
   * console.log(empty.getBestBid()); // null
   * console.log(empty.isEmpty()); // true
   * ```
   */
  public static empty(marketId: string): Orderbook {
    return new Orderbook(marketId, [], [], new Date());
  }

  /**
   * Получает лучший bid (максимальная цена покупки)
   *
   * @returns Лучший bid price или null если нет бидов
   *
   * @remarks
   * Возвращает первый элемент отсортированного массива bids.
   * Это максимальная цена, которую покупатели готовы заплатить.
   *
   * @example
   * ```typescript
   * const bestBid = orderbook.getBestBid();
   * if (bestBid) {
   *   console.log(`Best bid: ${bestBid.value}`);
   * }
   * ```
   */
  public getBestBid(): Price | null {
    return this.bids.length > 0 ? this.bids[0].price : null;
  }

  /**
   * Получает лучший ask (минимальная цена продажи)
   *
   * @returns Лучший ask price или null если нет асков
   *
   * @remarks
   * Возвращает первый элемент отсортированного массива asks.
   * Это минимальная цена, по которой продавцы готовы продать.
   *
   * @example
   * ```typescript
   * const bestAsk = orderbook.getBestAsk();
   * if (bestAsk) {
   *   console.log(`Best ask: ${bestAsk.value}`);
   * }
   * ```
   */
  public getBestAsk(): Price | null {
    return this.asks.length > 0 ? this.asks[0].price : null;
  }

  /**
   * Получает спред (bid-ask spread)
   *
   * @returns Spread объект или null если нет bid/ask
   *
   * @remarks
   * Спред = ask - bid
   * Узкий спред указывает на высокую ликвидность.
   * Широкий спред указывает на низкую ликвидность.
   *
   * @example
   * ```typescript
   * const spread = orderbook.getSpread();
   * if (spread) {
   *   console.log(`Spread width: ${spread.width()}`);
   *   console.log(`Midpoint: ${spread.midpoint().value}`);
   * }
   * ```
   */
  public getSpread(): Spread | null {
    const bid = this.getBestBid();
    const ask = this.getBestAsk();

    if (!bid || !ask) {
      return null;
    }

    return Spread.create(bid, ask);
  }

  /**
   * Получает mid price (средняя цена)
   *
   * @returns Mid price или null если нет bid/ask
   *
   * @remarks
   * Mid price = (best bid + best ask) / 2
   * Используется как справочная цена для анализа.
   * Не учитывает объёмы (в отличие от microprice).
   *
   * @example
   * ```typescript
   * const midPrice = orderbook.getMidPrice();
   * if (midPrice) {
   *   console.log(`Mid price: ${midPrice.value}`);
   * }
   * ```
   */
  public getMidPrice(): Price | null {
    const spread = this.getSpread();
    return spread ? spread.midpoint() : null;
  }

  /**
   * Получает microprice (взвешенная цена)
   *
   * @returns Microprice или null если нет bid/ask
   *
   * @remarks
   * Microprice учитывает объёмы на лучших bid/ask уровнях:
   *
   * microprice = (bestAsk * bidQty + bestBid * askQty) / (bidQty + askQty)
   *
   * Где:
   * - bidQty = объём на лучшем bid
   * - askQty = объём на лучшем ask
   *
   * Microprice точнее отражает истинную рыночную цену,
   * так как учитывает дисбаланс ликвидности.
   *
   * Примеры:
   * - Если bidQty >> askQty: microprice ближе к ask (давление покупателей)
   * - Если askQty >> bidQty: microprice ближе к bid (давление продавцов)
   * - Если bidQty == askQty: microprice == midprice
   *
   * @example
   * ```typescript
   * // bid: 0.50 qty 100, ask: 0.52 qty 200
   * const micro = orderbook.getMicroprice();
   * // micro = (0.52 * 100 + 0.50 * 200) / (100 + 200)
   * //       = (52 + 100) / 300 = 0.5067
   * // Ближе к bid, так как больше объём на ask
   *
   * const mid = orderbook.getMidPrice();
   * // mid = (0.50 + 0.52) / 2 = 0.51
   *
   * console.log(`Micro: ${micro.value}`); // 0.5067
   * console.log(`Mid: ${mid.value}`); // 0.51
   * ```
   */
  public getMicroprice(): Price | null {
    if (this.bids.length === 0 || this.asks.length === 0) {
      return null;
    }

    const bestBid = this.bids[0];
    const bestAsk = this.asks[0];

    const bidQty = bestBid.quantity.value;
    const askQty = bestAsk.quantity.value;

    if (bidQty + askQty === 0) {
      return null;
    }

    // microprice = (ask * bidQty + bid * askQty) / (bidQty + askQty)
    const microprice =
      (bestAsk.price.value * bidQty + bestBid.price.value * askQty) /
      (bidQty + askQty);

    return Price.fromNumber(microprice);
  }

  /**
   * Получает общий объём на стороне bid
   *
   * @param levels - Количество уровней для суммирования (по умолчанию все)
   * @returns Общий объём бидов
   *
   * @remarks
   * Суммирует объёмы всех bid уровней (или первых N уровней).
   * Используется для оценки покупательского давления.
   *
   * @example
   * ```typescript
   * const totalBidVolume = orderbook.getTotalBidVolume();
   * const top5BidVolume = orderbook.getTotalBidVolume(5);
   * console.log(`Total bid volume: ${totalBidVolume.value}`);
   * ```
   */
  public getTotalBidVolume(levels?: number): Quantity {
    const relevantBids = levels ? this.bids.slice(0, levels) : this.bids;

    const total = relevantBids.reduce(
      (sum, level) => sum + level.quantity.value,
      0
    );

    return Quantity.fromNumber(total, 0);
  }

  /**
   * Получает общий объём на стороне ask
   *
   * @param levels - Количество уровней для суммирования (по умолчанию все)
   * @returns Общий объём асков
   *
   * @remarks
   * Суммирует объёмы всех ask уровней (или первых N уровней).
   * Используется для оценки продавательского давления.
   *
   * @example
   * ```typescript
   * const totalAskVolume = orderbook.getTotalAskVolume();
   * const top5AskVolume = orderbook.getTotalAskVolume(5);
   * console.log(`Total ask volume: ${totalAskVolume.value}`);
   * ```
   */
  public getTotalAskVolume(levels?: number): Quantity {
    const relevantAsks = levels ? this.asks.slice(0, levels) : this.asks;

    const total = relevantAsks.reduce(
      (sum, level) => sum + level.quantity.value,
      0
    );

    return Quantity.fromNumber(total, 0);
  }

  /**
   * Вычисляет imbalance (дисбаланс объёмов)
   *
   * @param levels - Количество уровней для расчёта (по умолчанию 5)
   * @returns Imbalance от -1 до 1
   *
   * @remarks
   * Imbalance = (bidVolume - askVolume) / (bidVolume + askVolume)
   *
   * Интерпретация:
   * - Imbalance > 0: больше покупателей, цена может вырасти
   * - Imbalance < 0: больше продавцов, цена может упасть
   * - Imbalance ~0: баланс сторон
   *
   * Диапазон:
   * - +1.0: только bids, нет asks (сильное покупательское давление)
   * - -1.0: только asks, нет bids (сильное продавательское давление)
   * -  0.0: равные объёмы (баланс)
   *
   * @example
   * ```typescript
   * const imbalance = orderbook.getImbalance(5);
   * if (imbalance > 0.3) {
   *   console.log('Strong buying pressure');
   * } else if (imbalance < -0.3) {
   *   console.log('Strong selling pressure');
   * } else {
   *   console.log('Balanced market');
   * }
   * ```
   */
  public getImbalance(levels: number = 5): number {
    const bidVolume = this.getTotalBidVolume(levels).value;
    const askVolume = this.getTotalAskVolume(levels).value;

    if (bidVolume + askVolume === 0) {
      return 0;
    }

    return (bidVolume - askVolume) / (bidVolume + askVolume);
  }

  /**
   * Проверяет, пуст ли стакан
   *
   * @returns True если нет ни бидов, ни асков
   *
   * @example
   * ```typescript
   * if (orderbook.isEmpty()) {
   *   console.log('No liquidity available');
   * }
   * ```
   */
  public isEmpty(): boolean {
    return this.bids.length === 0 && this.asks.length === 0;
  }

  /**
   * Проверяет наличие ликвидности
   *
   * @returns True если есть хотя бы один bid и один ask
   *
   * @remarks
   * Orderbook с ликвидностью имеет как минимум один bid и один ask.
   * Используется для проверки возможности торговли.
   *
   * @example
   * ```typescript
   * if (orderbook.hasLiquidity()) {
   *   console.log('Can place orders');
   * } else {
   *   console.log('No liquidity - cannot trade');
   * }
   * ```
   */
  public hasLiquidity(): boolean {
    return this.bids.length > 0 && this.asks.length > 0;
  }

  /**
   * Получает количество уровней на bid стороне
   *
   * @returns Количество bid уровней
   *
   * @example
   * ```typescript
   * console.log(`Bid depth: ${orderbook.getBidDepth()} levels`);
   * ```
   */
  public getBidDepth(): number {
    return this.bids.length;
  }

  /**
   * Получает количество уровней на ask стороне
   *
   * @returns Количество ask уровней
   *
   * @example
   * ```typescript
   * console.log(`Ask depth: ${orderbook.getAskDepth()} levels`);
   * ```
   */
  public getAskDepth(): number {
    return this.asks.length;
  }

  /**
   * Получает возраст снимка стакана
   *
   * @returns Возраст в миллисекундах
   *
   * @remarks
   * Вычисляет разницу между текущим временем и timestamp.
   * Используется для проверки актуальности данных.
   *
   * @example
   * ```typescript
   * const ageMs = orderbook.getAgeMs();
   * if (ageMs > 5000) {
   *   console.log('Orderbook data is stale (>5s old)');
   * }
   * ```
   */
  public getAgeMs(): number {
    return Date.now() - this.timestamp.getTime();
  }

  /**
   * Проверяет, устарел ли стакан
   *
   * @param maxAgeMs - Максимальный возраст в мс (по умолчанию 5000)
   * @returns True если стакан старше maxAgeMs
   *
   * @example
   * ```typescript
   * if (orderbook.isStale(3000)) {
   *   console.log('Need to refresh orderbook');
   * }
   * ```
   */
  public isStale(maxAgeMs: number = 5000): boolean {
    return this.getAgeMs() > maxAgeMs;
  }

  /**
   * Конвертирует в строковое представление
   *
   * @returns Строковое представление стакана
   *
   * @example
   * ```typescript
   * console.log(orderbook.toString());
   * // "Orderbook[market-123]: 5 bids, 4 asks, spread 0.0100"
   * ```
   */
  public toString(): string {
    const spread = this.getSpread();
    const spreadStr = spread ? spread.width().toFixed(4) : 'N/A';
    return `Orderbook[${this.marketId}]: ${this.bids.length} bids, ${this.asks.length} asks, spread ${spreadStr}`;
  }

  /**
   * Конвертирует в объект
   *
   * @returns Объектное представление стакана
   *
   * @example
   * ```typescript
   * const obj = orderbook.toObject();
   * console.log(JSON.stringify(obj, null, 2));
   * ```
   */
  public toObject() {
    const bestBid = this.getBestBid();
    const bestAsk = this.getBestAsk();
    const midPrice = this.getMidPrice();
    const microprice = this.getMicroprice();
    const spread = this.getSpread();

    return {
      marketId: this.marketId,
      timestamp: this.timestamp.toISOString(),
      bestBid: bestBid?.value,
      bestAsk: bestAsk?.value,
      midPrice: midPrice?.value,
      microprice: microprice?.value,
      spreadWidth: spread?.width(),
      bidDepth: this.bids.length,
      askDepth: this.asks.length,
      totalBidVolume: this.getTotalBidVolume().value,
      totalAskVolume: this.getTotalAskVolume().value,
      imbalance: this.getImbalance(),
      ageMs: this.getAgeMs(),
    };
  }
}
