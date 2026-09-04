# CEX compatibility audit (N-002 PART 25/26/27 → реализовано в N-005)

Аудит совместимости recording-архитектуры с CEX-данными. Написан в N-002 как
матрица «что потребуется, когда появится CexSource»; **в N-005 CEX-путь
реализован** — документ зафиксирован как исполненный контракт.

## Итоговая архитектура (N-005)

```text
CCXT / CCXT Pro
      ↓
CexSource                       (@polymarket/cex-v2)
      ↓ CEX_ORDERBOOK / CEX_TRADE
ТОТ ЖЕ ExternalMessageBus       (union PolymarketExternalMessage | CexExternalMessage)
      ↓ subscribe('CEX_*')
ТОТ ЖЕ ExternalMessageRecorder  (один сервис, опциональная cex-конфигурация)
      ↓ toRecordedObservation(message)  (конверт V2 ВОКРУГ payload)
CexWindowRecorder               (@polymarket/data-collection, оконная policy)
      ↓
{outputDir}/{utcDate}/{exchange}/{exchange}_{symbol}_{marketType}_{stream}_{окно ET}.jsonl → .jsonl.gz
```

Один Recorder-СЕРВИС — две storage/writer-policy:

- **Polymarket market-session policy** (`DataRecorder`): OPEN → recording →
  SEAL → enrichment → FINALIZE (EXPIRED/SHUTDOWN) — не изменена;
- **CEX time-window policy** (`CexWindowRecorder`): непрерывный поток →
  выровненное окно → ротация → gzip → следующее окно.

Общая единственно механическая часть — `GzipCompressor` (переиспользован).
Generic buffered-writer НЕ извлечён: extraction потребовала бы
абстрагировать lifecycle-политики (см. решение в PR N-005).

## Матрица совместимости (исполнение)

| Возможность legacy `CexFileRotator` | Реализация N-005 |
|---|---|
| Буферизация строк (200 строк / flush 5s) | `CexWindowRecorder`: те же дефолты; hot path recorder-а — route + serialize + enqueue |
| Time-window ротация (выровненные 5-мин окна) | Сохранена; окно назначается по времени INGRESS наблюдения (`observation.ingress`) — закрыта и гонка legacy, терявшая строки во время асинхронного gzip, и подмена времени наблюдения wall-clock-ом записи |
| Gzip при ротации окна | `GzipCompressor` (atomic tmp → rename); строгая цепочка завершения: flush подтверждён → stream закрыт finish-ем → gzip успешен → completed. Любой отказ (включая ТАЙМАУТ закрытия stream и отказ gzip) оставляет `.jsonl` incomplete-артефактом — false-completed `.jsonl.gz` невозможен; отказы видны в `CexWindowRecorder.getStats()` |
| Naming `{utcDate}/{exchange}/{exchange}_{symbol}_{type}_{окно ET}` | Сохранён + сегмент `stream` (`orderbook`/`trades`): V2 разводит потоки по разным физическим партициям, поэтому поток обязан жить в имени, в routing-ключе и в header-е партиции; символы санитизируются по `[/:]`; окна, не кратные минуте (только тесты), получают секунды в метке |
| Cleanup незавершённых `.jsonl` при старте и close | Та же семантика (`cleanup()` при старте процесса, удаление незавершённых окон при `close()`) |
| Множественные writer-ы `(exchange, symbol, marketType)` | Ключ расширен потоком: `(exchange, symbol, marketType, stream)`; routing-идентичность приходит В КАЖДОМ typed payload — регистраций нет |
| Watcher/restart механика | Ушла в `CexSource` (transport): multiplex/per-symbol/fetch, supervised restart, stale, плановый перезапуск; recorder транспорта не касается |

## Гарантии, заявленные N-002 — статус

- **ONE bus** — выполнено: `ExternalMessageBus<PolymarketExternalMessage |
  CexExternalMessage>` присваивается обоим портам подписки без кастов;
  compile-time тест `ExternalMessageRecorder.types.test.ts` переведён с
  эскиза `FutureCexExternalMessage` на реальный `CexExternalMessage`.
- **ONE Recorder service** — выполнено: CEX — это опциональная
  `cex`-конфигурация ТОГО ЖЕ `ExternalMessageRecorder` (typed subscribe +
  оконный storage), не второй сервис и не прямой Source→disk путь.
- **ONE file policy — НЕ требование** — подтверждено: политики
  сосуществуют, интеграционный тест
  `one-bus-one-recorder.integration.test.ts` доказывает раздельную
  маршрутизацию без cross-routing и один shutdown обеих политик.

## Формат партиции: Replayable Raw Format V2

```text
LINE 1  {"t":"meta","formatVersion":2,"source":"CEX","exchangeId":"binance",
         "marketType":"swap","symbol":"BTC/USDT:USDT","stream":"orderbook",
         "windowStartMs":…,"windowEndMs":…}
LINE 2+ {"type":"CEX_ORDERBOOK","ingress":{…},"payload":{…}}
```

Header обязателен: у CCXT-payload-а нет ни биржи, ни типа рынка, а имя файла
контрактом не является — reader обязан узнавать формат и routing identity из
самого файла (canonical identity транспорта — тройка
`exchangeId + marketType + stream`).

В `payload` data-строки лежит РОВНО `message.payload`
(`{ exchangeId, marketType, symbol, orderBook | trade }` с нетронутым
JSON-снапшотом unified-объекта CCXT): конверт добавлен СНАРУЖИ, сам payload
не нормализуется. `ingress` копируется из metadata того сообщения, которое
пришло recorder-у, — это исторический ключ порядка `(runId, sequence)` и
момент наблюдения. Live-only поля (`messageId`/`correlationId`/
`causationId`/`createdAt`) в файлы не попадают — закреплено интеграционным
тестом и live smoke readback-ом.

Контракт и decoder формата — `@polymarket/raw-archive-format`.

## Legacy path

`packages/infrastructure/cex-market-data`
(`CexCollectorService`/`CcxtExchangeWatcher`/`CexFileRotator`) в N-005
**не удалён и не переписан**: он остаётся работающим для старых consumers
(Application sinks) до будущего consumer cutover после CEX Semantic Adapter.
Новый V2-контур не импортирует legacy-пакет (контурный тест cex-v2).
