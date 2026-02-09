# Архитектурное решение: On-Chain vs Off-Chain Conditions

## Проблема

**Исходная версия** (до рефакторинга):

```typescript
type ProtocolId = 'POLYMARKET_CTF' | 'KALSHI' | 'UMA_CTF';

type ConditionRef = {
  protocolId: ProtocolId;
  chainId: ChainId;        // ← ПРОБЛЕМА!
  conditionId: ConditionId;
};
```

**Логическое противоречие:**
- `ProtocolId` включает `'KALSHI'`
- `ConditionRef` обязывает иметь `chainId: ChainId` (EVM chain ID)
- **Но KALSHI не EVM-сеть!** Это regulated off-chain exchange в США

Модель заставляет притворяться, что KALSHI - on-chain protocol, хотя это не так.

### Смешение концепций

1. **Protocol** (механика/стандарт):
   - POLYMARKET_CTF - это Gnosis CTF protocol на Polygon
   - UMA_CTF - это UMA Conditional Token Framework
   - Это on-chain protocols с chainId, conditionId (hash)

2. **Venue** (платформа):
   - POLYMARKET - платформа, использующая POLYMARKET_CTF
   - KALSHI - regulated exchange, НЕ имеет blockchain
   - Это разные измерения!

### Пример противоречия

```typescript
// ❌ Невозможно создать валидный ConditionRef для KALSHI
const kalshi: ConditionRef = {
  protocolId: 'KALSHI',        // OK
  chainId: ???,                // ЧТО ЗДЕСЬ?? KALSHI не on-chain!
  conditionId: '0x...',        // KALSHI не использует keccak256 hashes
};
```

**Вывод**: `ConditionRef` в исходной версии - это `OnChainConditionRef`, а не универсальная "ссылка на condition".

## Решение: Discriminated Union

### Новая архитектура

```typescript
// 1. Разделение Protocol (только on-chain)
type OnChainProtocolId = 'POLYMARKET_CTF' | 'UMA_CTF' | 'GNOSIS_CTF';

// 2. On-Chain Condition Reference
type OnChainConditionRef = {
  readonly kind: 'ONCHAIN';
  readonly protocolId: OnChainProtocolId;
  readonly chainId: ChainId;
  readonly conditionId: ConditionId;
};

// 3. Off-Chain Condition Reference
type OffChainConditionRef = {
  readonly kind: 'OFFCHAIN';
  readonly venueId: VenueId;      // KALSHI, PREDICTIT, etc
  readonly marketId: string;      // venue-specific market ID
};

// 4. Discriminated Union
type ConditionRef = OnChainConditionRef | OffChainConditionRef;
```

### Преимущества

#### 1. ✅ Type Safety

**До:**
```typescript
// Можно создать невалидный ConditionRef
const invalid: ConditionRef = {
  protocolId: 'KALSHI',
  chainId: 137,  // ❌ KALSHI не на Polygon!
  conditionId: '0xabc123'
};
```

**После:**
```typescript
// ❌ TypeScript error - KALSHI не on-chain protocol
const invalid: OnChainConditionRef = {
  kind: 'ONCHAIN',
  protocolId: 'KALSHI',  // Error: Type 'KALSHI' is not assignable
  chainId: 137,
  conditionId: '0xabc123'
};

// ✅ Правильно - используем OffChainConditionRef
const valid: OffChainConditionRef = {
  kind: 'OFFCHAIN',
  venueId: 'KALSHI',
  marketId: 'KXBTCUSDM-24APR'
};
```

#### 2. ✅ Exhaustive Checking

```typescript
function processCondition(ref: ConditionRef) {
  if (ref.kind === 'ONCHAIN') {
    // TypeScript knows: ref has protocolId, chainId, conditionId
    const rpcUrl = getRpcUrl(ref.chainId);
    const contract = getContractAddress(ref.protocolId);
    // Query on-chain data
  } else {
    // TypeScript knows: ref has venueId, marketId
    const apiUrl = getVenueApiUrl(ref.venueId);
    // Query venue REST API
  }
  // TypeScript ensures all cases covered
}
```

#### 3. ✅ Явная семантика

**On-Chain:**
- EVM-based protocols
- Имеет chainId (blockchain network)
- Имеет conditionId (keccak256 hash)
- Примеры: Polymarket CTF, UMA CTF

**Off-Chain:**
- Regulated exchanges
- Имеет venueId (platform name)
- Имеет marketId (venue-specific ID)
- Примеры: KALSHI, PREDICTIT

#### 4. ✅ Легко расширять

Добавление нового on-chain protocol:
```typescript
type OnChainProtocolId =
  | 'POLYMARKET_CTF'
  | 'UMA_CTF'
  | 'GNOSIS_CTF'
  | 'NEW_PROTOCOL_CTF';  // ← просто добавили
```

Добавление нового off-chain venue:
```typescript
type VenueId =
  | 'POLYMARKET'
  | 'KALSHI'
  | 'PREDICTIT'
  | 'NEW_VENUE';  // ← просто добавили
```

## Примеры использования

### Polymarket (On-Chain)

```typescript
const polymarketCondition: ConditionRef = {
  kind: 'ONCHAIN',
  protocolId: 'POLYMARKET_CTF',
  chainId: 137,  // Polygon
  conditionId: '0x742d35cc6634c0532925a3b844bc9e7595f0bee1254e37e3ceb2f92cd2e8d6b9'
};

// AssetId для outcome token
const yesToken: AssetId = {
  type: 'OUTCOME_TOKEN',
  conditionRef: polymarketCondition,
  outcomeKey: BinaryOutcome.UP  // YES
};
```

### KALSHI (Off-Chain)

```typescript
const kalshiMarket: ConditionRef = {
  kind: 'OFFCHAIN',
  venueId: 'KALSHI',
  marketId: 'KXBTCUSDM-24APR'
};

// KALSHI не имеет tokenized positions,
// используем другие value objects для positions
```

### Type Guards

```typescript
import { isOnChainConditionRef, isOffChainConditionRef } from '@polymarket/ids';

function getMarketData(ref: ConditionRef) {
  if (isOnChainConditionRef(ref)) {
    // Query blockchain
    return queryOnChainData(ref.chainId, ref.conditionId);
  }

  if (isOffChainConditionRef(ref)) {
    // Query venue API
    return queryVenueAPI(ref.venueId, ref.marketId);
  }
}
```

### Сериализация

```typescript
import { conditionRefToString, parseConditionRef } from '@polymarket/ids';

// On-chain
const onChain: ConditionRef = {
  kind: 'ONCHAIN',
  protocolId: 'POLYMARKET_CTF',
  chainId: 137,
  conditionId: '0xabc123'
};

const str1 = conditionRefToString(onChain);
// → "ONCHAIN:POLYMARKET_CTF:137:0xabc123"

// Off-chain
const offChain: ConditionRef = {
  kind: 'OFFCHAIN',
  venueId: 'KALSHI',
  marketId: 'KXBTCUSDM-24APR'
};

const str2 = conditionRefToString(offChain);
// → "OFFCHAIN:KALSHI:KXBTCUSDM-24APR"

// Парсинг
const parsed1 = parseConditionRef('ONCHAIN:POLYMARKET_CTF:137:0xabc123');
const parsed2 = parseConditionRef('OFFCHAIN:KALSHI:KXBTCUSDM-24APR');
```

## Сравнение с исходной версией

| Аспект | До | После |
|--------|----|----|
| **Protocol** | POLYMARKET_CTF \| KALSHI \| UMA_CTF | OnChainProtocolId (только on-chain) |
| **Venue** | Не разделено | VenueId (POLYMARKET \| KALSHI \| ...) |
| **ConditionRef** | Один тип (всегда с chainId) | Discriminated union (ONCHAIN \| OFFCHAIN) |
| **KALSHI** | Противоречие (protocol без chainId) | ✅ OffChainConditionRef с venueId |
| **Type Safety** | ❌ Можно создать невалидные refs | ✅ TypeScript предотвращает ошибки |
| **Семантика** | ❌ Неявная (Protocol = Venue?) | ✅ Явная (On-Chain vs Off-Chain) |

## Migration Guide

### Для consumers

**До:**
```typescript
const ref: ConditionRef = {
  protocolId: 'POLYMARKET_CTF',
  chainId: 137,
  conditionId: '0xabc123'
};
```

**После:**
```typescript
const ref: ConditionRef = {
  kind: 'ONCHAIN',  // ← добавили discriminator
  protocolId: 'POLYMARKET_CTF',
  chainId: 137,
  conditionId: '0xabc123'
};
```

### Для KALSHI

**До:**
```typescript
// ❌ Невозможно создать валидный ref
const kalshi: ConditionRef = {
  protocolId: 'KALSHI',  // KALSHI был в ProtocolId
  chainId: ???,          // Что здесь??
  conditionId: ???       // Что здесь??
};
```

**После:**
```typescript
// ✅ Теперь возможно и type-safe
const kalshi: ConditionRef = {
  kind: 'OFFCHAIN',
  venueId: 'KALSHI',
  marketId: 'KXBTCUSDM-24APR'
};
```

## Будущие расширения

### Добавление новых on-chain protocols

```typescript
// Легко добавить новый CTF protocol на другом chain
type OnChainProtocolId =
  | 'POLYMARKET_CTF'    // Polygon
  | 'UMA_CTF'           // Ethereum
  | 'GNOSIS_CTF'        // Generic
  | 'BASE_CTF'          // ← новый protocol на Base
  | 'ARBITRUM_CTF';     // ← новый protocol на Arbitrum
```

### Добавление новых off-chain venues

```typescript
type VenueId =
  | 'POLYMARKET'
  | 'KALSHI'
  | 'PREDICTIT'
  | 'AUGUR_V2'          // ← если будет off-chain mode
  | 'FUTUUR';           // ← новый venue
```

### Hybrid Venues (On-Chain + Off-Chain API)

Некоторые venues могут иметь оба режима:

```typescript
// Polymarket - on-chain protocol
const polymarketOnChain: ConditionRef = {
  kind: 'ONCHAIN',
  protocolId: 'POLYMARKET_CTF',
  chainId: 137,
  conditionId: '0xabc123'
};

// Если бы у Polymarket был off-chain trading mode
const polymarketOffChain: ConditionRef = {
  kind: 'OFFCHAIN',
  venueId: 'POLYMARKET',
  marketId: 'market-slug-123'
};
```

## Заключение

Discriminated union для ConditionRef:
- ✅ Устраняет логическое противоречие (Protocol vs Venue)
- ✅ Добавляет type safety (невозможно создать невалидные refs)
- ✅ Делает семантику явной (On-Chain vs Off-Chain)
- ✅ Легко расширяется (новые protocols и venues)
- ✅ Exhaustive checking в TypeScript

**Архитектурно правильное решение** для мультивенью prediction market системы.
