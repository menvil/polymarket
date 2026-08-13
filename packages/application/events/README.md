# @polymarket/application-events

Canonical contracts application-level событий: пакет отвечает на вопрос
**«что произошло»** на уровне приложения и ничего не знает о том, **«как это
доставляется»**.

## Контуры событий системы

- **Application events (этот пакет)** — semantic-уведомления application-слоя:
  fill-контур (`FILL_RECEIVED`, …), рыночные данные (`BOOK_UPDATED`, …),
  сигналы стратегий (`STRATEGY_SIGNAL`), lifecycle рынков (`MARKET_OPENED`/
  `MARKET_CLOSED`), venue-обновления ордеров (`ORDER_UPDATE_RECEIVED`).
- **Domain events** — определяются внутри соответствующих Domain-пакетов.
  `OrderEvent` живёт в `@polymarket/order`; union `ApplicationEvent` лишь
  ссылается на него и **не реэкспортирует**: нужен именно `OrderEvent` —
  импортируй из `@polymarket/order`.
- **External source messages** — НЕ являются `ApplicationEvent`; будущий
  infrastructure-контур внешних сообщений будет отдельным.

## Зависимости и границы

Event definitions не зависят от `@polymarket/event-bus` и
`@polymarket/message-bus` — только от Domain/Foundation-типов
(`@polymarket/ids`, `@polymarket/value-objects`, `@polymarket/fill`,
`@polymarket/order`, `@polymarket/orderbook`). Обратные зависимости
(events → bus, domain → events) запрещены.

```text
@polymarket/event-bus        ← доставка (Application-фасад)
        ↓
@polymarket/application-events  ← контракты (этот пакет)
        ↓
domain / foundation
```

## Структура

Один публичный contract/type — один PascalCase-файл; папки — по контурам:

```text
src/
├── fill/               FillReceivedEvent, FillConfirmedEvent,
│                       FillFailedEvent, DirectFillAppliedEvent
├── market-data/        TopOfBook, BookUpdatedEvent, BookDepthEvent,
│                       TradeReceivedEvent
├── strategy/           SignalDirection, StrategySignalEvent
├── market-lifecycle/   MarketCloseReason, MarketOpenedEvent, MarketClosedEvent
├── venue-order/        VenueOrderUpdate, OrderUpdateReceivedEvent
├── ApplicationEvent.ts канонический union контура
└── index.ts            публичные exports
```

## Использование

```typescript
import type {
  ApplicationEvent,
  FillReceivedEvent,
  MarketOpenedEvent,
  StrategySignalEvent,
} from '@polymarket/application-events';

// Доставка — отдельный пакет:
import { EventBus, type IEventBus } from '@polymarket/event-bus';
```

События — flat discriminated union (`{ type, ...поля }`); envelope-миграция
(`{ type, payload }`) — отдельная будущая фаза (M-003) и здесь не начата.
