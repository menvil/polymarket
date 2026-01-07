# Event-Driven Architecture Migration: File Changes (Steps 1-8)

## Summary

- **Total files created**: 15
- **Total files modified**: 5
- **Total files deleted**: 4
- **Total tests added**: 186 tests
- **All tests passing**: 417/417 ✅

---

## Step 1: Domain Events (3 new files + 2 test files)

### Created Files

- `src/domain/events/OrderBookSnapshotReceivedEvent.ts`
  - Domain event for orderbook snapshots
  - Contains bids/asks as primitives (number arrays)
  - Helper methods: `getBestBid()`, `getBestAsk()`, `getSpread()`

- `src/domain/events/TradeExecutedEvent.ts`
  - Domain event for executed trades
  - Contains price, size, side (BUY/SELL/null)
  - Helper methods: `getNotional()`, `isBuy()`, `isSell()`

- `src/domain/events/MarketDataErrorEvent.ts`
  - Error event for invariant violations and processing errors
  - Error types: `INVARIANT_VIOLATION`, `PROCESSING_ERROR`, `UNKNOWN`
  - Helper methods: `isInvariantViolation()`, `isProcessingError()`

- `tests/unit/domain/events/OrderBookSnapshotReceivedEvent.test.ts` (28 tests)
- `tests/unit/domain/events/TradeExecutedEvent.test.ts` (29 tests)

### Modified Files

- `src/domain/events/index.ts`
  - Added exports for new events and types

---

## Step 2: Mapper (1 new file + 1 test file)

### Created Files

- `src/infrastructure/polymarket/ws/mapping/mapParsedToDomainEvent.ts`
  - Pure mapper: `PolymarketMessage → DomainEvent | null`
  - Never throws, returns null on invalid data
  - Validates all fields before creating events
  - Handles: `book`, `trade`, `last_trade_price`, control messages

- `tests/unit/infrastructure/polymarket/ws/mapping/mapParsedToDomainEvent.test.ts` (30 tests)

---

## Step 3: EventBus (1 new file + 1 test file)

### Created Files

- `src/shared/events/InMemoryEventBus.ts`
  - Synchronous event bus with error isolation
  - Methods: `publish()`, `subscribe()`, `subscribeAll()`
  - Error handling: silent catch per handler
  - Invocation order: specific handlers → "all" handlers

- `tests/unit/shared/events/InMemoryEventBus.test.ts` (26 tests)

---

## Step 4: Aggregate (1 new file + 1 test file)

### Created Files

- `src/domain/aggregates/MarketDataSubscriptionAggregate.ts`
  - Event-sourced aggregate for market-data state
  - Invariants:
    - No time regression (monotonic timestamps)
    - Trade price within spread (if orderbook exists)
    - Asset ID match
  - Methods: `apply()`, `replay()`, `getOrderbook()`, `getLastTrade()`
  - Throws `InvariantViolationError` on violations

- `tests/unit/domain/aggregates/MarketDataSubscriptionAggregate.test.ts` (35 tests)

---

## Step 5: Projector (1 new file + 1 test file)

### Created Files

- `src/application/projectors/MarketDataProjector.ts`
  - Connects EventBus → Aggregates → Callbacks
  - One global projector for all markets
  - `Map<assetId, Aggregate>` for state isolation
  - `Map<assetId, CallbackRegistry>` for callback isolation
  - Catches `InvariantViolationError` → emits `MarketDataErrorEvent`
  - Methods:
    - `subscribeToOrderbook()`, `subscribeToTrades()`
    - `unsubscribeAllOrderbooks()`, `unsubscribeAllTrades()`
    - `getOrderbook()`, `getLastTrade()`, `getAggregate()`

- `tests/unit/application/projectors/MarketDataProjector.test.ts` (38 tests)

---

## Step 6: Refactor Adapter (1 modified + 4 deleted + 1 test modified)

### Modified Files

- `src/infrastructure/polymarket/ws/PolymarketWsAdapter.ts`
  - **Complete refactoring** to use event-driven architecture
  - Removed: `SubscriptionRegistry`, `parseOrderbook`, `parseTrade`
  - Added: `InMemoryEventBus`, `MarketDataProjector`, `mapParsedToDomainEvent`
  - Architecture: `Router → Adapter → Mapper → EventBus → Projector → Callbacks`
  - Changed message handlers:
    - OLD: `parse() → Registry.notify()`
    - NEW: `mapper() → EventBus.publish()`
  - Delegated subscriptions to projector
  - Added unsubscribe methods calling `projector.unsubscribeAll*()`

- `src/application/projectors/MarketDataProjector.ts`
  - Added `unsubscribeAllOrderbooks(assetId)` method
  - Added `unsubscribeAllTrades(assetId)` method
  - Updated `CallbackRegistry` to log callback errors (not silently catch)

- `tests/unit/infrastructure/polymarket/ws/PolymarketWsAdapter.e2e.test.ts`
  - Added timestamps to trade events in batch test (fix time regression invariant)

### Deleted Files

- `src/infrastructure/polymarket/ws/parsing/parseOrderbook.ts`
  - Replaced by event-driven mapper

- `src/infrastructure/polymarket/ws/parsing/parseTrade.ts`
  - Replaced by event-driven mapper

- `tests/unit/infrastructure/polymarket/ws/parsing/parseOrderbook.test.ts`
  - No longer needed (mapper tests cover this)

- `tests/unit/infrastructure/polymarket/ws/parsing/parseTrade.test.ts`
  - No longer needed (mapper tests cover this)

---

## Step 7: Error Handling Strategy

**Status**: Already implemented ✅

**No changes needed** - current architecture already uses event-driven error handling:
- Aggregate throws `InvariantViolationError`
- Projector catches → emits `MarketDataErrorEvent`
- Mapper returns `null` silently
- CallbackRegistry logs errors with isolation

---

## Step 8: Integration with Dev Modes

**Status**: Already integrated ✅

**No changes needed** - both dev modes already use event-driven architecture:
- `npm run dev` (main.ts): Uses `MultiMarketTrader` → `PolymarketWsAdapter`
- `npm run collect:dev` (collector.ts): Uses `PolymarketWsAdapter` directly
- DI container (providers.ts): Creates new `PolymarketWsAdapter` instances

---

## Architecture Pipeline

```
┌─────────────┐
│  WebSocket  │
└──────┬──────┘
       │ raw Buffer
       ▼
┌─────────────┐
│   Router    │ (parse JSON)
└──────┬──────┘
       │ PolymarketMessage
       ▼
┌─────────────┐
│   Adapter   │ (handleOrderbookMessage / handleTradeMessage)
└──────┬──────┘
       │ PolymarketMessage
       ▼
┌─────────────┐
│   Mapper    │ (mapParsedToDomainEvent)
└──────┬──────┘
       │ DomainEvent | null
       ▼
┌─────────────┐
│  EventBus   │ (publish)
└──────┬──────┘
       │ DomainEvent
       ▼
┌─────────────┐
│  Projector  │ (subscribeAll on EventBus)
└──────┬──────┘
       │ Filter: OrderBookSnapshot | TradeExecuted
       ▼
┌─────────────┐
│  Aggregate  │ (apply event → update state)
└──────┬──────┘
       │ On success: extract entity
       │ On error: throw InvariantViolationError
       ▼
┌─────────────┐
│  Projector  │ (catch error → emit MarketDataErrorEvent)
└──────┬──────┘
       │ Success: notify callbacks
       │ Error: emit error event
       ▼
┌─────────────┐
│  Callbacks  │ (receive Orderbook / Trade entities)
└─────────────┘
```

---

## Benefits of Event-Driven Architecture

### 1. **Separation of Concerns**
- Mapper: pure transformation (no state, no side effects)
- Aggregate: business logic + invariants
- Projector: coordination (event routing)
- Callbacks: presentation layer

### 2. **Testability**
- Each component fully unit testable in isolation
- 186 new tests added (417 total)
- Mappers: test with fixtures (no mocks)
- Aggregates: test with event replay
- Projector: test with synthetic events

### 3. **Error Isolation**
- Invalid data → mapper returns null → skip silently
- Invariant violation → error event → callbacks still work for other markets
- Callback error → logged but doesn't affect other callbacks
- No cascade failures

### 4. **Event Sourcing Ready**
- All state changes are events
- Events are immutable
- Aggregate can replay event history
- Easy to add event persistence later

### 5. **Observable System**
- All data flows through EventBus
- Easy to add monitoring/metrics
- Can subscribe to any event for logging/debugging
- MarketDataErrorEvent for quality monitoring

### 6. **Extensibility**
- Add new event types without changing existing code
- Add new projectors for different views
- Add new aggregates for different invariants
- Add new subscribers without touching producers

---

## Migration Checklist

- ✅ Step 1: Domain Events created
- ✅ Step 2: Pure Mapper implemented
- ✅ Step 3: EventBus implemented
- ✅ Step 4: Aggregate with invariants implemented
- ✅ Step 5: Projector implemented
- ✅ Step 6: Adapter refactored to use event-driven pipeline
- ✅ Step 7: Error handling strategy verified (already event-driven)
- ✅ Step 8: Integration with dev modes verified (already using new architecture)
- ✅ All 417 tests passing
- ✅ TypeScript build successful
- ✅ Zero breaking changes to public APIs
- ✅ Documentation updated

---

## Next Steps (Optional Future Enhancements)

1. **Event Persistence**
   - Add event store for event replay
   - Enable time-travel debugging
   - Support audit trail

2. **Metrics & Monitoring**
   - Subscribe to MarketDataErrorEvent for alerting
   - Track event processing latency
   - Monitor invariant violation rates

3. **Multiple Projectors**
   - Add projector for price history
   - Add projector for trade volume aggregation
   - Add projector for market depth analysis

4. **CQRS Pattern**
   - Separate command models (place orders)
   - Separate query models (read orderbooks)
   - Use events for synchronization

5. **Async Event Handlers**
   - Add async EventBus for heavy processing
   - Add event queue for persistence
   - Add dead letter queue for failed events
