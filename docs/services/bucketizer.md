# Bucketizer - Offline Statistical Analysis (Stateful)

## Оглавление
- [Обзор](#обзор)
- [Архитектура](#архитектура)
- [Компоненты](#компоненты)
- [Bucket Types](#bucket-types)
- [Конфигурация](#конфигурация)
- [Использование](#использование)
- [Примеры](#примеры)

---

## Обзор

**Bucketizer** — это offline-режим для построения статистических buckets из исторических данных маркета с **stateful отслеживанием активных attempts**.

### Назначение

Вместо торговли в режиме реального времени, bucketizer:
1. **Читает** исторические snapshots (orderbook + trades)
2. **Воспроизводит** события в хронологическом порядке
3. **Отслеживает активные attempts** (виртуальные лимитные ордера)
4. **Агрегирует** результаты в multi-horizon buckets
5. **Записывает** результаты на диск для последующего анализа

### Применение

- **Бэктестинг стратегий**: вероятности fill на разных уровнях orderbook и временных горизонтах
- **Анализ ликвидности**: статистика по volume, spread и времени исполнения
- **Оптимизация параметров**: подбор оптимальных размеров ордеров
- **Исследование рынка**: поиск паттернов в исторических данных

### Ключевые особенности

- ✅ **Stateful Tracking**: AttemptTracker поддерживает активное состояние виртуальных ордеров
- ✅ **Multi-Horizon**: вероятности fill для разных временных горизонтов (5s, 10s, 30s, 120s)
- ✅ **Pessimistic Queue Model**: "мы стоим последними в очереди" для консервативных оценок
- ✅ **File Independence**: каждый snapshot файл - независимая сессия
- ✅ **Backpressure Control**: последовательная обработка без memory overflow

---

## Архитектура

### Общая схема (Stateful)

```
┌─────────────────────────────────────────────────────────────┐
│                  Snapshot Files (JSONL/gzipped)             │
│                   ./snapshots/YYYY-MM-DD/                   │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    SnapshotScanner                          │
│  - Сканирует директории                                    │
│  - Фильтрует по датам                                      │
│  - Сортирует файлы по времени                              │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│               SnapshotReaderFactory                         │
│  - Определяет формат (.jsonl / .jsonl.gz)                  │
│  - Создаёт соответствующий reader                          │
│  - Автоматическая декомпрессия gzip                        │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    ReplayRunner                             │
│  - Режимы: MAX (без задержек), SCALED (с задержками)       │
│  - Backpressure control (последовательная обработка)       │
│  - Graceful shutdown (AbortSignal)                         │
│  - onFileComplete callback для finalization                │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              SnapshotEventNormalizer                        │
│  - Преобразует raw snapshots в DomainEvent                 │
│  - OrderBookSnapshotReceivedEvent                          │
│  - TradeExecutedEvent                                       │
│  - ВАЖНО: Reverses orderbook arrays (Polymarket quirk)     │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                  BucketPipeline (Stateful)                  │
│  ┌──────────────────────────────────────────────┐          │
│  │     VolumeLevelProbabilityFillBucketType     │          │
│  │  ┌────────────────────────────────────────┐ │          │
│  │  │    AttemptTracker (per asset_id)       │ │          │
│  │  │  - Tracks active attempts              │ │          │
│  │  │  - Pessimistic queue model             │ │          │
│  │  │  - Multi-horizon expiry                │ │          │
│  │  └────────────────────────────────────────┘ │          │
│  └──────────────────────────────────────────────┘          │
│                                                             │
│  Алгоритм:                                                 │
│  1. processEvent(event) → AttemptResult[]                  │
│  2. aggregateResult(result) → update buckets               │
│  3. finalizeFile() → close attempts, reset trackers        │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                   BucketWriter                              │
│  - Overwrite mode: полная замена файлов                    │
│  - Merge mode: инкрементальное обновление                  │
│  - Atomic writes (temp file → rename)                      │
│  - Группировка по bucket type                              │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              Output Files (JSONL)                           │
│         ./buckets/{bucketType}/buckets.jsonl                │
└─────────────────────────────────────────────────────────────┘
```

### Принципы

1. **Stateful Processing**: активные attempts отслеживаются между событиями
2. **File Independence**: attempts не переносятся между файлами
3. **Multi-Horizon**: вероятности для разных временных окон (5s-120s)
4. **Pessimistic Model**: консервативная оценка ("стоим последними в очереди")
5. **Sequential Processing**: backpressure control
6. **Graceful Shutdown**: корректная остановка через AbortSignal

---

## Компоненты

### 1. SnapshotScanner

**Назначение**: Сканирование snapshot директорий

**Ключевые методы**:
- `scan(options?)`: сканирует файлы с опциональной фильтрацией по датам

**Пример**:
```typescript
const scanner = new SnapshotScanner('./snapshots', logger);

const result = await scanner.scan({
  fromDate: '2026-01-01',
  toDate: '2026-01-31'
});

console.log(`Found ${result.files.length} files`);
console.log(`Total size: ${(result.totalSizeBytes / 1024 / 1024).toFixed(2)} MB`);
```

### 2. SnapshotReaderFactory

**Назначение**: Создание readers для разных форматов

**Поддерживаемые форматы**:
- `.jsonl` - обычные текстовые файлы
- `.jsonl.gz` - gzip-сжатые файлы

**Автоматическая очистка**: temp файлы после декомпрессии удаляются в `finally` блоке

### 3. ReplayRunner

**Назначение**: Воспроизведение событий с backpressure

**Режимы**:

#### MAX Mode (максимальная скорость)
```typescript
const runner = new ReplayRunner(scanner, readerFactory, {
  mode: 'MAX'
}, logger);

await runner.run(
  async (event) => {
    // Обработка событий без задержек
    await pipeline.processEvent(event);
  },
  async () => {
    // Финализация файла
    await pipeline.finalizeFile();
  }
);
```

#### SCALED Mode (с задержками)
```typescript
const runner = new ReplayRunner(scanner, readerFactory, {
  mode: 'SCALED',
  scale: 0.1,  // 10% от реального времени
  maxCatchupDelayMs: 200  // Максимум 200ms между событиями
}, logger);

await runner.run(
  async (event) => {
    await pipeline.processEvent(event);
  },
  async () => {
    await pipeline.finalizeFile();
  }
);
```

**Алгоритм задержек (SCALED mode)**:
```
delay = (event2.timestamp - event1.timestamp) * scale
actualDelay = min(delay, maxCatchupDelayMs)
await sleep(actualDelay)
```

**File Finalization**:
```typescript
await runner.run(
  async (event) => {
    await pipeline.processEvent(event);
  },
  async () => {
    // Вызывается ПОСЛЕ обработки каждого файла
    await pipeline.finalizeFile();
  },
  abortSignal
);
```

### 4. AttemptTracker (NEW!)

**Назначение**: Stateful отслеживание активных attempts (виртуальных лимитных ордеров)

**Концепция**:
- Создается один tracker на каждый `asset_id`
- Отслеживает активные attempts между событиями
- Определяет когда attempt исполнен (filled) или истёк (expired)

**Pessimistic Queue Model**:
```
Предполагаем что мы стоим ПОСЛЕДНИМИ в очереди на каждом price level.

Пример:
  Orderbook: bid 0.50 size=100
  → Создаём attempt: myPrice=0.50, needToEatQty=100
  → Если приходит trade size=50 → needToEatQty=50 (ещё не filled)
  → Если приходит trade size=60 → needToEatQty=0 (filled!)
```

**Алгоритм**:

1. **onOrderBookSnapshot**:
```typescript
for (const level of bids) {
  const cumVolume = sum(bids[0..level])
  const volumeBin = findBin(cumVolume)

  createAttempt({
    side: 'buy',
    level: levelIndex + 1,
    myPrice: level.price,
    needToEatQty: level.size,
    expiryMs: now + maxHorizonSec * 1000
  })
}
```

2. **onTrade**:
```typescript
for (const attempt of activeAttempts) {
  if (doesTradeMatch(attempt, trade)) {
    attempt.needToEatQty -= min(trade.size, attempt.needToEatQty)

    if (attempt.needToEatQty <= 0) {
      // FILLED!
      return {
        bucketKey: attempt.bucketKey,
        filled: true,
        fillTimeSec: (now - attempt.t0) / 1000,
        fillPrice: trade.price
      }
    }
  }
}
```

3. **Trade Matching Logic**:
```typescript
function doesTradeMatch(attempt, trade) {
  if (attempt.side === 'buy') {
    // Buy attempt: trade price должна быть <= myPrice
    return trade.price <= attempt.myPrice
  } else {
    // Sell attempt: trade price должна быть >= myPrice
    return trade.price >= attempt.myPrice
  }
}
```

4. **Expiry**:
```typescript
// Attempts expire after maxHorizonSec
if (now - attempt.t0 > maxHorizonSec * 1000) {
  return {
    bucketKey: attempt.bucketKey,
    filled: false  // Expired without fill
  }
}
```

**Методы**:
- `onOrderBookSnapshot(ts, bids, asks)` → `AttemptResult[]`
- `onTrade(ts, price, size, side)` → `AttemptResult[]`
- `closeAll()` → `AttemptResult[]` (все активные как "not filled")
- `getStats()` → `{ activeAttempts, expiryQueueSize }`

### 5. BucketPipeline (Stateful)

**Назначение**: Обработка событий через stateful bucket types

**Ключевые изменения**:
- Поддерживает stateful bucket types с AttemptTracker
- Метод `finalizeFile()` для завершения файла
- Новые stats: `attemptsFinalized`, `bucketsAggregated`

**Пример**:
```typescript
const pipeline = new BucketPipeline(registry, logger);

// Обработка событий
await pipeline.processEvent(orderbookEvent);
await pipeline.processEvent(tradeEvent);

// Финализация файла (ВАЖНО!)
await pipeline.finalizeFile();

// Получение buckets
const buckets = pipeline.getBuckets();
console.log(`Created ${buckets.size} buckets`);

// Статистика
const stats = pipeline.getStats();
console.log(`Events: ${stats.eventsProcessed}`);
console.log(`Attempts finalized: ${stats.attemptsFinalized}`);
console.log(`Buckets aggregated: ${stats.bucketsAggregated}`);
```

**File Independence**:
```typescript
// File 1
await pipeline.processEvent(event1);
await pipeline.processEvent(event2);
await pipeline.finalizeFile();  // Closes all attempts, resets trackers

// File 2 (starts fresh, no attempts from file 1)
await pipeline.processEvent(event3);
await pipeline.finalizeFile();
```

### 6. BucketWriter

**Назначение**: Запись buckets на диск

**Режимы**:

#### Overwrite Mode
```typescript
const writer = new BucketWriter(registry, logger);

await writer.write(buckets, {
  mode: 'overwrite',
  outputDir: './buckets'
});
```

#### Merge Mode
```typescript
await writer.write(buckets, {
  mode: 'merge',
  outputDir: './buckets'
});
```

**Алгоритм merge**:
1. Прочитать существующие buckets из файла
2. Для каждого нового bucket:
   - Если bucket существует → merge data (attempts/fills aggregation)
   - Если bucket новый → добавить
3. Записать все buckets в temp файл
4. Atomic rename: `buckets.jsonl.tmp` → `buckets.jsonl`

---

## Bucket Types

### VolumeLevelProbabilityFillBucketType (Stateful, Multi-Horizon)

**Назначение**: Вычисляет вероятность fill лимитного ордера на разных уровнях orderbook, при разном cumulative volume, для разных временных горизонтов.

#### Bucket Key Format

```
side_level_volumeMin_volumeMax
```

**Примеры**:
- `buy_1_0_100` - BUY side, уровень 1, volume 0-100
- `sell_5_400_500` - SELL side, уровень 5, volume 400-500

**ВАЖНО**: Bucket key НЕ содержит asset_id! Attempts от разных asset_id (YES/NO токенов) агрегируются в один bucket.

#### Bucket Data Structure (NEW!)

```typescript
interface VolumeLevelProbabilityFillData {
  // Multi-horizon fill time distribution
  fill_time_distribution: {
    [horizonSec: number]: {
      attempts: number;      // Total attempts
      fills: number;         // Fills within this horizon
      probability: number;   // fills / attempts
    }
  };

  // Price distribution for fills
  price_fill_distribution: {
    [price: string]: number;  // price → count
  };
}
```

**Пример bucket**:
```json
{
  "bucket_type": "volume_level_probability_fill",
  "bucket_key": {
    "side": "buy",
    "level": 1,
    "volumeMin": 0,
    "volumeMax": 100
  },
  "fill_time_distribution": {
    "5": { "attempts": 1000, "fills": 210, "probability": 0.21 },
    "10": { "attempts": 1000, "fills": 280, "probability": 0.28 },
    "15": { "attempts": 1000, "fills": 320, "probability": 0.32 },
    "30": { "attempts": 1000, "fills": 410, "probability": 0.41 },
    "60": { "attempts": 1000, "fills": 520, "probability": 0.52 },
    "120": { "attempts": 1000, "fills": 650, "probability": 0.65 }
  },
  "price_fill_distribution": {
    "0.450000": 120,
    "0.460000": 80,
    "0.470000": 95,
    "0.480000": 110,
    "0.490000": 105,
    "0.500000": 140
  }
}
```

**Интерпретация**:
- На первом уровне BUY стороны при cumulative volume 0-100
- Вероятность fill в течение 5s: **21%**
- Вероятность fill в течение 60s: **52%**
- Вероятность fill в течение 120s: **65%**
- Заполнения происходили по ценам от 0.45 до 0.50

#### Конфигурация

```typescript
const bucketType = new VolumeLevelProbabilityFillBucketType({
  maxLevels: 10,              // Максимум уровней
  volumeStep: 100,            // Шаг volume bucket (USDC)
  volumeMin: 0,               // Минимальный volume
  volumeMax: 1000,            // Максимальный volume
  horizonsSec: [5, 10, 15, 30, 60, 120],  // Временные горизонты
  logger                      // Logger
});
```

#### Алгоритм (Stateful)

**1. processEvent(OrderBookSnapshotReceivedEvent)**:
```typescript
// Для каждого asset_id создается свой AttemptTracker
const tracker = getOrCreateTracker(event.assetId)

// Tracker создает attempts
const results = tracker.onOrderBookSnapshot(
  event.timestamp,
  event.bids,  // REVERSED by normalizer!
  event.asks   // REVERSED by normalizer!
)

// results пусты (attempts созданы, но ещё не завершены)
```

**2. processEvent(TradeExecutedEvent)**:
```typescript
const tracker = getOrCreateTracker(event.assetId)

// Tracker обрабатывает trade
const results = tracker.onTrade(
  event.timestamp,
  event.price,
  event.size,
  event.side
)

// results содержат filled attempts
for (const result of results) {
  aggregateResult(result)  // Обновление bucket
}
```

**3. aggregateResult(result)**:
```typescript
const bucket = getOrCreateBucket(result.bucketKey)

for (const horizon of horizonsSec) {
  bucket.fill_time_distribution[horizon].attempts++

  if (result.filled && result.fillTimeSec <= horizon) {
    bucket.fill_time_distribution[horizon].fills++
  }

  bucket.fill_time_distribution[horizon].probability =
    fills / attempts
}

if (result.filled) {
  const priceKey = result.fillPrice.toFixed(6)
  bucket.price_fill_distribution[priceKey]++
}
```

**4. finalize()**:
```typescript
// Вызывается в конце файла
const results = tracker.closeAll()  // Все активные как "not filled"

for (const result of results) {
  aggregateResult(result)
}

// Очистка trackers для следующего файла
resetTrackers()
```

#### Модель "Pessimistic Queue"

**Предположение**: Мы стоим **последними** в очереди на каждом price level.

**Алгоритм**:
1. На orderbook snapshot: `needToEatQty = level.size` (весь объём на уровне)
2. На trade: `needToEatQty -= min(trade.size, needToEatQty)`
3. Если `needToEatQty <= 0` → **filled!**

**Пример**:
```
Snapshot: bid 0.50 size=100
→ Создаём attempt: needToEatQty=100

Trade: price=0.50 size=40
→ needToEatQty=60 (ещё не filled)

Trade: price=0.50 size=70
→ needToEatQty=0 (filled!)
→ fillTime = now - t0
```

**Динамическое обновление**:
```
Snapshot 1: bid 0.50 size=50
→ attempt: needToEatQty=50

Snapshot 2: bid 0.50 size=100
→ size увеличился на 50
→ needToEatQty=100 (pessimistic: новый объём добавлен позади нас)

Trade: size=30
→ needToEatQty=70

Snapshot 3: bid 0.50 size=80
→ size уменьшился на 20
→ Кредитуем progress: needToEatQty=50
```

---

## Конфигурация

### Environment Variables

```bash
# ========================================
# Bucketizer Configuration
# ========================================

# Input directory with snapshot files
# Default: ./snapshots
BUCKET_INPUT_DIR=./snapshots

# Output directory for bucket files
# Default: ./buckets
BUCKET_OUTPUT_DIR=./buckets

# Bucket types to calculate (comma-separated)
# Default: volume_level_probability_fill
BUCKET_TYPES=volume_level_probability_fill

# Maximum orderbook levels to process
# Default: 10
BUCKET_MAX_LEVELS=10

# Volume bucket step (in USDC)
# Default: 100
BUCKET_VOLUME_STEP=100

# Minimum volume to track
# Default: 0
BUCKET_VOLUME_MIN=0

# Maximum volume to track
# Default: 1000
BUCKET_VOLUME_MAX=1000

# Time horizons for fill probability (seconds, comma-separated)
# Default: 5,10,15,30,60,120
BUCKET_HORIZONS_SEC=5,10,15,30,60,120

# ========================================
# Replay Configuration
# ========================================

# Replay mode: MAX (no delays) or SCALED (with delays)
# Default: MAX
REPLAY_MODE=MAX

# Scale factor for SCALED mode (0.0 - 1.0)
# Example: 0.1 = 10% of real time
# Default: 1.0
REPLAY_SCALE=1.0

# Maximum catch-up delay in milliseconds (for SCALED mode)
# Default: 200
REPLAY_MAX_CATCHUP_DELAY_MS=200

# ========================================
# Date Filtering (Optional)
# ========================================

# Process snapshots from this date (inclusive)
# Format: YYYY-MM-DD
# BUCKET_FROM_DAY=2026-01-01

# Process snapshots until this date (inclusive)
# Format: YYYY-MM-DD
# BUCKET_TO_DAY=2026-01-05
```

---

## Использование

### CLI

```bash
# Production (требует npm run build)
npm run bucketize

# Development (без build, с hot reload)
npm run bucketize:dev

# С конфигурацией
BUCKET_INPUT_DIR=./data/snapshots \
BUCKET_OUTPUT_DIR=./data/buckets \
BUCKET_HORIZONS_SEC=5,10,30,60 \
REPLAY_MODE=MAX \
npm run bucketizer:dev
```

### Программный API

```typescript
import { SnapshotScanner } from './infrastructure/persistence/snapshot-readers/SnapshotScanner.js';
import { SnapshotReaderFactory } from './infrastructure/persistence/snapshot-readers/SnapshotReaderFactory.js';
import { ReplayRunner } from './application/services/bucketizer/ReplayRunner.js';
import { BucketTypeRegistry } from './application/services/bucketizer/BucketTypeRegistry.js';
import { BucketPipeline } from './application/services/bucketizer/BucketPipeline.js';
import { BucketWriter } from './application/services/bucketizer/BucketWriter.js';
import { VolumeLevelProbabilityFillBucketType } from './application/services/bucketizer/bucket-types/VolumeLevelProbabilityFillBucketType.js';
import { ConsoleLogger } from './infrastructure/logging/ConsoleLogger.js';

// 1. Setup components
const logger = new ConsoleLogger({ level: 'info' });
const scanner = new SnapshotScanner('./snapshots', logger);
const readerFactory = new SnapshotReaderFactory(logger);

// 2. Setup bucket types
const registry = new BucketTypeRegistry();
const fillBucketType = new VolumeLevelProbabilityFillBucketType({
  maxLevels: 10,
  volumeStep: 100,
  volumeMin: 0,
  volumeMax: 1000,
  horizonsSec: [5, 10, 15, 30, 60, 120],
  logger
});
registry.register(fillBucketType);

// 3. Setup pipeline
const pipeline = new BucketPipeline(registry, logger);

// 4. Setup replay runner
const runner = new ReplayRunner(
  scanner,
  readerFactory,
  {
    mode: 'MAX',
    scanOptions: {
      fromDate: '2026-01-01',
      toDate: '2026-01-31'
    }
  },
  logger
);

// 5. Process events
const stats = await runner.run(
  async (event) => {
    await pipeline.processEvent(event);
  },
  async () => {
    // ВАЖНО: Финализация каждого файла!
    await pipeline.finalizeFile();
  }
);

console.log(`Processed ${stats.processedEvents} events`);
console.log(`Files: ${stats.filesProcessed}`);

// 6. Get buckets
const buckets = pipeline.getBuckets();
console.log(`Created ${buckets.size} buckets`);

const pipelineStats = pipeline.getStats();
console.log(`Attempts finalized: ${pipelineStats.attemptsFinalized}`);
console.log(`Buckets aggregated: ${pipelineStats.bucketsAggregated}`);

// 7. Write buckets to disk
const writer = new BucketWriter(registry, logger);
const writeStats = await writer.write(buckets, {
  mode: 'merge',  // Merge with existing data
  outputDir: './buckets'
});

console.log(`Written ${writeStats.bucketsWritten} buckets`);
console.log(`Merged: ${writeStats.mergedBuckets}, New: ${writeStats.newBuckets}`);
```

---

## Примеры

### Пример 1: Анализ одного дня

```typescript
const runner = new ReplayRunner(
  scanner,
  readerFactory,
  {
    mode: 'MAX',
    scanOptions: {
      fromDate: '2026-01-05',
      toDate: '2026-01-05'
    }
  },
  logger
);

await runner.run(
  async (event) => {
    await pipeline.processEvent(event);
  },
  async () => {
    await pipeline.finalizeFile();
  }
);

await writer.write(pipeline.getBuckets(), {
  mode: 'overwrite',
  outputDir: './buckets'
});
```

### Пример 2: Инкрементальное обновление

```typescript
// Day 1: Initial processing
await runner.run(handler, fileHandler);
await writer.write(pipeline.getBuckets(), {
  mode: 'overwrite',
  outputDir: './buckets'
});

// Day 2: Incremental update
const pipeline2 = new BucketPipeline(registry, logger);
await runner2.run(
  async (event) => {
    await pipeline2.processEvent(event);
  },
  async () => {
    await pipeline2.finalizeFile();
  }
);

// Merge with existing data
await writer.write(pipeline2.getBuckets(), {
  mode: 'merge',  // ← Merge mode!
  outputDir: './buckets'
});
```

### Пример 3: Graceful Shutdown

```typescript
const controller = new AbortController();

// Handle SIGINT (Ctrl+C)
process.on('SIGINT', () => {
  console.log('\nStopping replay...');
  controller.abort();
});

try {
  await runner.run(
    async (event) => {
      await pipeline.processEvent(event);
    },
    async () => {
      await pipeline.finalizeFile();
    },
    controller.signal
  );
} catch (error) {
  if (error.message === 'Aborted') {
    console.log('Replay stopped gracefully');

    // Write partial results
    await writer.write(pipeline.getBuckets(), {
      mode: 'merge',
      outputDir: './buckets'
    });
  } else {
    throw error;
  }
}
```

### Пример 4: Чтение и анализ результатов

```typescript
import * as fs from 'node:fs/promises';

// Read bucket file
const content = await fs.readFile(
  './buckets/volume_level_probability_fill/buckets.jsonl',
  'utf8'
);

const buckets = content
  .trim()
  .split('\n')
  .map(line => JSON.parse(line));

// Analyze multi-horizon probabilities
for (const bucket of buckets) {
  const { bucket_key, fill_time_distribution, price_fill_distribution } = bucket;

  // Find buckets with high 5s fill probability
  if (fill_time_distribution[5]?.probability > 0.3) {
    console.log(`\nHigh-liquidity bucket: ${bucket_key.side}_${bucket_key.level}_${bucket_key.volumeMin}_${bucket_key.volumeMax}`);

    // Show probability progression
    console.log('Fill probabilities by horizon:');
    for (const horizon of [5, 10, 30, 60, 120]) {
      const stats = fill_time_distribution[horizon];
      console.log(`  ${horizon}s: ${(stats.probability * 100).toFixed(1)}% (${stats.fills}/${stats.attempts})`);
    }

    // Show price range
    const prices = Object.keys(price_fill_distribution).map(parseFloat).sort((a, b) => a - b);
    console.log(`Price range: ${prices[0].toFixed(3)} - ${prices[prices.length - 1].toFixed(3)}`);
  }
}
```

**Пример вывода**:
```
High-liquidity bucket: buy_1_0_100
Fill probabilities by horizon:
  5s: 35.2% (352/1000)
  10s: 48.5% (485/1000)
  30s: 62.1% (621/1000)
  60s: 74.3% (743/1000)
  120s: 82.7% (827/1000)
Price range: 0.450 - 0.495
```

---

## Производительность

### Метрики

Типичная производительность (на MacBook Pro M1):
- **Чтение**: ~10,000 events/sec (MAX mode)
- **Attempt tracking**: зависит от активности маркета
- **Bitcoin markets**: медленнее (100k+ active attempts)
- **Inactive markets**: быстро (<100 active attempts)
- **Запись**: ~5,000 buckets/sec

### Мониторинг

```typescript
const stats = await runner.run(handler, fileHandler);

console.log('Replay Statistics:');
console.log(`  Total events: ${stats.totalEvents}`);
console.log(`  Processed: ${stats.processedEvents}`);
console.log(`  Skipped: ${stats.skippedEvents}`);
console.log(`  Errors: ${stats.errorEvents}`);
console.log(`  Duration: ${(stats.durationMs / 1000).toFixed(2)}s`);
console.log(`  Speed: ${Math.round(stats.processedEvents / (stats.durationMs / 1000))} events/sec`);

const pipelineStats = pipeline.getStats();
console.log('\nPipeline Statistics:');
console.log(`  Events processed: ${pipelineStats.eventsProcessed}`);
console.log(`  Attempts finalized: ${pipelineStats.attemptsFinalized}`);
console.log(`  Buckets aggregated: ${pipelineStats.bucketsAggregated}`);
console.log(`  Total buckets: ${pipeline.getBuckets().size}`);
```

---

## Архитектурные решения

### Почему stateful?

**Старая архитектура (stateless)**:
- Каждое событие обрабатывалось независимо
- Невозможно отслеживать fill time
- Невозможно multi-horizon анализ

**Новая архитектура (stateful)**:
- AttemptTracker поддерживает активное состояние
- Отслеживание fill time для multi-horizon
- Pessimistic queue model для консервативных оценок

### Почему file independence?

**Проблема**: Если attempts переносятся между файлами, статистика искажается
- Файл 1 создал attempt в 23:59:59
- Файл 2 начинается в 00:00:00
- Attempt expired через 120s → неправильная статистика

**Решение**: Каждый файл - независимая сессия
- После обработки файла: `finalizeFile()` → все attempts закрываются
- `resetTrackers()` → состояние очищается
- Следующий файл начинается с чистого листа

### Почему не смешиваем YES/NO токены?

**Вопрос**: YES и NO токены - это разные asset_id, но они агрегируются в один bucket?

**Ответ**: ДА, и это правильно!
- Каждый asset_id обрабатывается своим AttemptTracker
- Buy attempts для YES создаются из bids YES
- Trades для YES матчатся с attempts YES
- Но bucket key НЕ содержит asset_id
- Результаты агрегируются в общую статистику

**Почему это правильно?**
- Мы измеряем вероятность исполнения лимитного ордера
- Не важно YES это или NO - механика одинаковая
- Больше данных = более точная статистика

---

## Troubleshooting

### Проблема: "unexpected end of file" при декомпрессии

**Причина**: Повреждённый .gz файл

**Решение**: Bucketizer автоматически пропускает повреждённые файлы и продолжает

### Проблема: "Memory overflow"

**Причина**: Слишком много active attempts (очень активные маркеты)

**Решение**: Обрабатывайте меньшие периоды:
```typescript
for (let day = 1; day <= 31; day++) {
  const pipeline = new BucketPipeline(registry, logger);
  // ... process day ...
  await writer.write(pipeline.getBuckets(), { mode: 'merge' });
}
```

### Проблема: Очень медленная обработка Bitcoin файлов

**Причина**: Bitcoin markets очень активны (100k+ attempts)

**Решение**: Это нормально! Bitcoin файлы просто требуют больше времени.

---

## См. также

- [Data Collection](./data-collection.md) - Сбор snapshot данных
- [Architecture](../architecture/event-flow.md) - Общая архитектура системы
- [Domain Events](../domain/entities.md) - Domain события
