# SignedQuantity: Архитектура и Дизайн

Детальная документация архитектурных решений для SignedQuantity Value Object.

## Содержание

- [Обзор архитектуры](#обзор-архитектуры)
- [Слои системы](#слои-системы)
- [Ключевые решения](#ключевые-решения)
- [Паттерны](#паттерны)
- [Сравнение с Quantity](#сравнение-с-quantity)

## Обзор архитектуры

SignedQuantity следует **3-слойной архитектуре** Value Objects в @polymarket/value-objects:

```
┌─────────────────────────────────────────┐
│         Public API (Facade)             │  Result<T, E>
│     SignedQuantityService               │  Never throws
├─────────────────────────────────────────┤
│              Core                       │  Throws on invariant violation
│         SignedQuantity                  │  Business logic
├─────────────────────────────────────────┤
│            Adapters                     │  I/O, formatting
│  Formatter, Serializer                  │
└─────────────────────────────────────────┘
```

### Принципы

1. **Immutability** — все операции возвращают новые экземпляры
2. **Type Safety** — строгая типизация через TypeScript
3. **Decimal Precision** — Decimal.js для точности вычислений
4. **Result Pattern** — ошибки через `Result<T, E>`, не exceptions в публичном API
5. **Single Responsibility** — каждый слой имеет четкую ответственность

## Слои системы

### 1. Core Layer

**Ответственность:** бизнес-логика, инварианты, immutable состояние.

```typescript
// signed-quantity/core/SignedQuantity.ts
export class SignedQuantity {
  private constructor(private readonly _value: Decimal) {
    // Инварианты проверяются в конструкторе
    if (_value.isNaN()) { throw ... }
    if (!_value.isFinite()) { throw ... }
  }

  public static of(value: Decimal): SignedQuantity {
    // Нормализация -0 → 0
    const normalized = value.isZero() ? new Decimal(0) : value;
    return new SignedQuantity(normalized);
  }

  // Instance методы: value(), toNumber(), comparisons, sign operations
}
```

**Характеристики Core:**
- ✅ Бросает исключения при нарушении инвариантов
- ✅ Не парсит — принимает готовый Decimal
- ✅ Не знает о Result<T, E>
- ✅ Содержит ТОЛЬКО бизнес-логику

**Инварианты (проверяются в constructor):**
1. Not NaN (`_value.isNaN()` → throw)
2. Must be finite (`!_value.isFinite()` → throw)
3. -0 normalization (в `of()`)

**Критическое решение: abs() возвращает Decimal, не SignedQuantity**

```typescript
public abs(): Decimal {
  return this._value.abs();
}
```

**Обоснование:**
- Абсолютное значение всегда >= 0 → семантически это Quantity, а не SignedQuantity
- Возврат Decimal даёт гибкость: можно создать Quantity через QuantityService
- Консистентность с математикой: |x| теряет информацию о знаке

### 2. Facade Layer

**Ответственность:** публичный API, парсинг, оркестрация, Result<T, E>.

```typescript
// signed-quantity/facade/SignedQuantityService.ts
export class SignedQuantityService {
  /**
   * Контракт "Never Throw"
   * Все методы ГАРАНТИРОВАННО возвращают Result
   */
  public static create(value: number | string | Decimal): Result<SignedQuantity, InvalidSignedQuantityError> {
    // 1. Парсинг через toDecimal() (безопасный)
    const decimalResult = toDecimal('value', value, ...);
    if (isErr(decimalResult)) {
      return Err(rewrap(...));
    }

    // 2. Создание через Core (может бросить)
    return wrapOp('SignedQuantityService', 'create', {}, () => {
      const qty = SignedQuantity.of(decimalResult.value);
      return Ok(qty);
    }, InvalidSignedQuantityError);
  }

  // add, subtract, multiply, divide, abs, negate
}
```

**Характеристики Facade:**
- ✅ НИКОГДА не бросает исключения
- ✅ Все методы возвращают `Result<T, E>`
- ✅ Парсит входные данные (через `toDecimal()`)
- ✅ Оркестрирует Core + Math + Rules
- ✅ Использует `wrapOp()` и `rewrap()` для обработки ошибок

**Error Context Contract:**

Каждая ошибка содержит:
- `context.op` — название операции ('create', 'add', 'divide', ...)
- `context.opChain` — цепочка операций (внутренние op не теряются)
- `context.quantity`, `context.factor`, `context.divisor` — входные данные
- `context.raw` — сырой ввод для ошибок парсинга
- `context.cause` — для math-исключений (root-cause)
- `context.reason` — для инвариантов Core (SignedQuantityErrorReason)

### 3. Adapters Layer

**Ответственность:** форматирование, сериализация, I/O.

**SignedQuantityFormatter:**
```typescript
export class SignedQuantityFormatter {
  // Стандартные форматы
  public static toString(qty, decimals, options): Result<string, InvalidDecimalPlacesError>
  public static toCompactString(qty, options): string
  public static toDebugString(qty): string

  // Финансовый формат (negative in parentheses)
  public static toFinancialString(qty, decimals): Result<string, InvalidDecimalPlacesError>

  // Дисплейный формат с K/M суффиксами
  public static toDisplayString(qty, options): string

  // P&L формат для UI
  public static toPnLString(qty, decimals): Result<{ value, indicator }, InvalidDecimalPlacesError>
}
```

**Опции форматирования:**
- `showPlusSign?: boolean` — показывать ли знак "+" для положительных (default: true)

**SignedQuantitySerializer:**
```typescript
export class SignedQuantitySerializer {
  // JSON контракт: { value: string }
  public static toJSON(qty): SignedQuantityJSON
  public static fromJSON(json: unknown): Result<SignedQuantity, InvalidSignedQuantityError>
}
```

**Характеристики Adapters:**
- ✅ Граница системы (работа с unknown, string, JSON)
- ✅ Полная валидация на входе
- ✅ Использует Facade для создания VO

## Ключевые решения

### 1. Нормализация -0 → 0

**Проблема:** Decimal.js различает +0 и -0, что может вызвать неожиданное поведение.

**Решение:**
```typescript
public static of(value: Decimal): SignedQuantity {
  // Нормализация -0 → 0
  const normalized = value.isZero() ? new Decimal(0) : value;
  return new SignedQuantity(normalized);
}
```

**Обоснование:**
- Математически -0 и +0 эквивалентны для бизнес-логики
- Избегаем edge cases при сравнениях
- Консистентность: `SignedQuantity.ZERO.equals(SignedQuantity.of(new Decimal(-0)))` → true

### 2. Строго типизированный sign()

```typescript
public sign(): -1 | 0 | 1 {
  if (this._value.isZero()) return 0;
  return this._value.isNegative() ? -1 : 1;
}
```

**Обоснование:**
- Тип `-1 | 0 | 1` вместо `number` → type safety
- Компилятор может проверить exhaustiveness в switch
- Явно документирует все возможные значения

### 3. abs() возвращает Decimal, не SignedQuantity

```typescript
public abs(): Decimal {
  return this._value.abs();
}
```

**Альтернатива (отклонена):**
```typescript
// ❌ НЕ используем
public abs(): SignedQuantity {
  return SignedQuantity.of(this._value.abs());
}
```

**Обоснование:**
- |x| всегда >= 0 → семантически это Quantity
- Возврат Decimal позволяет конвертацию в Quantity:
  ```typescript
  const absQty = QuantityService.create(signedQty.abs());
  ```
- Избегаем семантической путаницы (SignedQuantity с гарантией >= 0)

### 4. neg() для инверсии знака

```typescript
public neg(): SignedQuantity {
  return SignedQuantity.of(this._value.negated());
}
```

**Альтернативы (отклонены):**
- `negate()` — слишком длинный
- `inverse()` — может быть неоднозначно (1/x?)
- `opposite()` — менее математический

**Обоснование:**
- `neg()` — короткий, математически корректный (negation)
- Консистентен с Decimal.js: `decimal.negated()`
- Явно показывает операцию над знаком

### 5. Операции могут принимать отрицательные значения

**Отличие от Quantity:**

```typescript
// Quantity: factor должен быть >= 0
QuantityService.multiply(qty, -1); // ❌ Err: factor must be non-negative

// SignedQuantity: factor может быть отрицательным
SignedQuantityService.multiply(qty, -1); // ✅ Ok: инверсия знака
```

**Обоснование:**
- SignedQuantity предназначен для работы со знаковыми величинами
- Умножение на отрицательный factor = change direction
- Деление на отрицательный divisor также валидно

### 6. Контракт "Never Throw" в Facade

**Все методы Service возвращают Result:**

```typescript
public static create(...): Result<SignedQuantity, InvalidSignedQuantityError>
public static add(...): Result<SignedQuantity, InvalidSignedQuantityError>
public static divide(...): Result<SignedQuantity, InvalidSignedQuantityError>
```

**Обоснование:**
- Явная обработка ошибок на уровне типов
- Компилятор заставляет обрабатывать ошибки
- Нет неожиданных exceptions в runtime

## Паттерны

### Throws+Facade Pattern

```typescript
// Core Layer (throws)
export class SignedQuantity {
  private constructor(private readonly _value: Decimal) {
    if (_value.isNaN()) {
      throw new SignedQuantityInvariantViolation(...);
    }
  }
}

// Facade Layer (Result)
export class SignedQuantityService {
  public static create(value: number | string | Decimal): Result<SignedQuantity, InvalidSignedQuantityError> {
    return wrapOp('SignedQuantityService', 'create', {}, () => {
      const qty = SignedQuantity.of(decimal); // может бросить
      return Ok(qty);
    }, InvalidSignedQuantityError);
  }
}

// Публичный код
const result = SignedQuantityService.create(10);
if (result.ok) {
  // работаем с result.value
}
```

**Преимущества:**
- Core остаётся простым (throws)
- Facade обрабатывает все exceptions → Result
- Публичный API гарантированно безопасен

### Immutable Operations Pattern

```typescript
const qty = SignedQuantityService.create(10).value;

// Все операции возвращают НОВЫЙ экземпляр
const negated = qty.neg();

console.log(qty.toNumber());     // 10 (оригинал не изменён)
console.log(negated.toNumber()); // -10 (новый экземпляр)
```

### Константы для часто используемых значений

```typescript
export class SignedQuantity {
  public static readonly ZERO = SignedQuantity.of(new Decimal(0));
  public static readonly ONE = SignedQuantity.of(new Decimal(1));
  public static readonly MINUS_ONE = SignedQuantity.of(new Decimal(-1));
}
```

**Преимущества:**
- Избегаем создания одних и тех же объектов
- Читаемость: `SignedQuantity.ZERO` вместо `SignedQuantityService.create(0)`
- Производительность: shared instances

## Сравнение с Quantity

| Аспект | Quantity | SignedQuantity |
|--------|----------|----------------|
| **Диапазон** | >= 0 | любое finite |
| **Инварианты** | finite, non-negative | finite |
| **Валидация subtract** | ValidateResultNonNegative | нет проверки |
| **Валидация multiply** | ValidateFactorNonNegative | нет проверки |
| **Методы sign** | нет (всегда >= 0) | sign(), abs(), neg() |
| **Use cases** | абсолютные количества | относительные изменения |

### Когда использовать что?

**Используй Quantity:**
- Абсолютные количества акций, объёмы
- Размеры ордеров, лимиты
- Всё, что не может быть отрицательным

**Используй SignedQuantity:**
- Position deltas (+100 купил, -50 продал)
- Profit & Loss (прибыль/убыток)
- Net positions после операций
- Account balance changes
- Любые изменения, которые могут быть в обе стороны

## Тестирование

### Test Coverage

- **Core Layer**: 50 тестов
  - of() — создание, нормализация, инварианты
  - Константы (ZERO, ONE, MINUS_ONE)
  - Сравнения и проверки знака
  - Операции со знаком (sign(), abs(), neg())
  - Immutability

- **Facade Layer**: 39 тестов
  - create() — парсинг, валидация
  - Арифметика (add, subtract, multiply, divide)
  - Операции со знаком (abs, negate)
  - Integration scenarios (P&L, position reversal)

- **Adapters Layer**: 51 тест
  - Formatter (27 тестов) — все форматы, опции
  - Serializer (24 теста) — сериализация, структурные ошибки, round-trip

**Итого: 140 тестов**

### Test Patterns

```typescript
// Тестирование через Facade
const result = SignedQuantityService.create(-10);
expect(result.ok).toBe(true);
if (result.ok) {
  expect(result.value.toNumber()).toBe(-10);
}

// Тестирование инвариантов Core
expect(() => SignedQuantity.of(new Decimal(NaN))).toThrow(SignedQuantityInvariantViolation);
```

## Будущие улучшения

### Возможные расширения

1. **Rounding операции**
   - `roundToStep()` с поддержкой отрицательных
   - `ceil()`, `floor()`, `round()`

2. **Batch операции**
   - `sumAll(quantities: SignedQuantity[])`
   - `average(quantities: SignedQuantity[])`

3. **Конверсия**
   - `toQuantity(): Result<Quantity, Error>` (если >= 0)
   - `fromQuantity(qty: Quantity, sign: -1 | 1)`

4. **Percentage операции**
   - `percentage(base: SignedQuantity): Result<Ratio, Error>`
   - `applyPercentage(percent: Ratio)`

### Compatibility

При добавлении новых методов:
- ✅ Всё через Facade (Result<T, E>)
- ✅ Core остаётся minimal (только инварианты)
- ✅ Backward compatibility (не ломать существующий API)
- ✅ Документировать использование и edge cases

## См. также

- [README.md](../README.md) — основная документация
- [examples.md](./examples.md) — примеры использования
- [facade.md](./facade.md) — детали SignedQuantityService
