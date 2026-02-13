# План унификации Value Objects - ОБСУЖДЕНИЕ

> Статус: В обсуждении
> Обсуждаем пошагово, корректируем, затем реализуем

---

## ✅ Коммит 1: Очистка ErrorReason enums

**Что делаем:**

- Убрать дубликаты из PriceErrorReason (EXCEEDS_MAX_PRICE, NEGATIVE_PRICE)
- Убрать дубликаты из QuantityErrorReason (NEGATIVE_QUANTITY, EXCEEDS_MAX_QUANTITY)
- Заменить все использования на OUT_OF_RANGE_LOW/HIGH и NEGATIVE

**Статус:** ✅ Одобрено

---

## ✅ Коммит 2: Константы - унификация на static readonly

**Что предлагаю:**

### Price

```typescript
// БЫЛО:
public static min(): Price { return new Price(Price.MIN_PRICE); }
public static max(): Price { return new Price(Price.MAX_PRICE); }
public static half(): Price { return new Price(Price.HALF_PRICE); }
public static minValue(): Decimal { return Price.MIN_PRICE; }
public static maxValue(): Decimal { return Price.MAX_PRICE; }

// СТАЛО:
public static readonly MIN = Price.fromDecimal(Price.MIN_PRICE);
public static readonly MAX = Price.fromDecimal(Price.MAX_PRICE);
public static readonly HALF = Price.fromDecimal(Price.HALF_PRICE);
// Удалить minValue()/maxValue() - не нужны
```

**Использование:**

```typescript
// БЫЛО:
const min = Price.MIN;

// СТАЛО:
const min = Price.MIN;
```

### Money

```typescript
// БЫЛО:
private static _zeroUSDC?: Money;
public static get ZERO_USDC(): Money {
  return this._zeroUSDC ??= Money.create(new Decimal(0), 'USDC');
}

// СТАЛО:
public static readonly ZERO_USDC = Money.fromDecimal(new Decimal(0), 'USDC');
```

### Quantity

Уже правильно! Оставить как есть:

```typescript
public static readonly ZERO = Quantity.of(0);
public static readonly ONE = Quantity.of(1);
```

**РЕШЕНИЕ:**

### Price - переименовать константы

```typescript
// БЫЛО:
private static readonly MIN_PRICE = new Decimal('0.0001');
private static readonly MAX_PRICE = new Decimal('0.9999');
private static readonly HALF_PRICE = new Decimal('0.5');

public static min(): Price { ... }
public static max(): Price { ... }
public static half(): Price { ... }
public static minValue(): Decimal { ... }  // @internal
public static maxValue(): Decimal { ... }  // @internal

// СТАЛО:
public static readonly MIN = new Price(new Decimal('0.0001'));
public static readonly MAX = new Price(new Decimal('0.9999'));
public static readonly HALF = new Price(new Decimal('0.5'));

// Удалить: min(), max(), half(), minValue(), maxValue()
```

**Использование:**

```typescript
// БЫЛО:
const min = Price.MIN;
const minVal = Price.MIN.value();

// СТАЛО:
const min = Price.MIN;
const minVal = Price.MIN.value();  // Вместо minValue()
```

### Money - Record с константами для каждой валюты

```typescript
// БЫЛО:
private static _zeroUSDC?: Money;
public static get ZERO_USDC(): Money {
  return this._zeroUSDC ??= Money.create(new Decimal(0), 'USDC');
}

// СТАЛО:
public static readonly ZERO: Record<SupportedCurrency, Money> = {
  USDC: Money.fromDecimal(new Decimal(0), 'USDC'),
  // Когда добавим USDT:
  // USDT: Money.fromDecimal(new Decimal(0), 'USDT'),
};
```

**Использование:**

```typescript
// БЫЛО:
const zero = Money.ZERO.USDC;

// СТАЛО:
const zero = Money.ZERO.USDC;  // Явно указываем валюту
const zeroUsdt = Money.ZERO.USDT;  // Когда добавим
```

**Преимущества:**

- ✅ Понятно о какой валюте речь
- ✅ Легко добавить новые валюты
- ✅ Type-safe (TypeScript знает все валюты)

### Quantity - оставить как есть

```typescript
public static readonly ZERO = Quantity.of(0);
public static readonly ONE = Quantity.of(1);
```

**Затронутые файлы:**

- `src/price/core/Price.ts` - константы, удаление методов
- `src/price/facade/PriceService.ts` - `Price.MIN` → `Price.MIN`
- `src/price/rules/**` - `Price.MIN.value()` → `Price.MIN.value()`
- `src/money/core/Money.ts` - Record для ZERO
- `src/money/facade/MoneyService.ts` - `Money.ZERO.USDC` → `Money.ZERO.USDC`
- Все тесты Price и Money

**Статус:** ✅ Одобрено

---

## ✅ Коммит 3: Убрать ParseError из Money

**РЕШЕНИЕ:** Убрать ParseError везде. Философия - данные должны быть адекватными на входе, все проверки в конструкторе.

**Что делаем:**

### 1. Упростить Money.of()

```typescript
// БЫЛО:
public static of(value: number | string, currency: SupportedCurrency = 'USDC'): Money {
  let decimal: Decimal;
  try {
    decimal = new Decimal(value);
  } catch (error) {
    throw new MoneyParseError(String(value));
  }
  return Money.create(decimal, currency);
}

// СТАЛО:
public static of(value: number | string, currency: SupportedCurrency = 'USDC'): Money {
  return Money.create(new Decimal(value), currency);
  // Если Decimal не может распарсить - бросит свою ошибку
  // Если значение валидно но нарушает инварианты - бросит MoneyInvariantViolation
}
```

### 2. Удалить MoneyParseError.ts

### 3. Обновить MoneyService.create()

```typescript
// БЫЛО:
try {
  const money = Money.of(value, currency);
  return Ok(money);
} catch (error) {
  if (error instanceof MoneyParseError) {
    return Err(new InvalidMoneyError(...INVALID_FORMAT));
  }
  if (error instanceof MoneyInvariantViolation) {
    return Err(new InvalidMoneyError(...error.reason));
  }
  return unexpectedError(...);
}

// СТАЛО:
try {
  const money = Money.of(value, currency);
  return Ok(money);
} catch (error) {
  if (error instanceof MoneyInvariantViolation) {
    return Err(new InvalidMoneyError(...error.reason));
  }
  // Любая другая ошибка (включая Decimal parse errors) = INVALID_FORMAT
  return Err(new InvalidMoneyError(...INVALID_FORMAT));
}
```

### 4. Price и Quantity - оставить как есть

```typescript
// Уже правильно - просто пробрасываем:
public static of(value: number | string | Decimal): Price {
  return value instanceof Decimal
    ? Price.fromDecimal(value)
    : new Price(new Decimal(value));
}
```

**Преимущества:**

- ✅ Меньше кода (убираем MoneyParseError.ts)
- ✅ Проще логика (меньше типов ошибок)
- ✅ Единообразие (все три value objects одинаковые)
- ✅ Философия: адекватные данные на входе, проверки в конструкторе

**Статус:** ✅ Одобрено

---

## ✅ Коммит 4: Унификация проверок инвариантов

**Текущая ситуация:**

### Price (проверяет отдельно NaN и Finite)

```typescript
if (v.isNaN()) throw ...NAN;
if (!v.isFinite()) throw ...NON_FINITE;
if (v.lessThan(MIN)) throw ...OUT_OF_RANGE_LOW;
if (v.greaterThan(MAX)) throw ...OUT_OF_RANGE_HIGH;
```

### Quantity (только Finite)

```typescript
if (!v.isFinite()) throw ...NON_FINITE;  // isFinite() покрывает NaN
if (v.isNegative()) throw ...NEGATIVE;
```

### Money (проверяет отдельно)

```typescript
if (amount.isNaN()) throw ...NAN;
if (!amount.isFinite()) throw ...NON_FINITE;
if (!SUPPORTED_CURRENCIES.has(currency)) throw ...UNSUPPORTED_CURRENCY;
if (amount.abs().greaterThan(MAX)) throw ...EXCEEDS_MAX_AMOUNT;
```

**Вопрос:**

1. Нужно ли проверять NaN отдельно если isFinite() его покрывает?
2. Или проверять отдельно чтобы давать разные error reasons (NAN vs NON_FINITE)?

**Decimal.js поведение:**

```javascript
new Decimal(NaN).isFinite()     // false
new Decimal(Infinity).isFinite() // false
new Decimal(NaN).isNaN()        // true
new Decimal(Infinity).isNaN()   // false
```

**Варианты:**

**Вариант A: Проверять отдельно (как Price/Money)**

```typescript
if (v.isNaN()) throw ...NAN;
if (!v.isFinite()) throw ...NON_FINITE;
```

- Pros: Разные error reasons для NaN и Infinity
- Cons: Дублирование проверки

**Вариант B: Только isFinite (как Quantity)**

```typescript
if (!v.isFinite()) throw ...NON_FINITE;  // Покрывает NaN
```

- Pros: Одна проверка
- Cons: Не различаем NaN и Infinity

**РЕШЕНИЕ: Вариант A** - проверять отдельно для разных error reasons

### Что делаем

**Price - оставить как есть** (уже правильно):

```typescript
if (v.isNaN()) throw new PriceInvariantViolation('...', PriceErrorReason.NAN);
if (!v.isFinite()) throw new PriceInvariantViolation('...', PriceErrorReason.NON_FINITE);
if (v.lessThan(MIN_PRICE)) throw ...OUT_OF_RANGE_LOW;
if (v.greaterThan(MAX_PRICE)) throw ...OUT_OF_RANGE_HIGH;
```

**Quantity - добавить явную проверку NaN**:

```typescript
// БЫЛО:
if (!v.isFinite()) throw new QuantityInvariantViolation('...', QuantityErrorReason.NON_FINITE);
if (v.isNegative()) throw ...NEGATIVE;

// СТАЛО:
if (v.isNaN()) throw new QuantityInvariantViolation('Quantity cannot be NaN', QuantityErrorReason.NAN);
if (!v.isFinite()) throw new QuantityInvariantViolation('Quantity must be finite', QuantityErrorReason.NON_FINITE);
if (v.isNegative()) throw new QuantityInvariantViolation('Quantity cannot be negative', QuantityErrorReason.NEGATIVE);
```

**Money - переупорядочить для единообразия**:

```typescript
// БЫЛО (в методе create()):
// 1. Currency check
// 2. NaN check
// 3. Finite check
// 4. Max amount check

// СТАЛО (единый порядок для всех):
// 1. NaN check (самое базовое)
// 2. Finite check
// 3. Domain-specific checks (Currency, Max, Range, etc)

if (amount.isNaN()) throw ...NAN;
if (!amount.isFinite()) throw ...NON_FINITE;
if (!SUPPORTED_CURRENCIES.has(currency)) throw ...UNSUPPORTED_CURRENCY;
if (amount.abs().greaterThan(MAX_AMOUNT)) throw ...EXCEEDS_MAX_AMOUNT;
```

**Единый порядок проверок для всех value objects:**

1. ✅ NaN check (explicit)
2. ✅ Finite check (explicit)
3. ✅ Domain-specific (Range/Negative/Currency/Max)

**Преимущества:**

- ✅ Разные error reasons для NaN и Infinity
- ✅ Более детальная диагностика
- ✅ Единообразие во всех value objects

**Статус:** ✅ Одобрено

---

## ✅ Коммит 5: Money.value() → value()

**BREAKING CHANGE**

**РЕШЕНИЕ:**

- ✅ Переименовать amount() → value()
- ✅ Удалить toDecimal() алиас
- ✅ Замена вручную файл за файлом для максимального контроля

**Что делаем:**

### 1. Money.ts

```typescript
// БЫЛО:
public amount(): Decimal { return this.amt; }
public toDecimal(): Decimal { return this.amt; }

// СТАЛО:
public value(): Decimal { return this.amt; }
// toDecimal() удалить полностью
```

### 2. Обновить все файлы (вручную)

**Код (проверить каждый файл):**

- `src/money/facade/MoneyService.ts` - все `.value()` → `.value()`
- `src/money/adapters/MoneyFormatter.ts` - все `.value()` → `.value()`
- `src/money/adapters/MoneySerializer.ts` - все `.value()` → `.value()`

**Тесты (проверить каждый файл):**

- `__tests__/unit/money/core/Money.test.ts`
- `__tests__/unit/money/facade/MoneyService.create.test.ts`
- `__tests__/unit/money/facade/MoneyService.math.test.ts`
- `__tests__/unit/money/adapters/MoneyFormatter.test.ts`
- `__tests__/unit/money/adapters/MoneySerializer.test.ts`

**Документация (проверить каждый файл):**

- `docs/money/core.md`
- `docs/money/facade.md`
- `docs/money/adapters.md`
- `docs/money/examples.md`
- `docs/money/migration.md`

### 3. Проверки после каждого файла

```bash
npm run build   # Должно компилироваться
npm test        # Все тесты должны проходить
```

**Преимущества ручной замены:**

- ✅ Максимальный контроль
- ✅ Видим что именно меняем
- ✅ Не заменим случайно что-то не то
- ✅ Можем добавлять комментарии если нужно

**Статус:** ✅ Одобрено

---

## ✅ Коммит 6: Методы сравнения

**Что предлагаю добавить:**

### Price

```typescript
isLessThan(other: Price): boolean
isLessThanOrEqual(other: Price): boolean
isGreaterThan(other: Price): boolean
isGreaterThanOrEqual(other: Price): boolean
```

### Money

```typescript
isLessThan(other: Money): boolean
isLessThanOrEqual(other: Money): boolean
isGreaterThan(other: Money): boolean
isGreaterThanOrEqual(other: Money): boolean
isZero(): boolean
isPositive(): boolean
isNegative(): boolean
```

**Для Money нужна проверка валюты:**

```typescript
private assertSameCurrency(other: Money): void {
  if (!this.hasSameCurrency(other)) {
    throw new Error('Cannot compare Money with different currencies');
  }
}
```

**Вопрос:** Нужны ли эти методы или достаточно `.value().lessThan()`?

---

## ❓ Коммит 7: Документация

**Что обновлять:**

- Все примеры с `.value()` → `.value()`
- Все примеры с `Price.MIN` → `Price.MIN`
- Добавить примеры ParseError (если решим добавить)
- Добавить примеры методов сравнения (если решим добавить)

**Вопросы:**

1. Какие еще части документации нужно обновить?
2. Нужны ли migration guides?

---

## Итоговые вопросы для обсуждения

1. ✅ **Дубликаты в ErrorReason** - убрать (одобрено)
2. ❓ **Константы** - методы → static readonly?
3. ❓ **ParseError** - добавлять везде / убрать везде / оставить как есть?
4. ❓ **Проверки инвариантов** - NaN отдельно или через isFinite?
5. ❓ **Money.value()** - переименовать в value()?
6. ❓ **Методы сравнения** - добавлять или нет?
7. ❓ **Документация** - что еще обновить?

---

**Следующий шаг:** Обсудим пункт 2 (Константы)?

---

**РЕШЕНИЕ для методов сравнения:**

### Price - добавить в Core (безопасно, нет контекста)

```typescript
// Price.ts
isLessThan(other: Price): boolean {
  return this.v.lessThan(other.v);
}

isLessThanOrEqual(other: Price): boolean {
  return this.v.lessThanOrEqualTo(other.v);
}

isGreaterThan(other: Price): boolean {
  return this.v.greaterThan(other.v);
}

isGreaterThanOrEqual(other: Price): boolean {
  return this.v.greaterThanOrEqualTo(other.v);
}
```

### Quantity - оставить как есть (уже есть полный набор)

### Money - ТОЛЬКО в Facade (есть контекст валюты)

**Core (Money.ts):**

```typescript
// ОСТАВИТЬ только:
hasSameCurrency(other: Money): boolean

// УДАЛИТЬ:
equals(other: Money): boolean  // Перенести в Facade
```

**Facade (MoneyService.ts):**

```typescript
public static isLessThan(a: Money, b: Money): Result<boolean, InvalidMoneyError>
public static isGreaterThan(a: Money, b: Money): Result<boolean, InvalidMoneyError>
public static equals(a: Money, b: Money): Result<boolean, InvalidMoneyError>
// etc.
```

**Статус:** ✅ Одобрено
