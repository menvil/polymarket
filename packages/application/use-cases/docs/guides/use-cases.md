# @polymarket/use-cases — Торговые Use Cases

## Обзор

Пакет реализует три application-layer use case для оркестрации доменных объектов:

| Use Case | Ответственность |
|----------|-----------------|
| `PlaceOrderUseCase` | Размещение нового торгового ордера |
| `ProcessFillUseCase` | Обработка исполнения ордера (fill) |
| `CancelOrderUseCase` | Отмена ордера с откатом резервации |

## Зависимости

```
PlaceOrderUseCase
  ├── IOrderRiskChecker (pre-trade risk)
  ├── OrderService → IOrderRepository
  ├── PortfolioService → IPortfolioStore
  ├── IExchangeClient
  ├── IEventBus
  └── IClock

ProcessFillUseCase
  ├── OrderService → IOrderRepository
  ├── PortfolioService → IPortfolioStore
  ├── LedgerService → Ledger
  ├── IProcessedFillRepository (idempotency guard)
  └── IEventBus

CancelOrderUseCase
  ├── OrderService → IOrderRepository
  ├── PortfolioService → IPortfolioStore
  ├── IExchangeClient
  └── IEventBus
```

## PlaceOrderUseCase

### Алгоритм (7 шагов)

1. **Риск-проверка** — `riskChecker.checkBeforeOrder()` (fail-fast)
2. **Создание Order** — `Order.create()` → PENDING
3. **Резервирование баланса** — `portfolioService.reserveForOrder(notional)`
4. **Отправка на биржу** — `exchangeClient.submitOrder()`
   - При ошибке биржи: откат резервации через `releaseReservation()`
5. **Принятие ордера** — `order.accept()` → OPEN
6. **Сохранение** — `orderRepo.save(acceptedOrder)`
7. **Публикация событий** — `eventBus.publishAll(order.pullEvents())`

### Пример использования

```typescript
const useCase = new PlaceOrderUseCase({
  riskChecker,
  orderService,
  portfolioService,
  orderRepo,
  exchangeClient,
  eventBus,
  clock,
  logger,
});

const result = await useCase.execute({
  orderId,
  accountId,
  asset,
  instrumentId,
  side: 'BUY',
  price: Price.of(new Decimal('0.65')),
  size: Quantity.of(new Decimal('100')),
  portfolio: currentPortfolio,
  openOrdersCount: 3,
  strategyId: 'my-strategy',
});

if (result.ok) {
  console.log('Order placed:', result.value); // orderId
}
```

## ProcessFillUseCase

### Алгоритм

1. **Idempotency guard** — `processedFillRepo.markIfNotExists(fill.id)` → skip if false
2. **Получить Order** — `orderRepo.get(fill.orderId)`
3. **Применить Fill к Order** — `orderService.applyFill(order, fillData)`
4. **Обновить Portfolio** — `portfolioService.applyFill(fill)`
   - BUY: `applyDebit(price×size)` + позиция увеличивается
   - SELL: `applyCredit(price×size)` + позиция уменьшается
5. **Записать в Ledger** — `ledgerService.recordFill(fill)`
6. **Публикация событий** — `eventBus.publishAll(order.pullEvents())`

### Idempotency

Повторный вызов с тем же `fill.id` безопасен — шаг 1 предотвращает двойную обработку.

## CancelOrderUseCase

### Алгоритм

1. **Получить Order** — `orderRepo.get(orderId)`
2. **Проверить статус** — если терминальный → `Ok(void)` (идемпотентность)
3. **Отменить Order** — `orderService.cancel(order, reason)` → CANCELED
4. **Снять резервацию** — `portfolioService.releaseReservation(remainingNotional)` (только BUY)
5. **Best-effort биржевая отмена** — `exchangeClient.cancelOrder(orderId)` (ошибка не прерывает)
6. **Публикация событий** — `eventBus.publishAll(order.pullEvents())`

### Best-effort отмена

Ошибка `exchangeClient.cancelOrder()` логируется, но не вызывает Err.
Reconciliation-процесс обрабатывает расхождения между локальным состоянием и биржей.

## Portfolio CAS

`IPortfolioStore.save(portfolio, expectedVersion)` использует Compare-And-Swap.
Portfolio не имеет поля `.version` — always pass `0`. In-memory реализация
всегда принимает сохранение.

## Позиции: SimplePosition

`SimplePosition` — упрощённая реализация `IPosition` без lot-based FIFO/LIFO.
Хранит агрегированные `quantity` и `averageEntryPrice`. Для lot-based tracking
используйте `@polymarket/position` в отдельном слое.
