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
- Базовые операции (equals, hasSameCurrency)

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

// Singleton zero USDC (lazy init)
public static get ZERO_USDC(): Money
```

---

## Исключения

Core бросает два типа исключений:

### 1. MoneyParseError

**Когда:** Ошибка парсинга входного значения в Decimal (ДО создания Decimal)

**Extends:** `Error`

**Структура:**

```typescript
export class MoneyParseError extends Error {
  public readonly value: string;  // сырое значение

  constructor(value: string) {
    super(`Failed to parse Money value: ${value}`);
    this.name = 'MoneyParseError';
    this.value = value;
  }
}
```

**Примеры:**

- `Money.of("abc")` → MoneyParseError
- `Money.of(undefined)` → MoneyParseError
- `Money.of({})` → MoneyParseError

---

### 2. MoneyInvariantViolation

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

- `Money.fromDecimal(new Decimal(NaN), 'USDC')` → reason: 'NAN'
- `Money.fromDecimal(new Decimal(Infinity), 'USDC')` → reason: 'NON_FINITE'
- `Money.fromDecimal(new Decimal('1e16'), 'USDC')` → reason: 'EXCEEDS_MAX_AMOUNT'
- `Money.fromDecimal(new Decimal(100), 'EUR')` → reason: 'UNSUPPORTED_CURRENCY'

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

- Меньше чем `Number.MAX_SAFE_INTEGER` (9e15)
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

Создаёт Money из number или string.

**Сигнатура:**

```typescript
public static of(
  value: number | string,
  currency: SupportedCurrency = 'USDC'
): Money
```

**Параметры:**

- `value` — сумма (number или string)
- `currency` — валюта (default: 'USDC')

**Возвращает:** `Money`

**Бросает:**

- `MoneyParseError` — если не удалось parse value в Decimal
- `MoneyInvariantViolation` — если нарушены инварианты

**Процесс:**

1. Парсит value в Decimal через `new Decimal(value)`
2. Если parse fail → бросает `MoneyParseError`
3. Вызывает `Money.create(decimal, currency)`
4. Если invariant fail → бросает `MoneyInvariantViolation`

**Примеры:**

```typescript
const m1 = Money.of(100);                 // Money(100 USDC)
const m2 = Money.of('42.50', 'USDC');     // Money(42.50 USDC)
const m3 = Money.of(100.123456789);       // Money(100.123456789 USDC)

// Ошибки:
Money.of("abc");       // throws MoneyParseError
Money.of(NaN);         // throws MoneyInvariantViolation (NAN)
Money.of(Infinity);    // throws MoneyInvariantViolation (NON_FINITE)
Money.of('1e16');      // throws MoneyInvariantViolation (EXCEEDS_MAX_AMOUNT)
```

---

#### `Money.fromDecimal(value, currency?)`

Создаёт Money из Decimal (zero-copy).

**Сигнатура:**

```typescript
public static fromDecimal(
  value: Decimal,
  currency: SupportedCurrency = 'USDC'
): Money
```

**Параметры:**

- `value` — Decimal сумма
- `currency` — валюта (default: 'USDC')

**Возвращает:** `Money`

**Бросает:**

- `MoneyInvariantViolation` — если нарушены инварианты

**Использование:**

- В Facade после арифметики
- В тестах для точного контроля
- Когда уже есть Decimal (zero-copy)

**Примеры:**

```typescript
const decimal = new Decimal('123.456');
const money = Money.fromDecimal(decimal);  // Money(123.456 USDC)

// Ошибки:
Money.fromDecimal(new Decimal(NaN));      // throws MoneyInvariantViolation
Money.fromDecimal(new Decimal('1e16'));   // throws MoneyInvariantViolation
```

---

#### `Money.zero(currency?)`

Создаёт Money с нулевой суммой.

**Сигнатура:**

```typescript
public static zero(currency: SupportedCurrency = 'USDC'): Money
```

**Параметры:**

- `currency` — валюта (default: 'USDC')

**Возвращает:** `Money` с amount = 0

**Примеры:**

```typescript
const zero = Money.zero();        // Money(0 USDC)
const zeroEUR = Money.zero('EUR'); // throws (EUR not supported)
```

---

#### `Money.ZERO_USDC`

Singleton константа для нулевой суммы USDC.

**Сигнатура:**

```typescript
public static get ZERO_USDC(): Money
```

**Возвращает:** `Money(0 USDC)` (ленивая инициализация)

**Использование:**

- Вместо `Money.zero()` когда нужен USDC
- Singleton — всегда один и тот же объект

**Примеры:**

```typescript
const zero = Money.ZERO_USDC;  // Money(0 USDC)

// Singleton:
Money.ZERO_USDC === Money.ZERO_USDC;  // true
```

---

### Методы экземпляра

#### `amount()`

Возвращает сумму как Decimal.

**Сигнатура:**

```typescript
public amount(): Decimal
```

**Примеры:**

```typescript
const money = Money.of(100.5);
const decimal = money.amount();  // Decimal(100.5)
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
const money = Money.of(100, 'USDC');
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
const money = Money.of('123.456');
console.log(money.toNumber());  // 123.456

// Для вычислений используйте amount()
const decimal = money.amount();  // Decimal (точный)
```

---

#### `toDecimal()`

Алиас для `amount()`.

**Сигнатура:**

```typescript
public toDecimal(): Decimal
```

**Примеры:**

```typescript
const money = Money.of(100);
const decimal = money.toDecimal();  // Decimal(100)
```

---

#### `equals(other)`

Проверяет строгое равенство (валюта и сумма).

**Сигнатура:**

```typescript
public equals(other: Money): boolean
```

**Возвращает:** `true` если валюта и сумма идентичны.

**Примеры:**

```typescript
const m1 = Money.of(100, 'USDC');
const m2 = Money.of(100, 'USDC');
const m3 = Money.of(100.01, 'USDC');

m1.equals(m2);  // true (одинаковая валюта и сумма)
m1.equals(m3);  // false (разные суммы)
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
const usd1 = Money.of(100, 'USDC');
const usd2 = Money.of(200, 'USDC');

usd1.hasSameCurrency(usd2);  // true
```

---

## Примеры использования

### Создание Money

```typescript
// Из числа
const m1 = Money.of(100);           // 100 USDC
const m2 = Money.of(100.50);        // 100.50 USDC

// Из строки (для точности)
const m3 = Money.of("99.999999999"); // 99.999999999 USDC

// С явной валютой
const m4 = Money.of(100, 'USDC');

// Из Decimal
const decimal = new Decimal('123.456');
const m5 = Money.fromDecimal(decimal);

// Ноль
const zero = Money.zero();          // 0 USDC
const zero2 = Money.ZERO_USDC;      // 0 USDC (singleton)
```

### Работа с инвариантами

```typescript
// ✅ Валидные значения
Money.of(0);              // OK: ноль разрешён
Money.of(-100);           // OK: отрицательные разрешены
Money.of('1e15');         // OK: ровно MAX_AMOUNT
Money.of('999999999999999.999'); // OK

// ❌ Нарушения инвариантов
try {
  Money.of(NaN);
} catch (e) {
  if (e instanceof MoneyInvariantViolation) {
    console.log(e.reason);  // 'NAN'
  }
}

try {
  Money.of(Infinity);
} catch (e) {
  if (e instanceof MoneyInvariantViolation) {
    console.log(e.reason);  // 'NON_FINITE'
  }
}

try {
  Money.of('1e16');  // > MAX_AMOUNT
} catch (e) {
  if (e instanceof MoneyInvariantViolation) {
    console.log(e.reason);  // 'EXCEEDS_MAX_AMOUNT'
  }
}

// ❌ Ошибки парсинга
try {
  Money.of("abc");
} catch (e) {
  if (e instanceof MoneyParseError) {
    console.log(e.value);  // "abc"
  }
}
```

### Сравнение

```typescript
const m1 = Money.of(100, 'USDC');
const m2 = Money.of(100, 'USDC');
const m3 = Money.of(100.01, 'USDC');

// Равенство
m1.equals(m2);  // true
m1.equals(m3);  // false

// Проверка валюты
m1.hasSameCurrency(m2);  // true
m1.hasSameCurrency(m3);  // true
```

### Константы

```typescript
// Максимальная сумма
console.log(Money.MAX_AMOUNT.toString());  // "1000000000000000"

// Поддерживаемые валюты
console.log(Money.SUPPORTED_CURRENCIES);  // Set { 'USDC' }

// Zero singleton
const zero = Money.ZERO_USDC;
console.log(zero.amount().toNumber());  // 0
console.log(zero.currency());           // "USDC"
```

---

## Заключение

Core Layer:

- ✅ Простой, чистый value object
- ✅ Гарантия инвариантов через typed exceptions
- ✅ Разделение parse errors и invariant violations
- ✅ Иммутабельность
- ✅ Type-safe API

Для создания Money из внешних данных используйте [MoneyService](./facade.md) (Result-based).
