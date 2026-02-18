# Core Layer — Quantity Value Object

> Базовый иммутабельный value object с инвариантами

## Обзор

Core Layer содержит базовую реализацию `Quantity` — иммутабельного value object для представления количества.

**Ключевые принципы:**

- Иммутабельность — все операции возвращают новые экземпляры
- Инварианты — значение всегда finite и non-negative
- Типизированные исключения — `QuantityInvariantViolation`

---

## Quantity

### Инварианты

`Quantity` гарантирует два инварианта:

1. **Finite** — значение не может быть `NaN` или `Infinity`
2. **Non-negative** — значение должно быть >= 0

При нарушении инварианта кидается `QuantityInvariantViolation` с `reason`:

- `'NAN'` — для NaN
- `'NON_FINITE'` — для Infinity/-Infinity
- `'NEGATIVE'` — для отрицательных значений

### Создание

#### `Quantity.of(value)`

Создаёт Quantity из Decimal.

**Оптимизация:** Использует zero-copy - напрямую сохраняет переданный Decimal без копирования.

```typescript
const qty1 = Quantity.of(new Decimal(10));
const qty2 = Quantity.of(new Decimal("10.5"));

// Throws QuantityInvariantViolation
try {
  const invalid = Quantity.of(new Decimal(-1));  // reason: 'NEGATIVE'
} catch (e) {
  console.log(e.reason);  // 'NEGATIVE'
}

try {
  const invalid = Quantity.of(new Decimal(NaN));  // reason: 'NAN'
} catch (e) {
  console.log(e.reason);  // 'NAN'
}
```

### Константы

```typescript
Quantity.ZERO  // Quantity со значением 0
Quantity.ONE   // Quantity со значением 1
```

**Пример:**

```typescript
if (remaining.equals(Quantity.ZERO)) {
  console.log('Position closed');
}
```

---

## API Методы

### `value(): Decimal`

Возвращает внутреннее Decimal значение.

```typescript
const qty = Quantity.of(new Decimal(10));
const decimal: Decimal = qty.value();
console.log(decimal.toString());  // "10"
```

### `toNumber(): number`

Конвертирует в number (lossy для больших чисел).

```typescript
const qty = Quantity.of(new Decimal("10.5"));
const num: number = qty.toNumber();  // 10.5

// ⚠️ Lossy для больших чисел
const big = Quantity.of(new Decimal("999999999999999999999"));
console.log(big.toNumber());  // Может потерять точность!
```

**Когда использовать:** Только для UI/display, не для вычислений.

### `equals(other: Quantity): boolean`

Сравнивает два Quantity на равенство.

```typescript
const qty1 = Quantity.of(new Decimal(10));
const qty2 = Quantity.of(new Decimal("10.0"));
const qty3 = Quantity.of(new Decimal(5));

qty1.equals(qty2);  // true
qty1.equals(qty3);  // false
```

### `isZero(): boolean`

Проверяет что значение равно нулю.

```typescript
Quantity.ZERO.isZero();    // true
Quantity.of(new Decimal(0)).isZero();   // true
Quantity.of(new Decimal(10)).isZero();  // false
```

### `isPositive(): boolean`

Проверяет что значение строго больше нуля.

```typescript
Quantity.of(new Decimal(10)).isPositive();   // true
Quantity.of(new Decimal(0)).isPositive();    // false (ноль не positive)
Quantity.ZERO.isPositive();     // false
```

### `isLessThan(other: Quantity): boolean`

Проверяет что это количество меньше другого.

```typescript
const qty1 = Quantity.of(new Decimal(5));
const qty2 = Quantity.of(new Decimal(10));

qty1.isLessThan(qty2);  // true
qty2.isLessThan(qty1);  // false
qty1.isLessThan(qty1);  // false (равны)
```

### `isLessThanOrEqual(other: Quantity): boolean`

Проверяет что это количество меньше или равно другому.

```typescript
const qty1 = Quantity.of(new Decimal(5));
const qty2 = Quantity.of(new Decimal(10));

qty1.isLessThanOrEqual(qty2);  // true
qty2.isLessThanOrEqual(qty1);  // false
qty1.isLessThanOrEqual(qty1);  // true (равны)
```

### `isGreaterThan(other: Quantity): boolean`

Проверяет что это количество больше другого.

```typescript
const qty1 = Quantity.of(new Decimal(10));
const qty2 = Quantity.of(new Decimal(5));

qty1.isGreaterThan(qty2);  // true
qty2.isGreaterThan(qty1);  // false
qty1.isGreaterThan(qty1);  // false (равны)
```

### `isGreaterThanOrEqual(other: Quantity): boolean`

Проверяет что это количество больше или равно другому.

```typescript
const qty1 = Quantity.of(new Decimal(10));
const qty2 = Quantity.of(new Decimal(5));

qty1.isGreaterThanOrEqual(qty2);  // true
qty2.isGreaterThanOrEqual(qty1);  // false
qty1.isGreaterThanOrEqual(qty1);  // true (равны)
```

---

## QuantityInvariantViolation

Типизированное исключение для нарушений инвариантов.

### Поля

```typescript
class QuantityInvariantViolation extends Error {
  readonly reason: 'NEGATIVE' | 'NON_FINITE' | 'NAN';
  constructor(message: string, reason: 'NEGATIVE' | 'NON_FINITE' | 'NAN');
}
```

### Пример обработки

```typescript
const value = new Decimal(-1); // Пример невалидного значения

try {
  const qty = Quantity.of(value);
} catch (error) {
  if (error instanceof QuantityInvariantViolation) {
    switch (error.reason) {
      case 'NEGATIVE':
        console.error('Value cannot be negative');
        break;
      case 'NON_FINITE':
        console.error('Value must be finite (Infinity)');
        break;
      case 'NAN':
        console.error('Value cannot be NaN');
        break;
    }
  }
}
```

---

## Паттерны использования

### ✅ Правильно: Используйте через Facade

```typescript
import { QuantityService } from '@polymarket/value-objects/quantity';

const value = 10; // Пример: создаём Quantity из number

const result = QuantityService.create(value);
if (!result.ok) {
  // Type-safe error handling
  console.error(result.error.context.reason);
  return;
}
const qty = result.value;
```

### ❌ Неправильно: Прямое создание в user code

```typescript
// НЕ делайте так в application code
try {
  const qty = Quantity.of(userInput);  // Может бросить
} catch (e) {
  // Легко забыть обработать
}
```

**Исключение:** Можно использовать напрямую в тестах или когда значение гарантированно валидно.

```typescript
// ✅ В тестах это OK
const qty = Quantity.of(new Decimal(10));
```

---

## Zero-copy оптимизация

`Quantity.of()` использует zero-copy для Decimal:

```typescript
const value = 10;
const decimal = new Decimal(value);

// ✅ Оба вызова используют zero-copy
const qty1 = Quantity.of(decimal);  // Напрямую использует тот же объект
const qty2 = Quantity.of(decimal);  // Напрямую использует тот же объект

// Проверяем что это тот же Decimal
console.log(qty1.value() === decimal); // true
console.log(qty2.value() === decimal); // true
```

**Когда передавать Decimal в `of()`:**

- Когда важна семантика (явно показываем что ожидаем Decimal)
- В type-narrowed контексте (когда TypeScript уже знает что это Decimal)

---

## Сравнение с примитивами

| Feature | number | Decimal | Quantity |
| --------- | -------- | --------- | ---------- |
| Precision | Limited | Arbitrary | Arbitrary |
| Immutable | Yes | Yes | Yes |
| Domain validation | No | No | **Yes** |
| Type-safe | Weak | Strong | **Strong** |
| Can be negative | Yes | Yes | **No** |
| Can be NaN | Yes | Yes | **No** |

---

## Best Practices

### 1. Всегда проверяйте инварианты

Core Layer кидает исключения при нарушении инвариантов. Используйте Facade для type-safe обработки.

### 2. Не храните number для вычислений

❌ **Плохо:**

```typescript
let total: number = 0;
total += 0.1;
total += 0.2;
console.log(total);  // 0.30000000000000004 😱
```

✅ **Хорошо:**

```typescript
let total = Quantity.ZERO;
const qty01 = QuantityService.create("0.1");
if (!qty01.ok) { throw qty01.error; }
const result1 = QuantityService.add(total, qty01.value);
if (!result1.ok) {
  throw result1.error;
}
const qty02 = QuantityService.create("0.2");
if (!qty02.ok) { throw qty02.error; }
const result2 = QuantityService.add(result1.value, qty02.value);
if (!result2.ok) {
  throw result2.error;
}
console.log(result2.value.value().toString());  // "0.3" ✅
```

### 3. Используйте константы

```typescript
const qty = Quantity.of(new Decimal(0)); // Пример: количество для проверки

// ✅ Хорошо: используем константу
if (qty.equals(Quantity.ZERO)) { ... }

// ❌ Избыточно: создаём новый экземпляр
if (qty.equals(Quantity.of(new Decimal(0)))) { ... }
```

---

## Тестирование

### Проверка инвариантов

```typescript
import { Quantity, QuantityInvariantViolation } from '@polymarket/value-objects/quantity';

describe('Quantity invariants', () => {
  it('should throw for negative', () => {
    expect(() => Quantity.of(new Decimal(-1))).toThrow(QuantityInvariantViolation);
  });

  it('should throw for NaN', () => {
    expect(() => Quantity.of(new Decimal(NaN))).toThrow(QuantityInvariantViolation);
  });

  it('should create valid quantity', () => {
    const qty = Quantity.of(new Decimal(10));
    expect(qty.value().toNumber()).toBe(10);
  });
});
```

---

## Дальнейшее чтение

- [Facade Layer](./facade.md) — как правильно использовать Quantity
- [Архитектура](./architecture.md) — почему Core кидает исключения
- [Примеры](./examples.md) — реальные use cases
