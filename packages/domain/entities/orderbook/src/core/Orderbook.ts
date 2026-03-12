/**
 * Orderbook entity
 *
 * @remarks
 * Представляет стакан заявок (order book) с бидами и асками.
 * Предоставляет методы для анализа ликвидности, спреда и расчёта цен.
 *
 * ИСПРАВЛЕНИЯ от оригинала:
 * 1. Branded types: InstrumentId вместо string (и для marketId, и для tokenId)
 * 2. Timestamp VO вместо number для venueTimestamp и receivedAt
 * 3. getSpread() возвращает Result вместо null (явный сигнал о crossed book)
 * 4. getTotalVolume убрал require() и использует Decimal-арифметику
 * 5. isStale() использует receivedAt вместо Date.now()
 * 6. Использует нормализованные данные из OrderbookNormalizer
 * 7. Все импорты статические (ESM-совместимость)
 *
 * @example
 * ```typescript
 * import { Orderbook } from './Orderbook.js';
 * import { OrderbookNormalizer } from '../normalizer/OrderbookNormalizer.js';
 * import type { RawOrderbook } from '../normalizer/types.js';
 *
 * const rawData: RawOrderbook = { marketId: '...', tokenId: '...', bids: [], asks: [] };
 * const normalized = OrderbookNormalizer.normalize(rawData);
 *
 * if (normalized.ok) {
 *   const orderbook = Orderbook.fromNormalized(normalized.value);
 *   const spread = orderbook.getSpread();
 *
 *   if (spread.ok) {
 *     console.log(`Spread: ${spread.value.width().toFixed(4)}`);
 *   } else if (spread.error.isCrossedBook()) {
 *     console.error('CRITICAL: Crossed book detected!');
 *   }
 * }
 * ```
 */

import type { Price, Spread } from '@polymarket/value-objects';
import { PriceService, Quantity, QuantityService, SpreadService, Timestamp } from '@polymarket/value-objects';
import type { InstrumentId } from '@polymarket/ids';
import type { IClock } from '@polymarket/time';
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import Decimal from 'decimal.js';
import { OrderbookLevel } from './OrderbookLevel.js';
import { OrderbookInvalidError, OrderbookInvalidReason } from '@polymarket/errors/orderbook';
import type { NormalizedOrderbook } from '../normalizer/OrderbookNormalizer.js';

/**
 * Параметры для создания Orderbook
 */
export interface OrderbookParams {
  readonly instrumentId: InstrumentId;
  readonly asset: InstrumentId;
  readonly bids: readonly OrderbookLevel[];
  readonly asks: readonly OrderbookLevel[];
  readonly venueTimestamp?: Timestamp; // Timestamp VO (от exchange)
  readonly receivedAt: Timestamp; // Timestamp VO (локально)
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
    public readonly asset: InstrumentId,

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
     * Timestamp VO (миллисекунды).
     * Когда exchange сгенерировал этот snapshot.
     * Может отсутствовать если venue не присылает timestamp.
     *
     * Используется для:
     * - Анализа latency (receivedAt - venueTimestamp)
     * - Определения skew часов
     */
    public readonly venueTimestamp: Timestamp | undefined,

    /**
     * Timestamp получения данных (локально)
     *
     * @remarks
     * Timestamp VO (миллисекунды).
     * Когда мы получили/создали этот orderbook.
     *
     * Используется для:
     * - Stale detection (receivedAt.toNumber() vs nowMs)
     * - Age calculation
     * - TTL проверок
     */
    public readonly receivedAt: Timestamp,

    /**
     * Опциональный источник времени для детерминированной работы getAgeMs() и isStale().
     *
     * @remarks
     * Если задан — getAgeMs()/isStale() без явного nowMs используют clock.now().getTime()
     * вместо Date.now(). Обратная совместимость сохраняется через явный nowMs.
     */
    private readonly _clock?: IClock
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
   * Конвертирует числовые timestamps из NormalizedOrderbook в Timestamp VO.
   *
   * @example
   * ```typescript
   * const normalized = OrderbookNormalizer.normalize(rawData);
   * if (normalized.ok) {
   *   const orderbook = Orderbook.fromNormalized(normalized.value);
   * }
   * ```
   */
  public static fromNormalized(normalized: NormalizedOrderbook, clock?: IClock): Orderbook {
    // NormalizedOrderbook уже содержит Timestamp VO — конвертация не нужна
    return new Orderbook(
      normalized.marketId as InstrumentId,
      normalized.tokenId as InstrumentId,
      normalized.bids,
      normalized.asks,
      normalized.venueTimestamp,
      normalized.receivedAt,
      clock
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
  public static empty(instrumentId: InstrumentId, asset: InstrumentId, clock?: IClock): Orderbook {
    return new Orderbook(
      instrumentId,
      asset,
      [],
      [],
      undefined,
      Timestamp.now(),
      clock
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
   * - Crossed book: bid > ask (CROSSED_BOOK)
   *
   * Явный сигнал о проблемах вместо silent null.
   * Критично для trading систем.
   *
   * ### Асимметрия правил crossed book:
   * `getSpread()` допускает `bid == ask` (нулевой спред) — это валидный нормальный случай.
   * `OrderbookNormalizer` с `allowCrossed: false` строже: отвергает `bid >= ask`,
   * т.е. нулевой спред уже отфильтрован на входе перед созданием `Orderbook`.
   *
   * @example
   * ```typescript
   * const spreadResult = orderbook.getSpread();
   * if (spreadResult.ok) {
   *   console.log(`Spread: ${spreadResult.value.width().toFixed(4)}`);
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
            bestBid: bid?.value().toNumber(),
            bestAsk: ask?.value().toNumber(),
          },
        })
      );
    }

    // SpreadService.create() возвращает Result<Spread, InvalidSpreadError>
    const spreadResult = SpreadService.create(bid, ask);

    if (!spreadResult.ok) {
      // Spread.create не ok означает crossed book
      return Err(
        new OrderbookInvalidError('Crossed book detected in getSpread', {
          context: {
            reason: OrderbookInvalidReason.CROSSED_BOOK,
            marketId: this.instrumentId,
            tokenId: this.asset,
            bestBid: bid.value().toNumber(),
            bestAsk: ask.value().toNumber(),
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
    if (!spreadResult.ok) return null;
    const midDecimal = spreadResult.value.midpoint();
    const priceResult = PriceService.create(midDecimal);
    return priceResult.ok ? priceResult.value : null;
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

    const bidQty = bestBid.quantity.value();
    const askQty = bestAsk.quantity.value();
    const totalQty = bidQty.plus(askQty);

    if (totalQty.isZero()) {
      return null;
    }

    // microprice = (ask * bidQty + bid * askQty) / (bidQty + askQty)
    const micropriceDecimal = bestAsk.price.value().times(bidQty)
      .plus(bestBid.price.value().times(askQty))
      .dividedBy(totalQty);

    const priceResult = PriceService.create(micropriceDecimal);
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
   * ИСПРАВЛЕНИЕ: Использует Decimal-арифметику вместо number.
   *
   * Quantity.of(0) валиден, не нужна особая обработка.
   */
  public getTotalBidVolume(levels?: number): Quantity {
    const relevantBids = levels !== undefined ? this.bids.slice(0, levels) : this.bids;

    const total = relevantBids.reduce(
      (sum, level) => sum.plus(level.quantity.value()),
      new Decimal(0)
    );

    const quantityResult = QuantityService.create(total);
    return quantityResult.ok ? quantityResult.value : Quantity.ZERO;
  }

  /**
   * Получает общий объём на стороне ask
   *
   * @param levels - Количество уровней для суммирования (по умолчанию все)
   * @returns Общий объём асков
   *
   * @remarks
   * ИСПРАВЛЕНИЕ: Использует Decimal-арифметику вместо number.
   */
  public getTotalAskVolume(levels?: number): Quantity {
    const relevantAsks = levels !== undefined ? this.asks.slice(0, levels) : this.asks;

    const total = relevantAsks.reduce(
      (sum, level) => sum.plus(level.quantity.value()),
      new Decimal(0)
    );

    const quantityResult = QuantityService.create(total);
    return quantityResult.ok ? quantityResult.value : Quantity.ZERO;
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
    const bidVolume = this.getTotalBidVolume(levels).value();
    const askVolume = this.getTotalAskVolume(levels).value();
    const totalVolume = bidVolume.plus(askVolume);

    if (totalVolume.isZero()) {
      return 0;
    }

    return bidVolume.minus(askVolume).dividedBy(totalVolume).toNumber();
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
   * ИСПРАВЛЕНИЕ: Использует receivedAt (Timestamp VO) вместо venue timestamp.
   *
   * Вычисляет разницу между текущим временем и receivedAt (локальный timestamp).
   * Используется для проверки актуальности данных.
   *
   * НЕ использует venueTimestamp, так как:
   * - Venue часы могут быть рассинхронизированы
   * - Latency уже учтена в receivedAt
   *
   * @param nowMs - Текущее время в мс (по умолчанию Date.now()). Передавайте clock.now().toNumber() для бэктеста.
   */
  public getAgeMs(nowMs?: number): number {
    return (nowMs ?? this._clock?.now().getTime() ?? Date.now()) - this.receivedAt.toNumber();
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
      ? this.receivedAt.toNumber() - this.venueTimestamp.toNumber()
      : null;
  }

  /**
   * Проверяет, устарел ли стакан
   *
   * @param maxAgeMs - Максимальный возраст в мс (по умолчанию 5000)
   * @param nowMs - Текущее время в мс (по умолчанию Date.now()). Передавайте clock.now().toNumber() для бэктеста.
   * @returns True если стакан старше maxAgeMs
   *
   * @remarks
   * ИСПРАВЛЕНИЕ: Использует receivedAt (Timestamp VO) вместо venue timestamp.
   *
   * Stale detection по локальному времени получения данных,
   * а не по времени venue (которое может быть некорректным).
   */
  public isStale(maxAgeMs: number = 5000, nowMs?: number): boolean {
    return this.getAgeMs(nowMs) > maxAgeMs;
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
   * Для полного представления используйте OrderbookSerializer.toJSON().
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
      venueTimestamp: this.venueTimestamp?.toNumber(),
      receivedAt: this.receivedAt.toNumber(),
      bestBid: bestBid?.value().toNumber(),
      bestAsk: bestAsk?.value().toNumber(),
      midPrice: midPrice?.value().toNumber(),
      microprice: microprice?.value().toNumber(),
      spreadWidth: spreadResult.ok ? spreadResult.value.width().toNumber() : undefined,
      spreadStatus: spreadResult.ok ? 'ok' : spreadResult.error.getReason(),
      bidDepth: this.bids.length,
      askDepth: this.asks.length,
      totalBidVolume: this.getTotalBidVolume().value().toNumber(),
      totalAskVolume: this.getTotalAskVolume().value().toNumber(),
      imbalance: this.getImbalance(),
      ageMs: this.getAgeMs(),
      latencyMs: this.getLatencyMs(),
    };
  }
}
