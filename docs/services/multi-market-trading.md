# Multi-Market Trading

## Обзор

**Multi-Market Trading** - система для одновременной торговли на нескольких маркетах Polymarket с автоматическим распределением капитала и изоляцией состояния.

**Основные компоненты:**
- `MultiMarketTrader` - координатор торговли на нескольких маркетах
- `BalanceAllocator` - динамическое распределение капитала
- `MainTradingOrchestrator` - торговая логика для одного маркета (с метриками активности)

## Архитектура

```
┌─────────────────────────────────────────────────────────────────────┐
│                         MultiMarketTrader                           │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                     BalanceAllocator                         │   │
│  │  totalBalance: 1000 USDC                                     │   │
│  │  tradingBalance: 800 USDC (ratio: 0.8)                       │   │
│  │  allocations: Map<marketId, Money>                           │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  activeMarkets: Map<marketId, MarketContext>                        │
│                                                                     │
│  ┌─────────────────────┐  ┌─────────────────────┐                  │
│  │ MarketContext #1    │  │ MarketContext #2    │   ...            │
│  │                     │  │                     │                  │
│  │ market: Market      │  │ market: Market      │                  │
│  │ orchestrator: Orch  │  │ orchestrator: Orch  │                  │
│  │ allocatedBalance    │  │ allocatedBalance    │                  │
│  │ status: ACTIVE      │  │ status: ACTIVE      │                  │
│  │                     │  │                     │                  │
│  │ metrics: {          │  │ metrics: {          │                  │
│  │   tradesPerMin: 45  │  │   tradesPerMin: 30  │                  │
│  │   orderbookPerMin   │  │   orderbookPerMin   │                  │
│  │   quotesPerMin      │  │   quotesPerMin      │                  │
│  │ }                   │  │ }                   │                  │
│  └─────────────────────┘  └─────────────────────┘                  │
│           │                        │                                │
│           ▼                        ▼                                │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │              WebSocketManager (shared)                       │   │
│  │   Subscriptions: [yes1, no1, yes2, no2, ...]                │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

## BalanceAllocator

### Алгоритм распределения баланса

**Двухуровневое управление:**

```
Level 1: Total → Trading
  totalBalance = 1000 USDC
  tradingBalance = totalBalance × TRADING_BALANCE_RATIO
                 = 1000 × 0.8 = 800 USDC

Level 2: Trading → Per-Market
  freeBalance = tradingBalance - allocatedBalance
  perMarketBalance = freeBalance / newMarketsCount
```

### Ключевые методы

#### `allocateToNewMarkets(marketIds, remainingSlots)`

Распределяет **ВЕСЬ** свободный баланс между новыми маркетами (не только минимум).

```typescript
// Пример: свободно 400 USDC, добавляем 2 маркета
const result = allocator.allocateToNewMarkets(['market1', 'market2'], 2);
// Каждый маркет получит 200 USDC (не MIN_CAPITAL_PER_MARKET!)
```

**Алгоритм:**
1. Вычислить `freeBalance = tradingBalance - allocatedBalance`
2. Ограничить количество маркетов по `remainingSlots`
3. Вычислить `perMarketBalance = freeBalance / targetMarkets`
4. Если `perMarketBalance < MIN_CAPITAL_PER_MARKET`:
   - Уменьшить количество маркетов
   - Пересчитать `perMarketBalance`
5. Распределить весь свободный баланс

#### `releaseWithPnL(marketId, pnl)`

Освобождает allocation с учётом прибыли/убытка.

```typescript
// Маркет завершился с прибылью +$20
allocator.releaseWithPnL('market1', Money.fromUSDC(20));
// totalBalance увеличится на $20
// tradingBalance пересчитается

// Маркет завершился с убытком -$15
allocator.releaseWithPnL('market2', Money.fromUSDC(-15));
// totalBalance уменьшится на $15
```

### Пример расчёта

```
ВХОДНЫЕ ДАННЫЕ:
  totalBalance = 1000 USDC
  TRADING_BALANCE_RATIO = 0.8
  MAX_CONCURRENT_MARKETS = 5
  MIN_CAPITAL_PER_MARKET = 10 USDC
  Доступных маркетов = 3

РАСЧЁТ:
  1. tradingBalance = 1000 × 0.8 = 800 USDC
  2. targetMarkets = min(3, 5) = 3
  3. perMarketBalance = 800 / 3 = 266.67 USDC
  4. 266.67 >= 10 ✓ (достаточно)

РЕЗУЛЬТАТ:
  ✓ Подписка на 3 маркета
  ✓ Каждый маркет получает ~266.67 USDC
  ✓ Использовано 800 USDC
```

### Метрики (AllocationStats)

```typescript
interface AllocationStats {
  totalBalance: Money;           // Общий баланс (до ratio)
  tradingBalance: Money;         // Торговый баланс (после ratio)
  allocatedBalance: Money;       // Занятый баланс
  freeBalance: Money;            // Свободный баланс
  marketCount: number;           // Количество активных маркетов
  perMarketBalance: Money | null; // Средний капитал на маркет

  // Расширенные метрики
  utilization: number;           // allocatedBalance / tradingBalance (0-1)
  utilizationPercent: number;    // То же в процентах (0-100)
  avgCapitalPerMarket: number;   // Средний капитал на маркет
  remainder: Money;              // Свободный остаток
  availableSlots: number;        // Сколько маркетов ещё можно добавить
}
```

## Activity Metrics (Метрики активности)

Каждый `MainTradingOrchestrator` отслеживает активность **per-market**:

```typescript
// Получить метрики
const metrics = orchestrator.getMetrics();
// {
//   tradesPerMinute: 45,
//   orderbookUpdatesPerMinute: 120,
//   quotesUpdatesPerMinute: 12
// }
```

### Вывод в статус-лог

Метрики добавляются в JSON-лог оценки риска:

```json
{
  "status": "WARNING",
  "mode": "INVENTORY",
  "urgency": { "value": 63.37 },
  "netPositionUtilization": { "value": 0 },
  "grossPositionUtilization": { "value": 0 },
  "secondsToExpiry": 805.734,
  "timeToExpiry": "13m25s",
  "marketQuestion": "Ethereum Up or Down - December 29",
  "marketUrl": "https://polymarket.com/event/...",
  "recommendations": [...],
  "activityMetrics": {
    "tradesPerMinute": 45,
    "orderbookUpdatesPerMinute": 120,
    "quotesUpdatesPerMinute": 12
  },
  "orderbookState": {
    "yes": {
      "bestBid": 0.6500,
      "bestAsk": 0.6600,
      "midPrice": 0.6550,
      "spread": 0.0100,
      "bidDepth": 65,
      "askDepth": 34
    },
    "no": {
      "bestBid": 0.3300,
      "bestAsk": 0.3500,
      "midPrice": 0.3400,
      "spread": 0.0200,
      "bidDepth": 42,
      "askDepth": 28
    },
    "arbitrage": {
      "type": "SELL_BOTH",
      "yesPrice": 0.66,
      "noPrice": 0.36,
      "sum": 1.02,
      "expectedSum": 1.0,
      "profitPercent": 0.8,
      "action": "Sell YES at 0.6600, Sell NO at 0.3600",
      "profitPerUSDC": 0.008
    }
  }
}
```

**Примечание:** `arbitrage` будет `null` если нет арбитражной возможности.

### Orderbook State Metrics

| Метрика | Описание |
|---------|----------|
| `yes.bestBid` | Лучшая цена покупки YES токена |
| `yes.bestAsk` | Лучшая цена продажи YES токена |
| `yes.midPrice` | Средняя цена YES (bid+ask)/2, округлено до 4 знаков |
| `yes.spread` | Спред YES (ask - bid), округлено до 4 знаков |
| `yes.bidDepth` | Количество уровней bid в ордербуке YES |
| `yes.askDepth` | Количество уровней ask в ордербуке YES |
| `no.*` | Аналогичные метрики для NO токена |

### Arbitrage Detection (ArbitrageDetector)

Используется доменный сервис `ArbitrageDetector` для обнаружения арбитражных возможностей с учётом комиссий.

| Поле | Описание |
|------|----------|
| `type` | Тип арбитража: `SELL_BOTH` или `BUY_BOTH` |
| `yesPrice` | Цена YES токена для сделки |
| `noPrice` | Цена NO токена для сделки |
| `sum` | Сумма цен (YES + NO) |
| `expectedSum` | Ожидаемая сумма (1.0) |
| `profitPercent` | Процент прибыли после комиссий |
| `action` | Рекомендуемое действие |
| `profitPerUSDC` | Прибыль на каждый вложенный $1 |

**Условия арбитража (с учётом fees 0.2%):**
```
SELL_BOTH: (YES_bid + NO_bid) > 1.0 + 0.002 = 1.002
BUY_BOTH:  (YES_ask + NO_ask) < 1.0 - 0.002 = 0.998
```

**Пример:**
```
YES_bid = 0.66, NO_bid = 0.36 → sum = 1.02 > 1.002 → SELL_BOTH
profitPercent = (1.02 - 1.0 - 0.002) * 100 = 1.8%
```

## Order ID Format

Формат ID ордера для гарантии уникальности в multi-market сценарии:

```
{side}-{fullTokenId}-{timestamp}

Примеры:
  bid-71321045679252212594626385532706912750332728571942532289631379312455583286320-1767024644010
  ask-71321045679252212594626385532706912750332728571942532289631379312455583286320-1767024644011
```

**Зачем полный tokenId:**
- Гарантирует уникальность даже если два маркета генерируют ордера в одну миллисекунду
- Позволяет идентифицировать маркет по ID ордера

## InMemoryOrderRepository

### Новые методы поиска

```typescript
// Найти ордера по токену (использует индекс)
const yesOrders = await repository.findByTokenId(market.yesTokenId);
const noOrders = await repository.findByTokenId(market.noTokenId);

// Найти все ордера маркета (оба токена)
const allOrders = await repository.findByMarketTokens(
  market.yesTokenId,
  market.noTokenId
);
```

### Структура индексов

```
orders: Map<orderId, Order>              // O(1) по ID
tokenIdIndex: Map<tokenId, Set<orderId>> // O(1) по токену
statusIndex: Map<status, Set<orderId>>   // O(1) по статусу
```

### Deprecated

```typescript
// ⚠️ НЕ ИСПОЛЬЗОВАТЬ - не работает!
await repository.findByMarket(marketId);

// ✅ Использовать вместо:
await repository.findByMarketTokens(yesTokenId, noTokenId);
```

## Уровни логирования

| Лог | Уровень | Описание |
|-----|---------|----------|
| `Trade (YES/NO): BUY/SELL...` | TRACE | Каждый трейд в orderbook |
| `Orderbook (YES/NO): bid=... ask=...` | TRACE | Каждое обновление orderbook |
| `Quotes updated: bid=... ask=...` | TRACE | Обновление котировок |
| Risk Assessment JSON | DEBUG | Оценка риска + метрики активности |
| `Trading mode changed` | INFO | Смена режима торговли |
| `Market added/removed` | INFO | Добавление/удаление маркета |

**Для детального просмотра установите `LOG_LEVEL=trace` в .env**

## Конфигурация (.env)

```bash
# ========================================
# Multi-Market Trading Configuration
# ========================================

# Maximum concurrent markets to trade
# 0 = subscribe to ALL markets passing filters
# N > 0 = subscribe to at most N markets
MAX_CONCURRENT_MARKETS=5

# Fraction of total balance available for trading
# Value: (0.0, 1.0]
# Example: 0.8 = use 80% of balance for trading, keep 20% as reserve
TRADING_BALANCE_RATIO=1.0

# Minimum capital required per market (USDC)
# If per-market balance < this value, reduce number of markets
MIN_CAPITAL_PER_MARKET=10

# Pause between market discovery scans (ms)
MARKET_SCAN_PAUSE_MS=30000

# Interval for checking market expiry (ms)
MARKET_EXPIRY_CHECK_INTERVAL_MS=1000

# Log level (error, warn, info, debug, trace)
LOG_LEVEL=debug
```

## Использование

### Базовый пример

```typescript
import { MultiMarketTrader } from './application/services/MultiMarketTrader';
import { BalanceAllocator } from './application/services/BalanceAllocator';
import { Money } from './domain/value-objects/Money';

// 1. Создание MultiMarketTrader
const trader = new MultiMarketTrader(
  marketDiscovery,
  orchestratorFactory,
  {
    maxConcurrentMarkets: 5,
    tradingBalanceRatio: 0.8,
    minCapitalPerMarket: 10,
    scanPauseMs: 30000,
    expiryCheckIntervalMs: 1000,
  },
  logger
);

// 2. Запуск
await trader.start(Money.fromUSDC(1000));

// 3. Получение статуса
const status = trader.getStatus();
console.log(`Active markets: ${status.activeMarketCount}`);
console.log(`Utilization: ${status.utilizationPercent}%`);
console.log(`Available slots: ${status.availableSlots}`);

// 4. Остановка
await trader.stop();
```

### Получение статуса

```typescript
interface MultiMarketStatus {
  isRunning: boolean;
  totalBalance: number;
  tradingBalance: number;
  allocatedBalance: number;
  freeBalance: number;
  activeMarketCount: number;
  maxConcurrentMarkets: number;
  atCapacity: boolean;

  // Метрики использования
  utilization: number;           // 0-1
  utilizationPercent: number;    // 0-100
  avgCapitalPerMarket: number;
  availableSlots: number;

  markets: MarketStatusInfo[];
  lastScanAt: Date | null;
  nextScanAt: Date | null;
  recentErrors: string[];
}
```

## Жизненный цикл маркета

```
┌──────────────┐
│   PENDING    │  Маркет добавлен, orchestrator инициализируется
└──────┬───────┘
       │ orchestrator.start()
       ▼
┌──────────────┐
│    ACTIVE    │  Маркет активно торгуется
└──────┬───────┘
       │ market.isExpired() или ошибка
       ▼
┌──────────────┐
│   EXPIRED    │  Маркет истёк
│   / ERROR    │
└──────┬───────┘
       │ removeMarket()
       ▼
┌──────────────┐
│   REMOVED    │  Баланс освобождён, orchestrator остановлен
└──────────────┘
       │
       ▼
  Баланс возвращается в пул → allocateToNewMarkets() для нового маркета
```

## Диаграмма потока данных

```
                     ┌─────────────────┐
                     │  MarketDiscovery │
                     │     Service      │
                     └────────┬────────┘
                              │ candidates[]
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    MultiMarketTrader                         │
│                                                              │
│  tryAddMarketsFromDiscovery()                                │
│    │                                                         │
│    ├── Check remainingSlots                                  │
│    ├── Filter already active markets                         │
│    ├── BalanceAllocator.allocateToNewMarkets()              │
│    └── addMarketFromCandidate() for each                    │
│              │                                               │
│              ▼                                               │
│    ┌─────────────────────────────────────────┐              │
│    │         MarketContext                    │              │
│    │  ┌─────────────────────────────────┐    │              │
│    │  │    MainTradingOrchestrator      │    │              │
│    │  │                                  │    │              │
│    │  │  - handleOrderbookUpdate()       │    │              │
│    │  │  - handleTradeUpdate()           │    │              │
│    │  │  - updateQuotes()                │    │              │
│    │  │  - metrics tracking              │    │              │
│    │  └─────────────────────────────────┘    │              │
│    └─────────────────────────────────────────┘              │
│                                                              │
│  checkMarketExpiry() (every 1s)                             │
│    └── removeMarket() if expired                            │
│          └── BalanceAllocator.releaseWithPnL()              │
│                                                              │
│  performScan() (every 30s)                                  │
│    └── tryAddMarketsFromDiscovery()                         │
└─────────────────────────────────────────────────────────────┘
```

## Сравнение с MarketRotationManager

| Аспект | MarketRotationManager | MultiMarketTrader |
|--------|----------------------|-------------------|
| Маркеты | 1 активный | N активных |
| Переключение | После истечения | Параллельная работа |
| Баланс | Весь на одном маркете | Распределён между маркетами |
| Изоляция | - | Полная изоляция состояния |
| Метрики | - | Per-market метрики |

**Рекомендация:** Используйте `MultiMarketTrader` для production. `MarketRotationManager` устарел.

## Связанные файлы

```
src/application/services/
├── MultiMarketTrader.ts      # Координатор multi-market
├── BalanceAllocator.ts       # Распределение баланса
└── types/multi-market.ts     # Типы

src/application/orchestrators/
└── MainTradingOrchestrator.ts  # Торговая логика + метрики

src/infrastructure/persistence/repositories/
└── InMemoryOrderRepository.ts  # Репозиторий с findByTokenId

src/infrastructure/config/
└── EnvConfig.ts                # Конфигурация
```
