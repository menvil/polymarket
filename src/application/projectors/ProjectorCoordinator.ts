/**
 * ProjectorCoordinator - Wiring layer для EventBus → Projector → State → Callbacks
 *
 * @remarks
 * Координатор который связывает все компоненты projector архитектуры.
 *
 * ## Архитектура:
 *
 * ```
 * EventBus → ProjectorCoordinator → Projector (stateless) → StateManager
 *                    ↓
 *               CallbackRegistry
 * ```
 *
 * ## Ответственность:
 *
 * ✅ Подписывается на EventBus (subscribeAll)
 * ✅ Фильтрует события (OrderBookSnapshot, TradeExecuted)
 * ✅ Получает aggregate из StateManager
 * ✅ Вызывает соответствующий Projector (orderbook/trades)
 * ✅ При успехе: вызывает callbacks с entity
 * ✅ При ошибке: публикует MarketDataErrorEvent
 * ✅ Управляет CallbackRegistry для каждого assetId
 *
 * ## Что НЕ делает:
 *
 * ❌ Не применяет события напрямую (делегирует в Projector)
 * ❌ Не владеет state (делегирует в StateManager)
 * ❌ Не содержит бизнес-логику (только coordination)
 *
 * @example
 * ```typescript
 * const eventBus = new InMemoryEventBus();
 * const coordinator = new ProjectorCoordinator(eventBus, logger);
 *
 * // Subscribe to orderbook updates
 * coordinator.subscribeToOrderbook('asset-123', (orderbook) => {
 *   console.log(`Best bid: ${orderbook.getBestBid()?.value}`);
 * });
 *
 * // Subscribe to trades
 * coordinator.subscribeToTrades('asset-123', (trade) => {
 *   console.log(`Trade: ${trade.price.value}`);
 * });
 *
 * // EventBus publishes events → Coordinator processes → Callbacks invoked
 * const event = new OrderBookSnapshotReceivedEvent('asset-123', bids, asks);
 * eventBus.publish(event);
 * ```
 */

import type { DomainEvent } from '../../domain/events/DomainEvent.js';
import { OrderBookSnapshotReceivedEvent } from '../../domain/events/OrderBookSnapshotReceivedEvent.js';
import { TradeExecutedEvent } from '../../domain/events/TradeExecutedEvent.js';
import { MarketDataErrorEvent } from '../../domain/events/MarketDataErrorEvent.js';
import type { Orderbook } from '../../domain/entities/Orderbook.js';
import type { Trade } from '../../domain/entities/Trade.js';
import type { MarketDataSubscriptionAggregate } from '../../domain/aggregates/MarketDataSubscriptionAggregate.js';
import type { InMemoryEventBus } from '../../shared/events/InMemoryEventBus.js';
import type { ILogger } from '../../domain/ports/ILogger.js';
import { StateManager } from './StateManager.js';
import { OrderbookProjector } from './OrderbookProjector.js';
import { TradesProjector } from './TradesProjector.js';

/**
 * Callback для orderbook updates
 */
export type OrderbookCallback = (orderbook: Orderbook) => void;

/**
 * Callback для trade updates
 */
export type TradeCallback = (trade: Trade) => void;

/**
 * Simple Registry для callbacks одного типа
 *
 * @remarks
 * Переиспользуем из старого MarketDataProjector.
 */
class CallbackRegistry<T> {
  private callbacks: Set<(data: T) => void> = new Set();

  constructor(
    private readonly logger: ILogger,
    private readonly assetId: string
  ) {}

  public subscribe(callback: (data: T) => void): () => void {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }

  public notify(data: T): void {
    for (const callback of this.callbacks) {
      try {
        callback(data);
      } catch (error) {
        this.logger.error('Error in subscription callback', {
          assetId: this.assetId.substring(0, 16) + '...',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  public getCount(): number {
    return this.callbacks.size;
  }

  public clear(): void {
    this.callbacks.clear();
  }
}

/**
 * ProjectorCoordinator
 *
 * @remarks
 * Wiring layer между EventBus, Projectors, StateManager и Callbacks.
 */
export class ProjectorCoordinator {
  private readonly stateManager: StateManager;
  private readonly orderbookProjector: OrderbookProjector;
  private readonly tradesProjector: TradesProjector;
  private readonly orderbookRegistries: Map<string, CallbackRegistry<Orderbook>> =
    new Map();
  private readonly tradeRegistries: Map<string, CallbackRegistry<Trade>> =
    new Map();
  private unsubscribeFromBus?: () => void;

  /**
   * Создаёт новый ProjectorCoordinator
   *
   * @param eventBus - Event bus для подписки на события
   * @param logger - Logger для логирования
   *
   * @remarks
   * Автоматически создаёт StateManager и Projector'ы.
   * Подписывается на EventBus через subscribeAll().
   */
  constructor(
    private readonly eventBus: InMemoryEventBus,
    private readonly logger: ILogger
  ) {
    this.stateManager = new StateManager();
    this.orderbookProjector = new OrderbookProjector();
    this.tradesProjector = new TradesProjector();

    this.subscribeToEventBus();
  }

  /**
   * Подписывается на все события в EventBus
   *
   * @remarks
   * Фильтрует OrderBookSnapshotReceivedEvent и TradeExecutedEvent.
   * Остальные события игнорируются.
   */
  private subscribeToEventBus(): void {
    this.unsubscribeFromBus = this.eventBus.subscribeAll((event) => {
      this.handleEvent(event);
    });
  }

  /**
   * Обрабатывает событие из EventBus
   *
   * @param event - Domain event
   *
   * @remarks
   * **ВАЖНО**: Метод ДОЛЖЕН быть синхронным (контракт EventBus).
   * EventBus требует synchronous handlers: (event: T) => void
   *
   * Алгоритм:
   * 1. Фильтровать тип события (OrderBookSnapshot | TradeExecuted)
   * 2. Получить aggregate из StateManager (getOrCreate)
   * 3. Вызвать соответствующий Projector (orderbook/trades) - **синхронно**
   * 4. Если success → вызвать callbacks с entity - **синхронно**
   * 5. Если failure → опубликовать MarketDataErrorEvent - **синхронно**
   *
   * Все операции синхронные - нет await, нет async работы.
   */
  private handleEvent(event: DomainEvent): void {
    // Фильтруем только market-data события
    if (
      !(event instanceof OrderBookSnapshotReceivedEvent) &&
      !(event instanceof TradeExecutedEvent)
    ) {
      return;
    }

    const assetId = event.assetId;

    // Получаем или создаём Aggregate через StateManager
    const aggregate = this.stateManager.getOrCreate(assetId);

    // Применяем событие через соответствующий Projector
    if (event instanceof OrderBookSnapshotReceivedEvent) {
      const result = this.orderbookProjector.apply(event, aggregate);

      if (result.success) {
        // Успех: вызываем orderbook callbacks
        this.notifyOrderbookCallbacks(assetId, result.entity);
      } else {
        // Ошибка: публикуем error event
        this.handleProjectionError(assetId, result.error, result.invariant, event);
      }
    } else if (event instanceof TradeExecutedEvent) {
      const result = this.tradesProjector.apply(event, aggregate);

      if (result.success) {
        // Успех: вызываем trade callbacks
        this.notifyTradeCallbacks(assetId, result.entity);
      } else {
        // Ошибка: публикуем error event
        this.handleProjectionError(assetId, result.error, result.invariant, event);
      }
    }
  }

  /**
   * Вызывает orderbook callbacks
   *
   * @param assetId - Asset ID
   * @param orderbook - Orderbook entity
   */
  private notifyOrderbookCallbacks(assetId: string, orderbook: Orderbook): void {
    const registry = this.orderbookRegistries.get(assetId);
    if (registry) {
      registry.notify(orderbook);
    }
  }

  /**
   * Вызывает trade callbacks
   *
   * @param assetId - Asset ID
   * @param trade - Trade entity
   */
  private notifyTradeCallbacks(assetId: string, trade: Trade): void {
    const registry = this.tradeRegistries.get(assetId);
    if (registry) {
      registry.notify(trade);
    }
  }

  /**
   * Обрабатывает ошибку projection
   *
   * @param assetId - Asset ID
   * @param error - Описание ошибки
   * @param invariant - Название нарушенного инварианта
   * @param event - Original event
   *
   * @remarks
   * Публикует MarketDataErrorEvent в EventBus.
   */
  private handleProjectionError(
    assetId: string,
    error: string,
    invariant: string | undefined,
    event: DomainEvent
  ): void {
    this.logger.warn(
      `[ProjectorCoordinator] Projection error for ${assetId}: ${error}`,
      {
        assetId,
        invariant,
        eventName: event.eventName,
        eventId: event.eventId,
      }
    );

    // Публикуем error event
    const errorEvent = new MarketDataErrorEvent(
      assetId,
      'INVARIANT_VIOLATION',
      error,
      {
        invariant,
        eventName: event.eventName,
        eventId: event.eventId,
        eventTimestamp: event.timestamp.toISOString(),
      }
    );

    this.eventBus.publish(errorEvent);
  }

  /**
   * Подписывается на orderbook updates
   *
   * @param assetId - Asset ID to subscribe to
   * @param callback - Callback to invoke with Orderbook entity
   * @returns Unsubscribe function
   */
  public subscribeToOrderbook(
    assetId: string,
    callback: OrderbookCallback
  ): () => void {
    let registry = this.orderbookRegistries.get(assetId);
    if (!registry) {
      registry = new CallbackRegistry<Orderbook>(this.logger, assetId);
      this.orderbookRegistries.set(assetId, registry);
    }

    return registry.subscribe(callback);
  }

  /**
   * Подписывается на trade updates
   *
   * @param assetId - Asset ID to subscribe to
   * @param callback - Callback to invoke with Trade entity
   * @returns Unsubscribe function
   */
  public subscribeToTrades(
    assetId: string,
    callback: TradeCallback
  ): () => void {
    let registry = this.tradeRegistries.get(assetId);
    if (!registry) {
      registry = new CallbackRegistry<Trade>(this.logger, assetId);
      this.tradeRegistries.set(assetId, registry);
    }

    return registry.subscribe(callback);
  }

  /**
   * Получает текущий orderbook для assetId
   *
   * @param assetId - Asset ID
   * @returns Orderbook entity или null если нет данных
   */
  public getOrderbook(assetId: string): Orderbook | null {
    const aggregate = this.stateManager.get(assetId);
    return aggregate ? aggregate.getOrderbook() : null;
  }

  /**
   * Получает последнюю сделку для assetId
   *
   * @param assetId - Asset ID
   * @returns Trade entity или null если нет данных
   */
  public getLastTrade(assetId: string): Trade | null {
    const aggregate = this.stateManager.get(assetId);
    return aggregate ? aggregate.getLastTrade() : null;
  }

  /**
   * Получает aggregate для assetId
   *
   * @param assetId - Asset ID
   * @returns Aggregate или null если не существует
   *
   * @remarks
   * Полезно для тестирования и отладки.
   * Предоставляет прямой доступ к aggregate через StateManager.
   */
  public getAggregate(assetId: string): MarketDataSubscriptionAggregate | null {
    return this.stateManager.get(assetId);
  }

  /**
   * Получает количество подписчиков orderbook
   *
   * @param assetId - Asset ID
   * @returns Number of orderbook subscribers
   */
  public getOrderbookSubscriberCount(assetId: string): number {
    const registry = this.orderbookRegistries.get(assetId);
    return registry ? registry.getCount() : 0;
  }

  /**
   * Получает количество подписчиков trades
   *
   * @param assetId - Asset ID
   * @returns Number of trade subscribers
   */
  public getTradeSubscriberCount(assetId: string): number {
    const registry = this.tradeRegistries.get(assetId);
    return registry ? registry.getCount() : 0;
  }

  /**
   * Получает список tracked asset IDs
   *
   * @returns Array of asset IDs that have aggregates
   */
  public getTrackedAssetIds(): string[] {
    return this.stateManager.getTrackedAssetIds();
  }

  /**
   * Unsubscribes all orderbook callbacks for asset
   *
   * @param assetId - Asset ID
   */
  public unsubscribeAllOrderbooks(assetId: string): void {
    const registry = this.orderbookRegistries.get(assetId);
    if (registry) {
      registry.clear();
      this.orderbookRegistries.delete(assetId);
    }
  }

  /**
   * Unsubscribes all trade callbacks for asset
   *
   * @param assetId - Asset ID
   */
  public unsubscribeAllTrades(assetId: string): void {
    const registry = this.tradeRegistries.get(assetId);
    if (registry) {
      registry.clear();
      this.tradeRegistries.delete(assetId);
    }
  }

  /**
   * Очищает все данные (state и callbacks)
   *
   * @remarks
   * Полезно для тестирования и cleanup.
   */
  public clear(): void {
    this.stateManager.clear();
    this.orderbookRegistries.clear();
    this.tradeRegistries.clear();
  }

  /**
   * Уничтожает Coordinator
   *
   * @remarks
   * - Отписывается от EventBus
   * - Очищает все state и callbacks
   */
  public destroy(): void {
    if (this.unsubscribeFromBus) {
      this.unsubscribeFromBus();
      this.unsubscribeFromBus = undefined;
    }

    this.clear();
  }
}
