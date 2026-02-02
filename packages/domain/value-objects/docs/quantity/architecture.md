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
- Контракт "Never Throw" — никогда не бросает исключения

**НЕ делает:**

- Не реализует бизнес-логику (делегирует Rules)
- Не делает low-level checks (делегирует Core)

**Helper Methods (приватные):**
Facade использует централизованные helper methods для обработки ошибок:

1. **`toCause(e: unknown)`** — извлекает структурированный cause из любой ошибки

   ```typescript
   // Error → { name, message, stack }
   // Unknown → { name: 'UnknownError', message: String(e) }
   ```

2. **`expectedMathError(op, ctx, e)`** — создаёт InvalidQuantityError для ожидаемых ошибок из @polymarket/math

   ```typescript
   // Для InvalidQuantityError, ArithmeticOverflowError, DivisionByZeroError
   // Добавляет op, ctx и cause
   ```

3. **`unexpectedError(op, ctx, e)`** — создаёт InvalidQuantityError для неожиданных ошибок

   ```typescript
   // Для любых других исключений
   // Включает полный stack trace для debugging
   ```

4. **`rewrap(op, ctx, err)`** — обёртывает InvalidQuantityError с добавлением op и контекста

   ```typescript
   // Порядок мерджа защищает приоритет err.context:
   // { ...ctx, ...(err.context ?? {}), op }
   ```

5. **`toDecimal(input)`** — безопасно конвертирует number | string | Decimal в Decimal

   ```typescript
   // Убирает ненадёжный instanceof Decimal
   // Использует Decimal.isDecimal() или всегда парсит
   // Возвращает Result с raw и cause при ошибке
   ```

**Пример оркестрации:**

```typescript
// ✅ Делает: оркестрация с централизованной обработкой ошибок
QuantityService.divide(qty, divisor)
// Внутри:
// 1. toDecimal(divisor)                      <- Helper (parse)
// 2. ValidateDivisorForQuantityDivision.check() <- Rules
// 3. divideDecimal(qty.value(), divisor)     <- Math (в try/catch)
// 4. this.create(result)                     <- Core
// 5. Обёртка в Result через rewrap          <- Facade

// ✅ Делает: контракт ошибок (всегда полный контекст)
if (!result.ok) {
  result.error.context.op;         // 'divide' (всегда)
  result.error.context.quantity;   // входной qty
  result.error.context.divisor;    // входной divisor
  result.error.context.raw;        // сырой ввод (при parse fail)
  result.error.context.cause;      // { name, message, stack? }
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

### 7. Централизованная обработка ошибок (DRY)

**Решение:** 5 helper methods для всех catch blocks вместо дублирования кода.

**Проблема:**
Без helper methods каждый catch block дублировал 20-40 строк кода:

```typescript
// ❌ Было: дублирование в каждом методе
try {
  const result = divideDecimal(qty.value(), divisor);
  // ...
} catch (error) {
  if (error instanceof DivisionByZeroError) {
    return Err(new InvalidQuantityError('...', {
      context: {
        op: 'divide',
        quantity: qty.value().toString(),
        divisor: divisor.toString(),
        cause: {
          name: error.name,
          message: error.message,
          stack: error.stack
        }
      }
    }));
  } else if (error instanceof ArithmeticOverflowError) {
    // ... аналогичный код
  } else {
    // ... ещё больше дублирования
  }
}
```

**Решение:**

```typescript
// ✅ Стало: централизованные helper methods
try {
  const result = divideDecimal(qty.value(), divisor);
  // ...
} catch (error) {
  const ctx = {
    quantity: qty.value().toString(),
    divisor: divisor.toString()
  };

  // Ожидаемые ошибки
  if (error instanceof DivisionByZeroError ||
      error instanceof InvalidQuantityError ||
      error instanceof ArithmeticOverflowError) {
    return Err(this.expectedMathError('divide', ctx, error));
  }

  // Неожиданные ошибки
  return Err(this.unexpectedError('divide', ctx, error));
}
```

**Почему выбрали:**

- ✅ Сократили catch blocks с 20-40 строк до 2-6 строк
- ✅ Единственное место для логики toCause/expectedMathError/unexpectedError
- ✅ Проще поддерживать (изменения в одном месте)
- ✅ Консистентная структура cause везде

---

### 8. Контракт "Never Throw"

**Решение:** ВСЕ методы QuantityService ГАРАНТИРОВАННО возвращают Result, никогда не бросают.

**Альтернативы:**

- ❌ Частичное покрытие try/catch — можно забыть обработать исключение
- ❌ Пробрасывать unexpected errors — пользователь должен писать try/catch

**Почему выбрали:**

- ✅ Compile-time гарантия: TypeScript знает что метод возвращает Result
- ✅ Runtime гарантия: catch blocks ловят ВСЁ (даже non-Error throws)
- ✅ Диагностика: unexpected errors включают полный stack trace
- ✅ Type-safe: невозможно забыть обработать ошибку

**Comprehensive Contract Tests:**
Все гарантии задокументированы тестами:

```typescript
describe('Facade Error Contract - Comprehensive', () => {
  it('Parse fail → context.op и context.raw обязательны', () => {
    const result = QuantityService.multiply(qty, 'invalid');
    expect(result.ok).toBe(false);
    expect(result.error.context?.op).toBe('multiply');
    expect(result.error.context?.raw).toBeDefined();
    expect(result.error.context?.factor).toBeDefined();
  });

  it('Rule fail → op и операционные поля обязательны', () => {
    const result = QuantityService.subtract(qty1, qty2);
    expect(result.ok).toBe(false);
    expect(result.error.context?.op).toBe('subtract');
    expect(result.error.context?.quantity1).toBeDefined();
    expect(result.error.context?.quantity2).toBeDefined();
  });

  it('Math throw → cause.name и cause.message обязательны', () => {
    const result = QuantityService.divide(qty, 0);
    expect(result.ok).toBe(false);
    expect(result.error.context?.cause?.name).toBe('DivisionByZeroError');
    expect(result.error.context?.cause?.message).toBeDefined();
  });

  it('Never Throw → всегда возвращает Result', () => {
    expect(() => QuantityService.create(NaN)).not.toThrow();
    expect(() => QuantityService.divide(qty, 0)).not.toThrow();
    expect(() => QuantityService.multiply(qty, 'invalid')).not.toThrow();
  });
});
```

---

### 9. Убран instanceof Decimal (надёжность)

**Решение:** Использовать `Decimal.isDecimal()` или всегда парсить.

**Проблема:**
`instanceof Decimal` ломается при наличии двух копий decimal.js в node_modules:

```typescript
// ❌ Было: ненадёжно
const decimal = factor instanceof Decimal ? factor : new Decimal(factor);
```

**Решение:**

```typescript
// ✅ Стало: надёжно
private static toDecimal(input: number | string | Decimal): Result<Decimal, InvalidQuantityError> {
  try {
    // Проверка через Decimal.isDecimal если доступен
    if (typeof Decimal.isDecimal === 'function' && Decimal.isDecimal(input)) {
      return Ok(input);
    }
    // Парсим (работает для number, string, и Decimal)
    const decimal = new Decimal(input);
    return Ok(decimal);
  } catch (error) {
    return Err(new InvalidQuantityError(..., {
      context: { raw: String(input), cause: this.toCause(error) }
    }));
  }
}
```

**Почему выбрали:**

- ✅ Надёжнее: Decimal.isDecimal() не зависит от множественных копий
- ✅ Диагностичнее: raw и cause для всех ошибок парсинга
- ✅ Консистентнее: единый путь парсинга для всех операций

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

1. **Готово!** Не нужно менять Core/Rules

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

1. **Facade:** Использовать в методе сервиса

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

1. **Готово!** Core не меняется

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
