# SignedQuantityService: Facade Layer

Детальная документация SignedQuantityService — публичного API для работы со знаковыми количествами.

## Содержание

- [Обзор](#обзор)
- [Контракты и гарантии](#контракты-и-гарантии)
- [Методы](#методы)
- [Обработка ошибок](#обработка-ошибок)
- [Внутренняя реализация](#внутренняя-реализация)
- [Best Practices](#best-practices)

## Обзор

SignedQuantityService — это **Facade Layer** для SignedQuantity Value Object.

### Ответственность

1. **Публичный API**: единая точка входа для всех операций
2. **Парсинг входных данных**: безопасная конвертация number/string/Decimal
3. **Оркестрация**: координация Core + Math операций
4. **Error Handling**: конвертация exceptions → Result<T, E>
5. **Контракт "Never Throw"**: гарантия отсутствия exceptions

### Архитектура

```
┌─────────────────────────────────────────────┐
│   SignedQuantityService (Facade)            │
│                                             │
│   Создание и парсинг:                       │
│   + create(value)                           │  ← Парсинг + валидация
│                                             │
│   Арифметика:                               │
│   + add(qty1, qty2)                         │  ← Оркестрация math
│   + subtract(qty1, qty2)                    │  ← Оркестрация math
│   + multiply(qty, factor)                   │  ← Оркестрация math
│   + divide(qty, divisor)                    │  ← Оркестрация math
│                                             │
│   Операции со знаком:                       │
│   + abs(qty)                                │  ← Делегирование Core
│   + negate(qty)                             │  ← Делегирование Core
│                                             │
│   Масштабирование и порции:                 │
│   + scale(qty, rate)                        │  ← Validation + math
│   + portion(qty, rate)                      │  ← Math only
│                                             │
│   Округление и корректировка:               │
│   + roundToStep(qty, step, mode)            │  ← Validation + rounding
│   + adjustBy(qty, delta, step, options)     │  ← Complex orchestration
└─────────────────────────────────────────────┘
          ↓                  ↓
   ┌────────────┐     ┌──────────────┐
   │    Core    │     │  Math Layer  │
   │ (throws)   │     │ (throws)     │
   └────────────┘     └──────────────┘
```

## Контракты и гарантии

### Never Throw Contract

**ВСЕ методы SignedQuantityService НИКОГДА не бросают исключения.**

```typescript
// ✅ Всегда безопасно — возвращает Result
const result = SignedQuantityService.create(value);

// ❌ Никогда не произойдёт
try {
  const result = SignedQuantityService.create(value);
} catch (e) {
  // unreachable code
}
```

**Гарантия:**
- Любые exceptions из Core, Math, или других слоёв ловятся и конвертируются в `Result.Err`
- Публичный API ВСЕГДА возвращает `Result<T, E>`
- TypeScript compiler заставляет обрабатывать ошибки

### Result Contract

**Все операции возвращают `Result<SignedQuantity, InvalidSignedQuantityError>`**

```typescript
type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };
```

**Примеры:**

```typescript
// Успех
const result = SignedQuantityService.create(10);
result.ok === true
result.value === SignedQuantity(10)

// Ошибка
const result = SignedQuantityService.create(NaN);
result.ok === false
result.error === InvalidSignedQuantityError
```

### Error Context Contract

**Каждая ошибка содержит структурированный context:**

```typescript
interface ErrorContext {
  op: string;                    // Название операции
  opChain?: string[];            // Цепочка операций
  quantity?: string;             // Входное количество
  quantity1?: string;            // Первый операнд (для бинарных операций)
  quantity2?: string;            // Второй операнд
  factor?: string;               // Множитель (для multiply)
  divisor?: string;              // Делитель (для divide)
  raw?: { field: string; value: string }; // Сырой ввод (для парсинга)
  cause?: { name: string; message: string }; // Root cause (math exceptions)
  reason?: SignedQuantityErrorReason; // Типизированная причина
}
```

**Пример:**

```typescript
const result = SignedQuantityService.divide(qty, 0);
if (!result.ok) {
  result.error.context.op === 'divide'
  result.error.context.quantity === '100'
  result.error.context.divisor === '0'
  result.error.context.reason === SignedQuantityErrorReason.DIVISION_BY_ZERO
}
```

## Методы

### create

```typescript
public static create(
  value: number | string | Decimal
): Result<SignedQuantity, InvalidSignedQuantityError>
```

**Назначение:** создаёт SignedQuantity из различных типов входных данных.

**Этапы:**
1. Парсинг value → Decimal через `toDecimal()`
2. Создание через Core: `SignedQuantity.of(decimal)`
3. Оборачивание exceptions → Result

**Валидация:**
- Проверка finite (не NaN, не ±Infinity)
- Нормализация -0 → 0

**Примеры:**

```typescript
// From number
SignedQuantityService.create(10);        // Ok(SignedQuantity(10))
SignedQuantityService.create(-10);       // Ok(SignedQuantity(-10))
SignedQuantityService.create(0);         // Ok(SignedQuantity(0))

// From string
SignedQuantityService.create('123.456'); // Ok(SignedQuantity(123.456))
SignedQuantityService.create('-123');    // Ok(SignedQuantity(-123))

// From Decimal
import Decimal from 'decimal.js';
SignedQuantityService.create(new Decimal(-10)); // Ok

// Errors
SignedQuantityService.create(NaN);       // Err(reason: NAN)
SignedQuantityService.create(Infinity);  // Err(reason: NON_FINITE)
SignedQuantityService.create('invalid'); // Err(reason: INVALID_FORMAT)
```

**Error Context:**
```typescript
{
  op: 'create',
  raw: { field: 'value', value: '...' },
  reason: SignedQuantityErrorReason.NAN | NON_FINITE | INVALID_FORMAT
}
```

### add

```typescript
public static add(
  qty1: SignedQuantity,
  qty2: SignedQuantity
): Result<SignedQuantity, InvalidSignedQuantityError>
```

**Назначение:** складывает два знаковых количества.

**Алгоритм:**
1. Сложение через `addDecimal(qty1.value(), qty2.value())`
2. Создание результата через `createFromDecimal()`

**Примеры:**

```typescript
const a = SignedQuantityService.create(100).value;
const b = SignedQuantityService.create(-30).value;

SignedQuantityService.add(a, b); // Ok(SignedQuantity(70))

// Результат может быть отрицательным
SignedQuantityService.add(b, a); // Ok(SignedQuantity(70))

// Сумма до нуля
const c = SignedQuantityService.create(-100).value;
SignedQuantityService.add(a, c); // Ok(SignedQuantity(0))
```

**Error Context:**
```typescript
{
  op: 'add',
  quantity1: '100',
  quantity2: '-30'
}
```

### subtract

```typescript
public static subtract(
  qty1: SignedQuantity,
  qty2: SignedQuantity
): Result<SignedQuantity, InvalidSignedQuantityError>
```

**Назначение:** вычитает знаковые количества.

**Отличие от Quantity:** результат может быть отрицательным (нет проверки non-negative).

**Алгоритм:**
1. Вычитание через `subtractDecimal(qty1.value(), qty2.value())`
2. Создание результата через `createFromDecimal()`

**Примеры:**

```typescript
const a = SignedQuantityService.create(100).value;
const b = SignedQuantityService.create(30).value;

SignedQuantityService.subtract(a, b); // Ok(SignedQuantity(70))

// ✅ Результат может быть отрицательным
SignedQuantityService.subtract(b, a); // Ok(SignedQuantity(-70))
```

**Error Context:**
```typescript
{
  op: 'subtract',
  quantity1: '100',
  quantity2: '30'
}
```

### multiply

```typescript
public static multiply(
  quantity: SignedQuantity,
  factor: number | string | Decimal
): Result<SignedQuantity, InvalidSignedQuantityError>
```

**Назначение:** умножает знаковое количество на коэффициент.

**Отличие от Quantity:** factor может быть отрицательным.

**Алгоритм:**
1. Парсинг factor → Decimal
2. Умножение через `multiplyDecimal(quantity.value(), factorDecimal)`
3. Создание результата через `createFromDecimal()`

**Примеры:**

```typescript
const qty = SignedQuantityService.create(100).value;

// Умножение на положительный
SignedQuantityService.multiply(qty, 2);    // Ok(SignedQuantity(200))

// ✅ Умножение на отрицательный (инверсия знака)
SignedQuantityService.multiply(qty, -1);   // Ok(SignedQuantity(-100))

// Умножение на дробь
SignedQuantityService.multiply(qty, 0.5);  // Ok(SignedQuantity(50))

// Умножение на ноль
SignedQuantityService.multiply(qty, 0);    // Ok(SignedQuantity(0))
```

**Error Context:**
```typescript
{
  op: 'multiply',
  quantity: '100',
  factor: '-1'
}
```

### divide

```typescript
public static divide(
  quantity: SignedQuantity,
  divisor: number | string | Decimal
): Result<SignedQuantity, InvalidSignedQuantityError>
```

**Назначение:** делит знаковое количество на делитель.

**Валидация:**
- Проверка деления на ноль (divisor.isZero() → Err)

**Алгоритм:**
1. Парсинг divisor → Decimal
2. Проверка на ноль
3. Деление через `divideDecimal(quantity.value(), divisorDecimal)`
4. Создание результата через `createFromDecimal()`

**Примеры:**

```typescript
const qty = SignedQuantityService.create(100).value;

// Деление на положительный
SignedQuantityService.divide(qty, 2);    // Ok(SignedQuantity(50))

// ✅ Деление на отрицательный (инверсия знака)
SignedQuantityService.divide(qty, -2);   // Ok(SignedQuantity(-50))

// ❌ Деление на ноль
SignedQuantityService.divide(qty, 0);    // Err(reason: DIVISION_BY_ZERO)
```

**Error Context:**
```typescript
// Деление на ноль
{
  op: 'divide',
  quantity: '100',
  divisor: '0',
  reason: SignedQuantityErrorReason.DIVISION_BY_ZERO
}
```

### abs

```typescript
public static abs(
  quantity: SignedQuantity
): Result<SignedQuantity, InvalidSignedQuantityError>
```

**Назначение:** возвращает абсолютное значение.

**Алгоритм:**
1. Получение abs через `quantity.abs()` (возвращает Decimal)
2. Создание SignedQuantity через `createFromDecimal()`

**Примеры:**

```typescript
const negative = SignedQuantityService.create(-100).value;
SignedQuantityService.abs(negative); // Ok(SignedQuantity(100))

const positive = SignedQuantityService.create(100).value;
SignedQuantityService.abs(positive); // Ok(SignedQuantity(100))

const zero = SignedQuantity.ZERO;
SignedQuantityService.abs(zero); // Ok(SignedQuantity(0))
```

**Error Context:**
```typescript
{
  op: 'abs',
  quantity: '-100'
}
```

### negate

```typescript
public static negate(
  quantity: SignedQuantity
): Result<SignedQuantity, InvalidSignedQuantityError>
```

**Назначение:** инвертирует знак (положительное ↔ отрицательное).

**Алгоритм:**
1. Инверсия через `quantity.neg()` (возвращает SignedQuantity)
2. Оборачивание в Result

**Примеры:**

```typescript
const positive = SignedQuantityService.create(100).value;
SignedQuantityService.negate(positive); // Ok(SignedQuantity(-100))

const negative = SignedQuantityService.create(-100).value;
SignedQuantityService.negate(negative); // Ok(SignedQuantity(100))

const zero = SignedQuantity.ZERO;
SignedQuantityService.negate(zero); // Ok(SignedQuantity(0))
```

**Error Context:**
```typescript
{
  op: 'negate',
  quantity: '100'
}
```

### scale

```typescript
public static scale(
  quantity: SignedQuantity,
  rate: Ratio
): Result<SignedQuantity, InvalidSignedQuantityError>
```

**Назначение:** масштабирует количество на rate с валидацией rate ≥ 0.

**Алгоритм:**
1. Конвертация rate → Decimal через `rate.toDecimal()`
2. Валидация: rate ≥ 0 и isFinite (через ValidateFactorForSignedQuantityScale)
3. Умножение: `quantity.value() * rate`
4. Создание результата через `createFromDecimal()`

**Отличие от portion:** scale требует rate ≥ 0 (защита от инверсии знака).

**Примеры:**

```typescript
const qty = SignedQuantityService.create(100).value;
const rate2x = RatioService.fromDecimal(2).value;

// Масштабирование long позиции
SignedQuantityService.scale(qty, rate2x); // Ok(SignedQuantity(200))

// Масштабирование short позиции
const short = SignedQuantityService.create(-50).value;
SignedQuantityService.scale(short, rate2x); // Ok(SignedQuantity(-100))

// Ошибка: negative rate
const negRate = RatioService.fromDecimal(-1).value;
SignedQuantityService.scale(qty, negRate); // Err(reason: NEGATIVE_SCALE_FACTOR)
```

**Error Context:**
```typescript
{
  op: 'scale',
  quantity: '100',
  rate: '2',
  reason: SignedQuantityErrorReason.NEGATIVE_SCALE_FACTOR | NON_FINITE
}
```

### portion

```typescript
public static portion(
  quantity: SignedQuantity,
  rate: Ratio
): Result<SignedQuantity, InvalidSignedQuantityError>
```

**Назначение:** вычисляет часть количества, rate может быть любым (включая отрицательный).

**Алгоритм:**
1. Конвертация rate → Decimal
2. Умножение: `quantity.value() * rate` (БЕЗ валидации rate)
3. Создание результата через `createFromDecimal()`

**Отличие от scale:** portion НЕ требует rate ≥ 0, может инвертировать знак.

**Примеры:**

```typescript
const qty = SignedQuantityService.create(100).value;
const rate25pct = RatioService.fromDecimal(0.25).value;

// Взять 25%
SignedQuantityService.portion(qty, rate25pct); // Ok(SignedQuantity(25))

// Negative rate — инверсия знака
const negRate = RatioService.fromDecimal(-0.5).value;
SignedQuantityService.portion(qty, negRate); // Ok(SignedQuantity(-50))
```

**Error Context:**
```typescript
{
  op: 'portion',
  quantity: '100',
  rate: '0.25'
}
```

### roundToStep

```typescript
public static roundToStep(
  quantity: SignedQuantity,
  stepSize: number | string | Decimal,
  roundingMode: Decimal.Rounding = Decimal.ROUND_HALF_UP
): Result<SignedQuantity, InvalidSignedQuantityError>
```

**Назначение:** округляет до ближайшего кратного stepSize.

**Алгоритм:**
1. Парсинг stepSize → Decimal через `toDecimal()`
2. Валидация: stepSize > 0 и isFinite (через ValidateStepSizeForSignedQuantity)
3. Округление через `roundToTick(quantity.value(), stepSize, roundingMode)`
4. Создание результата через `createFromDecimal()`

**Режимы округления:**
- `ROUND_HALF_UP` (default): к ближайшему, .5 вверх
- `ROUND_DOWN`: к нулю
- `ROUND_UP`: от нуля
- `ROUND_FLOOR`: к -Infinity
- `ROUND_CEIL`: к +Infinity

**Примеры:**

```typescript
const qty = SignedQuantityService.create(10.567).value;

// Округление до центов (0.01)
SignedQuantityService.roundToStep(qty, 0.01); // Ok(SignedQuantity(10.57))

// Negative с ROUND_DOWN (к нулю)
const negQty = SignedQuantityService.create(-10.567).value;
SignedQuantityService.roundToStep(negQty, 0.01, Decimal.ROUND_DOWN);
// Ok(SignedQuantity(-10.56))

// ROUND_FLOOR (к -Infinity)
SignedQuantityService.roundToStep(negQty, 0.01, Decimal.ROUND_FLOOR);
// Ok(SignedQuantity(-10.57))
```

**Error Context:**
```typescript
{
  op: 'roundToStep',
  quantity: '10.567',
  stepSize: '0.01',
  roundingMode: '4',
  reason: SignedQuantityErrorReason.INVALID_FORMAT | NON_FINITE
}
```

### adjustBy

```typescript
public static adjustBy(
  quantity: SignedQuantity,
  delta: Ratio,
  stepSize: number | string | Decimal,
  options?: {
    roundingMode?: Decimal.Rounding;
    allowCrossZero?: boolean;
  }
): Result<SignedQuantity, InvalidSignedQuantityError>
```

**Назначение:** изменяет количество на процент delta с округлением и опциональной защитой от crossing zero.

**Алгоритм:**
1. Парсинг stepSize → Decimal
2. Валидация stepSize > 0 и isFinite
3. Вычисление multiplier = `delta.onePlus()` (1 + delta)
4. Умножение: `quantity.value() * multiplier`
5. Округление до stepSize
6. Если `allowCrossZero = false`: валидация через ValidateDeltaForAdjustByNoCrossZero
7. Создание результата

**Опции:**
- `roundingMode`: режим округления (default: ROUND_HALF_UP)
- `allowCrossZero`: разрешить смену знака (default: true)

**Политика allowCrossZero = false:**
- Запрещает positive → negative или negative → positive
- Разрешает схлопывание до zero (result === 0)
- Запрещает adjustBy на zero quantity (кроме delta = 0)

**Примеры:**

```typescript
const qty = SignedQuantityService.create(100).value;
const delta10pct = RatioService.fromPercent(10).value; // +10%

// Увеличение на 10%
SignedQuantityService.adjustBy(qty, delta10pct, 0.01);
// Ok(SignedQuantity(110))

// Уменьшение на 20%
const deltaMinus20 = RatioService.fromPercent(-20).value;
SignedQuantityService.adjustBy(qty, deltaMinus20, 0.01);
// Ok(SignedQuantity(80))

// Защита от crossing zero
const deltaMinus150 = RatioService.fromPercent(-150).value;
SignedQuantityService.adjustBy(qty, deltaMinus150, 0.01, { allowCrossZero: false });
// Err(reason: RESULT_CROSSES_ZERO)

// Граничный случай: result = 0 разрешён
const deltaMinus100 = RatioService.fromPercent(-100).value;
SignedQuantityService.adjustBy(qty, deltaMinus100, 0.01, { allowCrossZero: false });
// Ok(SignedQuantity(0))
```

**Error Context:**
```typescript
{
  op: 'adjustBy',
  quantity: '100',
  delta: '0.1',
  stepSize: '0.01',
  roundingMode: '4',
  allowCrossZero: 'false',
  reason: SignedQuantityErrorReason.RESULT_CROSSES_ZERO | CANNOT_ADJUST_ZERO | INVALID_FORMAT
}
```

## Обработка ошибок

### wrapOp Pattern

**Все операции используют `wrapOp()` для обработки exceptions:**

```typescript
return wrapOp(
  'SignedQuantityService',  // Service name
  'create',                 // Operation name
  { raw: { field: 'value', value: String(value) } }, // Context
  () => {
    // Код который может бросить exception
    const qty = SignedQuantity.of(decimalResult.value);
    return Ok(qty);
  },
  InvalidSignedQuantityError // Error class
);
```

**wrapOp гарантирует:**
- Любой exception конвертируется в Result.Err
- Context сохраняется в error.context
- Error class используется для создания ошибки

### rewrap Pattern

**Для пропагации ошибок из вложенных операций:**

```typescript
const decimalResult = toDecimal('value', value, ...);
if (isErr(decimalResult)) {
  return Err(
    rewrap(
      'SignedQuantityService',
      'create',
      {},
      decimalResult.error,
      InvalidSignedQuantityError
    )
  );
}
```

**rewrap сохраняет:**
- Оригинальный reason из внутренней ошибки
- Оригинальный cause из math exceptions
- Добавляет op и opChain для трассировки

### Error Chain

**Пример цепочки ошибок:**

```typescript
// 1. Пользователь вызывает Service
const result = SignedQuantityService.create('invalid');

// 2. toDecimal() возвращает Err
// → error.context.reason = INVALID_FORMAT

// 3. rewrap() добавляет context
// → error.context.op = 'create'
// → error.context.opChain = ['create']

// 4. Возвращается пользователю
result.error.context.op === 'create'
result.error.context.reason === 'INVALID_FORMAT'
```

## Внутренняя реализация

### createFromDecimal (private)

```typescript
private static createFromDecimal(
  decimal: Decimal
): Result<SignedQuantity, InvalidSignedQuantityError>
```

**Назначение:** внутренний хелпер для создания SignedQuantity из уже валидированного Decimal.

**Использование:**
- В арифметических операциях (результат уже Decimal)
- В операциях со знаком (abs возвращает Decimal)

**Обоснование:**
- Избегает повторного парсинга
- Core получает готовый Decimal → только проверка инвариантов

**Пример:**

```typescript
// В методе add()
const sum = addDecimal(qty1.value(), qty2.value()); // → Decimal
return this.createFromDecimal(sum); // → Result<SignedQuantity, E>
```

### toDecimal Utility

**Безопасный парсинг без instanceof:**

```typescript
const decimalResult = toDecimal(
  'value',                           // field name
  value,                             // input
  SignedQuantityErrorReason.INVALID_FORMAT, // default reason
  InvalidSignedQuantityError,        // error class
  {
    nanReason: SignedQuantityErrorReason.NAN,
    nonFiniteReason: SignedQuantityErrorReason.NON_FINITE
  }
);
```

**Возвращает:**
- `Ok(Decimal)` — успешный парсинг
- `Err(InvalidSignedQuantityError)` — ошибка с типизированным reason

## Best Practices

### 1. Всегда обрабатывай ошибки

```typescript
// ✅ Правильно
const result = SignedQuantityService.create(value);
if (!result.ok) {
  console.error(result.error);
  return;
}
const qty = result.value;

// ❌ Неправильно (TypeScript не скомпилируется)
const qty = SignedQuantityService.create(value).value; // Error: Property 'value' does not exist on type 'Result'
```

### 2. Используй isErr / isOk helpers

```typescript
import { isErr, isOk } from '@polymarket/result';

const result = SignedQuantityService.create(value);

if (isErr(result)) {
  // TypeScript знает: result.ok === false, result.error доступен
  console.error(result.error);
  return;
}

// TypeScript знает: result.ok === true, result.value доступен
const qty = result.value;
```

### 3. Propagate Result через функции

```typescript
function calculateTotal(
  quantities: SignedQuantity[]
): Result<SignedQuantity, InvalidSignedQuantityError> {
  let total = SignedQuantity.ZERO;

  for (const qty of quantities) {
    const result = SignedQuantityService.add(total, qty);
    if (!result.ok) {
      // Прокидываем ошибку выше
      return result;
    }
    total = result.value;
  }

  return Ok(total);
}
```

### 4. Используй контекст ошибки для диагностики

```typescript
const result = SignedQuantityService.divide(qty, divisor);

if (!result.ok) {
  const ctx = result.error.context;
  console.error(`Operation: ${ctx.op}`);
  console.error(`Quantity: ${ctx.quantity}`);
  console.error(`Divisor: ${ctx.divisor}`);
  console.error(`Reason: ${ctx.reason}`);
}
```

### 5. НЕ используй Core напрямую в публичном коде

```typescript
// ❌ НЕ делай так в публичном коде
import { SignedQuantity } from '@polymarket/value-objects/signed-quantity';
const qty = SignedQuantity.of(new Decimal(10)); // может бросить!

// ✅ Используй Facade
import { SignedQuantityService } from '@polymarket/value-objects/signed-quantity';
const result = SignedQuantityService.create(10); // Result<T, E>
```

### 6. Core только для внутренних операций

```typescript
// ✅ Core используется внутри Facade
export class SignedQuantityService {
  public static create(value: number | string | Decimal): Result<...> {
    return wrapOp(..., () => {
      const qty = SignedQuantity.of(decimal); // OK: wrapOp поймает exception
      return Ok(qty);
    }, ...);
  }
}
```

## Тестирование

### Test Coverage

**72 теста для SignedQuantityService:**

- `create()`: 10 тестов
  - Успешное создание (positive, negative, zero, from string, from Decimal)
  - Нормализация -0 → 0
  - Валидация (NaN, Infinity, invalid string)

- `add()`: 4 теста
  - Сложение различных комбинаций знаков
  - Сумма до нуля

- `subtract()`: 4 теста
  - Вычитание с отрицательным результатом
  - Различные комбинации знаков

- `multiply()`: 6 тестов
  - Умножение на положительный, отрицательный, ноль, дробь
  - Валидация NaN factor

- `divide()`: 5 тестов
  - Деление на положительный, отрицательный
  - Деление на ноль (ошибка)
  - Валидация NaN divisor

- `abs()`: 3 теста
  - Положительное, отрицательное, ноль

- `negate()`: 4 теста
  - Инверсия знака, double negate

- `scale()`: 6 тестов
  - Масштабирование positive/negative на positive rate
  - Scale by zero, масштабирование нуля
  - Ошибка на negative rate
  - Error context validation

- `portion()`: 5 тестов
  - Вычисление порции с positive/negative rate
  - Инверсия знака через negative rate

- `roundToStep()`: 11 тестов
  - Округление positive/negative с разными режимами
  - Валидация invalid stepSize (zero, negative, NaN, 'abc')
  - String stepSize support
  - Error context validation

- `adjustBy()`: 11 тестов
  - Увеличение/уменьшение на процент
  - allowCrossZero политика (true/false)
  - Граничные случаи (zero crossing, idempotent)
  - Валидация invalid stepSize (zero, NaN, 'abc')
  - Custom rounding modes
  - Error context validation

- Integration scenarios: 3 теста
  - P&L calculation
  - Position reversal
  - Percentage of position

### Test Pattern

```typescript
it('should create positive SignedQuantity from number', () => {
  const result = SignedQuantityService.create(10);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.toNumber()).toBe(10);
  }
});
```

## См. также

- [README.md](../README.md) — основная документация
- [architecture.md](./architecture.md) — архитектурные решения
- [examples.md](./examples.md) — примеры использования
