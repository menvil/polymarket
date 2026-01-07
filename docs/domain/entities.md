# Доменные сущности (Domain Entities)

## Обзор

Доменные сущности — это объекты с уникальной идентичностью, которые представляют ключевые концепции предметной области трейдинг-бота. Все сущности **immutable** (неизменяемые) — любые изменения создают новый экземпляр.

## Архитектурные принципы

### 1. Immutability (Неизменяемость)
Все сущности неизменяемы. Это обеспечивает:
- **Thread-safety**: безопасность в многопоточной среде
- **Предсказуемость**: состояние не меняется неожиданно
- **Отладка**: легко отследить историю изменений
- **Тестируемость**: нет скрытых side effects

```typescript
// ❌ Плохо - изменение свойства
order.status = 'FILLED';

// ✅ Хорошо - создание нового экземпляра
const filledOrder = order.withStatus('FILLED');
```

### 2. Инкапсуляция бизнес-логики
Сущности содержат бизнес-правила и валидацию:

```typescript
// Бизнес-правило: нельзя отменить исполненный ордер
if (order.canCancel()) {
  const cancelled = order.withStatus('CANCELED');
}
```

### 3. Use of Value Objects
Сущности используют Value Objects для типобезопасности:

```typescript
// Вместо примитивов
const order = new Order(
  price: Price.fromNumber(0.65),  // не просто number
  quantity: Quantity.fromNumber(100)  // не просто number
);
```

---

## Сущности

### 1. Market

**Файл**: `src/domain/entities/Market.ts`

Представляет рынок прогнозирования (prediction market).

#### Свойства

| Свойство | Тип | Описание |
|----------|-----|----------|
| `id` | `string` | Уникальный идентификатор (conditionId) |
| `question` | `string` | Вопрос рынка |
| `yesTokenId` | `string` | ID токена YES |
| `noTokenId` | `string` | ID токена NO |
| `expirationDate` | `Date` | Дата окончания рынка |
| `status` | `MarketStatus` | Статус: ACTIVE, CLOSED, RESOLVED |
| `resolvedOutcome` | `MarketOutcome` | Результат (YES, NO, null) |

#### Ключевые методы

```typescript
// Проверка состояния
market.isActive(): boolean
market.isExpired(): boolean
market.isResolved(): boolean
market.canTrade(): boolean

// Время до истечения
market.timeToExpiry(): number  // milliseconds

// Получить токен
market.getTokenId(outcome: 'YES' | 'NO'): string
```

#### Пример использования

```typescript
const market = Market.create({
  id: '0x123...',
  question: 'Will BTC reach $100k by end of 2024?',
  yesTokenId: '0xabc...',
  noTokenId: '0xdef...',
  expirationDate: new Date('2024-12-31'),
  status: 'ACTIVE'
});

if (market.canTrade()) {
  const hoursLeft = market.timeToExpiry() / (1000 * 60 * 60);
  console.log(`Market open for ${hoursLeft.toFixed(1)} hours`);
}
```

---

### 2. Order

**Файл**: `src/domain/entities/Order.ts`

Представляет торговый ордер (заявку).

#### Свойства

| Свойство | Тип | Описание |
|----------|-----|----------|
| `id` | `string` | Уникальный идентификатор |
| `tokenId` | `string` | ID токена |
| `side` | `OrderSide` | BUY или SELL |
| `price` | `Price` | Цена ордера |
| `size` | `Quantity` | Размер ордера |
| `status` | `OrderStatus` | PENDING, OPEN, FILLED, CANCELED, REJECTED |
| `timestamp` | `Date` | Время создания |
| `filledSize` | `Quantity?` | Исполненный размер |
| `averageFillPrice` | `Price?` | Средняя цена исполнения |

#### Lifecycle (Жизненный цикл)

```
PENDING → OPEN → FILLED
            ↓
         CANCELED
            ↓
         REJECTED
```

#### Ключевые методы

```typescript
// Проверка состояния
order.isFilled(): boolean
order.isOpen(): boolean
order.isPending(): boolean
order.canCancel(): boolean
order.isPartiallyFilled(): boolean

// Расчёты
order.getNotional(): number  // price * size
order.getRemainingSize(): Quantity
order.getFillPercentage(): number  // 0-100

// Мутации (возвращают новый Order)
order.withStatus(status: OrderStatus): Order
order.withFill(filledSize: Quantity, avgPrice: Price): Order
```

#### Бизнес-правила

1. **Валидация размера**: `size` должен быть положительным
2. **Валидация fill**: `filledSize ≤ size`
3. **Отмена**: можно отменить только PENDING или OPEN ордера
4. **Average fill price**: обязателен если `filledSize > 0`

#### Пример использования

```typescript
const order = Order.create({
  id: '0x123',
  tokenId: 'token-yes',
  side: 'BUY',
  price: Price.fromNumber(0.55),
  size: Quantity.fromNumber(100),
  status: 'PENDING',
  timestamp: new Date()
});

// Ордер исполнился
const filled = order.withFill(
  Quantity.fromNumber(100),
  Price.fromNumber(0.55)
);

console.log(filled.isFilled()); // true
console.log(filled.getNotional()); // 55.0
```

---

### 3. Position

**Файл**: `src/domain/entities/Position.ts`

Представляет агрегированную позицию с учётом FIFO (First In, First Out).

#### Свойства

| Свойство | Тип | Описание |
|----------|-----|----------|
| `tokenId` | `string` | ID токена/рынка |
| `side` | `Side` | YES или NO |
| `totalQuantity` | `Quantity` | Общее количество |
| `averageEntryPrice` | `Price` | Средняя цена входа |
| `lots` | `PositionLot[]` | Массив лотов (FIFO) |
| `unrealizedPnL` | `Money` | Нереализованный P&L |

#### Алгоритм FIFO

**Почему FIFO?**
- Требуется в большинстве налоговых юрисдикций
- Обеспечивает точный расчёт cost basis
- Упрощает бухгалтерский учёт
- Индустриальный стандарт

**Как работает:**
1. При добавлении лота: append в конец массива
2. При закрытии позиции: используем **старейшие** лоты первыми
3. Средняя цена = weighted average всех лотов

```typescript
// Лоты в порядке от старого к новому
lots = [
  { id: 'lot-1', qty: 10, price: 0.60, date: '2024-01-01' },  // ← закрываем первым
  { id: 'lot-2', qty:  5, price: 0.70, date: '2024-01-02' },
  { id: 'lot-3', qty:  8, price: 0.65, date: '2024-01-03' }
]

// При закрытии 12 shares:
// 1. Закрываем lot-1 полностью (10 shares)
// 2. Закрываем 2 shares из lot-2
```

#### Ключевые методы

```typescript
// Создание
Position.empty(tokenId: string, side: Side): Position

// Управление лотами
position.addLot(lot: PositionLot): Position
position.removeLot(lotId: string, quantity: Quantity): Position

// P&L расчёты
position.calculateUnrealizedPnL(currentPrice: Price): Money
position.getTotalCost(): Money

// Проверки
position.isEmpty(): boolean
position.getLotCount(): number
position.getOldestLot(): PositionLot | undefined
```

#### Пример использования

```typescript
const position = Position.empty('token-123', 'YES');

// Добавляем первый лот
const lot1 = new PositionLot(
  'lot-1',
  'token-123',
  'YES',
  Quantity.fromNumber(10),
  Price.fromNumber(0.60),
  new Date()
);
const pos1 = position.addLot(lot1);
console.log(pos1.averageEntryPrice.value); // 0.60

// Добавляем второй лот
const lot2 = new PositionLot(
  'lot-2',
  'token-123',
  'YES',
  Quantity.fromNumber(5),
  Price.fromNumber(0.70),
  new Date()
);
const pos2 = pos1.addLot(lot2);
console.log(pos2.totalQuantity.value); // 15
console.log(pos2.averageEntryPrice.value); // 0.6333 (weighted avg)

// Вычисляем P&L
const currentPrice = Price.fromNumber(0.75);
const pnl = pos2.calculateUnrealizedPnL(currentPrice);
// lot-1: (0.75 - 0.60) * 10 = 1.50
// lot-2: (0.75 - 0.70) *  5 = 0.25
// total: 1.75
console.log(pnl.amount); // 1.75

// Закрываем 8 shares (FIFO - берём из lot-1)
const pos3 = pos2.removeLot('lot-1', Quantity.fromNumber(8));
console.log(pos3.totalQuantity.value); // 7 (2 from lot-1, 5 from lot-2)
```

---

### 4. PositionLot

**Файл**: `src/domain/entities/PositionLot.ts`

Представляет один лот для FIFO учёта.

#### Свойства

| Свойство | Тип | Описание |
|----------|-----|----------|
| `lotId` | `string` | Уникальный идентификатор лота |
| `tokenId` | `string` | ID токена/рынка |
| `side` | `Side` | YES или NO |
| `quantity` | `Quantity` | Количество shares |
| `entryPrice` | `Price` | Цена входа |
| `timestamp` | `Date` | Время создания лота |

#### Ключевые методы

```typescript
// Расчёты
lot.calculateCost(): Money  // quantity * entry price
lot.calculateUnrealizedPnL(currentPrice: Price): Money

// Закрытие
lot.close(closeQuantity: Quantity): PositionLot
lot.isClosed(): boolean
```

#### P&L расчёт

**Для YES позиций:**
```
P&L = (current_price - entry_price) * quantity
```

**Для NO позиций:**
```
P&L = (entry_price - current_price) * quantity
```

Почему инверсия для NO? Потому что NO токен растёт в цене, когда вероятность YES падает.

#### Пример использования

```typescript
const lot = new PositionLot(
  'lot-1',
  'token-123',
  'YES',
  Quantity.fromNumber(10),
  Price.fromNumber(0.65),
  new Date()
);

// Cost basis
const cost = lot.calculateCost();
console.log(cost.amount); // 6.50

// Unrealized P&L (цена выросла до 0.70)
const pnl = lot.calculateUnrealizedPnL(Price.fromNumber(0.70));
console.log(pnl.amount); // 0.50 (profit)

// Частичное закрытие
const remaining = lot.close(Quantity.fromNumber(6));
console.log(remaining.quantity.value); // 4
console.log(remaining.isClosed()); // false

// Полное закрытие
const closed = remaining.close(Quantity.fromNumber(4));
console.log(closed.isClosed()); // true
```

---

### 5. Portfolio

**Файл**: `src/domain/entities/Portfolio.ts`

Представляет портфель трейдера.

#### Свойства

| Свойство | Тип | Описание |
|----------|-----|----------|
| `id` | `string` | Идентификатор портфеля |
| `cash` | `Money` | Доступный кэш |
| `reservedCash` | `Money` | Резервированный кэш (для BUY ордеров) |
| `positions` | `Map<string, Position>` | Позиции (marketId → Position) |

#### Управление кэшем

**Резервирование при BUY ордере:**
```typescript
// 1. Размещаем BUY ордер на 100 USDC
const reserved = portfolio.reserveCash(Money.fromUSDC(100));
// cash: 1000 → 1000
// reservedCash: 0 → 100
// availableCash: 1000 → 900

// 2. Ордер исполнился
const updated = reserved.releaseCash(Money.fromUSDC(100))
                        .updateCash(Money.fromUSDC(-100));
// cash: 1000 → 900
// reservedCash: 100 → 0
// availableCash: 900 → 900
```

**Available cash:**
```typescript
availableCash = cash - reservedCash
```

#### Ключевые методы

```typescript
// Создание
Portfolio.create(id: string, initialCash: Money): Portfolio

// Управление кэшем
portfolio.reserveCash(amount: Money): Portfolio
portfolio.releaseCash(amount: Money): Portfolio
portfolio.updateCash(amount: Money): Portfolio
portfolio.get availableCash(): Money

// Управление позициями
portfolio.addPosition(position: Position): Portfolio
portfolio.updatePosition(tokenId: string, position: Position): Portfolio
portfolio.removePosition(tokenId: string): Portfolio
portfolio.getPosition(tokenId: string): Position | undefined
portfolio.hasPosition(tokenId: string): boolean

// Расчёты
portfolio.getTotalValue(marketPrices: Map<string, Price>): Money
portfolio.getTotalUnrealizedPnL(marketPrices: Map<string, Price>): Money

// Утилиты
portfolio.getPositionCount(): number
portfolio.getAllPositions(): Position[]
portfolio.isEmpty(): boolean
```

#### Бизнес-правила

1. **Резервирование**: нельзя резервировать больше available cash
2. **Освобождение**: нельзя освободить больше reserved cash
3. **Отрицательный кэш**: запрещён (проверка при updateCash)
4. **Уникальность позиций**: один marketId = одна позиция

#### Пример использования

```typescript
const portfolio = Portfolio.create('p1', Money.fromUSDC(10000));

// Размещаем BUY ордер
const reserved = portfolio.reserveCash(Money.fromUSDC(500));
console.log(reserved.availableCash.amount); // 9500

// Ордер исполнился - списываем средства
const updated = reserved.releaseCash(Money.fromUSDC(500))
                        .updateCash(Money.fromUSDC(-500));

// Добавляем позицию
const position = Position.empty('market-123', 'YES').addLot(lot);
const withPos = updated.addPosition(position);

// Вычисляем общую стоимость
const marketPrices = new Map([
  ['market-123', Price.fromNumber(0.70)]
]);
const totalValue = withPos.getTotalValue(marketPrices);
console.log(`Total portfolio value: ${totalValue.amount}`);
```

---

### 6. Orderbook

**Файл**: `src/domain/entities/Orderbook.ts`

Представляет стакан заявок (order book).

#### Свойства

| Свойство | Тип | Описание |
|----------|-----|----------|
| `marketId` | `string` | ID рынка |
| `bids` | `OrderbookLevel[]` | Bids (отсортированы по убыванию цены) |
| `asks` | `OrderbookLevel[]` | Asks (отсортированы по возрастанию цены) |
| `timestamp` | `Date` | Время снимка |

#### Структура Level

```typescript
interface OrderbookLevel {
  price: Price;
  quantity: Quantity;
}
```

#### Сортировка уровней

```typescript
// Bids: лучший (максимальный) первый
bids = [
  { price: 0.55, qty: 100 },  // ← best bid
  { price: 0.54, qty: 200 },
  { price: 0.53, qty: 150 }
]

// Asks: лучший (минимальный) первый
asks = [
  { price: 0.56, qty: 150 },  // ← best ask
  { price: 0.57, qty: 250 },
  { price: 0.58, qty: 100 }
]
```

#### Ключевые методы

```typescript
// Создание
Orderbook.create(marketId: string, data: OrderbookData): Orderbook
Orderbook.empty(marketId: string): Orderbook

// Best bid/ask
orderbook.getBestBid(): Price | null
orderbook.getBestAsk(): Price | null
orderbook.getSpread(): Spread | null

// Цены
orderbook.getMidPrice(): Price | null  // (bid + ask) / 2
orderbook.getMicroprice(): Price | null  // weighted by volume

// Объёмы
orderbook.getTotalBidVolume(levels?: number): Quantity
orderbook.getTotalAskVolume(levels?: number): Quantity
orderbook.getImbalance(levels?: number): number  // -1 to 1

// Проверки
orderbook.isEmpty(): boolean
orderbook.hasLiquidity(): boolean
orderbook.isStale(maxAgeMs?: number): boolean

// Depth
orderbook.getBidDepth(): number
orderbook.getAskDepth(): number
orderbook.getAgeMs(): number
```

#### Microprice vs Midprice

**Midprice** (простое среднее):
```
mid = (best_bid + best_ask) / 2
```

**Microprice** (взвешенное по объёму):
```
micro = (best_ask × bid_qty + best_bid × ask_qty) / (bid_qty + ask_qty)
```

**Почему microprice точнее?**
- Учитывает дисбаланс ликвидности
- Если больше покупателей (bid_qty > ask_qty) → цена ближе к ask
- Если больше продавцов (ask_qty > bid_qty) → цена ближе к bid

#### Imbalance (Дисбаланс)

```typescript
imbalance = (bidVolume - askVolume) / (bidVolume + askVolume)
```

Интерпретация:
- `+1.0`: только bids (сильное покупательское давление)
- `-1.0`: только asks (сильное продавательское давление)
- `0.0`: баланс сторон

#### Пример использования

```typescript
const orderbook = Orderbook.create('market-123', {
  bids: [
    { price: Price.fromNumber(0.52), quantity: Quantity.fromNumber(100) },
    { price: Price.fromNumber(0.51), quantity: Quantity.fromNumber(200) }
  ],
  asks: [
    { price: Price.fromNumber(0.53), quantity: Quantity.fromNumber(150) },
    { price: Price.fromNumber(0.54), quantity: Quantity.fromNumber(250) }
  ]
});

// Best prices
const bestBid = orderbook.getBestBid(); // 0.52
const bestAsk = orderbook.getBestAsk(); // 0.53

// Spread
const spread = orderbook.getSpread();
console.log(spread?.width()); // 0.01

// Mid vs Microprice
const mid = orderbook.getMidPrice(); // 0.525
const micro = orderbook.getMicroprice(); // ~0.524 (weighted)

// Imbalance (больше асков → отрицательный)
const imbalance = orderbook.getImbalance(2);
console.log(imbalance); // Negative (selling pressure)

// Проверка актуальности
if (orderbook.isStale(5000)) {
  console.log('Orderbook is stale, need refresh');
}
```

---

### 7. Trade

**Файл**: `src/domain/entities/Trade.ts`

Представляет исполненную сделку.

#### Свойства

| Свойство | Тип | Описание |
|----------|-----|----------|
| `id` | `string` | Уникальный идентификатор |
| `marketId` | `string` | ID рынка |
| `price` | `Price` | Цена исполнения |
| `quantity` | `Quantity` | Количество |
| `side` | `TradeSide` | BUY или SELL (агрессор) |
| `timestamp` | `Date` | Время сделки |
| `orderId?` | `string` | ID связанного ордера |
| `makerOrderId?` | `string` | ID maker ордера |
| `takerOrderId?` | `string` | ID taker ордера |

#### Trade Side

- `BUY`: taker купил (aggressive buyer) → покупательское давление
- `SELL`: taker продал (aggressive seller) → продавательское давление

#### Ключевые методы

```typescript
// Создание
Trade.create(params: TradeParams): Trade

// Расчёты
trade.getNotional(): number  // price * quantity
trade.getAgeMs(): number

// Проверки
trade.isBuy(): boolean
trade.isSell(): boolean
trade.isRecent(maxAgeMs?: number): boolean

// Сортировка
trade.compareByTime(other: Trade): number
```

#### Использование

**1. История сделок**
```typescript
const trades: Trade[] = [];
trades.push(Trade.create({
  id: 'trade-1',
  marketId: 'market-123',
  price: Price.fromNumber(0.65),
  quantity: Quantity.fromNumber(100),
  side: 'BUY',
  timestamp: new Date()
}));
```

**2. Анализ давления на рынок**
```typescript
// Получаем недавние сделки (последние 60 секунд)
const recentTrades = trades.filter(t => t.isRecent(60000));

// Считаем buy vs sell volume
const buyVolume = recentTrades
  .filter(t => t.isBuy())
  .reduce((sum, t) => sum + t.getNotional(), 0);

const sellVolume = recentTrades
  .filter(t => t.isSell())
  .reduce((sum, t) => sum + t.getNotional(), 0);

// Давление
const pressure = (buyVolume - sellVolume) / (buyVolume + sellVolume);
if (pressure > 0.3) {
  console.log('Strong buying pressure');
}
```

**3. VWAP (Volume-Weighted Average Price)**
```typescript
const totalNotional = trades.reduce((sum, t) => sum + t.getNotional(), 0);
const totalVolume = trades.reduce((sum, t) => sum + t.quantity.value, 0);
const vwap = totalNotional / totalVolume;
console.log(`VWAP: ${vwap.toFixed(4)}`);
```

**4. Сортировка по времени**
```typescript
// От старых к новым
trades.sort((a, b) => a.compareByTime(b));

// От новых к старым
trades.sort((a, b) => b.compareByTime(a));
```

#### Пример использования

```typescript
const trade = Trade.create({
  id: 'trade-123',
  marketId: 'market-abc',
  price: Price.fromNumber(0.65),
  quantity: Quantity.fromNumber(100),
  side: 'BUY',
  timestamp: new Date(),
  orderId: 'order-456'
});

console.log(trade.getNotional()); // 65.0
console.log(trade.isBuy()); // true
console.log(trade.isRecent(30000)); // true if < 30s old

// Сериализация
const json = trade.toJSON();
console.log(JSON.stringify(json, null, 2));
```

---

## Связи между сущностями

```
┌────────────┐
│   Market   │
└─────┬──────┘
      │ 1
      │
      │ N
┌─────▼──────┐         ┌──────────┐
│   Order    │ ◄──────┤ Portfolio │
└─────┬──────┘         └─────┬────┘
      │                      │
      │ 1:1                  │ 1:N
      │                      │
┌─────▼──────┐         ┌─────▼────────┐
│   Trade    │         │   Position   │
└────────────┘         └──────┬───────┘
                              │ 1:N
                              │
                        ┌─────▼────────┐
                        │ PositionLot  │
                        └──────────────┘

┌────────────┐
│ Orderbook  │ ◄──── связан с Market
└────────────┘
```

---

## Best Practices

### 1. Создание сущностей

✅ **Используйте фабричные методы:**
```typescript
const market = Market.create({...});
const position = Position.empty('token-123', 'YES');
const portfolio = Portfolio.create('p1', Money.fromUSDC(1000));
```

❌ **Не вызывайте конструкторы напрямую:**
```typescript
new Market(...);  // ❌ Private constructor
```

### 2. Immutability

✅ **Создавайте новые экземпляры:**
```typescript
const filled = order.withStatus('FILLED');
const updated = portfolio.addPosition(position);
```

❌ **Не изменяйте свойства:**
```typescript
order.status = 'FILLED';  // ❌ Compile error (readonly)
```

### 3. Валидация

Вся валидация происходит в фабричных методах:
```typescript
try {
  const order = Order.create({...});
} catch (error) {
  if (error instanceof OrderValidationError) {
    console.error(error.message);
  }
}
```

### 4. Использование Value Objects

✅ **Всегда используйте Value Objects:**
```typescript
const price = Price.fromNumber(0.65);
const quantity = Quantity.fromNumber(100);
const money = Money.fromUSDC(1000);
```

❌ **Не используйте примитивы:**
```typescript
const price: number = 0.65;  // ❌ Теряется типобезопасность
```

---

## Тестирование

### Пример unit теста

```typescript
import { Order, OrderStatus } from '@/domain/entities';
import { Price, Quantity } from '@/domain/value-objects';

describe('Order', () => {
  it('should calculate notional correctly', () => {
    const order = Order.create({
      id: 'test-1',
      tokenId: 'token-yes',
      side: 'BUY',
      price: Price.fromNumber(0.55),
      size: Quantity.fromNumber(100),
      status: 'PENDING',
      timestamp: new Date()
    });

    expect(order.getNotional()).toBe(55.0);
  });

  it('should not allow canceling filled order', () => {
    const order = Order.create({...})
      .withStatus('FILLED');

    expect(order.canCancel()).toBe(false);
  });
});
```

---

## Резюме

| Сущность | Ключевая ответственность |
|----------|--------------------------|
| **Market** | Метаданные рынка, проверка активности |
| **Order** | Lifecycle ордера, расчёт notional |
| **Position** | Агрегация лотов, P&L расчёты, FIFO |
| **PositionLot** | Один лот для FIFO учёта |
| **Portfolio** | Управление кэшем и позициями |
| **Orderbook** | Анализ ликвидности, цены, спред |
| **Trade** | История сделок, анализ давления |

**Общие принципы:**
- ✅ Immutability (все readonly)
- ✅ Инкапсуляция бизнес-логики
- ✅ Value Objects для типобезопасности
- ✅ Factory methods для создания
- ✅ Полная валидация
- ✅ TSDoc документация
