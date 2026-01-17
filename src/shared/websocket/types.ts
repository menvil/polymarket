/**
 * Shared WebSocket types for exchange-agnostic transport layer
 *
 * @remarks
 * These types are used across all WebSocket implementations regardless of exchange.
 * Exchange-specific types should be defined in their own modules.
 *
 * @module shared/websocket/types
 */

/**
 * WebSocket connection status
 *
 * @remarks
 * Lifecycle states:
 * - disconnected: Initial state, not connected
 * - connecting: Connection attempt in progress
 * - connected: Successfully connected and ready
 * - reconnecting: Lost connection, attempting to reconnect
 * - closed: Permanently closed, no reconnection
 */
export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closed';

/**
 * Base WebSocket configuration
 *
 * @remarks
 * Common configuration options for any WebSocket transport.
 * Exchange-specific configs can extend this interface.
 *
 * @example
 * ```typescript
 * const config: BaseWebSocketConfig = {
 *   url: 'wss://example.com/ws',
 *   reconnectDelay: 1000,
 *   maxReconnectDelay: 30000,
 *   heartbeatInterval: 30000,
 *   heartbeatTimeout: 10000,
 * };
 * ```
 */
export interface BaseWebSocketConfig {
  /** WebSocket server URL (wss:// or ws://) */
  url: string;

  /** Initial reconnection delay in milliseconds */
  reconnectDelay?: number;

  /** Maximum reconnection delay (for exponential backoff) */
  maxReconnectDelay?: number;

  /** Heartbeat/ping interval in milliseconds */
  heartbeatInterval?: number;

  /** Heartbeat timeout (before considering connection dead) */
  heartbeatTimeout?: number;
}

/**
 * Parsed WebSocket message (exchange-agnostic)
 *
 * @remarks
 * Represents a successfully parsed data message from the exchange.
 * IMessageParser implementations return this structure.
 *
 * Flow:
 * 1. Raw WebSocket data arrives
 * 2. IMessageParser.parseMessage() converts it to ParsedMessage
 * 3. BaseWebSocketTransport emits event based on `type`
 *
 * @example
 * ```typescript
 * const parsed: ParsedMessage = {
 *   type: 'orderbook',
 *   channelId: '123',
 *   payload: { bids: [...], asks: [...] },
 * };
 * ```
 */
export interface ParsedMessage {
  /**
   * Event type (e.g., 'orderbook', 'trade', 'ticker')
   *
   * @remarks
   * This value determines which event will be emitted:
   * - 'orderbook' → emit('orderbook', payload)
   * - 'trade' → emit('trade', payload)
   * - Custom types are allowed
   */
  type: string;

  /**
   * Channel/asset/symbol identifier
   *
   * @remarks
   * Identifies which market/asset this message is for.
   * Format depends on exchange (e.g., Polymarket uses asset_id, Binance uses symbol).
   */
  channelId: string;

  /**
   * Parsed message payload
   *
   * @remarks
   * Exchange-specific data structure.
   * Type safety is the responsibility of the consuming code.
   */
  payload: unknown;
}

/**
 * Generic subscription parameters
 *
 * @remarks
 * Key-value map for subscription configuration.
 * Exchange-specific implementations define the actual structure.
 *
 * Examples:
 * - Polymarket: { assets_ids: string[], type: 'market' }
 * - Binance: { symbol: string, channel: 'depth' }
 *
 * @example
 * ```typescript
 * const params: SubscriptionParams = {
 *   assets_ids: ['123', '456'],
 *   type: 'market',
 * };
 * ```
 */
export interface SubscriptionParams {
  [key: string]: unknown;
}
