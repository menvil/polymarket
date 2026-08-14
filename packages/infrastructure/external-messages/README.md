# @polymarket/external-messages

Boundary-контракт сообщений, пришедших ИЗ ВНЕШНЕГО МИРА. Пакет types-only: он
задаёт ОДНУ semantic-границу и не содержит ни runtime-кода, ни валидации, ни
знаний о конкретных источниках.

## Purpose

`ExternalMessage` означает ровно одно:

> внешняя система прислала нам source-native сообщение; transport уже получил и
> декодировал его, но semantic adapter ещё НЕ преобразовал его в наши внутренние
> concepts.

Это точка, в которой сырой внешний мир становится типизированным сообщением
системы — и одновременно точка, ДО которой ничего нашего (Domain, Application) в
сообщении ещё нет.

## Canonical envelope reuse

`ExternalMessage` — **semantic specialization** canonical Foundation-конверта, а
не второй envelope:

```typescript
// @polymarket/external-messages
export type ExternalMessage<
  TType extends string,
  TPayload,
  TMetadata extends MessageMetadata = MessageMetadata,
> = MessageEnvelope<TType, TPayload, TMetadata>;
```

Структура `{ type, payload, metadata }` целиком принадлежит
`@polymarket/messages` (M-003) и здесь **не переопределяется и не копируется**.
Никакого `ExternalMessageEnvelope` с собственными полями не существует: у
системы один конверт, у него разные semantic-контуры.

Ровно так же metadata — та же canonical `MessageMetadata`. Отдельного
`ExternalMessageMetadata` нет, и поля `source`, `channel`, `exchange`,
`marketId`, `tokenId`, `transport`, `connectionId`, `rawTopic` в metadata **не
добавляются**: это semantic-данные конкретного источника, их место — в typed
payload. Metadata содержит только универсальные message-system concerns:
`messageId`, `runId`, `sequence`, `createdAt` + high-resolution компоненты,
`correlationId`, `causationId`.

## Source-native payload

`TPayload` описывает сообщение конкретного внешнего источника **в его
собственных терминах** — поля, единицы и кодировки транспорта, — а не наши
Domain-объекты:

```typescript
// Будущий контракт (M-005), payload = сообщение транспорта:
type PolymarketBookExternalMessage = ExternalMessage<
  'POLYMARKET_BOOK',
  PolymarketBookMessagePayload // НЕ Orderbook entity
>;
```

```text
PolymarketBookExternalMessage
        ↓
Polymarket semantic adapter
        ↓
Orderbook
```

`Orderbook`, `Trade`, `ReferencePrice`, `VenueOrderUpdate`, `ApplicationEvent`,
Domain-события — всё это появляется **после** semantic adapter.
`ExternalMessage` живёт строго до него.

### AnyExternalMessage — это bound, а не отмазка

```typescript
export type AnyExternalMessage = ExternalMessage<string, unknown>;
```

`AnyExternalMessage` существует для generic infrastructure-кода, который обязан
работать с любым внешним сообщением, не зная его контракта (`ExternalMessageBus`,
будущие Recorder/Reader). Конкретные production-контракты **обязаны** задавать
конкретный `TPayload`: widening до `AnyExternalMessage` уничтожает
discriminated-union narrowing и типизацию подписок.

## Validation before this boundary

Пакет не содержит runtime schema framework, и `ExternalMessage` **не является**
точкой валидации. Ответственность за декодирование и проверку лежит **перед**
границей:

```text
raw untrusted JSON
        ↓
transport decode / validation     ← здесь валидация
        ↓
typed source-native payload
        ↓
ExternalMessage                   ← здесь уже доверенный typed-контракт
        ↓
ExternalMessageBus
```

Поэтому так делать нельзя:

```typescript
// НЕТ: приведение не проверяет ничего
const message = JSON.parse(frame) as PolymarketBookExternalMessage;
```

Конкретные валидаторы/декодеры появятся вместе с конкретным source adapter
(M-005+).

## Root causality

Внешнее наблюдение обычно **начинает** causal chain, поэтому transport создаёт
metadata через `nextRoot()`:

```typescript
const external: PolymarketBookExternalMessage = {
  type: 'POLYMARKET_BOOK',
  payload: decodePolymarketBook(rawFrame),
  metadata: metadataGenerator.nextRoot(),
};
// external.metadata.correlationId === external.metadata.messageId
// external.metadata.causationId  === undefined
```

Сообщения, порождённые semantic adapter-ом, продолжают цепочку через
`nextChild()`:

```typescript
const internal = {
  type: 'ORDERBOOK_UPDATED',
  payload: toOrderbook(external.payload),
  metadata: metadataGenerator.nextChild(external.metadata),
};
// internal.metadata.correlationId === external.metadata.messageId
// internal.metadata.causationId   === external.metadata.messageId
```

```text
M1 ExternalMessage   (root)
 ↓
M2 ApplicationEvent  (child: correlation = M1, causation = M1)
```

Сам генератор metadata M-004 не меняет — контур просто ИСПОЛЬЗУЕТ готовый
Foundation-стандарт (`MessageMetadataGenerator` из `@polymarket/messages`).

## Distinction from ApplicationEvent / DomainEvent

| | ExternalMessage | ApplicationEvent / DomainEvent |
|---|---|---|
| Смысл | source-native наблюдение | внутреннее semantic-событие |
| Словарь полей | чужой (транспорта/биржи) | наш (Domain/Application) |
| Кто создаёт | transport | Domain/Application/adapter |
| Causality | как правило, root | как правило, child |
| Контур доставки | `ExternalMessageBus` | Application `EventBus` |
| Конверт | один и тот же `MessageEnvelope` | один и тот же `MessageEnvelope` |

Общий конверт — не повод их смешивать: разные контуры существуют
одновременно и параллельно, поверх одного generic delivery engine.

## Dependencies

Единственная зависимость — `@polymarket/messages`. Пакет **не** зависит от
`@polymarket/application-events`, `@polymarket/event-bus`,
`@polymarket/order-events`, `@polymarket/order`, `@polymarket/value-objects` и
никакого Domain/Application-кода: если конкретного Foundation-типа не хватает,
Domain сюда не затаскивается.

## Not in this package

Source-specific контракты (`PolymarketExternalMessage`, `CexExternalMessage`,
`RtdsExternalMessage`), semantic adapters, Recorder, Reader/replay и
runtime-валидация. Всё это — отдельные последующие фазы (M-005 Polymarket,
M-006 CEX, M-007 RTDS, M-008 private/user channel).

Доставка внешних сообщений — `@polymarket/external-message-bus`.
