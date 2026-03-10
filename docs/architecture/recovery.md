# Recovery & Reconciliation (Phase 9)

## Цель

Phase 9 гарантирует консистентность состояния системы на старте и после WS reconnect.

## Расположение

`packages/application/recovery/`
Пакет: `@polymarket/recovery`

## Компоненты

### PortfolioReplayService

**Ответственность:** Инициализация Portfolio в IPortfolioStore из текущего баланса venue.

**Поток данных:**
```
ICurrentBalanceProvider.getUsdcBalance(accountId)
  → Decimal (текущий USDC баланс)
  → Balance.withZeroReserved(Money.of(balance, 'USDC'), accountId, POLYMARKET)
  → Portfolio.create({ id, accountId, balance })
  → IPortfolioStore.save(portfolio, version=0)
```

**Идемпотентность:** Если Portfolio уже существует — skip без изменений.

**Почему не через историю fills:**
Текущий USDC-баланс из REST API уже отражает все исторические исполнения.
Восстановление через историю fills потребовало бы отдельного маппера
для REST-формата (отличается от WS-формата).

---

### OrderReconciler

**Ответственность:** Сверка локальных ордеров с venue — отмена закрытых в offline-период.

**Поток данных:**
```
IOrderRepository.getAll()
  → localOrders[]

IVenueOrderProvider.getOpenOrderIds()
  → venueOrderIds Set<string>

Для каждого localOrder НЕ в venueOrderIds:
  → OrderUpdateHandler.handle({ type: 'CANCELLED', orderId, reason })
  → Order.cancel() → IOrderRepository.save() → IEventBus.publishAll()
```

**Идемпотентность:** OrderUpdateHandler безопасно обрабатывает попытку отмены
уже отменённого ордера (Order FSM отклоняет, handler логирует и возвращает).

---

## Порты (интерфейсы для инфраструктуры)

| Порт | Метод | Реализация в инфра |
|------|-------|-------------------|
| `ICurrentBalanceProvider` | `getUsdcBalance(accountId)` | `PolymarketBalanceProvider` |
| `IVenueOrderProvider` | `getOpenOrderIds()` | `PolymarketOrderRestClient.getOpenOrders()` |

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
// onReconnect callback → orderReconciler.reconcile(accountId)
```

## Reconnect Flow

`UserEventFeedAdapter` принимает опциональный `onReconnect` callback:

```typescript
const adapter = new UserEventFeedAdapter(
  wsEmitter,
  fillHandler,
  orderHandler,
  accountId,
  logger,
  () => orderReconciler.reconcile(accountId),  // Phase 9
);
```

При WS reconnect → callback вызывается автоматически → OrderReconciler синхронизирует ордера.

## Принципы

- **Fail-safe**: ошибки recovery логируются, но не бросают исключения (система стартует в любом случае)
- **Идемпотентность**: повторный вызов replay() и reconcile() безопасен
- **Разделение ответственности**: Portfolio ← баланс; Orders ← venue-сверка
- **Dependency direction**: recovery → ports (application) ← infrastructure (реализации)
