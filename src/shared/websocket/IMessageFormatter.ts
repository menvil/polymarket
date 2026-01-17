/**
 * IMessageFormatter - Interface for formatting OUTGOING WebSocket messages
 *
 * @remarks
 * Responsibility: Convert domain-level subscription requests into exchange-specific wire format.
 * This is the OUTGOING half of the message handling (paired with IMessageParser for incoming).
 *
 * Design Decision:
 * - Split from IMessageParser to follow Single Responsibility Principle
 * - IMessageFormatter handles subscribe/unsubscribe formatting (client → server)
 * - IMessageParser handles incoming message parsing (server → client)
 *
 * Each exchange implements this interface with their specific format:
 * - Polymarket: JSON with { assets_ids: [...], type: 'market' }
 * - Binance: JSON with { method: 'SUBSCRIBE', params: [...] }
 * - Kraken: JSON with { event: 'subscribe', pair: [...], subscription: {...} }
 *
 * @example
 * ```typescript
 * // Polymarket implementation
 * class PolymarketMessageFormatter implements IMessageFormatter {
 *   formatSubscription(channel: string, params: SubscriptionParams): string {
 *     return JSON.stringify({
 *       assets_ids: params.assets_ids,
 *       type: 'market',
 *     });
 *   }
 * }
 *
 * // Usage in BaseWebSocketTransport
 * const message = this.formatter.formatSubscription('market', { assets_ids: ['123'] });
 * this.ws.send(message);
 * ```
 *
 * @module shared/websocket/IMessageFormatter
 */

import type { SubscriptionParams } from './types.js';

/**
 * Interface for formatting outgoing WebSocket messages
 *
 * @remarks
 * Implementations must:
 * - Convert generic SubscriptionParams to exchange-specific format
 * - Return ready-to-send string (usually JSON.stringify result)
 * - Validate params and throw clear errors if invalid
 * - Handle exchange-specific quirks (e.g., Polymarket requires numeric strings)
 *
 * Error Handling:
 * - Throw Error for invalid params (caught by BaseWebSocketTransport)
 * - Log warnings for suspicious but valid input
 * - Never return null/undefined (always return valid string or throw)
 *
 * SLA:
 * - Synchronous operation (no async needed for formatting)
 * - Fast execution (< 1ms typical)
 * - Deterministic output (same params → same output)
 */
export interface IMessageFormatter {
  /**
   * Format a subscription request
   *
   * @param channel - Channel name (exchange-specific, e.g., 'market', 'depth', 'trade')
   * @param params - Subscription parameters (exchange-specific structure)
   * @returns Formatted message string ready to send via WebSocket
   * @throws {Error} If params are invalid or missing required fields
   *
   * @remarks
   * The channel parameter may be ignored by some exchanges (e.g., Polymarket doesn't use it).
   * Other exchanges may use it to determine message structure (e.g., Binance).
   *
   * Validation:
   * - Check required fields exist
   * - Validate field formats (e.g., numeric strings, valid enums)
   * - Remove duplicates if applicable
   * - Throw descriptive errors for invalid input
   *
   * @example
   * ```typescript
   * // Polymarket
   * const msg = formatter.formatSubscription('market', {
   *   assets_ids: ['123', '456'],
   *   type: 'market',
   * });
   * // Returns: '{"assets_ids":["123","456"],"type":"market"}'
   *
   * // Binance
   * const msg = formatter.formatSubscription('depth', {
   *   symbol: 'BTCUSDT',
   *   levels: 20,
   * });
   * // Returns: '{"method":"SUBSCRIBE","params":["btcusdt@depth20"],"id":1}'
   * ```
   */
  formatSubscription(channel: string, params: SubscriptionParams): string;

  /**
   * Format an unsubscription request
   *
   * @param channel - Channel name
   * @param params - Unsubscription parameters (usually same as subscription)
   * @returns Formatted message string ready to send via WebSocket
   * @throws {Error} If params are invalid
   *
   * @remarks
   * Some exchanges use the same format for subscribe/unsubscribe (e.g., Polymarket).
   * Others use different message types (e.g., Binance uses method: 'UNSUBSCRIBE').
   *
   * Implementation Note:
   * - If unsubscribe format is identical to subscribe, delegate to formatSubscription()
   * - If different, implement separate logic
   *
   * @example
   * ```typescript
   * // Polymarket (same as subscribe)
   * const msg = formatter.formatUnsubscription('market', {
   *   assets_ids: ['123'],
   * });
   *
   * // Binance (different method)
   * const msg = formatter.formatUnsubscription('depth', {
   *   symbol: 'BTCUSDT',
   * });
   * // Returns: '{"method":"UNSUBSCRIBE","params":["btcusdt@depth20"],"id":2}'
   * ```
   */
  formatUnsubscription(channel: string, params: SubscriptionParams): string;
}
