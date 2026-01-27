# План реализации Foundation: Math Package

## Оглавление

1. [Резюме](#резюме)
2. [Мотивация](#мотивация)
3. [Архитектура Math Package](#архитектура-math-package)
4. [Детальный план реализации](#детальный-план-реализации)
5. [План тестирования](#план-тестирования)
6. [План документации](#план-документации)
7. [Критерии завершения](#критерии-завершения)

---

## Резюме

**Цель:** Создать независимый `@polymarket/math` package с чистыми математическими операциями над Decimal.

**Почему первым:**
- ✅ Не зависит от других пакетов (кроме `decimal.js` и `@polymarket/errors`)
- ✅ Можно реализовать и протестировать полностью изолированно
- ✅ Переиспользуется всеми numeric Value Objects (Quantity, Price, Money, etc)
- ✅ Простой API - чистые функции без состояния

**Результат:**
```typescript
import { addDecimal, divideDecimal, roundToTick } from '@polymarket/math';

const result = divideDecimal(new Decimal(10), new Decimal(2)); // 5
const rounded = roundToTick(new Decimal(10.567), new Decimal(0.01)); // 10.57
```

---

## Мотивация

### Проблема текущего подхода

Математические операции **дублируются** в каждом Value Object:

```typescript
// В Quantity.ts
divide(divisor: number): Result<Quantity, ...> {
  const result = this.value.dividedBy(divisor);
  // проверки overflow, etc
}

// В Price.ts
divide(divisor: number): Result<Price, ...> {
  const result = this.value.dividedBy(divisor);
  // те же проверки!
}

// В Money.ts
divide(divisor: number): Result<Money, ...> {
  const result = this.value.dividedBy(divisor);
  // те же проверки опять!
}
```

**Последствия:**
- ❌ Дублирование кода
- ❌ Нужно обновлять в 7 местах при изменении логики
- ❌ Невозможно тестировать математику отдельно
- ❌ Каждый VO знает про математику

### Решение: Foundation Math Package

```typescript
// packages/foundation/math
export function divideDecimal(a: Decimal, b: Decimal): Decimal {
  if (!b.isFinite()) throw new InvalidDivisorError();
  if (b.isZero()) throw new DivisionByZeroError();
  const result = a.div(b);
  if (!result.isFinite()) throw new ArithmeticOverflowError();
  return result;
}

// Используется везде
// Quantity, Price, Money - все используют одну функцию!
```

**Преимущества:**
- ✅ Одно место для математики
- ✅ Легко тестировать
- ✅ Легко документировать
- ✅ Переиспользуется всеми VO
- ✅ Можно реализовать ПЕРВЫМ (нет зависимостей)

---

## Архитектура Math Package

### Структура пакета

```
packages/foundation/math/
 ├─ src/
 │   ├─ decimal/                    ← Операции над Decimal
 │   │   ├─ add.ts                  - Сложение
 │   │   ├─ subtract.ts             - Вычитание
 │   │   ├─ multiply.ts             - Умножение
 │   │   ├─ divide.ts               - Деление (throw на 0/NaN)
 │   │   ├─ compare.ts              - Сравнения (equals, lessThan, etc)
 │   │   ├─ round.ts                - Округление (round/floor/ceil)
 │   │   └─ index.ts
 │   │
 │   ├─ rounding/                   ← Специализированное округление
 │   │   ├─ roundToTick.ts          - Округление до тика
 │   │   ├─ roundToPrecision.ts     - Округление до точности
 │   │   └─ index.ts
 │   │
 │   ├─ validation/                 ← Проверки Decimal значений
 │   │   ├─ isFinite.ts             - Проверка конечности
 │   │   ├─ isPositive.ts           - Проверка положительности
 │   │   ├─ isNonNegative.ts        - Проверка неотрицательности
 │   │   └─ index.ts
 │   │
 │   ├─ constants.ts                ← Математические константы
 │   └─ index.ts                    ← Главный экспорт
 │
 ├─ __tests__/
 │   ├─ unit/
 │   │   ├─ decimal/
 │   │   │   ├─ add.test.ts
 │   │   │   ├─ subtract.test.ts
 │   │   │   ├─ multiply.test.ts
 │   │   │   ├─ divide.test.ts
 │   │   │   ├─ compare.test.ts
 │   │   │   └─ round.test.ts
 │   │   ├─ rounding/
 │   │   │   ├─ roundToTick.test.ts
 │   │   │   └─ roundToPrecision.test.ts
 │   │   └─ validation/
 │   │       ├─ isFinite.test.ts
 │   │       ├─ isPositive.test.ts
 │   │       └─ isNonNegative.test.ts
 │   │
 │   └─ integration/
 │       └─ operations-chain.test.ts
 │
 ├─ docs/
 │   ├─ README.md                   ← Обзор пакета
 │   ├─ decimal-operations.md       ← Операции над Decimal
 │   ├─ rounding.md                 ← Округление
 │   ├─ error-handling.md           ← Обработка ошибок
 │   └─ examples.md                 ← Примеры использования
 │
 ├─ package.json
 ├─ tsconfig.json
 ├─ tsconfig.build.json
 ├─ jest.config.ts
 ├─ .eslintrc.json
 └─ README.md
```

### Принципы пакета

1. **Чистые функции (Pure Functions)**
   - Нет побочных эффектов
   - Детерминированные (одни входы → один выход)
   - Без состояния

2. **Throw на математические невозможности**
   - Division by zero → `throw DivisionByZeroError`
   - NaN/Infinity результат → `throw ArithmeticOverflowError`
   - Невалидный divisor → `throw InvalidDivisorError`

3. **Никаких бизнес-правил**
   - НЕ проверяем знак делителя (это бизнес-правило)
   - НЕ проверяем минимальные значения (это бизнес-правило)
   - ТОЛЬКО математическая корректность

4. **Полная типобезопасность**
   - Строгие типы TypeScript
   - Экспортируем типы для потребителей

---

## Детальный план реализации

### Фаза 0: Инициализация пакета (30 минут)

#### Шаг 0.1: Создать структуру пакета

```bash
cd /Users/menvil/Projects/polymarket/packages/foundation
mkdir -p math/src/decimal
mkdir -p math/src/rounding
mkdir -p math/src/validation
mkdir -p math/__tests__/unit/decimal
mkdir -p math/__tests__/unit/rounding
mkdir -p math/__tests__/unit/validation
mkdir -p math/__tests__/integration
mkdir -p math/docs
```

#### Шаг 0.2: Создать package.json

**Файл:** `packages/foundation/math/package.json`
```json
{
  "name": "@polymarket/math",
  "version": "1.0.0",
  "description": "Pure mathematical operations for Polymarket domain",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./decimal": {
      "types": "./dist/decimal/index.d.ts",
      "import": "./dist/decimal/index.js"
    },
    "./rounding": {
      "types": "./dist/rounding/index.d.ts",
      "import": "./dist/rounding/index.js"
    },
    "./validation": {
      "types": "./dist/validation/index.d.ts",
      "import": "./dist/validation/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "test": "jest",
    "test:watch": "jest --watch",
    "test:coverage": "jest --coverage",
    "lint": "eslint src --ext .ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "decimal.js": "^10.4.3",
    "@polymarket/errors": "workspace:*"
  },
  "devDependencies": {
    "@types/jest": "^29.5.0",
    "@typescript-eslint/eslint-plugin": "^6.0.0",
    "@typescript-eslint/parser": "^6.0.0",
    "eslint": "^8.40.0",
    "jest": "^29.5.0",
    "ts-jest": "^29.1.0",
    "typescript": "^5.0.0"
  },
  "keywords": [
    "math",
    "decimal",
    "precision",
    "arithmetic",
    "polymarket"
  ],
  "author": "Polymarket",
  "license": "MIT"
}
```

#### Шаг 0.3: Создать конфигурации

**Файл:** `tsconfig.json`
```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "declarationDir": "./dist"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "__tests__"]
}
```

**Файл:** `tsconfig.build.json`
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

**Файл:** `jest.config.ts`
```typescript
import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/index.ts'
  ],
  coverageThreshold: {
    global: {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100
    }
  }
};

export default config;
```

**Файл:** `.eslintrc.json`
```json
{
  "extends": "../../../.eslintrc.base.json",
  "parserOptions": {
    "project": "./tsconfig.json"
  }
}
```

---

### Фаза 1: Decimal Operations (2 часа)

#### Шаг 1.1: Добавить ошибки (если нужны новые)

**Проверить:** `packages/foundation/errors/src/value-objects/`

Уже есть:
- ✅ `DivisionByZeroError`
- ✅ `ArithmeticOverflowError`

Добавить если нужно:
- `InvalidDivisorError` (для non-finite divisor)

**Файл:** `packages/foundation/errors/src/value-objects/InvalidDivisorError.ts`
```typescript
import { ValidationError } from '../base/ValidationError.js';

/**
 * Ошибка: невалидный делитель
 *
 * @remarks
 * Выбрасывается при попытке деления на невалидное значение (NaN, Infinity).
 * Это математическая невозможность, а не бизнес-правило.
 */
export class InvalidDivisorError extends ValidationError {
  constructor(
    message: string | ((ctx: Record<string, unknown>) => string),
    options?: { context?: Record<string, unknown> }
  ) {
    super(
      typeof message === 'function' ? message(options?.context || {}) : message,
      options
    );
    this.name = 'InvalidDivisorError';
  }
}
```

#### Шаг 1.2: Реализовать add

**Файл:** `src/decimal/add.ts`
```typescript
import Decimal from 'decimal.js';
import { ArithmeticOverflowError } from '@polymarket/errors';

/**
 * Складывает два Decimal значения
 *
 * @param a - Первое слагаемое
 * @param b - Второе слагаемое
 * @returns Сумма a + b
 * @throws {ArithmeticOverflowError} Если результат не конечное число
 *
 * @remarks
 * Чистая математическая операция без бизнес-правил.
 * Throw = математическая невозможность (overflow).
 *
 * НЕ проверяет:
 * - Знаки операндов (это бизнес-правило)
 * - Минимальные/максимальные значения (это бизнес-правило)
 *
 * @example
 * ```typescript
 * const result = addDecimal(new Decimal(5), new Decimal(3));
 * console.log(result.toString()); // "8"
 *
 * // Throw на overflow
 * const huge = new Decimal('1e308');
 * addDecimal(huge, huge); // throws ArithmeticOverflowError
 * ```
 */
export function addDecimal(a: Decimal, b: Decimal): Decimal {
  const result = a.plus(b);

  if (!result.isFinite()) {
    throw new ArithmeticOverflowError(
      (ctx) => `Addition overflow: ${ctx.a} + ${ctx.b} = ${ctx.result}`,
      {
        context: {
          a: a.toString(),
          b: b.toString(),
          result: result.toString()
        }
      }
    );
  }

  return result;
}
```

#### Шаг 1.3: Реализовать subtract

**Файл:** `src/decimal/subtract.ts`
```typescript
import Decimal from 'decimal.js';
import { ArithmeticOverflowError } from '@polymarket/errors';

/**
 * Вычитает одно Decimal значение из другого
 *
 * @param a - Уменьшаемое
 * @param b - Вычитаемое
 * @returns Разность a - b
 * @throws {ArithmeticOverflowError} Если результат не конечное число
 *
 * @remarks
 * Чистая математическая операция.
 * НЕ проверяет что результат >= 0 (это бизнес-правило для Quantity).
 * Математически разрешены отрицательные результаты.
 *
 * @example
 * ```typescript
 * subtractDecimal(new Decimal(10), new Decimal(3)); // 7
 * subtractDecimal(new Decimal(3), new Decimal(10)); // -7 (математически валидно!)
 * ```
 */
export function subtractDecimal(a: Decimal, b: Decimal): Decimal {
  const result = a.minus(b);

  if (!result.isFinite()) {
    throw new ArithmeticOverflowError(
      (ctx) => `Subtraction overflow: ${ctx.a} - ${ctx.b} = ${ctx.result}`,
      {
        context: {
          a: a.toString(),
          b: b.toString(),
          result: result.toString()
        }
      }
    );
  }

  return result;
}
```

#### Шаг 1.4: Реализовать multiply

**Файл:** `src/decimal/multiply.ts`
```typescript
import Decimal from 'decimal.js';
import { ArithmeticOverflowError } from '@polymarket/errors';

/**
 * Умножает два Decimal значения
 *
 * @param a - Первый множитель
 * @param b - Второй множитель
 * @returns Произведение a * b
 * @throws {ArithmeticOverflowError} Если результат не конечное число
 *
 * @example
 * ```typescript
 * multiplyDecimal(new Decimal(5), new Decimal(3)); // 15
 * multiplyDecimal(new Decimal(2.5), new Decimal(4)); // 10
 * ```
 */
export function multiplyDecimal(a: Decimal, b: Decimal): Decimal {
  const result = a.times(b);

  if (!result.isFinite()) {
    throw new ArithmeticOverflowError(
      (ctx) => `Multiplication overflow: ${ctx.a} * ${ctx.b} = ${ctx.result}`,
      {
        context: {
          a: a.toString(),
          b: b.toString(),
          result: result.toString()
        }
      }
    );
  }

  return result;
}
```

#### Шаг 1.5: Реализовать divide

**Файл:** `src/decimal/divide.ts`
```typescript
import Decimal from 'decimal.js';
import {
  DivisionByZeroError,
  ArithmeticOverflowError,
  InvalidDivisorError
} from '@polymarket/errors';

/**
 * Делит одно Decimal значение на другое
 *
 * @param dividend - Делимое
 * @param divisor - Делитель
 * @returns Частное dividend / divisor
 * @throws {InvalidDivisorError} Если делитель не конечное число (NaN/Infinity)
 * @throws {DivisionByZeroError} Если делитель равен нулю
 * @throws {ArithmeticOverflowError} Если результат не конечное число
 *
 * @remarks
 * Чистая математическая операция.
 *
 * Проверяет только математическую корректность:
 * - divisor должен быть finite (не NaN, не Infinity)
 * - divisor не должен быть нулём
 * - result должен быть finite
 *
 * НЕ проверяет:
 * - Знак делителя (математически можно делить на отрицательное)
 * - Минимальные значения
 *
 * Это бизнес-правила - они проверяются в Rules/Policy слоях.
 *
 * @example
 * ```typescript
 * // Нормальное деление
 * divideDecimal(new Decimal(10), new Decimal(2)); // 5
 * divideDecimal(new Decimal(10), new Decimal(3)); // 3.333...
 *
 * // Отрицательное деление (математически валидно!)
 * divideDecimal(new Decimal(10), new Decimal(-2)); // -5
 *
 * // Throw на невалидный делитель
 * divideDecimal(new Decimal(10), new Decimal(NaN)); // throws InvalidDivisorError
 * divideDecimal(new Decimal(10), new Decimal(Infinity)); // throws InvalidDivisorError
 *
 * // Throw на деление на ноль
 * divideDecimal(new Decimal(10), new Decimal(0)); // throws DivisionByZeroError
 *
 * // Throw на overflow
 * const huge = new Decimal('1e308');
 * const tiny = new Decimal('1e-308');
 * divideDecimal(huge, tiny); // throws ArithmeticOverflowError
 * ```
 */
export function divideDecimal(dividend: Decimal, divisor: Decimal): Decimal {
  // Проверка 1: Делитель должен быть конечным числом
  if (!divisor.isFinite()) {
    throw new InvalidDivisorError(
      (ctx) => `Divisor must be finite, got ${ctx.divisor}`,
      {
        context: {
          divisor: divisor.toString(),
          dividend: dividend.toString()
        }
      }
    );
  }

  // Проверка 2: Делитель не должен быть нулём
  if (divisor.isZero()) {
    throw new DivisionByZeroError(
      () => 'Cannot divide by zero',
      {
        context: {
          dividend: dividend.toString(),
          divisor: divisor.toString()
        }
      }
    );
  }

  // Выполняем деление
  const result = dividend.div(divisor);

  // Проверка 3: Результат должен быть конечным
  if (!result.isFinite()) {
    throw new ArithmeticOverflowError(
      (ctx) => `Division overflow: ${ctx.dividend} / ${ctx.divisor} = ${ctx.result}`,
      {
        context: {
          dividend: dividend.toString(),
          divisor: divisor.toString(),
          result: result.toString()
        }
      }
    );
  }

  return result;
}
```

#### Шаг 1.6: Реализовать compare

**Файл:** `src/decimal/compare.ts`
```typescript
import Decimal from 'decimal.js';

/**
 * Сравнивает два Decimal на равенство с точностью epsilon
 *
 * @param a - Первое значение
 * @param b - Второе значение
 * @param epsilon - Точность сравнения (default: 1e-10)
 * @returns True если |a - b| < epsilon
 *
 * @example
 * ```typescript
 * equalsDecimal(new Decimal(10), new Decimal(10)); // true
 * equalsDecimal(new Decimal(10.00001), new Decimal(10)); // true (в пределах epsilon)
 * equalsDecimal(new Decimal(10), new Decimal(11)); // false
 * ```
 */
export function equalsDecimal(
  a: Decimal,
  b: Decimal,
  epsilon: Decimal = new Decimal(1e-10)
): boolean {
  return a.minus(b).abs().lessThan(epsilon);
}

/**
 * Проверяет a < b
 */
export function lessThanDecimal(a: Decimal, b: Decimal): boolean {
  return a.lessThan(b);
}

/**
 * Проверяет a <= b
 */
export function lessThanOrEqualDecimal(a: Decimal, b: Decimal): boolean {
  return a.lessThanOrEqualTo(b);
}

/**
 * Проверяет a > b
 */
export function greaterThanDecimal(a: Decimal, b: Decimal): boolean {
  return a.greaterThan(b);
}

/**
 * Проверяет a >= b
 */
export function greaterThanOrEqualDecimal(a: Decimal, b: Decimal): boolean {
  return a.greaterThanOrEqualTo(b);
}

/**
 * Сравнивает два Decimal
 *
 * @returns -1 если a < b, 0 если a == b, 1 если a > b
 */
export function compareDecimal(a: Decimal, b: Decimal): -1 | 0 | 1 {
  if (a.lessThan(b)) return -1;
  if (a.greaterThan(b)) return 1;
  return 0;
}
```

#### Шаг 1.7: Реализовать round

**Файл:** `src/decimal/round.ts`
```typescript
import Decimal from 'decimal.js';

/**
 * Округляет Decimal к ближайшему целому
 *
 * @param value - Значение для округления
 * @returns Округлённое значение
 *
 * @example
 * ```typescript
 * roundDecimal(new Decimal(10.5)); // 11
 * roundDecimal(new Decimal(10.4)); // 10
 * roundDecimal(new Decimal(-10.5)); // -11
 * ```
 */
export function roundDecimal(value: Decimal): Decimal {
  return value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
}

/**
 * Округляет вниз к ближайшему целому
 */
export function floorDecimal(value: Decimal): Decimal {
  return value.toDecimalPlaces(0, Decimal.ROUND_DOWN);
}

/**
 * Округляет вверх к ближайшему целому
 */
export function ceilDecimal(value: Decimal): Decimal {
  return value.toDecimalPlaces(0, Decimal.ROUND_UP);
}

/**
 * Усекает до целого (отбрасывает дробную часть)
 */
export function truncDecimal(value: Decimal): Decimal {
  return value.trunc();
}
```

#### Шаг 1.8: Создать index

**Файл:** `src/decimal/index.ts`
```typescript
export { addDecimal } from './add.js';
export { subtractDecimal } from './subtract.js';
export { multiplyDecimal } from './multiply.js';
export { divideDecimal } from './divide.js';
export {
  equalsDecimal,
  lessThanDecimal,
  lessThanOrEqualDecimal,
  greaterThanDecimal,
  greaterThanOrEqualDecimal,
  compareDecimal
} from './compare.js';
export {
  roundDecimal,
  floorDecimal,
  ceilDecimal,
  truncDecimal
} from './round.js';
```

---

### Фаза 2: Rounding Operations (1 час)

#### Шаг 2.1: Реализовать roundToTick

**Файл:** `src/rounding/roundToTick.ts`
```typescript
import Decimal from 'decimal.js';
import { InvalidTickSizeError } from '@polymarket/errors';

/**
 * Тип функции округления
 */
export type RoundFunction = (x: number) => number;

/**
 * Округляет значение до размера тика
 *
 * @param value - Значение для округления
 * @param tickSize - Размер тика (например, 0.01 для центов)
 * @param roundFn - Функция округления (Math.round/floor/ceil)
 * @returns Округлённое значение
 * @throws {InvalidTickSizeError} Если tickSize невалидный (<= 0 или не finite)
 *
 * @remarks
 * Алгоритм:
 * 1. value / tickSize (получаем количество тиков)
 * 2. roundFn(количество тиков) (округляем до целого числа тиков)
 * 3. * tickSize (умножаем обратно)
 *
 * @example
 * ```typescript
 * // Округление до 0.01 (центы)
 * roundToTick(new Decimal(10.567), new Decimal(0.01)); // 10.57
 * roundToTick(new Decimal(10.564), new Decimal(0.01)); // 10.56
 *
 * // Округление до 0.1
 * roundToTick(new Decimal(10.567), new Decimal(0.1)); // 10.6
 *
 * // Округление вниз
 * roundToTick(new Decimal(10.567), new Decimal(0.01), Math.floor); // 10.56
 *
 * // Округление вверх
 * roundToTick(new Decimal(10.561), new Decimal(0.01), Math.ceil); // 10.57
 * ```
 */
export function roundToTick(
  value: Decimal,
  tickSize: Decimal,
  roundFn: RoundFunction = Math.round
): Decimal {
  // Валидация tickSize
  if (!tickSize.isFinite() || tickSize.lessThanOrEqualTo(0)) {
    throw new InvalidTickSizeError(
      (ctx) => `Tick size must be finite and positive, got ${ctx.tickSize}`,
      {
        context: {
          tickSize: tickSize.toString(),
          value: value.toString()
        }
      }
    );
  }

  // Алгоритм округления до тика
  const divided = value.dividedBy(tickSize).toNumber();
  const rounded = roundFn(divided);
  const result = new Decimal(rounded).times(tickSize);

  return result;
}

/**
 * Округляет вниз до тика
 */
export function floorToTick(value: Decimal, tickSize: Decimal): Decimal {
  return roundToTick(value, tickSize, Math.floor);
}

/**
 * Округляет вверх до тика
 */
export function ceilToTick(value: Decimal, tickSize: Decimal): Decimal {
  return roundToTick(value, tickSize, Math.ceil);
}
```

**Добавить ошибку если нет:**

**Файл:** `packages/foundation/errors/src/value-objects/InvalidTickSizeError.ts`
```typescript
import { ValidationError } from '../base/ValidationError.js';

export class InvalidTickSizeError extends ValidationError {
  constructor(
    message: string | ((ctx: Record<string, unknown>) => string),
    options?: { context?: Record<string, unknown> }
  ) {
    super(
      typeof message === 'function' ? message(options?.context || {}) : message,
      options
    );
    this.name = 'InvalidTickSizeError';
  }
}
```

#### Шаг 2.2: Реализовать roundToPrecision

**Файл:** `src/rounding/roundToPrecision.ts`
```typescript
import Decimal from 'decimal.js';

/**
 * Округляет до указанного количества десятичных знаков
 *
 * @param value - Значение для округления
 * @param decimalPlaces - Количество десятичных знаков
 * @param roundFn - Тип округления (default: ROUND_HALF_UP)
 * @returns Округлённое значение
 *
 * @example
 * ```typescript
 * roundToPrecision(new Decimal(10.567), 2); // 10.57
 * roundToPrecision(new Decimal(10.564), 2); // 10.56
 * roundToPrecision(new Decimal(10.567), 1); // 10.6
 * ```
 */
export function roundToPrecision(
  value: Decimal,
  decimalPlaces: number,
  roundingMode: Decimal.Rounding = Decimal.ROUND_HALF_UP
): Decimal {
  return value.toDecimalPlaces(decimalPlaces, roundingMode);
}
```

#### Шаг 2.3: Создать index

**Файл:** `src/rounding/index.ts`
```typescript
export {
  roundToTick,
  floorToTick,
  ceilToTick,
  type RoundFunction
} from './roundToTick.js';
export { roundToPrecision } from './roundToPrecision.js';
```

---

### Фаза 3: Validation Utilities (30 минут)

#### Шаг 3.1: Реализовать проверки

**Файл:** `src/validation/isFinite.ts`
```typescript
import Decimal from 'decimal.js';

/**
 * Проверяет что Decimal значение конечное (не NaN, не Infinity)
 */
export function isFiniteDecimal(value: Decimal): boolean {
  return value.isFinite();
}
```

**Файл:** `src/validation/isPositive.ts`
```typescript
import Decimal from 'decimal.js';

/**
 * Проверяет что Decimal значение строго положительное (> 0)
 */
export function isPositiveDecimal(value: Decimal): boolean {
  return value.greaterThan(0);
}
```

**Файл:** `src/validation/isNonNegative.ts`
```typescript
import Decimal from 'decimal.js';

/**
 * Проверяет что Decimal значение неотрицательное (>= 0)
 */
export function isNonNegativeDecimal(value: Decimal): boolean {
  return value.greaterThanOrEqualTo(0);
}
```

**Файл:** `src/validation/isZero.ts`
```typescript
import Decimal from 'decimal.js';

/**
 * Проверяет что Decimal значение равно нулю
 *
 * @param epsilon - Точность сравнения (default: 1e-10)
 */
export function isZeroDecimal(value: Decimal, epsilon: Decimal = new Decimal(1e-10)): boolean {
  return value.abs().lessThan(epsilon);
}
```

**Файл:** `src/validation/index.ts`
```typescript
export { isFiniteDecimal } from './isFinite.js';
export { isPositiveDecimal } from './isPositive.js';
export { isNonNegativeDecimal } from './isNonNegative.js';
export { isZeroDecimal } from './isZero.js';
```

---

### Фаза 4: Constants и Main Export (15 минут)

#### Шаг 4.1: Создать константы

**Файл:** `src/constants.ts`
```typescript
import Decimal from 'decimal.js';

/**
 * Математические константы
 */
export const MATH_CONSTANTS = {
  /** Ноль */
  ZERO: new Decimal(0),

  /** Единица */
  ONE: new Decimal(1),

  /** Десять */
  TEN: new Decimal(10),

  /** Сто */
  HUNDRED: new Decimal(100),

  /** Точность по умолчанию для сравнений */
  DEFAULT_EPSILON: new Decimal(1e-10),

  /** Минимальный тик по умолчанию (1 цент) */
  DEFAULT_TICK: new Decimal(0.01)
} as const;
```

#### Шаг 4.2: Создать главный index

**Файл:** `src/index.ts`
```typescript
// Decimal operations
export * from './decimal/index.js';

// Rounding
export * from './rounding/index.js';

// Validation
export * from './validation/index.js';

// Constants
export { MATH_CONSTANTS } from './constants.js';

// Re-export Decimal type for convenience
export type { Decimal } from 'decimal.js';
```

---

## План тестирования

### Unit Tests (100% покрытие)

#### Тесты для decimal operations

**Файл:** `__tests__/unit/decimal/add.test.ts`
```typescript
import { describe, it, expect } from '@jest/globals';
import { addDecimal } from '../../../src/decimal/add.js';
import { ArithmeticOverflowError } from '@polymarket/errors';
import Decimal from 'decimal.js';

describe('addDecimal', () => {
  it('должен складывать положительные числа', () => {
    const result = addDecimal(new Decimal(5), new Decimal(3));
    expect(result.toString()).toBe('8');
  });

  it('должен складывать отрицательные числа', () => {
    const result = addDecimal(new Decimal(-5), new Decimal(-3));
    expect(result.toString()).toBe('-8');
  });

  it('должен складывать положительное и отрицательное', () => {
    const result = addDecimal(new Decimal(10), new Decimal(-3));
    expect(result.toString()).toBe('7');
  });

  it('должен складывать дробные числа', () => {
    const result = addDecimal(new Decimal(1.5), new Decimal(2.3));
    expect(result.toNumber()).toBeCloseTo(3.8, 10);
  });

  it('должен throw на overflow', () => {
    const huge = new Decimal('1e308');
    expect(() => addDecimal(huge, huge)).toThrow(ArithmeticOverflowError);
  });

  it('должен работать с нулём', () => {
    const result = addDecimal(new Decimal(5), new Decimal(0));
    expect(result.toString()).toBe('5');
  });

  it('должен быть коммутативным (a+b = b+a)', () => {
    const a = new Decimal(5);
    const b = new Decimal(3);
    expect(addDecimal(a, b).toString()).toBe(addDecimal(b, a).toString());
  });
});
```

**Аналогично для:** subtract, multiply, divide, compare, round

**Всего тестов для decimal:** ~60 тестов

#### Тесты для rounding

**Файл:** `__tests__/unit/rounding/roundToTick.test.ts`
```typescript
import { describe, it, expect } from '@jest/globals';
import { roundToTick, floorToTick, ceilToTick } from '../../../src/rounding/roundToTick.js';
import { InvalidTickSizeError } from '@polymarket/errors';
import Decimal from 'decimal.js';

describe('roundToTick', () => {
  describe('roundToTick (Math.round)', () => {
    it('должен округлять до 0.01', () => {
      const result = roundToTick(new Decimal(10.567), new Decimal(0.01));
      expect(result.toString()).toBe('10.57');
    });

    it('должен округлять до 0.1', () => {
      const result = roundToTick(new Decimal(10.567), new Decimal(0.1));
      expect(result.toString()).toBe('10.6');
    });

    it('должен округлять вниз когда .xx4', () => {
      const result = roundToTick(new Decimal(10.564), new Decimal(0.01));
      expect(result.toString()).toBe('10.56');
    });

    it('должен округлять вверх когда .xx5', () => {
      const result = roundToTick(new Decimal(10.565), new Decimal(0.01));
      expect(result.toString()).toBe('10.57');
    });

    it('должен throw на tickSize <= 0', () => {
      expect(() => roundToTick(new Decimal(10), new Decimal(0)))
        .toThrow(InvalidTickSizeError);
      expect(() => roundToTick(new Decimal(10), new Decimal(-0.01)))
        .toThrow(InvalidTickSizeError);
    });

    it('должен throw на tickSize = NaN', () => {
      expect(() => roundToTick(new Decimal(10), new Decimal(NaN)))
        .toThrow(InvalidTickSizeError);
    });
  });

  describe('floorToTick', () => {
    it('должен округлять вниз', () => {
      const result = floorToTick(new Decimal(10.567), new Decimal(0.01));
      expect(result.toString()).toBe('10.56');
    });
  });

  describe('ceilToTick', () => {
    it('должен округлять вверх', () => {
      const result = ceilToTick(new Decimal(10.561), new Decimal(0.01));
      expect(result.toString()).toBe('10.57');
    });
  });
});
```

**Всего тестов для rounding:** ~20 тестов

#### Тесты для validation

**Файл:** `__tests__/unit/validation/isFinite.test.ts`
```typescript
import { describe, it, expect } from '@jest/globals';
import { isFiniteDecimal } from '../../../src/validation/isFinite.js';
import Decimal from 'decimal.js';

describe('isFiniteDecimal', () => {
  it('должен возвращать true для конечных чисел', () => {
    expect(isFiniteDecimal(new Decimal(10))).toBe(true);
    expect(isFiniteDecimal(new Decimal(-10))).toBe(true);
    expect(isFiniteDecimal(new Decimal(0))).toBe(true);
    expect(isFiniteDecimal(new Decimal(1.5))).toBe(true);
  });

  it('должен возвращать false для NaN', () => {
    expect(isFiniteDecimal(new Decimal(NaN))).toBe(false);
  });

  it('должен возвращать false для Infinity', () => {
    expect(isFiniteDecimal(new Decimal(Infinity))).toBe(false);
    expect(isFiniteDecimal(new Decimal(-Infinity))).toBe(false);
  });
});
```

**Всего тестов для validation:** ~15 тестов

### Integration Tests

**Файл:** `__tests__/integration/operations-chain.test.ts`
```typescript
import { describe, it, expect } from '@jest/globals';
import {
  addDecimal,
  subtractDecimal,
  multiplyDecimal,
  divideDecimal,
  roundToTick
} from '../../src/index.js';
import Decimal from 'decimal.js';

describe('Operations Chain Integration', () => {
  it('должен правильно выполнять цепочку операций', () => {
    // (10 + 5) * 2 / 3, округлить до 0.01
    const step1 = addDecimal(new Decimal(10), new Decimal(5)); // 15
    const step2 = multiplyDecimal(step1, new Decimal(2)); // 30
    const step3 = divideDecimal(step2, new Decimal(3)); // 10
    const result = roundToTick(step3, new Decimal(0.01)); // 10.00

    expect(result.toString()).toBe('10');
  });

  it('должен корректно обрабатывать сложные вычисления', () => {
    // Вычисление средней цены: (price1 * qty1 + price2 * qty2) / (qty1 + qty2)
    const price1 = new Decimal(100);
    const qty1 = new Decimal(10);
    const price2 = new Decimal(120);
    const qty2 = new Decimal(15);

    const cost1 = multiplyDecimal(price1, qty1); // 1000
    const cost2 = multiplyDecimal(price2, qty2); // 1800
    const totalCost = addDecimal(cost1, cost2); // 2800
    const totalQty = addDecimal(qty1, qty2); // 25
    const avgPrice = divideDecimal(totalCost, totalQty); // 112

    expect(avgPrice.toString()).toBe('112');
  });
});
```

**Всего тестов:** ~10 интеграционных

**Суммарно:** ~105 тестов, 100% покрытие

---

## План документации

### Структура документации

```
docs/
 ├─ README.md                     ← Обзор пакета
 ├─ decimal-operations.md         ← Операции над Decimal
 ├─ rounding.md                   ← Округление
 ├─ validation.md                 ← Проверки
 ├─ error-handling.md             ← Обработка ошибок
 └─ examples.md                   ← Примеры использования
```

### README.md

```markdown
# @polymarket/math

Чистые математические операции над Decimal для Polymarket domain.

## Установка

\`\`\`bash
npm install @polymarket/math
\`\`\`

## Быстрый старт

\`\`\`typescript
import { addDecimal, divideDecimal, roundToTick } from '@polymarket/math';
import Decimal from 'decimal.js';

// Сложение
const sum = addDecimal(new Decimal(5), new Decimal(3)); // 8

// Деление
const result = divideDecimal(new Decimal(10), new Decimal(2)); // 5

// Округление до тика
const rounded = roundToTick(new Decimal(10.567), new Decimal(0.01)); // 10.57
\`\`\`

## Особенности

- ✅ Чистые функции без побочных эффектов
- ✅ Throw только на математические невозможности
- ✅ Никаких бизнес-правил
- ✅ 100% покрытие тестами
- ✅ Полная типобезопасность

## API

### Decimal Operations
- \`addDecimal(a, b)\` - Сложение
- \`subtractDecimal(a, b)\` - Вычитание
- \`multiplyDecimal(a, b)\` - Умножение
- \`divideDecimal(a, b)\` - Деление

### Rounding
- \`roundToTick(value, tickSize)\` - Округление до тика
- \`roundToPrecision(value, decimals)\` - Округление до знаков

### Validation
- \`isFiniteDecimal(value)\` - Проверка конечности
- \`isPositiveDecimal(value)\` - Проверка положительности

## Документация

- [Decimal Operations](./docs/decimal-operations.md)
- [Rounding](./docs/rounding.md)
- [Error Handling](./docs/error-handling.md)
- [Examples](./docs/examples.md)
```

### decimal-operations.md

Детальное описание всех операций с примерами и edge cases.

### rounding.md

Алгоритмы округления, примеры для разных tickSize.

### error-handling.md

```markdown
# Error Handling

## Философия

Math package бросает исключения только на **математические невозможности**.

### Что бросает throw

- **DivisionByZeroError** - деление на ноль
- **ArithmeticOverflowError** - результат Infinity/NaN
- **InvalidDivisorError** - делитель NaN/Infinity
- **InvalidTickSizeError** - tickSize <= 0 или NaN

### Что НЕ бросает throw

- Отрицательный результат (математически валидно)
- Отрицательный делитель (математически валидно)
- Большие/маленькие значения (это бизнес-правило)

Бизнес-правила проверяются в Rules/Policy слоях.

## Где ловить исключения

**НЕ ловить** в domain коде:

\`\`\`typescript
// ❌ НЕ делать так
try {
  const result = divideDecimal(a, b);
} catch (e) {
  // обработка...
}
\`\`\`

Если math функция бросает - это БАГ (передали невалидные данные).

**Ловить** только на границах системы (HTTP/CLI/Worker).
```

---

## Критерии завершения

### Must Have (Обязательно)

- ✅ Все операции decimal реализованы и работают
- ✅ Все операции rounding реализованы
- ✅ Все validation функции реализованы
- ✅ 100% покрытие тестами (branches, lines, functions, statements)
- ✅ Все тесты проходят
- ✅ ESLint без ошибок
- ✅ TypeScript компилируется без ошибок
- ✅ README.md написан
- ✅ Документация по операциям написана
- ✅ package.json корректно настроен
- ✅ Exports работают (`import from '@polymarket/math'`)

### Should Have (Желательно)

- ✅ Примеры использования документированы
- ✅ Error handling гайд написан
- ✅ TSDoc комментарии для всех public функций
- ✅ Benchmarks для операций (опционально)

### Could Have (Можно позже)

- Performance оптимизации
- Дополнительные математические функции (abs, pow, sqrt, etc)
- Support для BigInt

---

## Timeline

| День | Задача | Время |
|------|--------|-------|
| 1 | Фаза 0-1: Инициализация + Decimal Ops | 3 часа |
| 2 | Фаза 2-3: Rounding + Validation | 2 часа |
| 3 | Фаза 4 + Тесты | 3 часа |
| 4 | Документация | 2 часа |

**Итого:** ~10 часов чистого времени (2 недели calendar time)

---

## Команды для выполнения

```bash
# Создать структуру
cd packages/foundation
mkdir math
cd math
# ... создать все директории

# Установить зависимости
npm install

# Разработка
npm run test:watch

# Проверки
npm run typecheck
npm run lint
npm test

# Сборка
npm run build

# Проверить exports
node -e "import('@polymarket/math').then(m => console.log(Object.keys(m)))"
```

---

## Следующие шаги после завершения

После того как Math package готов:

1. ✅ Используется в рефакторинге Quantity (импорт из `@polymarket/math`)
2. ✅ Используется в рефакторинге Price
3. ✅ Используется в рефакторинге Money
4. ✅ Используется во всех numeric Value Objects

**Никакого дублирования математики!**

---

**Конец плана Math package**

Этот план можно выполнить полностью независимо от рефакторинга value-objects.
