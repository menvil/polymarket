# @polymarket/event-bus

> **Публичный behavioral contract** (гарантии, non-guarantees, migration constraint
> для M-001) зафиксирован в `../README.md`. Этот файл описывает внутреннее устройство
> текущей реализации и контрактом не является.

## Обзор

Единственный источник всех типов событий в системе (`ApplicationEvent` — полный union)
и реализация application-level event bus (`EventBus implements IEventBus`). Handlers
(`@polymarket/handlers`), orchestrators (`@polymarket/orchestrators`) и strategy зависят
от `IEventBus`/`ApplicationEvent`, а не друг от друга.

```typescript
import { EventBus, type IEventBus, type ApplicationEvent } from '@polymarket/event-bus';

const bus: IEventBus = new EventBus(logger);

const unsub = bus.subscribe('BOOK_UPDATED', async (event) => {
  await strategy.onBookUpdated(event.topOfBook);
});

const result = await bus.publish({ type: 'FILL_RECEIVED', fill, receivedAt });
if (!result.ok) logger.error('Publish failed', { error: result.error.message });
```

## Типы событий (`src/events/`)

`ApplicationEvent` — union всех событий, собранный в `events/index.ts`:

| Источник | События |
|---|---|
| `domain-events.ts` | `FillReceivedEvent`, `FillConfirmedEvent`, `FillFailedEvent`, `DirectFillAppliedEvent` |
| `market-events.ts` | `BookUpdatedEvent`, `BookDepthEvent`, `TradeReceivedEvent` (+ `TopOfBook`) |
| `strategy-events.ts` | `StrategySignalEvent` (+ `SignalDirection`) |
| `market-lifecycle-events.ts` | `MarketOpenedEvent`, `MarketClosedEvent` (+ `MarketCloseReason`) |
| `order-update-events.ts` | `OrderUpdateReceivedEvent` (+ `VenueOrderUpdate`) |
| `@polymarket/order` (реэкспорт) | `OrderEvent` — Order FSM transitions |

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
└── legacy-проекция диагностики (getStats)
      │
      ▼
MessageBus<ApplicationEvent>   ← вся механика доставки
```

`ApplicationEvent` подключается к движку как есть: flat union структурно
удовлетворяет `TypedMessage` (есть поле `type`), `MessageEnvelope` в M-002 не
используется (это M-003). Событие передаётся движку по ссылке — без
клонирования/сериализации. Generic lifecycle движка (`drain()`/`close()`) и его
расширенные stats публичным API `EventBus` сознательно не становятся; фасад
никогда не вызывает `_bus.close()`.

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
гарантирует движок: подписчик, бросивший Application `QueueOverflowError`,
приходит в фасад уже внутри `MessageBusCriticalHandlerError.originalError` и
не может быть перепутан с операционным overflow.

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

## `publishOrThrow()`/`publishAllOrThrow()` — deprecation-мост, снят в Этапе 10d

До Этапа 6 `publish()`/`publishAll()` бросали `Error` напрямую. Реальные вызывающие на
момент Этапа 6 — 19 сайтов в 8 файлах: 8 внутри `@polymarket/handlers` (сразу переведены
на `Result`-обработку в Этапе 6) и 11 вне пакета — `apps/bot/src/main.ts` (2),
`apps/bot/src/bot/buildUseCases.ts` (1, через `IOrderedEventOutbox`),
`apps/bot/src/bot/MarketRotation.ts` (1),
`packages/infrastructure/backtesting/src/BacktestEngine.ts` (1),
`packages/infrastructure/polymarket/rest/adapters/PolymarketExecutionAdapter.ts` (6,
fire-and-forget). Прямая правка сигнатуры `publish()`/`publishAll()` в Этапе 6 сломала бы
сборку во всех 11 внешних сайтах, лежавших вне территории того этапа.

Временное решение (Этап 6 — Этап 10c): `publishOrThrow()`/`publishAllOrThrow()` —
throw-based обёртки над `Result`-based `publish()`/`publishAll()` (`if (!result.ok) throw
result.error;`), бросавшие **тот же объект ошибки**, что `publish()` вернул бы в `Err`.

**Этап 10d снял мост целиком** — оба метода удалены из `IEventBus`/`EventBus`. Все 11
внешних сайтов переведены на `Result`-обработку тремя паттернами в зависимости от формы
вызова: (1) awaited-сайты (`main.ts`, `MarketRotation.ts`, `BacktestEngine.ts`) —
`if (!result.ok) { ...log...; }`; (2) fire-and-forget-сайты
(`PolymarketExecutionAdapter.ts`, 6 штук) — `void eventBus.publish(...).then((result) =>
{ if (!result.ok) ...log...; })`, что дополнительно потребовало починить
`infrastructure/polymarket`'s собственный узкий локальный `IEventBus`-порт (тот держал
`publish(): void` вместо `Promise<Result<...>>` — только структурно совместим с реальным
`EventBus` благодаря нестрогой TS-проверке void-возврата); (3) `buildUseCases.ts`'s
`InMemoryOrderedEventOutbox`-обёртка (+ 4 тестовых зеркала) — throw-конверсия инлайнится
локально в `publish`-callback, поскольку `IOrderedEventOutboxDeps.publish` контрактно
throw-based по архитектурному замыслу (декаплинг `@polymarket/in-memory` от
`@polymarket/event-bus`'s `Result`-типа), не может перейти на `Result`-ветвление.

## Диагностика

`EventBus.getStats(): { queueSize, subscribedTypes, dispatching }` — снимок текущего
состояния для мониторинга/debugging (например, периодический `setInterval`, алерт при
растущем `queueSize`).

## Ссылки

- ADR: `docs/architecture/boundary-contract.md`
- План миграции, Этапы 6 и 10d: `/Users/menvil/.claude/plans/synthetic-swimming-heron.md`
- `packages/foundation/errors/src/event-bus/` — `QueueOverflowError`, `CriticalHandlerError`
