# @polymarket/event-bus — Behavioral Contract (M-000)

Этот документ — **точный публичный контракт** Application EventBus, зафиксированный
фазой M-000 перед будущей заменой внутреннего delivery-движка (M-001). Каждая гарантия
ниже покрыта тестами (`__tests__/EventBus.test.ts`, `__tests__/EventBus.contract.test.ts`,
`__tests__/EventBus.types.test.ts`). Любая следующая реализация считается совместимой
только если проходит этот contract suite без изменений.

Внутреннее устройство (`docs/event-bus.md`) контрактом **не является**.

## Implementation note (M-002)

С M-002 `EventBus` — тонкий Application-фасад над generic-движком
`MessageBus<ApplicationEvent>` (`@polymarket/message-bus`, композиция):

```text
EventBus  =  Application-specific facade  +  MessageBus<ApplicationEvent> engine
```

Разделение ответственности:

- `@polymarket/message-bus` — очередь, FIFO, параллельный fan-out, reentrancy,
  critical-семантика, drain-guards;
- `@polymarket/event-bus` — типизация `ApplicationEvent`, Application
  error-контракт (`QueueOverflowError`/`CriticalHandlerError`), интеграция
  logger, legacy diagnostics API (`getStats()`).

Смена движка не меняет контракт этого README: M-000 contract-suite остаётся
compatibility gate и проходит без изменений. Ошибки движка (`MessageBus*Error`)
наружу не протекают и из пакета не экспортируются; generic lifecycle
(`drain()`/`close()`) и расширенные stats движка публичным API не являются.
Детали трансляции — `docs/event-bus.md`.

## Purpose

In-process распределение `ApplicationEvent` внутри application-слоя: handlers,
orchestrators, use-cases и strategy общаются через bus, а не напрямую друг с другом.

## Public API

```typescript
interface IEventBus {
  publish(event: ApplicationEvent): Promise<Result<void, QueueOverflowError | CriticalHandlerError>>;
  publishAll(events: readonly ApplicationEvent[]): Promise<Result<void, QueueOverflowError | CriticalHandlerError>>;
  subscribe<K extends ApplicationEvent['type']>(
    type: K,
    handler: EventHandler<Extract<ApplicationEvent, { type: K }>>,
    options?: { critical?: boolean },
  ): () => void; // unsubscribe
}
```

- `publish()`/`publishAll()` **не бросают** ожидаемые operational-ошибки — queue
  overflow, drain-limit и critical handler failure возвращаются как typed `Err`.
  Успех — `Ok(undefined)`.
- `EventHandler<T> = (event: T) => void | Promise<void>` — разрешены и sync-,
  и async-handlers; для обоих действует одна и та же семантика ошибок.
- `EventBus.getStats()` — диагностика конкретного класса `EventBus` (см. Diagnostics);
  **не входит** в порт `IEventBus`.
- События — flat discriminated union (`{ type, ...поля }`). Формат события в M-000
  не меняется; переход на `{ type, payload }` — отдельная будущая фаза (M-003).

## Event routing

Подписка `subscribe(type, handler)` получает **только** события ровно этого `type`.
Narrowing сохраняется на уровне типов: handler `'BOOK_UPDATED'` получает
`BookUpdatedEvent`, а не общий `ApplicationEvent` (compile-time покрытие —
`EventBus.types.test.ts`).

## Ordering guarantees

- **FIFO между событиями очереди**: `publishAll([A, B, C])` доставляет в порядке
  `A → B → C`.
- **Fan-out одного события завершается до следующего события**: событие `B` не
  диспетчеризуется, пока не завершились (settle) все handlers события `A`.
- **Reentrant-публикации добавляются в хвост очереди**:
  `publishAll([A, B])` + `handler(A) → publish(C)` даёт порядок `A → B → C`
  (не `A → C → B`). Аналогично `handler(A) → publishAll([C, D])` даёт `A → B → C → D`.
- Очередь, оставшаяся после critical failure, обрабатывается **раньше** событий,
  опубликованных позже (см. Critical failures).

## Fan-out

- Все зарегистрированные handlers типа события вызываются для каждого события.
- Handlers **одного** события запускаются **параллельно**; bus дожидается завершения
  всех (settle) перед переходом к следующему событию.
- Порядок side-effect-ов handlers одного события не гарантируется — см.
  Explicit non-guarantees.

## Non-critical failures

Default (`options` отсутствуют или `{ critical: false }`):

- ошибка одного handler-а (sync throw или rejected promise) **не** останавливает
  остальных handlers этого события — они всё равно выполняются;
- ошибка логируется (`logger.error('EventBus handler threw an error', { err, eventType })`);
- drain продолжается со следующего события очереди;
- `publish()`/`publishAll()` возвращают `Ok`, если нет других terminal-ошибок.

## Critical failures

`subscribe(type, handler, { critical: true })`:

- **Все handlers текущего события завершаются**: critical-ошибка не отменяет уже
  запущенный параллельный fan-out; исход определяется после settle всех handlers.
- Caller получает `Err(CriticalHandlerError)`; в `error.context` сохраняются
  `originalError` (сырое брошенное значение подписчика) и `eventType`.
- **Первая critical-ошибка каноническая** (в детерминированном порядке
  подписки/входа); последующие critical-ошибки не теряются — логируются
  (`'EventBus critical handler threw an additional error'`).
- Ошибка чужого кода не маскируется под операционную: даже если подписчик бросил
  `QueueOverflowError`, caller получает `Err(CriticalHandlerError)` с оригиналом
  в `context.originalError`.
- **Событие с failure считается завершённым**: обратно в очередь не возвращается,
  повторно не диспетчеризуется.
- **Оставшаяся очередь сохраняется**: события легитимны; следующий
  `publish()`/`publishAll()` возобновляет drain со старой очереди (старые события
  раньше нового). Пустой `publishAll([])` тоже возобновляет обработку сохранённой
  очереди — это единственный публичный способ «пнуть» drain, не публикуя новых
  событий. Bus остаётся работоспособным; реакция (перезапуск, остановка
  системы, alerting) — решение caller-а.

## Overflow

`maxQueueSize` (конструктор, по умолчанию 100 000) ограничивает размер **ожидающей**
очереди; уже dequeued (in-flight) событие в лимит не входит.

- `publish()` при переполнении возвращает `Err(QueueOverflowError)`; отклонённое
  событие **не** попадает в очередь; уже стоящие в очереди события **не** удаляются.
- `publishAll()` атомарен относительно enqueue: batch, не влезающий в лимит целиком,
  отклоняется **целиком** (all or nothing) — частичного enqueue не бывает.

## Drain-loop protection

`maxEventsPerDrain` (конструктор, по умолчанию 10 000) ограничивает число событий,
обработанных за один drain-цикл — защита от infinite event loop
(`handler(A) → publish(B) → handler(B) → publish(A)`).

- При превышении caller получает `Err(QueueOverflowError)` (message содержит
  `drain limit exceeded`).
- Оставшаяся очередь **очищается**: это не легитимный backlog, а события, созданные
  зациклившейся публикацией.
- Bus остаётся работоспособным: после устранения петли следующий `publish()`
  обрабатывается нормально.

## Reentrancy

`publish()`/`publishAll()`, вызванные **изнутри** handler-а (во время активного drain):

- не запускают второй drain и не обрабатывают событие рекурсивно;
- добавляют событие(я) в хвост существующей очереди;
- **`Ok` reentrant-вызова подтверждает успешный enqueue, а НЕ завершение обработки
  опубликованного события** — ждать обработки нельзя (self-deadlock); событие будет
  обработано текущим внешним drain позже;
- `Err` reentrant-вызова возможен только по правилам Overflow (переполнение очереди).

Terminal-ошибки drain (critical failure, drain-limit) получает **внешний** caller,
чей вызов запустил drain.

## Subscription lifecycle

- `subscribe()` возвращает функцию отписки; отписка **идемпотентна** (повторный
  вызов не бросает).
- После отписки handler не получает последующие события.
- **Unsubscribe во время fan-out**: snapshot подписчиков текущего события уже
  сформирован — отписанный handler доигрывает текущее событие, но не получает
  следующие.
- **Subscribe во время dispatch**: новый handler не получает событие, dispatch
  которого уже начался; получает следующие события (в том числе следующее событие
  того же drain).
- Отписка последнего handler-а типа наблюдаемо уменьшает
  `getStats().subscribedTypes` (нет утечки подписок).

## Diagnostics

`EventBus.getStats(): { queueSize, subscribedTypes, dispatching }` — снимок состояния:

- `queueSize` — количество **ожидающих** событий; текущее in-flight событие не входит;
- `subscribedTypes` — количество типов событий, имеющих ≥1 активного подписчика;
  уменьшается при отписке последнего handler-а типа;
- `dispatching` — идёт ли drain прямо сейчас.

Idle-состояние: `{ queueSize: 0, dispatching: false }`.
`getStats()` — метод класса `EventBus` (диагностика), не часть порта `IEventBus`:
добавление его в порт сломало бы существующие моки без диагностической надобности.

## Explicit non-guarantees

Осознанно **НЕ** является контрактом (и не должно им стать молча в M-001):

- **Порядок между handlers одного события.** Handlers выполняются параллельно;
  ordering between handlers of the same event is not guaranteed as an
  application-level ordering contract. Бизнес-код не должен зависеть от
  side-effect-ов другого handler-а того же события — даже если текущая итерация
  регистрации даёт insertion order.
- **Относительный порядок дочерних событий от параллельных handlers.** Если
  `handler A → publish(X)` и `handler B → publish(Y)` для одного события, порядок
  `X`/`Y` в очереди недетерминирован и не гарантируется.
- **Timeout / cancel / retry handlers.** Handler обязан завершаться сам; зависший
  handler останавливает drain. Это не ответственность EventBus.
- **Persistence / durability / replay / history.** Bus строго in-process и
  non-persistent: не хранит историю, не replay-ит события новым подписчикам,
  не retry-ит handlers, не переживает crash процесса, не доставляет между
  процессами. Это не Kafka/RabbitMQ.
- **Внутренние структуры.** Map/Set-хранилище подписок, Array-очередь,
  `Promise.allSettled` — детали реализации, не контракт; contract suite к ним
  не привязан.

## Migration constraint

> Future M-001 generic MessageBus implementation must preserve this observable
> Application EventBus contract unless a separate architecture decision explicitly
> changes it.

M-001 обязан подставить новый движок внутрь `EventBus` и пройти
`EventBus.test.ts` + `EventBus.contract.test.ts` + `EventBus.types.test.ts` без
правок этих тестов. Провал suite означает, что новая реализация изменила
поведение и drop-in replacement-ом не является.
