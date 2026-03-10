/**
 * @polymarket/exchange/ws — публичный API WebSocket уровня Polymarket.
 *
 * @remarks
 * Предоставляет raw WS-эмиттер и адаптер для подключения к Polymarket WebSocket.
 *
 * ### Содержимое:
 * - `IPolymarketWsEmitter` — контракт подписки на raw WS-события
 * - `PolymarketWsAdapter` — реализация IPolymarketWsEmitter
 * - `PolymarketWebSocketManager` — WebSocket-менеджер (транспортный слой)
 * - `UserChannelConfig` — конфигурация аутентификации в user channel
 *
 * @example
 * ```typescript
 * import {
 *   PolymarketWsAdapter,
 *   PolymarketWebSocketManager,
 * } from '@polymarket/exchange/ws';
 *
 * const manager = new PolymarketWebSocketManager(
 *   { url: 'wss://ws-subscriptions-clob.polymarket.com/ws/market' },
 *   logger,
 * );
 * const adapter = new PolymarketWsAdapter(manager, logger);
 * await adapter.connect();
 * ```
 */

export type { IPolymarketWsEmitter, UserChannelConfig } from './IPolymarketWsEmitter.js';
export { PolymarketWsAdapter } from './PolymarketWsAdapter.js';
export { PolymarketWebSocketManager } from './PolymarketWebSocketManager.js';
export type { PolymarketWebSocketConfig } from './PolymarketWebSocketManager.js';
