# @polymarket/event-bus

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
  выбросил исключение. Оборачивает исходное брошенное значение в `context.originalError`
  (raw `unknown` — handler может бросить что угодно, не обязательно `Error`).

Внутри (`_drainQueue()`/`_dispatch()`, оба `private`) реализация остаётся throw-based —
`_drainQueue()`'s `while`/`break`/`finally`-цикл сложнее выразить через `Result`-threading
без риска для поведения, а метод не пересекает публичную границу. Граница `Result`
строится ровно в `publish()`/`publishAll()` (через `_drainAndConvert()`): `try/catch`
вокруг `_drainQueue()`, `QueueOverflowError` пробрасывается как есть (её уже сконструировал
`_drainQueue()`), всё остальное оборачивается в `CriticalHandlerError`.

### Critical vs non-critical handlers

`subscribe(type, handler, { critical: true })`:

- **non-critical** (по умолчанию) — ошибка handler'а логируется, drain продолжается для
  остальных handlers этого же события и для остальных событий в очереди.
- **critical** — ошибка останавливает `_drainQueue()`, возвращается как
  `Err(CriticalHandlerError)` (или бросается из `publishOrThrow()`/`publishAllOrThrow()`).
  Очередь **не очищается** — оставшиеся события легитимны, следующий `publish()`
  возобновит drain с того места, где он остановился. Bus остаётся работоспособным;
  caller решает, перезапустить обработку, остановить систему или алертить.

  Переполнение drain-лимита (`QueueOverflowError`), в отличие от critical-ошибки, **очищает**
  очередь — оставшиеся события считаются артефактом бага (infinite loop), а не легитимными
  данными, и повторная обработка только усугубит проблему.

Все handlers одного события выполняются параллельно (`Promise.allSettled`) — нет гарантий
порядка, если два handler'а одного события публикуют дочерние события. Handlers не должны
зависеть от side-effects друг друга. Таймауты — не ответственность `EventBus`: каждый
handler обязан сам завершаться или обрабатывать собственный timeout.

## `publishOrThrow()`/`publishAllOrThrow()` — deprecation-мост (Этап 6 плана миграции)

До Этапа 6 `publish()`/`publishAll()` бросали `Error` напрямую. Реальные вызывающие на
момент миграции — 19 сайтов в 8 файлах: 8 внутри `@polymarket/handlers` (полностью
переведены на `Result`-обработку в Этапе 6) и 11 вне пакета —
`apps/bot/src/main.ts` (2), `apps/bot/src/bot/buildUseCases.ts` (1, через
`IOrderedEventOutbox`), `apps/bot/src/bot/MarketRotation.ts` (1),
`packages/infrastructure/backtesting/src/BacktestEngine.ts` (1),
`packages/infrastructure/polymarket/rest/adapters/PolymarketExecutionAdapter.ts` (6,
fire-and-forget). Прямая правка сигнатуры `publish()`/`publishAll()` сломала бы сборку во
всех 11 внешних сайтах, лежащих вне территории Этапа 6 (`apps/*`/`infrastructure/*` —
Этап 10 плана миграции).

Решение: `publishOrThrow()`/`publishAllOrThrow()` — throw-based обёртки над новыми
`Result`-based `publish()`/`publishAll()` (`if (!result.ok) throw result.error;`). Бросают
**тот же объект ошибки**, что `publish()` вернул бы в `Err` — поведение для существующих
вызывающих не меняется, это чистое переименование (`.publish(` → `.publishOrThrow(`) без
изменения семантики. Снимаются в Этапе 10 плана миграции, когда оставшиеся 11 сайтов
переходят на `Result`-обработку вместе с остальным `apps/*`/`infrastructure/*`.

**Не использовать в новом коде** — только для уже существующих вызывающих вне
`@polymarket/handlers`, ожидающих снятия моста.

## Диагностика

`EventBus.getStats(): { queueSize, subscribedTypes, dispatching }` — снимок текущего
состояния для мониторинга/debugging (например, периодический `setInterval`, алерт при
растущем `queueSize`).

## Ссылки

- ADR: `docs/architecture/boundary-contract.md`
- План миграции, Этап 6: `/Users/menvil/.claude/plans/synthetic-swimming-heron.md`
- `packages/foundation/errors/src/event-bus/` — `QueueOverflowError`, `CriticalHandlerError`
