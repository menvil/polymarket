# @polymarket/messages

Canonical message contract системы — Foundation-владелец формы `{ type, payload, metadata }`.

## Зачем этот пакет

До M-003 системные события были flat (`{ type, fieldA, fieldB }`), metadata не существовало,
а `MessageEnvelope` жил внутри delivery-пакета `@polymarket/message-bus`. M-003 вводит ОДИН
обязательный системный контракт сообщения и отдаёт его отдельному Foundation-пакету:
contract не принадлежит ни delivery-механике, ни какому-либо слою событий — он общий для всех
контуров (Application events, Domain Order events, будущие external-сообщения M-004).

## Canonical message

```typescript
{
  type,      // routing discriminator
  payload,   // строго типизированные semantic data сообщения
  metadata,  // обязательная единая системная metadata
}
```

Все три поля **обязательны**. Flat-форм и `metadata?: ...` в системе больше не существует.

```typescript
export interface MessageEnvelope<
  TType extends string,
  TPayload,
  TMetadata extends MessageMetadata = MessageMetadata,
> {
  readonly type: TType;
  readonly payload: TPayload;
  readonly metadata: TMetadata;
}

export type TypedMessage = MessageEnvelope<string, unknown, MessageMetadata>;
```

`TypedMessage` — generic-граница delivery-слоя: `MessageBus<TMessage extends TypedMessage>`
принимает только canonical-сообщения, но runtime по-прежнему читает ТОЛЬКО `message.type`.

## MessageMetadata

```typescript
export interface MessageMetadata {
  readonly messageId: MessageId;   // уникальная identity сообщения
  readonly runId: RunId;           // identity runtime, создавшего сообщение

  readonly sequence: number;       // строго возрастает внутри одного runId, с 1

  readonly createdAt: Timestamp;   // канонический Timestamp проекта (ms precision)

  readonly createdAtUnixSeconds: number;      // целые Unix-секунды
  readonly millisecondOfSecond: number;       // 0..999
  readonly microsecondOfMillisecond: number;  // 0..999 (0 без sub-ms precision)
  readonly nanosecondOfMicrosecond: number;   // 0..999 (0 без sub-ms precision)

  readonly correlationId: MessageId; // корень causal chain
  readonly causationId?: MessageId;  // непосредственный parent; отсутствует у root
}
```

### Семантика полей

- **messageId** — branded identity конкретного сообщения. Human-readable формат
  `<runId>-<unixSeconds>-<ms>-<us>-<ns>-<sequence>`
  (например `k8f3pz7q-1786668087-123-456-789-000018423`), но identity — opaque:
  система не парсит компоненты обратно, они уже лежат отдельными полями metadata.
- **runId** — 8 символов `[a-z0-9]`, генерируется ОДИН раз на запуск процесса.
- **sequence** — порядок сообщений внутри runtime. НЕ глобален между процессами:
  инвариант — `(runId, sequence)` однозначно задаёт порядок внутри конкретного runtime.
- **Все time-поля** (`createdAt`, `createdAtUnixSeconds`, `millisecondOfSecond`,
  `microsecondOfMillisecond`, `nanosecondOfMicrosecond`) — разложение ОДНОГО
  абсолютного момента: с high-resolution источником — одного значения
  `nowEpochNanoseconds()`, без него — одного чтения `IClock.now()` (тогда
  micro/nano — честные нули: режимы без sub-ms precision наносекунды не
  выдумывают). Смешивания источников нет — поля не могут описывать разные
  моменты. Точный runtime-порядок в любом случае гарантирует `sequence`.
- **correlationId / causationId** — causal chain:

```text
M1 external observation   messageId=M1  correlationId=M1  causationId=—
        ↓
M2 application event      messageId=M2  correlationId=M1  causationId=M1
        ↓
M3 domain event           messageId=M3  correlationId=M1  causationId=M2
        ↓
M4 application event      messageId=M4  correlationId=M1  causationId=M3
```

`correlationId` — вся цепочка; `causationId` — непосредственная стрелка назад.

## MessageMetadataGenerator

Единственный canonical-механизм создания metadata. НЕ Singleton: один instance создаётся
в composition root конкретного runtime и передаётся producer-ам.

```typescript
import { MessageMetadataGenerator, LiveHighResolutionClock } from '@polymarket/messages';
import { LiveClock } from '@polymarket/time';

// Composition root (один раз на процесс):
const metadataGenerator = new MessageMetadataGenerator({
  clock: new LiveClock(),
  highResolutionClock: new LiveHighResolutionClock(), // live; в paper/replay — опустить (нули)
});

// Root-сообщение (начало новой causal chain):
const root = metadataGenerator.nextRoot();
// root.correlationId === root.messageId, causationId отсутствует

// Child-сообщение (реакция на parent):
const child = metadataGenerator.nextChild(parent.metadata);
// child.correlationId === parent.correlationId
// child.causationId === parent.messageId
```

Гарантии генератора:

- **Полностью synchronous** — нет await/I/O/locks; в одном Node runtime синхронные
  секции не interleave-ятся, поэтому `sequence++` безопасен при любом числе async producers.
- **Sequence safe-integer** — при теоретическом overflow генератор fail-fast бросает ошибку.
- **RunId** — генерируется один раз (Node crypto) или инъецируется детерминированно в тестах.
- **Время детерминируемо и когерентно** — источники только инъецированные `IClock` и
  `IHighResolutionClock` (абсолютные epoch-наносекунды). `LiveHighResolutionClock` —
  гибридные часы: wall-clock origin + monotonic elapsed (`process.hrtime.bigint()`
  измеряет ТОЛЬКО elapsed и никогда не трактуется как Unix-время напрямую); пара
  origins снимается bracket-ом (hrtime до/после `Date.now()`, wall-момент = середина
  bracket-а, широкий bracket = preemption → повторная попытка) — перекос спаривания
  двух OS-часов ограничен полушириной bracket-а.
  `PaperHighResolutionClock` — детерминированный источник для тестов/replay.

## Producer style

```typescript
const event = {
  type: 'MARKET_OPENED',
  payload: { marketId /* ... */ },
  metadata: metadataGenerator.nextRoot(),
} satisfies MarketOpenedEvent;

const reaction = {
  type: 'ORDER_FILLED',
  payload: { /* ... */ },
  metadata: metadataGenerator.nextChild(parent.metadata),
} satisfies OrderFilledEvent;
```

Запрещено: ручная сборка metadata/messageId в producer-ах, `Date.now()`/`crypto.randomUUID()`
возле создания событий, `as any`-касты к event-типам.

## Что metadata НЕ содержит

`source`, `channel`, `marketId`, `strategyId`, `exchange`, произвольный context —
semantic data живут в `payload` конкретного сообщения. Metadata — только универсальные
message-system concerns: identity, runtime identity, ordering, creation time, causal chain.

## Зависимости и слои

```text
@polymarket/ids        (MessageId, RunId)
@polymarket/time       (IClock)
@polymarket/timestamp  (Timestamp — канонический тип времени проекта, Foundation)
        ↑
@polymarket/messages
        ↑
        ├── @polymarket/message-bus        (generic delivery)
        ├── @polymarket/order-events       (Domain OrderEvent)
        ├── @polymarket/application-events (ApplicationEvent)
        └── будущий external-контур (M-004)
```

Весь граф — внутри Foundation: `messages → timestamp → time`. Foundation не
зависит от Domain (инвариант закреплён dependency-direction тестом).

`@polymarket/messages` НЕ зависит от `@polymarket/message-bus` — направление строго
`message-bus → messages`.
