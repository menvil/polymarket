# Facade Layer — QuantityService API

> Единая точка входа для всех операций с Quantity

## Обзор

`QuantityService` — это фасад, который предоставляет type-safe API для работы с Quantity через `Result<T, E>`.

**Все методы возвращают `Result<Quantity, InvalidQuantityError>`**.

**Контракт "Never Throw":** ВСЕ методы QuantityService ГАРАНТИРОВАННО возвращают Result и НИКОГДА не бросают исключения.

---

## Facade Error Contract

Все ошибки из `QuantityService` содержат стандартный контекст:

```typescript
import { QuantityErrorReason } from '@polymarket/value-objects/quantity';

interface InvalidQuantityErrorContext {
  op: string;  // Название операции: 'create', 'add', 'divide', 'portion', 'increaseBy', etc. (ВСЕГДА присутствует)
  opChain?: string[];  // Цепочка вложенных операций для трассировки

  // Входные данные (операционные поля)
  value?: string;
  quantity?: string;
  quantity1?: string;
  quantity2?: string;
  divisor?: string;
  factor?: string;
  stepSize?: string;
  rate?: string;           // Для portion()
  delta?: string;          // Для increaseBy()
  roundingMode?: string;   // Для increaseBy()

  // Сырой ввод (для ошибок парсинга)
  raw?: {
    field: string;  // Имя поля: 'value', 'factor', 'divisor', 'stepSize', 'rate', 'delta'
    value: string;  // Сырое значение перед парсингом
  };

  // Причина из Core/Rules (типизированный enum)
  reason?: QuantityErrorReason;

  // Для math exceptions и unexpected errors
  cause?: {
    name: string;     // 'DivisionByZeroError', 'ArithmeticOverflowError', 'InvalidOperandError', 'UnknownError'
    message: string;
    stack?: string;   // Stack trace для отладки
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

**Оптимизация:** Если `value` уже `Decimal`, используется `of()` без повторного парсинга.

---

### Арифметика

#### `add(qty1: Quantity, qty2: Quantity)`

Складывает два Quantity.

```typescript
const qty1 = Quantity.of(new Decimal(10));
const qty2 = Quantity.of(new Decimal(5));

const result = QuantityService.add(qty1, qty2);
if (result.ok) {
  console.log(result.value.value().toNumber());  // 15
}

// Overflow detection
const huge = Quantity.of(new Decimal('1e308'));
const overflowResult = QuantityService.add(huge, huge);
if (!overflowResult.ok) {
  console.log(overflowResult.error.context?.reason);  // 'NON_FINITE'
}
```

#### `subtract(qty1: Quantity, qty2: Quantity)`

Вычитает qty2 из qty1 с проверкой неотрицательности результата.

```typescript
const qty1 = Quantity.of(new Decimal(10));
const qty2 = Quantity.of(new Decimal(5));

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

#### `multiply(quantity: Quantity, factor: number | string | Decimal)`

Умножает Quantity на коэффициент.

```typescript
const qty = Quantity.of(new Decimal(10));

// Успех (number)
const result = QuantityService.multiply(qty, 2);
if (result.ok) {
  console.log(result.value.value().toNumber());  // 20
}

// С Decimal
const decimal = QuantityService.multiply(qty, new Decimal(2.5));
if (decimal.ok) {
  console.log(decimal.value.value().toNumber());  // 25
}

// С string (для высокой точности)
const stringResult = QuantityService.multiply(qty, "2.5");
if (stringResult.ok) {
  console.log(stringResult.value.value().toNumber());  // 25
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

// Ошибка: invalid string
const invalid = QuantityService.multiply(qty, "abc");
if (!invalid.ok) {
  console.log(invalid.error.context?.op);  // 'multiply'
  console.log(invalid.error.context?.raw); // { field: 'factor', value: 'abc' }
  console.log(invalid.error.context?.factor); // 'abc'
}
```

#### `divide(quantity: Quantity, divisor: number | string | Decimal)`

Делит Quantity на делитель.

```typescript
const qty = Quantity.of(new Decimal(10));

// Успех (number)
const result = QuantityService.divide(qty, 2);
if (result.ok) {
  console.log(result.value.value().toNumber());  // 5
}

// С string (для высокой точности)
const stringResult = QuantityService.divide(qty, "2.5");
if (stringResult.ok) {
  console.log(stringResult.value.value().toNumber());  // 4
}

// С Decimal
const decimalResult = QuantityService.divide(qty, new Decimal(2));
if (decimalResult.ok) {
  console.log(decimalResult.value.value().toNumber());  // 5
}

// Ошибка: division by zero
const zero = QuantityService.divide(qty, 0);
if (!zero.ok) {
  console.log(zero.error.context?.op);     // 'divide'
  console.log(zero.error.context?.cause);  // { name: 'DivisionByZeroError', message: '...' }
}

// Ошибка: negative divisor
const neg = QuantityService.divide(qty, -1);
if (!neg.ok) {
  console.log(neg.error.message);  // "... must be positive"
}

// Ошибка: invalid string
const invalid = QuantityService.divide(qty, "abc");
if (!invalid.ok) {
  console.log(invalid.error.context?.op);     // 'divide'
  console.log(invalid.error.context?.raw);    // { field: 'divisor', value: 'abc' }
  console.log(invalid.error.context?.divisor); // 'abc'
}
```

**Обработка math exceptions:**

`divide()` ловит ВСЕ исключения и возвращает Result (контракт "Never Throw"):

- `DivisionByZeroError` → `Result.Err` с `context.cause`
- `InvalidOperandError` → `Result.Err` с `context.cause`
- `ArithmeticOverflowError` → `Result.Err` с `context.cause`
- Неожиданные ошибки → `Result.Err` с `context.cause` (UnknownError)

---

### Округление

#### `roundToStep(quantity, stepSize: number | string | Decimal, roundingMode?)`

Округляет Quantity к размеру шага (step).

```typescript
const qty = Quantity.of(new Decimal("10.567"));

// С number
const result1 = QuantityService.roundToStep(qty, 0.01);
if (result1.ok) {
  console.log(result1.value.value().toString());  // "10.57"
}

// С string (для высокой точности)
const result2 = QuantityService.roundToStep(qty, "0.01");
if (result2.ok) {
  console.log(result2.value.value().toString());  // "10.57"
}

// С Decimal
const stepSize = new Decimal("0.01");
const result3 = QuantityService.roundToStep(qty, stepSize);
if (result3.ok) {
  console.log(result3.value.value().toString());  // "10.57"
}

// С указанным режимом
const down = QuantityService.roundToStep(
  qty,
  "0.01",
  Decimal.ROUND_DOWN
);
if (down.ok) {
  console.log(down.value.value().toString());  // "10.56"
}

// Ошибка: invalid stepSize
const invalid = QuantityService.roundToStep(qty, 0);
if (!invalid.ok) {
  console.log(invalid.error.message);  // "... must be positive"
}

// Ошибка: invalid string
const invalidStr = QuantityService.roundToStep(qty, "abc");
if (!invalidStr.ok) {
  console.log(invalidStr.error.context?.op);       // 'roundToStep'
  console.log(invalidStr.error.context?.raw);      // { field: 'stepSize', value: 'abc' }
  console.log(invalidStr.error.context?.stepSize); // 'abc'
}
```

#### `portion(quantity: Quantity, rate: Ratio)`

Вычисляет часть (долю) от количества по заданному коэффициенту.

**Формула:** `quantity × rate`

**Use cases:**
- Вычисление комиссий (например, 0.5% от суммы)
- Расчет частичного заполнения ордера (заполнено 75%)
- Алгоритмы ребалансировки портфеля

```typescript
import { QuantityService, RatioService } from '@polymarket/value-objects';

// Вычисление комиссии 0.5% от 1000
const position = QuantityService.create(new Decimal(1000));
const feeRate = RatioService.fromPercent(0.5);
if (position.ok && feeRate.ok) {
  const fee = QuantityService.portion(position.value, feeRate.value);
  if (fee.ok) {
    console.log(fee.value.value().toString()); // "5" (0.5% от 1000)
  }
}

// Частичное заполнение ордера (75%)
const orderSize = QuantityService.create(new Decimal(100));
const fillRate = RatioService.fromPercent(75);
if (orderSize.ok && fillRate.ok) {
  const filled = QuantityService.portion(orderSize.value, fillRate.value);
  if (filled.ok) {
    console.log(filled.value.value().toString()); // "75"
  }
}

// Увеличение на 150%
const base = QuantityService.create(new Decimal(1000));
const rate150 = RatioService.fromPercent(150);
if (base.ok && rate150.ok) {
  const result = QuantityService.portion(base.value, rate150.value);
  if (result.ok) {
    console.log(result.value.value().toString()); // "1500" (150% от 1000)
  }
}
```

**Ошибки:**
- `INVALID_FORMAT` — некорректный rate
- `NON_FINITE` — overflow/underflow в вычислениях
- `NEGATIVE` — результат отрицательный (если rate < 0)

#### `increaseBy(quantity: Quantity, delta: Ratio, stepSize, options?)`

Увеличивает/уменьшает количество на заданный процент с округлением к stepSize.

**Формула:** `quantity × (1 + delta)` → округление к stepSize

**Параметры:**
- `quantity` — исходное количество
- `delta` — относительное изменение (Ratio), может быть отрицательным
- `stepSize` — размер шага для округления результата
- `options.roundingMode` — режим округления (по умолчанию ROUND_HALF_UP)

**Use cases:**
- Увеличение ордера на X%
- DCA (dollar-cost averaging) стратегии
- Position sizing с учётом минимального лота

**Delta может быть отрицательным:**
- Положительный: увеличение (+10% → delta = 0.10)
- Отрицательный: уменьшение (-5% → delta = -0.05)
- Ограничение: delta ≥ -1 (иначе результат отрицательный)

```typescript
import { QuantityService, RatioService } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

// Увеличить на 10% с округлением к шагу 1
const qty = QuantityService.create(new Decimal(95));
const delta = RatioService.fromPercent(10);
if (qty.ok && delta.ok) {
  const result = QuantityService.increaseBy(qty.value, delta.value, 1);
  if (result.ok) {
    console.log(result.value.value().toString()); // "105" (95 × 1.10 = 104.5 → round to 105)
  }
}

// Уменьшить на 5% (отрицательный delta)
const decrease = RatioService.fromPercent(-5);
if (qty.ok && decrease.ok) {
  const result = QuantityService.increaseBy(qty.value, decrease.value, 1);
  if (result.ok) {
    console.log(result.value.value().toString()); // "90" (95 × 0.95 = 90.25 → round to 90)
  }
}

// С округлением вниз (conservative для покупок)
if (qty.ok && delta.ok) {
  const result = QuantityService.increaseBy(
    qty.value,
    delta.value,
    1,
    { roundingMode: Decimal.ROUND_DOWN }
  );
  if (result.ok) {
    console.log(result.value.value().toString()); // "104" (95 × 1.10 = 104.5 → floor to 104)
  }
}

// DCA стратегия: увеличивать на 10% каждый раз
const baseSize = QuantityService.create(new Decimal(100));
const increment = RatioService.fromPercent(10);
if (baseSize.ok && increment.ok) {
  const order1 = baseSize.value; // 100
  const order2Result = QuantityService.increaseBy(order1, increment.value, 1);
  if (order2Result.ok) {
    const order2 = order2Result.value; // 110
    const order3Result = QuantityService.increaseBy(order2, increment.value, 1);
    if (order3Result.ok) {
      console.log(order3Result.value.value().toString()); // "121"
    }
  }
}
```

**Edge cases:**
- delta = 0 → количество остаётся неизменным (после округления к step)
- delta = -1 (-100%) → результат = 0 (граничный случай)
- delta < -1 (< -100%) → результат отрицательный → InvalidQuantityError

**Ошибки:**
- `INVALID_FORMAT` — некорректный delta или stepSize
- `INVALID_STEP_SIZE` — stepSize ≤ 0
- `NON_FINITE` — overflow/underflow в вычислениях
- `NEGATIVE` — результат отрицательный (delta < -1)

---

## Паттерны использования

### Pattern 1: Create + Validate

```typescript
async function createOrder(input: string) {
  // Парсим и валидируем
  const result = QuantityService.create(input);

  if (!result.ok) {
    // Показываем пользователю понятную ошибку
    throw new ValidationError(result.error.message);
  }

  // Используем валидную quantity
  const orderQty = result.value;
  await orderService.placeOrder({ quantity: orderQty });
}
```

### Pattern 2: Calculate

```typescript
function calculateRemaining(current: Quantity, trade: Quantity) {
  // Вычисляем остаток
  const result = QuantityService.subtract(current, trade);

  if (!result.ok) {
    // Невозможная операция: trade > current
    return Result.err(new TradeTooLargeError());
  }

  return Result.ok(result.value);
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

## Гарантии контракта

### Контракт "Never Throw"

**Гарантия:** ВСЕ методы QuantityService НИКОГДА не бросают исключения.

```typescript
// ✅ Всегда безопасно - никогда не throw
const result = QuantityService.create(NaN);
expect(() => QuantityService.create(NaN)).not.toThrow();

const result2 = QuantityService.divide(qty, 0);
expect(() => QuantityService.divide(qty, 0)).not.toThrow();

const result3 = QuantityService.multiply(qty, "invalid");
expect(() => QuantityService.multiply(qty, "invalid")).not.toThrow();
```

### Контракт ошибок

**Parse fail гарантии:**

- Всегда содержит `context.op`
- Всегда содержит `context.raw` (сырой ввод в toDecimal)
- Всегда содержит операционный параметр (`factor`, `divisor`, `stepSize`)
- Всегда содержит `context.cause` с информацией об ошибке парсинга

```typescript
const result = QuantityService.multiply(qty, "invalid");
if (!result.ok) {
  expect(result.error.context?.op).toBe('multiply');
  expect(result.error.context?.raw).toBeDefined();
  expect(result.error.context?.factor).toBeDefined();
  expect(result.error.context?.cause).toBeDefined();
}
```

**Rule fail гарантии:**

- Всегда содержит `context.op`
- Всегда содержит операционные поля (`quantity`, `quantity1`, `quantity2`, `factor`, `divisor`, `stepSize`)
- Может содержать `context.reason` для инвариантов Core
- Может содержать `context.result` для rule failures

```typescript
const result = QuantityService.subtract(Quantity.of(new Decimal(5)), Quantity.of(new Decimal(10)));
if (!result.ok) {
  expect(result.error.context?.op).toBe('subtract');
  expect(result.error.context?.quantity1).toBeDefined();
  expect(result.error.context?.quantity2).toBeDefined();
  expect(result.error.context?.result).toBeDefined();
}
```

**Math exception гарантии:**

- Всегда содержит `context.op`
- Всегда содержит `context.cause.name`
- Всегда содержит `context.cause.message`
- Может содержать `context.cause.stack` для отладки

```typescript
const result = QuantityService.divide(qty, 0);
if (!result.ok) {
  expect(result.error.context?.op).toBe('divide');
  expect(result.error.context?.cause?.name).toBe('DivisionByZeroError');
  expect(result.error.context?.cause?.message).toBeDefined();
}
```

---

## Performance Tips

### 1. Переиспользуйте Decimal

```typescript
// ❌ Медленно: парсит из строки дважды
const result1 = QuantityService.create("123.456");  // парсинг строки → Decimal
const result2 = QuantityService.create("123.456");  // парсинг строки → Decimal снова

// ✅ Быстро: parse один раз, потом zero-copy
const decimal = new Decimal("123.456");             // парсинг один раз
const result1 = QuantityService.create(decimal);    // zero-copy (fromDecimal)
const result2 = QuantityService.create(decimal);    // zero-copy (fromDecimal)
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
      const qty1 = Quantity.of(new Decimal(10));
      const qty2 = Quantity.of(new Decimal(5));
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
