# WebSocket Message Parsers

> ⚠️ **DEPRECATED** - This document describes the old parser-based architecture.
>
> **Replaced by:** Event-Driven Architecture (January 2026)
> - `parseOrderbook()` and `parseTrade()` were replaced by `mapParsedToDomainEvent()`
> - See [Event Flow Documentation](../architecture/event-flow.md) for current architecture
> - See [CHANGES.md](../../CHANGES.md) for migration details
>
> **This document is kept for historical reference only.**

---

## Overview

Dedicated parsing layer for converting Polymarket WebSocket messages to Domain entities.

**Location:** `src/infrastructure/polymarket/ws/parsing/` ❌ **DELETED** (Step 6)

**Purpose:** Pure functions that transform raw Polymarket API data to Domain entities (Orderbook, Trade) with proper value objects and validation.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│           PolymarketWsAdapter (Integration)             │
│  - Routes messages from Router to Parsers               │
│  - Handles errors and logging                           │
└────────────────┬────────────────────────────────────────┘
                 │
       ┌─────────┴─────────┐
       │                   │
┌──────▼──────┐    ┌───────▼────────┐
│parseOrderbook│    │  parseTrade    │
│  (Pure fn)   │    │   (Pure fn)    │
└──────┬──────┘    └───────┬────────┘
       │                   │
       └─────────┬─────────┘
                 │
         ┌───────▼────────┐
         │ Domain Entities │
         │ - Orderbook     │
         │ - Trade         │
         │ - Price         │
         │ - Quantity      │
         └─────────────────┘
```

## Parsers

### 1. parseOrderbook()

**File:** `src/infrastructure/polymarket/ws/parsing/parseOrderbook.ts`

**Signature:**
```typescript
function parseOrderbook(message: PolymarketOrderbookMessage): Orderbook
```

**Responsibilities:**
- Validate `asset_id` (required, non-empty)
- Validate `bids` and `asks` arrays
- Convert price strings → `Price` value objects
- Convert size strings → `Quantity` value objects
- Handle timestamp (number/string/undefined → Date)
- Create immutable `Orderbook` entity

**Error Handling:**
- Throws `OrderbookParseError` on invalid data
- Includes field name and raw data in error

**Example:**
```typescript
const message = {
  event_type: 'book',
  asset_id: '677042551971...',
  bids: [{price: '0.52', size: '100'}, {price: '0.51', size: '200'}],
  asks: [{price: '0.53', size: '150'}],
  timestamp: 1766875759895
};

const orderbook = parseOrderbook(message);
// Orderbook with sorted bids/asks, typed value objects
```

**Test Coverage:** 27 tests covering:
- Valid messages (empty bids/asks, various timestamps)
- Missing fields (asset_id, bids, asks)
- Invalid data (malformed prices/sizes, invalid timestamps)
- Error details (field names, raw data included)

### 2. parseTrade()

**File:** `src/infrastructure/polymarket/ws/parsing/parseTrade.ts`

**Signature:**
```typescript
function parseTrade(message: PolymarketTradeMessage): Trade
```

**Responsibilities:**
- Validate `asset_id`, `price`, `size` (required)
- Convert price string → `Price` value object
- Convert size string → `Quantity` value object
- Handle side ('BUY'|'SELL'|null)
- Handle timestamp (number/string/undefined → Date)
- Generate unique trade ID (`asset_id_prefix-timestamp`)
- Create immutable `Trade` entity

**Error Handling:**
- Throws `TradeParseError` on invalid data
- Includes field name and raw data in error

**Example:**
```typescript
const message = {
  event_type: 'trade',
  asset_id: '677042551971...',
  price: '0.52',
  size: '50',
  side: 'BUY',
  timestamp: 1766875759895
};

const trade = parseTrade(message);
// Trade with ID '67704255-1766875759895', typed value objects
```

**Test Coverage:** 30 tests covering:
- Valid messages (BUY/SELL, last_trade_price, various timestamps)
- Missing fields (asset_id, price, size)
- Invalid data (malformed prices/sizes, invalid side/timestamps)
- Trade ID generation
- Error details (field names, raw data included)

## Design Principles

### 1. Pure Functions

Both parsers are **pure functions** with **no side effects**:
- Same input always produces same output
- No external state mutations
- No I/O operations
- Deterministic and testable

### 2. Single Responsibility

Each parser has **one job**:
- `parseOrderbook`: Polymarket orderbook message → Domain Orderbook
- `parseTrade`: Polymarket trade message → Domain Trade

### 3. Fail Fast

Parsers throw **immediately** on invalid data:
- Missing required fields → Error
- Invalid price/size → Error
- Malformed timestamps → Error

### 4. Descriptive Errors

Custom error classes with context:
```typescript
class OrderbookParseError {
  field?: string;       // Field that failed
  rawData?: unknown;    // Original problematic data
}

class TradeParseError {
  field?: string;
  rawData?: unknown;
}
```

### 5. Type Safety

Strong TypeScript typing throughout:
- Input types from `PolymarketMessageRouter`
- Output types from Domain layer
- Value objects (`Price`, `Quantity`) enforce constraints

## Integration with Adapter

**PolymarketWsAdapter** uses parsers for Domain conversion:

```typescript
private handleOrderbookMessage(message: PolymarketOrderbookMessage): void {
  try {
    // Skip if no callbacks
    if (!this.orderbookRegistry.has(message.asset_id)) return;

    // Parse using dedicated parser
    const orderbook = parseOrderbook(message);

    // Notify subscribers
    this.orderbookRegistry.notify(message.asset_id, orderbook);
  } catch (error) {
    // Errors logged, not propagated
    this.logger.error('Failed to handle orderbook', { error });
  }
}
```

**Error Handling:**
- Parsers throw errors on invalid data
- Adapter catches and logs errors
- Errors **never propagate** to user callbacks
- One bad message doesn't break other subscriptions

## Testing

### Unit Tests

**Location:**
- `tests/unit/infrastructure/polymarket/ws/parsing/parseOrderbook.test.ts`
- `tests/unit/infrastructure/polymarket/ws/parsing/parseTrade.test.ts`

**Coverage:** 57 tests total
- `parseOrderbook`: 27 tests
- `parseTrade`: 30 tests

**Test Categories:**
1. Valid messages (various formats)
2. Missing fields (required field validation)
3. Malformed data (invalid values)
4. Error details (field names, raw data)
5. Edge cases (empty arrays, NaN timestamps)

### Integration Tests

Parsers tested through **adapter integration tests**:
- End-to-end data flow (WebSocket → Parser → Domain → Callback)
- Multiple subscriptions
- Error isolation
- 46 integration + E2E tests

**Run tests:**
```bash
npm test -- parsing      # Parser unit tests only
npm test -- WsAdapter    # Integration tests
```

## Usage Examples

### Parsing Orderbook

```typescript
import { parseOrderbook } from './parsing/parseOrderbook.js';

// Valid message
const message = {
  event_type: 'book',
  asset_id: 'token-123',
  bids: [{price: '0.52', size: '100'}],
  asks: [{price: '0.53', size: '150'}],
  timestamp: 1766875759895
};

const orderbook = parseOrderbook(message);
console.log(orderbook.getBestBid()?.value);  // 0.52
console.log(orderbook.getBestAsk()?.value);  // 0.53
console.log(orderbook.getSpread()?.width()); // 0.01

// Invalid message
const invalid = { bids: [], asks: [] };
parseOrderbook(invalid);  // Throws OrderbookParseError
```

### Parsing Trade

```typescript
import { parseTrade } from './parsing/parseTrade.js';

// Valid message
const message = {
  event_type: 'trade',
  asset_id: 'token-123',
  price: '0.65',
  size: '100',
  side: 'BUY',
  timestamp: 1766875759895
};

const trade = parseTrade(message);
console.log(trade.id);            // 'token-12-1766875759895'
console.log(trade.price.value);   // 0.65
console.log(trade.quantity.value);// 100
console.log(trade.side);          // 'BUY'
console.log(trade.getNotional()); // 65.0

// Last trade price (no side)
const lastPrice = {
  event_type: 'last_trade_price',
  asset_id: 'token-123',
  price: '0.65',
  size: '50'
};

const trade2 = parseTrade(lastPrice);
console.log(trade2.side);  // null (valid)
```

## Error Handling Best Practices

### In Adapter (where parsers are called)

```typescript
try {
  const orderbook = parseOrderbook(message);
  registry.notify(tokenId, orderbook);
} catch (error) {
  // Log error with context
  logger.error('Failed to parse orderbook', {
    error: error instanceof Error ? error.message : String(error),
    tokenId: message.asset_id?.substring(0, 16) + '...',
    field: error instanceof OrderbookParseError ? error.field : undefined
  });

  // Don't propagate - isolate errors
  // Other subscriptions continue working
}
```

### In Application Code

**Don't use parsers directly** - use PolymarketWsAdapter instead:

```typescript
// ❌ Don't do this
const message = await getWebSocketMessage();
const orderbook = parseOrderbook(message);  // No error handling!

// ✅ Do this
adapter.subscribeToOrderbook(tokenId, (orderbook) => {
  // orderbook is already parsed and validated
  console.log(orderbook.getBestBid());
});
```

## Comparison: Before vs After

### Before (inline parsing)

```typescript
private handleOrderbookMessage(message: any): void {
  // 40+ lines of inline parsing
  const bids = message.bids.map(level => ({
    price: Price.fromNumber(parseFloat(level.price)),
    quantity: Quantity.fromMarketData(parseFloat(level.size))
  }));

  const asks = message.asks.map(level => ({
    price: Price.fromNumber(parseFloat(level.price)),
    quantity: Quantity.fromMarketData(parseFloat(level.size))
  }));

  let timestamp: Date;
  if (message.timestamp) {
    timestamp = new Date(message.timestamp);
    if (isNaN(timestamp.getTime())) {
      timestamp = new Date();
    }
  } else {
    timestamp = new Date();
  }

  const orderbook = Orderbook.create(tokenId, { bids, asks, timestamp });
  registry.notify(tokenId, orderbook);
}
```

**Problems:**
- Mixed concerns (routing + parsing)
- No validation
- Hard to test in isolation
- Duplicated logic (orderbook + trade)

### After (dedicated parsers)

```typescript
private handleOrderbookMessage(message: PolymarketOrderbookMessage): void {
  const orderbook = parseOrderbook(message);  // 1 line!
  registry.notify(message.asset_id, orderbook);
}
```

**Benefits:**
- ✅ Single responsibility (routing only)
- ✅ Full validation in parser
- ✅ Testable in isolation (57 parser tests)
- ✅ Reusable pure functions
- ✅ Type-safe errors

## Event Flow Changes (January 2026)

### Critical Fix: Message Emission Order

**Problem Found:** After refactoring, data collection stopped working. Router was receiving parsed objects instead of raw Buffers, causing `JSON.parse()` to fail.

**Root Cause:** `emit('message', data)` was in `processMessage()` AFTER parsing, so router received parsed objects instead of raw Buffers.

### Before (BROKEN)

```typescript
// WebSocketManager.handleMessage()
private handleMessage(data: WebSocket.Data): void {
  try {
    const message = JSON.parse(data.toString());
    this.processMessage(message);  // ← Passes PARSED object
  } catch (error) {
    // error handling
  }
}

// WebSocketManager.processMessage()
private processMessage(message: any): void {
  // Emit 'message' with PARSED object ❌
  this.emit('message', message);

  // Then emit specific events
  if (message.event_type === 'book') {
    this.emit('orderbook', message);
  }
}
```

**Result:**
```
WebSocket raw data (Buffer)
  → handleMessage() parses JSON
  → processMessage() emits 'message' with PARSED object  ❌
  → Router tries to parse again → ERROR!
  → Data collection fails (no events recorded)
```

### After (FIXED)

```typescript
// WebSocketManager.handleMessage()
private handleMessage(data: WebSocket.Data): void {
  // FIRST: Emit raw message event BEFORE parsing (for router)
  this.emit('message', data);  // ← RAW Buffer!

  try {
    const message = JSON.parse(data.toString());
    if (Array.isArray(message)) {
      for (const msg of message) {
        this.processMessage(msg);
      }
    } else {
      this.processMessage(message);
    }
  } catch (error) {
    // error handling
  }
}

// WebSocketManager.processMessage()
private processMessage(message: any): void {
  // Emit 'raw' for data collector
  const assetId = message.asset_id;
  if (assetId && (eventType === 'book' || eventType === 'trade')) {
    this.emit('raw', message);  // ← Parsed object for collector
  }

  // Emit specific events
  if (message.event_type === 'book') {
    this.emit('orderbook', message);
  }

  // NOTE: Does NOT emit 'message' here!
}
```

**Result:**
```
WebSocket raw data (Buffer)
  → handleMessage() emits 'message' with RAW Buffer  ✅
  → handleMessage() parses JSON
  → processMessage() emits 'raw', 'orderbook', 'trade'  ✅
  → Router receives raw Buffer and parses successfully  ✅
  → Data collection works (301+ events recorded)  ✅
```

### Event Types Summary

| Event | Data Type | Emitted By | Purpose |
|-------|-----------|------------|---------|
| `message` | Buffer (raw) | `handleMessage()` | Router receives raw data to parse |
| `raw` | Object (parsed) | `processMessage()` | DataCollector receives parsed data |
| `orderbook` | Object (parsed) | `processMessage()` | Specific orderbook events |
| `trade` | Object (parsed) | `processMessage()` | Specific trade events |

### Key Changes

1. **Moved `emit('message')`:** From `processMessage()` to `handleMessage()` BEFORE parsing
2. **Added `emit('raw')`:** New event in `processMessage()` for data collection
3. **Data types:** `message` = raw Buffer, `raw` = parsed object

**Why two events?**
- `message` (Buffer): Router needs raw data to parse → Domain entities
- `raw` (Object): DataCollector needs parsed data to save → files

### Testing

New unit tests verify correct emission order:

```typescript
describe('handleMessage() - emit order', () => {
  it('should emit "message" with raw Buffer BEFORE parsing', () => {
    const rawData = Buffer.from(JSON.stringify({
      event_type: 'book',
      asset_id: '123',
      bids: [],
      asks: []
    }));

    const messageSpy = jest.fn();
    wsManager.on('message', messageSpy);
    wsManager.handleMessage(rawData);

    // Should receive raw Buffer, not parsed object
    expect(messageSpy).toHaveBeenCalledWith(rawData);
    expect(Buffer.isBuffer(messageSpy.mock.calls[0][0])).toBe(true);
  });

  it('should emit "message" BEFORE specific events', () => {
    const callOrder: string[] = [];
    wsManager.on('message', () => callOrder.push('message'));
    wsManager.on('raw', () => callOrder.push('raw'));
    wsManager.on('orderbook', () => callOrder.push('orderbook'));

    wsManager.handleMessage(rawData);

    // Order: message → raw → orderbook
    expect(callOrder).toEqual(['message', 'raw', 'orderbook']);
  });
});
```

**Test Location:** `tests/unit/infrastructure/exchange/clients/WebSocketManager.test.ts`

### Impact

**Before fix:**
- ❌ Data collection broken (only 1 event recorded)
- ❌ Router throwing errors on parse
- ❌ Tests passed (but real flow was broken!)

**After fix:**
- ✅ Data collection working (301+ events)
- ✅ Router receives correct raw data
- ✅ All 271 tests passing
- ✅ E2E verified working

### Related Changes

This fix was part of larger refactoring:
1. **Parser extraction:** Moved parsing logic to dedicated pure functions
2. **Reconnection loop fix:** Added `_isSubscribing` flag (see [WebSocket Adapter](./websocket-adapter.md))
3. **Connect method:** Added explicit `connect()` to adapter

**Files changed:**
- `WebSocketManager.ts` (lines 456-459, 600)
- `collector.ts` (lines 171-188)
- Tests added: 6 new tests for event emission order

---

## Related Documentation

- [WebSocket Adapter](./websocket-adapter.md) - Main adapter with reconnection loop prevention
- [Event Flow Architecture](../architecture/event-flow.md) - Complete WebSocket event flow diagram
- **PolymarketMessageRouter:** Message routing layer
- **SubscriptionRegistry:** Callback management
- **Domain Entities:** Orderbook, Trade, Price, Quantity
