# Bridge Adapters (Phase 8)

## Цель

Phase 8 соединяет инфраструктурный слой (Polymarket WS/REST) с application layer (handlers, use-cases).

## Расположение

`packages/infrastructure/polymarket/adapters/`

## Компоненты

### MarketDataFeedAdapter

**Ответственность:** Market channel — orderbook snapshots.

**Поток данных:**
```
IPolymarketWsEmitter.onOrderbookSnapshot(dto: WsOrderbookSnapshotDto)
  → WsRawLevel[] → PriceLevel[]    (конвертация VOs на границе инфраструктуры)
  → BookUpdateHandler.handleSnapshot(tokenId, bids, asks, timestamp)

IPolymarketWsEmitter.onReconnect()
  → BookUpdateHandler.onReconnect()   (инвалидирует кэш стаканов)
```

**Gap recovery:** При reconnect стаканы инвалидируются. Следующий WS snapshot восстанавливает состояние автоматически.

**Пример использования:**
```typescript
const adapter = new MarketDataFeedAdapter(wsEmitter, bookHandler, logger);
adapter.start();
// При завершении:
adapter.stop();
```

---

### UserEventFeedAdapter

**Ответственность:** User channel — fills + lifecycle ордеров.

**Поток данных:**
```
IPolymarketWsEmitter.onUserFill(dto: WsUserFillDto)
  → _mapFillDto(dto)                         (явный маппинг → Record<string, unknown>)
  → FillEventHandler.handle(raw, accountId)

IPolymarketWsEmitter.onOrderUpdate(dto: WsOrderUpdateDto)
  → _mapOrderUpdate(dto)                     (orderEventType → VenueOrderUpdate | null)
  → OrderUpdateHandler.handle(update)

IPolymarketWsEmitter.onReconnect()
  → предупреждение в лог (TODO Phase 9: trigger reconciliation)
```

**Маппинг orderEventType:**
| orderEventType | VenueOrderUpdate       |
|---------------|------------------------|
| PLACEMENT     | `{ type: 'ACCEPTED' }` |
| CANCELLATION  | `{ type: 'CANCELLED' }`|
| Остальные     | null (игнорируется)    |

**Пример использования:**
```typescript
// Перед start() активировать user channel:
await wsEmitter.subscribeUserChannel({ apiKey, secret, passphrase });

const adapter = new UserEventFeedAdapter(
  wsEmitter, fillHandler, orderHandler, accountId, logger
);
adapter.start();
```

---

### PolymarketExchangeClientAdapter

**Ответственность:** Реализует `IExchangeClient` (из `@polymarket/ports`) через `PolymarketExecutionAdapter`.

**Маппинг:**
```
domain VOs → raw числа/строки → PolymarketExecutionAdapter.postOrder()
throws → Err(ExchangeError)   (IExchangeClient не бросает)
```

**AssetId → tokenId:**
- `POLYMARKET_CTF_TOKEN`: используем `.tokenId` напрямую
- Другие типы: fallback через `assetIdToString()` + предупреждение

**Пример использования:**
```typescript
const exchangeClient: IExchangeClient = new PolymarketExchangeClientAdapter(
  executionAdapter,
  logger,
);
// В PlaceOrderUseCase:
const result = await exchangeClient.submitOrder({ asset, side, price, size });
```

---

## Порядок старта системы

```typescript
// 1. Recovery (до WS подписок)
await portfolioReplayService.replay(accountId);
await orderReconciler.reconcile(accountId);

// 2. Оркестраторы
fillOrchestrator.register();
riskOrchestrator.register();

// 3. Стратегии
await strategyRunner.start(myStrategy);

// 4. WS bridge (состояние готово)
marketDataFeedAdapter.start();
userEventFeedAdapter.start();
```

## Принципы

- **Одна ответственность**: MarketDataFeedAdapter ≠ UserEventFeedAdapter (разные каналы)
- **Явный маппинг**: без `as unknown as` — поля отображаются явно
- **Конвертация на границе**: строки → VOs происходит в адаптере, не в handlers
- **Stop безопасен**: повторный `stop()` идемпотентен
