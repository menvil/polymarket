# Миграция со старого Quantity на новую архитектуру

> Пошаговое руководство по переходу на Quantity Value Object с Facade паттерном

## Содержание

1. [Обзор изменений](#обзор-изменений)
2. [Пошаговая миграция](#пошаговая-миграция)
3. [Сравнение API](#сравнение-api)
4. [Breaking Changes](#breaking-changes)
5. [Backward Compatibility](#backward-compatibility)
6. [Миграция по use case](#миграция-по-use-case)
7. [FAQ](#faq)

---

## Обзор изменений

### Что изменилось?

**Старый Quantity:**
- Прямое создание через конструктор или статические методы
- Исключения при невалидных значениях
- Нет явного управления ошибками

**Новый Quantity:**
- Создание через `QuantityService` (Facade)
- Возвращает `Result<Quantity, InvalidQuantityError>`
- Явное управление ошибками через `Result<T, E>`
- 4-слойная архитектура (Core → Rules → Facade → Adapters)

### Почему миграция?

1. **Type-safe error handling** — невозможно забыть обработать ошибку
2. **Explicit contracts** — видно какие ошибки могут произойти
3. **Better separation of concerns** — чёткое разделение слоёв
4. **Extensibility** — легко добавлять новые правила и операции
5. **Testability** — каждый слой тестируется независимо

---

## Пошаговая миграция

### Шаг 1: Обновите импорты

**Было:**
```typescript
import { Quantity } from '@polymarket/value-objects';
```

**Стало:**
```typescript
// Для основной работы
import { QuantityService, Quantity } from '@polymarket/value-objects/quantity';

// Для сериализации
import { QuantitySerializer, QuantityFormatter } from '@polymarket/value-objects/quantity';
```

### Шаг 2: Замените создание Quantity

**Было:**
```typescript
try {
  const qty = Quantity.of(10);
  // используем qty
} catch (error) {
  // обработка ошибки
}
```

**Стало:**
```typescript
const result = QuantityService.create(10);
if (!result.ok) {
  console.error(result.error.message);
  return;
}
const qty = result.value;
// используем qty
```

### Шаг 3: Обновите обработку ошибок

**Было:**
```typescript
try {
  const qty = Quantity.of(-1);
} catch (error) {
  if (error instanceof QuantityInvariantViolation) {
    console.error('Invalid quantity');
  }
}
```

**Стало:**
```typescript
const result = QuantityService.create(-1);
if (!result.ok) {
  // TypeScript заставляет проверить result.ok
  console.error(result.error.message);
  console.error(result.error.context?.reason); // 'NEGATIVE'
}
```

### Шаг 4: Используйте Facade для операций

Если в старом коде были прямые арифметические операции, замените их на `QuantityService`:

**Было (если были методы):**
```typescript
const sum = qty1.add(qty2); // Если бы такой метод был
```

**Стало:**
```typescript
const sumResult = QuantityService.add(qty1, qty2);
if (!sumResult.ok) {
  console.error(sumResult.error.message);
  return;
}
const sum = sumResult.value;
```

---

## Сравнение API

### Создание Quantity

| Старый способ | Новый способ |
|---------------|--------------|
| `new Quantity(10)` | `QuantityService.create(10)` |
| `Quantity.of(10)` (если был) | `QuantityService.create(10)` |
| `Quantity.fromDecimal(decimal)` | `QuantityService.create(decimal)` |

**Ключевое различие:** Новый способ возвращает `Result<T, E>`.

### Доступ к значению

| Старый способ | Новый способ |
|---------------|--------------|
| `qty.value()` | `qty.value()` ✅ (не изменилось) |
| `qty.toNumber()` | `qty.toNumber()` ✅ (не изменилось) |

### Сравнение

| Старый способ | Новый способ |
|---------------|--------------|
| `qty1.equals(qty2)` | `qty1.equals(qty2)` ✅ (не изменилось) |
| `qty.isZero()` | `qty.isZero()` ✅ (не изменилось) |
| `qty.isPositive()` | `qty.isPositive()` ✅ (не изменилось) |

### Константы

| Старый способ | Новый способ |
|---------------|--------------|
| `Quantity.ZERO` | `Quantity.ZERO` ✅ (не изменилось) |
| `Quantity.ONE` | `Quantity.ONE` ✅ (не изменилось) |

---

## Breaking Changes

### 1. Создание возвращает Result вместо throw

**До:**
```typescript
function createOrder(input: string) {
  try {
    const qty = new Quantity(input);
    return { success: true, quantity: qty };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
```

**После:**
```typescript
function createOrder(input: string) {
  const result = QuantityService.create(input);

  if (!result.ok) {
    return { success: false, error: result.error.message };
  }

  return { success: true, quantity: result.value };
}
```

### 2. Нет прямых арифметических методов на Quantity

Если в старом Quantity были методы типа `add()`, `subtract()`, они удалены.

**Используйте Facade:**
```typescript
// ❌ Старый способ (если был)
const sum = qty1.add(qty2);

// ✅ Новый способ
const sumResult = QuantityService.add(qty1, qty2);
if (sumResult.ok) {
  const sum = sumResult.value;
}
```

### 3. InvalidQuantityError вместо QuantityInvariantViolation

**До:**
```typescript
catch (error) {
  if (error instanceof QuantityInvariantViolation) {
    console.log(error.reason); // 'NEGATIVE' | 'NON_FINITE'
  }
}
```

**После:**
```typescript
if (!result.ok) {
  console.log(result.error.context?.reason); // 'NEGATIVE' | 'NON_FINITE'
  console.log(result.error.context?.op); // 'create' | 'add' | ...
}
```

---

## Backward Compatibility

### Старый Quantity.ts остаётся

Старый файл `Quantity.ts` **не удалён** для backward compatibility.

```typescript
// ✅ Это всё ещё работает
import { Quantity } from '@polymarket/value-objects';
const qty = Quantity.of(10);
```

### Новый API доступен по отдельному пути

```typescript
// ✅ Новый API по новому пути
import { QuantityService } from '@polymarket/value-objects/quantity';
```

### Постепенная миграция

Вы можете мигрировать постепенно:

1. **Phase 1:** Новый код использует `QuantityService`
2. **Phase 2:** Рефакторим критичные части старого кода
3. **Phase 3:** Полная миграция всего кода

---

## Миграция по use case

### Use Case 1: Парсинг пользовательского ввода

**Было:**
```typescript
function parseUserQuantity(input: string): Quantity | null {
  try {
    return new Quantity(input);
  } catch (error) {
    console.error('Invalid quantity');
    return null;
  }
}
```

**Стало:**
```typescript
function parseUserQuantity(input: string): Quantity | null {
  const result = QuantityService.create(input);

  if (!result.ok) {
    console.error('Invalid quantity:', result.error.message);
    return null;
  }

  return result.value;
}
```

**Улучшенный вариант (возвращаем Result):**
```typescript
function parseUserQuantity(input: string): Result<Quantity, InvalidQuantityError> {
  return QuantityService.create(input);
}

// Использование
const result = parseUserQuantity(userInput);
if (!result.ok) {
  showErrorToUser(result.error.message);
  return;
}
const qty = result.value;
```

### Use Case 2: Валидация ордера

**Было:**
```typescript
function validateOrderQuantity(input: string, minSize: number): boolean {
  try {
    const qty = new Quantity(input);
    return qty.value().greaterThanOrEqualTo(minSize);
  } catch (error) {
    return false;
  }
}
```

**Стало:**
```typescript
import Decimal from 'decimal.js';

function validateOrderQuantity(
  input: string,
  minSize: Decimal
): Result<Quantity, InvalidQuantityError> {
  return QuantityService.create(input);
}

// Использование
const result = validateOrderQuantity(userInput, new Decimal(1));
if (!result.ok) {
  console.error('Validation failed:', result.error.message);
  return;
}
const orderQty = result.value;
```

### Use Case 3: Вычисление суммы

**Было:**
```typescript
function calculateTotal(quantities: string[]): Quantity {
  let total = new Quantity(0);

  for (const qty of quantities) {
    try {
      const parsed = new Quantity(qty);
      total = new Quantity(total.value().plus(parsed.value()));
    } catch (error) {
      console.error('Failed to parse quantity:', qty);
    }
  }

  return total;
}
```

**Стало:**
```typescript
function calculateTotal(
  quantities: string[]
): Result<Quantity, InvalidQuantityError> {
  let total = Quantity.ZERO;

  for (const qtyStr of quantities) {
    // Парсим quantity
    const parseResult = QuantityService.create(qtyStr);
    if (!parseResult.ok) {
      return parseResult;
    }

    // Складываем
    const addResult = QuantityService.add(total, parseResult.value);
    if (!addResult.ok) {
      return addResult;
    }

    total = addResult.value;
  }

  return Ok(total);
}

// Использование
const result = calculateTotal(["10", "20", "30"]);
if (!result.ok) {
  console.error('Failed to calculate total:', result.error.message);
  return;
}
console.log(`Total: ${result.value.value()}`); // "60"
```

### Use Case 4: Округление к tick size

**Было:**
```typescript
import { round } from '@polymarket/math';

function roundQuantity(qty: Quantity, stepSize: number): Quantity {
  const rounded = round(qty.value().toNumber(), stepSize);
  return new Quantity(rounded);
}
```

**Стало:**
```typescript
import Decimal from 'decimal.js';

function roundQuantity(
  qty: Quantity,
  stepSize: Decimal
): Result<Quantity, InvalidQuantityError> {
  return QuantityService.roundToStep(qty, stepSize);
}

// Использование
const qty = Quantity.of("10.567");
const result = roundQuantity(qty, new Decimal("0.01"));

if (result.ok) {
  console.log(result.value.value().toString()); // "10.57"
}
```

### Use Case 5: Сериализация для API

**Было:**
```typescript
function serializeQuantity(qty: Quantity) {
  return {
    value: qty.value().toString()
  };
}

function deserializeQuantity(json: { value: string }): Quantity {
  return new Quantity(json.value);
}
```

**Стало:**
```typescript
import { QuantitySerializer } from '@polymarket/value-objects/quantity';

// Сериализация
const json = QuantitySerializer.toJSON(qty);

// Десериализация
const result = QuantitySerializer.fromJSON(json);
if (!result.ok) {
  console.error('Failed to deserialize:', result.error.message);
  return;
}
const qty = result.value;
```

### Use Case 6: Форматирование для UI

**Было:**
```typescript
function formatQuantity(qty: Quantity, decimals: number): string {
  return qty.value().toFixed(decimals);
}
```

**Стало:**
```typescript
import { QuantityFormatter } from '@polymarket/value-objects/quantity';

// Простое форматирование
const formatted = QuantityFormatter.toString(qty, 2);

// С K/M суффиксами для больших чисел
const display = QuantityFormatter.toDisplayString(qty);

// Компактный (убирает лишние нули)
const compact = QuantityFormatter.toCompactString(qty);
```

---

## FAQ

### Q: Нужно ли мигрировать весь код сразу?

**A:** Нет! Старый `Quantity.ts` остаётся для backward compatibility. Мигрируйте постепенно:

1. Новый код пишите с `QuantityService`
2. Рефакторите критичные части
3. Постепенно мигрируйте остальное

### Q: Что если я использую Quantity в тестах?

**A:** В тестах можно использовать прямое создание через `Quantity.of()`:

```typescript
// ✅ В тестах это OK
const qty = Quantity.of(10);
expect(qty.value().toNumber()).toBe(10);

// Но для user input используйте Facade
const result = QuantityService.create(userInput);
expect(result.ok).toBe(true);
```

### Q: Как обрабатывать ошибки в async функциях?

**A:** Возвращайте `Result<T, E>` из async функций:

```typescript
async function createOrder(
  input: string
): Promise<Result<Order, InvalidQuantityError>> {
  const qtyResult = QuantityService.create(input);

  if (!qtyResult.ok) {
    return Err(qtyResult.error);
  }

  const order = await orderService.create(qtyResult.value);
  return Ok(order);
}
```

### Q: Могу ли я использовать старый и новый Quantity вместе?

**A:** Да, они совместимы на уровне Core:

```typescript
// Старый способ
const oldQty = Quantity.of(10);

// Новый способ
const newResult = QuantityService.create(10);
if (newResult.ok) {
  const newQty = newResult.value;

  // ✅ Можно сравнивать
  oldQty.equals(newQty); // true

  // ✅ Можно использовать в операциях Facade
  QuantityService.add(oldQty, newQty);
}
```

### Q: Что делать с null checks?

**Было:**
```typescript
function process(qty: Quantity | null) {
  if (qty === null) {
    return;
  }
  // используем qty
}
```

**Стало:**
```typescript
function process(result: Result<Quantity, InvalidQuantityError>) {
  if (!result.ok) {
    console.error(result.error.message);
    return;
  }
  const qty = result.value;
  // используем qty
}
```

### Q: Как мигрировать большой модуль?

**План:**

1. **Шаг 1:** Добавьте новые импорты
```typescript
import { QuantityService } from '@polymarket/value-objects/quantity';
```

2. **Шаг 2:** Создайте wrapper функции
```typescript
function createQuantitySafe(value: string | number): Quantity | null {
  const result = QuantityService.create(value);
  return result.ok ? result.value : null;
}
```

3. **Шаг 3:** Постепенно заменяйте прямые вызовы на wrapper

4. **Шаг 4:** Рефакторите wrapper на полноценный Result<T, E>

### Q: Производительность изменилась?

**A:** Нет разницы для Core операций:

- `qty.value()` — zero-cost
- `qty.equals()` — zero-cost
- `QuantityService.create()` — идентичен старому `new Quantity()`

Facade добавляет минимальный overhead (обёртка в Result), но это negligible.

### Q: Как обрабатывать несколько ошибок?

**A:** Используйте early return или собирайте ошибки:

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidQuantityError } from '@polymarket/errors';
import { QuantityService, Quantity } from '@polymarket/value-objects/quantity';

// Early return (для первой ошибки)
function validateMultiple(values: string[]): Result<Quantity[], InvalidQuantityError> {
  const quantities: Quantity[] = [];

  for (const value of values) {
    const result = QuantityService.create(value);
    if (!result.ok) {
      return result; // Останавливаемся на первой ошибке
    }
    quantities.push(result.value);
  }

  return Ok(quantities);
}

// Собираем все ошибки
function validateAllWithErrors(values: string[]): {
  quantities: Quantity[];
  errors: InvalidQuantityError[];
} {
  const quantities: Quantity[] = [];
  const errors: InvalidQuantityError[] = [];

  for (const value of values) {
    const result = QuantityService.create(value);
    if (result.ok) {
      quantities.push(result.value);
    } else {
      errors.push(result.error);
    }
  }

  return { quantities, errors };
}
```

---

## Заключение

### Преимущества миграции

✅ **Type-safe error handling** — компилятор заставляет проверить ошибки
✅ **Explicit contracts** — видно какие ошибки могут произойти
✅ **Better error context** — context.op, context.reason, context.cause
✅ **Scalable architecture** — 4 слоя с чётким разделением
✅ **Testability** — легко тестировать каждый слой

### Миграция не срочная

Старый `Quantity.ts` остаётся работать. Мигрируйте постепенно, начиная с нового кода.

### Дополнительные ресурсы

- [README](./README.md) — обзор всей системы
- [Architecture](./architecture.md) — почему Throws+Facade
- [Facade API](./facade.md) — полный список методов QuantityService
- [Examples](./examples.md) — практические примеры

---

**Версия:** 0.1.0
**Последнее обновление:** 29 января 2026
