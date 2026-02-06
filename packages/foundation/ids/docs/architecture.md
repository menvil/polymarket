# Архитектура @polymarket/ids

## Почему отдельный пакет?

### Foundation vs Domain

`@polymarket/ids` находится в `packages/foundation/` (НЕ в `packages/domain/`), потому что:

- **Примитивные типы** - это building blocks, а не бизнес-логика
- **Используются везде** - в value objects, entities, services, adapters
- **Минимум зависимостей** - только TypeScript, никаких внешних библиотек
- **Branded types** - compile-time type safety без runtime overhead

### Трёхуровневая архитектура IDs

```
┌─────────────────────────────────────────────┐
│  Core IDs - канонические domain IDs         │
│  (ConditionRef, OutcomeKey, AccountId)      │
└─────────────────────────────────────────────┘
                    ▲
                    │
┌─────────────────────────────────────────────┐
│  Venue IDs - специфика конкретных площадок  │
│  (InstrumentId, venue-specific formats)     │
└─────────────────────────────────────────────┘
                    ▲
                    │
┌─────────────────────────────────────────────┐
│  Mapping - registry между venues и core     │
│  (sourceToVenue, executionToVenue)          │
└─────────────────────────────────────────────┘
```

## Ключевые архитектурные решения

### 1. ConditionRef вместо голого ConditionId

**Проблема**: Голый `ConditionId` (просто hash `0xabc123...`) бесполезен без контекста.

**Почему плохо**:
- Может быть collision между разными chains (Polygon vs Ethereum)
- Может быть collision между разными protocols (Polymarket vs Kalshi)
- Непонятно где искать данные (какой RPC endpoint использовать)

**Решение**: Всегда используй `ConditionRef` с полным контекстом:

```typescript
type ConditionRef = {
  protocolId: ProtocolId;   // POLYMARKET_CTF | KALSHI | UMA_CTF
  chainId: ChainId;         // 137 (Polygon) | 1 (Ethereum) | 8453 (Base)
  conditionId: ConditionId; // 0xabc123...
};
```

**Преимущества**:
- ✅ Однозначная идентификация condition в мультивенью системе
- ✅ Можно определить RPC endpoint по chainId
- ✅ Можно определить contract address по protocolId
- ✅ Type safety - невозможно перепутать conditions из разных sources

### 2. Разделение MarketDataSource vs ExecutionVenue

**Проблема**: Где мы ЧИТАЕМ данные !== где мы ОТПРАВЛЯЕМ ордера.

**Сценарии**:

| Scenario      | MarketDataSource | ExecutionVenue | Use Case         |
|---------------|------------------|----------------|------------------|
| Live trading  | POLYMARKET_WS    | POLYMARKET     | Реальная торговля|
| Paper trading | POLYMARKET_WS    | SIMULATOR      | Тест стратегии   |
| Backtest      | POLYMARKET_REPLAY| SIMULATOR      | История          |

**Архитектура**:

```typescript
// MarketDataSourceId - ОТКУДА мы ЧИТАЕМ
type MarketDataSourceId =
  | 'POLYMARKET_WS'      // Live WebSocket
  | 'POLYMARKET_REPLAY'  // Historical data
  | 'KALSHI_WS'
  | ...;

// ExecutionVenueId - КУДА мы ОТПРАВЛЯЕМ
type ExecutionVenueId =
  | 'POLYMARKET'   // Real venue
  | 'KALSHI'       // Real venue
  | 'SIMULATOR';   // Paper trading
```

**Почему разделили**:
- Читать live Polymarket + торговать в симуляторе (paper trading)
- Читать replay данные + торговать в симуляторе (backtest)
- Читать live Kalshi + торговать реально на Kalshi (live trading)
- **Flexibility**: можно комбинировать любой source с любым execution venue

### 3. Branded Types для type safety

**Проблема**: TypeScript не различает `string` типы.

```typescript
type AccountId = string;
type WalletAddress = string;

function getBalance(account: AccountId) { ... }

// ❌ TypeScript не видит ошибку
getBalance('0x123...');  // это WalletAddress, не AccountId!
```

**Решение**: Branded types

```typescript
type AccountId = string & { readonly __brand: 'AccountId' };
type WalletAddress = string & { readonly __brand: 'WalletAddress' };

// ✅ TypeScript ошибка!
getBalance('0x123...');  // Type 'string' is not assignable to AccountId

// ✅ OK
getBalance('0x123...' as AccountId);
```

**Преимущества**:
- ✅ Compile-time type safety
- ✅ Zero runtime overhead (brand field не существует в runtime)
- ✅ Невозможно случайно перепутать типы
- ✅ Self-documenting code

**Почему НЕ classes**:
- Classes требуют instantiation (`new AccountId('...')`)
- Classes требуют serialization/deserialization logic
- Classes добавляют runtime overhead
- Branded types - это чистый TypeScript, compile-time only

### 4. AssetId как Union Type

**Проблема**: Нужен универсальный ID для любого актива (currency или outcome token).

**Решение**: Discriminated union

```typescript
type AssetId =
  | { type: 'CURRENCY'; currency: string; }
  | { type: 'OUTCOME_TOKEN'; conditionRef: ConditionRef; outcomeKey: OutcomeKey; };
```

**Преимущества**:
- ✅ Type-safe discriminated union
- ✅ Exhaustive checking в switch/if
- ✅ Явная семантика (не может быть одновременно currency и token)
- ✅ Можно использовать в generic контейнерах (AssetQuantity, events, transfers)

**Использование**:

```typescript
function processAsset(asset: AssetId) {
  if (asset.type === 'CURRENCY') {
    // TypeScript знает: asset.currency доступен
    console.log(`Currency: ${asset.currency}`);
  } else {
    // TypeScript знает: asset.conditionRef и asset.outcomeIndex доступны
    console.log(`Token: ${asset.conditionRef.conditionId} outcome ${asset.outcomeIndex}`);
  }
}
```

### 5. VenueId для matching балансов

**Проблема**: В мультивенью системе нужно понимать где находятся активы.

**Решение**: `VenueId` указывает площадку где хранятся балансы/tokens.

```typescript
type VenueId = 'POLYMARKET' | 'KALSHI' | ...;

// Balance всегда привязан к venue
type Balance = {
  accountId: AccountId;
  venueId: VenueId;    // ← где находится баланс
  asset: AssetId;
  amount: Money;
};
```

**Использование в matching**:

```typescript
// При получении Quote нужно проверить баланс на том же venue
if (quote.sourceId === 'POLYMARKET_WS') {
  const venueId = sourceToVenue(quote.sourceId);  // → 'POLYMARKET'
  const balance = getBalance(accountId, venueId);
  // ...
}
```

**Mapping функции**:

```typescript
// MarketDataSourceId → VenueId
sourceToVenue('POLYMARKET_WS') → 'POLYMARKET'
sourceToVenue('KALSHI_WS')     → 'KALSHI'

// ExecutionVenueId → VenueId
executionToVenue('POLYMARKET') → 'POLYMARKET'
executionToVenue('SIMULATOR')  → undefined  // симулятор не имеет venue
```

## Структура пакета

```
packages/foundation/ids/
├── src/
│   ├── core/              # Канонические domain IDs
│   │   ├── ProtocolId.ts
│   │   ├── ChainId.ts
│   │   ├── ConditionId.ts
│   │   ├── ConditionRef.ts      # Всегда используй ConditionRef!
│   │   ├── OutcomeKey.ts        # UP/DOWN для бинарных рынков (расширяемо)
│   │   ├── WalletAddress.ts
│   │   ├── AccountId.ts
│   │   ├── VenueId.ts           # Где находятся балансы
│   │   ├── AssetId.ts           # Currency | OutcomeToken
│   │   └── index.ts
│   ├── market-data/       # Market Data IDs (откуда ЧИТАЕМ)
│   │   ├── MarketDataSourceId.ts
│   │   ├── InstrumentId.ts
│   │   └── index.ts
│   ├── execution/         # Execution IDs (куда ОТПРАВЛЯЕМ)
│   │   ├── ExecutionVenueId.ts
│   │   ├── OrderId.ts     # Для будущих Order entities
│   │   ├── FillId.ts      # Для будущих Fill entities
│   │   └── index.ts
│   └── index.ts
```

### Subpath exports

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./core": "./dist/core/index.js",
    "./market-data": "./dist/market-data/index.js",
    "./execution": "./dist/execution/index.js"
  }
}
```

**Использование**:

```typescript
// Main export - core types
import { type ConditionRef, BinaryOutcome } from '@polymarket/ids';

// Subpath exports
import { type MarketDataSourceId } from '@polymarket/ids/market-data';
import { type ExecutionVenueId } from '@polymarket/ids/execution';
```

## Принципы дизайна

### 1. Immutability

Все типы readonly:

```typescript
export type ConditionRef = Readonly<{
  protocolId: ProtocolId;
  chainId: ChainId;
  conditionId: ConditionId;
}>;
```

### 2. Type Safety

Branded types для всех ID:

```typescript
type ChainId = number & { readonly __brand: 'ChainId' };
type ConditionId = string & { readonly __brand: 'ConditionId' };
```

### 3. Zero Runtime Overhead

Нет classes, нет validation в runtime (только type casts).

### 4. Self-Documenting

Явные имена типов, discriminated unions, TSDoc комментарии.

### 5. Extensibility

Open union types для будущих расширений:

```typescript
type MarketDataSourceId =
  | 'POLYMARKET_WS'
  | 'KALSHI_WS'
  | (string & { readonly __brand: 'MarketDataSourceId' });  // ← extensibility
```

## Интеграция с другими пакетами

### @polymarket/value-objects

```typescript
// Quote использует IDs из @polymarket/ids
import { type MarketDataSourceId, type InstrumentId } from '@polymarket/ids/market-data';

class Quote {
  constructor(
    public readonly sourceId: MarketDataSourceId,
    public readonly instrumentId: InstrumentId,
    // ...
  ) {}
}
```

### @polymarket/entities

```typescript
// Balance entity использует VenueId и AssetId
import { type VenueId, type AssetId } from '@polymarket/ids';

class Balance {
  constructor(
    public readonly venueId: VenueId,
    public readonly asset: AssetId,
    // ...
  ) {}
}
```

### @polymarket/adapters

```typescript
// Adapters используют mapping функции
import { sourceToVenue, executionToVenue } from '@polymarket/ids';

const venueId = sourceToVenue(quote.sourceId);
const balance = balanceRepository.get(accountId, venueId);
```

## Будущие расширения

### Phase 2: OrderId и FillId

```typescript
// Для Order и Fill entities
type OrderId = string & { readonly __brand: 'OrderId' };
type FillId = string & { readonly __brand: 'FillId' };
```

### Phase 3: Multi-chain support

```typescript
// Добавление новых chains
const KnownChainIds = {
  ETHEREUM: 1 as ChainId,
  POLYGON: 137 as ChainId,
  BASE: 8453 as ChainId,
  ARBITRUM: 42161 as ChainId,  // ← new
  OPTIMISM: 10 as ChainId,      // ← new
};
```

### Phase 4: Venue-specific IDs

```typescript
// Venue-specific instrument IDs
type PolymarketInstrumentId = string & { readonly __brand: 'PolymarketInstrumentId' };
type KalshiInstrumentId = string & { readonly __brand: 'KalshiInstrumentId' };

// Mapping к canonical InstrumentId
function toCanonicalInstrument(
  venue: VenueId,
  venueInstrumentId: string
): InstrumentId;
```
