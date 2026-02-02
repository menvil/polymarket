# Архитектура Price Value Object

> Подробное описание архитектурных решений и паттернов

## Содержание

1. [Обзор архитектуры](#обзор-архитектуры)
2. [Паттерн Throws+Facade](#паттерн-throwsfacade)
3. [4-слойная архитектура](#4-слойная-архитектура)
4. [Разделение ответственности](#разделение-ответственности)
5. [Потоки данных](#потоки-данных)
6. [Архитектурные решения](#архитектурные-решения)
7. [Polymarket-специфичные решения](#polymarket-специфичные-решения)

---

## Обзор архитектуры

Price модуль построен на принципах **Domain-Driven Design** с чётким разделением слоёв по ответственности.

### Ключевые принципы

1. **Иммутабельность** — все операции создают новые экземпляры
2. **Explicit Error Handling** — все ошибки явные через `Result<T, E>`
3. **Single Responsibility** — каждый класс делает одну вещь
4. **Dependency Inversion** — высокоуровневые слои не зависят от низкоуровневых
5. **Open/Closed** — легко расширять, не меняя существующий код
6. **Polymarket-aligned** — соответствие семантике рынков предсказаний

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
│  Facade Layer (PriceService)    │
│  - Catches exceptions           │
│  - Returns Result<T, E>         │
└─────────────────────────────────┘
    ↓ calls
┌─────────────────────────────────┐
│  Core Layer (Price)             │
│  - Throws PriceInvariant...     │
│  - Pure domain logic            │
└─────────────────────────────────┘
```

### Пример потока

```typescript
// User Code
const result = PriceService.create(1.5);
// result.ok === false
// result.error.context.value === '1.5'

// Что происходит внутри:

// 1. Facade: PriceService.create()
try {
  const price = Price.of(1.5);  // -> идёт в Core
  return Ok(price);
} catch (error) {
  // 2. Core: Price.of() бросил PriceInvariantViolation
  if (error instanceof PriceInvariantViolation) {
    // 3. Facade: оборачивает в InvalidPriceError и Result
    return Err(new InvalidPriceError(...));
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
│  - PriceSerializer (точная)                         │
│  - PriceFormatter (форматирование)                  │
│                                                     │
│  Зависит от: Core, Facade                          │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  Layer 3: Facade                                    │
│  - PriceService                                     │
│  - Единая точка входа                              │
│  - Result<T, E> обёртка                            │
│  - Error Contract                                   │
│  - withOperationContext helper                      │
│                                                     │
│  Зависит от: Core, Rules, Math                     │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  Layer 2: Rules                                     │
│  - ValidateTickSize                                 │
│  - ValidateTickSizeMultipleOfBaseTick               │
│  - ValidateAligned                                  │
│  - ValidateDivisorForPriceDivision                  │
│  - ValidateFactorForPriceMultiplication             │
│                                                     │
│  Зависит от: Ничего (только Decimal, Result)       │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  Layer 1: Core                                      │
│  - Price (value object)                             │
│  - PriceInvariantViolation (exception)              │
│  - Инварианты: finite, range [0.0001, 0.9999]     │
│                                                     │
│  Зависит от: Ничего (только Decimal)               │
└─────────────────────────────────────────────────────┘
```

---

## Разделение ответственности

### Layer 1: Core

**Ответственность:**
- Представление цены как value object
- Гарантия инвариантов (finite, диапазон [0.0001, 0.9999])
- Базовые операции (equals, isMin, isMax)
- Константы (MIN_PRICE, MAX_PRICE, HALF_PRICE)

**НЕ делает:**
- Не знает про бизнес-правила (tickSize, alignment)
- Не знает про Result<T, E>
- Не делает арифметику (это делает Facade + Math)
- Не знает про Polymarket tick rules (это Rules)

**Пример:**
```typescript
// ✅ Делает
const price = Price.of(0.5);
price.isMin();    // false
price.isMax();    // false
price.equals(other);

// ❌ НЕ делает
// price.add(other);         // нет такого метода!
// price.complement();       // нет такого метода!
// price.roundToTick(...);   // нет такого метода!
```

---

### Layer 2: Rules

**Ответственность:**
- Атомарные проверки (одно правило = одна проверка)
- Принимают Decimal, возвращают Result<void, Error> или Result<Decimal, Error>
- Не знают про Price (работают с Decimal)
- Полиморфные правила (ValidateTickSize базовое, ValidateTickSizeMultipleOfBaseTick расширенное)

**НЕ делает:**
- Не создают Price
- Не знают про операции (add, multiply)
- Не знают друг про друга (независимы)

**Пример:**
```typescript
// ✅ Делает: атомарная проверка
ValidateTickSize.check(new Decimal(0.01));  // Ok

// ✅ Делает: композиция проверок
ValidateTickSizeMultipleOfBaseTick.check(0.01);
// Внутри:
// 1. ValidateTickSize.check() <- базовая проверка
// 2. Проверка кратности 0.0001 <- Polymarket-специфика

// ❌ НЕ делает
// ValidateTickSize.check(price);  // нет, только Decimal!
```

**Иерархия правил:**

```
ValidateTickSize (базовое)
    ↓ наследуется
ValidateTickSizeMultipleOfBaseTick (Polymarket-специфичное)
```

---

### Layer 3: Facade

**Ответственность:**
- Единая точка входа для всех операций
- Оркестрация Core + Math + Rules
- Обёртка исключений в Result<T, E>
- Facade Error Contract (withOperationContext)
- Semantic операции (complement, average)

**НЕ делает:**
- Не реализует бизнес-логику (делегирует Rules)
- Не делает low-level checks (делегирует Core)
- Не делает арифметику напрямую (использует @polymarket/math)

**Пример:**
```typescript
// ✅ Делает: оркестрация
PriceService.complement(price)
// Внутри:
// 1. subtractDecimal(Decimal(1), price.value())  <- Math
// 2. this.create(result)                         <- Core
// 3. Обёртка в Result                            <- Facade

// ✅ Делает: контракт ошибок
if (!result.ok) {
  result.error.context.op;      // 'complement'
  result.error.context.price;   // '0.65'
}

// ✅ Делает: валидация через Rules
roundToMarketTick(price, tickSize, mode)
// Внутри:
// 1. ValidateTickSizeMultipleOfBaseTick.check()  <- Rule
// 2. roundToTick/floorToTick/ceilToTick()       <- Math
// 3. this.create()                               <- Core
```

---

### Layer 4: Adapters

**Ответственность:**
- Сериализация (toJSON/fromJSON)
- Форматирование (toString, toPercentageString)
- Адаптация к внешним системам

**НЕ делает:**
- Не содержит бизнес-логику
- Не валидирует (использует Facade)

---

## Потоки данных

### Поток создания Price

```
User Input (number/string/Decimal)
    ↓
PriceService.create()
    ↓
try {
  Price.of()  ← проверяет инварианты
    ↓
  constructor:
    - isNaN?       → throw PriceInvariantViolation
    - isFinite?    → throw PriceInvariantViolation
    - < MIN?       → throw PriceInvariantViolation
    - > MAX?       → throw PriceInvariantViolation
    ↓
  return Ok(price)
}
catch (PriceInvariantViolation) {
    ↓
  return Err(InvalidPriceError)
}
```

### Поток арифметической операции (complement)

```
price
    ↓
PriceService.complement()
    ↓
subtractDecimal(Decimal(1), price.value())  ← @polymarket/math
    ↓
result: Decimal
    ↓
this.create(result)  ← проверяет инварианты
    ↓
Result<Price, InvalidPriceError>
```

### Поток округления к тику

```
price, tickSize, mode
    ↓
PriceService.roundToMarketTick()
    ↓
ValidateTickSizeMultipleOfBaseTick.check(tickSize)  ← Rule
    ↓
  ValidateTickSize.check(tickSize)  ← базовая проверка
    ↓
  tickSize % 0.0001 === 0?          ← Polymarket проверка
    ↓
tick: Decimal
    ↓
switch(mode) {
  'floor': floorToTick(price, tick)     ← Math
  'ceil': ceilToTick(price, tick)       ← Math
  'nearest': roundToTick(price, tick)   ← Math
}
    ↓
rounded: Decimal
    ↓
this.create(rounded)  ← проверяет инварианты
    ↓
Result<Price, InvalidPriceError | InvalidPriceError>
```

### Поток деления с валидацией

```
price, divisor
    ↓
PriceService.divide()
    ↓
parse divisor → Decimal  (try/catch)
    ↓
ValidateDivisorForPriceDivision.check(divisor)  ← Rule
    ↓
  isNaN?     → Err(InvalidPriceError)
  isFinite?  → Err(InvalidPriceError)
  isZero?    → Err(InvalidPriceError)
    ↓
divideDecimal(price.value(), divisor)  ← Math
    ↓
result: Decimal
    ↓
this.create(result)  ← проверяет инварианты
    ↓
Result<Price, InvalidPriceError | InvalidPriceError>
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

### 2. Почему Rules не знают про Price?

**Решение:** Rules работают только с Decimal.

**Альтернативы:**
- ❌ Rules принимают Price — циклическая зависимость

**Почему выбрали:**
- ✅ Нет циклических зависимостей
- ✅ Rules переиспользуемы
- ✅ Тестировать проще

---

### 3. Почему отдельные методы multiply/divide, а не один calculate?

**Решение:** Разные операции = разные методы с разными типами ошибок.

```typescript
// ✅ Текущее решение
multiply(price, factor): Result<Price, InvalidPriceError | InvalidPriceError>
divide(price, divisor): Result<Price, InvalidPriceError | InvalidPriceError>

// ❌ Альтернатива
calculate(price, value, op): Result<Price, InvalidPriceError | InvalidPriceError | InvalidPriceError>
```

**Почему выбрали:**
- ✅ Explicit intent (явное намерение)
- ✅ Разные типы ошибок для разных операций
- ✅ Type narrowing работает корректно

---

### 4. Почему complement() в Facade, а не в Core?

**Решение:** Математические операции в Facade.

**Альтернативы:**
- ❌ `price.complement()` в Core

**Почему выбрали:**
- ✅ Core не делает арифметику
- ✅ Facade оркестрирует Math + Core
- ✅ Единый паттерн для всех операций

---

### 5. Почему ValidateTickSize и ValidateTickSizeMultipleOfBaseTick раздельно?

**Решение:** Два отдельных правила вместо флага.

**Альтернативы:**
- ❌ `ValidateTickSize.check(tickSize, { requireMultipleOfBase: true })`

**Почему выбрали:**
- ✅ Single Responsibility (одно правило = одна проверка)
- ✅ Композиция проще чем конфигурация
- ✅ Явная семантика (Polymarket vs generic)

**Применение:**

```typescript
// Polymarket-специфичные операции используют строгое правило
roundToMarketTick() → ValidateTickSizeMultipleOfBaseTick

// Если добавим generic операции, можно использовать базовое
// roundToTick() → ValidateTickSize
```

---

### 6. Почему withOperationContext вместо дублирования контекста?

**Решение:** Helper для добавления контекста операции.

```typescript
// ✅ Текущее решение
const validateResult = ValidateDivisorForPriceDivision.check(divisor);
if (!validateResult.ok) {
  return Err(
    withOperationContext(validateResult.error, 'divide', {
      dividend: price.value().toString()
    })
  );
}

// ❌ Альтернатива: дублировать всё
if (!validateResult.ok) {
  return Err(
    new InvalidPriceError(validateResult.error.message, {
      context: {
        op: 'divide',
        divisor: validateResult.error.context.divisor,
        dividend: price.value().toString(),
        reason: validateResult.error.context.reason
      }
    })
  );
}
```

**Почему выбрали:**
- ✅ DRY (Don't Repeat Yourself)
- ✅ Консистентность контракта
- ✅ Меньше ошибок при рефакторинге

---

## Polymarket-специфичные решения

### 1. Базовый тик как MIN_PRICE

**Решение:** MIN_PRICE (0.0001) служит базовым тиком.

**Почему:**
- Все tick sizes кратны базовому тику
- Упрощает валидацию
- Соответствует семантике Polymarket

### 2. Диапазон [0.0001, 0.9999] вместо [0, 1]

**Решение:** Price НЕ может быть 0 или 1.

**Почему:**
- 0 означает "невозможный исход" (нет смысла торговать)
- 1 означает "гарантированный исход" (нет uncertainty)
- Реальные рынки всегда имеют uncertainty
- Предотвращает деление на ноль в расчётах odds

### 3. ValidateTickSizeMultipleOfBaseTick в roundToMarketTick

**Решение:** Строгая проверка кратности для market operations.

**Почему:**
- Гарантирует что все market ticks кратны базовому
- Предотвращает создание "невалидных" tick sizes
- Соответствует правилам биржи Polymarket

### 4. Semantic операции: complement, average

**Решение:** Специализированные методы вместо generic арифметики.

```typescript
// ✅ Semantic
complement(price) → 1 - price
average(p1, p2) → (p1 + p2) / 2

// ❌ Generic
subtract(Price.of(1), price)
divide(add(p1, p2), 2)
```

**Почему:**
- Явное намерение (intent-revealing)
- Читаемость кода
- Специфичная обработка ошибок

---

## Расширяемость

### Добавление новой операции

Пример: добавить `weightedAverage(p1, w1, p2, w2)`

1. **Facade:** Добавить метод
```typescript
public static weightedAverage(
  price1: Price,
  weight1: Decimal,
  price2: Price,
  weight2: Decimal
): Result<Price, InvalidPriceError> {
  const totalWeight = weight1.plus(weight2);
  const weighted = price1.value().times(weight1)
    .plus(price2.value().times(weight2))
    .div(totalWeight);

  return this.create(weighted);
}
```

2. **Готово!** Не нужно менять Core/Rules

---

### Добавление нового правила

Пример: добавить `ValidateSpread`

1. **Rules:** Создать класс
```typescript
export class ValidateSpread {
  public static check(
    bid: Decimal,
    ask: Decimal,
    minSpread: Decimal
  ): Result<void, InvalidPriceError> {
    const spread = ask.minus(bid);
    if (spread.lessThan(minSpread)) {
      return Err(new InvalidPriceError(...));
    }
    return Ok(undefined);
  }
}
```

2. **Facade:** Использовать в методе
```typescript
public static validateSpread(
  bidPrice: Price,
  askPrice: Price,
  minSpread: Decimal
) {
  const result = ValidateSpread.check(
    bidPrice.value(),
    askPrice.value(),
    minSpread
  );

  if (!result.ok) {
    return Err(withOperationContext(result.error, 'validateSpread', {
      bid: bidPrice.value().toString(),
      ask: askPrice.value().toString()
    }));
  }

  return Ok(undefined);
}
```

3. **Готово!** Core не меняется

---

## Best Practices

### 1. Всегда используйте Facade

❌ **Плохо:**
```typescript
try {
  const price = Price.of(userInput);
} catch (e) {
  // Легко забыть обработать
}
```

✅ **Хорошо:**
```typescript
const result = PriceService.create(userInput);
if (!result.ok) {
  // Компилятор заставит проверить
}
```

---

### 2. Используйте ValidateTickSizeMultipleOfBaseTick для Polymarket операций

❌ **Плохо:**
```typescript
// Может принять tick size не кратный 0.0001
ValidateTickSize.check(tickSize)
```

✅ **Хорошо:**
```typescript
// Гарантирует кратность базовому тику
ValidateTickSizeMultipleOfBaseTick.check(tickSize)
```

---

### 3. Используйте semantic операции

❌ **Плохо:**
```typescript
// Неясное намерение
const oneResult = PriceService.create(1);
const compResult = PriceService.subtract(oneResult.value, price);
```

✅ **Хорошо:**
```typescript
// Явное намерение
const compResult = PriceService.complement(price);
```

---

## Заключение

Архитектура Price модуля обеспечивает:

1. **Чёткое разделение ответственности** между слоями
2. **Type-safe обработку ошибок** через Result<T, E>
3. **Polymarket-aligned семантику** (базовый тик, диапазон)
4. **Расширяемость** без изменения существующего кода
5. **Тестируемость** каждого слоя независимо (323 теста)
6. **Читаемость** для разработчиков всех уровней

Следование этим принципам гарантирует maintainable и scalable кодовую базу для рынков предсказаний Polymarket.
