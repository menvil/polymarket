# SignedQuantity Value Object - План реализации

## Обзор

SignedQuantity - Value Object для представления знаковых количеств (может быть положительным, отрицательным или нулем).

### Ключевые отличия от Quantity

| Характеристика | Quantity | SignedQuantity |
|---------------|----------|----------------|
| Диапазон значений | `>= 0` | любое конечное число |
| Знак | только положительное | положительное, отрицательное, ноль |
| Нормализация -0 | N/A | `-0` → `0` |
| Use cases | размеры позиций, объемы | изменения позиций, P&L, дельты |

## Структура директорий

```
src/signed-quantity/
├── core/
│   ├── SignedQuantity.ts              # Core VO (throws)
│   ├── SignedQuantityInvariantViolation.ts
│   └── index.ts
├── facade/
│   ├── SignedQuantityService.ts       # Facade (Result API)
│   └── index.ts
├── errors/
│   ├── SignedQuantityErrorReason.ts   # Typed error enum
│   └── index.ts
├── adapters/
│   ├── SignedQuantityFormatter.ts     # Display formatting
│   ├── SignedQuantitySerializer.ts    # JSON serialization
│   └── index.ts
├── rules/
│   └── index.ts                       # Пока пустое (добавим по мере необходимости)
└── index.ts                           # Public exports
```

## Phase 1: Core Layer

### 1.1 SignedQuantityErrorReason.ts

```typescript
/**
 * Типизированные причины ошибок для SignedQuantity операций
 */
export enum SignedQuantityErrorReason {
  /** Значение NaN */
  NAN = 'NAN',

  /** Значение не finite (Infinity, -Infinity) */
  NON_FINITE = 'NON_FINITE',

  /** Ошибка парсинга значения */
  INVALID_FORMAT = 'INVALID_FORMAT',

  /** Деление на ноль */
  DIVISION_BY_ZERO = 'DIVISION_BY_ZERO'
}
```

**Почему нет NEGATIVE?**

- SignedQuantity допускает отрицательные значения
- NEGATIVE нужен только для Quantity

### 1.2 SignedQuantityInvariantViolation.ts

```typescript
import { SignedQuantityErrorReason } from '../errors/SignedQuantityErrorReason.js';

/**
 * SignedQuantityInvariantViolation - нарушение инварианта SignedQuantity
 */
export class SignedQuantityInvariantViolation extends Error {
  public readonly reason:
    | SignedQuantityErrorReason.NAN
    | SignedQuantityErrorReason.NON_FINITE;

  constructor(
    message: string,
    reason:
      | SignedQuantityErrorReason.NAN
      | SignedQuantityErrorReason.NON_FINITE
  ) {
    super(`SignedQuantity invariant violation: ${message}`);
    Object.setPrototypeOf(this, SignedQuantityInvariantViolation.prototype);
    this.name = 'SignedQuantityInvariantViolation';
    this.reason = reason;
  }
}
```

### 1.3 SignedQuantity.ts (Core)

```typescript
import Decimal from 'decimal.js';
import { SignedQuantityErrorReason } from '../errors/SignedQuantityErrorReason.js';
import { SignedQuantityInvariantViolation } from './SignedQuantityInvariantViolation.js';

/**
 * SignedQuantity Value Object
 *
 * @remarks
 * Представляет знаковое количество (может быть положительным, отрицательным или нулем).
 *
 * Инварианты:
 * - Must be finite (не NaN, не Infinity)
 * - Нормализация -0 → 0
 *
 * Используется для:
 * - Изменения позиций (position deltas)
 * - Profit & Loss (P&L)
 * - Нетто-позиции (net positions)
 * - Любые знаковые количества
 *
 * @example
 * ```typescript
 * // Положительное изменение
 * const increase = SignedQuantity.of(new Decimal(10));
 *
 * // Отрицательное изменение
 * const decrease = SignedQuantity.of(new Decimal(-10));
 *
 * // Ноль
 * const noChange = SignedQuantity.ZERO;
 *
 * // Проверка знака
 * if (qty.isPositive()) { ... }
 * if (qty.isNegative()) { ... }
 * const sign = qty.sign(); // -1 | 0 | 1
 * ```
 */
export class SignedQuantity {
  /**
   * Константы
   */
  public static readonly ZERO = SignedQuantity.of(new Decimal(0));
  public static readonly ONE = SignedQuantity.of(new Decimal(1));
  public static readonly MINUS_ONE = SignedQuantity.of(new Decimal(-1));

  private constructor(private readonly _value: Decimal) {
    // Инвариант 1: Not NaN
    if (_value.isNaN()) {
      throw new SignedQuantityInvariantViolation(
        'SignedQuantity cannot be NaN',
        SignedQuantityErrorReason.NAN
      );
    }

    // Инвариант 2: Must be finite
    if (!_value.isFinite()) {
      throw new SignedQuantityInvariantViolation(
        'SignedQuantity must be finite',
        SignedQuantityErrorReason.NON_FINITE
      );
    }

    // ВАЖНО: Нормализация -0 → 0 делается в of(), не здесь
  }

  /**
   * Создаёт SignedQuantity из Decimal
   *
   * @internal ТОЛЬКО для внутреннего использования в Core и Facade
   *
   * @remarks
   * Автоматически нормализует -0 в 0.
   * Для публичного API используйте SignedQuantityService.create().
   *
   * @param value - Значение (Decimal)
   * @returns Новый SignedQuantity
   * @throws {SignedQuantityInvariantViolation} Если значение не соответствует инвариантам
   */
  public static of(value: Decimal): SignedQuantity {
    // Нормализация -0 → 0
    const normalized = value.isZero() ? new Decimal(0) : value;
    return new SignedQuantity(normalized);
  }

  /**
   * Возвращает Decimal значение
   */
  public value(): Decimal {
    return this._value;
  }

  /**
   * Возвращает number значение (lossy conversion)
   */
  public toNumber(): number {
    return this._value.toNumber();
  }

  // === Проверки ===

  public equals(other: SignedQuantity): boolean {
    return this._value.equals(other._value);
  }

  public isZero(): boolean {
    return this._value.isZero();
  }

  public isPositive(): boolean {
    return this._value.greaterThan(0);
  }

  public isNegative(): boolean {
    return this._value.lessThan(0);
  }

  // === Сравнения ===

  public isLessThan(other: SignedQuantity): boolean {
    return this._value.lessThan(other._value);
  }

  public isLessThanOrEqual(other: SignedQuantity): boolean {
    return this._value.lessThanOrEqualTo(other._value);
  }

  public isGreaterThan(other: SignedQuantity): boolean {
    return this._value.greaterThan(other._value);
  }

  public isGreaterThanOrEqual(other: SignedQuantity): boolean {
    return this._value.greaterThanOrEqualTo(other._value);
  }

  // === Операции со знаком ===

  /**
   * Возвращает знак числа
   *
   * @returns -1 (отрицательное), 0 (ноль), 1 (положительное)
   */
  public sign(): -1 | 0 | 1 {
    if (this._value.isZero()) return 0;
    return this._value.isNegative() ? -1 : 1;
  }

  /**
   * Возвращает абсолютное значение как SignedQuantity
   *
   * @returns SignedQuantity с неотрицательным значением
   */
  public abs(): SignedQuantity {
    return SignedQuantity.of(this._value.abs());
  }

  /**
   * Возвращает противоположное по знаку значение
   *
   * @returns Новый SignedQuantity с противоположным знаком
   *
   * @example
   * ```typescript
   * const qty = SignedQuantity.of(new Decimal(10));
   * const neg = qty.neg(); // -10
   * ```
   */
  public neg(): SignedQuantity {
    return SignedQuantity.of(this._value.negated());
  }
}
```

**Ключевые решения:**

1. ✅ Нормализация -0 в of(), не в конструкторе (для наглядности)
2. ✅ abs() возвращает SignedQuantity (консистентно с остальными операциями Core)
3. ✅ Константы: ZERO, ONE, MINUS_ONE
4. ✅ sign() возвращает строго типизированный union: -1 | 0 | 1

## Phase 2: Facade Layer

### 2.1 SignedQuantityService.ts

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidSignedQuantityError, toDecimal, wrapOp } from '@polymarket/errors';
import Decimal from 'decimal.js';
import { addDecimal, subtractDecimal, multiplyDecimal, divideDecimal } from '@polymarket/math';
import { SignedQuantity } from '../core/SignedQuantity.js';
import { SignedQuantityInvariantViolation } from '../core/SignedQuantityInvariantViolation.js';
import { SignedQuantityErrorReason } from '../errors/SignedQuantityErrorReason.js';

/**
 * SignedQuantityService - публичный API для работы с SignedQuantity
 *
 * @remarks
 * Единая точка входа для всех операций с SignedQuantity.
 * ВСЕ методы ГАРАНТИРОВАННО возвращают Result и НИКОГДА не бросают исключения.
 */
export class SignedQuantityService {
  private static readonly SERVICE_NAME = 'SignedQuantityService';

  /**
   * Создать SignedQuantity из number/string/Decimal
   */
  public static create(
    value: Decimal | number | string
  ): Result<SignedQuantity, InvalidSignedQuantityError> {
    const op = 'create';
    return wrapOp(op, { value }, () => {
      // Парсинг
      const decimalResult = toDecimal(
        'value',
        value,
        SignedQuantityErrorReason.INVALID_FORMAT,
        InvalidSignedQuantityError
      );
      if (!decimalResult.ok) return decimalResult;

      // Создание через Core (может бросить)
      try {
        const qty = SignedQuantity.of(decimalResult.value);
        return Ok(qty);
      } catch (error) {
        if (error instanceof SignedQuantityInvariantViolation) {
          return Err(
            new InvalidSignedQuantityError(error.message, {
              context: {
                service: SignedQuantityService.SERVICE_NAME,
                op,
                reason: error.reason
              }
            })
          );
        }
        throw error; // Unexpected error
      }
    }, SignedQuantityService.SERVICE_NAME, InvalidSignedQuantityError);
  }

  /**
   * Сложение двух SignedQuantity
   */
  public static add(
    a: SignedQuantity,
    b: SignedQuantity
  ): Result<SignedQuantity, InvalidSignedQuantityError> {
    const op = 'add';
    return wrapOp(op, {}, () => {
      const result = addDecimal(a.value(), b.value());
      return Ok(SignedQuantity.of(result));
    }, SignedQuantityService.SERVICE_NAME, InvalidSignedQuantityError);
  }

  /**
   * Вычитание SignedQuantity
   */
  public static subtract(
    a: SignedQuantity,
    b: SignedQuantity
  ): Result<SignedQuantity, InvalidSignedQuantityError> {
    const op = 'subtract';
    return wrapOp(op, {}, () => {
      const result = subtractDecimal(a.value(), b.value());
      return Ok(SignedQuantity.of(result));
    }, SignedQuantityService.SERVICE_NAME, InvalidSignedQuantityError);
  }

  /**
   * Умножение на скаляр
   */
  public static multiply(
    qty: SignedQuantity,
    factor: Decimal | number | string
  ): Result<SignedQuantity, InvalidSignedQuantityError> {
    const op = 'multiply';
    return wrapOp(op, { factor }, () => {
      const factorDecimalResult = toDecimal(
        'factor',
        factor,
        SignedQuantityErrorReason.INVALID_FORMAT,
        InvalidSignedQuantityError
      );
      if (!factorDecimalResult.ok) return factorDecimalResult;

      const result = multiplyDecimal(qty.value(), factorDecimalResult.value);
      return Ok(SignedQuantity.of(result));
    }, SignedQuantityService.SERVICE_NAME, InvalidSignedQuantityError);
  }

  /**
   * Деление на скаляр
   */
  public static divide(
    qty: SignedQuantity,
    divisor: Decimal | number | string
  ): Result<SignedQuantity, InvalidSignedQuantityError> {
    const op = 'divide';
    return wrapOp(op, { divisor }, () => {
      const divisorDecimalResult = toDecimal(
        'divisor',
        divisor,
        SignedQuantityErrorReason.INVALID_FORMAT,
        InvalidSignedQuantityError
      );
      if (!divisorDecimalResult.ok) return divisorDecimalResult;

      // Проверка деления на ноль
      if (divisorDecimalResult.value.isZero()) {
        return Err(
          new InvalidSignedQuantityError('Cannot divide by zero', {
            context: {
              service: SignedQuantityService.SERVICE_NAME,
              op,
              reason: SignedQuantityErrorReason.DIVISION_BY_ZERO
            }
          })
        );
      }

      const result = divideDecimal(qty.value(), divisorDecimalResult.value);
      return Ok(SignedQuantity.of(result));
    }, SignedQuantityService.SERVICE_NAME, InvalidSignedQuantityError);
  }

  /**
   * Абсолютное значение (возвращает SignedQuantity)
   */
  public static abs(qty: SignedQuantity): Result<SignedQuantity, InvalidSignedQuantityError> {
    return Ok(qty.abs());
  }

  /**
   * Противоположное по знаку
   */
  public static negate(qty: SignedQuantity): SignedQuantity {
    return qty.neg();
  }
}
```

## Phase 3: Adapters Layer

### 3.1 SignedQuantityFormatter.ts

```typescript
import { SignedQuantity } from '../core/SignedQuantity.js';

/**
 * SignedQuantityFormatter - форматирование для отображения
 */
export class SignedQuantityFormatter {
  /**
   * Форматировать с фиксированными десятичными знаками
   *
   * @param qty - SignedQuantity для форматирования
   * @param decimals - Количество десятичных знаков (по умолчанию 2)
   * @param showSign - Показывать знак + для положительных (по умолчанию false)
   * @returns Отформатированная строка
   *
   * @example
   * ```typescript
   * SignedQuantityFormatter.toFixed(qty, 2);       // "10.50" или "-10.50"
   * SignedQuantityFormatter.toFixed(qty, 2, true); // "+10.50" или "-10.50"
   * ```
   */
  public static toFixed(
    qty: SignedQuantity,
    decimals = 2,
    showSign = false
  ): string {
    const value = qty.value().toFixed(decimals);
    if (showSign && qty.isPositive()) {
      return `+${value}`;
    }
    return value;
  }

  /**
   * Форматировать с указанием направления
   *
   * @returns Строка с индикатором направления: "↑ 10.50", "↓ 10.50", "= 0.00"
   */
  public static withDirection(qty: SignedQuantity, decimals = 2): string {
    const value = qty.value().abs().toFixed(decimals);
    if (qty.isPositive()) return `↑ ${value}`;
    if (qty.isNegative()) return `↓ ${value}`;
    return `= ${value}`;
  }

  /**
   * Компактный формат для логов
   */
  public static compact(qty: SignedQuantity, decimals = 2): string {
    return qty.value().toFixed(decimals);
  }
}
```

### 3.2 SignedQuantitySerializer.ts

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidSignedQuantityError, ErrorSource } from '@polymarket/errors';
import { SignedQuantity } from '../core/SignedQuantity.js';
import { SignedQuantityService } from '../facade/SignedQuantityService.js';
import { SignedQuantityErrorReason } from '../errors/SignedQuantityErrorReason.js';

/**
 * SignedQuantitySerializer - JSON сериализация
 */
export class SignedQuantitySerializer {
  /**
   * Сериализация в JSON (number)
   */
  public static toJSON(qty: SignedQuantity): number {
    return qty.toNumber();
  }

  /**
   * Десериализация из JSON
   */
  public static fromJSON(
    json: number
  ): Result<SignedQuantity, InvalidSignedQuantityError> {
    return SignedQuantityService.create(json);
  }

  /**
   * Десериализация из unknown (с type guard)
   */
  public static fromUnknown(
    value: unknown
  ): Result<SignedQuantity, InvalidSignedQuantityError> {
    if (typeof value !== 'number') {
      return Err(
        new InvalidSignedQuantityError(
          `SignedQuantity must be number, got ${typeof value}`,
          {
            context: {
              source: ErrorSource.PARSING,
              reason: SignedQuantityErrorReason.INVALID_FORMAT,
              raw: { field: 'value', value }
            }
          }
        )
      );
    }

    return SignedQuantitySerializer.fromJSON(value);
  }
}
```

## Phase 4: Tests

### 4.1 Структура тестов

```
__tests__/unit/signed-quantity/
├── SignedQuantity.test.ts           # Core tests
├── SignedQuantityService.test.ts    # Facade tests
├── SignedQuantityFormatter.test.ts  # Formatter tests
└── SignedQuantitySerializer.test.ts # Serializer tests
```

### 4.2 Ключевые тест-кейсы

**Core тесты:**

- ✅ Создание положительного значения
- ✅ Создание отрицательного значения
- ✅ Создание нуля
- ✅ Нормализация -0 → 0
- ✅ Отклонение NaN
- ✅ Отклонение Infinity
- ✅ sign() для положительных, отрицательных, нуля
- ✅ isPositive(), isNegative(), isZero()
- ✅ abs() возвращает SignedQuantity
- ✅ neg() меняет знак
- ✅ equals() сравнение
- ✅ Сравнения (lessThan, greaterThan и т.д.)

**Service тесты:**

- ✅ create() из number/string/Decimal
- ✅ add() положительных и отрицательных
- ✅ subtract() с переходом через ноль
- ✅ multiply() со знаками
- ✅ divide() с проверкой деления на ноль
- ✅ Обработка ошибок (NaN, Infinity)

**Formatter тесты:**

- ✅ toFixed() с разными decimals
- ✅ toFixed() с showSign=true
- ✅ withDirection() для положительных/отрицательных/нуля

**Serializer тесты:**

- ✅ toJSON() → number
- ✅ fromJSON() round-trip
- ✅ fromUnknown() type guard

## Phase 5: Documentation

### 5.1 Файлы документации

```
docs/signed-quantity/
├── README.md           # Основная документация
├── architecture.md     # Архитектурные решения
├── examples.md         # Примеры использования
└── facade.md          # Facade API reference
```

### 5.2 Ключевые разделы README

1. **Обзор** - что такое SignedQuantity и когда использовать
2. **Быстрый старт** - базовые примеры
3. **API Reference** - все методы
4. **Отличия от Quantity** - таблица сравнения
5. **Use Cases** - практические сценарии (P&L, position deltas)
6. **Best Practices** - рекомендации

## Phase 6: Integration

### 6.1 Exports в index.ts

```typescript
// Core
export { SignedQuantity } from './core/SignedQuantity.js';
export { SignedQuantityInvariantViolation } from './core/SignedQuantityInvariantViolation.js';

// Facade
export { SignedQuantityService } from './facade/SignedQuantityService.js';

// Errors
export { SignedQuantityErrorReason } from './errors/SignedQuantityErrorReason.js';

// Adapters
export { SignedQuantityFormatter } from './adapters/SignedQuantityFormatter.js';
export { SignedQuantitySerializer } from './adapters/SignedQuantitySerializer.js';
```

### 6.2 Обновление package exports

В `package.json`:

```json
{
  "exports": {
    "./signed-quantity": {
      "types": "./dist/signed-quantity/index.d.ts",
      "import": "./dist/signed-quantity/index.js"
    }
  }
}
```

### 6.3 Создание InvalidSignedQuantityError

**В @polymarket/errors:**

```typescript
export class InvalidSignedQuantityError extends ValidationError {
  constructor(message: string, options?: ValidationErrorOptions) {
    super(message, options);
    this.name = 'InvalidSignedQuantityError';
  }
}
```

## Порядок реализации (шаг за шагом)

### День 1: Core + Errors

1. ✅ Создать SignedQuantityErrorReason.ts
2. ✅ Создать SignedQuantityInvariantViolation.ts
3. ✅ Создать SignedQuantity.ts (Core)
4. ✅ Написать Core тесты

### День 2: Facade

1. ✅ Создать InvalidSignedQuantityError в @polymarket/errors
2. ✅ Создать SignedQuantityService.ts
3. ✅ Написать Service тесты

### День 3: Adapters

1. ✅ Создать SignedQuantityFormatter.ts
2. ✅ Создать SignedQuantitySerializer.ts
3. ✅ Написать Formatter и Serializer тесты

### День 4: Documentation

1. ✅ Написать README.md
2. ✅ Написать architecture.md
3. ✅ Написать examples.md
4. ✅ Написать facade.md

### День 5: Integration & Review

1. ✅ Настроить exports
2. ✅ Прогнать все тесты
3. ✅ Проверить TypeScript компиляцию
4. ✅ Code review и финальные правки

## Критические решения

### 1. abs() возвращает SignedQuantity

**Итоговое решение:** `abs()` возвращает `SignedQuantity` (не `Decimal`).
Core `quantity.abs()` возвращает `SignedQuantity`, Facade оборачивает в `Ok(...)`.

**Почему SignedQuantity, а не Decimal:**

- Консистентность с остальными операциями Facade (все возвращают `Result<SignedQuantity, ...>`)
- Возврат Quantity создавал бы circular dependency
- Абсолютное значение >= 0 гарантируется инвариантом SignedQuantity через нормализацию

### 2. Нормализация -0

**Реализация:**

```typescript
const normalized = value.isZero() ? new Decimal(0) : value;
```

**Почему важно:**

- Decimal.js различает +0 и -0
- Для equals() нужна консистентность
- Избегаем edge cases

### 3. Константы

**Добавлены:**

- `SignedQuantity.ZERO`
- `SignedQuantity.ONE`
- `SignedQuantity.MINUS_ONE`

**Почему MINUS_ONE:**

- Часто используется для инверсии
- Избегаем повторного создания

### 4. sign() типизация

**Строго типизированный union:**

```typescript
sign(): -1 | 0 | 1
```

**Альтернатива:**

```typescript
sign(): number  // Слабее
```

## Use Cases

### 1. Position Delta

```typescript
// Увеличение позиции
const increase = SignedQuantity.of(new Decimal(100));

// Уменьшение позиции
const decrease = SignedQuantity.of(new Decimal(-50));

// Применение к позиции
const newPosition = QuantityService.add(
  currentPosition,
  delta.abs() // Конвертируем в Quantity
);
```

### 2. P&L Tracking

```typescript
// Профит
const profit = SignedQuantity.of(new Decimal(1500.50));

// Убыток
const loss = SignedQuantity.of(new Decimal(-250.75));

// Агрегация
const totalPnL = SignedQuantityService.add(profit, loss);

// Форматирование
console.log(SignedQuantityFormatter.withDirection(totalPnL));
// "↑ 1249.75" или "↓ 1249.75"
```

### 3. Net Position

```typescript
// Лонг позиция
const long = SignedQuantity.of(new Decimal(100));

// Шорт позиция
const short = SignedQuantity.of(new Decimal(-75));

// Нетто
const net = SignedQuantityService.add(long, short);
// SignedQuantity(25)
```

## Вопросы для обсуждения

1. ✅ **Нужны ли Rules для SignedQuantity?**
   - Пока не добавляем, по мере необходимости

2. ✅ **Как конвертировать SignedQuantity → Quantity?**
   - Через abs(): `QuantityService.create(signedQty.abs())`
   - Или проверка знака + value()

3. ✅ **Нужен ли метод toQuantity()?**
   - Можно добавить для удобства, но не критично

4. ✅ **Форматирование отрицательных значений?**
   - Стандартно: "-10.50"
   - С индикатором: "↓ 10.50"
   - Выбор через опции

## Checklist

### Core

- [ ] SignedQuantityErrorReason.ts
- [ ] SignedQuantityInvariantViolation.ts
- [ ] SignedQuantity.ts
- [ ] Core тесты (52+ tests)

### Facade

- [ ] InvalidSignedQuantityError в @polymarket/errors
- [ ] SignedQuantityService.ts
- [ ] Service тесты (30+ tests)

### Adapters

- [ ] SignedQuantityFormatter.ts
- [ ] SignedQuantitySerializer.ts
- [ ] Adapter тесты (20+ tests)

### Documentation

- [ ] README.md
- [ ] architecture.md
- [ ] examples.md
- [ ] facade.md

### Integration

- [ ] index.ts exports
- [ ] package.json exports
- [ ] TypeScript компиляция
- [ ] Все тесты проходят

---

**Оценка времени:** 3-5 дней

**Сложность:** Средняя (повторяем паттерн Quantity)

**Риски:** Минимальные (проверенный паттерн)
