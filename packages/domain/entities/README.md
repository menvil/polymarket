# @polymarket/entities

Domain entities для Polymarket торгового бота.

## 🤔 Зачем нужны Entities?

### Проблема без Entities

```typescript
// ❌ БЕЗ ENTITIES - просто объекты
const order = {
  price: 0.75,
  quantity: 100,
  side: 'buy',
  total: 75  // Можно забыть пересчитать!
}

// Расчёты размазаны по коду
order.total = order.price * order.quantity;

// Валидация где-то отдельно
if (order.price < 0.01 || order.price > 0.99) {
  throw new Error('Invalid price');
}

// Легко сломать инварианты
order.price = 1.5;  // Ой! Невалидная цена
order.total = 50;   // Теперь total не соответствует price * quantity
```

**Проблемы:**
- ❌ Нет валидации при создании
- ❌ Можно сломать инварианты (например, `total` не соответствует `price * quantity`)
- ❌ Логика размазана по всему коду
- ❌ Дублирование проверок везде где используется
- ❌ Трудно тестировать
- ❌ Нет гарантий что объект в валидном состоянии

### ✅ Решение с Entities

```typescript
// ✅ С ENTITIES - инкапсуляция + валидация
class Order {
  private constructor(
    private readonly _price: Decimal,
    private readonly _quantity: Decimal,
    private readonly _side: OrderSide
  ) {}

  // Валидация при создании - невалидный Order создать НЕВОЗМОЖНО
  static create(
    price: Decimal,
    quantity: Decimal,
    side: OrderSide
  ): Result<Order, InvalidOrderError> {
    // Валидация цены
    if (price.lessThan('0.01') || price.greaterThan('0.99')) {
      return Err(new InvalidPriceError('Price must be between 0.01 and 0.99'));
    }

    // Валидация количества
    if (!quantity.isPositive()) {
      return Err(new InvalidQuantityError('Quantity must be positive'));
    }

    return Ok(new Order(price, quantity, side));
  }

  // Расчёты как методы - ВСЕГДА корректны
  get total(): Decimal {
    return this._price.times(this._quantity);
  }

  get price(): Decimal {
    return this._price; // Иммутабельно - нельзя изменить!
  }

  // Бизнес-логика внутри entity
  canMatch(otherOrder: Order): boolean {
    if (this._side === otherOrder._side) return false;

    if (this._side === 'buy') {
      return this._price.greaterThanOrEqualTo(otherOrder._price);
    }
    return this._price.lessThanOrEqualTo(otherOrder._price);
  }
}

// Использование
const order = Order.create(
  new Decimal('0.75'),
  new Decimal(100),
  'buy'
).unwrap();

console.log(order.total); // Всегда корректно: 75
// order._price = ... // ❌ Нельзя - private!
```

**Преимущества:**
- ✅ Валидация при создании - невозможно создать невалидный Order
- ✅ Инварианты защищены - `total` всегда корректен
- ✅ Логика в одном месте - легко найти и изменить
- ✅ Иммутабельность - нельзя случайно сломать
- ✅ Легко тестировать
- ✅ Гарантия валидного состояния

---

## 📦 Entities для Polymarket бота

### Order (Ордер)

**Что это:** Заявка на покупку/продажу по определённой цене.

**Зачем:**
- Валидация цены (0.01-0.99)
- Валидация количества (> 0)
- Расчёт total = price × quantity
- Проверка возможности сведения с другим ордером

**Пример:**
```typescript
const buyOrder = Order.create(
  new Decimal('0.75'),  // price
  new Decimal(100),     // quantity
  'buy'
).unwrap();

const sellOrder = Order.create(
  new Decimal('0.70'),
  new Decimal(50),
  'sell'
).unwrap();

// Могут ли ордера свестись?
if (buyOrder.canMatch(sellOrder)) {
  console.log('Match possible!');
}
```

---

### Position (Позиция)

**Что это:** Текущая позиция пользователя на рынке.

**Зачем:**
- Отслеживание количества контрактов
- Расчёт средней цены входа
- Расчёт PnL (прибыль/убыток)
- Проверка достаточности средств

**Пример:**
```typescript
const position = Position.create({
  marketId: 'market-123',
  contracts: new Decimal(100),
  averagePrice: new Decimal('0.60'),
  currentPrice: new Decimal('0.75')
}).unwrap();

// Текущая прибыль
const pnl = position.calculatePnL();
console.log(pnl.toString()); // 15 (100 * (0.75 - 0.60))
```

---

### Market (Рынок)

**Что это:** Предсказательный рынок (событие).

**Зачем:**
- Хранение информации о рынке
- Валидация что рынок активен
- Расчёт спреда (разницы между bid и ask)
- Проверка ликвидности

**Пример:**
```typescript
const market = Market.create({
  id: 'market-123',
  question: 'Will BTC reach $100k in 2024?',
  bestBid: new Decimal('0.65'),
  bestAsk: new Decimal('0.70'),
  status: 'active'
}).unwrap();

// Спред
const spread = market.calculateSpread();
console.log(spread.toString()); // 0.05
```

---

### Trade (Сделка)

**Что это:** Исполненная сделка (матч двух ордеров).

**Зачем:**
- Запись истории сделок
- Расчёт комиссий
- Расчёт итоговой стоимости
- Обновление позиций

**Пример:**
```typescript
const trade = Trade.create({
  buyOrderId: 'order-1',
  sellOrderId: 'order-2',
  price: new Decimal('0.72'),
  quantity: new Decimal(50),
  fee: new Decimal('0.01')
}).unwrap();

// Итоговая стоимость с комиссией
const totalCost = trade.calculateTotalCost();
console.log(totalCost.toString()); // 36.01
```

---

### OrderBook (Книга ордеров)

**Что это:** Список всех активных ордеров на рынке.

**Зачем:**
- Хранение bid/ask ордеров
- Поиск лучших цен
- Матчинг ордеров
- Расчёт ликвидности на разных уровнях цен

**Пример:**
```typescript
const orderBook = OrderBook.create('market-123').unwrap();

// Добавление ордеров
orderBook.addOrder(buyOrder);
orderBook.addOrder(sellOrder);

// Получение лучших цен
const bestBid = orderBook.getBestBid();
const bestAsk = orderBook.getBestAsk();

// Попытка свести ордер
const matches = orderBook.findMatches(newOrder);
```

---

### User (Пользователь)

**Что это:** Пользователь бота с балансом.

**Зачем:**
- Управление балансом
- Проверка достаточности средств
- История операций
- Расчёт доступных средств (с учётом открытых ордеров)

**Пример:**
```typescript
const user = User.create({
  id: 'user-123',
  balance: new Decimal(1000),
  lockedBalance: new Decimal(200)
}).unwrap();

// Доступные средства
const available = user.getAvailableBalance();
console.log(available.toString()); // 800

// Проверка достаточности средств
if (user.hasEnoughBalance(new Decimal(500))) {
  console.log('Can place order');
}
```

---

## 🎯 Почему с Entities ЛУЧШЕ?

### 1. **Безопасность типов**
```typescript
// БЕЗ entities - можно передать что угодно
function placeOrder(price: number, qty: number) { ... }
placeOrder(-1, 0); // ❌ Компилируется, но сломается в runtime

// С entities - невалидный Order создать невозможно
function placeOrder(order: Order) { ... }
placeOrder(Order.create(-1, 0).unwrap()); // ❌ Ошибка при создании
```

### 2. **Единственный источник правды**
```typescript
// БЕЗ entities - расчёты повторяются везде
const total1 = order.price * order.quantity;
const total2 = calculateTotal(order); // Другая функция
const total3 = order.total;           // Может устареть

// С entities - одна функция, один результат
order.total // ✅ Всегда корректно
```

### 3. **Тестируемость**
```typescript
// Легко тестировать в изоляции
describe('Order', () => {
  it('should calculate total correctly', () => {
    const order = Order.create(
      new Decimal('0.5'),
      new Decimal(100),
      'buy'
    ).unwrap();

    expect(order.total.toString()).toBe('50');
  });
});
```

### 4. **Эволюция кода**
```typescript
// Добавить новую логику легко - она в одном месте
class Order {
  // Новый метод
  calculateFee(feeRate: Decimal): Decimal {
    return this.total.times(feeRate);
  }

  // Всё остальное не меняется
}
```

---

## 📚 Паттерны

### Immutability (Иммутабельность)

```typescript
class Order {
  // ❌ НЕ ТАК
  public price: Decimal;

  // ✅ ТАК
  private readonly _price: Decimal;

  get price(): Decimal {
    return this._price;
  }
}
```

### Factory Method (Создание через статический метод)

```typescript
class Order {
  private constructor(...) {}  // private!

  // ✅ Единственный способ создать
  static create(...): Result<Order, Error> {
    // Валидация здесь
    return Ok(new Order(...));
  }
}
```

### Value Objects vs Entities

**Entity** (Order, User, Market):
- Имеет уникальный ID
- Изменяется со временем (мутабельное состояние в БД)
- Сравнивается по ID

**Value Object** (Price, Quantity, Money):
- Нет ID
- Иммутабельно
- Сравнивается по значению

---

## 🚀 Итого

**Без Entities:**
- Код как спагетти 🍝
- Проверки дублируются
- Легко сломать
- Трудно тестировать

**С Entities:**
- Чистая архитектура 🏛️
- Логика в одном месте
- Защита от ошибок
- Легко тестировать

**Вывод:** С entities код надёжнее, понятнее и проще поддерживать. Это стандартный подход в Domain-Driven Design для сложных систем.