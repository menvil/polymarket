# Data Collection System

## Обзор

Система сбора данных для записи raw market data с Polymarket для анализа и бэктестов.

### Ключевые особенности

- Запись RAW WebSocket событий (orderbook, trades)
- Работает параллельно с торговлей или standalone
- Буферизация: 100 событий ИЛИ 10 секунд
- Валидные данные только при истечении маркета
- Gzip сжатие при финализации (опционально)

## Архитектура

```
┌─────────────────────────────────────────────────────────────┐
│                      WebSocketManager                        │
│                    emit('raw', event)                        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   DataCollectorService                       │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ tokenToConditionId: Map<tokenId, conditionId>       │    │
│  │ markets: Map<conditionId, RegisteredMarket>         │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                       DataRecorder                           │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ writers: Map<slug, MarketWriter>                    │    │
│  │ tokenToSlug: Map<tokenId, slug>                     │    │
│  └─────────────────────────────────────────────────────┘    │
│                              │                               │
│              ┌───────────────┼───────────────┐              │
│              ▼               ▼               ▼              │
│        ┌─────────┐     ┌─────────┐     ┌─────────┐         │
│        │Formatter│     │Buffer   │     │Stream   │         │
│        │(NDJSON) │     │(100 ev) │     │(file)   │         │
│        └─────────┘     └─────────┘     └─────────┘         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      File System                             │
│  snapshots/                                                  │
│  └── 2026-01-03/                                            │
│      ├── Will Bitcoin go up or down___btc-up-jan3.jsonl     │
│      └── Will ETH reach 5000___eth-5k-dec.jsonl.gz          │
└─────────────────────────────────────────────────────────────┘
```

## Компоненты

### 1. DataCollectorService (Application Layer)

Координатор сбора данных. Связывает WebSocket события с DataRecorder.

```typescript
class DataCollectorService {
  // Инициализация (очистка incomplete)
  async initialize(): Promise<void>;

  // Регистрация маркета для записи
  registerMarket(candidate: MarketCandidate): void;

  // Обработка raw WebSocket события
  handleRawEvent(event: RawWsEvent): void;

  // Финализация маркета (expired = валидные данные)
  async finalizeMarket(conditionId: string, expired: boolean): Promise<void>;

  // Закрытие
  async close(): Promise<void>;
}
```

### 2. DataRecorder (Infrastructure Layer)

Реализация записи в файлы.

```typescript
class DataRecorder implements IDataRecorder {
  // Регистрация маркета
  registerMarket(slug, question, rawMarket, tokenIds): void;

  // Запись события
  recordRawEvent(tokenId, rawEvent): void;

  // Финализация (сжатие если expired)
  async finalizeMarket(slug, expired): Promise<void>;
}
```

### 3. IFormatter (Strategy Pattern)

Интерфейс для сериализации данных.

```typescript
interface IFormatter {
  readonly extension: string;      // 'jsonl', 'parquet', 'arrow'
  readonly format: DataFormat;     // 'ndjson' | 'parquet' | 'arrow'
  supportsStreaming(): boolean;
  formatRecord(record: object): string | Buffer;
}
```

Реализации:
- `NDJSONFormatter` - JSON Lines формат (streaming, рекомендуется)
- `ParquetFormatter` - Apache Parquet (batch, columnar)
- `ArrowFormatter` - Apache Arrow IPC (batch, in-memory)

### Сравнение форматов

| Формат   | Streaming | Сжатие      | Размер   | Скорость чтения |
|----------|-----------|-------------|----------|-----------------|
| NDJSON   | Да        | gzip        | Большой  | Средняя         |
| Parquet  | Нет       | Snappy      | Малый    | Быстрая         |
| Arrow    | Нет       | Нет         | Средний  | Очень быстрая   |

### 4. GzipCompressor

Сжатие файлов при финализации.

```typescript
class GzipCompressor {
  // Сжать файл (удаляет оригинал)
  async compressFile(filePath: string): Promise<string>;

  // Нужно ли сжимать
  shouldCompress(filePath: string): boolean;
}
```

## Конфигурация

### Environment Variables

```bash
# Enable/disable data collection
DATA_COLLECTION_ENABLED=0

# Output directory
DATA_COLLECTION_OUTPUT_DIR=./snapshots

# Format: ndjson, parquet, arrow
DATA_COLLECTION_FORMAT=ndjson

# Compression: none, gzip
DATA_COLLECTION_COMPRESSION=none

# Buffer size (events before flush)
DATA_COLLECTION_BUFFER_SIZE=100

# Flush interval (ms)
DATA_COLLECTION_FLUSH_INTERVAL_MS=10000
```

## Формат данных

### Структура файла

Каждый файл содержит данные одного маркета в формате NDJSON:

```jsonl
{"t":"meta","ts":1704307200000,"m":{...GammaMarketData...}}
{"event_type":"book","asset_id":"0x...","market":"0x...","timestamp":"...","hash":"...","bids":[...],"asks":[...]}
{"event_type":"trade","asset_id":"0x...","price":"0.55","size":"100",...}
{"event_type":"last_trade_price","asset_id":"0x...","price":"0.55"}
...
```

### Meta Record (первая строка)

```json
{
  "t": "meta",
  "ts": 1704307200000,
  "m": {
    "conditionId": "0x...",
    "slug": "btc-up-jan3",
    "question": "Will Bitcoin go up?",
    "outcomes": ["Yes", "No"],
    "endDate": "2026-01-03T12:00:00Z",
    ...
  }
}
```

### Book Event

```json
{
  "event_type": "book",
  "asset_id": "0x...",
  "market": "0x...",
  "timestamp": "1704307200123",
  "hash": "abc123",
  "bids": [
    {"price": "0.55", "size": "1000"},
    {"price": "0.54", "size": "500"}
  ],
  "asks": [
    {"price": "0.56", "size": "800"},
    {"price": "0.57", "size": "300"}
  ]
}
```

### Trade Event

```json
{
  "event_type": "trade",
  "asset_id": "0x...",
  "price": "0.55",
  "size": "100",
  "side": "buy",
  "timestamp": "1704307200456"
}
```

## Использование

### Режим 1: Параллельно с торговлей

```bash
# Включить в .env
DATA_COLLECTION_ENABLED=1

# Запустить как обычно
npm run dev
```

### Режим 2: Standalone (только сбор)

```bash
# Development (tsx)
npm run collect:dev

# Production
npm run build && npm run collect
```

## Алгоритм управления слотами маркетов

### Концепция

Система ограничивает количество **одновременно отслеживаемых** маркетов через `MAX_CONCURRENT_MARKETS`. Это предотвращает перегрузку WebSocket соединения и чрезмерное использование памяти.

### Правила работы

1. **Маркет отслеживается до истечения**
   - После начала отслеживания маркет НЕ удаляется, даже если выпал из топа
   - Удаление происходит ТОЛЬКО когда маркет истекает (`endDate < now`)
   - Это гарантирует полноту собранных данных

2. **Освобождение слотов**
   - Слот освобождается ТОЛЬКО при истечении маркета
   - При истечении: отписка → финализация → удаление из памяти

3. **Добавление новых маркетов**
   - Новые маркеты добавляются ТОЛЬКО если есть свободные слоты
   - Выбираются лучшие маркеты из топа (по score)
   - Если слотов нет → ждём истечения существующих

### Алгоритм периодического сканирования

```
КАЖДЫЕ MARKET_SCAN_PAUSE_MS (например, 30 секунд):

1. Обновить данные маркетов: marketDiscovery.refresh()
2. Получить топ-N лучших маркетов: scanResult = findBestMarket()
3. Найти новые маркеты: newMarkets = топ-N ∖ уже_зарегистрированные

4. Если есть новые маркеты:
   a. Вычислить свободные слоты:
      freeSlots = MAX_CONCURRENT_MARKETS - registeredMarkets.size

   b. Если freeSlots > 0:
      - Взять первые freeSlots маркетов из newMarkets
      - Зарегистрировать их в DataCollector
      - Подписаться через WebSocket
      - Логировать: "Added N new markets (total: X/Y)"

   c. Если freeSlots = 0:
      - Логировать: "No free slots (X/Y active, N candidates waiting)"
      - Ничего не делать, ждать истечения
```

### Алгоритм проверки истечения

```
КАЖДЫЕ MARKET_EXPIRY_CHECK_INTERVAL_MS (например, 10 секунд):

1. Получить текущее время: now = Date.now()
2. Найти истёкшие маркеты:
   expiredMarkets = маркеты где now >= endDate

3. Для каждого истёкшего маркета:
   a. Отписаться от WebSocket (перестать получать события)
   b. Финализировать маркет (flush buffer, сжатие)
   c. Удалить из registeredMarkets (освободить слот)

4. Логировать: "Removed N expired markets (remaining: X)"
```

### Пример работы системы

```
MAX_CONCURRENT_MARKETS=5

┌─────────────────────────────────────────────────────────────────┐
│ T0: Старт - добавлено 5 маркетов [A, B, C, D, E]              │
│     registeredMarkets = {A, B, C, D, E} ✅ (5/5 слотов занято)  │
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│ T1: Periodic scan (через 30 сек)                               │
│     Топ-5 маркетов: [B, C, D, E, F]  (A выпал из топа!)       │
│     newMarkets = [F]                                            │
│     freeSlots = 5 - 5 = 0                                       │
│     → НЕ добавляем F (нет свободных слотов)                    │
│     registeredMarkets = {A, B, C, D, E} ✅                      │
│                                                                  │
│     ВАЖНО: Маркет A НЕ удаляется, хотя выпал из топа!          │
│            Следим за ним до истечения!                          │
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│ T2: Expiry check обнаруживает истечение маркета A              │
│     → Отписываемся от WebSocket                                 │
│     → Финализируем маркет A (flush, сжатие)                     │
│     → Удаляем из registeredMarkets                              │
│     registeredMarkets = {B, C, D, E} ✅ (4/5 слотов)            │
│     freeSlots = 1 (освободился!)                                │
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│ T3: Periodic scan (через 30 сек)                               │
│     Топ-5 маркетов: [B, C, D, E, F]                            │
│     newMarkets = [F]                                            │
│     freeSlots = 5 - 4 = 1                                       │
│     → Добавляем F (есть свободный слот!)                        │
│     registeredMarkets = {B, C, D, E, F} ✅ (5/5 слотов)         │
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│ T4: Маркет B истекает                                           │
│     → Удаляется через expiry timer                              │
│     registeredMarkets = {C, D, E, F} ✅ (4/5 слотов)            │
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│ T5: Periodic scan                                               │
│     Топ-5 маркетов: [C, D, E, F, G]                            │
│     newMarkets = [G]                                            │
│     freeSlots = 5 - 4 = 1                                       │
│     → Добавляем G                                               │
│     registeredMarkets = {C, D, E, F, G} ✅ (5/5 слотов)         │
└─────────────────────────────────────────────────────────────────┘
```

### Логи системы

**При отсутствии свободных слотов:**
```
[DEBUG] No free slots for new markets (5/5 active, 3 candidates waiting)
```

**При добавлении новых маркетов:**
```
[INFO] 🔄 Found 2 new markets to add (3 available, 2 slots free)
[INFO] Adding market: Bitcoin price prediction...
[INFO] Adding market: Ethereum merge completion...
[INFO] ✅ Added 2 new markets (total: 5/5 markets)
```

**При истечении маркета:**
```
[INFO] ⏱️  Found 1 expired markets
[INFO] Market expired {
  conditionId: "0xb4b0ba4ccfae...",
  question: "Will Bitcoin go up or down..."
}
[INFO] ✅ Removed 1 expired markets (remaining: 4)
```

### Гарантии

✅ **Никогда** не превышает `MAX_CONCURRENT_MARKETS`
✅ **Всегда** отслеживает маркет до истечения (полнота данных)
✅ **Автоматически** заполняет свободные слоты лучшими маркетами из топа
✅ **Не теряет** данные при выпадении маркета из топа
✅ **Graceful** обработка race conditions между expiry timer и scan timer

### Конфигурация слотов

```bash
# Максимум одновременных маркетов
# 0 = без лимита (отслеживать ВСЕ маркеты из топа)
# N > 0 = отслеживать максимум N маркетов
MAX_CONCURRENT_MARKETS=5

# Интервал сканирования новых маркетов
MARKET_SCAN_PAUSE_MS=30000        # 30 секунд

# Интервал проверки истечения
MARKET_EXPIRY_CHECK_INTERVAL_MS=10000  # 10 секунд
```

### Особые случаи

**1. MAX_CONCURRENT_MARKETS=0 (без лимита)**
```typescript
const freeSlots = maxMarkets > 0
  ? Math.max(0, maxMarkets - currentCount)
  : Infinity;  // Неограниченное количество слотов
```

**2. Доступных маркетов меньше чем лимит**
```
MAX_CONCURRENT_MARKETS=5
Доступных маркетов: 3

→ Регистрируем все 3 маркета
→ registeredMarkets.size = 3 (меньше лимита - это нормально)
```

**3. Все маркеты истекли одновременно**
```
→ Expiry timer удаляет все маркеты
→ registeredMarkets.size = 0
→ При следующем scan добавятся новые (до лимита)
→ Логируется: "No markets remaining after expiry cleanup"
```

## Валидность данных

### Правила

1. **Валидные данные** - только при истечении маркета (`endDate < now`)
2. **Incomplete данные** - при остановке до истечения → `.incomplete/`
3. **При повторном запуске** - incomplete удаляются при старте

### Жизненный цикл файла

```
┌────────────────┐
│   Регистрация  │ → Создаётся файл в snapshots/YYYY-MM-DD/
└───────┬────────┘
        ▼
┌────────────────┐
│    Запись      │ → События буферизируются и записываются
└───────┬────────┘
        ▼
┌────────────────┐
│  Финализация   │
└───────┬────────┘
        │
        ├─► expired=true  → Файл остаётся (опционально сжимается)
        │
        └─► expired=false → Файл перемещается в .incomplete/
```

## Схема имени файла

```
{sanitized_question}___{sanitized_slug}.{ext}[.gz]
```

Пример:
```
Will Bitcoin go up or down___btc-up-jan3.jsonl
Will ETH reach 5000___eth-5k-dec.jsonl.gz
```

### Санитизация

- Запрещённые символы → `_`
- Control characters → удаляются
- Точки в конце → удаляются
- Длина → max 100 символов

## Интеграция

### С MultiMarketTrader

```typescript
const multiMarketTrader = new MultiMarketTrader(
  marketDiscovery,
  orchestratorFactory,
  config,
  logger,
  dataCollector  // Опциональный
);

// При добавлении маркета → dataCollector.registerMarket()
// При удалении маркета → dataCollector.finalizeMarket()
```

### С WebSocketManager

```typescript
wsManager.on('raw', (event: RawWsEvent) => {
  dataCollector.handleRawEvent(event);
});
```

## Мониторинг

### Логи

```
[INFO] DataRecorder initialized { outputDir, format, compression }
[INFO] Market registered for recording { slug, question, filePath }
[TRACE] Buffer flushed { slug, events, totalEvents }
[INFO] Market finalized (expired) { slug, eventsRecorded, filePath }
[INFO] File compressed { gzPath }
[WARN] Market finalized (incomplete) { slug, movedTo }
```

### Статистика

```typescript
const stats = dataCollector.getStats();
// {
//   enabled: true,
//   registeredMarkets: 5,
//   recorderStats: {
//     activeMarkets: 5,
//     totalEventsRecorded: 12450,
//     bufferedEvents: 37,
//     markets: [...]
//   }
// }
```

## Roadmap

### Текущая версия

- [x] NDJSON формат
- [x] Gzip сжатие
- [x] Буферизация
- [x] Standalone режим
- [x] Интеграция с trading
- [x] Parquet формат
- [x] Arrow формат

### Планируется

- [ ] Zstd сжатие
- [ ] Streaming decompression
- [ ] Data validation/repair tools
