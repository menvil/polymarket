# Quantity Value Object: План рефакторинга и имплементации

## Метаданные

- **Value Object:** Quantity
- **Текущий файл:** `packages/domain/value-objects/src/Quantity.ts` (659 lines)
- **Сложность:** High (базовый VO, используется везде)
- **Зависимости:** `@polymarket/math`, `@polymarket/errors`, `@polymarket/result`
- **Приоритет:** 🔴 ВЫСОКИЙ (базовый unit для всей системы)

---

## Оглавление

1. [Специфика Quantity](#специфика-quantity)
2. [Целевая архитектура](#целевая-архитектура)
3. [Детальный план по фазам](#детальный-план-по-фазам)
4. [План тестирования](#план-тестирования)
5. [План документации](#план-документации)
6. [Миграция](#миграция)

---

## Специфика Quantity

### Характеристики

**Назначение:** Представляет количество акций/токенов на рынках предсказаний.

**Диапазон:** `>= 0` (non-negative)

**MIN_SIZE:** `1` (минимум Polymarket - 1 акция)
- По умолчанию = 1
- Может переопределяться для конкретных рынков (orderMinSize)

**DEFAULT_TICK:** `0.01` (для округления)

**Константы:**
```typescript
Quantity.ZERO = 0
Quantity.ONE = 1
```

### Текущие операции

1. **Создание:**
   - `fromValue(value, minSize?)` - с проверкой minSize
   - `fromNumber(n)` - без проверки minSize
   - `unsafeFromNumber(n)` - для внутренних операций

2. **Математика:**
   - `add(other)` - сложение
   - `subtract(other)` - вычитание (может стать отрицательным!)
   - `multiply(factor)` - умножение
   - `divide(divisor)` - деление

3. **Округление:**
   - `toTick(tickSize)` - округление до тика
   - `floor()`, `ceil()`, `round()` - округление

4. **Сравнение:**
   - `equals(other)` - равенство
   - `lessThan(other)`, `greaterThan(other)` - сравнения
   - `isZero()` - проверка на ноль
   - `isPositive()` - проверка положительности

5. **Сериализация:**
   - `toJSON()` - { value: number }
   - `toString()` - string representation

### Инварианты

**Всегда должно быть true:**
1. ✅ `quantity >= 0` (non-negative)
2. ✅ `isFinite(quantity)`
3. ✅ `!isNaN(quantity)`

### Бизнес-правила (контекстуальные)

**Зависят от контекста:**
1. 🔶 `quantity >= minSize` (для ордеров)
2. 🔶 `divisor > 0` (для деления)
3. 🔶 `result >= 0` (для subtract - зависит от use case)
4. 🔶 Округление до конкретного tickSize

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
 │   ├─ ValidateMinSize.ts          ← Правило: qty >= minSize
 │   ├─ ValidateNonNegative.ts      ← Правило: qty >= 0
 │   ├─ ValidatePositiveDivisor.ts  ← Правило: divisor > 0
 │   └─ index.ts
 │
 ├─ policy/
 │   ├─ OrderQuantityPolicy.ts      ← Политика для ордеров
 │   ├─ PositionQuantityPolicy.ts   ← Политика для позиций
 │   └─ index.ts
 │
 ├─ facade/
 │   ├─ QuantityService.ts          ← Главный фасад
 │   └─ index.ts
 │
 ├─ adapters/
 │   ├─ QuantitySerializer.ts       ← JSON сериализация
 │   ├─ QuantityFormatter.ts        ← String formatting
 │   └─ index.ts
 │
 └─ index.ts                        ← Главный экспорт
```

### Слои и ответственность

#### **Core Layer** (`core/Quantity.ts`)

**Ответственность:** Только инварианты существования.

```typescript
import Decimal from 'decimal.js';

/**
 * QuantityInvariantViolation - нарушение инварианта Quantity
 */
export class QuantityInvariantViolation extends Error {
  constructor(message: string) {
    super(`Quantity invariant violation: ${message}`);
    this.name = 'QuantityInvariantViolation';
  }
}

/**
 * Core Quantity Value Object
 *
 * @remarks
 * Содержит ТОЛЬКО инварианты существования:
 * - Non-negative (>= 0)
 * - Finite value
 * - Equality comparison
 *
 * НЕ содержит:
 * - Математику (используй @polymarket/math)
 * - Бизнес-правила minSize (используй Rules)
 * - Округление (используй Math)
 * - Сериализацию (используй Adapters)
 */
export class Quantity {
  private constructor(private readonly v: Decimal) {
    // Инвариант 1: Must be finite
    if (!v.isFinite()) {
      throw new QuantityInvariantViolation('must be finite');
    }

    // Инвариант 2: Cannot be negative
    if (v.isNegative()) {
      throw new QuantityInvariantViolation('cannot be negative');
    }
  }

  /**
   * Создаёт Quantity из Decimal/number/string
   *
   * @remarks
   * Без проверки minSize - это бизнес-правило.
   * Для проверки minSize используй QuantityService.createForOrder()
   */
  public static of(value: number | string | Decimal): Quantity {
    // Оптимизация: если уже Decimal, не пересоздаём
    const decimal = value instanceof Decimal ? value : new Decimal(value);
    return new Quantity(decimal);
  }

  /**
   * Константы
   */
  public static readonly ZERO = new Quantity(new Decimal(0));
  public static readonly ONE = new Quantity(new Decimal(1));

  /**
   * Возвращает Decimal значение
   */
  public value(): Decimal {
    return this.v;
  }

  /**
   * Возвращает number значение
   */
  public toNumber(): number {
    return this.v.toNumber();
  }

  /**
   * Проверяет равенство с другим количеством
   */
  public equals(other: Quantity, epsilon: Decimal = new Decimal(0.0001)): boolean {
    return this.v.minus(other.v).abs().lessThan(epsilon);
  }

  /**
   * Проверяет что количество равно нулю
   */
  public isZero(epsilon: Decimal = new Decimal(0.0001)): boolean {
    return this.v.abs().lessThan(epsilon);
  }

  /**
   * Проверяет что количество положительное (> 0)
   */
  public isPositive(): boolean {
    return this.v.greaterThan(0);
  }
}
```

**Что можно:**
- Проверка инвариантов
- Equality comparison
- Геттеры для Decimal/number

**Что нельзя:**
- Математику (используй `@polymarket/math`)
- Бизнес-правила (используй Rules)
- Сериализацию (используй Adapters)

---

#### **Math Layer** (из `@polymarket/math`)

**Используем готовые функции:**

```typescript
import {
  addDecimal,
  subtractDecimal,
  multiplyDecimal,
  divideDecimal,
  roundToTick
} from '@polymarket/math';
```

**Примеры:**
```typescript
// Сложение
const sum = addDecimal(qty1.value(), qty2.value());

// Вычитание (может стать отрицательным!)
const diff = subtractDecimal(qty1.value(), qty2.value());

// Умножение
const multiplied = multiplyDecimal(qty.value(), new Decimal(2));

// Деление
const divided = divideDecimal(qty.value(), new Decimal(2));

// Округление до тика
const rounded = roundToTick(qty.value(), new Decimal(0.01));
```

---

#### **Rules Layer**

**Файл:** `rules/ValidateMinSize.ts`

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidQuantityError } from '@polymarket/errors';
import Decimal from 'decimal.js';

/**
 * Правило: Quantity должен быть >= minSize
 *
 * @remarks
 * Атомарное бизнес-правило.
 * Проверяет что количество >= минимального размера для рынка.
 *
 * Это контекстуальное правило:
 * - Для ордеров: minSize обычно >= 1
 * - Для позиций: может быть меньше (лоты могут частично закрываться)
 * - Для вычислений: может не применяться
 *
 * @example
 * ```typescript
 * const result = ValidateMinSize.check(
 *   new Decimal(0.5),
 *   new Decimal(1)
 * );
 * if (!result.ok) {
 *   console.error(result.error); // InvalidQuantityError
 * }
 * ```
 */
export class ValidateMinSize {
  public static check(
    quantity: Decimal,
    minSize: Decimal
  ): Result<void, InvalidQuantityError> {
    if (quantity.lessThan(minSize)) {
      return Err(
        new InvalidQuantityError(
          (ctx) => `Quantity ${ctx.quantity} is less than minimum size ${ctx.minSize}`,
          {
            code: InvalidQuantityError.code,
            context: {
              quantity: quantity.toString(),
              minSize: minSize.toString()
            }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
```

**Файл:** `rules/ValidateNonNegative.ts`

```typescript
/**
 * Правило: Результат операции должен быть неотрицательным
 *
 * @remarks
 * Используется когда результат операции (subtract) не должен быть отрицательным.
 * Отличается от Core инварианта:
 * - Core: объект НЕ МОЖЕТ существовать с negative
 * - Rule: операция НЕ ДОЛЖНА давать negative результат в этом контексте
 */
export class ValidateNonNegativeResult {
  public static check(result: Decimal): Result<void, InvalidQuantityError> {
    if (result.isNegative()) {
      return Err(
        new InvalidQuantityError(
          (ctx) => `Operation result ${ctx.result} cannot be negative`,
          {
            code: InvalidQuantityError.code,
            context: { result: result.toString() }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
```

**Файл:** `rules/ValidatePositiveDivisor.ts`

```typescript
/**
 * Правило: Делитель должен быть положительным
 *
 * @remarks
 * Бизнес-правило для деления quantity.
 * Математически можно делить на отрицательное,
 * но в бизнес-логике это обычно ошибка.
 */
export class ValidatePositiveDivisor {
  public static check(divisor: Decimal): Result<void, InvalidQuantityError> {
    if (divisor.lessThanOrEqualTo(0)) {
      return Err(
        new InvalidQuantityError(
          (ctx) => `Divisor must be positive, got ${ctx.divisor}`,
          {
            code: InvalidQuantityError.code,
            context: { divisor: divisor.toString() }
          }
        )
      );
    }

    if (!divisor.isFinite()) {
      return Err(
        new InvalidQuantityError(
          (ctx) => `Divisor must be finite, got ${ctx.divisor}`,
          {
            code: InvalidQuantityError.code,
            context: { divisor: divisor.toString() }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
```

---

#### **Policy Layer**

**Файл:** `policy/OrderQuantityPolicy.ts`

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidQuantityError } from '@polymarket/errors';
import { ValidateMinSize } from '../rules/ValidateMinSize.js';
import Decimal from 'decimal.js';

/**
 * Политика для количеств в ордерах
 *
 * @remarks
 * Комбинирует правила для создания/обновления ордеров.
 */
export class OrderQuantityPolicy {
  /**
   * Валидирует quantity для размещения ордера
   *
   * @param quantity - Количество
   * @param orderMinSize - Минимальный размер ордера для рынка
   * @returns Result<void, Error>
   */
  public static validateForOrder(
    quantity: Decimal,
    orderMinSize: Decimal
  ): Result<void, InvalidQuantityError> {
    // 1. Проверяем minSize
    const minSizeResult = ValidateMinSize.check(quantity, orderMinSize);
    if (!minSizeResult.ok) {
      return minSizeResult;
    }

    // 2. Дополнительные проверки для ордеров
    // (например, проверка максимального размера, если нужно)

    return Ok(undefined);
  }

  /**
   * Валидирует изменение количества в ордере
   */
  public static validateUpdate(
    currentQuantity: Decimal,
    newQuantity: Decimal,
    orderMinSize: Decimal
  ): Result<void, InvalidQuantityError> {
    // Новое количество должно удовлетворять minSize
    return this.validateForOrder(newQuantity, orderMinSize);
  }
}
```

**Файл:** `policy/PositionQuantityPolicy.ts`

```typescript
/**
 * Политика для количеств в позициях
 *
 * @remarks
 * Позиции могут иметь дробные количества (лоты частично закрываются).
 * Правила мягче чем для ордеров.
 */
export class PositionQuantityPolicy {
  /**
   * Валидирует quantity для добавления в позицию
   */
  public static validateForPosition(
    quantity: Decimal
  ): Result<void, InvalidQuantityError> {
    // Для позиций достаточно быть > 0
    // (может быть < orderMinSize после частичного закрытия)
    if (!quantity.isPositive()) {
      return Err(
        new InvalidQuantityError(
          (ctx) => `Position quantity must be positive, got ${ctx.quantity}`,
          {
            code: InvalidQuantityError.code,
            context: { quantity: quantity.toString() }
          }
        )
      );
    }

    return Ok(undefined);
  }

  /**
   * Валидирует закрытие части позиции
   */
  public static validatePartialClose(
    currentQuantity: Decimal,
    closeQuantity: Decimal
  ): Result<void, InvalidQuantityError> {
    // closeQuantity должен быть > 0
    if (!closeQuantity.isPositive()) {
      return Err(
        new InvalidQuantityError(
          'Close quantity must be positive',
          {
            code: InvalidQuantityError.code,
            context: { closeQuantity: closeQuantity.toString() }
          }
        )
      );
    }

    // closeQuantity не должен превышать current
    if (closeQuantity.greaterThan(currentQuantity)) {
      return Err(
        new InvalidQuantityError(
          (ctx) => `Cannot close ${ctx.close} when position is ${ctx.current}`,
          {
            code: InvalidQuantityError.code,
            context: {
              current: currentQuantity.toString(),
              close: closeQuantity.toString()
            }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
```

---

#### **Facade Layer**

**Файл:** `facade/QuantityService.ts`

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { Quantity } from '../core/Quantity.js';
import { InvalidQuantityError } from '@polymarket/errors';
import {
  addDecimal,
  subtractDecimal,
  multiplyDecimal,
  divideDecimal,
  roundToTick
} from '@polymarket/math';
import { OrderQuantityPolicy } from '../policy/OrderQuantityPolicy.js';
import { PositionQuantityPolicy } from '../policy/PositionQuantityPolicy.js';
import { ValidatePositiveDivisor } from '../rules/ValidatePositiveDivisor.js';
import { ValidateNonNegativeResult } from '../rules/ValidateNonNegative.js';
import Decimal from 'decimal.js';

/**
 * Фасад для работы с Quantity
 *
 * @remarks
 * Единая точка входа для всех операций с количествами.
 * Оркестрирует Core + Math + Rules + Policy.
 */
export class QuantityService {
  /**
   * Создаёт Quantity (без проверки minSize)
   */
  public static create(value: number | string | Decimal): Result<Quantity, InvalidQuantityError> {
    try {
      const quantity = Quantity.of(value);
      return Ok(quantity);
    } catch (error) {
      if (error instanceof Error) {
        return Err(
          new InvalidQuantityError(error.message, {
            code: InvalidQuantityError.code,
            context: { value: String(value) }
          })
        );
      }
      throw error;
    }
  }

  /**
   * Создаёт Quantity для ордера (с проверкой minSize)
   */
  public static createForOrder(
    value: number | string | Decimal,
    orderMinSize: Decimal
  ): Result<Quantity, InvalidQuantityError> {
    const decimal = value instanceof Decimal ? value : new Decimal(value);

    // Проверяем политику ордера
    const policyResult = OrderQuantityPolicy.validateForOrder(decimal, orderMinSize);
    if (!policyResult.ok) {
      return Err(policyResult.error);
    }

    return this.create(decimal);
  }

  /**
   * Складывает два количества
   */
  public static add(qty1: Quantity, qty2: Quantity): Quantity {
    const sum = addDecimal(qty1.value(), qty2.value());
    return Quantity.of(sum);
  }

  /**
   * Вычитает quantity с проверкой неотрицательности
   */
  public static subtract(
    qty1: Quantity,
    qty2: Quantity
  ): Result<Quantity, InvalidQuantityError> {
    const diff = subtractDecimal(qty1.value(), qty2.value());

    // Проверяем что результат неотрицательный
    const validateResult = ValidateNonNegativeResult.check(diff);
    if (!validateResult.ok) {
      return Err(validateResult.error);
    }

    return this.create(diff);
  }

  /**
   * Умножает quantity на коэффициент
   */
  public static multiply(
    quantity: Quantity,
    factor: number | Decimal
  ): Result<Quantity, InvalidQuantityError> {
    const factorDecimal = factor instanceof Decimal ? factor : new Decimal(factor);
    const result = multiplyDecimal(quantity.value(), factorDecimal);

    return this.create(result);
  }

  /**
   * Делит quantity на делитель с проверкой
   */
  public static divide(
    quantity: Quantity,
    divisor: number | Decimal
  ): Result<Quantity, InvalidQuantityError> {
    const divisorDecimal = divisor instanceof Decimal ? divisor : new Decimal(divisor);

    // Проверяем что делитель положительный
    const validateResult = ValidatePositiveDivisor.check(divisorDecimal);
    if (!validateResult.ok) {
      return Err(validateResult.error);
    }

    // Делим (Math layer уже проверит division by zero)
    const result = divideDecimal(quantity.value(), divisorDecimal);

    return this.create(result);
  }

  /**
   * Округляет до тика
   */
  public static roundToTick(
    quantity: Quantity,
    tickSize: Decimal,
    roundingMode?: Decimal.Rounding
  ): Result<Quantity, InvalidQuantityError> {
    const rounded = roundToTick(quantity.value(), tickSize, roundingMode);
    return this.create(rounded);
  }

  /**
   * Валидирует для использования в позиции
   */
  public static validateForPosition(
    quantity: Quantity
  ): Result<void, InvalidQuantityError> {
    return PositionQuantityPolicy.validateForPosition(quantity.value());
  }
}
```

---

#### **Adapters Layer**

**Файл:** `adapters/QuantitySerializer.ts`

```typescript
/**
 * Сериализация Quantity в/из JSON
 */
export class QuantitySerializer {
  public static toJSON(quantity: Quantity): { value: number } {
    return { value: quantity.toNumber() };
  }

  public static fromJSON(json: { value: number }): Result<Quantity, InvalidQuantityError> {
    return QuantityService.create(json.value);
  }
}
```

**Файл:** `adapters/QuantityFormatter.ts`

```typescript
/**
 * Форматирование Quantity в строки
 */
export class QuantityFormatter {
  public static toString(quantity: Quantity, decimals: number = 2): string {
    return quantity.value().toFixed(decimals);
  }

  public static toCompactString(quantity: Quantity): string {
    return quantity.value().toString();
  }

  public static toDebugString(quantity: Quantity): string {
    return `Quantity(${quantity.value().toString()})`;
  }

  public static toDisplayString(quantity: Quantity): string {
    const value = quantity.toNumber();
    if (value >= 1000000) {
      return `${(value / 1000000).toFixed(2)}M`;
    }
    if (value >= 1000) {
      return `${(value / 1000).toFixed(2)}K`;
    }
    return value.toFixed(2);
  }
}
```

---

## Детальный план по фазам

### Фаза 0: Подготовка (15 минут)

**Цель:** Создать структуру директорий.

**Команды:**
```bash
cd packages/domain/value-objects/src
mkdir -p quantity/core
mkdir -p quantity/rules
mkdir -p quantity/policy
mkdir -p quantity/facade
mkdir -p quantity/adapters
```

---

### Фаза 1: Core Layer (25 минут)

**Файлы:**
- `quantity/core/Quantity.ts` - Core VO
- `quantity/core/index.ts` - Экспорты

**Тесты:** `__tests__/unit/quantity/core/Quantity.test.ts` (~25 тестов)

---

### Фаза 2: Rules Layer (40 минут)

**Файлы:**
- `quantity/rules/ValidateMinSize.ts`
- `quantity/rules/ValidateNonNegative.ts`
- `quantity/rules/ValidatePositiveDivisor.ts`
- `quantity/rules/index.ts`

**Тесты:** `__tests__/unit/quantity/rules/*.test.ts` (~20 тестов)

---

### Фаза 3: Policy Layer (30 минут)

**Файлы:**
- `quantity/policy/OrderQuantityPolicy.ts`
- `quantity/policy/PositionQuantityPolicy.ts`
- `quantity/policy/index.ts`

**Тесты:** `__tests__/unit/quantity/policy/*.test.ts` (~15 тестов)

---

### Фаза 4: Facade Layer (50 минут)

**Файлы:**
- `quantity/facade/QuantityService.ts` - Главный фасад
- `quantity/facade/index.ts`

**Тесты:** `__tests__/unit/quantity/facade/*.test.ts` (~30 тестов)

---

### Фаза 5: Adapters Layer (15 минут)

**Файлы:**
- `quantity/adapters/QuantitySerializer.ts`
- `quantity/adapters/QuantityFormatter.ts`
- `quantity/adapters/index.ts`

**Тесты:** `__tests__/unit/quantity/adapters/*.test.ts` (~12 тестов)

---

### Фаза 6: Главный index.ts (10 минут)

**Файл:** `quantity/index.ts`

```typescript
// Core
export { Quantity, QuantityInvariantViolation } from './core/index.js';

// Facade (главная точка входа)
export { QuantityService } from './facade/index.js';

// Adapters
export { QuantitySerializer, QuantityFormatter } from './adapters/index.js';

// Rules (для advanced use cases)
export {
  ValidateMinSize,
  ValidateNonNegativeResult,
  ValidatePositiveDivisor
} from './rules/index.js';

// Policy (для advanced use cases)
export {
  OrderQuantityPolicy,
  PositionQuantityPolicy
} from './policy/index.js';
```

---

### Фаза 7: Integration тесты (35 минут)

**Файл:** `__tests__/integration/quantity/QuantityWorkflow.integration.test.ts`

**Сценарии:**
1. Создание для ордера → валидация minSize
2. Add → subtract → проверка неотрицательности
3. Multiply → divide → округление
4. Создание для позиции → частичное закрытие
5. Сериализация → десериализация

---

### Фаза 8: Обновить package.json exports (5 минут)

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

---

## План тестирования

### Суммарная статистика

| Слой | Unit тестов | Integration |
|------|-------------|-------------|
| Core | 25 | - |
| Rules | 20 | - |
| Policy | 15 | - |
| Facade | 30 | - |
| Adapters | 12 | - |
| **Integration** | - | 20 |
| **Итого** | **102** | **20** |
| **ВСЕГО** | **122 теста** | |

### Coverage Target

- **Branches:** 100%
- **Functions:** 100%
- **Lines:** 100%
- **Statements:** 100%

---

## План документации

1. **`quantity/README.md`** - Обзор архитектуры
2. **`quantity/docs/architecture.md`** - Детали слоёв
3. **`quantity/docs/migration-guide.md`** - Гайд по миграции
4. **`quantity/docs/examples.md`** - Примеры использования

---

## Миграция

### Breaking Changes

```typescript
// Было:
const qty = Quantity.fromValue(10, 1);

// Стало:
const qty = QuantityService.createForOrder(10, new Decimal(1));
```

---

## Timeline

| Фаза | Время |
|------|-------|
| 0. Подготовка | 15 мин |
| 1. Core | 25 мин |
| 2. Rules | 40 мин |
| 3. Policy | 30 мин |
| 4. Facade | 50 мин |
| 5. Adapters | 15 мин |
| 6. Index | 10 мин |
| 7. Integration | 35 мин |
| 8. Exports | 5 мин |
| **Итого** | **~3.5 часа** |

---

**Конец плана для Quantity**
