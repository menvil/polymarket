# Архитектура Quantity Value Object

> Подробное описание архитектурных решений и паттернов

## Содержание

1. [Обзор архитектуры](#обзор-архитектуры)
2. [Паттерн Throws+Facade](#паттерн-throwsfacade)
3. [4-слойная архитектура](#4-слойная-архитектура)
4. [Разделение ответственности](#разделение-ответственности)
5. [Потоки данных](#потоки-данных)
6. [Архитектурные решения](#архитектурные-решения)

---

## Обзор архитектуры

Quantity модуль построен на принципах **Domain-Driven Design** с чётким разделением слоёв по ответственности.

### Ключевые принципы

1. **Иммутабельность** — все операции создают новые экземпляры
2. **Explicit Error Handling** — все ошибки явные через `Result<T, E>`
3. **Single Responsibility** — каждый класс делает одну вещь
4. **Dependency Inversion** — высокоуровневые слои не зависят от низкоуровневых
5. **Open/Closed** — легко расширять, не меняя существующий код

---

## Паттерн Throws+Facade

### Концепция

**Core кидает типизированные исключения** → **Facade ловит и возвращает Result<T, E>**

### Зачем?

1. **Core остаётся чистым** — не знает про `Result<T, E>`, только про domain logic
2. **Facade контролирует errors** — единственная точка, где исключения становятся `Result`
3. **Type safety** — невозможно забыть обработать ошибку
4. **Explicit contracts** — видно какие ошибки могут произойти

### Схема

```text
User Code
    ↓ calls
┌─────────────────────────────────┐
│  Facade Layer (QuantityService) │
│  - Catches exceptions           │
│  - Returns Result<T, E>         │
└─────────────────────────────────┘
    ↓ calls
┌─────────────────────────────────┐
│  Core Layer (Quantity)          │
│  - Throws QuantityInvariant...  │
│  - Pure domain logic            │
└─────────────────────────────────┘
```

### Пример потока

```typescript
// User Code
const result = QuantityService.create(-1);
// result.ok === false
// result.error.context.reason === 'NEGATIVE'

// Что происходит внутри:

// 1. Facade: QuantityService.create()
try {
  const quantity = Quantity.of(-1);  // -> идёт в Core
  return Ok(quantity);
} catch (error) {
  // 2. Core: Quantity.of() бросил QuantityInvariantViolation
  if (error instanceof QuantityInvariantViolation) {
    // 3. Facade: оборачивает в InvalidQuantityError и Result
    return Err(new InvalidQuantityError(...));
  }
}
```

---

## 4-слойная архитектура

### Диаграмма слоёв

```text
┌─────────────────────────────────────────────────────┐
│                  User Code                          │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  Layer 4: Adapters                                  │
│  - QuantitySerializer (точная)                      │
│  - QuantityLossySerializer (lossy)                  │
│  - QuantityFormatter (форматирование)               │
│                                                     │
│  Зависит от: Core, Facade                          │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  Layer 3: Facade                                    │
│  - QuantityService                                  │
│  - Единая точка входа                              │
│  - Result<T, E> обёртка                            │
│  - Error Contract                                   │
│                                                     │
│  Зависит от: Core, Rules, Math                     │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  Layer 2: Rules                                     │
│  - ValidateMinSize                                  │
│  - ValidateResultNonNegative                        │
│  - ValidateDivisorForQuantityDivision               │
│  - ValidateFactorForQuantityMultiplication          │
│  - ValidateStepSizeForQuantity                      │
│                                                     │
│  Зависит от: Ничего (только Decimal, Result)       │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  Layer 1: Core                                      │
│  - Quantity (value object)                          │
│  - QuantityInvariantViolation (exception)           │
│  - Инварианты: finite, non-negative                │
│                                                     │
│  Зависит от: Ничего (только Decimal)               │
└─────────────────────────────────────────────────────┘
```

---

## Разделение ответственности

### Layer 1: Core

**Ответственность:**
- Представление количества как value object
- Гарантия инвариантов (finite, non-negative)
- Базовые операции (equals, isZero, isPositive)

**НЕ делает:**
- Не знает про бизнес-правила (minSize, stepSize)
- Не знает про Result<T, E>
- Не делает арифметику (это делает Facade + Math)

**Пример:**
```typescript
// ✅ Делает
const qty = Quantity.of(10);
qty.isZero();  // false
qty.equals(other);

// ❌ НЕ делает
// qty.add(other);  // нет такого метода!
```

---

### Layer 2: Rules

**Ответственность:**
- Атомарные проверки (одно правило = одна проверка)
- Принимают Decimal, возвращают Result<void, Error>
- Не знают про Quantity (работают с Decimal)

**НЕ делает:**
- Не создают Quantity
- Не знают про операции (add, multiply)

**Пример:**
```typescript
// ✅ Делает
ValidateMinSize.check(new Decimal(10), new Decimal(1));  // Ok
ValidateMinSize.check(new Decimal(0.5), new Decimal(1)); // Err

// ❌ НЕ делает
// ValidateMinSize.check(quantity);  // нет, только Decimal!
```

---

### Layer 3: Facade

**Ответственность:**
- Единая точка входа для всех операций
- Оркестрация Core + Math + Rules
- Обёртка исключений в Result<T, E>
- Facade Error Contract

**НЕ делает:**
- Не реализует бизнес-логику (делегирует Rules)
- Не делает low-level checks (делегирует Core)

**Пример:**
```typescript
// ✅ Делает: оркестрация
QuantityService.add(qty1, qty2)
// Внутри:
// 1. addDecimal(qty1.value(), qty2.value())  <- Math
// 2. this.create(sum)                        <- Core
// 3. Обёртка в Result                        <- Facade

// ✅ Делает: контракт ошибок
if (!result.ok) {
  result.error.context.op;      // 'add'
  result.error.context.quantity1;
  result.error.context.quantity2;
}
```

---

### Layer 4: Adapters

**Ответственность:**
- Сериализация (toJSON/fromJSON)
- Форматирование (toString, toDisplayString)
- Адаптация к внешним системам

**НЕ делает:**
- Не содержит бизнес-логику
- Не валидирует (использует Facade)

---

## Потоки данных

### Поток создания Quantity

```
User Input (number/string/Decimal)
    ↓
QuantityService.create()
    ↓
try {
  Quantity.of()  ← проверяет инварианты
    ↓
  return Ok(quantity)
}
catch (QuantityInvariantViolation) {
    ↓
  return Err(InvalidQuantityError)
}
```

### Поток арифметической операции (add)

```
qty1, qty2
    ↓
QuantityService.add()
    ↓
addDecimal(qty1.value(), qty2.value())  ← @polymarket/math
    ↓
sum: Decimal
    ↓
this.create(sum)  ← проверяет инварианты
    ↓
Result<Quantity, Error>
```

### Поток валидации через Facade

```
User Input
    ↓
QuantityService.create(value)
    ↓
decimal = parse(value)
    ↓
Quantity.fromDecimal(decimal)  ← Core (проверяет инварианты)
    ↓
  если non-negative && finite → Ok
  иначе → QuantityInvariantViolation
    ↓
Facade ловит exception → Result.err(InvalidQuantityError)
    ↓
Result<Quantity, InvalidQuantityError>
```

---

## Архитектурные решения

### 1. Почему Throws+Facade, а не Result везде?

**Решение:** Core кидает исключения, Facade возвращает Result.

**Альтернативы:**
- ❌ Result везде — Core становится зависим от @polymarket/result
- ❌ Exceptions везде — пользователь должен писать try/catch

**Почему выбрали:**
- ✅ Core остаётся чистым domain model
- ✅ Facade обеспечивает type-safe контракт
- ✅ Разделение concerns

---

### 2. Почему Rules не знают про Quantity?

**Решение:** Rules работают только с Decimal.

**Альтернативы:**
- ❌ Rules принимают Quantity — циклическая зависимость

**Почему выбрали:**
- ✅ Нет циклических зависимостей
- ✅ Rules переиспользуемы
- ✅ Тестировать проще

---

### 3. Почему Facade не выбрасывает исключения?

**Решение:** Facade всегда возвращает Result<T, E>.

**Альтернативы:**
- ❌ Facade кидает — пользователь забывает try/catch

**Почему выбрали:**
- ✅ Type-safe на compile time
- ✅ Явное управление ошибками
- ✅ Невозможно забыть обработать

---

### 4. Почему не используем Result.map/flatMap?

**Решение:** Используем простые if/else вместо монадических цепочек.

**Альтернативы:**
- ❌ Монадические цепочки — сложнее читать для junior devs

**Почему выбрали:**
- ✅ Код понятен всем уровням разработчиков
- ✅ Легче отлаживать
- ✅ Производительность одинаковая

---

### 5. Почему zero-copy в fromDecimal()?

**Решение:** `fromDecimal()` не парсит Decimal повторно.

```typescript
// Оптимизация: если value уже Decimal
const quantity = value instanceof Decimal
  ? Quantity.fromDecimal(value)  // zero-copy
  : Quantity.of(value);           // parse
```

**Альтернативы:**
- ❌ Всегда парсить — лишние операции

**Почему выбрали:**
- ✅ Производительность
- ✅ Избегаем повторного парсинга

---

### 6. Почему QuantitySerializer и QuantityLossySerializer раздельно?

**Решение:** Два отдельных класса вместо флага `lossy`.

**Альтернативы:**
- ❌ `QuantitySerializer.toJSON(qty, { lossy: true })`

**Почему выбрали:**
- ✅ Explicit intent (явное намерение)
- ✅ Разные типы возврата (`{ value: string }` vs `{ value: number }`)
- ✅ Компилятор видит разницу

---

## Расширяемость

### Добавление новой операции

Пример: добавить `min(qty1, qty2)`

1. **Facade:** Добавить метод
```typescript
public static min(qty1: Quantity, qty2: Quantity): Result<Quantity, InvalidQuantityError> {
  const smaller = qty1.value().lessThan(qty2.value()) ? qty1 : qty2;
  return Ok(smaller);
}
```

2. **Готово!** Не нужно менять Core/Rules

---

### Добавление нового правила

Пример: добавить `ValidateMaxSize`

1. **Rules:** Создать класс
```typescript
export class ValidateMaxSize {
  public static check(quantity: Decimal, maxSize: Decimal): Result<void, InvalidQuantityError> {
    if (quantity.greaterThan(maxSize)) {
      return Err(new InvalidQuantityError(...));
    }
    return Ok(undefined);
  }
}
```

2. **Facade:** Использовать в методе сервиса
```typescript
// В QuantityService
public static createWithValidation(value: number | string | Decimal, minSize: Decimal, maxSize: Decimal) {
  const createResult = this.create(value);
  if (!createResult.ok) return createResult;

  const qty = createResult.value;
  const decimal = qty.value();

  const minResult = ValidateMinSize.check(decimal, minSize);
  if (!minResult.ok) return Err(withOperationContext(minResult.error, 'createWithValidation'));

  const maxResult = ValidateMaxSize.check(decimal, maxSize);
  if (!maxResult.ok) return Err(withOperationContext(maxResult.error, 'createWithValidation'));

  return Ok(qty);
}
```

3. **Готово!** Core не меняется

---

## Best Practices

### 1. Всегда используйте Facade

❌ **Плохо:**
```typescript
try {
  const qty = Quantity.of(userInput);
} catch (e) {
  // Легко забыть обработать
}
```

✅ **Хорошо:**
```typescript
const result = QuantityService.create(userInput);
if (!result.ok) {
  // Компилятор заставит проверить
}
```

---

### 2. Rules для переиспользуемой логики

❌ **Плохо:** Дублировать проверки
```typescript
// В нескольких местах
if (divisor.lessThanOrEqualTo(0)) { ... }
```

✅ **Хорошо:** Создать Rule
```typescript
ValidateDivisorForQuantityDivision.check(divisor)
```

---

### 3. Композиция правил в Facade

❌ **Плохо:** Смешивать контексты в одном методе
```typescript
// Одна функция для всех контекстов
validateQuantity(qty, minSize?, maxSize?, allowZero?)
```

✅ **Хорошо:** Специализированные методы в Facade
```typescript
// QuantityService предоставляет контекст-специфичные методы
QuantityService.create(value)  // Базовая валидация (Core инварианты)

// Приложение может создать свои методы с композицией Rules
export function validateForOrder(qty: Quantity, minSize: Decimal) {
  const minResult = ValidateMinSize.check(qty.value(), minSize);
  if (!minResult.ok) return minResult;
  return Ok(undefined);
}
```

---

## Заключение

Архитектура Quantity модуля обеспечивает:

1. **Чёткое разделение ответственности** между слоями
2. **Type-safe обработку ошибок** через Result<T, E>
3. **Расширяемость** без изменения существующего кода
4. **Тестируемость** каждого слоя независимо
5. **Читаемость** для разработчиков всех уровней

Следование этим принципам гарантирует maintainable и scalable кодовую базу.
