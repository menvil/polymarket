/**
 * Верхушка стакана — immutable snapshot лучших цен.
 *
 * @remarks
 * Создаётся BookUpdateHandler при каждом снапшоте. O(1) — только лучшие уровни.
 * Несёт immutable snapshot, а НЕ mutable OrderBook — потому что несколько
 * стратегий получают BookUpdatedEvent через fanout: если передать mutable
 * структуру, стратегия А увидит изменения стратегии Б.
 */
import type { Price, Quantity } from '@polymarket/value-objects';

export interface TopOfBook {
  /** Лучшая цена bid (или undefined если стакан пуст) */
  readonly bestBid: Price | undefined;
  /** Лучшая цена ask (или undefined если стакан пуст) */
  readonly bestAsk: Price | undefined;
  /** Spread = bestAsk - bestBid (или undefined) */
  readonly spread: Price | undefined;
  /** Размер лучшего bid (или undefined) */
  readonly bestBidSize: Quantity | undefined;
  /** Размер лучшего ask (или undefined) */
  readonly bestAskSize: Quantity | undefined;
}
