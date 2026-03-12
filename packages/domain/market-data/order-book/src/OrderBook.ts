/**
 * Стакан ордеров (Order Book)
 *
 * @remarks
 * Мутабельный класс, представляющий текущее состояние стакана ордеров.
 * Хранит bid и ask уровни, отсортированные по цене.
 *
 * ### Алгоритм:
 * - Bids: отсортированы по убыванию цены (best bid = первый)
 * - Asks: отсортированы по возрастанию цены (best ask = первый)
 * - applyDelta(): size.isZero() → удалить уровень; size.isNegative() → игнорировать
 * - getImbalance(): (bidSize - askSize) / (bidSize + askSize), 0 если пусто
 *
 * ### Почему mutable:
 * Order book может обновляться тысячи раз в секунду.
 * Иммутабельность привела бы к огромному давлению на GC.
 * Снапшот (toSnapshot()) всегда доступен для immutable копии.
 *
 * ### Внутреннее хранение:
 * Map<string, PriceLevel> — ключ это price.value().toString() для
 * точного Decimal-сравнения без float precision issues.
 */

import Decimal from 'decimal.js';
import { addDecimal, subtractDecimal, divideDecimal, averageDecimal, isZeroDecimal } from '@polymarket/math';
import type { MarketId } from '@polymarket/ids';
import type { Timestamp } from '@polymarket/value-objects';
import type { PriceLevel } from './PriceLevel.js';
import type { OrderBookDelta } from './OrderBookDelta.js';

/**
 * Снапшот стакана ордеров для сериализации
 *
 * @remarks
 * Использует Price/Quantity VO как и PriceLevel.
 * Для JSON-сериализации используйте `.value().toString()` на каждом поле.
 */
export interface OrderBookSnapshot {
  /** ID рынка */
  readonly marketId: string;
  /** ID токена */
  readonly tokenId: string;
  /** Уровни покупки (Price/Quantity VO) */
  readonly bids: PriceLevel[];
  /** Уровни продажи (Price/Quantity VO) */
  readonly asks: PriceLevel[];
  /** Timestamp последнего обновления стакана (опционально — undefined до первого applyFullState) */
  readonly timestamp: Timestamp | undefined;
}

/**
 * Мутабельный стакан ордеров
 *
 * @remarks
 * Использует Price и Quantity VO для type safety и точной арифметики.
 * Внутренний Map использует string ключи (price.value().toString())
 * для точного Decimal-сравнения без float precision issues.
 *
 * @example
 * ```typescript
 * import { PriceService, QuantityService } from '@polymarket/value-objects';
 *
 * const book = OrderBook.create('market-abc', 'token-yes');
 * const bid = PriceService.create('0.65').value!;
 * const bidSize = QuantityService.create('1000').value!;
 * const ask = PriceService.create('0.66').value!;
 * const askSize = QuantityService.create('800').value!;
 *
 * book.applyFullState(
 *   [{ price: bid, size: bidSize }],
 *   [{ price: ask, size: askSize }]
 * );
 * console.log(book.getBestBid()?.price.value().toString()); // '0.65'
 * console.log(book.getImbalance().toNumber()); // ≈ 0.111
 * ```
 */
export class OrderBook {
  public readonly marketId: MarketId;
  public readonly tokenId: string;

  /**
   * Map<priceStr, PriceLevel> для bids
   * Ключ = price.value().toString() для точного Decimal-сравнения
   */
  private _bids: Map<string, PriceLevel>;

  /**
   * Map<priceStr, PriceLevel> для asks
   * Ключ = price.value().toString() для точного Decimal-сравнения
   */
  private _asks: Map<string, PriceLevel>;

  /**
   * Timestamp последнего вызова applyFullState.
   * Используется в toSnapshot() без аргументов.
   */
  private _lastUpdatedAt: Timestamp | undefined = undefined;

  /**
   * Приватный конструктор — используйте OrderBook.create()
   */
  private constructor(marketId: MarketId, tokenId: string) {
    this.marketId = marketId;
    this.tokenId = tokenId;
    this._bids = new Map();
    this._asks = new Map();
  }

  /**
   * Создаёт новый пустой стакан ордеров
   *
   * @param marketId - ID рынка
   * @param tokenId - ID токена
   * @returns Новый пустой OrderBook
   *
   * @example
   * ```typescript
   * const book = OrderBook.create('market-abc', 'token-yes');
   * ```
   */
  public static create(marketId: MarketId, tokenId: string): OrderBook {
    return new OrderBook(marketId, tokenId);
  }

  /**
   * Применяет дельту к стакану
   *
   * @param delta - Изменения уровней bid и ask
   *
   * @remarks
   * Семантика:
   * - size > 0: обновить/добавить уровень
   * - size === 0: удалить уровень
   * - size < 0: игнорировать (защитная семантика от некорректных данных)
   *
   * @example
   * ```typescript
   * book.applyDelta({
   *   bids: [{ price: bidPrice, size: newSize }],
   *   asks: [{ price: askPrice, size: zeroQty }], // удалить ask
   * });
   * ```
   */
  public applyDelta(delta: OrderBookDelta): void {
    for (const level of delta.bids) {
      this._applyLevel(this._bids, level);
    }
    for (const level of delta.asks) {
      this._applyLevel(this._asks, level);
    }
  }

  /**
   * Полностью заменяет стакан новым состоянием
   *
   * @param bids - Уровни покупки
   * @param asks - Уровни продажи
   * @param timestamp - Timestamp снапшота из WS (опционально)
   *
   * @remarks
   * Используется при получении полного снапшота стакана от биржи.
   * Полностью заменяет текущее состояние.
   * Уровни с size <= 0 игнорируются.
   * Если передан `timestamp` — сохраняется как `_lastUpdatedAt` и доступен через `toSnapshot()`.
   * Если `timestamp` не передан — `_lastUpdatedAt` остаётся прежним (намеренное поведение:
   * при backtest-воспроизведении события могут не иметь timestamp и сохраняют последний известный).
   *
   * @example
   * ```typescript
   * book.applyFullState(
   *   [{ price: bid, size: bidSize }],
   *   [{ price: ask, size: askSize }],
   *   timestamp,
   * );
   * ```
   */
  public applyFullState(bids: readonly PriceLevel[], asks: readonly PriceLevel[], timestamp?: Timestamp): void {
    this._bids = new Map();
    this._asks = new Map();

    for (const level of bids) {
      if (level.size.value().gt(0)) {
        this._bids.set(level.price.value().toString(), level);
      }
    }
    for (const level of asks) {
      if (level.size.value().gt(0)) {
        this._asks.set(level.price.value().toString(), level);
      }
    }

    if (timestamp !== undefined) {
      this._lastUpdatedAt = timestamp;
    }
  }

  /**
   * Возвращает лучший bid (наибольшая цена покупки)
   *
   * @returns Лучший bid или undefined если стакан пустой
   *
   * @example
   * ```typescript
   * const bestBid = book.getBestBid();
   * if (bestBid) console.log(bestBid.price.value().toString()); // '0.65'
   * ```
   */
  public getBestBid(): PriceLevel | undefined {
    const sorted = this._getSortedBids();
    return sorted.length > 0 ? sorted[0] : undefined;
  }

  /**
   * Возвращает лучший ask (наименьшая цена продажи)
   *
   * @returns Лучший ask или undefined если стакан пустой
   *
   * @example
   * ```typescript
   * const bestAsk = book.getBestAsk();
   * if (bestAsk) console.log(bestAsk.price.value().toString()); // '0.66'
   * ```
   */
  public getBestAsk(): PriceLevel | undefined {
    const sorted = this._getSortedAsks();
    return sorted.length > 0 ? sorted[0] : undefined;
  }

  /**
   * Вычисляет среднюю цену (mid price)
   *
   * @returns (bestBid + bestAsk) / 2 или undefined если стакан пустой
   *
   * @example
   * ```typescript
   * const mid = book.getMidPrice(); // Decimal('0.655')
   * ```
   */
  public getMidPrice(): Decimal | undefined {
    const bid = this.getBestBid();
    const ask = this.getBestAsk();
    if (bid === undefined || ask === undefined) return undefined;
    return averageDecimal(bid.price.value(), ask.price.value());
  }

  /**
   * Вычисляет спред между лучшим ask и bid
   *
   * @returns bestAsk - bestBid или undefined если стакан пустой
   *
   * @example
   * ```typescript
   * const spread = book.getSpread(); // Decimal('0.01')
   * ```
   */
  public getSpread(): Decimal | undefined {
    const bid = this.getBestBid();
    const ask = this.getBestAsk();
    if (bid === undefined || ask === undefined) return undefined;
    return subtractDecimal(ask.price.value(), bid.price.value());
  }

  /**
   * Вычисляет дисбаланс стакана
   *
   * @param topLevels - Количество верхних уровней для подсчёта (по умолчанию все)
   * @returns (bidSize - askSize) / (bidSize + askSize), диапазон [-1, +1], 0 если пусто
   *
   * @remarks
   * Положительное значение → больше объёма на bid стороне (бычий сигнал).
   * Отрицательное значение → больше объёма на ask стороне (медвежий сигнал).
   * Возвращает Decimal(0) (не undefined) для удобства использования в стратегиях.
   *
   * @example
   * ```typescript
   * const imbalance = book.getImbalance(5); // топ 5 уровней
   * console.log(imbalance.toNumber()); // 0.304
   * ```
   */
  public getImbalance(topLevels?: number): Decimal {
    if (topLevels !== undefined && (!Number.isInteger(topLevels) || topLevels < 0)) {
      throw new RangeError(`OrderBook.getImbalance: topLevels must be a non-negative integer, got ${topLevels}`);
    }

    const bids = this._getSortedBids();
    const asks = this._getSortedAsks();

    const bidSlice = topLevels !== undefined ? bids.slice(0, topLevels) : bids;
    const askSlice = topLevels !== undefined ? asks.slice(0, topLevels) : asks;

    const bidSize = bidSlice.reduce((sum, l) => addDecimal(sum, l.size.value()), new Decimal(0));
    const askSize = askSlice.reduce((sum, l) => addDecimal(sum, l.size.value()), new Decimal(0));

    const total = addDecimal(bidSize, askSize);
    if (isZeroDecimal(total)) return new Decimal(0);

    return divideDecimal(subtractDecimal(bidSize, askSize), total);
  }

  /**
   * Возвращает уровни покупки, отсортированные по убыванию цены
   *
   * @param levels - Максимальное количество уровней (по умолчанию все)
   * @returns Отсортированные уровни bid
   *
   * @example
   * ```typescript
   * const top5Bids = book.getBids(5);
   * top5Bids.forEach(l => console.log(l.price.value().toString()));
   * ```
   */
  public getBids(levels?: number): readonly PriceLevel[] {
    if (levels !== undefined && (!Number.isInteger(levels) || levels < 0)) {
      throw new RangeError(`OrderBook.getBids: levels must be a non-negative integer, got ${levels}`);
    }
    const sorted = this._getSortedBids();
    return levels !== undefined ? sorted.slice(0, levels) : sorted;
  }

  /**
   * Возвращает уровни продажи, отсортированные по возрастанию цены
   *
   * @param levels - Максимальное количество уровней (по умолчанию все)
   * @returns Отсортированные уровни ask
   *
   * @example
   * ```typescript
   * const top5Asks = book.getAsks(5);
   * top5Asks.forEach(l => console.log(l.price.value().toString()));
   * ```
   */
  public getAsks(levels?: number): readonly PriceLevel[] {
    if (levels !== undefined && (!Number.isInteger(levels) || levels < 0)) {
      throw new RangeError(`OrderBook.getAsks: levels must be a non-negative integer, got ${levels}`);
    }
    const sorted = this._getSortedAsks();
    return levels !== undefined ? sorted.slice(0, levels) : sorted;
  }

  /**
   * Проверяет, пустой ли стакан
   *
   * @returns True если нет ни одного уровня ни на bid ни на ask стороне
   */
  public isEmpty(): boolean {
    return this._bids.size === 0 && this._asks.size === 0;
  }

  /**
   * Создаёт снапшот текущего состояния стакана
   *
   * @returns Снапшот стакана с Price/Quantity VO и timestamp последнего обновления
   *
   * @remarks
   * `timestamp` в снапшоте = `_lastUpdatedAt`, устанавливаемый в `applyFullState()`.
   * Для JSON-сериализации конвертируйте Price/Quantity через `.value().toString()`.
   *
   * @example
   * ```typescript
   * const snapshot = book.toSnapshot();
   * // Для JSON:
   * const json = {
   *   bids: snapshot.bids.map(l => ({
   *     price: l.price.value().toString(),
   *     size: l.size.value().toString(),
   *   })),
   * };
   * ```
   */
  public toSnapshot(): OrderBookSnapshot {
    return {
      marketId: this.marketId,
      tokenId: this.tokenId,
      bids: this._getSortedBids(),
      asks: this._getSortedAsks(),
      timestamp: this._lastUpdatedAt,
    };
  }

  // ==================== Вспомогательные методы ====================

  /**
   * Применяет один ценовой уровень к карте
   *
   * @remarks
   * Ключ карты = price.value().toString() для точного Decimal-сравнения.
   * size < 0 → игнорировать; size === 0 → удалить; иначе → обновить/добавить.
   */
  private _applyLevel(map: Map<string, PriceLevel>, level: PriceLevel): void {
    const sizeDecimal = level.size.value();
    if (sizeDecimal.isNegative()) return; // игнорируем некорректные данные
    const key = level.price.value().toString();
    if (sizeDecimal.isZero()) {
      map.delete(key);
    } else {
      map.set(key, level);
    }
  }

  /**
   * Возвращает bids отсортированные по убыванию цены (лучший bid первый)
   */
  private _getSortedBids(): PriceLevel[] {
    return Array.from(this._bids.values())
      .sort((a, b) => b.price.value().comparedTo(a.price.value()));
  }

  /**
   * Возвращает asks отсортированные по возрастанию цены (лучший ask первый)
   */
  private _getSortedAsks(): PriceLevel[] {
    return Array.from(this._asks.values())
      .sort((a, b) => a.price.value().comparedTo(b.price.value()));
  }
}
