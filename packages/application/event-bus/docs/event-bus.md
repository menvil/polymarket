# @polymarket/event-bus

> **Публичный behavioral contract** (гарантии, non-guarantees, migration constraint
> для M-001) зафиксирован в `../README.md`. Этот файл описывает внутреннее устройство
> текущей реализации и контрактом не является.

## Обзор

**Application-specific delivery façade canonical `ApplicationEvent`** — и только она.
С M-002.5 event contracts здесь не определяются и не реэкспортируются:

- **Application event contracts** — `@polymarket/application-events` (union
  `ApplicationEvent`) — единственный контур шины. Сырые сообщения источников
  идут по `ExternalMessageBus`; domain-сущности событий не публикуют;
- **Delivery mechanics** — `@polymarket/message-bus` (generic-движок);
- **Этот пакет** — Application-фасад доставки: `EventBus implements IEventBus`,
  Application error-контракт, logger-интеграция, диагностика.

Проекции (`@polymarket/trading-state`, `@polymarket/account-state`), handlers
и strategy зависят от `IEventBus` + `@polymarket/application-events`, а не
друг от друга.

```typescript
import { EventBus, type IEventBus } from '@polymarket/event-bus';

const bus: IEventBus = new EventBus(logger);

const unsub = bus.subscribe('BOOK_UPDATED', async (event) => {
  await strategy.onBookUpdated(event.payload.topOfBook);
});

const result = await bus.publish({
  type: 'TRADING_ACCOUNT_ORDER_COMMITTED',
  payload: { venueId, accountId, order, portfolio },
  metadata: metadataGenerator.nextRoot(),
});
if (!result.ok) logger.error('Publish failed', { error: result.error.message });
```

## `EventBus` — фасад над `MessageBus<ApplicationEvent>` (M-002)

С M-002 у `EventBus` НЕТ собственного механизма доставки: очередь, FIFO,
параллельный fan-out (включая нормализацию sync-throw в rejection), reentrancy,
critical/non-critical семантика, overflow- и drain-limit-защиты — целиком
ответственность generic-движка `@polymarket/message-bus`. Вопрос «как устроены
queue/fan-out/drain?» имеет один ответ во всём проекте — см.
`packages/foundation/message-bus/README.md` и его `docs/message-bus.md`.

```text
EventBus (фасад, composition — не наследование)
├── Application-specific публичный контракт (IEventBus)
├── трансляция ошибок движка → Application-ошибки
├── logger-адаптер через MessageBusObserver
└── общая operational-диагностика (getStats → canonical MessageBusStats)
      │
      ▼
MessageBus<ApplicationEvent>   ← вся механика доставки
```

`ApplicationEvent` подключается к движку как есть: каждый член union —
canonical `MessageEnvelope` `{ type, payload, metadata }` (M-003) и структурно
удовлетворяет `TypedMessage`. Событие передаётся движку по ссылке — без
клонирования/сериализации. Generic lifecycle движка (`drain()`/`close()`)
публичным API `EventBus` сознательно не становится; фасад никогда не вызывает
`_bus.close()`. Operational-диагностика, напротив, общая: `getStats()` — прямой
passthrough canonical `MessageBusStats`.

### Конструктор → policy движка

Публичный конструктор сохранён: `new EventBus(logger, maxEventsPerDrain?,
maxQueueSize?)`. Legacy-параметры адаптируются в
`createMessageBusPolicy({ queuePolicy: { maxQueueSize,
maxMessagesPerDrain: maxEventsPerDrain } })`; остальные группы policy —
default-значения M-001, в точности воспроизводящие семантику M-000
(`reject-new`, `parallel`, `continue`/`stop-drain-preserve-queue`/`clear-queue`).

### Error translation boundary

`publish()`/`publishAll()` возвращают прежний
`Promise<Result<void, QueueOverflowError | CriticalHandlerError>>` — ошибки
движка наружу не протекают. Единственная точка перевода —
`EventBus._translateResult()`, exhaustive по union `MessageBusPublishError`
(замыкается `never`-веткой; классификация только по `instanceof`, без
string-matching):

| Ошибка движка | Публичный Result |
|---|---|
| `MessageBusOverflowError` | `Err(QueueOverflowError)` — legacy message/context: `eventType` для одиночного publish, `eventCount` для batch |
| `MessageBusDrainLimitError` | `Err(QueueOverflowError)` — M-000 сознательно использует один публичный класс для обеих причин переполнения |
| `MessageBusCriticalHandlerError` | `Err(CriticalHandlerError)` c `context.eventType` и `context.originalError` |
| `MessageBusClosedError` | invariant violation → throw (недостижимо: у `IEventBus` нет `close()`) |

Тексты сообщений воспроизводят M-000 дословно (`EventBus queue overflow (N):
cannot enqueue ...`, `EventBus drain limit exceeded (N): ...`, `EventBus
critical handler threw during dispatch of ...`). Происхождение ошибок
гарантирует движок: **critical**-подписчик, бросивший Application
`QueueOverflowError`, приходит в фасад уже внутри
`MessageBusCriticalHandlerError.originalError` и не может быть перепутан с
операционным overflow. Ошибки non-critical подписчиков в Result не попадают
вовсе — для них сохраняется log-only поведение (см. logger-адаптер ниже).

### Logger-адаптер (MessageBusObserver)

Движок не зависит от logger — фасад передаёт ему observer, воспроизводящий
ровно исторические log-вызовы M-000:

- non-critical падение → `logger.error('EventBus handler threw an error',
  { err, eventType })`;
- дополнительные critical-ошибки после первой →
  `logger.error('EventBus critical handler threw an additional error',
  { err, eventType })`;
- primary critical НЕ логируется — возвращается caller'у как `Err`;
- overflow/drain-limit фасад не логирует (старый EventBus тоже не логировал).

Поведенческая семантика critical/non-critical (siblings завершаются, очередь
после critical-сбоя сохраняется, drain-limit очищает очередь петли, bus
остаётся работоспособным) — без изменений; теперь её обеспечивает движок, а
фиксирует всё тот же M-000 contract-suite.

### `publishAll([])` — legacy «kick»

До M-002 пустой `publishAll([])` на idle-bus запускал drain и мог возобновить
обработку очереди, сохранённой после critical-сбоя; движок же делает ранний
`Ok` на пустом массиве. Поскольку `IEventBus` сознательно не предоставляет
`drain()`, пустой batch — единственный публичный способ поднять сохранённую
очередь без новых событий, поэтому фасад воспроизводит legacy сам: при
активном drain — `Ok` сразу (не присоединяясь — reentrant-вызов из handler-а
иначе ждал бы сам себя), при idle — `_bus.drain()` с трансляцией его Result.
Закреплено regression-тестами в `EventBus.message-bus-adapter.test.ts`.

## Диагностика

`EventBus.getStats(): MessageBusStats` — прямой passthrough canonical-снимка
generic-движка (queueSize, subscribedTypes, dispatching, closed, publishedTotal,
dispatchedTotal, handlerErrorsTotal, rejectedPublicationsTotal) для
мониторинга/debugging (например, периодический `setInterval`, алерт при растущем
`queueSize`). Семантика полей — ответственность `@polymarket/message-bus`;
тип реэкспортируется из корня пакета. Отдельный `EventBusStats` сознательно не
вводится: это общий diagnostics-контракт semantic-фасадов над `MessageBus<T>`.

## Ссылки

- ADR: `docs/architecture/boundary-contract.md`
- План миграции, Этапы 6 и 10d: `/Users/menvil/.claude/plans/synthetic-swimming-heron.md`
- `packages/foundation/errors/src/event-bus/` — `QueueOverflowError`, `CriticalHandlerError`
