/**
 * Реестр стаканов — хранит OrderBook экземпляры per (marketId, tokenId).
 *
 * @remarks
 * BookUpdateHandler владеет OrderBook экземплярами.
 * OrderBook mutable by design — high-frequency updates без аллокаций.
 * TopOfBook (immutable snapshot O(1)) создаётся при каждом BOOK_UPDATED publish.
 *
 * Ключ реестра: `${marketId}:${tokenId}` (составной, уникален в системе).
 * MarketDataFeedAdapter управляет жизненным циклом реестра.
 */
import type { OrderBook } from '@polymarket/order-book';
import type { MarketId, InstrumentId } from '@polymarket/ids';

export interface IBookRegistry {
  /**
   * Возвращает OrderBook по ключу (marketId, tokenId) или undefined.
   *
   * @param marketId - ID рынка (condition_id)
   * @param tokenId - ID токена (YES/NO outcome token)
   * @returns OrderBook или undefined если не найден
   */
  get(marketId: MarketId, tokenId: InstrumentId): OrderBook | undefined;

  /**
   * Возвращает существующий OrderBook или создаёт новый.
   *
   * @param marketId - ID рынка
   * @param tokenId - ID токена
   * @returns OrderBook (всегда ненулевой)
   */
  getOrCreate(marketId: MarketId, tokenId: InstrumentId): OrderBook;

  /**
   * Удаляет OrderBook из реестра.
   *
   * @param marketId - ID рынка
   * @param tokenId - ID токена
   */
  delete(marketId: MarketId, tokenId: InstrumentId): void;
}
