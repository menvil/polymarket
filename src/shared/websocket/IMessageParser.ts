/**
 * IMessageParser - Interface for parsing INCOMING WebSocket messages
 *
 * @remarks
 * Responsibility: Convert raw WebSocket messages into structured domain events.
 * This is the INCOMING half of the message handling (paired with IMessageFormatter for outgoing).
 *
 * Design Decision:
 * - Split from IMessageFormatter to follow Single Responsibility Principle
 * - IMessageParser handles incoming message parsing (server → client)
 * - IMessageFormatter handles subscribe/unsubscribe formatting (client → server)
 *
 * Each exchange implements this interface with their specific parsing logic:
 * - Polymarket: Parse { event_type: 'book' | 'trade' | 'pong' | ... }
 * - Binance: Parse { e: 'depthUpdate' | 'trade' | ... }
 * - Kraken: Parse { event: 'heartbeat' | ... } and array payloads
 *
 * Key Responsibilities:
 * 1. **parseMessage()**: Convert raw data to ParsedMessage (or null for control messages)
 * 2. **isPongMessage()**: Detect heartbeat/pong responses
 * 3. **isErrorMessage()**: Detect error messages
 * 4. **extractErrorMessage()**: Extract human-readable error text
 *
 * @example
 * ```typescript
 * // Polymarket implementation
 * class PolymarketMessageParser implements IMessageParser {
 *   parseMessage(data: unknown): ParsedMessage | null {
 *     const msg = data as PolymarketWSMessage;
 *     if (msg.event_type === 'book') {
 *       return {
 *         type: 'orderbook',
 *         channelId: msg.asset_id,
 *         payload: msg,
 *       };
 *     }
 *     return null; // Control message (pong, subscribed, etc.)
 *   }
 * }
 *
 * // Usage in BaseWebSocketTransport
 * const parsed = this.parser.parseMessage(JSON.parse(rawData));
 * if (parsed) {
 *   this.emit(parsed.type, parsed.payload);
 * }
 * ```
 *
 * @module shared/websocket/IMessageParser
 */

import type { ParsedMessage } from './types.js';

/**
 * Interface for parsing incoming WebSocket messages
 *
 * @remarks
 * Implementations must:
 * - Parse exchange-specific message formats
 * - Return ParsedMessage for data events (orderbook, trade, ticker, etc.)
 * - Return null for control messages (pong, subscribed, error, etc.)
 * - Detect heartbeat/pong messages
 * - Detect and extract error messages
 *
 * Design Principles:
 * - **Fail gracefully**: Return null for unparseable messages (don't throw)
 * - **Logging**: Log warnings for unexpected formats
 * - **Type safety**: Validate message structure before accessing fields
 * - **Performance**: Fast parsing (< 1ms typical)
 *
 * Control Messages vs Data Messages:
 * - **Control messages** (return null): pong, subscribed, unsubscribed, error
 * - **Data messages** (return ParsedMessage): orderbook, trade, ticker, etc.
 *
 * This distinction allows BaseWebSocketTransport to:
 * - Handle control messages internally (heartbeat, subscriptions, errors)
 * - Emit data messages to application layer
 */
export interface IMessageParser {
  /**
   * Parse incoming WebSocket message
   *
   * @param data - Raw message data (usually parsed JSON object)
   * @returns ParsedMessage for data events, null for control messages or unparseable data
   *
   * @remarks
   * Decision Flow:
   * 1. Check if message is control message (pong, subscribed, error) → return null
   * 2. Check if message is data event (orderbook, trade) → return ParsedMessage
   * 3. Check if message is malformed/incomplete → log warning, return null
   *
   * Control Messages (return null):
   * - Heartbeat/pong responses (handled by BaseWebSocketTransport)
   * - Subscription confirmations (logged but not emitted)
   * - Error messages (handled by isErrorMessage/extractErrorMessage)
   *
   * Data Messages (return ParsedMessage):
   * - Orderbook updates → { type: 'orderbook', channelId: '123', payload: {...} }
   * - Trade events → { type: 'trade', channelId: '123', payload: {...} }
   * - Custom events → { type: 'custom', channelId: '123', payload: {...} }
   *
   * Error Handling:
   * - Invalid/unparseable data → log warning, return null (don't throw)
   * - Missing required fields → log warning, return null
   * - Never throw exceptions (parseMessage is called in hot path)
   *
   * @example
   * ```typescript
   * // Polymarket
   * const parsed = parser.parseMessage({
   *   event_type: 'book',
   *   asset_id: '123',
   *   bids: [...],
   *   asks: [...],
   * });
   * // Returns: { type: 'orderbook', channelId: '123', payload: {...} }
   *
   * const pong = parser.parseMessage({ event_type: 'pong' });
   * // Returns: null (control message)
   *
   * // Binance
   * const parsed = parser.parseMessage({
   *   e: 'depthUpdate',
   *   s: 'BTCUSDT',
   *   b: [...],
   *   a: [...],
   * });
   * // Returns: { type: 'orderbook', channelId: 'BTCUSDT', payload: {...} }
   * ```
   */
  parseMessage(data: unknown): ParsedMessage | null;

  /**
   * Check if message is a pong/heartbeat response
   *
   * @param data - Raw message data
   * @returns true if this is a heartbeat/pong message
   *
   * @remarks
   * Used by BaseWebSocketTransport to:
   * - Reset heartbeat timeout
   * - Confirm connection is alive
   * - Avoid treating pong as a data event
   *
   * Exchange Examples:
   * - Polymarket: { event_type: 'pong' }
   * - Binance: { e: 'ping' } or { result: null, id: <pingId> }
   * - Kraken: { event: 'heartbeat' }
   *
   * @example
   * ```typescript
   * if (parser.isPongMessage(data)) {
   *   this.resetHeartbeatTimeout();
   *   return; // Don't process as data event
   * }
   * ```
   */
  isPongMessage(data: unknown): boolean;

  /**
   * Check if message is an error message
   *
   * @param data - Raw message data
   * @returns true if this is an error message
   *
   * @remarks
   * Used by BaseWebSocketTransport to:
   * - Detect exchange errors
   * - Emit 'error' event with extracted message
   * - Log error details
   *
   * Exchange Examples:
   * - Polymarket: { event_type: 'error', message: '...' }
   * - Binance: { error: { code: -1100, msg: '...' } }
   * - Kraken: { errorMessage: '...' }
   *
   * @example
   * ```typescript
   * if (parser.isErrorMessage(data)) {
   *   const errMsg = parser.extractErrorMessage(data);
   *   this.logger.error('WebSocket error', { error: errMsg });
   *   this.emit('error', new Error(errMsg));
   * }
   * ```
   */
  isErrorMessage(data: unknown): boolean;

  /**
   * Extract human-readable error message
   *
   * @param data - Raw message data (should be error message)
   * @returns Error message string, or undefined if not an error or message unavailable
   *
   * @remarks
   * Called after isErrorMessage() returns true.
   * Extracts the actual error text from exchange-specific error format.
   *
   * Fallback Behavior:
   * - If no error message found → return 'Unknown error'
   * - If data is not an error → return undefined
   * - Never throw exceptions
   *
   * Exchange Examples:
   * - Polymarket: Extract message field
   * - Binance: Extract error.msg field
   * - Kraken: Extract errorMessage field
   *
   * @example
   * ```typescript
   * // Polymarket
   * const msg = parser.extractErrorMessage({ event_type: 'error', message: 'Invalid token' });
   * // Returns: 'Invalid token'
   *
   * // Binance
   * const msg = parser.extractErrorMessage({ error: { code: -1100, msg: 'Invalid symbol' } });
   * // Returns: 'Invalid symbol'
   * ```
   */
  extractErrorMessage(data: unknown): string | undefined;
}
