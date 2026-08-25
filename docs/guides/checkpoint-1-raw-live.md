# CHECKPOINT #1 — Full Raw Live Collection Verification

Контрольная точка после N-005: доказательство на живых данных, что весь
raw live collection contour работает как ОДНА система до semantic boundary.

## Почему это сделано так?

После N-001…N-005 каждый источник и политика хранения были проверены
по отдельности (unit/integration/smoke per package). Checkpoint закрывает
оставшийся риск: **взаимодействие** источников на одном bus, одном
recorder, в одном процессе — routing interaction, давление на общий bus,
общий lifecycle recorder-а, порядок shutdown, изоляция источников.
Отдельные smoke этого не доказывают: нужен один общий interval, где все
источники активны одновременно.

## Верифицированная система

```text
Polymarket CLOB/SDK ──────────────┐
Polymarket RTDS ──────────────────┼──► ExternalMessage
CCXT Pro (6 бирж, spot) ──────────┘
                ↓
     ОДИН ExternalMessageBus<PolymarketExternalMessage | CexExternalMessage>
                ↓
     ОДИН ExternalMessageRecorder (обе storage-политики одного сервиса)
         ↙                                   ↘
  Polymarket market-session            CEX time-window
  (DataRecorder, formatVersion 2)      (CexWindowRecorder, 5m окна)
         ↓                                   ↓
  JSONL → SEAL → Gamma enrichment →    JSONL → flush → close → gzip
  FINALIZED .jsonl.gz                  завершённые .jsonl.gz партиции
```

## Verification runner

`scripts/checkpoint-raw-live.mts` — DEVELOPMENT-ONLY тонкая композиция
поверх production-пакетов (без собственных adapters и преобразований
payload). Расширение `.mts` обязательно: корневой `package.json` без
`"type": "module"`, а все workspace-пакеты — ESM-only.

Шаги runner-а:

1. create shared bus → shared recorder (обе политики);
2. create Polymarket source/discovery/coordinator/finalizer;
3. create 6 × CexSource (binance, coinbase, kraken, cryptocom, okx,
   bybit — подмножество production-конфига legacy-коллектора
   `apps/collect-data/cex-config.json`, по 4 пары на биржу, валидность
   пар подтверждена REST-пробой `loadMarkets`);
4. одновременный live-сбор c cadence как у legacy (discovery 30s,
   fillSlots/finalize 10s) до полного комплекта evidence;
5. controlled shutdown в порядке контура (finalizer → coordinator →
   sources → bus.drain → recorder → bus.close);
6. строгая валидация артефактов (см. ниже) + `report.json`.

Режимы: `CHECKPOINT_MODE=full` (полный lifecycle до FINALIZED-архива) и
`CHECKPOINT_MODE=short` (restart-верификация: ДВЕ последовательные
композиции в одном процессе — ловит state, случайно оставшийся
глобально/статически). Output изолирован: `data/checkpoint-raw-live/<run-id>/`
(в `.gitignore`).

Shutdown full-режима — graceful wind-down (решение user 2026-08-25,
после находки premature-timeout архива): перед закрытием контура runner
вызывает `finalizer.drain()` — уже начатые финализации дожидаются
официальной резолюции Gamma (или полного 60-минутного бюджета), опрос
идёт штатным 30-секундным cadence; `CHECKPOINT_DRAIN=0` отключает,
SIGINT прерывает. Подробности семантики —
`packages/infrastructure/market-finalizer/docs/market-finalization.md`.

Вторая находка того же ревью артефактов: архив существовал, а победителя
в нём не было (UMA-резолюция догоняла позже completion-условия). Теперь
финализация заполняет `finalization.winning` по winner-ladder с
происхождением (`source`/`exact`), и валидатор checkpoint-а требует у
КАЖДОГО complete-архива точного победителя из официального источника
(`resolution` либо `official-prices`), а у любого архива с победителем —
согласованности `source` и `exact`.

### Наблюдаемость checkpoint-а

Существующая observability пакетов (stats-снимки) + два минимальных
средства уровня runner-а (новый metrics framework не вводится):

- независимые подписки-счётчики на том же bus (типы, биржи, фиды,
  монотонность `metadata.sequence`);
- `CountingLogger` — ILogger-обёртка, считающая restart/error-события
  по текстам существующих логов (`Planned restart …`,
  `…failed permanently`, cooldown).

### Exact-match доказательство payload-only

Валидация сравнивает строки файлов с точными JSON-строками payload,
опубликованными на bus:

- CEX: mid-run сэмплы по каждой партиции (биржа×символ×поток) — строка
  обязана присутствовать в завершённой партиции той же identity;
- Polymarket market/RTDS: ring-буферы последних 64 payload-строк,
  замораживаемые в момент выхода рынка из ACTIVE (freeze-лаг опроса
  сессий ≤10s перекрывается глубиной ring-а).

Плюс структурные проверки каждой строки каждого артефакта: JSON parse,
отсутствие envelope-ключей (`metadata`/`messageId`/`sequence`/`runId`/
`correlationId`/`causationId`), классификация market/RTDS/CEX, routing
identity (для CEX — сверка exchange/symbol/marketType/stream строки с
именем и директорией файла).

### Ловушка классификации строк (исправленный дефект runner-а)

RTDS-события SDK несут `type: 'update'` — классификатор строк обязан
проверять RTDS-ветку (`topic.startsWith('prices.crypto.')`) ДО
market-ветки (`topic === 'market'`), иначе RTDS-строки считаются
market-событиями без `payload.market`. Первый полный прогон дал
FAIL-вердикт именно из-за этого дефекта валидатора (контур был исправен);
после исправления повторный полный прогон — PASS.

## Итог прогона 2026-08-25 (run-id `2026-08-25T10-33-22-516Z-full`)

Полный отчёт: `report.json` в директории прогона.

- Длительность: 17.7 мин (10:33:22Z → 10:51:05Z), verdict **PASS**.
- ОДИН bus: 781 358 сообщений, `sequence` строго монотонен (0 нарушений),
  0 rejected publications, 0 handler errors.
- Polymarket: 9 рынков записывались, 6 архивов (3 `complete` с реальным
  Gamma enrichment + 3 `timeout` shutdown-семантики finalizer.close());
  латентность enrichment 6.3–9.3 мин:
  - BTC 6:35–6:40 ET: priceToBeat 79266.93 → finalPrice 79240.91,
    winner **Down**, 115 790 строк;
  - ETH 6:35–6:40 ET: 2477.04 → 2477.50, winner **Up**, 41 764 строки;
  - SOL 6:35–6:40 ET: 99.4546 → 99.3926, winner **Down**, 16 481 строка.
- RTDS: оба topic-а (`prices.crypto.binance`, `prices.crypto.chainlink`),
  6 фидов, 5 375 сообщений, fan-out в файлы рынков (821–954 RTDS-строки
  на архив).
- CEX: 6 бирж × 4 пары × OB+trades; 462 242 сообщения; 144 завершённые
  партиции (24 на биржу), readback 396 732 строки — 0 parse errors,
  0 identity mismatches, 0 envelope leaks, 0 cross-routing;
  exact-match сэмплы 144/144. Разница accepted (420 184) vs readback —
  строки текущих окон, удалённые при shutdown (документированная
  политика).
- 12 плановых рестартов транспорта (15-мин интервал legacy-конфига,
  6 бирж × OB+trades) — все с восстановлением; snapshot failures 0,
  write failures 0, permanent failures 0, error-логов 0.
- Shutdown чистый (все шаги ок, incomplete-файлов нет), процесс завершился
  сам (без `process.exit`); unhandled rejections 0.
- Restart-верификация (`CHECKPOINT_MODE=short`): две последовательные
  композиции в одном процессе — обе start/collect/shutdown чисто.

## Сопутствующий фикс quality-gate

`npm test` на корне падал ДО checkpoint-а: root-скрипт использовал
`npm run test --workspaces` без `--if-present`, а у двух legacy-app
workspaces (`apps/collect-data`, `apps/pnl`) нет script `test` — npm
завершался ошибкой ПОСЛЕ зелёного прогона всех реальных suites.
Исправлено добавлением `--if-present` (паттерн уже использовался в этом
же `package.json` для `lint:md`).

## Что checkpoint НЕ делает

Semantic Adapter (Polymarket/CEX), Application/Risk/Use Cases/Strategies,
reader/replay, legacy cleanup — сознательно не начаты (граница
checkpoint-а — RAW contour).

## Deferred cleanup candidates (НЕ удалялись)

Зафиксированы для будущего repo-wide dead-code audit (после consumer
cutover):

- `apps/collect-data` — legacy коллектор (`main.ts`, `config.ts`,
  `checkCexSnapshot.ts`) поверх legacy WS/discovery;
- `packages/infrastructure/cex-market-data` — legacy CEX path
  (`CcxtExchangeWatcher`, `CcxtSymbolWatcher`, `CexFileRotator`,
  `CexCollectorService`, свой `RestartingTask`);
- `packages/infrastructure/polymarket` — legacy WS/REST/catalog path
  (`ws/`, `rest/`, `catalog/`, `dns/`) — трогать только после переделки
  ExecutionEvent/polymarket-пакета (решение зафиксировано ранее);
- legacy discovery в `packages/application/market-discovery` использует
  V2 только частично (фильтр/скорер переиспользованы N-003 — сам пакет
  не legacy, кандидат только его legacy-обвязка, если останется).
