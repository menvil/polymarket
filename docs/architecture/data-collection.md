# Архитектура: Сбор и воспроизведение рыночных данных

## Проблема

Для бектестинга стратегий и отладки нужна возможность:

1. Записывать сырые WS-события Polymarket в реальном времени
2. Читать сохранённые снапшоты для воспроизведения в бектесте

## Решение

Три режима работы системы:

```
LIVE TRADING:   WS → Adapters → Handlers → Strategy   (без записи)
COLLECTION:     WS → [Recorder] → Adapters → Handlers  (запись + торговля)
BACKTEST:       Disk → SnapshotReader → Adapters → Handlers → MockExchangeClient
```

Один и тот же application layer (`BookUpdateHandler`, `ProcessFillUseCase`, `IStrategy`)
работает во всех трёх режимах без изменений.

## Компоненты

### `IMarketDataRecorder` (@polymarket/ports)

Порт для записи сырых данных. Определяет интерфейс, которому должна соответствовать
любая реализация рекордера.

```typescript
interface IMarketDataRecorder {
  registerMarket(meta: MarketMeta): void;
  recordEvent(tokenId: InstrumentId, rawEvent: unknown): void;  // синхронный, never throws
  finalizeMarket(marketId: MarketId, reason: 'EXPIRED' | 'SHUTDOWN'): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
  isEnabled(): boolean;
}
```

**Ключевые гарантии:**

- `recordEvent` синхронный и никогда не бросает — не блокирует trading path
- Событие записывается ДО доменной обработки (сохраняется raw wire-формат)

### `DataRecorder` (@polymarket/data-collection)

Реализует `IMarketDataRecorder`. Хранит state в памяти, сбрасывает на диск периодически.

**Структура файлов:**

```
outputDir/
  2024-01-15/
    Will Bitcoin reach $100k?___0xabc123.jsonl
    Will Bitcoin reach $100k?___0xabc123.jsonl.gz  (после финализации)
```

**Формат записи:** NDJSON (один JSON-объект на строку):

```json
{"_t":1705312000000,"_type":"META","marketId":"0xabc","question":"..."}
{"_t":1705312001000,"_type":"EVENT","event":{...raw WS DTO...}}
```

**Конфигурация:**

```typescript
interface DataRecorderConfig {
  outputDir: string;
  bufferSize?: number;       // default 100 событий
  flushIntervalMs?: number;  // default 10_000 ms
  compression?: 'none' | 'gzip';  // default 'none'
}
```

### `MarketDataFeedAdapter` (hook)

Рекордер подключается как опциональная зависимость:

```typescript
const adapter = new MarketDataFeedAdapter(wsEmitter, bookHandler, logger, recorder);
```

Внутри обработчика snapshot:

```typescript
// Сначала пишем raw — до любой доменной обработки
this._recorder?.recordEvent(dto.asset_id, dto);
// Затем стандартная обработка
const bids = this._convertLevels(dto.bids);
await this._bookHandler.handleSnapshot(...);
```

### `SnapshotReader` (@polymarket/snapshot-readers)

Пакет для чтения сохранённых снапшотов:

- `JsonlSnapshotReader` — читает `.jsonl` файлы построчно (memory-efficient)
- `GzipJsonlSnapshotReader` — декомпрессирует во временный файл, делегирует `JsonlSnapshotReader`
- `SnapshotReaderFactory` — автоматически выбирает reader по расширению файла
- `SnapshotScanner` — сканирует директорию с фильтрацией по дате/marketId

```typescript
const scanner = new SnapshotScanner('/data/snapshots');
const result = await scanner.scan({
  fromDate: '2024-01-01',
  toDate:   '2024-01-31',
  marketId: '0xabc123',
});

const reader = SnapshotReaderFactory.create(result.files[0].filePath);
for await (const line of reader.readLines()) {
  const event = JSON.parse(line);
  // обработка...
}
await reader.close();
```

## Graceful Shutdown: алгоритм очистки

### Проблема

При Ctrl+C (SIGINT) незавершённые `.jsonl` файлы текущей сессии должны быть удалены
(неполные данные бесполезны для бектеста). Ранее `DataRecorder.close()` вызывал
`stream.destroy()` без ожидания закрытия файловых дескрипторов, после чего сразу
запускал `cleanup()`. Это создавало race condition: `unlink()` срабатывал до того,
как ОС полностью освобождала fd.

### Решение (аналог CexFileRotator)

`DataRecorder.close()` теперь использует тот же паттерн что и `CexFileRotator.close()`:

1. `stream.destroy()` + ожидание события `'close'` (или 5-секундный таймаут)
2. Только после закрытия всех fd → `cleanup()` (disk-scan + `unlink()`)

```typescript
// Ждём реального закрытия FD перед disk-scan
await Promise.all(writersSnapshot.map((writer) =>
  Promise.race([
    new Promise<void>((resolve) => {
      writer.stream!.once('close', () => resolve());
      writer.stream!.destroy();
    }),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ])
));
// Теперь safe: все FD освобождены, unlink() гарантированно работает
await this.cleanup();
```

`cleanup()` — тот же код что и при startup: сканирует диск, находит все `.jsonl`
файлы и удаляет их. При наличии архивов `.jsonl.gz` они не затрагиваются.

## Почему такое решение?

1. **Optional dependency**: рекордер необязателен — система работает без него.
   При добавлении рекордера не меняется ни одна строка бизнес-логики.

2. **Raw events**: записываем данные ДО преобразования в domain objects.
   Это позволяет воспроизводить оригинальный wire-формат и менять парсинг при бектесте.

3. **fire-and-forget**: `recordEvent` синхронный и никогда не бросает.
   Ошибки I/O буферизуются внутри рекордера — не прерывают trading path.

4. **Separation of concerns**: `data-collection` и `snapshot-readers` — разные пакеты.
   Запись не зависит от чтения, и наоборот.

## Дальнейшие шаги

- [ ] `packages/infrastructure/backtesting/` — `MockExchangeClient`, `BacktestEngine`
- [ ] `apps/collector/` — standalone сервис сбора данных (CollectorService)
