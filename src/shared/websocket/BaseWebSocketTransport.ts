/**
 * BaseWebSocketTransport - Exchange-agnostic WebSocket транспортный слой
 *
 * @remarks
 * Предоставляет основную функциональность WebSocket, работающую с любой биржей:
 * - Жизненный цикл соединения (connect, disconnect, reconnect)
 * - Автоматическое переподключение с экспоненциальным backoff
 * - Механизм heartbeat/ping-pong
 * - Отслеживание подписок и автоматическая переподписка
 * - Эмиссия событий (паттерн EventEmitter)
 * - Graceful shutdown
 *
 * Использует паттерн композиции:
 * - IMessageFormatter: Форматирует исходящие subscribe/unsubscribe сообщения (специфично для биржи)
 * - IMessageParser: Парсит входящие сообщения и обнаруживает управляющие сообщения (специфично для биржи)
 *
 * Специфичная для биржи логика делегируется инжектированным formatter и parser.
 * Это позволяет одному транспорту работать с Polymarket, Binance, Kraken, и т.д.
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
 * Основная реализация WebSocket транспорта использующая паттерн композиции.
 * Делегирует специфичную для биржи логику в IMessageFormatter и IMessageParser.
 *
 * События:
 * - `connected` - Успешно подключено
 * - `disconnected` - Отключено
 * - `reconnecting` - Начата попытка переподключения
 * - `error` - Произошла ошибка
 * - `message` - Сырые WebSocket данные (Buffer, эмитятся ПЕРВЫМИ)
 * - `raw` - Распарсенное сообщение (после события message)
 * - `orderbook` - Обновление orderbook (роутится из parser)
 * - `trade` - Обновление trade (роутится из parser)
 * - Кастомные события из parser.parseMessage().type
 *
 * Порядок событий (КРИТИЧНО для DataCollector):
 * 1. `message` (сырой Buffer) - эмитится ПЕРВЫМ
 * 2. `raw` (распарсенные данные) - эмитится после парсинга
 * 3. Событие специфичного типа (orderbook/trade/и т.д.) - эмитится последним
 *
 * Жизненный цикл:
 * 1. disconnected (начальное)
 * 2. connecting (попытка подключения)
 * 3. connected (готов для подписок)
 * 4. reconnecting (потеря соединения, попытка переподключения)
 * 5. closed (окончательно закрыт, без переподключения)
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
   * Создаёт новый WebSocket транспорт
   *
   * @param config - Конфигурация транспорта
   * @param formatter - Форматировщик сообщений для исходящих сообщений (специфично для биржи)
   * @param parser - Парсер сообщений для входящих сообщений (специфично для биржи)
   * @param logger - Экземпляр логгера
   *
   * @throws {Error} Если config, formatter, parser, или logger равен null
   *
   * @remarks
   * Применяет значения по умолчанию:
   * - reconnectDelay: 1000мс
   * - maxReconnectDelay: 30000мс
   * - heartbeatInterval: 30000мс
   * - heartbeatTimeout: 5000мс
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

    // Применяем значения по умолчанию
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
   * Подключается к WebSocket серверу
   *
   * @returns Promise который резолвится при подключении
   * @throws {Error} Если подключение не удалось
   *
   * @remarks
   * - Если уже подключён или подключается, возвращает немедленно
   * - Эмитит событие 'connecting' когда начинается попытка подключения
   * - Эмитит событие 'connected' когда подключение успешно
   * - Автоматически запускает heartbeat после подключения
   * - Автоматически переподписывается на все подписки после переподключения
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

          // Ждём полной готовности WebSocket перед переподпиской
          // Предотвращает ошибки "readyState 0 (CONNECTING)"
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
   * @returns Promise который резолвится при отключении
   *
   * @remarks
   * - Останавливает heartbeat
   * - Очищает таймер переподключения
   * - Закрывает WebSocket соединение
   * - Устанавливает статус 'closed' (предотвращает автоматическое переподключение)
   * - Эмитит событие 'disconnected'
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
   * Переподключается для новой подписки (очищает старые подписки)
   *
   * @returns Promise который резолвится при переподключении
   * @throws {Error} Если переподключение не удалось
   *
   * @remarks
   * Некоторые биржи (например, Polymarket) не поддерживают динамическое изменение подписок.
   * Этот метод:
   * 1. Очищает все старые подписки
   * 2. Закрывает текущее соединение
   * 3. Ждёт 500мс
   * 4. Переподключается (resubscribeAll НЕ восстановит старые подписки)
   *
   * После вызова вы должны вручную подписаться заново.
   *
   * @example
   * ```typescript
   * await transport.reconnectForNewSubscription();
   * await transport.subscribe('market', { assets_ids: newTokens });
   * ```
   */
  public async reconnectForNewSubscription(): Promise<void> {
    this.logger.info('Reconnecting for new subscription...');

    // Очищаем старые подписки ДО переподключения
    // Иначе resubscribeAll() попытается их восстановить
    const oldCount = this.subscriptions.size;
    this.subscriptions.clear();
    this.logger.debug('Cleared old subscriptions before reconnect', { oldCount });

    // Закрываем текущее соединение
    if (this.ws && this.status === 'connected') {
      this.ws.close();
      this.ws = null;
      this.status = 'disconnected';
    }

    // Ждём перед переподключением
    await new Promise(resolve => setTimeout(resolve, 500));

    // Переподключаемся (resubscribeAll ничего не сделает - подписки очищены)
    await this.connect();

    this.logger.info('Reconnected - ready for new subscription');
  }

  /**
   * Подписывается на канал
   *
   * @param channel - Имя канала (специфично для биржи)
   * @param params - Параметры подписки (специфичны для биржи)
   * @returns Promise который резолвится когда сообщение подписки отправлено
   *
   * @remarks
   * - Делегирует форматирование сообщения в IMessageFormatter
   * - Отслеживает подписку для автоматической переподписки после переподключения
   * - Отправляет только если подключён и WebSocket открыт
   * - Логирует предупреждение если не подключён
   *
   * Поток:
   * 1. Создать ключ подписки (channel + params)
   * 2. Добавить в set подписок (для resubscribeAll)
   * 3. Отформатировать сообщение используя formatter.formatSubscription()
   * 4. Отправить через WebSocket
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

    // Проверяем и статус И readyState WebSocket
    if (this.status === 'connected' && this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        // Делегируем форматирование в специфичный для биржи formatter
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
   * Отписывается от канала
   *
   * @param channel - Имя канала
   * @param params - Параметры подписки
   * @returns Promise который резолвится когда сообщение отписки отправлено
   *
   * @remarks
   * - Удаляет подписку из отслеживания (не будет восстановлена при переподключении)
   * - Делегирует форматирование сообщения в IMessageFormatter
   *
   * @example
   * ```typescript
   * await transport.unsubscribe('market', { assets_ids: ['123'] });
   * ```
   */
  public async unsubscribe(channel: string, params: SubscriptionParams): Promise<void> {
    const subscriptionKey = this.getSubscriptionKey(channel, params);
    this.subscriptions.delete(subscriptionKey);

    // Проверяем и статус И readyState WebSocket (аналогично subscribe)
    if (this.status === 'connected' && this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        // Делегируем форматирование в специфичный для биржи formatter
        const message = this.formatter.formatUnsubscription(channel, params);
        this.logger.debug('Sending unsubscription', { channel, message: message.substring(0, 200) });
        this.ws.send(message);
      } catch (error) {
        this.logger.error('Failed to format/send unsubscription', { error, channel, params });
        throw error;
      }
    } else if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
      // Сокет не OPEN - отписка пропущена, но subscription удалена из Map
      this.logger.warn('Unsubscription skipped: socket not OPEN', {
        channel,
        params,
        readyState: this.ws.readyState,
        status: this.status,
      });
    } else {
      // Не подключены вообще
      this.logger.warn('Cannot unsubscribe - not connected', {
        channel,
        params,
        status: this.status,
      });
    }
  }

  /**
   * Получает текущий статус соединения
   *
   * @returns Статус соединения
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
   * Проверяет подключён ли
   *
   * @returns true если подключён
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
   * Обрабатывает входящее WebSocket сообщение
   *
   * @param data - Сырые WebSocket данные
   *
   * @remarks
   * КРИТИЧНЫЙ ПОРЯДОК СОБЫТИЙ (для DataCollector):
   * 1. Эмитить событие 'message' с сырым Buffer ПЕРВЫМ
   * 2. Распарсить сообщение используя IMessageParser
   * 3. Обработать управляющие сообщения (pong, error) внутренне
   * 4. Эмитить событие 'raw' с распарсенными данными
   * 5. Эмитить событие специфичного типа (orderbook, trade, и т.д.)
   *
   * Этот порядок гарантирует что DataCollector получит сырой Buffer до любого парсинга.
   *
   * Алгоритм:
   * 1. Эмитить сырое событие 'message'
   * 2. Распарсить JSON
   * 3. Обработать массивы (batch сообщения)
   * 4. Делегировать в processMessage()
   * 5. Логировать ошибки для непарсируемых сообщений
   *
   * @example
   * ```typescript
   * // Порядок эмиссии событий:
   * // 1. emit('message', Buffer.from('{"event_type":"book",...}'))
   * // 2. emit('raw', { event_type: 'book', ... })
   * // 3. emit('orderbook', { event_type: 'book', ... })
   * ```
   */
  private handleMessage(data: WebSocket.Data): void {
    // КРИТИЧНО: Эмитить сырое событие message ДО парсинга (для router/DataCollector)
    this.emit('message', data);

    try {
      const message = JSON.parse(data.toString()) as any;

      // Обработка batch сообщений (массив сообщений)
      if (Array.isArray(message)) {
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

      // Обрабатываем известные текстовые ответы от сервера (не JSON)
      const knownTextResponses = [
        'INVALID OPERATION',
        'ERROR',
        'PONG',
        'OK',
        'UNAUTHORIZED',
        'TOO MANY REQUESTS',
      ];

      if (knownTextResponses.includes(rawData)) {
        // Логируем как warning (не error) - это ожидаемые ответы сервера
        this.logger.warn('Received text message from server', {
          message: rawData,
        });
        return;
      }

      // Неизвестное непарсируемое сообщение - логируем как error
      this.logger.error('Failed to parse WebSocket message', {
        error: error instanceof Error ? error.message : String(error),
        rawData: rawData.substring(0, 200),
      });
    }
  }

  /**
   * Обрабатывает одно распарсенное сообщение
   *
   * @param message - Распарсенный объект сообщения
   *
   * @remarks
   * Делегирует парсинг сообщения в IMessageParser.
   *
   * Алгоритм:
   * 1. Проверить является ли сообщение pong (используя parser.isPongMessage)
   *    - Если да: обработать pong, вернуться
   * 2. Проверить является ли сообщение ошибкой (используя parser.isErrorMessage)
   *    - Если да: извлечь ошибку, эмитить событие error, вернуться
   * 3. Распарсить сообщение (используя parser.parseMessage)
   *    - Если null: управляющее сообщение (subscribed, и т.д.), залогировать и вернуться
   *    - Если ParsedMessage: эмитить 'raw' + событие специфичного типа
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
      // Проверка на pong сообщение (используя parser)
      if (this.parser.isPongMessage(message)) {
        this.handlePong();
        return;
      }

      // Проверка на сообщение об ошибке (используя parser)
      if (this.parser.isErrorMessage(message)) {
        const errorMsg = this.parser.extractErrorMessage(message);
        this.logger.error('WebSocket error message received', { message, errorMsg });
        this.emit('error', new Error(errorMsg || 'Unknown WebSocket error'));
        return;
      }

      // Парсим сообщение используя специфичный для биржи parser
      const parsed = this.parser.parseMessage(message);

      if (parsed === null) {
        // Управляющее сообщение (subscribed, unsubscribed, price_change, и т.д.) - игнорируем
        // Не логируем чтобы уменьшить шум (события price_change очень частые)
        return;
      }

      // Эмитим raw событие для DataCollector (ДО события специфичного типа)
      this.emit('raw', message);

      // Эмитим событие специфичного типа (orderbook, trade, и т.д.)
      // ВАЖНО: передаём parsed.payload, а не сырое message (контракт ParsedMessage)
      this.emit(parsed.type, parsed.payload);
    } catch (error) {
      this.logger.error('Failed to process message', { error, message });
    }
  }

  /**
   * Обрабатывает закрытие соединения
   *
   * @remarks
   * - Останавливает heartbeat
   * - Эмитит событие 'disconnected'
   * - Планирует переподключение (если не завершаемся)
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
   *
   * @remarks
   * - Эмитит событие 'reconnecting' с текущей задержкой
   * - Удваивает задержку при каждой неудаче (до maxReconnectDelay)
   * - Сбрасывает задержку до начального значения при успешном подключении
   */
  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this.status = 'reconnecting';
    this.emit('reconnecting', this.currentReconnectDelay);

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((error) => {
        this.emit('error', error);
        // Увеличиваем задержку для следующей попытки (экспоненциальный backoff)
        this.currentReconnectDelay = Math.min(
          this.currentReconnectDelay * 2,
          this.config.maxReconnectDelay
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
   * Запускает механизм heartbeat
   *
   * @remarks
   * - Отправляет ping каждые heartbeatInterval
   * - Устанавливает таймаут для pong ответа
   * - Терминирует соединение если pong не получен
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();

    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.status === 'connected') {
        this.ws.ping();

        // Устанавливаем таймаут для pong ответа
        this.heartbeatTimeoutTimer = setTimeout(() => {
          // Если pong не получен - терминируем соединение
          this.logger.warn('Heartbeat timeout - terminating connection');
          this.ws?.terminate();
        }, this.config.heartbeatTimeout);
      }
    }, this.config.heartbeatInterval);
  }

  /**
   * Останавливает механизм heartbeat
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
   *
   * @remarks
   * Очищает таймаут heartbeat (соединение живо)
   */
  private handlePong(): void {
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer);
      this.heartbeatTimeoutTimer = null;
    }
  }

  /**
   * Переподписывается на все отслеживаемые подписки
   *
   * @remarks
   * Вызывается автоматически после переподключения.
   * Итерирует по всем подпискам и отправляет subscribe сообщения.
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
   * Создаёт ключ подписки
   *
   * @param channel - Имя канала
   * @param params - Параметры подписки
   * @returns Уникальный ключ подписки
   *
   * @remarks
   * Формат: `channel::JSON.stringify(params)`
   * Используется для отслеживания и дедупликации.
   */
  private getSubscriptionKey(channel: string, params: SubscriptionParams): string {
    return `${channel}::${JSON.stringify(params)}`;
  }
}