# @polymarket/snapshot-readers

## Обзор

Читает архивы рыночных данных, записанные `@polymarket/data-collection`
(`outputDir/YYYY-MM-DD/*.jsonl(.gz)`). Два независимых кирпичика: `SnapshotScanner` находит
файлы по дате/рынку, `SnapshotReaderFactory`+`ISnapshotReader` читают конкретный файл
построчно через async generator (memory-efficient, без загрузки всего файла в память).

| Экспорт | Назначение |
|---|---|
| `SnapshotScanner` | Сканирует `outputDir/YYYY-MM-DD/*.jsonl(.gz)`, фильтр по дате/marketId |
| `SnapshotReaderFactory` | `.create(filePath)` — выбирает reader по расширению файла |
| `ISnapshotReader` | `readLines()`/`close()`/`getFilePath()` — единый API для `.jsonl`/`.jsonl.gz` |
| `JsonlSnapshotReader` | Читает `.jsonl` напрямую построчно |
| `GzipJsonlSnapshotReader` | Читает `.jsonl.gz`: распаковывает во временный файл, читает, удаляет при `close()` |
| `SnapshotFileInfo` | Метаданные найденного файла (путь, дата, размер) |
| `ScanOptions`/`ScanResult` | Параметры/результат `SnapshotScanner.scan()` |

```typescript
import { SnapshotScanner, SnapshotReaderFactory } from '@polymarket/snapshot-readers';

const scanner = new SnapshotScanner('./data/snapshots', logger);
const { files } = await scanner.scan({ fromDate: '2026-01-01', toDate: '2026-01-07' });

const factory = new SnapshotReaderFactory(logger);
for (const file of files) {
  const reader = factory.create(file.filePath);
  try {
    for await (const line of reader.readLines()) {
      const event = JSON.parse(line);
      // обработка события
    }
  } finally {
    await reader.close(); // ОБЯЗАТЕЛЕН — GzipJsonlSnapshotReader удаляет временный файл
  }
}
```

## Почему async generator, а не загрузка файла целиком

Снапшоты рыночных данных — потенциально многогигабайтные NDJSON-архивы (один торговый день
одного активного рынка). `readLines(): AsyncGenerator<string, void, undefined>` читает и
отдаёт по одной строке за раз через Node.js readline-поток — потребитель обрабатывает
события по мере поступления, без пиковой аллокации под весь файл. `GzipJsonlSnapshotReader`
поверх этого ещё распаковывает `.gz` во временный файл перед чтением — отсюда обязательность
`close()`: только он удаляет этот временный файл (утечка временных файлов при пропущенном
`close()` — единственный практический риск неверного использования).

## Почему выбор реализации — по расширению файла, не по флагу

`SnapshotReaderFactory.create(filePath)` определяет `JsonlSnapshotReader` vs
`GzipJsonlSnapshotReader` по суффиксу пути (`.jsonl.gz` vs `.jsonl`), не по отдельному
параметру — снапшоты на диске физически либо сжаты, либо нет, и это уже видно из имени
файла (тот же формат, что производит `@polymarket/data-collection`'s `GzipCompressor`).
Неподдерживаемое расширение — `throw` при конструировании (программная ошибка вызывающего
кода: путь пришёл не из `SnapshotScanner`, а откуда-то ещё) — не `Result`, поскольку это
чистая фабрика без потенциально невалидного внешнего ввода (в отличие от парсинга самих
NDJSON-строк, которое остаётся на совести потребителя `readLines()`).

## Ссылки

- Потребители: `apps/collect-data` (анализ архивов), `packages/infrastructure/backtesting`
  (реплей исторических снапшотов через `BacktestEngine`)
- Производитель данных: `packages/infrastructure/persistence/data-collection`
  (`docs/data-collection.md`)
- ADR: `docs/architecture/boundary-contract.md`
- План миграции, Этап 11: `/Users/menvil/.claude/plans/synthetic-swimming-heron.md`
