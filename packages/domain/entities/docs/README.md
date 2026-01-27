# @polymarket/entities

> Доменные сущности (Entities) для торговой системы Polymarket

## Описание

Пакет содержит доменные сущности - объекты с идентичностью и изменяемым состоянием, представляющие бизнес-концепции торговой системы. Реализованы по принципам **Domain-Driven Design (DDD)**.

## Что такое Entity?

### Entity vs Value Object

| Характеристика | Value Object | Entity |
|---------------|--------------|--------|
| **Идентичность** | Нет (сравнивается по значению) | Есть (уникальный `id`) |
| **Изменяемость** | Полностью immutable | Состояние меняется через методы |
| **Равенство** | По значению: `Money(100) == Money(100)` | По идентичности: `Order#1 != Order#2` |
| **Время жизни** | Создаётся и уничтожается | Существует во времени, имеет lifecycle |
| **Примеры** | Money, Price, Date, Color | Order, User, Account, Invoice |

### Основные принципы

- ✅ **Идентичность** — каждая Entity имеет уникальный `id`
- ✅ **Состояние** — может меняться через бизнес-методы
- ✅ **Инварианты** — поддерживает бизнес-правила
- ✅ **Lifecycle** — переходы между состояниями
- ✅ **Композиция** — использует Value Objects для данных

## Entities в проекте

### 📋 Order - Ордер на покупку/продажу

Представляет заявку на покупку или продажу токенов.

```typescript
import { Order } from '@polymarket/entities';
import { Price, Quantity } from '@polymarket/value-objects';

// Создание BUY ордера
const order = Order.create({
  id: 'order-123',
  tokenId: 'token-yes',
  side: 'BUY',
  price: Price.fromValue(0.65),
  size: Quantity.fromValue(100),
  status: 'PENDING',
  timestamp: new Date()
});

// Расчёт стоимости ордера (notional)
const notional = order.getNotional(); // 65.00 (100 * 0.65)

// Проверка возможности отмены
if (order.canCancel()) {
  console.log('Order can be canceled');
}
```

**Lifecycle:**
```
PENDING → OPEN → PARTIALLY_FILLED → FILLED
            ↓
         CANCELED / REJECTED
```

**Бизнес-правила:**
- Цена должна быть в диапазоне [0.0001, 0.9999]
- Размер >= минимального количества
- Исполненный размер не может превышать размер ордера
- Только PENDING/OPEN ордера можно отменить

---

### 💼 Position - Позиция трейдера

Представляет агрегированную позицию в токене с FIFO учётом лотов.

```typescript
import { Position, PositionLot } from '@polymarket/entities';
import { Price, Quantity } from '@polymarket/value-objects';

// Создание пустой позиции
const position = Position.empty('token-yes', 'YES');

// Создание первого лота через factory (возвращает Result)
const lot1Result = PositionLot.create(
  'lot-1',
  'token-yes',
  'YES',
  Quantity.fromValue(10).value,
  Price.fromValue(0.60).value,
  Date.now()
);

if (!lot1Result.ok) {
  console.error('Failed to create lot:', lot1Result.error.message);
  return;
}

// Добавление лота (возвращает Result)
const addResult = position.addLot(lot1Result.value);
if (!addResult.ok) {
  console.error('Failed to add lot:', addResult.error.message);
  return;
}

const updated = addResult.value;
console.log(updated.totalQuantity.value); // 10
console.log(updated.averageEntryPrice.value); // 0.60

// Добавление второго лота (weighted average)
const lot2Result = PositionLot.create(
  'lot-2',
  'token-yes',
  'YES',
  Quantity.fromValue(5).value,
  Price.fromValue(0.70).value,
  Date.now()
);

if (!lot2Result.ok) return;

const addResult2 = updated.addLot(lot2Result.value);
if (!addResult2.ok) return;

const withLot2 = addResult2.value;
console.log(withLot2.totalQuantity.value); // 15
console.log(withLot2.averageEntryPrice.value); // 0.6333
```

**Алгоритм FIFO:**
1. При покупке - добавляется новый лот в конец очереди
2. При продаже - списываются лоты из начала очереди (FIFO)
3. Средняя цена = общая стоимость / общее количество
4. P&L = текущая стоимость - стоимость входа

**Почему FIFO?**
- Требуется большинством налоговых юрисдикций
- Точный учёт налоговой базы
- Индустриальный стандарт для ценных бумаг

---

### 🏦 Portfolio - Портфель трейдера

Управляет денежными средствами и позициями трейдера.

```typescript
import { Portfolio } from '@polymarket/entities';
import { Money } from '@polymarket/value-objects';

// Создание портфеля с начальным балансом (возвращает Result)
const portfolioResult = Portfolio.create('portfolio-1', Money.fromValue(1000));
if (!portfolioResult.ok) {
  console.error('Failed to create portfolio:', portfolioResult.error.message);
  return;
}

const portfolio = portfolioResult.value;

// Резервирование средств для BUY ордера (возвращает Result)
const reserveResult = portfolio.reserveCash(Money.fromValue(100));
if (!reserveResult.ok) {
  console.error('Insufficient funds:', reserveResult.error.message);
  return;
}

const reserved = reserveResult.value;
console.log(reserved.availableCash.amount); // 900
console.log(reserved.reservedCash.amount); // 100

// Добавление позиции (возвращает Result)
const addResult = reserved.addPosition(position);
if (!addResult.ok) {
  console.error('Failed to add position:', addResult.error.message);
  return;
}

const withPosition = addResult.value;

// Расчёт общей стоимости портфеля
const marketPrices = new Map([['token-yes', Price.fromValue(0.70)]]);
const totalValue = withPosition.getTotalValue(marketPrices);
console.log(totalValue.amount); // cash + позиции по текущим ценам
```

**Алгоритм:**
1. Хранит доступный кэш и резервированный кэш
2. При размещении BUY ордера - резервирует средства
3. При отмене/исполнении - освобождает средства
4. Общая стоимость = кэш + сумма стоимостей позиций

**Бизнес-правила:**
- Нельзя резервировать больше доступного кэша
- Резервированный кэш недоступен для новых ордеров
- Каждая позиция уникальна по marketId

---

### 🎯 OutcomeToken - Токен исхода

Представляет один из двух исходов бинарного рынка.

```typescript
import { Market } from '@polymarket/entities';

// OutcomeToken создается автоматически при создании Market
const result = Market.create({
  id: 'market-123',
  slug: 'btc-100k-2024',
  question: 'Will BTC reach $100k in 2024?',
  outcomeNames: ['Yes', 'No'],
  outcomeTokenIds: ['token-yes-456', 'token-no-789'],
  expirationDate: new Date('2024-12-31T23:59:59Z'),
  status: 'ACTIVE'
});

if (result.ok) {
  const market = result.value;

  // Получение outcome токенов
  const yesToken = market.getOutcomeToken(0);
  console.log(yesToken.name); // "Yes"
  console.log(yesToken.id); // "token-yes-456"
  console.log(yesToken.outcomeIndex); // 0

  // Поиск по ID
  const token = market.getOutcomeTokenById('token-yes-456');
  console.log(token?.name); // "Yes"
}
```

**Lifecycle:** Создается вместе с Market, существует пока существует Market.

**Aggregate:** Market - aggregate root, OutcomeToken - часть aggregate.

**Подробнее:** См. [outcome-token.md](./outcome-token.md)

---

### 📊 Market - Рынок предсказаний

Представляет бинарный рынок предсказаний с двумя исходами.

```typescript
import { Market } from '@polymarket/entities';

// Создание рынка с валидацией
const result = Market.create({
  id: 'market-123',
  slug: 'btc-100k-2024',
  question: 'Will BTC reach $100k in 2024?',
  outcomeNames: ['Yes', 'No'],
  outcomeTokenIds: ['token-yes-456', 'token-no-789'],
  expirationDate: new Date('2024-12-31T23:59:59Z'),
  status: 'ACTIVE'
});

if (result.ok) {
  const market = result.value;

  // Getter для marketUrl
  console.log(market.marketUrl);
  // "https://polymarket.com/event/btc-100k-2024"

  // Lifecycle методы
  const closedMarket = market.close();
  console.log(closedMarket.status); // "CLOSED"

  const resolveResult = closedMarket.resolve(0); // Yes wins
  if (resolveResult.ok) {
    const resolved = resolveResult.value;
    console.log(resolved.getResolvedOutcomeToken()?.name); // "Yes"
  }

  // Serialization
  const json = market.toJSON();
  const fromJson = Market.fromJSON(json);
} else {
  console.error('Validation failed:', result.error.message);
}
```

**Lifecycle:**
```
ACTIVE → CLOSED → RESOLVED
```

**Методы:**
- `close()` - закрывает рынок (ACTIVE → CLOSED)
- `resolve(outcomeIndex)` - разрешает рынок (CLOSED → RESOLVED)
- `getOutcomeToken(index)` - получает outcome token по индексу
- `getOutcomeTokenById(tokenId)` - поиск outcome token по ID
- `canTrade()` - проверяет можно ли торговать
- `toJSON() / fromJSON()` - сериализация

---

### 🔄 Trade - Исполненная сделка

Представляет исполненную сделку на рынке.

```typescript
import { Trade } from '@polymarket/entities';
import { Price, Quantity } from '@polymarket/value-objects';

// Создание сделки с валидацией
const result = Trade.create({
  id: 'trade-1',
  marketId: 'market-123',
  tokenId: 'token-yes-456',
  price: Price.fromValue(0.65).value,
  size: Quantity.fromValue(100).value,
  side: 'BUY',
  timestamp: new Date(),
  transactionHash: '0x1234...',
  orderId: 'order-1' // optional
});

if (result.ok) {
  const trade = result.value;

  console.log(trade.getNotional()); // 65.0 (0.65 * 100)
  console.log(trade.isBuy()); // true
  console.log(trade.isRecent(60000)); // true if < 1 minute old
}

// Парсинг события Polymarket
const event = {
  market: 'market-123',
  asset_id: 'token-yes-456',
  price: '0.65',
  size: '100',
  side: 'BUY',
  timestamp: '1705315800000',
  transaction_hash: '0x1234...'
};

const tradeResult = Trade.fromPolymarketEvent(event);
if (tradeResult.ok) {
  console.log(tradeResult.value.getNotional()); // 65.0
}
```

**Методы:**
- `getNotional()` - вычисляет стоимость (price × size)
- `isBuy() / isSell()` - проверка стороны
- `getAgeMs() / isRecent()` - проверка возраста
- `fromPolymarketEvent()` - парсинг Polymarket WebSocket события
- `toJSON() / fromJSON()` - сериализация

**Denormalization:** Trade хранит `tokenId` напрямую для быстрого поиска по токену.

---

### 📖 Orderbook - Книга ордеров

Bid/Ask стакан с расчётом лучших цен.

```typescript
import { Orderbook } from '@polymarket/entities';

const orderbook = Orderbook.empty('market-123');

// Получение лучших bid/ask
const spread = orderbook.getSpread();
const midPrice = orderbook.getMidPrice();

// Получение глубины рынка
const depth = orderbook.getDepth(5); // Top 5 уровней
```

## Архитектурные паттерны

### 1. Entity с приватным конструктором

Entities используют **Factory Pattern** для создания:

```typescript
export class Order {
  private constructor(params: OrderParams) { ... }

  // Public factory method
  public static create(params: OrderParams): Result<Order, Error> {
    // Валидация бизнес-правил
    if (!this.isValidPrice(params.price)) {
      return Err(new OrderValidationError(...));
    }
    return Ok(new Order(params));
  }
}
```

**Зачем?**
- Централизованная валидация
- Невозможно создать невалидную Entity
- Явный контракт через factory method

### 2. Immutable updates + Result pattern

Entity иммутабельны - методы возвращают новые экземпляры через Result:

```typescript
class Portfolio {
  public reserveCash(amount: Money): Result<Portfolio, InsufficientFundsError> {
    const available = this.availableCash;

    if (available.isLessThan(amount)) {
      return Err(new InsufficientFundsError(amount.amount, available.amount));
    }

    const newReservedCash = this.reservedCash.add(amount);

    return Ok(
      new Portfolio(
        this.id,
        this.cash,
        newReservedCash,
        this.positions
      )
    );
  }
}
```

**Преимущества:**
- Нет побочных эффектов (immutability)
- Type-safe error handling (Result pattern)
- Безопасность в многопоточности
- Простая отладка (snapshot состояния)
- Композируемость операций

### 3. Rich Domain Model

Entity содержат бизнес-логику:

```typescript
class Order {
  // ✅ GOOD: Бизнес-метод на Entity
  public canCancel(): boolean {
    return this.status === 'PENDING' || this.status === 'OPEN';
  }

  public getNotional(): number {
    return this.price.value * this.size.value;
  }
}

// ❌ BAD: Логика вне Entity
function canCancelOrder(order: Order): boolean {
  return order.status === 'PENDING' || order.status === 'OPEN';
}
```

### 4. Композиция через Value Objects

Entity используют Value Objects для данных:

```typescript
class Order {
  public readonly price: Price;      // Value Object
  public readonly size: Quantity;    // Value Object
  public readonly status: OrderStatus; // Enum

  // НЕ:
  // public readonly price: number;  ❌ Теряем валидацию
}
```

## Взаимодействие Entity и Value Objects

```typescript
// Value Objects - строительные блоки
const price = Price.fromValue(0.65);
const quantity = Quantity.fromValue(100);

// Entity - композиция Value Objects
const order = Order.create({
  id: 'order-1',
  price: price,
  size: quantity,
  // ...
});

// Entity использует методы Value Objects
const notional = order.price.value * order.size.value;
```

## Когда создавать Entity?

**Создавайте Entity если:**
- ✅ Объект имеет уникальную идентичность
- ✅ Важна история изменений (audit trail)
- ✅ Объект проходит lifecycle (состояния)
- ✅ Нужно отслеживать объект во времени

**Используйте Value Object если:**
- ✅ Важно только значение (нет идентичности)
- ✅ Объект полностью заменяемый
- ✅ Сравнение по значению (2 + 2 всегда 4)

### Примеры

| Концепция | Entity или VO? | Почему |
|-----------|----------------|--------|
| Order | **Entity** | Имеет id, меняет статус, отслеживается |
| Price | **Value Object** | 0.65 всегда равно 0.65, нет идентичности |
| User | **Entity** | Имеет id, может менять email/пароль |
| Email | **Value Object** | "user@mail.com" - просто значение |
| Invoice | **Entity** | Номер счёта, дата, статус оплаты |
| Money | **Value Object** | 100 USD всегда равно 100 USD |

## Структура проекта

```
packages/domain/entities/
├── src/
│   ├── Order.ts         # Order entity
│   ├── Position.ts      # Position entity
│   ├── Portfolio.ts     # Portfolio entity
│   ├── Trade.ts         # Trade entity
│   ├── Market.ts        # Market entity
│   ├── Orderbook.ts     # Orderbook entity
│   ├── PositionLot.ts   # PositionLot entity
│   └── index.ts         # Barrel exports
├── __tests__/
│   └── unit/            # Тесты (будут добавлены)
└── docs/
    └── README.md        # Этот файл
```

## Связанные пакеты

- [@polymarket/value-objects](../value-objects) — Money, Price, Quantity, Percentage
- [@polymarket/result](../../foundation/result) — Result type для обработки ошибок
- [@polymarket/errors](../../foundation/errors) — Типизированные ошибки

## Лицензия

MIT
