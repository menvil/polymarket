# Money Core Layer

> Core value object с инвариантами и исключениями

## Содержание

1. [Обзор](#обзор)
2. [Money Value Object](#money-value-object)
3. [Исключения](#исключения)
4. [Инварианты](#инварианты)
5. [API Reference](#api-reference)
6. [Примеры использования](#примеры-использования)

---

## Обзор

Core Layer отвечает за:

- Представление денежной суммы с валютой как immutable value object
- Гарантию инвариантов через typed exceptions
- Базовые операции (hasSameCurrency, isZero, isPositive, isNegative)

**НЕ отвечает за:**

- Арифметические операции (это Facade + Math)
- Result<T, E> (это Facade)
- Валидацию контекстных правил (это Facade)

---

## Money Value Object

### Структура

```typescript
export class Money {
  private readonly amt: Decimal;      // сумма
  private readonly cur: SupportedCurrency;  // валюта

  // Private constructor - используйте статические методы
  private constructor(amt: Decimal, cur: SupportedCurrency) {}
}
```

### Константы класса

```typescript
// Поддерживаемые валюты
public static readonly SUPPORTED_CURRENCIES = new Set<SupportedCurrency>(['USDC']);

// Максимальная абсолютная сумма
public static readonly MAX_AMOUNT = new Decimal('1e15');

// Singleton zero для каждой валюты (инициализируется после class body)
public static readonly ZERO: Record<SupportedCurrency, Money>;
// Фактическое присвоение происходит ПОСЛЕ определения класса:
// Money.ZERO = { USDC: Money.of(new Decimal(0), 'USDC') };
```

---

## Исключения

Core бросает ТОЛЬКО один тип исключений:

### MoneyInvariantViolation

**Когда:** Нарушение инвариантов после успешного парсинга (ПОСЛЕ создания Decimal)

**Extends:** `Error`

**Структура:**

```typescript
type MoneyInvariantReason =
  | 'UNSUPPORTED_CURRENCY'  // валюта не поддерживается
  | 'NAN'                   // amount.isNaN()
  | 'NON_FINITE'            // !amount.isFinite()
  | 'EXCEEDS_MAX_AMOUNT';   // |amount| > MAX_AMOUNT

export class MoneyInvariantViolation extends Error {
  public readonly reason: MoneyInvariantReason;

  constructor(message: string, reason: MoneyInvariantReason) {
    super(message);
    this.name = 'MoneyInvariantViolation';
    this.reason = reason;
  }
}
```

**Примеры:**

- `Money.of(new Decimal(NaN), 'USDC')` → reason: 'NAN'
- `Money.of(new Decimal(Infinity), 'USDC')` → reason: 'NON_FINITE'
- `Money.of(new Decimal('1e16'), 'USDC')` → reason: 'EXCEEDS_MAX_AMOUNT'
- `Money.of(new Decimal(100), 'EUR')` → reason: 'UNSUPPORTED_CURRENCY'

---

## Инварианты

Money гарантирует 4 инварианта:

### 1. Поддерживаемая валюта

**Правило:** `currency in SUPPORTED_CURRENCIES`

**Проверка:**

```typescript
if (!Money.SUPPORTED_CURRENCIES.has(currency)) {
  throw new MoneyInvariantViolation(
    `Unsupported currency: ${currency}`,
    'UNSUPPORTED_CURRENCY'
  );
}
```

**Текущие поддерживаемые валюты:** `['USDC']`

**В будущем:** можно добавить EUR, BTC, etc.

---

### 2. Not NaN

**Правило:** `!amount.isNaN()`

**Проверка:**

```typescript
if (amount.isNaN()) {
  throw new MoneyInvariantViolation('Amount is NaN', 'NAN');
}
```

**Примеры нарушений:**

- `new Decimal(NaN)`
- Результат `0 / 0`
- Результат `Infinity - Infinity`

---

### 3. Finite

**Правило:** `amount.isFinite()`

**Проверка:**

```typescript
if (!amount.isFinite()) {
  throw new MoneyInvariantViolation('Amount must be finite', 'NON_FINITE');
}
```

**Примеры нарушений:**

- `new Decimal(Infinity)`
- `new Decimal(-Infinity)`
- Результат `1 / 0`

---

### 4. Не превышает MAX_AMOUNT

**Правило:** `|amount| <= 1e15`

**Проверка:**

```typescript
if (amount.abs().greaterThan(Money.MAX_AMOUNT)) {
  throw new MoneyInvariantViolation(
    `Amount exceeds maximum: ${Money.MAX_AMOUNT}`,
    'EXCEEDS_MAX_AMOUNT'
  );
}
```

**Почему 1e15?**

- Меньше чем `Number.MAX_SAFE_INTEGER` (≈9.007e15)
- Margin для вычислений
- Практичность: 1 квадриллион USD > мировой GDP

**Примеры нарушений:**

```typescript
new Decimal('1e16')
new Decimal('9999999999999999')
// Результат арифметики, превысивший лимит
```

---

## API Reference

### Статические методы создания

#### `Money.of(value, currency?)`

Создаёт Money из Decimal.

**Сигнатура:**

```typescript
public static of(
  value: Decimal,
  currency: SupportedCurrency = 'USDC'
): Money
```

**Параметры:**

- `value` — сумма (Decimal)
- `currency` — валюта (default: 'USDC')

**Возвращает:** `Money`

**Бросает:**

- `MoneyInvariantViolation` — если нарушены инварианты

**Использование:**

- **ТОЛЬКО в Core и Facade layers**
- Для публичного API используйте `MoneyService.create()`
- Парсинг number/string → Decimal делается в MoneyService

**Примеры:**

```typescript
// ✅ В Core/Facade
const m1 = Money.of(new Decimal('100'));        // Money(100 USDC)
const m2 = Money.of(new Decimal('42.50'), 'USDC'); // Money(42.50 USDC)

// ❌ В публичном коде - используй MoneyService
const result = MoneyService.create(100, 'USDC');
if (result.ok) {
  const money = result.value;
}

// Ошибки:
Money.of(new Decimal(NaN));         // throws MoneyInvariantViolation (NAN)
Money.of(new Decimal(Infinity));    // throws MoneyInvariantViolation (NON_FINITE)
Money.of(new Decimal('1e16'));      // throws MoneyInvariantViolation (EXCEEDS_MAX_AMOUNT)
```

---

### Статические константы

#### `Money.ZERO`

Record с singleton константами для нулевых сумм каждой валюты.

**Сигнатура:**

```typescript
public static readonly ZERO: Record<SupportedCurrency, Money>
```

**Использование:**

- Доступ по валюте: `Money.ZERO.USDC`
- Singleton — всегда один и тот же объект для каждой валюты
- Автоматически создаётся для всех валют из SUPPORTED_CURRENCIES

**Примеры:**

```typescript
const zero = Money.ZERO.USDC;  // Money(0 USDC)

// Singleton:
Money.ZERO.USDC === Money.ZERO.USDC;  // true

// Проверка нуля
if (money.value().equals(Money.ZERO.USDC.value())) {
  console.log('Zero amount');
}
```

---

### Методы экземпляра

#### `value()`

Возвращает сумму как Decimal.

**Сигнатура:**

```typescript
public value(): Decimal
```

**Примеры:**

```typescript
const money = Money.of(new Decimal('100.5'));
const decimal = money.value();  // Decimal(100.5)
console.log(decimal.toString()); // "100.5"
```

---

#### `currency()`

Возвращает валюту.

**Сигнатура:**

```typescript
public currency(): SupportedCurrency
```

**Примеры:**

```typescript
const money = Money.of(new Decimal(100), 'USDC');
console.log(money.currency());  // "USDC"
```

---

#### `toNumber()`

Преобразует в number (lossy).

**Сигнатура:**

```typescript
public toNumber(): number
```

**⚠️ Внимание:** Может потерять точность для больших чисел.

**Использование:** Для UI, когда точность не критична.

**Примеры:**

```typescript
const money = Money.of(new Decimal('123.456'));
console.log(money.toNumber());  // 123.456

// Для вычислений используйте value()
const decimal = money.value();  // Decimal (точный)
```

---

#### `hasSameCurrency(other)`

Проверяет совпадение валют.

**Сигнатура:**

```typescript
public hasSameCurrency(other: Money): boolean
```

**Использование:** В Facade для проверки перед add/subtract.

**Примеры:**

```typescript
const usd1 = Money.of(new Decimal(100), 'USDC');
const usd2 = Money.of(new Decimal(200), 'USDC');

usd1.hasSameCurrency(usd2);  // true
```

---

#### `isZero()`

Проверяет что сумма равна нулю.

**Сигнатура:**

```typescript
public isZero(): boolean
```

**Возвращает:** `true` если сумма равна 0.

**Примеры:**

```typescript
Money.ZERO.USDC.isZero();  // true
Money.of(new Decimal(0)).isZero();      // true
Money.of(new Decimal(100)).isZero();    // false
Money.of(new Decimal(-100)).isZero();   // false
```

---

#### `isPositive()`

Проверяет что сумма положительная (> 0).

**Сигнатура:**

```typescript
public isPositive(): boolean
```

**Возвращает:** `true` если сумма > 0.

**Примеры:**

```typescript
Money.of(new Decimal(100)).isPositive();     // true
Money.of(new Decimal(0.01)).isPositive();    // true
Money.ZERO.USDC.isPositive();   // false
Money.of(new Decimal(-100)).isPositive();    // false
```

---

#### `isNegative()`

Проверяет что сумма отрицательная (< 0).

**Сигнатура:**

```typescript
public isNegative(): boolean
```

**Возвращает:** `true` если сумма < 0.

**Примеры:**

```typescript
Money.of(new Decimal(-100)).isNegative();    // true
Money.of(new Decimal(-0.01)).isNegative();   // true
Money.of(new Decimal(100)).isNegative();     // false
Money.ZERO.USDC.isNegative();   // false
```

---

## Примеры использования

### Создание Money (Core layer)

```typescript
// ⚠️ Используйте MoneyService.create() в публичном коде!
// Money.of() - ТОЛЬКО для Core/Facade layers

// Из Decimal
const m1 = Money.of(new Decimal('100'));           // 100 USDC
const m2 = Money.of(new Decimal('100.50'));        // 100.50 USDC

// Из строки через Decimal (для точности)
const m3 = Money.of(new Decimal("99.999999999")); // 99.999999999 USDC

// С явной валютой
const m4 = Money.of(new Decimal(100), 'USDC');

// Ноль
const zero = Money.ZERO.USDC;      // 0 USDC (singleton)
```

### Работа с инвариантами

```typescript
// ✅ Валидные значения
Money.of(new Decimal(0));              // OK: ноль разрешён
Money.of(new Decimal(-100));           // OK: отрицательные разрешены
Money.of(new Decimal('1e15'));         // OK: ровно MAX_AMOUNT
Money.of(new Decimal('999999999999999.999')); // OK

// ❌ Нарушения инвариантов
try {
  Money.of(new Decimal(NaN));
} catch (e) {
  if (e instanceof MoneyInvariantViolation) {
    console.log(e.reason);  // 'NAN'
  }
}

try {
  Money.of(new Decimal(Infinity));
} catch (e) {
  if (e instanceof MoneyInvariantViolation) {
    console.log(e.reason);  // 'NON_FINITE'
  }
}

try {
  Money.of(new Decimal('1e16'));  // > MAX_AMOUNT
} catch (e) {
  if (e instanceof MoneyInvariantViolation) {
    console.log(e.reason);  // 'EXCEEDS_MAX_AMOUNT'
  }
}
```

### Сравнение и проверки

```typescript
const m1 = Money.of(new Decimal(100), 'USDC');
const m2 = Money.of(new Decimal(100), 'USDC');
const m3 = Money.of(new Decimal('100.01'), 'USDC');

// Проверка валюты
m1.hasSameCurrency(m2);  // true
m1.hasSameCurrency(m3);  // true

// Проверка нуля
Money.ZERO.USDC.isZero();           // true
Money.of(new Decimal(0)).isZero();  // true
Money.of(new Decimal(100)).isZero(); // false

// Проверка положительности
Money.of(new Decimal(100)).isPositive();   // true
Money.ZERO.USDC.isPositive();              // false
Money.of(new Decimal(-100)).isPositive();  // false

// Проверка отрицательности
Money.of(new Decimal(-100)).isNegative();  // true
Money.of(new Decimal(100)).isNegative();   // false
Money.ZERO.USDC.isNegative();              // false
```

### Константы

```typescript
// Максимальная сумма
console.log(Money.MAX_AMOUNT.toString());  // "1000000000000000"

// Поддерживаемые валюты
console.log(Money.SUPPORTED_CURRENCIES);  // Set { 'USDC' }

// Zero singleton
const zero = Money.ZERO.USDC;
console.log(zero.value().toNumber());  // 0
console.log(zero.currency());           // "USDC"
```

---

## Заключение

Core Layer:

- ✅ Простой, чистый value object
- ✅ Гарантия инвариантов через MoneyInvariantViolation
- ✅ Иммутабельность
- ✅ Type-safe API
- ✅ Только для Core/Facade layers

**Для публичного API используйте [MoneyService](./facade.md)** (Result-based, парсинг number/string).
