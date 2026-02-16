# Архитектура Money Value Object

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

Money модуль построен на принципах **Domain-Driven Design** с чётким разделением слоёв по ответственности.

### Ключевые принципы

1. **Иммутабельность** — все операции создают новые экземпляры
2. **Explicit Error Handling** — все ошибки явные через `Result<T, E>`
3. **Single Responsibility** — каждый класс делает одну вещь
4. **Dependency Inversion** — высокоуровневые слои не зависят от низкоуровневых
5. **Never Throw Facade** — Facade НИКОГДА не бросает исключения

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
│  Facade Layer (MoneyService)    │
│  - Catches ALL exceptions       │
│  - Returns Result<T, E>         │
│  - NEVER throws                 │
└─────────────────────────────────┘
    ↓ calls
┌─────────────────────────────────┐
│  Core Layer (Money)             │
│  - Throws MoneyInvariant...     │
│  - Pure domain logic            │
└─────────────────────────────────┘
```

### Пример потока

```typescript
// User Code
const result = MoneyService.create("abc");
// result.ok === false
// result.error.context.reason === 'INVALID_FORMAT'

// Что происходит внутри:

// 1. Facade: MoneyService.create()
let decimal: Decimal;
try {
  decimal = new Decimal("abc");  // -> Decimal parse error
} catch {
  // 2. Facade ловит parse error
  return Err(new InvalidMoneyError('Failed to create Money', {
    context: { op: 'create', value: "abc", reason: 'INVALID_FORMAT' }
  }));
}

// Если парсинг успешен, идём в Core
try {
  const money = Money.of(decimal);  // Core принимает ТОЛЬКО Decimal
  return Ok(money);
} catch (error) {
  // 3. Core: Money.of() бросил MoneyInvariantViolation
  if (error instanceof MoneyInvariantViolation) {
    // 4. Facade: оборачивает в InvalidMoneyError и Result
    return Err(new InvalidMoneyError('Failed to create Money', {
      context: { op: 'create', value: decimal.toString(), reason: error.reason }
    }));
  }
  throw error;  // unexpected
}
```

---

## 4-слойная архитектура

Money имеет **4 слоя** по аналогии с Price и Quantity.

### Диаграмма слоёв

```text
┌─────────────────────────────────────────────────────┐
│                  User Code                          │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  Layer 4: Adapters                                  │
│  - MoneySerializer (точная)                         │
│  - MoneyFormatter (форматирование)                  │
│                                                     │
│  Зависит от: Core, Facade                          │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  Layer 3: Facade                                    │
│  - MoneyService                                     │
│  - Единая точка входа                              │
│  - Result<T, E> обёртка                            │
│  - Error Contract                                   │
│  - NEVER THROW гарантия                            │
│                                                     │
│  Зависит от: Core, Rules, Math (@polymarket/math)  │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  Layer 2: Rules                                     │
│  - ValidateFactorForMoneyMultiplication            │
│  - ValidateDivisorForMoneyDivision                 │
│  - Валидация операндов (NaN, finite, zero)         │
│                                                     │
│  Зависит от: Errors (@polymarket/errors)           │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│  Layer 1: Core                                      │
│  - Money (value object)                             │
│  - MoneyInvariantViolation (exception)              │
│  - Инварианты: supported currency, finite, |x|<=1e15│
│                                                     │
│  Зависит от: Ничего (только Decimal)               │
└─────────────────────────────────────────────────────┘
```

---

## Разделение ответственности

### Layer 1: Core

**Ответственность:**

- Представление денежной суммы с валютой как value object
- Гарантия инвариантов (supported currency, finite, |amount| <= MAX_AMOUNT)
- Базовые операции (hasSameCurrency, isZero, isPositive, isNegative)
- **Исключения**: MoneyInvariantViolation при нарушении инвариантов

**НЕ делает:**

- Не знает про бизнес-правила (минимальная сумма, неотрицательность)
- Не знает про Result<T, E>
- Не делает арифметику (это делает Facade + Math)
- Не проверяет совпадение валют в операциях (это делает Facade)

**Файлы:**

- `src/money/core/Money.ts`
- `src/money/core/MoneyInvariantViolation.ts`

**Инварианты:**

1. **Поддерживаемая валюта**: `currency in SUPPORTED_CURRENCIES` (сейчас только 'USDC')
2. **Not NaN**: `!amount.isNaN()`
3. **Finite**: `amount.isFinite()`
4. **Не превышает MAX**: `|amount| <= 1e15`

**Важно:** Core слой принимает ТОЛЬКО `Decimal`. Парсинг из `number` или `string` происходит в Facade слое (MoneyService).

---

### Layer 2: Rules

**Ответственность:**

- Валидация операндов для арифметических операций
- Проверка factor и divisor (NaN, finite, zero)
- Возвращает InvalidMoneyError с соответствующим reason

**Файлы:**

- `src/money/rules/ValidateFactorForMoneyMultiplication.ts`
- `src/money/rules/ValidateDivisorForMoneyDivision.ts`

**НЕ делает:**

- Не проверяет Core инварианты (это делает Core)
- Не делает математику (это делает Facade через @polymarket/math)

---

### Layer 3: Facade

**Ответственность:**

- Единая точка входа для создания и операций с Money
- Преобразование исключений в `Result<T, InvalidMoneyError>`
- Проверка контекстных правил (совпадение валют в add/subtract)
- Делегирование валидации операндов в Rules слой
- **NEVER THROW**: Ловит ВСЕ исключения (из Core, из @polymarket/math, из Rules)

**НЕ делает:**

- Не реализует математику (делегирует @polymarket/math)
- Не знает про сериализацию/форматирование
- Не валидирует операнды напрямую (делегирует Rules)

**Файлы:**

- `src/money/facade/MoneyService.ts`

**API:**

```typescript
create(value: number | string | Decimal, currency?: 'USDC'): Result<Money, InvalidMoneyError>
add(a: Money, b: Money): Result<Money, InvalidMoneyError (reason: CURRENCY_MISMATCH) | InvalidMoneyError (reason: EXCEEDS_MAX_AMOUNT)>
subtract(a: Money, b: Money): Result<Money, InvalidMoneyError (reason: CURRENCY_MISMATCH) | InvalidMoneyError (reason: EXCEEDS_MAX_AMOUNT)>
multiply(m: Money, factor: number | string | Decimal): Result<Money, InvalidMoneyError | InvalidMoneyError (reason: EXCEEDS_MAX_AMOUNT)>
divide(m: Money, divisor: number | string | Decimal): Result<Money, InvalidMoneyError (reason: DIVISION_BY_ZERO) | InvalidMoneyError | InvalidMoneyError (reason: EXCEEDS_MAX_AMOUNT)>
```

**Never Throw Contract:**

MoneyService ГАРАНТИРУЕТ что ВСЕ методы возвращают Result и НИКОГДА не бросают исключения:

1. **Core exceptions** → Result.Err(InvalidMoneyError)
2. **Math exceptions** → Result.Err(InvalidMoneyError (reason: EXCEEDS_MAX_AMOUNT))
3. **Parse errors** → Result.Err(InvalidMoneyError)
4. **Validation errors** → Result.Err(InvalidMoneyError (reason: CURRENCY_MISMATCH), InvalidMoneyError (reason: DIVISION_BY_ZERO))

Каждая операция обёрнута в try/catch для гарантии.

**Error Mapping:**

MoneyService использует helper `mapInvariantToOverflow` для DRY маппинга:

```typescript
private static mapInvariantToOverflow(
  op: string,
  ctx: Record<string, unknown>,
  e: MoneyInvariantViolation
): Result<never, InvalidMoneyError (reason: EXCEEDS_MAX_AMOUNT)>
```

Ожидаемые reason: `EXCEEDS_MAX_AMOUNT`, `NON_FINITE`, `NAN`.
Неожиданные reason (`UNSUPPORTED_CURRENCY`, `INVALID_FORMAT`) → throw (bug in code).

---

### Layer 4: Adapters

**Ответственность:**

- Сериализация в/из JSON (с валидацией на границе системы)
- Форматирование для UI
- Десериализация с unknown → typed

**НЕ делает:**

- Не создаёт Money напрямую (делегирует MoneyService)

**Файлы:**

- `src/money/adapters/MoneySerializer.ts`
- `src/money/adapters/MoneyFormatter.ts`

**MoneySerializer:**

- `toJSON(money)` → `{ amount: string, currency: string }`
- `fromJSON(json: unknown)` → валидирует структуру, делегирует `MoneyService.create`

**MoneyFormatter:**

- `toFixed(money, decimals)` → string
- `toCurrency(money, showCurrency)` → "$100.50 USDC"
- `toCompact(money, decimals)` → "$1.5K"

---

## Потоки данных

### Создание Money из пользовательского ввода

```text
User Input: "100.5"
    ↓
MoneyService.create("100.5")
    ↓
1. Parse to Decimal (try/catch)
    ↓ success
2. Money.of(decimal, 'USDC')
    ↓ calls
3. Validate Invariants:
   - SUPPORTED_CURRENCIES.has('USDC') ✅
   - !decimal.isNaN() ✅
   - decimal.isFinite() ✅
   - decimal.abs() <= 1e15 ✅
    ↓ all pass
4. new Money(decimal, 'USDC')
    ↓
Result.Ok(Money)
```

### Ошибка при создании (parse error)

```text
User Input: "abc"
    ↓
MoneyService.create("abc")
    ↓
1. Parse to Decimal (try/catch)
    ↓ FAIL → Decimal constructor throws
2. Catch parse error
    ↓
3. Return Err(InvalidMoneyError {
     context: {
       op: 'create',
       value: "abc",
       currency: 'USDC',
       reason: 'INVALID_FORMAT'
     }
   })
```

### Ошибка при создании (invariant violation)

```text
User Input: "99999999999999999"  // > 1e15
    ↓
MoneyService.create("99999999999999999")
    ↓
1. Parse to Decimal (try/catch)
    ↓ success
2. Money.of(decimal, 'USDC')
    ↓ calls
3. Money.create(decimal, 'USDC')
    ↓
4. Validate: decimal.abs() <= 1e15
    ↓ FAIL → throws MoneyInvariantViolation
5. Catch MoneyInvariantViolation
    ↓
6. Return Err(InvalidMoneyError {
     context: {
       op: 'create',
       value: "99999999999999999",
       currency: 'USDC',
       reason: 'EXCEEDS_MAX_AMOUNT'
     }
   })
```

### Арифметика (add)

```text
MoneyService.add(money1, money2)
    ↓
1. Check currencies match
    ↓ if not → Err(InvalidMoneyError (reason: CURRENCY_MISMATCH))
    ↓ if yes
2. addDecimal(money1.value(), money2.value())  // @polymarket/math
    ↓
3. Money.of(sum, currency)
    ↓
4. Validate invariants (can throw)
    ↓ if throws MoneyInvariantViolation
5. Map to InvalidMoneyError (reason: EXCEEDS_MAX_AMOUNT)
    ↓
Result.Err(InvalidMoneyError (reason: EXCEEDS_MAX_AMOUNT))
    OR
Result.Ok(Money)
```

---

## Архитектурные решения

### 1. Почему Rules Layer в Money минимален?

**Причина:** Большинство проверок Money — это инварианты Core, а не контекстные правила.

**Money имеет минимальный Rules Layer (Layer 2):**

- `ValidateFactorForMoneyMultiplication` — проверка множителя (не NaN, finite)
- `ValidateDivisorForMoneyDivision` — проверка делителя (не NaN, finite, не ноль)
- Эти правила проверяют ВХОДНЫЕ операнды, а не результат операции

**Core инварианты остаются в Core:**

- Валюта — инвариант (поддерживается или нет)
- Finite — инвариант (всегда требуется для результата)
- MAX_AMOUNT — инвариант (всегда проверяется для результата)
- Неотрицательность — НЕ инвариант (можно иметь отрицательный баланс)

**Price/Quantity имеют более развитый Rules Layer:**

- Price: tick size alignment, tick size multiple of base tick — контекстные правила рынка
- Quantity: minSize, stepSize — контекстные правила обмена

**Итого:** Money использует все четыре слоя (Core, Rules, Facade, Adapters), но Rules Layer минимален — только для валидации входных операндов.

### 2. Почему Money.of() принимает ТОЛЬКО Decimal?

**Разделение ответственности:**

Money - это Core value object, который должен работать ТОЛЬКО с уже валидированными данными (Decimal).

Парсинг из `number` или `string` - это ответственность Facade слоя (MoneyService).

**Преимущества такого подхода:**

1. **Чёткое разделение:**
   - Parse errors (невалидный формат: `"abc"`, `undefined`) → MoneyService
   - Invariant violations (нарушение доменных правил: `Infinity`, `1e16`) → Money

2. **Контроль над error mapping:**
   - MoneyService контролирует как парсинг ошибки мапятся в InvalidMoneyError
   - Money бросает ТОЛЬКО MoneyInvariantViolation

3. **Core остаётся чистым:**
   - Money не знает про форматы (number/string)
   - Money работает ТОЛЬКО с Decimal - типобезопасно

**Реальная реализация:**

```typescript
// MoneyService.create() - Facade
try {
  decimal = new Decimal(value);  // Парсинг в Facade
} catch {
  return Err(InvalidMoneyError with INVALID_FORMAT);
}

try {
  return Ok(Money.of(decimal));  // Core принимает ТОЛЬКО Decimal
} catch (error) {
  if (error instanceof MoneyInvariantViolation) {
    return Err(InvalidMoneyError with reason from Core);
  }
}
```

### 4. Почему MAX_AMOUNT = 1e15?

**Причина:** Безопасность для Number.MAX_SAFE_INTEGER.

JavaScript `Number.MAX_SAFE_INTEGER = 9007199254740991 ≈ 9e15`.

Мы ставим лимит `1e15` чтобы:

- Оставить margin для вычислений (умножение, сложение)
- Гарантировать что `money.toNumber()` безопасен (хоть и lossy)
- Предотвратить overflow в арифметике

**Практичность:**
`1e15 USDC = 1,000,000,000,000,000 USDC = 1 квадриллион долларов`

Это больше чем весь мировой GDP, поэтому лимит разумен.

### 5. Почему MoneyService.create принимает Decimal | number | string?

**Flexibility для разных use cases:**

1. **string** — пользовательский ввод, API responses
2. **number** — литералы в коде, простые тесты
3. **Decimal** — результаты вычислений (zero-copy)

**Facade парсит всё в Decimal** и делегирует `Money.of()` для zero-copy.

### 6. Почему Currency обязательна, но есть default?

**Money ≠ Number**:

- Денежная сумма БЕЗ валюты бессмысленна
- `100` что? Доллары? Евро? Биткоины?

**Default = 'USDC'**:

- Polymarket использует только USDC
- Удобство: `MoneyService.create(100)` вместо `MoneyService.create(100, 'USDC')`
- Явность: можно указать валюту при необходимости

**В будущем:**

- Если добавим другие валюты (EUR, BTC), default можно убрать
- Текущий API будет backward compatible

---

## Заключение

Money модуль следует принципам:

- **Простота** — чёткое разделение на 4 слоя (Core, Rules, Facade, Adapters)
- **Безопасность** — Never Throw Facade, явные ошибки
- **Точность** — Decimal.js для всех вычислений
- **Ясность** — разделение parse errors vs invariant violations

Архитектура позволяет легко:

- Добавлять новые валюты (расширить SUPPORTED_CURRENCIES)
- Добавлять новые операции (в Facade)
- Тестировать каждый слой отдельно
