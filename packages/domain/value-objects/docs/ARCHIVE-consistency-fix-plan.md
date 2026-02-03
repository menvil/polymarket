# План унификации Value Objects

> Дата: 2026-02-02
> Статус: В планировании
> Breaking changes: ✅ Разрешены (объекты не в продакшене)

---

## Обзор

Устранение всех несогласованностей между Price, Quantity и Money для создания единообразного API.

**Общий объем работ:**

- Изменения в Core: 3 файла (Money.ts, Price.ts, Quantity.ts)
- Новые файлы: 2 (PriceParseError.ts, QuantityParseError.ts)
- Обновления в Facade: 3 файла
- Обновления в Adapters: 3 файла
- Обновления в ErrorReason: 3 файла
- Обновления тестов: ~50 файлов
- Обновления документации: ~20 файлов

---

## Этап 1: Унификация Core классов

### 1.1. Money: Переименование amount() → value()

**Файлы:**

- `src/money/core/Money.ts`

**Изменения:**

```typescript
// БЫЛО:
public amount(): Decimal {
  return this.amt;
}

public toDecimal(): Decimal {  // Алиас - удаляем
  return this.amt;
}

// СТАЛО:
public value(): Decimal {
  return this.amt;
}

// Deprecated alias удаляем сразу (не в продакшене)
```

**Зависимые файлы (обновить все вызовы .value()):**

- `src/money/facade/MoneyService.ts` - все операции
- `src/money/adapters/MoneyFormatter.ts` - форматирование
- `src/money/adapters/MoneySerializer.ts` - сериализация
- `__tests__/unit/money/**/*.test.ts` - все тесты
- `docs/money/**/*.md` - вся документация

**Команда для поиска:**

```bash
grep -r "\.value()" packages/domain/value-objects/src/money/
grep -r "\.value()" packages/domain/value-objects/__tests__/unit/money/
```

---

### 1.2. Добавить ParseError в Price и Quantity

#### 1.2.1. Создать PriceParseError

**Новый файл:** `src/price/core/PriceParseError.ts`

```typescript
import { PriceErrorReason } from '../errors/PriceErrorReason';

/**
 * Ошибка парсинга значения цены
 *
 * @remarks
 * Отличается от PriceInvariantViolation:
 * - ParseError: входное значение невалидно как строка/число
 * - InvariantViolation: значение валидно, но нарушает инварианты
 *
 * @example
 * ```typescript
 * throw new PriceParseError('not-a-number');
 * ```
 */
export class PriceParseError extends Error {
  public readonly reason = PriceErrorReason.INVALID_FORMAT;
  public readonly rawValue: string;

  constructor(rawValue: string) {
    super(`Failed to parse price value: ${rawValue}`);
    Object.setPrototypeOf(this, PriceParseError.prototype);
    this.name = 'PriceParseError';
    this.rawValue = rawValue;
  }
}
```

#### 1.2.2. Обновить Price.of()

**Файл:** `src/price/core/Price.ts`

```typescript
import { PriceParseError } from './PriceParseError';

public static of(value: number | string | Decimal): Price {
  if (value instanceof Decimal) {
    return Price.fromDecimal(value);
  }

  let decimal: Decimal;
  try {
    decimal = new Decimal(value);
  } catch (error) {
    throw new PriceParseError(String(value));
  }

  return new Price(decimal);
}
```

#### 1.2.3. Создать QuantityParseError

**Новый файл:** `src/quantity/core/QuantityParseError.ts`

```typescript
import { QuantityErrorReason } from '../errors/QuantityErrorReason';

/**
 * Ошибка парсинга значения количества
 *
 * @remarks
 * Отличается от QuantityInvariantViolation:
 * - ParseError: входное значение невалидно как строка/число
 * - InvariantViolation: значение валидно, но нарушает инварианты
 *
 * @example
 * ```typescript
 * throw new QuantityParseError('not-a-number');
 * ```
 */
export class QuantityParseError extends Error {
  public readonly reason = QuantityErrorReason.INVALID_FORMAT;
  public readonly rawValue: string;

  constructor(rawValue: string) {
    super(`Failed to parse quantity value: ${rawValue}`);
    Object.setPrototypeOf(this, QuantityParseError.prototype);
    this.name = 'QuantityParseError';
    this.rawValue = rawValue;
  }
}
```

#### 1.2.4. Обновить Quantity.of()

**Файл:** `src/quantity/core/Quantity.ts`

```typescript
import { QuantityParseError } from './QuantityParseError';

public static of(value: number | string | Decimal): Quantity {
  if (value instanceof Decimal) {
    return Quantity.fromDecimal(value);
  }

  let decimal: Decimal;
  try {
    decimal = new Decimal(value);
  } catch (error) {
    throw new QuantityParseError(String(value));
  }

  return new Quantity(decimal);
}
```

#### 1.2.5. Обновить Facade для обработки ParseError

**Файл:** `src/price/facade/PriceService.ts`

```typescript
import { PriceParseError } from '../core/PriceParseError';

// В методе create()
try {
  const price = Price.of(value);
  // ...
} catch (error) {
  if (error instanceof PriceParseError) {
    return Err(
      new InvalidPriceError('Invalid price format', {
        context: {
          op: 'create',
          raw: { field: 'value', value: String(value) },
          reason: PriceErrorReason.INVALID_FORMAT
        }
      })
    );
  }

  if (error instanceof PriceInvariantViolation) {
    // ... существующая обработка
  }

  return unexpectedError('create', {}, error, InvalidPriceError);
}
```

**Аналогично для QuantityService.ts**

---

### 1.3. Унификация проверок инвариантов

**Изменить во всех трех классах:**

#### 1.3.1. Price.ts

```typescript
private constructor(private readonly v: Decimal) {
  // Инвариант 1: Not NaN (явная проверка)
  if (v.isNaN()) {
    throw new PriceInvariantViolation('Price cannot be NaN', PriceErrorReason.NAN);
  }

  // Инвариант 2: Must be finite (явная проверка)
  if (!v.isFinite()) {
    throw new PriceInvariantViolation('Price must be finite', PriceErrorReason.NON_FINITE);
  }

  // Инвариант 3: Range check
  if (v.lessThan(Price.MIN_PRICE)) {
    throw new PriceInvariantViolation(
      `Price ${v} is below minimum ${Price.MIN_PRICE}`,
      PriceErrorReason.OUT_OF_RANGE_LOW
    );
  }

  if (v.greaterThan(Price.MAX_PRICE)) {
    throw new PriceInvariantViolation(
      `Price ${v} exceeds maximum ${Price.MAX_PRICE}`,
      PriceErrorReason.OUT_OF_RANGE_HIGH
    );
  }
}
```

#### 1.3.2. Quantity.ts

```typescript
private constructor(private readonly v: Decimal) {
  // Инвариант 1: Not NaN (добавляем явную проверку)
  if (v.isNaN()) {
    throw new QuantityInvariantViolation('Quantity cannot be NaN', QuantityErrorReason.NAN);
  }

  // Инвариант 2: Must be finite (оставляем)
  if (!v.isFinite()) {
    throw new QuantityInvariantViolation('Quantity must be finite', QuantityErrorReason.NON_FINITE);
  }

  // Инвариант 3: Cannot be negative
  if (v.isNegative()) {
    throw new QuantityInvariantViolation('Quantity cannot be negative', QuantityErrorReason.NEGATIVE);
  }
}
```

**ВАЖНО:** В QuantityErrorReason уже есть NAN, просто не использовался!

#### 1.3.3. Money.ts - уже правильный порядок, НО

Переставить проверки для единообразия:

```typescript
private static create(amount: Decimal, currency: SupportedCurrency): Money {
  // Инвариант 1: Not NaN (переместить первым)
  if (amount.isNaN()) {
    throw new MoneyInvariantViolation('Amount is NaN', MoneyErrorReason.NAN);
  }

  // Инвариант 2: Finite
  if (!amount.isFinite()) {
    throw new MoneyInvariantViolation('Amount must be finite', MoneyErrorReason.NON_FINITE);
  }

  // Инвариант 3: Supported currency (переместить после NaN/Finite)
  if (!Money.SUPPORTED_CURRENCIES.has(currency)) {
    throw new MoneyInvariantViolation(
      `Unsupported currency: ${currency}`,
      MoneyErrorReason.UNSUPPORTED_CURRENCY
    );
  }

  // Инвариант 4: Max amount
  if (amount.abs().greaterThan(Money.MAX_AMOUNT)) {
    throw new MoneyInvariantViolation(
      `Amount exceeds maximum: ${Money.MAX_AMOUNT}`,
      MoneyErrorReason.EXCEEDS_MAX_AMOUNT
    );
  }

  return new Money(amount, currency);
}
```

---

## Этап 2: Очистка ErrorReason enums

### 2.1. PriceErrorReason - убрать дубликаты

**Файл:** `src/price/errors/PriceErrorReason.ts`

```typescript
export enum PriceErrorReason {
  // Core invariants
  /** Значение NaN */
  NAN = 'NAN',

  /** Значение не finite (Infinity, -Infinity) */
  NON_FINITE = 'NON_FINITE',

  /** Цена вне допустимого диапазона (низкая) */
  OUT_OF_RANGE_LOW = 'OUT_OF_RANGE_LOW',

  /** Цена вне допустимого диапазона (высокая) */
  OUT_OF_RANGE_HIGH = 'OUT_OF_RANGE_HIGH',

  // Facade/Rules errors
  /** Деление на ноль */
  DIVISION_BY_ZERO = 'DIVISION_BY_ZERO',

  /** Ошибка парсинга значения */
  INVALID_FORMAT = 'INVALID_FORMAT',

  /** Цена не выровнена по tickSize */
  NOT_ALIGNED = 'NOT_ALIGNED',

  /** Невалидный tickSize */
  INVALID_TICK_SIZE = 'INVALID_TICK_SIZE',

  // УДАЛИТЬ:
  // EXCEEDS_MAX_PRICE - дублирует OUT_OF_RANGE_HIGH
  // NEGATIVE_PRICE - дублирует OUT_OF_RANGE_LOW
}
```

**Обновить использование:**

```bash
# Найти все использования удаляемых констант
grep -r "EXCEEDS_MAX_PRICE" packages/domain/value-objects/
grep -r "NEGATIVE_PRICE" packages/domain/value-objects/

# Заменить на:
# EXCEEDS_MAX_PRICE → OUT_OF_RANGE_HIGH
# NEGATIVE_PRICE → OUT_OF_RANGE_LOW
```

### 2.2. QuantityErrorReason - унифицировать NEGATIVE

**Файл:** `src/quantity/errors/QuantityErrorReason.ts`

```typescript
export enum QuantityErrorReason {
  // Core invariants
  /** Значение NaN */
  NAN = 'NAN',

  /** Значение не finite (Infinity, -Infinity) */
  NON_FINITE = 'NON_FINITE',

  /** Количество отрицательное (инвариант) */
  NEGATIVE = 'NEGATIVE',

  // Facade/Rules errors
  /** Деление на ноль */
  DIVISION_BY_ZERO = 'DIVISION_BY_ZERO',

  /** Ошибка парсинга значения */
  INVALID_FORMAT = 'INVALID_FORMAT',

  /** Невалидный stepSize */
  INVALID_STEP_SIZE = 'INVALID_STEP_SIZE',

  /** Результат операции отрицательный (для subtract) */
  NEGATIVE_RESULT = 'NEGATIVE_RESULT',

  // УДАЛИТЬ:
  // NEGATIVE_QUANTITY - заменить на NEGATIVE
  // EXCEEDS_MAX_QUANTITY - пока не используется
}
```

**Обновить использование:**

```bash
grep -r "NEGATIVE_QUANTITY" packages/domain/value-objects/
# Заменить все на NEGATIVE
```

### 2.3. MoneyErrorReason - оставить как есть

Уже правильный! Нет дубликатов.

---

## Этап 3: Унификация констант

### 3.1. Price - изменить на static readonly

**Файл:** `src/price/core/Price.ts`

```typescript
export class Price {
  // Константы границ диапазона (приватные для internal use)
  private static readonly MIN_PRICE = new Decimal('0.0001');
  private static readonly MAX_PRICE = new Decimal('0.9999');
  private static readonly HALF_PRICE = new Decimal('0.5');

  // Публичные константы (static readonly)
  public static readonly MIN = Price.fromDecimal(Price.MIN_PRICE);
  public static readonly MAX = Price.fromDecimal(Price.MAX_PRICE);
  public static readonly HALF = Price.fromDecimal(Price.HALF_PRICE);

  // УДАЛИТЬ методы:
  // public static min(): Price { ... }
  // public static max(): Price { ... }
  // public static half(): Price { ... }
  // public static minValue(): Decimal { ... }
  // public static maxValue(): Decimal { ... }
}
```

**Обновить использование:**

```bash
# Найти все вызовы методов
grep -r "Price\.min()" packages/domain/value-objects/
grep -r "Price\.max()" packages/domain/value-objects/
grep -r "Price\.half()" packages/domain/value-objects/

# Заменить на:
# Price.MIN → Price.MIN
# Price.MAX → Price.MAX
# Price.HALF → Price.HALF
```

### 3.2. Money - убрать lazy initialization

**Файл:** `src/money/core/Money.ts`

```typescript
export class Money {
  // Константы
  public static readonly SUPPORTED_CURRENCIES = new Set<SupportedCurrency>(['USDC']);
  public static readonly MAX_AMOUNT = new Decimal('1e15');

  // Убрать lazy initialization
  public static readonly ZERO_USDC = Money.fromDecimal(new Decimal(0), 'USDC');

  // УДАЛИТЬ:
  // private static _zeroUSDC?: Money;
  // public static get ZERO_USDC(): Money { ... }

  // УДАЛИТЬ метод zero() или сделать alias
  public static zero(currency: SupportedCurrency = 'USDC'): Money {
    if (currency === 'USDC') {
      return Money.ZERO.USDC;
    }
    return Money.fromDecimal(new Decimal(0), currency);
  }
}
```

### 3.3. Quantity - оставить как есть

Уже правильный!

```typescript
public static readonly ZERO = Quantity.of(0);
public static readonly ONE = Quantity.of(1);
```

---

## Этап 4: Добавить методы сравнения

### 4.1. Price - добавить полный набор

**Файл:** `src/price/core/Price.ts`

```typescript
/**
 * Проверяет что эта цена меньше другой
 *
 * @param other - Другая цена для сравнения
 * @returns true если this < other
 *
 * @example
 * ```typescript
 * const p1 = Price.of(0.5);
 * const p2 = Price.of(0.6);
 * p1.isLessThan(p2); // true
 * ```
 */
public isLessThan(other: Price): boolean {
  return this.v.lessThan(other.v);
}

/**
 * Проверяет что эта цена меньше или равна другой
 */
public isLessThanOrEqual(other: Price): boolean {
  return this.v.lessThanOrEqualTo(other.v);
}

/**
 * Проверяет что эта цена больше другой
 */
public isGreaterThan(other: Price): boolean {
  return this.v.greaterThan(other.v);
}

/**
 * Проверяет что эта цена больше или равна другой
 */
public isGreaterThanOrEqual(other: Price): boolean {
  return this.v.greaterThanOrEqualTo(other.v);
}
```

### 4.2. Money - добавить с проверкой валюты

**Файл:** `src/money/core/Money.ts`

```typescript
/**
 * Проверяет что эта сумма меньше другой
 *
 * @param other - Другая сумма для сравнения
 * @returns true если this < other
 * @throws {Error} Если валюты не совпадают
 *
 * @example
 * ```typescript
 * const m1 = Money.of(100, 'USDC');
 * const m2 = Money.of(200, 'USDC');
 * m1.isLessThan(m2); // true
 * ```
 */
public isLessThan(other: Money): boolean {
  this.assertSameCurrency(other);
  return this.amt.lessThan(other.amt);
}

/**
 * Проверяет что эта сумма меньше или равна другой
 */
public isLessThanOrEqual(other: Money): boolean {
  this.assertSameCurrency(other);
  return this.amt.lessThanOrEqualTo(other.amt);
}

/**
 * Проверяет что эта сумма больше другой
 */
public isGreaterThan(other: Money): boolean {
  this.assertSameCurrency(other);
  return this.amt.greaterThan(other.amt);
}

/**
 * Проверяет что эта сумма больше или равна другой
 */
public isGreaterThanOrEqual(other: Money): boolean {
  this.assertSameCurrency(other);
  return this.amt.greaterThanOrEqualTo(other.amt);
}

/**
 * Проверяет что сумма равна нулю
 */
public isZero(): boolean {
  return this.amt.isZero();
}

/**
 * Проверяет что сумма положительная
 */
public isPositive(): boolean {
  return this.amt.greaterThan(0);
}

/**
 * Проверяет что сумма отрицательная
 */
public isNegative(): boolean {
  return this.amt.lessThan(0);
}

/**
 * Внутренний helper для проверки валют
 * @private
 */
private assertSameCurrency(other: Money): void {
  if (!this.hasSameCurrency(other)) {
    throw new Error(
      `Cannot compare Money with different currencies: ${this.cur} vs ${other.cur}`
    );
  }
}
```

---

## Этап 5: Обновление exports

### 5.1. Price - добавить PriceParseError

**Файл:** `src/price/core/index.ts`

```typescript
export { Price, PriceInvariantViolation } from './Price';
export { PriceParseError } from './PriceParseError';  // ДОБАВИТЬ
```

### 5.2. Quantity - добавить QuantityParseError

**Файл:** `src/quantity/core/index.ts`

```typescript
export { Quantity } from './Quantity';
export { QuantityParseError } from './QuantityParseError';  // ДОБАВИТЬ
```

### 5.3. Money - уже экспортирует MoneyParseError

Проверить, что экспортируется.

---

## Этап 6: Обновление тестов

### 6.1. Money тесты - .value() → .value()

**Команда для поиска всех тестов:**

```bash
find packages/domain/value-objects/__tests__/unit/money -name "*.test.ts" -exec grep -l "\.value()" {} \;
```

**Файлы для обновления:**

- `Money.test.ts`
- `MoneyService.create.test.ts`
- `MoneyService.math.test.ts`
- `MoneyFormatter.test.ts`
- `MoneySerializer.test.ts`

**Пример замены:**

```typescript
// БЫЛО:
expect(money.value().toNumber()).toBe(100);

// СТАЛО:
expect(money.value().toNumber()).toBe(100);
```

### 6.2. Price тесты - добавить тесты ParseError

**Файл:** `__tests__/unit/price/core/Price.test.ts`

```typescript
import { PriceParseError } from '../../../../src/price/core/PriceParseError';

describe('Price.of() - parse errors', () => {
  it('should throw PriceParseError for invalid string', () => {
    expect(() => Price.of('not-a-number')).toThrow(PriceParseError);
    expect(() => Price.of('abc')).toThrow(PriceParseError);
  });

  it('should throw PriceParseError for invalid objects', () => {
    expect(() => Price.of({} as any)).toThrow(PriceParseError);
    expect(() => Price.of([] as any)).toThrow(PriceParseError);
  });

  it('parse error should have INVALID_FORMAT reason', () => {
    try {
      Price.of('invalid');
      fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PriceParseError);
      expect((error as PriceParseError).reason).toBe(PriceErrorReason.INVALID_FORMAT);
    }
  });
});
```

### 6.3. Quantity тесты - аналогично Price

**Файл:** `__tests__/unit/quantity/core/Quantity.test.ts`

Добавить аналогичные тесты для QuantityParseError.

### 6.4. PriceService/QuantityService - тесты ParseError handling

**Файл:** `__tests__/unit/price/facade/PriceService.test.ts`

```typescript
describe('PriceService.create() - parse errors', () => {
  it('should return InvalidPriceError with INVALID_FORMAT for parse error', () => {
    const result = PriceService.create('not-a-number');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(InvalidPriceError);
      expect(result.error.context?.reason).toBe(PriceErrorReason.INVALID_FORMAT);
      expect(result.error.context?.op).toBe('create');
    }
  });
});
```

### 6.5. Константы - обновить тесты

**Price:**

```typescript
// БЫЛО:
const min = Price.MIN;
const max = Price.MAX;

// СТАЛО:
const min = Price.MIN;
const max = Price.MAX;
```

### 6.6. Методы сравнения - добавить тесты

**Price:**

```typescript
describe('Price comparison methods', () => {
  it('should compare prices with isLessThan', () => {
    const p1 = Price.of(0.5);
    const p2 = Price.of(0.6);

    expect(p1.isLessThan(p2)).toBe(true);
    expect(p2.isLessThan(p1)).toBe(false);
  });

  it('should compare prices with isGreaterThan', () => {
    const p1 = Price.of(0.6);
    const p2 = Price.of(0.5);

    expect(p1.isGreaterThan(p2)).toBe(true);
    expect(p2.isGreaterThan(p1)).toBe(false);
  });

  // ... остальные методы
});
```

**Money:**

```typescript
describe('Money comparison methods', () => {
  it('should compare money with same currency', () => {
    const m1 = Money.of(100);
    const m2 = Money.of(200);

    expect(m1.isLessThan(m2)).toBe(true);
  });

  it('should throw when comparing different currencies', () => {
    const m1 = Money.of(100, 'USDC');
    const m2 = Money.of(100, 'USDC'); // Только USDC сейчас

    // Когда будет >1 валюты:
    // expect(() => m1.isLessThan(m2_different_currency)).toThrow();
  });

  it('should check if money is zero', () => {
    expect(Money.ZERO.USDC.isZero()).toBe(true);
    expect(Money.of(100).isZero()).toBe(false);
  });

  it('should check if money is positive', () => {
    expect(Money.of(100).isPositive()).toBe(true);
    expect(Money.ZERO.USDC.isPositive()).toBe(false);
    expect(Money.of(-100).isPositive()).toBe(false);
  });
});
```

---

## Этап 7: Обновление документации

### 7.1. Money документация - amount → value

**Файлы для обновления:**

```bash
grep -r "\.value()" packages/domain/value-objects/docs/money/
```

- `docs/money/core.md`
- `docs/money/facade.md`
- `docs/money/adapters.md`
- `docs/money/examples.md`
- `docs/money/migration.md`

**Пример:**

```markdown
// БЫЛО:
const decimal = money.value();

// СТАЛО:
const decimal = money.value();
```

### 7.2. Обновить примеры с ParseError

**Во всех docs файлах добавить:**

```markdown
## Обработка ошибок

### Parse Errors vs Invariant Violations

```typescript
// Parse error - невалидный формат входных данных
try {
  const price = Price.of('not-a-number');
} catch (error) {
  if (error instanceof PriceParseError) {
    console.error('Invalid format:', error.rawValue);
  }
}

// Invariant violation - значение валидно, но нарушает инварианты
try {
  const price = Price.of(2.0);  // > MAX_PRICE
} catch (error) {
  if (error instanceof PriceInvariantViolation) {
    console.error('Invariant violated:', error.reason);
  }
}
```

```

### 7.3. Обновить примеры с константами

**Price docs:**
```markdown
// БЫЛО:
const min = Price.MIN;
const max = Price.MAX;
const half = Price.HALF;

// СТАЛО:
const min = Price.MIN;
const max = Price.MAX;
const half = Price.HALF;
```

### 7.4. Добавить примеры новых методов сравнения

**Price/Money docs:**

```markdown
## Методы сравнения

```typescript
const p1 = Price.of(0.5);
const p2 = Price.of(0.6);

// Сравнение
p1.isLessThan(p2);          // true
p1.isLessThanOrEqual(p2);   // true
p1.isGreaterThan(p2);       // false
p1.isGreaterThanOrEqual(p2); // false
p1.equals(p2);              // false

// Для Money:
const m1 = Money.of(100);
const m2 = Money.of(200);

m1.isLessThan(m2);  // true
m1.isZero();        // false
m1.isPositive();    // true
```

```

### 7.5. Обновить architecture.md

Описать новую единообразную структуру:
- Единый порядок проверок инвариантов
- Parse errors vs Invariant violations
- Методы сравнения во всех value objects

---

## Этап 8: Проверка и валидация

### 8.1. Компиляция

```bash
npm run build
```

Ожидаемые ошибки компиляции:

- Все места где используется .value() в Money
- Все места где используется Price.MIN вместо Price.MIN

Исправить все ошибки.

### 8.2. Тесты

```bash
npm test
```

Ожидается: **Все 476+ тестов проходят**

### 8.3. Линтер

```bash
npm run lint
npm run typecheck
```

### 8.4. Markdown линтер

```bash
npm run lint:md
```

---

## Чек-лист выполнения

### Core изменения

- [ ] Money.value() → Money.value()
- [ ] Создать PriceParseError
- [ ] Создать QuantityParseError
- [ ] Обновить Price.of() для ParseError
- [ ] Обновить Quantity.of() для ParseError
- [ ] Унифицировать проверки инвариантов (NaN → Finite → Domain)
- [ ] Переупорядочить проверки в Money.create()

### ErrorReason cleanup

- [ ] Убрать EXCEEDS_MAX_PRICE и NEGATIVE_PRICE из PriceErrorReason
- [ ] Убрать NEGATIVE_QUANTITY и EXCEEDS_MAX_QUANTITY из QuantityErrorReason
- [ ] Заменить все использования на унифицированные

### Константы

- [ ] Price: заменить методы на static readonly (MIN, MAX, HALF)
- [ ] Price: удалить minValue()/maxValue()
- [ ] Money: убрать lazy initialization ZERO_USDC

### Методы сравнения

- [ ] Price: добавить isLessThan, isGreaterThan, etc
- [ ] Money: добавить isLessThan, isGreaterThan, isZero, isPositive, isNegative
- [ ] Money: добавить assertSameCurrency()

### Exports

- [ ] Price: экспортировать PriceParseError
- [ ] Quantity: экспортировать QuantityParseError

### Facade обновления

- [ ] PriceService: обработка PriceParseError
- [ ] QuantityService: обработка QuantityParseError
- [ ] Обновить все вызовы Price.MIN/max()/half()

### Adapters обновления

- [ ] MoneyFormatter: .value() → .value()
- [ ] MoneySerializer: .value() → .value()

### Тесты

- [ ] Money тесты: все .value() → .value()
- [ ] Price тесты: добавить ParseError тесты
- [ ] Quantity тесты: добавить ParseError тесты
- [ ] PriceService тесты: ParseError handling
- [ ] QuantityService тесты: ParseError handling
- [ ] Price тесты: константы MIN/MAX/HALF
- [ ] Money тесты: константы ZERO_USDC
- [ ] Price тесты: методы сравнения
- [ ] Money тесты: методы сравнения, isZero, isPositive
- [ ] Все тесты проходят (npm test)

### Документация

- [ ] Money docs: все .value() → .value()
- [ ] Все docs: примеры ParseError
- [ ] Все docs: константы через static readonly
- [ ] Все docs: примеры методов сравнения
- [ ] architecture.md: обновить описание единообразия
- [ ] README.md: обновить quick start примеры

### Проверки

- [ ] npm run build - без ошибок
- [ ] npm test - все тесты проходят
- [ ] npm run lint - без ошибок
- [ ] npm run typecheck - без ошибок
- [ ] npm run lint:md - без критичных ошибок

---

## Порядок выполнения

**Рекомендуемый порядок для минимизации конфликтов:**

1. **Этап 2** (ErrorReason cleanup) - не ломает тесты
2. **Этап 3** (Константы) - обновить тесты сразу
3. **Этап 1.2** (ParseError) - добавить новые файлы
4. **Этап 1.3** (Проверки инвариантов) - обновить конструкторы
5. **Этап 1.1** (Money.amount → value) - массовая замена
6. **Этап 4** (Методы сравнения) - новая функциональность
7. **Этап 5** (Exports) - добавить экспорты
8. **Этап 6** (Тесты) - обновить все тесты
9. **Этап 7** (Документация) - обновить docs
10. **Этап 8** (Проверка) - финальная валидация

---

## Метрики успеха

- ✅ Все три value objects имеют метод `value()`
- ✅ Все три различают ParseError и InvariantViolation
- ✅ Единый порядок проверок инвариантов
- ✅ Нет дублирующихся ErrorReason констант
- ✅ Единый подход к константам (static readonly)
- ✅ Полный набор методов сравнения везде
- ✅ Все 476+ тестов проходят
- ✅ Документация актуальна
- ✅ Breaking changes задокументированы

---

**Время выполнения:** ~8-12 часов работы

**Коммиты:** Рекомендуется делать по этапам для возможности отката
