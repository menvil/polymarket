# План реализации Ratio Value Object

## Общие сведения

**Цель**: Реализовать Ratio value object для представления относительных величин (коэффициентов, долей) с точной арифметикой.

**Ключевые принципы**:
- Ratio хранит дробь (fraction): `0.02` для 2%, `0.0025` для 25 bps
- Ratio - это минимальная абстракция, НЕ содержит арифметические операции
- Доменные операции (addRate, take, applyDiscount) живут в Money/Price/Quantity
- Следует архитектуре Throws+Facade как Money/Price/Quantity
- 4-layer architecture: Core → Rules → Facade → Adapters

---

## Фаза 1: Core Layer (Базовый класс)

### 1.1 Создать `src/ratio/core/Ratio.ts`

**Структура класса:**

```typescript
/**
 * Ratio - value object для представления относительных величин (коэффициентов, долей)
 *
 * @remarks
 * ## Архитектура
 * - Core слой БРОСАЕТ исключения RatioInvariantViolation
 * - Facade слой (RatioService) возвращает Result<T, E> и НИКОГДА не бросает
 * - Для безопасного создания используйте RatioService.fromDecimal() / fromPercent() / fromBps()
 *
 * ## Инварианты
 * Ratio гарантирует:
 * - Значение не NaN
 * - Значение конечно (finite)
 *
 * ## НЕ-инварианты (не проверяются на этом уровне)
 * - Минимальные/максимальные границы (проверяются Rules при необходимости)
 * - Парсинг строк (делает RatioFormatter в Adapters)
 * - Валидация precondition для операций (делает Rules)
 *
 * ## Семантика
 * Ratio хранит дробь (fraction):
 * - `0.02` означает 2% (two percent)
 * - `0.0025` означает 25 bps (basis points)
 * - `1.0` означает 100%
 * - `-0.1` означает -10% (discount)
 *
 * ## Важно: Ratio НЕ содержит арифметических операций
 * Операции живут в целевых value objects:
 * - Money.addRate(ratio: Ratio): добавить процент к сумме
 * - Price.take(ratio: Ratio): взять процент от цены
 * - Quantity.applyDiscount(ratio: Ratio): применить скидку
 *
 * @see {@link RatioService} для безопасного создания и операций
 *
 * @example
 * ```typescript
 * // ❌ WRONG: Никогда не вызывайте конструктор напрямую
 * const ratio = new Ratio(value);
 *
 * // ✅ CORRECT: Используйте RatioService
 * const ratioResult = RatioService.fromPercent(2); // 2% => 0.02
 * if (ratioResult.ok) {
 *   const ratio = ratioResult.value;
 *   console.log(ratio.toDecimal()); // Decimal(0.02)
 * }
 * ```
 */
export class Ratio {
  /**
   * Единственный приватный конструктор
   * @throws {RatioInvariantViolation} если нарушены инварианты
   */
  private constructor(private readonly _value: Decimal) {
    // Invariant 1: value не может быть NaN
    if (_value.isNaN()) {
      throw new RatioInvariantViolation(
        'Ratio value cannot be NaN',
        RatioErrorReason.NAN
      );
    }

    // Invariant 2: value должно быть конечным
    if (!_value.isFinite()) {
      throw new RatioInvariantViolation(
        'Ratio value must be finite',
        RatioErrorReason.NON_FINITE
      );
    }
  }

  /**
   * Создать Ratio из дроби (fraction)
   *
   * @param value - Дробь: 0.02 для 2%, 0.5 для 50%
   * @returns Ratio instance
   * @throws {RatioInvariantViolation} если нарушены инварианты
   *
   * @example
   * ```typescript
   * const ratio = Ratio.of(new Decimal(0.02)); // 2%
   * const ratio2 = Ratio.of(new Decimal(0.5)); // 50%
   * ```
   */
  public static of(value: Decimal): Ratio {
    return new Ratio(value);
  }

  /**
   * Получить значение как Decimal (fraction)
   *
   * @returns Decimal значение (0.02 для 2%)
   *
   * @example
   * ```typescript
   * const ratio = Ratio.of(new Decimal(0.02));
   * console.log(ratio.toDecimal().toString()); // "0.02"
   * ```
   */
  public toDecimal(): Decimal {
    return this._value;
  }

  /**
   * Получить значение как number (lossy!)
   *
   * @remarks
   * ⚠️ ВНИМАНИЕ: Преобразование в number может потерять точность
   * Используйте только для отображения, НЕ для вычислений
   *
   * @returns number значение (0.02 для 2%)
   *
   * @example
   * ```typescript
   * const ratio = Ratio.of(new Decimal(0.02));
   * console.log(ratio.toNumber()); // 0.02
   * ```
   */
  public toNumber(): number {
    return this._value.toNumber();
  }

  /**
   * Вычислить (1 + ratio) для compound operations
   *
   * @remarks
   * Используется для операций типа "добавить X процентов":
   * - amount * (1 + ratio)
   * - price * (1 + markup)
   *
   * @returns Decimal значение (1 + ratio)
   *
   * @example
   * ```typescript
   * const markup = Ratio.of(new Decimal(0.1)); // 10%
   * console.log(markup.onePlus().toString()); // "1.1"
   *
   * // Usage: price * (1 + markup)
   * const newPrice = price.toDecimal().mul(markup.onePlus());
   * ```
   */
  public onePlus(): Decimal {
    return new Decimal(1).plus(this._value);
  }

  /**
   * Проверить равенство с другим Ratio
   *
   * @param other - Другой Ratio для сравнения
   * @returns true если значения равны
   *
   * @example
   * ```typescript
   * const r1 = Ratio.of(new Decimal(0.02));
   * const r2 = Ratio.of(new Decimal(0.02));
   * console.log(r1.equals(r2)); // true
   * ```
   */
  public equals(other: Ratio): boolean {
    return this._value.equals(other._value);
  }

  /**
   * Проверить, равно ли значение нулю
   *
   * @returns true если ratio === 0
   *
   * @example
   * ```typescript
   * const zero = Ratio.of(new Decimal(0));
   * console.log(zero.isZero()); // true
   * ```
   */
  public isZero(): boolean {
    return this._value.isZero();
  }

  /**
   * Проверить, положительно ли значение
   *
   * @returns true если ratio > 0
   *
   * @example
   * ```typescript
   * const markup = Ratio.of(new Decimal(0.1));
   * console.log(markup.isPositive()); // true
   * ```
   */
  public isPositive(): boolean {
    return this._value.greaterThan(0);
  }

  /**
   * Проверить, отрицательно ли значение
   *
   * @returns true если ratio < 0
   *
   * @example
   * ```typescript
   * const discount = Ratio.of(new Decimal(-0.1));
   * console.log(discount.isNegative()); // true
   * ```
   */
  public isNegative(): boolean {
    return this._value.lessThan(0);
  }

  /**
   * Константа: нулевой коэффициент
   */
  public static readonly ZERO: Ratio = new Ratio(new Decimal(0));

  /**
   * Константа: единичный коэффициент (100%)
   */
  public static readonly ONE: Ratio = new Ratio(new Decimal(1));
}
```

### 1.2 Создать `src/ratio/core/RatioInvariantViolation.ts`

```typescript
/**
 * Исключение при нарушении инвариантов Ratio
 *
 * @remarks
 * Бросается только Core слоем (Ratio.of())
 * Facade слой (RatioService) ловит и оборачивает в InvalidRatioError
 */
import { RatioErrorReason } from '../errors/RatioErrorReason.js';

export class RatioInvariantViolation extends Error {
  public readonly reason: RatioErrorReason;

  constructor(message: string, reason: RatioErrorReason) {
    super(message);
    this.name = 'RatioInvariantViolation';
    this.reason = reason;
    Object.setPrototypeOf(this, RatioInvariantViolation.prototype);
  }
}
```

### 1.3 Создать `src/ratio/core/index.ts`

```typescript
export { Ratio } from './Ratio.js';
export { RatioInvariantViolation } from './RatioInvariantViolation.js';
```

---

## Фаза 2: Errors Layer (Типизированные ошибки)

### 2.1 Создать `src/ratio/errors/RatioErrorReason.ts`

```typescript
/**
 * Типизированные причины ошибок Ratio
 *
 * @remarks
 * - Используется в RatioInvariantViolation.reason (Core)
 * - Используется в InvalidRatioError.context.reason (Facade)
 * - Позволяет exhaustive checking и безопасный рефакторинг
 * - Все значения SCREAMING_SNAKE_CASE
 *
 * @example
 * ```typescript
 * if (error.context.reason === RatioErrorReason.NAN) {
 *   console.log('Value was NaN');
 * }
 * ```
 */
export enum RatioErrorReason {
  /**
   * Значение NaN (Not a Number)
   *
   * @example
   * RatioService.fromDecimal(NaN) // reason: NAN
   */
  NAN = 'NAN',

  /**
   * Значение не конечно (Infinity или -Infinity)
   *
   * @example
   * RatioService.fromDecimal(Infinity) // reason: NON_FINITE
   */
  NON_FINITE = 'NON_FINITE',

  /**
   * Некорректный формат при парсинге
   *
   * @example
   * RatioFormatter.parse("not a number") // reason: INVALID_FORMAT
   */
  INVALID_FORMAT = 'INVALID_FORMAT',

  /**
   * Некорректная структура JSON при десериализации
   *
   * @example
   * RatioSerializer.fromJSON({ wrong: "structure" }) // reason: INVALID_JSON_STRUCTURE
   */
  INVALID_JSON_STRUCTURE = 'INVALID_JSON_STRUCTURE',

  /**
   * Ratio меньше -1 когда требуется >= -1
   *
   * @remarks
   * Используется в ValidateRatioGteMinusOne для операций типа:
   * - amount * (1 + ratio) где (1 + ratio) должно быть >= 0
   *
   * @example
   * RatioService.fromDecimal(new Decimal(-1.5), { ensureGteMinusOne: true })
   * // reason: LESS_THAN_MINUS_ONE
   */
  LESS_THAN_MINUS_ONE = 'LESS_THAN_MINUS_ONE',

  /**
   * Некорректное значение decimals (должно быть >= 0)
   *
   * @example
   * RatioFormatter.toPercent(ratio, -1) // reason: INVALID_DECIMALS
   */
  INVALID_DECIMALS = 'INVALID_DECIMALS',

  /**
   * Ошибка при операции с Decimal
   *
   * @example
   * Внутренняя ошибка при Decimal arithmetic
   */
  DECIMAL_ERROR = 'DECIMAL_ERROR'
}
```

### 2.2 Создать `src/ratio/errors/index.ts`

```typescript
export { RatioErrorReason } from './RatioErrorReason.js';
```

---

## Фаза 3: Rules Layer (Валидация)

### 3.1 Создать `src/ratio/rules/ValidateRatioGteMinusOne.ts`

```typescript
/**
 * Rule: Ratio >= -1 (для операций типа "1 + ratio")
 *
 * @remarks
 * Проверяет, что ratio >= -1, что гарантирует (1 + ratio) >= 0
 * Используется для операций:
 * - Money.addRate(ratio): amount * (1 + ratio)
 * - Price.applyMarkup(ratio): price * (1 + ratio)
 *
 * @example
 * ```typescript
 * // ✅ Valid: -1 <= ratio
 * ValidateRatioGteMinusOne.check(new Decimal(-1), 'addRate');
 * ValidateRatioGteMinusOne.check(new Decimal(-0.5), 'addRate'); // -50% discount
 * ValidateRatioGteMinusOne.check(new Decimal(0.1), 'addRate'); // +10% markup
 *
 * // ❌ Invalid: ratio < -1
 * ValidateRatioGteMinusOne.check(new Decimal(-1.5), 'addRate');
 * // => Err(InvalidRatioError with reason LESS_THAN_MINUS_ONE)
 * ```
 */
import Decimal from 'decimal.js';
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidRatioError } from '@polymarket/errors';
import { ErrorSource } from '@polymarket/errors';
import { RatioErrorReason } from '../errors/RatioErrorReason.js';

export class ValidateRatioGteMinusOne {
  /**
   * Проверить, что ratio >= -1
   *
   * @param value - Значение ratio для проверки
   * @param operation - Название операции (для контекста ошибки)
   * @returns Ok(undefined) если valid, Err(InvalidRatioError) если invalid
   */
  public static check(value: Decimal, operation: string): Result<void, InvalidRatioError> {
    if (value.lessThan(-1)) {
      return Err(
        new InvalidRatioError(
          `Ratio must be >= -1 for operation "${operation}", got: ${value.toString()}`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              op: operation,
              ratioValue: value.toString(),
              reason: RatioErrorReason.LESS_THAN_MINUS_ONE
            }
          }
        )
      );
    }
    return Ok(undefined);
  }
}
```

### 3.2 Создать `src/ratio/rules/index.ts`

```typescript
export { ValidateRatioGteMinusOne } from './ValidateRatioGteMinusOne.js';
```

---

## Фаза 4: Facade Layer (Public API)

### 4.1 Создать `src/ratio/facade/RatioService.ts`

```typescript
/**
 * Service facade для безопасного создания Ratio
 *
 * @remarks
 * ## Never Throw Contract
 * ВСЕ методы ГАРАНТИРУЮТ возврат Result<T, E> и НИКОГДА не бросают исключения
 *
 * ## Facade Error Contract
 * Каждый Err содержит context с полями:
 * - context.reason: RatioErrorReason (typed enum)
 * - context.op: string (название операции)
 * - context.[field]Value: string (значения, вызвавшие ошибку)
 * - context.source: ErrorSource
 *
 * ## Factory Methods
 * - fromDecimal(): создать из дроби (0.02 для 2%)
 * - fromPercent(): создать из процента (2 для 2%)
 * - fromBps(): создать из basis points (200 для 2%)
 *
 * ## Validation Options
 * - ensureGteMinusOne: проверить, что ratio >= -1 (для операций "1 + ratio")
 *
 * @example
 * ```typescript
 * // Создание из разных форматов
 * const r1 = RatioService.fromDecimal(0.02); // 2%
 * const r2 = RatioService.fromPercent(2); // 2%
 * const r3 = RatioService.fromBps(200); // 2%
 *
 * // С валидацией
 * const markup = RatioService.fromPercent(10, { ensureGteMinusOne: true });
 * if (markup.ok) {
 *   // Используем в операциях типа amount * (1 + ratio)
 * }
 * ```
 */
import Decimal from 'decimal.js';
import { Result, Ok, Err, isErr } from '@polymarket/result';
import { InvalidRatioError } from '@polymarket/errors';
import { ErrorSource, rewrap, toDecimal, wrapOp } from '@polymarket/errors';
import { Ratio } from '../core/Ratio.js';
import { RatioInvariantViolation } from '../core/RatioInvariantViolation.js';
import { RatioErrorReason } from '../errors/RatioErrorReason.js';
import { ValidateRatioGteMinusOne } from '../rules/ValidateRatioGteMinusOne.js';

/**
 * Опции для создания Ratio
 */
export interface RatioCreateOptions {
  /**
   * Проверить, что ratio >= -1
   * Используется для операций типа amount * (1 + ratio)
   */
  ensureGteMinusOne?: boolean;
}

export class RatioService {
  private static readonly SERVICE_NAME = 'RatioService';

  /**
   * Создать Ratio из дроби (fraction)
   *
   * @param value - Дробь: 0.02 для 2%, 0.5 для 50%
   * @param options - Опции валидации
   * @returns Result с Ratio или InvalidRatioError
   *
   * @example
   * ```typescript
   * const ratioResult = RatioService.fromDecimal(0.02);
   * if (ratioResult.ok) {
   *   console.log(ratioResult.value.toDecimal()); // Decimal(0.02)
   * }
   *
   * // С валидацией
   * const validRatio = RatioService.fromDecimal(-0.5, { ensureGteMinusOne: true });
   * // OK: -0.5 >= -1
   *
   * const invalidRatio = RatioService.fromDecimal(-1.5, { ensureGteMinusOne: true });
   * // Err: -1.5 < -1
   * ```
   */
  public static fromDecimal(
    value: number | string | Decimal,
    options?: RatioCreateOptions
  ): Result<Ratio, InvalidRatioError> {
    return wrapOp('fromDecimal', () => {
      // Step 1: Parse to Decimal
      const decimalResult = toDecimal(value, 'fromDecimal', {});
      if (isErr(decimalResult)) {
        return Err(rewrap('fromDecimal', {}, decimalResult.error, InvalidRatioError));
      }
      const decimal = decimalResult.value;

      // Step 2: Optional validation
      if (options?.ensureGteMinusOne) {
        const validationResult = ValidateRatioGteMinusOne.check(decimal, 'fromDecimal');
        if (isErr(validationResult)) {
          return validationResult;
        }
      }

      // Step 3: Create Ratio (throws on invariant violation)
      return this.createFromDecimal(decimal, 'fromDecimal');
    });
  }

  /**
   * Создать Ratio из процента (2 для 2%)
   *
   * @param percent - Процент: 2 для 2%, 50 для 50%
   * @param options - Опции валидации
   * @returns Result с Ratio или InvalidRatioError
   *
   * @example
   * ```typescript
   * const ratioResult = RatioService.fromPercent(2); // 2% => 0.02
   * if (ratioResult.ok) {
   *   console.log(ratioResult.value.toDecimal()); // Decimal(0.02)
   * }
   * ```
   */
  public static fromPercent(
    percent: number | string | Decimal,
    options?: RatioCreateOptions
  ): Result<Ratio, InvalidRatioError> {
    return wrapOp('fromPercent', () => {
      // Step 1: Parse to Decimal
      const decimalResult = toDecimal(percent, 'fromPercent', {});
      if (isErr(decimalResult)) {
        return Err(rewrap('fromPercent', {}, decimalResult.error, InvalidRatioError));
      }

      // Step 2: Convert percent to fraction (divide by 100)
      const fraction = decimalResult.value.div(100);

      // Step 3: Optional validation
      if (options?.ensureGteMinusOne) {
        const validationResult = ValidateRatioGteMinusOne.check(fraction, 'fromPercent');
        if (isErr(validationResult)) {
          return validationResult;
        }
      }

      // Step 4: Create Ratio
      return this.createFromDecimal(fraction, 'fromPercent');
    });
  }

  /**
   * Создать Ratio из basis points (200 для 2%)
   *
   * @param bps - Basis points: 200 для 2%, 100 для 1%
   * @param options - Опции валидации
   * @returns Result с Ratio или InvalidRatioError
   *
   * @example
   * ```typescript
   * const ratioResult = RatioService.fromBps(200); // 200 bps => 0.02
   * if (ratioResult.ok) {
   *   console.log(ratioResult.value.toDecimal()); // Decimal(0.02)
   * }
   * ```
   */
  public static fromBps(
    bps: number | string | Decimal,
    options?: RatioCreateOptions
  ): Result<Ratio, InvalidRatioError> {
    return wrapOp('fromBps', () => {
      // Step 1: Parse to Decimal
      const decimalResult = toDecimal(bps, 'fromBps', {});
      if (isErr(decimalResult)) {
        return Err(rewrap('fromBps', {}, decimalResult.error, InvalidRatioError));
      }

      // Step 2: Convert bps to fraction (divide by 10000)
      const fraction = decimalResult.value.div(10000);

      // Step 3: Optional validation
      if (options?.ensureGteMinusOne) {
        const validationResult = ValidateRatioGteMinusOne.check(fraction, 'fromBps');
        if (isErr(validationResult)) {
          return validationResult;
        }
      }

      // Step 4: Create Ratio
      return this.createFromDecimal(fraction, 'fromBps');
    });
  }

  /**
   * Проверить равенство двух Ratio
   *
   * @param a - Первый Ratio
   * @param b - Второй Ratio
   * @returns Result с true/false
   *
   * @example
   * ```typescript
   * const r1 = RatioService.fromPercent(2);
   * const r2 = RatioService.fromDecimal(0.02);
   * if (r1.ok && r2.ok) {
   *   const equalResult = RatioService.equals(r1.value, r2.value);
   *   console.log(equalResult.value); // true
   * }
   * ```
   */
  public static equals(a: Ratio, b: Ratio): Result<boolean, never> {
    return Ok(a.equals(b));
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  /**
   * Внутренний helper: создать Ratio из Decimal
   */
  private static createFromDecimal(
    value: Decimal,
    operation: string
  ): Result<Ratio, InvalidRatioError> {
    try {
      const ratio = Ratio.of(value);
      return Ok(ratio);
    } catch (error) {
      return Err(this.mapInvariantToError(error, value, operation));
    }
  }

  /**
   * Внутренний helper: преобразовать RatioInvariantViolation в InvalidRatioError
   */
  private static mapInvariantToError(
    error: unknown,
    value: Decimal,
    operation: string
  ): InvalidRatioError {
    if (error instanceof RatioInvariantViolation) {
      return new InvalidRatioError(error.message, {
        context: {
          source: ErrorSource.INVARIANT_VIOLATION,
          op: operation,
          service: this.SERVICE_NAME,
          ratioValue: value.toString(),
          reason: error.reason
        }
      });
    }

    // Unexpected error
    return new InvalidRatioError(`Unexpected error in ${operation}: ${String(error)}`, {
      context: {
        source: ErrorSource.UNKNOWN,
        op: operation,
        service: this.SERVICE_NAME,
        ratioValue: value.toString(),
        reason: RatioErrorReason.DECIMAL_ERROR
      }
    });
  }
}
```

### 4.2 Создать `src/ratio/facade/index.ts`

```typescript
export { RatioService, RatioCreateOptions } from './RatioService.js';
```

---

## Фаза 5: Adapters Layer (Форматирование и сериализация)

### 5.1 Создать `src/ratio/adapters/RatioFormatter.ts`

```typescript
/**
 * Форматирование Ratio в строки
 *
 * @remarks
 * Все методы возвращают Result<string, InvalidRatioError>
 * Поддерживаются форматы:
 * - Decimal: "0.02"
 * - Percent: "2.00%"
 * - Basis points: "200 bps"
 *
 * @example
 * ```typescript
 * const ratio = RatioService.fromPercent(2.5).value;
 *
 * RatioFormatter.toDecimal(ratio); // "0.025"
 * RatioFormatter.toPercent(ratio, 2); // "2.50%"
 * RatioFormatter.toBps(ratio, 0); // "250 bps"
 * ```
 */
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidRatioError, ErrorSource } from '@polymarket/errors';
import { Ratio } from '../core/Ratio.js';
import { RatioErrorReason } from '../errors/RatioErrorReason.js';

export class RatioFormatter {
  /**
   * Форматировать как decimal string
   *
   * @param ratio - Ratio для форматирования
   * @param decimals - Количество десятичных знаков (по умолчанию 4)
   * @returns Result с отформатированной строкой
   *
   * @example
   * ```typescript
   * const ratio = RatioService.fromPercent(2).value;
   * RatioFormatter.toDecimal(ratio, 4); // "0.0200"
   * ```
   */
  public static toDecimal(ratio: Ratio, decimals: number = 4): Result<string, InvalidRatioError> {
    // Validate decimals (inline validation following existing pattern)
    if (decimals < 0 || !Number.isInteger(decimals)) {
      return Err(
        new InvalidRatioError('decimals argument must be a non-negative integer', {
          context: {
            source: ErrorSource.RULE_VALIDATION,
            op: 'toDecimal',
            decimals: decimals.toString(),
            reason: RatioErrorReason.INVALID_DECIMALS
          }
        })
      );
    }

    // Format
    const formatted = ratio.toDecimal().toFixed(decimals);
    return Ok(formatted);
  }

  /**
   * Форматировать как процент
   *
   * @param ratio - Ratio для форматирования
   * @param decimals - Количество десятичных знаков (по умолчанию 2)
   * @returns Result с отформатированной строкой (например, "2.50%")
   *
   * @example
   * ```typescript
   * const ratio = RatioService.fromPercent(2.5).value;
   * RatioFormatter.toPercent(ratio, 2); // "2.50%"
   * RatioFormatter.toPercent(ratio, 1); // "2.5%"
   * ```
   */
  public static toPercent(ratio: Ratio, decimals: number = 2): Result<string, InvalidRatioError> {
    // Validate decimals (inline validation following existing pattern)
    if (decimals < 0 || !Number.isInteger(decimals)) {
      return Err(
        new InvalidRatioError('decimals argument must be a non-negative integer', {
          context: {
            source: ErrorSource.RULE_VALIDATION,
            op: 'toPercent',
            decimals: decimals.toString(),
            reason: RatioErrorReason.INVALID_DECIMALS
          }
        })
      );
    }

    // Convert to percent (multiply by 100)
    const percent = ratio.toDecimal().mul(100);
    const formatted = percent.toFixed(decimals) + '%';
    return Ok(formatted);
  }

  /**
   * Форматировать как basis points
   *
   * @param ratio - Ratio для форматирования
   * @param decimals - Количество десятичных знаков (по умолчанию 0)
   * @returns Result с отформатированной строкой (например, "250 bps")
   *
   * @example
   * ```typescript
   * const ratio = RatioService.fromPercent(2.5).value;
   * RatioFormatter.toBps(ratio, 0); // "250 bps"
   * RatioFormatter.toBps(ratio, 1); // "250.0 bps"
   * ```
   */
  public static toBps(ratio: Ratio, decimals: number = 0): Result<string, InvalidRatioError> {
    // Validate decimals (inline validation following existing pattern)
    if (decimals < 0 || !Number.isInteger(decimals)) {
      return Err(
        new InvalidRatioError('decimals argument must be a non-negative integer', {
          context: {
            source: ErrorSource.RULE_VALIDATION,
            op: 'toBps',
            decimals: decimals.toString(),
            reason: RatioErrorReason.INVALID_DECIMALS
          }
        })
      );
    }

    // Convert to bps (multiply by 10000)
    const bps = ratio.toDecimal().mul(10000);
    const formatted = bps.toFixed(decimals) + ' bps';
    return Ok(formatted);
  }

  /**
   * Парсинг строки в Ratio
   *
   * @remarks
   * Поддерживаются форматы:
   * - "0.02" - decimal
   * - "2%" - percent
   * - "200 bps" - basis points
   *
   * @param input - Строка для парсинга
   * @returns Result с Ratio или InvalidRatioError
   *
   * @example
   * ```typescript
   * RatioFormatter.parse("0.02");   // Ok(Ratio(0.02))
   * RatioFormatter.parse("2%");     // Ok(Ratio(0.02))
   * RatioFormatter.parse("200 bps"); // Ok(Ratio(0.02))
   * RatioFormatter.parse("invalid"); // Err(InvalidRatioError)
   * ```
   */
  public static parse(input: string): Result<Ratio, InvalidRatioError> {
    const trimmed = input.trim();

    // Format: "2%"
    if (trimmed.endsWith('%')) {
      const percentStr = trimmed.slice(0, -1).trim();
      const percentNum = parseFloat(percentStr);
      if (isNaN(percentNum)) {
        return Err(
          new InvalidRatioError(`Invalid percent format: "${input}"`, {
            context: {
              source: ErrorSource.ADAPTER,
              op: 'parse',
              input,
              reason: RatioErrorReason.INVALID_FORMAT
            }
          })
        );
      }
      const { RatioService } = require('../facade/RatioService.js');
      return RatioService.fromPercent(percentNum);
    }

    // Format: "200 bps"
    if (trimmed.endsWith('bps')) {
      const bpsStr = trimmed.slice(0, -3).trim();
      const bpsNum = parseFloat(bpsStr);
      if (isNaN(bpsNum)) {
        return Err(
          new InvalidRatioError(`Invalid bps format: "${input}"`, {
            context: {
              source: ErrorSource.ADAPTER,
              op: 'parse',
              input,
              reason: RatioErrorReason.INVALID_FORMAT
            }
          })
        );
      }
      const { RatioService } = require('../facade/RatioService.js');
      return RatioService.fromBps(bpsNum);
    }

    // Format: "0.02" (decimal)
    const decimalNum = parseFloat(trimmed);
    if (isNaN(decimalNum)) {
      return Err(
        new InvalidRatioError(`Invalid decimal format: "${input}"`, {
          context: {
            source: ErrorSource.ADAPTER,
            op: 'parse',
            input,
            reason: RatioErrorReason.INVALID_FORMAT
          }
        })
      );
    }
    const { RatioService } = require('../facade/RatioService.js');
    return RatioService.fromDecimal(decimalNum);
  }
}
```

### 5.2 Создать `src/ratio/adapters/RatioSerializer.ts`

```typescript
/**
 * Сериализация Ratio в/из JSON
 *
 * @remarks
 * ## JSON формат
 * ```json
 * { "ratio": "0.02" }
 * ```
 *
 * Значение хранится как decimal string для сохранения точности
 *
 * @example
 * ```typescript
 * const ratio = RatioService.fromPercent(2).value;
 *
 * // Serialize
 * const json = RatioSerializer.toJSON(ratio);
 * console.log(json); // { ratio: "0.02" }
 *
 * // Deserialize
 * const parsed = RatioSerializer.fromJSON(json);
 * if (parsed.ok) {
 *   console.log(parsed.value.equals(ratio)); // true
 * }
 * ```
 */
import { Result, Ok, Err, isErr } from '@polymarket/result';
import { InvalidRatioError, ErrorSource } from '@polymarket/errors';
import { Ratio } from '../core/Ratio.js';
import { RatioService } from '../facade/RatioService.js';
import { RatioErrorReason } from '../errors/RatioErrorReason.js';

/**
 * JSON структура для Ratio
 */
export interface RatioJSON {
  ratio: string;
}

export class RatioSerializer {
  /**
   * Сериализовать Ratio в JSON
   *
   * @param ratio - Ratio для сериализации
   * @returns JSON объект
   *
   * @example
   * ```typescript
   * const ratio = RatioService.fromPercent(2).value;
   * const json = RatioSerializer.toJSON(ratio);
   * console.log(json); // { ratio: "0.02" }
   * ```
   */
  public static toJSON(ratio: Ratio): RatioJSON {
    return {
      ratio: ratio.toDecimal().toString()
    };
  }

  /**
   * Десериализовать Ratio из JSON
   *
   * @param json - JSON объект (unknown type для безопасности)
   * @returns Result с Ratio или InvalidRatioError
   *
   * @example
   * ```typescript
   * const json = { ratio: "0.02" };
   * const result = RatioSerializer.fromJSON(json);
   * if (result.ok) {
   *   console.log(result.value.toDecimal()); // Decimal(0.02)
   * }
   * ```
   */
  public static fromJSON(json: unknown): Result<Ratio, InvalidRatioError> {
    // Validate structure
    if (typeof json !== 'object' || json === null) {
      return Err(
        new InvalidRatioError('Invalid JSON: expected object', {
          context: {
            source: ErrorSource.ADAPTER,
            op: 'fromJSON',
            json: String(json),
            reason: RatioErrorReason.INVALID_JSON_STRUCTURE
          }
        })
      );
    }

    const obj = json as Record<string, unknown>;

    // Validate "ratio" field
    if (typeof obj.ratio !== 'string') {
      return Err(
        new InvalidRatioError('Invalid JSON: "ratio" field must be string', {
          context: {
            source: ErrorSource.ADAPTER,
            op: 'fromJSON',
            json: JSON.stringify(json),
            reason: RatioErrorReason.INVALID_JSON_STRUCTURE
          }
        })
      );
    }

    // Parse ratio value
    const ratioResult = RatioService.fromDecimal(obj.ratio);
    if (isErr(ratioResult)) {
      return ratioResult;
    }

    return Ok(ratioResult.value);
  }
}
```

### 5.3 Создать `src/ratio/adapters/index.ts`

```typescript
export { RatioFormatter } from './RatioFormatter.js';
export { RatioSerializer, RatioJSON } from './RatioSerializer.js';
```

---

## Фаза 6: Module Root (Barrel exports)

### 6.1 Создать `src/ratio/index.ts`

```typescript
/**
 * Ratio module - value object для представления относительных величин
 *
 * @remarks
 * Экспортирует публичный API модуля:
 * - Core: Ratio class, RatioInvariantViolation
 * - Facade: RatioService (primary API)
 * - Adapters: RatioFormatter, RatioSerializer
 * - Errors: RatioErrorReason
 */

// Core (public API)
export { Ratio, RatioInvariantViolation } from './core/index.js';

// Facade (primary API)
export { RatioService, RatioCreateOptions } from './facade/index.js';

// Adapters (public API)
export { RatioFormatter, RatioSerializer, RatioJSON } from './adapters/index.js';

// Errors (public API)
export { RatioErrorReason } from './errors/index.js';
```

### 6.2 Обновить `src/index.ts`

```typescript
// ... existing exports ...

// Ratio модуль (только публичный API)
export {
  Ratio,
  RatioService,
  RatioSerializer,
  RatioFormatter,
  RatioErrorReason
} from './ratio/index.js';
```

### 6.3 Обновить `package.json`

Добавить export path для ratio:

```json
"./ratio": {
  "types": "./dist/ratio/index.d.ts",
  "import": "./dist/ratio/index.js"
}
```

---

## Фаза 7: Tests (Unit + Integration)

### 7.1 Unit Tests Structure

```
__tests__/unit/ratio/
├── core/
│   └── Ratio.test.ts
├── facade/
│   └── RatioService.test.ts
├── adapters/
│   ├── RatioFormatter.test.ts
│   └── RatioSerializer.test.ts
└── rules/
    └── ValidateRatioGteMinusOne.test.ts
```

### 7.2 Создать `__tests__/unit/ratio/core/Ratio.test.ts`

**Тестируемые аспекты:**
- ✅ Успешное создание через `Ratio.of()`
- ❌ Броски исключений при нарушении инвариантов (NaN, non-finite)
- ✅ Методы: `toDecimal()`, `toNumber()`, `onePlus()`
- ✅ Сравнение: `equals()`, `isZero()`, `isPositive()`, `isNegative()`
- ✅ Константы: `Ratio.ZERO`, `Ratio.ONE`

**Примерная структура:**
```typescript
describe('Ratio core', () => {
  describe('инварианты', () => {
    it('NAN - бросает RatioInvariantViolation', () => { ... });
    it('NON_FINITE - бросает RatioInvariantViolation', () => { ... });
  });

  describe('Ratio.of() success', () => {
    it('создает из положительного значения', () => { ... });
    it('создает из отрицательного значения', () => { ... });
    it('создает нулевой Ratio', () => { ... });
  });

  describe('методы доступа', () => {
    it('toDecimal() возвращает Decimal', () => { ... });
    it('toNumber() возвращает number', () => { ... });
    it('onePlus() возвращает 1 + ratio', () => { ... });
  });

  describe('сравнение', () => {
    it('equals() корректно сравнивает', () => { ... });
    it('isZero() определяет нулевое значение', () => { ... });
    it('isPositive() определяет положительное значение', () => { ... });
    it('isNegative() определяет отрицательное значение', () => { ... });
  });

  describe('константы', () => {
    it('ZERO равен 0', () => { ... });
    it('ONE равен 1', () => { ... });
  });
});
```

### 7.3 Создать `__tests__/unit/ratio/facade/RatioService.test.ts`

**Тестируемые аспекты:**
- ✅ `fromDecimal()` - успешное создание и ошибки
- ✅ `fromPercent()` - конверсия процентов
- ✅ `fromBps()` - конверсия basis points
- ✅ Опция `ensureGteMinusOne` - валидация
- ✅ `equals()` - сравнение
- ❌ Обработка ошибок парсинга (NaN, non-finite)
- ✅ Контекст ошибок (reason, op, values)

**Примерная структура:**
```typescript
describe('RatioService', () => {
  describe('fromDecimal()', () => {
    it('создает Ratio из числа', () => { ... });
    it('создает Ratio из строки', () => { ... });
    it('создает Ratio из Decimal', () => { ... });
    it('возвращает Err при NaN', () => { ... });
    it('возвращает Err при Infinity', () => { ... });

    describe('с ensureGteMinusOne', () => {
      it('принимает -1', () => { ... });
      it('принимает -0.5', () => { ... });
      it('отклоняет -1.5', () => { ... });
    });
  });

  describe('fromPercent()', () => {
    it('конвертирует 2% в 0.02', () => { ... });
    it('конвертирует 100% в 1', () => { ... });
    it('конвертирует -10% в -0.1', () => { ... });
  });

  describe('fromBps()', () => {
    it('конвертирует 200 bps в 0.02', () => { ... });
    it('конвертирует 10000 bps в 1', () => { ... });
  });

  describe('equals()', () => {
    it('возвращает true для равных Ratio', () => { ... });
    it('возвращает false для разных Ratio', () => { ... });
  });
});
```

### 7.4 Создать `__tests__/unit/ratio/adapters/RatioFormatter.test.ts`

**Тестируемые аспекты:**
- ✅ `toDecimal()` - форматирование с разными decimals
- ✅ `toPercent()` - форматирование процентов
- ✅ `toBps()` - форматирование basis points
- ✅ `parse()` - парсинг всех форматов
- ❌ Валидация decimals (negative, non-integer) - inline в каждом методе

### 7.5 Создать `__tests__/unit/ratio/adapters/RatioSerializer.test.ts`

**Тестируемые аспекты:**
- ✅ `toJSON()` - сериализация в JSON
- ✅ `fromJSON()` - десериализация из JSON
- ❌ Валидация структуры JSON
- ✅ Round-trip (serialize → deserialize → equals)

### 7.6 Создать `__tests__/unit/ratio/rules/ValidateRatioGteMinusOne.test.ts`

**Тестируемые аспекты:**
- ✅ Принимает значения >= -1
- ❌ Отклоняет значения < -1
- ✅ Граничные случаи: -1, -0.9999, -1.0001

### 7.7 Integration Tests

**Создать `__tests__/integration/ratio/RatioWorkflow.integration.test.ts`**

**Тестируемые сценарии:**
- ✅ Создание → Форматирование → Парсинг → Равенство
- ✅ Создание → Сериализация → Десериализация → Равенство
- ✅ Разные форматы создания (decimal, percent, bps) приводят к одинаковым значениям
- ✅ Использование в расчетах: `amount * (1 + ratio)`
- ✅ Валидация с ensureGteMinusOne в комплексных сценариях

---

## Фаза 8: Documentation

### 8.1 Создать `docs/ratio/README.md`

**Содержание:**
- Введение: что такое Ratio, зачем нужен
- Quick start: основные примеры использования
- Ключевые особенности:
  - Хранит fraction, не percentage
  - Минимальная абстракция
  - Операции живут в целевых value objects
- Архитектура: 4-layer overview
- Ссылки на детальную документацию

### 8.2 Создать `docs/ratio/architecture.md`

**Содержание:**
- Throws+Facade pattern объяснение
- 4-layer architecture diagram (Mermaid)
- Ответственность каждого слоя
- Data flow diagrams
- Архитектурные решения:
  - Почему храним fraction, а не percentage?
  - Почему операции живут в Money/Price/Quantity?
  - Почему минимальная абстракция?
- Сравнение с удаленным Percentage value object

### 8.3 Создать `docs/ratio/core.md`

**Содержание:**
- Полная API reference для Ratio class
- Описание инвариантов
- Методы: `of()`, `toDecimal()`, `toNumber()`, `onePlus()`
- Сравнение: `equals()`, `isZero()`, `isPositive()`, `isNegative()`
- Константы: `ZERO`, `ONE`
- Примеры для каждого метода

### 8.4 Создать `docs/ratio/facade.md`

**Содержание:**
- Полная API reference для RatioService
- Factory methods: `fromDecimal()`, `fromPercent()`, `fromBps()`
- Опции: `RatioCreateOptions`, `ensureGteMinusOne`
- Comparison: `equals()`
- Обработка ошибок: типы ошибок, reason enum
- Never Throw Contract объяснение
- Примеры использования

### 8.5 Создать `docs/ratio/adapters.md`

**Содержание:**
- RatioFormatter API reference
  - `toDecimal()`, `toPercent()`, `toBps()`
  - `parse()` - поддерживаемые форматы
- RatioSerializer API reference
  - `toJSON()`, `fromJSON()`
  - JSON schema
- Примеры для каждого метода

### 8.6 Создать `docs/ratio/examples.md`

**Содержание:**
- Real-world сценарии использования
- Примеры с Money:
  ```typescript
  // Добавить 10% markup к цене
  const markup = RatioService.fromPercent(10).value;
  const newPrice = money.toDecimal().mul(markup.onePlus());
  ```
- Примеры с Price:
  ```typescript
  // Взять 2% fee от суммы
  const fee = RatioService.fromPercent(2).value;
  const feeAmount = price.toDecimal().mul(fee.toDecimal());
  ```
- Примеры с Quantity:
  ```typescript
  // Применить 15% discount к количеству
  const discount = RatioService.fromPercent(-15).value;
  const newQty = qty.toDecimal().mul(discount.onePlus());
  ```
- Примеры форматирования:
  ```typescript
  // Показать пользователю
  const formatted = RatioFormatter.toPercent(ratio, 2).value; // "10.00%"
  ```
- Примеры сериализации:
  ```typescript
  // Сохранить в API
  const json = RatioSerializer.toJSON(ratio); // { ratio: "0.1" }
  ```

### 8.7 Создать `docs/ratio/comparison-with-percentage.md`

**Содержание:**
- Почему Percentage был удален
- Фундаментальная проблема Percentage.add/subtract
- Почему Ratio - правильное решение
- Таблица сравнения:

| Аспект | Percentage (удален) | Ratio (новый) |
|--------|-------------------|---------------|
| Семантика | Неясная (value object?) | Четкая (relative value) |
| Операции | add/subtract (бессмысленно) | Минимум (только вспомогательные) |
| Использование | Standalone | В контексте целевого value object |
| Арифметика | В Percentage классе | В Money/Price/Quantity |

---

## Фаза 9: TSDoc Comments

### 9.1 Правила для TSDoc

Каждый класс/метод должен иметь TSDoc комментарий с:
- **@remarks**: архитектурные решения, алгоритмы, контракты
- **@param**: описание каждого параметра
- **@returns**: что возвращает метод
- **@throws**: какие исключения (только для Core)
- **@example**: пример использования (в блоке ```typescript)

### 9.2 Примеры TSDoc

**Для Core класса:**
```typescript
/**
 * Ratio - value object для представления относительных величин
 *
 * @remarks
 * ## Архитектура
 * - Core слой БРОСАЕТ исключения
 * - Facade слой возвращает Result<T, E>
 *
 * ## Инварианты
 * - Значение не NaN
 * - Значение конечно
 *
 * @see {@link RatioService} для безопасного создания
 *
 * @example
 * ```typescript
 * // ❌ WRONG
 * const ratio = new Ratio(value);
 *
 * // ✅ CORRECT
 * const result = RatioService.fromPercent(2);
 * ```
 */
```

**Для Facade метода:**
```typescript
/**
 * Создать Ratio из процента
 *
 * @param percent - Процент: 2 для 2%
 * @param options - Опции валидации
 * @returns Result с Ratio или InvalidRatioError
 *
 * @example
 * ```typescript
 * const result = RatioService.fromPercent(2);
 * if (result.ok) {
 *   console.log(result.value.toDecimal()); // 0.02
 * }
 * ```
 */
```

---

## Фаза 10: Build & Test

### 10.1 Сборка

```bash
npm run build
```

Должны сгенерироваться:
- `dist/ratio/core/Ratio.js` + `.d.ts`
- `dist/ratio/facade/RatioService.js` + `.d.ts`
- `dist/ratio/adapters/RatioFormatter.js` + `.d.ts`
- `dist/ratio/adapters/RatioSerializer.js` + `.d.ts`
- `dist/ratio/index.js` + `.d.ts`

### 10.2 Type Checking

```bash
npm run typecheck:all
```

Проверяет:
- Типизация src/
- Типизация __tests__/

### 10.3 Linting

```bash
npm run lint:all
```

Проверяет:
- ESLint правила для src/
- ESLint правила для __tests__/

### 10.4 Testing

```bash
npm run test
```

Должны пройти все тесты:
- Unit tests (Core, Facade, Adapters, Rules)
- Integration tests

```bash
npm run test:coverage
```

Проверить покрытие кода тестами (target: > 90%)

### 10.5 CI

```bash
npm run ci:full
```

Полная проверка перед коммитом:
- Typecheck all
- Lint all
- Build
- Test with coverage

---

## Фаза 11: Integration with Existing Value Objects

### 11.1 Обновить Money для работы с Ratio

**Пример метода в Money (будущая реализация):**
```typescript
/**
 * Добавить процент к сумме (amount * (1 + ratio))
 *
 * @param ratio - Коэффициент для добавления
 * @returns Новый Money с увеличенной суммой
 *
 * @example
 * ```typescript
 * const amount = Money.of(new Decimal(100), 'USDC');
 * const markup = RatioService.fromPercent(10).value; // 10%
 * const newAmount = amount.addRate(markup);
 * // newAmount = 110 USDC
 * ```
 */
public addRate(ratio: Ratio): Money {
  const multiplier = ratio.onePlus(); // 1 + ratio
  const newValue = this._amount.mul(multiplier);
  return Money.of(newValue, this._currency);
}
```

### 11.2 Обновить Price для работы с Ratio

**Пример метода в Price (будущая реализация):**
```typescript
/**
 * Взять процент от цены (price * ratio)
 *
 * @param ratio - Коэффициент для взятия
 * @returns Новый Price с уменьшенной суммой
 *
 * @example
 * ```typescript
 * const price = Price.of(new Decimal(0.5));
 * const fee = RatioService.fromPercent(2).value; // 2%
 * const feeAmount = price.take(fee);
 * // feeAmount = 0.01
 * ```
 */
public take(ratio: Ratio): Price {
  const newValue = this._value.mul(ratio.toDecimal());
  return Price.of(newValue);
}
```

### 11.3 Обновить Quantity для работы с Ratio

**Пример метода в Quantity (будущая реализация):**
```typescript
/**
 * Применить скидку к количеству (qty * (1 + ratio))
 *
 * @param ratio - Коэффициент скидки (отрицательный для уменьшения)
 * @returns Новый Quantity с измененным значением
 *
 * @example
 * ```typescript
 * const qty = Quantity.of(new Decimal(100));
 * const discount = RatioService.fromPercent(-15).value; // -15%
 * const newQty = qty.applyDiscount(discount);
 * // newQty = 85
 * ```
 */
public applyDiscount(ratio: Ratio): Quantity {
  const multiplier = ratio.onePlus(); // 1 + ratio
  const newValue = this._value.mul(multiplier);
  return Quantity.of(newValue);
}
```

**Примечание:** Эти методы будут реализованы в отдельной задаче после завершения Ratio value object.

---

## Фаза 12: Final Checklist

### 12.1 Структура файлов
- [ ] `src/ratio/core/Ratio.ts`
- [ ] `src/ratio/core/RatioInvariantViolation.ts`
- [ ] `src/ratio/core/index.ts`
- [ ] `src/ratio/errors/RatioErrorReason.ts`
- [ ] `src/ratio/errors/index.ts`
- [ ] `src/ratio/rules/ValidateRatioGteMinusOne.ts`
- [ ] `src/ratio/rules/index.ts`
- [ ] `src/ratio/facade/RatioService.ts`
- [ ] `src/ratio/facade/index.ts`
- [ ] `src/ratio/adapters/RatioFormatter.ts`
- [ ] `src/ratio/adapters/RatioSerializer.ts`
- [ ] `src/ratio/adapters/index.ts`
- [ ] `src/ratio/index.ts`
- [ ] `src/index.ts` (updated)
- [ ] `package.json` (updated)

### 12.2 Тесты
- [ ] `__tests__/unit/ratio/core/Ratio.test.ts`
- [ ] `__tests__/unit/ratio/facade/RatioService.test.ts`
- [ ] `__tests__/unit/ratio/adapters/RatioFormatter.test.ts`
- [ ] `__tests__/unit/ratio/adapters/RatioSerializer.test.ts`
- [ ] `__tests__/unit/ratio/rules/ValidateRatioGteMinusOne.test.ts`
- [ ] `__tests__/integration/ratio/RatioWorkflow.integration.test.ts`

### 12.3 Документация
- [ ] `docs/ratio/README.md`
- [ ] `docs/ratio/architecture.md`
- [ ] `docs/ratio/core.md`
- [ ] `docs/ratio/facade.md`
- [ ] `docs/ratio/adapters.md`
- [ ] `docs/ratio/examples.md`
- [ ] `docs/ratio/comparison-with-percentage.md`

### 12.4 Качество кода
- [ ] Все TSDoc комментарии добавлены
- [ ] `npm run build` - успешно
- [ ] `npm run typecheck:all` - без ошибок
- [ ] `npm run lint:all` - без ошибок
- [ ] `npm run test` - все тесты проходят
- [ ] `npm run test:coverage` - покрытие > 90%
- [ ] `npm run ci:full` - полная проверка проходит

### 12.5 Интеграция
- [ ] Ratio экспортируется в `src/index.ts`
- [ ] `package.json` содержит `./ratio` export path
- [ ] Можно импортировать: `import { Ratio, RatioService } from '@polymarket/value-objects/ratio'`
- [ ] Можно импортировать: `import { Ratio, RatioService } from '@polymarket/value-objects'`

---

## Ключевые принципы при реализации

1. **Следовать существующим паттернам**
   - Смотреть на Money/Price/Quantity как референс
   - Использовать те же именования, структуру, стиль

2. **Ratio - минимальная абстракция**
   - НЕ добавлять арифметические операции (add, subtract, multiply, divide)
   - Только вспомогательные методы (`onePlus()`, `equals()`, сравнения)
   - Операции живут в Money/Price/Quantity

3. **TSDoc на русском, логи на английском**
   - Все комментарии в коде - русский язык
   - Все сообщения ошибок - английский язык
   - Все describe/it в тестах - русский язык

4. **Result pattern везде**
   - Core бросает исключения
   - Facade возвращает Result<T, E>
   - Never Throw Contract для Facade

5. **Типизированные ошибки**
   - Использовать RatioErrorReason enum
   - Включать context во все ошибки
   - Exhaustive checking возможен

6. **Decimal everywhere**
   - Никогда не использовать `number` для вычислений
   - `toNumber()` только для отображения
   - Всегда Decimal внутри

7. **Immutability**
   - Private readonly fields
   - Все операции создают новые инстансы
   - Никогда не мутировать

---

## Оценка объема работы

**Файлы кода:** ~11 файлов (убран ValidateDecimals)
**Тесты:** ~6 файлов (убран ValidateDecimals.test.ts)
**Документация:** ~7 файлов

**Итого:** ~24 файла

**Строки кода (приблизительно):**
- Core: ~200 строк
- Rules: ~50 строк (только ValidateRatioGteMinusOne)
- Facade: ~250 строк
- Adapters: ~300 строк (inline валидация decimals)
- Tests: ~700 строк
- Documentation: ~2000 строк

**Итого:** ~3500 строк

---

## Порядок реализации (рекомендуемый)

1. **Errors** → RatioErrorReason enum (фундамент для всех слоев)
2. **Core** → Ratio class + RatioInvariantViolation
3. **Rules** → Validators (нужны для Facade)
4. **Facade** → RatioService (основной API)
5. **Adapters** → Formatter + Serializer
6. **Exports** → index.ts файлы, package.json
7. **Tests** → Unit tests (Core → Rules → Facade → Adapters)
8. **Integration Tests** → Комплексные сценарии
9. **Documentation** → Markdown файлы
10. **Quality** → Build, typecheck, lint, test coverage

---

## Следующие шаги после завершения Ratio

1. Интегрировать Ratio в Money (addRate, take)
2. Интегрировать Ratio в Price (applyMarkup, applyDiscount)
3. Интегрировать Ratio в Quantity (applyDiscount)
4. Обновить документацию существующих value objects с примерами использования Ratio
5. Создать migration guide для пользователей (если Percentage использовался где-то)
