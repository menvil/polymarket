# Справочник типов @polymarket/ids

## Core IDs

### OnChainProtocolId

Идентификатор on-chain протокола prediction market.

```typescript
type OnChainProtocolId = string & { readonly __brand: 'OnChainProtocolId' };
```

**Известные on-chain протоколы**:

- `POLYMARKET_CTF` - Polymarket Conditional Token Framework (Gnosis CTF на Polygon)
- `UMA_CTF` - UMA Conditional Token Framework
- `GNOSIS_CTF` - Generic Gnosis CTF на любом EVM chain

**Использование**:

```typescript
import { type OnChainProtocolId, isKnownOnChainProtocol, KnownOnChainProtocols } from '@polymarket/ids';

const protocol: OnChainProtocolId = KnownOnChainProtocols.POLYMARKET_CTF;

if (isKnownOnChainProtocol(protocol)) {
  console.log('Known on-chain protocol');
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
  ETHEREUM_MAINNET: 1 as ChainId,
  POLYGON: 137 as ChainId,
  BASE: 8453 as ChainId,
} as const;
```

**Helpers**:

```typescript
function getChainName(chainId: ChainId): string;

// Примеры
getChainName(KnownChainIds.ETHEREUM_MAINNET); // → 'Ethereum Mainnet'
getChainName(KnownChainIds.POLYGON);          // → 'Polygon'
getChainName(KnownChainIds.BASE);             // → 'Base'
getChainName(999 as ChainId);                 // → 'Chain 999'
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
type ConditionRef = OnChainConditionRef | OffChainConditionRef;

type OnChainConditionRef = Readonly<{
  kind: 'ONCHAIN';
  protocolId: OnChainProtocolId;
  chainId: ChainId;
  conditionId: ConditionId;
}>;

type OffChainConditionRef = Readonly<{
  kind: 'OFFCHAIN';
  venueId: VenueId;
  marketId: string;
}>;
```

**Создание**:

```typescript
import { type ConditionRef, type OnChainConditionRef, type OffChainConditionRef, KnownChainIds, KnownOnChainProtocols, KnownVenues, parseConditionId } from '@polymarket/ids';

// On-chain condition (Polymarket)
const onChainRef: OnChainConditionRef = {
  kind: 'ONCHAIN',
  protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
  chainId: KnownChainIds.POLYGON,
  conditionId: parseConditionId('0xabc123...')!,
};

// Off-chain condition (KALSHI)
const offChainRef: OffChainConditionRef = {
  kind: 'OFFCHAIN',
  venueId: KnownVenues.KALSHI,
  marketId: 'KXBTCUSDM-24APR',
};
```

**Helper функции**:

```typescript
// Сравнение
function conditionRefEquals(a: ConditionRef, b: ConditionRef): boolean;

const ref1: ConditionRef = { kind: 'ONCHAIN', /* ... */ };
const ref2: ConditionRef = { kind: 'ONCHAIN', /* ... */ };
if (conditionRefEquals(ref1, ref2)) {
  console.log('Same condition');
}

// Преобразование в строку
function conditionRefToString(ref: ConditionRef): string;

const onChainStr = conditionRefToString(onChainRef);
// → "ONCHAIN:POLYMARKET_CTF:137:0xabc123..."

const offChainStr = conditionRefToString(offChainRef);
// → "OFFCHAIN:KALSHI:KXBTCUSDM-24APR"

// Парсинг из строки
function parseConditionRef(str: string): ConditionRef | undefined;

const parsedOnChain = parseConditionRef('ONCHAIN:POLYMARKET_CTF:137:0xabc123...');
// → { kind: 'ONCHAIN', protocolId: 'POLYMARKET_CTF', chainId: 137, conditionId: '0xabc123...' }

const parsedOffChain = parseConditionRef('OFFCHAIN:KALSHI:KXBTCUSDM-24APR');
// → { kind: 'OFFCHAIN', venueId: 'KALSHI', marketId: 'KXBTCUSDM-24APR' }

// Type guards
function isOnChainConditionRef(ref: ConditionRef): ref is OnChainConditionRef;
function isOffChainConditionRef(ref: ConditionRef): ref is OffChainConditionRef;

if (isOnChainConditionRef(ref)) {
  console.log(`On-chain: ${ref.protocolId} on chain ${ref.chainId}`);
} else {
  console.log(`Off-chain: ${ref.venueId} market ${ref.marketId}`);
}
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
const conditionRef: OnChainConditionRef = {
  kind: 'ONCHAIN',
  protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
  chainId: KnownChainIds.POLYGON,
  conditionId: parseConditionId('0xabc123...')!,
};
// Всё понятно! Polygon, Polymarket CTF, condition hash.
```

---

### WalletAddress

Ethereum-совместимый адрес кошелька.

```typescript
type WalletAddress = string & { readonly __brand: 'WalletAddress' };
```

**Helper функции**:

```typescript
// Validation (format: 0x + 40 lowercase hex chars only — mixed case returns false)
function isValidWalletAddressFormat(address: string): boolean;

isValidWalletAddressFormat('0x1234567890123456789012345678901234567890');  // → true (if valid format)

// Parsing (lowercase normalization)
function parseWalletAddress(address: string): WalletAddress | undefined;

parseWalletAddress('0xAbC123...')
// → '0xabc123...' as WalletAddress (lowercase canonical form)

parseWalletAddress('INVALID')
// → undefined
```

---

### AccountId

Идентификатор аккаунта (wallet, venue account, или subaccount).

```typescript
type AccountId =
  | {
      readonly kind: 'WALLET';
      readonly address: WalletAddress;
    }
  | {
      readonly kind: 'VENUE';
      readonly venueId: VenueId;
      readonly userId: string;
    }
  | {
      readonly kind: 'SUBACCOUNT';
      readonly base: AccountId;
      readonly name: string;
    };
```

**Helper функции**:

```typescript
import {
  type AccountId,
  accountIdFromWallet,
  accountIdFromVenue,
  accountIdForSubaccount,
  AccountIdValidationError,
  AccountIdDepthError,
  parseWalletAddress,
  KnownVenues
} from '@polymarket/ids';
import type { Result } from '@polymarket/result';

// От wallet address
function accountIdFromWallet(wallet: WalletAddress): AccountId;

const wallet = parseWalletAddress('0x123...')!;
const accountId = accountIdFromWallet(wallet);
// → { kind: 'WALLET', address: '0x123...' }

// От venue account
function accountIdFromVenue(venue: VenueId, userId: string): Result<AccountId, AccountIdValidationError>;

const result = accountIdFromVenue(KnownVenues.KALSHI, 'user123');
if (result.ok) {
  const accountId = result.value;
  // → { kind: 'VENUE', venueId: 'KALSHI', userId: 'user123' }
} else {
  console.error('Invalid userId:', result.error.message);
}

// Subaccount
function accountIdForSubaccount(base: AccountId, subaccountName: string): Result<AccountId, AccountIdDepthError | AccountIdValidationError>;

const walletAcc = accountIdFromWallet(parseWalletAddress('0x123...')!);
const subResult = accountIdForSubaccount(walletAcc, 'trading');
if (subResult.ok) {
  const subaccount = subResult.value;
  // → { kind: 'SUBACCOUNT', base: { kind: 'WALLET', ... }, name: 'trading' }
} else {
  console.error('Error:', subResult.error.message);
}

// Сериализация
function accountIdToString(id: AccountId): string;

accountIdToString(accountId);
// → 'wallet:0x123...'

accountIdToString(result.value);
// → 'venue:KALSHI:user123'

accountIdToString(subResult.value);
// → 'sub:wallet:0x123...:trading'

// Парсинг
function parseAccountId(str: string): AccountId | undefined;

const parsed = parseAccountId('wallet:0x123...');
// → { kind: 'WALLET', address: '0x123...' }

// Type guards
function isWalletAccount(id: AccountId): id is Extract<AccountId, { kind: 'WALLET' }>;
function isVenueAccount(id: AccountId): id is Extract<AccountId, { kind: 'VENUE' }>;
function isSubaccount(id: AccountId): id is Extract<AccountId, { kind: 'SUBACCOUNT' }>;

if (isWalletAccount(accountId)) {
  // TypeScript знает: accountId.address is WalletAddress
  console.log(accountId.address);
}
```

**Использование**:

```typescript
import { type AccountId, accountIdFromWallet, parseWalletAddress } from '@polymarket/ids';

const wallet = parseWalletAddress('0x123...')!;
const accountId = accountIdFromWallet(wallet);

// Получить баланс для account
const balance = getBalance(accountId, venueId);

// Pattern matching
if (accountId.kind === 'WALLET') {
  console.log('Wallet account:', accountId.address);
} else if (accountId.kind === 'VENUE') {
  console.log('Venue account:', accountId.venueId, accountId.userId);
} else {
  console.log('Subaccount:', accountId.name);
}
```

---

### VenueId

Идентификатор площадки, где находятся балансы/tokens.

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
  | { readonly type: 'OUTCOME_TOKEN'; readonly conditionRef: OnChainConditionRef; readonly outcomeKey: OutcomeKey; };
```

**Helper функции**:

```typescript
import {
  AssetIdHelpers,
  KnownCurrencies,
  BinaryOutcome,
  type OnChainConditionRef,
  KnownOnChainProtocols,
  KnownChainIds,
  parseConditionId
} from '@polymarket/ids';

// Currency asset
const usdc = AssetIdHelpers.USDC;
// → { type: 'CURRENCY', currency: 'USDC' }

const usdcExplicit = AssetIdHelpers.fromCurrency(KnownCurrencies.USDC);
// → { type: 'CURRENCY', currency: 'USDC' }

// Outcome token asset
const onChainRef: OnChainConditionRef = {
  kind: 'ONCHAIN',
  protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
  chainId: KnownChainIds.POLYGON,
  conditionId: parseConditionId('0xabc123...')!,
};

const tokenAsset = AssetIdHelpers.fromOutcomeToken(onChainRef, BinaryOutcome.UP);
// → { type: 'OUTCOME_TOKEN', conditionRef: {...}, outcomeKey: 'UP' }

// Сравнение
function assetIdEquals(a: AssetId, b: AssetId): boolean;

assetIdEquals(usdc, AssetIdHelpers.USDC);  // → true
assetIdEquals(usdc, usdcExplicit);         // → true

// To string
function assetIdToString(asset: AssetId): string;

assetIdToString(usdc);
// → 'CURRENCY:USDC'

assetIdToString(tokenAsset);
// → 'OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0xabc123...:UP'

// Type guards
function isCurrencyAsset(asset: AssetId): asset is { type: 'CURRENCY'; currency: SupportedCurrency };
function isOutcomeTokenAsset(asset: AssetId): asset is { type: 'OUTCOME_TOKEN'; conditionRef: OnChainConditionRef; outcomeKey: OutcomeKey };

if (isCurrencyAsset(asset)) {
  console.log(`Currency: ${asset.currency}`);
} else {
  console.log(`Token: outcome ${asset.outcomeKey}`);
}
```

**Использование**:

```typescript
import {
  type AssetId,
  AssetIdHelpers,
  isCurrencyAsset,
  BinaryOutcome,
  type OnChainConditionRef,
  KnownOnChainProtocols,
  KnownChainIds,
  parseConditionId
} from '@polymarket/ids';

function processAsset(asset: AssetId) {
  if (isCurrencyAsset(asset)) {
    // TypeScript знает: asset.currency доступен
    console.log(`Processing currency: ${asset.currency}`);
  } else {
    // TypeScript знает: asset.conditionRef и asset.outcomeKey доступны
    console.log(`Processing token for condition ${asset.conditionRef.conditionId}`);
    console.log(`Outcome: ${asset.outcomeKey}`);
  }
}

// Примеры
processAsset(AssetIdHelpers.USDC);

const onChainRef: OnChainConditionRef = {
  kind: 'ONCHAIN',
  protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
  chainId: KnownChainIds.POLYGON,
  conditionId: parseConditionId('0xabc123...')!,
};
processAsset(AssetIdHelpers.fromOutcomeToken(onChainRef, BinaryOutcome.UP));
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

// Type guards (возвращают undefined для неизвестных источников)
function isLiveSource(sourceId: MarketDataSourceId): boolean | undefined;
function isReplaySource(sourceId: MarketDataSourceId): boolean | undefined;

// Известные источники
isLiveSource('POLYMARKET_WS');      // → true
isLiveSource('POLYMARKET_REPLAY');  // → false
isReplaySource('POLYMARKET_REPLAY'); // → true

// Неизвестные источники (custom)
const customSource = 'MY_CUSTOM_SOURCE' as MarketDataSourceId;
isLiveSource(customSource);         // → undefined (нет metadata)
isReplaySource(customSource);       // → undefined (нет metadata)
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

| Type                | Category      | Purpose                           | Example                                    |
|---------------------|---------------|-----------------------------------|--------------------------------------------|
| OnChainProtocolId   | Core          | Протокол on-chain market          | 'POLYMARKET_CTF'                           |
| ChainId             | Core          | Blockchain network                | 137 (Polygon)                              |
| ConditionId         | Core          | Hash condition                    | '0xabc123...'                              |
| ConditionRef        | Core          | Полная ссылка на condition        | { kind: 'ONCHAIN', protocol, chain, id }   |
| OutcomeKey          | Core          | UP/DOWN outcome key               | 'UP', 'DOWN'                               |
| WalletAddress       | Core          | Ethereum-compatible address       | '0x1234...'                                |
| AccountId           | Core          | Аккаунт владельца                 | { kind: 'WALLET', address }                |
| VenueId             | Core          | Где находятся балансы             | 'POLYMARKET'                               |
| AssetId             | Core          | Currency или OutcomeToken         | { type: 'CURRENCY', currency: 'USDC' }     |
| MarketDataSourceId  | Market Data   | Откуда ЧИТАЕМ данные              | 'POLYMARKET_WS'                            |
| InstrumentId        | Market Data   | ID инструмента на source          | 'BTC-USD-2025'                             |
| ExecutionVenueId    | Execution     | Куда ОТПРАВЛЯЕМ ордера            | 'POLYMARKET'                               |
| OrderId             | Execution     | ID ордера (future)                | 'order-123'                                |
| FillId              | Execution     | ID fill (future)                  | 'fill-456'                                 |

---

## Naming Conflicts Resolution

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
