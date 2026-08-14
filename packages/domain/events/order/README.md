# @polymarket/order-events

Canonical источник **domain-событий Order** — фактов изменения Order-агрегата.

## Что такое Domain Event

`OrderEvent` (`ORDER_CREATED` … `ORDER_FILLED`) — факт перехода FSM
Order-агрегата: создаётся самим агрегатом (`@polymarket/order`), применяется без
валидации и используется для replay/history (`Order.fromEvents()` /
`Order.pullEvents()`). Это НЕ application-события: semantic-уведомления
application-слоя (`FILL_RECEIVED`, `MARKET_OPENED`, …) живут в
`@polymarket/application-events`.

## Canonical envelope (M-003)

Каждый member — тот же canonical `MessageEnvelope<TType, TPayload>` из
`@polymarket/messages`, что и у ApplicationEvent: `{ type, payload, metadata }`,
все три поля обязательны. Payload-типы именованы и экспортированы
(`OrderCreatedPayload`, …) — их переиспользует Order-агрегат.

Детерминизм Domain сохранён: агрегат внутри хранит drafts `{ type, payload }`
и НЕ обращается к clock/random/generator. Canonical событие materialize-ится
на границе `Order.pullEvents(metadataFor)` — metadata поставляет
Application-слой (замыкание над canonical `MessageMetadataGenerator`:
`nextChild(parent)` для событий, порождённых сообщением; `nextRoot()` для
инициативных команд).

**Metadata не участвует в replay-семантике**: `Order.fromEvents()` читает
только `type` + `payload`; изменение metadata при одинаковых type+payload
не меняет reconstructed state (доказано тестом
`Order.metadata-independence.test.ts` в `@polymarket/order`).

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
@polymarket/fill (FillData)   @polymarket/ids   @polymarket/value-objects   @polymarket/messages
      ↑                              ↑                   ↑                        ↑
      ├──────────── @polymarket/order-events ────────────┴────────────────────────┤
      └──────────── @polymarket/order (entity) ───────────────────────────────────┘
```

Пакет не зависит от `@polymarket/order`, application- и bus-слоёв.
