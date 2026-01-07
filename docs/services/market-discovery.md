# Market Discovery Service

## Обзор

**MarketDiscoveryService** - сервис для сканирования, фильтрации и выбора рынков Polymarket для трейдинга.

**ВАЖНО:** Сервис работает ТОЛЬКО с реальными рынками из Gamma API.
- В **SIMULATION** режиме: используются реальные данные рынков, ордера симулируются
- В **LIVE** режиме: используются реальные данные рынков, ордера размещаются реально

❌ **НЕТ** виртуальных/фейковых рынков для изолированного тестирования
✅ **ЕСТЬ** реальные рынки из Gamma API для симуляции и живой торговли

## Архитектура

```
MarketDiscoveryService (orchestrator)
├── GammaApiClient (data fetching)
├── MarketFilter (filtering)
└── MarketScorer (scoring/ranking)
```

### Компоненты

#### 1. GammaApiClient

Клиент для взаимодействия с Polymarket Gamma API.

**Методы:**
- `getActiveMarkets()` - получить все активные рынки
- `getMarket(conditionId)` - получить конкретный рынок по ID

**Пример:**
```typescript
const client = new GammaApiClient(
  { baseUrl: 'https://gamma-api.polymarket.com', timeout: 10000 },
  logger
);

const markets = await client.getActiveMarkets();
console.log(`Fetched ${markets.length} markets`);
```

#### 2. MarketFilter

Фильтрация рынков по критериям (структурная валидация из v3.js).

**ВАЖНО:** Используется **structure-based validation** (не только текстовое совпадение):

**Структурная валидация (из v3.js):**
1. **Parse clobTokenIds** - обработка как массива так и JSON строки
2. **Binary market check** - ровно 2 токена (YES/NO)
3. **Token ID validation** - не пустые строки
4. **Required fields** - conditionId, question, endDate
5. **Outcomes validation** - массив outcomes (если есть) должен содержать 2 элемента

**Фильтры:**
- **Базовые:** `active && !closed && enableOrderBook`
- **Время до экспирации:** `minTimeToExpiryHours` (0 = любые рынки)
- **Спред:** `minSpread` (0.02 = 2% минимум)
- **Объем:** `minDailyVolume` (100 USD минимум)
- **Ключевые слова:**
  - `requiredKeywords` - ВСЕ должны присутствовать (например: `['up', 'down']`)
  - `anyOfKeywords` - ХОТЯ БЫ ОДНО должно присутствовать (например: `['bitcoin', 'ethereum', 'solana', 'xrp']`)
  - `excludedKeywords` - НИ ОДНО не должно присутствовать

**Пример:**
```typescript
const filter = new MarketFilter({
  minTimeToExpiryHours: 0,
  minSpread: 0.02,
  minDailyVolume: 100,
  maxMarketsToTrack: 5,
  requiredKeywords: ['up', 'down'],
  anyOfKeywords: ['bitcoin', 'ethereum', 'solana', 'xrp'],
}, logger);

const candidates = filter.filterMarkets(rawMarkets);
```

**Пример фильтра из оригинального кода:**
```javascript
return m.active && !m.closed && m.enableOrderBook &&
    (question.includes('bitcoin') || question.includes('ethereum') || question.includes('solana') || question.includes('xrp')) &&
    question.includes('up') &&
    question.includes('down');
```

**Эквивалентная конфигурация:**
```typescript
{
  requiredKeywords: ['up', 'down'],
  anyOfKeywords: ['bitcoin', 'ethereum', 'solana', 'xrp'],
}
```

#### 3. MarketScorer

Сортировка рынков по приоритету (логика из v3.js).

**ВАЖНО:** НЕ используется взвешенная оценка. Простая сортировка по ближайшей экспирации.

**Алгоритм (из v3.js filterAndSortMarkets):**
1. Сортировка по endDate по возрастанию (EARLIEST first)
2. Если endDate равны - сортировка по алфавиту (question)
3. Score устанавливается в часы до экспирации (для отображения)

**Формат времени в логах:**

Время до экспирации выводится в человекочитаемом формате:
- `>= 1 часа`: `"1h30m"` (часы и минуты)
- `< 1 часа`: `"5m45s"` (минуты и секунды)
- `< 1 минуты`: `"30s"` (только секунды)

**Пример вывода:**
```
Sorted 33 markets by expiry (soonest first)
  1. [5m45s] Ethereum Up or Down - December 28, 3:00PM-3:15PM ET...
  2. [6m12s] Solana Up or Down - December 28, 3:00PM-3:15PM ET...
  3. [1h15m] Ethereum Up or Down - December 28, 3:15PM-3:30PM ET...
```

**Из v3.js кода:**
```javascript
// Sort by expiry time: EARLIEST first (ascending order)
// If expiry time is the same, sort alphabetically by question
futureMarkets.sort((a, b) => {
  const dateA = new Date(a.endDate);
  const dateB = new Date(b.endDate);
  const timeDiff = dateA.getTime() - dateB.getTime();

  if (timeDiff === 0) {
    return a.question.localeCompare(b.question);
  }

  return timeDiff;  // Ascending: soonest first
});
```

**Пример:**
```typescript
const scorer = new MarketScorer({
  timeToExpiry: 3.0,
  liquidity: 2.0,
  volume: 1.0,
}, logger);

const sorted = scorer.scoreMarkets(candidates);
const best = sorted[0]; // Earliest expiry
console.log(`Best: ${best.question} (${best.score.toFixed(0)}h until expiry)`);
```

#### 4. MarketDiscoveryService

Главный сервис - оркестратор всего процесса.

**Конфигурация:**
```typescript
interface MarketDiscoveryConfig {
  filter: MarketFilterConfig;
  scoring?: MarketScoringWeights; // Optional, defaults to DEFAULT_SCORING_WEIGHTS
}
```

**Методы:**
- `findBestMarket()` - найти лучший рынок для трейдинга
- `refresh()` - обновить список рынков (форсировать новый запрос к API)

## Алгоритм работы

### findBestMarket()

```
1. FETCH: Получить список рынков из Gamma API
   └─> GammaApiClient.getActiveMarkets()
   └─> Пагинация (до 10 страниц, 500 рынков на страницу)
   └─> Кэширование на 60 секунд

2. FILTER: Применить структурную валидацию и фильтры (v3.js logic)
   ├─> Базовые критерии (active, not closed, order book enabled)
   ├─> Structure-based validation:
   │   ├─> Parse clobTokenIds (array or JSON string)
   │   ├─> Binary market check (exactly 2 tokens)
   │   ├─> Token ID validation (non-empty strings)
   │   ├─> Required fields (conditionId, question, endDate)
   │   └─> Outcomes validation (if present, must have 2 elements)
   ├─> Время до экспирации
   ├─> Спред
   ├─> Объем
   └─> Ключевые слова

3. SORT: Сортировать по ближайшей экспирации (v3.js logic)
   ├─> Sort by endDate ascending (EARLIEST first)
   └─> If equal, sort alphabetically by question

4. SELECT: Выбрать первый
   └─> Рынок с ближайшей экспирацией (не наивысшим score!)
```

## Использование

### Базовый пример

```typescript
import {
  MarketDiscoveryService,
  GammaApiClient,
} from './domain/services/market-discovery';

// 1. Создать API клиент
const apiClient = new GammaApiClient(
  {
    baseUrl: 'https://gamma-api.polymarket.com',
    timeout: 10000,
  },
  logger
);

// 2. Создать сервис
const discovery = new MarketDiscoveryService(
  apiClient,
  {
    filter: {
      minTimeToExpiryHours: 0,
      minSpread: 0.02,
      minDailyVolume: 100,
      maxMarketsToTrack: 5,
      requiredKeywords: ['up', 'down'],
      anyOfKeywords: ['bitcoin', 'ethereum', 'solana', 'xrp'],
    },
  },
  logger
);

// 3. Найти лучший рынок
const result = await discovery.findBestMarket();

if (result.market) {
  console.log(`Selected: ${result.market.question}`);
  console.log(`Score: ${result.market.score}`);
  console.log(`Time to expiry: ${(result.market.timeToExpiry / (1000 * 60 * 60)).toFixed(2)}h`);
  console.log(`Volume: $${result.market.dailyVolume}`);
  console.log(`Liquidity: $${result.market.liquidity}`);
  console.log(`Spread: ${result.market.spread.toFixed(4)}`);

  // Начать трейдинг
  await startTrading(result.market);
} else {
  console.log('No suitable markets found');
}
```

### Периодическое сканирование

```typescript
// Сканировать каждые 5 минут
setInterval(async () => {
  const result = await discovery.findBestMarket();

  if (result.market) {
    // Проверить, изменился ли рынок
    if (currentMarket?.conditionId !== result.market.conditionId) {
      console.log(`Switching to new market: ${result.market.question}`);
      await switchMarket(result.market);
    }
  }
}, 5 * 60 * 1000);
```

### Интеграция с Main Loop

```typescript
// В главном цикле бота
async function mainLoop() {
  // 1. Market Discovery
  const discoveryResult = await marketDiscovery.findBestMarket();

  if (!discoveryResult.market) {
    logger.warn('No markets available, waiting...');
    await sleep(60000); // Wait 1 minute
    return;
  }

  const market = discoveryResult.market;

  // 2. Subscribe to orderbook
  await wsAdapter.subscribeToOrderbook(market.yesTokenId, handleYesOrderbook);
  await wsAdapter.subscribeToOrderbook(market.noTokenId, handleNoOrderbook);

  // 3. Start trading loop
  while (shouldContinueTrading(market)) {
    // ... trading logic
    await sleep(CONFIG.UPDATE_INTERVAL_MS);
  }

  // 4. Cleanup
  await wsAdapter.unsubscribeAll();
}
```

## Конфигурация

Конфигурация Market Discovery загружается из переменных окружения (`.env`):

### Переменные окружения

#### Market Discovery

| Переменная | По умолчанию | Описание |
|------------|--------------|----------|
| `MARKET_DISCOVERY_MIN_TIME_TO_EXPIRY_HOURS` | `0` | Минимум часов до экспирации (0 = любой) |
| `MARKET_DISCOVERY_MIN_SPREAD` | `0.02` | Минимальный спред (0.02 = 2%) |
| `MARKET_DISCOVERY_MIN_DAILY_VOLUME` | `100` | Минимальный объём ($100) |
| `MARKET_DISCOVERY_REQUIRED_KEYWORDS` | `up,down` | ВСЕ должны присутствовать (через запятую) |
| `MARKET_DISCOVERY_ANY_OF_KEYWORDS` | `bitcoin,ethereum,solana,xrp` | ХОТЯ БЫ ОДНО должно присутствовать |

#### Multi-Market Trading

| Переменная | По умолчанию | Описание |
|------------|--------------|----------|
| `MAX_CONCURRENT_MARKETS` | `5` | Макс. количество одновременно торгуемых рынков (0 = все) |
| `TRADING_BALANCE_RATIO` | `1.0` | Доля баланса для торговли (0.8 = 80%) |
| `MIN_CAPITAL_PER_MARKET` | `10` | Минимальный капитал на рынок (USDC) |

### Пример .env

```bash
# Market Discovery Configuration
MARKET_DISCOVERY_MIN_TIME_TO_EXPIRY_HOURS=0
MARKET_DISCOVERY_MIN_SPREAD=0.02
MARKET_DISCOVERY_MIN_DAILY_VOLUME=100
MARKET_DISCOVERY_REQUIRED_KEYWORDS=up,down
MARKET_DISCOVERY_ANY_OF_KEYWORDS=bitcoin,ethereum,solana,xrp

# Multi-Market Trading Configuration
MAX_CONCURRENT_MARKETS=5
TRADING_BALANCE_RATIO=1.0
MIN_CAPITAL_PER_MARKET=10
```

### Алгоритм распределения баланса

При старте multi-market trading:

```
1. tradingBalance = totalBalance * TRADING_BALANCE_RATIO
2. targetMarkets = min(доступные рынки, MAX_CONCURRENT_MARKETS)
3. perMarketBalance = tradingBalance / targetMarkets

4. Если perMarketBalance < MIN_CAPITAL_PER_MARKET:
   - Уменьшаем количество рынков
   - maxAffordableMarkets = floor(tradingBalance / MIN_CAPITAL_PER_MARKET)
   - Используем MIN_CAPITAL_PER_MARKET на рынок
```

**Пример:**

```
Входные данные:
  totalBalance = 1000 USDC
  TRADING_BALANCE_RATIO = 0.05
  MAX_CONCURRENT_MARKETS = 10
  MIN_CAPITAL_PER_MARKET = 10 USDC
  Доступно рынков = 8

Расчёт:
  1. tradingBalance = 1000 * 0.05 = 50 USDC
  2. targetMarkets = min(8, 10) = 8
  3. perMarketBalance = 50 / 8 = 6.25 USDC
  4. 6.25 < 10 -> НЕДОСТАТОЧНО!
  5. maxAffordableMarkets = floor(50 / 10) = 5

Результат:
  - Подписка на 5 рынков (из 8 доступных)
  - Каждый рынок получает 10 USDC
```

### Использование в коде

Конфигурация автоматически загружается из `EnvConfig`:

```typescript
const marketDiscovery = new MarketDiscoveryService(
  gammaApiClient,
  {
    filter: {
      minTimeToExpiryHours: env.MARKET_DISCOVERY_MIN_TIME_TO_EXPIRY_HOURS,
      minSpread: env.MARKET_DISCOVERY_MIN_SPREAD,
      minDailyVolume: env.MARKET_DISCOVERY_MIN_DAILY_VOLUME,
      maxMarketsToTrack: env.MAX_CONCURRENT_MARKETS,
      requiredKeywords: env.MARKET_DISCOVERY_REQUIRED_KEYWORDS,
      anyOfKeywords: env.MARKET_DISCOVERY_ANY_OF_KEYWORDS,
    },
  },
  logger
);

// Создание multi-market trader
const multiMarketTrader = new MultiMarketTrader(
  marketDiscovery,
  orchestratorFactory,
  {
    maxConcurrentMarkets: env.MAX_CONCURRENT_MARKETS,
    tradingBalanceRatio: env.TRADING_BALANCE_RATIO,
    minCapitalPerMarket: env.MIN_CAPITAL_PER_MARKET,
    scanPauseMs: env.MARKET_SCAN_PAUSE_MS,
    expiryCheckIntervalMs: env.MARKET_EXPIRY_CHECK_INTERVAL_MS,
  },
  logger
);

await multiMarketTrader.start(totalBalance);
```

### Примечания по конфигурации

- **Keywords** - регистронезависимые, разделяются запятой
- **Пустая строка** в keywords = фильтр отключён
- **minTimeToExpiryHours = 0** = любой рынок включая ближайший к экспирации
- **MAX_CONCURRENT_MARKETS = 0** = подписка на все рынки, прошедшие фильтры
- Изменения в `.env` применяются при перезапуске бота

## Типы данных

### GammaMarketData

Raw market data from Gamma API:

```typescript
interface GammaMarketData {
  conditionId: string;
  question: string;
  description?: string;
  endDate: string;
  active: boolean;
  closed: boolean;
  enableOrderBook: boolean;
  tags?: string[];
  tokens?: Array<{
    tokenId: string;
    outcome: string;
    price?: number;
  }>;
  clobTokenIds?: string[] | string;
  outcomes?: string[];
  volume?: number;
  liquidity?: number;
  spread?: number;
}
```

### MarketCandidate

Processed market after filtering:

```typescript
interface MarketCandidate {
  conditionId: string;
  question: string;
  endDate: Date;
  timeToExpiry: number;
  yesTokenId: string;
  noTokenId: string;
  dailyVolume: number;
  liquidity: number;
  spread: number;
  score: number;
  rawData: GammaMarketData;
}
```

### MarketDiscoveryResult

Result with best market and metadata:

```typescript
interface MarketDiscoveryResult {
  market: MarketCandidate | null;  // Best market (highest score)
  candidates: MarketCandidate[];    // All candidates (sorted by score)
  totalFetched: number;             // Total markets from API
  totalFiltered: number;            // Markets that passed filters
  timestamp: Date;                  // Discovery timestamp
}
```

## Примеры фильтрации

### Пример 1: Крипто-рынки с UP/DOWN

```typescript
{
  requiredKeywords: ['up', 'down'],
  anyOfKeywords: ['bitcoin', 'ethereum', 'solana', 'xrp'],
}
```

**Результат:**
- ✅ "Will Bitcoin go up or down?" (есть up, down, bitcoin)
- ✅ "Ethereum up vs down" (есть up, down, ethereum)
- ❌ "Will Bitcoin hit $100k?" (нет up/down)
- ❌ "Gold price up or down" (нет крипто-ключевого слова)

### Пример 2: Только краткосрочные рынки

```typescript
{
  minTimeToExpiryHours: 0,
  maxTimeToExpiryHours: 24, // Custom filter in code
}
```

### Пример 3: Высоколиквидные рынки

```typescript
{
  minDailyVolume: 10000,  // $10k minimum
  minLiquidity: 5000,     // $5k minimum liquidity
  minSpread: 0.01,        // 1% minimum spread
}
```

## Логирование

Сервис логирует на каждом этапе:

```
[INFO] MarketDiscoveryService initialized
[INFO] Finding best market...
[INFO] Fetched markets from Gamma API (count: 450)
[DEBUG] Market filtered: insufficient time to expiry (question: "...", hoursToExpiry: 0.5)
[DEBUG] Market filtered: spread too tight (question: "...", spread: 0.01)
[INFO] Filtered markets (total: 450, passed: 23, filtered: 427)
[INFO] Sorted 23 markets by expiry (soonest first)
[INFO] Markets discovered (totalFetched: 450, totalFiltered: 23, candidates: 5)
```

### Multi-Market логирование

При работе с несколькими маркетами, логи содержат название маркета:

```
[DEBUG] [Bitcoin] Orderbook (YES): bid=0.6100 ask=0.6200 mid=0.6150 spread=0.0100
[DEBUG] [Ethereum] Orderbook (NO): bid=0.3800 ask=0.3900 mid=0.3850 spread=0.0100
[DEBUG] [Bitcoin] Trade (YES): BUY 162 @ 0.6200
[INFO] [Bitcoin] [SIMULATION] Order: BUY 100 @ 0.6037
[INFO] [Bitcoin] [SIMULATION] Cancelled 2 orders
```

## Тестирование

### Unit тесты

```typescript
describe('MarketFilter', () => {
  it('should filter markets by keywords', () => {
    const filter = new MarketFilter({
      requiredKeywords: ['up', 'down'],
      anyOfKeywords: ['bitcoin'],
    }, logger);

    const markets = [
      { question: 'Bitcoin up or down', ... },
      { question: 'Ethereum price', ... },
    ];

    const result = filter.filterMarkets(markets);
    expect(result).toHaveLength(1);
    expect(result[0].question).toContain('Bitcoin');
  });
});
```

### Integration тесты

```typescript
describe('MarketDiscoveryService', () => {
  it('should find best market from real API', async () => {
    const service = new MarketDiscoveryService(apiClient, config, logger);
    const result = await service.findBestMarket();

    expect(result.market).toBeDefined();
    expect(result.market.score).toBeGreaterThan(0);
    expect(result.candidates.length).toBeGreaterThan(0);
  });
});
```

## Заключение

**MarketDiscoveryService** обеспечивает автоматический выбор лучших рынков для трейдинга на основе реальных данных Polymarket. Сервис работает одинаково в симуляции и живой торговле, обеспечивая единообразный процесс discovery без фейковых рынков.
