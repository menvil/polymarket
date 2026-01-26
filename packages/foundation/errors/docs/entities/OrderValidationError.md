# OrderValidationError

## Описание

`OrderValidationError` — это класс ошибки для **валидации Order entity** в системе трейдинга Polymarket.

Наследуется от `TradingError` и используется когда параметры создания Order не соответствуют бизнес-правилам или имеют невалидные значения.

## Когда возникает?

OrderValidationError возвращается методами Order entity при валидации:

- `Order.create()` — основной метод создания
- `Order.fromOrderAccepted()` — создание из события
- `Order.fromJSON()` — десериализация из JSON

## Свойства

```typescript
class OrderValidationError extends TradingError {
  public readonly severity: ErrorSeverity = 'low';
  public static readonly code = 'ORDER_VALIDATION_ERROR';

  // Наследуется от TradingError:
  message: string;              // Описание ошибки
  context?: Record<string, unknown>; // Контекст для отладки
  cause?: Error;                // Исходная ошибка (если есть)
}
```

### Severity: `'low'`

Проблемы валидации **не критичны** для системы — это ожидаемые ошибки при некорректном вводе данных или программной логике.

## Типичные ошибки

### 1. Пустой или невалидный ID

```typescript
const result = Order.create({
  id: '',  // ❌ Пустая строка
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

  console.log(result.error.context);
  // { field: 'id', value: '' }
}
```

### 2. Пустой marketId

```typescript
const result = Order.create({
  id: 'order-123',
  marketId: '',  // ❌ Пустой
  tokenId: 'token-yes',
  side: 'BUY',
  price: Price.fromValue(0.65).value!,
  size: Quantity.fromValue(100).value!,
  status: 'OPEN',
  timestamp: new Date(),
});

if (!result.ok) {
  console.error(result.error.message);
  // "Market ID must be a non-empty string"

  console.log(result.error.context);
  // { field: 'marketId', orderId: 'order-123', value: '' }
}
```

### 3. Невалидная сторона (side)

```typescript
const result = Order.create({
  id: 'order-123',
  marketId: 'market-abc',
  tokenId: 'token-yes',
  side: 'INVALID' as any,  // ❌ Не 'BUY' и не 'SELL'
  price: Price.fromValue(0.65).value!,
  size: Quantity.fromValue(100).value!,
  status: 'OPEN',
  timestamp: new Date(),
});

if (!result.ok) {
  console.error(result.error.message);
  // "Invalid order side: INVALID"

  console.log(result.error.context);
  // {
  //   field: 'side',
  //   orderId: 'order-123',
  //   value: 'INVALID',
  //   validValues: ['BUY', 'SELL']
  // }
}
```

### 4. Невалидный статус

```typescript
const result = Order.create({
  id: 'order-123',
  marketId: 'market-abc',
  tokenId: 'token-yes',
  side: 'BUY',
  price: Price.fromValue(0.65).value!,
  size: Quantity.fromValue(100).value!,
  status: 'UNKNOWN' as any,  // ❌ Неизвестный статус
  timestamp: new Date(),
});

if (!result.ok) {
  console.error(result.error.message);
  // "Invalid order status: UNKNOWN"

  console.log(result.error.context);
  // {
  //   field: 'status',
  //   orderId: 'order-123',
  //   value: 'UNKNOWN',
  //   validValues: ['PENDING', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED']
  // }
}
```

### 5. Size не положительный

```typescript
const result = Order.create({
  id: 'order-123',
  marketId: 'market-abc',
  tokenId: 'token-yes',
  side: 'BUY',
  price: Price.fromValue(0.65).value!,
  size: Quantity.fromValue(0).value!,  // ❌ Ноль или отрицательное
  status: 'OPEN',
  timestamp: new Date(),
});

if (!result.ok) {
  console.error(result.error.message);
  // "Order size must be positive"

  console.log(result.error.context);
  // { field: 'size', orderId: 'order-123', value: 0 }
}
```

### 6. FilledSize превышает size

```typescript
const result = Order.create({
  id: 'order-123',
  marketId: 'market-abc',
  tokenId: 'token-yes',
  side: 'BUY',
  price: Price.fromValue(0.65).value!,
  size: Quantity.fromValue(100).value!,
  status: 'PARTIALLY_FILLED',
  timestamp: new Date(),
  filledSize: Quantity.fromValue(150).value!,  // ❌ Больше чем size
  averageFillPrice: Price.fromValue(0.65).value!,
});

if (!result.ok) {
  console.error(result.error.message);
  // "Filled size (150) cannot exceed order size (100)"

  console.log(result.error.context);
  // {
  //   field: 'filledSize',
  //   orderId: 'order-123',
  //   filledSize: 150,
  //   orderSize: 100
  // }
}
```

### 7. Отсутствует averageFillPrice при filledSize > 0

```typescript
const result = Order.create({
  id: 'order-123',
  marketId: 'market-abc',
  tokenId: 'token-yes',
  side: 'BUY',
  price: Price.fromValue(0.65).value!,
  size: Quantity.fromValue(100).value!,
  status: 'PARTIALLY_FILLED',
  timestamp: new Date(),
  filledSize: Quantity.fromValue(50).value!,
  // ❌ Нет averageFillPrice
});

if (!result.ok) {
  console.error(result.error.message);
  // "Average fill price is required when filled size > 0"

  console.log(result.error.context);
  // { field: 'averageFillPrice', orderId: 'order-123' }
}
```

### 8. Невалидный timestamp

```typescript
const result = Order.create({
  id: 'order-123',
  marketId: 'market-abc',
  tokenId: 'token-yes',
  side: 'BUY',
  price: Price.fromValue(0.65).value!,
  size: Quantity.fromValue(100).value!,
  status: 'OPEN',
  timestamp: new Date('invalid'),  // ❌ Невалидная дата
});

if (!result.ok) {
  console.error(result.error.message);
  // "Invalid timestamp"

  console.log(result.error.context);
  // { field: 'timestamp', orderId: 'order-123', value: Invalid Date }
}
```

## Использование

### Обработка ошибок валидации

```typescript
import { Order } from '@polymarket/entities';
import { OrderValidationError } from '@polymarket/errors';

function createOrder(params: OrderParams) {
  const result = Order.create(params);

  if (result.ok) {
    return result.value;
  }

  // Обработка ошибки валидации
  const error = result.error;

  console.error('Order validation failed:', error.message);
  console.log('Error code:', error.code); // 'ORDER_VALIDATION_ERROR'
  console.log('Severity:', error.severity); // 'low'
  console.log('Context:', error.context);

  // Логирование для отладки
  logValidationError(error);

  return null;
}
```

### Проверка типа ошибки

```typescript
import { OrderValidationError } from '@polymarket/errors';

const result = Order.create(params);

if (!result.ok) {
  // Вариант 1: instanceof
  if (result.error instanceof OrderValidationError) {
    console.log('Order validation failed');
  }

  // Вариант 2: .is() метод ✨
  if (OrderValidationError.is(result.error)) {
    console.log('Order validation failed');
  }

  // Вариант 3: проверка code
  if (result.error.code === 'ORDER_VALIDATION_ERROR') {
    console.log('Order validation failed');
  }
}
```

### Извлечение контекста

```typescript
if (!result.ok && OrderValidationError.is(result.error)) {
  const context = result.error.context;

  // Получение информации о поле
  const fieldName = context?.field as string;
  const fieldValue = context?.value;

  console.error(`Validation failed for field "${fieldName}": ${fieldValue}`);

  // Для некоторых ошибок есть дополнительная информация
  if (context?.validValues) {
    console.log('Valid values:', context.validValues);
  }

  if (context?.filledSize && context?.orderSize) {
    console.log(`FilledSize (${context.filledSize}) > OrderSize (${context.orderSize})`);
  }
}
```

## Примеры

### Валидация пользовательского ввода

```typescript
import { Order } from '@polymarket/entities';
import { Price, Quantity } from '@polymarket/value-objects';
import { OrderValidationError } from '@polymarket/errors';

async function placeOrder(userInput: {
  marketId: string;
  tokenId: string;
  side: string;
  price: number;
  size: number;
}) {
  // Создание value objects
  const priceResult = Price.fromValue(userInput.price);
  if (!priceResult.ok) {
    return { error: 'Invalid price' };
  }

  const sizeResult = Quantity.fromValue(userInput.size);
  if (!sizeResult.ok) {
    return { error: 'Invalid size' };
  }

  // Создание Order
  const orderResult = Order.create({
    id: generateId(),
    marketId: userInput.marketId,
    tokenId: userInput.tokenId,
    side: userInput.side as TradeSide,
    price: priceResult.value,
    size: sizeResult.value,
    status: 'PENDING',
    timestamp: new Date(),
  });

  if (orderResult.ok) {
    await exchange.placeOrder(orderResult.value);
    return { success: true, orderId: orderResult.value.id };
  }

  // Обработка ошибки валидации
  if (OrderValidationError.is(orderResult.error)) {
    return {
      error: `Validation failed: ${orderResult.error.message}`,
      field: orderResult.error.context?.field,
    };
  }

  return { error: 'Unknown error' };
}
```

### Десериализация из API

```typescript
async function loadOrderFromAPI(orderId: string) {
  const response = await fetch(`/api/orders/${orderId}`);
  const json = await response.json();

  const result = Order.fromJSON(json);

  if (result.ok) {
    return result.value;
  }

  // API вернул невалидные данные
  if (OrderValidationError.is(result.error)) {
    console.error('API returned invalid Order data:', result.error.message);
    console.log('Invalid field:', result.error.context?.field);
    console.log('Invalid value:', result.error.context?.value);

    // Уведомление о проблеме с API
    notifyAPIError({
      endpoint: `/api/orders/${orderId}`,
      error: result.error,
    });
  }

  return null;
}
```

### Обработка событий с валидацией

```typescript
import type { OrderAccepted } from '@polymarket/entities/events';

exchange.on('OrderAccepted', (event: OrderAccepted) => {
  const result = Order.fromOrderAccepted(event);

  if (result.ok) {
    const order = result.value;
    console.log(`Order ${order.id} accepted`);
    updateOrderbook(order);
  } else if (OrderValidationError.is(result.error)) {
    // Невалидное событие от биржи (защита от bad data)
    console.error('Invalid OrderAccepted event:', result.error.message);
    console.log('Event data:', event);
    console.log('Validation context:', result.error.context);

    // Критичная проблема — биржа прислала невалидные данные
    alertSystemAdmins({
      severity: 'high',
      message: 'Exchange sent invalid OrderAccepted event',
      error: result.error,
      event,
    });
  }
});
```

## Best Practices

### ✅ DO

```typescript
// ✅ Всегда проверяй Result перед использованием
const result = Order.create(params);
if (result.ok) {
  const order = result.value;
} else {
  handleError(result.error);
}

// ✅ Логируй контекст ошибки для отладки
if (!result.ok) {
  logger.error('Order validation failed', {
    message: result.error.message,
    context: result.error.context,
  });
}

// ✅ Используй проверку типа для специфичной обработки
if (OrderValidationError.is(result.error)) {
  // Обработка валидации Order
}
```

### ❌ DON'T

```typescript
// ❌ Не игнорируй ошибки валидации
const order = Order.create(params).value!; // Может упасть!

// ❌ Не перехватывай как исключения (Result не throw)
try {
  const order = Order.create(params);
} catch (e) {
  // Никогда не выполнится!
}

// ❌ Не создавай OrderValidationError вручную для Order
throw new OrderValidationError('...'); // Используй Order.create()
```

## Связанные ошибки

- **[OrderbookValidationError](./OrderbookValidationError.md)** — валидация Orderbook entity
- **[MarketValidationError](./MarketValidationError.md)** — валидация Market entity
- **[TradeValidationError](./TradeValidationError.md)** — валидация Trade entity
- **[InvalidPriceError](../value-objects/InvalidPriceError.md)** — невалидная цена (из Price value object)
- **[InvalidQuantityError](../value-objects/InvalidQuantityError.md)** — невалидный объём (из Quantity value object)

## См. также

- [Order Entity](../../domain/entities/docs/entities/order.md) — документация Order
- [TradingError](../base/TradingError.md) — базовый класс ошибок
- [Result Pattern](../../result/docs/README.md) — railway-oriented programming
- [Error Handling Guide](../README.md) — общая стратегия обработки ошибок
