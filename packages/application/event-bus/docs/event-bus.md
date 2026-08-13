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

## `EventBus` — queue-based dispatch

### Почему очередь, а не прямой вызов handlers

`publish()`/`publishAll()` кладут событие(я) в приватную `_queue` и запускают
`_drainQueue()`, если drain ещё не идёт (`_dispatching`). Если `publish()` вызван ИЗНУТРИ
handler'а (handler публикует новое событие в ответ на текущее) — событие просто
добавляется в очередь, а не обрабатывается рекурсивно. Это даёт детерминированный порядок:
`publishAll([A, B])`, где handler(A) публикует C, гарантированно даёт порядок `A → B → C`,
а не `A → C → B` или стек рекурсивных вызовов.

### Result-контракт

`publish()`/`publishAll()` возвращают `Promise<Result<void, QueueOverflowError |
CriticalHandlerError>>`:

- **`QueueOverflowError`** — либо `_queue.length` превысил `maxQueueSize` (защита от OOM
  при медленном drain и высокочастотных событиях), либо `_drainQueue()` обработал
  `maxEventsPerDrain` событий за один drain-цикл без опустошения очереди (защита от
  infinite event loop: `handler(A) → publish(B) → handler(B) → publish(A)`). В обоих
  случаях сконструирован сразу как `QueueOverflowError` — единый класс для обеих причин
  переполнения (см. `packages/foundation/errors/src/event-bus/QueueOverflowError.ts`).
- **`CriticalHandlerError`** — подписчик, зарегистрированный с `{ critical: true }`,
  выбросил исключение. Конструируется в `_dispatch()` (где известен тип события):
  в `context` сохраняются `originalError` (raw `unknown` — handler может бросить что
  угодно, не обязательно `Error`) и `eventType`. Даже если подписчик бросил
  `QueueOverflowError`, наружу уходит `CriticalHandlerError` — ошибка чужого кода не
  маскируется под операционное состояние bus-а.

Внутри (`_drainQueue()`/`_dispatch()`, оба `private`) реализация остаётся throw-based —
`_drainQueue()`'s `while`/`break`/`finally`-цикл сложнее выразить через `Result`-threading
без риска для поведения, а метод не пересекает публичную границу. Граница `Result`
строится ровно в `publish()`/`publishAll()` (через `_drainAndConvert()`): `try/catch`
вокруг `_drainQueue()`, обе typed-ошибки (`QueueOverflowError` из `_drainQueue()`,
`CriticalHandlerError` из `_dispatch()`) пропускаются как есть, любое другое брошенное
значение защитно оборачивается в `CriticalHandlerError` (при текущих внутренностях
недостижимо — страховка на случай замены движка).

### Critical vs non-critical handlers

`subscribe(type, handler, { critical: true })`:

- **non-critical** (по умолчанию) — ошибка handler'а логируется, drain продолжается для
  остальных handlers этого же события и для остальных событий в очереди.
- **critical** — ошибка останавливает `_drainQueue()`, возвращается как
  `Err(CriticalHandlerError)`.
  Очередь **не очищается** — оставшиеся события легитимны, следующий `publish()`
  возобновит drain с того места, где он остановился. Bus остаётся работоспособным;
  caller решает, перезапустить обработку, остановить систему или алертить.

  Переполнение drain-лимита (`QueueOverflowError`), в отличие от critical-ошибки, **очищает**
  очередь — оставшиеся события считаются артефактом бага (infinite loop), а не легитимными
  данными, и повторная обработка только усугубит проблему.

Все handlers одного события выполняются параллельно (`Promise.allSettled`) — нет гарантий
порядка, если два handler'а одного события публикуют дочерние события. Handlers не должны
зависеть от side-effects друг друга. Синхронный throw sync-handler-а нормализуется в
rejection (async-обёртка в `_dispatch()`) — иначе он оборвал бы запуск остальных handlers
и обошёл non-critical семантику. Таймауты — не ответственность `EventBus`: каждый
handler обязан сам завершаться или обрабатывать собственный timeout.

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
