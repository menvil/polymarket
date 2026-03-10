# Application Layer Implementation Plan

## Polymarket Trading System — `packages/application/`

**Дата создания:** 2026-03-09
**Статус:** Проектирование (planning phase)
**Ветка:** `errors-fixes`

---

## 1. Обзор архитектуры

### Место Application Layer в системе

```
┌─────────────────────────────────────────────────────────────────────┐
│                      APPLICATION LAYER                              │
│                    packages/application/                            │
│                                                                     │
│  event-bus/   handlers/   use-cases/   strategy/   risk/           │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ использует
┌───────────────────────────▼─────────────────────────────────────────┐
│                        DOMAIN LAYER                                 │
│  entities/: Order, Fill, Position, Portfolio, Market, Trade         │
│  accounting/: Ledger, LedgerEntry, FillLedgerAdapter                │
│  market-data/: OrderBook, TradeTape                                 │
│  value-objects/: Price, Quantity, Quote, Fee, Balance …             │
└─────────────────────────────────────────────────────────────────────┘
                            │ использует
┌───────────────────────────▼─────────────────────────────────────────┐
│                      FOUNDATION LAYER                               │
│  errors/, ids/, logger/, math/, result/, time/                      │
└─────────────────────────────────────────────────────────────────────┘

         ↑ (внешний API-клиент добавляется позже через интерфейс IExchangeClient)
```

### Принципы проектирования

1. **Dependency Rule**: application слой зависит от domain и foundation, никогда наоборот.
2. **Result pattern**: все операции возвращают `Result<T, E>` из `@polymarket/result`, async-операции — `Promise<Result<T, E>>`.
3. **Immutability**: доменные агрегаты (Order, Position, Portfolio) immutable — handlers возвращают новые экземпляры и обновляют хранилище.
4. **Domain Event Outbox**: после каждой команды `Order.pullEvents()` — события публикуются в EventBus.
5. **Dependency Injection**: все сервисы принимают зависимости через конструктор; нет глобальных синглтонов.
6. **ILogger**: логирование через `ILogger` из `@polymarket/logger`; все сообщения на **английском языке**.

---

## 2. Структура пакетов

```
packages/application/
├── event-bus/                  # @polymarket/event-bus
│   ├── src/
│   │   ├── events/
│   │   │   ├── domain-events.ts    # FillReceivedEvent, OrderUpdatedEvent
│   │   │   ├── market-events.ts    # BookUpdatedEvent, TradeReceivedEvent
│   │   │   ├── risk-events.ts      # RiskLimitBreachedEvent
│   │   │   ├── strategy-events.ts  # StrategySignalEvent
│   │   │   └── index.ts            # ApplicationEvent union + EventMap
│   │   ├── IEventBus.ts
│   │   ├── EventBus.ts             # In-process async реализация (fanout)
│   │   └── index.ts
│   ├── package.json
│   └── ...
│
├── ports/                      # @polymarket/ports — Dependency Inversion (порты)
│   ├── src/
│   │   ├── IOrderRepository.ts     # Port для хранения Order агрегатов
│   │   ├── IPortfolioStore.ts      # Port для хранения Portfolio
│   │   ├── IProcessedFillRepository.ts  # Idempotency — уже обработанные fills
│   │   ├── IExchangeClient.ts      # Port для HTTP CLOB API
│   │   └── index.ts
│   ├── package.json
│   └── ...
│
├── handlers/                   # @polymarket/handlers — Ingress adapters
│   ├── src/
│   │   ├── BookUpdateHandler.ts
│   │   ├── FillEventHandler.ts
│   │   ├── OrderUpdateHandler.ts
│   │   └── index.ts
│   ├── package.json
│   └── ...
│
├── orchestrators/              # @polymarket/orchestrators — Явный слой оркестрации
│   ├── src/
│   │   ├── FillOrchestrator.ts         # FILL_RECEIVED → ProcessFillUseCase
│   │   ├── MarketDataOrchestrator.ts   # BOOK_UPDATED → стратегии
│   │   └── index.ts
│   ├── package.json
│   └── ...
│
├── use-cases/                  # @polymarket/use-cases
│   ├── src/
│   │   ├── PlaceOrderUseCase.ts
│   │   ├── ProcessFillUseCase.ts
│   │   ├── CancelOrderUseCase.ts
│   │   └── index.ts
│   ├── package.json
│   └── ...
│
├── strategy/                   # @polymarket/strategy
│   ├── src/
│   │   ├── IStrategy.ts
│   │   ├── ITradingAPI.ts          # Тонкий фасад для стратегий
│   │   ├── StrategyRunner.ts
│   │   └── index.ts
│   ├── package.json
│   └── ...
│
└── risk/                       # @polymarket/risk
    ├── src/
    │   ├── RiskParams.ts
    │   ├── RiskViolation.ts
    │   ├── OrderRiskChecker.ts         # Pre-trade: synchronous
    │   ├── DrawdownRiskMonitor.ts      # Post-trade: async monitoring
    │   └── index.ts
    ├── package.json
    └── ...
```

---

## 3. Package 1: `event-bus/` — `@polymarket/event-bus`

### Назначение

Типизированная in-process шина событий. Связывает handlers, use-cases и strategy без прямых зависимостей между ними.

### Зависимости

- `@polymarket/logger` (ILogger)
- `@polymarket/result`
- `@polymarket/order` (OrderEvent types — re-exported из EventMap)
- `@polymarket/ids`

### `events/domain-events.ts`

```typescript
// Domain-level события: fills, orders.
import type { FillId, OrderId } from '@polymarket/ids';
import type { Timestamp } from '@polymarket/value-objects';
import type { Fill } from '@polymarket/fill';
import type { OrderEvent } from '@polymarket/order';

// Order domain events (re-exported из Order.pullEvents())
export type { OrderEvent } from '@polymarket/order';

export interface FillReceivedEvent {
  readonly type: 'FILL_RECEIVED';
  readonly fill: Fill;
  readonly receivedAt: Timestamp;
}
```

### `events/market-events.ts`

```typescript
// Market data события: orderbook, trades.
// ВАЖНО: передаём OrderBookSnapshot (immutable), не mutable OrderBook.
// Причина: несколько стратегий читают событие одновременно (fanout).
// Если передать mutable OrderBook, стратегия A может получить данные
// уже изменённые стратегией B до того, как A успеет их прочитать.
import type { MarketId, InstrumentId } from '@polymarket/ids';
import type { Price, Quantity, Timestamp } from '@polymarket/value-objects';
import type { Trade } from '@polymarket/trade';

// Разбиваем snapshot на два события с разными частотами:
//
// TopOfBookEvent — high-frequency (каждое изменение лучшей цены).
//   Содержит только агрегаты: bestBid/bestAsk/spread/imbalance.
//   Копирование: O(1) — нет массивов, нет аллокаций.
//   Именно этот event нужен большинству стратегий на каждом тике.
//
// DepthSnapshotEvent — low-frequency (по запросу или раз в N ms).
//   Содержит полный стакан (100+ levels).
//   Стратегии подписываются только если нужна полная глубина.

export interface TopOfBook {
  readonly marketId: MarketId;
  readonly tokenId: InstrumentId;
  readonly bestBid?: Price;
  readonly bestAsk?: Price;
  readonly spread?: Price;
  readonly midpoint?: Price;
  readonly imbalance: number;   // (bidQty - askQty) / (bidQty + askQty), [-1, 1]
  readonly updatedAt: Timestamp;
}

export interface BookDepthLevel {
  readonly price: Price;
  readonly quantity: Quantity;
}

export interface BookDepthSnapshot {
  readonly marketId: MarketId;
  readonly tokenId: InstrumentId;
  readonly bids: readonly BookDepthLevel[];
  readonly asks: readonly BookDepthLevel[];
  readonly updatedAt: Timestamp;
}

// High-frequency: каждое изменение лучшей цены
export interface BookUpdatedEvent {
  readonly type: 'BOOK_UPDATED';
  readonly topOfBook: TopOfBook;
}

// Low-frequency: полный стакан (по подписке или запросу)
export interface BookDepthEvent {
  readonly type: 'BOOK_DEPTH';
  readonly depth: BookDepthSnapshot;
}

export interface TradeReceivedEvent {
  readonly type: 'TRADE_RECEIVED';
  readonly trade: Trade;
}
```

### `events/risk-events.ts`

```typescript
import type { Timestamp } from '@polymarket/value-objects';

export interface RiskLimitBreachedEvent {
  readonly type: 'RISK_LIMIT_BREACHED';
  readonly violation: string;
  readonly strategyId?: string;
  readonly triggeredAt: Timestamp;
}
```

### `events/strategy-events.ts`

```typescript
import type { MarketId, InstrumentId } from '@polymarket/ids';
import type { Price, Quantity } from '@polymarket/value-objects';

export interface StrategySignalEvent {
  readonly type: 'STRATEGY_SIGNAL';
  readonly strategyId: string;
  readonly signal: 'BUY' | 'SELL' | 'CANCEL_ALL' | 'HOLD';
  readonly marketId: MarketId;
  readonly tokenId: InstrumentId;
  readonly suggestedPrice?: Price;
  readonly suggestedSize?: Quantity;
}
```

### `events/index.ts` — единый union

```typescript
// Единая точка сборки ApplicationEvent.
// Каждая категория событий живёт в своём файле —
// EventMap не вырастает в 1000-строчный монолит.

export type { OrderEvent, FillReceivedEvent } from './domain-events.js';
export type { BookUpdatedEvent, TradeReceivedEvent, OrderBookSnapshot } from './market-events.js';
export type { RiskLimitBreachedEvent } from './risk-events.js';
export type { StrategySignalEvent } from './strategy-events.js';

import type { OrderEvent, FillReceivedEvent } from './domain-events.js';
import type { BookUpdatedEvent, TradeReceivedEvent } from './market-events.js';
import type { RiskLimitBreachedEvent } from './risk-events.js';
import type { StrategySignalEvent } from './strategy-events.js';

export type ApplicationEvent =
  | OrderEvent
  | FillReceivedEvent
  | BookUpdatedEvent      // high-frequency: top of book only
  | BookDepthEvent        // low-frequency: full depth snapshot
  | TradeReceivedEvent
  | RiskLimitBreachedEvent
  | StrategySignalEvent;

export type EventByType<T extends ApplicationEvent['type']> =
  Extract<ApplicationEvent, { type: T }>;
```

### `IEventBus.ts`

```typescript
import type { ApplicationEvent } from './EventMap.js';

/**
 * Типизированный обработчик события конкретного типа.
 *
 * @template T - Строковый литерал типа события
 */
export type EventHandler<T extends ApplicationEvent['type']> = (
  event: Extract<ApplicationEvent, { type: T }>
) => Promise<void>;

/**
 * Контракт шины событий.
 *
 * @remarks
 * - publish() не гарантирует порядок вызова обработчиков.
 * - Ошибки в обработчиках логируются, не propagate в вызывающий код.
 * - subscribe() возвращает функцию отписки (unsubscribe pattern).
 */
export interface IEventBus {
  /**
   * Публикует событие всем подписчикам данного типа.
   *
   * @param event - Событие для публикации
   */
  publish(event: ApplicationEvent): Promise<void>;

  /**
   * Публикует массив событий последовательно.
   *
   * @param events - Массив событий (например, из Order.pullEvents())
   */
  publishAll(events: readonly ApplicationEvent[]): Promise<void>;

  /**
   * Подписывается на события конкретного типа.
   *
   * @param type - Тип события (строковый литерал из EventMap)
   * @param handler - Обработчик события
   * @returns Функция отписки — вызвать для снятия подписки
   */
  subscribe<T extends ApplicationEvent['type']>(
    type: T,
    handler: EventHandler<T>
  ): () => void;

  /**
   * Отписывает все обработчики (для корректного shutdown).
   */
  unsubscribeAll(): void;
}
```

### `EventBus.ts`

```typescript
// In-process асинхронная реализация IEventBus.

// ─── Типобезопасный реестр ────────────────────────────────────────────────────
// Проблема с Map<string, Set<EventHandler>>: TypeScript не контролирует
// соответствие типов — можно подписать handler<FILL_RECEIVED> на 'BOOK_UPDATED'.
//
// Решение: используем mapped type — каждому ключу соответствует строго
// типизированный Set обработчиков именно для этого события.
type HandlerMap = {
  [K in ApplicationEvent['type']]?: Set<EventHandler<K>>;
};

export class EventBus implements IEventBus {
  private readonly _handlers: HandlerMap = {};
  private readonly _logger: ILogger;
  // Bounded queue для backpressure: если handlers медленные,
  // publish() не накапливает unbounded Promise.all chains.
  private _publishingCount = 0;
  private readonly _maxConcurrentPublish: number;

  constructor(logger: ILogger, maxConcurrentPublish = 1000) {
    this._logger = logger.child({ component: 'EventBus' });
    this._maxConcurrentPublish = maxConcurrentPublish;
  }

  public async publish(event: ApplicationEvent): Promise<void> {
    // Backpressure guard: если слишком много одновременных публикаций,
    // логируем предупреждение. В production заменить на очередь с bounded buffer.
    this._publishingCount++;
    if (this._publishingCount > this._maxConcurrentPublish) {
      this._logger.warn('EventBus backpressure: too many concurrent publishes', {
        count: this._publishingCount,
        eventType: event.type,
      });
    }

    try {
      const handlers = this._handlers[event.type] as Set<EventHandler<typeof event.type>> | undefined;
      if (!handlers || handlers.size === 0) return;

      // Fanout: все handlers одного события — параллельно (latency = max, не sum).
      // ВАЖНО: Node.js single-thread не защищает от логических race conditions.
      // Async handler делает await — в этот момент event loop обрабатывает
      // другие события. State может измениться до resume.
      // Правило: handlers должны читать state атомарно В НАЧАЛЕ и не полагаться
      // на то, что state не изменился между await-вызовами.
      await Promise.all(
        [...handlers].map((handler) =>
          (handler(event as never) as Promise<void>).catch((error: unknown) => {
            this._logger.error('Event handler failed', error as Error, {
              eventType: event.type,
            });
          })
        )
      );
    } finally {
      this._publishingCount--;
    }
  }

  public async publishAll(events: readonly ApplicationEvent[]): Promise<void> {
    // publishAll — НАМЕРЕННО последовательно: порядок внутри batch КРИТИЧЕН.
    // ORDER_CREATED → ORDER_ACCEPTED → ORDER_FILLED — это FSM переходы.
    // Если запустить параллельно, handler может увидеть ORDER_FILLED
    // раньше чем ORDER_CREATED — нарушение инварианта.
    //
    // Latency trade-off: batch из 3 событий × 5ms = 15ms.
    // Это допустимо: Order.pullEvents() редко даёт > 3 событий за раз.
    // BOOK_UPDATED (high-frequency) никогда не идёт через publishAll.
    for (const event of events) {
      await this.publish(event);
    }
  }

  public subscribe<T extends ApplicationEvent['type']>(
    type: T,
    handler: EventHandler<T>
  ): () => void {
    if (!this._handlers[type]) {
      this._handlers[type] = new Set() as HandlerMap[T];
    }
    (this._handlers[type] as Set<EventHandler<T>>).add(handler);

    return () => {
      (this._handlers[type] as Set<EventHandler<T>> | undefined)?.delete(handler);
    };
  }

  public unsubscribeAll(): void {
    for (const key of Object.keys(this._handlers) as ApplicationEvent['type'][]) {
      delete this._handlers[key];
    }
  }
}
```

---

## 4. Package 2: `handlers/` — `@polymarket/handlers`

### Назначение

Обработчики входящих событий с биржи. Переводят raw данные от WebSocket/HTTP в доменные операции.

### Зависимости

- `@polymarket/event-bus`
- `@polymarket/order`
- `@polymarket/fill`
- `@polymarket/order-book`
- `@polymarket/trade`
- `@polymarket/trade-tape`
- `@polymarket/logger`
- `@polymarket/result`

### `BookUpdateHandler.ts`

Обрабатывает обновления стакана с биржи. Мутирует `OrderBook` (mutable by design — высокая частота), публикует `BookUpdatedEvent`.

```typescript
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import type { IEventBus } from '@polymarket/event-bus';
import type { MarketId, InstrumentId } from '@polymarket/ids';
import { TimestampService } from '@polymarket/value-objects';
import { OrderBook } from '@polymarket/order-book';
import type { OrderBookDelta } from '@polymarket/order-book';

/**
 * Реестр стаканов — один OrderBook на (marketId, tokenId).
 *
 * @remarks
 * BookUpdateHandler владеет OrderBook экземплярами.
 * OrderBook — mutable (design decision для high-frequency updates).
 * Снапшот получается через book.toSnapshot() для передачи вовне.
 */
export interface IBookRegistry {
  get(marketId: MarketId, tokenId: InstrumentId): OrderBook | undefined;
  getOrCreate(marketId: MarketId, tokenId: InstrumentId): OrderBook;
}

export class BookUpdateHandler {
  private readonly _books: IBookRegistry;
  private readonly _eventBus: IEventBus;
  private readonly _clock: IClock;
  private readonly _logger: ILogger;

  constructor(books: IBookRegistry, eventBus: IEventBus, clock: IClock, logger: ILogger) {
    this._books = books;
    this._eventBus = eventBus;
    this._clock = clock;
    this._logger = logger.child({ handler: 'BookUpdateHandler' });
  }

  /**
   * Применяет полный снапшот стакана (при подключении/реконнекте).
   *
   * @param marketId - ID рынка
   * @param tokenId - ID токена
   * @param bids - Bid уровни (PriceLevel[])
   * @param asks - Ask уровни (PriceLevel[])
   */
  public async handleFullState(
    marketId: MarketId,
    tokenId: InstrumentId,
    bids: PriceLevel[],
    asks: PriceLevel[]
  ): Promise<void> {
    const book = this._books.getOrCreate(marketId, tokenId);
    book.applyFullState(bids, asks);

    this._logger.debug('Order book full state applied', {
      marketId,
      tokenId,
      bidsCount: bids.length,
      asksCount: asks.length,
    });

    // Fix #1: публикуем TopOfBook (immutable snapshot), а НЕ mutable OrderBook.
    // book.toTopOfBook() создаёт O(1) снапшот (только лучший bid/ask),
    // что соответствует BookUpdatedEvent структуре: { type, topOfBook }.
    await this._eventBus.publish({
      type: 'BOOK_UPDATED',
      topOfBook: book.toTopOfBook(),
    });
  }

  /**
   * Применяет инкрементальное обновление стакана (delta).
   *
   * @param marketId - ID рынка
   * @param tokenId - ID токена
   * @param delta - Дельта уровней
   */
  public async handleDelta(
    marketId: MarketId,
    tokenId: InstrumentId,
    delta: OrderBookDelta
  ): Promise<void> {
    const book = this._books.get(marketId, tokenId);
    if (!book) {
      this._logger.warn('Received delta for unknown order book, ignoring', { marketId, tokenId });
      return;
    }

    book.applyDelta(delta);

    // Fix #1: публикуем TopOfBook (immutable snapshot), а НЕ mutable OrderBook.
    await this._eventBus.publish({
      type: 'BOOK_UPDATED',
      topOfBook: book.toTopOfBook(),
    });
  }
}
```

### `FillEventHandler.ts`

Принимает raw fill-событие с биржи (Polymarket WebSocket user-channel), парсит через `FillMapper`, публикует в EventBus. Не обновляет Portfolio напрямую — это задача `ProcessFillUseCase`.

```typescript
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import type { IEventBus } from '@polymarket/event-bus';
import type { AccountId } from '@polymarket/ids';
import { TimestampService } from '@polymarket/value-objects';
import { FillMapper } from '@polymarket/fill';

/**
 * Raw payload из Polymarket WebSocket user-channel (событие трейда).
 *
 * @remarks
 * Это raw JSON от биржи — до парсинга.
 * Поля совпадают с форматом Polymarket trade event API.
 */
export interface RawPolymarketTradeEvent {
  readonly id: string;
  readonly taker_order_id: string;
  readonly trader_side: string;
  readonly price: string;
  readonly size: string;
  readonly fee_rate_bps: string;
  readonly status: string;
  readonly maker_orders: readonly RawMakerOrder[];
  // ... другие поля venue
}

export interface RawMakerOrder {
  readonly order_id: string;
  readonly matched_amount: string;
}

export class FillEventHandler {
  private readonly _eventBus: IEventBus;
  private readonly _clock: IClock;
  private readonly _logger: ILogger;

  constructor(eventBus: IEventBus, clock: IClock, logger: ILogger) {
    this._eventBus = eventBus;
    this._clock = clock;
    this._logger = logger.child({ handler: 'FillEventHandler' });
  }

  /**
   * Обрабатывает raw fill-событие с биржи.
   *
   * @param raw - Raw payload из Polymarket WebSocket
   * @param accountId - ID аккаунта (из конфигурации)
   */
  public async handle(raw: RawPolymarketTradeEvent, accountId: AccountId): Promise<void> {
    const result = FillMapper.fromPolymarketTradeEvent(raw, accountId);

    if (!result.ok) {
      this._logger.error('Failed to parse fill event from venue', undefined, {
        error: result.error.message,
        rawEventId: raw.id,
      });
      return;
    }

    const { fill, metadata } = result.value;

    this._logger.info('Fill event received from venue', {
      fillId: fill.id,
      orderId: fill.orderId,
      side: fill.side,
      price: fill.price.value().toNumber(),
      size: fill.size.value().toNumber(),
      liquidity: metadata.liquidity,
    });

    const receivedAt = TimestampService.create(this._clock.now()).value;
    await this._eventBus.publish({
      type: 'FILL_RECEIVED',
      fill,
      receivedAt,
    });
  }
}
```

### `OrderUpdateHandler.ts`

Принимает обновления статуса ордера с биржи (accepted/rejected/cancelled/expired). Применяет к Order агрегату и публикует domain events через EventBus.

```typescript
import type { ILogger } from '@polymarket/logger';
import type { IEventBus } from '@polymarket/event-bus';
import type { OrderId } from '@polymarket/ids';
import type { Order } from '@polymarket/order';
import type { Result } from '@polymarket/result';
import type { TradingError } from '@polymarket/errors';

/**
 * Репозиторий ордеров — интерфейс для хранилища активных ордеров.
 *
 * @remarks
 * Application layer зависит от этого интерфейса (Port).
 * Конкретная реализация (in-memory Map, Redis) живёт в infrastructure.
 */
// Fix #11: IOrderRepository определён ТОЛЬКО в @polymarket/ports.
// Убран дублирующий интерфейс из handlers/.
// OrderUpdateHandler импортирует из '../ports/index.js' или '@polymarket/ports'.
// import type { IOrderRepository } from '@polymarket/ports';

/** Тип обновления статуса ордера с биржи */
export type VenueOrderUpdate =
  | { type: 'ACCEPTED'; orderId: OrderId }
  | { type: 'REJECTED'; orderId: OrderId; reason: string }
  | { type: 'CANCELLED'; orderId: OrderId; reason?: string }
  | { type: 'EXPIRED'; orderId: OrderId };

export class OrderUpdateHandler {
  private readonly _orders: IOrderRepository;
  private readonly _eventBus: IEventBus;
  private readonly _logger: ILogger;

  constructor(orders: IOrderRepository, eventBus: IEventBus, logger: ILogger) {
    this._orders = orders;
    this._eventBus = eventBus;
    this._logger = logger.child({ handler: 'OrderUpdateHandler' });
  }

  /**
   * Обрабатывает обновление статуса ордера с биржи.
   *
   * @param update - Обновление от venue (raw, после парсинга биржевого формата)
   */
  public async handle(update: VenueOrderUpdate): Promise<void> {
    const orderId = update.orderId as OrderId;
    const order = this._orders.get(orderId);

    if (!order) {
      this._logger.warn('Received status update for unknown order, ignoring', {
        orderId: update.orderId,
        updateType: update.type,
      });
      return;
    }

    let result: Result<Order, TradingError>;

    switch (update.type) {
      case 'ACCEPTED':
        result = order.accept();
        break;
      case 'REJECTED':
        result = order.reject(update.reason);
        break;
      case 'CANCELLED':
        result = order.cancel(update.reason);
        break;
      case 'EXPIRED':
        result = order.expire();
        break;
    }

    if (!result.ok) {
      this._logger.error('Failed to apply venue order update to order aggregate', undefined, {
        orderId: update.orderId,
        updateType: update.type,
        error: result.error.message,
        currentStatus: order.status,
      });
      return;
    }

    const updatedOrder = result.value;
    this._orders.save(updatedOrder);

    // Извлекаем domain events и публикуем в EventBus (Domain Event Outbox pattern)
    const events = updatedOrder.pullEvents();
    await this._eventBus.publishAll(events as ApplicationEvent[]);

    this._logger.info('Order status updated', {
      orderId: update.orderId,
      updateType: update.type,
      newStatus: updatedOrder.status,
    });
  }
}
```

---

## 4.5. Package: `ports/` — `@polymarket/ports`

### Назначение

Dependency Inversion: порты (интерфейсы) для инфраструктурных зависимостей.
Определяются в `application/` слое — реализации живут в `infrastructure/`.
Use-cases и handlers зависят от портов, не от конкретных реализаций.

```typescript
// IOrderRepository.ts
// Fix #11: единственное место определения — ports/.
// Добавлены методы для StrategyRunner (getByStrategyId) и OrderRiskChecker (countByStrategyId).
export interface IOrderRepository {
  get(orderId: OrderId): Order | undefined;
  save(order: Order): void;
  delete(orderId: OrderId): void;
  /** Возвращает все открытые ордера стратегии (для ITradingAPI.getOpenOrders). */
  getByStrategyId(strategyId: string): readonly Order[];
  /** O(1) счётчик открытых ордеров стратегии (для OrderRiskChecker). */
  countByStrategyId(strategyId?: string): number;
}

// IPortfolioStore.ts
// CAS (Compare-And-Swap) версионирование для защиты от read-modify-write race.
// Проблема без CAS:
//   ProcessFill читает Portfolio v1 → ...await... → сохраняет v2
//   CancelOrder читает Portfolio v1 → ...await... → сохраняет v2 (перезаписывает v2 ProcessFill)
// С CAS: save() проверяет, что version в store совпадает с expectedVersion.
// Если нет — VersionConflictError → caller должен retry с re-read.
export interface IPortfolioStore {
  get(accountId: AccountId): Portfolio | undefined;
  /** @throws VersionConflictError если portfolio был изменён с момента get() */
  save(portfolio: Portfolio, expectedVersion: number): Result<void, VersionConflictError>;
}

export class VersionConflictError extends TradingError {
  public readonly severity: ErrorSeverity = 'low'; // caller должен retry
}

// IProcessedFillRepository.ts
// Idempotency guard — предотвращает двойную обработку fill.
// Биржи иногда присылают duplicate events (reconnect, retry).
//
// ВАЖНО: has() + mark() — НЕ атомарно!
// Race condition: два concurrent ProcessFillUseCase могут оба вызвать has()
// до того, как любой из них вызовет mark().
// Решение: markIfNotExists() — атомарная операция "пометить и сообщить о результате".
// Возвращает true если fill был впервые помечен (нужно обрабатывать).
// Возвращает false если fill уже был помечен ранее (дубликат, пропустить).
//
// В Node.js single-thread это обеспечивается тем, что функция синхронная
// (никаких await внутри) — event loop не переключится между markIfNotExists и
// следующей строкой кода.
export interface IProcessedFillRepository {
  markIfNotExists(fillId: FillId): boolean; // true = первый раз, false = дубликат
}

// IExchangeClient.ts
export interface IExchangeClient {
  submitOrder(params: SubmitOrderParams): Promise<Result<OrderId, ExchangeError>>;
  cancelOrder(orderId: OrderId): Promise<Result<void, ExchangeError>>;
}

export interface SubmitOrderParams {
  readonly asset: AssetId;
  readonly side: Side;
  readonly price: Price;
  readonly size: Quantity;
  readonly strategyId?: string;
}
```

---

## 4.6. Package: `orchestrators/` — `@polymarket/orchestrators`

### Назначение

**Явный orchestration layer** — связывает EventBus-события с use-cases.
Это главный ответ на вопрос "кто вызывает ProcessFillUseCase?":
`FillOrchestrator` подписывается на `FILL_RECEIVED` и вызывает use-case.

Без этого слоя orchestration размазывается по системе и появляется hidden coupling.

### `FillOrchestrator.ts`

```typescript
// FillEventHandler          → EventBus(FILL_RECEIVED)
//                                     ↓
// FillOrchestrator          → ProcessFillUseCase
//                                     ↓
//                              EventBus(domain events)

export class FillOrchestrator {
  constructor(
    private readonly _eventBus: IEventBus,
    private readonly _processFill: ProcessFillUseCase,
    private readonly _logger: ILogger
  ) {}

  public register(): void {
    this._eventBus.subscribe('FILL_RECEIVED', async (event) => {
      const result = await this._processFind.execute({ fill: event.fill });
      if (!result.ok) {
        this._logger.error('ProcessFillUseCase failed', result.error, {
          fillId: event.fill.id,
        });
      }
    });
  }
}
```

### `RiskOrchestrator.ts` (переименован из MarketDataOrchestrator)

```typescript
// Fix #10: MarketDataOrchestrator переименован в RiskOrchestrator.
// Его ЕДИНСТВЕННАЯ ответственность: RISK_LIMIT_BREACHED → StrategyRunner.onRiskBreached().
//
// BOOK_UPDATED и BOOK_DEPTH подписки убраны.
// Причина: стратегии подписываются напрямую через ctx.api.subscribe() в initialize().
// Цепочка BookUpdateHandler → EventBus(BOOK_UPDATED) → strategies (напрямую).
// Лишний hop через MarketDataOrchestrator → StrategyRunner.onBookUpdate → EventBus
// создавал петлю (Fix #2) и добавлял latency без пользы.
//
// Итоговые цепочки:
//   BookUpdateHandler → EventBus(BOOK_UPDATED) → strategy handlers (напрямую)
//   RiskOrchestrator  → EventBus(RISK_LIMIT_BREACHED) → StrategyRunner.onRiskBreached()

export class RiskOrchestrator {
  constructor(
    private readonly _eventBus: IEventBus,
    private readonly _strategyRunner: IStrategyRunner,
    private readonly _logger: ILogger
  ) {}

  public register(): void {
    this._eventBus.subscribe('RISK_LIMIT_BREACHED', async (event) => {
      await this._strategyRunner.onRiskBreached(event);
    });
  }
}
```

---

## 5. Package 3: `use-cases/` — `@polymarket/use-cases`

### Назначение

Бизнес-сценарии верхнего уровня. Каждый use case координирует несколько доменных агрегатов через порты из `@polymarket/ports`. Возвращает `Result`.

### Зависимости

- `@polymarket/ports` (IOrderRepository, IPortfolioStore, IProcessedFillRepository, IExchangeClient)
- `@polymarket/event-bus`
- `@polymarket/order`
- `@polymarket/fill`
- `@polymarket/position`
- `@polymarket/portfolio`
- `@polymarket/ledger`
- `@polymarket/risk`
- `@polymarket/logger`
- `@polymarket/result`
- `@polymarket/ids`
- `@polymarket/value-objects`

### `PlaceOrderUseCase.ts`

```typescript
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import type { AccountId, OrderId } from '@polymarket/ids';
import type { Price, Quantity, Side, Timestamp } from '@polymarket/value-objects';
import type { AssetId } from '@polymarket/ids';
import { Order } from '@polymarket/order';
import type { Portfolio } from '@polymarket/portfolio';
import { Money } from '@polymarket/value-objects/money';
import type { IOrderRepository, IPortfolioStore, IExchangeClient } from '@polymarket/ports';
import type { IEventBus, ApplicationEvent } from '@polymarket/event-bus';
import type { IRiskChecker } from '@polymarket/risk';
import type { IExchangeClient } from './ports.js';
import type { ILogger } from '@polymarket/logger';
import type { TradingError } from '@polymarket/errors';

export interface PlaceOrderInput {
  readonly accountId: AccountId;
  readonly asset: AssetId;
  readonly side: Side;
  readonly price: Price;
  readonly size: Quantity;
  readonly timestamp: Timestamp;
  readonly strategyId?: string;
}

export interface PlaceOrderOutput {
  readonly order: Order;
  readonly orderId: OrderId;
}

export type PlaceOrderError = TradingError | RiskViolationError | ExchangeError | InvalidBalanceError;

/**
 * PlaceOrderUseCase — размещение нового лимитного ордера.
 *
 * @remarks
 * ### Алгоритм:
 * 1. Проверка риск-лимитов (RiskChecker) — до любых доменных операций.
 * 2. Создание Order агрегата (Order.create()) — всегда PENDING.
 * 3. Резервирование средств в Portfolio (portfolio.reserveForOrder()).
 * 4. Отправка ордера на биржу (IExchangeClient.submitOrder()) — async.
 * 5. Сохранение Order в репозитории.
 * 6. Публикация OrderCreatedEvent через EventBus (из Order.pullEvents()).
 *
 * ### Откат при ошибке:
 * Если биржа вернула ошибку → portfolio.releaseReservation() →
 * Order удаляется из репозитория (он в PENDING, не OPEN).
 *
 * ### Почему Order.id генерируется локально:
 * Polymarket позволяет задать clientOrderId. Это даёт идемпотентность:
 * при ретрае с тем же ID биржа вернёт уже существующий ордер.
 */
export class PlaceOrderUseCase {
  constructor(
    private readonly _orders: IOrderRepository,
    private readonly _portfolioStore: IPortfolioStore,
    private readonly _risk: IRiskChecker,
    private readonly _exchange: IExchangeClient,
    private readonly _eventBus: IEventBus,
    private readonly _logger: ILogger,
  ) {}

  public async execute(input: PlaceOrderInput): Promise<Result<PlaceOrderOutput, PlaceOrderError>> {
    const log = this._logger.child({
      useCase: 'PlaceOrderUseCase',
      accountId: String(input.accountId),
      asset: String(input.asset),
      side: input.side,
    });

    // Шаг 1: получить Portfolio (нужен для риск-проверки и резервирования).
    // Fix #5: null check — Portfolio обязан существовать к моменту размещения ордера.
    // Fix #12: portfolio нужен для PreOrderCheckInput.
    const oldPortfolio = this._portfolioStore.get(input.accountId);
    if (!oldPortfolio) {
      log.error('Portfolio not found for account', undefined, { accountId: String(input.accountId) });
      return Err(new TradingError(`Portfolio not found for account: ${String(input.accountId)}`));
    }

    // Шаг 2: риск-проверка
    // Fix #12: PlaceOrderInput → PreOrderCheckInput (разные типы, явное маппирование).
    // OrderRiskChecker.checkBeforeOrder принимает PreOrderCheckInput, не PlaceOrderInput.
    const riskInput: PreOrderCheckInput = {
      portfolio: oldPortfolio,
      openOrdersCount: this._orders.countByStrategyId(input.strategyId),
      side: input.side,
      price: input.price,
      size: input.size,
      instrumentId: input.asset as unknown as InstrumentId,
      strategyId: input.strategyId,
    };
    const riskResult = this._risk.checkBeforeOrder(riskInput);
    if (!riskResult.ok) {
      log.warn('Order rejected by risk checker', { violation: riskResult.error.toString() });
      return Err(riskResult.error);
    }

    // Шаг 3: создание Order агрегата
    const orderResult = Order.create({
      id: this._generateOrderId(),
      asset: input.asset,
      side: input.side,
      price: input.price,
      size: input.size,
      timestamp: input.timestamp,
      strategyId: input.strategyId,
    });
    if (!orderResult.ok) {
      return Err(orderResult.error);
    }
    const order = orderResult.value;

    // Шаг 4: резервирование средств
    // ВАЖНО: oldPortfolio уже загружен на шаге 1.
    // Portfolio immutable — reserveForOrder() возвращает новый экземпляр.
    // Rollback = сохранить oldPortfolio (не новый reserveResult.value).
    const notional = Money.of(
      input.price.value().times(input.size.value()),
      'USDC'
    );
    const reserveResult = oldPortfolio.reserveForOrder(notional);
    if (!reserveResult.ok) {
      log.warn('Insufficient funds to place order', { required: notional.value().toNumber() });
      return Err(reserveResult.error);
    }

    // Шаг 5: отправка на биржу
    const submitResult = await this._exchange.submitOrder({
      asset: input.asset,
      side: input.side,
      price: input.price,
      size: input.size,
      strategyId: input.strategyId,
    });

    if (!submitResult.ok) {
      // Rollback: биржа отклонила — возвращаем oldPortfolio (без резервирования).
      // Fix #4: передаём oldPortfolio.version — CAS для rollback.
      // reserveResult.value — это уже новый объект с резервом, его не сохраняем.
      this._portfolioStore.save(oldPortfolio, oldPortfolio.version);
      log.error('Exchange rejected order submission', undefined, {
        orderId: order.id,
        error: submitResult.error.message,
      });
      return Err(submitResult.error);
    }

    // Шаг 6: сохранение
    // Fix #4: CAS — передаём oldPortfolio.version (версия до резервирования).
    this._orders.save(order);
    this._portfolioStore.save(reserveResult.value, oldPortfolio.version); // CAS: version must match

    // Шаг 7: публикация domain events
    const events = order.pullEvents();
    await this._eventBus.publishAll(events as ApplicationEvent[]);

    log.info('Order placed successfully', {
      orderId: order.id,
      price: input.price.value().toNumber(),
      size: input.size.value().toNumber(),
    });

    return Ok({ order, orderId: order.id });
  }

  private _generateOrderId(): OrderId {
    // ULID: Universally Unique Lexicographically Sortable Identifier.
    // Преимущества перед ${Date.now()}-${Math.random()}:
    // 1. Sortable: ULID лексикографически упорядочен по времени создания.
    // 2. Collision-safe под нагрузкой: монотонно увеличивается в пределах ms.
    // 3. Deterministic retry: при retry с тем же seed получаем тот же ID.
    // Зависимость: ulid (1KB, zero dependencies).
    // import { ulid } from 'ulid';
    return asOrderId(ulid())!;
  }
}
```

### `ProcessFillUseCase.ts`

Критический use case. Обрабатывает подтверждённый fill.
Вместо прямого управления 5 агрегатами — делегирует в domain services.

```typescript
export interface ProcessFillInput {
  readonly fill: Fill;
}

export type ProcessFillError = TradingError | ValidationError;

/**
 * ProcessFillUseCase — обработка исполнения ордера.
 *
 * @remarks
 * ### Алгоритм:
 * 0. Idempotency check — если fill уже обработан, пропустить (markIfNotExists = atomic).
 * 1. Получаем Order по fill.orderId.
 * 2. OrderService.applyFill(order, fill) → updatedOrder.
 * 3. PortfolioService.applyFill(portfolio, fill) → updatedPortfolio (с CAS retry loop).
 * 4. LedgerService.record(fill) — записывает в Ledger.
 * 5. Сохраняем агрегаты (portfolioStore.save с CAS version).
 * 6. Публикуем domain events.
 *
 * ### SRP: каждый сервис знает только своё
 * - OrderService: бизнес-логика применения fill к Order FSM
 * - PortfolioService: обновление баланса + позиции
 * - LedgerService: двойная запись
 */
export class ProcessFillUseCase {
  constructor(
    private readonly _orders: IOrderRepository,
    private readonly _portfolioStore: IPortfolioStore,
    private readonly _processedFills: IProcessedFillRepository,
    private readonly _orderService: OrderService,
    private readonly _portfolioService: PortfolioService,
    private readonly _ledgerService: LedgerService,
    private readonly _eventBus: IEventBus,
    private readonly _logger: ILogger,
  ) {}

  public async execute(input: ProcessFillInput): Promise<Result<void, ProcessFillError>> {
    const { fill } = input;
    const log = this._logger.child({
      useCase: 'ProcessFillUseCase',
      fillId: String(fill.id),
      orderId: String(fill.orderId),
    });

    // Шаг 0: идемпотентность — атомарная операция markIfNotExists().
    // НЕЛЬЗЯ использовать has() + mark() — это НЕ атомарно.
    // Race condition: два concurrent вызова execute() оба увидят has()=false
    // до того как любой из них вызовет mark().
    //
    // markIfNotExists() синхронна (нет await внутри) — в Node.js
    // event loop не переключится между вызовом и следующей строкой.
    // Это гарантирует атомарность в single-thread окружении.
    const isFirstTime = this._processedFills.markIfNotExists(fill.id);
    if (!isFirstTime) {
      log.warn('Duplicate fill received, skipping (idempotency guard)', {});
      return Ok(undefined);
    }

    // Шаг 1: найти Order
    const order = this._orders.get(fill.orderId);
    if (!order) {
      log.warn('Fill received for unknown order, skipping', {});
      return Ok(undefined); // или буферизовать в pending store
    }

    // Шаг 2: OrderService.applyFill — бизнес-логика FSM изолирована в сервисе
    const updatedOrderResult = this._orderService.applyFill(order, fill);
    if (!updatedOrderResult.ok) {
      log.error('OrderService.applyFill failed', undefined, {
        error: updatedOrderResult.error.message,
        orderStatus: order.status,
      });
      return Err(updatedOrderResult.error);
    }
    const updatedOrder = updatedOrderResult.value;

    // Шаг 3: PortfolioService.applyFill — баланс + позиция (с CAS retry loop).
    // Fix #4 & #9: portfolioStore.save() принимает expectedVersion (CAS).
    // Fix #5: portfolio может быть undefined — ранний возврат.
    // При VersionConflictError — re-read и retry (до MAX_RETRIES попыток).
    // PortfolioService инкапсулирует: applyDebit, applyCredit, upsertPosition.
    const MAX_RETRIES = 3;
    let updatedPortfolio: Portfolio | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const portfolio = this._portfolioStore.get(fill.accountId);

      // Fix #5: null check — Portfolio обязан существовать к моменту fill.
      if (!portfolio) {
        log.warn('Portfolio not found for fill account, skipping', {});
        return Ok(undefined);
      }

      const portfolioResult = await this._portfolioService.applyFill(portfolio, fill);
      if (!portfolioResult.ok) {
        log.error('PortfolioService.applyFill failed', undefined, {
          error: portfolioResult.error.message,
        });
        return Err(portfolioResult.error);
      }

      // Fix #4: передаём expectedVersion для CAS-проверки.
      const saveResult = this._portfolioStore.save(portfolioResult.value, portfolio.version);
      if (saveResult.ok) {
        updatedPortfolio = portfolioResult.value;
        break;
      }

      if (!(saveResult.error instanceof VersionConflictError)) {
        return Err(saveResult.error);
      }

      log.warn('Portfolio CAS conflict, retrying', { attempt, fillId: String(fill.id) });
    }

    if (!updatedPortfolio) {
      return Err(new TradingError(`Portfolio CAS failed after ${MAX_RETRIES} retries for fill ${String(fill.id)}`));
    }

    // Шаг 4: LedgerService.record — двойная запись
    this._ledgerService.record(fill);

    // Шаг 5: сохранить Order агрегат (Portfolio уже сохранён в retry loop)
    this._orders.save(updatedOrder);

    // Шаг 6: публикация domain events
    // Fix #3: НЕТ шага 7 (this._processedFills.mark).
    // markIfNotExists() в шаге 0 уже атомарно пометил fill как обработанный.
    // Повторный mark() был бы ошибкой — двойное выполнение атомарной операции.
    const orderEvents = updatedOrder.pullEvents();
    await this._eventBus.publishAll(orderEvents as ApplicationEvent[]);

    log.info('Fill processed successfully', {
      fillId: String(fill.id),
      newOrderStatus: updatedOrder.status,
      filledSize: updatedOrder.filledSize.value().toNumber(),
    });

    return Ok(undefined);
  }

  /** Обновляет Position через addLots (BUY) или close (SELL) */
  private async _updatePosition(
    fill: Fill,
    portfolio: Portfolio
  ): Promise<Result<Portfolio, ValidationError>> {
    // Логика делегируется в PositionUpdater (sub-service, определён отдельно)
    // Здесь placeholder для понимания потока
    return Ok(portfolio);
  }
}
```

### `CancelOrderUseCase.ts`

```typescript
export interface CancelOrderInput {
  readonly orderId: OrderId;
  readonly reason?: string;
}

export type CancelOrderError = TradingError | ExchangeError;

/**
 * CancelOrderUseCase — отмена активного ордера.
 *
 * @remarks
 * ### Алгоритм:
 * 1. Получить Order по ID.
 * 2. Проверить canCancel() (только OPEN/PARTIALLY_FILLED).
 * 3. Отправить запрос на отмену на биржу (IExchangeClient.cancelOrder()).
 * 4. При успехе — применить order.cancel() → новый Order(CANCELED).
 * 5. Освободить резервирование в Portfolio (portfolio.releaseReservation()).
 * 6. Сохранить, опубликовать OrderCancelledEvent.
 *
 * ### Optimistic cancel:
 * Биржа может ответить ошибкой если ордер уже исполнен.
 * В этом случае OrderUpdateHandler обработает FILLED event позже.
 */
export class CancelOrderUseCase {
  constructor(
    private readonly _orders: IOrderRepository,
    private readonly _portfolioStore: IPortfolioStore,
    private readonly _exchange: IExchangeClient,
    private readonly _eventBus: IEventBus,
    private readonly _logger: ILogger,
  ) {}

  public async execute(input: CancelOrderInput): Promise<Result<Order, CancelOrderError>> {
    const log = this._logger.child({
      useCase: 'CancelOrderUseCase',
      orderId: String(input.orderId),
    });

    const order = this._orders.get(input.orderId);
    if (!order) {
      return Err(new TradingError(`Order not found: ${String(input.orderId)}`));
    }

    if (!order.canCancel()) {
      return Err(new TradingError(
        `Cannot cancel order in status ${order.status}`,
        { context: { orderId: String(input.orderId), status: order.status } }
      ));
    }

    // Запрос на биржу
    const exchangeResult = await this._exchange.cancelOrder(input.orderId);
    if (!exchangeResult.ok) {
      log.warn('Exchange cancel request failed', { error: exchangeResult.error.message });
      return Err(exchangeResult.error);
    }

    // Применяем к Order
    const cancelResult = order.cancel(input.reason);
    if (!cancelResult.ok) return Err(cancelResult.error);
    const cancelledOrder = cancelResult.value;

    // Освобождаем резервирование для незаполненного остатка
    const portfolio = this._portfolioStore.get(order._s.accountId as AccountId); // через snapshot
    const remainingNotional = Money.of(
      order.price.value().times(order.remainingSize.value()),
      'USDC'
    );
    const releaseResult = portfolio.releaseReservation(remainingNotional);
    if (releaseResult.ok) {
      this._portfolioStore.save(releaseResult.value);
    }

    this._orders.save(cancelledOrder);

    const events = cancelledOrder.pullEvents();
    await this._eventBus.publishAll(events as ApplicationEvent[]);

    log.info('Order cancelled successfully', { reason: input.reason });

    return Ok(cancelledOrder);
  }
}
```

---

## 6. Package 4: `strategy/` — `@polymarket/strategy`

### Назначение

Интерфейс `IStrategy` и `StrategyRunner` — оркестратор запуска/остановки стратегий. Каждая стратегия подписывается на события через EventBus и принимает решения.

### Зависимости

- `@polymarket/event-bus`
- `@polymarket/use-cases`
- `@polymarket/order-book`
- `@polymarket/trade-tape`
- `@polymarket/portfolio`
- `@polymarket/risk`
- `@polymarket/logger`
- `@polymarket/result`
- `@polymarket/ids`

### `IStrategy.ts`

```typescript
import type { ILogger } from '@polymarket/logger';
import type { IEventBus } from '@polymarket/event-bus';
import type { PlaceOrderUseCase, CancelOrderUseCase } from '@polymarket/use-cases';
import type { IRiskChecker } from '@polymarket/risk';

/**
 * ITradingAPI — тонкий фасад для стратегий.
 *
 * @remarks
 * Стратегия знает только о ITradingAPI — не о PlaceOrderUseCase, IEventBus,
 * IRiskChecker или других деталях архитектуры.
 * Это принципиально: стратегия не должна зависеть от всей системы.
 * StrategyRunner конструирует конкретный TradingAPI для каждой стратегии.
 */
export interface ITradingAPI {
  /** Размещает ордер. Risk-check выполняется внутри. */
  placeOrder(params: PlaceOrderParams): Promise<Result<OrderId, PlaceOrderError>>;
  /** Отменяет ордер по ID. */
  cancelOrder(orderId: OrderId): Promise<Result<void, CancelOrderError>>;
  /** Возвращает список открытых ордеров стратегии. */
  getOpenOrders(): readonly Order[];
  /** Подписывается на события стакана/fills для данного инструмента. */
  subscribe<T extends ApplicationEvent['type']>(
    type: T,
    handler: EventHandler<T>
  ): () => void;
  /** Logger с контекстом стратегии. */
  readonly logger: ILogger;
  /** ID стратегии. */
  readonly strategyId: string;
}

/**
 * Контекст выполнения стратегии.
 * Содержит только ITradingAPI — стратегия не знает о внутренней архитектуре.
 */
export interface StrategyContext {
  readonly api: ITradingAPI;
}

/**
 * Интерфейс торговой стратегии.
 *
 * @remarks
 * Каждая стратегия реализует этот интерфейс.
 * Жизненный цикл управляется StrategyRunner.
 *
 * ### Принципы стратегий:
 * - Стратегия подписывается на события в initialize() и отписывается в stop().
 * - Стратегия не хранит Portfolio напрямую — использует context.portfolio для чтения.
 * - Стратегия не вызывает биржу напрямую — только через PlaceOrderUseCase/CancelOrderUseCase.
 * - Стратегия не управляет риском — RiskChecker вызывается внутри PlaceOrderUseCase.
 *
 * @example
 * ```typescript
 * export class SimpleMMStrategy implements IStrategy {
 *   readonly id = 'simple-mm-v1';
 *   readonly name = 'Simple Market Maker';
 *
 *   async initialize(ctx: StrategyContext): Promise<void> {
 *     // Подписка через ctx.api.subscribe — TradingAPI сохраняет unsubscribe для cleanup.
 *     ctx.api.subscribe('BOOK_UPDATED', async (event) => {
 *       await this._onBookUpdate(event.topOfBook);
 *     });
 *   }
 *
 *   async stop(): Promise<void> {
 *     // StrategyRunner снимет подписки через unsubscribe функции
 *   }
 *
 *   private async _onBookUpdate(topOfBook: TopOfBook): Promise<void> {
 *     const bestBid = topOfBook.bestBid;
 *     const bestAsk = topOfBook.bestAsk;
 *     if (!bestBid || !bestAsk) return;
 *     // ... логика котирования
 *   }
 * }
 * ```
 */
export interface IStrategy {
  /** Уникальный ID стратегии (совпадает с Order.strategyId для изоляции) */
  readonly id: string;
  /** Человекочитаемое имя стратегии (для логов) */
  readonly name: string;

  /**
   * Инициализирует стратегию и подписывается на события.
   *
   * @param ctx - Контекст с зависимостями
   *
   * @remarks
   * Вызывается единожды при старте StrategyRunner.
   * Здесь регистрируются подписки на EventBus.
   * Ошибки в инициализации должны быть wrapped в Result.
   */
  initialize(ctx: StrategyContext): Promise<Result<void, Error>>;

  /**
   * Корректно останавливает стратегию.
   *
   * @remarks
   * Вызывается при shutdown или при ошибке риск-мониторинга.
   * Должна отменить все открытые ордера стратегии через context.cancelOrder.
   */
  stop(): Promise<void>;

  /**
   * Возвращает метрики стратегии для мониторинга.
   *
   * @returns Произвольный объект с метриками (orders placed, fills, etc.)
   */
  getMetrics(): Record<string, unknown>;
}
```

### `StrategyRunner.ts`

```typescript
/**
 * StrategyRunner — оркестратор жизненного цикла стратегий.
 *
 * @remarks
 * ### Алгоритм запуска:
 * 1. Для каждой стратегии создаёт дочерний logger с strategyId.
 * 2. Формирует StrategyContext с зависимостями.
 * 3. Вызывает strategy.initialize(ctx) — стратегия подписывается на события.
 * 4. При ошибке инициализации — логирует, не запускает стратегию.
 *
 * ### Мониторинг:
 * StrategyRunner подписывается на RISK_LIMIT_BREACHED — при нарушении
 * вызывает strategy.stop() для соответствующей стратегии.
 *
 * ### Multi-strategy изоляция:
 * Каждая стратегия видит только свои ордера через strategyId.
 * OrderRepository.getByStrategyId(strategyId) возвращает только ордера стратегии.
 */
// Fix #2/#10: IStrategyRunner убирает onBookUpdate/onBookDepth.
// Стратегии подписываются на BOOK_UPDATED/BOOK_DEPTH напрямую через ctx.api.subscribe()
// в своём initialize(). MarketDataOrchestrator больше не нужен для market data —
// только для RISK_LIMIT_BREACHED (маршрутизация к stop/stopAll).
export interface IStrategyRunner {
  onRiskBreached(event: RiskLimitBreachedEvent): Promise<void>;
  start(strategy: IStrategy): Promise<Result<void, Error>>;
  stop(strategyId: string): Promise<void>;
  stopAll(): Promise<void>;
}

// Fix #8: StrategyRunner не хранит Omit<StrategyContext, ...>.
// StrategyContext = { api: ITradingAPI } — никаких strategyId/logger полей.
// Вместо этого StrategyRunner получает зависимости для ПОСТРОЕНИЯ TradingAPI per-strategy:
// _eventBus, _placeOrder, _cancelOrder, _orders — всё чтобы инстанцировать TradingAPI.
//
// Fix #6: _unsubscribes → _tradingAPIs Map<strategyId, TradingAPI>.
// TradingAPI (конкретный класс) сам отслеживает свои подписки.
// stop(strategyId) вызывает tradingAPI.unsubscribeAll() перед strategy.stop().
export class StrategyRunner implements IStrategyRunner {
  private readonly _strategies = new Map<string, IStrategy>();
  // Fix #6: per-strategy TradingAPI instances для cleanup подписок при stop().
  private readonly _tradingAPIs = new Map<string, TradingAPI>();
  private readonly _logger: ILogger;

  // Fix #8: инжектируем зависимости для TradingAPI (не Omit<StrategyContext>).
  constructor(
    private readonly _eventBus: IEventBus,
    private readonly _placeOrder: PlaceOrderUseCase,
    private readonly _cancelOrder: CancelOrderUseCase,
    private readonly _orders: IOrderRepository,
    logger: ILogger,
  ) {
    this._logger = logger.child({ component: 'StrategyRunner' });
  }

  /**
   * Регистрирует и запускает стратегию.
   *
   * @param strategy - Стратегия для запуска
   *
   * @remarks
   * Для каждой стратегии создаётся изолированный TradingAPI.
   * TradingAPI.unsubscribeAll() вызывается при stop() для cleanup подписок.
   */
  public async start(strategy: IStrategy): Promise<Result<void, Error>> {
    if (this._strategies.has(strategy.id)) {
      return Err(new Error(`Strategy ${strategy.id} already running`));
    }

    const strategyLogger = this._logger.child({ strategyId: strategy.id, strategyName: strategy.name });

    // Fix #8: создаём TradingAPI для стратегии — она знает только этот API.
    // TradingAPI реализует ITradingAPI: placeOrder, cancelOrder, getOpenOrders, subscribe, logger, strategyId.
    const tradingAPI = new TradingAPI({
      eventBus: this._eventBus,
      placeOrder: this._placeOrder,
      cancelOrder: this._cancelOrder,
      orders: this._orders,
      logger: strategyLogger,
      strategyId: strategy.id,
    });

    // Fix #8: ctx.api = tradingAPI — правильная форма StrategyContext.
    const ctx: StrategyContext = { api: tradingAPI };

    const initResult = await strategy.initialize(ctx);
    if (!initResult.ok) {
      // Cleanup подписок если инициализация упала
      tradingAPI.unsubscribeAll();
      strategyLogger.error('Strategy initialization failed', initResult.error as Error, {});
      return Err(initResult.error);
    }

    this._strategies.set(strategy.id, strategy);
    this._tradingAPIs.set(strategy.id, tradingAPI); // Fix #6: сохраняем для cleanup
    strategyLogger.info('Strategy started successfully', {});

    return Ok(undefined);
  }

  // Fix #2/#10: onBookUpdate/onBookDepth удалены.
  // Стратегии получают BOOK_UPDATED через ctx.api.subscribe('BOOK_UPDATED', handler) в initialize().
  // Прямая подписка на EventBus без промежуточных слоёв.

  public async onRiskBreached(event: RiskLimitBreachedEvent): Promise<void> {
    if (event.strategyId) {
      // Останавливаем только конкретную стратегию
      await this.stop(event.strategyId);
    } else {
      // Системное нарушение — останавливаем всё
      this._logger.error('System-wide risk limit breached, stopping all strategies', undefined, {});
      await this.stopAll();
    }
  }

  /**
   * Останавливает конкретную стратегию.
   *
   * @param strategyId - ID стратегии
   */
  public async stop(strategyId: string): Promise<void> {
    const strategy = this._strategies.get(strategyId);
    if (!strategy) {
      this._logger.warn('Attempted to stop unknown strategy', { strategyId });
      return;
    }

    // Fix #6: unsubscribeAll() снимает все EventBus-подписки стратегии.
    const tradingAPI = this._tradingAPIs.get(strategyId);
    tradingAPI?.unsubscribeAll();

    await strategy.stop();
    this._strategies.delete(strategyId);
    this._tradingAPIs.delete(strategyId);
    this._logger.info('Strategy stopped', { strategyId });
  }

  /**
   * Останавливает все стратегии (shutdown).
   */
  public async stopAll(): Promise<void> {
    this._logger.info('Stopping all strategies', { count: this._strategies.size });
    for (const strategyId of this._strategies.keys()) {
      await this.stop(strategyId);
    }
  }

  /**
   * Возвращает метрики всех активных стратегий.
   */
  public getMetrics(): Record<string, Record<string, unknown>> {
    const result: Record<string, Record<string, unknown>> = {};
    for (const [id, strategy] of this._strategies) {
      result[id] = strategy.getMetrics();
    }
    return result;
  }
}

/**
 * TradingAPI — конкретная реализация ITradingAPI для одной стратегии.
 *
 * @remarks
 * Fix #6: отслеживает все EventBus-подписки через _unsubscribes[].
 * unsubscribeAll() вызывается StrategyRunner при stop() для cleanup.
 * Fix #7: backpressure в EventBus — это мониторинговый счётчик (log warning),
 * не hard block. В Node.js single-thread избыток concurrent publishes
 * физически невозможен (event loop последователен). Счётчик сигнализирует
 * о накоплении async debt — при превышении порога стоит исследовать
 * узкие места, а не блокировать поток.
 */
export class TradingAPI implements ITradingAPI {
  private readonly _unsubscribes: Array<() => void> = [];

  constructor(private readonly _deps: {
    eventBus: IEventBus;
    placeOrder: PlaceOrderUseCase;
    cancelOrder: CancelOrderUseCase;
    orders: IOrderRepository;
    logger: ILogger;
    strategyId: string;
  }) {}

  get logger(): ILogger { return this._deps.logger; }
  get strategyId(): string { return this._deps.strategyId; }

  public subscribe<T extends ApplicationEvent['type']>(type: T, handler: EventHandler<T>): () => void {
    // Fix #6: сохраняем unsubscribe-функцию для cleanup.
    const unsubscribe = this._deps.eventBus.subscribe(type, handler);
    this._unsubscribes.push(unsubscribe);
    return unsubscribe;
  }

  public async placeOrder(params: PlaceOrderParams): Promise<Result<OrderId, PlaceOrderError>> {
    return this._deps.placeOrder.execute({ ...params, strategyId: this._deps.strategyId });
  }

  public async cancelOrder(orderId: OrderId): Promise<Result<void, CancelOrderError>> {
    return this._deps.cancelOrder.execute({ orderId });
  }

  public getOpenOrders(): readonly Order[] {
    return this._deps.orders.getByStrategyId(this._deps.strategyId);
  }

  /** Снимает все EventBus-подписки данной стратегии. Вызывается StrategyRunner.stop(). */
  public unsubscribeAll(): void {
    for (const unsub of this._unsubscribes) unsub();
    this._unsubscribes.length = 0;
  }
}
```

---

## 7. Package 5: `risk/` — `@polymarket/risk`

### Назначение

Два независимых класса с разными ответственностями:

- **`OrderRiskChecker`** — pre-trade валидация, синхронная, вызывается внутри `PlaceOrderUseCase`.
- **`DrawdownRiskMonitor`** — post-trade мониторинг, async, подписывается на `FILL_RECEIVED` через EventBus и периодически проверяет drawdown.

Причина разделения: drawdown = мониторинг портфеля во времени (async, периодичный).
Order risk = синхронная проверка перед каждым ордером. Разные частоты, разные триггеры.

### О кэшировании totalExposure

`OrderRiskChecker` не итерирует по всем позициям на каждом ордере.
`Portfolio` хранит кэшированное `totalExposure: Decimal` (обновляется при upsertPosition).
Проверка O(1), а не O(N).

```typescript
// В Portfolio:
// get totalExposure(): Decimal — вычисляется и кэшируется при upsertPosition()
// Не итерируем positions на каждый чек.
```

### Зависимости

- `@polymarket/portfolio`
- `@polymarket/position`
- `@polymarket/order`
- `@polymarket/result`
- `@polymarket/errors`
- `@polymarket/logger`
- `@polymarket/ids`
- `@polymarket/value-objects`

### `RiskParams.ts`

```typescript
import type { Decimal } from 'decimal.js';

/**
 * Параметры риск-лимитов.
 *
 * @remarks
 * Все лимиты опциональны — undefined означает "отключён".
 * Конфигурируются при создании RiskChecker или через updateParams().
 */
export interface RiskParams {
  /**
   * Максимальный размер позиции по одному инструменту (в токенах).
   * Например: 10000 токенов YES.
   */
  readonly maxPositionSize?: Decimal;

  /**
   * Максимальный общий notional exposure по всем позициям (в USDC).
   * Например: 50000 USDC.
   */
  readonly maxTotalExposure?: Decimal;

  /**
   * Максимальная просадка от пика (0–1, например 0.1 = 10%).
   * При превышении — стратегия останавливается.
   */
  readonly maxDrawdown?: Decimal;

  /**
   * Максимальный размер одного ордера (в USDC notional).
   * Например: 5000 USDC.
   */
  readonly maxOrderNotional?: Decimal;

  /**
   * Максимальное количество одновременно открытых ордеров.
   */
  readonly maxOpenOrders?: number;

  /**
   * Минимальная доступная ликвидность (available balance) для размещения ордера.
   * Например: 100 USDC должно остаться незарезервированным.
   */
  readonly minAvailableBalance?: Decimal;
}
```

### `RiskViolation.ts`

```typescript
import { TradingError } from '@polymarket/errors';
import type { ErrorSeverity } from '@polymarket/errors';

/**
 * Тип нарушения риск-лимита.
 *
 * @remarks
 * Используется для маршрутизации реакции (стоп/пропуск/алерт).
 */
export type RiskViolationType =
  | 'POSITION_LIMIT_EXCEEDED'
  | 'TOTAL_EXPOSURE_EXCEEDED'
  | 'MAX_DRAWDOWN_BREACHED'
  | 'ORDER_NOTIONAL_EXCEEDED'
  | 'MAX_OPEN_ORDERS_EXCEEDED'
  | 'INSUFFICIENT_AVAILABLE_BALANCE';

/**
 * Ошибка нарушения риск-лимита.
 */
export class RiskViolationError extends TradingError {
  public readonly severity: ErrorSeverity = 'high';
  public readonly violationType: RiskViolationType;

  constructor(
    violationType: RiskViolationType,
    message: string,
    context?: Record<string, unknown>
  ) {
    super(message, { context });
    this.violationType = violationType;
  }
}
```

### `OrderRiskChecker.ts` — Pre-trade, синхронный

```typescript
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import type { Portfolio } from '@polymarket/portfolio';
import type { ILogger } from '@polymarket/logger';
import Decimal from 'decimal.js';
import type { RiskParams } from './RiskParams.js';
import { RiskViolationError } from './RiskViolation.js';

export interface IOrderRiskChecker {
  /**
   * Синхронная pre-trade проверка перед каждым PlaceOrderUseCase.
   * Порядок проверок: от дешёвых O(1) к дорогим.
   * 1. maxOpenOrders    — O(1)
   * 2. maxOrderNotional — O(1)
   * 3. minAvailableBalance — O(1)
   * 4. maxPositionSize  — O(1) через Portfolio.getPosition()
   * 5. maxTotalExposure — O(1) через Portfolio.totalExposure (кэш, не итерация!)
   */
  checkBeforeOrder(input: PreOrderCheckInput): Result<void, RiskViolationError>;
  updateParams(params: Partial<RiskParams>): void;
}

export interface PreOrderCheckInput {
  readonly portfolio: Portfolio;
  readonly openOrdersCount: number;
  readonly side: 'BUY' | 'SELL';
  readonly price: Price;
  readonly size: Quantity;
  readonly instrumentId: InstrumentId;
  readonly strategyId?: string;
}

export class OrderRiskChecker implements IOrderRiskChecker {
  private _params: RiskParams;
  private readonly _logger: ILogger;

  constructor(params: RiskParams, logger: ILogger) {
    this._params = params;
    this._logger = logger.child({ component: 'OrderRiskChecker' });
  }

  public checkBeforeOrder(input: PreOrderCheckInput): Result<void, RiskViolationError> {
    const orderNotional = input.price.value().times(input.size.value());

    // Проверка 1: макс. кол-во открытых ордеров
    if (
      this._params.maxOpenOrders !== undefined &&
      input.openOrdersCount >= this._params.maxOpenOrders
    ) {
      return Err(new RiskViolationError(
        'MAX_OPEN_ORDERS_EXCEEDED',
        `Open orders count ${input.openOrdersCount} exceeds limit ${this._params.maxOpenOrders}`,
        { strategyId: input.strategyId, current: input.openOrdersCount, limit: this._params.maxOpenOrders }
      ));
    }

    // Проверка 2: макс. notional ордера
    if (
      this._params.maxOrderNotional !== undefined &&
      orderNotional.gt(this._params.maxOrderNotional)
    ) {
      return Err(new RiskViolationError(
        'ORDER_NOTIONAL_EXCEEDED',
        `Order notional ${orderNotional.toNumber()} exceeds limit ${this._params.maxOrderNotional.toNumber()} USDC`,
        { strategyId: input.strategyId, notional: orderNotional.toNumber(), limit: this._params.maxOrderNotional.toNumber() }
      ));
    }

    // Проверка 3: минимальный доступный баланс
    if (this._params.minAvailableBalance !== undefined) {
      const available = input.portfolio.balance.available().value();
      // После резервирования этого ордера баланс уменьшится на orderNotional
      const balanceAfter = available.minus(orderNotional);
      if (balanceAfter.lt(this._params.minAvailableBalance)) {
        return Err(new RiskViolationError(
          'INSUFFICIENT_AVAILABLE_BALANCE',
          `Available balance ${available.toNumber()} USDC would drop to ${balanceAfter.toNumber()} below min ${this._params.minAvailableBalance.toNumber()}`,
          { available: available.toNumber(), limit: this._params.minAvailableBalance.toNumber() }
        ));
      }
    }

    // Проверка 4: лимит позиции по инструменту
    if (this._params.maxPositionSize !== undefined && input.side === 'BUY') {
      const currentPosition = input.portfolio.getPosition(input.instrumentId);
      const currentQty = currentPosition?.quantity.value() ?? new Decimal(0);
      const newQty = currentQty.plus(input.size.value());
      if (newQty.gt(this._params.maxPositionSize)) {
        return Err(new RiskViolationError(
          'POSITION_LIMIT_EXCEEDED',
          `Position size ${newQty.toNumber()} would exceed limit ${this._params.maxPositionSize.toNumber()}`,
          { instrumentId: String(input.instrumentId), current: currentQty.toNumber(), limit: this._params.maxPositionSize.toNumber() }
        ));
      }
    }

    // Проверка 5: максимальный total exposure — O(1), не O(N).
    // Portfolio.totalExposure — кэшированное значение, обновляется при upsertPosition().
    // НЕ итерируем по всем позициям — это была бы катастрофа при 200 рынках.
    if (this._params.maxTotalExposure !== undefined) {
      const exposureAfter = input.portfolio.totalExposure.plus(orderNotional);
      if (exposureAfter.gt(this._params.maxTotalExposure)) {
        return Err(new RiskViolationError(
          'TOTAL_EXPOSURE_EXCEEDED',
          `Total exposure ${exposureAfter.toNumber()} USDC would exceed limit ${this._params.maxTotalExposure.toNumber()}`,
          { current: input.portfolio.totalExposure.toNumber(), limit: this._params.maxTotalExposure.toNumber() }
        ));
      }
    }

    return Ok(undefined);
  }

  public updateParams(params: Partial<RiskParams>): void {
    this._params = { ...this._params, ...params };
    this._logger.info('Risk parameters updated', {
      updatedFields: Object.keys(params),
    });
  }
}
```

### `DrawdownRiskMonitor.ts` — Post-trade, асинхронный мониторинг

```typescript
// DrawdownRiskMonitor подписывается на FILL_RECEIVED и периодически
// проверяет drawdown портфеля. При нарушении — публикует RISK_LIMIT_BREACHED.
// Это отдельный класс от OrderRiskChecker: разные триггеры, разные частоты.

export class DrawdownRiskMonitor {
  private _peakValue: Decimal = new Decimal(0);

  constructor(
    private readonly _eventBus: IEventBus,
    private readonly _portfolioStore: IPortfolioStore,
    private readonly _clock: IClock,
    private readonly _params: Pick<RiskParams, 'maxDrawdown'>,
    private readonly _logger: ILogger
  ) {}

  public register(): void {
    this._eventBus.subscribe('FILL_RECEIVED', async (event) => {
      await this._checkDrawdown(event.fill.accountId);
    });
  }

  private async _checkDrawdown(accountId: AccountId): Promise<void> {
    if (!this._params.maxDrawdown) return;

    const portfolio = this._portfolioStore.get(accountId);
    if (!portfolio) return;

    // ВАЖНО: currentValue = cash + unrealized PnL по всем позициям.
    // portfolio.balance.available() — это только cash, НЕ полное portfolio value.
    // Для prediction markets unrealized PnL критичен: позиция на 0.90 vs 0.10
    // определяет majority стоимости портфеля.
    //
    // portfolio.getTotalValue(markPrices) принимает Map<InstrumentId, Price>
    // (текущие цены из OrderBook) и возвращает cash + sum(qty * markPrice).
    // markPrices передаётся снаружи — DrawdownMonitor не тянет OrderBook напрямую.
    const markPrices = this._markPricesProvider.getLatest();
    const currentValue = portfolio.getTotalValue(markPrices);

    if (currentValue.gt(this._peakValue)) {
      this._peakValue = currentValue;
    }

    if (this._peakValue.isZero()) return;

    const drawdown = this._peakValue.minus(currentValue).dividedBy(this._peakValue);
    if (drawdown.gt(this._params.maxDrawdown)) {
      const triggeredAt = TimestampService.create(this._clock.now()).value;
      await this._eventBus.publish({
        type: 'RISK_LIMIT_BREACHED',
        violation: `Drawdown ${drawdown.times(100).toFixed(2)}% exceeded max ${this._params.maxDrawdown.times(100).toFixed(2)}%`,
        triggeredAt,
      });
      this._logger.error('Drawdown limit breached', undefined, {
        drawdown: drawdown.toNumber(),
        peak: this._peakValue.toNumber(),
        current: currentValue.toNumber(),
      });
    }
  }
}
```

---

## 8. Зависимости между пакетами

```
Граф зависимостей (→ = "зависит от"):

risk/ → domain/portfolio, domain/position, foundation/result, foundation/errors

event-bus/ → foundation/logger, foundation/result
            + re-exports types from domain/entities/order (OrderEvent)

handlers/ → event-bus/, domain/order, domain/fill,
            domain/market-data/order-book, domain/entities/trade,
            foundation/logger, foundation/result

use-cases/ → event-bus/, ports/ (IOrderRepository, IPortfolioStore, IProcessedFillRepository),
             domain/order, domain/fill, domain/portfolio,
             domain/accounting/ledger, risk/,
             foundation/logger, foundation/result, foundation/ids

strategy/ → event-bus/, use-cases/, risk/, ports/,
            domain/market-data/order-book, domain/market-data/trade-tape,
            foundation/logger, foundation/result
```

### Матрица зависимостей пакетов Application Layer

| Пакет | event-bus | handlers | use-cases | strategy | risk |
|-------|-----------|----------|-----------|----------|------|
| event-bus | — | нет | нет | нет | нет |
| handlers | ДА | — | нет | нет | нет |
| use-cases | ДА | нет | — | нет | ДА |
| ports | нет | нет | нет | нет | нет |
| orchestrators | ДА | нет | ДА | ДА | нет |
| strategy | ДА | нет | ДА | — | ДА |
| risk | нет | нет | нет | нет | — |

Порядок инициализации при запуске бота:

1. `OrderRiskChecker`, `DrawdownRiskMonitor` (нет зависимостей в application слое)
2. `EventBus`
3. `BookUpdateHandler`, `FillEventHandler`, `OrderUpdateHandler`
4. `PlaceOrderUseCase`, `ProcessFillUseCase`, `CancelOrderUseCase`
5. `FillOrchestrator.register()`, `RiskOrchestrator.register()`, `DrawdownRiskMonitor.register()`
6. `StrategyRunner.start(strategy)` → `strategy.initialize(ctx)` (подписки стратегий на EventBus)

---

## 9. Конфигурация пакетов

### Шаблон `package.json` для каждого пакета

```json
// packages/application/event-bus/package.json
{
  "name": "@polymarket/event-bus",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "test": "jest",
    "lint": "eslint src --ext .ts",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist *.tsbuildinfo"
  },
  "dependencies": {
    "@polymarket/logger": "^0.1.0",
    "@polymarket/result": "^0.1.0",
    "@polymarket/order": "^0.1.0"
  }
}
```

### `tsconfig.json` — шаблон для всех пакетов application

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### `jest.config.ts` — шаблон с moduleNameMapper

```typescript
// packages/application/event-bus/jest.config.ts
export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^@polymarket/result$': '<rootDir>/../../foundation/result/src/index.ts',
    '^@polymarket/logger$': '<rootDir>/../../foundation/logger/src/index.ts',
    '^@polymarket/errors$': '<rootDir>/../../foundation/errors/src/index.ts',
    '^@polymarket/ids$': '<rootDir>/../../foundation/ids/src/index.ts',
    '^@polymarket/order$': '<rootDir>/../../domain/entities/order/src/index.ts',
    '^@polymarket/fill$': '<rootDir>/../../domain/entities/fill/src/index.ts',
    '^@polymarket/order-book$': '<rootDir>/../../domain/market-data/order-book/src/index.ts',
    '^@polymarket/trade$': '<rootDir>/../../domain/entities/trade/src/index.ts',
    '^@polymarket/trade-tape$': '<rootDir>/../../domain/market-data/trade-tape/src/index.ts',
    '^@polymarket/portfolio$': '<rootDir>/../../domain/entities/portfolio/src/index.ts',
    '^@polymarket/ledger$': '<rootDir>/../../domain/accounting/ledger/src/index.ts',
    '^@polymarket/risk$': '<rootDir>/../risk/src/index.ts',
    '^@polymarket/event-bus$': '<rootDir>/../event-bus/src/index.ts',
    '^@polymarket/handlers$': '<rootDir>/../handlers/src/index.ts',
    '^@polymarket/use-cases$': '<rootDir>/../use-cases/src/index.ts',
  },
};
```

---

## 10. Ключевые архитектурные решения и обоснования

### 10.1. IOrderRepository определён только в `@polymarket/ports`

Fix #11: единственное определение интерфейса в `ports/` — Dependency Inversion принцип.
Handlers и use-cases импортируют `IOrderRepository` из `@polymarket/ports`, не определяют свои копии.
Это устраняет два несинхронизированных интерфейса, которые могут разойтись при добавлении методов
(например `countByStrategyId`, `getByStrategyId` нужны StrategyRunner и OrderRiskChecker).

### 10.2. Portfolio хранится атомарно (один Portfolio = одна валюта)

Следует существующей архитектуре: `Portfolio.balance` — это `Balance` VO с `available + reserved`. Все операции возвращают новый Portfolio (immutable pattern из domain layer).

### 10.3. Ledger используется для аудита, Portfolio — для live-состояния

Это два независимых представления одной истории:

- `Ledger` — append-only, источник истины для аудита и reconciliation.
- `Portfolio` — проекция для быстрого доступа к балансу/позициям в realtime.

При рестарте бота Portfolio восстанавливается через `replay()` на основе Ledger.

### 10.4. FillEventHandler не вызывает ProcessFillUseCase напрямую

Разделение ответственностей: `FillEventHandler` только парсит raw данные и публикует `FILL_RECEIVED`. `ProcessFillUseCase` вызывается из application orchestrator (или из подписки StrategyRunner) после получения события. Это позволяет буферизовать fills при out-of-order scenarios.

### 10.5. RiskChecker — синхронный, без async

Portfolio и OrderBook уже в памяти. Async добавляет latency без пользы. При необходимости внешних проверок (API) создаётся отдельный `AsyncRiskChecker`.

### 10.6. Domain Event Outbox через Order.pullEvents()

Каждый успешный `accept()`, `applyFill()`, `cancel()` добавляет событие в буфер Order. Application layer вызывает `pullEvents()` и публикует их в EventBus. Это гарантирует что стратегии видят domain-level события (ORDER_FILLED, ORDER_PARTIALLY_FILLED), а не только raw venue данные.

---

## 11. Что НЕ входит в эту фазу

Следующие компоненты планируются для отдельной итерации:

1. **IPortfolioStore** — конкретные реализации (in-memory, Redis). Сейчас определяется только интерфейс в use-cases.
2. **IExchangeClient** — HTTP CLOB + WebSocket клиент Polymarket (добавляется позже).
3. **Persistence** — сохранение Order/Portfolio на диск/Redis (infrastructure layer).
4. **Reconciliation service** — синхронизация локального состояния с биржей после реконнекта.
5. **Backtesting harness** — использует те же IStrategy/RiskChecker, но с бумажным клиентом.
6. **PositionUpdater sub-service** — детальная логика создания PositionLot из Fill и вызова position.addLots() / position.close().

---

### Critical Files for Implementation

- `/Users/menvil/Projects/polymarket/packages/domain/entities/order/src/Order.ts` - Ключевой агрегат: `applyFill()`, `accept()`, `cancel()`, `pullEvents()` — методы которые вызываются в handlers и use-cases
- `/Users/menvil/Projects/polymarket/packages/domain/entities/fill/src/Fill.ts` - FillReceivedEvent несёт `Fill` как payload; `Fill.getNetCashFlow()` используется в ProcessFillUseCase для Portfolio операций
- `/Users/menvil/Projects/polymarket/packages/domain/entities/portfolio/src/Portfolio.ts` - Все balance операции (`reserveForOrder`, `releaseReservation`, `applyDebit`, `applyCredit`, `upsertPosition`) используются в PlaceOrderUseCase и ProcessFillUseCase
- `/Users/menvil/Projects/polymarket/packages/domain/accounting/ledger/src/Ledger.ts` - ProcessFillUseCase вызывает `ledger.append()` и `FillLedgerAdapter.toLedgerEntries(fill)` для аудит-трейла каждого исполнения
- `/Users/menvil/Projects/polymarket/packages/domain/market-data/order-book/src/OrderBook.ts` - BookUpdateHandler мутирует `OrderBook` через `applyDelta()`/`applyFullState()`; IStrategy читает `getBestBid()`, `getBestAsk()`, `getImbalance()` для принятия решений
