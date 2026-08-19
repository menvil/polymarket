# CEX compatibility audit (N-002, PART 25/26/27)

Аудит будущей совместимости recording-архитектуры N-002 с CEX-данными.
**В N-002 CEX-путь НЕ мигрирован**: production
`CexCollectorService` / `CcxtExchangeWatcher` / `CexFileRotator`
(`packages/infrastructure/cex-market-data`) не изменены — они продолжают
работать как раньше, пока не появится `CexSource`, публикующий CEX
ExternalMessages в общий `ExternalMessageBus`.

## Почему сейчас нельзя мигрировать

`CexSource` в контуре ExternalMessageBus ещё не существует. Миграция recording
без source означала бы прямой путь CCXT → disk в обход bus — ровно та
архитектура, от которой N-002 уходит. Когда `CexSource` появится:

```text
CCXT → CexSource → ExternalMessage → ТОТ ЖЕ ExternalMessageBus → ТОТ ЖЕ Recorder service
```

## Матрица совместимости

Каждая текущая возможность `CexFileRotator` → что потребуется от будущего
Recorder → поддерживает ли архитектура N-002 → что отложено до CexSource-фазы.

| Текущая возможность CexFileRotator | Будущее требование к Recorder | N-002 поддерживает архитектурно? | Отложено до CexSource-фазы |
|---|---|---|---|
| Буферизация строк в памяти (200 строк / flush 5s) | Тот же дешёвый hot path: enqueue в память, flush по threshold/таймеру | Да — bus-handler recorder-а уже только route+serialize+enqueue; buffering — свойство storage-движка | Выбор storage-движка для CEX-строк (переиспользование/extraction) |
| Time-window ротация (выровненные 5-мин окна, выравнивание старта) | Партиционирование файлов по времени, а не по market-session | Да — routing-слой recorder-а отделён от writer-policy: сессии Polymarket не зашиты в bus-handler, CEX добавит свою registration с оконным writer-ом | Реализация window-writer policy (сейчас есть только market-session policy) |
| Gzip при ротации окна | Сжатие завершённого партишена | Да — момент «партишен завершён» инкапсулирован в policy (у Polymarket это finalizeMarket, у CEX будет граница окна) | Перенос gzip-вызова в window-policy |
| Naming `{outputDir}/{utcDate}/{exchange}/{exchange}_{symbol}_{type}_{окно ET}.jsonl[.gz]` | Схема имён на партишен CEX | Да — naming принадлежит writer-policy, а не bus-слою | Реализация naming в CEX-policy |
| Cleanup незавершённых `.jsonl` при старте и close | Та же семантика incomplete-файлов | Да — уже общая семантика обоих движков (`.jsonl` = incomplete, `.jsonl.gz` = завершённый архив) | Ничего |
| Множественные writer-ы (exchange, symbol, marketType) | Routing одного потока сообщений во множество writer-ов | Да — recorder уже делает fan-out routing (RTDS: один фид → N файлов); ключ CEX будет `(exchange, symbol, marketType)` вместо `(topic, symbol)` | Typed CEX ExternalMessage contract (`CEX_ORDERBOOK`/`CEX_TRADE`) и его routing-ключ |
| Watcher/restart механика (`CcxtExchangeWatcher`, `RestartingTask`) | НЕ требование Recorder — это transport | Да — transport уйдёт в `CexSource` (симметрично `PolymarketSource`), recorder его не касается | Реализация CexSource |

## Что сознательно НЕ извлечено сейчас (PART 27)

`DataRecorder` и `CexFileRotator` дублируют механику (buffering, flush,
stream lifecycle, gzip, cleanup), но generic-абстракции
(`GenericBufferedWriter`, `AbstractRotator`, `StoragePolicyFactory`, ...)
в N-002 НЕ создаются: второй concrete use case ещё не реализован, extraction
без него была бы спекулятивной. При CexSource-фазе появится evidence для
осознанного выделения общего writer-ядра.

## Что уже гарантирует N-002

- **ONE bus**: порт подписки recorder-а (`PolymarketRecordingBusSubscription`)
  принимает bus, параметризованный расширенным union
  (`PolymarketExternalMessage | CexExternalMessage`), без кастов —
  закреплено compile-time тестом `ExternalMessageRecorder.types.test.ts`.
- **ONE Recorder service**: добавление CEX — это новые typed subscribe +
  CEX writer-policy внутри того же сервиса, не второй сервис и не прямой
  Source→disk путь.
- **ONE file policy — НЕ требование**: Polymarket market-session writer и
  будущий CEX time-window writer сосуществуют как разные policy одного
  сервиса.
