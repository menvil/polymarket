# Order Entity

## Что такое Order

`Order` — неизменяемая доменная сущность, представляющая торговую заявку в системе предсказательных рынков Polymarket. Управляет всем жизненным циклом заявки через конечный автомат (FSM).

Пакет: `packages/domain/entities/order/`

## Жизненный цикл

```
              accept()                applyFill()
  PENDING ──────────────► OPEN ◄──────────────────────────────┐
     │                     │                                  │
     │ reject()            │ applyFill()      applyFill()     │
     ▼                     ▼                  (partial)       │
  REJECTED          PARTIALLY_FILLED ─────────────────────────┘
                          │
             cancel() / expire()
              ▼            ▼
          CANCELED       EXPIRED

  Терминальные: FILLED, CANCELED, REJECTED, EXPIRED
  Активные:     PENDING, OPEN, PARTIALLY_FILLED
```

### Возможные переходы

| Из                | Через             | В                           |
|-------------------|-------------------|-----------------------------|
| PENDING           | `accept()`        | OPEN                        |
| PENDING           | `reject(reason)`  | REJECTED                    |
| OPEN              | `applyFill(fill)` | PARTIALLY_FILLED или FILLED |
| OPEN              | `cancel(reason?)` | CANCELED                    |
| OPEN              | `expire()`        | EXPIRED                     |
| PARTIALLY_FILLED  | `applyFill(fill)` | PARTIALLY_FILLED или FILLED |
| PARTIALLY_FILLED  | `cancel(reason?)` | CANCELED                    |
| PARTIALLY_FILLED  | `expire()`        | EXPIRED                     |

Терминальные статусы (`FILLED`, `CANCELED`, `REJECTED`, `EXPIRED`) не могут перейти в другой статус.

## Структура пакета

```
src/
  Order.ts                           # Основная сущность (immutable entity)
  index.ts
  params/
    OrderParams.ts                   # Параметры для Order.create()
  types/
    OrderChange.ts                   # Discriminated union событий FSM
  value-objects/
    OrderFill.ts                     # Состояние исполнения заявки (VO)
    OrderStatus.ts                   # Статус + predicates + transitions
    CancelReason.ts                  # Enum причин отмены (8 значений)
    RejectReason.ts                  # Enum причин отклонения (14 значений)
    ExpireReason.ts                  # Enum причин истечения (6 значений)
  transitions/
    guards.ts                        # Функции-предикаты проверки переходов
    handlers.ts                      # Чистые функции выполнения переходов
    OrderFSM.ts                      # Dispatcher (switch по change.type)
  utils/
    calculations.ts                  # getNotional, getRemainingSize, getFillPercentage
    predicates.ts                    # isFilled, isOpen, isTerminal и др.
  view/
    OrderViewModel.ts                # Серализация Order → plain object
    OrderDeserializer.ts             # Десериализация JSON → Order
```

## Архитектура: FSM pipeline

Каждый вызов метода перехода (`.accept()`, `.applyFill()` и т.д.) проходит через единый pipeline:

```
Order.method() → OrderChange{type} → Order._transition()
  → OrderFSM.apply() → switch(change.type)
  → handler(orderData, ...) → guards → Result<OrderData, Error>
  → Order._reconstitute(orderData) → новый Order instance
```

**Ключевые принципы:**

1. **Immutability** — каждый переход возвращает НОВЫЙ `Order`. Оригинал не изменяется.
2. **Result pattern** — все переходы возвращают `Result<Order, ValidationError>`, никогда не бросают исключения.
3. **_reconstitute** — восстановление Order после FSM обходит повторную валидацию неизменяемых полей (`id`, `asset`, `price`, `size`, `timestamp`). Handlers меняют только `status`, `fill` и `reason`.
4. **Exhaustiveness check** — TypeScript гарантирует обработку всех типов `OrderChange` в `OrderFSM.switch`.

## Создание Order

```typescript
import { Order } from '@polymarket/order';
import { Price, Quantity, Timestamp } from '@polymarket/value-objects';
import { asOrderId, parseConditionId, parseOutcomeKey, KnownChainIds, KnownOnChainProtocols } from '@polymarket/ids';
import Decimal from 'decimal.js';

const result = Order.create({
  id: asOrderId('order-123')!,
  asset: {
    type: 'OUTCOME_TOKEN',
    conditionRef: {
      kind: 'ONCHAIN',
      protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
      chainId: KnownChainIds.POLYGON,
      conditionId: parseConditionId('0x' + 'a'.repeat(64))!,
    },
    outcomeKey: parseOutcomeKey('YES')!,
  },
  side: 'BUY',
  price: Price.of(new Decimal('0.65')),
  size: Quantity.of(new Decimal('100')),
  status: 'PENDING',
  timestamp: Timestamp.now(),
});

if (result.ok) {
  const order = result.value;
  console.log(order.status);   // 'PENDING'
  console.log(order.toString()); // 'Order[order-123]: BUY 100 @ 0.65 (PENDING)'
}
```

### Валидация при создании

`Order.create()` проверяет:

1. `id` — не пустая строка (max 256 chars) через `asOrderId()`
2. `asset` — присутствует
3. `price` — присутствует (инвариант `Price.of()` бросает при невалидном значении)
4. `size` — присутствует и `> 0`
5. `side` — `'BUY'` или `'SELL'`
6. `status` — валидный `OrderStatus`
7. `fill` — если указан, проходит через `OrderFill.create()`

## Методы Order

### FSM переходы

```typescript
// PENDING → OPEN
order.accept(): Result<Order, ValidationError>

// PENDING → REJECTED
order.reject(reason: string): Result<Order, ValidationError>
// reason обязателен и не пустой

// OPEN / PARTIALLY_FILLED → CANCELED
order.cancel(reason?: string): Result<Order, ValidationError>
// По умолчанию reason = 'User cancelled'

// OPEN / PARTIALLY_FILLED → EXPIRED
order.expire(): Result<Order, ValidationError>

// OPEN / PARTIALLY_FILLED → PARTIALLY_FILLED / FILLED
order.applyFill(fill: FillForOrder): Result<Order, ValidationError>
```

### Вычисления

```typescript
order.getNotional(): Decimal        // price × size
order.getRemainingSize(): Quantity   // size - filledSize
order.getFillPercentage(): Decimal   // (filledSize / size) × 100 → [0..100]
order.getTradeCount(): number        // количество fills
```

### Предикаты

```typescript
order.isFilled(): boolean
order.isOpen(): boolean
order.isPending(): boolean
order.isPartiallyFilled(): boolean
order.canCancel(): boolean           // status === OPEN || PARTIALLY_FILLED
order.canModify(): boolean           // status === OPEN
```

### Проверка fill (pre-validation)

```typescript
order.canAcceptFill(fill: FillForOrder): boolean
order.hasFill(fillId: FillId): boolean
```

`canAcceptFill()` проверяет без создания нового Order:
1. Статус `OPEN` или `PARTIALLY_FILLED`
2. `fill.asset === order.asset`
3. `fill.orderId === order.id`
4. `fill.side === order.side`
5. `fill.size > 0` и `<= remainingSize`
6. `fill.id` не является дубликатом

## OrderFill Value Object

Инкапсулирует состояние исполнения заявки.

```typescript
// Создание пустого fill (новая заявка)
const fill = OrderFill.empty();
fill.isEmpty();   // true

// Добавление fill (возвращает НОВЫЙ экземпляр)
const result = fill.addFill(
  fillSize,    // Quantity
  fillPrice,   // Price
  fillId,      // FillId
  orderSize    // Quantity (для валидации)
);

if (result.ok) {
  const updated = result.value;
  fill.isEmpty();                      // true — оригинал не изменился
  updated.getFilledSize()              // Quantity
  updated.getAverageFillPrice()        // Price | undefined
  updated.getFillIds()                 // readonly FillId[]
  updated.getTradeCount()              // number
  updated.hasFill(fillId)              // boolean
  updated.isFull(orderSize)            // boolean
  updated.isPartial(orderSize)         // boolean
  updated.getRemainingSize(orderSize)  // Quantity
  updated.getFillPercentage(orderSize) // Decimal (0-100)
}
```

### VWAP (Weighted Average Price)

При нескольких fills средняя цена вычисляется как взвешенная:

```
avgPrice = (filledSize₁ × price₁ + filledSize₂ × price₂) / (filledSize₁ + filledSize₂)
```

Пример: 40 @ 0.55 + 35 @ 0.60 + 25 @ 0.65 → VWAP = 0.5925

### Инварианты OrderFill

- `filledSize >= 0` (гарантируется `Quantity`)
- `filledSize <= orderSize`
- `averageFillPrice` обязателен если `filledSize > 0`
- `fillIds` не содержит дубликатов

## OrderChange — Events FSM

Discriminated union для type-safe dispatch:

```typescript
type OrderChange =
  | { type: 'ACCEPTED' }
  | { type: 'REJECTED'; reason: string }
  | { type: 'CANCELLED'; reason: string }
  | { type: 'EXPIRED' }
  | { type: 'FILL_APPLIED'; fill: FillForOrder }
```

`FillForOrder` — минимальный интерфейс Fill для Order:

```typescript
interface FillForOrder {
  readonly id: FillId;
  readonly orderId: OrderId;   // ОБЯЗАТЕЛЕН
  readonly asset: AssetId;
  readonly side: Side;
  readonly size: Quantity;
  readonly price: Price;
}
```

## Guards (transitions/guards.ts)

Чистые функции-предикаты для проверки допустимости перехода:

```typescript
canAccept(status): boolean          // PENDING → OPEN
canReject(status): boolean          // PENDING → REJECTED
canCancel(status): boolean          // OPEN/PARTIALLY_FILLED → CANCELED
canExpire(status): boolean          // OPEN/PARTIALLY_FILLED → EXPIRED
canApplyFill(status): boolean       // OPEN/PARTIALLY_FILLED → */FILLED
requiresReason(status): boolean     // только REJECTED требует reason

// Детальная проверка fill со всеми полями
canAcceptFillDetailed(params: FillValidationParams): boolean
```

Используются в UI (показать/скрыть кнопки), а также внутри handlers для валидации перехода.

## Handlers (transitions/handlers.ts)

Чистые функции, выполняющие переход состояния:

```typescript
handleAccepted(order: OrderData): Result<OrderData, Error>
handleRejected(order: OrderData, reason: string): Result<OrderData, Error>
handleCancelled(order: OrderData, reason: string): Result<OrderData, Error>
handleExpired(order: OrderData): Result<OrderData, Error>
handleFillApplied(order: OrderData, fill: FillForOrder): Result<OrderData, Error>
```

`OrderData` — plain object DTO (не `Order` instance). Handlers обновляют только `status`, `fill` и `reason`.

## Причины переходов

### RejectReason (14 значений)

```typescript
enum RejectReason {
  INVALID_PRICE, BELOW_MIN_SIZE, ABOVE_MAX_SIZE,
  MARKET_CLOSED, MARKET_HALTED, DUPLICATE_ORDER,
  UNKNOWN_INSTRUMENT, INSUFFICIENT_LIQUIDITY,
  SELF_TRADE_PREVENTION, RATE_LIMIT_EXCEEDED,
  VENUE_ERROR, INVALID_ACCOUNT,
  INSUFFICIENT_PERMISSIONS, INVALID_ORDER_TYPE
}
```

### CancelReason (8 значений)

```typescript
enum CancelReason {
  USER_REQUESTED, INSUFFICIENT_BALANCE, RISK_LIMIT_EXCEEDED,
  POSITION_CLOSED, STRATEGY_STOPPED, REPLACED_BY_NEW,
  MARKET_CONDITIONS_CHANGED, ADMINISTRATIVE
}
```

### ExpireReason (6 значений)

```typescript
enum ExpireReason {
  TIME_IN_FORCE, POST_ONLY_FAILED, IOC_NOT_FILLED,
  FOK_NOT_FILLED, MARKET_SESSION_END, CONDITIONAL_NOT_TRIGGERED
}
```

## Сериализация

### OrderViewModel.toJSON (Order → JSON)

```typescript
import { OrderViewModel } from '@polymarket/order';

const json = OrderViewModel.toJSON(order);
// {
//   id: 'order-123',
//   asset: 'OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0xaaa...:YES',  // assetIdToString()
//   side: 'BUY',
//   price: 0.65,
//   size: 100,
//   status: 'PARTIALLY_FILLED',
//   timestamp: '2024-01-01T00:00:00.000Z',
//   fill: { filledSize: 40, averageFillPrice: 0.55, fillIds: ['fill-1'] },
//   notional: 65,
//   remainingSize: 60,
//   fillPercentage: 40
// }

// Читаемый формат
const readable = OrderViewModel.toReadable(order);

// Краткий формат
const summary = OrderViewModel.toSummary(order);
```

### OrderDeserializer.fromJSON (JSON → Order)

```typescript
import { OrderDeserializer } from '@polymarket/order';

const result = OrderDeserializer.fromJSON(json);
if (result.ok) {
  const order = result.value;
}

// Массив
const results = OrderDeserializer.fromJSONArray(jsonArray);

// Partial (пропускает невалидные)
const orders = OrderDeserializer.fromJSONPartial(jsonArray);
```

**Важно**: `asset` в JSON сериализуется через `assetIdToString()` в формате
`OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0xaaa...:YES`, не как JSON-объект.

## Полный пример: жизненный цикл

```typescript
import { Order } from '@polymarket/order';
import { Price, Quantity, Timestamp } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

// 1. Создать PENDING заявку
const pending = Order.create({ ...params, status: 'PENDING' }).value!;

// 2. Биржа приняла
const open = pending.accept().value!;
console.log(open.status);          // 'OPEN'
console.log(open.fill.isEmpty());  // true

// 3. Частичное исполнение
const partial = open.applyFill({
  id: asFillId('fill-1')!,
  orderId: open.id,
  asset: open.asset,
  side: 'BUY',
  size: Quantity.of(new Decimal('40')),
  price: Price.of(new Decimal('0.55')),
}).value!;
console.log(partial.status);                              // 'PARTIALLY_FILLED'
console.log(partial.getRemainingSize().value().toNumber()); // 60

// 4. Полное исполнение
const filled = partial.applyFill({
  id: asFillId('fill-2')!,
  orderId: open.id,
  asset: open.asset,
  side: 'BUY',
  size: Quantity.of(new Decimal('60')),
  price: Price.of(new Decimal('0.60')),
}).value!;
console.log(filled.status);                                   // 'FILLED'
console.log(filled.fill.getAverageFillPrice()?.value().toNumber()); // VWAP
console.log(filled.getFillPercentage().toNumber());            // 100

// 5. Иммутабельность — оригиналы не изменились
console.log(pending.status);  // 'PENDING'
console.log(open.status);     // 'OPEN'
console.log(partial.status);  // 'PARTIALLY_FILLED'
```

## Тестовое покрытие

| Файл                  | Statements | Branches | Functions | Lines |
|-----------------------|-----------|----------|-----------|-------|
| **Все файлы**         | **94.89%** | **87.9%** | **94.23%** | **94.87%** |
| guards.ts             | 100%      | 100%     | 100%      | 100%  |
| handlers.ts           | 100%      | 100%     | 100%      | 100%  |
| calculations.ts       | 100%      | 100%     | 100%      | 100%  |
| predicates.ts         | 100%      | 100%     | 100%      | 100%  |
| CancelReason.ts       | 100%      | 100%     | 100%      | 100%  |
| RejectReason.ts       | 100%      | 100%     | 100%      | 100%  |
| ExpireReason.ts       | 100%      | 100%     | 100%      | 100%  |
| Order.ts              | 95.8%     | 87.5%    | 100%      | 95.8% |
| OrderFill.ts          | 92.4%     | 76.5%    | 94.1%     | 92.4% |
| OrderFSM.ts           | 75%       | 83.3%    | 50%       | 75%   |
| OrderDeserializer.ts  | 93.75%    | 82.6%    | 75%       | 93.5% |

**359 тестов** в 13 suite:
- Unit: guards, handlers, FSM, predicates, calculations
- Unit (value-objects): OrderFill, OrderStatus, CancelReason, RejectReason, ExpireReason
- Unit (view): OrderViewModel, OrderDeserializer
- Integration: OrderLifecycle (8 сценариев end-to-end)

## Связь с другими пакетами

```
@polymarket/value-objects  ← Price, Quantity, Timestamp, Side
@polymarket/ids            ← AssetId, OrderId, FillId, asOrderId, assetIdToString
@polymarket/result         ← Result, Ok, Err
@polymarket/errors         ← ValidationError
@polymarket/fill           ← Fill.applyFill() передаёт FillForOrder в Order
```

## Важные решения

### Почему `_reconstitute()` а не `create()` для восстановления

После FSM-перехода данные уже валидированы. Повторный вызов `Order.create()` добавил бы:
- Лишние аллокации
- Ложные точки отказа (например, `OrderFill.create()` может вернуть `Err` по причинам, не связанным с текущим переходом)

`_reconstitute()` — `private static`, вызывается ТОЛЬКО внутри `_transition()` после успешного FSM.

### Почему `handlers.ts` использует `Error` а не `ValidationError`

Ошибки из handlers немедленно перехватываются в `Order._transition()` и оборачиваются в `ValidationError`. `handlers.ts` — внутренний слой реализации, его ошибки никогда не утекают наружу. Использование базового `Error` упрощает handlers и избегает circular dependency с `@polymarket/errors`.

### Почему `asset: AssetId` а не отдельные `marketId` + `tokenId`

`AssetId` уже содержит оба идентификатора (`conditionRef` = рынок, `outcomeKey` = токен). Единый `AssetId` упрощает сравнение через `AssetIdHelpers.equals()` и соответствует архитектуре ids-пакета.
