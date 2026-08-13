/**
 * PolymarketWebSocketManager — transport-only WebSocket manager for Polymarket.
 *
 * @remarks
 * This class formats outgoing subscription messages and emits raw incoming
 * WebSocket frames through `message`. Incoming Polymarket messages are parsed
 * only by PolymarketMessageRouter inside PolymarketWsAdapter.
 */
import type { ILogger } from '@polymarket/logger';
import type { BaseWebSocketConfig, ConnectionStatus } from '../stubs/shared/websocket/types.js';
import { BaseWebSocketTransport } from '../stubs/shared/websocket/BaseWebSocketTransport.js';
import { PolymarketMessageFormatter } from './PolymarketMessageFormatter.js';

/**
 * Конфигурация WebSocket для Polymarket.
 */
export interface PolymarketWebSocketConfig extends BaseWebSocketConfig {
  /** URL WebSocket (по умолчанию: wss://ws-subscriptions-clob.polymarket.com/ws/market) */
  url: string;
}

/**
 * Polymarket-specific transport wrapper.
 *
 * @remarks
 * Public market/user event callbacks live on PolymarketWsAdapter. This manager
 * deliberately does not emit parsed `orderbook`, `trade`, or `raw` events.
 */
export class PolymarketWebSocketManager extends BaseWebSocketTransport {
  constructor(config: PolymarketWebSocketConfig, logger: ILogger) {
    const formatter = new PolymarketMessageFormatter(logger);
    super(config, formatter, logger);
  }

  /**
   * Подписывается на обновления токенов.
   */
  public async subscribeToTokens(tokenIds: string[]): Promise<void> {
    return this.subscribe('market', {
      assets_ids: tokenIds,
      type: 'market',
    });
  }

  /**
   * Отписывается от обновлений токенов.
   */
  public async unsubscribeFromTokens(tokenIds: string[]): Promise<void> {
    return this.unsubscribe('market', {
      assets_ids: tokenIds,
      type: 'market',
    });
  }

  /**
   * Переподключается для изменения подписок.
   */
  public async reconnectForNewSubscription(): Promise<void> {
    await this.disconnect();
    await this.connect();
  }

  /**
   * Возвращает текущий статус соединения.
   */
  public getStatus(): ConnectionStatus {
    return super.getStatus();
  }

  /**
   * Проверяет подключён ли WebSocket.
   */
  public isConnected(): boolean {
    return super.isConnected();
  }
}

export type { ConnectionStatus } from '../stubs/shared/websocket/types.js';
export type { SubscriptionParams } from '../stubs/shared/websocket/types.js';
