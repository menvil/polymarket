# @polymarket/ids

Foundation ID types для Polymarket domain.

## Описание

Пакет содержит фундаментальные типы идентификаторов, используемые во всех слоях приложения.

### Почему отдельный пакет?

- **Foundation типы** - базовые building blocks, не бизнес-логика
- **Используются везде** - в value objects, entities, services
- **Branded types** - compile-time type safety через branded types
- **Валидация** - runtime валидация через Result pattern (@polymarket/result)

## Структура

```
src/
├── core/              # Domain IDs
│   ├── ConditionRef.ts
│   ├── OutcomeKey.ts
│   ├── AccountId.ts
│   ├── VenueId.ts
│   └── AssetId.ts
├── market-data/       # Market Data IDs
│   ├── MarketDataSourceId.ts
│   └── InstrumentId.ts
└── execution/         # Execution IDs
    ├── ExecutionVenueId.ts
    ├── OrderId.ts
    └── FillId.ts
```

## Использование

### Core IDs

```typescript
import {
  type SupportedCurrency,
  type ConditionRef,
  type OutcomeKey,
  type AccountId,
  type VenueId,
  type AssetId,
  KnownCurrencies,
  KnownChainIds,
  KnownVenues,
  BinaryOutcome,
  isSupportedCurrency,
  accountIdFromWallet,
  parseWalletAddress,
  AssetIdHelpers,
} from '@polymarket/ids';

// SupportedCurrency - поддерживаемые валюты
const currency: SupportedCurrency = 'USDC'; // ✅ OK
const knownUsdc = KnownCurrencies.USDC; // 'USDC' as SupportedCurrency

// Type guard для валидации
const input = getUserInput();
if (isSupportedCurrency(input)) {
  // TypeScript knows: input is SupportedCurrency
  const money = Money.of(100, input);
}

// ConditionRef - полная ссылка на condition (discriminated union)

// On-chain example (Polymarket)
const onChainRef: ConditionRef = {
  kind: 'ONCHAIN',
  protocolId: 'POLYMARKET_CTF',
  chainId: KnownChainIds.POLYGON,
  conditionId: '0xabc123...' as any,
};

// Off-chain example (Kalshi)
const offChainRef: ConditionRef = {
  kind: 'OFFCHAIN',
  venueId: 'KALSHI',
  marketId: 'KXBTCUSDM-24APR',
};

// OutcomeKey - UP/DOWN для бинарных рынков
const upOutcome = BinaryOutcome.UP;   // 'UP'
const downOutcome = BinaryOutcome.DOWN; // 'DOWN'

// AccountId - discriminated union (НЕ строка!)
// Wallet account
const walletAccount: AccountId = {
  kind: 'WALLET',
  address: parseWalletAddress('0x1234...')!
};

// Или через фабрику
const walletAcc = accountIdFromWallet(parseWalletAddress('0x1234...')!);

// VenueId - где находятся балансы
const venueId: VenueId = KnownVenues.POLYMARKET;

// AssetId - универсальный актив (используй AssetIdHelpers)
const usdcAsset = AssetIdHelpers.USDC;
const token = AssetIdHelpers.fromOutcomeToken(onChainRef, BinaryOutcome.UP);
```

### Market Data IDs

```typescript
import {
  type MarketDataSourceId,
  KnownMarketDataSources,
  sourceToVenue,
} from '@polymarket/ids/market-data';

// MarketDataSourceId - откуда ЧИТАЕМ данные
const liveSource: MarketDataSourceId = KnownMarketDataSources.POLYMARKET_WS;
const replaySource: MarketDataSourceId = KnownMarketDataSources.POLYMARKET_REPLAY;

// Mapping source → venue
const venue = sourceToVenue(liveSource); // 'POLYMARKET'
```

### Execution IDs

```typescript
import {
  type ExecutionVenueId,
  KnownExecutionVenues,
} from '@polymarket/ids/execution';

// ExecutionVenueId - куда ОТПРАВЛЯЕМ ордера
const liveVenue: ExecutionVenueId = KnownExecutionVenues.POLYMARKET;
const simulator: ExecutionVenueId = KnownExecutionVenues.SIMULATOR;
```

## Ключевые концепции

### Branded Types

Все ID types используют branded types для type safety:

```typescript
// Некоторые ID используют простые branded types:
type ChainId = number & { readonly __brand: 'ChainId' };

// AccountId использует discriminated union:
type AccountId =
  | { kind: 'WALLET'; address: WalletAddress }
  | { kind: 'VENUE'; venueId: VenueId; userId: string }
  | { kind: 'SUBACCOUNT'; base: AccountId; name: string };
```

Это даёт:

- ✅ Type safety в compile time
- ✅ Строгая типизация без лишних wrapper-классов
- ✅ Невозможно случайно перепутать типы

```typescript
function getBalance(accountId: AccountId) { /* ... */ }

// ❌ TypeScript error
getBalance('some-string');

// ✅ OK
getBalance('some-string' as AccountId);
```

### ConditionRef - Discriminated Union для On-Chain и Off-Chain

**⚠️ ВАЖНО**: ConditionRef теперь discriminated union!

**Проблема**: Старая версия смешивала on-chain protocols (POLYMARKET_CTF) с off-chain venues (KALSHI), что создавало логическое противоречие (KALSHI не имеет chainId).

**Решение**: Разделение на On-Chain и Off-Chain references.

#### On-Chain Conditions (EVM-based)

```typescript
const polymarket: ConditionRef = {
  kind: 'ONCHAIN',
  protocolId: 'POLYMARKET_CTF',  // on-chain protocol
  chainId: 137,                  // Polygon
  conditionId: '0xabc123...'     // keccak256 hash
};
```

#### Off-Chain Conditions (Regulated Exchanges)

```typescript
const kalshi: ConditionRef = {
  kind: 'OFFCHAIN',
  venueId: 'KALSHI',             // venue name
  marketId: 'KXBTCUSDM-24APR'    // venue-specific market ID
};
```

#### Type-Safe Processing

```typescript
function processCondition(ref: ConditionRef) {
  if (ref.kind === 'ONCHAIN') {
    // TypeScript knows: ref has protocolId, chainId, conditionId
    const rpcUrl = getRpcUrl(ref.chainId);
    console.log(`On-chain: ${ref.protocolId}`);
  } else {
    // TypeScript knows: ref has venueId, marketId
    const apiUrl = getVenueApiUrl(ref.venueId);
    console.log(`Off-chain: ${ref.venueId} market ${ref.marketId}`);
  }
}
```

❌ **НИКОГДА** не используй голый `ConditionId`:

```typescript
const bad = '0xabc123...'; // что это? on-chain? off-chain? какой venue?
```

✅ **ВСЕГДА** используй `ConditionRef` с полным контекстом.

### Result Pattern для Error Handling

Некоторые функции возвращают `Result<T, Error>` вместо прямого значения или `undefined`.

**Зачем?** Result явно показывает что операция может завершиться ошибкой и требует обработки.

**Функции возвращающие Result:**

- `accountIdFromVenue(venueId, userId)` - валидация userId
- `accountIdForSubaccount(base, name)` - валидация name и depth limit

**Два способа работы с Result:**

```typescript
import { accountIdFromVenue, accountIdForSubaccount, KnownVenues } from '@polymarket/ids';
import type { Result } from '@polymarket/result';
import { unwrap } from '@polymarket/result';

// Способ 1: Pattern matching (безопасный)
const result: Result<AccountId, Error> = accountIdFromVenue(KnownVenues.POLYMARKET, 'user:123');
if (result.ok) {
  const accountId = result.value;
  console.log('Success:', accountId);
} else {
  console.error('Error:', result.error.message);
}

// Способ 2: unwrap() функция (бросает если ошибка)
const accountId = unwrap(accountIdFromVenue(KnownVenues.POLYMARKET, 'user_valid'));
// Используй только если уверен что ввод валидный

// Пример с subaccount depth limit
const deep1 = unwrap(accountIdForSubaccount(walletAccount, 'sub1'));
const deep2 = unwrap(accountIdForSubaccount(deep1, 'sub2'));
const deep3 = unwrap(accountIdForSubaccount(deep2, 'sub3'));
// ... до depth 5 включительно OK
const deep6 = accountIdForSubaccount(deep5, 'sub6'); // → Err (depth > 5)
```

### Разделение MarketDataSource vs ExecutionVenue

**MarketDataSourceId** - откуда ЧИТАЕМ данные:

- Live: `POLYMARKET_WS`, `KALSHI_WS`
- Replay: `POLYMARKET_REPLAY`, `KALSHI_REPLAY`

**ExecutionVenueId** - куда ОТПРАВЛЯЕМ ордера:

- Live: `POLYMARKET`, `KALSHI`
- Simulation: `SIMULATOR`

Это позволяет:

- Читать live данные Polymarket + торговать в симуляторе (paper trading)
- Читать replay данные + торговать в симуляторе (backtest)
- Читать live данные + торговать реально (live trading)

## Scripts

```bash
# Build
npm run build

# Tests (unit tests через Jest)
npm test

# Runtime tests (проверка dist/ ESM imports)
npm run test:dist

# Полный набор тестов (unit + runtime)
npm run test:all

# Type check
npm run typecheck

# Lint
npm run lint
```

**⚠️ Важно для test:dist:**

- Требует собранные зависимости (@polymarket/result должен иметь dist/)
- Проверяет ESM exports и runtime import работоспособность
- Запускается напрямую через Node.js (не через Jest)

## Dependencies

**Runtime:**

- `@polymarket/result` - Result pattern для error handling

**Dev:**

- TypeScript, Jest, ESLint
