# @polymarket/ports

## Обзор

Application-layer порты (Dependency Inversion) — `use-cases`, `handlers`, `strategy` и
`orchestrators` зависят от интерфейсов этого пакета, а не от конкретных инфраструктурных
реализаций (`packages/infrastructure/*`). Пакет содержит только типы и чистые функции —
никакой инфраструктуры, никакого I/O.

## Группы портов

### Repositories/stores с CAS (optimistic concurrency)

`IOrderRepository`, `IPortfolioStore` — хранилища агрегатов с версионированием.
Общий паттерн:

```
getVersion(id)                → текущая версия (0, если записи нет)
save(entity, expectedVersion) → Ok(void) если версия совпала, иначе Err(VersionConflictError)
```

`VersionConflictError` (`resourceId`/`expected`/`actual` — типизированные поля, не только
`message`) — общая ошибка обоих портов. Caller обязан перечитать состояние и повторить
операцию (retry), а не считать конфликт финальной ошибкой.

`IOrderRepository` дополнительно поддерживает условное удаление: `deleteIfVersion` (по
версии) и `deleteIfState` (по допустимым статусам, для cleanup-путей, где важен факт
"ордер терминален", а не конкретная версия) — `OrderStateConflictError`, если фактический
статус не входит в допустимые.

`IOrderStateStore` — синхронный (не CAS, не async) read-only срез ордеров для
`StrategyScheduler`/стратегий, с identity-based (`FillId`) отслеживанием matched/in-flight
fills вместо счётчиков — устраняет гонки partial-fill между собой.

### Idempotency guards / journals

`IProcessedFillRepository` — state machine `PROCESSING → APPLIED/FAILED/
RECONCILIATION_REQUIRED`, защищает от повторного применения одного и того же fill
(подробная диаграмма переходов — в TSDoc файла). `IOrderSubmissionRepository` — журнал
идемпотентности размещения ордера, incorporates `reservationJournal.ts`'s снимки резервации
капитала (`ReservationSnapshot`).

**`reservationJournal.ts`** — чистые функции учёта резервации (USDC для BUY, токены для
SELL): `emptyReservation`/`heldReservation` — конструкторы снимка, `applyReservationDelta` —
применение потребления/освобождения с проверкой инварианта `initial = remaining + consumed +
released`. Суммы — decimal-строки (не `Decimal`/VO) намеренно: порт не должен навязывать
конкретное числовое представление персистентным адаптерам; арифметика инкапсулирована
внутри модуля. Все публичные функции — `Result`-based (`heldReservation()` переведена с
throw в Этапе 5 плана миграции — единственный реальный throw во всём пакете, второй
Result-сосед `applyReservationDelta()` уже был в этой форме).

### Recorders (fire-and-forget запись на диск)

`IMarketDataRecorder.recordEvent(tokenId: InstrumentId, rawEvent)` — сырые WS-события до
преобразования в доменные объекты (для воспроизведения в бектесте); `tokenId` брендирован
в Этапе 10c плана миграции, реальные вызывающие валидируют через `asInstrumentId(...)` с
fail-open (skip + debug-лог) на невалид — recording не должно ронять trading path.
`IDecisionJournal` — структурированные решения стратегии (NDJSON, отдельный файл на
рынок). Брендированы (Этап 10c): `SessionMeta.marketId: MarketId`, `SessionMeta.
instrumentId: InstrumentId`, `DecisionEntry.strategyId: StrategyId`, `OrderEntry`/
`FillEntry`/`CancelEntry.orderId: OrderId`, `ResolutionEntry.marketId: MarketId`.
**Намеренно остаётся `string`**: `marketId` на `DecisionEntry`/`OrderEntry`/`FillEntry`/
`SignalEntry`/`CancelEntry` — это ключ роутинга журнала, на большинстве реальных сайтов
конструирования несёт строковое представление `InstrumentId` (см.
`DecisionJournalRecorder._appendRecord()`'s fallback через `_instrumentIndex`,
резолвящий tokenId → marketId), а не подлинный `MarketId` — брендирование как `MarketId`
было бы типово неверным здесь, не просто механической недоделкой. `SessionMeta.tokenIds`
остаётся `readonly string[]` — нет подходящего branded-типа для списка токенов (тот же
прецедент, что `IMarketDataRecorder.MarketMeta.tokenIds`).

### Exchange / discovery

`IExchangeClient` — торговый клиент (submit/cancel/getTrades), `SubmitOrderResult`/
`CancelOrderResult` — структурированные (не exception-based) исходы, включая ambiguous
(`UNKNOWN` — сабмит ушёл, подтверждение не получено). `SubmitRejectionBalanceMetadata` —
числовая metadata venue-отклонения по балансу (микроединицы, `Decimal`); переиспользуется
`use-cases`'s `PlaceOrderFailureError.balance` напрямую (дедуплицировано в Этапе 10c плана
миграции — раньше `use-cases` держал побитовую копию той же структуры).
`IMarketCatalog` — каталог инструментов.

**`IMarketDiscoveryService`** (`IMarketDiscoveryService.ts`) — обнаружение технически
поддержанного universe рынков площадки: `refresh(options?) → boolean` +
`getSnapshot() → MarketDiscoverySnapshot`. За границей порта нет ни одного vendor-объекта:
единственное представление рынка — доменная сущность `Market` (`@polymarket/market`).
Разделение refresh/getSnapshot сохраняет last-good семантику — временная недоступность
площадки не лишает Application последнего успешного universe.

`MarketDiscoveryDiagnostics.invalidMarkets` — не число, а разбор ПО ПРИЧИНЕ
(`classification`/`eventUnavailable`/`schedule`/`seriesDuration`/`canonicalMapping` + `total`):
один счётчик отвечает «сколько», но не «что сломано», а недоступное событие, нераспознанный
номинал серии и отказ canonical-отображения — операционно разные ситуации. Рядом
`eventFetchFailures` считает СОБЫТИЯ: полный отказ обогащения не делает обход неуспешным
(каталог прочитан, `refresh()` вернёт `true` с пустым universe), и без этого счётчика
«площадка недоступна» неотличимо от «сегодня нет рынков».

Запись снимка — `MarketDiscoveryEntry = { market: Market, metrics: MarketDiscoveryMetrics }`.
Быстро меняющиеся наблюдения (`liquidity: Money`, `spread?: Ratio`) живут РЯДОМ с `Market`,
а не внутри него: `Market` — identity/структура/расписание, и «изменился стакан» не должно
читаться как «изменился рынок». Отсутствующий спред остаётся `undefined` — «неизвестен» и
«нулевой» противоположны. `marketUniverseKey(venueId, marketId)` — единое правило
идентичности рынка для дедупликации discovery и lookup `MarketUniverse`.

Порт НЕ ранжирует рынки: ключевые слова, минимальная ликвидность/спред, предпочтения по
активу и длительности, top-N — owner policy НАД портом (Policy-MR).

**`DiscoveredMarket`** (`DiscoveredMarket.ts`) — LEGACY-контракт, вход V1-адаптера;
исчезнет вместе с V1-путём. Отбор по canonical-записям делает `@polymarket/policy`.
`spread?: Ratio`, `liquidity: Money`,
`eventStartMs?: Timestamp` (все три — Этап 10c плана миграции). `score: Decimal` и
`startsAt?: Timestamp` не меняются: `score` — внутренний sort-key без чистого
VO-отображения (устанавливается `MarketScorer`), `startsAt` — семантически ДРУГОЕ поле,
чем `eventStartMs` ("когда бот начал запись/торговлю", не "когда начинается сам ивент") —
не путать. Единственная точка конструирования (`PolymarketMarketDiscoveryAdapter.
_mapToDiscoveredMarket()`) использует Result-проверенное построение
(`MoneyService.create`/`RatioService.fromDecimal`/`TimestampService.create`) с деградацией
до дефолта/`undefined` при ошибке парсинга — в отличие от `marketId`/`instrumentId`/
`expiresAt` (обязательные поля, ошибка парсинга отбрасывает весь рынок), эти три —
второстепенные, отбрасывать всю находку рынка из-за них не оправдано.

### Прочее

`ICurrentBalanceProvider.getUsdcBalance(): Promise<Money>` (Этап 10c — было `Promise<
Decimal>`; единственный реальный имплементер обёртывал уже-`Money`-результат
`PolymarketBalanceProvider.getAvailableBalance()` через lossy `Money.toNumber() → new
Decimal(...)` раунд-трип — конверсия порта на `Money` убрала этот раунд-трип полностью, не
только типовой долг, реальный precision-фикс). `IFillReverter`, `IFillProcessor`,
`IKeyedMutex`, `IStrategyCommitmentReader`, `IReconciliationIssueRepository`,
`IOrderedEventOutbox` — однометодные/узкие порты для конкретных use-case-ов (см. TSDoc
каждого файла — уже исчерпывающий, не дублируется здесь).

## `IMarketFilterConfig` удалён

Порог-конфиг старого отбора (`minTimeToExpiryHours`, `minSpread`, `minLiquidity`,
`maxMarketsToReturn`, `minDurationMinutes`/`maxDurationMinutes` + keyword-массивы) больше
не существует. Его заменил `PolymarketPolicy` из `@polymarket/policy` — не переименованием,
а другим контрактом: пороги там выражены canonical-типами (`Money`, `Ratio`,
`MarketDuration`, `CryptoAssetId`), потому что policy сравнивается с canonical `Market`, и
примитив на этой границе означал бы конверсию на каждом сравнении плюс молчаливую
возможность сопоставить миллисекунды с минутами.

Три поля не мигрировали сознательно: `maxMarketsToReturn` (количество выбирает
потребитель — `ranked.slice(0, n)`), `minTimeToExpiryHours` и duration-диапазон в минутах
(это lifecycle/lead-time, он принадлежит будущему Subscription Planner, а не
owner-селектору).

## Что отложено и почему

Полное расследование — Этапы 5 и 10c плана миграции
(`/Users/menvil/.claude/plans/synthetic-swimming-heron.md`). Большая часть Этапа 5's
исходного списка ("что отложено") уже решена в Этапе 10c — см. "Recorders" и "Exchange /
discovery" выше для подробностей по `IDecisionJournal`/`IMarketDataRecorder`/
`DiscoveredMarket`/`ICurrentBalanceProvider`. Остаётся отложенным:

- **`strategyId?: string`** в `IOrderRepository`, `IOrderStateStore`,
  `IStrategyCommitmentReader`, `IExchangeClient`, `IOrderSubmissionRepository` (5 портов —
  `IDecisionJournal` больше не входит в этот список: `DecisionEntry.strategyId` уже
  брендирован в Этапе 10c). Реальный источник значений — `Order`/`OrderState`/
  `OrderEvent` в `packages/domain/entities/order`, документированный event-replay/
  журнальный формат (`Order.fromEvents(events)` воспроизводит историю без валидации) —
  пакет вне мандата всей этой миграции (Этап 3 дал ему только TSDoc-backfill). Даже
  полная конверсия сигнатур этих 5 портов была бы косметической: реально хранимое/
  сравниваемое поле осталось бы примитивом. `StrategyId` сам по себе уже построен и
  реально используется по всей цепочке `IStrategy`/`ExecutionEngine`/
  `StrategyScheduler`/`apps/bot/strategies/*` (Этапы 1, 10b) — граница валидации между
  этим типизированным миром и сырым `Order`/`OrderEvent`-миром находится в
  `OrderEventBridge.ts` (см. Решение 12, `docs/architecture/boundary-contract.md`), не
  в самих портах.
- **`DecisionJournalRecorder.close()`'s небезопасный `as MarketId`-каст** — пре-
  существующий, некритичный пробел типобезопасности на строковых ключах внутреннего
  `Map`; не относится ни к одной находке Этапа 10c, не форсируется.

## Ссылки

- ADR: `docs/architecture/boundary-contract.md` (Решения 12, 13 — валидация на мосту
  типизированный/сырой мир; персистентный/routing-key паттерн не значит "всё остаётся raw")
- План миграции, Этапы 5 и 10c: `/Users/menvil/.claude/plans/synthetic-swimming-heron.md`
