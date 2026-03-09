/**
 * Polymarket WebSocket types
 *
 * @remarks
 * Contains Polymarket-specific WebSocket message formats and subscription parameters.
 * Based on actual Polymarket CLOB WebSocket API.
 *
 * API Documentation:
 * - Endpoint: wss://ws-subscriptions-clob.polymarket.com/ws/market
 * - Format: JSON messages with event_type field
 *
 * @module infrastructure/polymarket/ws/types
 */

/**
 * Polymarket subscription parameters
 *
 * @remarks
 * Polymarket uses a simple subscription format:
 * - assets_ids: Array of token IDs (as numeric strings)
 * - type: Subscription type ('market' or 'user')
 *
 * Format sent to WebSocket:
 * ```json
 * {
 *   "assets_ids": ["67704255197116168826604911233626301865010283966205730455742704536521111535950", ...],
 *   "type": "market"
 * }
 * ```
 *
 * @example
 * ```typescript
 * const params: PolymarketSubscriptionParams = {
 *   assets_ids: [
 *     '67704255197116168826604911233626301865010283966205730455742704536521111535950',
 *     '28257334928283890303635192969230584167951485435421345229067758649928042311681',
 *   ],
 *   type: 'market',
 * };
 * ```
 */
export interface PolymarketSubscriptionParams {
  /**
   * Array of asset IDs (token IDs) to subscribe to
   *
   * @remarks
   * - Token IDs are very long numeric strings (77 digits)
   * - Must be valid token IDs from Polymarket markets
   * - Duplicates will be removed automatically
   * - Each token represents one side of a binary market (YES or NO)
   *
   * @example
   * ['67704255197116168826604911233626301865010283966205730455742704536521111535950']
   */
  assets_ids: string[];

  /**
   * Subscription type
   *
   * @remarks
   * - 'market': Subscribe to market data (orderbook, trades)
   * - 'user': Subscribe to user-specific events (fills, orders)
   *
   * Most common is 'market' for market making / trading bots.
   */
  type: 'market' | 'user';
}

/**
 * Polymarket WebSocket message (incoming)
 *
 * @remarks
 * All messages from Polymarket WebSocket have an event_type field.
 * Additional fields depend on the event type.
 *
 * Event Types:
 * - **Data events** (have asset_id): book, trade, last_trade_price
 * - **Control events** (no asset_id): pong, error, subscribed, unsubscribed
 * - **Ignored events**: price_change, tick_size_change
 *
 * @example
 * ```typescript
 * // Orderbook update
 * const book: PolymarketWSMessage = {
 *   event_type: 'book',
 *   asset_id: '67704255197116168826604911233626301865010283966205730455742704536521111535950',
 *   bids: [{ price: '0.52', size: '100' }],
 *   asks: [{ price: '0.53', size: '150' }],
 *   timestamp: 1766875759895,
 * };
 *
 * // Trade update
 * const trade: PolymarketWSMessage = {
 *   event_type: 'trade',
 *   asset_id: '67704255197116168826604911233626301865010283966205730455742704536521111535950',
 *   price: '0.52',
 *   size: '50',
 *   side: 'BUY',
 *   timestamp: 1766875759895,
 * };
 *
 * // Pong (control message)
 * const pong: PolymarketWSMessage = {
 *   event_type: 'pong',
 * };
 *
 * // Error (control message)
 * const error: PolymarketWSMessage = {
 *   event_type: 'error',
 *   message: 'Invalid token ID',
 * };
 * ```
 */
export interface PolymarketWSMessage {
  /**
   * Event type
   *
   * @remarks
   * Determines how to parse the rest of the message.
   *
   * Data Events:
   * - book: Orderbook snapshot/update
   * - trade: Trade execution
   * - last_trade_price: Last trade price update
   *
   * Control Events:
   * - pong: Heartbeat response
   * - error: Error message
   * - subscribed: Subscription confirmation
   * - unsubscribed: Unsubscription confirmation
   *
   * Ignored Events:
   * - price_change: Price change notifications (batched)
   * - tick_size_change: Tick size configuration change
   */
  event_type: 'book' | 'trade' | 'last_trade_price' | 'pong' | 'error' | 'subscribed' | 'unsubscribed' | 'price_change' | 'tick_size_change';

  /**
   * Asset ID (token ID)
   *
   * @remarks
   * Present only for data events (book, trade, last_trade_price).
   * Not present for control events (pong, error, subscribed).
   *
   * 77-digit numeric string representing a specific market outcome.
   *
   * @example
   * '67704255197116168826604911233626301865010283966205730455742704536521111535950'
   */
  asset_id?: string;

  /**
   * Bids (for orderbook events)
   *
   * @remarks
   * Array of { price: string, size: string } objects.
   * Prices are decimal strings (e.g., '0.52').
   * Sizes are decimal strings (e.g., '100.5').
   *
   * Sorted by price descending (best bid first).
   *
   * @example
   * [{ price: '0.52', size: '100' }, { price: '0.51', size: '200' }]
   */
  bids?: Array<{ price: string; size: string }>;

  /**
   * Asks (for orderbook events)
   *
   * @remarks
   * Array of { price: string, size: string } objects.
   * Sorted by price ascending (best ask first).
   *
   * @example
   * [{ price: '0.53', size: '150' }, { price: '0.54', size: '250' }]
   */
  asks?: Array<{ price: string; size: string }>;

  /**
   * Trade price (for trade events)
   *
   * @remarks
   * Decimal string representing the execution price.
   *
   * @example
   * '0.52'
   */
  price?: string;

  /**
   * Trade size (for trade events)
   *
   * @remarks
   * Decimal string representing the trade quantity.
   *
   * @example
   * '50.5'
   */
  size?: string;

  /**
   * Trade side (for trade events)
   *
   * @remarks
   * - BUY: Aggressive buy (taker bought from maker)
   * - SELL: Aggressive sell (taker sold to maker)
   *
   * This is from the taker's perspective.
   */
  side?: 'BUY' | 'SELL';

  /**
   * Timestamp (Unix milliseconds)
   *
   * @remarks
   * Present for data events (book, trade).
   * Represents when the event occurred on the exchange.
   *
   * @example
   * 1766875759895
   */
  timestamp?: number;

  /**
   * Error message (for error events)
   *
   * @remarks
   * Human-readable error description.
   *
   * @example
   * 'Invalid token ID'
   */
  message?: string;
}
