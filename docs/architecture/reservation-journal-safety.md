# Reservation journal safety — commit-critical учёт резервации в order lifecycle

## Почему это сделано так?

До этих изменений reservation journal (`OrderSubmissionRecord.reservation`) был
best-effort recovery-store: сбои `markReservationHeld` / `applyReservationTransition`
логировались, но не влияли на исход операций. Это допускало P0-сценарии:

- **Двойная заморозка капитала**: retry после `FAILED` submission с неснятой
  резервацией выполнял второй `reserve` поверх первого.
- **Ложный held-recovery**: journal оставался `HELD` после реального release —
  поздний fill потреблял «несуществующий» капитал.
- **Тихий desync**: `SETTLED` в journal при упавшем Portfolio release (капитал
  заморожен, учёт говорит «свободен»).
- **Идемпотентность съедала rollback повторной попытки**: operationId без
  attempt-скоупа считал rollback второй попытки дубликатом первой.

Теперь journal — **commit-critical**: он не может незаметно разойтись с
Portfolio, а любое частично закоммиченное состояние блокирует новые торговые
операции до ручной реконсиляции.

## Ключевые инварианты

1. `initial = remaining + consumed + released` (как и раньше).
2. Консистентность статус↔суммы (`applyReservationDelta` возвращает
   `Err(INVARIANT_VIOLATION)`):
   - `SETTLED` требует `remaining === 0`;
   - `HELD` / `PARTIALLY_SETTLED` требуют `remaining > 0`;
   - `NONE` требует нулевых сумм.
3. `RECONCILIATION_REQUIRED` **терминален для автоматики**: любой consume/release/
   смена статуса → `Err(RECONCILIATION_LOCKED)` (разрешён только идемпотентный
   re-mark). Выход — только ручная реконсиляция.
4. **Journal никогда не становится `SETTLED`, если Portfolio release не
   подтвердился** — вместо этого `RECONCILIATION_REQUIRED`.
5. **`markFailed` (retry разрешён) — только после подтверждённого Portfolio И
   journal rollback** (`remaining === 0 && status === 'SETTLED'`).

## Typed manual reconciliation block (P0)

### Проблема

MATCHED placeholder (`pendingMatchFillId`) означает «fill ожидается и разрешит
состояние» — его снимает первый реальный fill. Но при **journal desync**
(journal остался `HELD` после уже освобождённого Portfolio) семантика обратная:
задержанный fill НЕ должен ни потреблять held-резервацию (для BUY
USDC-резервация агрегирована на аккаунте — он потребил бы чужой капитал), ни
снимать блок.

### Решение

`IOrderStateStore` расширен отдельной осью — `ManualReconciliationBlock`
(`{ orderId, instrumentId, reason }`):

- `markManualReconciliationBlock` / `clearManualReconciliationBlock` /
  `hasManualReconciliationBlockForOrder` / `hasManualReconciliationBlocks` /
  `getManualReconciliationBlocks`;
- участвует в `hasUnsettledFills` (блокирует Place/Cancel/стратегии);
- НЕ снимается fill-ами и `clearInFlightFill`/`clearFillProcessing` — только
  явным `clearManualReconciliationBlock` (оператор/recovery-тулинг).

### Кто ставит manual block

Все partial-commit ветки, где Portfolio↔journal могли разойтись; одновременно
best-effort выполняется перевод журнала в `RECONCILIATION_REQUIRED`
(двухслойная защита — block работает, даже если пометка журнала тоже упала):

- Place: rollback release failure, journal-release-after-confirmed-release
  failure, journal-HELD compensation failure, unknown-submit release failure;
- Cancel: Portfolio release failure, journal release failure, `order.cancel()`
  failure после подтверждённого venue cancel, non-terminal CAS conflict после
  подтверждённого venue cancel;
- Update: обе journal/Portfolio release failure ветки (с local Order и без);
- ProcessFill: journal failure после business commit (normal и held path).

MATCHED placeholder остаётся ТОЛЬКО там, где fill действительно ожидается и
состояние консистентно (ALREADY_FILLED, uncertain rollback cancel c ещё held
Portfolio+journal).

### Guard в ProcessFillUseCase

Перед ЛЮБЫМИ мутациями (и до чтения Order/journal) `_processLocked` проверяет
`hasManualReconciliationBlockForOrder(fill.orderId)` и
`hasManualReconciliationBlocks(instrumentId)` — при блоке fill **откладывается**
(deferred): processing-блок → `FAILED_RETRYABLE`, processed fill → `markFailed`
(retry разрешён), Portfolio/Ledger/journal не тронуты, manual block остаётся.

### Почему deferred, а не terminal (P1)

Fill, остановленный manual block ДО мутаций, ещё ничего не изменил. Terminal
`RECONCILIATION_REQUIRED` делал бы корректный fill соседнего ордера того же
инструмента навсегда необрабатываемым (после снятия блока `begin()` возвращал
бы вечный no-op). Deferred-семантика: пока блок жив — каждый retry снова
откладывается без мутаций (безопасность обеспечивает сам блок); после
`clearManualReconciliationBlock` повторный `execute(fill)` применяет fill ровно
один раз. Terminal `RECONCILIATION_REQUIRED` остаётся только для post-mutation
сбоев (частичный commit самого fill) и провала prevalidation held-fill.

## Recovery ambiguous submissions без venueOrderId (fail-closed)

### Проблема

При `MAY_HAVE_BEEN_SUBMITTED` (или `UNKNOWN` без orderId) submission
переводится в `UNKNOWN`, резервация held, но **venueOrderId неизвестен** —
поздний Fill не находит запись через `findByVenueOrderId` и ушёл бы в direct
path: двойной дебет для BUY (available списан + исходная USDC-резервация
аккаунта заморожена навсегда).

### Почему НЕ автоматический recovery

Эвристическое совпадение по instrument/side/price/size/time — только ПОДСКАЗКА
оператору, не доказательство (ошибочный bind чужого ордера хуже отсутствия
bind). Пустой ответ `getOpenOrders()+getTrades()` — НЕ доказательство
отсутствия заявки (API может отставать). Никакой возраст записи не разрешает
автоматический release. UNKNOWN без venueOrderId ВСЕГДА означает: reservation
held, manual block активен, авто-retry submit запрещён.

### Решение (трёхступенчатое, fail-closed)

1. **`PlaceOrderUseCase` сразу ставит manual block** на инструмент (ключ —
   clientOrderId) в обеих ветках без venueOrderId — fill будет отложен
   (deferred), а не применён direct path.
2. **`ReconcileUnknownSubmissionsUseCase` — DISCOVERY-ONLY** (периодически +
   после WS reconnect): `listByStatus('UNKNOWN')` → эвристические кандидаты
   (структурированные `UnknownSubmissionCandidate`: `OPEN_ORDER` со snapshot /
   `TRADE` с trade) → findings + идемпотентные issues. Исходы:
   `HEURISTIC_CANDIDATE_FOUND` / `AMBIGUOUS_VENUE_MATCH` /
   `NO_CANDIDATE_INCONCLUSIVE` / `VENUE_LOOKUP_INCOMPLETE`. НИКОГДА не
   вызывает bind/release/`markFailed`/`clearManualReconciliationBlock`.
3. **`ResolveUnknownSubmissionUseCase` — явное операторское решение** (под
   account/instrument locks, с audit: operatorId/reason/время):
   - `BIND_VENUE_ORDER` + `OPEN_ORDER`: verify через venue → `markVenueAccepted`
     → **block ОСТАЁТСЯ** (`BOUND_AWAITING_ORDER_RECOVERY`: данных snapshot
     недостаточно для восстановления локального Order — нет strategyId и части
     параметров; блок до восстановления Order в локальном репозитории);
   - `BIND_VENUE_ORDER` + `TRADE`: verify → bind → matched/in-flight markers
     на конкретные fillId trade-ов (unsettled evidence сохраняется) → ТОЛЬКО
     потом снятие блока (`BOUND_AWAITING_FILL`); fill применится held-path
     через WS/reconciliation, markers снимет `ProcessFillUseCase`;
   - `CONFIRM_NOT_SUBMITTED`: Portfolio release → journal release (`SETTLED`)
     → `markFailed` (retry разрешён) → снятие блока
     (`RELEASED_NOT_SUBMITTED`). Частичный сбой → journal
     `RECONCILIATION_REQUIRED` best-effort, блок ОСТАЁТСЯ, issue, retry
     запрещён (`RECONCILIATION_REQUIRED`).

Автоматический UNKNOWN recovery возвращать только после появления сильного
venue identifier либо authoritative lookup с отдельным исходом
`CONCLUSIVELY_NOT_FOUND`.

## Exception boundary обработки Fill (FillCommitPhase + lease)

### Commit tracker

`ProcessFillUseCase` ведёт `FillCommitPhase` (`NONE → ORDER_COMMITTED →
PORTFOLIO_COMMITTED → LEDGER_COMMITTED → JOURNAL_COMMITTED`), обновляемую сразу
после каждой необратимой мутации. Locked processing обёрнут в exception
boundary; `orderedEventOutbox.flush()` — в `finally` (уже enqueued события
committed мутаций не остаются без попытки публикации). Неожиданный throw:

- `phase === NONE` → business mutation не было → `markFailed` +
  processing-блок `FAILED_RETRYABLE` → **retry разрешён**;
- `phase !== NONE` → частичный commit → `markReconciliationRequired` + journal
  `RECONCILIATION_REQUIRED` best-effort + manual block + issue → retry запрещён.

В ОБОИХ случаях venue MATCHED/in-flight markers НЕ снимаются — evidence
сохраняется до применения/отката/операторского разрешения.

### PROCESSING lease

`IProcessedFillRepository.begin(fillId, lease?)` принимает
`{ workerId, now, leaseMs }` (default в ProcessFill: `main`/120s): просроченный
`PROCESSING` (крэш между begin и mark*) reclaim-ится (`reclaimed: true`,
монотонный `leaseToken` — fencing) вместо вечного `BUSY`. Legacy begin без
lease — прежнее поведение. Персистентная реализация обязана делать
acquire/reclaim атомарно и отклонять `mark*` со старым token.

## Terminal settlement pending (delayed-fill race)

### Проблема

Partial fill произошёл на venue, а `CANCELLED`/`EXPIRED`/`REJECTED` update
пришёл ПЕРВЫМ. Немедленный release всей остаточной резервации завысил бы
available (временно доступный незаработанный капитал), а delayed fill затем
дебетовал бы available второй раз.

### Решение

Manual block здесь НЕ подходит (заблокировал бы и сам поздний Fill). Введён
отдельный АВТОМАТИЧЕСКИ разрешаемый статус `TerminalSettlementPending`
(`IOrderStateStore`): блокирует Place/Cancel/strategy (входит в
`hasUnsettledFills`), но НЕ блокирует `ProcessFillUseCase`.

- `UpdateOrderStatusUseCase` при терминальном update с held journal-резервацией
  (обе ветки: с локальным Order и без): CAS save terminal → **резервация НЕ
  освобождается** → ставится pending → pending-cancel marker НЕ снимается.
  Legacy-путь (без journal-резервации) — прежний немедленный release.
- **`SettleTerminalOrdersUseCase`** (периодически + в reconcile loop):
  authoritative `getTrades` (Err → pending ОСТАЁТСЯ: timeout — не
  доказательство отсутствия fill) → непримененные trades ордера прогоняются
  через `fillProcessor` (delayed fill → held-reservation path) → после
  применения ВСЕХ trades journal `remaining` — authoritative остаток:
  Portfolio release remaining → journal release → `SETTLED` → снятие pending +
  placeholder. Частичный сбой settlement → эскалация в manual block + issue.

## Deadlock-safe settlement и lease-fencing (итерация hardening)

### Двухфазный SettleTerminalOrdersUseCase

Settle НЕ вызывает `fillProcessor` под settlement-lock (вложенный захват тех же
`[account, order, instrument]` ключей — deadlock на non-reentrant mutex):

- **Фаза 1 (без lock)**: непримененные trades → `fillProcessor.execute()`
  (ProcessFill берёт mutex сам). `Ok` от processor НЕ означает «применён»
  (BUSY/DUPLICATE/RECONCILIATION no-op тоже `Ok`) — после каждого вызова статус
  ОБЯЗАТЕЛЬНО перечитывается (`getStatus`): только `APPLIED` продолжает.
- **Фаза 2 (под lock)**: re-read pending → re-check статусов всех trades →
  matched-evidence → re-read journal → только затем release + settle.

Интеграционные тесты settle гоняются на РЕАЛЬНОМ общем `InMemoryKeyedMutex`
(регрессия на deadlock).

### begin() внутри keyed mutex (ProcessFillUseCase)

Idempotency guard + lease выполняются ВНУТРИ критической секции: воскресший
worker A (просроченный lease) сначала завершает обработку и выходит из mutex;
worker B входит после и его `begin()` видит актуальный `APPLIED` — «протухший»
ACQUIRED не проносится через границу критсекции. `mark*` в exception handler
разрешены только после нашего ACQUIRED (флаг `acquired`). Reclaim по lease
остаётся для случая «mutex освобождён, а mark* не случился».

### Exact-ID контракт matched/in-flight

`clearOrderFillMatched`/`clearInFlightFill` снимают ТОЛЬКО переданный fillId —
никакой скрытой семантики. Placeholder `pendingMatchFillId(orderId)` снимает
вызывающий код ЯВНО (`ProcessFillUseCase._clearInFlightFlags`, OrderEventBridge
FILL_CONFIRMED, Settle/Update при settlement). Reversal-path (FILL_FAILED)
placeholder намеренно НЕ снимает.

### Account-изоляция terminal settlement

`TerminalSettlementPending.accountId` обязателен;
`getTerminalSettlementPending(accountId)` фильтрует по аккаунту; перед release
сверяется `journalRecord.accountId === pending.accountId` (несовпадение →
эскалация, НЕ release). Grace period `minSettleDelayMs` (default 30s) — время
venue trades API догнать terminal update перед доверием к пустому ответу.

### Операторский bind: size-проверки

`BIND_VENUE_ORDER`/OPEN_ORDER — полный `size` venue-ордера обязан равняться
`effectiveSize ?? requestedSize`; TRADE — суммарный размер trades не превышает
его. Несовпадение → Err без записи binding-связи.

### CancelBoundVenueOrderUseCase (закрытие BOUND_AWAITING_ORDER_RECOVERY)

Операторская отмена привязанного live venue-ордера без локального Order:
venue cancel → confirmed. Held-остаток (если был) **НЕ освобождается сразу**
(та же delayed-fill race, что и в `UpdateOrderStatusUseCase` — partial fill мог
случиться на venue до/во время cancel, а событие о нём ещё не дошло локально):
ставится `TerminalSettlementPending` + blocking placeholder →
`submissions.markCancelled` (терминальный статус `CANCELLED`, НЕ `FAILED` — см.
ниже) → снятие manual block (delayed Fill должен пройти) →
`CANCELLED_SETTLEMENT_PENDING`. Authoritative release остатка выполняет
`SettleTerminalOrdersUseCase` ПОСЛЕ применения всех venue trades — тот же
механизм, что и для CANCELLED/EXPIRED/REJECTED update-ов на живом Order.
`ALREADY_FILLED` → placeholder markers + снятие блока (fill придёт held-path).
Неоднозначные исходы → блок остаётся + issue. Для будущего восстановления
локального Order submission record расширен `assetId`/`strategyId`
(заполняются в `begin()`).

### CANCELLED — терминальный submission-статус без права на resubmit

`markFailed` семантически означает «ордер точно не создан, retry безопасен».
Для `CancelBoundVenueOrderUseCase` это неверно: venue-ордер ДЕЙСТВИТЕЛЬНО
существовал и был операторски отменён. Отдельный статус `CANCELLED`
(`IOrderSubmissionRepository.markCancelled`) не даёт `begin()` под тем же
`clientOrderId` перейти в `FAILED_RETRYABLE` — вместо этого возвращается
`{ outcome: 'CANCELLED_NO_RESUBMIT' }` НАВСЕГДА (резервация не проверяется,
статус сам по себе терминален). `PlaceOrderUseCase` обрабатывает этот outcome
как `UNKNOWN` — Err + issue, без submit. Новый ордер обязан использовать
новый `clientOrderId`.

`CancelBoundVenueOrderOutcome` различает `CANCELLED_SETTLEMENT_PENDING` (был
held-остаток — `TerminalSettlementPending` реально создан) и `CANCELLED`
(нечего было ждать — held-остаток отсутствовал, `TerminalSettlementPending`
НЕ создавался). Outcome не должен намекать на pending, которого нет.

### Контракт полноты getTrades — реализован (cursor pagination + `requireCursor` + статус)

`IExchangeClient.getTrades` документирует контракт: `Ok([])` трактуется как
authoritative отсутствие fills — реализация обязана обеспечивать окно/
пагинацию/лаг либо возвращать `Err`. Polymarket-адаптер теперь ЭТОТ контракт
реально выполняет:

- **Cursor pagination**: `PolymarketUserTradesRestClient.getUserFills` следует
  по `next_cursor` (base64 offset) до сентинела `"LTE="` (страниц больше нет);
  `MAX_PAGES` (40) — защита от бесконечного цикла: при его исчерпании БЕЗ
  сентинела метод бросает `Error` вместо молчаливого возврата частичного
  списка (адаптер конвертирует throw → `Err`, settle держит pending).
- **`requireCursor: true`** (используется ТОЛЬКО `getTrades()`): bare-array
  ответ либо объектный ответ БЕЗ `next_cursor` (не на сентинеле) — schema
  drift, а НЕ «страниц больше нет» — бросает `Error`. Non-critical helper-
  методы (`getTotalVolume`/`getFillStats`) НЕ передают этот флаг, сохраняют
  прежнее толерантное поведение (не authoritative).
- **Без `_userTradesClient`**: `getTrades()` возвращает `Err` немедленно —
  legacy `getFilledOrders()` fallback (только первая страница) удалён из
  этого пути: полноту без L2-аутентифицированного клиента доказать нельзя.
- **On-chain статус**: реальный API возвращает `status` с префиксом
  `TRADE_STATUS_*` (`TRADE_STATUS_CONFIRMED` и т.д.) — раньше терялся при
  парсинге и хардкодился в `'CONFIRMED'`; теперь нормализуется (префикс
  снимается) и попадает в `VenueTradeSnapshot.status`.

### Единый WS/REST fill-mapper (P0: fillId mismatch + чужие maker-ордера)

REST и WS раньше использовали РАЗНЫЕ реализации разворачивания
`maker_orders[]`:

- REST (`_expandUserFill`) безусловно разворачивал ВЕСЬ массив в составной
  `${tradeId}:${orderId}` fillId — без проверки владения (чужой maker-ордер
  в том же match-событии принимался бы за наш → **Portfolio/Ledger corruption
  чужими данными**);
- WS (`FillMapper.allFromPolymarketTradeEvent`) уже фильтровал по `owner`
  UUID/`maker_address` и использовал bare `tradeId` при ЕДИНСТВЕННОМ своём
  ордере — composite ID только при НЕСКОЛЬКИХ. Расхождение схемы fillId
  означало, что WS применял fill как `trade-1`, а REST reconciliation того же
  fill видел `trade-1:order-a` — **другой fillId** → `IProcessedFillRepository`
  считал его новым → direct-fill path применял его ПОВТОРНО (double
  accounting).

Исправление: `packages/infrastructure/polymarket/adapters/mapUserFillsToVenueTrades.ts`
переиспользует `FillMapper.allFromPolymarketTradeEvent` (ту же реализацию,
что и WS) — REST-запись лишь нормализуется под ожидаемые поля (`match_time`
→ `timestamp`, статус без `TRADE_STATUS_` префикса), `maker_address`
инжектируется из credentials (`PolymarketExchangeClientAdapter`-конструктор,
параметр `makerAddress`, тот же, что уже передавался в `UserEventFeedAdapter`)
— НЕ берётся из ответа API (server-provided top-level `maker_address`
ненадёжен для cross-outcome записей, тот же принцип, что
`UserEventFeedAdapter._mapFillDto`). `_expandUserFill`/собственная fillId-схема
REST-адаптера удалены полностью — один маппер, одно правило владения, одно
правило fillId, используемое ОБОИМИ путями.

### Fail-closed на ошибку маппинга (P0, итерация после единого маппера)

Изначальная версия `mapUserFillToVenueTradeSnapshots` логировала `Err` от
`FillMapper` и возвращала `[]` — казалось безопасным («не наша запись,
пропускаем»), но `/data/trades` с L2-аутентификацией возвращает ТОЛЬКО записи,
где мы участник (taker либо хотя бы один maker в matched-событии) — это НЕ
публичный feed. Значит `Err` от `FillMapper` на такой записи означает «это
наша запись, но мы не смогли её разобрать» (баг маппинга/schema drift), а НЕ
«легитимно не наша». Молчаливое исключение отдавало `SettleTerminalOrdersUseCase`
authoritative-пустой snapshot там, где fill реально существовал → release
held reservation ошибочно.

Исправление: `mapUserFillToVenueTradeSnapshots` теперь возвращает
`Result<VenueTradeSnapshot[], Error>`; `PolymarketExchangeClientAdapter.getTrades`
пробрасывает ПЕРВЫЙ же `Err` наружу как `Err` всего запроса (не частичный
`Ok`) — retry на следующем прогоне, капитал остаётся held, а не ошибочно
released. Дополнительно: `getTrades()` требует настроенный `makerAddress`,
если сконфигурирован `_userTradesClient` — без него cross-outcome MAKER-записи
систематически не проходили бы owner-matching (fallback только по
`maker_address`), и с fail-closed маппингом это превратилось бы в постоянно
проваливающийся `getTrades()` без явного объяснения; теперь — явная ошибка
конфигурации при первом вызове.

### Операторский TRADE bind: только полное покрытие size (P1)

`_bindTrade` снимает manual block и снимает fill-markers СРАЗУ после bind
(держится и до этого только сам факт unsettled evidence) — до этой правки
size-проверка допускала `cumulativeSize <= requestedSize`, то есть PARTIAL
исполнение (например 50 из 100) успешно bind-илось. После этого: block снят,
markers сняты (`ProcessFillUseCase` снимает их при успешном применении),
`TerminalSettlementPending` для этого пути НЕ создаётся (в отличие от
CANCELLED/EXPIRED/REJECTED через `UpdateOrderStatusUseCase`/
`CancelBoundVenueOrderUseCase`) — остаток reservation (`PARTIALLY_SETTLED`,
remaining > 0) оставался БЕЗ какого-либо recovery-механизма: ничто и никогда
больше на него не смотрело.

Гейт "order всё ещё открыт" (см. выше) уже отсеивает опасный случай, когда
остаток реально ещё стоит в стакане — значит partial trades здесь означают
ордер, который частично исполнился и после этого исчез с venue книги без
объяснения (недостаточно данных для безопасного bind в любом случае).
Исправление: `_bindTrade` требует `cumulativeSize.equals(requestedSize)`
(было `<=`) — Err при любом несовпадении, в т.ч. partial. Симметрично уже
существующему требованию `_bindOpenOrder` (тот всегда требовал точного
совпадения size). Полноценный recovery для genuinely-partial-then-terminated
ордеров (например отдельный `BOUND_PARTIAL_SETTLEMENT_PENDING`, маршрутизация
остатка через `SettleTerminalOrdersUseCase`) — возможное будущее расширение,
не реализовано: пока безопаснее оставить капитал frozen под manual block, чем
разрешить bind без recovery-пути для остатка.

### ENABLE_AUTO_TERMINAL_SETTLEMENT: единая точка гейтинга (P1)

Флаг изначально гейтил только периодический таймер в `main.ts` — но
`orderReconciler.reconcile()` (`buildLiveInfra.ts`) безусловно вызывал
`settleTerminalOrdersUseCase.execute()` независимо от таймера, а сам
`reconcile()` вызывается на КАЖДЫЙ startup И на КАЖДЫЙ WS reconnect —
`ENABLE_AUTO_TERMINAL_SETTLEMENT=false` фактически НЕ гарантировал отключение
automatic release. Исправление: `BuildLiveInfraParams.enableAutoTerminalSettlement`
(default `false`) — `main.ts` читает `process.env.ENABLE_AUTO_TERMINAL_SETTLEMENT`
ОДИН раз (до `buildLiveInfra()`) и передаёт ОДНО и то же значение и в
`buildLiveInfra()` (гейтит `reconcile()`), и для гейтинга периодического
прямого вызова `settleTerminalOrdersUseCase.execute()` — единственный источник
истины, оба места читают из одной переменной, не из `process.env` дважды.

### Единая классификация on-chain статуса trade (`venueTradeStatusPolicy`)

Общий helper (`services/venueTradeStatusPolicy.ts`) с двумя профилями:

- `recovery` (`ReconcileTradesUseCase`) — `CONFIRMED` И `MATCHED` (осознанное
  исключение: не терять fill, если REST вернул `MATCHED`, но WS-событие не
  пришло; дубли исключены `IProcessedFillRepository`).
- `settlement` (`SettleTerminalOrdersUseCase`, операторский TRADE bind) —
  ТОЛЬКО `CONFIRMED`. Settlement необратим (снимает блокировку капитала) —
  `MATCHED` ещё может стать `RETRYING`/`FAILED`. Для `FAILED`-trade решение
  зависит от local `IProcessedFillRepository` статуса этого fillId (P1,
  проверено на всех трёх опасных состояниях):
  - `undefined`/`FAILED`/`REVERTED` — локальной commit-активности точно не
    было → безопасно исключить из орбиты settlement (contributes 0, не
    блокирует release остального остатка);
  - `APPLIED` — fill уже применён локально (WS доставил раньше отката) —
    desync, эскалация в manual block, а НЕ тихий пропуск;
  - `RECONCILIATION_REQUIRED` — предыдущая попытка уже ЧАСТИЧНО закоммитила
    Order/Portfolio/Ledger/journal (см. `FillCommitPhase` в
    `ProcessFillUseCase`) — unresolved partial commit, НЕ «fill не применён»
    → тоже эскалация (исключение отсюда посчитало бы authoritative remaining
    БЕЗ учёта уже применённой частичной мутации);
  - `PROCESSING` — конкурентный `ProcessFillUseCase.execute()` МОГ начать
    обработку ДО того, как venue сообщил `FAILED` (trade был `MATCHED` на
    момент `begin()`), и ещё не завершился → `kept` (НЕ excluded): если
    settle release-ит remaining, считая trade «не случившимся», а
    конкурентный процесс тем временем завершится `APPLIED` — та же
    резервация окажется released И consumed одновременно (double-use).

**Venue finality проверяется ПЕРВОЙ, ДО local APPLIED** (и в фазе 1, и в
фазе 2 под lock `SettleTerminalOrdersUseCase`): иначе fill, применённый
`ReconcileTradesUseCase` по более мягкому `'recovery'` профилю (MATCHED
допустим там для WS-race), обошёл бы CONFIRMED-gate здесь — local `APPLIED`
не равно venue finality. Порядок проверки НЕ «сначала local status, потом
venue status» — ровно наоборот.

### ProcessFillUseCase: exception classification внутри keyed mutex

`try/catch` вокруг `_processLocked` перенесён ВНУТРЬ callback,
переданного в `runExclusive` (не вокруг `await runExclusive(...)` снаружи).
`InMemoryKeyedMutex.runExclusive` освобождает lock в `finally` СРАЗУ после
settle-а callback — если классифицировать исключение (`markFailed`/
`markReconciliationRequired`) ПОСЛЕ `await runExclusive(...)`, lock уже
отпущен, и конкурентный `execute()` того же fillId мог бы войти в `begin()`
ДО того, как первый вызов пометит fill терминальным статусом. Перенос
try/catch внутрь callback гарантирует: mark* выполняется, пока lock ещё наш.
Регрессионный тест (`ProcessFillUseCase.integration.test.ts`) использует
controllable fake `IProcessedFillRepository` с управляемым gate на
`markReconciliationRequired`, чтобы детерминированно проверить порядок
`begin()` конкурентного вызова относительно завершения exception handler-а.

### ResolveUnknownSubmissionUseCase: TRADE bind — гейты + немедленное применение

`_bindTrade` — операторский bind, необратим как settlement (снимает manual
block, потребляет held reservation), поэтому ПЕРЕД bind обязательны два гейта:

1. **Order всё ещё открыт на venue** — `getOpenOrders` вызывается ДО bind;
   если `venueOrderId` там присутствует, ордер лишь ЧАСТИЧНО исполнен —
   bind-ить как TRADE означало бы снять manual block и оставить остаток
   (ещё стоящий в стакане) невидимым локально ("invisible live order"). Err
   с указанием использовать `candidateKind: 'OPEN_ORDER'` вместо.
2. **On-chain finality** — любой `FAILED` trade → Err немедленно; любой
   НЕ-`CONFIRMED` trade (MATCHED/MINED/RETRYING/undefined) → Err (submission
   остаётся `UNKNOWN`, block держится) — профиль `'settlement'` из
   `venueTradeStatusPolicy`, НЕ более мягкий `'recovery'`.

После прохождения гейтов `_bindTrade` больше не отбрасывает уже полученные
trade snapshots после верификации/bind — `execute()` (ПОСЛЕ выхода из lock,
`fillProcessor` берёт свой mutex сам) прогоняет их через
`fillProcessor.execute()` и проверяет `processedFillRepo.getStatus() ===
APPLIED`. Раньше расчёт был полностью на WS/`ReconcileTradesUseCase`: если
trade исчезал со следующей неполной страницы venue API (см. контракт полноты
выше), markers/held-резервация могли остаться зависшими навсегда без
применённого fill. Неуспех немедленной попытки НЕ меняет исход резолюции
(`BOUND_AWAITING_FILL`) — markers остаются, fill будет ретраится обычным путём.

## CancelOrderOutcome: различение terminal-статусов

`CancelOrderOutcome` различает: `ALREADY_CANCELLED` (CANCELED),
`ALREADY_FILLED` (FILLED — НЕ отмена, экспозиция получена),
`ALREADY_TERMINAL { orderStatus: REJECTED | EXPIRED }` (ордер умер сам).
`ExecutionEngine`-маппинг: `ALREADY_FILLED → PENDING` (блокирует PLACE цикла),
`ALREADY_TERMINAL → TERMINAL_NOOP` (не cancelled++, не блокирует, без
cooldown); `cancelled++`/cooldown — только `CANCELLED`/`ALREADY_CANCELLED`.

## Exception boundaries (P1)

Контракты портов — `Result`, но неожиданный rejected Promise не должен
обходить saga recovery:

- `PlaceOrderUseCase`: `submitOrder` обёрнут — throw консервативно трактуется
  как транспортный `MAY_HAVE_BEEN_SUBMITTED` (Err + reservation held +
  submission UNKNOWN + issue); `cancelOrder` в rollback-ветках обёрнут — throw
  = transport error (политика оставляет резервацию held + issue).
- `PolymarketExchangeClientAdapter`: SELL preflight (`checkBalance`) внутри
  exception boundary — pre-dispatch throw классифицируется как
  `DEFINITELY_NOT_SUBMITTED` (запрос на venue не отправлялся, retry безопасен).
- `ProcessFillUseCase` (held path): rejection `applyReservationTransition`
  ловится и обрабатывается как journal desync (`RECONCILIATION_REQUIRED` +
  manual block), а не пробрасывается.

## Attempt-скоупинг operation IDs

`OrderSubmissionRecord.attempt` начинается с 1; безопасный retry в `begin()`
увеличивает его. Все reservation operation IDs включают attempt:

```
attempt:${attempt}:rollback:definitely-not-submitted
attempt:${attempt}:rollback:rejected
attempt:${attempt}:effective-size-excess-release
attempt:${attempt}:cancel-release
attempt:${attempt}:venue-update-release
attempt:${attempt}:fill:${fillId}
attempt:${attempt}:fill:${fillId}:terminal
```

Так rollback/consume разных попыток одного clientOrderId не считаются
дубликатами (идемпотентность по operationId остаётся в силе внутри попытки).

## Шаги ключевых алгоритмов

### begin() — safe retry guard (InMemoryOrderSubmissionRepository)

1. `FAILED` + reservation `NONE` **или** `SETTLED` с `remaining === '0'` →
   `FAILED_RETRYABLE`, `attempt + 1`, статус `SUBMITTING`.
2. `FAILED` + reservation `HELD` / `PARTIALLY_SETTLED` / `RECONCILIATION_REQUIRED`
   / `remaining > 0` → **`{ outcome: 'RECONCILIATION_REQUIRED', record }`**:
   PlaceOrderUseCase не выполняет risk/reserve/submit, создаёт issue, Err.

### markReservationHeld — разрешённые переходы

- `NONE → HELD`;
- `SETTLED → HELD` — только после увеличения attempt (новая попытка);
- `HELD → HELD` — только идемпотентно с тем же `initial`.

`HELD` с другой суммой, `PARTIALLY_SETTLED`, `RECONCILIATION_REQUIRED`,
повторный hold той же попытки → `Err(ReservationTransitionError)`.

### PlaceOrderUseCase (внутри keyed mutex)

1. **Unsettled-fills guard в самом use-case** (не только в scheduler):
   `hasUnsettledFills(instrumentId)` → Err без begin/reserve/submit.
2. Reserve → `markReservationHeld` **commit-critical**: сбой → submit НЕ
   выполняется, компенсирующий Portfolio release; компенсация успешна →
   `markFailed` (retry безопасен); упала → submission остаётся `SUBMITTING`
   (blocking), journal → `RECONCILIATION_REQUIRED`, `ORDER_PORTFOLIO_DESYNC` issue.
3. `DEFINITELY_NOT_SUBMITTED` / `REJECTED` → общий helper
   `_releaseReservationBeforeRetry`: Portfolio release → journal release →
   проверка `SETTLED/remaining=0` → только потом `markFailed`. Сбой любого шага
   блокирует retry (submission не FAILED) + issue.
4. Post-submit rollback (`_rollbackPostSubmit`): journal release **только после
   успешного Portfolio release**; при сбое Portfolio → journal
   `RECONCILIATION_REQUIRED`. Неоднозначные исходы cancel
   (`ALREADY_FILLED`/`NOT_FOUND`/`UNKNOWN_RETRY_NEEDED`/transport) ставят
   блокирующий instrument-marker (`markInFlightFill` + placeholder).
5. Effective-size: journal excess-release **обязателен** — при сбое local Order
   НЕ создаётся, venue-first rollback уменьшенной резервации + Err.

### ProcessFillUseCase

- **Reservation `RECONCILIATION_REQUIRED` блокирует любой путь** (normal / held
  / direct) до каких-либо мутаций: fill → `RECONCILIATION_REQUIRED`,
  processing-блок сохраняется, issue, Err.
- Held-путь выбирается по `canConsumeHeldReservation` (только
  `HELD`/`PARTIALLY_SETTLED` c `remaining > 0`), а не по `hasHeldReservation`.
- **Превалидация held-fill до Portfolio/Ledger/journal**: account, side,
  instrument, reservation kind (BUY→USDC, SELL→TOKENS), `consumeAmount > 0`,
  `consumeAmount <= remaining`, cumulative fill size ≤
  `effectiveSize ?? requestedSize` (size из capital: BUY — `consumed/orderPrice`,
  SELL — `consumed`). Любой провал → блок без мутаций + issue с
  фактическими/ожидаемыми значениями.
- `PortfolioService.applyFillAgainstHeldReservation` дополнительно defensive
  проверяет `reservationKind` (Err без мутации при несоответствии).
- **Normal-fill journal commit-critical** (`_syncJournalOnNormalFill` →
  `Result`): terminal Order — атомарный transition
  `{ consume, release: remainingBefore − consume }` с operationId
  `attempt:N:fill:ID:terminal` (нет окна между consume и terminal-settle);
  partial — одиночный consume. Сбой после business commit →
  `RECONCILIATION_REQUIRED` + `RESERVATION_JOURNAL_DESYNC` issue, БЕЗ
  `markApplied`/`clearFillProcessing`, fill не retryable.

### CancelOrderUseCase

Порядок после подтверждённого venue cancel: CAS save → enqueue events →
Portfolio release → journal release.

- Portfolio release упал → journal `RECONCILIATION_REQUIRED` (НЕ `SETTLED`),
  блокирующий marker, issue, исход `RECONCILIATION_REQUIRED`.
- Journal release упал (после успешного Portfolio) →
  `RESERVATION_JOURNAL_DESYNC` issue + marker, исход `RECONCILIATION_REQUIRED`.
- `CANCELLED`/`ALREADY_CANCELLED` возвращаются **только после двух успешных
  операций**. Состояние `Portfolio held + journal SETTLED` недостижимо.

### UpdateOrderStatusUseCase

- **Terminal update без local Order** (`CANCELLED`/`REJECTED`/`EXPIRED`):
  `findByVenueOrderId` → проверка account → Portfolio release по
  `reservation.kind`/`remaining` → journal release только после успешного
  Portfolio release. Частичный commit → issue + blocking marker. Фиктивный
  Order не создаётся. Без execution record — прежний desync issue.
- Normal terminal update: journal release только при успешном Portfolio
  release, Result проверяется; сбой → block + issue.
- **Снятие pending cancel marker** (`clearOrderFillMatched` +
  `clearInFlightFill` по `pendingMatchFillId(orderId)`) — только после
  успешного settlement; иначе `hasUnsettledFills` остаётся true (и это
  корректно: блок до реконсиляции).

### ExecutionEngine

`_executeCancel` возвращает `CancelExecutionResult`:

| CancelOrderOutcome        | CancelExecutionResult |
|---------------------------|-----------------------|
| `CANCELLED`               | `CONFIRMED`           |
| `ALREADY_CANCELLED`       | `CONFIRMED`           |
| `FILL_PENDING`            | `PENDING`             |
| `RECONCILIATION_REQUIRED` | `PENDING`             |
| `Err`                     | `FAILED`              |

- `cancelled++` только для `CONFIRMED`; post-cancel cooldown — тоже только
  `CONFIRMED` (cooldown ≠ подтверждение отмены).
- `PENDING` блокирует **все** PLACE intents текущего цикла (включая SELL —
  reconciliation block не обходится по стороне).
- Окончательный контроль остаётся в PlaceOrderUseCase (unsettled-fills guard
  под mutex).

### Outbox enqueue — общий helper

`enqueueCommittedEvents` (`packages/application/use-cases/src/services/enqueueCommittedEvents.ts`)
используется во всех четырёх use-case'ах: проверяет `Result`, не бросает после
business commit, логирует `EVENT_PUBLISH_FAILED` + создаёт issue, НЕ вызывает
`flush()` под lock. Гарантии outbox сохранены: enqueue под mutex, flush после
mutex, FIFO по aggregate, failed head остаётся в очереди.

## Совместимость с будущей persistent-реализацией

Порты (`IOrderSubmissionRepository`, `reservationJournal`) расширены минимально
и типобезопасно: `attempt: number` в записи, новый begin-outcome
`RECONCILIATION_REQUIRED`, код ошибки `RECONCILIATION_LOCKED`, чистая функция
`canConsumeHeldReservation`. Вся арифметика/валидация остаётся в чистых
функциях `reservationJournal.ts` — persistent-адаптер (DB transaction/outbox)
реализует те же переходы поверх своих транзакций.

## Актуальный пример кода (подтверждённый rollback до retry)

```typescript
// PlaceOrderUseCase._releaseReservationBeforeRetry (сокращённо):
const releaseResult = args.releaseReservation();           // 1. Portfolio
if (!releaseResult.ok) {
  await this._markJournalReconciliationRequired(...);       // journal НЕ SETTLED
  await this._addRollbackReleaseIssue(...);                 // blocking issue
  return { releaseError: releaseResult.error.message };     // markFailed НЕ вызывается
}
const r = await submissions.applyReservationTransition(input.orderId, {
  operationId: `attempt:${attempt}:rollback:${slug}`,       // 2. journal (attempt-scoped)
  release: args.reservationInitial,
  now: clock.now(),
});
const settled = r.ok && r.value.reservation.status === 'SETTLED'
  && new Decimal(r.value.reservation.remaining).isZero();
if (!settled) { /* issue, submission остаётся blocking */ return {}; }
await this._markSubmissionFailed(input.orderId, args.failReason); // 3. retry разрешён
```
