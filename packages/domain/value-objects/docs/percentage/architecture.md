# Архитектура Percentage Value Object

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

Percentage модуль построен на принципах **Domain-Driven Design** с чётким разделением слоёв по ответственности.

### Ключевые принципы

1. **Иммутабельность** — все операции создают новые экземпляры
2. **Explicit Error Handling** — все ошибки явные через `Result<T, E>`
3. **Single Responsibility** — каждый класс делает одну вещь
4. **Dependency Inversion** — высокоуровневые слои не зависят от низкоуровневых
5. **Never Throw Facade** — Facade НИКОГДА не бросает исключения
6. **Централизованный errorUtils** — переиспользование toDecimal, wrapOp, rewrap

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
│  Facade Layer (PercentageService)│
│  - Catches ALL exceptions       │
│  - Returns Result<T, E>         │
│  - NEVER throws                 │
│  - Использует errorUtils        │
└─────────────────────────────────┘
    ↓ calls
┌─────────────────────────────────┐
│  Core Layer (Percentage)        │
│  - Throws PercentageInvariant...│
│  - Pure domain logic            │
└─────────────────────────────────┘
```

### Пример потока

```typescript
// User Code
const result = PercentageService.create(50);
// result.ok === true
// result.value.value() === Decimal(50)

// Что происходит внутри:

// 1. Facade: PercentageService.create()
const decimalResult = toDecimal('value', value, INVALID_FORMAT, InvalidPercentageError);
if (isErr(decimalResult)) {
  return Err(rewrap('create', {}, decimalResult.error, InvalidPercentageError));
}

// 2. Facade: createFromDecimal()
try {
  return Ok(Percentage.fromDecimal(decimal));
} catch (error) {
  // 3. Core: Percentage.fromDecimal() бросил PercentageInvariantViolation
  if (error instanceof PercentageInvariantViolation) {
    // 4. Facade: мапит в InvalidPercentageError через mapInvariantToError
    return this.mapInvariantToError('create', { value: decimal.toString() }, error);
  }
}
```

---

## 4-слойная архитектура

Percentage имеет **4 слоя** по аналогии с Price, Money и Quantity.

### Диаграмма слоёв

```text
┌─────────────────────────────────────────────────────┐
│                  User Code                          │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  Layer 4: Adapters                                  │
│  - PercentageSerializer (точная)                    │
│  - PercentageFormatter (форматирование)             │
│                                                     │
│  Зависит от: Core, Facade                          │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  Layer 3: Facade                                    │
│  - PercentageService                                │
│  - Единая точка входа                              │
│  - Result<T, E> обёртка                            │
│  - Error Contract через errorUtils                  │
│  - NEVER THROW гарантия                            │
│                                                     │
│  Зависит от: Core, Rules, Math, errorUtils         │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  Layer 2: Rules                                     │
│  - ValidateFeeNonNegative                          │
│  - ValidateFeeForTrading                           │
│  - ValidateTotalFee                                │
│  - ValidateSpreadNonNegative                       │
│  - ValidateSpreadRange                             │
│                                                     │
│  Зависит от: Core, Errors (@polymarket/errors)     │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  Layer 1: Core                                      │
│  - Percentage (value object)                        │
│  - PercentageInvariantViolation (exception)         │
│  - PercentageErrorReason (enum)                     │
│  - Инварианты: finite, range [-1e6, 1e6]          │
│                                                     │
│  Зависит от: Ничего (только Decimal)               │
└─────────────────────────────────────────────────────┘
```

---

## Разделение ответственности

### Layer 1: Core

**Ответственность:**

- Представление процента как value object (шкала 0-100)
- Гарантия инвариантов (finite, диапазон [-1e6, 1e6])
- Базовые операции (equals, isZero, isPositive, isNegative, сравнения)
- Конвертация между представлениями (toDecimal, toBasisPoints)
- Константы (ZERO, ONE_HUNDRED)

**НЕ делает:**

- Не знает про бизнес-правила (fee limits, spread limits)
- Не знает про Result<T, E>
- Не делает арифметику (это делает Facade + Math)
- Не проверяет контекстные правила (комиссии, спреды)

**Пример:**

```typescript
// ✅ Делает
const pct = Percentage.of(50);
pct.isZero();           // false
pct.isPositive();       // true
pct.equals(other);
pct.toDecimal();        // Decimal(0.5)
pct.toBasisPoints();    // Decimal(5000)

// ❌ НЕ делает
// pct.add(other);       // нет такого метода!
// pct.applyTo(value);   // нет такого метода!
```

**Инварианты:**

1. **Not NaN**: `!value.isNaN()`
2. **Finite**: `value.isFinite()`
3. **Min bound**: `value >= MIN_PERCENTAGE (-1e6)`
4. **Max bound**: `value <= MAX_PERCENTAGE (1e6)`

**Файлы:**

- `src/percentage/core/Percentage.ts`
- `src/percentage/core/PercentageInvariantViolation.ts`
- `src/percentage/core/PercentageErrorReason.ts`

---

### Layer 2: Rules

**Ответственность:**

- Контекстные проверки для бизнес-правил
- Валидация комиссий (fees) и спредов (spreads)
- Возвращает InvalidPercentageError с соответствующим reason

**5 Rules:**

1. **ValidateFeeNonNegative** — комиссия >= 0%
2. **ValidateFeeForTrading** — торговая комиссия в диапазоне [0%, 5%]
3. **ValidateTotalFee** — суммарная комиссия <= 10%
4. **ValidateSpreadNonNegative** — спред >= 0%
5. **ValidateSpreadRange** — спред в диапазоне [minSpread, maxSpread] (по умолчанию [0%, 10%])

**НЕ делает:**

- Не проверяет Core инварианты (это делает Core)
- Не делает математику (это делает Facade через @polymarket/math)
- Не знают друг про друга (независимы)

**Пример:**

```typescript
// ✅ Делает: атомарная проверка
ValidateFeeForTrading.check(Percentage.of(2.5));  // Ok(void)

// ✅ Делает: композиция проверок
ValidateSpreadRange.check(spread, minSpread, maxSpread);

// ❌ НЕ делает
// ValidateFeeForTrading.check(decimal);  // нет, только Percentage!
```

**Файлы:**

- `src/percentage/rules/ValidateFeeNonNegative.ts`
- `src/percentage/rules/ValidateFeeForTrading.ts`
- `src/percentage/rules/ValidateTotalFee.ts`
- `src/percentage/rules/ValidateSpreadNonNegative.ts`
- `src/percentage/rules/ValidateSpreadRange.ts`

---

### Layer 3: Facade

**Ответственность:**

- Единая точка входа для всех операций с Percentage
- Оркестрация Core + Math + Rules
- Обёртка исключений в Result<T, E>
- Facade Error Contract через errorUtils (toDecimal, wrapOp, rewrap)
- **NEVER THROW**: Ловит ВСЕ исключения (из Core, из @polymarket/math)

**НЕ делает:**

- Не реализует математику напрямую (делегирует @polymarket/math)
- Не делает low-level checks (делегирует Core)
- Не дублирует контекст ошибок (использует rewrap)

**Файлы:**

- `src/percentage/facade/PercentageService.ts`

**API:**

```typescript
create(value: number | string | Decimal): Result<Percentage, InvalidPercentageError>
fromDecimalFraction(decimal: number | string | Decimal): Result<Percentage, InvalidPercentageError>
fromBasisPoints(basisPoints: number | string | Decimal): Result<Percentage, InvalidPercentageError>
add(a: Percentage, b: Percentage): Result<Percentage, InvalidPercentageError>
subtract(a: Percentage, b: Percentage): Result<Percentage, InvalidPercentageError>
multiply(pct: Percentage, factor: number | string | Decimal): Result<Percentage, InvalidPercentageError>
divide(pct: Percentage, divisor: number | string | Decimal): Result<Percentage, InvalidPercentageError>
applyTo(pct: Percentage, value: Decimal): Result<Decimal, InvalidPercentageError>
```

**Использование errorUtils:**

```typescript
// ✅ Делает: парсинг через toDecimal
const decimalResult = toDecimal('value', value, INVALID_FORMAT, InvalidPercentageError);

// ✅ Делает: обёртка операций через wrapOp
return wrapOp('add', ctx, () => {
  const sum = addDecimal(a.value(), b.value());
  return this.createFromDecimal(sum, 'add', {});
}, 'percentage', InvalidPercentageError);

// ✅ Делает: rewrap ошибок с сохранением root-cause
return Err(rewrap('multiply', { value, factor }, factorResult.error, InvalidPercentageError));
```

**Never Throw Contract:**

PercentageService ГАРАНТИРУЕТ что ВСЕ методы возвращают Result и НИКОГДА не бросают исключения:

1. **Core exceptions** → Result.Err(InvalidPercentageError)
2. **Math exceptions** → Result.Err(InvalidPercentageError) с cause
3. **Parse errors** → Result.Err(InvalidPercentageError) с reason: INVALID_FORMAT
4. **Validation errors** → Result.Err(InvalidPercentageError) с соответствующим reason

---

### Layer 4: Adapters

**Ответственность:**

- Сериализация в/из JSON (с валидацией на границе системы)
- Форматирование для UI (toPercent, toDecimalFraction, toBasisPoints, toCompact)
- Десериализация с unknown → typed

**НЕ делает:**

- Не создаёт Percentage напрямую (делегирует PercentageService или Percentage.fromDecimal)
- Не содержит бизнес-логику

**Файлы:**

- `src/percentage/adapters/PercentageSerializer.ts`
- `src/percentage/adapters/PercentageFormatter.ts`

**PercentageSerializer:**

- `toJSON(percentage)` → `{ value: string }`
- `fromJSON(json: unknown)` → валидирует структуру, делегирует `PercentageService.create`

**PercentageFormatter:**

- `toFixed(pct, decimals)` → "50.00"
- `toPercent(pct, decimals)` → "50.00%"
- `toDecimalFraction(pct, decimals)` → "0.5000"
- `toBasisPoints(pct, decimals)` → "5000 bp"
- `toCompact(pct, decimals)` → "50.0%"

---

## Потоки данных

### Создание Percentage из пользовательского ввода

```text
User Input: "50"
    ↓
PercentageService.create("50")
    ↓
1. toDecimal('value', "50", INVALID_FORMAT, InvalidPercentageError)
    ↓ success
2. createFromDecimal(Decimal(50), 'create', {})
    ↓ calls
3. Percentage.fromDecimal(decimal)
    ↓
4. Validate Invariants:
   - !decimal.isNaN() ✅
   - decimal.isFinite() ✅
   - decimal >= -1e6 ✅
   - decimal <= 1e6 ✅
    ↓ all pass
5. new Percentage(decimal)
    ↓
Result.Ok(Percentage)
```

### Ошибка при создании (parse error)

```text
User Input: "abc"
    ↓
PercentageService.create("abc")
    ↓
1. toDecimal('value', "abc", INVALID_FORMAT, InvalidPercentageError)
    ↓ FAIL → Decimal constructor throws
2. Catch parse error через toDecimal
    ↓
3. Return Err(InvalidPercentageError {
     context: {
       raw: { field: 'value', value: "abc" },
       reason: 'INVALID_FORMAT'
     }
   })
    ↓
4. rewrap добавляет op: 'create'
    ↓
Result.Err(InvalidPercentageError)
```

### Ошибка при создании (invariant violation)

```text
User Input: "2000000"  // > 1e6
    ↓
PercentageService.create("2000000")
    ↓
1. toDecimal('value', "2000000", ...) → Ok(Decimal(2000000))
    ↓
2. createFromDecimal(Decimal(2000000), 'create', {})
    ↓ calls
3. Percentage.fromDecimal(decimal)
    ↓
4. Validate: decimal <= 1e6
    ↓ FAIL → throws PercentageInvariantViolation
5. Catch PercentageInvariantViolation
    ↓
6. mapInvariantToError('create', { value: "2000000" }, error)
    ↓
7. Return Err(InvalidPercentageError {
     context: {
       op: 'create',
       value: "2000000",
       reason: 'OUT_OF_RANGE_HIGH'
     }
   })
```

### Арифметика (add)

```text
PercentageService.add(pct1, pct2)
    ↓
1. Prepare ctx: { a: pct1.value().toString(), b: pct2.value().toString() }
    ↓
2. wrapOp('add', ctx, () => { ... }, 'percentage', InvalidPercentageError)
    ↓
3. addDecimal(pct1.value(), pct2.value())  // @polymarket/math
    ↓
4. createFromDecimal(sum, 'add', {})
    ↓
5. Validate invariants (can throw)
    ↓ if throws PercentageInvariantViolation
6. Map to InvalidPercentageError через mapInvariantToError
    ↓
Result.Err(InvalidPercentageError) or Result.Ok(Percentage)
```

### Применение процента к значению

```text
PercentageService.applyTo(pct, value)
    ↓
1. Prepare ctx: { percentage: pct.value().toString(), value: value.toString() }
    ↓
2. wrapOp('applyTo', ctx, () => { ... }, 'percentage', InvalidPercentageError)
    ↓
3. pct.toDecimal() // Decimal(0.5) для 50%
    ↓
4. multiplyDecimal(value, decimal)  // @polymarket/math
    ↓
Result.Ok(Decimal) or Result.Err(InvalidPercentageError)
```

---

## Архитектурные решения

### 1. Почему диапазон [-1e6, 1e6]?

**Решение:** Широкий диапазон для покрытия всех use cases.

**Почему не [0, 100]:**

- ❌ Не поддерживает отрицательные проценты (PnL, изменения цен)
- ❌ Не поддерживает проценты > 100% (прибыль 200%, рост цены на 150%)

**Почему выбрали [-1e6, 1e6]:**

- ✅ Поддерживает отрицательные значения (PnL: -50%)
- ✅ Поддерживает большие проценты (рост на 1000%)
- ✅ Защита от overflow (1,000,000% достаточно для любых расчётов)
- ✅ Симметричный диапазон

**Примеры use cases:**

```typescript
// ✅ Отрицательные проценты
const pnl = Percentage.of(-25);  // -25% убыток

// ✅ Проценты > 100%
const growth = Percentage.of(250);  // 250% рост

// ✅ Малые проценты
const fee = Percentage.of(0.25);  // 0.25% комиссия
```

---

### 2. Почему Core НЕ проверяет неотрицательность?

**Решение:** Неотрицательность — это контекстное правило, не инвариант.

**Альтернативы:**

- ❌ Percentage всегда >= 0 — не поддерживает PnL и изменения цен
- ❌ Два класса (PositivePercentage, Percentage) — дублирование кода

**Почему выбрали Rules Layer:**

- ✅ Core поддерживает все use cases
- ✅ Rules проверяют контекстные ограничения (fees, spreads)
- ✅ Гибкость: можно добавлять новые правила без изменения Core

**Примеры:**

```typescript
// ✅ Core принимает отрицательные значения
const pct = Percentage.of(-10);  // Ok

// ✅ Rules проверяют контекст
ValidateFeeNonNegative.check(pct);  // Err (fee не может быть отрицательной)
ValidateSpreadNonNegative.check(pct);  // Err (spread не может быть отрицательным)
```

---

### 3. Почему 5 отдельных Rules вместо одной ValidatePercentage?

**Решение:** Single Responsibility — одно правило = одна проверка.

**Альтернативы:**

- ❌ `ValidatePercentage({ type: 'fee', maxFee: 5 })`
- ❌ `ValidatePercentage({ type: 'spread', min: 0, max: 10 })`

**Почему выбрали 5 отдельных:**

- ✅ Явная семантика (ValidateFeeForTrading vs ValidateTotalFee)
- ✅ Композиция проще чем конфигурация
- ✅ Type safety (не можешь передать неправильные параметры)
- ✅ Переиспользуемость

**Применение:**

```typescript
// Polymarket-специфичные правила
ValidateFeeForTrading.check(makerFee);   // [0%, 5%]
ValidateTotalFee.check(totalFee);        // <= 10%
ValidateSpreadRange.check(spread);       // [0%, 10%] по умолчанию

// Базовые правила (переиспользуемые)
ValidateFeeNonNegative.check(fee);       // >= 0%
ValidateSpreadNonNegative.check(spread); // >= 0%
```

---

### 4. Почему errorUtils вместо дублирования?

**Решение:** DRY через централизованные функции toDecimal, wrapOp, rewrap.

**Проблема без errorUtils:**

```typescript
// ❌ Дублирование кода в каждом методе
try {
  decimal = new Decimal(value);
} catch {
  return Err(new InvalidPercentageError(..., {
    context: { raw: { field: 'value', value: String(value) }, reason: INVALID_FORMAT }
  }));
}

// ❌ Дублирование обработки math errors
try {
  const result = addDecimal(a, b);
} catch (error) {
  if (error instanceof ArithmeticOverflowError) {
    return Err(new InvalidPercentageError(..., { context: { op, cause: { ... } } }));
  }
}
```

**Решение с errorUtils:**

```typescript
// ✅ Парсинг через toDecimal
const decimalResult = toDecimal('value', value, INVALID_FORMAT, InvalidPercentageError);

// ✅ Обёртка операций через wrapOp
return wrapOp('add', ctx, () => { ... }, 'percentage', InvalidPercentageError);

// ✅ Rewrap ошибок с сохранением root-cause
return Err(rewrap('multiply', { value, factor }, factorResult.error, InvalidPercentageError));
```

**Преимущества:**

- ✅ DRY (Don't Repeat Yourself)
- ✅ Консистентность контракта
- ✅ Меньше ошибок при рефакторинге
- ✅ Переиспользование в Price, Money, Quantity

---

### 5. Почему три способа создания (create, fromDecimalFraction, fromBasisPoints)?

**Решение:** Flexibility для разных use cases.

**Три представления процента:**

1. **Процент (0-100)**: `create(50)` → 50%
2. **Дробь (0-1)**: `fromDecimalFraction(0.5)` → 50%
3. **Базисные пункты (bp)**: `fromBasisPoints(5000)` → 50%

**Почему все три:**

- ✅ `create(50)` — естественный ввод пользователя
- ✅ `fromDecimalFraction(0.5)` — API responses, математические расчёты
- ✅ `fromBasisPoints(5000)` — финансовые системы (точность для малых процентов)

**Примеры:**

```typescript
// Пользовательский ввод
const result1 = PercentageService.create(50);  // "50" → 50%

// API response
const result2 = PercentageService.fromDecimalFraction(0.5);  // 0.5 → 50%

// Финансовая система
const result3 = PercentageService.fromBasisPoints(5000);  // 5000 bp → 50%
```

---

### 6. Почему applyTo возвращает Decimal, а не Percentage?

**Решение:** Результат применения процента — это значение, не процент.

**Семантика:**

```typescript
// Применение процента к значению
applyTo(50%, 100) = 100 * 0.5 = 50  // Decimal (значение)

// НЕ процент!
applyTo(50%, 100) ≠ 50%  // это не имеет смысла
```

**Почему Decimal:**

- ✅ Результат — это значение (например, сумма комиссии), не процент
- ✅ Type safety: нельзя по ошибке использовать как Percentage
- ✅ Соответствие семантике

**Примеры:**

```typescript
// Расчёт комиссии
const fee = Percentage.of(2.5);
const amount = new Decimal(100);
const feeAmountResult = PercentageService.applyTo(fee, amount);
if (feeAmountResult.ok) {
  const feeAmount = feeAmountResult.value;  // Decimal(2.5) — это сумма, не процент!
}

// Расчёт скидки
const discount = Percentage.of(10);
const price = new Decimal(200);
const discountAmountResult = PercentageService.applyTo(discount, price);
if (discountAmountResult.ok) {
  const discountAmount = discountAmountResult.value;  // Decimal(20)
  const finalPrice = price.minus(discountAmount);     // Decimal(180)
}
```

---

## Заключение

Percentage модуль следует принципам:

- **Простота** — чёткое разделение на 4 слоя (Core, Rules, Facade, Adapters)
- **Безопасность** — Never Throw Facade, явные ошибки
- **Точность** — Decimal.js для всех вычислений
- **Гибкость** — поддержка отрицательных и больших процентов
- **DRY** — централизованный errorUtils для обработки ошибок
- **Переиспользуемость** — Rules независимы и композируемы

Архитектура позволяет легко:

- Добавлять новые Rules (расширить валидацию)
- Добавлять новые операции (в Facade)
- Тестировать каждый слой отдельно
- Переиспользовать паттерны в других value objects
