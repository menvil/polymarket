# Facade Layer — QuantityService API

> Единая точка входа для всех операций с Quantity

## Обзор

`QuantityService` — это фасад, который предоставляет type-safe API для работы с Quantity через `Result<T, E>`.

**Все методы возвращают `Result<Quantity, InvalidQuantityError>`** (кроме `validateForPosition` который возвращает `Result<void, InvalidQuantityError>`).

---

## Facade Error Contract

Все ошибки из `QuantityService` содержат стандартный контекст:

```typescript
interface InvalidQuantityErrorContext {
  op: string;  // Название операции: 'create', 'add', 'divide', etc.

  // Входные данные
  value?: string;
  quantity?: string;
  quantity1?: string;
  quantity2?: string;
  divisor?: string;
  factor?: string;
  tickSize?: string;
  minSize?: string;

  // Причина из Core/Rules
  reason?: 'NEGATIVE' | 'NON_FINITE';

  // Для math exceptions
  cause?: {
    name: string;     // 'DivisionByZeroError', 'ArithmeticOverflowError'
    message: string;
  };
}
```

**Пример использования:**
```typescript
const result = QuantityService.divide(qty, 0);
if (!result.ok) {
  console.log(result.error.context?.op);      // 'divide'
  console.log(result.error.context?.divisor); // '0'
  console.log(result.error.context?.cause);   // { name: '...', message: '...' }
}
```

---

## API Методы

### Создание

#### `create(value: number | string | Decimal)`

Создаёт Quantity с валидацией инвариантов.

```typescript
// Успех
const result = QuantityService.create(10);
if (result.ok) {
  const qty: Quantity = result.value;
  console.log(qty.value().toString());  // "10"
}

// Ошибка: negative
const negResult = QuantityService.create(-1);
if (!negResult.ok) {
  console.log(negResult.error.context?.op);     // 'create'
  console.log(negResult.error.context?.reason); // 'NEGATIVE'
}

// Ошибка: non-finite
const nanResult = QuantityService.create(NaN);
if (!nanResult.ok) {
  console.log(nanResult.error.context?.reason); // 'NON_FINITE'
}
```

**Оптимизация:** Если `value` уже `Decimal`, используется `fromDecimal()` без повторного парсинга.

#### `createForOrder(value, orderMinSize: Decimal)`

Создаёт Quantity для ордера с проверкой `minSize`.

```typescript
const ORDER_MIN_SIZE = new Decimal(1);

// Успех
const result = QuantityService.createForOrder(10, ORDER_MIN_SIZE);
if (result.ok) {
  console.log('Order quantity valid');
}

// Ошибка: quantity < minSize
const tooSmall = QuantityService.createForOrder(0.5, ORDER_MIN_SIZE);
if (!tooSmall.ok) {
  console.log(tooSmall.error.context?.op);      // 'createForOrder'
  console.log(tooSmall.error.context?.minSize); // '1'
  console.log(tooSmall.error.message);          // "... less than minimum size ..."
}
```

---

### Арифметика

#### `add(qty1: Quantity, qty2: Quantity)`

Складывает два Quantity.

```typescript
const qty1 = Quantity.of(10);
const qty2 = Quantity.of(5);

const result = QuantityService.add(qty1, qty2);
if (result.ok) {
  console.log(result.value.value().toNumber());  // 15
}

// Overflow detection
const huge = Quantity.fromDecimal(new Decimal('1e308'));
const overflowResult = QuantityService.add(huge, huge);
if (!overflowResult.ok) {
  console.log(overflowResult.error.context?.reason);  // 'NON_FINITE'
}
```

#### `subtract(qty1: Quantity, qty2: Quantity)`

Вычитает qty2 из qty1 с проверкой неотрицательности результата.

```typescript
const qty1 = Quantity.of(10);
const qty2 = Quantity.of(5);

// Успех
const result = QuantityService.subtract(qty1, qty2);
if (result.ok) {
  console.log(result.value.value().toNumber());  // 5
}

// Ошибка: negative result
const negResult = QuantityService.subtract(qty2, qty1);
if (!negResult.ok) {
  console.log(negResult.error.context?.op);     // 'subtract'
  console.log(negResult.error.message);         // "... cannot be negative"
}

// OK: zero result
const zeroResult = QuantityService.subtract(qty1, qty1);
if (zeroResult.ok) {
  console.log(zeroResult.value.isZero());  // true
}
```

#### `multiply(quantity: Quantity, factor: number | Decimal)`

Умножает Quantity на коэффициент.

```typescript
const qty = Quantity.of(10);

// Успех
const result = QuantityService.multiply(qty, 2);
if (result.ok) {
  console.log(result.value.value().toNumber());  // 20
}

// С Decimal
const decimal = QuantityService.multiply(qty, new Decimal(2.5));
if (decimal.ok) {
  console.log(decimal.value.value().toNumber());  // 25
}

// Умножение на 0 OK
const zero = QuantityService.multiply(qty, 0);
if (zero.ok) {
  console.log(zero.value.isZero());  // true
}

// Ошибка: negative factor
const neg = QuantityService.multiply(qty, -1);
if (!neg.ok) {
  console.log(neg.error.message);  // "... cannot be negative"
}
```

#### `divide(quantity: Quantity, divisor: number | Decimal)`

Делит Quantity на делитель.

```typescript
const qty = Quantity.of(10);

// Успех
const result = QuantityService.divide(qty, 2);
if (result.ok) {
  console.log(result.value.value().toNumber());  // 5
}

// Ошибка: division by zero
const zero = QuantityService.divide(qty, 0);
if (!zero.ok) {
  console.log(zero.error.context?.op);  // 'divide'
  // Может быть cause от DivisionByZeroError
}

// Ошибка: negative divisor
const neg = QuantityService.divide(qty, -1);
if (!neg.ok) {
  console.log(neg.error.message);  // "... must be positive"
}
```

**Обработка math exceptions:**

`divide()` ловит только ожидаемые исключения:
- `DivisionByZeroError` → `Result.Err` с `context.cause`
- `ArithmeticOverflowError` → `Result.Err` с `context.cause`
- Другие ошибки → rethrow (это баги)

---

### Округление

#### `roundToTick(quantity, tickSize: Decimal, roundingMode?)`

Округляет Quantity к размеру тика.

```typescript
const qty = Quantity.of("10.567");
const tickSize = new Decimal("0.01");

// Default: ROUND_HALF_UP
const result = QuantityService.roundToTick(qty, tickSize);
if (result.ok) {
  console.log(result.value.value().toString());  // "10.57"
}

// С указанным режимом
const down = QuantityService.roundToTick(
  qty,
  tickSize,
  Decimal.ROUND_DOWN
);
if (down.ok) {
  console.log(down.value.value().toString());  // "10.56"
}

// Ошибка: invalid tickSize
const invalid = QuantityService.roundToTick(qty, new Decimal(0));
if (!invalid.ok) {
  console.log(invalid.error.message);  // "... must be positive"
}
```

---

### Валидация

#### `validateForPosition(quantity: Quantity)`

Валидирует Quantity для использования в позиции.

```typescript
// Позиция > 0: OK
const active = QuantityService.validateForPosition(Quantity.of(10));
if (active.ok) {
  console.log('Position valid');
}

// Позиция = 0: OK (closed position)
const closed = QuantityService.validateForPosition(Quantity.ZERO);
if (closed.ok) {
  console.log('Closed position valid');
}

// Negative невозможен (Core инвариант)
// Quantity.of(-1) бросит исключение, до validateForPosition не дойдёт
```

**Примечание:** Этот метод всегда возвращает `Ok` для валидного `Quantity`, так как Core уже гарантирует >= 0.

---

## Паттерны использования

### Pattern 1: Create + Validate

```typescript
async function createOrder(input: string, minSize: Decimal) {
  // Парсим и валидируем
  const result = QuantityService.createForOrder(input, minSize);

  if (!result.ok) {
    // Показываем пользователю понятную ошибку
    throw new ValidationError(result.error.message);
  }

  // Используем валидную quantity
  const orderQty = result.value;
  await orderService.placeOrder({ quantity: orderQty });
}
```

### Pattern 2: Calculate + Validate

```typescript
function calculateRemaining(current: Quantity, trade: Quantity) {
  // Вычисляем остаток
  const result = QuantityService.subtract(current, trade);

  if (!result.ok) {
    // Невозможная операция: trade > current
    return Result.err(new TradeTooLargeError());
  }

  const remaining = result.value;

  // Проверяем что можно использовать как позицию
  const validateResult = QuantityService.validateForPosition(remaining);

  return Result.ok(remaining);
}
```

### Pattern 3: Chain operations

```typescript
function processTradeChain(position: Quantity, trades: Quantity[]) {
  let current = position;

  for (const trade of trades) {
    const result = QuantityService.subtract(current, trade);

    if (!result.ok) {
      return Result.err(`Trade failed at ${trade}: ${result.error.message}`);
    }

    current = result.value;
  }

  return Result.ok(current);
}
```

### Pattern 4: Early return on error

```typescript
function calculatePosition(initial: string, buys: string[], sells: string[]) {
  // Создаём начальную позицию
  const initResult = QuantityService.create(initial);
  if (!initResult.ok) return initResult;

  let position = initResult.value;

  // Добавляем покупки
  for (const buy of buys) {
    const buyResult = QuantityService.create(buy);
    if (!buyResult.ok) return buyResult;

    const addResult = QuantityService.add(position, buyResult.value);
    if (!addResult.ok) return addResult;

    position = addResult.value;
  }

  // Вычитаем продажи
  for (const sell of sells) {
    const sellResult = QuantityService.create(sell);
    if (!sellResult.ok) return sellResult;

    const subtractResult = QuantityService.subtract(position, sellResult.value);
    if (!subtractResult.ok) return subtractResult;

    position = subtractResult.value;
  }

  return Result.ok(position);
}
```

---

## Error Handling Best Practices

### 1. Проверяйте `result.ok` всегда

```typescript
// ✅ Правильно
const result = QuantityService.create(value);
if (!result.ok) {
  // TypeScript заставляет проверить
  console.error(result.error.message);
  return;
}
const qty = result.value;

// ❌ Неправильно (не скомпилируется)
const qty = QuantityService.create(value).value;  // TS error: value не существует на Result
```

### 2. Используйте context для деталей

```typescript
const result = QuantityService.divide(qty, divisor);
if (!result.ok) {
  const ctx = result.error.context;

  // Логируем для отладки
  logger.error('Division failed', {
    op: ctx?.op,
    quantity: ctx?.quantity,
    divisor: ctx?.divisor,
    cause: ctx?.cause
  });

  // Показываем пользователю
  if (ctx?.cause?.name === 'DivisionByZeroError') {
    showError('Cannot divide by zero');
  } else {
    showError('Invalid division operation');
  }
}
```

### 3. Не игнорируйте ошибки

```typescript
// ❌ Плохо: игнорируем ошибки
const result = QuantityService.add(qty1, qty2);
if (result.ok) {
  doSomething(result.value);
}
// Что если !ok? Молча провалится

// ✅ Хорошо: явная обработка
const result = QuantityService.add(qty1, qty2);
if (!result.ok) {
  handleError(result.error);
  return;
}
doSomething(result.value);
```

---

## Performance Tips

### 1. Переиспользуйте Decimal

```typescript
// ❌ Медленно: парсит дважды
const decimal = new Decimal(value);
const result1 = QuantityService.create(decimal);  // parse
const result2 = QuantityService.create(decimal);  // parse

// ✅ Быстро: parse один раз, потом zero-copy
const decimal = new Decimal(value);
const result1 = QuantityService.create(decimal);  // Внутри: fromDecimal()
```

### 2. Кешируйте константы

```typescript
// ✅ Хорошо
const ZERO = Quantity.ZERO;
const ONE = Quantity.ONE;

if (qty.equals(ZERO)) { ... }
```

### 3. Batch операции

```typescript
// ❌ Медленно: много отдельных проверок
for (const value of values) {
  const result = QuantityService.create(value);
  if (!result.ok) return result;
}

// ✅ Быстрее: валидируем всё сразу
const results = values.map(v => QuantityService.create(v));
const errors = results.filter(r => !r.ok);
if (errors.length > 0) {
  return Result.err(new BatchValidationError(errors));
}
```

---

## Тестирование

```typescript
import { QuantityService, Quantity } from '@polymarket/value-objects/quantity';

describe('QuantityService', () => {
  describe('create', () => {
    it('should create valid quantity', () => {
      const result = QuantityService.create(10);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(10);
      }
    });

    it('should return error for negative', () => {
      const result = QuantityService.create(-1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.op).toBe('create');
        expect(result.error.context?.reason).toBe('NEGATIVE');
      }
    });
  });

  describe('add', () => {
    it('should add two quantities', () => {
      const qty1 = Quantity.of(10);
      const qty2 = Quantity.of(5);
      const result = QuantityService.add(qty1, qty2);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(15);
      }
    });
  });
});
```

---

## Дальнейшее чтение

- [Core Layer](./core.md) — внутреннее устройство Quantity
- [Примеры](./examples.md) — реальные use cases
- [Архитектура](./architecture.md) — почему Facade возвращает Result
