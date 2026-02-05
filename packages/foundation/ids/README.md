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
│   ├── OutcomeIndex.ts
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
  type ConditionRef,
  type OutcomeIndex,
  type AccountId,
  type VenueId,
  type AssetId,
  KnownChainIds,
  OutcomeIndex as OutcomeIndexConst,
} from '@polymarket/ids';

// ConditionRef - полная ссылка на condition
const conditionRef: ConditionRef = {
  protocolId: 'POLYMARKET_CTF',
  chainId: KnownChainIds.POLYGON,
  conditionId: '0xabc123...' as any,
};

// OutcomeIndex - YES/NO
const yesOutcome: OutcomeIndex = OutcomeIndexConst.YES; // 1
const noOutcome: OutcomeIndex = OutcomeIndexConst.NO; // 0

// AccountId - wallet или venue account
const accountId: AccountId = '0x1234...' as AccountId;

// VenueId - где находятся балансы
const venueId: VenueId = 'POLYMARKET';

// AssetId - универсальный актив
const usdc = AssetId.USDC;
const token = AssetId.fromOutcomeToken(conditionRef, OutcomeIndexConst.YES);
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

### ConditionRef - всегда полная ссылка

❌ **НИКОГДА** не используй голый `ConditionId`:
```typescript
const bad = '0xabc123...'; // что это? на каком chain? в каком protocol?
```

✅ **ВСЕГДА** используй `ConditionRef`:
```typescript
const good: ConditionRef = {
  protocolId: 'POLYMARKET_CTF',
  chainId: 137,
  conditionId: '0xabc123...'
};
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

# Tests
npm test

# Type check
npm run typecheck

# Lint
npm run lint
```

## Dependencies

Нет зависимостей кроме dev dependencies (TypeScript, Jest).
