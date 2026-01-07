# PolymarketWsAdapter

## Overview

WebSocket adapter для Polymarket с поддержкой reconnection loop prevention и event-driven архитектуры.

**Ключевые возможности:**
- ✅ Reconnection loop prevention с флагом `_isSubscribing`
- ✅ Явный метод `connect()` для подключения к WebSocket
- ✅ Event-driven архитектура с изоляцией ошибок
- ✅ Поддержка множественных подписок на маркеты
- ✅ Graceful shutdown с очисткой ресурсов

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│              PolymarketWsAdapter                        │
│  ┌────────────────────────────────────────────────┐    │
│  │ subscribedTokens: Set<string>                  │    │
│  │ _isConnected: boolean                          │    │
│  │ _isSubscribing: boolean ← Prevents loop!       │    │
│  │ _isDestroyed: boolean                          │    │
│  └────────────────────────────────────────────────┘    │
│                      │                                  │
│         ┌────────────┼────────────┐                     │
│         │            │            │                     │
│    ┌────▼────┐  ┌────▼────┐  ┌───▼──────┐             │
│    │ Router  │  │ Client  │  │ Registry │             │
│    └─────────┘  └─────────┘  └──────────┘             │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
           ┌───────────────────┐
           │ WebSocketManager  │
           └───────────────────┘
```

---

## Methods

### connect()

Подключается к WebSocket серверу.

**Signature:**
```typescript
public async connect(): Promise<void>
```

**Algorithm:**
1. Проверяет, что adapter не destroyed (`checkDestroyed()`)
2. Вызывает `client.connect()`
3. Устанавливает `_isConnected = true` при успешном подключении

**Example:**
```typescript
const adapter = new PolymarketWsAdapter(wsManager, logger);
await adapter.connect();
```

**Throws:**
- `Error` if adapter is destroyed

**Why needed?**
До добавления этого метода коллектор подключался напрямую к `wsManager`, минуя adapter. В результате adapter не знал о подключении и не устанавливал флаг `_isConnected`, что приводило к проблемам с подписками.

**Solution:**
Теперь подключение ВСЕГДА происходит через adapter:
```typescript
// ❌ БЫЛО (неправильно):
await wsManager.connect();
const adapter = new PolymarketWsAdapter(wsManager, logger);

// ✅ СТАЛО (правильно):
const adapter = new PolymarketWsAdapter(wsManager, logger);
await adapter.connect();
```

---

### subscribeToMarket(yesTokenId, noTokenId)

Подписывается на маркет (YES + NO токены). Использует reconnection с защитой от loops.

**Signature:**
```typescript
public async subscribeToMarket(
  yesTokenId: string,
  noTokenId: string
): Promise<void>
```

**Algorithm:**
1. Adds tokens to `subscribedTokens` set
2. Checks `_isConnected` flag
3. If connected, calls `sendAllSubscriptions()`
4. `sendAllSubscriptions()` checks `_isSubscribing` flag (loop prevention!)
5. If not subscribing, sets flag and reconnects
6. Resets flag in finally block

**Example:**
```typescript
const yesToken = '67704255197116168826604911233626301865010283966205730455742704536521111535950';
const noToken = '48331043336612883890405840694803087191347769269211396801222748316064917524501';

await adapter.subscribeToMarket(yesToken, noToken);
```

**Throws:**
- `Error` if adapter is destroyed
- `Error` if reconnection fails

---

### unsubscribeFromMarket(yesTokenId, noTokenId)

Отписывается от маркета.

**Signature:**
```typescript
public async unsubscribeFromMarket(
  yesTokenId: string,
  noTokenId: string
): Promise<void>
```

**Algorithm:**
1. Removes tokens from `subscribedTokens`
2. Calls `sendUnsubscribeMessage()` for each token
3. Does NOT reconnect (unlike subscribe)

**Example:**
```typescript
await adapter.unsubscribeFromMarket(yesToken, noToken);
```

---

## Reconnection Loop Prevention

### Problem

`sendAllSubscriptions()` calls `reconnectWithTimeout()`, which triggers `'connected'` event, which calls `resubscribeAll()`, which calls `sendAllSubscriptions()` again → **infinite loop!**

```
sendAllSubscriptions()
  → reconnectWithTimeout()
    → emit('connected')
      → resubscribeAll()
        → sendAllSubscriptions()
          → reconnectWithTimeout()
            → emit('connected')
              → ... ∞
```

### Solution

Используем флаг `_isSubscribing` с try/finally для предотвращения рекурсии:

```typescript
/**
 * Flag to prevent reconnection loop
 * Set to true while sendAllSubscriptions() is executing
 *
 * @remarks
 * Without this flag, sendAllSubscriptions() would call reconnectWithTimeout(),
 * which triggers 'connected' event, which calls resubscribeAll(),
 * which calls sendAllSubscriptions() again → infinite loop!
 */
private _isSubscribing = false;

/**
 * Sends all subscriptions to WebSocket
 *
 * @remarks
 * Algorithm:
 * 1. Check if already subscribing → return early (prevent loop)
 * 2. Set _isSubscribing = true
 * 3. Reconnect to WebSocket with timeout
 * 4. Send subscription message with all tokens
 * 5. Reset _isSubscribing = false in finally block
 *
 * @throws {Error} If reconnection fails
 */
private async sendAllSubscriptions(): Promise<void> {
  if (this.subscribedTokens.size === 0) {
    this.logger.debug('No tokens to subscribe to');
    return;
  }

  // Prevent reconnection loop
  if (this._isSubscribing) {
    this.logger.debug('Subscription already in progress, skipping');
    return;
  }

  this._isSubscribing = true;

  try {
    const tokens = Array.from(this.subscribedTokens);

    this.logger.info('Sending WebSocket subscription', {
      tokenCount: tokens.length,
      marketCount: tokens.length / 2,
    });

    // Polymarket requires reconnect for new subscriptions
    await this.client.reconnectWithTimeout(10000);

    // Send single subscription with all tokens
    const params: SubscribeParams = {
      assets_ids: tokens,
      type: 'market',
    };

    await this.client.subscribe('market', params);

    this.logger.info('Subscription sent successfully', {
      tokenCount: tokens.length,
    });
  } catch (error) {
    this.logger.error('Failed to send subscriptions', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    // ALWAYS reset flag (even on error)
    this._isSubscribing = false;
  }
}
```

**Key Points:**
1. ✅ Check `_isSubscribing` at the start → return early if true
2. ✅ Set `_isSubscribing = true` before reconnect
3. ✅ Use try/finally to ALWAYS reset flag (даже при ошибке!)
4. ✅ Prevents infinite loop from `reconnect → connected → resubscribe → reconnect`

**Why try/finally?**
Если ошибка произойдёт внутри `reconnectWithTimeout()` или `subscribe()`, флаг всё равно сбросится в `finally` блоке. Иначе флаг останется `true` навсегда и следующие подписки не будут работать.

---

## Event Handling

### Event Flow

```
User calls subscribeToMarket()
  → Adds tokens to subscribedTokens
  → Calls sendAllSubscriptions()
    → Sets _isSubscribing = true
    → Reconnects to WebSocket
      → Triggers 'connected' event
        → Calls resubscribeAll()
          → Calls sendAllSubscriptions()
            → Checks _isSubscribing (true)
            → Returns early (loop prevented!)
    → Sends subscription message
    → Resets _isSubscribing = false
```

### Error Isolation

Ошибки в callback'ах изолированы друг от друга:

```typescript
// If callback1 throws, callback2 and callback3 still execute
adapter.subscribeToOrderbook(tokenId, callback1); // throws
adapter.subscribeToOrderbook(tokenId, callback2); // ✅ still executes
adapter.subscribeToOrderbook(tokenId, callback3); // ✅ still executes
```

Это реализовано в `SubscriptionRegistry` через try/catch для каждого callback.

---

## Usage Examples

### Basic Usage

```typescript
import { PolymarketWsAdapter } from './infrastructure/polymarket/ws/PolymarketWsAdapter.js';
import { WebSocketManager } from './infrastructure/exchange/clients/WebSocketManager.js';

const wsManager = new WebSocketManager(config, logger);
const adapter = new PolymarketWsAdapter(wsManager, logger);

// 1. Connect
await adapter.connect();

// 2. Subscribe to market
await adapter.subscribeToMarket(yesTokenId, noTokenId);

// 3. Subscribe to orderbook updates
adapter.subscribeToOrderbook(yesTokenId, (orderbook) => {
  console.log('Orderbook update:', orderbook.bids.length, orderbook.asks.length);
});

// 4. Subscribe to trade updates
adapter.subscribeToTrades(yesTokenId, (trade) => {
  console.log('Trade:', trade.price.value, trade.quantity.value);
});

// 5. Graceful shutdown
await adapter.destroy();
```

### Data Collection Mode

```typescript
// Connect through adapter (so it knows connection state)
const adapter = new PolymarketWsAdapter(wsManager, logger);
await adapter.connect();

// Subscribe to raw events for data collection
wsManager.on('raw', (event: RawWsEvent) => {
  dataCollector.handleRawEvent(event);
});

// Subscribe to markets
for (const market of markets) {
  await adapter.subscribeToMarket(market.yesTokenId, market.noTokenId);
}
```

### Multiple Markets

```typescript
const markets = [
  { yes: 'token1', no: 'token2' },
  { yes: 'token3', no: 'token4' },
  { yes: 'token5', no: 'token6' },
];

// Subscribe to all markets
for (const market of markets) {
  await adapter.subscribeToMarket(market.yes, market.no);
}

// All subscriptions sent in ONE reconnect (efficient!)
```

---

## Testing

### Unit Tests

See: `tests/unit/infrastructure/polymarket/ws/PolymarketWsAdapter.integration.test.ts`

**Coverage:**
- ✅ connect() method
- ✅ Reconnection loop prevention
- ✅ Multiple subscriptions
- ✅ Error isolation
- ✅ Graceful shutdown

**Example tests:**
```typescript
describe('connect()', () => {
  it('should connect to WebSocket successfully', async () => {
    await adapter.connect();
    expect(mockWsManager.connect).toHaveBeenCalledTimes(1);
  });

  it('should throw if adapter is destroyed', async () => {
    await adapter.destroy();
    await expect(adapter.connect()).rejects.toThrow('destroyed');
  });
});

describe('reconnection loop prevention', () => {
  it('should not call sendAllSubscriptions recursively', async () => {
    await adapter.subscribeToMarket(yesToken, noToken);
    // Should call reconnect only once, not multiple times
    expect(mockReconnect).toHaveBeenCalledTimes(1);
  });

  it('should reset _isSubscribing flag on error', async () => {
    mockReconnect.mockRejectedValueOnce(new Error('fail'));
    await expect(
      adapter.subscribeToMarket(yesToken, noToken)
    ).rejects.toThrow();
    // Flag should be reset even on error
    expect((adapter as any)._isSubscribing).toBe(false);
  });
});
```

---

## Related Files

| File | Description |
|------|-------------|
| `PolymarketWsAdapter.ts` | Main adapter implementation |
| `PolymarketWsClient.ts` | Low-level WebSocket client |
| `PolymarketMessageRouter.ts` | Routes messages to handlers |
| `SubscriptionRegistry.ts` | Manages subscriptions and callbacks |
| `WebSocketManager.ts` | Generic WebSocket manager |

---

## Changelog

### January 2026 - Reconnection Loop Fix

**Problem:** Infinite reconnection loop when subscribing to markets

**Root Cause:** `sendAllSubscriptions()` → `reconnect()` → `'connected'` event → `resubscribeAll()` → `sendAllSubscriptions()` → ∞

**Solution:** Added `_isSubscribing` flag with try/finally pattern

**Files Changed:**
- `PolymarketWsAdapter.ts` (lines 115, 649-686)

**Tests Added:**
- `connect()` method tests (2 tests)
- Reconnection loop prevention tests (4 tests)

### January 2026 - Connect Method

**Problem:** Collector connected directly to wsManager, bypassing adapter

**Root Cause:** No explicit `connect()` method on adapter

**Solution:** Added `connect()` method that sets `_isConnected` flag

**Files Changed:**
- `PolymarketWsAdapter.ts` (lines 176-179)
- `collector.ts` (lines 171-181)

**Tests Added:**
- `connect()` method tests (2 tests)

---

## See Also

- [WebSocket Parsers](./websocket-parsers.md) - Parser functions for orderbook/trade data
- [Event Flow](../architecture/event-flow.md) - WebSocket event flow architecture
- [Data Collection](../services/data-collection.md) - Data collection service
