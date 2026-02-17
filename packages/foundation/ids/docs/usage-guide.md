# Руководство по использованию @polymarket/ids

## Быстрый старт

```typescript
import {
  type ConditionRef,
  type OutcomeKey,
  type AccountId,
  type VenueId,
  type AssetId,
  KnownCurrencies,
  KnownChainIds,
  KnownVenues,
  KnownOnChainProtocols,
  BinaryOutcome,
  isSupportedCurrency,
  accountIdFromWallet,
  parseWalletAddress,
  parseConditionId,
  AssetIdHelpers,
} from '@polymarket/ids';

// Wallet account
const walletAccount: AccountId = accountIdFromWallet(parseWalletAddress('0x1234...')!);

// ConditionRef — on-chain (Polymarket)
const conditionId = parseConditionId('0x4869df2f6745f3c59c91af1c9d6dc75a5282a3d6a15b7c8e9f2d1a3b4c5e6f7a');
const onChainRef: ConditionRef = {
  kind: 'ONCHAIN',
  protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
  chainId: KnownChainIds.POLYGON,
  conditionId: conditionId!,
};

// ConditionRef — off-chain (Kalshi)
const offChainRef: ConditionRef = {
  kind: 'OFFCHAIN',
  venueId: KnownVenues.KALSHI,
  marketId: 'KXBTCUSDM-24APR',
};

// AssetId
const usdcAsset = AssetIdHelpers.USDC;
const yesToken = AssetIdHelpers.fromOutcomeToken(onChainRef, BinaryOutcome.UP);
```

```typescript
// Market Data IDs
import {
  type MarketDataSourceId,
  KnownMarketDataSources,
  sourceToVenue,
} from '@polymarket/ids/market-data';

const liveSource: MarketDataSourceId = KnownMarketDataSources.POLYMARKET_WS;
const venue = sourceToVenue(liveSource); // → 'POLYMARKET'
```

```typescript
// Execution IDs
import {
  type ExecutionVenueId,
  KnownExecutionVenues,
} from '@polymarket/ids/execution';

const liveVenue: ExecutionVenueId = KnownExecutionVenues.POLYMARKET;
const simulator: ExecutionVenueId = KnownExecutionVenues.SIMULATOR;
```

---

## Установка и импорт

### Установка

```bash
npm install @polymarket/ids
```

### Импорты

```typescript
// Main export - core types
import {
  type ConditionRef,
  type OutcomeKey,
  type AccountId,
  type VenueId,
  type AssetId,
  BinaryOutcome,
  AssetIdHelpers,
  KnownChainIds,
  KnownVenues,
} from '@polymarket/ids';

// Subpath exports
import {
  type MarketDataSourceId,
  type InstrumentId,
  KnownMarketDataSources,
  sourceToVenue,
  isLiveSource,
} from '@polymarket/ids/market-data';

import {
  type ExecutionVenueId,
  type OrderId,
  type FillId,
  KnownExecutionVenues,
  isSimulator,
} from '@polymarket/ids/execution';
```

---

## Сценарии использования

### 1. Live Trading (реальная торговля)

**Сценарий**: Подключаемся к Polymarket WebSocket, получаем котировки, торгуем реально.

```typescript
import {
  type ConditionRef,
  type OnChainConditionRef,
  type AccountId,
  type VenueId,
  type WalletAddress,
  type ConditionId,
  parseWalletAddress,
  accountIdFromWallet,
  BinaryOutcome,
  AssetIdHelpers,
  KnownChainIds,
} from '@polymarket/ids';
import {
  type MarketDataSourceId,
  KnownMarketDataSources,
  sourceToVenue,
} from '@polymarket/ids/market-data';
import {
  type ExecutionVenueId,
  KnownExecutionVenues,
} from '@polymarket/ids/execution';

// 1. Настройка
const marketDataSource: MarketDataSourceId = KnownMarketDataSources.POLYMARKET_WS;
const executionVenue: ExecutionVenueId = KnownExecutionVenues.POLYMARKET;
const walletAddr = parseWalletAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')!;
const accountId: AccountId = accountIdFromWallet(walletAddr);

// 2. Создание ConditionRef
const conditionRef: OnChainConditionRef = {
  kind: 'ONCHAIN',
  protocolId: 'POLYMARKET_CTF',
  chainId: KnownChainIds.POLYGON,
  conditionId: '0xabc123...' as ConditionId,
};

// 3. Получаем котировку
const quote = {
  sourceId: marketDataSource,
  conditionRef,
  bid: 0.48,
  ask: 0.52,
  timestamp: Date.now(),
};

// 4. Проверяем баланс на том же venue
const venueId: VenueId = sourceToVenue(quote.sourceId)!;  // → 'POLYMARKET'
const balance = getBalance(accountId, venueId, AssetIdHelpers.USDC);

if (balance.amount.gte(Money.of(100, 'USDC'))) {
  // 5. Отправляем ордер
  const order = {
    executionVenue,
    conditionRef,
    outcomeKey: BinaryOutcome.UP,
    side: 'BUY',
    price: 0.52,
    quantity: 100,
  };

  await sendOrder(order);
}
```

---

### 2. Paper Trading (симуляция)

**Сценарий**: Подключаемся к live данным, но торгуем в симуляторе.

```typescript
import {
  BinaryOutcome,
} from '@polymarket/ids';
import {
  type MarketDataSourceId,
  KnownMarketDataSources,
} from '@polymarket/ids/market-data';
import {
  type ExecutionVenueId,
  KnownExecutionVenues,
  isSimulator,
} from '@polymarket/ids/execution';

// 1. Live market data
const marketDataSource: MarketDataSourceId = KnownMarketDataSources.POLYMARKET_WS;

// 2. Simulator execution
const executionVenue: ExecutionVenueId = KnownExecutionVenues.SIMULATOR;

// 3. Получаем live котировку
const quote = {
  sourceId: marketDataSource,
  conditionRef,
  bid: 0.48,
  ask: 0.52,
};

// 4. Торгуем в симуляторе
if (isSimulator(executionVenue)) {
  // Симулятор не требует реального баланса
  const simulatedOrder = {
    executionVenue,
    conditionRef,
    outcomeKey: BinaryOutcome.UP,
    side: 'BUY',
    price: quote.ask,
    quantity: 100,
  };

  await simulateOrder(simulatedOrder);
}
```

---

### 3. Backtest (тестирование на истории)

**Сценарий**: Загружаем исторические данные, торгуем в симуляторе.

```typescript
import {
  type ConditionRef,
  type ConditionId,
  BinaryOutcome,
  KnownChainIds,
  KnownOnChainProtocols,
} from '@polymarket/ids';
import {
  type MarketDataSourceId,
  KnownMarketDataSources,
  isReplaySource,
} from '@polymarket/ids/market-data';
import {
  type ExecutionVenueId,
  KnownExecutionVenues,
} from '@polymarket/ids/execution';

// 1. Replay source
const marketDataSource: MarketDataSourceId = KnownMarketDataSources.POLYMARKET_REPLAY;
const executionVenue: ExecutionVenueId = KnownExecutionVenues.SIMULATOR;

if (isReplaySource(marketDataSource)) {
  console.log('Running backtest');
}

// Пример ConditionRef для backtest
const conditionRef: ConditionRef = {
  kind: 'ONCHAIN',
  protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
  chainId: KnownChainIds.POLYGON,
  conditionId: '0xabc123...' as ConditionId,
};

// 2. Загружаем исторические данные
const historicalQuotes = loadHistoricalQuotes(marketDataSource, conditionRef);

// 3. Backtest loop
for (const quote of historicalQuotes) {
  // Simulate strategy
  const signal = strategy.evaluate(quote);

  if (signal === 'BUY') {
    const order = {
      executionVenue,
      conditionRef,
      outcomeKey: BinaryOutcome.UP,
      side: 'BUY',
      price: quote.ask,
      quantity: 100,
    };

    await simulateOrder(order);
  }
}

// 4. Анализ результатов
const results = getBacktestResults();
console.log(`PnL: ${results.pnl}, Sharpe: ${results.sharpe}`);
```

---

### 4. Multi-Venue Trading

**Сценарий**: Торгуем на нескольких площадках одновременно.

```typescript
import {
  type VenueId,
  type ConditionRef,
  type ConditionId,
  KnownVenues,
  KnownChainIds,
} from '@polymarket/ids';
import {
  type MarketDataSourceId,
  KnownMarketDataSources,
  sourceToVenue,
} from '@polymarket/ids/market-data';
import {
  type ExecutionVenueId,
  KnownExecutionVenues,
} from '@polymarket/ids/execution';

// 1. Настройка для нескольких venues

// Polymarket - on-chain (discriminated union с kind: 'ONCHAIN')
const polymarketCondition: ConditionRef = {
  kind: 'ONCHAIN',
  protocolId: 'POLYMARKET_CTF',
  chainId: KnownChainIds.POLYGON,
  conditionId: '0xabc123...' as ConditionId,
};

// Kalshi - off-chain (discriminated union с kind: 'OFFCHAIN')
const kalshiCondition: ConditionRef = {
  kind: 'OFFCHAIN',
  venueId: 'KALSHI',
  marketId: 'KXBTCUSDM-24APR',
};

// 2. Получаем котировки с разных venues
const polymarketQuote = {
  sourceId: KnownMarketDataSources.POLYMARKET_WS,
  conditionRef: polymarketCondition,
  bid: 0.48,
  ask: 0.52,
};

const kalshiQuote = {
  sourceId: KnownMarketDataSources.KALSHI_WS,
  conditionRef: kalshiCondition,
  bid: 0.46,
  ask: 0.50,
};

// 3. Проверяем балансы на каждом venue
const polymarketVenue = sourceToVenue(polymarketQuote.sourceId)!;
const kalshiVenue = sourceToVenue(kalshiQuote.sourceId)!;

const polymarketBalance = getBalance(accountId, polymarketVenue, AssetIdHelpers.USDC);
const kalshiBalance = getBalance(accountId, kalshiVenue, AssetIdHelpers.USDC);

// 4. Arbitrage: покупаем дешевле, продаём дороже
if (kalshiQuote.ask < polymarketQuote.bid) {
  // Buy on Kalshi
  await sendOrder({
    executionVenue: KnownExecutionVenues.KALSHI,
    conditionRef: kalshiCondition,
    outcomeKey: BinaryOutcome.UP,
    side: 'BUY',
    price: kalshiQuote.ask,
    quantity: 100,
  });

  // Sell on Polymarket
  await sendOrder({
    executionVenue: KnownExecutionVenues.POLYMARKET,
    conditionRef: polymarketCondition,
    outcomeKey: BinaryOutcome.UP,
    side: 'SELL',
    price: polymarketQuote.bid,
    quantity: 100,
  });
}
```

---

### 5. Asset Management

**Сценарий**: Работа с разными активами (USDC и outcome tokens).

```typescript
import {
  type AssetId,
  type ConditionRef,
  type OnChainConditionRef,
  type ConditionId,
  AssetIdHelpers,
  isCurrencyAsset,
  isOutcomeTokenAsset,
  BinaryOutcome,
  KnownChainIds,
  assetIdToString,
} from '@polymarket/ids';

// 1. Currency asset
const usdcAsset: AssetId = AssetIdHelpers.USDC;

// 2. Outcome token asset
const conditionRef: OnChainConditionRef = {
  kind: 'ONCHAIN',
  protocolId: 'POLYMARKET_CTF',
  chainId: KnownChainIds.POLYGON,
  conditionId: '0xabc123...' as ConditionId,
};

const yesTokenAsset: AssetId = AssetIdHelpers.fromOutcomeToken(
  conditionRef,
  BinaryOutcome.UP
);

const noTokenAsset: AssetId = AssetIdHelpers.fromOutcomeToken(
  conditionRef,
  BinaryOutcome.DOWN
);

// 3. Получаем все балансы
const assets = [usdcAsset, yesTokenAsset, noTokenAsset];

for (const asset of assets) {
  const balance = getBalance(accountId, venueId, asset);

  if (isCurrencyAsset(asset)) {
    console.log(`Currency ${asset.currency}: ${balance.amount}`);
  } else if (isOutcomeTokenAsset(asset)) {
    console.log(
      `Token ${assetIdToString(asset)}: ${balance.amount}`
    );
  }
}

// 4. Portfolio value
function calculatePortfolioValue(balances: Balance[]): Money {
  let total = Money.of(0, 'USDC');

  for (const balance of balances) {
    if (isCurrencyAsset(balance.asset)) {
      // USDC напрямую добавляем
      total = MoneyService.add(total, balance.amount);
    } else if (isOutcomeTokenAsset(balance.asset)) {
      // Outcome token оцениваем по текущей цене
      const quote = getQuote(balance.asset.conditionRef);
      const price = balance.asset.outcomeKey === BinaryOutcome.UP
        ? quote.bid
        : (1 - quote.ask);

      const value = Money.of(balance.amount.toNumber() * price, 'USDC');
      total = MoneyService.add(total, value);
    }
  }

  return total;
}
```

---

### 6. Account Management

**Сценарий**: Работа с разными типами аккаунтов.

```typescript
import {
  type AccountId,
  type WalletAddress,
  type VenueId,
  accountIdFromWallet,
  accountIdFromVenue,
  accountIdForSubaccount,
  KnownVenues,
  parseWalletAddress,
} from '@polymarket/ids';
import type { Result } from '@polymarket/result';
import { unwrap } from '@polymarket/result';

// 1. Wallet account (Polymarket)
const wallet: WalletAddress = parseWalletAddress('0x123...')!;
const walletAccount: AccountId = accountIdFromWallet(wallet);
// → { kind: 'WALLET', address: '0x123...' }

// 2. Venue account (Kalshi) - возвращает Result<AccountId>
const kalshiAccountResult: Result<AccountId, Error> = accountIdFromVenue(
  KnownVenues.KALSHI,
  'user123'
);
// Используем pattern matching или unwrap()
if (kalshiAccountResult.ok) {
  const kalshiAccount = kalshiAccountResult.value;
  // → { kind: 'VENUE', venueId: 'KALSHI', userId: 'user123' }
}

// 3. Subaccount (для изоляции стратегий) - возвращает Result<AccountId>
// ВАЖНО: accountIdForSubaccount принимает AccountId (не WalletAddress!)
const tradingResult = accountIdForSubaccount(walletAccount, 'trading');
const hedgingResult = accountIdForSubaccount(walletAccount, 'hedging');

// Простой способ: unwrap() функция (выбросит если ошибка)
const tradingAccount = unwrap(tradingResult);
const hedgingAccount = unwrap(hedgingResult);
// → { kind: 'SUBACCOUNT', base: { kind: 'WALLET', ... }, name: 'trading' }

// 4. Получаем балансы для всех аккаунтов
const accounts = [walletAccount, tradingAccount, hedgingAccount];

for (const account of accounts) {
  const balance = getBalance(account, KnownVenues.POLYMARKET, AssetIdHelpers.USDC);
  console.log(`Account ${account}: ${balance.amount}`);
}
```

---

### 7. Condition Reference Management

**Сценарий**: Работа с ConditionRef.

```typescript
import {
  type ConditionRef,
  type ConditionId,
  KnownChainIds,
  conditionRefEquals,
  conditionRefToString,
  parseConditionRef,
  parseConditionId,
} from '@polymarket/ids';

// 1. Создание ConditionRef (discriminated union с kind)
const condition1: ConditionRef = {
  kind: 'ONCHAIN',
  protocolId: 'POLYMARKET_CTF',
  chainId: KnownChainIds.POLYGON,
  conditionId: parseConditionId('0x' + 'a'.repeat(64))!,
};

// 2. Сравнение
const condition2: ConditionRef = {
  kind: 'ONCHAIN',
  protocolId: 'POLYMARKET_CTF',
  chainId: KnownChainIds.POLYGON,
  conditionId: parseConditionId('0x' + 'a'.repeat(64))!,
};

if (conditionRefEquals(condition1, condition2)) {
  console.log('Same condition');
}

// 3. Сериализация (с kind discriminator)
const str = conditionRefToString(condition1);
// → "ONCHAIN:POLYMARKET_CTF:137:0xabc123..."

// Сохраняем в БД, отправляем по сети, логируем
await db.saveCondition(str);

// 4. Десериализация
const loadedStr = await db.loadCondition();
const loadedCondition = parseConditionRef(loadedStr);

if (loadedCondition) {
  // ВАЖНО: нужна type guard по kind перед доступом к protocolId
  if (loadedCondition.kind === 'ONCHAIN') {
    console.log(`Loaded: ${loadedCondition.protocolId}`);
  } else {
    console.log(`Loaded: ${loadedCondition.venueId} market ${loadedCondition.marketId}`);
  }
}

// 5. ❌ Никогда не используй голый ConditionId!
// const bad = '0xabc123...' as ConditionId;  // ПЛОХО!

// 6. ✅ Всегда используй ConditionRef (с kind)
const good: ConditionRef = {
  kind: 'ONCHAIN',
  protocolId: 'POLYMARKET_CTF',
  chainId: KnownChainIds.POLYGON,
  conditionId: '0xabc123...' as ConditionId,
};
```

---

### 8. OutcomeKey Operations

**Сценарий**: Работа с UP/DOWN outcomes.

```typescript
import {
  type OutcomeKey,
  BinaryOutcome,
  oppositeOutcomeKey,
  parseOutcomeKey,
  outcomeKeyToIndex,
  indexToOutcomeKey,
} from '@polymarket/ids';

// 1. Использование констант
const up: OutcomeKey = BinaryOutcome.UP;      // → 'UP'
const down: OutcomeKey = BinaryOutcome.DOWN;  // → 'DOWN'

// 2. Opposite outcome (хеджирование)
function hedge(currentPosition: OutcomeKey): OutcomeKey | undefined {
  return oppositeOutcomeKey(currentPosition);
}

const position = BinaryOutcome.UP;
const hedgePosition = hedge(position);  // → 'DOWN'

// 3. Для UI - OutcomeKey уже строка, используй напрямую
console.log(`Buying ${up} token`);  // → "Buying UP token"

// 4. From string (парсинг user input)
const userInput = 'up';  // case-insensitive
const outcome = parseOutcomeKey(userInput.toUpperCase());

if (outcome !== undefined) {
  console.log(`User wants to buy outcome ${outcome}`);
}

// 5. Конверсия в on-chain index (для контрактов)
const onChainIndex = outcomeKeyToIndex(BinaryOutcome.UP);  // → 1
console.log(`On-chain index: ${onChainIndex}`);

// 6. Конверсия из on-chain index
const rawIndex = 0;  // получили из контракта
const outcomeFromChain = indexToOutcomeKey(rawIndex);  // → 'DOWN'

// 7. Итерация по всем outcomes
const outcomes: OutcomeKey[] = [
  BinaryOutcome.DOWN,
  BinaryOutcome.UP,
];

for (const outcome of outcomes) {
  const token = AssetIdHelpers.fromOutcomeToken(conditionRef, outcome);
  const balance = getBalance(accountId, venueId, token);
  console.log(`${outcome}: ${balance.amount}`);
}
```

---

## Интеграция с Value Objects

### Quote с MarketDataSourceId

```typescript
import {
  type ConditionRef,
  type ConditionId,
  type InstrumentId,
  KnownChainIds,
} from '@polymarket/ids';
import {
  type MarketDataSourceId,
  KnownMarketDataSources,
} from '@polymarket/ids/market-data';

// Quote value object теперь содержит sourceId
class Quote {
  constructor(
    public readonly sourceId: MarketDataSourceId,
    public readonly instrumentId: InstrumentId,
    public readonly conditionRef: ConditionRef,
    public readonly bid: number,
    public readonly ask: number,
    public readonly timestamp: number
  ) {}
}

// Создание Quote
const quote = new Quote(
  KnownMarketDataSources.POLYMARKET_WS,
  'BTC-USD-2025' as InstrumentId,
  {
    kind: 'ONCHAIN',
    protocolId: 'POLYMARKET_CTF',
    chainId: KnownChainIds.POLYGON,
    conditionId: '0xabc123...' as ConditionId,
  },
  0.48,
  0.52,
  Date.now()
);
```

### Balance с VenueId и AssetId

```typescript
import {
  type AccountId,
  type VenueId,
  type AssetId,
  KnownVenues,
  KnownChainIds,
  AssetIdHelpers,
  parseWalletAddress,
  accountIdFromWallet,
} from '@polymarket/ids';

// Balance entity теперь содержит venueId и AssetId
class Balance {
  constructor(
    public readonly accountId: AccountId,
    public readonly venueId: VenueId,
    public readonly asset: AssetId,
    public readonly amount: Money
  ) {}
}

// Создание Balance — accountId это discriminated union объект, не строка
const wallet = parseWalletAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed')!;
const accountId: AccountId = accountIdFromWallet(wallet);

const balance = new Balance(
  accountId,
  KnownVenues.POLYMARKET,
  AssetIdHelpers.USDC,
  Money.of(100, 'USDC')
);
```

---

## Best Practices

### 1. Всегда используй ConditionRef

❌ Плохо:

```typescript
const conditionId = '0xabc123...';
```

✅ Хорошо:

```typescript
const conditionRef: OnChainConditionRef = {
  kind: 'ONCHAIN',
  protocolId: 'POLYMARKET_CTF',
  chainId: KnownChainIds.POLYGON,
  conditionId: '0xabc123...' as ConditionId,
};
```

### 2. Используй type guards для AssetId

❌ Плохо:

```typescript
if (asset.type === 'CURRENCY') {
  console.log(asset.currency);  // TypeScript не знает что currency существует
}
```

✅ Хорошо:

```typescript
if (isCurrencyAsset(asset)) {
  console.log(asset.currency);  // TypeScript знает что currency существует
}
```

### 3. Используй константы вместо magic strings

❌ Плохо:

```typescript
const venueId = 'POLYMARKET' as VenueId;
const outcome = 'UP' as OutcomeKey;
```

✅ Хорошо:

```typescript
const venueId = KnownVenues.POLYMARKET;
const outcome = BinaryOutcome.UP;
```

### 4. Используй mapping функции

❌ Плохо:

```typescript
let venueId: VenueId;
if (quote.sourceId === 'POLYMARKET_WS') {
  venueId = 'POLYMARKET' as VenueId;
} else if (quote.sourceId === 'KALSHI_WS') {
  venueId = 'KALSHI' as VenueId;
}
```

✅ Хорошо:

```typescript
const venueId = sourceToVenue(quote.sourceId);
```

### 5. Явные типы для branded types

❌ Плохо:

```typescript
const accountId = '0x123...' as AccountId;  // неявно
```

✅ Хорошо:

```typescript
const wallet = '0x123...' as WalletAddress;
const accountId: AccountId = accountIdFromWallet(wallet);
```

---

## Troubleshooting

### TypeScript errors: unsafe OutcomeKey casts

**Проблема**:

```
Type 'string' is not assignable to type 'OutcomeKey'
```

**Решение**: Используй BinaryOutcome константы или parseOutcomeKey для валидации

```typescript
// ❌ Плохо
const outcome: OutcomeKey = 'UP' as OutcomeKey;  // Unsafe cast!

// ✅ Хорошо
import { BinaryOutcome, parseOutcomeKey } from '@polymarket/ids';

// Compile-time константы
const outcome = BinaryOutcome.UP;

// Runtime валидация
const userInput = 'UP';
const parsed = parseOutcomeKey(userInput);
if (parsed) {
  const token = AssetIdHelpers.fromOutcomeToken(conditionRef, parsed);
}
```

### Cannot find module '@polymarket/ids/market-data'

**Проблема**: Subpath exports не работают.

**Решение**: Обнови package.json для moduleResolution:

```json
{
  "compilerOptions": {
    "moduleResolution": "bundler"  // или "node16"
  }
}
```

### AccountId не assignable к string

**`AccountId` — discriminated union объектов, не строка**:

```typescript
const str: string = accountId;  // Error: тип-объединение объектов не является строкой
```

`AccountId` — это discriminated union (`{ kind: 'WALLET' } | { kind: 'VENUE' } | { kind: 'SUBACCOUNT' }`), а не строка.
Для сериализации используй `accountIdToString()`:

```typescript
const str: string = accountIdToString(accountId);  // ✅ корректная сериализация
```

**`WalletAddress` — branded string, assignable к `string`**:

```typescript
const wallet: WalletAddress = parseWalletAddress('0x...')!;
const str: string = wallet;  // ✅ OK — WalletAddress является подтипом string
```

`WalletAddress` это `string & { readonly __brand: 'WalletAddress' }`, что является _подтипом_ `string`,
поэтому присваивание к `string` разрешено без явного приведения типа.

---

## Дополнительные ресурсы

- [Архитектура](./architecture.md) - архитектурные решения и дизайн-решения
- [Справочник типов](./types-reference.md) - полный список типов и функций
