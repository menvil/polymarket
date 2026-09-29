# @polymarket/order-events

Canonical источник **domain-событий Order** — фактов изменения Order-агрегата.

## Статус: legacy-контракт без producer'а

`Order` (`@polymarket/order`) больше не создаёт эти события и не
восстанавливается из них: внутренний outbox (`pullEvents()`) и replay
(`fromEvents()`) удалены, агрегат стал полностью immutable. Единственными
producer'ами были use-case'ы старого торгового контура — сейчас это
`legacy-bot/trading-contour-reference/`, вне сборки и тестов.

В активном дереве тип остаётся только:

- членом union доставки `EventBusEvent` в `@polymarket/event-bus`;
- в тестах, которые проверяют, что новые проекции на `ORDER_*` НЕ подписаны.

Пакет — кандидат на отдельное удаление (вместе с `OrderEvent` в
`EventBusEvent`); в рамках удаления outbox из `Order` он не менялся.

## Что такое Domain Event

`OrderEvent` (`ORDER_CREATED` … `ORDER_FILLED`) — факт перехода FSM
Order-агрегата. Это НЕ application-события: semantic-уведомления
application-слоя (`FILL_RECEIVED`, `MARKET_OPENED`, …) живут в
`@polymarket/application-events`.

## Canonical envelope (M-003)

Каждый member — тот же canonical `MessageEnvelope<TType, TPayload>` из
`@polymarket/messages`, что и у ApplicationEvent: `{ type, payload, metadata }`,
все три поля обязательны. Payload-типы именованы и экспортированы
(`OrderCreatedPayload`, …).

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
`@polymarket/fill`; order-events и order-entity используют его независимо и
друг от друга не зависят:

```text
@polymarket/fill (FillData)   @polymarket/ids   @polymarket/value-objects   @polymarket/messages
      ↑                              ↑                   ↑                        ↑
      ├──────────── @polymarket/order-events ────────────┴────────────────────────┘
      └──────────── @polymarket/order (entity) ── (без messages и order-events)
```

Пакет не зависит от `@polymarket/order`, application- и bus-слоёв.
