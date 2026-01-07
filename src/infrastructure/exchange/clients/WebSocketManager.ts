/**
 * WebSocket Manager для real-time данных от Polymarket
 *
 * @remarks
 * Управляет WebSocket соединением с Polymarket CLOB.
 * Поддерживает:
 * - Автоматическое переподключение с экспоненциальным backoff
 * - Heartbeat/ping-pong для поддержания соединения
 * - Подписки на каналы (orderbook, trades)
 * - Маршрутизацию сообщений по типам
 * - Graceful shutdown
 *
 * @example
 * ```typescript
 * import { ConsoleLogger } from '../logging/ConsoleLogger.js';
 *
 * const logger = new ConsoleLogger({ level: 'debug' });
 *
 * const ws = new WebSocketManager({
 *   url: 'wss://clob.polymarket.com/ws',
 *   reconnectDelay: 1000,
 *   maxReconnectDelay: 30000,
 *   logger
 * });
 *
 * ws.on('orderbook', (data) => {
 *   logger.info('Orderbook update received', { data });
 * });
 *
 * await ws.connect();
 * await ws.subscribe('orderbook', {
 *   assets_ids: ['0x123...'],
 *   type: 'market'
 * });
 * ```
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import type { ILogger } from '../../../domain/ports/ILogger.js';

/**
 * Конфигурация WebSocket Manager
 */
export interface WebSocketManagerConfig {
  /** URL WebSocket сервера */
  url: string;
  /** Начальная задержка переподключения (мс) */
  reconnectDelay?: number;
  /** Максимальная задержка переподключения (мс) */
  maxReconnectDelay?: number;
  /** Интервал heartbeat (мс) */
  heartbeatInterval?: number;
  /** Таймаут heartbeat (мс) */
  heartbeatTimeout?: number;
  /** Logger для логирования */
  logger?: ILogger;
}

/**
 * Тип WebSocket сообщения
 */
export interface WSMessage {
  /** Тип сообщения */
  type: 'subscribe' | 'unsubscribe' | 'ping' | 'pong' | 'orderbook' | 'trade' | 'error';
  /** Канал */
  channel?: string;
  /** Данные сообщения */
  data?: unknown;
  /** Timestamp */
  timestamp?: number;
}

/**
 * Параметры подписки
 */
export interface SubscribeParams {
  /** ID рынка */
  marketId?: string;
  /** ID токена */
  tokenId?: string;
  /** Asset IDs (token IDs) для подписки - Polymarket format */
  assets_ids?: string[];
  /** Тип подписки - Polymarket format */
  type?: string;
}

/**
 * Статус WebSocket соединения
 */
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'closed';

/**
 * WebSocket Manager
 *
 * @remarks
 * Управляет WebSocket соединением с автоматическим переподключением.
 * Расширяет EventEmitter для событийной модели.
 *
 * События:
 * - `connected` - Успешное подключение
 * - `disconnected` - Отключение
 * - `reconnecting` - Начало переподключения
 * - `error` - Ошибка соединения
 * - `orderbook` - Обновление orderbook
 * - `trade` - Новая сделка
 * - `message` - Любое входящее сообщение
 * - `raw` - Raw data event (book/trade) для DataCollector
 */
export class WebSocketManager extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly reconnectDelay: number;
  private readonly maxReconnectDelay: number;
  private readonly heartbeatInterval: number;
  private readonly heartbeatTimeout: number;
  private readonly logger: ILogger;

  private status: ConnectionStatus = 'disconnected';
  private currentReconnectDelay: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatTimeoutTimer: NodeJS.Timeout | null = null;
  private subscriptions: Set<string> = new Set();
  private isShuttingDown = false;

  /**
   * Создаёт новый WebSocket Manager
   *
   * @param config - Конфигурация
   *
   * @throws {Error} Если logger не предоставлен
   */
  constructor(config: WebSocketManagerConfig) {
    super();
    this.url = config.url;
    this.reconnectDelay = config.reconnectDelay ?? 1000;
    this.maxReconnectDelay = config.maxReconnectDelay ?? 30000;
    this.heartbeatInterval = config.heartbeatInterval ?? 30000;
    this.heartbeatTimeout = config.heartbeatTimeout ?? 5000;
    this.currentReconnectDelay = this.reconnectDelay;

    if (!config.logger) {
      throw new Error('Logger is required for WebSocketManager');
    }
    this.logger = config.logger;
  }

  /**
   * Подключается к WebSocket серверу
   *
   * @returns Promise, который резолвится при успешном подключении
   * @throws {Error} При ошибке подключения
   *
   * @example
   * ```typescript
   * await ws.connect();
   * console.log('Connected to WebSocket');
   * ```
   */
  public async connect(): Promise<void> {
    if (this.status === 'connected' || this.status === 'connecting') {
      return;
    }

    this.status = 'connecting';
    this.emit('connecting');
    this.logger.debug(`Connecting to WebSocket: ${this.url}`);

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);

        this.ws.on('open', async () => {
          this.status = 'connected';
          this.currentReconnectDelay = this.reconnectDelay;
          this.logger.info('WebSocket connected successfully');
          this.startHeartbeat();

          // Wait a bit for WebSocket to be fully ready before resubscribing
          // This prevents "readyState 0 (CONNECTING)" errors
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
   * Отключается от WebSocket сервера
   *
   * @example
   * ```typescript
   * await ws.disconnect();
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
   * Подписывается на канал
   *
   * @param channel - Название канала (orderbook/trade)
   * @param params - Параметры подписки
   * @returns Promise, который резолвится при успешной подписке
   *
   * @remarks
   * Polymarket format: { assets_ids: [tokenId1, tokenId2], type: 'market' }
   *
   * @example
   * ```typescript
   * // Polymarket format
   * await ws.subscribe('orderbook', {
   *   assets_ids: ['0x123...', '0x456...'],
   *   type: 'market'
   * });
   * ```
   */
  public async subscribe(channel: string, params: SubscribeParams): Promise<void> {
    const subscriptionKey = this.getSubscriptionKey(channel, params);
    this.subscriptions.add(subscriptionKey);

    this.logger.debug('Subscribe called', { channel, params, status: this.status });

    // Check both status AND WebSocket readyState
    if (this.status === 'connected' && this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Polymarket format: send params directly (not wrapped)
      if (params.assets_ids) {
        // Check for duplicates
        const uniqueTokens = [...new Set(params.assets_ids)];
        if (uniqueTokens.length !== params.assets_ids.length) {
          this.logger.warn('⚠️  Duplicate tokens detected in subscription!', {
            original: params.assets_ids.length,
            unique: uniqueTokens.length,
            duplicates: params.assets_ids.length - uniqueTokens.length,
          });
        }

        // Validate token format (should be numeric strings)
        const invalidTokens = uniqueTokens.filter(t => !/^\d+$/.test(t));
        if (invalidTokens.length > 0) {
          this.logger.error('❌ Invalid token format detected!', {
            invalidCount: invalidTokens.length,
            examples: invalidTokens.slice(0, 3),
            hint: 'Tokens must be numeric strings'
          });
        }

        // Polymarket subscription format - just assets_ids and type
        const subscription = {
          assets_ids: uniqueTokens, // Use unique tokens only
          type: params.type || 'market',
        };

        const subscriptionJson = JSON.stringify(subscription);

        this.logger.info('📡 Subscribing to WebSocket', {
          tokenCount: uniqueTokens.length,
          tokens: uniqueTokens.map(t => t.substring(0, 16) + '...'),
          fullTokens: uniqueTokens, // Full tokens for debugging
          jsonPayload: subscriptionJson.substring(0, 500) + '...' // First 500 chars
        });

        this.ws.send(subscriptionJson);
        this.logger.info('✅ Subscription JSON sent');
      } else {
        // Fallback to custom format
        const message: WSMessage = {
          type: 'subscribe',
          channel,
          data: params,
          timestamp: Date.now(),
        };
        this.send(message);
      }
    } else {
      this.logger.warn('Cannot subscribe - not connected', { status: this.status });
    }
  }

  /**
   * Отписывается от канала
   *
   * @param channel - Название канала
   * @param params - Параметры подписки
   *
   * @example
   * ```typescript
   * await ws.unsubscribe('orderbook', { marketId: '0x123...' });
   * ```
   */
  public async unsubscribe(channel: string, params: SubscribeParams): Promise<void> {
    const subscriptionKey = this.getSubscriptionKey(channel, params);
    this.subscriptions.delete(subscriptionKey);

    if (this.status === 'connected' && this.ws) {
      // Polymarket format: send params directly (not wrapped)
      if (params.assets_ids) {
        // Polymarket unsubscription format - just assets_ids and type
        const unsubscription = {
          assets_ids: params.assets_ids,
          type: params.type || 'market',
        };
        this.logger.debug('Sending unsubscription', { unsubscription });
        this.ws.send(JSON.stringify(unsubscription));
      } else {
        // Fallback to custom format
        const message: WSMessage = {
          type: 'unsubscribe',
          channel,
          data: params,
          timestamp: Date.now(),
        };

        this.send(message);
      }
    }
  }

  /**
   * Возвращает текущий статус соединения
   *
   * @returns Статус соединения
   */
  public getStatus(): ConnectionStatus {
    return this.status;
  }

  /**
   * Проверяет, подключен ли WebSocket
   *
   * @returns true если подключен
   */
  public isConnected(): boolean {
    return this.status === 'connected';
  }

  /**
   * Переподключается к WebSocket (для смены подписки)
   *
   * @remarks
   * Polymarket WebSocket не поддерживает динамическую смену подписки.
   * При изменении списка маркетов нужно переподключиться.
   *
   * ВАЖНО: Очищаем старые подписки ПЕРЕД reconnect, чтобы избежать
   * попытки resubscribeAll() переподписаться на старые подписки.
   *
   * @example
   * ```typescript
   * await wsManager.reconnectForNewSubscription();
   * await wsManager.subscribe('market', { assets_ids: newTokens });
   * ```
   */
  public async reconnectForNewSubscription(): Promise<void> {
    this.logger.info('🔄 Reconnecting WebSocket for new subscription...');

    // ✅ ВАЖНО: Очищаем старые подписки ПЕРЕД reconnect
    // Иначе resubscribeAll() попытается переподписаться на старые подписки
    // и получим INVALID OPERATION
    const oldSubscriptionsCount = this.subscriptions.size;
    this.subscriptions.clear();
    this.logger.debug('Cleared old subscriptions before reconnect', { oldCount: oldSubscriptionsCount });

    // Закрываем текущее соединение
    if (this.ws && this.status === 'connected') {
      this.ws.close();
      this.ws = null;
      this.status = 'disconnected';
    }

    // Ждем немного перед переподключением
    await new Promise(resolve => setTimeout(resolve, 500));

    // Переподключаемся (resubscribeAll не сработает - Map пустая)
    await this.connect();

    this.logger.info('✅ Reconnected - ready for new subscription');
  }

  /**
   * Отправляет сообщение через WebSocket
   *
   * @param message - Сообщение для отправки
   * @throws {Error} Если соединение не установлено
   */
  private send(message: WSMessage): void {
    if (!this.ws || this.status !== 'connected') {
      throw new Error('WebSocket is not connected');
    }

    this.ws.send(JSON.stringify(message));
  }

  /**
   * Обрабатывает сырые WebSocket данные
   *
   * @param data - Сырые данные от WebSocket
   *
   * @remarks
   * Алгоритм:
   * 1. Парсит JSON из data
   * 2. Проверяет, является ли сообщение массивом
   * 3. Если массив — обрабатывает каждый элемент отдельно (Polymarket может отправлять batch updates)
   * 4. Если одиночное сообщение — обрабатывает его
   *
   * @example
   * ```typescript
   * // Одиночное сообщение:
   * { event_type: 'book', asset_id: '...', bids: [...], asks: [...] }
   *
   * // Batch (массив):
   * [
   *   { event_type: 'book', asset_id: '...', ... },
   *   { event_type: 'trade', asset_id: '...', ... }
   * ]
   * ```
   */
  private handleMessage(data: WebSocket.Data): void {
    // Emit raw message event BEFORE parsing (for router)
    this.emit('message', data);

    try {
      const message = JSON.parse(data.toString()) as any;
      if(Array.isArray(message)) {
        for (const msg of message) {
          this.processMessage(msg);
        }
      } else {
        this.processMessage(message);
      }
    } catch (error) {
      const rawData = data.toString().trim();

      // Пропускаем пустые сообщения (heartbeat)
      if (rawData === '') {
        return;
      }

      // Известные ошибки от Polymarket - логируем как warning, не error
      const knownErrors = ['INVALID OPERATION', 'RATE_LIMIT', 'UNAUTHORIZED'];
      const isKnownError = knownErrors.some(e => rawData.includes(e));

      if (isKnownError) {
        this.logger.error('❌ Polymarket WebSocket rejected subscription!', {
          errorMessage: rawData,
          fullMessage: rawData,
          status: this.status,
          activeSubscriptions: this.subscriptions.size,
          hint: 'Check if subscription format is correct or if Polymarket API changed'
        });
      } else {
        this.logger.error('Failed to parse WebSocket message', {
          error: error instanceof Error ? error.message : String(error),
          rawData: rawData.substring(0, 200),
        });
      }
    }
  }

  /**
   * Обрабатывает входящее сообщение
   *
   * @param message - Объект сообщения (уже распарсенный JSON)
   *
   * @remarks
   * Адаптировано под реальный формат Polymarket WebSocket.
   *
   * Форматы сообщений:
   * - Data events (имеют asset_id):
   *   - `book`: { event_type: 'book', asset_id: '...', bids: [{price: '0.5', size: '10'}, ...], asks: [...], timestamp: 1234567890 }
   *   - `trade`: { event_type: 'trade', asset_id: '...', price: '0.5', size: '10', side: 'BUY', timestamp: ... }
   *   - `last_trade_price`: { event_type: 'last_trade_price', asset_id: '...', price: '0.5', size: '10' }
   *
   * - Control events (без asset_id):
   *   - `pong`: { event_type: 'pong' }
   *   - `error`: { event_type: 'error', message: '...', data: {...} }
   *   - `subscribed`: { event_type: 'subscribed', channel: '...', params: {...} }
   *   - `price_change`: { event_type: 'price_change', ... } (игнорируется)
   *
   * Алгоритм routing:
   * 1. Emit generic 'message' event для всех сообщений
   * 2. Извлекаем event_type и asset_id
   * 3. Для control events (pong, error, subscribed) — обрабатываем сразу
   * 4. Для data events (book, trade) — проверяем наличие asset_id и валидных данных
   * 5. Route message по типу через emit()
   *
   * @example
   * ```typescript
   * // Orderbook update
   * processMessage({
   *   event_type: 'book',
   *   asset_id: '67704255197116168826604911233626301865010283966205730455742704536521111535950',
   *   bids: [{price: '0.52', size: '100'}, {price: '0.51', size: '200'}],
   *   asks: [{price: '0.53', size: '150'}, {price: '0.54', size: '250'}],
   *   timestamp: 1766875759895
   * });
   * // -> emit('orderbook', message)
   *
   * // Trade update
   * processMessage({
   *   event_type: 'trade',
   *   asset_id: '67704255197116168826604911233626301865010283966205730455742704536521111535950',
   *   price: '0.52',
   *   size: '50',
   *   side: 'BUY',
   *   timestamp: 1766875759895
   * });
   * // -> emit('trade', message)
   * ```
   */
  private processMessage(message: any): void {
    try {
      // Polymarket WebSocket format
      const eventType = message.event_type || message.type;
      const tokenId = message.asset_id || message.market;

      // Handle control messages (без asset_id)
      if (eventType === 'pong') {
        this.handlePong();
        return;
      }

      if (eventType === 'error') {
        this.logger.error('WebSocket error message received', { message });
        this.emit('error', new Error(String(message.data || message.message || 'Unknown WebSocket error')));
        return;
      }

      if (eventType === 'subscribed' || eventType === 'unsubscribed') {
        // Subscription confirmation
        this.logger.debug('Subscription event', { eventType, message });
        return;
      }

      // Handle price_change events separately (different structure)
      if (eventType === 'price_change') {
        // price_change has array of price_changes, not single asset_id
        // Skip for now - not needed for trading or data collection
        this.logger.trace('Skipping price_change event', {
          market: message.market?.substring(0, 16) + '...',
          changes: message.price_changes?.length
        });
        return;
      }

      // Handle tick_size_change events (market configuration changes)
      if (eventType === 'tick_size_change') {
        // tick_size_change - skip, not needed for trading or data collection
        this.logger.trace('Skipping tick_size_change event', {
          market: message.market?.substring(0, 16) + '...'
        });
        return;
      }

      if (!tokenId) {
        // Data message without asset_id
        this.logger.warn('Message without tokenId', { eventType, message });
        return;
      }

      // Emit raw event for DataCollector (before routing)
      // Includes: book, trade, last_trade_price - all data events with asset_id
      this.emit('raw', message);

      // Route by event type
      if (eventType === 'book') {
        // Orderbook update
        this.emit('orderbook', message);
      } else if (eventType === 'trade' || eventType === 'last_trade_price') {
        // Trade update - проверяем наличие обязательных полей
        if (message.price && message.size) {
          this.emit('trade', message);
        }
      } else {
        this.logger.debug('Unknown event type', { eventType, tokenId: tokenId?.substring(0, 16) });
      }
    } catch (error) {
      this.logger.error('Failed to process message', { error, message });
    }
  }

  /**
   * Обрабатывает закрытие соединения
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
   * Планирует переподключение с экспоненциальным backoff
   */
  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this.status = 'reconnecting';
    this.emit('reconnecting', this.currentReconnectDelay);

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((error) => {
        this.emit('error', error);
        // Увеличиваем задержку для следующей попытки
        this.currentReconnectDelay = Math.min(
          this.currentReconnectDelay * 2,
          this.maxReconnectDelay
        );
        this.scheduleReconnect();
      });
    }, this.currentReconnectDelay);
  }

  /**
   * Очищает таймер переподключения
   */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Запускает heartbeat для поддержания соединения
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();

    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.status === 'connected') {
        this.ws.ping();

        // Устанавливаем таймаут для pong
        this.heartbeatTimeoutTimer = setTimeout(() => {
          // Если pong не получен - закрываем соединение
          this.ws?.terminate();
        }, this.heartbeatTimeout);
      }
    }, this.heartbeatInterval);
  }

  /**
   * Останавливает heartbeat
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
   * Обрабатывает pong от сервера
   */
  private handlePong(): void {
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  /**
   * Переподписывается на все каналы после переподключения
   */
  private resubscribeAll(): void {
    this.subscriptions.forEach((subscriptionKey) => {
      const [channel, paramsJson] = subscriptionKey.split('::');
      const params = JSON.parse(paramsJson) as SubscribeParams;

      const message: WSMessage = {
        type: 'subscribe',
        channel,
        data: params,
        timestamp: Date.now(),
      };

      if (this.ws && this.status === 'connected') {
        this.send(message);
      }
    });
  }

  /**
   * Создаёт ключ подписки
   *
   * @param channel - Название канала
   * @param params - Параметры подписки
   * @returns Уникальный ключ
   */
  private getSubscriptionKey(channel: string, params: SubscribeParams): string {
    return `${channel}::${JSON.stringify(params)}`;
  }
}
