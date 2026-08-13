# @polymarket/data-collection

## Обзор

Инфраструктурная запись сырых данных на диск: `DataRecorder` реализует
`IMarketDataRecorder` (`@polymarket/ports`) для рыночных WS-событий,
`DecisionJournalRecorder` реализует `IDecisionJournal` для решений стратегий. Оба пишут
буферизованный NDJSON, один файл на рынок, с периодическим/пороговым сбросом на диск.

| Экспорт | Назначение |
|---|---|
| `DataRecorder` | `IMarketDataRecorder`: `registerMarket`/`recordEvent`/`finalizeMarket`/`close` |
| `DecisionJournalRecorder` | `IDecisionJournal`: `startSession`/`recordDecision`/`recordFill`/`recordResolution`/`endSession`/`close` |
| `ArchivedMarketMetaRewriter` | Переписывает первую (meta) NDJSON-строку уже архивного файла |
| `NDJSONFormatter` | `formatRecord(obj)` → `'{"..."}\n'` |
| `GzipCompressor` | `compressFile(path)` → `.jsonl.gz`, максимальное сжатие, оригинал удаляется |
| `DataRecorderConfig`/`DEFAULT_RECORDER_CONFIG` | `outputDir`/`bufferSize`/`flushIntervalMs`/`compression` |

```typescript
import { DataRecorder, NDJSONFormatter, GzipCompressor, DEFAULT_RECORDER_CONFIG } from '@polymarket/data-collection';

const recorder = new DataRecorder(DEFAULT_RECORDER_CONFIG, new NDJSONFormatter(), new GzipCompressor(), logger);
recorder.registerMarket({ marketId, question, tokenIds, expiresAt });
recorder.recordEvent(instrumentId, { event_type: 'book', ... }); // fire-and-forget
await recorder.finalizeMarket(marketId, 'EXPIRED');
await recorder.close();
```

## Структура файлов на диске

```
outputDir/
  2026-01-01/
    Bitcoin_Up___0xabc.jsonl(.gz)
    Ethereum_Down___0xdef.jsonl(.gz)
  2026-01-02/
    ...
```

Первая строка каждого файла — `meta`-событие (`{"t":"meta","ts":...,"marketId":...,
"question":...,"tokenIds":[...]}`), читаемое обратно `@polymarket/snapshot-readers` при
реплее. `DecisionJournalRecorder` пишет в отдельную директорию (`journalDir`), отдельный
файл на рынок (`*.journal.jsonl`), с собственным набором типов записи (`session_start`/
`decision`/`fill`/`resolution`/`session_end`).

## Буферизация и fire-and-forget запись

Оба recorder'а держат события в памяти и сбрасывают на диск при достижении порога
(`bufferSize`, по умолчанию 100 для `DataRecorder`/50 для `DecisionJournalRecorder`) или по
таймеру (`flushIntervalMs`, по умолчанию 10с/5с) — защита от долгой тишины между сбросами.
`record*`-методы синхронные и fire-and-forget: recording — вспомогательная функция
(диагностика/бэктест-корпус), не должна создавать back-pressure на горячий путь обработки
рыночных данных или решений стратегии.

## Почему `recordEvent(tokenId: InstrumentId, ...)`, а не `string`

Порт `IMarketDataRecorder.recordEvent()` был переведён с `tokenId: string` на
`InstrumentId` в Этапе 10c плана миграции — реальные вызывающие (`apps/collect-data`,
`apps/bot/src/bot/buildRecording.ts`, `MarketDataFeedAdapter.ts`) уже валидируют tokenId
через `asInstrumentId()` до вызова, с fail-open пропуском (лог + skip) на невалид — сам
`DataRecorder` доверяет уже провалидированному входу.

## Почему `marketId` в `IDecisionJournal`-записях местами остаётся `string`

`DecisionJournalRecorder` реализует `IDecisionJournal` буквально (1-в-1 зеркалит типы
порта) — единственная точка, где сам класс конвертирует branded↔raw, это `endSession()`
(`String(marketId)` для строкового ключа внутреннего `Map`) и `close()` (обратный,
предсуществующий небезопасный каст при остановке). Почему сами record-типы
(`DecisionEntry`/`OrderEntry`/`FillEntry`/`SignalEntry`/`CancelEntry`) не бранднули
`marketId` полностью — см. `docs/architecture/boundary-contract.md`, Решение 13
(`marketId`-поле на этих типах фактически используется как routing-key и часто несёт
`InstrumentId`, не `MarketId` — брендирование было бы типово неверным на большинстве
реальных сайтов).

## Ссылки

- Порты: `@polymarket/ports` — `IMarketDataRecorder`, `IDecisionJournal`
- Потребители данных: `@polymarket/snapshot-readers` (docs/snapshot-readers.md)
- ADR: `docs/architecture/boundary-contract.md` (Решения 1, 13)
- План миграции, Этапы 10c/11: `/Users/menvil/.claude/plans/synthetic-swimming-heron.md`
