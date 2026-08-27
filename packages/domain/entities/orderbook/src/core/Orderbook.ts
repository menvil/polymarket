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
 * 3. Ценовые метрики (mid/микроцена/спред) вынесены в `bookPricing`
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

import type { DecimalPrice, OutcomePrice } from '@polymarket/value-objects';
import { Quantity, QuantityService } from '@polymarket/value-objects';
import { Timestamp } from '@polymarket/timestamp';
import type { InstrumentId, MarketId, VenueId } from '@polymarket/ids';
import { asMarketId } from '@polymarket/ids';
import type { IClock } from '@polymarket/time';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- внутренняя Decimal-арифметика/парсинг границы после VO-типизированного публичного API, см. docs/architecture/boundary-contract.md, Решение 1
import Decimal from 'decimal.js';
import { OrderbookLevel } from './OrderbookLevel.js';
import type { NormalizedOrderbook } from '../normalizer/OrderbookNormalizer.js';

/**
 * Параметры для создания Orderbook
 */
export interface OrderbookParams<TPrice extends DecimalPrice = OutcomePrice> {
  /** Площадка, где живёт этот стакан. */
  readonly venueId: VenueId;
  /**
   * Рынок, если у площадки он существует отдельно от инструмента.
   *
   * @remarks
   * Есть у рынков предсказаний (`condition_id`) и отсутствует у бирж: на
   * Binance «рынок BTC/USDT» и «инструмент BTC/USDT» — одно и то же, и
   * дублировать символ ради заполненности поля значило бы выдумывать
   * сущность, которой на площадке нет.
   */
  readonly marketId?: MarketId;
  /** Торгуемый инструмент: outcome-токен либо символ пары (`BTC/USDT`). */
  readonly instrumentId: InstrumentId;
  readonly bids: readonly OrderbookLevel<TPrice>[];
  readonly asks: readonly OrderbookLevel<TPrice>[];
  /** Timestamp от venue/exchange (если есть). */
  readonly venueTimestamp?: Timestamp;
  /** Timestamp получения данных (локально). */
  readonly receivedAt: Timestamp;
  /** Источник времени для `getAgeMs()`/`isStale()` без явного `nowMs`. */
  readonly clock?: IClock;
}

/**
 * Сущность Orderbook (Стакан заявок)
 *
 * @remarks
 * Неизменяемая сущность, представляющая стакан заявок рынка.
 * Каждый asset имеет свой orderbook.
 */
export class Orderbook<TPrice extends DecimalPrice = OutcomePrice> {
  private constructor(
    /**
     * Площадка, где живёт этот стакан.
     *
     * @remarks
     * Без неё книги `BTC/USDT` на binance и на coinbase неразличимы —
     * а это разные книги с разными ценами.
     */
    public readonly venueId: VenueId,

    /**
     * Рынок, если у площадки он существует отдельно от инструмента.
     *
     * @remarks
     * `condition_id` у рынка предсказаний; `undefined` у биржи, где рынок
     * и инструмент — одно и то же.
     */
    public readonly marketId: MarketId | undefined,

    /**
     * Торгуемый инструмент.
     *
     * @remarks
     * Outcome-токен у рынка предсказаний, символ пары (`BTC/USDT`) у биржи.
     * Поле называется так же, как то, что несёт: до foundation-изменения
     * `instrumentId` содержал marketId, из-за чего по коду жили приведения
     * `marketId as unknown as InstrumentId`.
     */
    public readonly instrumentId: InstrumentId,

    /**
     * Массив bid уровней (отсортирован по убыванию цены)
     */
    public readonly bids: readonly OrderbookLevel<TPrice>[],

    /**
     * Массив ask уровней (отсортирован по возрастанию цены)
     */
    public readonly asks: readonly OrderbookLevel<TPrice>[],

    /**
     * Timestamp от venue/exchange (если есть)
     *
     * @remarks
     * Когда exchange сгенерировал этот snapshot. Используется для анализа
     * latency (`receivedAt - venueTimestamp`) и определения skew часов.
     */
    public readonly venueTimestamp: Timestamp | undefined,

    /**
     * Timestamp получения данных (локально)
     *
     * @remarks
     * Используется для stale detection, age calculation и TTL-проверок.
     */
    public readonly receivedAt: Timestamp,

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
  public static fromNormalized(
    normalized: NormalizedOrderbook,
    venueId: VenueId,
    clock?: IClock,
  ): Orderbook<OutcomePrice> {
    return new Orderbook(
      venueId,
      asMarketId(normalized.marketId),
      normalized.tokenId as InstrumentId,
      normalized.bids,
      normalized.asks,
      normalized.venueTimestamp,
      normalized.receivedAt,
      clock,
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
  public static empty<T extends DecimalPrice = OutcomePrice>(
    venueId: VenueId,
    instrumentId: InstrumentId,
    marketId?: MarketId,
    clock?: IClock,
  ): Orderbook<T> {
    return new Orderbook(venueId, marketId, instrumentId, [], [], undefined, Timestamp.now(), clock);
  }

  /**
   * Создаёт Orderbook напрямую из уже распарсенных уровней, минуя `OrderbookNormalizer`.
   *
   * @param instrumentId - Идентификатор инструмента/рынка
   * @param asset - Идентификатор asset/outcome token
   * @param bids - Уровни покупки (`OrderbookLevel[]`, в любом порядке — сортируются внутри)
   * @param asks - Уровни продажи (`OrderbookLevel[]`, в любом порядке — сортируются внутри)
   * @param receivedAt - Timestamp получения данных (локально) — обязателен, используется
   *   для `getAgeMs()`/`isStale()` и как ключ ретеншна при истории через `RollingWindow<Orderbook>`
   * @param venueTimestamp - Timestamp от venue/exchange (опционально)
   * @param clock - Источник времени для `getAgeMs()`/`isStale()` без явного `nowMs`
   * @returns Новый `Orderbook`
   *
   * @remarks
   * Для сценария "уже есть готовые `OrderbookLevel[]`" (например, смаппленные из другого
   * представления стакана) — `OrderbookNormalizer` рассчитан на сырые непроверенные данные
   * (парсинг цен/quantity из строк, детекция crossed book), другой сценарий.
   *
   * `fromLevels` — plain return, как `fromNormalized`/`empty` (симметрично: приватный
   * конструктор класса вообще не валидирует, вся валидация либо предшествует вызову
   * факторики (`OrderbookNormalizer`), либо доступна post-hoc через `bookPricing`).
   * Единственная защита здесь — **сортировка** `bids`/`asks` внутри метода (bids по
   * убыванию цены, asks по возрастанию — тем же компаратором, что и
   * `OrderbookNormalizer.sortLevels()`): класс нигде не сортирует уровни сам
   * (`getBestBid()`/`getBestAsk()` берут `bids[0]`/`asks[0]` на веру), поэтому без
   * сортировки здесь вызывающий код с неупорядоченным входом получил бы молча неверные
   * `getBestBid()`/`toObject()` без единого сигнала об ошибке — хуже,
   * чем crossed book (тот хотя бы ловится `bookPricing.spread()`).
   *
   * @example
   * ```typescript
   * const orderbook = Orderbook.fromLevels(
   *   instrumentId,
   *   asset,
   *   [OrderbookLevel.create(price1, qty1), OrderbookLevel.create(price2, qty2)],
   *   [OrderbookLevel.create(price3, qty3)],
   *   Timestamp.now(clock),
   * );
   * ```
   */
  public static fromLevels<T extends DecimalPrice = OutcomePrice>(
    params: OrderbookParams<T>,
  ): Orderbook<T> {
    // Сортировка выполняется ЗДЕСЬ: класс нигде не сортирует уровни сам
    // (`getBestBid()` берёт `bids[0]` на веру), поэтому неупорядоченный вход
    // дал бы молча неверную верхушку без единого сигнала об ошибке
    const sortedBids = [...params.bids].sort((a, b) =>
      b.price.value().comparedTo(a.price.value()),
    );
    const sortedAsks = [...params.asks].sort((a, b) =>
      a.price.value().comparedTo(b.price.value()),
    );

    return new Orderbook(
      params.venueId,
      params.marketId,
      params.instrumentId,
      sortedBids,
      sortedAsks,
      params.venueTimestamp,
      params.receivedAt,
      params.clock,
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
  public getBestBid(): TPrice | null {
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
  public getBestAsk(): TPrice | null {
    return this.asks.length > 0 ? this.asks[0].price : null;
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
    const bestBid = this.getBestBid();
    const bestAsk = this.getBestAsk();
    // Ширина спреда здесь НЕ считается: это создание нового значения, для
    // которого нужна фабрика домена (см. `bookPricing`). Строковое
    // представление структуры обходится выбранными уровнями.
    const top =
      bestBid !== null && bestAsk !== null
        ? `${bestBid.value().toFixed(4)}/${bestAsk.value().toFixed(4)}`
        : 'N/A';
    return `Orderbook[${this.venueId}:${this.marketId ?? '-'}:${this.instrumentId}]: ${this.bids.length} bids, ${this.asks.length} asks, top ${top}`;
  }

  /**
   * Конвертирует в объект (summary view)
   *
   * @returns Объектное представление структуры стакана
   *
   * @remarks
   * Только СТРУКТУРНАЯ сводка: идентичность, времена, выбранные лучшие
   * уровни, глубина и объёмы. Производные ЦЕНЫ (mid, микроцена, ширина
   * спреда) сюда не входят — их вычисление требует знания ценового домена
   * и живёт в `bookPricing`. Для полного представления уровней используйте
   * `OrderbookSerializer.toJSON()`.
   */
  public toObject() {
    const bestBid = this.getBestBid();
    const bestAsk = this.getBestAsk();

    return {
      venueId: this.venueId,
      marketId: this.marketId,
      instrumentId: this.instrumentId,
      venueTimestamp: this.venueTimestamp?.toNumber(),
      receivedAt: this.receivedAt.toNumber(),
      bestBid: bestBid?.value().toNumber(),
      bestAsk: bestAsk?.value().toNumber(),
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
