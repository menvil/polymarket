/**
 * Порт рыночных данных (market data feed).
 *
 * @remarks
 * Реализуется PolymarketWsAdapter.
 * Phase 0.5 переработает WsAdapter в IPolymarketWsEmitter — этот интерфейс устареет.
 */

/**
 * Интерфейс для подписки на рыночные данные через WebSocket.
 */
export interface IMarketDataFeed {
  connect(): Promise<void>;
  disconnect?(): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subscribeToOrderbook(tokenId: string, callback: (orderbook: any) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subscribeToTrades(tokenId: string, callback: (trade: any) => void): void;
  unsubscribe(tokenId: string): void;
  isSubscribed(tokenId: string): boolean;
}
