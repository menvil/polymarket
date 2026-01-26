# OrderbookValidationError

## Описание

`OrderbookValidationError` — это класс ошибки для **валидации Orderbook entity** в системе трейдинга Polymarket.

Наследуется от `TradingError` и используется когда параметры создания Orderbook не соответствуют требованиям или содержат невалидные данные.

## Когда возникает?

OrderbookValidationError возвращается методами Orderbook entity при валидации:

- `Orderbook.create()` — основной метод создания
- `Orderbook.fromJSON()` — десериализация из JSON
- `Orderbook.empty()` — создание пустого стакана

## Свойства

```typescript
class OrderbookValidationError extends TradingError {
  public readonly severity: ErrorSeverity = 'low';
  public static readonly code = 'ORDERBOOK_VALIDATION_ERROR';

  // Наследуется от TradingError:
  message: string;              // Описание ошибки
  context?: Record<string, unknown>; // Контекст для отладки
  cause?: Error;                // Исходная ошибка (если есть)
}
```

### Severity: `'low'`

Проблемы валидации **не критичны** для системы — это ожидаемые ошибки при некорректном вводе или получении данных.

## Типичные ошибки

### 1. Пустой или невалидный marketId

```typescript
const result = Orderbook.create('', {  // ❌ Пустой marketId
  bids: [],
  asks: [],
});

if (!result.ok) {
  console.error(result.error.message);
  // "Market ID must be a non-empty string"

  console.log(result.error.context);
  // { field: 'marketId', value: '' }
}
```

### 2. Bids не является массивом

```typescript
const result = Orderbook.create('market-123', {
  bids: 'invalid' as any,  // ❌ Не массив
  asks: [],
});

if (!result.ok) {
  console.error(result.error.message);
  // "Bids must be an array"

  console.log(result.error.context);
  // { field: 'bids', marketId: 'market-123', value: 'invalid' }
}
```

### 3. Asks не является массивом

```typescript
const result = Orderbook.create('market-123', {
  bids: [],
  asks: null as any,  // ❌ Не массив
});

if (!result.ok) {
  console.error(result.error.message);
  // "Asks must be an array"

  console.log(result.error.context);
  // { field: 'asks', marketId: 'market-123', value: null }
}
```

### 4. Невалидная цена в bid уровне (fromJSON)

```typescript
const json = {
  marketId: 'market-123',
  bids: [
    { price: 'invalid', quantity: 100 }  // ❌ Цена не число
  ],
  asks: [],
};

const result = Orderbook.fromJSON(json);

if (!result.ok) {
  console.error(result.error.message);
  // "Invalid price in bid[0]"

  console.log(result.error.context);
  // { field: 'bids[0].price', marketId: 'market-123', value: 'invalid' }
}
```

### 5. Невалидный объём в ask уровне (fromJSON)

```typescript
const json = {
  marketId: 'market-123',
  bids: [],
  asks: [
    { price: 0.53, quantity: -10 }  // ❌ Отрицательный объём
  ],
};

const result = Orderbook.fromJSON(json);

if (!result.ok) {
  console.error(result.error.message);
  // "Failed to create Quantity from ask[0]: ..."

  console.log(result.error.context);
  // { field: 'asks[0].quantity', marketId: 'market-123', value: -10 }
}
```

### 6. Price выходит за допустимые пределы (fromJSON)

```typescript
const json = {
  marketId: 'market-123',
  bids: [
    { price: 1.5, quantity: 100 }  // ❌ Price > 1.0
  ],
  asks: [],
};

const result = Orderbook.fromJSON(json);

if (!result.ok) {
  console.error(result.error.message);
  // "Failed to create Price from bid[0]: Price must be between 0.01 and 0.99"

  console.log(result.error.context);
  // { field: 'bids[0].price', marketId: 'market-123', value: 1.5 }
}
```

### 7. Невалидный формат timestamp (fromJSON)

```typescript
const json = {
  marketId: 'market-123',
  bids: [],
  asks: [],
  timestamp: 'not-a-date',  // ❌ Невалидная строка даты
};

const result = Orderbook.fromJSON(json);

if (!result.ok) {
  console.error(result.error.message);
  // "Invalid timestamp format"

  console.log(result.error.context);
  // { field: 'timestamp', marketId: 'market-123', value: 'not-a-date' }
}
```

## Использование

### Обработка ошибок валидации

```typescript
import { Orderbook } from '@polymarket/entities';
import { OrderbookValidationError } from '@polymarket/errors';
import { Price, Quantity } from '@polymarket/value-objects';

function createOrderbook(marketId: string, data: OrderbookData) {
  const result = Orderbook.create(marketId, data);

  if (result.ok) {
    return result.value;
  }

  // Обработка ошибки валидации
  const error = result.error;

  console.error('Orderbook validation failed:', error.message);
  console.log('Error code:', error.code); // 'ORDERBOOK_VALIDATION_ERROR'
  console.log('Severity:', error.severity); // 'low'
  console.log('Context:', error.context);

  // Логирование для отладки
  logValidationError(error);

  return null;
}
```

### Проверка типа ошибки

```typescript
import { OrderbookValidationError } from '@polymarket/errors';

const result = Orderbook.create(marketId, data);

if (!result.ok) {
  // Вариант 1: instanceof
  if (result.error instanceof OrderbookValidationError) {
    console.log('Orderbook validation failed');
  }

  // Вариант 2: .is() метод ✨
  if (OrderbookValidationError.is(result.error)) {
    console.log('Orderbook validation failed');
  }

  // Вариант 3: проверка code
  if (result.error.code === 'ORDERBOOK_VALIDATION_ERROR') {
    console.log('Orderbook validation failed');
  }
}
```

### Извлечение контекста

```typescript
if (!result.ok && OrderbookValidationError.is(result.error)) {
  const context = result.error.context;

  // Получение информации о поле
  const fieldName = context?.field as string;
  const fieldValue = context?.value;
  const marketId = context?.marketId as string;

  console.error(`Orderbook validation failed for market "${marketId}"`);
  console.error(`Field "${fieldName}": ${fieldValue}`);

  // Для ошибок в уровнях (bid[N], ask[N])
  if (fieldName?.includes('[')) {
    const [levelType, indexStr] = fieldName.split('[');
    const index = parseInt(indexStr);
    console.log(`Error in ${levelType} level at index ${index}`);
  }
}
```

## Примеры

### Загрузка orderbook из WebSocket

```typescript
import { Orderbook, type OrderbookData } from '@polymarket/entities';
import { OrderbookValidationError } from '@polymarket/errors';

ws.on('orderbook_snapshot', (data: any) => {
  const result = Orderbook.fromJSON(data);

  if (result.ok) {
    const orderbook = result.value;
    updateMarketData(orderbook);
  } else if (OrderbookValidationError.is(result.error)) {
    // WebSocket прислал невалидные данные
    console.error('Invalid orderbook snapshot received:', result.error.message);
    console.log('Invalid field:', result.error.context?.field);
    console.log('Market ID:', result.error.context?.marketId);

    // Критичная проблема — требуется reconnect
    handleInvalidData({
      source: 'websocket',
      marketId: data.marketId,
      error: result.error,
    });
  }
});
```

### Валидация данных от REST API

```typescript
async function fetchOrderbook(marketId: string): Promise<Orderbook | null> {
  try {
    const response = await fetch(`/api/orderbook/${marketId}`);
    const json = await response.json();

    const result = Orderbook.fromJSON(json);

    if (result.ok) {
      return result.value;
    }

    // API вернул невалидные данные
    if (OrderbookValidationError.is(result.error)) {
      console.error('API returned invalid orderbook:', result.error.message);
      console.log('Context:', result.error.context);

      // Уведомление о проблеме с API
      notifyAPIError({
        endpoint: `/api/orderbook/${marketId}`,
        error: result.error,
        responseData: json,
      });
    }

    return null;
  } catch (error) {
    console.error('Failed to fetch orderbook:', error);
    return null;
  }
}
```

### Создание orderbook из уровней

```typescript
import { Price, Quantity } from '@polymarket/value-objects';

function buildOrderbook(marketId: string, rawData: {
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
}) {
  // Конвертация raw data в OrderbookLevel[]
  const bids = rawData.bids.map(([price, qty]) => {
    const priceResult = Price.fromValue(price);
    const qtyResult = Quantity.fromValue(qty);

    if (!priceResult.ok || !qtyResult.ok) {
      throw new Error(`Invalid level: price=${price}, qty=${qty}`);
    }

    return {
      price: priceResult.value,
      quantity: qtyResult.value,
    };
  });

  const asks = rawData.asks.map(([price, qty]) => {
    const priceResult = Price.fromValue(price);
    const qtyResult = Quantity.fromValue(qty);

    if (!priceResult.ok || !qtyResult.ok) {
      throw new Error(`Invalid level: price=${price}, qty=${qty}`);
    }

    return {
      price: priceResult.value,
      quantity: qtyResult.value,
    };
  });

  // Создание Orderbook
  const result = Orderbook.create(marketId, { bids, asks });

  if (result.ok) {
    return result.value;
  }

  // Обработка ошибки валидации
  if (OrderbookValidationError.is(result.error)) {
    console.error('Failed to build orderbook:', result.error.message);
    console.log('Error context:', result.error.context);
  }

  return null;
}
```

### Проверка данных перед сохранением

```typescript
async function saveOrderbook(orderbook: Orderbook) {
  // Сериализация
  const json = orderbook.toJSON();

  // Валидация перед сохранением (защита от регрессий)
  const validateResult = Orderbook.fromJSON(json);

  if (!validateResult.ok) {
    if (OrderbookValidationError.is(validateResult.error)) {
      console.error('Orderbook serialization produced invalid data:', validateResult.error.message);
      console.log('Context:', validateResult.error.context);

      // Критичная проблема — bug в toJSON()
      throw new Error('Orderbook serialization validation failed');
    }
  }

  // Сохранение
  await db.orderbooks.insert({
    marketId: orderbook.marketId,
    data: JSON.stringify(json),
    timestamp: orderbook.timestamp,
  });
}
```

## Best Practices

### ✅ DO

```typescript
// ✅ Всегда проверяй Result перед использованием
const result = Orderbook.create(marketId, data);
if (result.ok) {
  const orderbook = result.value;
} else {
  handleError(result.error);
}

// ✅ Валидируй данные из внешних источников
const result = Orderbook.fromJSON(apiData);
if (!result.ok) {
  logger.error('Invalid orderbook data from API', {
    error: result.error,
  });
}

// ✅ Логируй контекст для отладки
if (OrderbookValidationError.is(result.error)) {
  logger.error('Orderbook validation failed', {
    message: result.error.message,
    context: result.error.context,
  });
}
```

### ❌ DON'T

```typescript
// ❌ Не игнорируй ошибки валидации
const orderbook = Orderbook.create(marketId, data).value!; // Может упасть!

// ❌ Не используй невалидированные данные
ws.on('snapshot', (data) => {
  updateUI(data); // ❌ Сначала валидируй через Orderbook.fromJSON()
});

// ❌ Не создавай OrderbookValidationError вручную
throw new OrderbookValidationError('...'); // Используй Orderbook.create()
```

## Связанные ошибки

- **[OrderValidationError](./OrderValidationError.md)** — валидация Order entity
- **[MarketValidationError](./MarketValidationError.md)** — валидация Market entity
- **[TradeValidationError](./TradeValidationError.md)** — валидация Trade entity
- **[InvalidPriceError](../value-objects/InvalidPriceError.md)** — невалидная цена (из Price value object)
- **[InvalidQuantityError](../value-objects/InvalidQuantityError.md)** — невалидный объём (из Quantity value object)
- **[InvalidSpreadError](../value-objects/InvalidSpreadError.md)** — невалидный spread

## См. также

- [Orderbook Entity](../../domain/entities/docs/entities/orderbook.md) — документация Orderbook
- [TradingError](../base/TradingError.md) — базовый класс ошибок
- [Result Pattern](../../result/docs/README.md) — railway-oriented programming
- [Error Handling Guide](../README.md) — общая стратегия обработки ошибок
