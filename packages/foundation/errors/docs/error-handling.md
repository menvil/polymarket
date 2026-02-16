# Обработка ошибок

Руководство по best practices обработки ошибок в торговой системе Polymarket.

## Содержание

- [Философия](#философия)
- [Try/Catch vs Result<T,E>](#trycatch-vs-resultte)
- [Railway-Oriented Programming](#railway-oriented-programming)
- [Паттерны обработки](#паттерны-обработки)
- [Логирование](#логирование)
- [Мониторинг и метрики](#мониторинг-и-метрики)

---

## Философия

### Два подхода к ошибкам

**1. Exceptions (throw/catch)**

- Для исключительных ситуаций
- Когда нужно прервать выполнение
- В старом коде

**2. Result<T,E> (Railway-Oriented Programming)**

- Для ожидаемых ошибок
- Явная обработка в типах
- В новом коде (рекомендуется)

---

## Try/Catch vs Result<T,E>

### ❌ Старый подход: Try/Catch

```typescript
import { InvalidPriceError } from '@polymarket/errors';

class Price {
  static fromNumber(value: number): Price {
    if (value < 0.0001 || value > 0.9999) {
      throw new InvalidPriceError(
        (ctx) => `Invalid price ${ctx.value}`,
        {
          code: InvalidPriceError.code,
          context: { value, min: 0.0001, max: 0.9999 }
        }
      );
    }
    return new Price(value);
  }
}

// Использование
try {
  const price = Price.fromNumber(userInput);
  console.log('Valid price:', price);
} catch (error) {
  if (InvalidPriceError.is(error)) {
    console.error('Invalid price:', error.context?.value);
  }
}
```

**Проблемы:**

- ❌ Неявная обработка (компилятор не заставляет обработать ошибку)
- ❌ Сложно понять что функция может выбросить
- ❌ Performance overhead

### ✅ Новый подход: Result<T,E>

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidPriceError } from '@polymarket/errors';

class Price {
  static fromNumber(value: number): Result<Price, InvalidPriceError> {
    if (value < 0.0001 || value > 0.9999) {
      return Err(
        new InvalidPriceError(
          (ctx) => `Invalid price ${ctx.value}`,
          {
            code: InvalidPriceError.code,
            context: { value, min: 0.0001, max: 0.9999 }
          }
        )
      );
    }
    return Ok(new Price(value));
  }
}

// Использование
const result = Price.fromNumber(userInput);

if (result.ok) {
  console.log('Valid price:', result.value);
} else {
  console.error('Invalid price:', result.error.context?.value);
}
```

**Преимущества:**

- ✅ Явная обработка (компилятор требует обработать Result)
- ✅ Типобезопасность
- ✅ Композиция через map/flatMap
- ✅ Zero performance overhead

---

## Railway-Oriented Programming

### Концепция

Представьте железную дорогу с двумя путями:

- **Success track** (ok) - всё идёт по плану
- **Failure track** (err) - произошла ошибка

Операции либо остаются на success track, либо переключаются на failure track.

### Базовый пример

```typescript
import { Result, toChain } from '@polymarket/result';
import { InvalidPriceError, InvalidQuantityError } from '@polymarket/errors';

// Каждая функция возвращает Result
function validatePrice(value: number): Result<Price, InvalidPriceError> {
  // ...
}

function validateQuantity(value: number): Result<Quantity, InvalidQuantityError> {
  // ...
}

// Композиция через ResultChain
const orderResult = toChain(validatePrice(priceInput))
  .flatMap(price =>
    validateQuantity(qtyInput).map(qty => ({ price, qty }))
  )
  .map(({ price, qty }) => new Order(price, qty))
  .toResult();

// Обработка результата через pattern matching
if (orderResult.ok) {
  console.log('Order created:', orderResult.value);
} else {
  console.error('Validation failed:', orderResult.error.message);
}
```

### Цепочка операций (ResultChain)

```typescript
import { toChain, Ok, Err } from '@polymarket/result';
import {
  InvalidPriceError,
  InvalidQuantityError,
  InvalidMoneyError
} from '@polymarket/errors';

// Создание ордера через цепочку валидаций
const orderResult = toChain(validatePrice(priceInput))
  .flatMap(price =>
    validateQuantity(qtyInput).map(qty => ({ price, qty }))
  )
  .flatMap(({ price, qty }) =>
    validateBalance(balance).map(bal => ({ price, qty, balance: bal }))
  )
  .flatMap(({ price, qty, balance }) => {
    // Проверка достаточности средств
    const cost = price.value * qty.value;
    if (balance.amount < cost) {
      return Err(
        new InvalidMoneyError(
          (ctx) => `Insufficient balance: required ${ctx.required}, available ${ctx.available}`,
          {
            code: InvalidMoneyError.code,
            context: { required: cost, available: balance.amount }
          }
        )
      );
    }
    return Ok(new Order(price, qty));
  })
  .toResult();

// Обработка
if (orderResult.ok) {
  placeOrder(orderResult.value);
} else {
  if (InvalidPriceError.is(orderResult.error)) {
    showError('Invalid price', orderResult.error.context);
  } else if (InvalidQuantityError.is(orderResult.error)) {
    showError('Invalid quantity', orderResult.error.context);
  } else if (InvalidMoneyError.is(orderResult.error)) {
    showError('Insufficient funds', orderResult.error.context);
  }
}
```

---

## Паттерны обработки

### 1. Специфичная обработка по типу ошибки

```typescript
import {
  InvalidPriceError,
  InvalidQuantityError,
  TradingError
} from '@polymarket/errors';

try {
  const order = createOrder(price, quantity);
} catch (error) {
  // Обработка по конкретному типу
  if (InvalidPriceError.is(error)) {
    console.error('Price validation failed:', error.context);
    showUserError('Please enter a valid price between 0.0001 and 0.9999');
    return;
  }

  if (InvalidQuantityError.is(error)) {
    console.error('Quantity validation failed:', error.context);
    showUserError('Quantity must be positive');
    return;
  }

  // Общая обработка для TradingError
  if (error instanceof TradingError) {
    console.error('Trading error:', error.toJSON());
    showUserError('An error occurred. Please try again.');
    return;
  }

  // Неизвестная ошибка
  console.error('Unknown error:', error);
  throw error;
}
```

### 2. Обработка по severity

```typescript
import { TradingError } from '@polymarket/errors';

try {
  await executeTradeOperation();
} catch (error) {
  if (error instanceof TradingError) {
    switch (error.severity) {
      case 'low':
        // Логируем и показываем пользователю
        console.warn('Validation error:', error.toJSON());
        showUserError(error.message);
        break;

      case 'medium':
        // Логируем, показываем пользователю, отправляем метрики
        console.error('Business logic error:', error.toJSON());
        showUserError(error.message);
        metrics.increment(`errors.${error.code}`);
        break;

      case 'high':
        // Логируем, показываем, метрики, алерт команде
        console.error('Critical error:', error.toJSON());
        showUserError('A serious error occurred. Please contact support.');
        metrics.increment(`errors.${error.code}`);
        alertTeam(error);
        break;

      case 'critical':
        // Всё вышеперечисленное + экстренные меры
        console.error('CRITICAL ERROR:', error.toJSON());
        showUserError('System error. Trading is temporarily disabled.');
        metrics.increment(`errors.${error.code}`);
        alertTeam(error);
        disableTrading();
        break;
    }
  }
}
```

### 3. Обработка по коду ошибки

```typescript
import { InvalidPriceError, InvalidQuantityError } from '@polymarket/errors';

const result = validateOrder(orderData);

if (result.ok) {
  submitOrder(result.value);
} else {
  const error = result.error;
  // Обработка по коду
  switch (error.code) {
    case InvalidPriceError.code: // 'INVALID_PRICE'
      showFieldError('price', 'Price must be between 0.0001 and 0.9999');
      break;

    case InvalidQuantityError.code: // 'INVALID_QUANTITY'
      showFieldError('quantity', 'Quantity must be positive');
      break;

    default:
      showGeneralError('Validation failed. Please check your input.');
  }

  // Логирование для всех ошибок
  logger.error('Order validation failed', {
    code: error.code,
    context: error.context,
    timestamp: error.timestamp
  });
}
```

### 4. Обработка с fallback

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidPriceError } from '@polymarket/errors';

function getPriceOrDefault(input: number, defaultPrice: Price): Price {
  const result = Price.fromNumber(input);
  if (result.ok) {
    return result.value;
  } else {
    console.warn('Using default price due to error:', result.error.message);
    return defaultPrice;
  }
}

// Использование
const defaultPriceResult = Price.fromNumber(0.5);
if (!defaultPriceResult.ok) throw new Error('Invalid default price');
const price = getPriceOrDefault(userInput, defaultPriceResult.value);
```

### 5. Aggregate errors (множественные ошибки)

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';

type ValidationErrors = TradingError[];

function validateOrderFields(data: OrderData): Result<ValidatedOrder, ValidationErrors> {
  const errors: TradingError[] = [];

  const priceResult = validatePrice(data.price);
  if (!priceResult.ok) {
    errors.push(priceResult.error);
  }

  const qtyResult = validateQuantity(data.quantity);
  if (!qtyResult.ok) {
    errors.push(qtyResult.error);
  }

  const balanceResult = validateBalance(data.balance);
  if (!balanceResult.ok) {
    errors.push(balanceResult.error);
  }

  if (errors.length > 0) {
    return Err(errors);
  }

  return Ok({
    price: priceResult.value,
    quantity: qtyResult.value,
    balance: balanceResult.value
  });
}

// Использование
const result = validateOrderFields(formData);

if (result.ok) {
  submitOrder(result.value);
} else {
  // Показываем все ошибки пользователю
  result.error.forEach(error => {
    showFieldError(error.context?.field as string, error.message);
  });
}
```

---

## Логирование

### Структурированное логирование

```typescript
import { TradingError } from '@polymarket/errors';

class Logger {
  error(message: string, error: TradingError) {
    const logEntry = {
      level: 'error',
      message,
      error: error.toJSON(),
      // Дополнительные поля
      severity: error.severity,
      code: error.code,
      timestamp: error.timestamp.toISOString(),
      context: error.context
    };

    console.error(JSON.stringify(logEntry));

    // Отправка в систему логирования (например, Winston, Pino)
    this.transport.send(logEntry);
  }
}

// Использование
try {
  await placeOrder(order);
} catch (error) {
  if (error instanceof TradingError) {
    logger.error('Failed to place order', error);
  }
}
```

### Логирование с контекстом

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidPriceError } from '@polymarket/errors';

function validateAndLogPrice(value: number, orderId: string): Result<Price, InvalidPriceError> {
  const result = Price.fromNumber(value);

  if (result.ok) {
    logger.info('Price validated', {
      orderId,
      price: result.value.value
    });
  } else {
    logger.error('Price validation failed', {
      orderId,
      error: result.error.toJSON(),
      userInput: value
    });
  }

  return result;
}
```

---

## Мониторинг и метрики

### Счётчики ошибок

```typescript
import { TradingError } from '@polymarket/errors';

class ErrorMetrics {
  private metrics: MetricsClient;

  recordError(error: TradingError) {
    // Счётчик по коду ошибки
    if (error.code) {
      this.metrics.increment(`errors.${error.code}`);
    }

    // Счётчик по severity
    this.metrics.increment(`errors.severity.${error.severity}`);

    // Счётчик по имени класса
    this.metrics.increment(`errors.type.${error.name}`);

    // Таймстемп последней ошибки
    this.metrics.gauge(`errors.last_seen.${error.code}`, Date.now());
  }
}

// Использование
const metrics = new ErrorMetrics();

try {
  await executeOperation();
} catch (error) {
  if (error instanceof TradingError) {
    metrics.recordError(error);
  }
  throw error;
}
```

### Алерты по severity

```typescript
import { TradingError } from '@polymarket/errors';

class AlertManager {
  async handleError(error: TradingError) {
    if (error.severity === 'high' || error.severity === 'critical') {
      await this.sendAlert({
        title: `${error.severity.toUpperCase()} Error: ${error.name}`,
        message: error.message,
        code: error.code,
        context: error.context,
        timestamp: error.timestamp
      });
    }
  }

  private async sendAlert(alert: Alert) {
    // Отправка в Slack, PagerDuty, etc.
  }
}
```

### Dashboard метрик

Рекомендуется отслеживать:

1. **Error rate** - количество ошибок в секунду
2. **Error distribution** - распределение по severity
3. **Top errors** - самые частые ошибки по коду
4. **Error latency** - время от возникновения до обработки
5. **Recovery rate** - процент успешно обработанных ошибок

---

## Best Practices

### ✅ DO

1. **Используйте Result<T,E> для ожидаемых ошибок**

   ```typescript
   function validatePrice(value: number): Result<Price, InvalidPriceError>
   ```

2. **Используйте специфичные типы ошибок**

   ```typescript
   throw new InvalidPriceError(...) // ✅
   throw new Error('Invalid price') // ❌
   ```

3. **Включайте context для отладки**

   ```typescript
   { context: { value, min, max, field: 'price' } }
   ```

4. **Используйте коды ошибок**

   ```typescript
   { code: InvalidPriceError.code }
   ```

5. **Логируйте все ошибки**

   ```typescript
   logger.error('Operation failed', error.toJSON());
   ```

### ❌ DON'T

1. **Не глушите ошибки**

   ```typescript
   try { ... } catch (e) { /* nothing */ } // ❌
   ```

2. **Не используйте общие ошибки**

   ```typescript
   throw new Error('Something went wrong') // ❌
   ```

3. **Не включайте секреты в context**

   ```typescript
   { context: { password: '...' } } // ❌
   ```

4. **Не игнорируйте severity**

   ```typescript
   if (error.severity === 'critical') {
     console.log('oops'); // ❌ Нужны экстренные меры!
   }
   ```

5. **Не создавайте дубликаты кодов**

   ```typescript
   // Два разных класса с одним кодом - ❌
   InvalidPriceError.code === InvalidQuantityError.code
   ```

---

## См. также

- [Документация Result<T,E>](../../result/README.md)
- [Value Objects Errors](./value-objects/README.md)
- [Главная документация](./README.md)
