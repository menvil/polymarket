# Master Implementation Plan v2
## Polymarket Trading System — Единый подробный план

**Версия:** 2.0 (исправлено 10 архитектурных проблем v1)
**Дата:** 2026-03-09

---

## Исправленные архитектурные решения (отличия от v1)

| # | Проблема v1 | Решение v2 |
|---|------------|-----------|
| 1 | Phase 0.5 callbacks конфликтует с Phase 8 | WsAdapter → `IPolymarketWsEmitter` (raw events, нет callbacks-переделки) |
| 2 | Domain events в infrastructure (DomainEvent, OrderBookSnapshotReceivedEvent) | События только в `application/event-bus`; infrastructure использует внутренние DTOs |
| 3 | FeedAdapter — god object (4 ответственности) | Разделить на `MarketDataFeedAdapter` + `UserEventFeedAdapter` |
| 4 | `markIfNotExists` sync — не работает в multi-process | `IProcessedFillRepository.markIfNotExists()` → `Promise<boolean>` (storage-backed) |
| 5 | Handlers внутри одного event могут зависеть друг от друга | Правило: handlers side-effect isolated, нет cross-handler зависимостей |
| 6 | OrderBook sequence tracking не описан | `BookUpdateHandler` отслеживает sequence numbers, gap detection |
| 7 | TradingAPI._unsubscribes может пропустить nested subscribes | Дополнительно: `StrategyRunner` хранит `_subscriptions: Map<strategyId, Set<unsub>>` |
| 8 | ✅ Dependency direction правильный | Без изменений |
| 9 | ✅ CAS правильный | Без изменений |
| 10 | Нет описания system restart / recovery | Phase 9: Recovery & Reconciliation |
| + | Нет MarketRegistry | Phase 0.6: MarketCatalog stub |

---

## Обзор: архитектура системы

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       INFRASTRUCTURE LAYER                               │
│   @polymarket/exchange  (packages/infrastructure/polymarket/)            │
│                                                                          │
│   PolymarketWsClient ──► IPolymarketWsEmitter                          │
│        raw WS frames        onOrderbookSnapshot/Delta                   │
│                             onTradeEvent                                 │
│                             onUserFill                                   │
│                             onOrderUpdate                                │
│                                  │                                       │
│   ┌──────────────────────────────▼──────────────────────────────────┐   │
│   │  BRIDGE (Phase 8)                                               │   │
│   │  MarketDataFeedAdapter    UserEventFeedAdapter                  │   │
│   │  ExchangeClientAdapter                                          │   │
│   └──────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │ вызывает Handlers из
┌──────────────────────────────────▼──────────────────────────────────────┐
│                       APPLICATION LAYER                                  │
│   packages/application/                                                  │
│                                                                          │
│  @polymarket/ports          IOrderRepository, IPortfolioStore (CAS),    │
│                             IProcessedFillRepository (async),            │
│                             IExchangeClient, IMarketCatalog              │
│                                                                          │
│  @polymarket/event-bus      IEventBus, ApplicationEvent union,          │
│                             ALL event types (единственный источник)      │
│                                                                          │
│  @polymarket/handlers       BookUpdateHandler (sequence tracking),       │
│                             FillEventHandler, OrderUpdateHandler         │
│                                                                          │
│  @polymarket/risk           OrderRiskChecker (sync O(1)),               │
│                             DrawdownRiskMonitor (async)                  │
│                                                                          │
│  @polymarket/use-cases      PlaceOrder, ProcessFill, CancelOrder        │
│                             + OrderService, PortfolioService, Ledger    │
│                                                                          │
│  @polymarket/orchestrators  FillOrchestrator, RiskOrchestrator          │
│                                                                          │
│  @polymarket/strategy       IStrategy, TradingAPI, StrategyRunner       │
│                                                                          │
│  @polymarket/recovery       OrderReconciler, PortfolioReplay (Phase 9)  │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │ использует (read-only)
┌──────────────────────────────────▼──────────────────────────────────────┐
│                        DOMAIN LAYER  ✅ Готово                           │
│   entities: order, fill, trade, position, portfolio, market             │
│   accounting: ledger                                                     │
│   market-data: order-book, trade-tape                                   │
│   value-objects: Price, Quantity, Side, Fee, Balance, SignedQuantity…   │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │ использует
┌──────────────────────────────────▼──────────────────────────────────────┐
│                      FOUNDATION LAYER  ✅ Готово                         │
│   errors, ids, logger, math, result, time                               │
└─────────────────────────────────────────────────────────────────────────┘
```

### Поток данных: рыночные данные

```
Polymarket WS (orderbook channel)
  │
  ▼
PolymarketWsClient.onMessage()
  │
  ▼
PolymarketMessageParser.parse()       → RawOrderbookMessage (внутренний DTO)
  │
  ▼
PolymarketMessageRouter.route()       → dispatch по типу сообщения
  │
  ├─► IPolymarketWsEmitter.onOrderbookSnapshot(tokenId, bids, asks)
  │       │
  │       ▼
  │   MarketDataFeedAdapter
  │       │
  │       ▼
  │   BookUpdateHandler.handleFullState(marketId, tokenId, bids, asks)
  │       │ проверяет sequence number
  │       │ OrderBook.applyFullState()
  │       ▼
  │   EventBus.publish({ type: 'BOOK_UPDATED', topOfBook: book.toTopOfBook() })
  │       │
  │       ▼
  │   Strategy handlers (через TradingAPI.subscribe('BOOK_UPDATED', cb))
  │
  └─► IPolymarketWsEmitter.onOrderbookDelta(tokenId, changes)
          │
          ▼
      MarketDataFeedAdapter
          │
          ▼
      BookUpdateHandler.handleDelta(marketId, tokenId, delta)
          │ если gap detected → requestSnapshot()
          │ OrderBook.applyDelta()
          ▼
      EventBus.publish({ type: 'BOOK_UPDATED', topOfBook })
```

### Поток данных: исполнение ордеров

```
Polymarket WS (user channel)
  │
  ▼
onUserFill(rawFill)
  │
  ▼
UserEventFeedAdapter
  │
  ▼
FillEventHandler.handle(rawFill, accountId)
  │ FillMapper.fromPolymarketTradeEvent()
  ▼
EventBus.publish({ type: 'FILL_RECEIVED', fill, receivedAt })
  │
  ▼
FillOrchestrator
  │ subscribe('FILL_RECEIVED')
  ▼
ProcessFillUseCase.execute({ fill })
  │
  ├─► markIfNotExists(fill.id)  [async, storage-backed]
  ├─► OrderService.applyFill()
  ├─► PortfolioService.applyFill() [CAS retry loop]
  ├─► LedgerService.record()
  └─► EventBus.publishAll(order.pullEvents())
```

### Порядок выполнения фаз

```
Phase 0.1  package.json + tsconfig ──────────────────────────────────────┐
Phase 0.2  WS internal DTOs (НЕ domain events)                           │
Phase 0.3  Fix broken imports                                             │
Phase 0.4  logger.silly() → debug()                                      │
Phase 0.5  WsAdapter → IPolymarketWsEmitter (raw events)                 │
Phase 0.6  MarketCatalog stub                                             │
Phase 0.7  User Channel: auth, subscription, message disambiguation      │
             Инфраструктура компилируется                                 │
                                                                          │
Phase 1    @polymarket/ports ─────────────────────────────────────────────┤
Phase 2    @polymarket/event-bus                                          │
Phase 3    @polymarket/handlers                                           │
Phase 4    @polymarket/risk                     (3 и 4 параллельно)       │
Phase 5    @polymarket/use-cases                                          │
Phase 6    @polymarket/orchestrators            (6 и 7 вместе)            │
Phase 7    @polymarket/strategy                                           │
Phase 8    Bridge: infrastructure → application                           │
Phase 9    Recovery & Reconciliation                                      │
             Система готова к production                                  │
```

---

## Фаза 0: Инфраструктурный скаффолдинг

**Цель:** Сделать `packages/infrastructure/polymarket` компилируемым workspace-пакетом.
**Независима от фаз 1–9** — можно делать параллельно.

---

### Фаза 0.1 — package.json + tsconfig

**Файлы для создания:**

**`packages/infrastructure/polymarket/package.json`**
```json
{
  "name": "@polymarket/exchange",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    "./rest":     { "types": "./dist/rest/index.d.ts",     "import": "./dist/rest/index.js" },
    "./ws":       { "types": "./dist/ws/index.d.ts",       "import": "./dist/ws/index.js" },
    "./adapters": { "types": "./dist/adapters/index.d.ts", "import": "./dist/adapters/index.js" }
  },
  "scripts": {
    "build":     "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "lint":      "eslint . --ext .ts"
  },
  "dependencies": {
    "@polymarket/logger":        "workspace:*",
    "@polymarket/ids":           "workspace:*",
    "@polymarket/result":        "workspace:*",
    "@polymarket/errors":        "workspace:*",
    "@polymarket/value-objects": "workspace:*",
    "@polymarket/order-book":    "workspace:*",
    "@polymarket/trade":         "workspace:*",
    "decimal.js": "*",
    "ethers": "*"
  }
}
```

**`packages/infrastructure/polymarket/tsconfig.json`**
```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "./dist",
    "paths": {
      "@polymarket/logger":        ["../../foundation/logger/src/index.ts"],
      "@polymarket/ids":           ["../../foundation/ids/src/index.ts"],
      "@polymarket/result":        ["../../foundation/result/src/index.ts"],
      "@polymarket/errors":        ["../../foundation/errors/src/index.ts"],
      "@polymarket/value-objects": ["../../domain/value-objects/src/index.ts"],
      "@polymarket/order-book":    ["../../domain/market-data/order-book/src/index.ts"],
      "@polymarket/trade":         ["../../domain/entities/trade/src/index.ts"]
    }
  },
  "include": ["**/*.ts"],
  "exclude": ["dist", "node_modules"]
}
```

**`packages/infrastructure/polymarket/tsconfig.build.json`**
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "declaration": true, "declarationMap": true },
  "include": ["rest/**/*", "ws/**/*", "errors/**/*", "adapters/**/*", "ports/**/*"]
}
```

**Верификация:**
```bash
cd packages/infrastructure/polymarket && npx tsc --listFiles --noEmit 2>&1 | head -3
# Должны видеть файлы пакета
```

---

### Фаза 0.2 — Внутренние WS типы (НЕ domain events)

**Проблема v1:** В v1 предлагалось создать `DomainEvent`, `OrderBookSnapshotReceivedEvent`, `TradeExecutedEvent` внутри infrastructure/ports. Это архитектурная ошибка — domain events должны жить только в `application/event-bus`.

**Решение v2:** Infrastructure использует простые internal DTOs — только данные для парсинга WS-сообщений. Никакой "доменной" семантики.

**Файлы для создания** в `packages/infrastructure/polymarket/ws/dto/`:

**`ws/dto/WsMessageTypes.ts`** — enum типов сообщений
```typescript
export type WsMessageType =
  | 'book'           // orderbook snapshot (market channel)
  | 'price_change'   // batch price updates (market channel, игнорируется)
  | 'trade'          // публичный трейд (market channel) ИЛИ fill (user channel)
                     // Оба канала используют event_type: "trade" — различаются по каналу
  | 'order'          // lifecycle событие ордера (ТОЛЬКО user channel): event_type: "order"
  | 'last_trade_price'
  | 'tick_size_change';
```

**`ws/dto/WsOrderbookDto.ts`** — raw DTO для парсинга стакана
```typescript
/**
 * Уровень стакана в wire-формате.
 * Polymarket шлёт ТОЛЬКО полные снапшоты (type='book') — нет инкрементальных дельт.
 * Каждый 'book' event содержит весь стакан целиком.
 */
export interface WsRawLevel { price: string; size: string; }

export interface WsOrderbookSnapshotDto {
  readonly type: 'book';
  readonly asset_id: string;     // tokenId
  readonly market: string;       // marketId (condition_id)
  readonly bids: WsRawLevel[];
  readonly asks: WsRawLevel[];
  readonly timestamp: string;
  readonly hash?: string;
}

// NOTE: 'price_change' events существуют в Polymarket WS, но это batch-уведомления
// о ценах, а НЕ инкрементальные дельты стакана. Существующий код их игнорирует.
// WsOrderbookDeltaDto НЕ нужен — никакой delta-логики нет.
```

**`ws/dto/WsTradeDto.ts`** — raw DTO для публичных трейдов
```typescript
export interface WsTradeDto {
  readonly type: 'trade';
  readonly asset_id: string;
  readonly price: string;
  readonly size: string;
  readonly side: 'BUY' | 'SELL';
  readonly timestamp: string;
}
```

**`ws/dto/WsUserEventDto.ts`** — raw DTO для user-channel (fills, order updates)
```typescript
/**
 * Статусы fill-события из Polymarket user-channel (event_type: "trade").
 *
 * Жизненный цикл fill на блокчейне:
 * - MATCHED    — подтверждён матчером, отправлен в executor service
 * - MINED      — транзакция зафиксирована в блоке (on-chain observed)
 * - CONFIRMED  — finality достигнута, транзакция успешна
 * - RETRYING   — транзакция упала, будет повторена
 * - FAILED     — транзакция окончательно упала, повторов не будет
 *
 * Обработку Fill запускаем только при MATCHED (первичная запись в Ledger).
 * MINED/CONFIRMED — on-chain подтверждения, опционально для reconciliation.
 * RETRYING/FAILED — ошибка исполнения, возможно потребуется alert/retry логика.
 */
export type WsFillStatus = 'MATCHED' | 'MINED' | 'CONFIRMED' | 'RETRYING' | 'FAILED';

/**
 * Raw DTO fill-события из user-channel (event_type: "trade").
 *
 * ВАЖНО: user channel использует тот же event_type "trade", что и market channel.
 * Различаются по форме пейлоада: user fill имеет taker_order_id, fee_rate_bps и т.д.
 */
export interface WsUserFillDto {
  readonly id: string;
  readonly taker_order_id: string;
  readonly trader_side: 'BUY' | 'SELL';
  readonly price: string;
  readonly size: string;
  readonly fee_rate_bps: string;
  readonly status: WsFillStatus;
  readonly asset_id: string;
  readonly maker_orders: Array<{ order_id: string; matched_amount: string; }>;
  readonly timestamp: string;
}

/**
 * Raw DTO lifecycle-события ордера из user-channel (event_type: "order").
 *
 * Поле `orderEventType` соответствует полю `type` в JSON-пейлоаде:
 * - "PLACEMENT" — ордер принят биржей, размещён в стакане → VenueOrderUpdate.ACCEPTED
 * - Другие значения возможны при отмене/истечении ордера
 *
 * Поле `type: 'order'` — TypeScript-дискриминант, соответствует event_type: "order".
 */
export interface WsOrderUpdateDto {
  readonly type: 'order';               // event_type: "order" (TS discriminant)
  readonly orderEventType: string;      // payload field 'type': "PLACEMENT" etc.
  readonly order_id: string;
  readonly status?: string;             // текущий статус ордера (опционально)
  readonly reason?: string;
  readonly timestamp: string;
}
```

**`ws/dto/index.ts`** — реэкспорт всех DTO

**Важно:** Эти типы — ВНУТРЕННИЕ. Они не экспортируются из пакета в `package.json` exports. Используются только для парсинга и передаются в bridge-адаптеры.

**Верификация:**
```bash
grep -r "DomainEvent\|OrderBookSnapshotReceivedEvent\|TradeExecutedEvent" \
  packages/infrastructure/polymarket/ws/dto/
# Должно быть пусто — domain events НЕ в infrastructure
```

---

### Фаза 0.3 — Исправить все сломанные импорты

**Паттерн 1 (самый массовый): `../../../../domain/ports/ILogger.js` → `@polymarket/logger`**

Все 22 файла с этим импортом:
```bash
grep -rl "domain/ports/ILogger" packages/infrastructure/polymarket/ | sort
```
Глобальная замена:
```typescript
// До:
import type { ILogger } from '../../../../domain/ports/ILogger.js';
// После:
import type { ILogger } from '@polymarket/logger';
```

**Паттерн 2: `exchange/ports/I*.js` → локальные порты**

Инфраструктурные порты (IExecutionAdapter, IPortfolioAdapter и т.д.) создаём ВНУТРИ пакета в `packages/infrastructure/polymarket/ports/src/`. Они не пересекаются с application ports.

Файлы для создания в `packages/infrastructure/polymarket/ports/src/`:

| Файл | Содержимое (только сигнатуры) |
|------|------------------------------|
| `IExecutionAdapter.ts` | `PlaceOrderParams`, `OrderResponse`, `FillResponse`, `interface IExecutionAdapter { placeOrder, cancelOrder, getOpenOrders }` |
| `IPortfolioAdapter.ts` | `CanPlaceOrderParams`, `CanPlaceOrderResult`, `interface IPortfolioAdapter { canPlaceOrder, getBalance, getPositions }` |
| `IBalanceProvider.ts` | `BalanceResponse { asset: string; total: string; available: string; }`, `interface IBalanceProvider { getBalance(asset): Promise<BalanceResponse> }` |
| `IPositionsProvider.ts` | `PositionResponse`, `PositionState`, `interface IPositionsProvider { getPositions(): Promise<PositionResponse[]> }` |
| `IOrdersProvider.ts` | `interface IOrdersProvider { getOpenOrders(): Promise<OrderResponse[]> }` |
| `IMarketDataFeed.ts` | `interface IMarketDataFeed { subscribe(tokenId): void; unsubscribe(tokenId): void; isSubscribed(tokenId): boolean }` |
| `IPortfolioProjector.ts` | `interface IPortfolioProjector { getPosition(tokenId: string): { quantity: number } \| undefined }` |
| `IInfraOrderRepository.ts` | `interface IInfraOrderRepository { findById(orderId: string): Promise<unknown \| undefined> }` (отдельно от app IOrderRepository) |
| `index.ts` | реэкспорт всего |

Таблица замен по файлам:

| Файл | Старый импорт | Новый импорт |
|------|--------------|-------------|
| `rest/adapters/PolymarketExecutionAdapter.ts` | `../../../exchange/ports/IExecutionAdapter.js` | `../../ports/index.js` |
| `rest/adapters/PolymarketPortfolioAdapter.ts` | `../../../exchange/ports/IPortfolioAdapter.js` | `../../ports/index.js` |
| `rest/adapters/PolymarketPortfolioAdapter.ts` | `../../../exchange/ports/IBalanceProvider.js` | `../../ports/index.js` |
| `rest/adapters/PolymarketPortfolioAdapter.ts` | `../../../exchange/ports/IPositionsProvider.js` | `../../ports/index.js` |
| `rest/adapters/PolymarketRestAdapter.ts` | `../../../exchange/ports/IExecutionAdapter.js` | `../../ports/index.js` |
| `rest/adapters/PolymarketRestAdapter.ts` | `../../../exchange/ports/IPortfolioAdapter.js` | `../../ports/index.js` |
| `rest/policies/PolymarketBalancePolicy.ts` | `../../../exchange/ports/IBalanceProvider.js` | `../../ports/index.js` |
| `rest/providers/PolymarketBalanceProvider.ts` | `../../../exchange/ports/IBalanceProvider.js` | `../../ports/index.js` |
| `rest/providers/PolymarketPositionsProvider.ts` | `../../../exchange/ports/IPositionsProvider.js` | `../../ports/index.js` |
| `rest/providers/PolymarketOrdersProvider.ts` | `../../../exchange/ports/IOrdersProvider.js` | `../../ports/index.js` |
| `rest/mappers/PolymarketOrderMapper.ts` | `../../../exchange/ports/IExecutionAdapter.js` | `../../ports/index.js` |
| `rest/mappers/PolymarketPositionMapper.ts` | `../../../exchange/ports/IPortfolioAdapter.js` | `../../ports/index.js` |
| `sdk/PolymarketOfficialRestAdapter.ts` | `../../exchange/ports/IExecutionAdapter.js` | `../ports/index.js` |
| `sdk/PolymarketOfficialRestAdapter.ts` | `../../exchange/ports/IPortfolioAdapter.js` | `../ports/index.js` |

**Паттерн 3: shared/events → инлайн-заглушки или удаление**

| Файл | Что делать |
|------|-----------|
| `rest/adapters/PolymarketExecutionAdapter.ts` | `IEventBus`, `ExecutionEvent`, `ExecutionContext`, `EventEnvelope` → определить inline как minimal interfaces |
| `rest/PolymarketRestAdapterFactory.ts` | `IEventBus`, `PortfolioProjector` → `IInfraOrderRepository`, `IPortfolioProjector` из `../ports/index.js` |
| `rest/policies/PolymarketBalancePolicy.ts` | `PortfolioProjector` → `IPortfolioProjector` из `../../ports/index.js` |
| `ws/UserEventsFeedService.ts` | `IEventBus`, `IOrderRepository`, `ExecutionContext` → inline; `WsExecutionMapper`, `WsExecutionNormalizer` → удалить поля, инлайн-стаб |
| `ws/mapping/mapParsedToDomainEvent.ts` | **Полностью переписать** (см. Фаза 0.5) |

**Паттерн 4: domain entities**

| Файл | Старый импорт | Новый импорт |
|------|--------------|-------------|
| `ws/PolymarketWsAdapter.ts` | `../../../domain/entities/Orderbook.js` | `@polymarket/order-book` |
| `ws/PolymarketWsAdapter.ts` | `../../../domain/entities/Trade.js` | `@polymarket/trade` |
| `sdk/PolymarketOfficialWsAdapter.ts` | `../../../domain/entities/Orderbook.js` | `@polymarket/order-book` |

**Верификация:**
```bash
cd packages/infrastructure/polymarket && npx tsc --noEmit 2>&1 | grep "Cannot find module" | wc -l
# Цель: 0
```

---

### Фаза 0.4 — logger.silly() → logger.debug()

**Файл:** `packages/infrastructure/polymarket/rest/mappers/PolymarketBalanceMapper.ts`
**Строка:** ~151

```typescript
// До:
this.logger.silly('Balance mapped', { asset, total, available });
// После:
this.logger.debug('Balance mapped', { asset, total, available });
```

`ILogger` из `@polymarket/logger` не имеет метода `silly`. Ближайший эквивалент — `debug`.

**Верификация:**
```bash
grep -rn "\.silly(" packages/infrastructure/polymarket/
# Должно быть пусто
```

---

### Фаза 0.5 — WsAdapter: IPolymarketWsEmitter (raw events)

**Проблема v1:** Callbacks-модель в Phase 0.5 (Map<string, Set<OrderbookCallback>>) конфликтует с Phase 8 (FeedAdapter → Handlers). Пришлось бы переделывать.

**Решение v2:** Сразу проектируем WsAdapter как **raw event emitter** — без доменной логики, без знания о Handlers. Это финальная форма, не временная.

**`packages/infrastructure/polymarket/ws/IPolymarketWsEmitter.ts`** — новый интерфейс:

```typescript
import type { WsOrderbookSnapshotDto } from './dto/WsOrderbookDto.js';
import type { WsTradeDto } from './dto/WsTradeDto.js';
import type { WsUserFillDto, WsOrderUpdateDto } from './dto/WsUserEventDto.js';

/**
 * Контракт для подписки на raw события из Polymarket WebSocket.
 *
 * @remarks
 * Намеренно raw — без доменной обработки.
 * Bridge-адаптеры (MarketDataFeedAdapter, UserEventFeedAdapter) преобразуют
 * эти события в ApplicationEvent через Handlers.
 * Каждый метод возвращает unsubscribe-функцию для cleanup.
 *
 * Архитектура каналов:
 * - Market channel: onOrderbookSnapshot, onTradeEvent, onReconnect
 * - User channel: onUserFill, onOrderUpdate (требует аутентификации — см. Phase 0.7)
 *
 * Polymarket использует event_type: "trade" для ОБОИХ каналов:
 * - market channel: публичный трейд (WsTradeDto)
 * - user channel: fill нашего ордера (WsUserFillDto)
 * Разделение происходит в парсере по форме пейлоада.
 *
 * Polymarket orderbook channel шлёт ТОЛЬКО полные снапшоты ('book' events).
 * 'price_change' events — batch-уведомления о ценах, не дельты стакана.
 * onOrderbookDelta() отсутствует намеренно.
 */
export interface IPolymarketWsEmitter {
  /** Полный снапшот стакана (market channel, event_type: "book"). */
  onOrderbookSnapshot(cb: (dto: WsOrderbookSnapshotDto) => Promise<void>): () => void;
  /** Публичный трейд (market channel, event_type: "trade") */
  onTradeEvent(cb: (dto: WsTradeDto) => Promise<void>): () => void;
  /** Fill нашего ордера (user channel, event_type: "trade" с fill-полями) */
  onUserFill(cb: (dto: WsUserFillDto) => Promise<void>): () => void;
  /** Lifecycle событие ордера (user channel, event_type: "order") */
  onOrderUpdate(cb: (dto: WsOrderUpdateDto) => Promise<void>): () => void;
  /** Событие reconnect — BookUpdateHandler должен инвалидировать кэш стаканов */
  onReconnect(cb: () => void): () => void;
}
```

**Рефакторинг `ws/PolymarketWsAdapter.ts`:**

Удалить:
- Импорты: `InMemoryEventBus`, `ProjectorCoordinator`, `createProductionEnvelope`, `EventEnvelope`
- Поля: `eventBus`, `projector`
- Метод `mapParsedToDomainEvent` (перенести в DTO-парсеры)

Добавить реализацию `IPolymarketWsEmitter`:
- Внутренние `Set<cb>` для каждого типа события
- Dispatch из `handleMessage()` по типу DTO
- `onReconnect()` — вызывать из `reconnect()` метода

Переписать `ws/mapping/mapParsedToDomainEvent.ts` → `ws/mapping/WsMessageMapper.ts`:
```typescript
// Не domain events — только маппинг raw JSON → типизированные DTO
// WsOrderbookDeltaDto не существует: Polymarket шлёт только полные снапшоты.
// WsUserFillDto и WsTradeDto различаются по наличию поля taker_order_id:
//   - есть taker_order_id → WsUserFillDto (user channel fill)
//   - нет → WsTradeDto (market channel public trade)
export function parseWsMessage(
  raw: unknown,
  channel: 'market' | 'user'
): WsOrderbookSnapshotDto | WsTradeDto | WsUserFillDto | WsOrderUpdateDto | null
```

**Верификация:**
```bash
cd packages/infrastructure/polymarket && npx tsc --noEmit
# 0 errors
grep -r "InMemoryEventBus\|ProjectorCoordinator" packages/infrastructure/polymarket/ws/
# Должно быть пусто
```

---

### Фаза 0.6 — MarketCatalog stub

**Проблема:** В системе есть `OrderBook`, `InstrumentId`, `MarketId`, `tokenId`, но нет описания метаданных инструмента (tick size, lot size, mapping token→market).

> **Архитектурное решение:** `IMarketCatalog` — это application-layer порт (определяется в Phase 1, пакет `@polymarket/ports`). Инфраструктурный класс `PolymarketMarketCatalog` **реализует** этот порт. Строки из REST API парсятся в VOs на границе инфраструктуры, выше (в application layer) уже работают типизированные объекты.

**Файл для создания** `packages/infrastructure/polymarket/rest/PolymarketMarketCatalog.ts`:

```typescript
import Decimal from 'decimal.js';
import type { IMarketCatalog, InstrumentInfo } from '@polymarket/ports';
import { Price, Quantity } from '@polymarket/value-objects';
import { parseConditionId, asInstrumentId } from '@polymarket/ids';
import type { ILogger } from '@polymarket/logger';
import type { PolymarketMarketDataRestClient } from './PolymarketMarketDataRestClient.js';

/**
 * Внутренний тип: сырой REST-ответ Polymarket API.
 * НЕ экспортируется — живёт только внутри класса.
 */
interface RawMarketResponse {
  readonly condition_id: string;
  readonly tokens: ReadonlyArray<{ token_id: string; outcome: string }>;
  readonly minimum_tick_size: string;   // "0.01"
  readonly minimum_order_size: string;  // "5"
  readonly market_slug: string;
  readonly active: boolean;
}

/**
 * Реализация IMarketCatalog для Polymarket REST API.
 *
 * @remarks
 * Загружает метаданные инструментов при старте.
 * Строки из REST-ответа парсятся в domain VOs (Price, Quantity) здесь —
 * на границе инфраструктуры. Application layer получает готовые типизированные объекты.
 *
 * Implements: IMarketCatalog (из @polymarket/ports, Phase 1)
 */
export class PolymarketMarketCatalog implements IMarketCatalog {
  /** Индекс по tokenId (YES/NO token) */
  private readonly _byInstrumentId = new Map<string, InstrumentInfo>();

  constructor(
    private readonly _restClient: PolymarketMarketDataRestClient,
    private readonly _logger: ILogger,
  ) {}

  /** Загрузить каталог из REST. Вызывается при старте системы. */
  async load(): Promise<void> {
    const raw: RawMarketResponse[] = await this._restClient.getMarkets();
    for (const market of raw) {
      for (const token of market.tokens) {
        const info = this._parse(market, token.token_id);
        this._byInstrumentId.set(token.token_id, info);
      }
    }
    this._logger.info('MarketCatalog loaded', { count: this._byInstrumentId.size });
  }

  get(instrumentId: string): InstrumentInfo | undefined {
    return this._byInstrumentId.get(instrumentId);
  }

  getAll(): readonly InstrumentInfo[] {
    return Array.from(this._byInstrumentId.values());
  }

  /**
   * Парсит сырой REST-ответ в InstrumentInfo с domain VOs.
   * Строки → Price / Quantity / ConditionId на границе инфраструктуры.
   */
  private _parse(raw: RawMarketResponse, tokenId: string): InstrumentInfo {
    return {
      instrumentId: asInstrumentId(tokenId),
      marketId: parseConditionId(raw.condition_id),
      tickSize: Price.of(new Decimal(raw.minimum_tick_size)),
      minOrderSize: Quantity.of(new Decimal(raw.minimum_order_size)),
      active: raw.active,
    };
  }
}
```

**Ключевые принципы:**
- `RawMarketResponse` — приватный тип, представляет wire-format REST API. Не выходит за пределы класса.
- `IMarketCatalog` / `InstrumentInfo` — определяются в `@polymarket/ports` (Phase 1), используют domain VOs.
- Парсинг строк → VOs происходит ТОЛЬКО в `_parse()` — на границе инфраструктуры.
- `PolymarketMarketCatalog` добавляет метод `load(): Promise<void>`, которого нет в порту (инфраструктурная деталь).

**Где используется:**
- `BookUpdateHandler` — `catalog.get(tokenId)` → `InstrumentInfo.instrumentId` (уже `InstrumentId`, не string)
- `OrderRiskChecker` — `catalog.get(tokenId)?.tickSize` (уже `Price`, не string)
- `PolymarketExchangeClientAdapter` — маппинг параметров ордера

**Верификация:**
```bash
cd packages/infrastructure/polymarket && npx tsc --noEmit
# 0 errors — весь пакет компилируется
```

---

### Фаза 0.7 — User Channel: аутентификация и подписка

**Проблема:** В плане описан `UserEventFeedAdapter` (Phase 8.2) и `onUserFill/onOrderUpdate` в `IPolymarketWsEmitter` (Phase 0.5), но нигде не описано:
1. Как подключиться к user WS channel (аутентификация)
2. Чем отличается user channel от market channel на уровне WS
3. Как парсер различает `event_type: "trade"` market vs user channel

**Факты о Polymarket user channel:**
- WS endpoint тот же: `wss://ws-subscriptions-clob.polymarket.com/ws/`
- Параметры подписки отличаются: `{ type: 'user', markets: [...], auth: {...} }`
- Аутентификация: API-key подпись или L2 подпись (зависит от уровня доступа)
- User channel события: `event_type: "trade"` (fills) и `event_type: "order"` (lifecycle)
- `event_type: "trade"` в user channel имеет другой shape, чем в market channel

**Архитектурное решение:**

`IPolymarketWsEmitter` — общий интерфейс, скрывающий детали подключения.
Реализация (`PolymarketWsAdapter`) управляет двумя WS-соединениями:
- **Market WS**: `type: 'market'`, без аутентификации
- **User WS**: `type: 'user'`, с auth-токеном

```typescript
// packages/infrastructure/polymarket/ws/PolymarketWsAdapter.ts (добавить)

/**
 * Конфигурация user-channel подписки.
 * apiKey + secret используются для подписи запроса.
 */
export interface UserChannelConfig {
  readonly apiKey: string;
  readonly secret: string;
  readonly passphrase: string;
}

// Подписка на user channel — отдельный WS или через тот же endpoint с type: 'user'
// Формат subscription message для user channel:
// {
//   "auth": { "apiKey": "...", "secret": "...", "passphrase": "..." },
//   "markets": ["<condition_id>"],
//   "type": "user"
// }
```

**Парсинг user-channel `trade` events:**

User-channel `trade` и market-channel `trade` различаются по форме пейлоада:

```typescript
// ws/mapping/WsMessageMapper.ts
function isUserFillPayload(raw: Record<string, unknown>): raw is WsUserFillDto {
  // User fill имеет taker_order_id, fee_rate_bps, maker_orders
  return typeof raw['taker_order_id'] === 'string';
}

function parseTradeEvent(
  raw: Record<string, unknown>,
  channel: 'market' | 'user'
): WsTradeDto | WsUserFillDto | null {
  if (channel === 'user' && isUserFillPayload(raw)) return raw as WsUserFillDto;
  if (channel === 'market') return raw as WsTradeDto;
  return null;
}
```

**Реализация в `PolymarketWsAdapter`:**

```typescript
// При получении сообщения — знаем, откуда пришло (market WS или user WS)
private _handleMarketMessage(raw: unknown): void {
  const msg = raw as Record<string, unknown>;
  if (msg['event_type'] === 'book') { ... dispatch onOrderbookSnapshot ... }
  if (msg['event_type'] === 'trade') { ... dispatch onTradeEvent (WsTradeDto) ... }
}

private _handleUserMessage(raw: unknown): void {
  const msg = raw as Record<string, unknown>;
  if (msg['event_type'] === 'trade') { ... dispatch onUserFill (WsUserFillDto) ... }
  if (msg['event_type'] === 'order') { ... dispatch onOrderUpdate (WsOrderUpdateDto) ... }
}
```

**Обработка WsFillStatus в FillEventHandler:**

Не все статусы fill требуют создания записи в Ledger. Рекомендуемая логика:

| WsFillStatus | Действие |
|---|---|
| `MATCHED` | Записать Fill в Ledger (primary trigger) |
| `MINED` | Опционально: логировать on-chain confirmation |
| `CONFIRMED` | Опционально: финализировать запись |
| `RETRYING` | Alert: ошибка исполнения, транзакция повторяется |
| `FAILED` | Alert + reconciliation: fill не исполнен, откатить |

`FillEventHandler.handle()` должен проверять `dto.status` и обрабатывать только `MATCHED`.
Остальные статусы — нотификации об on-chain state, не новые fills.

**Файлы для создания/изменения в Phase 0.7:**

| Файл | Изменение |
|---|---|
| `ws/PolymarketWsAdapter.ts` | Добавить `UserChannelConfig`, разделить обработку market/user сообщений |
| `ws/mapping/WsMessageMapper.ts` | Добавить `channel` параметр, `isUserFillPayload()` |
| `ws/IPolymarketWsEmitter.ts` | Добавить `subscribeUserChannel(config: UserChannelConfig): Promise<void>` |

**Верификация:**
```bash
# User channel events корректно маршрутизируются
grep -r "orderEventType\|WsFillStatus\|taker_order_id" packages/infrastructure/polymarket/ws/
# Нет user_fill, order_update в коде
grep -r "user_fill\|order_update" packages/infrastructure/polymarket/
# Expected: пусто
```

---

## Фаза 1: @polymarket/ports

**Цель:** Application-level порты — Dependency Inversion принцип для use-cases, handlers, strategy.
**Зависит от:** Foundation (готово).
**Путь:** `packages/application/ports/`
**Пакет:** `@polymarket/ports`

### Файловая структура

```
packages/application/ports/
├── src/
│   ├── IOrderRepository.ts
│   ├── IPortfolioStore.ts
│   ├── VersionConflictError.ts
│   ├── IProcessedFillRepository.ts
│   ├── IExchangeClient.ts
│   ├── IMarketCatalog.ts
│   └── index.ts
├── package.json
├── tsconfig.json
└── tsconfig.build.json
```

### IOrderRepository.ts

```typescript
import type { Order } from '@polymarket/order';
import type { OrderId } from '@polymarket/ids';

/**
 * Хранилище активных Order агрегатов.
 *
 * @remarks
 * Единственное определение — только в @polymarket/ports.
 * Handlers и use-cases импортируют отсюда.
 * Реализации: InMemoryOrderRepository (phase 1), RedisOrderRepository (phase 9).
 */
export interface IOrderRepository {
  get(orderId: OrderId): Order | undefined;
  save(order: Order): void;
  delete(orderId: OrderId): void;
  /** Все открытые ордера стратегии. Используется TradingAPI.getOpenOrders(). */
  getByStrategyId(strategyId: string): readonly Order[];
  /** O(1) счётчик открытых ордеров. Используется OrderRiskChecker. */
  countByStrategyId(strategyId?: string): number;
}
```

### IPortfolioStore.ts

```typescript
import type { Portfolio } from '@polymarket/portfolio';
import type { AccountId } from '@polymarket/ids';
import type { Result } from '@polymarket/result';
import type { VersionConflictError } from './VersionConflictError.js';

/**
 * Хранилище Portfolio агрегата с CAS (Compare-And-Swap) защитой.
 *
 * @remarks
 * ### Зачем CAS:
 * ProcessFillUseCase и CancelOrderUseCase могут работать concurrently:
 *   ProcessFill читает Portfolio v1 → ...await... → пытается сохранить v2
 *   CancelOrder читает Portfolio v1 → ...await... → пытается сохранить v2
 * Без CAS один из них молча перезапишет другого.
 *
 * ### Как работает:
 * save() проверяет: version в store === expectedVersion?
 * Если нет → VersionConflictError → caller делает re-read и retry.
 */
export interface IPortfolioStore {
  get(accountId: AccountId): Portfolio | undefined;
  /**
   * Сохраняет Portfolio, проверяя версию.
   * @param expectedVersion - версия, прочитанная при get(); должна совпадать с текущей в store
   */
  save(portfolio: Portfolio, expectedVersion: number): Result<void, VersionConflictError>;
}
```

### VersionConflictError.ts

```typescript
import { TradingError } from '@polymarket/errors';

export class VersionConflictError extends TradingError {
  public readonly severity = 'low' as const; // caller должен retry, не fatal
  constructor(accountId: string, expected: number, actual: number) {
    super(`Portfolio version conflict for ${accountId}: expected ${expected}, got ${actual}`);
  }
}
```

### IProcessedFillRepository.ts

```typescript
import type { FillId } from '@polymarket/ids';

/**
 * Idempotency guard — предотвращает двойную обработку Fill.
 *
 * @remarks
 * ### Почему async (отличие от v1):
 * Sync-версия атомарна только в Node.js single-thread.
 * При worker_threads или multi-process (несколько экземпляров бота)
 * sync in-memory не даёт гарантий.
 * Async позволяет реализовать через Redis SETNX, Postgres unique constraint.
 *
 * ### Реализации:
 * - `InMemoryProcessedFillRepository` — for development/testing (Set<FillId>)
 * - `RedisProcessedFillRepository` — production (SETNX + TTL)
 * - `PostgresProcessedFillRepository` — production (unique index, идемпотентный INSERT)
 *
 * ### Семантика markIfNotExists:
 * Атомарна — нет window между check и mark.
 * Возвращает true если fill помечен ВПЕРВЫЕ (нужно обрабатывать).
 * Возвращает false если fill уже был помечен ранее (дубликат, пропустить).
 */
export interface IProcessedFillRepository {
  markIfNotExists(fillId: FillId): Promise<boolean>;
}
```

### IExchangeClient.ts

```typescript
import type { Result } from '@polymarket/result';
import type { OrderId, AssetId } from '@polymarket/ids';
import type { Price, Quantity, Side } from '@polymarket/value-objects';
import type { TradingError } from '@polymarket/errors';

export class ExchangeError extends TradingError {
  public readonly severity = 'high' as const;
}

export interface SubmitOrderParams {
  readonly asset: AssetId;
  readonly side: Side;
  readonly price: Price;
  readonly size: Quantity;
  readonly clientOrderId?: string; // для идемпотентного retry
  readonly strategyId?: string;
}

/**
 * Порт для взаимодействия с торговой площадкой.
 *
 * @remarks
 * Реализация: PolymarketExchangeClientAdapter в @polymarket/exchange.
 * PlaceOrderUseCase и CancelOrderUseCase зависят от этого интерфейса.
 */
export interface IExchangeClient {
  submitOrder(params: SubmitOrderParams): Promise<Result<OrderId, ExchangeError>>;
  cancelOrder(orderId: OrderId): Promise<Result<void, ExchangeError>>;
}
```

### IMarketCatalog.ts

```typescript
import type { InstrumentId, MarketId } from '@polymarket/ids';
import type { Price, Quantity } from '@polymarket/value-objects';

/**
 * Метаданные инструмента для application layer.
 * Заполняется из @polymarket/exchange при старте.
 */
export interface InstrumentInfo {
  readonly instrumentId: InstrumentId;
  readonly marketId: MarketId;
  readonly tickSize: Price;
  readonly minOrderSize: Quantity;
  readonly active: boolean;
}

export interface IMarketCatalog {
  get(instrumentId: InstrumentId): InstrumentInfo | undefined;
  getAll(): readonly InstrumentInfo[];
}
```

### package.json

```json
{
  "name": "@polymarket/ports",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "test": "jest",
    "lint": "eslint src --ext .ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@polymarket/errors":  "workspace:*",
    "@polymarket/ids":     "workspace:*",
    "@polymarket/result":  "workspace:*",
    "@polymarket/order":   "workspace:*",
    "@polymarket/portfolio": "workspace:*",
    "@polymarket/value-objects": "workspace:*"
  }
}
```

**Верификация:**
```bash
cd packages/application/ports && npm run build
# 0 errors; dist/ создан
```

---

## Фаза 2: @polymarket/event-bus

**Цель:** Единственный источник всех типов событий в системе.
**Зависит от:** Фаза 1 (ports для OrderId/FillId типов).
**Путь:** `packages/application/event-bus/`

### Файловая структура

```
packages/application/event-bus/
├── src/
│   ├── events/
│   │   ├── domain-events.ts     FillReceivedEvent
│   │   ├── market-events.ts     BookUpdatedEvent, BookDepthEvent
│   │   ├── risk-events.ts       RiskLimitBreachedEvent
│   │   ├── strategy-events.ts   StrategySignalEvent
│   │   └── index.ts             ApplicationEvent union + EventMap
│   ├── IEventBus.ts
│   ├── EventBus.ts
│   └── index.ts
├── __tests__/
│   ├── EventBus.test.ts
│   └── events.test.ts
├── package.json
├── tsconfig.json
└── tsconfig.build.json
```

### events/domain-events.ts

```typescript
import type { Fill } from '@polymarket/fill';
import type { Timestamp } from '@polymarket/value-objects';

/**
 * Fill получен и первично обработан (status: MATCHED).
 * FillOrchestrator запускает ProcessFillUseCase при получении этого события.
 */
export interface FillReceivedEvent {
  readonly type: 'FILL_RECEIVED';
  readonly fill: Fill;
  readonly receivedAt: Timestamp;
}

/**
 * Fill окончательно упал (status: FAILED).
 * Требует reconciliation: ранее записанный fill нужно откатить или пометить как failed.
 * RiskOrchestrator / RecoveryService подписываются на это событие.
 */
export interface FillFailedEvent {
  readonly type: 'FILL_FAILED';
  /** ID fill-события (совпадает с WsUserFillDto.id) */
  readonly fillId: string;
  readonly orderId: string;
  readonly receivedAt: Timestamp;
}
```

### events/market-events.ts

```typescript
import type { TopOfBook, OrderBookSnapshot } from '@polymarket/order-book';
import type { MarketId, InstrumentId } from '@polymarket/ids';
import type { Price, Quantity, Timestamp } from '@polymarket/value-objects';

/**
 * High-frequency событие — каждое изменение лучшей цены.
 *
 * @remarks
 * Несёт TopOfBook (immutable snapshot O(1)), а НЕ mutable OrderBook.
 * Причина: несколько стратегий получают это событие через fanout.
 * Если передать mutable OrderBook — стратегия А увидит изменения стратегии Б.
 */
export interface BookUpdatedEvent {
  readonly type: 'BOOK_UPDATED';
  readonly topOfBook: TopOfBook;      // { bestBid, bestAsk, spread, imbalance }
  readonly instrumentId: InstrumentId;
  readonly marketId: MarketId;
  readonly sequenceNumber: number;    // для gap detection в стратегиях
  readonly timestamp: Timestamp;
}

/**
 * Low-frequency событие — полный стакан по запросу или раз в N ms.
 * Стратегии подписываются только если нужна полная глубина.
 *
 * @remarks
 * Несёт OrderBookSnapshot из @polymarket/order-book — переиспользуем готовый
 * типизированный тип. BookUpdateHandler вызывает book.toSnapshot() при эмиссии:
 * нет дополнительных аллокаций, нет строк в application-layer событии.
 */
export interface BookDepthEvent {
  readonly type: 'BOOK_DEPTH';
  readonly instrumentId: InstrumentId;
  readonly snapshot: OrderBookSnapshot;  // ← типизированный снимок, не массив строк
  readonly timestamp: Timestamp;
}

/**
 * Публичный трейд с ленты — маркет-принт.
 * Price и Quantity VOs: это application-layer событие, не wire DTO.
 */
export interface TradeReceivedEvent {
  readonly type: 'TRADE_RECEIVED';
  readonly instrumentId: InstrumentId;
  readonly price: Price;      // ← был string
  readonly size: Quantity;    // ← был string
  readonly side: 'BUY' | 'SELL';
  readonly timestamp: Timestamp;
}
```

### events/risk-events.ts

```typescript
import type { Timestamp } from '@polymarket/value-objects';

export interface RiskLimitBreachedEvent {
  readonly type: 'RISK_LIMIT_BREACHED';
  readonly violationType: 'DRAWDOWN' | 'POSITION_LIMIT' | 'TOTAL_EXPOSURE' | 'OPEN_ORDERS';
  readonly violation: string;    // human-readable описание
  readonly triggeredAt: Timestamp;
  readonly strategyId?: string;  // если undefined → системное нарушение (остановить всё)
}
```

### events/strategy-events.ts

```typescript
import type { InstrumentId } from '@polymarket/ids';
import type { Price, Quantity } from '@polymarket/value-objects';

export interface StrategySignalEvent {
  readonly type: 'STRATEGY_SIGNAL';
  readonly strategyId: string;                   // нет StrategyId branded type — string ok
  readonly signal: 'BUY' | 'SELL' | 'CLOSE' | 'HEDGE';
  readonly instrumentId: InstrumentId;           // ← был string
  readonly suggestedPrice?: Price;               // ← был string
  readonly suggestedSize?: Quantity;             // ← был string
}
```

### events/index.ts — ApplicationEvent union

```typescript
export type { FillReceivedEvent, FillFailedEvent } from './domain-events.js';
export type { BookUpdatedEvent, BookDepthEvent, TradeReceivedEvent } from './market-events.js';
export type { RiskLimitBreachedEvent } from './risk-events.js';
export type { StrategySignalEvent } from './strategy-events.js';

// Re-export Order domain events (из @polymarket/order)
export type { OrderEvent } from '@polymarket/order';

/**
 * Полный union всех событий в системе.
 * HandlerMap использует этот тип для per-event-type типизации.
 *
 * User-channel events:
 * - FILL_RECEIVED — fill исполнен (WsFillStatus: MATCHED) → запустить ProcessFillUseCase
 * - FILL_FAILED — fill упал (WsFillStatus: FAILED) → alert + reconciliation
 * - OrderEvent (из @polymarket/order) — Order FSM transitions (FILL_APPLIED, CANCELLED и т.д.)
 */
export type ApplicationEvent =
  | FillReceivedEvent
  | FillFailedEvent
  | BookUpdatedEvent
  | BookDepthEvent
  | TradeReceivedEvent
  | RiskLimitBreachedEvent
  | StrategySignalEvent
  | OrderEvent;
```

### IEventBus.ts

```typescript
import type { ApplicationEvent } from './events/index.js';

export type EventHandler<T extends ApplicationEvent> = (event: T) => Promise<void>;

export interface IEventBus {
  publish(event: ApplicationEvent): Promise<void>;
  publishAll(events: readonly ApplicationEvent[]): Promise<void>;
  /**
   * Подписаться на события конкретного типа.
   * @returns unsubscribe-функция
   */
  subscribe<K extends ApplicationEvent['type']>(
    type: K,
    handler: EventHandler<Extract<ApplicationEvent, { type: K }>>
  ): () => void;
}
```

### EventBus.ts — реализация

```typescript
/**
 * Typed HandlerMap — per-event-type Set<handler>.
 * Ключевое отличие от Map<string, Set<handler>>:
 * TypeScript знает, какой handler соответствует какому event type.
 */
type HandlerMap = {
  [K in ApplicationEvent['type']]?: Set<EventHandler<Extract<ApplicationEvent, { type: K }>>>;
};

export class EventBus implements IEventBus {
  private readonly _handlers: HandlerMap = {};
  private _publishingCount = 0;
  private readonly _maxConcurrentPublish: number;
  private readonly _logger: ILogger;

  constructor(logger: ILogger, maxConcurrentPublish = 100) {
    this._logger = logger.child({ component: 'EventBus' });
    this._maxConcurrentPublish = maxConcurrentPublish;
  }

  public subscribe<K extends ApplicationEvent['type']>(
    type: K,
    handler: EventHandler<Extract<ApplicationEvent, { type: K }>>
  ): () => void {
    if (!this._handlers[type]) {
      (this._handlers as Record<string, unknown>)[type] = new Set();
    }
    const handlers = this._handlers[type]!;
    (handlers as Set<typeof handler>).add(handler);
    return () => (handlers as Set<typeof handler>).delete(handler);
  }

  /**
   * Публикует событие всем подписчикам параллельно (Promise.all fanout).
   *
   * @remarks
   * ### Правило изоляции handlers (Fix #5):
   * Handlers одного события НЕ должны зависеть от side-effects друг друга.
   * Пример нарушения: Handler A пишет в Portfolio, Handler B читает тот же Portfolio.
   * Если требуется такая зависимость — Handler A публикует новое событие,
   * Handler B подписывается на него (новый event → новый publish call).
   *
   * ### _publishingCount — мониторинг, не hard block:
   * Node.js event loop однопоточный — физического overflow нет.
   * Счётчик сигнализирует об async debt (много незавершённых handlers).
   * При превышении порога — log warning, investigation нужен разработчику.
   */
  public async publish(event: ApplicationEvent): Promise<void> {
    this._publishingCount++;
    if (this._publishingCount > this._maxConcurrentPublish) {
      this._logger.warn('EventBus high concurrent publish count', {
        count: this._publishingCount,
        eventType: event.type,
      });
    }
    try {
      const handlers = this._handlers[event.type];
      if (!handlers || handlers.size === 0) return;
      await Promise.all(
        [...handlers].map((handler) =>
          (handler as EventHandler<typeof event>)(event).catch((err: unknown) => {
            this._logger.error('EventBus handler threw an error', err as Error, {
              eventType: event.type,
            });
          })
        )
      );
    } finally {
      this._publishingCount--;
    }
  }

  /**
   * Публикует события последовательно (for...of, не Promise.all).
   *
   * @remarks
   * ### Почему sequential:
   * Domain events из Order.pullEvents() имеют FSM-порядок:
   * ORDER_CREATED → ORDER_ACCEPTED → ORDER_PARTIALLY_FILLED → ORDER_FILLED
   * Если публиковать параллельно — handlers могут увидеть ORDER_FILLED
   * раньше чем ORDER_CREATED. Это нарушает причинно-следственную связь.
   */
  public async publishAll(events: readonly ApplicationEvent[]): Promise<void> {
    for (const event of events) {
      await this.publish(event);
    }
  }
}
```

### __tests__/EventBus.test.ts — ключевые сценарии

```typescript
describe('EventBus', () => {
  it('delivers event to all subscribers (fanout)', async () => { ... });
  it('type-safe: BOOK_UPDATED handler only receives BookUpdatedEvent', () => { ... });
  it('unsubscribe removes handler', async () => { ... });
  it('publishAll is sequential (order preserved)', async () => { ... });
  it('handler error does not stop other handlers', async () => { ... });
  it('logs warning when publishing count exceeds threshold', async () => { ... });
});
```

**Верификация:**
```bash
cd packages/application/event-bus && npm run build && npm test
```

---

## Фаза 3: @polymarket/handlers

**Цель:** Ingress-адаптеры — принимают raw данные (от Bridge), публикуют ApplicationEvent.
**Зависит от:** Фазы 1 (ports), 2 (event-bus).
**Путь:** `packages/application/handlers/`

### Файловая структура

```
packages/application/handlers/
├── src/
│   ├── BookUpdateHandler.ts
│   ├── FillEventHandler.ts
│   ├── OrderUpdateHandler.ts
│   ├── IBookRegistry.ts
│   └── index.ts
├── __tests__/
│   ├── BookUpdateHandler.test.ts
│   ├── FillEventHandler.test.ts
│   └── OrderUpdateHandler.test.ts
├── package.json
├── tsconfig.json
└── tsconfig.build.json
```

### IBookRegistry.ts

```typescript
import type { OrderBook } from '@polymarket/order-book';
import type { MarketId, InstrumentId } from '@polymarket/ids';

/**
 * Реестр stаканов — один OrderBook на (marketId, tokenId).
 *
 * @remarks
 * BookUpdateHandler владеет OrderBook экземплярами.
 * OrderBook mutable by design — high-frequency updates без аллокаций.
 * Snapshot (TopOfBook) создаётся при каждом publish — O(1) copy.
 */
export interface IBookRegistry {
  get(marketId: MarketId, tokenId: InstrumentId): OrderBook | undefined;
  getOrCreate(marketId: MarketId, tokenId: InstrumentId): OrderBook;
  delete(marketId: MarketId, tokenId: InstrumentId): void;
}
```

### BookUpdateHandler.ts

```typescript
import type { Price, Quantity } from '@polymarket/value-objects';

/**
 * Уровень стакана с domain VOs.
 * MarketDataFeedAdapter конвертирует WsRawLevel[] → BookLevel[] перед вызовом.
 */
export interface BookLevel {
  readonly price: Price;
  readonly quantity: Quantity;
}

/**
 * Обрабатывает снапшоты стакана из Polymarket WS.
 *
 * @remarks
 * Polymarket шлёт ТОЛЬКО полные снапшоты ('book' events) — нет инкрементальных дельт.
 * 'price_change' events существуют, но это batch-уведомления, не дельты стакана.
 * Текущий код их игнорирует (см. PolymarketMessageParser.ts).
 *
 * Staleness detection: если timestamp нового снапшота не позже предыдущего —
 * логируем warn, но всё равно применяем (может быть reconnect-дубль).
 * При reconnect — OnReconnect() инвалидирует все книги.
 */
export class BookUpdateHandler {
  /** Последний timestamp снапшота per tokenId — для staleness detection */
  private readonly _lastTimestamps = new Map<string, number>();

  constructor(
    private readonly _books: IBookRegistry,
    private readonly _eventBus: IEventBus,
    private readonly _catalog: IMarketCatalog,
    private readonly _clock: IClock,
    private readonly _logger: ILogger,
  ) {}

  /**
   * Полный снапшот стакана (Polymarket WS event: type='book').
   * Единственный метод обновления — Polymarket не шлёт дельты.
   */
  public async handleSnapshot(
    tokenId: InstrumentId,
    bids: readonly BookLevel[],
    asks: readonly BookLevel[],
    timestamp: number,
  ): Promise<void> {
    const key = String(tokenId);
    const lastTs = this._lastTimestamps.get(key);

    if (lastTs !== undefined && timestamp <= lastTs) {
      this._logger.warn('Stale orderbook snapshot received, applying anyway', {
        tokenId, lastTs, got: timestamp,
      });
    }
    this._lastTimestamps.set(key, timestamp);

    const instrument = this._catalog.get(tokenId);
    const marketId = instrument?.marketId ?? (tokenId as unknown as MarketId);
    const book = this._books.getOrCreate(marketId, tokenId);
    book.applyFullState(bids, asks);

    this._logger.debug('Order book snapshot applied', { tokenId, bidsCount: bids.length, asksCount: asks.length });

    await this._eventBus.publish({
      type: 'BOOK_UPDATED',
      topOfBook: book.toTopOfBook(),
      instrumentId: tokenId,
      marketId,
      sequenceNumber: timestamp, // proxy для совместимости с BookUpdatedEvent
      timestamp: TimestampService.create(this._clock.now()).value,
    });
  }

  /**
   * Вызывается при reconnect — инвалидирует staleness timestamps.
   * WS пришлёт свежие snapshots для каждого tokenId.
   */
  public onReconnect(): void {
    this._lastTimestamps.clear();
    this._logger.info('Book timestamps reset after reconnect', {});
  }
}
```

### FillEventHandler.ts

```typescript
export class FillEventHandler {
  constructor(
    private readonly _eventBus: IEventBus,
    private readonly _clock: IClock,
    private readonly _logger: ILogger,
  ) {}

  /**
   * Обрабатывает raw fill-событие из Polymarket WS user-channel.
   * Парсит через FillMapper, публикует FILL_RECEIVED в EventBus.
   * Не обновляет Portfolio — это задача ProcessFillUseCase через FillOrchestrator.
   */
  public async handle(raw: RawPolymarketTradeEvent, accountId: AccountId): Promise<void> {
    const result = FillMapper.fromPolymarketTradeEvent(raw, accountId);
    if (!result.ok) {
      this._logger.error('Failed to parse fill event', undefined, {
        error: result.error.message, rawId: raw.id,
      });
      return;
    }
    const { fill } = result.value;
    const receivedAt = TimestampService.create(this._clock.now()).value;
    await this._eventBus.publish({ type: 'FILL_RECEIVED', fill, receivedAt });
    this._logger.info('Fill event published', { fillId: String(fill.id), orderId: String(fill.orderId) });
  }
}
```

### OrderUpdateHandler.ts

```typescript
export type VenueOrderUpdate =
  | { type: 'ACCEPTED'; orderId: OrderId }
  | { type: 'REJECTED'; orderId: OrderId; reason: string }
  | { type: 'CANCELLED'; orderId: OrderId; reason?: string }
  | { type: 'EXPIRED'; orderId: OrderId };

export class OrderUpdateHandler {
  constructor(
    private readonly _orders: IOrderRepository,  // из @polymarket/ports
    private readonly _eventBus: IEventBus,
    private readonly _logger: ILogger,
  ) {}

  public async handle(update: VenueOrderUpdate): Promise<void> {
    const order = this._orders.get(update.orderId);
    if (!order) {
      this._logger.warn('Order update for unknown order, ignoring', { orderId: String(update.orderId), type: update.type });
      return;
    }

    let result: Result<Order, TradingError>;
    switch (update.type) {
      case 'ACCEPTED':  result = order.accept(); break;
      case 'REJECTED':  result = order.reject(update.reason); break;
      case 'CANCELLED': result = order.cancel(update.reason); break;
      case 'EXPIRED':   result = order.expire(); break;
    }

    if (!result.ok) {
      this._logger.error('Failed to apply venue order update', undefined, {
        orderId: String(update.orderId), type: update.type, error: result.error.message,
      });
      return;
    }

    const updatedOrder = result.value;
    this._orders.save(updatedOrder);
    const events = updatedOrder.pullEvents();
    await this._eventBus.publishAll(events as ApplicationEvent[]);
    this._logger.info('Order status updated', { orderId: String(update.orderId), type: update.type });
  }
}
```

**Верификация:**
```bash
cd packages/application/handlers && npm run build && npm test
```

---

## Фаза 4: @polymarket/risk

**Цель:** Pre-trade и post-trade риск-контроль. Два независимых класса с разными триггерами.
**Зависит от:** Фазы 1 (ports), 2 (event-bus).
**Путь:** `packages/application/risk/`

### Файловая структура

```
packages/application/risk/
├── src/
│   ├── RiskParams.ts
│   ├── RiskViolation.ts
│   ├── PreOrderCheckInput.ts
│   ├── IOrderRiskChecker.ts
│   ├── OrderRiskChecker.ts
│   ├── IMarkPricesProvider.ts
│   ├── DrawdownRiskMonitor.ts
│   └── index.ts
├── __tests__/
│   ├── OrderRiskChecker.test.ts
│   └── DrawdownRiskMonitor.test.ts
├── package.json
└── tsconfig.json
```

### IMarkPricesProvider.ts

```typescript
import type { InstrumentId } from '@polymarket/ids';
import type { Price } from '@polymarket/value-objects';

/**
 * Провайдер последних рыночных цен для расчёта unrealized PnL.
 *
 * @remarks
 * Используется DrawdownRiskMonitor для оценки полной стоимости портфеля.
 * Реализации:
 * - `BookPricesProvider` — mid-price из IBookRegistry (live)
 * - `HistoricalPricesProvider` — из CSV/DB (для бэктеста)
 */
export interface IMarkPricesProvider {
  /** Получить последнюю цену инструмента. undefined если нет данных. */
  getPrice(instrumentId: InstrumentId): Price | undefined;
  /** Все доступные цены. Используется portfolio.getTotalValue(). */
  getLatest(): ReadonlyMap<InstrumentId, Price>;
}
```

### RiskParams.ts

```typescript
import type Decimal from 'decimal.js';

export interface RiskParams {
  /** Максимальный размер позиции по одному инструменту (в токенах) */
  readonly maxPositionSize?: Decimal;
  /** Максимальный total notional exposure по всем позициям (в USDC) */
  readonly maxTotalExposure?: Decimal;
  /** Максимальная просадка от пика портфеля (0–1, например 0.1 = 10%) */
  readonly maxDrawdown?: Decimal;
  /** Максимальный notional одного ордера (в USDC) */
  readonly maxOrderNotional?: Decimal;
  /** Максимальное количество одновременно открытых ордеров */
  readonly maxOpenOrders?: number;
  /** Минимальный доступный баланс после резервирования (в USDC) */
  readonly minAvailableBalance?: Decimal;
}
```

### PreOrderCheckInput.ts

```typescript
import type { Portfolio } from '@polymarket/portfolio';
import type { InstrumentId } from '@polymarket/ids';
import type { Price, Quantity, Side } from '@polymarket/value-objects';

/**
 * Входные данные для pre-trade проверки.
 *
 * @remarks
 * Намеренно отделён от PlaceOrderInput:
 * PlaceOrderUseCase маппирует PlaceOrderInput → PreOrderCheckInput,
 * добавляя portfolio и openOrdersCount из хранилищ.
 * OrderRiskChecker не знает ничего об use-cases.
 */
export interface PreOrderCheckInput {
  readonly portfolio: Portfolio;
  readonly openOrdersCount: number;  // из IOrderRepository.countByStrategyId()
  readonly side: Side;
  readonly price: Price;
  readonly size: Quantity;
  readonly instrumentId: InstrumentId;
  readonly strategyId?: string;
}
```

### OrderRiskChecker.ts

```typescript
/**
 * Синхронный pre-trade риск-чекер.
 *
 * @remarks
 * Порядок проверок — от дешёвых O(1) к более дорогим:
 * 1. maxOpenOrders       — O(1)
 * 2. maxOrderNotional    — O(1)
 * 3. minAvailableBalance — O(1), portfolio.balance.available()
 * 4. maxPositionSize     — O(1), portfolio.getPosition(instrumentId)
 * 5. maxTotalExposure    — O(1), portfolio.totalExposure (кэшированный Decimal)
 *
 * Ни одна проверка не итерирует все позиции — это было бы O(N).
 * portfolio.totalExposure обновляется при upsertPosition() и хранится как кэш.
 */
export class OrderRiskChecker implements IOrderRiskChecker {
  private _params: RiskParams;
  private readonly _logger: ILogger;

  constructor(params: RiskParams, logger: ILogger) {
    this._params = params;
    this._logger = logger.child({ component: 'OrderRiskChecker' });
  }

  public checkBeforeOrder(input: PreOrderCheckInput): Result<void, RiskViolationError> {
    const orderNotional = input.price.value().times(input.size.value());

    // 1. maxOpenOrders
    if (this._params.maxOpenOrders !== undefined && input.openOrdersCount >= this._params.maxOpenOrders) {
      return Err(new RiskViolationError('MAX_OPEN_ORDERS_EXCEEDED',
        `Open orders ${input.openOrdersCount} >= limit ${this._params.maxOpenOrders}`,
        { current: input.openOrdersCount, limit: this._params.maxOpenOrders, strategyId: input.strategyId }
      ));
    }

    // 2. maxOrderNotional
    if (this._params.maxOrderNotional !== undefined && orderNotional.gt(this._params.maxOrderNotional)) {
      return Err(new RiskViolationError('ORDER_NOTIONAL_EXCEEDED',
        `Order notional ${orderNotional} > limit ${this._params.maxOrderNotional} USDC`,
        { notional: orderNotional.toString(), limit: this._params.maxOrderNotional.toString() }
      ));
    }

    // 3. minAvailableBalance
    if (this._params.minAvailableBalance !== undefined) {
      const available = input.portfolio.balance.available().value();
      const afterReserve = available.minus(orderNotional);
      if (afterReserve.lt(this._params.minAvailableBalance)) {
        return Err(new RiskViolationError('INSUFFICIENT_AVAILABLE_BALANCE',
          `Balance after reserve ${afterReserve} < min ${this._params.minAvailableBalance}`,
          { available: available.toString(), afterReserve: afterReserve.toString() }
        ));
      }
    }

    // 4. maxPositionSize (только для BUY)
    if (this._params.maxPositionSize !== undefined && String(input.side) === 'BUY') {
      const current = input.portfolio.getPosition(input.instrumentId)?.quantity.value() ?? new Decimal(0);
      const after = current.plus(input.size.value());
      if (after.gt(this._params.maxPositionSize)) {
        return Err(new RiskViolationError('POSITION_LIMIT_EXCEEDED',
          `Position ${after} > limit ${this._params.maxPositionSize}`,
          { instrumentId: String(input.instrumentId), current: current.toString(), after: after.toString() }
        ));
      }
    }

    // 5. maxTotalExposure — O(1) через кэш portfolio.totalExposure
    if (this._params.maxTotalExposure !== undefined) {
      const after = input.portfolio.totalExposure.plus(orderNotional);
      if (after.gt(this._params.maxTotalExposure)) {
        return Err(new RiskViolationError('TOTAL_EXPOSURE_EXCEEDED',
          `Total exposure ${after} > limit ${this._params.maxTotalExposure} USDC`,
          { current: input.portfolio.totalExposure.toString(), after: after.toString() }
        ));
      }
    }

    return Ok(undefined);
  }

  public updateParams(params: Partial<RiskParams>): void {
    this._params = { ...this._params, ...params };
    this._logger.info('Risk params updated', { keys: Object.keys(params) });
  }
}
```

### DrawdownRiskMonitor.ts

```typescript
/**
 * Async post-trade мониторинг просадки.
 *
 * @remarks
 * Подписывается на FILL_RECEIVED — проверяет portfolio value после каждого fill.
 * Использует IMarkPricesProvider для расчёта unrealized PnL.
 * portfolio.balance.available() — только cash, НЕ полное portfolio value.
 * Нужно: cash + sum(position.quantity * markPrice) = полная стоимость.
 */
export class DrawdownRiskMonitor {
  private _peakValue: Decimal = new Decimal(0);

  constructor(
    private readonly _eventBus: IEventBus,
    private readonly _portfolioStore: IPortfolioStore,
    private readonly _markPrices: IMarkPricesProvider,
    private readonly _clock: IClock,
    private readonly _params: Pick<RiskParams, 'maxDrawdown'>,
    private readonly _logger: ILogger,
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

    const markPrices = this._markPrices.getLatest();
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
        violationType: 'DRAWDOWN',
        violation: `Drawdown ${drawdown.times(100).toFixed(2)}% exceeded max ${this._params.maxDrawdown.times(100).toFixed(2)}%`,
        triggeredAt,
      });
      this._logger.error('Drawdown limit breached', undefined, {
        drawdown: drawdown.toString(), peak: this._peakValue.toString(), current: currentValue.toString(),
      });
    }
  }
}
```

**Верификация:**
```bash
cd packages/application/risk && npm run build && npm test
```

---

## Фаза 5: @polymarket/use-cases

**Цель:** Бизнес-сценарии верхнего уровня. Координируют доменные агрегаты через порты.
**Зависит от:** Фазы 1 (ports), 2 (event-bus), 4 (risk).
**Путь:** `packages/application/use-cases/`

### Файловая структура

```
packages/application/use-cases/
├── src/
│   ├── PlaceOrderUseCase.ts
│   ├── ProcessFillUseCase.ts
│   ├── CancelOrderUseCase.ts
│   ├── services/
│   │   ├── OrderService.ts
│   │   ├── PortfolioService.ts
│   │   └── LedgerService.ts
│   └── index.ts
├── __tests__/
│   ├── PlaceOrderUseCase.test.ts
│   ├── ProcessFillUseCase.test.ts
│   └── CancelOrderUseCase.test.ts
├── package.json
└── tsconfig.json
```

### PlaceOrderUseCase.ts — полный алгоритм

```typescript
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

export class PlaceOrderUseCase {
  constructor(
    private readonly _orders: IOrderRepository,
    private readonly _portfolioStore: IPortfolioStore,
    private readonly _risk: IOrderRiskChecker,
    private readonly _exchange: IExchangeClient,
    private readonly _eventBus: IEventBus,
    private readonly _logger: ILogger,
  ) {}

  public async execute(input: PlaceOrderInput): Promise<Result<PlaceOrderOutput, PlaceOrderError>> {
    const log = this._logger.child({ useCase: 'PlaceOrderUseCase', accountId: String(input.accountId) });

    // Шаг 1: загрузить Portfolio (нужен ДО risk check)
    const oldPortfolio = this._portfolioStore.get(input.accountId);
    if (!oldPortfolio) {
      return Err(new TradingError(`Portfolio not found for account: ${String(input.accountId)}`));
    }

    // Шаг 2: риск-проверка (явное маппирование PlaceOrderInput → PreOrderCheckInput)
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
      log.warn('Order rejected by risk checker', { violation: riskResult.error.violationType });
      return Err(riskResult.error);
    }

    // Шаг 3: создать Order агрегат (PENDING)
    const orderResult = Order.create({
      id: this._generateOrderId(),
      asset: input.asset, side: input.side, price: input.price, size: input.size,
      timestamp: input.timestamp, strategyId: input.strategyId,
    });
    if (!orderResult.ok) return Err(orderResult.error);
    const order = orderResult.value;

    // Шаг 4: резервирование средств
    const notional = Money.of(input.price.value().times(input.size.value()), 'USDC');
    const reserveResult = oldPortfolio.reserveForOrder(notional);
    if (!reserveResult.ok) {
      log.warn('Insufficient funds', { notional: notional.value().toString() });
      return Err(reserveResult.error);
    }

    // Шаг 5: отправить на биржу (async)
    const submitResult = await this._exchange.submitOrder({
      asset: input.asset, side: input.side, price: input.price, size: input.size,
      clientOrderId: String(order.id), strategyId: input.strategyId,
    });

    if (!submitResult.ok) {
      // Rollback: биржа отклонила — восстанавливаем oldPortfolio
      this._portfolioStore.save(oldPortfolio, oldPortfolio.version);
      log.error('Exchange rejected order', undefined, { error: submitResult.error.message });
      return Err(submitResult.error);
    }

    // Шаг 6: сохранить Order + Portfolio с резервом (CAS)
    this._orders.save(order);
    this._portfolioStore.save(reserveResult.value, oldPortfolio.version);

    // Шаг 7: опубликовать domain events
    await this._eventBus.publishAll(order.pullEvents() as ApplicationEvent[]);

    log.info('Order placed', { orderId: String(order.id), price: input.price.value().toString(), size: input.size.value().toString() });
    return Ok({ order, orderId: order.id });
  }

  private _generateOrderId(): OrderId {
    // ULID: лексикографически сортируемый, collision-safe, deterministic retry.
    return asOrderId(ulid())!;
  }
}
```

### ProcessFillUseCase.ts — полный алгоритм с CAS retry

```typescript
export class ProcessFillUseCase {
  private static readonly MAX_CAS_RETRIES = 3;

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

  public async execute(input: { fill: Fill }): Promise<Result<void, ProcessFillError>> {
    const { fill } = input;
    const log = this._logger.child({ useCase: 'ProcessFillUseCase', fillId: String(fill.id) });

    // Шаг 0: атомарная idempotency проверка (async — storage-backed)
    const isFirstTime = await this._processedFills.markIfNotExists(fill.id);
    if (!isFirstTime) {
      log.warn('Duplicate fill received, skipping (idempotency guard)', {});
      return Ok(undefined);
    }

    // Шаг 1: найти Order
    const order = this._orders.get(fill.orderId);
    if (!order) {
      log.warn('Fill for unknown order, skipping', {});
      return Ok(undefined);
    }

    // Шаг 2: OrderService.applyFill (FSM transition)
    const orderResult = this._orderService.applyFill(order, fill);
    if (!orderResult.ok) {
      log.error('OrderService.applyFill failed', undefined, { error: orderResult.error.message });
      return Err(orderResult.error);
    }
    const updatedOrder = orderResult.value;

    // Шаг 3: PortfolioService.applyFill с CAS retry loop
    let updatedPortfolio: Portfolio | null = null;

    for (let attempt = 0; attempt < ProcessFillUseCase.MAX_CAS_RETRIES; attempt++) {
      const portfolio = this._portfolioStore.get(fill.accountId);
      if (!portfolio) {
        log.warn('Portfolio not found for fill account, skipping', {});
        return Ok(undefined);
      }

      const portfolioResult = await this._portfolioService.applyFill(portfolio, fill);
      if (!portfolioResult.ok) {
        log.error('PortfolioService.applyFill failed', undefined, { error: portfolioResult.error.message });
        return Err(portfolioResult.error);
      }

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
      return Err(new TradingError(`Portfolio CAS failed after ${ProcessFillUseCase.MAX_CAS_RETRIES} retries`));
    }

    // Шаг 4: LedgerService.record (двойная запись)
    this._ledgerService.record(fill);

    // Шаг 5: сохранить Order (Portfolio уже сохранён в retry loop)
    this._orders.save(updatedOrder);

    // Шаг 6: публикация domain events
    // НЕТ шага 7: markIfNotExists в шаге 0 уже атомарно пометил fill.
    // Повторный mark() — ошибка.
    await this._eventBus.publishAll(updatedOrder.pullEvents() as ApplicationEvent[]);

    log.info('Fill processed', { newStatus: updatedOrder.status, filledSize: updatedOrder.filledSize.value().toString() });
    return Ok(undefined);
  }
}
```

### services/OrderService.ts

```typescript
/**
 * Инкапсулирует FSM-логику применения Fill к Order агрегату.
 * ProcessFillUseCase делегирует сюда — не знает деталей FSM.
 */
export class OrderService {
  public applyFill(order: Order, fill: Fill): Result<Order, TradingError> {
    if (!order.canApplyFill(fill)) {
      return Err(new TradingError(`Cannot apply fill to order in status ${order.status}`));
    }
    return order.applyFill({ id: fill.id, size: fill.size, price: fill.price });
  }
}
```

### services/PortfolioService.ts

```typescript
/**
 * Обновляет Portfolio после Fill: debit/credit + позиция.
 * ProcessFillUseCase не знает деталей — только делегирует.
 */
export class PortfolioService {
  public async applyFill(portfolio: Portfolio, fill: Fill): Promise<Result<Portfolio, ValidationError>> {
    // 1. Списать notional (debit из reserved)
    const cashFlow = fill.getCashFlow();
    const debitResult = portfolio.applyDebit(cashFlow.amount.abs(), cashFlow.asset);
    if (!debitResult.ok) return debitResult;

    // 2. Зачислить токены (credit позиции)
    const tokenFlow = fill.getSignedQuantity();
    const creditResult = debitResult.value.applyCredit(tokenFlow.amount.abs(), tokenFlow.asset);
    if (!creditResult.ok) return creditResult;

    // 3. Обновить позицию (upsertPosition)
    return Ok(creditResult.value.upsertPosition(fill));
  }
}
```

### services/LedgerService.ts

```typescript
/**
 * Двойная запись в Ledger для аудит-трейла.
 * Синхронна — Ledger in-memory append-only.
 */
export class LedgerService {
  constructor(private readonly _ledger: Ledger) {}

  public record(fill: Fill): void {
    const entries = FillLedgerAdapter.toLedgerEntries(fill);
    for (const entry of entries) {
      this._ledger.append(entry);
    }
  }
}
```

**Верификация:**
```bash
cd packages/application/use-cases && npm run build && npm test
```

---

## Фаза 6: @polymarket/orchestrators

**Цель:** Явный слой оркестрации — связывает EventBus с use-cases и StrategyRunner.
**Зависит от:** Фазы 2 (event-bus), 5 (use-cases), 7 (IStrategyRunner — взаимная зависимость).
**Путь:** `packages/application/orchestrators/`

### Файловая структура

```
packages/application/orchestrators/
├── src/
│   ├── FillOrchestrator.ts
│   ├── RiskOrchestrator.ts
│   └── index.ts
├── __tests__/
│   └── FillOrchestrator.test.ts
├── package.json
└── tsconfig.json
```

### FillOrchestrator.ts

```typescript
/**
 * Единственный компонент, связывающий FILL_RECEIVED → ProcessFillUseCase.
 *
 * @remarks
 * Отвечает на вопрос "кто вызывает ProcessFillUseCase?".
 * FillEventHandler только парсит и публикует — не знает о use-cases.
 * Decoupling позволяет буферизировать fills при out-of-order сценариях.
 */
export class FillOrchestrator {
  constructor(
    private readonly _eventBus: IEventBus,
    private readonly _processFill: ProcessFillUseCase,
    private readonly _logger: ILogger,
  ) {}

  public register(): void {
    this._eventBus.subscribe('FILL_RECEIVED', async (event) => {
      const result = await this._processFill.execute({ fill: event.fill });
      if (!result.ok) {
        this._logger.error('ProcessFillUseCase failed', undefined, {
          fillId: String(event.fill.id), error: result.error.message,
        });
      }
    });
    this._logger.info('FillOrchestrator registered', {});
  }
}
```

### RiskOrchestrator.ts

```typescript
/**
 * Маршрутизирует RISK_LIMIT_BREACHED → IStrategyRunner.onRiskBreached().
 *
 * @remarks
 * НЕ создаётся MarketDataOrchestrator.
 * BOOK_UPDATED/BOOK_DEPTH: стратегии подписываются напрямую через ctx.api.subscribe().
 * Это устраняет потенциальную publish-loop (Phase 0.5 → Phase 8 конфликт из v1).
 */
export class RiskOrchestrator {
  constructor(
    private readonly _eventBus: IEventBus,
    private readonly _strategyRunner: IStrategyRunner,
    private readonly _logger: ILogger,
  ) {}

  public register(): void {
    this._eventBus.subscribe('RISK_LIMIT_BREACHED', async (event) => {
      await this._strategyRunner.onRiskBreached(event);
    });
    this._logger.info('RiskOrchestrator registered', {});
  }
}
```

**Верификация:**
```bash
cd packages/application/orchestrators && npm run build && npm test
```

---

## Фаза 7: @polymarket/strategy

**Цель:** Интерфейс стратегий и оркестратор жизненного цикла.
**Зависит от:** Фазы 1 (ports), 2 (event-bus), 5 (use-cases).
**Путь:** `packages/application/strategy/`

### Файловая структура

```
packages/application/strategy/
├── src/
│   ├── ITradingAPI.ts
│   ├── TradingAPI.ts
│   ├── IStrategy.ts
│   ├── StrategyContext.ts
│   ├── IStrategyRunner.ts
│   ├── StrategyRunner.ts
│   └── index.ts
├── __tests__/
│   ├── StrategyRunner.test.ts
│   └── TradingAPI.test.ts
├── package.json
└── tsconfig.json
```

### ITradingAPI.ts

```typescript
import type { AccountId, InstrumentId, OrderId } from '@polymarket/ids';
import type { Price, Quantity, Side, Timestamp } from '@polymarket/value-objects';

/**
 * Параметры размещения ордера — публичный API для стратегий.
 * Подмножество PlaceOrderInput (без accountId — TradingAPI знает его из strategyId).
 */
export interface PlaceOrderParams {
  readonly asset: InstrumentId;
  readonly side: Side;
  readonly price: Price;
  readonly size: Quantity;
  readonly timestamp: Timestamp;
}

/**
 * Тонкий фасад для стратегий — единственная точка доступа к системе.
 *
 * @remarks
 * Стратегия знает только ITradingAPI — не PlaceOrderUseCase, не IEventBus.
 * Это изолирует стратегию от внутренней архитектуры.
 * StrategyRunner создаёт конкретный TradingAPI для каждой стратегии.
 */
export interface ITradingAPI {
  placeOrder(params: PlaceOrderParams): Promise<Result<OrderId, PlaceOrderError>>;
  cancelOrder(orderId: OrderId): Promise<Result<void, CancelOrderError>>;
  getOpenOrders(): readonly Order[];
  /**
   * Подписаться на events для данной стратегии.
   * Все подписки трекаются TradingAPI для cleanup при stop().
   */
  subscribe<K extends ApplicationEvent['type']>(
    type: K,
    handler: EventHandler<Extract<ApplicationEvent, { type: K }>>
  ): () => void;
  readonly logger: ILogger;
  readonly strategyId: string;
}
```

### TradingAPI.ts — с subscription tracking (Fix #7)

```typescript
/**
 * Конкретная реализация ITradingAPI для одной стратегии.
 *
 * @remarks
 * Fix #7: _unsubscribes[] трекает ВСЕ подписки стратегии, включая вложенные
 * (subscribe вызванный из handler). unsubscribeAll() снимает все.
 *
 * Если стратегия вызывает subscribe() внутри handler'а (nested subscribe),
 * это корректно трекается: каждый вызов TradingAPI.subscribe() добавляет
 * unsubscribe-функцию в _unsubscribes[], независимо от контекста вызова.
 */
export class TradingAPI implements ITradingAPI {
  private readonly _unsubscribes: Array<() => void> = [];

  constructor(private readonly _deps: {
    readonly eventBus: IEventBus;
    readonly placeOrder: PlaceOrderUseCase;
    readonly cancelOrder: CancelOrderUseCase;
    readonly orders: IOrderRepository;
    readonly logger: ILogger;
    readonly strategyId: string;
  }) {}

  get logger() { return this._deps.logger; }
  get strategyId() { return this._deps.strategyId; }

  public subscribe<K extends ApplicationEvent['type']>(
    type: K,
    handler: EventHandler<Extract<ApplicationEvent, { type: K }>>
  ): () => void {
    const unsub = this._deps.eventBus.subscribe(type, handler);
    this._unsubscribes.push(unsub); // трекаем для cleanup
    return unsub;
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

  /** Снимает все EventBus-подписки данной стратегии. */
  public unsubscribeAll(): void {
    for (const unsub of this._unsubscribes) unsub();
    this._unsubscribes.length = 0;
  }
}
```

### IStrategyRunner.ts

```typescript
/**
 * Публичный интерфейс StrategyRunner для RiskOrchestrator и тестов.
 *
 * @remarks
 * onBookUpdate/onBookDepth НЕ включены — стратегии подписываются напрямую.
 * onRiskBreached — единственный внешний trigger (от RiskOrchestrator).
 */
export interface IStrategyRunner {
  onRiskBreached(event: RiskLimitBreachedEvent): Promise<void>;
  start(strategy: IStrategy): Promise<Result<void, Error>>;
  stop(strategyId: string): Promise<void>;
  stopAll(): Promise<void>;
  getMetrics(): Record<string, Record<string, unknown>>;
}
```

### StrategyRunner.ts

```typescript
export class StrategyRunner implements IStrategyRunner {
  private readonly _strategies = new Map<string, IStrategy>();
  private readonly _tradingAPIs = new Map<string, TradingAPI>(); // Fix #7: per-strategy API
  private readonly _logger: ILogger;

  constructor(
    private readonly _eventBus: IEventBus,
    private readonly _placeOrder: PlaceOrderUseCase,
    private readonly _cancelOrder: CancelOrderUseCase,
    private readonly _orders: IOrderRepository,
    logger: ILogger,
  ) {
    this._logger = logger.child({ component: 'StrategyRunner' });
  }

  public async start(strategy: IStrategy): Promise<Result<void, Error>> {
    if (this._strategies.has(strategy.id)) {
      return Err(new Error(`Strategy ${strategy.id} already running`));
    }

    const strategyLogger = this._logger.child({ strategyId: strategy.id, strategyName: strategy.name });

    // Создаём изолированный TradingAPI — каждая стратегия получает свой
    const tradingAPI = new TradingAPI({
      eventBus: this._eventBus,
      placeOrder: this._placeOrder,
      cancelOrder: this._cancelOrder,
      orders: this._orders,
      logger: strategyLogger,
      strategyId: strategy.id,
    });

    const ctx: StrategyContext = { api: tradingAPI };
    const initResult = await strategy.initialize(ctx);

    if (!initResult.ok) {
      tradingAPI.unsubscribeAll(); // cleanup если init упал
      strategyLogger.error('Strategy initialization failed', initResult.error as Error, {});
      return Err(initResult.error);
    }

    this._strategies.set(strategy.id, strategy);
    this._tradingAPIs.set(strategy.id, tradingAPI);
    strategyLogger.info('Strategy started', {});
    return Ok(undefined);
  }

  public async onRiskBreached(event: RiskLimitBreachedEvent): Promise<void> {
    if (event.strategyId) {
      await this.stop(event.strategyId);
    } else {
      this._logger.error('System-wide risk limit breached, stopping all', undefined, {});
      await this.stopAll();
    }
  }

  public async stop(strategyId: string): Promise<void> {
    const strategy = this._strategies.get(strategyId);
    if (!strategy) {
      this._logger.warn('Attempted to stop unknown strategy', { strategyId });
      return;
    }

    // Fix #7: снять ВСЕ подписки стратегии (включая nested)
    this._tradingAPIs.get(strategyId)?.unsubscribeAll();
    await strategy.stop();
    this._strategies.delete(strategyId);
    this._tradingAPIs.delete(strategyId);
    this._logger.info('Strategy stopped', { strategyId });
  }

  public async stopAll(): Promise<void> {
    this._logger.info('Stopping all strategies', { count: this._strategies.size });
    for (const strategyId of [...this._strategies.keys()]) {
      await this.stop(strategyId);
    }
  }

  public getMetrics(): Record<string, Record<string, unknown>> {
    const result: Record<string, Record<string, unknown>> = {};
    for (const [id, strategy] of this._strategies) {
      result[id] = strategy.getMetrics();
    }
    return result;
  }
}
```

**Верификация:**
```bash
cd packages/application/strategy && npm run build && npm test
```

---

## Фаза 8: Bridge — Infrastructure → Application

**Цель:** Подключить реальный Polymarket клиент к application layer.
**Зависит от:** Фазы 0 (инфраструктура компилируется) + Фазы 1–7 (application layer готов).
**Путь:** `packages/infrastructure/polymarket/adapters/`

### 8.1 — MarketDataFeedAdapter

**Файл:** `packages/infrastructure/polymarket/adapters/MarketDataFeedAdapter.ts`

```typescript
/**
 * Маршрутизирует рыночные данные из WS в BookUpdateHandler.
 *
 * @remarks
 * Одна ответственность: market channel (orderbook + public trades).
 * User channel (fills, order updates) → UserEventFeedAdapter.
 *
 * Gap recovery: если BookUpdateHandler вызвал _onSnapshotRequired(tokenId),
 * MarketDataFeedAdapter запрашивает snapshot через REST (не через WS).
 */
export class MarketDataFeedAdapter {
  private readonly _unsubscribes: Array<() => void> = [];

  constructor(
    private readonly _wsEmitter: IPolymarketWsEmitter,
    private readonly _bookHandler: BookUpdateHandler,
    private readonly _restClient: PolymarketOrderbookRestClient, // для gap recovery
    private readonly _logger: ILogger,
  ) {}

  public start(): void {
    // Polymarket шлёт только полные снапшоты ('book' events) — нет дельт.
    // Конвертируем WS строки → VOs на границе инфраструктуры.
    const unsubSnapshot = this._wsEmitter.onOrderbookSnapshot(async (dto) => {
      await this._bookHandler.handleSnapshot(
        dto.asset_id as InstrumentId,
        dto.bids.map((l) => ({ price: Price.of(new Decimal(l.price)), quantity: Quantity.of(new Decimal(l.size)) })),
        dto.asks.map((l) => ({ price: Price.of(new Decimal(l.price)), quantity: Quantity.of(new Decimal(l.size)) })),
        Number(dto.timestamp),
      );
    });

    const unsubReconnect = this._wsEmitter.onReconnect(() => {
      this._bookHandler.onReconnect();
      this._logger.info('Market data reconnected, book timestamps reset', {});
    });

    this._unsubscribes.push(unsubSnapshot, unsubReconnect);
  }

  /** Gap recovery callback: запросить fresh snapshot через REST */
  private async _requestSnapshot(tokenId: string): Promise<void> {
    try {
      const snapshot = await this._restClient.getOrderbook(tokenId);
      await this._bookHandler.handleFullState(
        tokenId as InstrumentId,
        snapshot.bids,
        snapshot.asks,
        Date.now(), // REST не даёт sequence number
      );
      this._logger.info('Gap recovery snapshot applied', { tokenId });
    } catch (err) {
      this._logger.error('Gap recovery snapshot failed', err as Error, { tokenId });
    }
  }

  public stop(): void {
    for (const unsub of this._unsubscribes) unsub();
    this._unsubscribes.length = 0;
  }
}
```

### 8.2 — UserEventFeedAdapter

**Файл:** `packages/infrastructure/polymarket/adapters/UserEventFeedAdapter.ts`

```typescript
/**
 * Маршрутизирует user-channel события в FillEventHandler и OrderUpdateHandler.
 *
 * @remarks
 * Одна ответственность: user channel (fills + order status updates).
 * Полностью отделён от MarketDataFeedAdapter.
 *
 * Будущие расширения (не требуют изменения MarketDataFeedAdapter):
 * - heartbeat tracking
 * - sequence tracking для user channel
 * - gap recovery для fills
 * - metrics
 */
export class UserEventFeedAdapter {
  private readonly _unsubscribes: Array<() => void> = [];

  constructor(
    private readonly _wsEmitter: IPolymarketWsEmitter,
    private readonly _fillHandler: FillEventHandler,
    private readonly _orderHandler: OrderUpdateHandler,
    private readonly _accountId: AccountId,
    private readonly _logger: ILogger,
  ) {}

  public start(): void {
    // Fills из user channel
    const unsubFill = this._wsEmitter.onUserFill(async (dto) => {
      // Явное маппирование WsUserFillDto → RawPolymarketTradeEvent
      // Нет as unknown as — поля совпадают, но делаем маппинг явно
      await this._fillHandler.handle(this._mapFillDto(dto), this._accountId);
    });

    // Обновления статуса ордеров
    const unsubOrder = this._wsEmitter.onOrderUpdate(async (dto) => {
      const update = this._mapOrderUpdate(dto);
      if (update) await this._orderHandler.handle(update);
    });

    const unsubReconnect = this._wsEmitter.onReconnect(() => {
      this._logger.info('User channel reconnected', {});
      // TODO Phase 9: trigger reconciliation
    });

    this._unsubscribes.push(unsubFill, unsubOrder, unsubReconnect);
  }

  /**
   * Явный маппинг WsUserFillDto → RawPolymarketTradeEvent.
   * Избегаем as unknown as — поля аналогичны, но тип должен быть явным.
   */
  private _mapFillDto(dto: WsUserFillDto): RawPolymarketTradeEvent {
    return {
      id: dto.id,
      taker_order_id: dto.taker_order_id,
      trader_side: dto.trader_side,
      price: dto.price,
      size: dto.size,
      fee_rate_bps: dto.fee_rate_bps,
      status: dto.status,
      asset_id: dto.asset_id,
      maker_orders: dto.maker_orders,
      timestamp: dto.timestamp,
    };
  }

  private _mapOrderUpdate(dto: WsOrderUpdateDto): VenueOrderUpdate | null {
    const orderId = asOrderId(dto.order_id);
    if (!orderId) return null;
    // dto.orderEventType — поле 'type' из JSON-пейлоада user-channel "order" события
    switch (dto.orderEventType) {
      case 'PLACEMENT':    return { type: 'ACCEPTED', orderId };
      case 'CANCELLATION': return { type: 'CANCELLED', orderId, reason: dto.reason };
      // EXPIRATION и другие будущие значения → игнорируем (не влияют на Order FSM)
      default:
        this._logger.debug('Unknown order event type, ignoring', { orderEventType: dto.orderEventType });
        return null;
    }
  }

  public stop(): void {
    for (const unsub of this._unsubscribes) unsub();
    this._unsubscribes.length = 0;
  }
}
```

### 8.3 — PolymarketExchangeClientAdapter

**Файл:** `packages/infrastructure/polymarket/adapters/PolymarketExchangeClientAdapter.ts`

```typescript
/**
 * Реализует IExchangeClient из @polymarket/ports через REST клиент.
 *
 * @remarks
 * Маппинг domain VOs → Polymarket REST params.
 * PlaceOrderUseCase зависит от IExchangeClient, не от этого класса.
 */
export class PolymarketExchangeClientAdapter implements IExchangeClient {
  constructor(
    private readonly _orderClient: PolymarketOrderRestClient,
    private readonly _logger: ILogger,
  ) {}

  public async submitOrder(params: SubmitOrderParams): Promise<Result<OrderId, ExchangeError>> {
    try {
      const response = await this._orderClient.placeOrder({
        tokenID: String(params.asset),
        side: String(params.side) as 'BUY' | 'SELL',
        price: params.price.value().toString(),
        size: params.size.value().toString(),
        orderID: params.clientOrderId, // идемпотентный retry
      });
      const orderId = asOrderId(response.orderID);
      if (!orderId) return Err(new ExchangeError(`Invalid orderId from exchange: ${response.orderID}`));
      return Ok(orderId);
    } catch (err) {
      return Err(new ExchangeError(`Exchange submitOrder failed: ${String(err)}`));
    }
  }

  public async cancelOrder(orderId: OrderId): Promise<Result<void, ExchangeError>> {
    try {
      await this._orderClient.cancelOrder(String(orderId));
      return Ok(undefined);
    } catch (err) {
      return Err(new ExchangeError(`Exchange cancelOrder failed: ${String(err)}`));
    }
  }
}
```

### 8.4 — Обновить package.json @polymarket/exchange

Добавить зависимости от application layer:
```json
{
  "dependencies": {
    "@polymarket/ports":    "workspace:*",
    "@polymarket/handlers": "workspace:*",
    "@polymarket/event-bus": "workspace:*"
  }
}
```

**Верификация:**
```bash
cd packages/infrastructure/polymarket && npx tsc --noEmit
```

---

## Фаза 9: Recovery & Reconciliation

**Цель:** Восстановление состояния после рестарта процесса.
**Зависит от:** Фазы 1–8 полностью готовы.
**Путь:** `packages/application/recovery/`

### Проблема

При рестарте:
- `IOrderRepository` (in-memory) — пустой: потеряны все открытые ордера
- `IPortfolioStore` (in-memory) — пустой: потерян баланс и позиции
- `IProcessedFillRepository` (in-memory) — пустой: риск двойной обработки fills

### Файловая структура

```
packages/application/recovery/
├── src/
│   ├── OrderReconciler.ts
│   ├── PortfolioReplayService.ts
│   ├── IOpenOrdersProvider.ts      # порт для получения open orders с биржи
│   └── index.ts
├── __tests__/
│   └── OrderReconciler.test.ts
├── package.json
└── tsconfig.json
```

### IOpenOrdersProvider.ts

```typescript
/**
 * Порт для получения открытых ордеров с биржи при старте.
 * Реализация: PolymarketOrdersProvider (REST) в @polymarket/exchange.
 */
export interface IOpenOrdersProvider {
  getOpenOrders(accountId: AccountId): Promise<readonly OpenOrderSnapshot[]>;
}

/**
 * Снимок открытого ордера — application-layer тип, используется в OrderReconciler.
 *
 * @remarks
 * Инфраструктурная реализация (PolymarketOrdersProvider) парсит REST-ответ
 * и конвертирует строки → VOs здесь, на границе инфраструктуры.
 * OrderReconciler работает только с типизированными domain VOs.
 */
export interface OpenOrderSnapshot {
  readonly orderId: OrderId;
  readonly asset: AssetId;
  readonly side: Side;
  readonly price: Price;
  readonly size: Quantity;
  readonly filledSize: Quantity;
  readonly status: 'OPEN' | 'MATCHED' | 'PARTIALLY_FILLED';  // известные статусы open orders
  readonly timestamp: Timestamp;
}
```

### OrderReconciler.ts

```typescript
/**
 * Синхронизирует IOrderRepository с реальным состоянием биржи при старте.
 *
 * @remarks
 * ### Алгоритм:
 * 1. Запросить open orders с биржи (REST)
 * 2. Для каждого open order — создать Order агрегат и сохранить в repository
 * 3. Логировать расхождения (ордера которые биржа знает, а мы нет)
 *
 * Запускается ОДИН РАЗ при старте, до начала обработки WS событий.
 */
export class OrderReconciler {
  constructor(
    private readonly _orders: IOrderRepository,
    private readonly _openOrdersProvider: IOpenOrdersProvider,
    private readonly _logger: ILogger,
  ) {}

  public async reconcile(accountId: AccountId): Promise<void> {
    this._logger.info('Starting order reconciliation', {});
    const exchangeOrders = await this._openOrdersProvider.getOpenOrders(accountId);

    let restored = 0;
    for (const snapshot of exchangeOrders) {
      const orderId = asOrderId(snapshot.orderId);
      if (!orderId) continue;

      if (!this._orders.get(orderId)) {
        const orderResult = Order.fromSnapshot(snapshot); // Order должен поддерживать fromSnapshot
        if (orderResult.ok) {
          this._orders.save(orderResult.value);
          restored++;
        }
      }
    }

    this._logger.info('Order reconciliation complete', { exchangeOrders: exchangeOrders.length, restored });
  }
}
```

### PortfolioReplayService.ts

```typescript
/**
 * Восстанавливает Portfolio из Ledger при рестарте.
 *
 * @remarks
 * Ledger — append-only источник истины.
 * Portfolio = проекция Ledger на текущий момент.
 * replay() воссоздаёт Portfolio из всех LedgerEntry для accountId.
 */
export class PortfolioReplayService {
  constructor(
    private readonly _ledger: Ledger,
    private readonly _portfolioStore: IPortfolioStore,
    private readonly _logger: ILogger,
  ) {}

  public async replay(accountId: AccountId): Promise<void> {
    this._logger.info('Starting portfolio replay from ledger', {});
    const portfolio = this._ledger.replay(accountId);
    this._portfolioStore.save(portfolio, 0); // version=0 для первичной загрузки
    this._logger.info('Portfolio replay complete', { accountId: String(accountId) });
  }
}
```

### Порядок старта системы

```typescript
// system-startup.ts — пример композиции
async function startup() {
  // 1. Инициализация инфраструктуры
  const catalog = new PolymarketMarketCatalog(restClient, logger);
  await catalog.load(); // Загрузить инструменты

  // 2. Recovery (до начала WS подписок)
  await portfolioReplay.replay(accountId);    // Portfolio из Ledger
  await orderReconciler.reconcile(accountId); // Orders с биржи

  // 3. Регистрация оркестраторов
  fillOrchestrator.register();
  riskOrchestrator.register();
  drawdownMonitor.register();

  // 4. Запуск стратегий
  await strategyRunner.start(myStrategy);

  // 5. Подключение к WS (теперь состояние готово)
  marketDataFeedAdapter.start();
  userEventFeedAdapter.start();

  logger.info('System startup complete', {});
}
```

**Верификация:**
```bash
cd packages/application/recovery && npm run build && npm test
```

---

## Матрица зависимостей

| Фаза | Зависит от | Параллельно с |
|------|-----------|---------------|
| 0.1 | — | — |
| 0.2 | 0.1 | — |
| 0.3 | 0.2 | — |
| 0.4 | 0.1 | 0.2, 0.3 |
| 0.5 | 0.2 | 0.3, 0.4 |
| 0.6 | 0.1 | 0.2–0.5 |
| 0.7 | 0.5 | 0.6 |
| **1 (ports)** | Foundation | Фаза 0 |
| **2 (event-bus)** | 1 | Фаза 0 |
| **3 (handlers)** | 1, 2 | Фаза 4 |
| **4 (risk)** | 1, 2 | Фаза 3 |
| **5 (use-cases)** | 1, 2, 4 | — |
| **6 (orchestrators)** | 2, 5, 7 | Вместе с 7 |
| **7 (strategy)** | 1, 2, 5 | Вместе с 6 |
| **8 (bridge)** | 0 (все), 1–7 | — |
| **9 (recovery)** | 1–8 | — |

---

## Финальный чеклист верификации

### Компиляция
```bash
# Инфраструктура
cd packages/infrastructure/polymarket && npx tsc --noEmit
# Ожидание: 0 errors

# Application layer (все пакеты)
for pkg in ports event-bus handlers risk use-cases orchestrators strategy recovery; do
  echo "=== $pkg ===" && cd packages/application/$pkg && npm run build && cd -
done

# Весь монорепо
npm run build --workspaces 2>&1 | grep -E "error|warning" | head -20
```

### Тесты
```bash
npm test --workspaces 2>&1 | grep -E "PASS|FAIL|Tests:"
```

### Архитектурные инварианты
```bash
# Fix #2: domain events НЕ в infrastructure
grep -r "DomainEvent\|OrderBookSnapshotReceivedEvent\|TradeExecutedEvent" \
  packages/infrastructure/polymarket/
# Expected: пусто

# Fix #11: IOrderRepository только в ports
grep -r "interface IOrderRepository" packages/application/
# Expected: только packages/application/ports/src/IOrderRepository.ts

# Fix #1: WsAdapter не re-publishes в EventBus
grep -r "eventBus.publish" packages/infrastructure/polymarket/ws/
# Expected: пусто

# Fix #3: нет god-object FeedAdapter
ls packages/infrastructure/polymarket/adapters/
# Expected: MarketDataFeedAdapter.ts, UserEventFeedAdapter.ts, PolymarketExchangeClientAdapter.ts

# Fix #4: markIfNotExists возвращает Promise
grep "markIfNotExists" packages/application/ports/src/IProcessedFillRepository.ts
# Expected: Promise<boolean>

# Fix #3: нет trailing mark() после markIfNotExists
grep -A5 "markIfNotExists" packages/application/use-cases/src/ProcessFillUseCase.ts | grep "\.mark("
# Expected: пусто
```

### Семантические инварианты
```
[ ] portfolio.version передаётся в каждый portfolioStore.save() вызов (CAS)
[ ] markIfNotExists async — НЕТ sync реализации в production
[ ] BookUpdateHandler.onReconnect() вызывается при reconnect (сбрасывает sequences)
[ ] StrategyRunner._tradingAPIs.get(id).unsubscribeAll() вызывается при stop()
[ ] Startup: portfolioReplay.replay() ДО wsAdapter.start()
[ ] Startup: orderReconciler.reconcile() ДО wsAdapter.start()
[ ] Handlers не зависят от side-effects друг друга в пределах одного event
[ ] Ни один файл в packages/domain/ и packages/foundation/ не изменился
[ ] WsMessageType не содержит 'user_fill' или 'order_update' — только 'order'
[ ] WsOrderUpdateDto.type === 'order', WsOrderUpdateDto.orderEventType === 'PLACEMENT'
[ ] WsFillStatus содержит MATCHED/MINED/CONFIRMED/RETRYING/FAILED (не UNMATCHED/DELAYED)
[ ] FillEventHandler обрабатывает только MATCHED статус (первичная запись в Ledger)
[ ] _mapOrderUpdate использует dto.orderEventType, а не dto.status
[ ] User-channel 'trade' events (fills) и market-channel 'trade' events различаются по каналу, не по event_type
[ ] PolymarketWsAdapter._handleMarketMessage и _handleUserMessage разделены
```

---

## Приложение: финальная структура директорий

```
packages/
├── foundation/          ✅ готово
│   ├── errors/
│   ├── ids/
│   ├── logger/
│   ├── math/
│   ├── result/
│   └── time/
│
├── domain/              ✅ готово
│   ├── value-objects/
│   ├── entities/
│   │   ├── order/
│   │   ├── fill/
│   │   ├── trade/
│   │   ├── position/
│   │   ├── portfolio/
│   │   └── market/
│   ├── accounting/ledger/
│   └── market-data/
│       ├── order-book/
│       └── trade-tape/
│
├── application/         🔲 реализовать (Фазы 1–9)
│   ├── ports/           @polymarket/ports
│   ├── event-bus/       @polymarket/event-bus
│   ├── handlers/        @polymarket/handlers
│   ├── risk/            @polymarket/risk
│   ├── use-cases/       @polymarket/use-cases
│   ├── orchestrators/   @polymarket/orchestrators
│   ├── strategy/        @polymarket/strategy
│   └── recovery/        @polymarket/recovery
│
└── infrastructure/      ⚠️ рефакторинг (Фаза 0) + Bridge (Фаза 8)
    └── polymarket/      @polymarket/exchange
        ├── ports/        инфраструктурные порты (НЕ domain events)
        ├── ws/dto/       WS DTOs (НЕ domain events)
        ├── rest/         REST clients
        ├── ws/           WebSocket client + IPolymarketWsEmitter
        ├── errors/
        ├── sdk/          legacy stubs
        └── adapters/     Bridge (Фаза 8)
            ├── MarketDataFeedAdapter.ts
            ├── UserEventFeedAdapter.ts
            └── PolymarketExchangeClientAdapter.ts
```
