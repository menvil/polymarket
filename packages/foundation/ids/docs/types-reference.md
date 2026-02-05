# Справочник типов @polymarket/ids

## Core IDs

### ProtocolId

Идентификатор протокола prediction market.

```typescript
type ProtocolId =
  | 'POLYMARKET_CTF'
  | 'KALSHI'
  | 'UMA_CTF'
  | (string & { readonly __brand: 'ProtocolId' });
```

**Известные протоколы**:
- `POLYMARKET_CTF` - Polymarket Conditional Token Framework (Gnosis CTF на Polygon)
- `KALSHI` - Kalshi regulated prediction market
- `UMA_CTF` - UMA Conditional Token Framework

**Использование**:

```typescript
import { type ProtocolId, isKnownProtocol } from '@polymarket/ids';

const protocol: ProtocolId = 'POLYMARKET_CTF';

if (isKnownProtocol(protocol)) {
  console.log('Known protocol');
}
```

---

### ChainId

Идентификатор blockchain network.

```typescript
type ChainId = number & { readonly __brand: 'ChainId' };
```

**Константы**:

```typescript
export const KnownChainIds = {
  ETHEREUM: 1 as ChainId,
  POLYGON: 137 as ChainId,
  BASE: 8453 as ChainId,
} as const;
```

**Helpers**:

```typescript
function getChainName(chainId: ChainId): string | undefined;

// Примеры
getChainName(1);     // → 'Ethereum'
getChainName(137);   // → 'Polygon'
getChainName(8453);  // → 'Base'
```

---

### ConditionId

Hash идентификатор condition (обычно keccak256).

```typescript
type ConditionId = string & { readonly __brand: 'ConditionId' };
```

**⚠️ ВАЖНО**: Никогда не используй голый `ConditionId`! Всегда используй `ConditionRef`.

**Validation**:

```typescript
function isValidConditionId(id: string): boolean;

// Примеры
isValidConditionId('0xabc123...');  // → true
isValidConditionId('invalid');      // → false
```

---

### ConditionRef

**Полная ссылка на condition** - ВСЕГДА используй вместо голого `ConditionId`.

```typescript
type ConditionRef = Readonly<{
  protocolId: ProtocolId;
  chainId: ChainId;
  conditionId: ConditionId;
}>;
```

**Создание**:

```typescript
import { type ConditionRef, KnownChainIds } from '@polymarket/ids';

const conditionRef: ConditionRef = {
  protocolId: 'POLYMARKET_CTF',
  chainId: KnownChainIds.POLYGON,
  conditionId: '0xabc123...' as ConditionId,
};
```

**Helper функции**:

```typescript
// Сравнение
function conditionRefEquals(a: ConditionRef, b: ConditionRef): boolean;

const ref1: ConditionRef = { /* ... */ };
const ref2: ConditionRef = { /* ... */ };
if (conditionRefEquals(ref1, ref2)) {
  console.log('Same condition');
}

// Преобразование в строку
function conditionRefToString(ref: ConditionRef): string;

const str = conditionRefToString(ref1);
// → "POLYMARKET_CTF:137:0xabc123..."

// Парсинг из строки
function parseConditionRef(str: string): ConditionRef | undefined;

const parsed = parseConditionRef('POLYMARKET_CTF:137:0xabc123...');
// → { protocolId: 'POLYMARKET_CTF', chainId: 137, conditionId: '0xabc123...' }
```

**Почему не голый ConditionId?**

❌ Плохо:
```typescript
const conditionId = '0xabc123...' as ConditionId;
// Вопросы:
// - На каком chain?
// - В каком protocol?
// - Где искать данные?
```

✅ Хорошо:
```typescript
const conditionRef: ConditionRef = {
  protocolId: 'POLYMARKET_CTF',
  chainId: 137,
  conditionId: '0xabc123...' as ConditionId,
};
// Всё понятно! Polygon, Polymarket CTF, condition hash.
```

---

### OutcomeIndex

Индекс outcome для бинарных рынков (YES/NO).

```typescript
type OutcomeIndex = 0 | 1;
```

**Константы**:

```typescript
import { OutcomeIndexValues } from '@polymarket/ids';

const yes = OutcomeIndexValues.YES;  // → 1
const no = OutcomeIndexValues.NO;    // → 0
```

**Helper функции**:

```typescript
// Validation
function isValidOutcomeIndex(value: number): value is OutcomeIndex;

isValidOutcomeIndex(1);  // → true
isValidOutcomeIndex(2);  // → false

// Opposite outcome
function oppositeOutcome(index: OutcomeIndex): OutcomeIndex;

oppositeOutcome(1);  // → 0
oppositeOutcome(0);  // → 1

// To string
function outcomeIndexToString(index: OutcomeIndex): 'YES' | 'NO';

outcomeIndexToString(1);  // → 'YES'
outcomeIndexToString(0);  // → 'NO'

// From string
function parseOutcomeIndex(str: string): OutcomeIndex | undefined;

parseOutcomeIndex('YES');  // → 1
parseOutcomeIndex('NO');   // → 0
parseOutcomeIndex('yes');  // → 1 (case-insensitive)
parseOutcomeIndex('1');    // → 1
parseOutcomeIndex('0');    // → 0
```

**Использование**:

```typescript
import { type OutcomeIndex, OutcomeIndexValues } from '@polymarket/ids';

function buyYes(condition: ConditionRef, outcome: OutcomeIndex) {
  if (outcome === OutcomeIndexValues.YES) {
    console.log('Buying YES token');
  }
}

buyYes(conditionRef, OutcomeIndexValues.YES);
```

---

### WalletAddress

Ethereum-совместимый адрес кошелька.

```typescript
type WalletAddress = string & { readonly __brand: 'WalletAddress' };
```

**Helper функции**:

```typescript
// Validation (checksum)
function isValidWalletAddress(address: string): boolean;

isValidWalletAddress('0x1234...');  // → true (if valid checksum)

// Normalization (lowercase)
function normalizeWalletAddress(address: string): WalletAddress;

normalizeWalletAddress('0xAbC123...')
// → '0xabc123...' as WalletAddress
```

---

### AccountId

Идентификатор аккаунта (wallet, venue account, или subaccount).

```typescript
type AccountId = string & { readonly __brand: 'AccountId' };
```

**Helper функции**:

```typescript
// От wallet address
function accountIdFromWallet(wallet: WalletAddress): AccountId;

const wallet = '0x123...' as WalletAddress;
const accountId = accountIdFromWallet(wallet);
// → '0x123...' as AccountId

// От venue account
function accountIdFromVenue(venue: VenueId, accountName: string): AccountId;

const accountId = accountIdFromVenue('KALSHI', 'user123');
// → 'KALSHI:user123' as AccountId

// Subaccount
function accountIdForSubaccount(wallet: WalletAddress, subaccountName: string): AccountId;

const subaccount = accountIdForSubaccount(wallet, 'trading');
// → '0x123...:trading' as AccountId
```

**Использование**:

```typescript
import { type AccountId, accountIdFromWallet } from '@polymarket/ids';

const wallet = '0x123...' as WalletAddress;
const accountId = accountIdFromWallet(wallet);

// Получить баланс для account
const balance = getBalance(accountId, venueId);
```

---

### VenueId

Идентификатор площадки где находятся балансы/tokens.

```typescript
type VenueId =
  | 'POLYMARKET'
  | 'KALSHI'
  | (string & { readonly __brand: 'VenueId' });
```

**Константы**:

```typescript
export const KnownVenues = {
  POLYMARKET: 'POLYMARKET' as VenueId,
  KALSHI: 'KALSHI' as VenueId,
} as const;
```

**Type guard**:

```typescript
function isKnownVenue(id: string): id is VenueId;

isKnownVenue('POLYMARKET');  // → true
isKnownVenue('UNKNOWN');     // → false
```

**Использование**:

```typescript
import { type VenueId, KnownVenues } from '@polymarket/ids';

const balance = {
  accountId: '0x123...' as AccountId,
  venueId: KnownVenues.POLYMARKET,  // ← где находится баланс
  asset: { type: 'CURRENCY', currency: 'USDC' },
  amount: Money.of(100, 'USDC'),
};
```

---

### AssetId

Универсальный идентификатор актива (currency или outcome token).

```typescript
type AssetId =
  | { readonly type: 'CURRENCY'; readonly currency: string; }
  | { readonly type: 'OUTCOME_TOKEN'; readonly conditionRef: ConditionRef; readonly outcomeIndex: OutcomeIndex; };
```

**Helper функции**:

```typescript
import { AssetIdHelpers } from '@polymarket/ids';

// Currency asset
const usdc = AssetIdHelpers.USDC;
// → { type: 'CURRENCY', currency: 'USDC' }

const usdt = AssetIdHelpers.fromCurrency('USDT');
// → { type: 'CURRENCY', currency: 'USDT' }

// Outcome token asset
const tokenAsset = AssetIdHelpers.fromOutcomeToken(conditionRef, OutcomeIndexValues.YES);
// → { type: 'OUTCOME_TOKEN', conditionRef: {...}, outcomeIndex: 1 }

// Сравнение
function assetIdEquals(a: AssetId, b: AssetId): boolean;

assetIdEquals(usdc, AssetIdHelpers.USDC);  // → true
assetIdEquals(usdc, usdt);                 // → false

// To string
function assetIdToString(asset: AssetId): string;

assetIdToString(usdc);
// → 'CURRENCY:USDC'

assetIdToString(tokenAsset);
// → 'TOKEN:POLYMARKET_CTF:137:0xabc123...:1'

// Type guards
function isCurrencyAsset(asset: AssetId): asset is { type: 'CURRENCY'; currency: string };
function isOutcomeTokenAsset(asset: AssetId): asset is { type: 'OUTCOME_TOKEN'; ... };

if (isCurrencyAsset(asset)) {
  console.log(`Currency: ${asset.currency}`);
} else {
  console.log(`Token: outcome ${asset.outcomeIndex}`);
}
```

**Использование**:

```typescript
import { type AssetId, AssetIdHelpers, isCurrencyAsset } from '@polymarket/ids';

function processAsset(asset: AssetId) {
  if (isCurrencyAsset(asset)) {
    // TypeScript знает: asset.currency доступен
    console.log(`Processing currency: ${asset.currency}`);
  } else {
    // TypeScript знает: asset.conditionRef и asset.outcomeIndex доступны
    console.log(`Processing token for condition ${asset.conditionRef.conditionId}`);
  }
}

// Примеры
processAsset(AssetIdHelpers.USDC);
processAsset(AssetIdHelpers.fromOutcomeToken(conditionRef, OutcomeIndexValues.YES));
```

---

## Market Data IDs

### MarketDataSourceId

Источник маркет-данных - **ОТКУДА мы ЧИТАЕМ данные**.

```typescript
type MarketDataSourceId =
  | 'POLYMARKET_WS'
  | 'POLYMARKET_REST'
  | 'POLYMARKET_REPLAY'
  | 'KALSHI_WS'
  | 'KALSHI_REST'
  | 'KALSHI_REPLAY'
  | 'POLYGON_RPC'
  | (string & { readonly __brand: 'MarketDataSourceId' });
```

**Константы**:

```typescript
import { KnownMarketDataSources } from '@polymarket/ids/market-data';

const liveWs = KnownMarketDataSources.POLYMARKET_WS;
const replay = KnownMarketDataSources.POLYMARKET_REPLAY;
```

**Helper функции**:

```typescript
// Mapping к VenueId
function sourceToVenue(sourceId: MarketDataSourceId): VenueId | undefined;

sourceToVenue('POLYMARKET_WS');      // → 'POLYMARKET'
sourceToVenue('POLYMARKET_REPLAY');  // → 'POLYMARKET'
sourceToVenue('KALSHI_WS');          // → 'KALSHI'

// Type guards
function isLiveSource(sourceId: MarketDataSourceId): boolean;
function isReplaySource(sourceId: MarketDataSourceId): boolean;

isLiveSource('POLYMARKET_WS');      // → true
isLiveSource('POLYMARKET_REPLAY');  // → false
isReplaySource('POLYMARKET_REPLAY'); // → true
```

**Использование**:

```typescript
import { type MarketDataSourceId, KnownMarketDataSources, sourceToVenue } from '@polymarket/ids/market-data';

const quote = {
  sourceId: KnownMarketDataSources.POLYMARKET_WS,
  bid: 0.48,
  ask: 0.52,
};

// Определить venue для получения баланса
const venueId = sourceToVenue(quote.sourceId);  // → 'POLYMARKET'
const balance = getBalance(accountId, venueId);
```

---

### InstrumentId

Идентификатор инструмента на конкретном source.

```typescript
type InstrumentId = string & { readonly __brand: 'InstrumentId' };
```

**Использование**:

```typescript
import { type InstrumentId } from '@polymarket/ids/market-data';

const quote = {
  sourceId: KnownMarketDataSources.POLYMARKET_WS,
  instrumentId: 'BTC-USD-2025' as InstrumentId,
  bid: 0.48,
  ask: 0.52,
};
```

**Замечание**: Разные venues могут иметь разные форматы `InstrumentId`. В будущем будет mapping к canonical `ConditionRef`.

---

## Execution IDs

### ExecutionVenueId

Площадка для исполнения - **КУДА мы ОТПРАВЛЯЕМ ордера**.

```typescript
type ExecutionVenueId =
  | 'POLYMARKET'
  | 'KALSHI'
  | 'SIMULATOR'
  | (string & { readonly __brand: 'ExecutionVenueId' });
```

**Константы**:

```typescript
import { KnownExecutionVenues } from '@polymarket/ids/execution';

const live = KnownExecutionVenues.POLYMARKET;
const simulator = KnownExecutionVenues.SIMULATOR;
```

**Helper функции**:

```typescript
// Type guard
function isSimulator(venueId: ExecutionVenueId): boolean;

isSimulator('SIMULATOR');   // → true
isSimulator('POLYMARKET');  // → false

// Mapping к VenueId
function executionToVenue(executionId: ExecutionVenueId): VenueId | undefined;

executionToVenue('POLYMARKET');  // → 'POLYMARKET'
executionToVenue('SIMULATOR');   // → undefined (simulator не имеет venue)
```

**Использование**:

```typescript
import { type ExecutionVenueId, KnownExecutionVenues } from '@polymarket/ids/execution';

// Live trading
const order = {
  executionVenue: KnownExecutionVenues.POLYMARKET,
  side: 'BUY',
  quantity: 100,
};

// Paper trading
const paperOrder = {
  executionVenue: KnownExecutionVenues.SIMULATOR,
  side: 'BUY',
  quantity: 100,
};
```

---

### OrderId

Идентификатор ордера (для будущих Order entities).

```typescript
type OrderId = string & { readonly __brand: 'OrderId' };
```

**Замечание**: Пока placeholder. Будет использоваться в Phase 2 для Order entity.

---

### FillId

Идентификатор fill (для будущих Fill entities).

```typescript
type FillId = string & { readonly __brand: 'FillId' };
```

**Замечание**: Пока placeholder. Будет использоваться в Phase 2 для Fill entity.

---

## Сравнительная таблица

| Type                | Category      | Purpose                           | Example                     |
|---------------------|---------------|-----------------------------------|-----------------------------|
| ConditionRef        | Core          | Полная ссылка на condition        | { protocol, chain, id }     |
| OutcomeIndex        | Core          | YES/NO индекс (0 \| 1)             | 1 (YES)                     |
| AccountId           | Core          | Аккаунт владельца                 | '0x123...'                  |
| VenueId             | Core          | Где находятся балансы             | 'POLYMARKET'                |
| AssetId             | Core          | Currency или OutcomeToken         | { type: 'CURRENCY', ... }   |
| MarketDataSourceId  | Market Data   | Откуда ЧИТАЕМ данные              | 'POLYMARKET_WS'             |
| InstrumentId        | Market Data   | ID инструмента на source          | 'BTC-USD-2025'              |
| ExecutionVenueId    | Execution     | Куда ОТПРАВЛЯЕМ ордера            | 'POLYMARKET'                |
| OrderId             | Execution     | ID ордера (future)                | 'order-123'                 |
| FillId              | Execution     | ID fill (future)                  | 'fill-456'                  |

---

## Naming Conflicts Resolution

### OutcomeIndex

**Проблема**: Тип и namespace с одинаковым именем.

**Решение**:

```typescript
// В core/index.ts
export type { OutcomeIndex } from './OutcomeIndex.js';
export {
  OutcomeIndex as OutcomeIndexValues,  // ← rename namespace export
  // ... other functions
} from './OutcomeIndex.js';

// Использование
import { type OutcomeIndex, OutcomeIndexValues } from '@polymarket/ids';

const yes: OutcomeIndex = OutcomeIndexValues.YES;
```

### AssetId

**Проблема**: Тип и namespace с одинаковым именем.

**Решение**:

```typescript
// В core/index.ts
export type { AssetId } from './AssetId.js';
export {
  AssetId as AssetIdHelpers,  // ← rename namespace export
  // ... other functions
} from './AssetId.js';

// Использование
import { type AssetId, AssetIdHelpers } from '@polymarket/ids';

const usdc: AssetId = AssetIdHelpers.USDC;
```
