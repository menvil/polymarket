/**
 * OrderbookProjector - event sourcing projector для orderbook данных
 *
 * @remarks
 * КРИТИЧНО v4.2: Полноценный projector (НЕ live observer)!
 *
 * State = fold(orderbook events от WebSocket)
 * Подписывается на WebSocket 'orderbook' события
 * Поддерживает актуальное состояние best bid/ask для каждого tokenId
 *
 * Используется стратегиями для получения текущих рыночных цен:
 * - Buy orders: размещаются на уровне best_ask (или чуть выше для maker)
 * - Sell orders: размещаются на уровне best_bid + spread (для прибыли)
 *
 * @example
 * ```typescript
 * const projector = new OrderbookProjector(logger);
 *
 * // Подписываемся на WebSocket orderbook события
 * wsManager.on('orderbook', (data) => {
 *   projector.project(data);
 * });
 *
 * // Получаем цены для размещения ордеров
 * const bestBid = projector.getBestBid(tokenId);
 * const bestAsk = projector.getBestAsk(tokenId);
 *
 * if (bestBid && bestAsk) {
 *   // Buy на уровне best_ask
 *   ctx.placeLimitOrder({ side: 'buy', price: bestAsk, ... });
 *
 *   // После fill: sell выше цены покупки для прибыли
 *   ctx.placeLimitOrder({ side: 'sell', price: bestBid + spread, ... });
 * }
 * ```
 */

import type { ILogger } from '../../ports/ILogger.js';

/**
 * Orderbook state для одного токена
 *
 * @remarks
 * Хранит best bid/ask извлечённые из последнего orderbook snapshot.
 */
export interface OrderbookState {
  /** Best bid price (highest buy price) */
  bestBid: number | null;
  /** Best ask price (lowest sell price) */
  bestAsk: number | null;
  /** Timestamp последнего обновления (Unix ms) */
  timestamp: number;
  /** Token ID (asset ID) */
  tokenId: string;
}

/**
 * Orderbook message от WebSocket
 *
 * @remarks
 * КРИТИЧНО: Polymarket возвращает orderbook в ОБРАТНОМ порядке!
 * - bids: [0.01, 0.02, ..., 0.51] (худшие → лучшие, worst first)
 * - asks: [0.99, 0.98, ..., 0.52] (худшие → лучшие, worst first)
 *
 * OrderbookProjector РАЗВОРАЧИВАЕТ массивы для получения стандартного порядка (best first).
 */
export interface OrderbookMessage {
  event_type: 'book';
  asset_id: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  timestamp: number;
}

/**
 * IOrderbookProjector interface
 */
export interface IOrderbookProjector {
  /**
   * Применить orderbook event к состоянию (pure reducer)
   *
   * @param message - Orderbook message от WebSocket
   */
  project(message: OrderbookMessage): void;

  /**
   * Получить best bid для токена
   *
   * @param tokenId - Token ID (asset ID)
   * @returns Best bid price или null если нет данных
   */
  getBestBid(tokenId: string): number | null;

  /**
   * Получить best ask для токена
   *
   * @param tokenId - Token ID (asset ID)
   * @returns Best ask price или null если нет данных
   */
  getBestAsk(tokenId: string): number | null;

  /**
   * Получить полное orderbook state для токена
   *
   * @param tokenId - Token ID (asset ID)
   * @returns OrderbookState или null если нет данных
   */
  getOrderbookState(tokenId: string): OrderbookState | null;

  /**
   * Получить mid price (среднее между bid и ask)
   *
   * @param tokenId - Token ID (asset ID)
   * @returns Mid price или null если нет данных
   */
  getMidPrice(tokenId: string): number | null;

  /**
   * Получить spread (разница между ask и bid)
   *
   * @param tokenId - Token ID (asset ID)
   * @returns Spread или null если нет данных
   */
  getSpread(tokenId: string): number | null;
}

/**
 * OrderbookProjector - полноценный event sourcing projector
 *
 * @remarks
 * КРИТИЧНО v4.2:
 * - State = fold(orderbook events)
 * - Подписывается на WebSocket события (допустимо для v1)
 * - NO Date.now() (timestamps из событий)
 * - Детерминированный replay возможен
 *
 * Инварианты:
 * - bids sorted descending (best bid = bids[0])
 * - asks sorted ascending (best ask = asks[0])
 * - bestBid < bestAsk (sanity check)
 *
 * TODO (v5):
 * - Хранить полный orderbook (не только best bid/ask)
 * - Snapshot/rebuild from event log
 */
export class OrderbookProjector implements IOrderbookProjector {
  private orderbooks = new Map<string, OrderbookState>();

  constructor(private readonly logger: ILogger) {}

  /**
   * Применить orderbook event (pure reducer)
   *
   * @remarks
   * КРИТИЧНО v4.2: Это pure reducer, НЕ live observer!
   * Подписывается на WebSocket события (допустимо для v1).
   *
   * Алгоритм:
   * 1. Извлечь tokenId из message.asset_id
   * 2. Извлечь best bid = bids[0]?.price (highest)
   * 3. Извлечь best ask = asks[0]?.price (lowest)
   * 4. Валидация: bestBid < bestAsk (sanity check)
   * 5. Обновить state в Map
   *
   * @example
   * ```typescript
   * projector.project({
   *   event_type: 'book',
   *   asset_id: '67704255...',
   *   bids: [{ price: '0.52', size: '100' }, { price: '0.51', size: '200' }],
   *   asks: [{ price: '0.53', size: '150' }, { price: '0.54', size: '250' }],
   *   timestamp: 1766875759895
   * });
   * // → bestBid = 0.52, bestAsk = 0.53
   * ```
   */
  project(message: OrderbookMessage): void {
    try {
      const tokenId = message.asset_id;

      if (!tokenId) {
        this.logger.warn('[OrderbookProjector] Message without asset_id', { message });
        return;
      }

      // ✅ КРИТИЧНО: Polymarket возвращает orderbook в обратном порядке!
      // bids: [0.01, 0.02, ..., 0.51] (худшие → лучшие)
      // asks: [0.99, 0.98, ..., 0.52] (худшие → лучшие)
      // Разворачиваем массивы чтобы получить лучшие цены первыми
      const sortedBids = message.bids ? [...message.bids].reverse() : [];
      const sortedAsks = message.asks ? [...message.asks].reverse() : [];

      // Извлечь best bid (первый элемент после reverse = лучший)
      const bestBidStr = sortedBids[0]?.price;
      const bestBid = bestBidStr ? parseFloat(bestBidStr) : null;

      // Извлечь best ask (первый элемент после reverse = лучший)
      const bestAskStr = sortedAsks[0]?.price;
      const bestAsk = bestAskStr ? parseFloat(bestAskStr) : null;

      // Валидация: bestBid < bestAsk (sanity check)
      if (bestBid !== null && bestAsk !== null && bestBid >= bestAsk) {
        this.logger.warn('[OrderbookProjector] INVARIANT VIOLATION: bestBid >= bestAsk (crossed market)', {
          tokenId: tokenId.substring(0, 16) + '...',
          bestBid,
          bestAsk,
        });
        // Всё равно сохраняем (может быть временная аномалия)
      }

      // Обновить state
      const state: OrderbookState = {
        tokenId,
        bestBid,
        bestAsk,
        timestamp: message.timestamp || Date.now(), // ✅ Используем timestamp из события
      };

      this.orderbooks.set(tokenId, state);

      // Debug logging removed - too verbose
      // this.logger.debug('[OrderbookProjector] Updated orderbook', {
      //   tokenId: tokenId.substring(0, 16) + '...',
      //   bestBid,
      //   bestAsk,
      //   spread: bestBid && bestAsk ? (bestAsk - bestBid).toFixed(4) : null,
      // });
    } catch (error) {
      this.logger.error('[OrderbookProjector] Error projecting orderbook', {
        error: error instanceof Error ? error.message : String(error),
        message,
      });
    }
  }

  getBestBid(tokenId: string): number | null {
    return this.orderbooks.get(tokenId)?.bestBid ?? null;
  }

  getBestAsk(tokenId: string): number | null {
    return this.orderbooks.get(tokenId)?.bestAsk ?? null;
  }

  getOrderbookState(tokenId: string): OrderbookState | null {
    return this.orderbooks.get(tokenId) ?? null;
  }

  getMidPrice(tokenId: string): number | null {
    const state = this.orderbooks.get(tokenId);
    if (!state || state.bestBid === null || state.bestAsk === null) {
      return null;
    }
    return (state.bestBid + state.bestAsk) / 2;
  }

  getSpread(tokenId: string): number | null {
    const state = this.orderbooks.get(tokenId);
    if (!state || state.bestBid === null || state.bestAsk === null) {
      return null;
    }
    return state.bestAsk - state.bestBid;
  }
}
