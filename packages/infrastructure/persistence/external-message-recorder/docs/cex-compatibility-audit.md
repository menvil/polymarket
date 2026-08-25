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
      ↓ message.payload (payload-only)
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
| Time-window ротация (выровненные 5-мин окна) | Сохранена; окно назначается В МОМЕНТ записи — закрыта гонка legacy, терявшая строки во время асинхронного gzip |
| Gzip при ротации окна | `GzipCompressor` (atomic tmp → rename); строгая цепочка завершения: flush подтверждён → stream закрыт finish-ем → gzip успешен → completed. Любой отказ (включая ТАЙМАУТ закрытия stream и отказ gzip) оставляет `.jsonl` incomplete-артефактом — false-completed `.jsonl.gz` невозможен; отказы видны в `CexWindowRecorder.getStats()` |
| Naming `{utcDate}/{exchange}/{exchange}_{symbol}_{type}_{окно ET}` | Сохранён + сегмент `stream` (`orderbook`/`trades`): payload-only строки V2 не несут дискриминатора `t`, поток обязан жить в имени; символы санитизируются по `[/:]`; окна, не кратные минуте (только тесты), получают секунды в метке |
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

## Payload-only инвариант CEX-строк

В data lines записывается РОВНО `message.payload`
(`{ exchangeId, marketType, symbol, orderBook | trade }` с нетронутым
JSON-снапшотом unified-объекта CCXT). `messageId`/`runId`/`sequence`/
`correlationId`/`causationId`/routing discriminator в файлы не попадают —
закреплено интеграционным тестом и live smoke readback-ом.

## Legacy path

`packages/infrastructure/cex-market-data`
(`CexCollectorService`/`CcxtExchangeWatcher`/`CexFileRotator`) в N-005
**не удалён и не переписан**: он остаётся работающим для старых consumers
(Application sinks) до будущего consumer cutover после CEX Semantic Adapter.
Новый V2-контур не импортирует legacy-пакет (контурный тест cex-v2).
