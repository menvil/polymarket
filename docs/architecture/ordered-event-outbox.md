# Ordered Event Outbox и safety-политики размещения ордеров

## Зачем это сделано

`PlaceOrderUseCase` и `ProcessFillUseCase` выполняют критическую секцию под
`IKeyedMutex` (сериализация reserve+submit+save относительно fills/cancels по
`[account, instrument]`). Раньше доменные события публиковались через
`eventBus.publishAll()` **внутри** этого lock. Это создавало две проблемы:

1. **Deadlock.** `EventBus.publishAll` дренирует подписчиков синхронно. Если
   handler `ORDER_ACCEPTED` вызывал lock-зависимый use-case (тот же `account`),
   он ждал mutex, который держит текущий Place — взаимоблокировка.
2. **Нарушение порядка при выносе публикации за lock «наивно».** Если просто
   вынести `publishAll` за lock, конкурентный `Fill`, дождавшийся mutex сразу
   после Place, мог опубликовать `ORDER_FILLED` раньше, чем Place опубликует
   `ORDER_CREATED`/`ORDER_ACCEPTED` — стратегия увидела бы fill по «неизвестному»
   ордеру.

**Решение** — `IOrderedEventOutbox`: события `enqueue`-ятся под lock (быстро, без
публикации), а `flush` (реальная публикация) выполняется уже ПОСЛЕ выхода из
lock. Порядок гарантирует сам outbox: per-aggregate FIFO по
`aggregateId = venueOrderId`.

## Контракт `IOrderedEventOutbox`

```typescript
interface OrderedEventBatch {
  readonly aggregateId: string;        // venueOrderId для Order-домена
  readonly aggregateVersion?: number;
  readonly events: readonly unknown[]; // opaque — ports не зависит от event-bus
}

interface IOrderedEventOutbox {
  // НЕ публикует; Result — сбой enqueue после commit не делает операцию retryable.
  enqueue(batch: OrderedEventBatch): Promise<Result<void, OutboxEnqueueError>>;
  flush(): Promise<void>;  // дренирует, НЕ бросает
}
```

- `enqueue` кладёт batch в FIFO-очередь по `aggregateId`. **Не** вызывает
  подписчиков. Возвращает `Result` (in-memory практически всегда `Ok`).
- `flush` публикует накопленные batch'и. Разные `aggregateId` дренируются
  параллельно, один `aggregateId` — строго FIFO. Конкурентный `flush` одного
  aggregate использует общий single-flight drain-promise.

### Алгоритм `InMemoryOrderedEventOutbox.flush()` по шагам

1. Берём снимок ключей всех непустых очередей.
2. Для каждого `aggregateId` параллельно (`Promise.all`) запускаем
   `_drainAggregate`.
3. `_drainAggregate` single-flight: если drain этого aggregate уже идёт,
   возвращается ТОТ ЖЕ promise (конкурентный caller ждёт его, не запускает второй).
4. Внутри loop: читаем **head** очереди БЕЗ удаления → `await publish(head.events)`
   → `shift()` **только после успеха**.
5. Сбой `publish`: head **остаётся в очереди** (НЕ теряется), drain
   останавливается (позже flush повторит head). Логируется `EVENT_PUBLISH_FAILED`,
   создаётся queryable issue со **стабильным** id
   `reconciliation:outbox:<aggregateId>:event-publish-failed` (`add` идемпотентен —
   ретраи не плодят дубликаты). Другие aggregate дренируются независимо.

### Почему `events: readonly unknown[]`, а `publish` — callback

- Пакет `@polymarket/ports` не должен зависеть от `@polymarket/event-bus` →
  события в порту opaque (`unknown[]`).
- `@polymarket/in-memory` тоже не зависит от event-bus → outbox принимает
  `publish: (events) => Promise<void>` (в проде `(events) => eventBus.publishAll(events)`).

## Единый инстанс outbox: Place ↔ Fill

`PlaceOrderUseCase` и `ProcessFillUseCase` **обязаны** использовать ОДИН и тот же
инстанс outbox — иначе per-order FIFO между Place-событиями и Fill-событиями не
сохранится. В `buildUseCases.ts` outbox создаётся в `buildProcessFillUseCase`,
возвращается в `ProcessFillBundle.orderedEventOutbox` и прокидывается в
`buildOrderUseCases`.

```
buildProcessFillUseCase → orderedEventOutbox ─┐
                                              ├─ один инстанс
buildOrderUseCases(orderedEventOutbox) ───────┘
```

## Reservation safety при ambiguous submit

Ключевой инвариант: **нельзя освобождать резервацию, пока не подтверждено, что
venue-ордер не существует** — иначе при последующем fill получим двойной учёт
(разморозили средства, а ордер исполнился).

| Исход submit / rollback cancel        | Резервация     | Submission | Reconciliation issue |
|---------------------------------------|----------------|------------|----------------------|
| `Err` DEFINITELY_NOT_SUBMITTED        | **release**    | markFailed | нет                  |
| `Err` MAY_HAVE_BEEN_SUBMITTED (и legacy без `submitOutcome`) | **HELD** | markUnknown | SUBMIT_UNKNOWN_OUTCOME (`reservationHeld: true`) |
| `Ok(UNKNOWN)` без `orderId`           | **HELD**       | markUnknown | SUBMIT_UNKNOWN_OUTCOME |
| `Ok(UNKNOWN)` с `orderId`, cancel CANCELLED/ALREADY_CANCELLED | **release** | markUnknown | SUBMIT_UNKNOWN_OUTCOME |
| `Ok(UNKNOWN)` с `orderId`, cancel ALREADY_FILLED/UNKNOWN_RETRY_NEEDED/NOT_FOUND/Err | **HELD** | markUnknown | SUBMIT_UNKNOWN_OUTCOME (`reservationHeld: true`) |

### Политика post-submit rollback (после успешного submit, до/во время commit)

Helper `_cancelVenueOrderBeforeReservationRelease` определяет
`shouldReleaseReservation` по исходу cancel:

- **CANCELLED / ALREADY_CANCELLED** → release (ордер точно снят).
- **ALREADY_FILLED** → HELD, `markOrderFillMatched` + `markInFlightFill`, issue
  `place-rollback:<venueOrderId>:already-filled` (`VENUE_LOCAL_ORDER_DESYNC`).
- **UNKNOWN_RETRY_NEEDED** → HELD, issue `…:unknown` (`CANCEL_UNKNOWN_OUTCOME`).
- **NOT_FOUND** → HELD, issue `…:not-found` (ордер мог существовать — нужна
  reconciliation).
- **транспортный Err** → HELD, issue `…:transport-error` (`CANCEL_UNKNOWN_OUTCOME`).

Во всех held-ветках контекст issue содержит `reservationHeld: true`, после чего
вызывается `markSubmissionUnknown` (авто-retry заблокирован).

## Submission guard: fingerprint и VENUE_ACCEPTED

`IOrderSubmissionRepository.begin(...)` принимает `fingerprint` (хэш из
account/instrument/asset/side/price/size/orderType/postOnly/strategyId) и
проверяет его ПЕРВЫМ:

- **FINGERPRINT_MISMATCH** — `clientOrderId` переиспользован под другой ордер:
  issue + Err, БЕЗ submit/cancel/release.
- Статусы: `SUBMITTING → IN_PROGRESS`, `VENUE_ACCEPTED → VENUE_ACCEPTED`,
  `COMMITTED → ALREADY_COMMITTED`, `UNKNOWN → UNKNOWN` (блок авто-retry),
  `FAILED → FAILED_RETRYABLE` (снова `SUBMITTING`).

`markVenueAccepted(clientOrderId, venueOrderId, now)` вызывается СРАЗУ после
успешного submit (venue вернул `venueOrderId`), ДО локальных Order-операций.
Если процесс упадёт между submit и local save, при рестарте `begin()` вернёт
`VENUE_ACCEPTED` — guard не сделает повторный submit. На save-conflict:

1. `orderRepo.get(venueOrderId)` существует → idempotent success (`Ok`), без cancel.
2. Иначе submission `COMMITTED`/`VENUE_ACCEPTED` с тем же `venueOrderId` → issue
   `submit:<venueOrderId>:save-conflict-no-local-order` + Err, без cancel (наш ордер).
3. Иначе (чужая запись) → безопасный rollback-cancel по политике выше.

## Namespaced lock keys

Чтобы lock-наборы разных use-case гарантированно пересекались по account, ключи
неймспейсятся (`packages/application/use-cases/src/lockKeys.ts`):

```typescript
lockKey.account(id)    // `account:<accountIdToString>`
lockKey.order(id)      // `order:<id>`
lockKey.instrument(id) // `instrument:<id>`
```

| Use-case             | Lock keys                                    |
|----------------------|----------------------------------------------|
| PlaceOrderUseCase    | `[account, instrument]`                       |
| ProcessFillUseCase   | `[account, order, instrument]`                |
| CancelOrderUseCase   | `[account, order, instrument]`                |
| UpdateOrderStatusUseCase | `[account, order]`                        |

Все включают `account` — операции одного аккаунта сериализуются.

## ACCEPTED без локального Order

`UpdateOrderStatusUseCase`: если venue-update пришёл, а локального Order нет,
issue создаётся для **всех** типов update (включая `ACCEPTED`, не только
terminal). id: `order-update:<orderId>:update-without-local-order:<type>`,
reason `VENUE_ORDER_UPDATE_WITHOUT_LOCAL_ORDER:<type>`,
`type: VENUE_LOCAL_ORDER_DESYNC`, возвращается `Ok` (handler не должен бесконечно
retry-ить).

## Authoritative portfolio

`PlaceOrderUseCase` НЕ откатывается на stale `input.portfolio`: если
`portfolioService.getPortfolio(accountId)` вернул `undefined` →
`markSubmissionFailed('PORTFOLIO_NOT_INITIALIZED')` + `Err('Portfolio not
initialized')`. Проверка выполняется ДО submit — reserve/cancel не нужны.
```

---

# Single-process lifecycle safety (расширение)

Этот раздел описывает изменения, делающие Order/Fill/Cancel lifecycle безопасным
для single-process live trading (reservation journal, held-recovery, venue-first
cancel, processing-блоки, corrupt-guard). Границы: persistent DB-транзакции,
restart durability и полноценный persistent outbox — вне scope.

## Обязательные инварианты

1. Резервация освобождается только если достоверно известно, что venue-ордер
   больше не может исполниться.
2. Каждый Fill использует ровно ОДИН источник расчёта: held reservation ЛИБО
   available balance — никогда одновременно списание available и оставленную
   held reservation.
3. `NOT_FOUND`, transport error и `UNKNOWN_RETRY_NEEDED` при cancel — НЕ
   подтверждение отмены.
4. При `ALREADY_FILLED` локальный Order НЕ переводится в CANCELED.
5. Ни один handler EventBus не вызывается под `IKeyedMutex` (все lifecycle
   события идут через outbox: enqueue под lock, flush после lock).
6. Для reservation accounting выполняется `initial = remaining + consumed + released`.
7. Corrupt `COMMITTED`/`VENUE_ACCEPTED` без venueOrderId никогда не вызывает
   reserve или submit (hard error + issue).
8. `FAILED_RETRYABLE` и `RECONCILIATION_REQUIRED` сохраняют instrument-level
   blocking state (`hasUnsettledFills`).

## Reservation journal

`OrderSubmissionRecord` теперь ещё и recovery journal: хранит `side`,
`orderPrice`, `requestedSize`, `effectiveSize?`, `venueOrderId?` и
`ReservationSnapshot` (`kind`, `initial`, `remaining`, `consumed`, `released`,
`status ∈ {NONE, HELD, PARTIALLY_SETTLED, SETTLED, RECONCILIATION_REQUIRED}`;
суммы — exact-decimal строки). Held определяется вычислимо
(`remaining > 0 && status ∉ {NONE, SETTLED}`), отдельного boolean НЕТ.
`applyReservationTransition` идемпотентен по `operationId` (fill ID / cancel-op
ID) и проверяет инвариант учёта. Обратный индекс `findByVenueOrderId` нужен
`ProcessFillUseCase` (fill приходит с venueOrderId).

## Три пути Fill (ProcessFillUseCase)

1. **Normal** — есть живой (non-terminal) локальный Order: `order.applyFill` +
   Portfolio consume reserved + journal consume.
2. **Held-reservation recovery** — Order нет/terminal, но journal имеет
   held-резервацию (ambiguous submit без local Order): `applyFillAgainstHeldReservation`
   потребляет reserved (BUY — `applyDebit` по `orderPrice`, НЕ `applyDirectDebit`
   из available), journal consume. Это закрывает P0 «двойной debit + frozen
   reservation».
3. **External/released direct** — ни живого Order, ни held-резервации:
   `applyDirectFill` из available.

> Направление: **direct fill НЕ всегда означает отсутствие резервации** — сперва
> проверяется held-резервация в journal; только при её отсутствии/SETTLED идёт
> списание из available.

## Venue-first cancel (CancelOrderUseCase)

Запрос отмены на venue выполняется ДО любой локальной мутации; по типизированному
исходу:

| Venue outcome        | Local Order        | Reservation      | Outcome                    |
|----------------------|--------------------|------------------|----------------------------|
| CANCELLED / ALREADY_CANCELLED | CANCELED (CAS) | release remaining | `CANCELLED`/`ALREADY_CANCELLED` |
| ALREADY_FILLED       | НЕ трогаем         | **held**         | `FILL_PENDING` (+matched+block) |
| NOT_FOUND            | НЕ трогаем         | **held**         | `RECONCILIATION_REQUIRED` (+issue+block) |
| UNKNOWN_RETRY_NEEDED | НЕ трогаем         | **held**         | `RECONCILIATION_REQUIRED` (+issue+block) |
| transport error / throw | НЕ трогаем      | **held**         | `RECONCILIATION_REQUIRED` (+issue+block) |

> **NOT_FOUND — НЕ best-effort success.** Резервация НЕ освобождается: venue-ордер
> мог существовать (gateway/lag). Возвращается typed `CancelOrderOutcome` —
> uncertain-исходы не выглядят как подтверждённая отмена.

Если venue подтвердил cancel, но local CAS save конфликтует (genuine non-terminal)
— НЕ release вслепую, `VENUE_LOCAL_ORDER_DESYNC` issue, `RECONCILIATION_REQUIRED`,
события НЕ публикуются.

## Application-level processing blocks (Stage 6)

Отдельная ось от venue `InFlightFillStatus`. `FillProcessingStatus ∈ {PROCESSING,
FAILED_RETRYABLE, RECONCILIATION_REQUIRED}`. ProcessFillUseCase ставит
`PROCESSING` в начале обработки; на retryable/reconciliation переводит статус, но
**НЕ снимает блок**; снимает (`clearFillProcessing`) только на реально settled
(APPLIED). `hasUnsettledFills(instrumentId) = hasInFlightFills || hasFillProcessingBlocks`
— единый guard для стратегий (`StrategyScheduler`) и cancel.

> **Markers нельзя очищать при reconciliation failure.** Событийный сбой
> публикации ПОСЛЕ commit — исключение: fill остаётся APPLIED, processing-блок
> снимается (это потеря уведомления, не trading-desync).

## Corrupt submission — hard error (Stage 5)

`ALREADY_COMMITTED`/`VENUE_ACCEPTED` без `venueOrderId` (повреждённые данные
персистентного адаптера) → детерминированный `VENUE_LOCAL_ORDER_DESYNC` issue
(stage `corrupt-submission-missing-venue-order-id`) + `Err`, ДО risk/reserve/
submit/cancel/markFailed.

## Outbox durability (исправление)

`InMemoryOrderedEventOutbox` публикует head-batch и делает `shift()` **только
после успеха**. При сбое publish batch **остаётся в голове** per-aggregate очереди
(НЕ теряется) и блокирует более поздние batches ТОГО ЖЕ aggregate; другие
aggregate дренируются независимо. Следующий `flush()` повторяет head. Single-flight
per aggregate — общий drain-promise (без busy-loop). `enqueue` возвращает `Result`.

> **Failed outbox batch НЕ теряется** (ранее реализация делала `shift()` до
> публикации — batch терялся; исправлено).

## Durability (явные границы)

- In-memory submission guard, reservation journal и outbox **НЕ переживают process
  restart**. Утверждения «in-memory `VENUE_ACCEPTED` переживает restart» неверны.
- Для persistent live-режима потребуется DB-транзакция для business state + outbox
  в одной границе (UnitOfWork), а не последовательный compensating-commit.
- Boot-time venue reconciliation (сверка held-резерваций и unknown-submissions с
  venue при старте) остаётся обязательным будущим этапом.
