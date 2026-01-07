# Architecture Overview

## Event-Driven Market Data Processing

This project uses **Event Sourcing + CQRS** for processing real-time market data from Polymarket WebSocket feeds.

### Core Pipeline

```
WebSocket (raw Buffer)
  ↓
Router (JSON parse)
  ↓
Adapter (route by event_type)
  ↓
Mapper (PolymarketMessage → DomainEvent | null)
  ↓
EventBus (publish/subscribe)
  ↓
Projector (filter events by type)
  ↓
Aggregate (apply event → update state + check invariants)
  ↓
Callbacks (receive Domain Entities: Orderbook, Trade)
```

### Key Components

| Component | Responsibility | Location |
|-----------|---------------|----------|
| **Mapper** | Pure transformation (never throws) | `src/infrastructure/polymarket/ws/mapping/` |
| **EventBus** | Synchronous event dispatch | `src/shared/events/` |
| **Aggregate** | Business logic + invariants | `src/domain/aggregates/` |
| **Projector** | Event routing to aggregates | `src/application/projectors/` |
| **Domain Events** | Immutable event data | `src/domain/events/` |

### Domain Events

- **OrderBookSnapshotReceivedEvent** - Full orderbook snapshot (bids/asks)
- **TradeExecutedEvent** - Executed trade (price, size, side)
- **MarketDataErrorEvent** - Invariant violations or processing errors

### Business Invariants

Enforced by `MarketDataSubscriptionAggregate`:

1. **No time regression** - Events must have monotonically increasing timestamps
2. **Trade price within spread** - Trades must fall within current orderbook spread
3. **Asset ID consistency** - All events for an aggregate must match its asset ID

**Violation handling**: Aggregate throws `InvariantViolationError` → Projector catches → Emits `MarketDataErrorEvent`

### Multi-Market Isolation

Each market has isolated state:

```typescript
Map<assetId, Aggregate>           // Separate state per market
Map<assetId, CallbackRegistry>    // Separate callbacks per market
```

**Benefit**: Error in Market A doesn't affect Market B

### Error Handling Strategy (5 Layers)

1. **Mapper** - Returns `null` on invalid data (no throws, no logging)
2. **EventBus** - Catches handler errors silently per handler
3. **Aggregate** - Throws `InvariantViolationError` on business rule violation
4. **Projector** - Catches and emits `MarketDataErrorEvent`
5. **CallbackRegistry** - Logs callback errors, continues other callbacks

### Benefits

✅ **Separation of Concerns** - Pure mapper, business logic in aggregate, coordination in projector
✅ **Testability** - Each component fully unit testable (186 new tests, 417 total)
✅ **Error Isolation** - Failures don't cascade across markets or callbacks
✅ **Event Sourcing Ready** - All state changes are events, easy to add persistence
✅ **Observable System** - All data flows through EventBus for monitoring
✅ **Extensibility** - Add new event types/projectors without changing existing code

### Testing

- **Domain Events**: 57 tests (OrderBookSnapshot: 28, TradeExecuted: 29)
- **Mapper**: 30 tests (all edge cases, invalid data)
- **EventBus**: 26 tests (subscriptions, error isolation)
- **Aggregate**: 35 tests (invariants, event replay)
- **Projector**: 38 tests (event routing, callbacks, errors)
- **Total**: 417 tests passing ✅

### Performance

- **EventBus**: Synchronous (no async overhead)
- **Mapper**: Pure function (no I/O, no state)
- **Aggregate**: In-memory state (Map lookup)
- **Callback invocation**: Direct function calls (no queue, no delay)

**Typical latency**: WebSocket message → Callback invocation < 1ms

---

## Migration History

**January 2026**: Migrated from parser-based to event-driven architecture

**Changes**:
- 15 files created
- 5 files modified
- 4 files deleted (old parsers)
- 186 new tests added
- Zero breaking changes to public APIs

**See**: [CHANGES.md](./CHANGES.md) for complete migration details

---

## Documentation

- **[Event Flow](./docs/architecture/event-flow.md)** - Detailed event-driven architecture
- **[WebSocket Adapter](./docs/infrastructure/websocket-adapter.md)** - PolymarketWsAdapter implementation
- **[Market Discovery](./docs/services/market-discovery.md)** - Market filtering and selection
- **[Trading Strategy](./docs/strategy/README.md)** - Trading orchestration

---

## Quick Start

### Subscribe to Market Data

```typescript
import { PolymarketWsAdapter } from './infrastructure/polymarket/ws/PolymarketWsAdapter.js';

const adapter = new PolymarketWsAdapter(config, logger);

// Subscribe to orderbook updates
adapter.subscribeToOrderbook(tokenId, (orderbook) => {
  console.log(`Best bid: ${orderbook.getBestBid()?.value}`);
  console.log(`Best ask: ${orderbook.getBestAsk()?.value}`);
  console.log(`Spread: ${orderbook.getSpread()?.width()}`);
});

// Subscribe to trade updates
adapter.subscribeToTrades(tokenId, (trade) => {
  console.log(`Trade: ${trade.side} ${trade.quantity.value} @ ${trade.price.value}`);
  console.log(`Notional: ${trade.getNotional()}`);
});

// Unsubscribe
adapter.unsubscribeFromOrderbook(tokenId);
adapter.unsubscribeFromTrades(tokenId);
```

### Run Development Modes

```bash
# Main trading mode
npm run dev

# Data collection mode
npm run collect:dev

# Run tests
npm test

# Generate documentation
npm run docs:generate && npm run build
```

---

## Tech Stack

- **Language**: TypeScript (ES Modules, .js extensions in imports)
- **Testing**: Jest (@jest/globals imports)
- **WebSocket**: ws library
- **Logging**: Winston
- **Documentation**: TypeDoc + Astro
- **Patterns**: Event Sourcing, CQRS, Domain-Driven Design
