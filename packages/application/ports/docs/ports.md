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

`IMarketDataRecorder` — сырые WS-события до преобразования в доменные объекты (для
воспроизведения в бектесте). `IDecisionJournal` — структурированные решения стратегии
(NDJSON, отдельный файл на рынок) — см. "Что отложено и почему" ниже.

### Exchange / discovery

`IExchangeClient` — торговый клиент (submit/cancel/getTrades), `SubmitOrderResult`/
`CancelOrderResult` — структурированные (не exception-based) исходы, включая ambiguous
(`UNKNOWN` — сабмит ушёл, подтверждение не получено). `IMarketCatalog` — каталог
инструментов. `IMarketDiscoveryService` — обнаружение новых рынков (Gamma API).
`IMarketFilterConfig` — пороги фильтрации кандидатов (см. ниже, почему это не VO).

### Прочее

`ICurrentBalanceProvider`, `IFillReverter`, `IFillProcessor`, `IKeyedMutex`,
`IStrategyCommitmentReader`, `IReconciliationIssueRepository`, `IOrderedEventOutbox` —
однометодные/узкие порты для конкретных use-case-ов (см. TSDoc каждого файла — уже
исчерпывающий, не дублируется здесь).

## Почему `IMarketFilterConfig`'s пороги остаются `number`

Все 8 полей (`minTimeToExpiryHours`, `minSpread`, `minLiquidity`, `maxMarketsToReturn`,
`minDurationMinutes`, `maxDurationMinutes` + 3 keyword-массива) — пороги сравнения внутри
`MarketFilter.filterCandidates()`, не единичные измеренные величины. Тот же принцип, что
уже применён в Этапе 2 (`market-state`'s `lookbackMs`/`staleMs`) и Этапе 4
(`DetectorConfig.minSpreadAfterFees`): конфиг-пороги не переводятся на VO — VO даёт
безопасность единиц измерения там, где значение течёт через систему и может быть спутано
с другим по смыслу числом; порог, который только сравнивается с одним конкретным полем в
одном конкретном фильтре, такой защиты не требует, а конструирование `Ratio.of()`/`Price.of()`
на каждый конфиг добавляет только шум.

## Что отложено и почему

Полное расследование — Этап 5 плана миграции
(`/Users/menvil/.claude/plans/synthetic-swimming-heron.md`, раздел "### Этап 5"). Коротко:

- **`IDecisionJournal.ts`** — record-типы (`DecisionEntry`/`OrderEntry`/`FillEntry`/
  `SignalEntry`/`CancelEntry`/`SessionMeta`) остаются на `string`/`number`, несмотря на
  внутреннюю несогласованность (`endSession(marketId: MarketId, ...)` уже типизирован,
  сами записи — нет). Причина: реальная реализация (`DecisionJournalRecorder` в
  `packages/infrastructure/persistence/data-collection`) и реальные потребители (12 файлов
  `apps/bot/src/strategies/*` + 2 файла `apps/bot/src/bot/`) целиком в периметре Этапов
  9-10 плана миграции — смена типов здесь без синхронной правки всех 14+ файлов сломала
  бы сборку до завершения тех этапов.
- **`IMarketDataRecorder.recordEvent(tokenId: string)`** — не переведён на `InstrumentId`.
  Реальные вызывающие (`apps/collect-data/src/main.ts`, `apps/bot/src/bot/
  buildRecording.ts`, `packages/infrastructure/polymarket/adapters/
  MarketDataFeedAdapter.ts`) — тоже Этап 10 (последний файл явно назван в списке Этапа 10
  master-плана). Остальная часть интерфейса (`MarketMeta.marketId: MarketId`, `startsAt`/
  `expiresAt: Timestamp`) уже полностью на VO.
- **`IMarketFilterConfig`** — не трогается вообще (см. раздел выше — пороги, не величины).
- **`strategyId?: string`** (в `IOrderRepository`, `IOrderSubmissionRepository`,
  `IExchangeClient`) — уже решено в Этапе 1 плана миграции: `StrategyId` (branded)
  построен, но подключение к этим 6 портам явно отложено на Этап 9.

## Ссылки

- ADR: `docs/architecture/boundary-contract.md`
- План миграции, Этап 5: `/Users/menvil/.claude/plans/synthetic-swimming-heron.md`
