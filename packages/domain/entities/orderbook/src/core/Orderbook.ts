/**
 * Orderbook entity
 *
 * @remarks
 * Представляет стакан заявок (order book) с бидами и асками.
 * Предоставляет методы для анализа ликвидности, спреда и расчёта цен.
 *
 * ИСПРАВЛЕНИЯ от оригинала:
 * 1. Branded types: InstrumentId и AssetId вместо string
 * 2. Раздельные timestamps: venueTimestamp (от exchange) + receivedAt (локально)
 * 3. getSpread() возвращает Result вместо null (явный сигнал о crossed book)
 * 4. getTotalVolume убрал лишние проверки и throw
 * 5. isStale() использует receivedAt вместо Date.now()
 * 6. Использует нормализованные данные из OrderbookNormalizer
 *
 * @example
 * ```typescript
 * import { Orderbook } from './Orderbook';
 * import { OrderbookNormalizer } from '../normalizer/OrderbookNormalizer';
 *
 * const rawData: RawOrderbook = { / * ... * / };
 * const normalized = OrderbookNormalizer.normalize(rawData);
 *
 * if (normalized.ok) {
 *   const orderbook = Orderbook.fromNormalized(normalized.value);
 *   const spread = orderbook.getSpread();
 *
 *   if (spread.ok) {
 *     console.log(`Spread: ${spread.value.width()}`);
 *   } else if (OrderbookInvalidError.isOrderbookInvalidError(spread.error)) {
 *     if (spread.error.isCrossedBook()) {
 *       console.error('CRITICAL: Crossed book detected!');
 *     }
 *   }
 * }
 * ```
 */

import type { Price, Quantity, Spread } from '@polymarket/value-objects';
import type { InstrumentId } from '@polymarket/ids';
import type { AssetId } from '@polymarket/ids';
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import { OrderbookLevel } from './OrderbookLevel.js';
import { OrderbookInvalidError, OrderbookInvalidReason } from '../errors/OrderbookInvalidError.js';
import type { NormalizedOrderbook } from '../normalizer/OrderbookNormalizer.js';

/**
 * Параметры для создания Orderbook
 */
export interface OrderbookParams {
  readonly instrumentId: InstrumentId;
  readonly asset: AssetId;
  readonly bids: readonly OrderbookLevel[];
  readonly asks: readonly OrderbookLevel[];
  readonly venueTimestamp?: number; // unix timestamp ms (от exchange)
  readonly receivedAt: number; // unix timestamp ms (локально)
}

/**
 * Сущность Orderbook (Стакан заявок)
 *
 * @remarks
 * Неизменяемая сущность, представляющая стакан заявок рынка.
 * Каждый asset имеет свой orderbook.
 */
export class Orderbook {
  private constructor(
    /**
     * Идентификатор инструмента/рынка
     *
     * @remarks
     * Branded type вместо string для type safety.
     */
    public readonly instrumentId: InstrumentId,

    /**
     * Идентификатор asset/outcome token
     *
     * @remarks
     * Branded type вместо string для type safety.
     */
    public readonly asset: AssetId,

    /**
     * Массив bid уровней (отсортирован по убыванию цены)
     *
     * @remarks
     * Уже нормализован OrderbookNormalizer:
     * - Отсортирован descending
     * - Агрегирован (если policy)
     * - Без нулевых qty (если policy)
     */
    public readonly bids: readonly OrderbookLevel[],

    /**
     * Массив ask уровней (отсортирован по возрастанию цены)
     *
     * @remarks
     * Уже нормализован OrderbookNormalizer:
     * - Отсортирован ascending
     * - Агрегирован (если policy)
     * - Без нулевых qty (если policy)
     */
    public readonly asks: readonly OrderbookLevel[],

    /**
     * Timestamp от venue/exchange (если есть)
     *
     * @remarks
     * Unix timestamp в миллисекундах.
     * Когда exchange сгенерировал этот snapshot.
     * Может отсутствовать если venue не присылает timestamp.
     *
     * Используется для:
     * - Анализа latency (receivedAt - venueTimestamp)
     * - Определения skew часов
     */
    public readonly venueTimestamp: number | undefined,

    /**
     * Timestamp получения данных (локально)
     *
     * @remarks
     * Unix timestamp в миллисекундах.
     * Когда мы получили/создали этот orderbook.
     *
     * Используется для:
     * - Stale detection (Date.now() - receivedAt)
     * - Age calculation
     * - TTL проверок
     */
    public readonly receivedAt: number
  ) {
    Object.freeze(this);
  }

  /**
   * Создаёт Orderbook из нормализованных данных
   *
   * @param normalized - Данные из OrderbookNormalizer
   * @returns Orderbook
   *
   * @remarks
   * Основной способ создания Orderbook.
   * Данные уже прошли валидацию и нормализацию в OrderbookNormalizer.
   *
   * @example
   * ```typescript
   * const normalized = OrderbookNormalizer.normalize(rawData);
   * if (normalized.ok) {
   *   const orderbook = Orderbook.fromNormalized(normalized.value);
   * }
   * ```
   */
  public static fromNormalized(normalized: NormalizedOrderbook): Orderbook {
    return new Orderbook(
      normalized.marketId as InstrumentId,
      normalized.tokenId as AssetId,
      normalized.bids,
      normalized.asks,
      normalized.venueTimestamp,
      normalized.receivedAt
    );
  }

  /**
   * Создаёт пустой orderbook
   *
   * @param instrumentId - Идентификатор инструмента
   * @param asset - Идентификатор asset
   * @returns Пустой Orderbook
   *
   * @remarks
   * Используется когда нет данных стакана.
   * Все методы вернут null/empty.
   *
   * @example
   * ```typescript
   * const empty = Orderbook.empty(instrumentId, assetId);
   * console.log(empty.isEmpty()); // true
   * ```
   */
  public static empty(instrumentId: InstrumentId, asset: AssetId): Orderbook {
    return new Orderbook(
      instrumentId,
      asset,
      [],
      [],
      undefined,
      Date.now()
    );
  }

  // ==================== BEST BID/ASK ====================

  /**
   * Получает лучший bid (максимальная цена покупки)
   *
   * @returns Лучший bid price или null если нет бидов
   *
   * @remarks
   * Возвращает первый элемент отсортированного массива bids.
   * Это максимальная цена, которую покупатели готовы заплатить.
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
   */
  public getBestAsk(): Price | null {
    return this.asks.length > 0 ? this.asks[0].price : null;
  }

  // ==================== SPREAD ====================

  /**
   * Получает спред (bid-ask spread)
   *
   * @returns Result<Spread, OrderbookInvalidError>
   *
   * @remarks
   * ИСПРАВЛЕНИЕ: Возвращает Result вместо null.
   *
   * Спред = ask - bid
   * Узкий спред указывает на высокую ликвидность.
   * Широкий спред указывает на низкую ликвидность.
   *
   * Возвращает ошибку если:
   * - Нет bid или ask (EMPTY_BOOK / ONE_SIDED)
   * - Crossed book: bid >= ask (CROSSED_BOOK)
   *
   * Явный сигнал о проблемах вместо silent null.
   * Критично для trading систем.
   *
   * @example
   * ```typescript
   * const spreadResult = orderbook.getSpread();
   * if (spreadResult.ok) {
   *   console.log(`Spread: ${spreadResult.value.width()}`);
   * } else {
   *   if (spreadResult.error.isCrossedBook()) {
   *     console.error('CRITICAL: Crossed book!');
   *   } else {
   *     console.warn('No liquidity');
   *   }
   * }
   * ```
   */
  public getSpread(): Result<Spread, OrderbookInvalidError> {
    const bid = this.getBestBid();
    const ask = this.getBestAsk();

    // Empty book
    if (!bid && !ask) {
      return Err(
        new OrderbookInvalidError('Empty orderbook', {
          context: {
            reason: OrderbookInvalidReason.EMPTY_BOOK,
            marketId: this.instrumentId,
            tokenId: this.asset,
          },
        })
      );
    }

    // One-sided book
    if (!bid || !ask) {
      return Err(
        new OrderbookInvalidError('One-sided orderbook', {
          context: {
            reason: OrderbookInvalidReason.ONE_SIDED,
            marketId: this.instrumentId,
            tokenId: this.asset,
            bestBid: bid?.value,
            bestAsk: ask?.value,
          },
        })
      );
    }

    // Try to create Spread (может вернуть ошибку если crossed)
    const { Spread: SpreadVO } = require('@polymarket/value-objects');
    const spreadResult = SpreadVO.create(bid, ask);

    if (!spreadResult.ok) {
      // Spread.create не ok означает crossed book
      return Err(
        new OrderbookInvalidError('Crossed book detected in getSpread', {
          context: {
            reason: OrderbookInvalidReason.CROSSED_BOOK,
            marketId: this.instrumentId,
            tokenId: this.asset,
            bestBid: bid.value,
            bestAsk: ask.value,
          },
        })
      );
    }

    return Ok(spreadResult.value);
  }

  /**
   * Получает mid price (средняя цена)
   *
   * @returns Mid price или null если нет bid/ask
   *
   * @remarks
   * Mid price = (best bid + best ask) / 2
   * Не учитывает объёмы (в отличие от microprice).
   */
  public getMidPrice(): Price | null {
    const spreadResult = this.getSpread();
    return spreadResult.ok ? spreadResult.value.midpoint() : null;
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
   * Microprice точнее отражает истинную рыночную цену,
   * так как учитывает дисбаланс ликвидности.
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

    const { Price: PriceVO } = require('@polymarket/value-objects');
    const priceResult = PriceVO.fromValue(microprice);
    return priceResult.ok ? priceResult.value : null;
  }

  // ==================== VOLUME ====================

  /**
   * Получает общий объём на стороне bid
   *
   * @param levels - Количество уровней для суммирования (по умолчанию все)
   * @returns Общий объём бидов
   *
   * @remarks
   * ИСПРАВЛЕНИЕ: Убрал лишнюю проверку `if (total === 0)` и throw.
   *
   * Quantity.fromValue(0) валиден, не нужна особая обработка.
   * Если сумма не валидна - это баг в Quantity, не наша проблема здесь.
   */
  public getTotalBidVolume(levels?: number): Quantity {
    const relevantBids = levels ? this.bids.slice(0, levels) : this.bids;

    const total = relevantBids.reduce(
      (sum, level) => sum + level.quantity.value,
      0
    );

    const { Quantity: QuantityVO } = require('@polymarket/value-objects');
    const quantityResult = QuantityVO.fromValue(total);

    // Если Quantity.fromValue фейлится на валидной сумме - это баг в Quantity
    // Возвращаем zero как fallback
    return quantityResult.ok ? quantityResult.value : QuantityVO.zero();
  }

  /**
   * Получает общий объём на стороне ask
   *
   * @param levels - Количество уровней для суммирования (по умолчанию все)
   * @returns Общий объём асков
   *
   * @remarks
   * ИСПРАВЛЕНИЕ: Убрал лишнюю проверку `if (total === 0)` и throw.
   */
  public getTotalAskVolume(levels?: number): Quantity {
    const relevantAsks = levels ? this.asks.slice(0, levels) : this.asks;

    const total = relevantAsks.reduce(
      (sum, level) => sum + level.quantity.value,
      0
    );

    const { Quantity: QuantityVO } = require('@polymarket/value-objects');
    const quantityResult = QuantityVO.fromValue(total);

    return quantityResult.ok ? quantityResult.value : QuantityVO.zero();
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
   * - Imbalance > 0: больше покупателей
   * - Imbalance < 0: больше продавцов
   * - Imbalance ~0: баланс сторон
   */
  public getImbalance(levels: number = 5): number {
    const bidVolume = this.getTotalBidVolume(levels).value;
    const askVolume = this.getTotalAskVolume(levels).value;

    if (bidVolume + askVolume === 0) {
      return 0;
    }

    return (bidVolume - askVolume) / (bidVolume + askVolume);
  }

  // ==================== STATUS ====================

  /**
   * Проверяет, пуст ли стакан
   *
   * @returns True если нет ни бидов, ни асков
   */
  public isEmpty(): boolean {
    return this.bids.length === 0 && this.asks.length === 0;
  }

  /**
   * Проверяет наличие ликвидности
   *
   * @returns True если есть хотя бы один bid и один ask
   */
  public hasLiquidity(): boolean {
    return this.bids.length > 0 && this.asks.length > 0;
  }

  /**
   * Получает количество уровней на bid стороне
   *
   * @returns Количество bid уровней
   */
  public getBidDepth(): number {
    return this.bids.length;
  }

  /**
   * Получает количество уровней на ask стороне
   *
   * @returns Количество ask уровней
   */
  public getAskDepth(): number {
    return this.asks.length;
  }

  // ==================== TIME/AGE ====================

  /**
   * Получает возраст снимка стакана (от receivedAt)
   *
   * @returns Возраст в миллисекундах
   *
   * @remarks
   * ИСПРАВЛЕНИЕ: Использует receivedAt вместо venue timestamp.
   *
   * Вычисляет разницу между текущим временем и receivedAt (локальный timestamp).
   * Используется для проверки актуальности данных.
   *
   * НЕ использует venueTimestamp, так как:
   * - Venue часы могут быть рассинхронизированы
   * - Latency уже учтена в receivedAt
   */
  public getAgeMs(): number {
    return Date.now() - this.receivedAt;
  }

  /**
   * Получает latency (если есть venueTimestamp)
   *
   * @returns Latency в миллисекундах или null если нет venueTimestamp
   *
   * @remarks
   * Latency = receivedAt - venueTimestamp
   *
   * Показывает сколько времени заняла доставка данных от venue.
   * Может быть отрицательным если часы рассинхронизированы.
   */
  public getLatencyMs(): number | null {
    return this.venueTimestamp !== undefined
      ? this.receivedAt - this.venueTimestamp
      : null;
  }

  /**
   * Проверяет, устарел ли стакан
   *
   * @param maxAgeMs - Максимальный возраст в мс (по умолчанию 5000)
   * @returns True если стакан старше maxAgeMs
   *
   * @remarks
   * ИСПРАВЛЕНИЕ: Использует receivedAt (локально) вместо venue timestamp.
   *
   * Stale detection по локальному времени получения данных,
   * а не по времени venue (которое может быть некорректным).
   */
  public isStale(maxAgeMs: number = 5000): boolean {
    return this.getAgeMs() > maxAgeMs;
  }

  // ==================== SERIALIZATION ====================

  /**
   * Конвертирует в строковое представление
   *
   * @returns Строковое представление стакана
   */
  public toString(): string {
    const spreadResult = this.getSpread();
    const spreadStr = spreadResult.ok
      ? spreadResult.value.width().toFixed(4)
      : 'N/A';
    return `Orderbook[${this.instrumentId}:${this.asset}]: ${this.bids.length} bids, ${this.asks.length} asks, spread ${spreadStr}`;
  }

  /**
   * Конвертирует в объект (summary view)
   *
   * @returns Объектное представление стакана с метриками
   *
   * @remarks
   * Возвращает сводные метрики без полных данных уровней.
   * Для полного представления используйте toJSON().
   */
  public toObject() {
    const bestBid = this.getBestBid();
    const bestAsk = this.getBestAsk();
    const midPrice = this.getMidPrice();
    const microprice = this.getMicroprice();
    const spreadResult = this.getSpread();

    return {
      instrumentId: this.instrumentId,
      asset: this.asset,
      venueTimestamp: this.venueTimestamp,
      receivedAt: this.receivedAt,
      bestBid: bestBid?.value,
      bestAsk: bestAsk?.value,
      midPrice: midPrice?.value,
      microprice: microprice?.value,
      spreadWidth: spreadResult.ok ? spreadResult.value.width() : undefined,
      spreadStatus: spreadResult.ok ? 'ok' : spreadResult.error.getReason(),
      bidDepth: this.bids.length,
      askDepth: this.asks.length,
      totalBidVolume: this.getTotalBidVolume().value,
      totalAskVolume: this.getTotalAskVolume().value,
      imbalance: this.getImbalance(),
      ageMs: this.getAgeMs(),
      latencyMs: this.getLatencyMs(),
    };
  }
}
