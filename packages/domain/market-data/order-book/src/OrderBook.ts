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
 * - applyDelta(): size===0 → удалить уровень; size<0 → игнорировать
 * - getImbalance(): (bidSize - askSize) / (bidSize + askSize), 0 если пусто
 *
 * ### Почему mutable:
 * Order book может обновляться тысячи раз в секунду.
 * Иммутабельность привела бы к огромному давлению на GC.
 * Снапшот (toSnapshot()) всегда доступен для immutable копии.
 */

import Decimal from 'decimal.js';
import { addDecimal, subtractDecimal, divideDecimal, averageDecimal, isZeroDecimal } from '@polymarket/math';
import type { MarketId } from '@polymarket/ids';
import type { PriceLevel } from './PriceLevel.js';
import type { OrderBookDelta } from './OrderBookDelta.js';

/**
 * Снапшот стакана ордеров для сериализации
 */
export interface OrderBookSnapshot {
  /** ID рынка */
  readonly marketId: string;
  /** ID токена */
  readonly tokenId: string;
  /** Уровни покупки */
  readonly bids: PriceLevel[];
  /** Уровни продажи */
  readonly asks: PriceLevel[];
  /** Время снапшота в миллисекундах (опционально) */
  readonly timestampMs?: number;
}

/**
 * Мутабельный стакан ордеров
 *
 * @remarks
 * Не знает о domain entities (@polymarket/trade, Fill и т.д.) — только числа.
 * Это позволяет использовать его в market-data слое без зависимости от домена.
 *
 * @example
 * ```typescript
 * const book = OrderBook.create('market-abc', 'token-yes');
 * book.applyFullState(
 *   [{ price: 0.65, size: 1000 }, { price: 0.64, size: 500 }],
 *   [{ price: 0.66, size: 800 }]
 * );
 * console.log(book.getBestBid()); // { price: 0.65, size: 1000 }
 * console.log(book.getImbalance()); // (1500 - 800) / (1500 + 800) ≈ 0.304
 * ```
 */
export class OrderBook {
  public readonly marketId: MarketId;
  public readonly tokenId: string;

  /** Map<price, size> для bids */
  private _bids: Map<number, number>;
  /** Map<price, size> для asks */
  private _asks: Map<number, number>;

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
   * @param tokenId - ID токена (строка, не AssetId — order book не знает о domain entities)
   * @returns Новый OrderBook
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
   *   bids: [{ price: 0.65, size: 500 }],
   *   asks: [{ price: 0.66, size: 0 }], // удалить ask 0.66
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
   *
   * @remarks
   * Используется при получении полного снапшота стакана от биржи.
   * Полностью заменяет текущее состояние.
   *
   * @example
   * ```typescript
   * book.applyFullState(
   *   [{ price: 0.65, size: 1000 }],
   *   [{ price: 0.66, size: 800 }]
   * );
   * ```
   */
  public applyFullState(bids: PriceLevel[], asks: PriceLevel[]): void {
    this._bids = new Map();
    this._asks = new Map();

    for (const level of bids) {
      if (level.size > 0) {
        this._bids.set(level.price, level.size);
      }
    }
    for (const level of asks) {
      if (level.size > 0) {
        this._asks.set(level.price, level.size);
      }
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
   * if (bestBid) console.log(bestBid.price); // 0.65
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
   * if (bestAsk) console.log(bestAsk.price); // 0.66
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
   * const mid = book.getMidPrice(); // 0.655
   * ```
   */
  public getMidPrice(): Decimal | undefined {
    const bid = this.getBestBid();
    const ask = this.getBestAsk();
    if (bid === undefined || ask === undefined) return undefined;
    return averageDecimal(new Decimal(bid.price), new Decimal(ask.price));
  }

  /**
   * Вычисляет спред между лучшим ask и bid
   *
   * @returns bestAsk - bestBid или undefined если стакан пустой
   *
   * @example
   * ```typescript
   * const spread = book.getSpread(); // 0.01
   * ```
   */
  public getSpread(): Decimal | undefined {
    const bid = this.getBestBid();
    const ask = this.getBestAsk();
    if (bid === undefined || ask === undefined) return undefined;
    return subtractDecimal(new Decimal(ask.price), new Decimal(bid.price));
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
   * Возвращает 0 (не undefined) для удобства использования в стратегиях.
   *
   * @example
   * ```typescript
   * const imbalance = book.getImbalance(5); // топ 5 уровней
   * console.log(imbalance); // 0.304
   * ```
   */
  public getImbalance(topLevels?: number): Decimal {
    const bids = this._getSortedBids();
    const asks = this._getSortedAsks();

    const bidSlice = topLevels !== undefined ? bids.slice(0, topLevels) : bids;
    const askSlice = topLevels !== undefined ? asks.slice(0, topLevels) : asks;

    const bidSize = bidSlice.reduce((sum, l) => addDecimal(sum, new Decimal(l.size)), new Decimal(0));
    const askSize = askSlice.reduce((sum, l) => addDecimal(sum, new Decimal(l.size)), new Decimal(0));

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
   * ```
   */
  public getBids(levels?: number): readonly PriceLevel[] {
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
   * ```
   */
  public getAsks(levels?: number): readonly PriceLevel[] {
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
   * @param timestampMs - Время снапшота (опционально)
   * @returns Сериализуемый снапшот стакана
   *
   * @example
   * ```typescript
   * const snapshot = book.toSnapshot(Date.now());
   * const json = JSON.stringify(snapshot);
   * ```
   */
  public toSnapshot(timestampMs?: number): OrderBookSnapshot {
    return {
      marketId: this.marketId,
      tokenId: this.tokenId,
      bids: this._getSortedBids(),
      asks: this._getSortedAsks(),
      timestampMs,
    };
  }

  // ==================== Вспомогательные методы ====================

  /**
   * Применяет один ценовой уровень к карте
   */
  private _applyLevel(map: Map<number, number>, level: PriceLevel): void {
    if (level.size < 0) return; // игнорируем некорректные данные
    if (level.size === 0) {
      map.delete(level.price);
    } else {
      map.set(level.price, level.size);
    }
  }

  /**
   * Возвращает bids отсортированные по убыванию цены
   */
  private _getSortedBids(): PriceLevel[] {
    return Array.from(this._bids.entries())
      .sort(([a], [b]) => b - a) // убывание: лучший bid первый
      .map(([price, size]) => ({ price, size }));
  }

  /**
   * Возвращает asks отсортированные по возрастанию цены
   */
  private _getSortedAsks(): PriceLevel[] {
    return Array.from(this._asks.entries())
      .sort(([a], [b]) => a - b) // возрастание: лучший ask первый
      .map(([price, size]) => ({ price, size }));
  }
}
