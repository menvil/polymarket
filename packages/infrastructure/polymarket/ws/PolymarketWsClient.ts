/**
 * PolymarketWsClient - Транспортный слой для Polymarket WebSocket
 *
 * @remarks
 * Чистая обёртка вокруг WebSocketManager, предоставляющая:
 * - Чистые транспортные операции (connect/disconnect/subscribe)
 * - Обёртку с timeout для операций переподключения
 * - EventEmitter интерфейс для raw WebSocket событий
 * - Никакой логики парсинга или domain логики (обрабатывается Router)
 *
 * Ответственность:
 * - Управление жизненным циклом WebSocket соединения
 * - Пересылка raw событий от WebSocketManager
 * - Защита от зависания при переподключении (timeout)
 * - Чистый API для управления подписками
 *
 * НЕ отвечает за:
 * - Парсинг сообщений (обрабатывается Router)
 * - Управление callbacks (обрабатывается SubscriptionRegistry)
 * - Создание domain entities (обрабатывается Adapter)
 *
 * @example
 * ```typescript
 * const client = new PolymarketWsClient(wsManager, logger);
 *
 * // Подключение
 * await client.connect();
 *
 * // Подписка на события
 * client.on('orderbook', (rawData) => {
 *   console.log('Raw orderbook:', rawData);
 * });
 *
 * // Подписка на маркет
 * await client.subscribe('market', {
 *   assets_ids: ['123...', '456...'],
 *   type: 'market'
 * });
 *
 * // Переподключение с timeout
 * await client.reconnectWithTimeout(10000);
 *
 * // Отключение
 * await client.disconnect();
 * ```
 */

import { EventEmitter } from 'events';
import type { PolymarketWebSocketManager, SubscriptionParams, ConnectionStatus } from './PolymarketWebSocketManager.js';
import type { ILogger } from '@polymarket/logger';

/**
 * Типы событий PolymarketWsClient
 *
 * @remarks
 * Все события пересылают raw данные от WebSocketManager без трансформации.
 */
export type WsClientEvent =
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'error'
  | 'orderbook'
  | 'trade'
  | 'message'
  | 'raw';

/**
 * PolymarketWsClient
 *
 * @remarks
 * Чистый транспортный слой-обёртка вокруг WebSocketManager.
 * Наследует EventEmitter для чистого event-based API.
 *
 * Принципы дизайна:
 * 1. **Никакой domain логики**: Только транспортные операции
 * 2. **Пересылка событий**: Прозрачная передача событий от WebSocketManager
 * 3. **Защита timeout**: Предотвращает зависание при переподключении
 * 4. **Чистый API**: Простой, сфокусированный интерфейс
 */
export class PolymarketWsClient extends EventEmitter {
  private readonly wsManager: PolymarketWebSocketManager;
  private readonly logger: ILogger;
  private _isDestroyed = false;

  /**
   * Создаёт PolymarketWsClient
   *
   * @param wsManager - Экземпляр PolymarketWebSocketManager для обёртывания
   * @param logger - Logger для транспортных операций
   *
   * @throws {Error} Если wsManager или logger равны null
   *
   * @example
   * ```typescript
   * const wsManager = new PolymarketWebSocketManager({ url: '...', logger });
   * const client = new PolymarketWsClient(wsManager, logger);
   * ```
   */
  constructor(wsManager: PolymarketWebSocketManager, logger: ILogger) {
    super();

    if (!wsManager) {
      throw new Error('wsManager is required');
    }
    if (!logger) {
      throw new Error('logger is required');
    }

    this.wsManager = wsManager;
    this.logger = logger.child({ component: 'PolymarketWsClient' });

    this.setupEventForwarding();
  }

  /**
   * Подключается к WebSocket серверу
   *
   * @returns Promise который разрешается при подключении
   * @throws {Error} Если клиент уничтожен
   * @throws {Error} Если подключение не удалось
   *
   * @remarks
   * Делегирует WebSocketManager.connect().
   * Бросает исключение если клиент был уничтожен.
   *
   * @example
   * ```typescript
   * await client.connect();
   * console.log('Подключено к WebSocket');
   * ```
   */
  public async connect(): Promise<void> {
    this.ensureNotDestroyed();
    this.logger.debug('Connecting to WebSocket');
    await this.wsManager.connect();
  }

  /**
   * Отключается от WebSocket сервера
   *
   * @returns Promise который разрешается при отключении
   * @throws {Error} Если клиент уничтожен
   *
   * @remarks
   * Делегирует WebSocketManager.disconnect().
   * Graceful завершение — ждёт подтверждения закрытия.
   *
   * @example
   * ```typescript
   * await client.disconnect();
   * console.log('Отключено');
   * ```
   */
  public async disconnect(): Promise<void> {
    this.ensureNotDestroyed();
    this.logger.debug('Disconnecting from WebSocket');
    await this.wsManager.disconnect();
  }

  /**
   * Переподключается к WebSocket для новой подписки
   *
   * @returns Promise который разрешается при переподключении
   * @throws {Error} Если клиент уничтожен
   * @throws {Error} Если переподключение не удалось
   *
   * @remarks
   * Используется когда Polymarket требует полное переподключение для изменения подписок.
   * Очищает старые подписки и устанавливает свежее соединение.
   *
   * **Без timeout** - используй reconnectWithTimeout() для защиты timeout.
   *
   * @example
   * ```typescript
   * await client.reconnectForNewSubscription();
   * await client.subscribe('market', { assets_ids: newTokens });
   * ```
   */
  public async reconnectForNewSubscription(): Promise<void> {
    this.ensureNotDestroyed();
    this.logger.debug('Reconnecting for new subscription');
    await this.wsManager.reconnectForNewSubscription();
  }

  /**
   * Переподключается с защитой timeout
   *
   * @param timeoutMs - Timeout в миллисекундах (по умолчанию: 10000)
   * @returns Promise который разрешается при переподключении
   * @throws {Error} Если клиент уничтожен
   * @throws {Error} Если переподключение истекло по времени или не удалось
   *
   * @remarks
   * Оборачивает reconnectForNewSubscription() в Promise.race с timeout.
   * Предотвращает бесконечное зависание если переподключение застопорилось.
   *
   * Алгоритм:
   * 1. Создать timeout promise который отклоняется после timeoutMs
   * 2. Race timeout vs reconnectForNewSubscription()
   * 3. Если timeout победил → бросить timeout error
   * 4. Если reconnect победил → вернуть успех
   *
   * @example
   * ```typescript
   * try {
   *   await client.reconnectWithTimeout(10000); // 10s timeout
   * } catch (error) {
   *   console.error('Reconnect timeout:', error);
   * }
   * ```
   */
  public async reconnectWithTimeout(timeoutMs: number = 10000): Promise<void> {
    this.ensureNotDestroyed();

    if (timeoutMs <= 0) {
      throw new Error('timeoutMs must be positive');
    }

    this.logger.debug('Reconnecting with timeout', { timeoutMs });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`Reconnect timeout after ${timeoutMs}ms`)),
        timeoutMs
      );
    });

    await Promise.race([
      this.wsManager.reconnectForNewSubscription(),
      timeoutPromise,
    ]);

    this.logger.debug('Reconnect successful');
  }

  /**
   * Подписывается на WebSocket канал
   *
   * @param channel - Имя канала (например, 'market')
   * @param params - Параметры подписки (формат Polymarket)
   * @returns Promise который разрешается когда подписка отправлена
   * @throws {Error} Если клиент уничтожен
   *
   * @remarks
   * Делегирует WebSocketManager.subscribe().
   * Использует формат Polymarket: { assets_ids: [...], type: 'market' }
   *
   * **Не ждёт подтверждения** - подписка асинхронная.
   * События придут через 'orderbook'/'trade' события.
   *
   * @example
   * ```typescript
   * await client.subscribe('market', {
   *   assets_ids: ['123...', '456...'],
   *   type: 'market'
   * });
   * ```
   */
  public async subscribe(channel: string, params: SubscriptionParams): Promise<void> {
    this.ensureNotDestroyed();
    this.logger.debug('Subscribing to channel', { channel, params });
    await this.wsManager.subscribe(channel, params);
  }

  /**
   * Отписывается от WebSocket канала
   *
   * @param channel - Имя канала
   * @param params - Параметры подписки
   * @returns Promise который разрешается когда отписка отправлена
   * @throws {Error} Если клиент уничтожен
   *
   * @remarks
   * Делегирует WebSocketManager.unsubscribe().
   * Не ждёт подтверждения.
   *
   * @example
   * ```typescript
   * await client.unsubscribe('market', {
   *   assets_ids: ['123...'],
   *   type: 'market'
   * });
   * ```
   */
  public async unsubscribe(channel: string, params: SubscriptionParams): Promise<void> {
    this.ensureNotDestroyed();
    this.logger.debug('Unsubscribing from channel', { channel, params });
    await this.wsManager.unsubscribe(channel, params);
  }

  /**
   * Получает текущий статус соединения
   *
   * @returns Статус соединения
   * @throws {Error} Если клиент уничтожен
   *
   * @remarks
   * Делегирует WebSocketManager.getStatus().
   * Возможные значения: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'closed'
   *
   * @example
   * ```typescript
   * const status = client.getStatus();
   * if (status === 'connected') {
   *   console.log('Готов к подписке');
   * }
   * ```
   */
  public getStatus(): ConnectionStatus {
    this.ensureNotDestroyed();
    return this.wsManager.getStatus();
  }

  /**
   * Проверяет подключен ли WebSocket
   *
   * @returns true если подключен
   * @throws {Error} Если клиент уничтожен
   *
   * @remarks
   * Делегирует WebSocketManager.isConnected().
   * Удобный метод для status === 'connected'.
   *
   * @example
   * ```typescript
   * if (client.isConnected()) {
   *   await client.subscribe('market', { ... });
   * }
   * ```
   */
  public isConnected(): boolean {
    this.ensureNotDestroyed();
    return this.wsManager.isConnected();
  }

  /**
   * Уничтожает клиент и очищает ресурсы
   *
   * @returns Promise который разрешается при завершении очистки
   *
   * @remarks
   * После destroy() все методы будут бросать Error.
   * Отключает WebSocket и удаляет все listeners.
   *
   * Алгоритм:
   * 1. Установить флаг isDestroyed
   * 2. Отключить WebSocket
   * 3. Удалить listeners пересылки событий
   * 4. Удалить все client listeners
   *
   * @example
   * ```typescript
   * await client.destroy();
   * // client.connect() теперь бросит Error
   * ```
   */
  public async destroy(): Promise<void> {
    if (this._isDestroyed) {
      return;
    }

    this.logger.debug('Destroying PolymarketWsClient');
    this._isDestroyed = true;

    // Отключить WebSocket
    try {
      await this.wsManager.disconnect();
    } catch (error) {
      this.logger.warn('Error during disconnect in destroy', { error });
    }

    // Удалить пересылку событий
    this.wsManager.removeAllListeners();

    // Удалить client listeners
    this.removeAllListeners();

    this.logger.debug('PolymarketWsClient destroyed');
  }

  /**
   * Проверяет был ли клиент уничтожен
   *
   * @returns true если уничтожен
   *
   * @example
   * ```typescript
   * if (client.isDestroyed()) {
   *   console.log('Клиент больше не используется');
   * }
   * ```
   */
  public isDestroyed(): boolean {
    return this._isDestroyed;
  }

  /**
   * Настраивает пересылку событий от WebSocketManager
   *
   * @remarks
   * Пересылает все события от WebSocketManager к PolymarketWsClient.
   * Без трансформации - raw данные проходят насквозь.
   *
   * Пересылаемые события:
   * - connected
   * - disconnected
   * - reconnecting
   * - error
   * - orderbook
   * - trade
   * - message
   * - raw
   */
  private setupEventForwarding(): void {
    const events: WsClientEvent[] = [
      'connected',
      'disconnected',
      'reconnecting',
      'error',
      'orderbook',
      'trade',
      'message',
      'raw',
    ];

    events.forEach((event) => {
      this.wsManager.on(event, (...args: any[]) => {
        if (!this._isDestroyed) {
          this.emit(event, ...args);
        }
      });
    });
  }

  /**
   * Гарантирует что клиент не был уничтожен
   *
   * @throws {Error} Если клиент уничтожен
   */
  private ensureNotDestroyed(): void {
    if (this._isDestroyed) {
      throw new Error('PolymarketWsClient has been destroyed');
    }
  }
}
