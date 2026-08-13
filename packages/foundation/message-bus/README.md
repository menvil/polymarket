# @polymarket/message-bus

Generic in-process typed message delivery primitive: FIFO-очередь, typed-подписки,
параллельный fan-out, Result-based operational-ошибки, policies, lifecycle и
диагностика. Этот README — поведенческий контракт пакета; каждая гарантия покрыта
тестами в `__tests__/`.

## Purpose

Единый низкоуровневый движок доставки сообщений для независимых bus-контуров
(будущие consumers — см. последний раздел). Пакет решает ровно одну задачу:
принять типизированное сообщение, поставить его в bounded FIFO-очередь и доставить
подписчикам его `type` с зафиксированной семантикой порядка, ошибок и lifecycle.

## What it knows

Только:

- `message.type` — строковый routing key;
- очередь (bounded FIFO + drain-limit);
- подписки (typed, critical/non-critical);
- delivery policies;
- lifecycle (`drain`/`close`) и диагностику (stats/observer).

## What it does NOT know

`ApplicationEvent`, `ExternalMessage`, Polymarket, CEX, Domain-события, Recorder,
Logger — ничего из этого пакет не импортирует и не упоминает. Единственная runtime
зависимость — `@polymarket/result`. Пакет не имеет ни одной причины меняться при
изменении торговой логики, API бирж или прикладных event-контрактов.

## Message model

Generic-граница — минимальный `TypedMessage`:

```typescript
interface TypedMessage {
  readonly type: string;
}
```

Bus не читает, не модифицирует, не клонирует и не интерпретирует никакие другие
поля. Поэтому одинаково валидны **обе** формы сообщений:

```typescript
// Flat discriminated union:
type FlatMessage =
  | { readonly type: 'PRICE'; readonly price: number }
  | { readonly type: 'TRADE'; readonly tradeId: string };

// Стандартизированный конверт (опциональный, для будущих контуров):
type PriceMessage = MessageEnvelope<'PRICE', { price: number }, { source: string }>;
```

`MessageEnvelope<TType, TPayload, TMetadata = unknown>` (`{ type, payload, metadata? }`)
определён в пакете как reusable-тип, но **не требуется** движком: требование
`payload` на generic-границе заблокировало бы контуры с flat-сообщениями.
`payload`/`metadata` полностью прозрачны для bus.

## Public API

```typescript
interface IMessageBus<TMessage extends TypedMessage> {
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

Подписка сохраняет compile-time narrowing: handler `'PRICE'` получает именно
PRICE-член union, а не общий `TMessage` (покрыто `MessageBus.types.test.ts`).
`MessageHandler` допускает sync- и async-обработчики; синхронный throw
нормализуется в rejection и обрабатывается идентично async-ошибке.

## Delivery semantics

- **FIFO между сообщениями**: `publishAll([A, B, C])` доставляет `A → B → C`;
  следующее сообщение не диспетчеризуется, пока не завершился fan-out текущего.
- **Параллельный fan-out**: обработчики одного сообщения запускаются параллельно;
  bus дожидается settle всех. (Механизм ожидания — деталь реализации, контракт —
  наблюдаемый параллелизм и ожидание всех.)
- **Reentrancy**: публикации изнутри обработчика попадают в хвост очереди, nested
  drain не запускается: `publishAll([A,B])` + `handler(A) → publish(C)` даёт
  `A → B → C`; `handler(A) → publishAll([C,D])` даёт `A → B → C → D`.
- **Один активный drain**: у bus единственный drain owner. Конкурентный
  `publish()` при активном drain возвращает `Ok` сразу после enqueue — сообщение
  доставит существующий drain.
- **Active-drain publish = enqueue acknowledgement**: `Ok` из `publish()`/
  `publishAll()` при активном drain подтверждает **успешную постановку в
  очередь**, а НЕ завершение обработки сообщения. Ждать обработки из обработчика
  нельзя — это self-deadlock.

## Critical / non-critical handlers

Default — `critical: false`:

- падение обработчика (sync throw / async rejection) не останавливает siblings —
  они выполняются;
- fan-out завершается, drain продолжается со следующего сообщения;
- ошибка сообщается observer'у (`critical: false`) и увеличивает
  `handlerErrorsTotal`;
- результат публикации остаётся `Ok`, если нет terminal-ошибки.

`{ critical: true }`:

1. все обработчики текущего сообщения settle-ятся (fan-out не отменяется);
2. первая critical-ошибка в детерминированном порядке subscription snapshot
   становится канонической: `Err(MessageBusCriticalHandlerError)` с `messageType`
   и `originalError`;
3. дополнительные critical-ошибки не теряются — уходят observer'у с
   `primaryCritical: false`;
4. упавшее сообщение считается обработанным — не replay-ится;
5. drain останавливается, **оставшаяся очередь сохраняется** и обрабатывается
   раньше более поздних публикаций;
6. bus остаётся работоспособным — реакция на ошибку принадлежит caller'у.

Ошибка, брошенная обработчиком, никогда не классифицируется по `instanceof`
внутренних ошибок bus: даже если обработчик бросил `MessageBusOverflowError`,
caller получит `MessageBusCriticalHandlerError` с оригиналом в `originalError`.

## Policies

Политика — plain immutable configuration (никаких Strategy-иерархий):

```typescript
interface MessageBusPolicy {
  queuePolicy:    { maxQueueSize: number; maxMessagesPerDrain: number };
  overflowPolicy: { strategy: 'reject-new' };
  handlerPolicy:  { fanOut: 'parallel' };
  errorPolicy:    {
    nonCriticalHandler: 'continue';
    criticalHandler: 'stop-drain-preserve-queue';
    drainLimit: 'clear-queue';
  };
}
```

Literal-union'ы стратегий сейчас содержат по одному поддерживаемому значению —
ровно те семантики, что реализует движок; расширение добавит literals без смены
API. Default: `maxQueueSize = 100_000`, `maxMessagesPerDrain = 10_000`
(`DEFAULT_MESSAGE_BUS_POLICY`); собрать свою — `createMessageBusPolicy()`.

**Валидация**: лимиты обязаны быть положительными safe integers. Невалидная
политика — configuration error: конструктор **синхронно бросает** `RangeError`.
Ожидаемые runtime-проблемы доставки, напротив, всегда `Result.Err` — эта граница
принципиальна.

## Queue

Bounded FIFO: `maxQueueSize` ограничивает **ожидающие** сообщения; текущее
in-flight сообщение (уже извлечённое в fan-out) в лимит и в `queueSize` не входит.

- Overflow (`reject-new`): новая публикация → `Err(MessageBusOverflowError)`;
  отклонённые сообщения не enqueue-ятся; существующая очередь не изменяется.
- `publishAll` атомарен: batch, не влезающий целиком, отклоняется целиком
  (all or nothing). `publishAll([])` → `Ok`.
- Drain-limit (`clear-queue`): при обработке `maxMessagesPerDrain` сообщений за
  один drain при непустой очереди — `Err(MessageBusDrainLimitError)`, оставшаяся
  очередь **очищается** (артефакт бесконечной петли публикаций, не backlog),
  bus остаётся работоспособным.

Внутренняя очередь — backing array + head-индекс c периодическим compaction:
amortized O(1) enqueue/dequeue, без `Array.shift()` на hot path (см.
`docs/message-bus.md`).

## Lifecycle

**`drain()`** — дообработать ожидающую очередь:

- idle + пустая очередь → `Ok`;
- очередь есть, drain не идёт → запускает drain и возвращает его Result;
- drain уже идёт → дожидается **существующего** (второй не запускается);
- терминальные исходы (`critical`/`drain-limit`) возвращаются как `Err`;
- после critical-сбоя `drain()` можно повторять — очередь сохранена.

**`close()`** — закрыть bus для новых публикаций:

1. атомарно помечает bus closed;
2. новые `publish`/`publishAll` → `Err(MessageBusClosedError)`;
3. дожидается/выполняет drain существующей очереди;
4. возвращает drain Result.

`close()` идемпотентен. Если close-drain завершился critical-ошибкой: bus остаётся
closed, оставшаяся очередь сохраняется, подписки можно менять (убрать failing
handler) и повторить `drain()`.

**Запрещено**: `await bus.drain()` / `await bus.close()` из обработчика этого же
bus. Обработчик — часть активного drain; такой вызов ждёт сам себя
(self-deadlock). Bus это misuse не детектирует.

## Diagnostics

**`getStats()`** — дешёвый снимок, не hot-path-логирование:

- `queueSize` — ожидающие сообщения (без in-flight);
- `subscribedTypes` — типы с ≥1 активным подписчиком;
- `dispatching`, `closed` — флаги состояния;
- `publishedTotal` — успешно enqueue-нутые сообщения (batch считается целиком
  только при приёме; отклонённый batch не считается);
- `dispatchedTotal` — сообщения с завершённым fan-out (включая сообщения без
  подписчиков и сообщения с critical-исходом);
- `handlerErrorsTotal` — все падения обработчиков (critical и non-critical);
- `rejectedPublicationsTotal` — отклонённые **операции** публикации (rejected
  `publishAll([100 шт.])` = +1, не +100).

**`MessageBusObserver`** — опциональный best-effort hook
(`onHandlerError`/`onQueueOverflow`/`onDrainLimitExceeded`) для интеграции
logger/metrics на стороне потребителя. Observer только наблюдает: не влияет на
control flow и Result; его собственное исключение перехватывается и не ломает
доставку. `HandlerErrorContext` различает non-critical (`critical: false`),
каноническую critical (`primaryCritical: true`) и дополнительные critical-ошибки
(`primaryCritical: false`).

## Result / error model

Ожидаемые runtime-исходы — всегда `Result` (никогда throw):

| Ошибка | Когда | Typed context |
|---|---|---|
| `MessageBusOverflowError` | очередь не вмещает публикацию | `maxQueueSize`, `attemptedCount`, `messageType?` |
| `MessageBusCriticalHandlerError` | упал critical-обработчик | `messageType`, `originalError` |
| `MessageBusDrainLimitError` | защита от петли публикаций | `maxMessagesPerDrain` |
| `MessageBusClosedError` | публикация после `close()` | — |

Все ошибки несут literal-поле `code` (discriminated union) — вид ошибки
определяется `instanceof`/`code`, не парсингом message-строки. Каждая ошибка
конструируется в точке возникновения (capacity-check / fan-out / drain-guard) —
происхождение известно сразу.

Синхронный throw из публичного API возможен только в конструкторе при невалидной
политике (configuration error). Неожиданное внутреннее исключение — это нарушение
инварианта (баг движка): оно пропагирует как rejected promise и сознательно не
маскируется под operational-`Result`.

## Explicit non-guarantees

Осознанно НЕ гарантируется:

- порядок между обработчиками одного сообщения (fan-out параллелен; бизнес-код не
  должен зависеть от side-effect'ов sibling-обработчика);
- относительный порядок child-сообщений, опубликованных разными параллельными
  обработчиками одного сообщения;
- timeout обработчиков (зависший обработчик блокирует drain);
- отмена (cancellation) обработчиков;
- retry обработчиков;
- persistence: bus in-process, ephemeral, non-durable — это НЕ Kafka/RabbitMQ/
  database queue/event store;
- история/replay: новые подписчики не получают прошлые сообщения;
- доставка между процессами;
- сохранность очереди при crash процесса;
- exactly-once вне рамок одного in-process вызова.

Отдельно: MessageBus — не event-sourcing bus. Он ничего не знает о Domain-событиях
и не является хранилищем `OrderEvent`; domain replay/event sourcing — отдельная
концепция, не связанная с этим пакетом.

## Future consumers (архитектурная иллюстрация)

```text
                 FOUNDATION
             MessageBus<TMessage>
                /            \
               ▼              ▼
    Application EventBus   ExternalMessageBus
        (future M-002)       (future M-004)
```

Иллюстрация направления — НЕ зависимость: пакет не импортирует ни один из этих
слоёв и не должен меняться при их эволюции. Контракт, который обязана сохранить
композиция Application EventBus поверх этого движка, зафиксирован отдельным
suite в `packages/application/event-bus` (M-000).
