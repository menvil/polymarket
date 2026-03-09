/**
 * PolymarketWebSocketManager - Polymarket-specific WebSocket manager
 *
 * @remarks
 * Extends BaseWebSocketTransport with Polymarket-specific functionality.
 * Uses composition pattern by injecting PolymarketMessageFormatter and PolymarketMessageParser.
 *
 * Provides:
 * - Polymarket-specific convenience methods (subscribeToTokens, unsubscribeFromTokens)
 * - Configured BaseWebSocketTransport with Polymarket formatter and parser
 * - Same API as old WebSocketManager (backward compatible)
 *
 * This is a thin wrapper that:
 * 1. Creates PolymarketMessageFormatter and PolymarketMessageParser
 * 2. Injects them into BaseWebSocketTransport via constructor
 * 3. Provides convenience methods for common Polymarket operations
 *
 * @example
 * ```typescript
 * const manager = new PolymarketWebSocketManager(
 *   {
 *     url: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
 *     reconnectDelay: 1000,
 *   },
 *   logger
 * );
 *
 * manager.on('orderbook', (data) => {
 *   console.log('Orderbook update:', data);
 * });
 *
 * await manager.connect();
 * await manager.subscribeToTokens(['67704255...', '28257334...']);
 * ```
 *
 * @module infrastructure/polymarket/ws/PolymarketWebSocketManager
 */

import type { ILogger } from '../../../domain/ports/ILogger.js';
import type { BaseWebSocketConfig } from '../../../shared/websocket/types.js';
import { BaseWebSocketTransport } from '../../../shared/websocket/BaseWebSocketTransport.js';
import { PolymarketMessageFormatter } from './PolymarketMessageFormatter.js';
import { PolymarketMessageParser } from './PolymarketMessageParser.js';

/**
 * Polymarket WebSocket configuration
 *
 * @remarks
 * Same as BaseWebSocketConfig but with Polymarket-specific defaults.
 */
export interface PolymarketWebSocketConfig extends BaseWebSocketConfig {
  /** WebSocket URL (default: wss://ws-subscriptions-clob.polymarket.com/ws/market) */
  url: string;
}

/**
 * PolymarketWebSocketManager
 *
 * @remarks
 * Polymarket-specific WebSocket manager using composition pattern.
 * Extends BaseWebSocketTransport and injects Polymarket formatter/parser.
 *
 * Features:
 * - Polymarket message formatting (via PolymarketMessageFormatter)
 * - Polymarket message parsing (via PolymarketMessageParser)
 * - Convenience methods for token subscriptions
 * - Same API as old WebSocketManager (backward compatible)
 *
 * Events (inherited from BaseWebSocketTransport):
 * - `connected` - Successfully connected
 * - `disconnected` - Disconnected
 * - `reconnecting` - Reconnection attempt started
 * - `error` - Error occurred
 * - `message` - Raw WebSocket data (Buffer, emitted FIRST)
 * - `raw` - Parsed message (after message event)
 * - `orderbook` - Orderbook update
 * - `trade` - Trade update
 */
export class PolymarketWebSocketManager extends BaseWebSocketTransport {
  /**
   * v5.4: Callbacks for trade subscriptions per tokenId
   *
   * @remarks
   * Used for trade-based fill detection in PAPER mode.
   * Each tokenId can have one callback.
   */
  private tradeCallbacks = new Map<
    string,
    (trade: { price: number; quantity: number; side: 'BUY' | 'SELL' | null }) => void
  >();

  /**
   * v5.4: Flag to track if trade listener is already set up
   */
  private tradeListenerInitialized = false;

  /**
   * Create a new Polymarket WebSocket manager
   *
   * @param config - WebSocket configuration
   * @param logger - Logger instance
   *
   * @throws {Error} If config or logger is null
   *
   * @remarks
   * Creates PolymarketMessageFormatter and PolymarketMessageParser internally
   * and injects them into BaseWebSocketTransport.
   *
   * The formatter and parser are created with the same logger for consistent logging.
   *
   * @example
   * ```typescript
   * const manager = new PolymarketWebSocketManager(
   *   {
   *     url: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
   *     reconnectDelay: 1000,
   *     maxReconnectDelay: 30000,
   *     heartbeatInterval: 30000,
   *     heartbeatTimeout: 5000,
   *   },
   *   logger
   * );
   * ```
   */
  constructor(config: PolymarketWebSocketConfig, logger: ILogger) {
    // Create Polymarket-specific formatter and parser
    const formatter = new PolymarketMessageFormatter(logger);
    const parser = new PolymarketMessageParser(logger);

    // Inject into BaseWebSocketTransport
    super(config, formatter, parser, logger);
  }

  /**
   * Subscribe to token updates
   *
   * @param tokenIds - Array of token IDs to subscribe to
   * @returns Promise that resolves when subscription message sent
   *
   * @remarks
   * Convenience method for subscribing to Polymarket tokens.
   * Equivalent to: subscribe('market', { assets_ids: tokenIds, type: 'market' })
   *
   * Features:
   * - Automatic duplicate removal (via PolymarketMessageFormatter)
   * - Token validation (via PolymarketMessageFormatter)
   * - Detailed logging
   *
   * @example
   * ```typescript
   * await manager.subscribeToTokens([
   *   '67704255197116168826604911233626301865010283966205730455742704536521111535950',
   *   '28257334928283890303635192969230584167951485435421345229067758649928042311681',
   * ]);
   *
   * manager.on('orderbook', (data) => {
   *   console.log('Orderbook for token:', data.asset_id);
   * });
   * ```
   */
  public async subscribeToTokens(tokenIds: string[]): Promise<void> {
    return this.subscribe('market', {
      assets_ids: tokenIds,
      type: 'market',
    });
  }

  /**
   * Unsubscribe from token updates
   *
   * @param tokenIds - Array of token IDs to unsubscribe from
   * @returns Promise that resolves when unsubscription message sent
   *
   * @remarks
   * Convenience method for unsubscribing from Polymarket tokens.
   * Equivalent to: unsubscribe('market', { assets_ids: tokenIds, type: 'market' })
   *
   * @example
   * ```typescript
   * await manager.unsubscribeFromTokens([
   *   '67704255197116168826604911233626301865010283966205730455742704536521111535950',
   * ]);
   * ```
   */
  public async unsubscribeFromTokens(tokenIds: string[]): Promise<void> {
    return this.unsubscribe('market', {
      assets_ids: tokenIds,
      type: 'market',
    });
  }

  /**
   * Subscribe to trade events for a specific token
   *
   * @param tokenId - Token ID to filter trades by
   * @param callback - Callback called for each trade
   *
   * @remarks
   * v5.4: For trade-based fill detection in PAPER mode.
   *
   * The callback receives normalized trade data:
   * - price: number (parsed from string)
   * - quantity: number (parsed from string)
   * - side: 'BUY' | 'SELL' | null
   *
   * Only one callback per tokenId is supported.
   * Calling again with same tokenId replaces the previous callback.
   *
   * @example
   * ```typescript
   * manager.subscribeToTrades('67704255...', (trade) => {
   *   console.log(`Trade: ${trade.side} ${trade.quantity} @ ${trade.price}`);
   *   tradeAccumulator.addTrade(tokenId, trade);
   * });
   * ```
   */
  public subscribeToTrades(
    tokenId: string,
    callback: (trade: { price: number; quantity: number; side: 'BUY' | 'SELL' | null }) => void
  ): void {
    // Store callback for this tokenId
    this.tradeCallbacks.set(tokenId, callback);

    // Initialize trade listener if not already done
    if (!this.tradeListenerInitialized) {
      this.tradeListenerInitialized = true;

      // Listen to all trade events and route to appropriate callbacks
      this.on('trade', (message: any) => {
        const assetId = message.asset_id;
        if (!assetId) return;

        const cb = this.tradeCallbacks.get(assetId);
        if (!cb) return;

        // Parse and normalize trade data
        // PolymarketTradeMessage has: price (string), size (string), side ('BUY'|'SELL'|undefined)
        const tradeData = {
          price: parseFloat(message.price) || 0,
          quantity: parseFloat(message.size) || 0,
          side: (message.side as 'BUY' | 'SELL') || null,
        };

        cb(tradeData);
      });
    }
  }

  /**
   * Unsubscribe from trade events for a specific token
   *
   * @param tokenId - Token ID to unsubscribe from
   *
   * @remarks
   * v5.4: Removes the trade callback for this tokenId.
   * Does NOT remove the underlying 'trade' event listener (it stays active for other tokens).
   */
  public unsubscribeFromTrades(tokenId: string): void {
    this.tradeCallbacks.delete(tokenId);
  }
}

// Re-export types from shared layer for backward compatibility
export type { ConnectionStatus } from '../../../shared/websocket/types.js';
export type { SubscriptionParams } from '../../../shared/websocket/types.js';
