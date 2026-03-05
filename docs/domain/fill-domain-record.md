# Fill — Domain Record исполнения ордера

## Что такое Fill

Fill — это **неизменяемая доменная запись** (Domain Record) факта исполнения нашего ордера на торговой площадке.

### Архитектурная классификация

Fill — не Entity в классическом DDD-смысле:

| Характеристика | Entity | Fill |
|---|---|---|
| Identity semantics | ✅ | ✅ (FillId) |
| Lifecycle | ✅ | ❌ |
| Мутации состояния | ✅ | ❌ |
| История | ✅ | ❌ |
| Поведение изменения | ✅ | ❌ |

Fill — это **immutable execution fact**: факт того, что конкретный ордер был исполнен. Создаётся один раз и не изменяется.

### Почему Fill не принадлежит Order aggregate

```
Реальная последовательность событий на бирже:

FILL → ORDER_UPDATE → ORDER_DONE   // нормально
ORDER_DONE → FILL                  // тоже бывает
FILL → FILL → ORDER_CANCELLED      // тоже бывает
```

Если Fill живёт внутри Order aggregate:
- Order должен существовать, чтобы принять Fill
- Fill может прийти раньше Order snapshot
- Fill lifecycle > Order lifecycle (fills хранятся месяцами, orders удаляются)

**Решение**: Fill — независимая запись. Она не принадлежит никакому агрегату.

## Реальные инварианты (только cross-field)

```typescript
// Инвариант 1: marketId не пустая строка
// (нет MarketId VO — строковый тип)
if (!params.marketId || params.marketId.trim().length === 0) → ошибка

// Инвариант 2: size > 0
// (Quantity VO допускает 0, Fill — нет)
if (!params.size.isPositive()) → ошибка
```

Всё остальное гарантируется typed params и VO:
- `FillId`, `OrderId`, `AccountId`, `VenueId`, `AssetId` — branded types
- `Price` — гарантирует > 0 при создании
- `Fee` — гарантирует >= 0
- `Timestamp` — валидирует при создании

## Экономические методы

```typescript
// BUY YES 50 @ 0.65, fee 0.02 USDC:

fill.getSignedQuantity()  // +50 (позиция выросла)
fill.getCashFlow()        // -32.50 (деньги ушли)
fill.getFeeFlow()         // -0.02 (комиссия)
fill.getNetCashFlow()     // -32.52 (итого)
fill.getNotional()        // 32.50 (всегда положительный)

// SELL YES 50 @ 0.65, fee 0.02 USDC:
fill.getSignedQuantity()  // -50
fill.getCashFlow()        // +32.50
fill.getFeeFlow()         // -0.02
fill.getNetCashFlow()     // +32.48
```

## Сериализация

Fill НЕ знает о persistence. Сериализация — ответственность FillMapper:

```typescript
// ✅ Правильно
const snapshot = FillMapper.toSnapshot(fill);

// ❌ Удалено
const snapshot = fill.toSnapshot(); // не существует
```

## Исправленные баги

### feeAsset bug в FillMapper

```typescript
// ❌ Было: fee asset = tokenId (YES/NO токен!)
const feeAssetQuantity = new AssetQuantity(tokenId, feeQuantity);

// ✅ Стало: fee asset = USDC (расчётная валюта Polymarket)
const feeAssetQuantity = new AssetQuantity(AssetIdHelpers.USDC, feeQuantity);
```

### Timestamp API

```typescript
// ❌ Не существует
Timestamp.fromEpochMs(ms)
fill.timestamp.value  // НЕ property

// ✅ Правильно
TimestampService.create(ms)  // возвращает Result<Timestamp, Error>
fill.timestamp.toNumber()    // number
fill.timestamp.value()       // Decimal (метод!)
```
