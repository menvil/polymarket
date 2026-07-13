# @polymarket/use-cases — Торговые Use Cases

## Обзор

Пакет реализует application-layer use cases для оркестрации доменных объектов:

| Use Case | Ответственность |
|----------|-----------------|
| `PlaceOrderUseCase` | Размещение нового торгового ордера |
| `CancelOrderUseCase` | Отмена ордера с откатом резервации |
| `ProcessFillUseCase` | Обработка исполнения ордера (fill) |
| `ReconcileTradesUseCase` | REST-сверка исполнений (safety net при gaps в WS) |
| `UpdateOrderStatusUseCase` | Применение venue-обновления статуса к Order |
| `InitializePortfolioUseCase` | Инициализация Portfolio из venue-баланса при старте |

Плюс прикладные сервисы:

| Service | Ответственность |
|---------|-----------------|
| `PortfolioService` | Резервации, применение fill к Portfolio (CAS через `IPortfolioStore`) |
| `LedgerService` | Запись fill в Ledger (append-only учёт) |

## Зависимости

```
PlaceOrderUseCase
  ├── IOrderRiskChecker (pre-trade risk)
  ├── OrderService → IOrderRepository
  ├── PortfolioService → IPortfolioStore
  ├── IExchangeClient
  ├── IEventBus
  ├── IClock
  └── IReconciliationIssueRepository (optional, queryable issues)

ProcessFillUseCase
  ├── OrderService → IOrderRepository
  ├── PortfolioService → IPortfolioStore
  ├── LedgerService → Ledger
  ├── IProcessedFillRepository (idempotency guard)
  ├── IEventBus
  └── IReconciliationIssueRepository (optional, queryable issues)

CancelOrderUseCase
  ├── OrderService → IOrderRepository
  ├── PortfolioService → IPortfolioStore
  ├── IExchangeClient
  ├── IEventBus
  └── IReconciliationIssueRepository (optional, queryable issues)
```

## PlaceOrderUseCase

### Алгоритм (7 шагов)

1. **Риск-проверка** — `riskChecker.checkBeforeOrder()` (fail-fast)
2. **Резервирование ресурсов** — BUY: `portfolioService.reserveForOrder(notional)`,
   SELL: `reserveTokensForOrder(size)`
3. **Отправка на биржу** — `exchangeClient.submitOrder()` → типизированный
   `SubmitOrderResult`:
   - `Err(ExchangeError)` (транспорт) → откат резервации, `Err`
   - `Ok({status: 'REJECTED'})` → откат резервации, `Err`; локальный `Order` НЕ
     создаётся (venue вообще не создал live-ордер)
   - `Ok({status: 'UNKNOWN'})` → откат резервации, best-effort `cancelOrder`
     (если venue вернул `orderId`), `Err` с manual-reconciliation контекстом;
     use case НИКОГДА не превращает ambiguous-ответ в обычный OPEN order.
     Если в deps передан `reconciliationIssues` — дополнительно создаётся
     queryable issue `SUBMIT_UNKNOWN_OUTCOME` (детерминированный id:
     `reconciliation:submit:${venueOrderId}:unknown`, либо
     `reconciliation:submit-client:${clientOrderId}:unknown` без venueOrderId).
     Issue создаётся ДАЖЕ если best-effort cancel удался — исход submit был
     ambiguous, и venue-состояние требует ручной проверки. Сбой `add()`
     логируется и не меняет исходный `Err`
   - `Ok({status: 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED'})` → продолжение до шага 7.
     Если venue скорректировал size (`effectiveSize < size`) — излишек резервации
     освобождается до создания Order
4. **Создание Order с venueOrderId** — `Order.create({ id: venueOrderId, ... })` → PENDING.
   Order создаётся ПОСЛЕ submit: только venue знает orderId, под которым придут
   WS-события (fills, order updates)
5. **Принятие ордера** — `order.accept()` → OPEN
6. **Сохранение (CAS)** — `orderRepo.save(acceptedOrder, 0)` — новый ордер всегда
   с `expectedVersion=0`. `Err(VersionConflictError)` означает, что под этим
   venueOrderId уже есть запись (гонка с reconcile/WS) — выполняется best-effort
   отмена venue-ордера + откат резервации, события НЕ публикуются.
   Сразу после успешного save, ДО публикации — markers/issues: для
   `PARTIALLY_FILLED`/`FILLED` ставится
   `orderStateStore.markOrderFillMatched(venueOrderId, pendingMatchFillId(...))`,
   БЕЗ синтеза `Fill`: use case не знает деталей исполнения (venue submit-ответ
   их не содержит) и не применяет ничего к `Portfolio` на этом шаге — реальный
   `Fill` придёт отдельно через WS (`FillEventHandler`) или REST
   (`ReconcileTradesUseCase`) и будет обработан в `ProcessFillUseCase`. Пометка
   нужна только чтобы `CancelOrderUseCase` не пытался отменить уже (частично)
   исполненный ордер.
7. **Публикация событий** — `eventBus.publishAll(order.pullEvents())`.
   Сбой публикации после commit НЕ возвращает `Err` — см.
   «Post-commit event publish failure policy» ниже.

   Для `FILLED` (если в deps передан `reconciliationIssues`) после успешного
   save+marker и ДО `publishAll` дополнительно создаётся queryable issue
   `SUBMIT_FILLED_WITHOUT_FILL_DETAILS`
   (id: `reconciliation:submit:${venueOrderId}:filled-without-fill-details`).

   **Почему это сделано так:** live-ордера на venue уже нет, а `Portfolio`
   нельзя обновить без реального `Fill` — если WS/reconciliation fill не
   придёт, потерю нельзя увидеть только по логам; issue делает ожидание
   fill queryable/alertable. Порядок (до `publishAll`) гарантирует, что при
   сбое публикации issue уже записана. Для `PARTIALLY_FILLED` issue НЕ
   создаётся: ордер всё ещё live, pending marker достаточен. Сбой `add()`
   логируется и не ломает успешный результат (`Ok(venueOrderId)`).

### Пример использования

```typescript
const useCase = new PlaceOrderUseCase({
  riskChecker,
  orderService,
  portfolioService,
  orderRepo,
  exchangeClient,
  eventBus,
  clock,
  logger,
});

const result = await useCase.execute({
  orderId,
  accountId,
  asset,
  instrumentId,
  side: 'BUY',
  price: Price.of(new Decimal('0.65')),
  size: Quantity.of(new Decimal('100')),
  portfolio: currentPortfolio,
  openOrdersCount: 3,
  strategyId: 'my-strategy',
});

if (result.ok) {
  console.log('Order placed:', result.value); // orderId
}
```

## ProcessFillUseCase

### Алгоритм

1. **Idempotency guard** — `processedFillRepo.begin(fill.id)` → `DUPLICATE`/`BUSY`/`RECONCILIATION_REQUIRED` → skip (Ok, no-op)
2. **Keyed mutex** — `keyedMutex.runExclusive([accountId, orderId, instrumentId], ...)` сериализует относительно `CancelOrderUseCase`
3. **Получить Order** — `orderRepo.get(fill.orderId)`
4. **Применить Fill к Order** — `order.applyFill(fillData)`
5. **Сохранить Order** — `orderStateStore.saveSync(updatedOrder)`
6. **Обновить Portfolio** — `portfolioService.applyFill(fill)`
   - BUY: `applyDebit(price×size)` + позиция увеличивается
   - SELL: `applyCredit(price×size)` + позиция уменьшается
   - Если падает ПОСЛЕ шага 5 (Order уже сохранён) → `markReconciliationRequired(fill.id, reason)`,
     НЕ `markFailed()` (см. Idempotency ниже). Если в deps передан
     `reconciliationIssues` — дополнительно создаётся queryable issue
     `ORDER_PORTFOLIO_DESYNC` (id: `reconciliation:fill:${fill.id}:order-portfolio-desync`)
     с тем же reason; семантика `markReconciliationRequired` не меняется,
     сбой `add()` логируется и не маскирует исходный `Err`
7. **Записать в Ledger** — `ledgerService.recordFill(fill)`
8. **`markApplied(fill.id)`** — сразу после успешного применения к Order/Portfolio/Ledger, ДО публикации
9. **Публикация событий** — `eventBus.publishAll(order.pullEvents())` — ошибка публикации НЕ откатывает `markApplied` (см. `ProcessFillUseCase` doc, `EVENT_PUBLISH_FAILED`)

### Idempotency

Повторный вызов с тем же `fill.id` безопасен: `begin()` возвращает `DUPLICATE` (уже `APPLIED`)
или `BUSY` (конкурентно `PROCESSING`) — в обоих случаях Ok без повторной обработки.
После `FAILED`/`REVERTED` — retry разрешён (`begin()` вернёт `ACQUIRED, isRetry: true`).

После `RECONCILIATION_REQUIRED` — retry НЕ разрешён. Этот статус ставится, когда Order уже
сохранён (шаг 5), а Portfolio — нет: `Order.applyFill()` защищён от повторного применения того
же fillId, поэтому retry такого fillId гарантированно упрётся в ошибку "duplicate fill" и никогда
не восстановит Portfolio. `begin()` на `RECONCILIATION_REQUIRED` возвращает
`{ outcome: 'RECONCILIATION_REQUIRED' }` (не `ACQUIRED`), а `execute()` — `Ok` (no-op) с
error-логом на каждый повторный вызов, чтобы проблема оставалась видимой в мониторинге, но не
мутирует Order/Portfolio/Ledger повторно. Требуется ручная реконсиляция.

## Reconciliation issues (IReconciliationIssueRepository)

### Почему это сделано так?

Manual reconciliation paths раньше только логировались или помечали статус fill в
`IProcessedFillRepository`. Логи не queryable, а processed-fill статус привязан к
fillId и не покрывает submit-сценарии без fill (UNKNOWN outcome, FILLED без fill
details). Порт `IReconciliationIssueRepository` (в `@polymarket/ports`) даёт единое
queryable/alertable хранилище проблем, требующих ручного вмешательства.

Ключевые свойства:

- **Optional dependency** — use-cases работают без него (прежнее поведение:
  logging + `markReconciliationRequired`); передача repo только добавляет issues.
- **Идемпотентный `add()`** — детерминированные id (`reconciliation:...`)
  гарантируют отсутствие дублей при retry того же сценария.
- **Best-effort** — сбой `add()` никогда не маскирует исходную trading-ошибку
  и не меняет результат use case (логируется `Failed to add reconciliation issue`).
- **Не мутирует trading state** — это operational/recovery запись, не Order/Portfolio.

### Кто какие issues создаёт

| Use case | Сценарий | Тип issue | id |
|----------|----------|-----------|----|
| `PlaceOrderUseCase` | submit → `UNKNOWN` | `SUBMIT_UNKNOWN_OUTCOME` | `reconciliation:submit:${venueOrderId}:unknown` (или `submit-client:${clientOrderId}`) |
| `PlaceOrderUseCase` | submit → `FILLED` без fill details | `SUBMIT_FILLED_WITHOUT_FILL_DETAILS` | `reconciliation:submit:${venueOrderId}:filled-without-fill-details` |
| `ProcessFillUseCase` | Portfolio падает после сохранения Order | `ORDER_PORTFOLIO_DESYNC` | `reconciliation:fill:${fillId}:order-portfolio-desync` |
| `CancelOrderUseCase` | venue cancel → `UNKNOWN_RETRY_NEEDED` после local cancel | `CANCEL_UNKNOWN_OUTCOME` | `reconciliation:cancel:${orderId}:unknown` |
| `CancelOrderUseCase` | транспортный `Err` venue cancel после local cancel | `CANCEL_UNKNOWN_OUTCOME` | `reconciliation:cancel:${orderId}:transport-error` |

In-memory реализация — `InMemoryReconciliationIssueRepository`
(`@polymarket/in-memory`, re-export в `@polymarket/backtesting`). Recovery
worker/use-case по этим issues — вне scope текущего этапа (только repository +
создание issues).

## CancelOrderUseCase

### Алгоритм

1. **Preflight** — `orderRepo.get(orderId)` (fail-fast, чтобы вычислить instrumentId для lock keys)
2. **Keyed mutex** — `keyedMutex.runExclusive([accountId, orderId, instrumentId], ...)` сериализует относительно `ProcessFillUseCase`
3. **Прочитать Order + версию атомарно** (внутри lock) — `getWithVersion(orderId)`:
   версия гарантированно относится к той же записи, что и Order (нет yield-окна
   между двумя раздельными await)
4. **Проверить статус** — если терминальный → `Ok(void)` (идемпотентность)
5. **Проверить matched/in-flight fills** — `orderStateStore.hasMatchedFills(orderId)` или
   `hasInFlightFills(instrumentId)` → `Ok(void)` (skip, отмена заблокирована)
6. **Отменить Order (CAS)** — `order.cancel(reason)` → CANCELED, затем
   `orderRepo.save(cancelledOrder, expectedVersion)`. При `VersionConflictError`:
   перечитать latest — терминальный/исчезнувший → `Ok` (no-op, БЕЗ release),
   иначе `Err`. Резервация и события при конфликте НЕ трогаются
7. **Снять резервацию** — `portfolioService.releaseOrderReservation()` — только
   ПОСЛЕ успешного CAS save
8. **Best-effort биржевая отмена** — `exchangeClient.cancelOrder(orderId)` (ошибка не прерывает)
9. **Публикация событий** — `eventBus.publishAll(order.pullEvents())`.
   Сбой публикации после commit НЕ возвращает `Err` — см.
   «Post-commit event publish failure policy» ниже.

### Best-effort отмена

`exchangeClient.cancelOrder()` возвращает `Ok(CancelOrderResult)` для любого бизнес-исхода
venue-отмены (`CANCELLED`, `ALREADY_FILLED`, `ALREADY_CANCELLED`, `NOT_FOUND`,
`UNKNOWN_RETRY_NEEDED`) — `Err(ExchangeError)` зарезервирован только для транспортных/API
ошибок. `CancelOrderUseCase` переключается по типизированному `status` и **не парсит текст
venue-ошибок** — эта классификация выполняется исключительно в infrastructure-адаптере
(`PolymarketExchangeClientAdapter._classifyCancelRejection`). И `Ok` с любым статусом, и
транспортный `Err` не приводят к возврату `Err` из use case — ордер уже отменён локально
в любом случае; reconciliation-процесс обрабатывает расхождения между локальным состоянием
и биржей.

`ALREADY_FILLED` помечает ордер через `orderStateStore.markOrderFillMatched()` И ставит
instrument-level pending marker `markInFlightFill({ fillId: pendingMatchFillId(orderId),
status: 'MATCHED' })`: локально ордер уже terminal, order-level marker не мешает стратегии
открыть НОВЫЙ ордер на том же инструменте до прихода реального fill —
`hasInFlightFills(instrumentId)` закрывает это race-окно. Оба placeholder-маркера снимаются
в `ProcessFillUseCase._clearInFlightFlags()` при первом реальном fill этого ордера.

### Reconciliation issues при ambiguous cancel

Если в deps передан `reconciliationIssues`, ambiguous исход venue cancel ПОСЛЕ уже
выполненного локального cancel (локально CANCELED, резервация освобождена, но venue
order может быть live) создаёт queryable issue `CANCEL_UNKNOWN_OUTCOME`:

- `UNKNOWN_RETRY_NEEDED` → id `reconciliation:cancel:${orderId}:unknown`,
  reason из `cancelOutcome.reason`;
- транспортный/API `Err(ExchangeError)` → id `reconciliation:cancel:${orderId}:transport-error`,
  reason из `error.message`.

Context обоих: `{ localStatus: 'CANCELED', stage: 'exchange-cancel-after-local-cancel',
outcome: 'UNKNOWN_RETRY_NEEDED' | 'TRANSPORT_ERROR' }`. Сбой `add()` логируется и не
меняет `Ok(undefined)` результата.

## Post-commit event publish failure policy

### Почему это сделано так?

Во всех use cases публикация доменных событий (`eventBus.publishAll`) выполняется
ПОСЛЕ бизнес-коммита (CAS save Order, release резервации, mutations Portfolio/Ledger).
Публикация — notification path, НЕ часть транзакции. Если после успешного коммита
publish падает:

- логируется error с маркером **`EVENT_PUBLISH_FAILED`** (queryable в мониторинге);
- state НЕ откатывается — коммит уже состоялся, откат невозможен/опасен;
- use case возвращает **`Ok`**, а не `Err` — иначе caller воспримет committed
  operation как retryable business failure, а повторный вызов даст
  duplicate/no-op/рассинхрон (например, повторный `PlaceOrderUseCase.execute()`
  создал бы дублирующий ордер на venue);
- потерянное уведомление — задача manual replay/observability (отдельный процесс),
  а не автоматического retry бизнес-операции.

Это применяется единообразно:

| Use case | Коммит перед publish | Результат при publish failure |
|----------|----------------------|-------------------------------|
| `PlaceOrderUseCase` | CAS save Order (live на venue) | `Ok(venueOrderId)` |
| `CancelOrderUseCase` | CAS save CANCELED + release + venue cancel attempted | `Ok(undefined)` |
| `UpdateOrderStatusUseCase` | CAS save + возможный release | `Ok(undefined)` |
| `ProcessFillUseCase` | Order/Portfolio/Ledger + `markApplied` | `Err` с пометкой «fill already committed as APPLIED» — fill НЕ становится retryable (`markApplied` уже вызван), Err сигнализирует только потерю уведомления |

Ошибки ДО коммита по-прежнему возвращают `Err` (с откатом, где он определён).

## Portfolio CAS

`IPortfolioStore.save(portfolio, expectedVersion)` использует Compare-And-Swap.
Portfolio не имеет поля `.version` — always pass `0`. In-memory реализация
всегда принимает сохранение.

## OrderRepository CAS (optimistic concurrency)

### Почему это сделано так?

Раньше `IOrderRepository.save(order)` / `delete(orderId)` работали по принципу
last-write-wins: устаревшая копия Order могла молча перетереть более свежее
состояние при fill/cancel/reconcile гонках. Теперь репозиторий версионирует
каждую запись, и все критические записи/удаления — условные.

### Контракт

- `getWithVersion(orderId)` → атомарный снапшот `{ order, version } | undefined` —
  версия гарантированно относится к той же записи, что и Order.
- `getVersion(orderId)` → текущая версия записи; `0` для отсутствующего ордера.
- `save(order, expectedVersion)` → `Ok(void)` или `Err(VersionConflictError)`.
  Новый ордер сохраняется с `expectedVersion=0`; stale save не изменяет
  хранимую запись.
- `deleteIfVersion(orderId, expectedVersion)` → условное удаление по версии;
  `Ok({status:'DELETED'|'NOT_FOUND'})` или `Err(VersionConflictError)`.
- `deleteIfState(orderId, allowedStates)` → условное удаление по статусу
  (например, cleanup терминальных ордеров в `OrderEventBridge`);
  `Err(OrderStateConflictError)`, если фактический статус вне `allowedStates`.

### Чтение перед CAS-мутацией

Order и версию нужно читать атомарно через `getWithVersion()`
(`getWithVersion` → мутация → `save(order, version)`). Раздельные
`getVersion()` + `get()` содержали yield-окно между двумя await: конкурирующая
мутация могла рассинхронизировать пару (версия N, копия N+1) — не потеря данных
(CAS save всё равно ловил конфликт), но лишние ложные конфликты под нагрузкой.
`CancelOrderUseCase` и `UpdateOrderStatusUseCase` используют `getWithVersion()`.

### Поведение use-cases при конфликте

- `PlaceOrderUseCase`: `Err`, best-effort отмена venue-ордера, откат резервации,
  события не публикуются.
- `CancelOrderUseCase` / `UpdateOrderStatusUseCase`: перечитать latest;
  терминальный / целевой статус / исчезнувший ордер → `Ok` (идемпотентный no-op,
  без повторного release), иначе `Err`. Резервация освобождается только после
  успешного CAS save.

### saveSync — временный escape hatch

`IOrderStateStore.saveSync(order)` НАМЕРЕННО обходит CAS (нет `expectedVersion`) —
он нужен `ProcessFillUseCase` для no-yield сохранения Order до мутации Portfolio
(fill/cancel race fix). При этом `saveSync` инкрементирует версию записи, поэтому
конкурирующий CAS save со stale-версией корректно получит `VersionConflictError`.
`saveSync` должен быть устранён отдельным Unit of Work/CAS refactor.

## Позиции: SimplePosition

`SimplePosition` — упрощённая реализация `IPosition` без lot-based FIFO/LIFO.
Хранит агрегированные `quantity` и `averageEntryPrice`. Для lot-based tracking
используйте `@polymarket/position` в отдельном слое.
