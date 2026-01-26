# Order FSM (Finite State Machine)

Документация по жизненному циклу Order entity и state transitions.

## Обзор

Order entity использует паттерн FSM для управления жизненным циклом заявок.
Все изменения состояния осуществляются через явные методы transitions,
которые возвращают Result<Order, Error> для безопасной обработки ошибок.

## Диаграмма состояний

```
                    ┌─────────┐
                    │ PENDING │  (создана, ждёт подтверждения биржи)
                    └────┬────┘
                         │
           ┌─────────────┴────────────┐
           │                          │
      accept()                   reject(reason)
           │                          │
           ▼                          ▼
      ┌────────┐              ┌──────────┐
      │  OPEN  │              │ REJECTED │ (terminal)
      └───┬────┘              └──────────┘
          │
          │ applyTrade(trade)
          │
          ├──────────────┬──────────────┐
          │              │              │
          ▼              ▼              ▼
   ┌──────────────┐   ┌────────┐   ┌─────────┐
   │ PARTIALLY_   │   │ FILLED │   │ EXPIRED │ (terminal)
   │   FILLED     │   └────────┘   └─────────┘
   └──────┬───────┘   (terminal)
          │
          │ applyTrade(trade)
          │
          ├──────────────┬──────────────┐
          │              │              │
          ▼              ▼              ▼
      ┌────────┐   ┌─────────┐   ┌─────────┐
      │ FILLED │   │ EXPIRED │   │CANCELED │
      └────────┘   └─────────┘   └─────────┘
      (terminal)   (terminal)    (terminal)

Легенда:
- PENDING: заявка создана, ждёт подтверждения
- OPEN: заявка подтверждена, размещена в orderbook
- PARTIALLY_FILLED: частично исполнена
- FILLED: полностью исполнена
- CANCELED: отменена пользователем
- REJECTED: отклонена биржей
- EXPIRED: истекла по времени
```

## Статусы

### PENDING
- **Описание**: Заявка создана, ждёт подтверждения биржей
- **Возможные переходы**:
  - `accept()` → OPEN
  - `reject(reason)` → REJECTED
- **Нельзя**: cancel(), expire(), applyTrade()

### OPEN
- **Описание**: Заявка подтверждена и размещена в orderbook
- **Возможные переходы**:
  - `applyTrade(trade)` → PARTIALLY_FILLED или FILLED
  - `cancel(reason?)` → CANCELED
  - `expire()` → EXPIRED
- **Характеристики**:
  - `filledSize` = undefined или 0
  - Видима другим участникам рынка

### PARTIALLY_FILLED
- **Описание**: Заявка частично исполнена
- **Возможные переходы**:
  - `applyTrade(trade)` → PARTIALLY_FILLED или FILLED
  - `cancel(reason?)` → CANCELED
  - `expire()` → EXPIRED
- **Характеристики**:
  - `0 < filledSize < size`
  - `averageFillPrice` вычислен как weighted average
  - `tradeIds` содержит IDs всех применённых trades

### FILLED
- **Описание**: Заявка полностью исполнена (терминальный статус)
- **Возможные переходы**: нет
- **Характеристики**:
  - `filledSize === size`
  - `remainingSize === 0`

### CANCELED
- **Описание**: Заявка отменена пользователем (терминальный статус)
- **Возможные переходы**: нет
- **Характеристики**:
  - `reason` содержит причину отмены
  - `filledSize` сохраняется (если была частично исполнена)

### REJECTED
- **Описание**: Заявка отклонена биржей (терминальный статус)
- **Возможные переходы**: нет
- **Характеристики**:
  - `reason` содержит причину отклонения
  - `filledSize` = undefined (не было исполнения)

### EXPIRED
- **Описание**: Заявка истекла по времени (терминальный статус)
- **Возможные переходы**: нет
- **Характеристики**:
  - `reason` = "Expired"
  - `filledSize` сохраняется (если была частично исполнена)

## Публичные методы

### accept(): Result<Order, OrderValidationError>

Принять заявку (биржей).

**Переход**: PENDING → OPEN

**Валидация**:
- Текущий статус должен быть PENDING

**Пример**:
```typescript
const pendingOrder = unwrap(Order.create({ ...params, status: 'PENDING' }));
const result = pendingOrder.accept();

if (result.ok) {
  console.log(result.value.status); // 'OPEN'
}
```

### reject(reason: string): Result<Order, OrderValidationError>

Отклонить заявку (биржей).

**Переход**: PENDING → REJECTED

**Валидация**:
- Текущий статус должен быть PENDING
- `reason` не должен быть пустой строкой

**Причины отклонения**:
- "Insufficient balance"
- "Invalid price"
- "Market closed"
- "Risk limit exceeded"

**Пример**:
```typescript
const pendingOrder = unwrap(Order.create({ ...params, status: 'PENDING' }));
const result = pendingOrder.reject('Insufficient balance');

if (result.ok) {
  console.log(result.value.status); // 'REJECTED'
  console.log(result.value.reason); // 'Insufficient balance'
}
```

### cancel(reason?: string): Result<Order, OrderValidationError>

Отменить заявку (пользователем).

**Переход**: OPEN или PARTIALLY_FILLED → CANCELED

**Валидация**:
- Текущий статус должен быть OPEN или PARTIALLY_FILLED

**Параметры**:
- `reason` (опционально): причина отмены, по умолчанию "User cancelled"

**Пример**:
```typescript
const openOrder = unwrap(Order.create({ ...params, status: 'OPEN' }));
const result = openOrder.cancel('Changed strategy');

if (result.ok) {
  console.log(result.value.status); // 'CANCELED'
  console.log(result.value.reason); // 'Changed strategy'
}
```

### expire(): Result<Order, OrderValidationError>

Истечь заявке по времени.

**Переход**: OPEN или PARTIALLY_FILLED → EXPIRED

**Валидация**:
- Текущий статус должен быть OPEN или PARTIALLY_FILLED

**Пример**:
```typescript
const openOrder = unwrap(Order.create({ ...params, status: 'OPEN' }));
const result = openOrder.expire();

if (result.ok) {
  console.log(result.value.status); // 'EXPIRED'
  console.log(result.value.reason); // 'Expired'
}
```

### applyTrade(trade: Trade): Result<Order, OrderValidationError>

Применить сделку (trade) к заявке.

**Переходы**:
- OPEN → PARTIALLY_FILLED (если `remainingSize > 0`)
- OPEN или PARTIALLY_FILLED → FILLED (если `remainingSize === 0`)

**Валидация (7 проверок)**:
1. Статус должен быть OPEN или PARTIALLY_FILLED
2. `trade.marketId === order.marketId`
3. `trade.tokenId === order.tokenId`
4. `trade.side === order.side`
5. `trade.orderId === order.id` (или undefined для FIFO)
6. `trade.size <= remainingSize`
7. Нет дубликатов `trade.id` в `tradeIds`

**Обновление**:
- `filledSize` += trade.size
- `averageFillPrice` = weighted average по всем trades
- `tradeIds.push(trade.id)`
- `status` → PARTIALLY_FILLED или FILLED

**Weighted Average Calculation**:
```
newAvg = (currentFilledSize × currentAvg + tradeSize × tradePrice)
         / (currentFilledSize + tradeSize)
```

**Пример (single fill)**:
```typescript
const openOrder = unwrap(Order.create({
  ...params,
  status: 'OPEN',
  size: Quantity(100)
}));

const trade = unwrap(Trade.create({
  ...tradeParams,
  orderId: openOrder.id,
  size: Quantity(30)
}));

const result = openOrder.applyTrade(trade);

if (result.ok) {
  console.log(result.value.status); // 'PARTIALLY_FILLED'
  console.log(result.value.filledSize.value); // 30
  console.log(result.value.getRemainingSize().value); // 70
}
```

**Пример (multiple fills)**:
```typescript
const order = unwrap(Order.create({ ...params, size: Quantity(100) }));

// First fill: 40 @ 0.64
const trade1 = unwrap(Trade.create({
  ...params,
  price: Price(0.64),
  size: Quantity(40)
}));
const after1 = unwrap(order.applyTrade(trade1));
// averageFillPrice = 0.64

// Second fill: 60 @ 0.66
const trade2 = unwrap(Trade.create({
  ...params,
  price: Price(0.66),
  size: Quantity(60)
}));
const after2 = unwrap(after1.applyTrade(trade2));
// averageFillPrice = (40×0.64 + 60×0.66) / 100 = 0.652
// status = 'FILLED'
```

**FIFO Matching**:
```typescript
// Trade без orderId (FIFO matching на бирже)
const trade = unwrap(Trade.create({
  ...params,
  // orderId: undefined (FIFO)
  size: Quantity(30)
}));

const result = order.applyTrade(trade);
// Работает для любой заявки с matching marketId/tokenId/side
```

## Helper Methods

### getTradeCount(): number

Возвращает количество trades, заполнивших заявку.

**Пример**:
```typescript
const order = unwrap(Order.create({ ...params, tradeIds: ['t1', 't2', 't3'] }));
console.log(order.getTradeCount()); // 3
```

### hasTrade(tradeId: string): boolean

Проверяет, был ли применён конкретный trade.

**Использование**:
- Предотвращение дубликатов
- Reconciliation с external trades
- Аудит исполнения

**Пример**:
```typescript
const order = unwrap(Order.create({ ...params, tradeIds: ['t1', 't2'] }));
console.log(order.hasTrade('t1')); // true
console.log(order.hasTrade('t3')); // false
```

### canAcceptTrade(trade: Trade): boolean

Pre-validation перед `applyTrade()` без создания нового Order.

**Проверки** (subset от _applyTrade):
1. Статус OPEN или PARTIALLY_FILLED
2. trade.marketId === this.marketId
3. trade.tokenId === this.tokenId
4. trade.side === this.side
5. trade.orderId === this.id (или undefined)
6. trade.size <= remainingSize
7. Нет дубликата trade.id

**Пример**:
```typescript
const order = unwrap(Order.create({ ...params, status: 'OPEN' }));
const trade = unwrap(Trade.create({ ...tradeParams, orderId: order.id }));

if (order.canAcceptTrade(trade)) {
  const result = order.applyTrade(trade);
  // result.ok гарантированно true (если не было concurrent changes)
}
```

### canCancel(): boolean

Проверяет, может ли заявка быть отменена.

**Правило**: Только OPEN или PARTIALLY_FILLED могут быть отменены.

**Примечание**: PENDING заявки НЕ могут быть отменены напрямую -
они должны быть либо accepted (→ OPEN) либо rejected (→ REJECTED) биржей.

**Пример**:
```typescript
const pendingOrder = unwrap(Order.create({ ...params, status: 'PENDING' }));
console.log(pendingOrder.canCancel()); // false

const openOrder = unwrap(Order.create({ ...params, status: 'OPEN' }));
console.log(openOrder.canCancel()); // true

const filledOrder = unwrap(Order.create({ ...params, status: 'FILLED' }));
console.log(filledOrder.canCancel()); // false
```

## Complete Lifecycle Examples

### Успешное полное исполнение

```typescript
// 1. Создание PENDING заявки
const pending = unwrap(Order.create({
  id: 'order-1',
  marketId: 'market-1',
  tokenId: 'token-yes',
  side: 'BUY',
  price: Price(0.65),
  size: Quantity(100),
  status: 'PENDING',
  timestamp: new Date()
}));

// 2. Биржа принимает → OPEN
const open = unwrap(pending.accept());
console.log(open.status); // 'OPEN'

// 3. Первый частичный fill → PARTIALLY_FILLED
const trade1 = unwrap(Trade.create({
  id: 'trade-1',
  marketId: 'market-1',
  tokenId: 'token-yes',
  price: Price(0.64),
  size: Quantity(40),
  side: 'BUY',
  timestamp: new Date(),
  transactionHash: '0xabc1',
  orderId: 'order-1'
}));

const partial = unwrap(open.applyTrade(trade1));
console.log(partial.status); // 'PARTIALLY_FILLED'
console.log(partial.filledSize.value); // 40
console.log(partial.getRemainingSize().value); // 60

// 4. Второй fill → FILLED
const trade2 = unwrap(Trade.create({
  id: 'trade-2',
  marketId: 'market-1',
  tokenId: 'token-yes',
  price: Price(0.66),
  size: Quantity(60),
  side: 'BUY',
  timestamp: new Date(),
  transactionHash: '0xabc2',
  orderId: 'order-1'
}));

const filled = unwrap(partial.applyTrade(trade2));
console.log(filled.status); // 'FILLED'
console.log(filled.filledSize.value); // 100
console.log(filled.getRemainingSize().value); // 0
console.log(filled.averageFillPrice.value); // 0.652
```

### Отмена частично исполненной заявки

```typescript
// Создание и подтверждение
const pending = unwrap(Order.create({ ...params, status: 'PENDING' }));
const open = unwrap(pending.accept());

// Частичное исполнение
const trade = unwrap(Trade.create({ ...tradeParams, size: Quantity(30) }));
const partial = unwrap(open.applyTrade(trade));

console.log(partial.status); // 'PARTIALLY_FILLED'
console.log(partial.filledSize.value); // 30

// Пользователь отменяет остаток
const canceled = unwrap(partial.cancel('User changed mind'));

console.log(canceled.status); // 'CANCELED'
console.log(canceled.filledSize.value); // 30 (сохраняется!)
console.log(canceled.reason); // 'User changed mind'
console.log(canceled.canCancel()); // false (нельзя отменить дважды)
```

### Отклонение биржей

```typescript
const pending = unwrap(Order.create({ ...params, status: 'PENDING' }));

// Биржа отклоняет (недостаточный баланс)
const rejected = unwrap(pending.reject('Insufficient balance'));

console.log(rejected.status); // 'REJECTED'
console.log(rejected.reason); // 'Insufficient balance'
console.log(rejected.filledSize); // undefined
```

## Error Handling

Все методы transitions возвращают `Result<Order, OrderValidationError>`.

**Примеры ошибок**:

```typescript
// Неправильный статус для accept()
const open = unwrap(Order.create({ ...params, status: 'OPEN' }));
const result = open.accept();
// result.ok === false
// result.error.message === "Cannot accept order with status OPEN..."

// Пустая причина для reject()
const pending = unwrap(Order.create({ ...params, status: 'PENDING' }));
const result = pending.reject('');
// result.ok === false
// result.error.message === "Reject reason must be a non-empty string"

// Mismatch trade.marketId
const order = unwrap(Order.create({ ...params, marketId: 'market-1' }));
const trade = unwrap(Trade.create({ ...params, marketId: 'market-2' }));
const result = order.applyTrade(trade);
// result.ok === false
// result.error.message === "Trade marketId (market-2) does not match..."

// Trade size превышает remaining
const order = unwrap(Order.create({ ...params, size: Quantity(100) }));
const trade = unwrap(Trade.create({ ...params, size: Quantity(150) }));
const result = order.applyTrade(trade);
// result.ok === false
// result.error.message === "Trade size (150) exceeds remaining order size (100)"
```

## Архитектурные решения

### Почему hybrid approach (public + private)?

- **Public методы** (`accept()`, `reject()`, etc.) - чистый API для клиентов
- **Private `_transition()`** - централизованная логика FSM
- **OrderChange types** - type-safe discriminated union для pattern matching

Это позволяет:
- Явный API без magic strings
- Единую точку валидации transitions
- Легкое расширение (новые типы OrderChange)

### Почему только applyTrade(), а не отдельный fill()?

**Решение**: Fill всегда происходит из-за trade, а не сам по себе.

На Polymarket и других биржах:
- Fills - это результат matching trades
- Нет "магического" fill без corresponding trade
- Trade ID нужен для reconciliation и audit trail

Поэтому `applyTrade(trade)` - единственный способ fill заявки.

### Почему tradeIds денормализация?

**Dual storage**:
- Global list: `Trade[]` со всеми trades на рынке
- Order: `tradeIds: string[]` для быстрого доступа

**Преимущества**:
- O(1) проверка `hasTrade(id)`
- Не нужен join для получения trades конкретной заявки
- Reconciliation с Polymarket WebSocket events

**Trade-off**: Дополнительная память, но значительный gain по performance.

### Почему FIFO support (orderId undefined)?

**Polymarket WebSocket API**:
```json
{
  "taker_order_id": "order-abc",
  "maker_orders": [
    { "order_id": "order-123", "size": "30" },
    { "order_id": "order-456", "size": "20" }
  ]
}
```

При FIFO matching:
- Trade может заполнить **несколько** maker orders
- `trade.orderId` может быть undefined
- Matching по marketId + tokenId + side

Поэтому validation разрешает `trade.orderId === undefined`.

## Best Practices

### 1. Всегда проверяй Result

```typescript
// ❌ Плохо
const order = pending.accept().value; // Может упасть!

// ✅ Хорошо
const result = pending.accept();
if (result.ok) {
  const order = result.value;
  // Безопасно использовать order
} else {
  console.error(result.error.message);
}

// ✅ Ещё лучше с unwrap (для тестов)
const order = unwrap(pending.accept());
```

### 2. Используй helper methods для pre-validation

```typescript
// ❌ Плохо - пробуем apply и обрабатываем ошибку
const result = order.applyTrade(trade);
if (!result.ok) {
  // Handle error...
}

// ✅ Хорошо - проверяем заранее
if (order.canAcceptTrade(trade)) {
  const result = order.applyTrade(trade);
  // result.ok гарантированно true
}
```

### 3. Сохраняй immutability

```typescript
// ❌ Плохо - пытаемся мутировать
order.status = 'OPEN'; // Ошибка компиляции (readonly)

// ✅ Хорошо - создаём новый объект
const openOrder = unwrap(order.accept());
// Оригинальный order не изменён
```

### 4. Логируй transitions для audit

```typescript
const result = order.accept();
if (result.ok) {
  logger.info('Order accepted', {
    orderId: order.id,
    newStatus: result.value.status,
    timestamp: new Date()
  });
}
```

### 5. Обрабатывай partial fills корректно

```typescript
// После partial fill проверяй canCancel
if (order.canCancel()) {
  // Пользователь может отменить остаток
  const result = order.cancel();
}

// Сохраняй filledSize даже после cancel
const canceled = unwrap(partial.cancel());
console.log(canceled.filledSize.value); // 30 (сохраняется!)
```

## Testing

См. `__tests__/unit/OrderFSM.test.ts` для comprehensive test suite (37 тестов):
- Accept transitions (2)
- Reject transitions (3)
- Cancel transitions (5)
- Expire transitions (3)
- ApplyTrade transitions (10)
- Helper methods (4)
- Complete lifecycle scenarios (2)

**Запуск**:
```bash
npm test OrderFSM
```
