# @polymarket/collect-data

## Обзор

Автономный сборщик сырых рыночных данных без торговой логики: подписывается на
Polymarket (market-события + RTDS-цены) и публичные потоки CEX, публикует их в общий
`ExternalMessageBus` и пишет на диск payload-строки для последующего реплея через
`@polymarket/backtesting`. Плюс набор CLI-инструментов анализа собранных
CEX/Chainlink-данных, используемых при калибровке crypto-сигналов стратегий.

| Файл                          | Назначение                                                        |
| ----------------------------- | ----------------------------------------------------------------- |
| `main.ts`                     | Тонкий bootstrap: конфиг → логгер → process-подготовка → рантайм    |
| `config.ts`                   | `CollectorConfig` — загрузка настроек из `.env`                     |
| `runtime/DataCollector.ts`    | Рантайм: composition, lifecycle источников, расписание, статус      |
| `runtime/createDataCollector.ts` | Composition root контура (bus, recorder, sources, control plane) |
| `runtime/DataCollectorConfig.ts` | Конфигурация рантайма + граница «внешний конфиг → V2»            |
| `runtime/collectionLifecycle.ts` | Read-only проекция lifecycle рынков                              |
| `runtime/processBootstrap.ts` | DNS-обход и единый охраняемый путь остановки                        |
| `analyzeChainlinkLeadLag.ts`  | CLI: корреляционный анализ lead-lag CEX microprice vs Chainlink      |
| `fitChainlinkLinearModels.ts` | CLI: Ridge-регрессия по тем же данным — веса бирж, горизонт          |
| `checkCexSnapshot.ts`         | CLI: валидация качества CEX JSONL.GZ снапшотов                       |
| `backfillPolymarketMeta.ts`   | CLI: перезапись meta-строки уже архивных снапшотов задним числом      |

```bash
# Dev (hot-reload):
npm run dev -w @polymarket/collect-data

# Production:
npm run build -w @polymarket/collect-data && npm start -w @polymarket/collect-data
```

## Контур сбора (после Collector-cutover)

Сборщик больше НЕ владеет источниками. Источники создаёт и закрывает общий
control-plane; сборщик — обычный владелец claim-ов (`collector:raw`) и обычный
подписчик шины.

```text
PolymarketControlRuntime → PolymarketSubscriptionController → PolymarketSource ─┐
CexSubscriptionController → CexSource generations ─────────────────────────────┤
                                                                               ▼
                                                              ОДИН ExternalMessageBus
                                                                ├── Collector (recorder + gate)
                                                                ├── PolymarketSemanticAdapter
                                                                └── CexSemanticAdapter
```

Два жёстких инварианта процесса: **один bus** и **один recorder**. На диск
попадает исключительно source-native `message.payload`. Collector — sibling
consumer, а не gate перед семантикой.

Управление сбором — прямые вызовы control-plane каждый control-тик:

```text
collector demand (collector:raw)     →  PolymarketControlRuntime.runOnce()
collector CEX demand (per exchange)  →  CexSubscriptionController.reconcile()
```

Допуск Polymarket-рынка к записи по первому наблюдению — `PolymarketCollectionGate`
(`@polymarket/collector`): по canonical `MarketUniverse` + owner policy, передаётся
recorder-у как `sessionProvider`. `DataCollector` оркестрирует control-тик, но
собственного рыночного состояния не держит. Координатора и финализатора в
композиции больше нет — expiry/finalization/RTDS-запись вынесены в следующий
этап (см. `docs/guides/collector-cutover.md`).

## Lifecycle рантайма

### Старт

```text
startup cleanup → recorder.start() → control-loop (runOnce + reconcile)
```

Recorder подписывается на bus ДО первого control-тика — иначе первое наблюдение
приобретённого рынка ушло бы в bus, не попав на диск. Отказ любого шага откатывает
уже поднятые ресурсы и отклоняет `start()`.

### Остановка

```text
control-loop → cexController.close → pmController.close → PM source.close
             → SDK client.closeSubscriptions → bus.drain → recorder.close → bus.close
```

Сначала снимается спрос-владение: CEX-контроллер закрывает СВОИ источники,
PM-контроллер снимает claim-ы и RTDS-ссылки (общий PM source он НЕ закрывает).
Затем закрывается общий PM source и его shared realtime, и только потом очередь
bus дренируется В recorder. `close()` идемпотентен и best-effort. `process.exit()`
не используется.

Отдельный шаг — `closeSubscriptions()` официального SDK-клиента. Клиент общий для
source и discovery, и shared websocket-соединения принадлежат ему, а не подпискам.
Шаг идёт сразу ПОСЛЕ закрытия source — раньше это рвало бы соединение под работающим
итератором.

Запуск и остановка сериализованы: сигнал, пришедший во время `start()`, дожидается
завершения подъёма и только потом гасит контур — иначе остановка «закрыла» бы
источники, которые запуск продолжает поднимать.

`SIGINT`, `SIGTERM` и фатальная ошибка сходятся в ОДИН охраняемый путь остановки:
повторный сигнал не запускает вторую параллельную остановку.

## Наблюдаемость

`collector.status()` отдаёт снимок операционного состояния: состояние рантайма и
время работы, claim-ы/подписки PM-контроллера, пулы CEX-контроллера, счётчики
допуска рынков (`gate`: admitted/ignoredUnknownMarket/ignoredByPolicy),
статистику recorder/CEX-окон/bus и здоровье общего PM-source. Все значения —
существующие `getStats()` компонентов; собственных метрик рантайм не заводит.
`main.ts` печатает этот снимок раз в минуту вместе с потреблением памяти.
Lifecycle-события сбора (`DISCOVERED`/`FINALIZING`/...) убраны вместе с
координатором — они вернутся на этапе полного CollectionSession lifecycle.

## Раскладка датасетов

```text
{DATA_COLLECTION_OUTPUT_DIR}/
  {YYYY-MM-DD}/
    polymarket/polymarket_{question}___{marketId}.jsonl[.gz]
    {exchangeId}/{exchange}_{symbol}_{marketType}_{stream}_{dateET}_{startET}-{endET}_ET.jsonl[.gz]
```

`.jsonl` = незавершённый файл, `.jsonl.gz` = завершённый архив. Незавершённые остатки
предыдущего запуска удаляются при старте: восстановлению они не подлежат.

Polymarket-архивы пишутся с `formatVersion: 2` — строки 2+ содержат source-native
события официального SDK. Первая строка (meta-header) определяет, каким парсером
читать остальные.

## Конфигурация

Настройки берутся из `.env` (см. файл в корне приложения). Ключевые:

| Переменная                       | Назначение                                        |
| -------------------------------- | ------------------------------------------------- |
| `DATA_COLLECTION_OUTPUT_DIR`     | Корень датасетов (общий для обеих политик)         |
| `DATA_COLLECTION_MAX_MARKETS`    | `acquireLimit`: сколько кандидатов плана приобретать за тик |
| `DATA_COLLECTION_COMPRESSION`    | `none` \| `gzip`                                   |
| `COLLECTOR_POLICY_ASSETS`        | Активы owner policy (`btc,eth`; пусто — любой)      |
| `COLLECTOR_POLICY_DURATIONS`     | Номиналы серий owner policy (`5m,15m`; пусто — любой) |
| `MARKET_DISCOVERY_*_KEYWORDS`    | Keyword-селекторы → `PolymarketPolicy.title`        |
| `MARKET_DISCOVERY_MIN_SPREAD` / `_MIN_LIQUIDITY` | Пороги → `minSpread`/`minLiquidity` policy |
| `DISCOVERY_WINDOW_HOURS`         | Окно обзора каталога (по умолчанию 2ч)              |
| `COLLECTOR_CONTROL_TICK_MS`      | Пауза между control-тиками (по умолчанию 5000)      |
| `CEX_CONFIG_FILE` / `CEX_CONFIG` | Конфигурация бирж; не задана — CEX выключен         |
| `CEX_ORDERBOOK_METHOD` / `CEX_RESTART_INTERVAL_MS` | Транспорт CEX-источников (не входит в CexPolicy) |
| `CEX_WINDOW_MINUTES`             | Размер окна партиции (по умолчанию — 5)             |
| `DNS_OVERRIDE_ENABLED`           | Обход подменённого DNS провайдера                   |

Отбор рынков теперь — owner policy (`family CRYPTO_UP_DOWN` + активы/номиналы/
keyword-селекторы), а не keyword-фильтр discovery. Формат `cex-config.json`
сохранён (ключ = `exchangeId`), но каждая биржа превращается в отдельную
`CexPolicy` — точный список её символов не размывается декартовым произведением.
Невалидная policy-конфигурация не даёт процессу стартовать (fail-fast).

## CLI-инструменты калибровки crypto-сигналов

`analyzeChainlinkLeadLag.ts`/`fitChainlinkLinearModels.ts` — оффлайн-анализ записанных
CEX+Chainlink снапшотов для калибровки сигнала `cex_chainlink_lead_lag` в
`CryptoSignalRegistry` (`@polymarket/market-state`): первый оценивает предсказательную
силу microprice отдельных бирж корреляцией, второй строит Ridge-регрессионные модели
поверх тех же входных окон. Результат калибровки переносится в конфигурацию стратегии
вручную.

`checkCexSnapshot.ts` — предварительная диагностика перед прогоном анализа:
невалидный JSON, crossed orderbook, нарушение сортировки уровней, non-monotonic
timestamp, покрытие символа сделками.

## Ссылки

- Collector-cutover (этот этап): `docs/guides/collector-cutover.md`
- Политика допуска: `packages/infrastructure/collector/docs/collector.md`
- Предыдущий V2-cutover: `docs/guides/data-collector-v2-cutover.md`
- CHECKPOINT #1: `docs/guides/checkpoint-1-raw-live.md`
- TWAP settlement и резолюция архивов: `docs/guides/twap-settlement-and-resolution.md`
- `@polymarket/data-collection`: `docs/architecture/data-collection.md`
- `@polymarket/market-discovery`: `docs/guides/multi-market.md`
- ADR: `docs/architecture/boundary-contract.md`
