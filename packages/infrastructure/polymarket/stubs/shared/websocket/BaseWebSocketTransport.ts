/**
 * Stub для BaseWebSocketTransport.
 *
 * @remarks
 * INTERNAL STUB — используется PolymarketWebSocketManager до реализации Phase 0.5.
 * После Phase 0.5 будет заменён реальным BaseWebSocketTransport из shared/websocket.
 */
import { EventEmitter } from 'events';
import type { ILogger } from '@polymarket/logger';
import type { BaseWebSocketConfig, SubscriptionParams } from './types.js';
import type { IMessageFormatter } from './IMessageFormatter.js';
import type { IMessageParser } from './IMessageParser.js';

/**
 * Базовый WebSocket транспорт с EventEmitter.
 *
 * @remarks
 * Stub реализация — все методы бросают "not implemented".
 */
export abstract class BaseWebSocketTransport extends EventEmitter {
  protected readonly config: Required<BaseWebSocketConfig>;
  protected readonly logger: ILogger;

  constructor(
    config: BaseWebSocketConfig,
    protected readonly formatter: IMessageFormatter,
    protected readonly parser: IMessageParser,
    logger: ILogger
  ) {
    super();
    this.config = {
      url: config.url,
      reconnectDelay: config.reconnectDelay ?? 1000,
      maxReconnectDelay: config.maxReconnectDelay ?? 30000,
      heartbeatInterval: config.heartbeatInterval ?? 30000,
      heartbeatTimeout: config.heartbeatTimeout ?? 5000,
      maxReconnectAttempts: config.maxReconnectAttempts ?? 10,
    };
    this.logger = logger;
  }

  async connect(): Promise<void> {
    throw new Error('BaseWebSocketTransport.connect() not implemented');
  }

  async disconnect(): Promise<void> {
    throw new Error('BaseWebSocketTransport.disconnect() not implemented');
  }

  async subscribe(_channel: string, _params: SubscriptionParams): Promise<void> {
    throw new Error('BaseWebSocketTransport.subscribe() not implemented');
  }

  async unsubscribe(_channel: string, _params: SubscriptionParams): Promise<void> {
    throw new Error('BaseWebSocketTransport.unsubscribe() not implemented');
  }
}
