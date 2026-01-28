# Percentage Value Object: Детальный план рефакторинга

## Метаданные

- **Value Object:** Percentage
- **Текущий файл:** `packages/domain/value-objects/src/Percentage.ts` (936 lines)
- **Сложность:** Medium (базовая математика, конверсии)
- **Зависимости:** `@polymarket/math`, `@polymarket/errors`, `@polymarket/result`
- **Приоритет:** 🔴 ВЫСОКИЙ (fees, PnL, spreads)

---

## Специфика Percentage

### Характеристики

**Назначение:** Представляет процентные значения с поддержкой разных форматов.

**Диапазон:** `[-1e6, 1e6]` (от -1,000,000% до 1,000,000%)

**Форматы:**
- **Процент** (шкала 0-100): `50` = 50%
- **Десятичная дробь** (шкала 0-1): `0.5` = 50%
- **Базисные пункты** (100 bp = 1%): `5000 bp` = 50%

**Константы:**
```typescript
Percentage.ZERO        = 0%
Percentage.ONE_HUNDRED = 100%
```

### Инварианты (Core Layer)

1. ✅ `value.isFinite()` - не NaN, не Infinity
2. ✅ `value >= MIN_PERCENTAGE` (-1e6)
3. ✅ `value <= MAX_PERCENTAGE` (1e6)

### Бизнес-правила (контекстуальные)

1. 🔶 `value >= 0` (для комиссий)
2. 🔶 `value in [0, 100]` (для некоторых контекстов)
3. 🔶 `value >= minFeeRate` (для минимальной комиссии)

---

## Текущее состояние vs Целевое

### Проблемы текущей реализации

1. **Монолитная структура**: Всё в одном классе (936 строк)
2. **Нет разделения слоёв**: Бизнес-правила смешаны с математикой
3. **Serialization в Core**: `toJSON()`, `toString()` должны быть в Adapters
4. **Нет Policy Layer**: Отсутствуют контекстуальные правила (для fees, spreads)
5. **Нет Service Facade**: Нет централизованной точки для операций

### Целевая архитектура

```
packages/domain/value-objects/
└── percentage/
    ├── core/
    │   ├── Percentage.ts              # Core VO (только инварианты)
    │   └── __tests__/
    │       └── Percentage.test.ts     # 25 тестов
    ├── rules/
    │   ├── ValidateNonNegative.ts     # percentage >= 0
    │   ├── ValidateRange.ts           # percentage in [min, max]
    │   ├── ValidateBasisPoints.ts     # корректные bp
    │   └── __tests__/
    │       └── rules.test.ts          # 20 тестов
    ├── policies/
    │   ├── FeePercentagePolicy.ts     # для комиссий
    │   ├── SpreadPercentagePolicy.ts  # для спредов
    │   └── __tests__/
    │       └── policies.test.ts       # 15 тестов
    ├── facade/
    │   ├── PercentageService.ts       # Orchestration
    │   └── __tests__/
    │       └── PercentageService.test.ts  # 30 тестов
    ├── adapters/
    │   ├── PercentageSerializer.ts    # JSON serialization
    │   ├── PercentageFormatter.ts     # Display formatting
    │   └── __tests__/
    │       └── adapters.test.ts       # 12 тестов
    └── index.ts
```

---

## Core Layer

### Файл: `core/Percentage.ts`

```typescript
import Decimal from 'decimal.js';

/**
 * Percentage - неизменяемый Value Object для процентных значений
 *
 * @remarks
 * **Инварианты (проверяются при создании):**
 * - Значение должно быть конечным (не NaN, не Infinity)
 * - Значение должно быть в диапазоне [-1e6, 1e6]
 *
 * **Не проверяется в Core:**
 * - Неотрицательность (проверяется в Rules/Policy)
 * - Диапазон [0, 100] (проверяется в Policy)
 *
 * **Представления:**
 * - Процент: 50 = 50%
 * - Дробь: 0.5 = 50%
 * - Базисные пункты: 5000 bp = 50%
 *
 * @example
 * ```typescript
 * // Создание через static factory
 * const pct = Percentage.of(new Decimal(50));  // 50%
 *
 * // Использование констант
 * const zero = Percentage.ZERO;        // 0%
 * const full = Percentage.ONE_HUNDRED; // 100%
 *
 * // Доступ к значению
 * pct.value();        // Decimal(50)
 * pct.toDecimal();    // 0.5 (fraction)
 * pct.toBasisPoints(); // 5000
 * ```
 */
export class Percentage {
  /**
   * Максимальное значение: 1,000,000%
   *
   * @remarks
   * Защита от overflow. Достаточно для любых реальных расчётов.
   */
  private static readonly MAX_PERCENTAGE = new Decimal('1e6');

  /**
   * Минимальное значение: -1,000,000%
   *
   * @remarks
   * Поддержка отрицательных значений для PnL, изменений цен.
   */
  private static readonly MIN_PERCENTAGE = new Decimal('-1e6');

  /**
   * Константа: 0%
   */
  public static readonly ZERO = new Percentage(new Decimal(0));

  /**
   * Константа: 100%
   */
  public static readonly ONE_HUNDRED = new Percentage(new Decimal(100));

  /**
   * Private constructor - используйте static factory methods
   *
   * @param v - Значение процента (шкала 0-100)
   * @throws PercentageInvariantViolation если инварианты нарушены
   */
  private constructor(private readonly v: Decimal) {
    // Инвариант 1: Конечность
    if (!v.isFinite()) {
      throw new PercentageInvariantViolation('Percentage must be finite');
    }

    // Инвариант 2: Диапазон
    if (v.lessThan(Percentage.MIN_PERCENTAGE)) {
      throw new PercentageInvariantViolation(
        `Percentage ${v} is less than MIN_PERCENTAGE ${Percentage.MIN_PERCENTAGE}`
      );
    }

    if (v.greaterThan(Percentage.MAX_PERCENTAGE)) {
      throw new PercentageInvariantViolation(
        `Percentage ${v} exceeds MAX_PERCENTAGE ${Percentage.MAX_PERCENTAGE}`
      );
    }
  }

  /**
   * Создать Percentage из Decimal значения
   *
   * @param value - Значение процента (шкала 0-100)
   * @returns Новый Percentage
   * @throws PercentageInvariantViolation если значение невалидно
   *
   * @remarks
   * Этот метод НЕ возвращает Result, т.к. используется для
   * создания после валидации в Service layer.
   *
   * @example
   * ```typescript
   * const pct = Percentage.of(new Decimal(25)); // 25%
   * ```
   */
  public static of(value: Decimal): Percentage {
    return new Percentage(value);
  }

  // ============================================================================
  // Getters
  // ============================================================================

  /**
   * Получить значение как Decimal (шкала 0-100)
   *
   * @returns Decimal значение процента
   *
   * @example
   * ```typescript
   * const pct = Percentage.of(new Decimal(50));
   * pct.value(); // Decimal(50)
   * ```
   */
  public value(): Decimal {
    return this.v;
  }

  /**
   * Преобразовать в десятичную дробь (шкала 0-1)
   *
   * @returns Десятичное представление (0.5 для 50%)
   *
   * @remarks
   * Используется для применения процента к значению:
   * `amount * percentage.toDecimal()`
   *
   * @example
   * ```typescript
   * const pct = Percentage.of(new Decimal(50));
   * pct.toDecimal(); // Decimal(0.5)
   * ```
   */
  public toDecimal(): Decimal {
    return this.v.dividedBy(100);
  }

  /**
   * Преобразовать в базисные пункты (100 bp = 1%)
   *
   * @returns Значение в базисных пунктах
   *
   * @example
   * ```typescript
   * const pct = Percentage.of(new Decimal(2.5));
   * pct.toBasisPoints(); // Decimal(250)
   * ```
   */
  public toBasisPoints(): Decimal {
    return this.v.times(100);
  }

  // ============================================================================
  // Comparison (Value Object требование)
  // ============================================================================

  /**
   * Проверить равенство с допуском epsilon
   *
   * @param other - Другой Percentage
   * @param epsilon - Допустимая погрешность
   * @returns true если значения равны с точностью до epsilon
   *
   * @example
   * ```typescript
   * const a = Percentage.of(new Decimal(10.0001));
   * const b = Percentage.of(new Decimal(10.0002));
   * a.equals(b, new Decimal(0.001)); // true
   * ```
   */
  public equals(other: Percentage, epsilon: Decimal): boolean {
    return this.v.minus(other.v).abs().lessThan(epsilon);
  }

  /**
   * Проверить точное равенство
   *
   * @param other - Другой Percentage
   * @returns true если значения точно равны
   */
  public equalsExact(other: Percentage): boolean {
    return this.v.equals(other.v);
  }

  // ============================================================================
  // Utility Checks
  // ============================================================================

  /**
   * Проверить является ли нулём
   *
   * @returns true если значение равно нулю
   */
  public isZero(): boolean {
    return this.v.isZero();
  }

  /**
   * Проверить является ли положительным
   *
   * @returns true если значение > 0
   */
  public isPositive(): boolean {
    return this.v.greaterThan(0);
  }

  /**
   * Проверить является ли отрицательным
   *
   * @returns true если значение < 0
   */
  public isNegative(): boolean {
    return this.v.isNegative();
  }

  // ============================================================================
  // Math Operations (используют @polymarket/math)
  // ============================================================================

  /**
   * Применить процент к значению
   *
   * @param value - Базовое значение
   * @returns Результат (value * percentage_decimal)
   *
   * @remarks
   * Использует multiplyDecimal из @polymarket/math
   *
   * @example
   * ```typescript
   * import { multiplyDecimal } from '@polymarket/math';
   *
   * const fee = Percentage.of(new Decimal(2.5));  // 2.5%
   * const amount = new Decimal(1000);
   * const feeAmount = fee.applyTo(amount);  // 25
   * ```
   */
  public applyTo(value: Decimal): Decimal {
    // Делегируем в @polymarket/math
    return multiplyDecimal(value, this.toDecimal());
  }
}

/**
 * Ошибка нарушения инварианта Percentage
 *
 * @remarks
 * Выбрасывается из private constructor когда значение нарушает инварианты.
 * Клиентский код НЕ должен ловить эту ошибку - она означает программную ошибку.
 */
export class PercentageInvariantViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PercentageInvariantViolation';
  }
}
```

**Размер:** ~200 строк (вместо 936)

**Что убрали:**
- Все factory methods (`fromValue`, `fromDecimal`, `fromBasisPoints`) → переносим в Service
- Арифметические операции (`add`, `subtract`, `multiply`, `divide`) → переносим в Service
- Сериализация (`toJSON`, `toString`) → переносим в Adapters
- Все validations кроме инвариантов → переносим в Rules/Policy

---

## Math Layer (используем существующий @polymarket/math)

Percentage использует следующие операции из `@polymarket/math`:

```typescript
import {
  addDecimal,
  subtractDecimal,
  multiplyDecimal,
  divideDecimal,
  compareDecimal,
} from '@polymarket/math';
```

**Не создаём новых файлов** - всё уже есть в Math пакете.

---

## Rules Layer

### 1. Файл: `rules/ValidateNonNegative.ts`

```typescript
import { type Result, Ok, Err } from '@polymarket/result';
import { InvalidPercentageError } from '@polymarket/errors';
import Decimal from 'decimal.js';

/**
 * Валидация: процент должен быть неотрицательным
 *
 * @remarks
 * Atomic business rule для контекстов где проценты не могут быть отрицательными:
 * - Комиссии (fees)
 * - Спреды (spreads)
 * - Вероятности
 *
 * @example
 * ```typescript
 * const result = ValidateNonNegative.check(new Decimal(-5));
 * if (!result.ok) {
 *   console.error(result.error.message); // "Percentage cannot be negative: -5"
 * }
 * ```
 */
export class ValidateNonNegative {
  /**
   * Проверить что процент неотрицательный
   *
   * @param value - Значение процента для проверки
   * @returns Ok если >= 0, Err если отрицательный
   */
  public static check(value: Decimal): Result<void, InvalidPercentageError> {
    if (value.isNegative()) {
      return Err(
        new InvalidPercentageError(
          (ctx) => `Percentage cannot be negative: ${ctx.value}`,
          {
            code: InvalidPercentageError.code,
            context: { value: value.toString(), constraint: 'non-negative' }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
```

### 2. Файл: `rules/ValidateRange.ts`

```typescript
import { type Result, Ok, Err } from '@polymarket/result';
import { InvalidPercentageError } from '@polymarket/errors';
import Decimal from 'decimal.js';

/**
 * Валидация: процент должен быть в заданном диапазоне
 *
 * @remarks
 * Atomic business rule для проверки что процент находится в допустимом диапазоне.
 *
 * **Типичные диапазоны:**
 * - [0, 100] - стандартные проценты
 * - [0, 5] - максимальная комиссия
 * - [-100, 100] - изменение цены
 *
 * @example
 * ```typescript
 * const result = ValidateRange.check(
 *   new Decimal(150),
 *   new Decimal(0),
 *   new Decimal(100)
 * );
 * if (!result.ok) {
 *   console.error(result.error.message);
 *   // "Percentage 150 is out of range [0, 100]"
 * }
 * ```
 */
export class ValidateRange {
  /**
   * Проверить что процент в допустимом диапазоне
   *
   * @param value - Значение процента
   * @param min - Минимум (включительно)
   * @param max - Максимум (включительно)
   * @returns Ok если в диапазоне, Err если вне диапазона
   */
  public static check(
    value: Decimal,
    min: Decimal,
    max: Decimal
  ): Result<void, InvalidPercentageError> {
    if (value.lessThan(min) || value.greaterThan(max)) {
      return Err(
        new InvalidPercentageError(
          (ctx) => `Percentage ${ctx.value} is out of range [${ctx.min}, ${ctx.max}]`,
          {
            code: InvalidPercentageError.code,
            context: {
              value: value.toString(),
              min: min.toString(),
              max: max.toString(),
              constraint: 'range'
            }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
```

### 3. Файл: `rules/ValidateBasisPoints.ts`

```typescript
import { type Result, Ok, Err } from '@polymarket/result';
import { InvalidPercentageError } from '@polymarket/errors';
import Decimal from 'decimal.js';

/**
 * Валидация: базисные пункты должны быть валидными
 *
 * @remarks
 * Проверяет что значение базисных пунктов корректно:
 * - Конечное число
 * - Неотрицательное (для большинства случаев)
 * - В допустимом диапазоне
 *
 * @example
 * ```typescript
 * const result = ValidateBasisPoints.check(new Decimal(10001));
 * if (!result.ok) {
 *   console.error(result.error.message);
 *   // "Basis points 10001 exceed maximum 10000 (100%)"
 * }
 * ```
 */
export class ValidateBasisPoints {
  /**
   * Максимальные базисные пункты для стандартных процентов (100% = 10000 bp)
   */
  private static readonly MAX_STANDARD_BP = new Decimal(10000);

  /**
   * Проверить базисные пункты для стандартного диапазона [0, 100%]
   *
   * @param basisPoints - Базисные пункты
   * @returns Ok если валидны, Err если невалидны
   */
  public static checkStandard(basisPoints: Decimal): Result<void, InvalidPercentageError> {
    // Конечность
    if (!basisPoints.isFinite()) {
      return Err(
        new InvalidPercentageError(
          'Basis points must be finite',
          {
            code: InvalidPercentageError.code,
            context: { basisPoints: basisPoints.toString(), constraint: 'finite' }
          }
        )
      );
    }

    // Неотрицательность
    if (basisPoints.isNegative()) {
      return Err(
        new InvalidPercentageError(
          (ctx) => `Basis points cannot be negative: ${ctx.basisPoints}`,
          {
            code: InvalidPercentageError.code,
            context: { basisPoints: basisPoints.toString(), constraint: 'non-negative' }
          }
        )
      );
    }

    // Максимум
    if (basisPoints.greaterThan(ValidateBasisPoints.MAX_STANDARD_BP)) {
      return Err(
        new InvalidPercentageError(
          (ctx) => `Basis points ${ctx.basisPoints} exceed maximum ${ctx.max} (100%)`,
          {
            code: InvalidPercentageError.code,
            context: {
              basisPoints: basisPoints.toString(),
              max: ValidateBasisPoints.MAX_STANDARD_BP.toString(),
              constraint: 'max-standard'
            }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
```

### 4. Файл: `rules/index.ts`

```typescript
export { ValidateNonNegative } from './ValidateNonNegative.js';
export { ValidateRange } from './ValidateRange.js';
export { ValidateBasisPoints } from './ValidateBasisPoints.js';
```

---

## Policy Layer

### 1. Файл: `policies/FeePercentagePolicy.ts`

```typescript
import { type Result, Ok } from '@polymarket/result';
import { InvalidPercentageError } from '@polymarket/errors';
import Decimal from 'decimal.js';
import { ValidateNonNegative } from '../rules/ValidateNonNegative.js';
import { ValidateRange } from '../rules/ValidateRange.js';

/**
 * Policy для валидации процентов комиссий
 *
 * @remarks
 * Комбинирует несколько business rules для контекста комиссий:
 * 1. Комиссия должна быть неотрицательной
 * 2. Комиссия должна быть в допустимом диапазоне [0, maxFee]
 *
 * **Типичные максимумы:**
 * - Trading fee: 5%
 * - Protocol fee: 2%
 * - Referral bonus: 1%
 *
 * @example
 * ```typescript
 * const result = FeePercentagePolicy.validateForTrading(new Decimal(2.5));
 * if (result.ok) {
 *   console.log('Fee is valid for trading');
 * }
 * ```
 */
export class FeePercentagePolicy {
  /**
   * Максимальная торговая комиссия (5%)
   */
  private static readonly MAX_TRADING_FEE = new Decimal(5);

  /**
   * Максимальная протокольная комиссия (2%)
   */
  private static readonly MAX_PROTOCOL_FEE = new Decimal(2);

  /**
   * Валидировать процент для торговой комиссии
   *
   * @param feePercentage - Процент комиссии
   * @returns Ok если валиден, Err с описанием проблемы
   *
   * @remarks
   * Проверки:
   * - Неотрицательный
   * - <= 5% (MAX_TRADING_FEE)
   *
   * @example
   * ```typescript
   * const result = FeePercentagePolicy.validateForTrading(new Decimal(2.5));
   * if (result.ok) {
   *   const pct = PercentageService.create(new Decimal(2.5));
   * }
   * ```
   */
  public static validateForTrading(
    feePercentage: Decimal
  ): Result<void, InvalidPercentageError> {
    // Rule 1: Неотрицательность
    const nonNegResult = ValidateNonNegative.check(feePercentage);
    if (!nonNegResult.ok) {
      return nonNegResult;
    }

    // Rule 2: Диапазон
    const rangeResult = ValidateRange.check(
      feePercentage,
      new Decimal(0),
      FeePercentagePolicy.MAX_TRADING_FEE
    );
    if (!rangeResult.ok) {
      return rangeResult;
    }

    return Ok(undefined);
  }

  /**
   * Валидировать процент для протокольной комиссии
   *
   * @param feePercentage - Процент комиссии
   * @returns Ok если валиден, Err с описанием проблемы
   *
   * @remarks
   * Проверки:
   * - Неотрицательный
   * - <= 2% (MAX_PROTOCOL_FEE)
   */
  public static validateForProtocol(
    feePercentage: Decimal
  ): Result<void, InvalidPercentageError> {
    const nonNegResult = ValidateNonNegative.check(feePercentage);
    if (!nonNegResult.ok) {
      return nonNegResult;
    }

    const rangeResult = ValidateRange.check(
      feePercentage,
      new Decimal(0),
      FeePercentagePolicy.MAX_PROTOCOL_FEE
    );
    if (!rangeResult.ok) {
      return rangeResult;
    }

    return Ok(undefined);
  }

  /**
   * Валидировать общую комиссию (trading + protocol)
   *
   * @param tradingFee - Торговая комиссия
   * @param protocolFee - Протокольная комиссия
   * @returns Ok если валидна, Err если превышает лимит
   *
   * @remarks
   * Проверяет что сумма комиссий не превышает разумный предел.
   */
  public static validateTotalFee(
    tradingFee: Decimal,
    protocolFee: Decimal
  ): Result<void, InvalidPercentageError> {
    const totalFee = tradingFee.plus(protocolFee);

    // Общая комиссия не должна превышать MAX_TRADING_FEE
    const rangeResult = ValidateRange.check(
      totalFee,
      new Decimal(0),
      FeePercentagePolicy.MAX_TRADING_FEE
    );

    return rangeResult;
  }
}
```

### 2. Файл: `policies/SpreadPercentagePolicy.ts`

```typescript
import { type Result, Ok } from '@polymarket/result';
import { InvalidPercentageError } from '@polymarket/errors';
import Decimal from 'decimal.js';
import { ValidateNonNegative } from '../rules/ValidateNonNegative.js';
import { ValidateRange } from '../rules/ValidateRange.js';

/**
 * Policy для валидации процентов спредов
 *
 * @remarks
 * Спред (bid-ask spread) выражается в процентах от mid-price:
 * `spread% = (ask - bid) / mid * 100`
 *
 * **Допустимые диапазоны:**
 * - Нормальный рынок: 0.1% - 2%
 * - Волатильный рынок: 2% - 10%
 * - Неликвидный рынок: 10% - 50%
 *
 * @example
 * ```typescript
 * const result = SpreadPercentagePolicy.validateForNormalMarket(
 *   new Decimal(1.5)
 * );
 * if (result.ok) {
 *   console.log('Spread is acceptable');
 * }
 * ```
 */
export class SpreadPercentagePolicy {
  /**
   * Максимальный спред для нормального рынка (2%)
   */
  private static readonly MAX_NORMAL_SPREAD = new Decimal(2);

  /**
   * Максимальный спред для волатильного рынка (10%)
   */
  private static readonly MAX_VOLATILE_SPREAD = new Decimal(10);

  /**
   * Минимальный допустимый спред (0.01% = 1 bp)
   */
  private static readonly MIN_SPREAD = new Decimal(0.01);

  /**
   * Валидировать спред для нормального рынка
   *
   * @param spreadPercentage - Спред в процентах
   * @returns Ok если валиден, Err если выход за границы
   *
   * @remarks
   * Нормальный рынок: спред в диапазоне [0.01%, 2%]
   */
  public static validateForNormalMarket(
    spreadPercentage: Decimal
  ): Result<void, InvalidPercentageError> {
    // Неотрицательность
    const nonNegResult = ValidateNonNegative.check(spreadPercentage);
    if (!nonNegResult.ok) {
      return nonNegResult;
    }

    // Минимум
    if (spreadPercentage.lessThan(SpreadPercentagePolicy.MIN_SPREAD)) {
      return Err(
        new InvalidPercentageError(
          (ctx) => `Spread ${ctx.value}% is too tight (min ${ctx.min}%)`,
          {
            code: InvalidPercentageError.code,
            context: {
              value: spreadPercentage.toString(),
              min: SpreadPercentagePolicy.MIN_SPREAD.toString(),
              constraint: 'min-spread'
            }
          }
        )
      );
    }

    // Диапазон для нормального рынка
    const rangeResult = ValidateRange.check(
      spreadPercentage,
      SpreadPercentagePolicy.MIN_SPREAD,
      SpreadPercentagePolicy.MAX_NORMAL_SPREAD
    );

    return rangeResult;
  }

  /**
   * Валидировать спред для волатильного рынка
   *
   * @param spreadPercentage - Спред в процентах
   * @returns Ok если валиден, Err если выход за границы
   *
   * @remarks
   * Волатильный рынок: спред в диапазоне [0.01%, 10%]
   */
  public static validateForVolatileMarket(
    spreadPercentage: Decimal
  ): Result<void, InvalidPercentageError> {
    const nonNegResult = ValidateNonNegative.check(spreadPercentage);
    if (!nonNegResult.ok) {
      return nonNegResult;
    }

    const rangeResult = ValidateRange.check(
      spreadPercentage,
      SpreadPercentagePolicy.MIN_SPREAD,
      SpreadPercentagePolicy.MAX_VOLATILE_SPREAD
    );

    return rangeResult;
  }
}
```

### 3. Файл: `policies/index.ts`

```typescript
export { FeePercentagePolicy } from './FeePercentagePolicy.js';
export { SpreadPercentagePolicy } from './SpreadPercentagePolicy.js';
```

---

## Facade Layer

### Файл: `facade/PercentageService.ts`

```typescript
import { type Result, Ok, Err } from '@polymarket/result';
import {
  InvalidPercentageError,
  ArithmeticOverflowError,
  DivisionByZeroError,
} from '@polymarket/errors';
import Decimal from 'decimal.js';
import {
  addDecimal,
  subtractDecimal,
  multiplyDecimal,
  divideDecimal,
} from '@polymarket/math';
import { Percentage } from '../core/Percentage.js';

/**
 * PercentageService - Facade для работы с Percentage
 *
 * @remarks
 * Централизованная точка входа для всех операций с процентами.
 *
 * **Предоставляет:**
 * - Factory methods для создания Percentage из разных форматов
 * - Арифметические операции с Result error handling
 * - Применение процентов к значениям
 * - Конверсии между форматами
 *
 * **Railway-Oriented Programming:**
 * Все fallible операции возвращают Result<T, E> для композиции.
 *
 * @example
 * ```typescript
 * import { PercentageService } from '@polymarket/value-objects/percentage';
 * import { unwrap } from '@polymarket/result';
 *
 * // Создание процента
 * const feeResult = PercentageService.create(new Decimal(2.5));
 * const fee = unwrap(feeResult); // 2.5%
 *
 * // Применение к значению
 * const orderValue = new Decimal(1000);
 * const feeAmount = PercentageService.applyToValue(fee, orderValue);
 * console.log(feeAmount); // 25
 *
 * // Арифметика
 * const total = PercentageService.add(
 *   unwrap(PercentageService.create(new Decimal(2.5))),
 *   unwrap(PercentageService.create(new Decimal(1.5)))
 * );
 * console.log(unwrap(total).value()); // 4
 * ```
 */
export class PercentageService {
  // ============================================================================
  // Factory Methods
  // ============================================================================

  /**
   * Создать Percentage из значения (шкала 0-100)
   *
   * @param value - Значение процента или Decimal
   * @returns Result с Percentage или InvalidPercentageError
   *
   * @remarks
   * Универсальный метод создания. Принимает:
   * - number: `25` = 25%
   * - string: `"25"` или `"25%"` = 25%
   * - Decimal: `new Decimal(25)` = 25%
   *
   * **Валидации:**
   * - Парсинг строки (убирает символ '%')
   * - Конечность (не NaN, не Infinity)
   * - Диапазон [-1e6, 1e6]
   *
   * @example
   * ```typescript
   * const p1 = PercentageService.create(25);           // 25%
   * const p2 = PercentageService.create("25%");        // 25%
   * const p3 = PercentageService.create(new Decimal(25)); // 25%
   *
   * const errorResult = PercentageService.create(NaN);
   * if (!errorResult.ok) {
   *   console.error(errorResult.error.message);
   * }
   * ```
   */
  public static create(
    value: number | string | Decimal
  ): Result<Percentage, InvalidPercentageError> {
    try {
      // Преобразуем в Decimal
      let decimalValue: Decimal;

      if (value instanceof Decimal) {
        decimalValue = value;
      } else if (typeof value === 'string') {
        // Убираем символ % если есть
        const cleaned = value.replace('%', '').trim();
        decimalValue = new Decimal(cleaned);
      } else {
        decimalValue = new Decimal(value);
      }

      // Проверки выполняются в constructor Percentage
      return Ok(Percentage.of(decimalValue));
    } catch (error) {
      // Ловим PercentageInvariantViolation и преобразуем в InvalidPercentageError
      if (error instanceof Error) {
        return Err(
          new InvalidPercentageError(
            error.message,
            {
              code: InvalidPercentageError.code,
              context: { value: String(value), error: error.message }
            }
          )
        );
      }

      return Err(
        new InvalidPercentageError(
          `Invalid percentage value: ${String(value)}`,
          {
            code: InvalidPercentageError.code,
            context: { value: String(value) }
          }
        )
      );
    }
  }

  /**
   * Создать Percentage из десятичной дроби (шкала 0-1)
   *
   * @param decimal - Десятичная дробь (0.5 = 50%)
   * @returns Result с Percentage или InvalidPercentageError
   *
   * @remarks
   * Преобразует десятичную дробь в процент: `0.5 → 50%`
   *
   * @example
   * ```typescript
   * const pct = PercentageService.fromDecimal(0.5);   // 50%
   * const fee = PercentageService.fromDecimal(0.025); // 2.5%
   * ```
   */
  public static fromDecimal(
    decimal: number | Decimal
  ): Result<Percentage, InvalidPercentageError> {
    try {
      const decimalValue = decimal instanceof Decimal ? decimal : new Decimal(decimal);

      // Конечность
      if (!decimalValue.isFinite()) {
        return Err(
          new InvalidPercentageError(
            'Decimal value must be finite',
            {
              code: InvalidPercentageError.code,
              context: { decimal: String(decimal), reason: 'not finite' }
            }
          )
        );
      }

      // Умножаем на 100 чтобы получить процент
      const percentage = decimalValue.times(100);
      return PercentageService.create(percentage);
    } catch (error) {
      return Err(
        new InvalidPercentageError(
          `Invalid decimal value: ${String(decimal)}`,
          {
            code: InvalidPercentageError.code,
            context: { decimal: String(decimal), error: String(error) }
          }
        )
      );
    }
  }

  /**
   * Создать Percentage из базисных пунктов (100 bp = 1%)
   *
   * @param bps - Базисные пункты
   * @returns Result с Percentage или InvalidPercentageError
   *
   * @remarks
   * Преобразует базисные пункты в процент: `250 bp → 2.5%`
   *
   * @example
   * ```typescript
   * const pct = PercentageService.fromBasisPoints(250); // 2.5%
   * const fee = PercentageService.fromBasisPoints(50);  // 0.5%
   * ```
   */
  public static fromBasisPoints(
    bps: number | Decimal
  ): Result<Percentage, InvalidPercentageError> {
    try {
      const bpsDecimal = bps instanceof Decimal ? bps : new Decimal(bps);

      // Конечность
      if (!bpsDecimal.isFinite()) {
        return Err(
          new InvalidPercentageError(
            'Basis points must be finite',
            {
              code: InvalidPercentageError.code,
              context: { bps: String(bps), reason: 'not finite' }
            }
          )
        );
      }

      // Делим на 100 чтобы получить процент
      const percentage = bpsDecimal.dividedBy(100);
      return PercentageService.create(percentage);
    } catch (error) {
      return Err(
        new InvalidPercentageError(
          `Invalid basis points: ${String(bps)}`,
          {
            code: InvalidPercentageError.code,
            context: { bps: String(bps), error: String(error) }
          }
        )
      );
    }
  }

  // ============================================================================
  // Constants
  // ============================================================================

  /**
   * Получить нулевой процент (0%)
   *
   * @returns Percentage со значением 0%
   */
  public static zero(): Percentage {
    return Percentage.ZERO;
  }

  /**
   * Получить 100%
   *
   * @returns Percentage со значением 100%
   */
  public static oneHundred(): Percentage {
    return Percentage.ONE_HUNDRED;
  }

  // ============================================================================
  // Arithmetic Operations
  // ============================================================================

  /**
   * Сложить два процента
   *
   * @param a - Первый процент
   * @param b - Второй процент
   * @returns Result с суммой или ArithmeticOverflowError
   *
   * @remarks
   * Использует addDecimal из @polymarket/math для точных вычислений.
   * Проверяет overflow (результат > MAX_PERCENTAGE).
   *
   * @example
   * ```typescript
   * const fee = unwrap(PercentageService.create(new Decimal(2.5)));
   * const markup = unwrap(PercentageService.create(new Decimal(1.5)));
   * const total = PercentageService.add(fee, markup);
   * console.log(unwrap(total).value()); // 4
   * ```
   */
  public static add(
    a: Percentage,
    b: Percentage
  ): Result<Percentage, ArithmeticOverflowError> {
    const result = addDecimal(a.value(), b.value());

    // Проверка overflow
    if (result.greaterThan(new Decimal('1e6'))) {
      return Err(
        new ArithmeticOverflowError(
          (ctx) => `Addition overflow: ${ctx.a} + ${ctx.b} = ${ctx.result} exceeds max`,
          {
            context: {
              operation: 'add',
              a: a.value().toString(),
              b: b.value().toString(),
              result: result.toString()
            }
          }
        )
      );
    }

    // Проверка underflow
    if (result.lessThan(new Decimal('-1e6'))) {
      return Err(
        new ArithmeticOverflowError(
          (ctx) => `Addition underflow: ${ctx.a} + ${ctx.b} = ${ctx.result} below min`,
          {
            context: {
              operation: 'add',
              a: a.value().toString(),
              b: b.value().toString(),
              result: result.toString()
            }
          }
        )
      );
    }

    return Ok(Percentage.of(result));
  }

  /**
   * Вычесть один процент из другого
   *
   * @param a - Уменьшаемое
   * @param b - Вычитаемое
   * @returns Result с разностью или ArithmeticOverflowError
   *
   * @example
   * ```typescript
   * const total = unwrap(PercentageService.create(new Decimal(4)));
   * const fee = unwrap(PercentageService.create(new Decimal(2.5)));
   * const net = PercentageService.subtract(total, fee);
   * console.log(unwrap(net).value()); // 1.5
   * ```
   */
  public static subtract(
    a: Percentage,
    b: Percentage
  ): Result<Percentage, ArithmeticOverflowError> {
    const result = subtractDecimal(a.value(), b.value());

    // Проверка overflow/underflow
    if (result.greaterThan(new Decimal('1e6')) || result.lessThan(new Decimal('-1e6'))) {
      return Err(
        new ArithmeticOverflowError(
          (ctx) => `Subtraction result ${ctx.result} is out of range`,
          {
            context: {
              operation: 'subtract',
              a: a.value().toString(),
              b: b.value().toString(),
              result: result.toString()
            }
          }
        )
      );
    }

    return Ok(Percentage.of(result));
  }

  /**
   * Умножить процент на коэффициент
   *
   * @param percentage - Процент
   * @param factor - Коэффициент
   * @returns Result с произведением или ArithmeticOverflowError
   *
   * @example
   * ```typescript
   * const base = unwrap(PercentageService.create(new Decimal(10)));
   * const doubled = PercentageService.multiply(base, new Decimal(2));
   * console.log(unwrap(doubled).value()); // 20
   * ```
   */
  public static multiply(
    percentage: Percentage,
    factor: Decimal
  ): Result<Percentage, ArithmeticOverflowError> {
    try {
      const result = multiplyDecimal(percentage.value(), factor);

      // Конечность
      if (!result.isFinite()) {
        return Err(
          new ArithmeticOverflowError(
            'Multiplication resulted in non-finite value',
            {
              context: {
                operation: 'multiply',
                percentage: percentage.value().toString(),
                factor: factor.toString()
              }
            }
          )
        );
      }

      // Диапазон
      if (result.abs().greaterThan(new Decimal('1e6'))) {
        return Err(
          new ArithmeticOverflowError(
            (ctx) => `Multiplication overflow: ${ctx.percentage} * ${ctx.factor} = ${ctx.result}`,
            {
              context: {
                operation: 'multiply',
                percentage: percentage.value().toString(),
                factor: factor.toString(),
                result: result.toString()
              }
            }
          )
        );
      }

      return Ok(Percentage.of(result));
    } catch (error) {
      return Err(
        new ArithmeticOverflowError(
          `Multiplication error: ${error}`,
          { context: { error: String(error) } }
        )
      );
    }
  }

  /**
   * Разделить процент на делитель
   *
   * @param percentage - Процент
   * @param divisor - Делитель
   * @returns Result с частным или DivisionByZeroError/ArithmeticOverflowError
   *
   * @example
   * ```typescript
   * const total = unwrap(PercentageService.create(new Decimal(20)));
   * const half = PercentageService.divide(total, new Decimal(2));
   * console.log(unwrap(half).value()); // 10
   * ```
   */
  public static divide(
    percentage: Percentage,
    divisor: Decimal
  ): Result<Percentage, DivisionByZeroError | ArithmeticOverflowError> {
    try {
      // Проверка делителя
      if (!divisor.isFinite()) {
        return Err(
          new DivisionByZeroError(
            (ctx) => `Invalid divisor ${ctx.divisor}: must be finite`,
            {
              context: {
                percentage: percentage.value().toString(),
                divisor: divisor.toString(),
                operation: 'divide percentage'
              }
            }
          )
        );
      }

      if (divisor.isZero()) {
        return Err(
          new DivisionByZeroError(
            (ctx) => `Cannot divide percentage ${ctx.percentage} by zero`,
            {
              context: {
                percentage: percentage.value().toString(),
                divisor: 0,
                operation: 'divide percentage'
              }
            }
          )
        );
      }

      const result = divideDecimal(percentage.value(), divisor);

      // Конечность результата
      if (!result.isFinite()) {
        return Err(
          new DivisionByZeroError(
            'Division resulted in non-finite value',
            {
              context: {
                percentage: percentage.value().toString(),
                divisor: divisor.toString(),
                result: result.toString()
              }
            }
          )
        );
      }

      // Диапазон результата
      if (result.abs().greaterThan(new Decimal('1e6'))) {
        return Err(
          new ArithmeticOverflowError(
            (ctx) => `Division result ${ctx.result} exceeds limits`,
            {
              context: {
                percentage: percentage.value().toString(),
                divisor: divisor.toString(),
                result: result.toString()
              }
            }
          )
        );
      }

      return Ok(Percentage.of(result));
    } catch (error) {
      return Err(
        new ArithmeticOverflowError(
          `Division error: ${error}`,
          { context: { error: String(error) } }
        )
      );
    }
  }

  // ============================================================================
  // Application
  // ============================================================================

  /**
   * Применить процент к значению
   *
   * @param percentage - Процент
   * @param value - Базовое значение
   * @returns Результат (value * percentage_decimal)
   *
   * @remarks
   * Вычисляет процентную долю от значения.
   * Использует Percentage.applyTo(), который делегирует в @polymarket/math.
   *
   * @example
   * ```typescript
   * const fee = unwrap(PercentageService.create(new Decimal(2.5)));
   * const orderValue = new Decimal(1000);
   * const feeAmount = PercentageService.applyToValue(fee, orderValue);
   * console.log(feeAmount.toString()); // "25"
   * ```
   */
  public static applyToValue(percentage: Percentage, value: Decimal): Decimal {
    return percentage.applyTo(value);
  }
}
```

**Размер:** ~400 строк

---

## Adapters Layer

### 1. Файл: `adapters/PercentageSerializer.ts`

```typescript
import { type Result, Ok, Err } from '@polymarket/result';
import { InvalidPercentageError } from '@polymarket/errors';
import { Percentage } from '../core/Percentage.js';
import { PercentageService } from '../facade/PercentageService.js';

/**
 * DTO для сериализации Percentage
 */
export interface PercentageDTO {
  /**
   * Значение процента (шкала 0-100)
   */
  value: number;
}

/**
 * Сериализатор для Percentage
 *
 * @remarks
 * Отвечает за преобразование между Percentage и JSON.
 * Отделяет технические детали сериализации от domain логики.
 *
 * @example
 * ```typescript
 * const pct = unwrap(PercentageService.create(new Decimal(25.5)));
 *
 * // Serialize
 * const dto = PercentageSerializer.toDTO(pct);
 * console.log(dto); // { value: 25.5 }
 *
 * // Deserialize
 * const result = PercentageSerializer.fromDTO(dto);
 * if (result.ok) {
 *   console.log(result.value.value()); // 25.5
 * }
 * ```
 */
export class PercentageSerializer {
  /**
   * Сериализовать Percentage в DTO
   *
   * @param percentage - Percentage для сериализации
   * @returns DTO объект
   */
  public static toDTO(percentage: Percentage): PercentageDTO {
    return {
      value: percentage.value().toNumber(),
    };
  }

  /**
   * Десериализовать Percentage из DTO
   *
   * @param dto - DTO объект
   * @returns Result с Percentage или InvalidPercentageError
   */
  public static fromDTO(dto: PercentageDTO): Result<Percentage, InvalidPercentageError> {
    return PercentageService.create(dto.value);
  }

  /**
   * Сериализовать в JSON строку
   *
   * @param percentage - Percentage для сериализации
   * @returns JSON строка
   */
  public static toJSON(percentage: Percentage): string {
    return JSON.stringify(PercentageSerializer.toDTO(percentage));
  }

  /**
   * Десериализовать из JSON строки
   *
   * @param json - JSON строка
   * @returns Result с Percentage или InvalidPercentageError
   */
  public static fromJSON(json: string): Result<Percentage, InvalidPercentageError> {
    try {
      const dto = JSON.parse(json) as PercentageDTO;
      return PercentageSerializer.fromDTO(dto);
    } catch (error) {
      return Err(
        new InvalidPercentageError(
          `Invalid JSON: ${error}`,
          {
            code: InvalidPercentageError.code,
            context: { json, error: String(error) }
          }
        )
      );
    }
  }
}
```

### 2. Файл: `adapters/PercentageFormatter.ts`

```typescript
import Decimal from 'decimal.js';
import { Percentage } from '../core/Percentage.js';

/**
 * Опции форматирования для процентов
 */
export interface PercentageFormatOptions {
  /**
   * Количество десятичных знаков (по умолчанию 2)
   */
  decimals?: number;

  /**
   * Включить символ % (по умолчанию true)
   */
  includeSymbol?: boolean;

  /**
   * Использовать знак + для положительных значений (по умолчанию false)
   */
  showPlusSign?: boolean;

  /**
   * Формат вывода (по умолчанию 'percentage')
   */
  format?: 'percentage' | 'decimal' | 'basisPoints';
}

/**
 * Форматтер для Percentage
 *
 * @remarks
 * Отвечает за представление Percentage в виде строк для UI.
 * Отделяет технические детали форматирования от domain логики.
 *
 * @example
 * ```typescript
 * const pct = unwrap(PercentageService.create(new Decimal(25.5)));
 *
 * // Стандартное форматирование
 * PercentageFormatter.format(pct); // "25.50%"
 *
 * // Без знака процента
 * PercentageFormatter.format(pct, { includeSymbol: false }); // "25.50"
 *
 * // С + для положительных
 * PercentageFormatter.format(pct, { showPlusSign: true }); // "+25.50%"
 *
 * // В базисных пунктах
 * PercentageFormatter.format(pct, { format: 'basisPoints' }); // "2550 bp"
 * ```
 */
export class PercentageFormatter {
  /**
   * Форматировать Percentage в строку
   *
   * @param percentage - Percentage для форматирования
   * @param options - Опции форматирования
   * @returns Отформатированная строка
   */
  public static format(
    percentage: Percentage,
    options: PercentageFormatOptions = {}
  ): string {
    const {
      decimals = 2,
      includeSymbol = true,
      showPlusSign = false,
      format = 'percentage',
    } = options;

    let value: Decimal;
    let symbol = '';

    // Выбираем представление
    switch (format) {
      case 'percentage':
        value = percentage.value();
        symbol = includeSymbol ? '%' : '';
        break;

      case 'decimal':
        value = percentage.toDecimal();
        symbol = '';
        break;

      case 'basisPoints':
        value = percentage.toBasisPoints();
        symbol = includeSymbol ? ' bp' : '';
        break;
    }

    // Форматируем число
    const formatted = value.toFixed(decimals);

    // Добавляем знак +
    if (showPlusSign && value.greaterThan(0)) {
      return `+${formatted}${symbol}`;
    }

    return `${formatted}${symbol}`;
  }

  /**
   * Форматировать как процент с символом %
   *
   * @param percentage - Percentage для форматирования
   * @param decimals - Количество десятичных знаков
   * @returns Строка вида "25.50%"
   */
  public static toPercentageString(percentage: Percentage, decimals: number = 2): string {
    return PercentageFormatter.format(percentage, { decimals, format: 'percentage' });
  }

  /**
   * Форматировать как десятичную дробь
   *
   * @param percentage - Percentage для форматирования
   * @param decimals - Количество десятичных знаков
   * @returns Строка вида "0.255"
   */
  public static toDecimalString(percentage: Percentage, decimals: number = 3): string {
    return PercentageFormatter.format(percentage, { decimals, format: 'decimal', includeSymbol: false });
  }

  /**
   * Форматировать как базисные пункты
   *
   * @param percentage - Percentage для форматирования
   * @returns Строка вида "2550 bp"
   */
  public static toBasisPointsString(percentage: Percentage): string {
    return PercentageFormatter.format(percentage, { decimals: 0, format: 'basisPoints' });
  }

  /**
   * Форматировать для изменений (с + для положительных)
   *
   * @param percentage - Percentage для форматирования
   * @param decimals - Количество десятичных знаков
   * @returns Строка вида "+5.25%" или "-2.50%"
   */
  public static formatChange(percentage: Percentage, decimals: number = 2): string {
    return PercentageFormatter.format(percentage, {
      decimals,
      format: 'percentage',
      showPlusSign: true,
    });
  }
}
```

### 3. Файл: `adapters/index.ts`

```typescript
export { PercentageSerializer, type PercentageDTO } from './PercentageSerializer.js';
export { PercentageFormatter, type PercentageFormatOptions } from './PercentageFormatter.js';
```

---

## Index Exports

### Файл: `percentage/index.ts`

```typescript
// Core
export { Percentage, PercentageInvariantViolation } from './core/Percentage.js';

// Rules
export {
  ValidateNonNegative,
  ValidateRange,
  ValidateBasisPoints,
} from './rules/index.js';

// Policies
export {
  FeePercentagePolicy,
  SpreadPercentagePolicy,
} from './policies/index.js';

// Facade
export { PercentageService } from './facade/PercentageService.js';

// Adapters
export {
  PercentageSerializer,
  type PercentageDTO,
  PercentageFormatter,
  type PercentageFormatOptions,
} from './adapters/index.js';
```

---

## Детальный план по фазам

| Фаза | Описание | Файлы | Время |
|------|----------|-------|-------|
| **0** | Подготовка структуры | Создать директории, package.json | 10 мин |
| **1** | Core Layer | `core/Percentage.ts` + tests | 40 мин |
| **2** | Rules Layer | `rules/*.ts` + tests | 45 мин |
| **3** | Policy Layer | `policies/*.ts` + tests | 40 мин |
| **4** | Facade Layer | `facade/PercentageService.ts` + tests | 1 час |
| **5** | Adapters Layer | `adapters/*.ts` + tests | 30 мин |
| **6** | Index exports | `index.ts` | 5 мин |
| **7** | Integration тесты | `__tests__/integration/*.test.ts` | 30 мин |
| **8** | Документация | `README.md` | 20 мин |
| **9** | Package exports | Обновить package.json | 5 мин |
| **Итого** | | | **~4.5 часа** |

---

## План тестирования

| Слой | Unit Tests | Описание |
|------|------------|----------|
| **Core** | 25 | Инварианты, константы, getters, comparison |
| **Rules** | 20 | Каждое правило со всеми edge cases |
| **Policy** | 15 | Комбинации rules для разных контекстов |
| **Facade** | 30 | Factory methods, арифметика, Result handling |
| **Adapters** | 12 | Serialization, formatting |
| **Integration** | 18 | Полные сценарии (fee calculation, spread validation) |
| **TOTAL** | **120** | |

### Примеры тестов

#### Core Tests (`core/__tests__/Percentage.test.ts`)

```typescript
describe('Percentage Core', () => {
  describe('constructor invariants', () => {
    it('should throw on NaN', () => {
      expect(() => Percentage.of(new Decimal(NaN))).toThrow(PercentageInvariantViolation);
    });

    it('should throw on Infinity', () => {
      expect(() => Percentage.of(new Decimal(Infinity))).toThrow(PercentageInvariantViolation);
    });

    it('should throw if value < MIN_PERCENTAGE', () => {
      expect(() => Percentage.of(new Decimal(-2e6))).toThrow(PercentageInvariantViolation);
    });

    it('should throw if value > MAX_PERCENTAGE', () => {
      expect(() => Percentage.of(new Decimal(2e6))).toThrow(PercentageInvariantViolation);
    });

    it('should accept valid negative value', () => {
      expect(() => Percentage.of(new Decimal(-50))).not.toThrow();
    });
  });

  describe('constants', () => {
    it('ZERO should be 0%', () => {
      expect(Percentage.ZERO.value().toNumber()).toBe(0);
    });

    it('ONE_HUNDRED should be 100%', () => {
      expect(Percentage.ONE_HUNDRED.value().toNumber()).toBe(100);
    });
  });

  describe('getters', () => {
    it('toDecimal should convert to fraction', () => {
      const pct = Percentage.of(new Decimal(50));
      expect(pct.toDecimal().toNumber()).toBe(0.5);
    });

    it('toBasisPoints should convert to bp', () => {
      const pct = Percentage.of(new Decimal(2.5));
      expect(pct.toBasisPoints().toNumber()).toBe(250);
    });
  });

  describe('comparison', () => {
    it('equals should work with epsilon', () => {
      const a = Percentage.of(new Decimal(10.001));
      const b = Percentage.of(new Decimal(10.002));
      expect(a.equals(b, new Decimal(0.01))).toBe(true);
    });

    it('equalsExact should be precise', () => {
      const a = Percentage.of(new Decimal(10.001));
      const b = Percentage.of(new Decimal(10.002));
      expect(a.equalsExact(b)).toBe(false);
    });
  });
});
```

#### Rules Tests (`rules/__tests__/rules.test.ts`)

```typescript
describe('Percentage Rules', () => {
  describe('ValidateNonNegative', () => {
    it('should pass for positive value', () => {
      const result = ValidateNonNegative.check(new Decimal(5));
      expect(result.ok).toBe(true);
    });

    it('should pass for zero', () => {
      const result = ValidateNonNegative.check(new Decimal(0));
      expect(result.ok).toBe(true);
    });

    it('should fail for negative value', () => {
      const result = ValidateNonNegative.check(new Decimal(-5));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidPercentageError);
      }
    });
  });

  describe('ValidateRange', () => {
    it('should pass for value in range', () => {
      const result = ValidateRange.check(
        new Decimal(50),
        new Decimal(0),
        new Decimal(100)
      );
      expect(result.ok).toBe(true);
    });

    it('should fail for value below min', () => {
      const result = ValidateRange.check(
        new Decimal(-1),
        new Decimal(0),
        new Decimal(100)
      );
      expect(result.ok).toBe(false);
    });

    it('should fail for value above max', () => {
      const result = ValidateRange.check(
        new Decimal(101),
        new Decimal(0),
        new Decimal(100)
      );
      expect(result.ok).toBe(false);
    });
  });
});
```

#### Policy Tests (`policies/__tests__/policies.test.ts`)

```typescript
describe('FeePercentagePolicy', () => {
  describe('validateForTrading', () => {
    it('should accept valid trading fee', () => {
      const result = FeePercentagePolicy.validateForTrading(new Decimal(2.5));
      expect(result.ok).toBe(true);
    });

    it('should reject negative fee', () => {
      const result = FeePercentagePolicy.validateForTrading(new Decimal(-1));
      expect(result.ok).toBe(false);
    });

    it('should reject fee > MAX_TRADING_FEE', () => {
      const result = FeePercentagePolicy.validateForTrading(new Decimal(6));
      expect(result.ok).toBe(false);
    });
  });

  describe('validateTotalFee', () => {
    it('should accept valid total', () => {
      const result = FeePercentagePolicy.validateTotalFee(
        new Decimal(2.5),
        new Decimal(1.5)
      );
      expect(result.ok).toBe(true);
    });

    it('should reject excessive total', () => {
      const result = FeePercentagePolicy.validateTotalFee(
        new Decimal(3),
        new Decimal(3)
      );
      expect(result.ok).toBe(false);
    });
  });
});
```

#### Facade Tests (`facade/__tests__/PercentageService.test.ts`)

```typescript
describe('PercentageService', () => {
  describe('create', () => {
    it('should create from number', () => {
      const result = PercentageService.create(25);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(25);
      }
    });

    it('should create from string with %', () => {
      const result = PercentageService.create('25%');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(25);
      }
    });

    it('should fail for invalid value', () => {
      const result = PercentageService.create(NaN);
      expect(result.ok).toBe(false);
    });
  });

  describe('fromDecimal', () => {
    it('should convert 0.5 to 50%', () => {
      const result = PercentageService.fromDecimal(0.5);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(50);
      }
    });
  });

  describe('add', () => {
    it('should add two percentages', () => {
      const a = unwrap(PercentageService.create(new Decimal(2.5)));
      const b = unwrap(PercentageService.create(new Decimal(1.5)));
      const result = PercentageService.add(a, b);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(4);
      }
    });

    it('should detect overflow', () => {
      const a = unwrap(PercentageService.create(new Decimal(9e5)));
      const b = unwrap(PercentageService.create(new Decimal(9e5)));
      const result = PercentageService.add(a, b);
      expect(result.ok).toBe(false);
    });
  });

  describe('applyToValue', () => {
    it('should calculate percentage of value', () => {
      const pct = unwrap(PercentageService.create(new Decimal(2.5)));
      const value = new Decimal(1000);
      const result = PercentageService.applyToValue(pct, value);
      expect(result.toNumber()).toBe(25);
    });
  });
});
```

#### Integration Tests (`__tests__/integration/percentage.integration.test.ts`)

```typescript
describe('Percentage Integration', () => {
  describe('fee calculation scenario', () => {
    it('should calculate total fee for order', () => {
      // Given
      const orderValue = new Decimal(10000);
      const tradingFeeRate = new Decimal(2.5);  // 2.5%
      const protocolFeeRate = new Decimal(0.5);  // 0.5%

      // Validate fees
      const tradingValidation = FeePercentagePolicy.validateForTrading(tradingFeeRate);
      expect(tradingValidation.ok).toBe(true);

      const protocolValidation = FeePercentagePolicy.validateForProtocol(protocolFeeRate);
      expect(protocolValidation.ok).toBe(true);

      // Create percentages
      const tradingFee = unwrap(PercentageService.create(tradingFeeRate));
      const protocolFee = unwrap(PercentageService.create(protocolFeeRate));

      // Calculate fee amounts
      const tradingAmount = PercentageService.applyToValue(tradingFee, orderValue);
      const protocolAmount = PercentageService.applyToValue(protocolFee, orderValue);

      // Verify
      expect(tradingAmount.toNumber()).toBe(250);   // 2.5% of 10000
      expect(protocolAmount.toNumber()).toBe(50);   // 0.5% of 10000

      // Total fee
      const totalFee = unwrap(PercentageService.add(tradingFee, protocolFee));
      const totalAmount = PercentageService.applyToValue(totalFee, orderValue);
      expect(totalAmount.toNumber()).toBe(300);  // 3% of 10000
    });
  });

  describe('spread validation scenario', () => {
    it('should validate bid-ask spread percentage', () => {
      // Given
      const bid = new Decimal(0.45);
      const ask = new Decimal(0.46);
      const mid = bid.plus(ask).dividedBy(2);  // 0.455

      // Calculate spread percentage
      const spreadValue = ask.minus(bid);  // 0.01
      const spreadPct = spreadValue.dividedBy(mid).times(100);  // 2.198%

      // Validate
      const validation = SpreadPercentagePolicy.validateForNormalMarket(spreadPct);
      expect(validation.ok).toBe(true);

      // Create percentage
      const spread = unwrap(PercentageService.create(spreadPct));
      expect(spread.value().toNumber()).toBeCloseTo(2.198, 2);
    });
  });
});
```

---

## Миграция

### До (текущий код)

```typescript
import { Percentage } from '@polymarket/value-objects';

// Создание
const fee = Percentage.fromValue(2.5);
const gain = Percentage.fromDecimal(0.15);

// Использование
fee.match({
  ok: (pct) => {
    const total = pct.add(gain);
    // ...
  },
  err: (error) => console.error(error)
});

// Сериализация
const json = pct.toJSON();
```

### После (новая архитектура)

```typescript
import {
  PercentageService,
  FeePercentagePolicy,
  PercentageSerializer,
  PercentageFormatter,
} from '@polymarket/value-objects/percentage';
import { unwrap } from '@polymarket/result';

// Создание через Service
const feeResult = PercentageService.create(new Decimal(2.5));
const fee = unwrap(feeResult);

const gainResult = PercentageService.fromDecimal(0.15);
const gain = unwrap(gainResult);

// Валидация через Policy
const validation = FeePercentagePolicy.validateForTrading(new Decimal(2.5));
if (validation.ok) {
  const fee = unwrap(PercentageService.create(new Decimal(2.5)));
}

// Арифметика через Service
const totalResult = PercentageService.add(fee, gain);
const total = unwrap(totalResult);

// Сериализация через Adapter
const dto = PercentageSerializer.toDTO(fee);
const json = PercentageSerializer.toJSON(fee);

// Форматирование через Adapter
const str = PercentageFormatter.format(fee);  // "2.50%"
const change = PercentageFormatter.formatChange(gain);  // "+15.00%"
```

### Преимущества новой архитектуры

1. **Separation of Concerns:**
   - Core: только инварианты
   - Rules: атомарные бизнес-правила
   - Policy: контекстуальная валидация
   - Service: orchestration
   - Adapters: technical details

2. **Testability:**
   - Каждый слой тестируется независимо
   - Легко моки для unit tests
   - Clear isolation of responsibilities

3. **Maintainability:**
   - Изменения в одном слое не влияют на другие
   - Легко добавлять новые rules и policies
   - Документация привязана к слоям

4. **Type Safety:**
   - Result pattern для всех fallible операций
   - Explicit error handling
   - No hidden throws

---

## Breaking Changes

**ДА, есть breaking changes** - это рефакторинг архитектуры:

### API Changes:

1. **Factory methods:**
   - `Percentage.fromValue()` → `PercentageService.create()`
   - `Percentage.fromDecimal()` → `PercentageService.fromDecimal()`
   - `Percentage.fromBasisPoints()` → `PercentageService.fromBasisPoints()`

2. **Arithmetic operations:**
   - `pct.add(other)` → `PercentageService.add(pct, other)`
   - `pct.subtract(other)` → `PercentageService.subtract(pct, other)`
   - `pct.multiply(factor)` → `PercentageService.multiply(pct, factor)`
   - `pct.divide(divisor)` → `PercentageService.divide(pct, divisor)`

3. **Serialization:**
   - `pct.toJSON()` → `PercentageSerializer.toDTO(pct)`
   - `pct.toString()` → `PercentageFormatter.format(pct)`

4. **Getters:**
   - `pct.getValue()` → `pct.value().toNumber()`
   - `pct.toDecimalFraction()` → `pct.toDecimal()`

### Migration Strategy:

1. **Фаза 1:** Создать новую структуру параллельно
2. **Фаза 2:** Обновить все импорты
3. **Фаза 3:** Удалить старый файл `Percentage.ts`

---

## Заметки по имплементации

### 1. Зависимость от Math package

Percentage использует:
- `multiplyDecimal` - для applyTo()
- `addDecimal` - для сложения
- `subtractDecimal` - для вычитания
- `divideDecimal` - для деления

**Важно:** Math package должен быть реализован ПЕРВЫМ.

### 2. Error Handling

Все ошибки из `@polymarket/errors`:
- `InvalidPercentageError` - уже существует
- `ArithmeticOverflowError` - уже существует
- `DivisionByZeroError` - уже существует

Не нужно создавать новые ошибки.

### 3. Precision

Decimal.js использует precision по умолчанию (20 significant digits).
Для процентов этого более чем достаточно.

### 4. Форматирование

PercentageFormatter поддерживает 3 формата:
- `percentage`: "25.50%"
- `decimal`: "0.255"
- `basisPoints`: "2550 bp"

Это покрывает все UI needs.

---

## Ожидаемый результат

После выполнения плана:

1. ✅ **Layered Architecture** - чистое разделение по слоям
2. ✅ **Result Pattern** - везде где может быть ошибка
3. ✅ **Testability** - 120 тестов с высоким coverage
4. ✅ **Type Safety** - явный error handling через Result
5. ✅ **Separation** - technical concerns (serialization) отделены от domain
6. ✅ **Policies** - контекстуальная валидация для fees и spreads
7. ✅ **Documentation** - TSDoc для каждого public метода

---

**Конец плана для Percentage**
