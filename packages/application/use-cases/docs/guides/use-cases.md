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

1. **Idempotency guard** — `processedFillRepo.begin(fill.id)` → `DUPLICATE`/`BUSY`/`RECONCILIATION_REQUIRED` → skip (Ok, no-op)
2. **Keyed mutex** — `keyedMutex.runExclusive([accountId, orderId, instrumentId], ...)` сериализует относительно `CancelOrderUseCase`
3. **Получить Order** — `orderRepo.get(fill.orderId)`
4. **Применить Fill к Order** — `order.applyFill(fillData)`
5. **Сохранить Order** — `orderStateStore.saveSync(updatedOrder)`
6. **Обновить Portfolio** — `portfolioService.applyFill(fill)`
   - BUY: `applyDebit(price×size)` + позиция увеличивается
   - SELL: `applyCredit(price×size)` + позиция уменьшается
   - Если падает ПОСЛЕ шага 5 (Order уже сохранён) → `markReconciliationRequired(fill.id, reason)`,
     НЕ `markFailed()` (см. Idempotency ниже)
7. **Записать в Ledger** — `ledgerService.recordFill(fill)`
8. **`markApplied(fill.id)`** — сразу после успешного применения к Order/Portfolio/Ledger, ДО публикации
9. **Публикация событий** — `eventBus.publishAll(order.pullEvents())` — ошибка публикации НЕ откатывает `markApplied` (см. `ProcessFillUseCase` doc, `EVENT_PUBLISH_FAILED`)

### Idempotency

Повторный вызов с тем же `fill.id` безопасен: `begin()` возвращает `DUPLICATE` (уже `APPLIED`)
или `BUSY` (конкурентно `PROCESSING`) — в обоих случаях Ok без повторной обработки.
После `FAILED`/`REVERTED` — retry разрешён (`begin()` вернёт `ACQUIRED, isRetry: true`).

После `RECONCILIATION_REQUIRED` — retry НЕ разрешён. Этот статус ставится, когда Order уже
сохранён (шаг 5), а Portfolio — нет: `Order.applyFill()` защищён от повторного применения того
же fillId, поэтому retry такого fillId гарантированно упрётся в ошибку "duplicate fill" и никогда
не восстановит Portfolio. `begin()` на `RECONCILIATION_REQUIRED` возвращает
`{ outcome: 'RECONCILIATION_REQUIRED' }` (не `ACQUIRED`), а `execute()` — `Ok` (no-op) с
error-логом на каждый повторный вызов, чтобы проблема оставалась видимой в мониторинге, но не
мутирует Order/Portfolio/Ledger повторно. Требуется ручная реконсиляция.

## CancelOrderUseCase

### Алгоритм

1. **Preflight** — `orderRepo.get(orderId)` (fail-fast, чтобы вычислить instrumentId для lock keys)
2. **Keyed mutex** — `keyedMutex.runExclusive([accountId, orderId, instrumentId], ...)` сериализует относительно `ProcessFillUseCase`
3. **Получить Order заново** (внутри lock — состояние могло измениться, пока ждали mutex)
4. **Проверить статус** — если терминальный → `Ok(void)` (идемпотентность)
5. **Проверить matched/in-flight fills** — `orderStateStore.hasMatchedFills(orderId)` или
   `hasInFlightFills(instrumentId)` → `Ok(void)` (skip, отмена заблокирована)
6. **Отменить Order** — `order.cancel(reason)` → CANCELED
7. **Снять резервацию** — `portfolioService.releaseReservation(remainingNotional)` (только BUY)
8. **Best-effort биржевая отмена** — `exchangeClient.cancelOrder(orderId)` (ошибка не прерывает)
9. **Публикация событий** — `eventBus.publishAll(order.pullEvents())`

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
