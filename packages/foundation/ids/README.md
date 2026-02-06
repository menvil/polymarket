# @polymarket/ids

Foundation ID types для Polymarket domain.

## Описание

Пакет содержит фундаментальные типы идентификаторов, используемые во всех слоях приложения.

### Почему отдельный пакет?

- **Foundation типы** - базовые building blocks, не бизнес-логика
- **Используются везде** - в value objects, entities, services
- **Branded types** - type safety без runtime overhead
- **Минимум зависимостей** - только TypeScript

## Структура

```
src/
├── core/              # Domain IDs
│   ├── ConditionRef.ts
│   ├── OutcomeKey.ts      # ✅ Primary (используй это)
│   ├── OutcomeIndex.ts    # ⚠️ Deprecated (только для on-chain адаптеров)
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
  BinaryOutcome,
  isSupportedCurrency,
} from '@polymarket/ids';

// SupportedCurrency - поддерживаемые валюты
const currency: SupportedCurrency = 'USDC'; // ✅ OK
const usdc = KnownCurrencies.USDC; // 'USDC' as SupportedCurrency

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

// AccountId - wallet или venue account
const accountId: AccountId = '0x1234...' as AccountId;

// VenueId - где находятся балансы
const venueId: VenueId = 'POLYMARKET';

// AssetId - универсальный актив
const usdc = AssetId.USDC;
const token = AssetId.fromOutcomeToken(conditionRef, BinaryOutcome.UP);
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
type AccountId = string & { readonly __brand: 'AccountId' };
type ChainId = number & { readonly __brand: 'ChainId' };
```

Это даёт:
- ✅ Type safety в compile time
- ✅ Zero runtime overhead
- ✅ Невозможно случайно перепутать типы

```typescript
function getBalance(accountId: AccountId) { ... }

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

# Tests
npm test

# Type check
npm run typecheck

# Lint
npm run lint
```

## Dependencies

Нет зависимостей кроме dev dependencies (TypeScript, Jest).
