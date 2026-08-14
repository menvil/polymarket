# @polymarket/external-message-bus

Второй semantic delivery contour системы — доставка сообщений, пришедших ИЗ
ВНЕШНЕГО МИРА. Тонкий Infrastructure-фасад над generic движком
`@polymarket/message-bus`; собственной механики доставки не содержит.

## One delivery engine, two contours

```text
                      MessageBus<T>          ← ОДИН generic delivery engine
                     /             \
        Application EventBus     ExternalMessageBus
                 │                        │
          EventBusEvent             ExternalMessage
                 │                        │
        semantic internal           source-native
             events                 observations
```

Оба bus используют один и тот же движок; различается **semantic meaning** того,
что по ним ходит:

- `EventBus` — доставка внутренних Application/Domain-событий;
- `ExternalMessageBus` — доставка наблюдений от внешних systems/transports.

| | Application `EventBus` | `ExternalMessageBus` |
|---|---|---|
| Слой | Application | Infrastructure |
| Сообщение | `EventBusEvent` | `ExternalMessage` |
| Публичный lifecycle | скрыт (нет `drain`/`close`) | открыт |
| Ошибки | транслируются в Application-классы | canonical `MessageBus*Error` |
| Движок | `MessageBus<EventBusEvent>` | `MessageBus<TExternalMessage>` |

## Composition, not inheritance

```typescript
export class ExternalMessageBus<TMessage extends AnyExternalMessage>
  implements IExternalMessageBus<TMessage>
{
  private readonly _bus: MessageBus<TMessage>; // HAS-A, не IS-A
}
```

`ExternalMessageBus` **не наследуется** от `MessageBus`. Наследование сделало бы
внутренние детали движка частью контракта внешнего контура и позволило бы фасаду
частично переопределить delivery-семантику. Композиция оставляет ровно одного
владельца механики доставки.

Ни очереди, ни fan-out, ни reentrancy-логики, ни critical-обработки, ни drain,
ни close, ни stats, ни overflow-защиты этот пакет **не реализует второй раз** —
всё делегируется движку (покрыто `contour-boundary.test.ts`).

## Public API

```typescript
type IExternalMessageBus<TMessage extends AnyExternalMessage> = IMessageBus<TMessage>;
```

Порт — намеренно чистый type alias к generic `IMessageBus`: контракт доставки
внешнего контура технически совпадает с canonical-контрактом движка, а второй
источник истины разъехался бы с ним при первом же расширении.

```typescript
class ExternalMessageBus<TMessage extends AnyExternalMessage>
  implements IExternalMessageBus<TMessage>
{
  constructor(options?: MessageBusOptions);
  publish(message: TMessage): Promise<Result<void, MessageBusPublishError>>;
  publishAll(messages: readonly TMessage[]): Promise<Result<void, MessageBusPublishError>>;
  subscribe<K extends TMessage['type']>(
    type: K,
    handler: MessageHandler<Extract<TMessage, { type: K }>>,
    options?: { critical?: boolean },
  ): () => void;
  drain(): Promise<Result<void, MessageBusDrainError>>;
  close(): Promise<Result<void, MessageBusDrainError>>;
  getStats(): MessageBusStats;
}
```

### Почему lifecycle публичен

В отличие от Application `EventBus` (который намеренно скрывает `drain`/`close`
— generic lifecycle не принадлежит Application-слою), внешний контур —
Infrastructure, и lifecycle ему нужен по существу:

- **transport reconnect** — дообработать наблюдения перед пересозданием
  соединения (`drain()`);
- **graceful shutdown** — transport остановлен, оставшиеся наблюдения обязаны
  дойти до adapter-ов/Recorder-а (`close()`);
- **будущий Reader/replay** — проиграть записанный файл и дождаться обработки.

### Reuse, а не дубли

Technical types остаются canonical и импортируются у `@polymarket/message-bus`:
`MessageHandler`, `MessageBusOptions`, `MessageBusPolicy`, `MessageBusObserver`,
`MessageBusStats`, `MessageBusPublishError`, `MessageBusDrainError` и классы
ошибок. Ни `ExternalMessageHandler`, ни `ExternalMessageBusStats`, ни
`ExternalMessageBusPolicy` не существует — это были бы alias-ы без semantic
разницы.

Опции конструктора переиспользуются as-is, поэтому будущие live ingress/Recorder
настраивают лимиты очереди, не меняя delivery engine:

```typescript
const bus = new ExternalMessageBus<VenueExternalMessage>({
  policy: createMessageBusPolicy({ queuePolicy: { maxQueueSize: 250_000 } }),
  observer: { onQueueOverflow: (ctx) => metrics.dropped(ctx.attemptedCount) },
});
```

## Typed subscribe

Bus generic по КОНКРЕТНОМУ union внешних сообщений — только так работает
discriminated-union narrowing:

```typescript
type VenueExternalMessage =
  | ExternalMessage<'VENUE_BOOK', { readonly market: string; readonly bids: readonly number[] }>
  | ExternalMessage<'VENUE_TRADE', { readonly price: number }>;

const bus = new ExternalMessageBus<VenueExternalMessage>();

bus.subscribe('VENUE_BOOK', (message) => {
  message.payload.bids;   // OK — сужено до члена VENUE_BOOK
  message.payload.price;  // compile error
});
```

Параметризация `ExternalMessageBus<AnyExternalMessage>` **уничтожает** narrowing
(payload схлопывается в `unknown`) — `AnyExternalMessage` предназначен для
generic infrastructure-кода, а не для production-контуров.

## What this bus does NOT do

- **не интерпретирует payload** — source-native наблюдение доходит до handler-а
  как есть; преобразование в наши concepts делает semantic adapter ПОСЛЕ bus;
- **не генерирует и не меняет metadata** — identity/ordering/causality создаёт
  producer (transport) ДО публикации;
- **не валидирует** — decode/validation живут перед границей `ExternalMessage`;
- **не клонирует, не сериализует и не нормализует сообщение** — handler получает
  тот же объект (`handlerMessage === message`, покрыто тестом);
- **не транслирует ошибки** — наружу идут canonical `MessageBus*Error`.

### Почему ошибки не транслируются

Application `EventBus` переводит ошибки движка, потому что его публичный
error-контракт (M-000) старше движка и обязан быть от него независим. У внешнего
контура такого унаследованного контракта нет — создавать второй набор идентичных
error-классов означало бы дублирование без semantic выгоды. Если внешней
инфраструктуре позже реально потребуются собственные semantic-ошибки, это будет
отдельное решение.

## Metadata: producer, не bus

Внешнее наблюдение обычно **начинает** causal chain:

```typescript
await bus.publish({
  type: 'VENUE_BOOK',
  payload: decodeVenueBook(rawFrame),
  metadata: metadataGenerator.nextRoot(), // ← producer, не bus
});
```

Semantic adapter продолжает цепочку из доставленного сообщения:

```typescript
bus.subscribe('VENUE_BOOK', (message) => {
  const internal = {
    type: 'ORDERBOOK_UPDATED',
    payload: toOrderbook(message.payload),
    metadata: metadataGenerator.nextChild(message.metadata),
  };
});
```

```text
M1 ExternalMessage    correlationId = M1, causationId = —
 ↓
M2 ApplicationEvent   correlationId = M1, causationId = M1
```

`MessageMetadata`, `MessageMetadataGenerator`, `RunId`/`MessageId`,
high-resolution clocks и семантика correlation/causation M-004 **не менялись** —
контур просто использует готовый Foundation-стандарт.

## Validation boundary

Bus **не является** validation engine и не содержит runtime schema framework:

```text
raw untrusted JSON
        ↓
transport decode / validation     ← ответственность источника
        ↓
typed source-native payload
        ↓
ExternalMessage
        ↓
ExternalMessageBus                ← здесь уже доверенный typed-контракт
```

Передавать `JSON.parse(...) as ExternalMessage` без source-specific
декодера/валидатора нельзя: приведение типа ничего не проверяет.

## Where this fits

```text
External source
      ↓
transport / decode
      ↓
ExternalMessage
      ↓
ExternalMessageBus
      ├── semantic adapter → Orderbook / Trade / ApplicationEvent / Domain workflow
      └── future Recorder  → recorded files
                                  ↓
                              future Reader → ExternalMessageBus (replay)
```

M-004 создаёт только сам контур. Semantic adapters, Recorder, Reader/replay и
конкретные источники — последующие фазы: M-005 Polymarket, M-006 CEX,
M-007 RTDS, M-008 private/user channel. Существующая инфраструктура (Polymarket
WS, CEX, RTDS) в M-004 не мигрируется и не удаляется.

## Docs

Подробный разбор архитектуры контура — [docs/external-message-bus.md](docs/external-message-bus.md).
Контракт сообщения — `@polymarket/external-messages`.
Движок доставки и его поведенческий контракт — `@polymarket/message-bus`.
