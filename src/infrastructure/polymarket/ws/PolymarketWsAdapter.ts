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
import type { PolymarketWebSocketManager, SubscriptionParams } from './PolymarketWebSocketManager.js';
import { PolymarketWsClient } from './PolymarketWsClient.js';
import { PolymarketMessageRouter } from './PolymarketMessageRouter.js';
import type {
  PolymarketOrderbookMessage,
  PolymarketTradeMessage,
} from './PolymarketMessageRouter.js';
import { InMemoryEventBus } from '../../../shared/events/InMemoryEventBus.js';
import { ProjectorCoordinator } from '../../../application/projectors/ProjectorCoordinator.js';
import { mapParsedToDomainEvent } from './mapping/mapParsedToDomainEvent.js';
import { createProductionEnvelope } from '../../../shared/events/EventEnvelope.js';
import type { DomainEvent } from '../../../domain/events/DomainEvent.js';

/**
 * Преобразует DomainEvent в payload для EventEnvelope
 *
 * @remarks
 * DomainEvent использует `eventName`, но createProductionEnvelope ожидает `type`.
 * Эта функция выполняет типобезопасное преобразование.
 *
 * @param event - Domain событие с eventName
 * @returns Payload с type для использования в envelope
 */
function domainEventToEnvelopePayload<E extends DomainEvent>(
  event: E
): E & { type: string } {
  return {
    ...event,
    type: event.eventName,
  };
}

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
   * Флаг необходимости повторной подписки
   * Устанавливается в true если токены изменились во время sendAllSubscriptions()
   */
  private _needsResubscribe = false;

  /**
   * Создаёт PolymarketWsAdapter
   *
   * @param wsManager - Экземпляр PolymarketWebSocketManager
   * @param logger - Logger для операций адаптера
   *
   * @throws {Error} Если wsManager или logger равны null
   *
   * @example
   * ```typescript
   * const wsManager = new PolymarketWebSocketManager({
   *   url: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
   *   logger
   * });
   * const adapter = new PolymarketWsAdapter(wsManager, logger);
   * ```
   */
  constructor(wsManager: PolymarketWebSocketManager, logger: ILogger) {
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
   * @returns Promise, который отклоняется с ошибкой (метод не реализован)
   *
   * @remarks
   * **НЕ РЕАЛИЗОВАН** в WebSocket адаптере.
   *
   * Этот адаптер предназначен для real-time данных через WebSocket.
   * Для получения snapshot используйте:
   * - `PolymarketOrderbookRestClient.getOrderbook()` для REST API
   * - `subscribeToOrderbook()` для подписки на real-time обновления
   *
   * @example
   * ```typescript
   * // ❌ Не работает - используйте REST клиент или подписку
   * // const orderbook = await wsAdapter.getOrderbook(tokenId);
   *
   * // ✅ Вариант 1: REST клиент
   * const orderbook = await orderbookRestClient.getOrderbook(tokenId);
   *
   * // ✅ Вариант 2: Подписка на real-time данные
   * wsAdapter.subscribeToOrderbook(tokenId, (orderbook) => {
   *   console.log('Best bid:', orderbook.getBestBid()?.price.value);
   * });
   * ```
   */
  public async getOrderbook(_tokenId: string): Promise<Orderbook> {
    return Promise.reject(
      new Error(
        'getOrderbook() не реализован в WebSocket адаптере. ' +
        'Используйте PolymarketOrderbookRestClient.getOrderbook() для snapshot ' +
        'или subscribeToOrderbook() для real-time обновлений.'
      )
    );
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
   * adapter.subscribeToOrderbook(upTokenId, (orderbook) => {
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
   * adapter.subscribeToTrades(upTokenId, (trade) => {
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
   * @param upTokenId - YES token ID
   * @param downTokenId - NO token ID
   *
   * @remarks
   * Удобный метод для подписки на оба токена в маркете.
   * НЕ регистрирует никакие callbacks - используйте subscribeToOrderbook/Trades для этого.
   * Только гарантирует что оба токена подписаны в WebSocket.
   *
   * @example
   * ```typescript
   * await adapter.subscribeToMarket(market.upTokenId, market.downTokenId);
   * // Теперь подписываемся на конкретные данные
   * adapter.subscribeToOrderbook(market.upTokenId, callback);
   * ```
   */
  public async subscribeToMarket(upTokenId: string, downTokenId: string): Promise<void> {
    this.checkDestroyed();

    this.logger.info('Subscribing to market', {
      upToken: upTokenId.substring(0, 16) + '...',
      downToken: downTokenId.substring(0, 16) + '...',
    });

    this.subscribedTokens.add(upTokenId);
    this.subscribedTokens.add(downTokenId);

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
   * adapter.unsubscribe(upTokenId);
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
   * @param upTokenId - YES token ID
   * @param downTokenId - NO token ID
   *
   * @example
   * ```typescript
   * await adapter.unsubscribeFromMarket(market.upTokenId, market.downTokenId);
   * ```
   */
  public async unsubscribeFromMarket(upTokenId: string, downTokenId: string): Promise<void> {
    this.checkDestroyed();

    this.logger.info('Unsubscribing from market', {
      upToken: upTokenId.substring(0, 16) + '...',
      downToken: downTokenId.substring(0, 16) + '...',
    });

    this.unsubscribe(upTokenId);
    this.unsubscribe(downTokenId);
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
   * adapter.unsubscribeFromOrderbook(upTokenId);
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
   * adapter.unsubscribeFromTrades(upTokenId);
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
   * if (adapter.isSubscribed(upTokenId)) {
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

    // Публикуем в EventBus (оборачиваем в envelope)
    const envelope = createProductionEnvelope(domainEventToEnvelopePayload(event), {
      environment: 'LIVE',
      accountId: 'default',
    });
    this.eventBus.publish(envelope);
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

    // Публикуем в EventBus (оборачиваем в envelope)
    const envelope = createProductionEnvelope(domainEventToEnvelopePayload(event), {
      environment: 'LIVE',
      accountId: 'default',
    });
    this.eventBus.publish(envelope);
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
    // CRITICAL: Don't send subscriptions if adapter is destroyed
    if (this._isDestroyed) {
      this.logger.debug('Adapter destroyed, skipping subscription');
      return;
    }

    if (this.subscribedTokens.size === 0) {
      this.logger.debug('No tokens to subscribe to');
      return;
    }

    // Если уже идёт подписка - помечаем что нужен повтор
    if (this._isSubscribing) {
      this._needsResubscribe = true;
      this.logger.debug('Subscription in progress, will retry after completion');
      return;
    }

    this._isSubscribing = true;

    try {
      do {
        // Сбрасываем флаг перед каждой отправкой
        this._needsResubscribe = false;

        const tokens = Array.from(this.subscribedTokens);

        this.logger.info('Sending WebSocket subscription', {
          tokenCount: tokens.length,
          marketCount: Math.floor(tokens.length / 2),
          sampleTokens: tokens.slice(0, 2).map(t => t.substring(0, 16) + '...'),
        });

        // Polymarket требует переподключения для новых подписок
        await this.client.reconnectWithTimeout(1000);

        // Отправляем одно сообщение подписки со всеми токенами
        const params: SubscriptionParams = {
          assets_ids: tokens,
          type: 'market',
        };

        await this.client.subscribe('market', params);

        this.logger.info('Subscription sent successfully', {
          tokenCount: tokens.length,
        });

      } while (this._needsResubscribe); // Повторяем если были изменения
    } catch (error) {
      // Don't log error if adapter is destroyed (это нормально)
      if (this._isDestroyed) {
        this.logger.debug('Subscription failed after destroy (expected)', {
          error: error instanceof Error ? error.message : String(error),
        });
      } else {
        // Логируем ошибку но НЕ пробрасываем - предотвращаем crash
        this.logger.error('Failed to send subscriptions', {
          error: error instanceof Error ? error.message : String(error),
          tokenCount: this.subscribedTokens.size,
          hint: 'Check if token IDs are valid or if Polymarket API changed',
        });
      }
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
    // CRITICAL: Don't resubscribe if adapter is destroyed
    if (this._isDestroyed) {
      this.logger.debug('Adapter destroyed, skipping resubscribe');
      return;
    }

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
