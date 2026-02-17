# Shared Assertion Helpers

Внутренние утилиты валидации операндов и результатов математических операций.

## Описание

Модуль `shared/assertions` содержит centralized assertion-функции, которые используются всеми математическими операциями пакета. Это исключает дублирование логики валидации и обеспечивает единый контракт проверок.

**Зачем отдельный модуль:**

- Все операции (add, subtract, multiply, divide, ...) выполняют одни и те же проверки
- Единый duck-typing контракт — нет расхождений между функциями
- Разные типы ошибок для одной логики (InvalidOperandError vs InvalidDivisorError) — через ErrorCtor generic
- Centralized проверка делителя — больше не разбросана по файлам

## Типы

### `DecimalLike`

Минимальный контракт объекта, который считается Decimal-подобным.

```typescript
export interface DecimalLike {
  isFinite(): boolean;
  toString(): string;
  toNumber(): number;
}
```

**Зачем нужен:**

Функции принимают `unknown` для runtime-валидации. После `assertFiniteOperandWith(value, ...)` TypeScript сужает тип `value` до `DecimalLike`, что даёт безопасный доступ к этим трём методам без дополнительных cast.

**Совместимость:**

Удовлетворяет как нативный `Decimal` из decimal.js, так и Decimal-объекты из других копий библиотеки (разные контексты node_modules). Это критично для кросс-пакетных сценариев.

### `DivisorLike`

Расширение `DecimalLike` для делителей — добавляет `isZero`.

```typescript
export interface DivisorLike extends DecimalLike {
  isZero(): boolean;
}
```

**Зачем нужен:**

`assertNonZeroDivisor` после успешной проверки гарантирует тип `DivisorLike`. Это позволяет вызвать `.isZero()` без unsafe cast. Интерфейс намеренно не включён в общий `DecimalLike` — не все операнды являются делителями.

## Функции

### `assertFiniteOperandWith`

Generic assertion: проверяет что значение является конечным Decimal-like объектом.

```typescript
function assertFiniteOperandWith<TError>(
  value: unknown,
  paramName: string,
  context: MathOperationContext,
  ErrorCtor: ErrorConstructor<TError>
): asserts value is DecimalLike
```

#### Параметры

| Параметр | Тип | Описание |
|----------|-----|----------|
| `value` | `unknown` | Значение для проверки |
| `paramName` | `string` | Имя параметра для сообщения об ошибке (`'a'`, `'b'`, `'value'`) |
| `context` | `MathOperationContext` | Контекст операции для ошибки |
| `ErrorCtor` | `ErrorConstructor<TError>` | Конструктор ошибки |

#### Порядок проверок

1. **duck-typing**: `isDecimalLike(value)` — проверяет `isFinite`, `toString`, `toNumber`
2. **конечность**: `value.isFinite()` — проверяет что число не NaN/Infinity

#### Зачем `unknown` вместо `Decimal`

Входной тип `unknown` вместо `Decimal` решает две задачи:

```typescript
// 1. Runtime-валидация: функция сама проверяет тип
divideDecimal(null as any, new Decimal(2)); // → InvalidOperandError, не TypeError

// 2. Кросс-контекстная совместимость: Decimal из другого node_modules
const d = createDecimalFromAnotherModule('1.5'); // instanceof Decimal === false
assertFiniteOperandWith(d, 'a', ctx, InvalidOperandError); // ✅ проходит duck-typing
```

#### Пример использования

```typescript
import { assertFiniteOperandWith } from '@polymarket/math/shared';
import { InvalidOperandError, InvalidDivisorError } from '@polymarket/errors';

const context = { operation: 'divide', a: '10', b: '2' };

// Разные типы ошибок — одна логика
assertFiniteOperandWith(a, 'a', context, InvalidOperandError);  // делимое
assertFiniteOperandWith(b, 'b', context, InvalidDivisorError);  // делитель

// После вызова TypeScript знает: a и b — DecimalLike
a.isFinite(); // ok, тип сужен
```

---

### `assertFiniteOperand`

Обёртка `assertFiniteOperandWith` с фиксированным `InvalidOperandError`.

```typescript
function assertFiniteOperand(
  value: unknown,
  paramName: string,
  context: MathOperationContext
): asserts value is DecimalLike
```

Используется в операциях округления (`roundToPrecision`, `roundToTick`), где операнд всегда обычный (не делитель).

```typescript
assertFiniteOperand(value, 'value', context); // InvalidOperandError при ошибке
// эквивалентно:
assertFiniteOperandWith(value, 'value', context, InvalidOperandError);
```

---

### `assertFiniteOperands`

Проверяет **оба** операнда бинарной операции через `assertFiniteOperandWith`.

```typescript
function assertFiniteOperands(
  a: unknown,
  b: unknown,
  context: MathOperationContext
): void
```

**Алгоритм:**

```
1. fullContext = { ...context, a: toStringSafe(a), b: toStringSafe(b) }
2. assertFiniteOperandWith(a, 'a', fullContext, InvalidOperandError)
3. assertFiniteOperandWith(b, 'b', fullContext, InvalidOperandError)
```

`a` и `b` формируются из реальных параметров, не из переданного `context` — это защита от случаев, когда caller передаёт устаревшие значения.

**Контракт совпадает с `assertFiniteOperandWith`:** тот же duck-typing, те же правила конечности.

```typescript
const context = { operation: 'add', a: toStringSafe(a), b: toStringSafe(b) };
assertFiniteOperands(a, b, context);
// Если не бросило — оба операнда прошли проверку
```

---

### `assertNonZeroDivisor`

Centralized проверка делителя: конечность + наличие `isZero` + ненулевое значение.

```typescript
function assertNonZeroDivisor(
  divisor: unknown,
  context: MathOperationContext
): asserts divisor is DivisorLike
```

#### Порядок проверок

```
1. assertFiniteOperandWith(divisor, 'b', context, InvalidDivisorError)
   → не Decimal-like: InvalidDivisorError("b must be a valid Decimal instance, ...")
   → NaN/Infinity:   InvalidDivisorError("b must be finite, ...")

2. typeof divisor.isZero !== 'function'
   → InvalidDivisorError("Operand 'b' (divisor) must have isZero method, ...")

3. divisor.isZero() === true
   → DivisionByZeroError("Cannot divide by zero ...")
```

#### Почему централизовано, а не в каждой операции

До рефакторинга `divide.ts` содержал 3 отдельных блока проверок делителя. Если бы появилась ещё одна операция деления (например, `modulo`), их пришлось бы копировать. Теперь всё в одном месте.

#### Почему `isZero` не включён в `DecimalLike`

Проверка `isZero` специфична только для делителя. Включать её в общий контракт всех операндов означало бы требовать `isZero` от `a` в `addDecimal`, `subtractDecimal` и т.д. — это избыточно и нарушает принцип наименьшего удивления.

```typescript
import { assertNonZeroDivisor } from '@polymarket/math/shared';

const context = { operation: 'divide', a: '10', b: '0' };

// Нулевой делитель → DivisionByZeroError
assertNonZeroDivisor(new Decimal(0), context);

// NaN делитель → InvalidDivisorError (не DivisionByZeroError)
assertNonZeroDivisor(new Decimal(NaN), context);

// Без isZero метода → InvalidDivisorError
const fakeDecimal = { isFinite: () => true, toString: () => '5', toNumber: () => 5 };
assertNonZeroDivisor(fakeDecimal, context); // → InvalidDivisorError
```

---

### `withResult`

Создаёт копию контекста с добавленным полем `result`.

```typescript
function withResult(
  context: MathOperationContext,
  result: unknown
): MathOperationContext
```

#### Почему нужен helper

До рефакторинга каждая операция вручную строила контекст для `assertFiniteResult`:

```typescript
// Было: дублирование в каждом файле
assertFiniteResult(result, {
  operation: 'add',
  a: toStringSafe(a),
  b: toStringSafe(b),
  result: toStringSafe(result), // ← ручное добавление
});
```

Теперь:

```typescript
// Стало: единообразно
assertFiniteResult(result, withResult(context, result));
```

#### Свойства

- **Иммутабельный**: не изменяет `context`, возвращает новый объект
- **Сериализует через `toStringSafe`**: безопасен для любого типа `result`
- **Тип `unknown`**: работает с `Decimal`, `null`, `undefined`, числами

```typescript
import { withResult } from '@polymarket/math/shared';

const context = { operation: 'multiply', a: '4', b: '5' };
const result = new Decimal('20');

const ctxWithResult = withResult(context, result);
// → { operation: 'multiply', a: '4', b: '5', result: '20' }

// Оригинальный context не изменён
console.log(context.result); // undefined
```

## Архитектура: поток проверок в операции

```
divideDecimal(a, b)
    │
    ├─ context = { operation, a: toStringSafe(a), b: toStringSafe(b) }
    │
    ├─ assertFiniteOperandWith(a, 'a', context, InvalidOperandError)
    │   ├─ isDecimalLike(a)?  NO → throw InvalidOperandError
    │   └─ a.isFinite()?      NO → throw InvalidOperandError
    │
    ├─ assertNonZeroDivisor(b, context)
    │   ├─ isDecimalLike(b)?        NO → throw InvalidDivisorError
    │   ├─ b.isFinite()?            NO → throw InvalidDivisorError
    │   ├─ typeof b.isZero === fn?  NO → throw InvalidDivisorError
    │   └─ b.isZero()?             YES → throw DivisionByZeroError
    │
    ├─ result = a.div(b)
    │
    └─ assertFiniteResult(result, withResult(context, result))
        └─ result.isFinite()?  NO → throw ArithmeticOverflowError
```

```
addDecimal(a, b)                   subtractDecimal(a, b)
multiplyDecimal(a, b)              averageDecimal(a, b)
    │
    ├─ context = { operation, a: toStringSafe(a), b: toStringSafe(b) }
    │
    ├─ assertFiniteOperands(a, b, context)
    │   ├─ fullContext = { ...context, a: ..., b: ... }
    │   ├─ assertFiniteOperandWith(a, 'a', fullContext, InvalidOperandError)
    │   └─ assertFiniteOperandWith(b, 'b', fullContext, InvalidOperandError)
    │
    ├─ result = a.plus/minus/times(b)
    │
    └─ assertFiniteResult(result, withResult(context, result))
```

## Контекст ошибок

Все assertion-функции включают `MathOperationContext` в ошибку. Это позволяет диагностировать проблему без стек-трейса:

```typescript
try {
  divideDecimal(new Decimal('10'), new Decimal('0'));
} catch (error) {
  if (DivisionByZeroError.is(error)) {
    console.log(error.context);
    // {
    //   operation: 'divide',
    //   a: '10',
    //   b: '0'
    // }
  }
}

try {
  addDecimal(new Decimal(Infinity), new Decimal('5'));
} catch (error) {
  if (InvalidOperandError.is(error)) {
    console.log(error.context);
    // {
    //   operation: 'add',
    //   a: 'Infinity',
    //   b: '5',
    //   paramName: 'a',
    //   value: 'Infinity'
    // }
  }
}
```

## Расширение: кастомная операция с assertion helpers

Если вы создаёте новую операцию в пакете, используйте те же helpers:

```typescript
import Decimal from 'decimal.js';
import {
  assertFiniteOperands,
  assertFiniteResult,
  withResult,
  toStringSafe,
} from '../shared/index.js';

// Пример: взвешенное среднее
export function weightedAverageDecimal(
  value: Decimal,
  weight: Decimal
): Decimal {
  const context = {
    operation: 'weightedAverage',
    a: toStringSafe(value),
    b: toStringSafe(weight),
  };

  assertFiniteOperands(value, weight, context);

  const result = value.times(weight);

  assertFiniteResult(result, withResult(context, result));

  return result;
}
```

## Экспорты

Все функции и типы экспортируются из `shared/index.ts`:

```typescript
import {
  assertFiniteOperandWith,
  assertFiniteOperand,
  assertFiniteOperands,
  assertNonZeroDivisor,
  withResult,
  toStringSafe,
} from '@polymarket/math/shared'; // внутренний путь

// Типы
import type {
  DecimalLike,
  DivisorLike,
  MathOperationContext,
  ErrorConstructor,
} from '@polymarket/math/shared';
```

## См. также

- [divideDecimal](../decimal/divide.md) — использует `assertNonZeroDivisor`
- [addDecimal](../decimal/add.md) — использует `assertFiniteOperands` + `withResult`
- [roundToPrecision](../rounding/README.md) — использует `assertFiniteOperand`
- [DivisionByZeroError](../../../../errors/docs/math/division-by-zero.md)
- [InvalidDivisorError](../../../../errors/docs/math/invalid-divisor.md)
- [InvalidOperandError](../../../../errors/docs/math/invalid-operand.md)
