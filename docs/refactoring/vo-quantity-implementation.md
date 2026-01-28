# Quantity Value Object: New Implementation Plan (Decimal-based)

## Epic Overview

**Epic:** Quantity (Decimal inside) — new implementation + replace exports

**Current state:** `packages/domain/value-objects/src/Quantity.ts` (659 lines, number-based)

**Target:** New Decimal-based implementation with layered architecture

**Strategy:** New implementation in `quantity/` directory, then replace exports (NOT incremental refactoring)

---

## Метаданные

- **Value Object:** Quantity
- **Сложность:** High (базовый VO, используется везде)
- **Зависимости:** `@polymarket/math`, `@polymarket/errors`, `@polymarket/result`
- **Приоритет:** 🔴 ВЫСОКИЙ (базовый unit для всей системы)

---

## ⚠️ Ключевое архитектурное решение

**Quantity хранит Decimal внутри:**

- Core Quantity хранит `Decimal` (opaque)
- Наружу отдаёт `Decimal` через `value()` и `number` через `toNumber()` (lossy)
- Это реально побеждает precision проблемы
- Все арифметические операции работают с `Decimal` через `@polymarket/math`

**Почему новая реализация:**
- Текущий `Quantity.ts` (659 строк) хранит `number`, а `Decimal` использует только для проверок/парсинга
- Миграция на Decimal-внутри — это архитектурный разлом
- Big-bang замена экспортов проще и безопаснее чем инкрементальный рефакторинг

---

## 🚨 Блокеры (проверить ДО начала работы)

### Блокер 1: @polymarket/math должен экспортировать типизированные ошибки

`@polymarket/math` **ДОЛЖЕН** экспортировать:
- `DivisionByZeroError` - для деления на ноль
- `ArithmeticOverflowError` - для переполнения/overflow

**Проверка:**
```bash
grep -r "DivisionByZeroError" packages/foundation/math/src
grep -r "ArithmeticOverflowError" packages/foundation/math/src
```

**Если НЕТ:** Реализовать их в `@polymarket/math` **ДО начала работы над Quantity**.

**Почему критично:**
- Без этих типов невозможно отличить ожидаемые арифметические ошибки от багов
- Невозможно корректно мапить user-input ошибки в Result
- Придется использовать catch-all антипаттерн (скрывает реальные баги)

---

## Правила дизайна (стандарты для всех задач)

### 1. Парсинг разрешён только в двух местах

**Правило:** Парсинг (преобразование `number | string` в `Decimal`) разрешён только в двух местах:

1. **`Quantity.of(value: Decimal.Value)`** (Core — создание доменного примитива)
2. **`QuantityService.*`** (Facade — user-input операции и оркестрация)

**Ни Rules, ни Policy не парсят никогда — принимают только `Decimal`.**

Конкретно:
- ✅ `Quantity.of(value: Decimal.Value)` — парсит в Core
- ✅ `QuantityService.create(value: number | string | Decimal)` — парсит в Facade
- ✅ `QuantityService.multiply(qty, factor: number | Decimal)` — парсит factor в Facade
- ✅ `QuantityService.divide(qty, divisor: number | Decimal)` — парсит divisor в Facade

- ❌ `ValidateMinSize.check(quantity: Decimal, minSize: Decimal)` — НЕ парсит, ТОЛЬКО Decimal
- ❌ `OrderQuantityPolicy.validateForOrder(quantity: Decimal, ...)` — НЕ парсит, ТОЛЬКО Decimal
- ❌ Все остальные rules/policy — НЕ парсят, ТОЛЬКО Decimal

**Почему:** Если разрешить парсинг в rules/policy, он размажется по проекту → проблемы с режимами Decimal и дублирование логики.

### 2. Rules возвращают InvalidQuantityError

**Правило:** Все rules возвращают `Result<void, InvalidQuantityError>`.

Это стандарт домена Polymarket для валидации Quantity.

### 3. Все операции возвращают Result

**Правило:** ВСЕ арифметические операции `QuantityService` возвращают `Result<Quantity, Error>`.

**Причина:** `@polymarket/math` может:
- Вернуть non-finite Decimal (Infinity, NaN)
- Бросить `ArithmeticOverflowError` (если так устроен math layer)
- Результат операции может нарушить инварианты Quantity (например, negative после subtract)

Конкретно:
- `add()` → Result (math может вернуть Infinity/NaN или бросить overflow)
- `subtract()` → Result (результат может быть negative)
- `multiply()` → Result (invalid factor, math может вернуть Infinity/NaN)
- `divide()` → Result (division by zero, math бросает DivisionByZeroError)
- `roundToTick()` → Result (invalid tickSize)

**Важно:** Поведение `@polymarket/math` (throw vs return non-finite) должно быть согласовано с контрактом math layer.

### 4. Выбор конструктора Quantity

**Правило:**

- `Quantity.of(value: Decimal.Value)` — когда вход сырой: `number`, `string`, `Decimal.Value`
- `Quantity.fromDecimal(decimal: Decimal)` — когда вход уже `Decimal` (результат math операций, конфиги)

**Избегайте повторного парсинга (для advanced use cases):**
```typescript
// ❌ Неправильно
const decimal = new Decimal(10);
const qty = Quantity.of(decimal); // лишний парсинг!

// ✅ Правильно
const decimal = new Decimal(10);
const qty = Quantity.fromDecimal(decimal);

// Пример advanced use: после math операций
const sum = addDecimal(qty1.value(), qty2.value());
const result = Quantity.fromDecimal(sum); // напрямую, минуя фасад
```

**Важно:** В `QuantityService` (фасаде) после math операций используйте `this.create(decimalResult)`, который внутри оптимизирован для Decimal. Правило "fromDecimal после math" применяется только для advanced use cases (когда работаете с Quantity напрямую, минуя фасад).

---

## Целевая архитектура

### Структура директорий

```
packages/domain/value-objects/src/quantity/
 ├─ core/
 │   ├─ Quantity.ts                 ← Core VO (только инварианты)
 │   └─ index.ts
 │
 ├─ rules/
 │   ├─ ValidateMinSize.ts
 │   ├─ ValidateResultNonNegative.ts
 │   ├─ ValidateDivisorForQuantityDivision.ts
 │   ├─ ValidateFactorForQuantityMultiplication.ts
 │   ├─ ValidateTickSizeForRounding.ts
 │   └─ index.ts
 │
 ├─ policy/
 │   ├─ OrderQuantityPolicy.ts
 │   ├─ PositionQuantityPolicy.ts
 │   └─ index.ts
 │
 ├─ facade/
 │   ├─ QuantityService.ts
 │   └─ index.ts
 │
 ├─ adapters/
 │   ├─ QuantitySerializer.ts
 │   ├─ QuantityFormatter.ts
 │   └─ index.ts
 │
 └─ index.ts                        ← Главный экспорт (заменит старый Quantity.ts)
```

### Публичный API

#### Core Layer (Quantity)

```typescript
// Создание
Quantity.of(value: Decimal.Value): Quantity
Quantity.fromDecimal(decimal: Decimal): Quantity
Quantity.ZERO: Quantity
Quantity.ONE: Quantity

// Доступ
value(): Decimal
toNumber(): number  // lossy

// Сравнение (без epsilon)
equals(other: Quantity): boolean
isZero(): boolean
isPositive(): boolean
```

#### Facade Layer (QuantityService)

```typescript
// Создание
create(value: number | string | Decimal): Result<Quantity, Error>
createForOrder(value: number | string | Decimal, orderMinSize: Decimal): Result<Quantity, Error>

// Математика (все → Result)
add(qty1: Quantity, qty2: Quantity): Result<Quantity, Error>
subtract(qty1: Quantity, qty2: Quantity): Result<Quantity, Error>
multiply(qty: Quantity, factor: number | Decimal): Result<Quantity, Error>
divide(qty: Quantity, divisor: number | Decimal): Result<Quantity, Error>
roundToTick(qty: Quantity, tickSize: Decimal, mode?): Result<Quantity, Error>

// Валидация
validateForPosition(qty: Quantity): Result<void, Error>
```

#### Adapters Layer

```typescript
// Точная сериализация (string)
QuantitySerializer.toJSON(qty): { value: string }
QuantitySerializer.fromJSON(json): Result<Quantity, Error>

// Lossy сериализация (number)
QuantityLossySerializer.toJSON(qty): { value: number }
QuantityLossySerializer.fromJSON(json): Result<Quantity, Error>

// Форматирование
QuantityFormatter.toString(qty, decimals?): string
QuantityFormatter.toCompactString(qty): string
QuantityFormatter.toDebugString(qty): string
QuantityFormatter.toDisplayString(qty): string  // K/M суффиксы
```

---

## Tasks (Jira-style)

### Task 1 — Create core VO

**Files:**
- ✅ `packages/domain/value-objects/src/quantity/core/Quantity.ts`
- ✅ `packages/domain/value-objects/src/quantity/core/index.ts`

**Implement:**
- `class Quantity`
- `class QuantityInvariantViolation extends Error { readonly reason: 'NEGATIVE' | 'NON_FINITE' }`

**API:**
- `Quantity.of(value: Decimal.Value): Quantity` — с парсингом
- `Quantity.fromDecimal(decimal: Decimal): Quantity` — без парсинга, не клонирует Decimal
- `Quantity.ZERO`, `Quantity.ONE` — константы
- `value(): Decimal` — геттер Decimal
- `toNumber(): number` — геттер number (lossy, с warning в TSDoc)
- `equals(other: Quantity): boolean` — без epsilon
- `isZero(): boolean` — без epsilon
- `isPositive(): boolean`

**Инварианты (проверка в конструкторе):**
1. `>= 0` (non-negative) → throw QuantityInvariantViolation('Quantity value cannot be negative', 'NEGATIVE')
2. `isFinite` → throw QuantityInvariantViolation('Quantity value must be finite', 'NON_FINITE')

**Tests:**
- `__tests__/unit/quantity/core/Quantity.test.ts` (~25 тестов)
- Покрытие: инварианты, of/fromDecimal, equals/isZero/isPositive, ZERO/ONE

**Acceptance Criteria:**
- [ ] QuantityInvariantViolation.reason имеет тип `'NEGATIVE' | 'NON_FINITE'` (union, не любая строка)
- [ ] `of()` парсит Decimal.Value через `new Decimal(value)`
- [ ] `fromDecimal()` НЕ парсит, принимает Decimal как есть (не клонирует)
- [ ] fromDecimal() TSDoc явно указывает: "не клонирует Decimal, принимает как есть"
- [ ] ZERO и ONE используют `of(0)` и `of(1)`
- [ ] equals/isZero используют точное сравнение (без epsilon)
- [ ] toNumber() имеет TSDoc warning про lossy conversion
- [ ] 100% coverage

---

### Task 2 — Create rules (domain-specific, NOT reusable)

**Rules возвращают `InvalidQuantityError` — это стандарт домена Polymarket.**

**Files:**
- ✅ `quantity/rules/ValidateMinSize.ts`
- ✅ `quantity/rules/ValidateResultNonNegative.ts`
- ✅ `quantity/rules/ValidateDivisorForQuantityDivision.ts`
- ✅ `quantity/rules/ValidateFactorForQuantityMultiplication.ts`
- ✅ `quantity/rules/ValidateTickSizeForRounding.ts`
- ✅ `quantity/rules/index.ts`

**Сигнатуры (ВСЕ принимают ТОЛЬКО Decimal):**

```typescript
// ValidateMinSize
static check(quantity: Decimal, minSize: Decimal): Result<void, InvalidQuantityError>

// ValidateResultNonNegative
static check(result: Decimal): Result<void, InvalidQuantityError>

// ValidateDivisorForQuantityDivision
static check(divisor: Decimal): Result<void, InvalidQuantityError>
// Проверяет: divisor > 0 && isFinite

// ValidateFactorForQuantityMultiplication
static check(factor: Decimal): Result<void, InvalidQuantityError>
// Проверяет: factor >= 0 && isFinite

// ValidateTickSizeForRounding
static check(tickSize: Decimal): Result<void, InvalidQuantityError>
// Проверяет: tickSize > 0 && isFinite
```

**Tests:**
- `__tests__/unit/quantity/rules/*.test.ts` (~30 тестов, ~6 на rule)
- Покрытие: valid/invalid cases, граничные случаи (0, negative, Infinity, NaN)

**Acceptance Criteria:**
- [ ] ВСЕ rules принимают ТОЛЬКО Decimal (НЕ number | Decimal)
- [ ] ВСЕ rules возвращают InvalidQuantityError с context
- [ ] InvalidQuantityError.context использует единый формат ключей:
  - ValidateMinSize: `{ quantity, minSize }`
  - ValidateResultNonNegative: `{ result }`
  - ValidateDivisorForQuantityDivision: `{ divisor }`
  - ValidateFactorForQuantityMultiplication: `{ factor }`
  - ValidateTickSizeForRounding: `{ tickSize }`
- [ ] Все значения в context сериализуются через `.toString()`
- [ ] TSDoc содержит @example для каждого rule
- [ ] 100% coverage

---

### Task 3 — Create policy

**Files:**
- ✅ `quantity/policy/OrderQuantityPolicy.ts`
- ✅ `quantity/policy/PositionQuantityPolicy.ts`
- ✅ `quantity/policy/index.ts`

**Сигнатуры (ВСЕ принимают ТОЛЬКО Decimal):**

```typescript
// OrderQuantityPolicy
static validateForOrder(quantity: Decimal, orderMinSize: Decimal): Result<void, InvalidQuantityError>
// Использует ValidateMinSize.check()

// PositionQuantityPolicy
static validateForPosition(quantity: Decimal): Result<void, InvalidQuantityError>
// Проверяет: >= 0 && isFinite (allow zero)

static validatePartialClose(currentQuantity: Decimal, closeQuantity: Decimal): Result<void, InvalidQuantityError>
// Проверяет: closeQuantity > 0 && closeQuantity <= currentQuantity
// Предполагается что currentQuantity и closeQuantity finite (источник — Quantity)
```

**Tests:**
- `__tests__/unit/quantity/policy/*.test.ts` (~15 тестов)
- Покрытие: order validation, position validation (zero allowed), partial close

**Acceptance Criteria:**
- [ ] ВСЕ policy принимают ТОЛЬКО Decimal (НЕ number | Decimal)
- [ ] OrderQuantityPolicy использует ValidateMinSize
- [ ] PositionQuantityPolicy allows zero (>= 0, не > 0)
- [ ] PositionQuantityPolicy.validatePartialClose явно документирует предположение: входы finite (источник — Quantity)
- [ ] TSDoc объясняет почему position может быть 0
- [ ] 100% coverage

---

### Task 4 — Create facade QuantityService

**Rule:** ALL operations return Result (как в правилах дизайна).

**Files:**
- ✅ `quantity/facade/QuantityService.ts`
- ✅ `quantity/facade/index.ts`

**Сигнатуры:**

```typescript
// Создание (парсинг разрешён в фасаде)
static create(value: number | string | Decimal): Result<Quantity, InvalidQuantityError>
// Оптимизация: если value instanceof Decimal → fromDecimal(), иначе of()

static createForOrder(
  value: number | string | Decimal,
  orderMinSize: Decimal  // ⚠️ orderMinSize ТОЛЬКО Decimal
): Result<Quantity, InvalidQuantityError>
// Парсит value один раз → OrderQuantityPolicy.validateForOrder() → create()

// Математика (factor/divisor могут быть number | Decimal в фасаде)
static add(qty1: Quantity, qty2: Quantity): Result<Quantity, InvalidQuantityError>
static subtract(qty1: Quantity, qty2: Quantity): Result<Quantity, InvalidQuantityError>
static multiply(qty: Quantity, factor: number | Decimal): Result<Quantity, InvalidQuantityError>
static divide(qty: Quantity, divisor: number | Decimal): Result<Quantity, InvalidQuantityError>
static roundToTick(qty: Quantity, tickSize: Decimal, mode?: Decimal.Rounding): Result<Quantity, InvalidQuantityError>

// Валидация
static validateForPosition(quantity: Quantity): Result<void, InvalidQuantityError>
```

**Оркестрация в операциях:**

**Важное правило:** В фасаде после math операций всегда используем `this.create(decimalResult)`.

Правило "использовать `fromDecimal()` после math" применяется только для ручного advanced use (когда пользователь напрямую работает с Quantity, минуя фасад).

```typescript
// add()
const sum = addDecimal(qty1.value(), qty2.value());
return this.create(sum);  // create() оптимизирован для Decimal, проверит инварианты

// subtract()
const diff = subtractDecimal(qty1.value(), qty2.value());
const validateResult = ValidateResultNonNegative.check(diff);
if (!validateResult.ok) return Err(validateResult.error);
return this.create(diff);

// multiply() — парсит factor только в фасаде
const factorDecimal = factor instanceof Decimal ? factor : new Decimal(factor);
const validateResult = ValidateFactorForQuantityMultiplication.check(factorDecimal);
if (!validateResult.ok) return Err(validateResult.error);
const result = multiplyDecimal(qty.value(), factorDecimal);
return this.create(result);

// divide() — парсит divisor только в фасаде
const divisorDecimal = divisor instanceof Decimal ? divisor : new Decimal(divisor);
const validateResult = ValidateDivisorForQuantityDivision.check(divisorDecimal);
if (!validateResult.ok) return Err(validateResult.error);
try {
  const result = divideDecimal(qty.value(), divisorDecimal);
  return this.create(result);
} catch (error) {
  // Мапим ТОЛЬКО ожидаемые типы (DivisionByZeroError | ArithmeticOverflowError)
  // Контракт: @polymarket/math.divideDecimal ДОЛЖЕН бросать эти классы
  if (error instanceof DivisionByZeroError || error instanceof ArithmeticOverflowError) {
    return Err(new InvalidQuantityError(...));
  }
  throw error;  // rethrow unexpected
}

// roundToTick()
const validateResult = ValidateTickSizeForRounding.check(tickSize);
if (!validateResult.ok) return Err(validateResult.error);
const rounded = roundToTick(qty.value(), tickSize, roundingMode);
return this.create(rounded);
```

**Imports:**
```typescript
import {
  addDecimal,
  subtractDecimal,
  multiplyDecimal,
  divideDecimal,
  roundToTick,
  DivisionByZeroError,      // ⚠️ Блокер
  ArithmeticOverflowError   // ⚠️ Блокер
} from '@polymarket/math';
```

**Tests:**
- `__tests__/unit/quantity/facade/*.test.ts` (~30 тестов)
- Покрытие: create/createForOrder, все операции (success/failure), валидации

**Acceptance Criteria:**
- [ ] create() использует fromDecimal() для Decimal (оптимизация)
- [ ] createForOrder() парсит value один раз
- [ ] ВСЕ операции возвращают Result
- [ ] В фасаде после math операций всегда используется `this.create(decimalResult)`
- [ ] multiply/divide парсят factor/divisor только в фасаде, потом передают Decimal в rules
- [ ] divide() ловит ТОЛЬКО DivisionByZeroError | ArithmeticOverflowError
- [ ] divide() rethrow unexpected errors
- [ ] Контракт проверяется тестом: @polymarket/math.divideDecimal действительно бросает DivisionByZeroError/ArithmeticOverflowError (не просто вера)
- [ ] create() мапит QuantityInvariantViolation.reason в InvalidQuantityError.context
- [ ] 100% coverage

---

### Task 5 — Create adapters

**Files:**
- ✅ `quantity/adapters/QuantitySerializer.ts` (включает QuantitySerializer + QuantityLossySerializer)
- ✅ `quantity/adapters/QuantityFormatter.ts`
- ✅ `quantity/adapters/index.ts`

**QuantitySerializer (точная сериализация):**
```typescript
static toJSON(quantity: Quantity): { value: string }
// return { value: quantity.value().toString() }

static fromJSON(json: { value: string }): Result<Quantity, InvalidQuantityError>
// return QuantityService.create(json.value)
```

**QuantityLossySerializer (lossy сериализация):**
```typescript
static toJSON(quantity: Quantity): { value: number }
// return { value: quantity.toNumber() }

static fromJSON(json: { value: number }): Result<Quantity, InvalidQuantityError>
// return QuantityService.create(json.value)
```

**QuantityFormatter:**
```typescript
static toString(quantity: Quantity, decimals: number = 2): string
static toCompactString(quantity: Quantity): string
static toDebugString(quantity: Quantity): string
static toDisplayString(quantity: Quantity): string  // с K/M суффиксами
// ⚠️ toDisplayString() использует toNumber() → lossy, может врать на больших значениях
```

**Tests:**
- `__tests__/unit/quantity/adapters/*.test.ts` (~15 тестов)
- Покрытие: string serialization, lossy serialization, все форматтеры

**Acceptance Criteria:**
- [ ] QuantitySerializer использует string (без потери точности)
- [ ] QuantityLossySerializer имеет TSDoc warning про lossy
- [ ] toDisplayString() имеет TSDoc warning: "использует toNumber() → lossy для больших значений"
- [ ] toDisplayString() форматирует >= 1000000 как "M", >= 1000 как "K"
- [ ] В тестах не проверяется "точность больших чисел" через toDisplayString (это lossy)
- [ ] 100% coverage

---

### Task 6 — Public exports + replace old Quantity

**Files:**
- ✅ `quantity/index.ts` — главный экспорт
- ✅ `packages/domain/value-objects/src/index.ts` — обновить экспорты (обеспечить обратную совместимость)
- ✅ `package.json` — добавить `./quantity` export

**⚠️ Важно:** Обеспечить обратный экспорт для старого пути импорта, чтобы не сломать существующий код.

**quantity/index.ts:**
```typescript
// Core
export { Quantity, QuantityInvariantViolation } from './core/index.js';

// Facade (главная точка входа)
export { QuantityService } from './facade/index.js';

// Adapters
export {
  QuantitySerializer,
  QuantityLossySerializer,
  QuantityFormatter
} from './adapters/index.js';

// Rules (для advanced use cases)
export {
  ValidateMinSize,
  ValidateResultNonNegative,
  ValidateDivisorForQuantityDivision,
  ValidateFactorForQuantityMultiplication,
  ValidateTickSizeForRounding
} from './rules/index.js';

// Policy (для advanced use cases)
export {
  OrderQuantityPolicy,
  PositionQuantityPolicy
} from './policy/index.js';
```

**package.json:**
```json
{
  "exports": {
    "./quantity": {
      "types": "./dist/quantity/index.d.ts",
      "import": "./dist/quantity/index.js"
    }
  }
}
```

**packages/domain/value-objects/src/index.ts (обратная совместимость):**
```typescript
// Обратный экспорт для старого пути импорта
// Было: import { Quantity } from '@polymarket/value-objects'
// Стало: import { Quantity } from '@polymarket/value-objects' (ещё работает!)
export { Quantity, QuantityService, QuantityInvariantViolation } from './quantity/index.js';

// Или если нужен полный экспорт:
export * from './quantity/index.js';
```

**Acceptance Criteria:**
- [ ] `quantity/index.ts` экспортирует всё публичное API
- [ ] package.json содержит `./quantity` export
- [ ] `packages/domain/value-objects/src/index.ts` реэкспортирует Quantity/QuantityService (обратная совместимость)
- [ ] `npm run build` успешно компилирует
- [ ] Можно импортировать: `import { Quantity, QuantityService } from '@polymarket/value-objects/quantity'` (новый путь)
- [ ] Можно импортировать: `import { Quantity } from '@polymarket/value-objects'` (старый путь, обратная совместимость)
- [ ] Не ломается существующий код с импортами Quantity

---

### Task 7 — Integration test

**File:**
- ✅ `__tests__/integration/quantity/QuantityWorkflow.integration.test.ts`

**Scenarios:**

1. **createForOrder + minSize validation:**
   - createForOrder с валидным minSize → Ok
   - createForOrder с quantity < minSize → Err

2. **add + subtract + non-negative:**
   - add(qty1, qty2) → Ok(sum)
   - subtract(qty1, qty2) где qty1 > qty2 → Ok(diff)
   - subtract(qty1, qty2) где qty1 < qty2 → Err (negative result)

3. **multiply + divide + round:**
   - multiply с valid factor → Ok
   - multiply с negative factor → Err
   - divide с valid divisor → Ok
   - divide с zero divisor → Err (DivisionByZeroError)
   - roundToTick с valid tickSize → Ok

4. **position validate + partial close:**
   - validateForPosition с qty > 0 → Ok
   - validateForPosition с qty = 0 → Ok (allow zero)
   - QuantityService.create(-1) → Err (NEGATIVE) — тестирует что negative qty не может быть создан
   - PositionQuantityPolicy.validateForPosition(new Decimal(-1)) → Err — тестирует policy-level проверку
   - validatePartialClose с closeQuantity <= currentQuantity → Ok
   - validatePartialClose с closeQuantity > currentQuantity → Err

5. **serialize + deserialize:**
   - QuantitySerializer (string) round-trip без потери точности на числе "12345678901234567890.123456789"
   - QuantityLossySerializer (number) round-trip (не требуем точности, это lossy)
   - Проверить что string serializer сохраняет точность для больших чисел через сравнение строк

**Tests:**
- `__tests__/integration/quantity/QuantityWorkflow.integration.test.ts` (~20 тестов)

**Acceptance Criteria:**
- [ ] Все сценарии проходят
- [ ] Тесты используют реальные компоненты (не моки)
- [ ] Невозможный сценарий "validateForPosition(qty < 0)" заменён на тесты создания negative qty
- [ ] String serializer тестируется на "12345678901234567890.123456789" и сохраняет точность (сравнение через строки)
- [ ] Lossy serializer тестируется отдельно, точность не требуется
- [ ] 100% coverage для интеграционных потоков

---

## План тестирования

### Суммарная статистика

| Слой | Unit тестов | Integration |
|------|-------------|-------------|
| Core | 25 | - |
| Rules | 30 | - |
| Policy | 15 | - |
| Facade | 30 | - |
| Adapters | 15 | - |
| **Integration** | - | 20 |
| **Итого** | **115** | **20** |
| **ВСЕГО** | **135 тестов** | |

### Coverage Target

- **Branches:** 100%
- **Functions:** 100%
- **Lines:** 100%
- **Statements:** 100%

---

## Breaking Changes (для документации миграции)

### 1. Создание Quantity для ордеров

```typescript
// Было:
const qty = Quantity.fromValue(10, 1);

// Стало:
const result = QuantityService.createForOrder(10, new Decimal(1));
if (!result.ok) {
  // Обработка ошибки
}
const qty = result.value;
```

### 2. Внутреннее представление

```typescript
// Было: Quantity хранит number
const num = quantity.value; // number

// Стало: Quantity хранит Decimal
const decimal = quantity.value(); // Decimal
const num = quantity.toNumber(); // number (lossy)
```

### 3. Арифметические операции

```typescript
// ВСЕ арифметические операции возвращают Result

// Было:
const sum = qty1.add(qty2); // Quantity

// Стало:
const result = QuantityService.add(qty1, qty2);
if (!result.ok) {
  // Обработка ошибки (например, overflow)
}
const sum = result.value;
```

### 4. Сериализация

```typescript
// Было: toJSON() возвращал number
const json = { value: 10.5 }; // number

// Стало: toJSON() возвращает string (для точности)
const json = QuantitySerializer.toJSON(qty); // { value: "10.5" }

// Для lossy сериализации (только для отображения):
const lossyJson = QuantityLossySerializer.toJSON(qty); // { value: number }
```

---

## Timeline (оценка)

| Task | Время |
|------|-------|
| **Проверка блокеров** | 15 мин |
| Task 1 — Core VO | 25 мин |
| Task 2 — Rules | 50 мин |
| Task 3 — Policy | 30 мин |
| Task 4 — Facade | 50 мин |
| Task 5 — Adapters | 15 мин |
| Task 6 — Exports | 10 мин |
| Task 7 — Integration | 35 мин |
| **Итого** | **~4 часа** |

---

**Конец плана**
