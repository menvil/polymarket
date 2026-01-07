/**
 * PolymarketWsAdapter - Event-driven WebSocket адаптер
 *
 * @remarks
 * Интегрирует event-driven pipeline для market-data:
 * - PolymarketWsClient - Транспортный слой
 * - PolymarketMessageRouter - Роутинг сообщений
 * - mapParsedToDomainEvent - Чистый маппер (Polymarket → DomainEvent)
 * - InMemoryEventBus - Event bus для pub/sub
 * - ProjectorCoordinator - EventBus → Projectors → StateManager → Callbacks
 *
 * Ответственность:
 * - Связывание event-driven слоёв
 * - Управление WebSocket подписками (tokens)
 * - Обработка WebSocket жизненного цикла (connect, disconnect, reconnect)
 * - Реализация интерфейса IMarketDataFeed
 *
 * Архитектура:
 * ```
 * WsAdapter (this)
 *   ├─ PolymarketWsClient (транспорт)
 *   │    └─ WebSocketManager
 *   ├─ PolymarketMessageRouter (роутинг)
 *   ├─ InMemoryEventBus (события)
 *   └─ ProjectorCoordinator (проекция)
 *        ├─ StateManager (Map<assetId, Aggregate>)
 *        ├─ OrderbookProjector (stateless)
 *        ├─ TradesProjector (stateless)
 *        └─ CallbackRegistries
 * ```
 *
 * Поток данных:
 * ```
 * WebSocket raw данные
 *   → WsClient получает из WebSocket
 *   → WsClient.on('message', rawData)
 *   → Router.processRawData(rawData)
 *   → Router.emit('orderbook'/'trade', parsedMessage)
 *   → Adapter: mapParsedToDomainEvent(message)
 *   → EventBus.publish(event)
 *   → Projector обрабатывает событие
 *   → Aggregate.apply(event)
 *   → Projector.notify(assetId, entity)
 *   → Вызываются user callbacks
 * ```
 *
 * @example
 * ```typescript
 * const adapter = new PolymarketWsAdapter(wsManager, logger);
 *
 * // Подписка на orderbook
 * adapter.subscribeToOrderbook(tokenId, (orderbook) => {
 *   console.log('Spread:', orderbook.getSpread().value);
 * });
 *
 * // Подписка на трейды
 * adapter.subscribeToTrades(tokenId, (trade) => {
 *   console.log('Trade:', trade.price.value, trade.quantity.value);
 * });
 * ```
 */

import type { IMarketDataFeed } from '../../../domain/ports/IMarketDataFeed.js';
import type { ILogger } from '../../../domain/ports/ILogger.js';
import { Orderbook } from '../../../domain/entities/Orderbook.js';
import { Trade } from '../../../domain/entities/Trade.js';
import type { WebSocketManager, SubscribeParams } from '../../exchange/clients/WebSocketManager.js';
import { PolymarketWsClient } from './PolymarketWsClient.js';
import { PolymarketMessageRouter } from './PolymarketMessageRouter.js';
import type {
  PolymarketOrderbookMessage,
  PolymarketTradeMessage,
} from './PolymarketMessageRouter.js';
import { InMemoryEventBus } from '../../../shared/events/InMemoryEventBus.js';
import { ProjectorCoordinator } from '../../../application/projectors/ProjectorCoordinator.js';
import { mapParsedToDomainEvent } from './mapping/mapParsedToDomainEvent.js';

/**
 * Тип callback для orderbook
 */
export type OrderbookCallback = (orderbook: Orderbook) => void;

/**
 * Тип callback для трейдов
 */
export type TradeCallback = (trade: Trade) => void;

/**
 * PolymarketWsAdapter
 *
 * @remarks
 * Event-driven адаптер, интегрирующий Client + Router + EventBus + Projector.
 * Реализует IMarketDataFeed для domain слоя.
 *
 * Принципы дизайна:
 * 1. **Event-driven архитектура**: Pub/sub паттерн для слабой связанности
 * 2. **Разделение ответственности**: Каждый слой имеет единственную ответственность
 * 3. **Чистая интеграция**: Слои общаются через события
 * 4. **Типобезопасность**: Строгая типизация через весь стек
 * 5. **Обратная совместимость**: Тот же публичный API что и у оригинального адаптера
 * 6. **Изоляция ошибок**: Ошибки не распространяются между слоями
 */
export class PolymarketWsAdapter implements IMarketDataFeed {
  private readonly client: PolymarketWsClient;
  private readonly router: PolymarketMessageRouter;
  private readonly eventBus: InMemoryEventBus;
  private readonly projector: ProjectorCoordinator;
  private readonly logger: ILogger;

  /**
   * Отслеживает все подписанные tokens для переподписки после reconnect
   */
  private readonly subscribedTokens: Set<string> = new Set();

  private _isConnected = false;
  private _isDestroyed = false;

  /**
   * Флаг для предотвращения цикла переподключений
   * Устанавливается в true пока выполняется sendAllSubscriptions()
   */
  private _isSubscribing = false;

  /**
   * Создаёт PolymarketWsAdapter
   *
   * @param wsManager - Экземпляр WebSocketManager
   * @param logger - Logger для операций адаптера
   *
   * @throws {Error} Если wsManager или logger равны null
   *
   * @example
   * ```typescript
   * const wsManager = new WebSocketManager({
   *   url: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
   *   logger
   * });
   * const adapter = new PolymarketWsAdapter(wsManager, logger);
   * ```
   */
  constructor(wsManager: WebSocketManager, logger: ILogger) {
    if (!wsManager) {
      throw new Error('wsManager is required');
    }
    if (!logger) {
      throw new Error('logger is required');
    }

    this.logger = logger.child ? logger.child('PolymarketWsAdapter') : logger;

    // Инициализируем компоненты
    this.client = new PolymarketWsClient(wsManager, this.logger);
    this.router = new PolymarketMessageRouter(this.logger);
    this.eventBus = new InMemoryEventBus(this.logger);
    this.projector = new ProjectorCoordinator(this.eventBus, this.logger);

    // Связываем слои
    this.setupIntegration();
  }

  /**
   * Проверяет подключен ли WebSocket
   */
  public get isConnected(): boolean {
    return this._isConnected;
  }

  /**
   * Подключается к WebSocket
   *
   * @throws {Error} Если адаптер уничтожен
   *
   * @remarks
   * Делегирует базовому PolymarketWsClient.
   * Настраивает обработчики событий и помечает адаптер как подключенный.
   *
   * @example
   * ```typescript
   * await adapter.connect();
   * console.log(adapter.isConnected); // true
   * ```
   */
  public async connect(): Promise<void> {
    this.checkDestroyed();
    await this.client.connect();
  }

  /**
   * Настраивает интеграцию между слоями
   *
   * @remarks
   * Связывает обработчики событий для соединения:
   * - Client → Router (raw данные)
   * - Router → Adapter (распарсенные сообщения)
   * - Adapter → EventBus (domain события через маппер)
   * - EventBus → Projector (автоматическая подписка)
   * - Projector → Aggregate → Callbacks
   *
   * Также обрабатывает события жизненного цикла соединения.
   */
  private setupIntegration(): void {
    // Client → Router: Пересылка raw данных сообщений
    this.client.on('message', (rawData: Buffer) => {
      this.router.processRawData(rawData);
    });

    // Router → Adapter: Обработка распарсенных orderbook сообщений
    this.router.on('orderbook', (message: PolymarketOrderbookMessage) => {
      this.handleOrderbookMessage(message);
    });

    // Router → Adapter: Обработка распарсенных trade сообщений
    this.router.on('trade', (message: PolymarketTradeMessage) => {
      this.handleTradeMessage(message);
    });

    // Router → Adapter: Обработка ошибок парсинга/роутинга
    this.router.on('error', (error: Error) => {
      this.logger.error('Router error', {
        error: error.message,
      });
      // Не пробрасываем ошибку дальше - предотвращаем uncaught exception
    });

    // События жизненного цикла Client
    this.client.on('connected', async () => {
      this._isConnected = true;
      this.logger.info('WebSocket connected');
      await this.resubscribeAll();
    });

    this.client.on('disconnected', () => {
      this._isConnected = false;
      this.logger.info('WebSocket disconnected');
    });

    this.client.on('error', (error: Error) => {
      this.logger.error('WebSocket error', {
        error: error.message,
      });
    });
  }

  /**
   * Получает текущий orderbook snapshot
   *
   * @param tokenId - Token ID для получения orderbook
   * @returns Promise, разрешающийся в текущий orderbook
   *
   * @throws {Error} Если не подключен или fetch не удался
   *
   * @remarks
   * Получает текущий orderbook из REST API, не из WebSocket.
   * Это snapshot, не подписка.
   *
   * @example
   * ```typescript
   * const orderbook = await adapter.getOrderbook(yesTokenId);
   * console.log('Best bid:', orderbook.getBestBid()?.price.value);
   * ```
   */
  public async getOrderbook(_tokenId: string): Promise<Orderbook> {
    throw new Error('getOrderbook not implemented - use subscribeToOrderbook for real-time data');
  }

  /**
   * Подписывается на обновления orderbook
   *
   * @param tokenId - Token ID для подписки
   * @param callback - Callback, вызываемый при обновлениях orderbook
   *
   * @remarks
   * Алгоритм:
   * 1. Делегировать projector.subscribeToOrderbook()
   * 2. Добавить token в набор subscribedTokens
   * 3. Отправить WebSocket подписку если подключено
   *
   * Несколько callbacks могут подписаться на один token.
   * Callback получает domain entity Orderbook.
   *
   * @example
   * ```typescript
   * adapter.subscribeToOrderbook(yesTokenId, (orderbook) => {
   *   console.log('Bids:', orderbook.bids.length);
   *   console.log('Asks:', orderbook.asks.length);
   *   console.log('Spread:', orderbook.getSpread().value);
   * });
   * ```
   */
  public subscribeToOrderbook(tokenId: string, callback: OrderbookCallback): void {
    this.checkDestroyed();

    this.logger.debug('Subscribing to orderbook', {
      tokenId: tokenId.substring(0, 16) + '...',
    });

    // Делегируем projector
    this.projector.subscribeToOrderbook(tokenId, callback);

    // Добавляем в подписанные tokens и обновляем WebSocket подписку
    const wasSubscribed = this.subscribedTokens.has(tokenId);
    this.subscribedTokens.add(tokenId);

    if (!wasSubscribed && this._isConnected) {
      // Новый token - отправляем подписку (ошибки обрабатываются внутри)
      void this.sendAllSubscriptions();
    }
  }

  /**
   * Подписывается на обновления трейдов
   *
   * @param tokenId - Token ID для подписки
   * @param callback - Callback, вызываемый при обновлениях трейдов
   *
   * @remarks
   * Аналогично subscribeToOrderbook, но для трейдов.
   * Callback получает domain entity Trade.
   *
   * @example
   * ```typescript
   * adapter.subscribeToTrades(yesTokenId, (trade) => {
   *   console.log('Trade:', trade.side, trade.quantity.value, '@', trade.price.value);
   * });
   * ```
   */
  public subscribeToTrades(tokenId: string, callback: TradeCallback): void {
    this.checkDestroyed();

    this.logger.debug('Subscribing to trades', {
      tokenId: tokenId.substring(0, 16) + '...',
    });

    // Делегируем projector
    this.projector.subscribeToTrades(tokenId, callback);

    // Добавляем в подписанные tokens и обновляем WebSocket подписку
    const wasSubscribed = this.subscribedTokens.has(tokenId);
    this.subscribedTokens.add(tokenId);

    if (!wasSubscribed && this._isConnected) {
      // Новый token - отправляем подписку (ошибки обрабатываются внутри)
      void this.sendAllSubscriptions();
    }
  }

  /**
   * Подписывается на маркет (оба токена YES и NO)
   *
   * @param yesTokenId - YES token ID
   * @param noTokenId - NO token ID
   *
   * @remarks
   * Удобный метод для подписки на оба токена в маркете.
   * НЕ регистрирует никакие callbacks - используйте subscribeToOrderbook/Trades для этого.
   * Только гарантирует что оба токена подписаны в WebSocket.
   *
   * @example
   * ```typescript
   * await adapter.subscribeToMarket(market.yesTokenId, market.noTokenId);
   * // Теперь подписываемся на конкретные данные
   * adapter.subscribeToOrderbook(market.yesTokenId, callback);
   * ```
   */
  public async subscribeToMarket(yesTokenId: string, noTokenId: string): Promise<void> {
    this.checkDestroyed();

    this.logger.info('Subscribing to market', {
      yesToken: yesTokenId.substring(0, 16) + '...',
      noToken: noTokenId.substring(0, 16) + '...',
    });

    this.subscribedTokens.add(yesTokenId);
    this.subscribedTokens.add(noTokenId);

    if (this._isConnected) {
      await this.sendAllSubscriptions();
    }
  }

  /**
   * Отписывается от token (все callbacks)
   *
   * @param tokenId - Token ID для отписки
   *
   * @remarks
   * Удаляет ВСЕ callbacks для этого token (orderbook и trades).
   * Обновляет WebSocket подписку.
   *
   * @example
   * ```typescript
   * adapter.unsubscribe(yesTokenId);
   * ```
   */
  public unsubscribe(tokenId: string): void {
    this.checkDestroyed();

    this.logger.debug('Unsubscribing from token', {
      tokenId: tokenId.substring(0, 16) + '...',
    });

    // Очищаем все callbacks через projector
    this.projector.unsubscribeAllOrderbooks(tokenId);
    this.projector.unsubscribeAllTrades(tokenId);

    this.subscribedTokens.delete(tokenId);

    if (this._isConnected) {
      // Обновляем подписки (ошибки обрабатываются внутри)
      void this.sendAllSubscriptions();
    }
  }

  /**
   * Отписывается от маркета (оба токена, все callbacks)
   *
   * @param yesTokenId - YES token ID
   * @param noTokenId - NO token ID
   *
   * @example
   * ```typescript
   * await adapter.unsubscribeFromMarket(market.yesTokenId, market.noTokenId);
   * ```
   */
  public async unsubscribeFromMarket(yesTokenId: string, noTokenId: string): Promise<void> {
    this.checkDestroyed();

    this.logger.info('Unsubscribing from market', {
      yesToken: yesTokenId.substring(0, 16) + '...',
      noToken: noTokenId.substring(0, 16) + '...',
    });

    this.unsubscribe(yesTokenId);
    this.unsubscribe(noTokenId);
  }

  /**
   * Отписывается только от orderbook (сохраняет trade callbacks)
   *
   * @param tokenId - Token ID
   *
   * @remarks
   * Удаляет только orderbook callbacks для этого token.
   * Trade callbacks остаются активными.
   * Token остаётся в subscribedTokens если есть trade callbacks.
   *
   * @example
   * ```typescript
   * adapter.unsubscribeFromOrderbook(yesTokenId);
   * // Trade callbacks всё ещё активны
   * ```
   */
  public unsubscribeFromOrderbook(tokenId: string): void {
    this.checkDestroyed();

    this.logger.debug('Unsubscribing from orderbook', {
      tokenId: tokenId.substring(0, 16) + '...',
    });

    // Очищаем все orderbook callbacks через projector
    this.projector.unsubscribeAllOrderbooks(tokenId);

    // Проверяем есть ли trade callbacks перед удалением из subscribedTokens
    const hasTradeCallbacks = this.projector.getTradeSubscriberCount(tokenId) > 0;

    if (!hasTradeCallbacks) {
      this.subscribedTokens.delete(tokenId);

      if (this._isConnected) {
        // Обновляем подписки (ошибки обрабатываются внутри)
        void this.sendAllSubscriptions();
      }
    }
  }

  /**
   * Отписывается только от трейдов (сохраняет orderbook callbacks)
   *
   * @param tokenId - Token ID
   *
   * @remarks
   * Удаляет только trade callbacks для этого token.
   * Orderbook callbacks остаются активными.
   *
   * @example
   * ```typescript
   * adapter.unsubscribeFromTrades(yesTokenId);
   * // Orderbook callbacks всё ещё активны
   * ```
   */
  public unsubscribeFromTrades(tokenId: string): void {
    this.checkDestroyed();

    this.logger.debug('Unsubscribing from trades', {
      tokenId: tokenId.substring(0, 16) + '...',
    });

    // Очищаем все trade callbacks через projector
    this.projector.unsubscribeAllTrades(tokenId);

    // Проверяем есть ли orderbook callbacks перед удалением из subscribedTokens
    const hasOrderbookCallbacks = this.projector.getOrderbookSubscriberCount(tokenId) > 0;

    if (!hasOrderbookCallbacks) {
      this.subscribedTokens.delete(tokenId);

      if (this._isConnected) {
        // Обновляем подписки (ошибки обрабатываются внутри)
        void this.sendAllSubscriptions();
      }
    }
  }

  /**
   * Проверяет подписан ли на token
   *
   * @param tokenId - Token ID для проверки
   * @returns true если есть orderbook или trade callbacks
   *
   * @example
   * ```typescript
   * if (adapter.isSubscribed(yesTokenId)) {
   *   console.log('Already subscribed');
   * }
   * ```
   */
  public isSubscribed(tokenId: string): boolean {
    this.checkDestroyed();

    return (
      this.projector.getOrderbookSubscriberCount(tokenId) > 0 ||
      this.projector.getTradeSubscriberCount(tokenId) > 0
    );
  }

  /**
   * Обрабатывает orderbook сообщение от router
   *
   * @param message - Распарсенное orderbook сообщение от PolymarketMessageRouter
   *
   * @remarks
   * Использует чистый маппер mapParsedToDomainEvent() для конвертации в domain event.
   * Публикует событие в EventBus, что запускает Projector → Aggregate → Callbacks.
   *
   * Алгоритм:
   * 1. Маппить сообщение в DomainEvent используя mapParsedToDomainEvent()
   * 2. Если маппер вернул null (невалидные данные), пропустить молча
   * 3. Опубликовать событие в EventBus
   * 4. EventBus → Projector → Aggregate.apply() → Callbacks
   *
   * Ответственность маппера:
   * - Валидирует обязательные поля (asset_id, bids, asks)
   * - Возвращает OrderBookSnapshotReceivedEvent или null
   * - Чистая функция (без side effects, без исключений)
   *
   * @throws Никогда не бросает - ошибки логируются в Projector
   *
   * @example
   * Формат сообщения:
   * ```typescript
   * {
   *   event_type: 'book',
   *   asset_id: '67704255197...',
   *   bids: [{price: '0.52', size: '100'}, ...],
   *   asks: [{price: '0.53', size: '150'}, ...],
   *   timestamp: 1766875759895
   * }
   * ```
   */
  private handleOrderbookMessage(message: PolymarketOrderbookMessage): void {
    // Маппим в domain event
    const event = mapParsedToDomainEvent(message);

    // Если маппер вернул null (невалидные данные), пропускаем
    if (event === null) {
      return;
    }

    // Публикуем в EventBus
    this.eventBus.publish(event);
  }

  /**
   * Обрабатывает trade сообщение от router
   *
   * @param message - Распарсенное trade сообщение от PolymarketMessageRouter
   *
   * @remarks
   * Использует чистый маппер mapParsedToDomainEvent() для конвертации в domain event.
   * Публикует событие в EventBus, что запускает Projector → Aggregate → Callbacks.
   *
   * Алгоритм:
   * 1. Маппить сообщение в DomainEvent используя mapParsedToDomainEvent()
   * 2. Если маппер вернул null (невалидные данные), пропустить молча
   * 3. Опубликовать событие в EventBus
   * 4. EventBus → Projector → Aggregate.apply() → Callbacks
   *
   * Ответственность маппера:
   * - Валидирует обязательные поля (asset_id, price, size)
   * - Возвращает TradeExecutedEvent или null
   * - Чистая функция (без side effects, без исключений)
   *
   * @throws Никогда не бросает - ошибки логируются в Projector
   *
   * @example
   * Формат сообщения:
   * ```typescript
   * {
   *   event_type: 'trade',
   *   asset_id: '67704255197...',
   *   price: '0.52',
   *   size: '50',
   *   side: 'BUY',
   *   timestamp: 1766875759895
   * }
   * ```
   */
  private handleTradeMessage(message: PolymarketTradeMessage): void {
    // Маппим в domain event
    const event = mapParsedToDomainEvent(message);

    // Если маппер вернул null (невалидные данные), пропускаем
    if (event === null) {
      return;
    }

    // Публикуем в EventBus
    this.eventBus.publish(event);
  }

  /**
   * Отправляет все подписки в WebSocket
   *
   * @remarks
   * **ВАЖНО**: Polymarket WebSocket ЗАМЕНЯЕТ подписки при каждом вызове.
   * Мы должны отправить ВСЕ токены в одном сообщении подписки.
   *
   * Алгоритм:
   * 1. Собрать все подписанные токены
   * 2. Переподключить WebSocket (Polymarket требует этого)
   * 3. Отправить одно сообщение подписки со всеми токенами
   */
  private async sendAllSubscriptions(): Promise<void> {
    if (this.subscribedTokens.size === 0) {
      this.logger.debug('No tokens to subscribe to');
      return;
    }

    // Предотвращаем цикл переподключений
    if (this._isSubscribing) {
      this.logger.debug('Subscription already in progress, skipping');
      return;
    }

    this._isSubscribing = true;

    try {
      const tokens = Array.from(this.subscribedTokens);

      this.logger.info('Sending WebSocket subscription', {
        tokenCount: tokens.length,
        marketCount: tokens.length / 2,
        sampleTokens: tokens.slice(0, 2).map(t => t.substring(0, 16) + '...'),
      });

      // Polymarket требует переподключения для новых подписок
      await this.client.reconnectWithTimeout(10000);

      // Отправляем одно сообщение подписки со всеми токенами
      const params: SubscribeParams = {
        assets_ids: tokens,
        type: 'market',
      };

      await this.client.subscribe('market', params);

      this.logger.info('Subscription sent successfully', {
        tokenCount: tokens.length,
      });
    } catch (error) {
      // Логируем ошибку но НЕ пробрасываем - предотвращаем crash
      this.logger.error('Failed to send subscriptions', {
        error: error instanceof Error ? error.message : String(error),
        tokenCount: this.subscribedTokens.size,
        hint: 'Check if token IDs are valid or if Polymarket API changed',
      });
      // НЕ throw error - позволяем системе продолжить работу
    } finally {
      this._isSubscribing = false;
    }
  }

  /**
   * Переподписывается на все токены после reconnect
   *
   * @remarks
   * Вызывается автоматически при событии 'connected'.
   * Отправляет все текущие подписки в WebSocket.
   */
  private async resubscribeAll(): Promise<void> {
    if (this.subscribedTokens.size === 0) {
      this.logger.debug('No tokens to resubscribe to');
      return;
    }

    this.logger.info('Resubscribing after reconnect', {
      tokenCount: this.subscribedTokens.size,
    });

    await this.sendAllSubscriptions();
  }

  /**
   * Проверяет был ли адаптер уничтожен и бросает исключение если да
   *
   * @throws {Error} Если адаптер уничтожен
   *
   * @remarks
   * Внутренний помощник для enforcing состояния destroyed
   */
  private checkDestroyed(): void {
    if (this._isDestroyed) {
      throw new Error('PolymarketWsAdapter has been destroyed and cannot be used');
    }
  }

  /**
   * Проверяет был ли адаптер уничтожен
   *
   * @returns true если адаптер уничтожен
   *
   * @example
   * ```typescript
   * if (adapter.isDestroyed()) {
   *   console.log('Adapter is destroyed, cannot use');
   * }
   * ```
   */
  public isDestroyed(): boolean {
    return this._isDestroyed;
  }

  /**
   * Уничтожает адаптер и очищает ресурсы
   *
   * @remarks
   * Graceful shutdown:
   * 1. Уничтожить client (отключает WebSocket)
   * 2. Уничтожить projector
   * 3. Очистить набор подписанных токенов
   * 4. Удалить все event listeners
   * 5. Установить флаг destroyed
   *
   * После destroy(), адаптер не может быть переиспользован.
   *
   * @example
   * ```typescript
   * await adapter.destroy();
   * ```
   */
  public async destroy(): Promise<void> {
    // Идемпотентно - можно безопасно вызывать несколько раз
    if (this._isDestroyed) {
      this.logger.debug('Adapter already destroyed, skipping');
      return;
    }

    this.logger.info('Destroying PolymarketWsAdapter');

    // Устанавливаем флаг destroyed немедленно для предотвращения новых операций
    this._isDestroyed = true;

    try {
      // Уничтожаем client (отключает WebSocket)
      await this.client.destroy();
    } catch (error) {
      this.logger.warn('Error destroying client', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Уничтожаем projector
    this.projector.destroy();

    // Очищаем подписки
    this.subscribedTokens.clear();

    // Удаляем все event listeners из router
    this.router.removeAllListeners();

    // Сбрасываем состояние
    this._isConnected = false;

    this.logger.info('PolymarketWsAdapter destroyed');
  }
}
