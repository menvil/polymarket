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
  ├── IKeyedMutex (сериализация reserve+submit+save по accountId+instrumentId)
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

### Алгоритм

1a. **Дешёвый риск-precheck** — `riskChecker.checkBeforeOrder()` на snapshot из
   `input` (fail-fast, вне lock). **НЕ authoritative**: два конкурентных
   `execute()` могут оба пройти его на устаревшем snapshot.

Шаги 1b–6 выполняются внутри **keyed mutex по `[accountId, instrumentId]`** —
ключи пересекаются с lock-наборами `ProcessFillUseCase`/`CancelOrderUseCase`.
Это закрывает race «submitOrder → WS fill → local save»: fill, прилетевший
между submit и сохранением Order, ждёт завершения Place и находит сохранённый
Order вместо ухода в direct-fill path (double debit + замороженная резервация).
Lock осознанно удерживается на время network call `submitOrder` — прагматичный
single-process safety guard. `publishAll` вынесен **за** lock (шаг 7).
TODO: replace long-held venue lock with PendingVenueOrderRegistry / UnitOfWork.

1b. **Authoritative риск-проверка (под lock)** — повторный
   `riskChecker.checkBeforeOrder()` на **свежем** `portfolio`
   (`portfolioService.getPortfolio`) и **актуальном** `openOrdersCount`
   (`orderRepo.countByStrategyId`). Устраняет гонку: без неё два конкурентных
   `execute()`, прошедших precheck на устаревшем snapshot, могли бы
   последовательно разместиться под lock, превысив лимиты по количеству/экспозиции.
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
7. **Публикация событий — ВНЕ lock** — `eventBus.publishAll(order.pullEvents())`
   выполняется в `execute()` уже ПОСЛЕ освобождения keyed mutex. `_placeLocked`
   возвращает commit-payload (venueOrderId + вытянутые события), а публикацию
   делает вызывающий: `publishAll` реально await-ит drain подписчиков, и
   держать на это время lock значило бы напрасно расширять critical section.
   Commit (CAS save + markers + issues) к этому моменту уже состоялся под lock.
   Сбой публикации после commit НЕ возвращает `Err` — см.
   «Post-commit event publish failure policy» ниже.

### Rollback release issues

Во всех rollback-ветках выполняется откат резервации
(`releaseReservation`/`releaseTokenReservation`). Если сам release падает,
резервация может остаться замороженной (Order↔Portfolio desync) — создаётся
best-effort issue `ORDER_PORTFOLIO_DESYNC`
(`reconciliation:place-rollback:${venueOrderId}:release-failed`, либо
`reconciliation:place-rollback-client:${clientOrderId}:release-failed`, если
venue-ордера не было — например REJECTED). Context содержит `stage`
(rollback-ветку) и `clientOrderId`. Rollback-ветка всё равно возвращает свой
исходный `Err`; сбой `add()` его не маскирует.

### Rollback cancel issues

Во всех rollback-ветках (UNKNOWN submit, invalid effectiveSize, excess-release
failure, timestamp/Order.create/accept failure, save conflict) выполняется
best-effort `cancelOrder(venueOrderId)`. Ambiguous исход этой отмены — venue
order может быть live или исполнен, а локального Order нет — создаёт issue
(если передан `reconciliationIssues`):

- `ALREADY_FILLED` → `VENUE_LOCAL_ORDER_DESYNC`
  (`reconciliation:place-rollback:${venueOrderId}:already-filled`) — придёт
  fill на несуществующий локально ордер;
- `UNKNOWN_RETRY_NEEDED` → `CANCEL_UNKNOWN_OUTCOME`
  (`reconciliation:place-rollback:${venueOrderId}:unknown`);
- `NOT_FOUND` → HELD + issue (`reconciliation:place-rollback:${venueOrderId}:not-found`) —
  ордер мог существовать, НЕ чистый rollback;
- транспортный `Err` → `CANCEL_UNKNOWN_OUTCOME`
  (`reconciliation:place-rollback:${venueOrderId}:transport-error`).

Только `CANCELLED`/`ALREADY_CANCELLED` — чистый rollback (release), issue не
создаётся. Все остальные исходы держат резервацию (`reservationHeld: true`).
Context содержит `stage` (какая rollback-ветка), `clientOrderId`,
`rollbackCancelOutcome`. Сбой `add()` не маскирует исходный `Err` rollback-ветки.

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
6a. **Dust release** (order стал terminal через dust threshold, remaining > 0) —
   снять остаток резервации. Сбой release НЕ проглатывается: Order уже terminal,
   dust-резервация может остаться замороженной →
   `markReconciliationRequired('DUST_RESERVATION_RELEASE_FAILED: ...')` +
   issue (`reconciliation:fill:${fillId}:dust-reservation-release-failed`),
   `Err`; Ledger и `markApplied` НЕ выполняются
7. **Записать в Ledger** — `ledgerService.recordFill(fill)`. Если `recordFill`
   бросит ПОСЛЕ commit Order+Portfolio — частичный commit (Ledger отстаёт),
   retry бесполезен → `markReconciliationRequired(fill.id,
   'ORDER_PORTFOLIO_LEDGER_DESYNC: ...')` + reconciliation issue
   (id `reconciliation:fill:${fillId}:order-portfolio-ledger-desync`), `Err`.
   То же в direct-fill path (там retry повторно применил бы Portfolio)
8. **`markApplied(fill.id)`** — сразу после успешного применения к Order/Portfolio/Ledger, ДО публикации
9. **Публикация событий** — `eventBus.publishAll(order.pullEvents())` — ошибка
   публикации НЕ откатывает `markApplied` и НЕ меняет результат: логируется
   `EVENT_PUBLISH_FAILED`, возвращается `Ok` (см. «Post-commit event publish
   failure policy»)

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
| `ProcessFillUseCase` | Ledger падает после commit Order+Portfolio | `ORDER_PORTFOLIO_DESYNC` | `reconciliation:fill:${fillId}:order-portfolio-ledger-desync` |
| `CancelOrderUseCase` | venue cancel → `UNKNOWN_RETRY_NEEDED` после local cancel | `CANCEL_UNKNOWN_OUTCOME` | `reconciliation:cancel:${orderId}:unknown` |
| `CancelOrderUseCase` | транспортный `Err` venue cancel после local cancel | `CANCEL_UNKNOWN_OUTCOME` | `reconciliation:cancel:${orderId}:transport-error` |
| `CancelOrderUseCase` | release резервации падает после committed CANCELED | `ORDER_PORTFOLIO_DESYNC` | `reconciliation:cancel:${orderId}:reservation-release-failed` |
| `UpdateOrderStatusUseCase` | release резервации падает после committed venue update | `ORDER_PORTFOLIO_DESYNC` | `reconciliation:order-update:${orderId}:reservation-release-failed` |
| `PlaceOrderUseCase` | rollback cancel → `ALREADY_FILLED` | `VENUE_LOCAL_ORDER_DESYNC` | `reconciliation:place-rollback:${venueOrderId}:already-filled` |
| `PlaceOrderUseCase` | rollback cancel → `UNKNOWN_RETRY_NEEDED` / транспортный `Err` | `CANCEL_UNKNOWN_OUTCOME` | `reconciliation:place-rollback:${venueOrderId}:unknown` / `:transport-error` |
| `PlaceOrderUseCase` | rollback release резервации падает | `ORDER_PORTFOLIO_DESYNC` | `reconciliation:place-rollback:${venueOrderId}:release-failed` (или `place-rollback-client:${clientOrderId}` без venueOrderId) |
| `ProcessFillUseCase` | dust release падает после terminal fill (Ledger уже записан) | `ORDER_PORTFOLIO_DESYNC` | `reconciliation:fill:${fillId}:dust-reservation-release-failed` |
| `ReconcileTradesUseCase` | venue `FAILED` при локальном `APPLIED` | `VENUE_LOCAL_ORDER_DESYNC` | `reconciliation:fill:${fillId}:venue-failed-after-applied` |
| `PlaceOrderUseCase` | submit транспорт `MAY_HAVE_BEEN_SUBMITTED` | `SUBMIT_UNKNOWN_OUTCOME` | `reconciliation:submit-client:${clientOrderId}:unknown` |
| `PlaceOrderUseCase` | publish событий падает после commit | `EVENT_PUBLISH_FAILED` | `reconciliation:submit:${venueOrderId}:event-publish-failed` |
| `UpdateOrderStatusUseCase` | terminal update без локального Order (под lock) | `VENUE_LOCAL_ORDER_DESYNC` | `reconciliation:order-update:${orderId}:early-terminal-without-local-order` |
| `PlaceOrderUseCase` | retry после FAILED с неснятой резервацией заблокирован | `ORDER_PORTFOLIO_DESYNC` | `reconciliation:submit-client:${clientOrderId}:retry-blocked-unresolved-reservation` |
| `PlaceOrderUseCase` | journal rollback release падает после успешного Portfolio release | `RESERVATION_JOURNAL_DESYNC` | `reconciliation:place-rollback[-client]:${id}:journal-release-failed` |
| `ProcessFillUseCase` | journal transition падает после Order+Portfolio+Ledger commit | `RESERVATION_JOURNAL_DESYNC` | `reconciliation:fill:${fillId}:reservation-journal-desync` |
| `ProcessFillUseCase` | превалидация held-fill провалилась (account/side/instrument/kind/amount) | `ORDER_PORTFOLIO_DESYNC` | `reconciliation:fill:${fillId}:held-fill-validation-failed` |
| `CancelOrderUseCase` | journal release падает после успешного Portfolio release | `RESERVATION_JOURNAL_DESYNC` | `reconciliation:cancel:${orderId}:journal-release-failed` |
| `UpdateOrderStatusUseCase` | journal release падает после успешного Portfolio release | `RESERVATION_JOURNAL_DESYNC` | `reconciliation:order-update:${orderId}:journal-release-failed` |
| Все четыре use-case | outbox `enqueue` вернул Err после business commit | `EVENT_PUBLISH_FAILED` | `reconciliation:<scope>:${id}:outbox-enqueue-failed` |

> Полное описание commit-critical семантики reservation journal (attempt-скоупинг
> operation IDs, safe-retry guard, атомарный terminal transition, blocking
> outcomes) — см. `docs/architecture/reservation-journal-safety.md`.

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
4. **Проверить статус** — если терминальный → `Ok({status:'ALREADY_CANCELLED'})` (идемпотентность)
5. **Проверить unsettled fills** — `hasMatchedFills(orderId)` или
   `hasUnsettledFills(instrumentId)` (venue in-flight ЛИБО application
   processing-блок) → `Ok({status:'FILL_PENDING'})` (skip, fill в пути)
6. **VENUE-FIRST: запрос отмены на venue** — `exchangeClient.cancelOrder(orderId)`
   выполняется **ДО** любой локальной мутации. Брошенное исключение трактуется
   как transport unknown. По типизированному исходу:
   - `CANCELLED`/`ALREADY_CANCELLED` → `order.cancel()` + CAS save + enqueue
     events + Portfolio release + journal release (СТРОГО в этом порядке) →
     `{status:'CANCELLED'|'ALREADY_CANCELLED'}` возвращается ТОЛЬКО после двух
     успешных release-операций. Сбой Portfolio release → journal
     `RECONCILIATION_REQUIRED` (НЕ `SETTLED`) + block + issue →
     `{status:'RECONCILIATION_REQUIRED'}`; сбой journal release →
     `RESERVATION_JOURNAL_DESYNC` issue + block → `{status:'RECONCILIATION_REQUIRED'}`.
     Если venue подтвердил, но local CAS конфликтует (non-terminal) — НЕ release
     вслепую, `VENUE_LOCAL_ORDER_DESYNC` issue, `{status:'RECONCILIATION_REQUIRED'}`.
   - `ALREADY_FILLED` → локальный Order **НЕ** переводим в CANCELED, резервацию
     **НЕ** освобождаем; ставим matched + instrument-block; `{status:'FILL_PENDING'}`
     (Fill позже пройдёт normal path и потребит резервацию один раз).
   - `NOT_FOUND` / `UNKNOWN_RETRY_NEEDED` / transport `Err` / throw → **НЕ**
     подтверждение отмены: локально НЕ меняем, резервация **held**,
     `CANCEL_UNKNOWN_OUTCOME` issue + instrument-block, `{status:'RECONCILIATION_REQUIRED'}`.
7. **Публикация** — cancel-события `enqueue`-ятся под lock (aggregateId=orderId),
   `flush` ПОСЛЕ выхода из lock (никаких `publishAll` под mutex).

### Типизированный `CancelOrderOutcome`

`execute()` возвращает `Result<CancelOrderOutcome, TradingError>`, где
`CancelOrderOutcome = { status: 'CANCELLED' | 'ALREADY_CANCELLED' | 'FILL_PENDING'
| 'RECONCILIATION_REQUIRED'; reason? }`. Uncertain-исходы (`RECONCILIATION_REQUIRED`,
`FILL_PENDING`) **не выглядят как подтверждённая отмена** — caller и логи
однозначно видят reconciliation state. `Err` возвращается только если ордер вообще
не найден (preflight).

**NOT_FOUND — НЕ best-effort success**: резервация НЕ освобождается (venue-ордер
мог существовать). `ALREADY_FILLED` ставит `markOrderFillMatched()` +
instrument-level `markInFlightFill({ fillId: pendingMatchFillId(orderId), status:
'MATCHED' })` (блокирует новые ордера инструмента до прихода Fill). Uncertain
outcomes создают `CANCEL_UNKNOWN_OUTCOME` issue (id `…:not-found` / `…:unknown` /
`…:transport-error`, context `{ localStatus: 'UNCHANGED', reservationHeld: true }`).

## ReconcileTradesUseCase: venue FAILED после local APPLIED

Reconciler — safety net при пропущенных WS-событиях. Если REST-сверка видит
trade со статусом `FAILED`, а локальный processed-fill статус — `APPLIED`
(WS `FILL_FAILED` не дошёл), значит Order/Portfolio/Ledger содержат применённый
fill, которого on-chain больше нет. Автоматический reversal из reconciler —
future work; текущее поведение: error-лог `VENUE_FILL_FAILED_AFTER_LOCAL_APPLIED`
+ issue `VENUE_LOCAL_ORDER_DESYNC`
(`reconciliation:fill:${fillId}:venue-failed-after-applied`), обработка trade
пропускается, счётчик `failedAfterApplied` в summary-логе. `FAILED` при
локальном статусе НЕ `APPLIED` — обычный skip (reversal не требуется).

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
| `ProcessFillUseCase` (normal и direct-fill) | Order/Portfolio/Ledger + `markApplied` | `Ok(undefined)` — fill уже `APPLIED`, `markFailed` не вызывается |

Ошибки ДО коммита по-прежнему возвращают `Err` (с откатом, где он определён).

## Release резервации после committed terminal order

`PortfolioService.releaseOrderReservation(accountId, order)` возвращает
`Result<void, PortfolioSaveError>` (раньше — `void` с проглатыванием ошибок).
Сбой release, когда локальный Order уже terminal (committed CAS save), — это
Order↔Portfolio desync (замороженная резервация), а не warning: caller обязан
создать reconciliation issue.

- `CancelOrderUseCase` — release всегда после успешного CAS save (projection
  не участвует, см. алгоритм); сбой → issue + `Ok`.
- `UpdateOrderStatusUseCase` — release для `CANCELLED`/`EXPIRED`/**`REJECTED`**
  (REJECTED добавлен: venue отклонил уже сохранённый локальный ордер —
  live-ордера нет, без release резервация замёрзла бы навсегда); сбой →
  issue + `Ok` (update уже committed). CAS-конфликт по-прежнему НЕ release'ит.

## InitializePortfolioUseCase: идемпотентный concurrent init

Между проверкой существующего Portfolio (шаг 1) и `save(…, 0)` (шаг 4) есть
`await balanceProvider.getUsdcBalance()` — конкурирующий init может успеть
сохранить Portfolio первым. Конфликт версии при `save(…, 0)` теперь
обрабатывается перечитыванием store: если Portfolio уже есть — warn-лог и
идемпотентный `Ok` (состояние системы нормальное, инициализацию выполнил
конкурент); если всё ещё нет — `Err` как раньше.

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

## Submission guard (IOrderSubmissionRepository)

`PlaceOrderUseCase` под keyed mutex вызывает `submissions.begin(clientOrderId)`
ПЕРВЫМ шагом (если `submissions` передан). Это защита от небезопасного
повторного submit того же `clientOrderId` (retry после таймаута): venue
идемпотентен по clientOrderId и может вернуть тот же venueOrderId, из-за чего
второй `execute()` попал бы в save-conflict и отменил бы успешно созданный ордер.

- `ALREADY_COMMITTED` → вернуть существующий `venueOrderId`, БЕЗ submit/cancel.
- `IN_PROGRESS` → `Err` (submission уже идёт).
- `UNKNOWN` → `Err` + `SUBMIT_UNKNOWN_OUTCOME` issue; авто-retry заблокирован.
- `ACQUIRED`/`FAILED_RETRYABLE` → продолжить.

После успешного `orderRepo.save` → `markCommitted`. UNKNOWN/ambiguous submit
(включая транспортный `MAY_HAVE_BEEN_SUBMITTED`) → `markUnknown`. REJECTED /
`DEFINITELY_NOT_SUBMITTED` → `markFailed` (retry допустим). В save-conflict-ветке
перед rollback cancel проверяется `submissions.get(clientOrderId)`: если запись
`COMMITTED` с тем же `venueOrderId` — venue-ордер НЕ отменяется (это наш же
успешно созданный ордер), возвращается `Ok(venueOrderId)`.

Optional dependency — без неё поведение прежнее. In-memory реализация:
`InMemoryOrderSubmissionRepository` (`@polymarket/in-memory`).

## Ambiguity транспортной ошибки submit (ExchangeError.submitOutcome)

`submitOrder` возвращает `Err(ExchangeError)` только на транспортных/API ошибках.
`ExchangeError.submitOutcome` различает: `DEFINITELY_NOT_SUBMITTED` (ошибка ДО
отправки — ордер точно не создан, чистый rollback + Err) и
`MAY_HAVE_BEEN_SUBMITTED` (ошибка ПОСЛЕ отправки — venue-ордер мог быть создан).
Если поле не задано — **conservative default `MAY_HAVE_BEEN_SUBMITTED`** (для live
trading безопаснее). При `MAY_HAVE_BEEN_SUBMITTED` `PlaceOrderUseCase` трактует
исход как UNKNOWN: best-effort rollback + `SUBMIT_UNKNOWN_OUTCOME` issue, Order НЕ
создаётся. Адаптер (`PolymarketExchangeClientAdapter`) помечает pre-dispatch
validation как `DEFINITELY_NOT_SUBMITTED`, а post-dispatch (timeout/invalid
response) как `MAY_HAVE_BEEN_SUBMITTED`.

## Remaining known debt

- **PendingVenueOrderRegistry** — сильнее, чем удержание keyed mutex на время
  `submitOrder`: реестр pending venue-ордеров позволил бы fill-ам находить
  «ордер в процессе размещения» без сериализации всего инструмента на network
  call. Текущий long-held lock — прагматичный single-process guard.
  `IOrderSubmissionRepository` частично закрывает дубль-submit риск, но полноценный
  registry + persistence (Redis/Postgres) — future work.
- **Автоматический reversal из reconcile `FAILED`** — future work; текущее
  поведение создаёт `VENUE_LOCAL_ORDER_DESYNC` issue и требует ручного
  вмешательства.
- **UnitOfWork / атомарный Order+Portfolio commit** — `saveSync` и
  последовательные мутации Portfolio остаются прагматичным single-process
  решением (см. также TODO в `IOrderStateStore.saveSync`).
