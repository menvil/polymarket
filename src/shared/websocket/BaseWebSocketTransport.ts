/**
 * BaseWebSocketTransport - Exchange-agnostic WebSocket transport layer
 *
 * @remarks
 * Provides core WebSocket functionality that works with any exchange:
 * - Connection lifecycle (connect, disconnect, reconnect)
 * - Automatic reconnection with exponential backoff
 * - Heartbeat/ping-pong mechanism
 * - Subscription tracking and automatic resubscription
 * - Event emission (EventEmitter pattern)
 * - Graceful shutdown
 *
 * Uses composition pattern:
 * - IMessageFormatter: Formats outgoing subscribe/unsubscribe messages (exchange-specific)
 * - IMessageParser: Parses incoming messages and detects control messages (exchange-specific)
 *
 * Exchange-specific logic is delegated to injected formatter and parser.
 * This allows the same transport to work with Polymarket, Binance, Kraken, etc.
 *
 * @example
 * ```typescript
 * const formatter = new PolymarketMessageFormatter(logger);
 * const parser = new PolymarketMessageParser(logger);
 *
 * const transport = new BaseWebSocketTransport(
 *   { url: 'wss://...', reconnectDelay: 1000 },
 *   formatter,
 *   parser,
 *   logger
 * );
 *
 * transport.on('orderbook', (data) => {
 *   console.log('Orderbook update:', data);
 * });
 *
 * await transport.connect();
 * await transport.subscribe('market', { assets_ids: ['123'] });
 * ```
 *
 * @module shared/websocket/BaseWebSocketTransport
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import type { ILogger } from '../../domain/ports/ILogger.js';
import type { BaseWebSocketConfig, ConnectionStatus, SubscriptionParams } from './types.js';
import type { IMessageFormatter } from './IMessageFormatter.js';
import type { IMessageParser } from './IMessageParser.js';

/**
 * BaseWebSocketTransport
 *
 * @remarks
 * Core WebSocket transport implementation using composition pattern.
 * Delegates exchange-specific logic to IMessageFormatter and IMessageParser.
 *
 * Events:
 * - `connected` - Successfully connected
 * - `disconnected` - Disconnected
 * - `reconnecting` - Reconnection attempt started
 * - `error` - Error occurred
 * - `message` - Raw WebSocket data (Buffer, emitted FIRST)
 * - `raw` - Parsed message (after message event)
 * - `orderbook` - Orderbook update (routed from parser)
 * - `trade` - Trade update (routed from parser)
 * - Custom events from parser.parseMessage().type
 *
 * Event Order (CRITICAL for DataCollector):
 * 1. `message` (raw Buffer) - emitted FIRST
 * 2. `raw` (parsed data) - emitted after parsing
 * 3. Type-specific event (orderbook/trade/etc.) - emitted last
 *
 * Lifecycle:
 * 1. disconnected (initial)
 * 2. connecting (connection attempt)
 * 3. connected (ready for subscriptions)
 * 4. reconnecting (lost connection, attempting reconnect)
 * 5. closed (permanently closed, no reconnection)
 */
export class BaseWebSocketTransport extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly config: Required<BaseWebSocketConfig>;
  private readonly formatter: IMessageFormatter;
  private readonly parser: IMessageParser;
  private readonly logger: ILogger;

  private status: ConnectionStatus = 'disconnected';
  private currentReconnectDelay: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatTimeoutTimer: NodeJS.Timeout | null = null;
  private subscriptions: Set<string> = new Set();
  private isShuttingDown = false;

  /**
   * Create a new WebSocket transport
   *
   * @param config - Transport configuration
   * @param formatter - Message formatter for outgoing messages (exchange-specific)
   * @param parser - Message parser for incoming messages (exchange-specific)
   * @param logger - Logger instance
   *
   * @throws {Error} If config, formatter, parser, or logger is null
   *
   * @remarks
   * Applies default values:
   * - reconnectDelay: 1000ms
   * - maxReconnectDelay: 30000ms
   * - heartbeatInterval: 30000ms
   * - heartbeatTimeout: 5000ms
   *
   * @example
   * ```typescript
   * const formatter = new PolymarketMessageFormatter(logger);
   * const parser = new PolymarketMessageParser(logger);
   *
   * const transport = new BaseWebSocketTransport(
   *   { url: 'wss://...', reconnectDelay: 1000 },
   *   formatter,
   *   parser,
   *   logger
   * );
   * ```
   */
  constructor(
    config: BaseWebSocketConfig,
    formatter: IMessageFormatter,
    parser: IMessageParser,
    logger: ILogger
  ) {
    super();

    if (!config || !config.url) {
      throw new Error('config with url is required');
    }
    if (!formatter) {
      throw new Error('formatter is required');
    }
    if (!parser) {
      throw new Error('parser is required');
    }
    if (!logger) {
      throw new Error('logger is required');
    }

    // Apply defaults
    this.config = {
      url: config.url,
      reconnectDelay: config.reconnectDelay ?? 1000,
      maxReconnectDelay: config.maxReconnectDelay ?? 30000,
      heartbeatInterval: config.heartbeatInterval ?? 30000,
      heartbeatTimeout: config.heartbeatTimeout ?? 5000,
    };

    this.formatter = formatter;
    this.parser = parser;
    this.logger = logger.child ? logger.child('BaseWebSocketTransport') : logger;
    this.currentReconnectDelay = this.config.reconnectDelay;
  }

  /**
   * Connect to WebSocket server
   *
   * @returns Promise that resolves when connected
   * @throws {Error} If connection fails
   *
   * @remarks
   * - If already connected or connecting, returns immediately
   * - Emits 'connecting' event when connection attempt starts
   * - Emits 'connected' event when connection succeeds
   * - Automatically starts heartbeat after connection
   * - Automatically resubscribes to all subscriptions after reconnection
   *
   * @example
   * ```typescript
   * try {
   *   await transport.connect();
   *   console.log('Connected to WebSocket');
   * } catch (error) {
   *   console.error('Connection failed:', error);
   * }
   * ```
   */
  public async connect(): Promise<void> {
    if (this.status === 'connected' || this.status === 'connecting') {
      return;
    }

    this.status = 'connecting';
    this.emit('connecting');
    this.logger.debug(`Connecting to WebSocket: ${this.config.url}`);

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.config.url);

        this.ws.on('open', async () => {
          this.status = 'connected';
          this.currentReconnectDelay = this.config.reconnectDelay;
          this.logger.info('WebSocket connected successfully');
          this.startHeartbeat();

          // Wait for WebSocket to be fully ready before resubscribing
          // Prevents "readyState 0 (CONNECTING)" errors
          await new Promise(resolve => setTimeout(resolve, 100));

          this.resubscribeAll();
          this.emit('connected');
          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          this.handleMessage(data);
        });

        this.ws.on('close', () => {
          this.handleClose();
        });

        this.ws.on('error', (error: Error) => {
          this.emit('error', error);
          if (this.status === 'connecting') {
            reject(error);
          }
        });

        this.ws.on('pong', () => {
          this.handlePong();
        });
      } catch (error) {
        this.status = 'disconnected';
        reject(error);
      }
    });
  }

  /**
   * Disconnect from WebSocket server
   *
   * @returns Promise that resolves when disconnected
   *
   * @remarks
   * - Stops heartbeat
   * - Clears reconnection timer
   * - Closes WebSocket connection
   * - Sets status to 'closed' (prevents automatic reconnection)
   * - Emits 'disconnected' event
   *
   * @example
   * ```typescript
   * await transport.disconnect();
   * console.log('Disconnected');
   * ```
   */
  public async disconnect(): Promise<void> {
    this.isShuttingDown = true;
    this.stopHeartbeat();
    this.clearReconnectTimer();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.status = 'closed';
    this.emit('disconnected');
  }

  /**
   * Reconnect for new subscription (clears old subscriptions)
   *
   * @returns Promise that resolves when reconnected
   * @throws {Error} If reconnection fails
   *
   * @remarks
   * Some exchanges (e.g., Polymarket) don't support dynamic subscription changes.
   * This method:
   * 1. Clears all old subscriptions
   * 2. Closes current connection
   * 3. Waits 500ms
   * 4. Reconnects (resubscribeAll will NOT restore old subscriptions)
   *
   * After calling this, you must manually subscribe again.
   *
   * @example
   * ```typescript
   * await transport.reconnectForNewSubscription();
   * await transport.subscribe('market', { assets_ids: newTokens });
   * ```
   */
  public async reconnectForNewSubscription(): Promise<void> {
    this.logger.info('Reconnecting for new subscription...');

    // Clear old subscriptions BEFORE reconnect
    // Otherwise resubscribeAll() will try to restore them
    const oldCount = this.subscriptions.size;
    this.subscriptions.clear();
    this.logger.debug('Cleared old subscriptions before reconnect', { oldCount });

    // Close current connection
    if (this.ws && this.status === 'connected') {
      this.ws.close();
      this.ws = null;
      this.status = 'disconnected';
    }

    // Wait before reconnecting
    await new Promise(resolve => setTimeout(resolve, 500));

    // Reconnect (resubscribeAll will do nothing - subscriptions cleared)
    await this.connect();

    this.logger.info('Reconnected - ready for new subscription');
  }

  /**
   * Subscribe to a channel
   *
   * @param channel - Channel name (exchange-specific)
   * @param params - Subscription parameters (exchange-specific)
   * @returns Promise that resolves when subscription message sent
   *
   * @remarks
   * - Delegates message formatting to IMessageFormatter
   * - Tracks subscription for automatic resubscription after reconnect
   * - Only sends if connected and WebSocket is open
   * - Logs warning if not connected
   *
   * Flow:
   * 1. Create subscription key (channel + params)
   * 2. Add to subscriptions set (for resubscribeAll)
   * 3. Format message using formatter.formatSubscription()
   * 4. Send via WebSocket
   *
   * @example
   * ```typescript
   * await transport.subscribe('market', {
   *   assets_ids: ['123', '456'],
   *   type: 'market',
   * });
   * ```
   */
  public async subscribe(channel: string, params: SubscriptionParams): Promise<void> {
    const subscriptionKey = this.getSubscriptionKey(channel, params);
    this.subscriptions.add(subscriptionKey);

    this.logger.debug('Subscribe called', { channel, params, status: this.status });

    // Check both status AND WebSocket readyState
    if (this.status === 'connected' && this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        // Delegate formatting to exchange-specific formatter
        const message = this.formatter.formatSubscription(channel, params);
        this.logger.debug('Sending subscription', { channel, message: message.substring(0, 200) });
        this.ws.send(message);
      } catch (error) {
        this.logger.error('Failed to format/send subscription', { error, channel, params });
        throw error;
      }
    } else {
      this.logger.warn('Cannot subscribe - not connected', { status: this.status });
    }
  }

  /**
   * Unsubscribe from a channel
   *
   * @param channel - Channel name
   * @param params - Subscription parameters
   * @returns Promise that resolves when unsubscription message sent
   *
   * @remarks
   * - Removes subscription from tracking (won't be restored on reconnect)
   * - Delegates message formatting to IMessageFormatter
   *
   * @example
   * ```typescript
   * await transport.unsubscribe('market', { assets_ids: ['123'] });
   * ```
   */
  public async unsubscribe(channel: string, params: SubscriptionParams): Promise<void> {
    const subscriptionKey = this.getSubscriptionKey(channel, params);
    this.subscriptions.delete(subscriptionKey);

    if (this.status === 'connected' && this.ws) {
      try {
        // Delegate formatting to exchange-specific formatter
        const message = this.formatter.formatUnsubscription(channel, params);
        this.logger.debug('Sending unsubscription', { channel, message: message.substring(0, 200) });
        this.ws.send(message);
      } catch (error) {
        this.logger.error('Failed to format/send unsubscription', { error, channel, params });
        throw error;
      }
    }
  }

  /**
   * Get current connection status
   *
   * @returns Connection status
   *
   * @example
   * ```typescript
   * const status = transport.getStatus();
   * if (status === 'connected') {
   *   console.log('Ready to subscribe');
   * }
   * ```
   */
  public getStatus(): ConnectionStatus {
    return this.status;
  }

  /**
   * Check if connected
   *
   * @returns true if connected
   *
   * @example
   * ```typescript
   * if (transport.isConnected()) {
   *   await transport.subscribe('market', { ... });
   * }
   * ```
   */
  public isConnected(): boolean {
    return this.status === 'connected';
  }

  /**
   * Handle incoming WebSocket message
   *
   * @param data - Raw WebSocket data
   *
   * @remarks
   * CRITICAL EVENT ORDER (for DataCollector):
   * 1. Emit 'message' event with raw Buffer FIRST
   * 2. Parse message using IMessageParser
   * 3. Handle control messages (pong, error) internally
   * 4. Emit 'raw' event with parsed data
   * 5. Emit type-specific event (orderbook, trade, etc.)
   *
   * This order ensures DataCollector receives raw Buffer before any parsing.
   *
   * Algorithm:
   * 1. Emit raw 'message' event
   * 2. Parse JSON
   * 3. Handle arrays (batch messages)
   * 4. Delegate to processMessage()
   * 5. Log errors for unparseable messages
   *
   * @example
   * ```typescript
   * // Event emission order:
   * // 1. emit('message', Buffer.from('{"event_type":"book",...}'))
   * // 2. emit('raw', { event_type: 'book', ... })
   * // 3. emit('orderbook', { event_type: 'book', ... })
   * ```
   */
  private handleMessage(data: WebSocket.Data): void {
    // CRITICAL: Emit raw message event BEFORE parsing (for router/DataCollector)
    this.emit('message', data);

    try {
      const message = JSON.parse(data.toString()) as any;

      // Handle batch messages (array of messages)
      if (Array.isArray(message)) {
        for (const msg of message) {
          this.processMessage(msg);
        }
      } else {
        this.processMessage(message);
      }
    } catch (error) {
      const rawData = data.toString().trim();

      // Skip empty messages (heartbeat)
      if (rawData === '') {
        return;
      }

      // Handle known text responses from server (not JSON)
      const knownTextResponses = [
        'INVALID OPERATION',
        'ERROR',
        'PONG',
        'OK',
        'UNAUTHORIZED',
        'TOO MANY REQUESTS',
      ];

      if (knownTextResponses.includes(rawData)) {
        // Log as warning (not error) - these are expected server responses
        this.logger.warn('Received text message from server', {
          message: rawData,
        });
        return;
      }

      // Unknown unparseable message - log as error
      this.logger.error('Failed to parse WebSocket message', {
        error: error instanceof Error ? error.message : String(error),
        rawData: rawData.substring(0, 200),
      });
    }
  }

  /**
   * Process a single parsed message
   *
   * @param message - Parsed message object
   *
   * @remarks
   * Delegates message parsing to IMessageParser.
   *
   * Algorithm:
   * 1. Check if message is pong (using parser.isPongMessage)
   *    - If yes: handle pong, return
   * 2. Check if message is error (using parser.isErrorMessage)
   *    - If yes: extract error, emit error event, return
   * 3. Parse message (using parser.parseMessage)
   *    - If null: control message (subscribed, etc.), log and return
   *    - If ParsedMessage: emit 'raw' + type-specific event
   *
   * @example
   * ```typescript
   * processMessage({ event_type: 'book', asset_id: '123', bids: [], asks: [] });
   * // -> emit('raw', message)
   * // -> emit('orderbook', message)
   * ```
   */
  private processMessage(message: any): void {
    try {
      // Check for pong message (using parser)
      if (this.parser.isPongMessage(message)) {
        this.handlePong();
        return;
      }

      // Check for error message (using parser)
      if (this.parser.isErrorMessage(message)) {
        const errorMsg = this.parser.extractErrorMessage(message);
        this.logger.error('WebSocket error message received', { message, errorMsg });
        this.emit('error', new Error(errorMsg || 'Unknown WebSocket error'));
        return;
      }

      // Parse message using exchange-specific parser
      const parsed = this.parser.parseMessage(message);

      if (parsed === null) {
        // Control message (subscribed, unsubscribed, price_change, etc.) - ignore
        // Not logged to reduce noise (price_change events are very frequent)
        return;
      }

      // Emit raw event for DataCollector (BEFORE type-specific event)
      this.emit('raw', message);

      // Emit type-specific event (orderbook, trade, etc.)
      this.emit(parsed.type, message);
    } catch (error) {
      this.logger.error('Failed to process message', { error, message });
    }
  }

  /**
   * Handle connection close
   *
   * @remarks
   * - Stops heartbeat
   * - Emits 'disconnected' event
   * - Schedules reconnection (unless shutting down)
   */
  private handleClose(): void {
    this.status = 'disconnected';
    this.stopHeartbeat();
    this.emit('disconnected');

    if (!this.isShuttingDown) {
      this.scheduleReconnect();
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   *
   * @remarks
   * - Emits 'reconnecting' event with current delay
   * - Doubles delay on each failure (up to maxReconnectDelay)
   * - Resets delay to initial value on successful connection
   */
  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this.status = 'reconnecting';
    this.emit('reconnecting', this.currentReconnectDelay);

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((error) => {
        this.emit('error', error);
        // Increase delay for next attempt (exponential backoff)
        this.currentReconnectDelay = Math.min(
          this.currentReconnectDelay * 2,
          this.config.maxReconnectDelay
        );
        this.scheduleReconnect();
      });
    }, this.currentReconnectDelay);
  }

  /**
   * Clear reconnection timer
   */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Start heartbeat mechanism
   *
   * @remarks
   * - Sends ping every heartbeatInterval
   * - Sets timeout for pong response
   * - Terminates connection if pong not received
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();

    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.status === 'connected') {
        this.ws.ping();

        // Set timeout for pong response
        this.heartbeatTimeoutTimer = setTimeout(() => {
          // If pong not received - terminate connection
          this.logger.warn('Heartbeat timeout - terminating connection');
          this.ws?.terminate();
        }, this.config.heartbeatTimeout);
      }
    }, this.config.heartbeatInterval);
  }

  /**
   * Stop heartbeat mechanism
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  /**
   * Handle pong from server
   *
   * @remarks
   * Clears heartbeat timeout (connection is alive)
   */
  private handlePong(): void {
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  /**
   * Resubscribe to all tracked subscriptions
   *
   * @remarks
   * Called automatically after reconnection.
   * Iterates over all subscriptions and sends subscribe messages.
   */
  private resubscribeAll(): void {
    if (this.subscriptions.size === 0) {
      return;
    }

    this.logger.debug('Resubscribing to all subscriptions', { count: this.subscriptions.size });

    this.subscriptions.forEach((subscriptionKey) => {
      const [channel, paramsJson] = subscriptionKey.split('::');
      const params = JSON.parse(paramsJson) as SubscriptionParams;

      if (this.ws && this.status === 'connected') {
        try {
          const message = this.formatter.formatSubscription(channel, params);
          this.ws.send(message);
        } catch (error) {
          this.logger.error('Failed to resubscribe', { error, channel, params });
        }
      }
    });
  }

  /**
   * Create subscription key
   *
   * @param channel - Channel name
   * @param params - Subscription parameters
   * @returns Unique subscription key
   *
   * @remarks
   * Format: `channel::JSON.stringify(params)`
   * Used for tracking and deduplication.
   */
  private getSubscriptionKey(channel: string, params: SubscriptionParams): string {
    return `${channel}::${JSON.stringify(params)}`;
  }
}
