# Архитектура @polymarket/ids

## Почему отдельный пакет?

### Foundation vs Domain

`@polymarket/ids` находится в `packages/foundation/` (НЕ в `packages/domain/`), потому что:

- **Примитивные типы** - это building blocks, а не бизнес-логика
- **Используются везде** - в value objects, entities, services, adapters
- **Минимум зависимостей** - @polymarket/result для error handling, TypeScript
- **Branded types** - compile-time type safety с runtime валидацией через parsers

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
- Непонятно, где искать данные (какой RPC endpoint использовать)

**Решение**: Всегда используй `ConditionRef` с полным контекстом:

```typescript
type ConditionRef =
  | { kind: 'ONCHAIN'; protocolId: OnChainProtocolId; chainId: ChainId; conditionId: ConditionId; }
  | { kind: 'OFFCHAIN'; venueId: VenueId; marketId: string; };
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
// Branded string (открытый тип): любой валидный идентификатор источника
type MarketDataSourceId = string & { readonly __brand: 'MarketDataSourceId' };

// Известные sources доступны через KnownMarketDataSources:
// KnownMarketDataSources.POLYMARKET_WS      // Live WebSocket
// KnownMarketDataSources.POLYMARKET_REPLAY  // Historical data
// KnownMarketDataSources.KALSHI_WS          // и др.

// ExecutionVenueId - КУДА мы ОТПРАВЛЯЕМ
// Union: VenueId (реальная биржа) | SimulatorExecutionVenueId ('SIMULATOR')
type ExecutionVenueId = VenueId | SimulatorExecutionVenueId;

// Известные venues доступны через KnownExecutionVenues:
// KnownExecutionVenues.POLYMARKET  // Real venue (VenueId)
// KnownExecutionVenues.KALSHI      // Real venue (VenueId)
// KnownExecutionVenues.SIMULATOR   // Paper trading
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
// WalletAddress — branded string:
type WalletAddress = string & { readonly __brand: 'WalletAddress' };

// AccountId — discriminated union (не строка!):
type AccountId =
  | { kind: 'WALLET'; address: WalletAddress }
  | { kind: 'VENUE'; venueId: VenueId; userId: string }
  | { kind: 'SUBACCOUNT'; base: AccountId; name: string };

// ✅ TypeScript ошибка!
getBalance('0x123...');  // Type 'string' is not assignable to AccountId

// ✅ OK — создаётся через фабрику, а не cast
const wallet = parseWalletAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')!;
getBalance(accountIdFromWallet(wallet));
```

**Преимущества**:

- ✅ Compile-time type safety через branded types
- ✅ Легковесная runtime валидация через parser функции
- ✅ Невозможно случайно перепутать типы
- ✅ Self-documenting code

**Почему НЕ classes**:

- Classes требуют instantiation (`new AccountId('...')`)
- Classes требуют serialization/deserialization logic
- Branded types проще: type alias + parser функции
- Валидация происходит в parser функциях (parseAccountId, parseConditionRef, etc.)

### 4. AssetId как Union Type

**Проблема**: Нужен универсальный ID для любого актива (currency или outcome token).

**Решение**: Discriminated union

```typescript
type AssetId =
  | { type: 'CURRENCY'; currency: SupportedCurrency; }
  | { type: 'OUTCOME_TOKEN'; conditionRef: OnChainConditionRef; outcomeKey: OutcomeKey; };
// Только OnChainConditionRef: outcome tokens существуют только на-chain
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
    // TypeScript знает: asset.conditionRef и asset.outcomeKey доступны
    console.log(`Token: ${asset.conditionRef.conditionId} outcome ${asset.outcomeKey}`);
  }
}
```

**Safe-контракт `fromOutcomeToken`**:

Публичная фабрика `AssetId.fromOutcomeToken` (экспортируется как `AssetIdHelpers.fromOutcomeToken`)
возвращает `Result<AssetId, AssetIdValidationError>` — **никогда не бросает исключения**.
Первое невалидное поле (в порядке outcomeKey → protocolId → chainId → conditionId) порождает `Err`.

```typescript
const result = AssetIdHelpers.fromOutcomeToken(onChainRef, BinaryOutcome.UP);
if (result.ok) {
  const asset: AssetId = result.value; // замороженный immutable объект
} else {
  // result.error: AssetIdValidationError с context.field и context.value
  console.error(result.error.message);
}
```

### 5. AccountId: Безопасная сериализация

`AccountId` — рекурсивная структура (SUBACCOUNT содержит base AccountId). Это требует двух защитных механизмов.

#### Escaping в строковом формате

Формат: `sub:<base>:<name>`, где `<base>` и `<name>` могут содержать `:` и `\`.
Без escaping `parseAccountId` не может отличить разделитель от данных.

**Алгоритм escape** (порядок критичен):

```
1. '\' → '\\'   (сначала backslash, иначе следующий шаг сломает результат)
2. ':' → '\:'   (затем colon)
```

**Алгоритм unescape** (посимвольный автомат):

```
- '\\'  → '\'
- '\:'  → ':'
- Любой другой символ после '\' — оставить как есть
- Голый ':' — разделитель (не данные)
```

Это гарантирует корректный round-trip для любых строк:

```typescript
escapeId('user\\:123')    // → 'user\\\\\\:123'
unescapeId('user\\\\\\:123') // → 'user\\:123' ✅
```

#### Depth limit protection

Рекурсивный обход SUBACCOUNT без ограничения глубины → DoS через глубоко вложенные структуры.
Дополнительная угроза: **цикличные ссылки** вида `a.base === a` (создаются в обход TypeScript через `as any`),
которые без специальной защиты приводят к бесконечному циклу.

Константа `MAX_SUBACCOUNT_DEPTH = 5`. Поведение при превышении:

| Функция | Поведение при depth > 5 |
|---|---|
| `accountIdForSubaccount` | `Err(AccountIdDepthError)` — явный Result |
| `accountIdToString` | Возвращает строку всегда (total function); при глубине > MAX+10 — dev assert + `'[INVALID:DEPTH_EXCEEDED]'` |
| `parseAccountId` | `undefined` (graceful rejection) |
| `accountIdEquals` | `false` (безопасный fallback) |

`getSubaccountDepth` — тотальная итеративная функция с двойной защитой:

1. **Детект цикла** через `WeakSet`: если текущий объект уже посещался — возвращает
   `MAX_SUBACCOUNT_DEPTH + 1`, что гарантирует `Err(AccountIdDepthError)` в `accountIdForSubaccount`.
2. **Hard cap** (`MAX_SUBACCOUNT_DEPTH + 10 = 15 итераций`): страховка на случай
   аномально длинной, но ациклической цепочки.

```typescript
function getSubaccountDepth(id: AccountId): number {
  const SAFETY_MARGIN = 10;
  const MAX_ITERATIONS = MAX_SUBACCOUNT_DEPTH + SAFETY_MARGIN;
  const visited = new WeakSet<object>();
  let depth = 0;
  let current: AccountId = id;

  while (current.kind === 'SUBACCOUNT') {
    if (visited.has(current)) {
      return MAX_SUBACCOUNT_DEPTH + 1; // цикл → гарантированно > MAX
    }
    visited.add(current);
    depth++;
    if (depth > MAX_ITERATIONS) {
      return MAX_SUBACCOUNT_DEPTH + 1; // hard cap
    }
    current = current.base;
  }
  return depth;
}
```

#### Защита от длинных строк

`parseAccountId` проверяет `str.length > maxLen` (default: `MAX_ACCOUNT_ID_STRING_LENGTH = 4096`) до начала обработки. Кастомный лимит через `ParseAccountIdOptions.maxLen`.

---

### 6. VenueId для matching балансов

**Проблема**: В мультивенью системе нужно понимать, где находятся активы.

**Решение**: `VenueId` указывает площадку, где хранятся балансы/tokens.

```typescript
// Branded string (открытый тип): любой валидный идентификатор venue
type VenueId = string & { readonly __brand: 'VenueId' };

// Известные venues доступны через KnownVenues:
// KnownVenues.POLYMARKET, KnownVenues.KALSHI, и др.

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
if (quote.sourceId === KnownMarketDataSources.POLYMARKET_WS) {
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
│   │   ├── OrderId.ts     # branded ID для биржевых ордеров
│   │   ├── FillId.ts      # branded ID для исполненных сделок
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
export type ConditionRef =
  | Readonly<{ kind: 'ONCHAIN'; protocolId: OnChainProtocolId; chainId: ChainId; conditionId: ConditionId; }>
  | Readonly<{ kind: 'OFFCHAIN'; venueId: VenueId; marketId: string; }>;
```

### 2. Type Safety

Branded types для всех ID:

```typescript
type ChainId = number & { readonly __brand: 'ChainId' };
type ConditionId = string & { readonly __brand: 'ConditionId' };
```

### 3. Легковесная Runtime Валидация

Parser функции (parseAccountId, parseConditionRef, asVenueId, etc.) выполняют валидацию:

- Формат строк (регулярные выражения для ID типов)
- Длина строк (защита от DoS)
- Depth limit для рекурсивных структур (AccountId)
- Control characters проверка

Result pattern (@polymarket/result) для graceful error handling.

### 4. Self-Documenting

Явные имена типов, discriminated unions, TSDoc комментарии.

### 5. Extensibility

Open union types для будущих расширений:

```typescript
type MarketDataSourceId = string & { readonly __brand: 'MarketDataSourceId' };
// Известные значения доступны через KnownMarketDataSources:
// KnownMarketDataSources.POLYMARKET_WS, KnownMarketDataSources.KALSHI_WS, etc.
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

### Phase 2: OrderId и FillId ✓ (реализовано)

`OrderId` и `FillId` уже реализованы в `execution/` и доступны через `@polymarket/ids/execution`:

```typescript
import { asOrderId, asFillId } from '@polymarket/ids/execution';

// Парсинг/валидация ID
const orderId = asOrderId('order-123');  // OrderId | undefined
const fillId  = asFillId('fill-456');   // FillId  | undefined
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

---

## Tech Debt: несогласованность форматов ConditionRef

> **⚠️ Известное расхождение** — не блокирует текущий функционал, запланировано к устранению.

`ConditionRef` имеет два формата:

- `ONCHAIN` — on-chain протоколы: `{ kind, protocolId, chainId, conditionId }`
- `OFFCHAIN` — off-chain площадки: `{ kind, venueId, marketId }`

Строковый формат `conditionRefToString`:

- ONCHAIN: `ONCHAIN:POLYMARKET_CTF:137:0xabc...`
- OFFCHAIN: `OFFCHAIN:KALSHI:MARKET_ID`

При этом в системе существуют параллельные именования площадок:

- **AccountId-префиксы** (`wallet:`, `venue:`, `sub:` в строковом формате AccountId — не имеют отношения к VenueId)
- **VenueId** (`POLYMARKET`, `KALSHI`, ... — используется в AccountId kind=VENUE и балансах)
- **MarketDataSourceId** (`POLYMARKET_WS`, `POLYMARKET_REPLAY`, ...)
- **ExecutionVenueId** (`POLYMARKET`, `KALSHI`, `SIMULATOR`)

Эти форматы частично дублируют друг друга. Унификация требует breaking change в
serialization-формате и миграции хранимых данных — **в данной задаче не реализовывалась**.
Задача отслеживается отдельно.
