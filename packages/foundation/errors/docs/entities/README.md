# Entity Validation Errors

## Описание

**Entity Validation Errors** — это специализированные классы ошибок для валидации доменных сущностей (entities) в системе трейдинга Polymarket.

Все ошибки валидации:
- Наследуются от `TradingError`
- Имеют **severity = 'low'** (не критичные)
- Используются с **Result pattern** (не throw)
- Содержат структурированный **context** для отладки
- Имеют уникальный **code** для идентификации

## Доступные ошибки

### [OrderValidationError](./OrderValidationError.md)

**Когда:** Валидация Order entity не прошла

**Методы:**
- `Order.create()` — создание ордера
- `Order.fromOrderAccepted()` — создание из события
- `Order.fromJSON()` — десериализация

**Типичные причины:**
- Пустой или невалидный ID, marketId, tokenId
- Невалидная сторона (side не 'BUY' и не 'SELL')
- Невалидный статус
- Size не положительный
- FilledSize превышает size
- Отсутствует averageFillPrice при filledSize > 0
- Невалидный timestamp

**Пример:**
```typescript
const result = Order.create({
  id: '',  // ❌ Пустой ID
  marketId: 'market-123',
  tokenId: 'token-yes',
  side: 'BUY',
  price: Price.fromValue(0.65).value!,
  size: Quantity.fromValue(100).value!,
  status: 'OPEN',
  timestamp: new Date(),
});

if (!result.ok) {
  console.error(result.error.message);
  // "Order ID must be a non-empty string"

  console.log(result.error.code);
  // "ORDER_VALIDATION_ERROR"
}
```

[→ Полная документация OrderValidationError](./OrderValidationError.md)

---

### [OrderbookValidationError](./OrderbookValidationError.md)

**Когда:** Валидация Orderbook entity не прошла

**Методы:**
- `Orderbook.create()` — создание стакана
- `Orderbook.fromJSON()` — десериализация
- `Orderbook.empty()` — пустой стакан

**Типичные причины:**
- Пустой или невалидный marketId
- Bids или asks не являются массивом
- Невалидная цена в bid/ask уровне
- Невалидный объём в bid/ask уровне
- Price выходит за допустимые пределы
- Невалидный формат timestamp

**Пример:**
```typescript
const result = Orderbook.create('', {  // ❌ Пустой marketId
  bids: [],
  asks: [],
});

if (!result.ok) {
  console.error(result.error.message);
  // "Market ID must be a non-empty string"

  console.log(result.error.code);
  // "ORDERBOOK_VALIDATION_ERROR"
}
```

[→ Полная документация OrderbookValidationError](./OrderbookValidationError.md)

---

### MarketValidationError

**Когда:** Валидация Market entity не прошла

**Методы:**
- `Market.create()` — создание рынка
- `Market.fromJSON()` — десериализация

**Типичные причины:**
- Пустой или невалидный ID, slug
- Пустой вопрос (question)
- Невалидное количество outcomeNames (должно быть 2)
- Невалидный статус
- Невалидная дата истечения

**Пример:**
```typescript
const result = Market.create({
  id: 'market-123',
  slug: '',  // ❌ Пустой slug
  question: 'Will BTC reach $100k?',
  outcomeNames: ['Yes', 'No'],
  expirationDate: new Date('2024-12-31'),
  status: 'ACTIVE',
});

if (!result.ok) {
  console.error(result.error.message);
  // "Market slug cannot be empty"
}
```

---

### TradeValidationError

**Когда:** Валидация Trade entity не прошла

**Методы:**
- `Trade.create()` — создание сделки
- `Trade.fromJSON()` — десериализация

**Типичные причины:**
- Пустой или невалидный ID, marketId, tokenId
- Невалидная сторона (side не 'BUY' и не 'SELL')
- Price не положительный
- Size не положительный
- Невалидный timestamp

**Пример:**
```typescript
const result = Trade.create({
  id: 'trade-123',
  marketId: 'market-abc',
  tokenId: 'token-yes',
  side: 'INVALID' as any,  // ❌ Невалидная сторона
  price: Price.fromValue(0.65).value!,
  size: Quantity.fromValue(50).value!,
  timestamp: new Date(),
});

if (!result.ok) {
  console.error(result.error.message);
  // "Invalid trade side: INVALID"
}
```

---

## Общие паттерны

### 1. Проверка Result

**Всегда проверяй Result** перед использованием значения:

```typescript
const result = Entity.create(params);

if (result.ok) {
  const entity = result.value;
  // Работа с entity
} else {
  // Обработка ошибки
  handleError(result.error);
}
```

### 2. Извлечение информации об ошибке

```typescript
if (!result.ok) {
  const error = result.error;

  console.error('Validation failed:', error.message);
  console.log('Error code:', error.code);
  console.log('Severity:', error.severity);
  console.log('Context:', error.context);

  // Логирование для отладки
  logger.error('Entity validation failed', {
    message: error.message,
    code: error.code,
    context: error.context,
  });
}
```

### 3. Проверка типа ошибки

```typescript
import { OrderValidationError } from '@polymarket/errors';

if (!result.ok) {
  // Вариант 1: instanceof
  if (result.error instanceof OrderValidationError) {
    console.log('Order validation failed');
  }

  // Вариант 2: .is() метод ✨ (рекомендуется)
  if (OrderValidationError.is(result.error)) {
    console.log('Order validation failed');
  }

  // Вариант 3: проверка code
  if (result.error.code === 'ORDER_VALIDATION_ERROR') {
    console.log('Order validation failed');
  }
}
```

### 4. Обработка контекста

Все validation errors содержат **context** с информацией о невалидном поле:

```typescript
if (!result.ok && OrderValidationError.is(result.error)) {
  const context = result.error.context;

  // Общая информация
  const fieldName = context?.field as string;
  const fieldValue = context?.value;

  console.error(`Field "${fieldName}" has invalid value:`, fieldValue);

  // Специфичная информация для конкретных ошибок
  if (context?.validValues) {
    console.log('Valid values:', context.validValues);
  }

  if (context?.filledSize && context?.orderSize) {
    console.log(`FilledSize (${context.filledSize}) > OrderSize (${context.orderSize})`);
  }
}
```

### 5. Валидация данных из внешних источников

```typescript
// WebSocket
ws.on('orderbook_snapshot', (data) => {
  const result = Orderbook.fromJSON(data);

  if (result.ok) {
    updateOrderbook(result.value);
  } else if (OrderbookValidationError.is(result.error)) {
    console.error('Invalid orderbook data:', result.error.message);
    handleInvalidData(result.error);
  }
});

// REST API
async function fetchOrder(orderId: string) {
  const response = await fetch(`/api/orders/${orderId}`);
  const json = await response.json();

  const result = Order.fromJSON(json);

  if (result.ok) {
    return result.value;
  }

  if (OrderValidationError.is(result.error)) {
    console.error('API returned invalid order:', result.error.message);
    notifyAPIError(result.error);
  }

  return null;
}
```

### 6. Централизованная обработка ошибок

```typescript
import {
  OrderValidationError,
  OrderbookValidationError,
  MarketValidationError,
  TradeValidationError,
} from '@polymarket/errors';

function handleValidationError(error: TradingError) {
  // Логирование
  logger.error('Validation failed', {
    message: error.message,
    code: error.code,
    severity: error.severity,
    context: error.context,
  });

  // Специфичная обработка по типу
  if (OrderValidationError.is(error)) {
    handleOrderValidationError(error);
  } else if (OrderbookValidationError.is(error)) {
    handleOrderbookValidationError(error);
  } else if (MarketValidationError.is(error)) {
    handleMarketValidationError(error);
  } else if (TradeValidationError.is(error)) {
    handleTradeValidationError(error);
  }

  // Уведомление пользователя
  showErrorNotification(error.message);
}
```

## Структура Context

### OrderValidationError

```typescript
{
  field: string;                    // Имя невалидного поля
  value?: unknown;                  // Невалидное значение
  orderId?: string;                 // ID ордера (если известен)
  validValues?: string[];           // Допустимые значения (для enum полей)
  filledSize?: number;              // Для ошибки filledSize > size
  orderSize?: number;               // Для ошибки filledSize > size
}
```

### OrderbookValidationError

```typescript
{
  field: string;                    // Имя невалидного поля (или "bids[N].price")
  value?: unknown;                  // Невалидное значение
  marketId?: string;                // ID рынка
}
```

### MarketValidationError

```typescript
{
  field: string;                    // Имя невалидного поля
  value?: unknown;                  // Невалидное значение
  marketId?: string;                // ID рынка (если известен)
  validValues?: string[];           // Допустимые значения
}
```

### TradeValidationError

```typescript
{
  field: string;                    // Имя невалидного поля
  value?: unknown;                  // Невалидное значение
  tradeId?: string;                 // ID сделки (если известен)
  validValues?: string[];           // Допустимые значения
}
```

## Best Practices

### ✅ DO

```typescript
// ✅ Всегда проверяй Result
const result = Entity.create(params);
if (result.ok) {
  const entity = result.value;
}

// ✅ Логируй контекст для отладки
if (!result.ok) {
  logger.error('Validation failed', {
    message: result.error.message,
    context: result.error.context,
  });
}

// ✅ Валидируй данные из внешних источников
const result = Entity.fromJSON(apiData);
if (!result.ok) {
  handleInvalidData(result.error);
}

// ✅ Используй .is() для проверки типа
if (OrderValidationError.is(error)) {
  // Обработка Order ошибки
}
```

### ❌ DON'T

```typescript
// ❌ Не игнорируй Result
const entity = Entity.create(params).value!; // Может упасть!

// ❌ Не используй try/catch (Result не throw)
try {
  const entity = Entity.create(params);
} catch (e) {
  // Никогда не выполнится!
}

// ❌ Не создавай validation errors вручную
throw new OrderValidationError('...'); // Используй Entity.create()

// ❌ Не игнорируй context
if (!result.ok) {
  console.log(result.error.message); // ❌ Неполная информация
  // ✅ Используй result.error.context тоже!
}
```

## Отличие от Value Object Errors

| Аспект | Entity Validation Errors | Value Object Errors |
|--------|--------------------------|---------------------|
| **Когда** | Валидация entity (Order, Orderbook) | Валидация value object (Price, Quantity) |
| **Примеры** | OrderValidationError, OrderbookValidationError | InvalidPriceError, InvalidQuantityError |
| **Context** | Содержит field, orderId, marketId | Содержит value, min, max, precision |
| **Severity** | 'low' | 'low' |
| **Lifecycle** | Валидация при create/fromJSON | Валидация при fromValue/arithmetic |

## Debugging Tips

### 1. Просмотр полной информации об ошибке

```typescript
if (!result.ok) {
  console.log('Full error details:', JSON.stringify({
    name: result.error.name,
    message: result.error.message,
    code: result.error.code,
    severity: result.error.severity,
    context: result.error.context,
  }, null, 2));
}
```

### 2. Логирование через toJSON()

```typescript
if (!result.ok) {
  logger.error('Validation failed', result.error.toJSON());
}
```

### 3. Добавление trace для отладки

```typescript
if (!result.ok) {
  console.error('Validation failed:', result.error.message);
  console.log('Context:', result.error.context);
  console.trace(); // Показывает stack trace
}
```

### 4. Использование error context для user-friendly сообщений

```typescript
if (!result.ok && OrderValidationError.is(result.error)) {
  const field = result.error.context?.field;
  const value = result.error.context?.value;

  // User-friendly сообщение
  const userMessage = getUserFriendlyMessage(field, value);
  showErrorToUser(userMessage);

  // Полная информация в логи
  logger.error('Order validation failed', {
    message: result.error.message,
    context: result.error.context,
  });
}

function getUserFriendlyMessage(field: string, value: unknown): string {
  switch (field) {
    case 'size':
      return 'Order size must be greater than zero';
    case 'price':
      return 'Price must be between $0.01 and $0.99';
    case 'side':
      return 'Order side must be either BUY or SELL';
    default:
      return `Invalid ${field}`;
  }
}
```

## См. также

### Entities

- [Order Entity](../../domain/entities/docs/entities/order.md)
- [Orderbook Entity](../../domain/entities/docs/entities/orderbook.md)
- [Market Entity](../../domain/entities/docs/entities/market.md)
- [Trade Entity](../../domain/entities/docs/entities/trade.md)

### Errors

- [TradingError](../base/TradingError.md) — базовый класс ошибок
- [Value Object Errors](../value-objects/README.md) — ошибки валидации value objects
- [Error Handling Guide](../README.md) — общая стратегия обработки ошибок

### Patterns

- [Result Pattern](../../result/docs/README.md) — railway-oriented programming
- [Entity Pattern](https://martinfowler.com/bliki/EvansClassification.html) — DDD entities
