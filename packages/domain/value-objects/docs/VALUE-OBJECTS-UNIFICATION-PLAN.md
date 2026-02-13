# План унификации Value Objects (Price, Quantity, Money)

> **Статус:** Готов к реализации
> **Дата:** 2026-02-02
> **Breaking changes:** Разрешены (объекты не в production)

---

## Цель

Устранить все несогласованности между Price, Quantity и Money для создания единообразного API.

**Найденные проблемы:**

- Money.value() ≠ Price/Quantity.value()
- Разные подходы к константам (методы vs static readonly vs lazy)
- Дублирование в ErrorReason enums
- Разная логика проверок инвариантов
- Money.equals() "тихо убивает" при currency mismatch

---

## Реализация: 7 коммитов

### Коммит 1: Очистка ErrorReason enums

**Цель:** Убрать дублирующиеся константы

#### PriceErrorReason

**Удалить:**

- `EXCEEDS_MAX_PRICE` (дублирует `OUT_OF_RANGE_HIGH`)
- `NEGATIVE_PRICE` (дублирует `OUT_OF_RANGE_LOW`)

**Заменить все использования:**

```bash
# Найти все места:
grep -r "EXCEEDS_MAX_PRICE\|NEGATIVE_PRICE" packages/domain/value-objects/

# Заменить на:
# EXCEEDS_MAX_PRICE → OUT_OF_RANGE_HIGH
# NEGATIVE_PRICE → OUT_OF_RANGE_LOW
```

**Файлы:**

- `src/price/errors/PriceErrorReason.ts`
- Все места использования (~5-10 мест)

#### QuantityErrorReason

**Удалить:**

- `NEGATIVE_QUANTITY` (заменить на `NEGATIVE`)
- `EXCEEDS_MAX_QUANTITY` (не используется)

**Заменить все использования:**

```bash
grep -r "NEGATIVE_QUANTITY\|EXCEEDS_MAX_QUANTITY" packages/domain/value-objects/
# NEGATIVE_QUANTITY → NEGATIVE
```

**Файлы:**

- `src/quantity/errors/QuantityErrorReason.ts`
- `src/quantity/core/Quantity.ts`
- Все тесты Quantity

**Проверка:**

```bash
npm run build
npm test
```

---

### Коммит 2: Унификация констант на static readonly

**Цель:** Единый подход к константам во всех value objects

#### Price - заменить методы на константы

**Удалить:**

```typescript
// Price.ts - удалить эти методы:
public static min(): Price { ... }
public static max(): Price { ... }
public static half(): Price { ... }
public static minValue(): Decimal { ... }
public static maxValue(): Decimal { ... }
```

**Добавить:**

```typescript
// Price.ts
public static readonly MIN = new Price(new Decimal('0.0001'));
public static readonly MAX = new Price(new Decimal('0.9999'));
public static readonly HALF = new Price(new Decimal('0.5'));
```

**Обновить все использования:**

```bash
# Найти:
grep -r "Price\.min()\|Price\.max()\|Price\.half()\|Price\.minValue()\|Price\.maxValue()" packages/domain/value-objects/

# Заменить:
# Price.MIN → Price.MIN
# Price.MAX → Price.MAX
# Price.HALF → Price.HALF
# Price.MIN.value() → Price.MIN.value()
# Price.MAX.value() → Price.MAX.value()
```

**Затронутые файлы:**

- `src/price/core/Price.ts`
- `src/price/facade/PriceService.ts`
- `src/price/rules/**/*.ts`
- Все тесты Price

#### Money - Record для мультивалютности

**Удалить:**

```typescript
// Money.ts
private static _zeroUSDC?: Money;
public static get ZERO_USDC(): Money {
  return this._zeroUSDC ??= Money.create(new Decimal(0), 'USDC');
}
```

**Добавить:**

```typescript
// Money.ts
public static readonly ZERO: Record<SupportedCurrency, Money> = {
  USDC: Money.fromDecimal(new Decimal(0), 'USDC'),
  // При добавлении новой валюты:
  // USDT: Money.fromDecimal(new Decimal(0), 'USDT'),
};
```

**Обновить все использования:**

```bash
grep -r "Money\.ZERO_USDC\|Money\.zero()" packages/domain/value-objects/

# Money.ZERO.USDC → Money.ZERO.USDC
# Money.zero() → Money.ZERO.USDC (или оставить метод как alias)
```

**Затронутые файлы:**

- `src/money/core/Money.ts`
- `src/money/facade/MoneyService.ts`
- Все тесты Money

#### Quantity - оставить как есть

```typescript
// Уже правильно:
public static readonly ZERO = Quantity.of(0);
public static readonly ONE = Quantity.of(1);
```

**Проверка:**

```bash
npm run build
npm test
```

---

### Коммит 3: Убрать ParseError из Money

**Цель:** Упростить код, философия "адекватные данные на входе"

#### Упростить Money.of()

**Было:**

```typescript
public static of(value: number | string, currency: SupportedCurrency = 'USDC'): Money {
  let decimal: Decimal;
  try {
    decimal = new Decimal(value);
  } catch (error) {
    throw new MoneyParseError(String(value));
  }
  return Money.create(decimal, currency);
}
```

**Стало:**

```typescript
public static of(value: number | string, currency: SupportedCurrency = 'USDC'): Money {
  return Money.create(new Decimal(value), currency);
  // Если Decimal не может распарсить - бросит свою ошибку
  // Если значение валидно но нарушает инварианты - бросит MoneyInvariantViolation
}
```

#### Удалить MoneyParseError

```bash
rm src/money/core/MoneyParseError.ts
```

**Обновить exports:**

```typescript
// src/money/core/index.ts
// Удалить: export { MoneyParseError } from './MoneyParseError';
```

#### Обновить MoneyService.create()

**Было:**

```typescript
try {
  const money = Money.of(value, currency);
  return Ok(money);
} catch (error) {
  if (error instanceof MoneyParseError) {
    return Err(new InvalidMoneyError('Parse error', {
      context: { op: 'create', reason: MoneyErrorReason.INVALID_FORMAT, ... }
    }));
  }
  if (error instanceof MoneyInvariantViolation) {
    return Err(new InvalidMoneyError(..., { reason: error.reason }));
  }
  return unexpectedError('create', {}, error, InvalidMoneyError);
}
```

**Стало:**

```typescript
try {
  const money = Money.of(value, currency);
  return Ok(money);
} catch (error) {
  if (error instanceof MoneyInvariantViolation) {
    // Бизнес-правило нарушено
    return Err(new InvalidMoneyError(error.message, {
      context: {
        op: 'create',
        raw: { field: 'value', value: String(value) },
        reason: error.reason
      }
    }));
  }
  // Любая другая ошибка (включая Decimal parse errors) = INVALID_FORMAT
  return Err(new InvalidMoneyError('Invalid format', {
    context: {
      op: 'create',
      raw: { field: 'value', value: String(value) },
      reason: MoneyErrorReason.INVALID_FORMAT
    }
  }));
}
```

**Файлы:**

- `src/money/core/Money.ts`
- `src/money/core/MoneyParseError.ts` (удалить)
- `src/money/core/index.ts`
- `src/money/facade/MoneyService.ts`
- Тесты (удалить тесты MoneyParseError)

**Price/Quantity:** Оставить как есть (уже правильно)

**Проверка:**

```bash
npm run build
npm test
```

---

### Коммит 4: Унификация проверок инвариантов

**Цель:** Единый порядок проверок: NaN → Finite → Domain-specific

#### Price - оставить как есть

```typescript
// Уже правильно:
if (v.isNaN()) throw new PriceInvariantViolation('Price cannot be NaN', PriceErrorReason.NAN);
if (!v.isFinite()) throw new PriceInvariantViolation('Price must be finite', PriceErrorReason.NON_FINITE);
if (v.lessThan(Price.MIN_PRICE)) throw ...OUT_OF_RANGE_LOW;
if (v.greaterThan(Price.MAX_PRICE)) throw ...OUT_OF_RANGE_HIGH;
```

#### Quantity - добавить явную проверку NaN

**Файл:** `src/quantity/core/Quantity.ts`

**Было:**

```typescript
private constructor(private readonly v: Decimal) {
  if (!v.isFinite()) {
    throw new QuantityInvariantViolation('Quantity value must be finite', QuantityErrorReason.NON_FINITE);
  }
  if (v.isNegative()) {
    throw new QuantityInvariantViolation('Quantity value cannot be negative', QuantityErrorReason.NEGATIVE);
  }
}
```

**Стало:**

```typescript
private constructor(private readonly v: Decimal) {
  // Инвариант 1: Not NaN (explicit check)
  if (v.isNaN()) {
    throw new QuantityInvariantViolation('Quantity cannot be NaN', QuantityErrorReason.NAN);
  }

  // Инвариант 2: Must be finite
  if (!v.isFinite()) {
    throw new QuantityInvariantViolation('Quantity must be finite', QuantityErrorReason.NON_FINITE);
  }

  // Инвариант 3: Cannot be negative
  if (v.isNegative()) {
    throw new QuantityInvariantViolation('Quantity cannot be negative', QuantityErrorReason.NEGATIVE);
  }
}
```

**Note:** QuantityErrorReason.NAN уже существует, просто не использовался!

#### Money - переупорядочить проверки

**Файл:** `src/money/core/Money.ts`

**Было:**

```typescript
private static create(amount: Decimal, currency: SupportedCurrency): Money {
  if (!Money.SUPPORTED_CURRENCIES.has(currency)) throw ...UNSUPPORTED_CURRENCY;
  if (amount.isNaN()) throw ...NAN;
  if (!amount.isFinite()) throw ...NON_FINITE;
  if (amount.abs().greaterThan(Money.MAX_AMOUNT)) throw ...EXCEEDS_MAX_AMOUNT;
  return new Money(amount, currency);
}
```

**Стало:**

```typescript
private static create(amount: Decimal, currency: SupportedCurrency): Money {
  // Инвариант 1: Not NaN (самое базовое)
  if (amount.isNaN()) {
    throw new MoneyInvariantViolation('Amount is NaN', MoneyErrorReason.NAN);
  }

  // Инвариант 2: Finite
  if (!amount.isFinite()) {
    throw new MoneyInvariantViolation('Amount must be finite', MoneyErrorReason.NON_FINITE);
  }

  // Инвариант 3: Supported currency
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

**Файлы:**

- `src/quantity/core/Quantity.ts`
- `src/money/core/Money.ts`
- Тесты (проверить что NaN выбрасывает NAN reason)

**Проверка:**

```bash
npm run build
npm test
```

---

### Коммит 5: Money.value() → value()

**Цель:** Единообразие с Price и Quantity

**BREAKING CHANGE** - Замена вручную файл за файлом

#### Money.ts - переименовать метод

**Файл:** `src/money/core/Money.ts`

**Было:**

```typescript
public amount(): Decimal {
  return this.amt;
}

public toDecimal(): Decimal {
  return this.amt;
}
```

**Стало:**

```typescript
public value(): Decimal {
  return this.amt;
}

// toDecimal() удалить полностью
```

#### Обновить все файлы вручную

**Порядок обновления (проверяем после каждого файла):**

1. **MoneyService.ts** (~20 вызовов)

   ```bash
   # Заменить все .value() на .value()
   # Проверить:
   npm run build && npm test
   ```

2. **MoneyFormatter.ts** (~5 вызовов)

   ```bash
   npm run build && npm test
   ```

3. **MoneySerializer.ts** (~2 вызова)

   ```bash
   npm run build && npm test
   ```

4. **Тесты Money** (~50 вызовов):
   - `Money.test.ts`
   - `MoneyService.create.test.ts`
   - `MoneyService.math.test.ts`
   - `MoneyFormatter.test.ts`
   - `MoneySerializer.test.ts`

   ```bash
   # После каждого теста:
   npm test
   ```

5. **Документация** (~10 файлов):
   - `docs/money/core.md`
   - `docs/money/facade.md`
   - `docs/money/adapters.md`
   - `docs/money/examples.md`
   - `docs/money/migration.md`

**Команда для поиска всех мест:**

```bash
grep -rn "\.value()" packages/domain/value-objects/src/money/
grep -rn "\.value()" packages/domain/value-objects/__tests__/unit/money/
grep -rn "\.value()" packages/domain/value-objects/docs/money/
```

**Финальная проверка:**

```bash
npm run build
npm test
npm run lint
npm run typecheck
```

---

### Коммит 6: Методы сравнения

**Цель:** Полный набор методов сравнения во всех value objects

#### Price - добавить в Core

**Файл:** `src/price/core/Price.ts`

**Добавить методы:**

```typescript
/**
 * Проверяет что эта цена меньше другой
 *
 * @param other - Другая цена
 * @returns true если this < other
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

**Добавить тесты:**

```typescript
// __tests__/unit/price/core/Price.test.ts
describe('Price comparison methods', () => {
  it('should compare with isLessThan', () => {
    const p1 = Price.of(0.5);
    const p2 = Price.of(0.6);
    expect(p1.isLessThan(p2)).toBe(true);
    expect(p2.isLessThan(p1)).toBe(false);
  });

  it('should compare with isGreaterThan', () => {
    const p1 = Price.of(0.6);
    const p2 = Price.of(0.5);
    expect(p1.isGreaterThan(p2)).toBe(true);
    expect(p2.isGreaterThan(p1)).toBe(false);
  });

  // ... isLessThanOrEqual, isGreaterThanOrEqual
});
```

#### Quantity - оставить как есть

Уже есть полный набор:

- `isZero()`
- `isPositive()`
- `isLessThan()`
- `isLessThanOrEqual()`
- `isGreaterThan()`
- `isGreaterThanOrEqual()`

#### Money - ТОЛЬКО в Facade

**Core (Money.ts) - минимум:**

**Удалить:**

```typescript
// Удалить этот метод:
public equals(other: Money): boolean {
  return this.cur === other.cur && this.amt.equals(other.amt);
}
```

**Оставить только:**

```typescript
// Money.ts
public hasSameCurrency(other: Money): boolean {
  return this.cur === other.cur;
}
```

**Facade (MoneyService.ts) - добавить методы:**

```typescript
/**
 * Сравнивает две суммы
 *
 * @param a - Первая сумма
 * @param b - Вторая сумма
 * @returns Result<boolean, InvalidMoneyError> где true если a < b
 * @throws Никогда - все ошибки в Result
 *
 * @example
 * ```typescript
 * const result = MoneyService.isLessThan(balance, limit);
 * if (!result.ok) {
 *   console.error('Currency mismatch');
 *   return;
 * }
 * if (result.value) {
 *   console.log('Balance is less than limit');
 * }
 * ```
 */
public static isLessThan(a: Money, b: Money): Result<boolean, InvalidMoneyError> {
  if (!a.hasSameCurrency(b)) {
    return Err(new InvalidMoneyError('Cannot compare Money with different currencies', {
      context: {
        op: 'isLessThan',
        reason: MoneyErrorReason.CURRENCY_MISMATCH,
        expected: a.currency(),
        actual: b.currency()
      }
    }));
  }
  return Ok(a.value().lessThan(b.value()));
}

public static isLessThanOrEqual(a: Money, b: Money): Result<boolean, InvalidMoneyError> {
  if (!a.hasSameCurrency(b)) {
    return Err(new InvalidMoneyError('Cannot compare Money with different currencies', {
      context: {
        op: 'isLessThanOrEqual',
        reason: MoneyErrorReason.CURRENCY_MISMATCH,
        expected: a.currency(),
        actual: b.currency()
      }
    }));
  }
  return Ok(a.value().lessThanOrEqualTo(b.value()));
}

public static isGreaterThan(a: Money, b: Money): Result<boolean, InvalidMoneyError> {
  if (!a.hasSameCurrency(b)) {
    return Err(new InvalidMoneyError('Cannot compare Money with different currencies', {
      context: {
        op: 'isGreaterThan',
        reason: MoneyErrorReason.CURRENCY_MISMATCH,
        expected: a.currency(),
        actual: b.currency()
      }
    }));
  }
  return Ok(a.value().greaterThan(b.value()));
}

public static isGreaterThanOrEqual(a: Money, b: Money): Result<boolean, InvalidMoneyError> {
  if (!a.hasSameCurrency(b)) {
    return Err(new InvalidMoneyError('Cannot compare Money with different currencies', {
      context: {
        op: 'isGreaterThanOrEqual',
        reason: MoneyErrorReason.CURRENCY_MISMATCH,
        expected: a.currency(),
        actual: b.currency()
      }
    }));
  }
  return Ok(a.value().greaterThanOrEqualTo(b.value()));
}

public static equals(a: Money, b: Money): Result<boolean, InvalidMoneyError> {
  if (!a.hasSameCurrency(b)) {
    return Err(new InvalidMoneyError('Cannot compare Money with different currencies', {
      context: {
        op: 'equals',
        reason: MoneyErrorReason.CURRENCY_MISMATCH,
        expected: a.currency(),
        actual: b.currency()
      }
    }));
  }
  return Ok(a.value().equals(b.value()));
}

// Методы без проверки валюты (работают с одним Money):
public static isZero(money: Money): boolean {
  return money.value().isZero();
}

public static isPositive(money: Money): boolean {
  return money.value().greaterThan(0);
}

public static isNegative(money: Money): boolean {
  return money.value().lessThan(0);
}
```

**Добавить тесты:**

```typescript
// __tests__/unit/money/facade/MoneyService.test.ts
describe('MoneyService comparison methods', () => {
  it('should compare money with same currency', () => {
    const m1 = Money.of(100);
    const m2 = Money.of(200);

    const result = MoneyService.isLessThan(m1, m2);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
  });

  it('should return error for different currencies', () => {
    const m1 = Money.of(100, 'USDC');
    // Когда добавим другие валюты:
    // const m2 = Money.of(100, 'USDT');
    // const result = MoneyService.isLessThan(m1, m2);
    // expect(result.ok).toBe(false);
    // expect(result.error.context?.reason).toBe(MoneyErrorReason.CURRENCY_MISMATCH);
  });

  it('should check if money is zero', () => {
    expect(MoneyService.isZero(Money.ZERO.USDC)).toBe(true);
    expect(MoneyService.isZero(Money.of(100))).toBe(false);
  });

  it('should check if money is positive', () => {
    expect(MoneyService.isPositive(Money.of(100))).toBe(true);
    expect(MoneyService.isPositive(Money.ZERO.USDC)).toBe(false);
    expect(MoneyService.isPositive(Money.of(-100))).toBe(false);
  });
});
```

**Файлы:**

- `src/price/core/Price.ts`
- `src/money/core/Money.ts` (удалить equals)
- `src/money/facade/MoneyService.ts` (добавить все методы)
- `__tests__/unit/price/core/Price.test.ts`
- `__tests__/unit/money/facade/MoneyService.test.ts`

**Проверка:**

```bash
npm run build
npm test
```

---

### Коммит 7: Обновление документации

**Цель:** Актуализировать всю документацию

#### Обновить примеры

**1. Money.value() → value():**

```bash
# Найти все:
grep -rn "\.value()" packages/domain/value-objects/docs/money/

# В каждом файле заменить:
const decimal = money.value();  → const decimal = money.value();
```

**Файлы:**

- `docs/money/core.md`
- `docs/money/facade.md`
- `docs/money/adapters.md`
- `docs/money/examples.md`
- `docs/money/migration.md`

**2. Price константы:**

```bash
# Найти:
grep -rn "Price\.min()\|Price\.max()" packages/domain/value-objects/docs/

# Заменить:
const min = Price.MIN;  → const min = Price.MIN;
const max = Price.MAX;  → const max = Price.MAX;
```

**Файлы:**

- `docs/price/core.md`
- `docs/price/facade.md`
- `docs/price/examples.md`

**3. Money константы:**

```bash
# Заменить:
Money.ZERO.USDC  → Money.ZERO.USDC
```

**Файлы:**

- `docs/money/*.md`

#### Добавить примеры новых методов

**Price - методы сравнения:**

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
```

```text

**Money - методы сравнения через Facade:**
```markdown
## Методы сравнения

**Важно:** Money сравнение только через MoneyService из-за проверки валюты.

```typescript
const m1 = Money.of(100, 'USDC');
const m2 = Money.of(200, 'USDC');

// Сравнение - возвращает Result
const result = MoneyService.isLessThan(m1, m2);
if (!result.ok) {
  console.error('Currency mismatch:', result.error.context?.reason);
  return;
}

if (result.value) {
  console.log('m1 < m2');
}

// Проверки без валюты
MoneyService.isZero(money);     // boolean
MoneyService.isPositive(money); // boolean
MoneyService.isNegative(money); // boolean
```

```text

#### Обновить architecture.md

**Добавить раздел:**
```markdown
## Единообразие Value Objects

### Методы доступа к значению

Все value objects используют единый метод `value()`:
- `Price.value(): Decimal`
- `Quantity.value(): Decimal`
- `Money.value(): Decimal`

### Константы

Все используют `public static readonly`:
- Price: `MIN`, `MAX`, `HALF`
- Quantity: `ZERO`, `ONE`
- Money: `ZERO.USDC` (Record для мультивалютности)

### Проверки инвариантов

Единый порядок во всех value objects:
1. NaN check (explicit)
2. Finite check (explicit)
3. Domain-specific checks (Range, Negative, Currency, etc.)

### Методы сравнения

**Price и Quantity:** в Core (scalar values, безопасно)
- `isLessThan()`, `isGreaterThan()`, etc. → `boolean`

**Money:** в Facade (есть контекст валюты)
- `MoneyService.isLessThan()`, etc. → `Result<boolean, InvalidMoneyError>`
- Проверяет совпадение валют
```

**Файлы:**

- Все `docs/**/*.md`
- `docs/README.md`

**Проверка:**

```bash
npm run lint:md
```

---

## Финальная проверка

После всех коммитов:

```bash
# Сборка
npm run build

# Все тесты
npm test

# Линтинг
npm run lint
npm run typecheck

# Markdown
npm run lint:md

# Git статус
git status  # Должно быть чисто
```

**Ожидаемый результат:**

- ✅ Сборка без ошибок
- ✅ Все 476+ тестов проходят
- ✅ Линтер без ошибок
- ✅ TypeScript без ошибок
- ✅ Markdown без критичных ошибок
- ✅ Git clean

---

## CHANGELOG entry

```markdown
## [2.0.0] - 2026-02-02

### Breaking Changes

- **Money**: Renamed `amount()` to `value()` for consistency with Price/Quantity
- **Money**: Removed `toDecimal()` alias (use `value()` instead)
- **Money**: Removed `equals()` from Core (use `MoneyService.equals()` instead)
- **Money**: Changed `ZERO_USDC` to `ZERO.USDC` (Record for multi-currency support)
- **Price**: Replaced methods with constants: `min()` → `MIN`, `max()` → `MAX`, `half()` → `HALF`
- **Price**: Removed `minValue()`, `maxValue()` methods (use `Price.MIN.value()` instead)
- **ErrorReasons**: Removed duplicate constants (use `OUT_OF_RANGE_LOW/HIGH`, `NEGATIVE`)

### Added

- **Price**: Added comparison methods: `isLessThan()`, `isGreaterThan()`, `isLessThanOrEqual()`, `isGreaterThanOrEqual()`
- **Money**: Added comparison methods in Facade: `MoneyService.isLessThan()`, `equals()`, etc. (returns `Result`)
- **Money**: Added utility methods: `MoneyService.isZero()`, `isPositive()`, `isNegative()`

### Changed

- **All Value Objects**: Unified invariant validation order (NaN → Finite → Domain-specific)
- **Quantity**: Added explicit NaN check for consistency
- **Money**: Removed MoneyParseError (simplified error handling)

### Migration Guide

```typescript
// 1. Money - rename method calls
// Before:
const decimal = money.value();
const num = money.toDecimal();

// After:
const decimal = money.value();

// 2. Price - use constants
// Before:
const min = Price.MIN;
const max = Price.MAX;

// After:
const min = Price.MIN;
const max = Price.MAX;

// 3. Money - use Record for ZERO
// Before:
const zero = Money.ZERO.USDC;

// After:
const zero = Money.ZERO.USDC;

// 4. Money - comparison through Facade
// Before:
if (money1.equals(money2)) { ... }

// After:
const result = MoneyService.equals(money1, money2);
if (!result.ok) {
  // Handle currency mismatch
}
if (result.value) { ... }

// 5. ErrorReasons - use unified constants
// Before:
PriceErrorReason.NEGATIVE_PRICE
QuantityErrorReason.NEGATIVE_QUANTITY

// After:
PriceErrorReason.OUT_OF_RANGE_LOW
QuantityErrorReason.NEGATIVE
```

```text

---

## Метрики успеха

- ✅ Все три value objects имеют метод `value()`
- ✅ Единый порядок проверок инвариантов
- ✅ Нет дублирующихся ErrorReason констант
- ✅ Единый подход к константам (static readonly)
- ✅ Полный набор методов сравнения:
  - Price/Quantity: в Core → boolean
  - Money: в Facade → Result
- ✅ Все 476+ тестов проходят
- ✅ Документация актуальна

---

**Готов начинать реализацию с Коммита 1!**
