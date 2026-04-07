/**
 * BaseWebSocketTransport — Exchange-agnostic WebSocket transport.
 *
 * @remarks
 * Адаптация из polymarket-v3 для использования встроенного WebSocket Node.js 21+
 * вместо пакета `ws`. API идентичен оригиналу.
 *
 * ### Алгоритм:
 * - `connect()` — открывает соединение, запускает heartbeat, восстанавливает подписки
 * - `disconnect()` — ставит `isShuttingDown = true`, закрывает WS (нет авто-реконнекта)
 * - `reconnectForNewSubscription()` — сбрасывает подписки, переподключается
 * - `subscribe()` — кэширует подписку и отправляет если подключены
 * - `unsubscribe()` — удаляет из кэша и отправляет если подключены
 * - Авто-реконнект с экспоненциальным backoff при случайном закрытии
 *
 * ### События:
 * - `connected` — WS открыт
 * - `disconnected` — WS закрыт
 * - `reconnecting` — начало попытки переподключения
 * - `error` — ошибка
 * - `message` — raw данные (Buffer/string, эмитируется ПЕРВЫМ)
 * - `raw` — распарсенный объект
 * - `orderbook` — payload события типа 'orderbook'
 * - `trade` — payload события типа 'trade'
 */
import { EventEmitter } from 'events';
import type { ILogger } from '@polymarket/logger';
import type { BaseWebSocketConfig, ConnectionStatus, SubscriptionParams } from './types.js';
import type { IMessageFormatter } from './IMessageFormatter.js';
import type { IMessageParser } from './IMessageParser.js';

/**
 * Базовый WebSocket транспорт — конкретный класс (не абстрактный).
 *
 * @remarks
 * Расширяется `PolymarketWebSocketManager` для добавления Polymarket-специфичных методов.
 */
export abstract class BaseWebSocketTransport extends EventEmitter {
  private _ws: WebSocket | null = null;
  protected readonly config: Required<BaseWebSocketConfig>;
  protected readonly logger: ILogger;

  private _status: ConnectionStatus = 'disconnected';
  private _currentReconnectDelay: number;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _isShuttingDown = false;

  /**
   * Кэш подписок для авто-восстановления после реконнекта.
   * Ключ: `channel::JSON.stringify(params)`
   */
  private readonly _subscriptions = new Set<string>();

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
    this._currentReconnectDelay = this.config.reconnectDelay;
  }

  /**
   * Подключается к WebSocket-серверу.
   *
   * @returns Promise, разрешается при открытии соединения
   * @throws {Error} Если подключение не удалось
   *
   * @example
   * ```typescript
   * await transport.connect();
   * ```
   */
  async connect(): Promise<void> {
    if (this._status === 'connected' || this._status === 'connecting') {
      return;
    }

    this._status = 'connecting';
    this._isShuttingDown = false;
    this.emit('connecting');
    this.logger.debug('Connecting to WebSocket', { url: this.config.url });

    return new Promise((resolve, reject) => {
      try {
        this._ws = new WebSocket(this.config.url);

        this._ws.onopen = async () => {
          this._status = 'connected';
          this._currentReconnectDelay = this.config.reconnectDelay;
          this.logger.info('WebSocket connected', { url: this.config.url });
          this._startHeartbeat();

          // Небольшая пауза перед переподпиской (предотвращает readyState=0 ошибки)
          await new Promise(r => setTimeout(r, 100));

          this._resubscribeAll();
          this.emit('connected');
          resolve();
        };

        this._ws.onmessage = (event: MessageEvent) => {
          this._handleMessage(event.data);
        };

        this._ws.onclose = () => {
          this._handleClose();
        };

        this._ws.onerror = () => {
          const err = new Error('WebSocket error');
          this.logger.error('WebSocket error', { url: this.config.url });
          this.emit('error', err);
          if (this._status === 'connecting') {
            reject(err);
            // Страховка: если onclose не сработает (undici может пропустить close-event
            // при ошибке TCP/TLS handshake до открытия соединения), планируем reconnect вручную.
            // Задержка 200ms даёт onclose шанс сработать первым — двойной вызов _handleClose
            // безопасен (повторный _scheduleReconnect очищает предыдущий таймер).
            setTimeout(() => {
              if (this._status !== 'connected' && this._status !== 'reconnecting' && !this._isShuttingDown) {
                this.logger.debug('onerror fallback: onclose did not fire, scheduling reconnect manually');
                this._handleClose();
              }
            }, 200);
          }
        };
      } catch (err) {
        this._status = 'disconnected';
        reject(err);
      }
    });
  }

  /**
   * Отключается от WebSocket-сервера (не запускает авто-реконнект).
   *
   * @returns Promise, разрешается при закрытии соединения
   *
   * @example
   * ```typescript
   * await transport.disconnect();
   * ```
   */
  async disconnect(): Promise<void> {
    this._isShuttingDown = true;
    this._stopHeartbeat();
    this._clearReconnectTimer();

    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }

    this._status = 'disconnected';
    this.emit('disconnected');
  }

  /**
   * Переподключается для смены подписок (сбрасывает кэш подписок).
   *
   * @returns Promise, разрешается при успешном подключении
   *
   * @remarks
   * Используется когда биржа не поддерживает динамическое изменение подписок.
   * После вызова необходимо заново вызвать `subscribe()`.
   *
   * @example
   * ```typescript
   * await transport.reconnectForNewSubscription();
   * await transport.subscribe('market', { assets_ids: newTokens });
   * ```
   */
  async reconnectForNewSubscription(): Promise<void> {
    this.logger.info('Reconnecting for new subscription');

    // Очищаем старые подписки ДО реконнекта (resubscribeAll не восстановит их)
    const oldCount = this._subscriptions.size;
    this._subscriptions.clear();
    this.logger.debug('Cleared subscriptions before reconnect', { oldCount });

    if (this._ws && this._status === 'connected') {
      this._ws.close();
      this._ws = null;
      this._status = 'disconnected';
    }

    await new Promise(r => setTimeout(r, 500));
    await this.connect();
    this.logger.info('Reconnected — ready for new subscription');
  }

  /**
   * Подписывается на канал.
   *
   * @param channel - Имя канала
   * @param params - Параметры подписки
   *
   * @remarks
   * Заменяет предыдущую подписку для того же канала — Polymarket заменяет
   * подписку при каждом вызове, поэтому кэшируем только последнее состояние.
   * Без этого `_subscriptions` накапливает устаревшие ключи, и при реконнекте
   * отправляются все промежуточные варианты с разным количеством токенов.
   *
   * @example
   * ```typescript
   * await transport.subscribe('market', { assets_ids: ['123...'], type: 'market' });
   * ```
   */
  async subscribe(channel: string, params: SubscriptionParams): Promise<void> {
    // Удаляем все предыдущие подписки для этого канала:
    // биржа заменяет подписку при каждом вызове, поэтому достаточно хранить последнюю.
    const prefix = `${channel}::`;
    for (const existing of this._subscriptions) {
      if (existing.startsWith(prefix)) {
        this._subscriptions.delete(existing);
      }
    }
    const key = this._subscriptionKey(channel, params);
    this._subscriptions.add(key);

    if (this._status === 'connected' && this._ws && this._ws.readyState === WebSocket.OPEN) {
      try {
        const message = this.formatter.formatSubscription(channel, params);
        this._ws.send(message);
      } catch (err) {
        this.logger.error('Failed to send subscription', {
          err: err instanceof Error ? err.message : String(err),
          channel,
        });
        throw err;
      }
    } else {
      this.logger.debug('Subscribe queued (not connected)', { channel, status: this._status });
    }
  }

  /**
   * Отписывается от канала.
   *
   * @param channel - Имя канала
   * @param params - Параметры отписки
   *
   * @example
   * ```typescript
   * await transport.unsubscribe('market', { assets_ids: ['123...'], type: 'market' });
   * ```
   */
  async unsubscribe(channel: string, params: SubscriptionParams): Promise<void> {
    const key = this._subscriptionKey(channel, params);
    this._subscriptions.delete(key);

    if (this._status === 'connected' && this._ws) {
      try {
        const message = this.formatter.formatUnsubscription(channel, params);
        this._ws.send(message);
      } catch (err) {
        this.logger.error('Failed to send unsubscription', {
          err: err instanceof Error ? err.message : String(err),
          channel,
        });
      }
    }
  }

  /**
   * Возвращает текущий статус соединения.
   */
  getStatus(): ConnectionStatus {
    return this._status;
  }

  /**
   * Возвращает true если подключены.
   */
  isConnected(): boolean {
    return this._status === 'connected';
  }

  // ─── Приватные методы ─────────────────────────────────────────────────────

  private _handleClose(): void {
    this._status = 'disconnected';
    this._stopHeartbeat();
    this.emit('disconnected');

    if (!this._isShuttingDown) {
      this._scheduleReconnect();
    }
  }

  private _handleMessage(data: unknown): void {
    // Эмитируем сырые данные ПЕРВЫМИ (для DataCollector)
    this.emit('message', data);

    try {
      const rawStr = typeof data === 'string' ? data : String(data);
      const trimmed = rawStr.trim();

      if (trimmed === '') return;

      // Текстовые ответы сервера (не JSON)
      const knownTextResponses = ['INVALID OPERATION', 'ERROR', 'PONG', 'OK', 'UNAUTHORIZED', 'TOO MANY REQUESTS'];
      if (knownTextResponses.includes(trimmed)) {
        this.logger.debug('Text response from server', { message: trimmed });
        return;
      }

      const parsed = JSON.parse(rawStr);
      const messages = Array.isArray(parsed) ? parsed : [parsed];

      for (const msg of messages) {
        this._processMessage(msg);
      }
    } catch (err) {
      this.logger.error('Failed to parse WebSocket message', {
        err: err instanceof Error ? err.message : String(err),
        preview: String(data).substring(0, 200),
      });
    }
  }

  private _processMessage(message: unknown): void {
    try {
      if (this.parser.isPong?.(message)) {
        this.logger.debug('Pong received');
        return;
      }

      if (this.parser.isError?.(message)) {
        const errText = this.parser.getErrorText?.(message) ?? 'Unknown WS error';
        this.logger.error('WS error message', { error: errText });
        this.emit('error', new Error(errText));
        return;
      }

      const result = this.parser.parseMessage(message);
      if (!result) return;

      this.emit('raw', message);
      this.emit(result.type, message);
    } catch (err) {
      this.logger.error('Failed to process message', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private _resubscribeAll(): void {
    if (this._subscriptions.size === 0) return;

    this.logger.debug('Resubscribing to all subscriptions', { count: this._subscriptions.size });

    for (const key of this._subscriptions) {
      const delimIdx = key.indexOf('::');
      const channel = key.substring(0, delimIdx);
      const paramsJson = key.substring(delimIdx + 2);
      const params = JSON.parse(paramsJson) as SubscriptionParams;

      if (this._ws && this._status === 'connected' && this._ws.readyState === WebSocket.OPEN) {
        try {
          const message = this.formatter.formatSubscription(channel, params);
          this._ws.send(message);
        } catch (err) {
          this.logger.error('Failed to resubscribe', {
            channel,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  private _scheduleReconnect(): void {
    this._clearReconnectTimer();
    this._status = 'reconnecting';
    this.emit('reconnecting', this._currentReconnectDelay);

    this.logger.info('Scheduling reconnect', { delayMs: this._currentReconnectDelay });

    this._reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => {
        this.emit('error', err);
        this._currentReconnectDelay = Math.min(
          this._currentReconnectDelay * 2,
          this.config.maxReconnectDelay,
        );
        this._scheduleReconnect();
      });
    }, this._currentReconnectDelay);
  }

  private _clearReconnectTimer(): void {
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  private _startHeartbeat(): void {
    this._stopHeartbeat();

    this._heartbeatTimer = setInterval(() => {
      if (this._ws && this._status === 'connected' && this._ws.readyState === WebSocket.OPEN) {
        // Polymarket использует текстовый PING (не WS-протокольный ping)
        this._ws.send('PING');
        this.logger.debug('Heartbeat PING sent');
      }
    }, this.config.heartbeatInterval);
  }

  private _stopHeartbeat(): void {
    if (this._heartbeatTimer !== null) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  private _subscriptionKey(channel: string, params: SubscriptionParams): string {
    return `${channel}::${JSON.stringify(params)}`;
  }
}
