# Анализ различий и проблемных моментов в Price, Quantity, Money

> Дата анализа: 2026-02-02
> Цель: Выявить несогласованности в реализации value objects для унификации подхода

---

## 1. Обзор

Проанализированы три core value objects:
- **Price** - цена на рынке предсказаний [0.0001, 0.9999]
- **Quantity** - количество акций/токенов [0, +∞]
- **Money** - денежная сумма с валютой [-1e15, 1e15]

---

## 2. Сравнительная таблица Core классов

| Аспект | Price | Quantity | Money |
|--------|-------|----------|-------|
| **Invariant Violation** | PriceInvariantViolation | QuantityInvariantViolation | MoneyInvariantViolation |
| **Parse Error** | ❌ Отсутствует | ❌ Отсутствует | ✅ MoneyParseError |
| **Количество инвариантов** | 4 (NaN, Finite, Low, High) | 2 (Finite, Negative) | 4 (Currency, NaN, Finite, MaxAmount) |
| **Метод доступа к значению** | `value()` | `value()` | `amount()` ❗ |
| **Константы** | MIN, MAX, HALF + методы | ZERO, ONE (static readonly) | ZERO_USDC (lazy singleton) |
| **Методы сравнения** | equals, isMin, isMax | equals, isZero, isPositive, is(Less\|Greater)Than* | equals, hasSameCurrency |
| **Дополнительные поля** | - | - | currency: SupportedCurrency |

---

## 3. Проблемы и несогласованности

### 🔴 Критические проблемы

#### 3.1. Несогласованность в названиях методов доступа

**Проблема:**
```typescript
// Price и Quantity
const decimal = price.value();
const decimal = quantity.value();

// Money - ДРУГОЕ имя! ❌
const decimal = money.amount(); // Должно быть value()
```

**Влияние:**
- Нарушается принцип наименьшего удивления
- Затрудняет переключение между value objects
- Различие не обосновано доменом

**Решение:**
```typescript
// Money.ts
public value(): Decimal {  // Переименовать amount() → value()
  return this.amt;
}
```

#### 3.2. Различия в проверке NaN и Finite

**Проблема:**
```typescript
// Price - проверяет NaN и Finite отдельно
if (v.isNaN()) throw ...;
if (!v.isFinite()) throw ...;

// Quantity - проверяет только Finite (покрывает NaN)
if (!v.isFinite()) throw ...;  // isFinite() возвращает false для NaN

// Money - проверяет NaN и Finite отдельно
if (amount.isNaN()) throw ...;
if (!amount.isFinite()) throw ...;
```

**Влияние:**
- Quantity имеет 1 проверку, Price и Money - 2
- Разные error reasons для одной ситуации

**Анализ Decimal.js:**
```javascript
// Decimal.js behavior
new Decimal(NaN).isFinite()     // false
new Decimal(Infinity).isFinite() // false
```

**Вывод:** `isFinite()` уже покрывает NaN, отдельная проверка избыточна!

**Решение:**
Использовать единый подход Quantity - только `isFinite()`, но различать error reasons:

```typescript
// Единый подход для всех value objects
if (v.isNaN()) {
  throw new InvariantViolation('...', ErrorReason.NAN);
}
if (!v.isFinite()) {
  throw new InvariantViolation('...', ErrorReason.NON_FINITE);
}
```

Это позволяет:
- Различать NaN и Infinity в error reasons
- Явно показывать обе проверки
- Единообразие во всех value objects

#### 3.3. MoneyParseError vs инварианты

**Проблема:**

Money различает parse errors и invariant violations:
```typescript
// Money.of()
try {
  decimal = new Decimal(value);
} catch (error) {
  throw new MoneyParseError(String(value));  // Parse error
}
return Money.create(decimal, currency);  // Может бросить MoneyInvariantViolation
```

Price и Quantity этого не делают:
```typescript
// Price.of() и Quantity.of()
return new Price(new Decimal(value));  // Parse error превращается в InvariantViolation
```

**Влияние:**
- Разная обработка ошибок в Facade
- Money требует 2 catch блока, Price/Quantity - 1
- Facade должен мапить parse errors в INVALID_FORMAT

**Вопрос:** Нужно ли различать parse errors?

**Аргументы ЗА:**
- Parse error ≠ Invariant violation (разные природы)
- Более точная диагностика
- MoneyService может давать разные сообщения

**Аргументы ПРОТИВ:**
- Усложняет код
- Facade все равно мапит оба в InvalidXError с одинаковым reason (INVALID_FORMAT)
- Price и Quantity работают без этого

**Рекомендация:**
Оставить как есть в Money (различение полезно), НО добавить в Price и Quantity для единообразия.

---

### 🟡 Средние проблемы

#### 3.4. Несогласованность в ErrorReason enum

**Проблема - дублирование значений:**
```typescript
// PriceErrorReason
OUT_OF_RANGE_LOW = 'OUT_OF_RANGE_LOW',
OUT_OF_RANGE_HIGH = 'OUT_OF_RANGE_HIGH',
EXCEEDS_MAX_PRICE = 'EXCEEDS_MAX_PRICE',    // ❓ Дублирует OUT_OF_RANGE_HIGH
NEGATIVE_PRICE = 'NEGATIVE_PRICE',          // ❓ Дублирует OUT_OF_RANGE_LOW

// QuantityErrorReason
NEGATIVE_QUANTITY = 'NEGATIVE_QUANTITY',
NEGATIVE = 'NEGATIVE',                      // ❓ Разные negative reasons!

// MoneyErrorReason
NEGATIVE_RESULT = 'NEGATIVE_RESULT',
```

**Проблема - разные названия:**
```typescript
EXCEEDS_MAX_PRICE    // Price
EXCEEDS_MAX_QUANTITY // Quantity
EXCEEDS_MAX_AMOUNT   // Money
```

**Решение:**
```typescript
// Унифицировать:
export enum PriceErrorReason {
  // Core invariants
  NAN = 'NAN',
  NON_FINITE = 'NON_FINITE',
  OUT_OF_RANGE_LOW = 'OUT_OF_RANGE_LOW',    // MIN_PRICE
  OUT_OF_RANGE_HIGH = 'OUT_OF_RANGE_HIGH',  // MAX_PRICE

  // Facade/Rules errors
  DIVISION_BY_ZERO = 'DIVISION_BY_ZERO',
  INVALID_FORMAT = 'INVALID_FORMAT',
  NOT_ALIGNED = 'NOT_ALIGNED',
  INVALID_TICK_SIZE = 'INVALID_TICK_SIZE',
}

export enum QuantityErrorReason {
  // Core invariants
  NAN = 'NAN',
  NON_FINITE = 'NON_FINITE',
  NEGATIVE = 'NEGATIVE',                    // Единое название!

  // Facade/Rules errors
  DIVISION_BY_ZERO = 'DIVISION_BY_ZERO',
  INVALID_FORMAT = 'INVALID_FORMAT',
  INVALID_STEP_SIZE = 'INVALID_STEP_SIZE',
  EXCEEDS_MAX = 'EXCEEDS_MAX',             // Если есть лимит
}

export enum MoneyErrorReason {
  // Core invariants
  NAN = 'NAN',
  NON_FINITE = 'NON_FINITE',
  EXCEEDS_MAX = 'EXCEEDS_MAX',
  UNSUPPORTED_CURRENCY = 'UNSUPPORTED_CURRENCY',

  // Facade/Rules errors
  CURRENCY_MISMATCH = 'CURRENCY_MISMATCH',
  DIVISION_BY_ZERO = 'DIVISION_BY_ZERO',
  INVALID_FORMAT = 'INVALID_FORMAT',
  NEGATIVE_RESULT = 'NEGATIVE_RESULT',     // Для subtract
}
```

#### 3.5. Константы - разные подходы

**Проблема:**
```typescript
// Price - методы + приватные константы
public static min(): Price { return new Price(Price.MIN_PRICE); }
public static minValue(): Decimal { return Price.MIN_PRICE; }
private static readonly MIN_PRICE = new Decimal('0.0001');

// Quantity - публичные статические readonly
public static readonly ZERO = Quantity.of(0);
public static readonly ONE = Quantity.of(1);

// Money - lazy singleton
private static _zeroUSDC?: Money;
public static get ZERO_USDC(): Money {
  return this._zeroUSDC ??= Money.create(new Decimal(0), 'USDC');
}
```

**Влияние:**
- Разный API для одних и тех же концепций
- Price требует вызов метода, Quantity - прямой доступ
- Money использует ленивую инициализацию

**Рекомендация:**
```typescript
// Единый подход - публичные статические readonly (как Quantity)
// Преимущества:
// - Простота использования (Price.ZERO vs Price.zero())
// - Инициализация один раз при загрузке модуля
// - Понятная семантика

export class Price {
  public static readonly MIN = Price.of('0.0001');
  public static readonly MAX = Price.of('0.9999');
  public static readonly HALF = Price.of('0.5');
}

export class Quantity {
  public static readonly ZERO = Quantity.of(0);
  public static readonly ONE = Quantity.of(1);
}

export class Money {
  public static readonly ZERO_USDC = Money.of(0, 'USDC');
  // Lazy initialization не нужна - разница в производительности незначительна
}
```

#### 3.6. Методы сравнения - неполнота

**Проблема:**
```typescript
// Quantity - полный набор
isZero(), isPositive(), isLessThan(), isGreaterThan(),
isLessThanOrEqual(), isGreaterThanOrEqual()

// Price - минимальный набор
equals(), isMin(), isMax()

// Money - минимальный набор
equals(), hasSameCurrency()
```

**Влияние:**
- Приходится сравнивать через `.value()`: `price1.value().lessThan(price2.value())`
- Нарушается инкапсуляция
- Quantity имеет удобный API, Price и Money - нет

**Рекомендация:**
Добавить методы сравнения в Price и Money:

```typescript
// Price
public isLessThan(other: Price): boolean {
  return this.v.lessThan(other.v);
}
// ... аналогично Quantity

// Money - НУЖНО проверять валюту!
public isLessThan(other: Money): boolean {
  if (!this.hasSameCurrency(other)) {
    throw new Error('Cannot compare Money with different currencies');
  }
  return this.amt.lessThan(other.amt);
}
```

---

### 🟢 Минорные проблемы

#### 3.7. Алиас toDecimal() в Money

**Проблема:**
```typescript
// Money
public amount(): Decimal { return this.amt; }
public toDecimal(): Decimal { return this.amt; }  // Алиас
```

Price и Quantity не имеют алиаса.

**Влияние:** Минимальное, но создает API inconsistency

**Решение:**
1. Переименовать `amount()` → `value()` (см. 3.1)
2. Удалить `toDecimal()` алиас

#### 3.8. Порядок проверок инвариантов

**Проблема:**
```typescript
// Price: NaN → Finite → Range
// Quantity: Finite → Negative
// Money: Currency → NaN → Finite → Max
```

**Влияние:** Разный порядок ошибок при нескольких нарушениях

**Рекомендация:**
Единый порядок для всех:
1. NaN (самая фундаментальная проблема)
2. Finite (Infinity)
3. Range/Negative/Currency (доменные ограничения)

---

## 4. Архитектурные различия

### 4.1. Статические методы minValue()/maxValue() в Price

**Назначение:**
```typescript
// Price.ts:209-227
public static minValue(): Decimal { return Price.MIN_PRICE; }
public static maxValue(): Decimal { return Price.MAX_PRICE; }
```

Помечены как `@internal ТОЛЬКО для Rules/Facade`.

**Проблема:**
- Quantity и Money не имеют аналогов
- Rules могут использовать `Price.min().value()` вместо `Price.minValue()`
- Дополнительные методы без явной пользы

**Вопрос:** Нужны ли эти методы?

**Рекомендация:**
Убрать `minValue()`/`maxValue()`. Использовать:
```typescript
// Rules/Facade
const minPrice = Price.MIN.value();  // Через константу
```

### 4.2. of() vs fromDecimal() - семантика

**Текущее состояние:**
```typescript
// Все три одинаково:
Price.of(value: number | string | Decimal)
Price.fromDecimal(decimal: Decimal)

Quantity.of(value: number | string | Decimal)
Quantity.fromDecimal(decimal: Decimal)

Money.of(value: number | string, currency?)
Money.fromDecimal(decimal: Decimal, currency?)
```

**Проблема:**
Money не принимает Decimal в `of()`, но Price и Quantity принимают.

**Решение:**
Единообразие - `of()` принимает все типы:
```typescript
Money.of(value: number | string | Decimal, currency: SupportedCurrency = 'USDC')
```

---

## 5. Рекомендации по унификации

### Приоритет 1 (Критические)

1. **Переименовать Money.amount() → value()**
   - Файлы: Money.ts, MoneyService.ts, все тесты
   - Влияние: Breaking change для всех потребителей
   - Миграция: Добавить deprecated алиас на 1 релиз

2. **Унифицировать проверки инвариантов**
   - Все value objects: NaN → Finite → Domain rules
   - Различать NaN и Infinity в error reasons

3. **Добавить ParseError в Price и Quantity**
   - Различать parse errors и invariant violations
   - Улучшит диагностику

### Приоритет 2 (Важные)

4. **Очистить ErrorReason enums**
   - Убрать дубликаты (NEGATIVE vs NEGATIVE_QUANTITY)
   - Унифицировать названия (EXCEEDS_MAX)

5. **Унифицировать константы**
   - Все через `public static readonly`
   - Убрать lazy initialization в Money

6. **Добавить методы сравнения в Price и Money**
   - isLessThan, isGreaterThan, etc.
   - Для Money - с проверкой валюты

### Приоритет 3 (Желательные)

7. **Убрать minValue()/maxValue() из Price**
8. **Убрать toDecimal() алиас из Money**
9. **Money.of() принимает Decimal**

---

## 6. План миграции

### Фаза 1: Подготовка (backward compatible)

```typescript
// Money.ts
/** @deprecated Use value() instead */
public amount(): Decimal {
  return this.value();
}

public value(): Decimal {
  return this.amt;
}
```

### Фаза 2: Обновление потребителей

- MoneyService
- MoneyFormatter
- MoneySerializer
- Все тесты

### Фаза 3: Breaking changes

- Удалить deprecated методы
- Обновить major version
- Обновить документацию

---

## 7. Итоговая оценка

### Общие сильные стороны

✅ Единая философия: Core throws, Facade returns Result
✅ Использование Decimal.js для точности
✅ Четкое разделение инвариантов и бизнес-правил
✅ TypeScript enums для error reasons

### Основные проблемы

❌ Несогласованность в API (amount vs value)
❌ Разные подходы к константам
❌ Неполнота методов сравнения
❌ Дублирование в error reasons

### Рекомендуемые действия

1. Создать RFC для обсуждения изменений
2. Приоритизировать breaking changes
3. Подготовить migration guide
4. Обновить документацию с примерами до/после

---

## 8. Вопросы для обсуждения

1. **Breaking changes:** Готовы ли мы к major version bump?
2. **ParseError:** Добавлять в Price/Quantity или убрать из Money?
3. **Методы сравнения:** Добавлять везде или оставить только в Quantity?
4. **Константы:** Публичные static readonly или методы?

---

**Следующие шаги:**
- [ ] Обсудить с командой
- [ ] Создать GitHub issues для каждого изменения
- [ ] Написать тесты для миграции
- [ ] Обновить документацию
