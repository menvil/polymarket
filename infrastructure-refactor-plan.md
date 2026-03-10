# Рефакторинг: @polymarket/exchange-polymarket

**Scope**: только `packages/infrastructure/polymarket/` → пакет `@polymarket/exchange-polymarket`.
Application layer не создаётся. Цель: `tsc --noEmit` без ошибок.

---

## Архитектурные принципы

```
domain ← application ← infrastructure
```

- `@polymarket/exchange-polymarket` — infrastructure слой.
- Зависит от `@polymarket/logger`, `@polymarket/orderbook`, `@polymarket/trade` (уже существуют).
- Не зависит от несуществующего application layer.
- Все недостающие контракты (IEventBus, IExecutionAdapter и т.д.) определяются **внутри пакета** в `ports/`.
- Когда application layer будет создан — эти внутренние интерфейсы заменятся импортами из `@polymarket/ports`, `@polymarket/event-bus`.
- WsAdapter **публикует** события в IEventBus. Управление подписчиками — не его ответственность.

---

## 1. Новые файлы: scaffold пакета

### `packages/infrastructure/polymarket/package.json`
```json
{
  "name": "@polymarket/exchange-polymarket",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    "./rest": "./rest/index.js"
  },
  "dependencies": {
    "@polymarket/logger": "workspace:*",
    "@polymarket/orderbook": "workspace:*",
    "@polymarket/trade": "workspace:*",
    "decimal.js": "*",
    "ethers": "*"
  }
}
```

### `packages/infrastructure/polymarket/tsconfig.json`
```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "./dist",
    "paths": {
      "@polymarket/logger": ["../../foundation/logger/src/index.ts"],
      "@polymarket/orderbook": ["../../domain/entities/orderbook/src/index.ts"],
      "@polymarket/trade": ["../../domain/entities/trade/src/index.ts"]
    }
  },
  "include": ["**/*.ts"],
  "exclude": ["dist", "node_modules"]
}
```

---

## 2. Новые файлы: внутренние порты (`ports/`)

Все контракты, которых не хватает — живут здесь. Это **seam-точки**: когда application layer появится, импорты в инфраструктуре заменятся на `@polymarket/ports`, `@polymarket/event-bus`.

### `ports/IEventBus.ts`
```typescript
// Простой generic IEventBus — временный, до появления @polymarket/event-bus.
// Совместим по форме: @polymarket/event-bus IEventBus является надмножеством.
export interface IEventBus<T = unknown> {
  publish(event: T): void;
  subscribe(handler: (event: T) => void): () => void;
}
```

### `ports/IExchangeClientPort.ts`
Определяет `PlaceOrderParams`, `OrderResponse`, `FillResponse`, `IExecutionAdapter`, `CanPlaceOrderParams`, `CanPlaceOrderResult`, `PositionResponse`, `IPortfolioAdapter`.

### `ports/IBalanceProvider.ts`
```typescript
export interface IBalanceProvider {
  getAvailableBalance(): Promise<number>;
  getOutcomeBalance(tokenId: string): Promise<number>;
}
```

### `ports/IPositionsProvider.ts`
Определяет `PositionResponse`, `PositionState`, `IPositionsProvider`.

### `ports/IOrdersProvider.ts`
Определяет `IOrdersProvider` (re-export `OrderResponse` из IExchangeClientPort).

### `ports/IPortfolioProjector.ts`
```typescript
export interface IPortfolioProjector {
  getPosition(tokenId: string): { quantity: number } | undefined;
}
```

### `ports/IOrderRepository.ts`
```typescript
// Минимальный контракт для UserEventsFeedService.
// Будет заменён на @polymarket/ports IOrderRepository.
export interface IOrderRepository {
  findById(orderId: string): Promise<unknown | undefined>;
}
```

### `ports/ExecutionEvents.ts`
Определяет `OrderAccepted`, `OrderRejected`, `OrderCancelled`, `ExecutionEvent`.

### `ports/EventEnvelope.ts`
Определяет `ExecutionContext`, `EventEnvelope<T>`, функцию `createProductionEnvelope()`.

---

## 3. Новые файлы: ws-события внутри пакета

`mapParsedToDomainEvent.ts` использует классы которых нет. Они определяются рядом:

### `ws/mapping/DomainEvent.ts`
```typescript
export interface DomainEvent {
  readonly eventName: string;
}
```

### `ws/mapping/OrderBookSnapshotReceivedEvent.ts`
```typescript
import type { DomainEvent } from './DomainEvent.js';

export class OrderBookSnapshotReceivedEvent implements DomainEvent {
  readonly eventName = 'OrderBookSnapshotReceived';
  constructor(
    public readonly assetId: string,
    public readonly bids: Array<{ price: number; size: number }>,
    public readonly asks: Array<{ price: number; size: number }>,
    public readonly timestamp: Date
  ) {}
}
```

### `ws/mapping/TradeExecutedEvent.ts`
```typescript
import type { DomainEvent } from './DomainEvent.js';

export type TradeSide = 'BUY' | 'SELL' | null;

export class TradeExecutedEvent implements DomainEvent {
  readonly eventName = 'TradeExecuted';
  constructor(
    public readonly assetId: string,
    public readonly price: number,
    public readonly size: number,
    public readonly side: TradeSide,
    public readonly timestamp: Date
  ) {}
}
```

---

## 4. Новые файлы: заглушки для UserEventsFeedService

`UserEventsFeedService` импортирует несуществующие `../../ws/WsExecutionMapper.js` и `../../ws/WsExecutionNormalizer.js`. Эти пути указывают на `packages/infrastructure/ws/` которого нет. Создать минимальные заглушки **внутри пакета**:

### `ws/WsExecutionMapper.ts`
```typescript
// Заглушка — будет реализована при подключении user WS channel.
export interface WsExecutionMapperMetrics {
  increment(counter: 'ws.parse_success' | 'ws.parse_failed' | 'ws.parse_nan'): void;
  sample(event: string, data: unknown): void;
}
```

### `ws/WsExecutionNormalizer.ts`
```typescript
import type { IOrderRepository } from '../ports/IOrderRepository.js';

// Заглушка — будет реализована при подключении user WS channel.
export class WsExecutionNormalizer {
  constructor(_orderRepository: IOrderRepository) {}
}
```

И исправить импорты в `UserEventsFeedService.ts`:
```typescript
// было:  import ... from '../../ws/WsExecutionMapper.js'
// стало: import ... from './WsExecutionMapper.js'
// было:  import ... from '../../ws/WsExecutionNormalizer.js'
// стало: import ... from './WsExecutionNormalizer.js'
```

---

## 5. Переписать: `ws/PolymarketWsAdapter.ts`

### Что удалить
- Импорты: `InMemoryEventBus`, `ProjectorCoordinator`, `createProductionEnvelope`
- Поля: `eventBus: InMemoryEventBus`, `projector: ProjectorCoordinator`
- Методы: `subscribeToOrderbook(tokenId, callback)`, `subscribeToTrades(tokenId, callback)`, `unsubscribeFromOrderbook()`, `unsubscribeFromTrades()`
- Типы: `OrderbookCallback`, `TradeCallback`

### Что добавить
```typescript
import type { IEventBus } from '../ports/IEventBus.js';
import type { DomainEvent } from './mapping/DomainEvent.js';

// В конструктор добавить параметр:
private readonly eventBus: IEventBus<DomainEvent>

// Из конструктора убрать создание InMemoryEventBus и ProjectorCoordinator
```

### Что изменить

**`handleOrderbookMessage(message)`**:
```typescript
private handleOrderbookMessage(message: PolymarketOrderbookMessage): void {
  const event = mapParsedToDomainEvent(message);
  if (event !== null) {
    this.eventBus.publish(event);
  }
}
```

**`handleTradeMessage(message)`**:
```typescript
private handleTradeMessage(message: PolymarketTradeMessage): void {
  const event = mapParsedToDomainEvent(message);
  if (event !== null) {
    this.eventBus.publish(event);
  }
}
```

**`isSubscribed(tokenId)`**:
```typescript
public isSubscribed(tokenId: string): boolean {
  return this.subscribedTokens.has(tokenId);
}
```

**`destroy()`**: убрать `this.projector.destroy()`.

### Изменить IMarketDataFeed

`ws/IMarketDataFeed.ts` (создать рядом с WsAdapter):
```typescript
// Упрощённый IMarketDataFeed — только lifecycle и WS-подписки.
// Управление подписчиками перенесено на IEventBus (subscribe/unsubscribe).
export interface IMarketDataFeed {
  connect(): Promise<void>;
  subscribeToMarket(upTokenId: string, downTokenId: string): Promise<void>;
  unsubscribeFromMarket(upTokenId: string, downTokenId: string): Promise<void>;
  isSubscribed(tokenId: string): boolean;
  destroy(): Promise<void>;
}
```

---

## 6. Исправить: `logger.silly()` → `logger.debug()`

Файл `rest/mappers/PolymarketBalanceMapper.ts`, строка 151.

---

## 7. Исправить: все сломанные импорты

### Паттерн `ILogger` (16 файлов)

Во всех файлах заменить:
```typescript
// было
import type { ILogger } from '../../../../domain/ports/ILogger.js';
// стало
import type { ILogger } from '@polymarket/logger';
```

Файлы (глубина относительно package root):
| Файл | Старый путь |
|---|---|
| `rest/adapters/PolymarketExecutionAdapter.ts` | `../../../../domain/ports/ILogger.js` |
| `rest/adapters/PolymarketPortfolioAdapter.ts` | `../../../../domain/ports/ILogger.js` |
| `rest/adapters/PolymarketRestAdapter.ts` | `../../../../domain/ports/ILogger.js` |
| `rest/PolymarketRestAdapterFactory.ts` | `../../../domain/ports/ILogger.js` |
| `rest/PolymarketRestClient.ts` | `../../../domain/ports/ILogger.js` |
| `rest/PolymarketDataApiClient.ts` | `../../../domain/ports/ILogger.js` |
| `rest/policies/PolymarketBalancePolicy.ts` | `../../../../domain/ports/ILogger.js` |
| `rest/policies/PolymarketMarketConstraintsPolicy.ts` | `../../../../domain/ports/ILogger.js` |
| `rest/providers/PolymarketBalanceProvider.ts` | `../../../../domain/ports/ILogger.js` |
| `rest/providers/PolymarketPositionsProvider.ts` | `../../../../domain/ports/ILogger.js` |
| `rest/providers/PolymarketOrdersProvider.ts` | `../../../../domain/ports/ILogger.js` |
| `rest/mappers/PolymarketBalanceMapper.ts` | `../../../../domain/ports/ILogger.js` |
| `rest/mappers/PolymarketOrderMapper.ts` | `../../../../domain/ports/ILogger.js` |
| `rest/clients/PolymarketOrderRestClient.ts` | `../../../../domain/ports/ILogger.js` |
| `rest/clients/PolymarketBalanceRestClient.ts` | `../../../../domain/ports/ILogger.js` |
| `rest/clients/PolymarketPositionsRestClient.ts` | `../../../../domain/ports/ILogger.js` |
| `rest/clients/PolymarketMarketDataRestClient.ts` | `../../../../domain/ports/ILogger.js` |
| `rest/clients/PolymarketOrderbookRestClient.ts` | `../../../../domain/ports/ILogger.js` |
| `rest/clients/PolymarketTradesRestClient.ts` | `../../../../domain/ports/ILogger.js` |
| `rest/clients/PolymarketUserTradesRestClient.ts` | `../../../../domain/ports/ILogger.js` |
| `rest/auth/PolymarketOrderBuilder.ts` | `../../../../domain/ports/ILogger.js` |
| `ws/PolymarketWsClient.ts` | `../../../domain/ports/ILogger.js` |
| `ws/PolymarketMessageRouter.ts` | `../../../domain/ports/ILogger.js` |
| `ws/PolymarketMessageParser.ts` | `../../../domain/ports/ILogger.js` |
| `ws/PolymarketMessageFormatter.ts` | `../../../domain/ports/ILogger.js` |
| `ws/PolymarketWebSocketManager.ts` | `../../../domain/ports/ILogger.js` |
| `ws/UserEventsFeedService.ts` | `../../../domain/ports/ILogger.js` |
| `errors/ErrorClassifier.ts` | `../../../domain/ports/ILogger.js` |
| `sdk/PolymarketOfficialRestAdapter.ts` | `../../../domain/ports/ILogger.js` |
| `sdk/PolymarketOfficialWsAdapter.ts` | `../../../domain/ports/ILogger.js` |

### Паттерн `exchange/ports/*` → `../../ports/*` (относительно rest/adapters/)

| Файл | Старый путь | Новый путь |
|---|---|---|
| `rest/adapters/PolymarketExecutionAdapter.ts` | `../../../exchange/ports/IExecutionAdapter.js` | `../../ports/IExchangeClientPort.js` |
| `rest/adapters/PolymarketPortfolioAdapter.ts` | `../../../exchange/ports/IPortfolioAdapter.js` | `../../ports/IExchangeClientPort.js` |
| `rest/adapters/PolymarketPortfolioAdapter.ts` | `../../../exchange/ports/IBalanceProvider.js` | `../../ports/IBalanceProvider.js` |
| `rest/adapters/PolymarketPortfolioAdapter.ts` | `../../../exchange/ports/IPositionsProvider.js` | `../../ports/IPositionsProvider.js` |
| `rest/adapters/PolymarketRestAdapter.ts` | `../../../exchange/ports/IExecutionAdapter.js` | `../../ports/IExchangeClientPort.js` |
| `rest/adapters/PolymarketRestAdapter.ts` | `../../../exchange/ports/IPortfolioAdapter.js` | `../../ports/IExchangeClientPort.js` |
| `rest/mappers/PolymarketOrderMapper.ts` | `../../../exchange/ports/IExecutionAdapter.js` | `../../ports/IExchangeClientPort.js` |
| `rest/mappers/PolymarketPositionMapper.ts` | `../../../exchange/ports/IPortfolioAdapter.js` | `../../ports/IExchangeClientPort.js` |
| `rest/providers/PolymarketBalanceProvider.ts` | `../../../exchange/ports/IBalanceProvider.js` | `../../ports/IBalanceProvider.js` |
| `rest/providers/PolymarketPositionsProvider.ts` | `../../../exchange/ports/IPositionsProvider.js` | `../../ports/IPositionsProvider.js` |
| `rest/providers/PolymarketOrdersProvider.ts` | `../../../exchange/ports/IOrdersProvider.js` | `../../ports/IOrdersProvider.js` |
| `rest/policies/PolymarketBalancePolicy.ts` | `../../../exchange/ports/IBalanceProvider.js` | `../../ports/IBalanceProvider.js` |
| `sdk/PolymarketOfficialRestAdapter.ts` | `../../exchange/ports/IExecutionAdapter.js` | `../ports/IExchangeClientPort.js` |
| `sdk/PolymarketOfficialRestAdapter.ts` | `../../exchange/ports/IPortfolioAdapter.js` | `../ports/IExchangeClientPort.js` |

### Паттерн `shared/events/*` и `domain/events/*` → `ports/` или `ws/mapping/`

| Файл | Старый путь | Новый путь |
|---|---|---|
| `rest/adapters/PolymarketExecutionAdapter.ts` | `../../../../shared/events/IEventBus.js` | `../../ports/IEventBus.js` |
| `rest/adapters/PolymarketExecutionAdapter.ts` | `../../../../domain/events/ExecutionEvent.js` | `../../ports/ExecutionEvents.js` |
| `rest/adapters/PolymarketExecutionAdapter.ts` | `../../../../domain/execution/ExecutionContext.js` | `../../ports/EventEnvelope.js` |
| `rest/adapters/PolymarketExecutionAdapter.ts` | `../../../../shared/events/EventEnvelope.js` | `../../ports/EventEnvelope.js` |
| `rest/PolymarketRestAdapterFactory.ts` | `../../../shared/events/IEventBus.js` | `../ports/IEventBus.js` |
| `rest/PolymarketRestAdapterFactory.ts` | `../../../domain/services/portfolio/PortfolioProjector.js` | `../ports/IPortfolioProjector.js` |
| `rest/policies/PolymarketBalancePolicy.ts` | `../../../../domain/services/portfolio/PortfolioProjector.js` | `../../ports/IPortfolioProjector.js` |
| `ws/UserEventsFeedService.ts` | `../../../shared/events/IEventBus.js` | `../ports/IEventBus.js` |
| `ws/UserEventsFeedService.ts` | `../../../domain/ports/IOrderRepository.js` | `../ports/IOrderRepository.js` |
| `ws/UserEventsFeedService.ts` | `../../../domain/execution/ExecutionContext.js` | `../ports/EventEnvelope.js` |
| `ws/mapping/mapParsedToDomainEvent.ts` | `../../../../domain/events/OrderBookSnapshotReceivedEvent.js` | `./OrderBookSnapshotReceivedEvent.js` |
| `ws/mapping/mapParsedToDomainEvent.ts` | `../../../../domain/events/TradeExecutedEvent.js` | `./TradeExecutedEvent.js` |
| `ws/mapping/mapParsedToDomainEvent.ts` | `../../../../domain/events/DomainEvent.js` | `./DomainEvent.js` |

### Паттерн `domain/entities/*` → workspace packages

| Файл | Старый путь | Новый путь |
|---|---|---|
| `ws/PolymarketWsAdapter.ts` | `../../../domain/entities/Orderbook.js` | `@polymarket/orderbook` |
| `ws/PolymarketWsAdapter.ts` | `../../../domain/entities/Trade.js` | `@polymarket/trade` |
| `sdk/PolymarketOfficialWsAdapter.ts` | `../../../domain/entities/Orderbook.js` | `@polymarket/orderbook` |

### Паттерн `domain/ports/IMarketDataFeed` → внутренний файл

| Файл | Старый путь | Новый путь |
|---|---|---|
| `ws/PolymarketWsAdapter.ts` | `../../../domain/ports/IMarketDataFeed.js` | `./IMarketDataFeed.js` |

---

## 8. Итоговый список создаваемых файлов

```
packages/infrastructure/polymarket/
  package.json                              # новый
  tsconfig.json                             # новый
  ports/
    IEventBus.ts                            # новый
    IExchangeClientPort.ts                  # новый
    IBalanceProvider.ts                     # новый
    IPositionsProvider.ts                   # новый
    IOrdersProvider.ts                      # новый
    IPortfolioProjector.ts                  # новый
    IOrderRepository.ts                     # новый
    ExecutionEvents.ts                      # новый
    EventEnvelope.ts                        # новый
  ws/
    IMarketDataFeed.ts                      # новый (упрощённый)
    WsExecutionMapper.ts                    # новый (заглушка)
    WsExecutionNormalizer.ts                # новый (заглушка)
    mapping/
      DomainEvent.ts                        # новый
      OrderBookSnapshotReceivedEvent.ts     # новый
      TradeExecutedEvent.ts                 # новый
```

---

## 9. Файлы, которые меняются (только импорты)

Все файлы из секции 7 + `PolymarketWsAdapter.ts` (секция 5) + `PolymarketBalanceMapper.ts` (секция 6).

---

## 10. Верификация

```bash
cd packages/infrastructure/polymarket && npx tsc --noEmit
# Ожидаемый результат: 0 ошибок
```

---

## TODO (после реализации application layer)

Когда `@polymarket/event-bus` и `@polymarket/ports` будут созданы, заменить в `@polymarket/exchange-polymarket`:

| Внутренний файл | Заменить на |
|---|---|
| `ports/IEventBus.ts` | `@polymarket/event-bus` IEventBus |
| `ports/IOrderRepository.ts` | `@polymarket/ports` IOrderRepository |
| `ports/IExchangeClientPort.ts` (IExecutionAdapter) | `@polymarket/ports` IExchangeClient |
| `ports/ExecutionEvents.ts` | события из `@polymarket/event-bus` |
| `ws/mapping/DomainEvent.ts` и события | события из `@polymarket/event-bus` |
