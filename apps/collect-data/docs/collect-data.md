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

## Контур сбора

```text
PolymarketSource ─┐
(market + RTDS)   │
                  ├──► ОДИН ExternalMessageBus ──┬──► ExternalMessageRecorder ──► JSONL
CexSource[] ──────┘                              │      (PM-политика + CEX-политика)
(orderbook+trades)                               └──► любой другой consumer
```

Два жёстких инварианта процесса: **один bus** и **один recorder**. Отдельных
Polymarket/CEX/RTDS-шин не существует; под единственным recorder живут две
storage-политики — market-сессии и CEX-окна.

Весь ingress идёт только `source → bus`. Recorder — обычный подписчик bus, а не
привилегированная цель прямых вызовов source-ов; на диск попадает исключительно
source-native `message.payload` без canonical runtime-metadata.

Управление сбором:

```text
PolymarketMarketDiscovery  →  MarketCollectionCoordinator  →  MarketFinalizer
    «что доступно»              «что записываем сейчас»        «как закрываем»
```

`DataCollector` оркестрирует их тиком (`fillSlots` + `runOnce`), но собственного
рыночного состояния не держит.

## Lifecycle рантайма

### Старт

```text
startup cleanup → recorder.start() → CEX sources → runtime loop
```

Recorder подписывается на bus ДО старта ingress — иначе первые сообщения ушли бы в
bus, не попав на диск. Отказ любого шага откатывает уже поднятые ресурсы в обратном
порядке и отклоняет `start()`: контур либо работает целиком, либо не оставляет за
собой ни открытых потоков, ни таймеров.

### Остановка

```text
runtime loop → finalizer → coordinator → PM source → SDK client realtime
             → CEX sources → bus.drain() → recorder.close() → bus.close()
```

Сначала глохнет ingress, затем очередь bus дренируется В recorder, и только потом
закрывается сам recorder. `close()` идемпотентен и best-effort: отказ одного шага
логируется и не отменяет остальные. `process.exit()` не используется — процесс
обязан завершиться сам, иначе живой хэндл остался бы незамеченным.

Отдельный шаг — `closeSubscriptions()` официального SDK-клиента. Клиент общий для
source, discovery и финализатора, и shared websocket-соединения принадлежат ему, а не
подпискам: снятие подписок источником их не закрывает. Шаг идёт сразу ПОСЛЕ закрытия
source — раньше это рвало бы соединение под работающим итератором.

Запуск и остановка сериализованы: сигнал, пришедший во время `start()`, дожидается
завершения подъёма и только потом гасит контур — иначе остановка «закрыла» бы
источники, которые запуск продолжает поднимать.

`SIGINT`, `SIGTERM` и фатальная ошибка сходятся в ОДИН охраняемый путь остановки:
повторный сигнал не запускает вторую параллельную остановку.

### Опциональный drain

`collector.drain()` дожидается официальных резолюций уже начатых финализаций. Штатная
остановка по сигналу его НЕ вызывает: ожидание измеряется десятками минут и не
укладывается в `kill_timeout` супервизора. Вызов уместен для контролируемых прогонов
(например, verification-runner checkpoint-а).

## Наблюдаемость

```typescript
const off = collector.onMarketLifecycle((event) => {
  if (event.kind === 'FINALIZED') archived.push(String(event.marketId));
});
```

События: `DISCOVERED`, `COLLECTION_STARTED`, `FINALIZING`, `FINALIZED`, `DROPPED`.
Это operational-состояние сбора, а не domain-события и не trading lifecycle.

`collector.status()` отдаёт снимок: состояние рантайма и время работы, сессии
координатора, финализации, статистику recorder/CEX-окон/bus и здоровье каждого
source поимённо. Все значения — существующие `getStats()` компонентов; собственных
метрик рантайм не заводит. `main.ts` печатает этот снимок раз в минуту вместе с
потреблением памяти.

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
| `DATA_COLLECTION_MAX_MARKETS`    | Максимум одновременных collection-сессий            |
| `DATA_COLLECTION_COMPRESSION`    | `none` \| `gzip`                                   |
| `MARKET_SCAN_PAUSE_MS`           | Период обновления кэша кандидатов                   |
| `MARKET_DISCOVERY_*`             | Фильтр кандидатов (ключевые слова, пороги)          |
| `CEX_CONFIG_FILE` / `CEX_CONFIG` | Конфигурация бирж; не задана — CEX выключен         |
| `CEX_WINDOW_MINUTES`             | Размер окна партиции (по умолчанию — 5)             |
| `DNS_OVERRIDE_ENABLED`           | Обход подменённого DNS провайдера                   |

Формат `cex-config.json` сохранён от прежнего коллектора (ключ словаря =
`exchangeId`); конверсия имён полей в словарь `@polymarket/cex-v2` выполняется на
границе в `runtime/DataCollectorConfig.ts`. Невалидная CEX-конфигурация не даёт
процессу стартовать — прежний коллектор в этом случае молча продолжал БЕЗ CEX, и
прогон выглядел живым, хотя половина датасета не писалась.

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

- Cutover-обоснование: `docs/guides/data-collector-v2-cutover.md`
- CHECKPOINT #1: `docs/guides/checkpoint-1-raw-live.md`
- TWAP settlement и резолюция архивов: `docs/guides/twap-settlement-and-resolution.md`
- `@polymarket/data-collection`: `docs/architecture/data-collection.md`
- `@polymarket/market-discovery`: `docs/guides/multi-market.md`
- ADR: `docs/architecture/boundary-contract.md`
