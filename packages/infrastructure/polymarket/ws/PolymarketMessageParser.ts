/**
 * PolymarketMessageParser - Parses Polymarket-specific incoming WebSocket messages
 *
 * @remarks
 * Responsible for parsing INCOMING messages from Polymarket WebSocket.
 * This is the INCOMING half (paired with PolymarketMessageFormatter for outgoing).
 *
 * Polymarket Message Types:
 * - **Data events** (have asset_id): book, trade, last_trade_price
 * - **Control events** (no asset_id): pong, error, subscribed, unsubscribed
 * - **Ignored events**: price_change, tick_size_change
 *
 * Key Responsibilities:
 * - Parse data events → return ParsedMessage
 * - Detect control events → return null
 * - Detect pong messages (for heartbeat)
 * - Detect error messages (for error handling)
 * - Extract error text from error messages
 *
 * Parsing Rules:
 * - Control messages (pong, error, subscribed) → return null
 * - Data messages without asset_id → log warning, return null
 * - Data messages with asset_id → return ParsedMessage
 * - Invalid/incomplete messages → log warning, return null
 * - Never throw exceptions (fail gracefully)
 *
 * @example
 * ```typescript
 * const parser = new PolymarketMessageParser(logger);
 *
 * // Orderbook message
 * const parsed = parser.parseMessage({
 *   event_type: 'book',
 *   asset_id: '67704255...',
 *   bids: [{ price: '0.52', size: '100' }],
 *   asks: [{ price: '0.53', size: '150' }],
 * });
 * // Returns: { type: 'orderbook', channelId: '67704255...', payload: {...} }
 *
 * // Pong message (control)
 * const parsed = parser.parseMessage({ event_type: 'pong' });
 * // Returns: null (control message, handled by transport)
 * ```
 *
 * @module infrastructure/polymarket/ws/PolymarketMessageParser
 */

import type { IMessageParser } from '../stubs/shared/websocket/IMessageParser.js';
import type { ParsedMessage } from '../stubs/shared/websocket/types.js';
import type { PolymarketWSMessage } from './types.js';
import type { ILogger } from '@polymarket/logger';

/**
 * Polymarket message parser implementation
 *
 * @remarks
 * Implements IMessageParser for Polymarket CLOB WebSocket API.
 *
 * Features:
 * - Parses all Polymarket message types
 * - Handles control messages (pong, error, subscribed)
 * - Validates data message structure
 * - Graceful error handling (never throws)
 *
 * Error Handling:
 * - Invalid messages → log warning, return null
 * - Missing fields → log warning, return null
 * - Never throws exceptions (fail gracefully)
 */
export class PolymarketMessageParser implements IMessageParser {
  private readonly logger: ILogger;

  /**
   * Create a new Polymarket message parser
   *
   * @param logger - Logger instance
   *
   * @throws {Error} If logger is null
   *
   * @example
   * ```typescript
   * const parser = new PolymarketMessageParser(logger);
   * ```
   */
  constructor(logger: ILogger) {
    if (!logger) {
      throw new Error('logger is required');
    }

    this.logger = logger.child ? logger.child('PolymarketMessageParser') : logger;
  }

  /**
   * Parse incoming Polymarket message
   *
   * @param data - Raw message data (parsed JSON object)
   * @returns ParsedMessage for data events, null for control messages or invalid data
   *
   * @remarks
   * Decision Flow:
   * 1. Extract event_type from message
   * 2. Check if control message (pong, error, subscribed, unsubscribed) → return null
   * 3. Check if ignored message (price_change, tick_size_change) → return null
   * 4. Check if data message has asset_id → if not, return null
   * 5. Parse data message based on event_type:
   *    - book → validate bids/asks, return 'orderbook'
   *    - trade → validate price/size, return 'trade'
   *    - last_trade_price → return 'trade'
   * 6. Unknown event_type → log warning, return null
   *
   * Control Messages (return null):
   * - pong: Heartbeat response
   * - error: Error notification
   * - subscribed: Subscription confirmation
   * - unsubscribed: Unsubscription confirmation
   *
   * Ignored Messages (return null):
   * - price_change: Batch price changes (not needed for trading)
   * - tick_size_change: Market config changes (not needed for trading)
   *
   * Data Messages (return ParsedMessage):
   * - book: { type: 'orderbook', channelId: asset_id, payload: message }
   * - trade: { type: 'trade', channelId: asset_id, payload: message }
   * - last_trade_price: { type: 'trade', channelId: asset_id, payload: message }
   *
   * Validation:
   * - Data messages MUST have asset_id → else return null
   * - book messages MUST have bids AND asks → else return null
   * - trade messages MUST have price AND size → else return null
   *
   * @example
   * ```typescript
   * // Orderbook update
   * const parsed = parser.parseMessage({
   *   event_type: 'book',
   *   asset_id: '67704255...',
   *   bids: [{ price: '0.52', size: '100' }],
   *   asks: [{ price: '0.53', size: '150' }],
   *   timestamp: 1766875759895,
   * });
   * // Returns: { type: 'orderbook', channelId: '67704255...', payload: {...} }
   *
   * // Trade update
   * const parsed = parser.parseMessage({
   *   event_type: 'trade',
   *   asset_id: '67704255...',
   *   price: '0.52',
   *   size: '50',
   *   side: 'BUY',
   *   timestamp: 1766875759895,
   * });
   * // Returns: { type: 'trade', channelId: '67704255...', payload: {...} }
   *
   * // Pong (control message)
   * const parsed = parser.parseMessage({ event_type: 'pong' });
   * // Returns: null
   *
   * // Invalid message (missing asset_id)
   * const parsed = parser.parseMessage({ event_type: 'book' });
   * // Returns: null (logs warning)
   * ```
   */
  parseMessage(data: unknown): ParsedMessage | null {
    try {
      const message = data as PolymarketWSMessage;
      const eventType = message.event_type;

      if (!eventType) {
        this.logger.trace('Message without event_type', { message });
        return null;
      }

      // Управляющие сообщения (без asset_id) — обрабатываются транспортом
      if (eventType === 'pong' || eventType === 'error' || eventType === 'subscribed' || eventType === 'unsubscribed') {
        // Обрабатываются BaseWebSocketTransport (isPongMessage, isErrorMessage)
        return null;
      }

      // Игнорируемые события (не нужны для торговли)
      if (eventType === 'price_change') {
        // price_change содержит массив price_changes, а не единственный asset_id
        // Пропускаем — не нужно для торговли или сбора данных
        this.logger.trace('Skipping price_change event', {
          market: (message as any).market?.substring(0, 16) + '...',
          changes: (message as any).price_changes?.length,
        });
        return null;
      }

      if (eventType === 'tick_size_change') {
        // tick_size_change — пропускаем, не нужно для торговли или сбора данных
        this.logger.trace('Skipping tick_size_change event', {
          market: (message as any).market?.substring(0, 16) + '...',
        });
        return null;
      }

      // Сообщения с данными ДОЛЖНЫ иметь asset_id
      if (!message.asset_id) {
        this.logger.warn('Data message without asset_id', { eventType, message });
        return null;
      }

      // Парсим событие стакана
      if (eventType === 'book') {
        // Проверяем обязательные поля
        if (!message.bids || !message.asks) {
          this.logger.warn('Orderbook message missing bids or asks', { message });
          return null;
        }

        return {
          type: 'orderbook',
          channelId: message.asset_id,
          payload: message,
        };
      }

      // Парсим событие сделки
      if (eventType === 'trade' || eventType === 'last_trade_price') {
        // Проверяем обязательные поля
        if (!message.price || !message.size) {
          this.logger.trace('Trade message missing price or size', { eventType, message });
          return null;
        }

        return {
          type: 'trade',
          channelId: message.asset_id,
          payload: message,
        };
      }

      // Неизвестный тип события
      this.logger.debug('Unknown event type', {
        eventType,
        asset_id: message.asset_id?.substring(0, 16),
      });
      return null;
    } catch (error) {
      this.logger.error('Failed to parse message', { error, data });
      return null;
    }
  }

  /**
   * Check if message is a pong/heartbeat response
   *
   * @param data - Raw message data
   * @returns true if this is a pong message
   *
   * @remarks
   * Polymarket sends { event_type: 'pong' } in response to ping.
   * This is used by BaseWebSocketTransport to reset heartbeat timeout.
   *
   * @example
   * ```typescript
   * const isPong = parser.isPongMessage({ event_type: 'pong' });
   * // Returns: true
   *
   * const isPong = parser.isPongMessage({ event_type: 'book', ... });
   * // Returns: false
   * ```
   */
  isPongMessage(data: unknown): boolean {
    const message = data as PolymarketWSMessage;
    return message.event_type === 'pong';
  }

  /**
   * Check if message is an error message
   *
   * @param data - Raw message data
   * @returns true if this is an error message
   *
   * @remarks
   * Polymarket sends { event_type: 'error', message: '...' } for errors.
   * This is used by BaseWebSocketTransport to emit error events.
   *
   * @example
   * ```typescript
   * const isError = parser.isErrorMessage({ event_type: 'error', message: 'Invalid token' });
   * // Returns: true
   *
   * const isError = parser.isErrorMessage({ event_type: 'book', ... });
   * // Returns: false
   * ```
   */
  isErrorMessage(data: unknown): boolean {
    const message = data as PolymarketWSMessage;
    return message.event_type === 'error';
  }

  /**
   * Extract human-readable error message
   *
   * @param data - Raw message data (should be error message)
   * @returns Error message string, or undefined if not an error
   *
   * @remarks
   * Polymarket error format: { event_type: 'error', message: '...' }
   * Extracts the message field.
   *
   * Fallback:
   * - If message field missing → return 'Unknown error'
   * - If not an error message → return undefined
   *
   * @example
   * ```typescript
   * const errMsg = parser.extractErrorMessage({
   *   event_type: 'error',
   *   message: 'Invalid token ID',
   * });
   * // Returns: 'Invalid token ID'
   *
   * const errMsg = parser.extractErrorMessage({ event_type: 'error' });
   * // Returns: 'Unknown error'
   *
   * const errMsg = parser.extractErrorMessage({ event_type: 'book', ... });
   * // Returns: undefined
   * ```
   */
  extractErrorMessage(data: unknown): string | undefined {
    const message = data as PolymarketWSMessage;

    if (message.event_type !== 'error') {
      return undefined;
    }

    return message.message || 'Unknown error';
  }
}
