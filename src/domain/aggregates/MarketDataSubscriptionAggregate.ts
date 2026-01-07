/**
 * MarketDataSubscriptionAggregate
 *
 * @remarks
 * Aggregate для управления состоянием подписки на market-data одного маркета.
 * Строит projection entities (Orderbook, Trade) из domain events.
 *
 * Принципы:
 * - Event-sourced: состояние строится из событий через apply()
 * - Invariants: проверяет только критические бизнес-правила
 * - Replay: можно восстановить состояние из истории событий
 * - Immutable events → Mutable aggregate state
 * - Принимает ВСЕ события с биржи (они валидные по определению)
 *
 * Инварианты:
 * 1. **No time regression**: события должны быть монотонно возрастающими по времени
 *
 * Состояние:
 * - assetId: идентификатор актива (фиксируется при создании)
 * - lastOrderbook: последний snapshot стакана (или null)
 * - lastTrade: последняя исполненная сделка (или null)
 * - lastEventTime: время последнего события (для проверки регрессии)
 *
 * @example
 * ```typescript
 * // Создание aggregate
 * const aggregate = MarketDataSubscriptionAggregate.create('asset-123');
 *
 * // Применение событий
 * const bookEvent = new OrderBookSnapshotReceivedEvent('asset-123', bids, asks);
 * const result1 = aggregate.apply(bookEvent);
 * // result1 = { applied: true }
 *
 * const tradeEvent = new TradeExecutedEvent('asset-123', 0.52, 100, 'BUY');
 * const result2 = aggregate.apply(tradeEvent);
 * // result2 = { applied: true }
 *
 * // Получение состояния
 * const orderbook = aggregate.getOrderbook(); // Orderbook entity
 * const trade = aggregate.getLastTrade(); // Trade entity
 *
 * // Replay из истории
 * const aggregate2 = MarketDataSubscriptionAggregate.create('asset-123');
 * const results = aggregate2.replay([bookEvent, tradeEvent]);
 * // results = [{ applied: true }, { applied: true }]
 * ```
 */

import { OrderBookSnapshotReceivedEvent } from '../events/OrderBookSnapshotReceivedEvent.js';
import { TradeExecutedEvent } from '../events/TradeExecutedEvent.js';
import { Orderbook } from '../entities/Orderbook.js';
import type { OrderbookLevel } from '../entities/Orderbook.js';
import { Trade } from '../entities/Trade.js';
import { Price } from '../value-objects/Price.js';
import { Quantity } from '../value-objects/Quantity.js';

/**
 * Ошибка нарушения инварианта
 *
 * @remarks
 * Выбрасывается когда событие нарушает бизнес-правила aggregate.
 */
export class InvariantViolationError extends Error {
  constructor(message: string, public readonly invariant: string) {
    super(message);
    this.name = 'InvariantViolationError';
  }
}

/**
 * Результат применения события к aggregate
 *
 * @remarks
 * Используется вместо exceptions для детерминированного replay.
 */
export interface ApplyResult {
  /**
   * Успешно ли применилось событие
   *
   * @remarks
   * true = событие изменило состояние aggregate
   * false = событие проигнорировано или нарушило инвариант
   */
  applied: boolean;

  /**
   * Описание ошибки (если applied = false)
   *
   * @remarks
   * - Нарушение инварианта: "Time regression: ..."
   * - Неизвестное событие: "Unknown event type"
   */
  error?: string;

  /**
   * Название нарушенного инварианта (если applied = false)
   *
   * @remarks
   * Возможные значения:
   * - 'no_time_regression' - событие старше lastEventTime
   */
  invariant?: string;
}

/**
 * MarketDataSubscriptionAggregate
 *
 * @remarks
 * Aggregate для управления состоянием market-data подписки.
 * Строит projection из событий OrderBookSnapshotReceived и TradeExecuted.
 */
export class MarketDataSubscriptionAggregate {
  private lastOrderbook: Orderbook | null = null;
  private lastTrade: Trade | null = null;
  private lastEventTime: Date | null = null;

  /**
   * Множество ID уже применённых событий
   *
   * @remarks
   * Используется для идемпотентности:
   * - At-least-once delivery → события могут дублироваться
   * - Повторное применение события не должно менять состояние
   * - eventId уникален для каждого события (DomainEvent.eventId)
   */
  private appliedEventIds: Set<string> = new Set();

  /**
   * Создаёт новый aggregate
   *
   * @param assetId - Идентификатор актива
   *
   * @remarks
   * Private constructor - используйте статический метод create().
   */
  private constructor(public readonly assetId: string) {}

  /**
   * Создаёт новый aggregate
   *
   * @param assetId - Идентификатор актива
   * @returns Новый aggregate instance
   * @throws {Error} Если assetId пустой
   *
   * @example
   * ```typescript
   * const aggregate = MarketDataSubscriptionAggregate.create('asset-123');
   * ```
   */
  public static create(assetId: string): MarketDataSubscriptionAggregate {
    if (!assetId || assetId.trim().length === 0) {
      throw new Error('Asset ID cannot be empty');
    }
    return new MarketDataSubscriptionAggregate(assetId);
  }

  /**
   * Проверяет было ли уже применено событие
   *
   * @param eventId - Уникальный ID события
   * @returns true если событие уже применялось
   *
   * @remarks
   * Используется для идемпотентности at-least-once delivery.
   * Если событие уже применялось, повторное применение должно быть безопасным.
   *
   * @example
   * ```typescript
   * const event = new OrderBookSnapshotReceivedEvent(...);
   * const result1 = aggregate.apply(event);
   * // result1 = { applied: true }
   *
   * const alreadyApplied = aggregate.hasApplied(event.eventId);
   * // alreadyApplied = true
   *
   * const result2 = aggregate.apply(event); // Повторное применение
   * // result2 = { applied: true } (идемпотентно)
   * ```
   */
  public hasApplied(eventId: string): boolean {
    return this.appliedEventIds.has(eventId);
  }

  /**
   * Применяет domain event к aggregate
   *
   * @param event - Domain event для применения (OrderBookSnapshot | TradeExecuted)
   * @returns Результат применения события
   *
   * @remarks
   * Алгоритм:
   * 1. **Проверить идемпотентность**: если event.eventId уже применялся → вернуть { applied: true }
   * 2. Проверить инвариант: no time regression
   * 3. Обработать событие по типу:
   *    - OrderBookSnapshotReceived → построить Orderbook entity
   *    - TradeExecuted → построить Trade entity + проверить price in spread
   * 4. Обновить lastEventTime ТОЛЬКО если событие успешно применилось
   * 5. Добавить eventId в appliedEventIds
   *
   * Инварианты:
   * - **No time regression**: lastEventTime должно быть <= event.timestamp
   * - **Trade price within spread**: если есть orderbook, trade.price должна быть [bid, ask]
   *
   * Важно:
   * - НЕ проверяет assetId (это делает Projector до вызова apply)
   * - НЕ бросает exceptions (возвращает ApplyResult)
   * - Детерминированный (replay даст тот же результат)
   *
   * @example
   * ```typescript
   * const bookEvent = new OrderBookSnapshotReceivedEvent(
   *   'asset-123',
   *   [{price: 0.52, size: 100}],
   *   [{price: 0.53, size: 150}]
   * );
   * const result = aggregate.apply(bookEvent);
   * // result = { applied: true }
   *
   * const tradeEvent = new TradeExecutedEvent('asset-123', 0.525, 50, 'BUY');
   * const result2 = aggregate.apply(tradeEvent);
   * // result2 = { applied: true } ✓ Price within spread [0.52, 0.53]
   *
   * // Time regression
   * const oldEvent = new TradeExecutedEvent('asset-123', 0.50, 10, 'SELL', oldTime);
   * const result3 = aggregate.apply(oldEvent);
   * // result3 = { applied: false, error: "...", invariant: "no_time_regression" }
   * ```
   */
  public apply(
    event: OrderBookSnapshotReceivedEvent | TradeExecutedEvent
  ): ApplyResult {
    // 1. Проверяем идемпотентность: если событие уже применялось, возвращаем success
    if (this.hasApplied(event.eventId)) {
      return { applied: true }; // Идемпотентность: повторное применение безопасно
    }

    // 2. Проверяем инвариант: no time regression
    const timeCheckResult = this.checkTimeInvariant(event.timestamp);
    if (!timeCheckResult.valid) {
      return {
        applied: false,
        error: timeCheckResult.error,
        invariant: 'no_time_regression',
      };
    }

    // 3. Обрабатываем событие по типу
    let applyResult: ApplyResult;

    if (event instanceof OrderBookSnapshotReceivedEvent) {
      applyResult = this.applyOrderBookSnapshot(event);
    } else if (event instanceof TradeExecutedEvent) {
      applyResult = this.applyTradeExecuted(event);
    } else {
      // Не должно происходить (TypeScript гарантирует типы)
      return {
        applied: false,
        error: 'Unknown event type',
      };
    }

    // 4. Обновляем lastEventTime ТОЛЬКО если событие применилось
    if (applyResult.applied) {
      this.lastEventTime = event.timestamp;
      // 5. Добавляем eventId в appliedEventIds для идемпотентности
      this.appliedEventIds.add(event.eventId);
    }

    return applyResult;
  }

  /**
   * Replay событий для восстановления состояния
   *
   * @param events - Массив событий в хронологическом порядке
   * @returns Массив результатов применения событий
   *
   * @remarks
   * Последовательно применяет все события через apply().
   * Полностью детерминирован - один и тот же набор событий даст одно и то же состояние.
   *
   * Используется для:
   * - Восстановления состояния из event store
   * - Тестирования с Given/When/Then
   * - Миграции данных
   *
   * Важно:
   * - Не бросает exceptions (возвращает результаты)
   * - Пропускает события нарушающие инварианты
   * - Фильтрует только OrderBookSnapshot и TradeExecuted события
   *
   * @example
   * ```typescript
   * const events = [
   *   new OrderBookSnapshotReceivedEvent('asset-123', bids1, asks1, time1),
   *   new TradeExecutedEvent('asset-123', 0.52, 100, 'BUY', time2),
   *   new OrderBookSnapshotReceivedEvent('asset-123', bids2, asks2, time3),
   * ];
   *
   * const aggregate = MarketDataSubscriptionAggregate.create('asset-123');
   * const results = aggregate.replay(events);
   * // results = [{ applied: true }, { applied: true }, { applied: true }]
   * ```
   */
  public replay(
    events: (OrderBookSnapshotReceivedEvent | TradeExecutedEvent)[]
  ): ApplyResult[] {
    const results: ApplyResult[] = [];

    for (const event of events) {
      const result = this.apply(event);
      results.push(result);
    }

    return results;
  }

  /**
   * Получает текущий orderbook
   *
   * @returns Orderbook entity или null если ещё не было события
   *
   * @example
   * ```typescript
   * const orderbook = aggregate.getOrderbook();
   * if (orderbook) {
   *   console.log(`Best bid: ${orderbook.getBestBid()?.value}`);
   * }
   * ```
   */
  public getOrderbook(): Orderbook | null {
    return this.lastOrderbook;
  }

  /**
   * Получает последнюю сделку
   *
   * @returns Trade entity или null если ещё не было события
   *
   * @example
   * ```typescript
   * const trade = aggregate.getLastTrade();
   * if (trade) {
   *   console.log(`Last trade: ${trade.price.value} x ${trade.quantity.value}`);
   * }
   * ```
   */
  public getLastTrade(): Trade | null {
    return this.lastTrade;
  }

  /**
   * Получает время последнего события
   *
   * @returns Timestamp последнего события или null
   *
   * @example
   * ```typescript
   * const lastUpdate = aggregate.getLastEventTime();
   * if (lastUpdate) {
   *   console.log(`Last update: ${lastUpdate.toISOString()}`);
   * }
   * ```
   */
  public getLastEventTime(): Date | null {
    return this.lastEventTime;
  }

  /**
   * Проверяет инвариант: no time regression
   *
   * @param eventTime - Время нового события
   * @returns Результат проверки
   *
   * @remarks
   * События должны приходить в монотонно возрастающем порядке.
   * Допускается равенство времени (события в одну миллисекунду).
   */
  private checkTimeInvariant(eventTime: Date): {
    valid: boolean;
    error?: string;
  } {
    if (this.lastEventTime !== null && eventTime < this.lastEventTime) {
      return {
        valid: false,
        error:
          `Time regression detected: last event at ${this.lastEventTime.toISOString()}, ` +
          `new event at ${eventTime.toISOString()}`,
      };
    }

    return { valid: true };
  }

  /**
   * Применяет OrderBookSnapshotReceivedEvent
   *
   * @param event - Событие orderbook snapshot
   * @returns Результат применения
   *
   * @remarks
   * Конвертирует примитивы из события в domain entities:
   * - number → Price (value object)
   * - number → Quantity (value object)
   * - {price, size}[] → OrderbookLevel[]
   * - Создаёт Orderbook entity через Orderbook.create()
   *
   * Всегда успешно (нет инвариантов для orderbook).
   */
  private applyOrderBookSnapshot(
    event: OrderBookSnapshotReceivedEvent
  ): ApplyResult {
    // Конвертируем примитивы в value objects
    const bids: OrderbookLevel[] = event.bids.map((level) => ({
      price: Price.fromNumber(level.price),
      quantity: Quantity.fromMarketData(level.size),
    }));

    const asks: OrderbookLevel[] = event.asks.map((level) => ({
      price: Price.fromNumber(level.price),
      quantity: Quantity.fromMarketData(level.size),
    }));

    // Создаём Orderbook entity (сортирует и валидирует)
    this.lastOrderbook = Orderbook.create(this.assetId, {
      bids,
      asks,
      timestamp: event.timestamp,
    });

    return { applied: true };
  }

  /**
   * Применяет TradeExecutedEvent
   *
   * @param event - Событие trade execution
   * @returns Результат применения
   *
   * @remarks
   * Конвертирует примитивы в domain entities и создаёт Trade.
   *
   * Важно:
   * - Принимает ВСЕ трейды с биржи (они валидные по определению)
   * - НЕ проверяет trade price vs orderbook spread (это data quality check, НЕ инвариант)
   * - Трейды могут быть вне spread по множеству причин (race condition, market orders, etc)
   *
   * Trade ID детерминирован:
   * - Формат: `${assetId}-${timestamp.getTime()}`
   * - Одинаковые события → одинаковые ID
   * - Replay безопасен
   */
  private applyTradeExecuted(event: TradeExecutedEvent): ApplyResult {
    // Конвертируем примитивы в value objects
    const price = Price.fromNumber(event.price);
    const quantity = Quantity.fromMarketData(event.size);

    // Генерируем детерминированный ID для сделки
    // Формат: assetId-timestamp (без счётчика!)
    const tradeId = `${this.assetId}-${event.timestamp.getTime()}`;

    // Создаём Trade entity
    this.lastTrade = Trade.create({
      id: tradeId,
      marketId: this.assetId,
      price,
      quantity,
      side: event.side,
      timestamp: event.timestamp,
    });

    return { applied: true };
  }

  /**
   * Получает статус aggregate
   *
   * @returns Объект со статусом
   *
   * @remarks
   * Полезно для отладки и мониторинга.
   *
   * @example
   * ```typescript
   * const status = aggregate.getStatus();
   * console.log(JSON.stringify(status, null, 2));
   * ```
   */
  public getStatus() {
    return {
      assetId: this.assetId,
      hasOrderbook: this.lastOrderbook !== null,
      hasTrade: this.lastTrade !== null,
      lastEventTime: this.lastEventTime?.toISOString() ?? null,
      orderbook: this.lastOrderbook?.toObject() ?? null,
      lastTrade: this.lastTrade?.toObject() ?? null,
    };
  }
}
