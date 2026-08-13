# @polymarket/order-events

Canonical источник **domain-событий Order** — фактов изменения Order-агрегата.

## Что такое Domain Event

`OrderEvent` (`ORDER_CREATED` … `ORDER_FILLED`) — факт перехода FSM
Order-агрегата: создаётся самим агрегатом (`@polymarket/order`), применяется без
валидации и используется для replay/history (`Order.fromEvents()` /
`Order.pullEvents()`). Это НЕ application-события: semantic-уведомления
application-слоя (`FILL_RECEIVED`, `MARKET_OPENED`, …) живут в
`@polymarket/application-events`.

Через Application EventBus domain-события Order тоже доставляются — union
контура доставки определён в `@polymarket/event-bus`:
`EventBusEvent = ApplicationEvent | OrderEvent`. Это union доставки, а не
принадлежности к слою.

## Структура

Один event — один PascalCase-файл; `OrderEvent.ts` — только union:

```text
src/
├── OrderCreatedEvent.ts
├── OrderAcceptedEvent.ts
├── OrderRejectedEvent.ts
├── OrderCancelledEvent.ts
├── OrderExpiredEvent.ts
├── OrderPartiallyFilledEvent.ts
├── OrderFilledEvent.ts
├── OrderEvent.ts
└── index.ts
```

## Зависимости (DAG, без циклов)

`FillData` — общий lightweight-контракт одного исполнения — живёт в
`@polymarket/fill`, поэтому order-events и order-entity разделяют его без
циклической зависимости друг от друга:

```text
@polymarket/fill (FillData)   @polymarket/ids   @polymarket/value-objects
      ↑                              ↑                   ↑
      ├──────────── @polymarket/order-events ────────────┤
      └──────────── @polymarket/order (entity) ──────────┘
```

Пакет не зависит от `@polymarket/order`, application- и bus-слоёв.
