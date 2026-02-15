# План: Интеграция Ratio в Money

## Цель

Добавить операции с Ratio в Money для поддержки:
- Вычисления долей (fees, rebates, allocations)
- Увеличения/уменьшения на процент (price adjustments, discounts)

## Обзор архитектуры

```
Money (Core) + Ratio (Core) → MoneyService (Facade)
                            ↓
                    Result<Money, InvalidMoneyError>
```

## Фазы реализации

### Phase 1: Расширение MoneyErrorReason ✅ Подготовка

**Файл:** `packages/domain/value-objects/src/money/errors/MoneyErrorReason.ts`

**Добавить новые reasons:**

```typescript
export enum MoneyErrorReason {
  // ... существующие ...

  /** Невалидный Ratio для операции */
  INVALID_RATIO = 'INVALID_RATIO',

  /** Ratio вне допустимого диапазона для операции */
  RATIO_OUT_OF_RANGE = 'RATIO_OUT_OF_RANGE',

  /** Delta для increaseBy приведёт к отрицательному результату (delta < -1) */
  DELTA_LESS_THAN_MINUS_ONE = 'DELTA_LESS_THAN_MINUS_ONE'
}
```

**Обоснование reasons:**
- `INVALID_RATIO` - общая категория для невалидных ratio (NaN, infinite и т.д.)
- `RATIO_OUT_OF_RANGE` - для business rules (например, portion rate должен быть >= 0)
- `DELTA_LESS_THAN_MINUS_ONE` - специфичная причина для increaseBy (delta < -1 приведёт к negative result)

---

### Phase 2: Rules для валидации Ratio операций

#### 2.1. ValidateRatioForPortion

**Файл:** `packages/domain/value-objects/src/money/rules/ValidateRatioForPortion.ts`

**Цель:** Проверить что rate подходит для вычисления доли (portion).

**Проверки:**
1. `rate.toDecimal()` не NaN (уже гарантируется Ratio инвариантами, но для защиты)
2. `rate.toDecimal()` finite (уже гарантируется Ratio инвариантами)
3. `rate.toDecimal() >= 0` (бизнес-правило: portion не может быть отрицательным)

**Альтернатива:** Можно разрешить отрицательные portion для discounts/rebates.
**Решение:** Сделаем два варианта:
- `ValidateNonNegativeRatioForPortion` - запрещает отрицательные (для fees)
- `portion()` без ограничения знака (универсальная)

**Реализация:**

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidMoneyError, ErrorSource } from '@polymarket/errors';
import { Ratio } from '../../ratio/core/Ratio';
import { MoneyErrorReason } from '../errors/MoneyErrorReason';

/**
 * Правило: Rate для portion должен быть >= 0 (для fees, allocations)
 *
 * @remarks
 * Business rule для операции portion (вычисление доли).
 * Запрещает отрицательные rates для сценариев fees/allocations.
 *
 * Для универсальной portion (включая discounts) используйте
 * MoneyService.portion() без этого правила.
 *
 * Проверяет:
 * - rate >= 0 (неотрицательная доля)
 *
 * @param rate - Ratio для проверки
 * @returns Result<void, InvalidMoneyError>
 *
 * @example
 * ```typescript
 * const validateResult = ValidateNonNegativeRatioForPortion.check(
 *   Ratio.of(new Decimal(-0.1)) // -10%
 * );
 * if (!validateResult.ok) {
 *   console.error(validateResult.error.context.reason); // RATIO_OUT_OF_RANGE
 * }
 * ```
 */
export class ValidateNonNegativeRatioForPortion {
  public static check(rate: Ratio): Result<void, InvalidMoneyError> {
    // Проверка: rate должен быть неотрицательным
    if (rate.toDecimal().lessThan(0)) {
      return Err(
        new InvalidMoneyError('Portion rate cannot be negative', {
          context: {
            source: ErrorSource.RULE_VALIDATION,
            rate: rate.toDecimal().toString(),
            reason: MoneyErrorReason.RATIO_OUT_OF_RANGE
          }
        })
      );
    }

    return Ok(undefined);
  }
}
```

#### 2.2. ValidateDeltaForIncreaseBy

**Файл:** `packages/domain/value-objects/src/money/rules/ValidateDeltaForIncreaseBy.ts`

**Цель:** Проверить что delta подходит для increaseBy (не приведёт к negative result).

**Проверки:**
1. `delta.toDecimal() >= -1` (иначе factor = 1 + delta будет отрицательным)

**Обоснование:**
- `increaseBy(0.1)` → factor = 1.1 → +10% ✅
- `increaseBy(-0.5)` → factor = 0.5 → -50% ✅
- `increaseBy(-1)` → factor = 0 → -100% ✅ (zero result)
- `increaseBy(-1.5)` → factor = -0.5 ❌ (negative result, нарушение Money инварианта)

**Реализация:**

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidMoneyError, ErrorSource } from '@polymarket/errors';
import { Ratio } from '../../ratio/core/Ratio';
import { MoneyErrorReason } from '../errors/MoneyErrorReason';
import Decimal from 'decimal.js';

/**
 * Правило: Delta для increaseBy должен быть >= -1
 *
 * @remarks
 * Business rule для операции increaseBy (увеличение на процент).
 * Запрещает delta < -1, так как это приведёт к отрицательному factor.
 *
 * factor = 1 + delta
 * - delta = 0.1 → factor = 1.1 (увеличение на 10%)
 * - delta = -0.5 → factor = 0.5 (уменьшение на 50%)
 * - delta = -1 → factor = 0 (уменьшение на 100%, zero result)
 * - delta = -1.5 → factor = -0.5 ❌ (отрицательный factor)
 *
 * Проверяет:
 * - delta >= -1
 *
 * @param delta - Ratio для проверки
 * @returns Result<void, InvalidMoneyError>
 *
 * @example
 * ```typescript
 * const validateResult = ValidateDeltaForIncreaseBy.check(
 *   Ratio.of(new Decimal(-1.5)) // -150%
 * );
 * if (!validateResult.ok) {
 *   console.error(validateResult.error.context.reason); // DELTA_LESS_THAN_MINUS_ONE
 * }
 * ```
 */
export class ValidateDeltaForIncreaseBy {
  public static check(delta: Ratio): Result<void, InvalidMoneyError> {
    // Проверка: delta >= -1
    const minusOne = new Decimal(-1);
    if (delta.toDecimal().lessThan(minusOne)) {
      return Err(
        new InvalidMoneyError('Delta must be >= -1 (factor = 1 + delta must be non-negative)', {
          context: {
            source: ErrorSource.RULE_VALIDATION,
            delta: delta.toDecimal().toString(),
            reason: MoneyErrorReason.DELTA_LESS_THAN_MINUS_ONE
          }
        })
      );
    }

    return Ok(undefined);
  }
}
```

---

### Phase 3: Реализация операций в MoneyService

#### 3.1. MoneyService.portion()

**Сигнатура:**
```typescript
public static portion(m: Money, rate: Ratio): Result<Money, InvalidMoneyError>
```

**Семантика:** "Сколько денег составляет доля rate от суммы m"

**Формула:** `result = m * rate`

**Use cases:**
- Fee calculation: `portion(orderAmount, Ratio.fromPercent(2))` → trading fee
- Rebate: `portion(paidAmount, Ratio.fromBps(25))` → cashback
- Allocation: `portion(totalBudget, Ratio.fromDecimal(0.3))` → 30% allocation

**Алгоритм:**
1. Парсинг не нужен (принимаем готовый Ratio)
2. Опциональная валидация rate через `ValidateNonNegativeRatioForPortion` (если нужно запретить negative)
3. Multiply: `m.value() * rate.toDecimal()`
4. Create Money через `createFromDecimal()`

**Реализация:**

```typescript
/**
 * Вычисляет долю (portion) от суммы Money
 *
 * @param m - Исходная сумма
 * @param rate - Доля (Ratio) - например, 0.02 для 2%
 * @returns Result<Money, InvalidMoneyError>
 * @throws Никогда - все ошибки оборачиваются в Result
 *
 * @remarks
 * **Семантика:** "Сколько денег составляет доля rate от суммы m"
 *
 * **Формула:** result = m * rate
 *
 * **Use cases:**
 * - Fee: `portion(orderAmount, Ratio.fromPercent(2))` → 2% trading fee
 * - Rebate: `portion(paidAmount, Ratio.fromBps(25))` → 0.25% cashback
 * - Allocation: `portion(budget, Ratio.fromDecimal(0.3))` → 30% от бюджета
 *
 * **Знак rate:**
 * - Положительный rate (>= 0): стандартный случай (fees, allocations)
 * - Отрицательный rate (< 0): допустимо для discounts/rebates
 *
 * **Процесс:**
 * 1. Multiply: m.value() * rate.toDecimal()
 * 2. Create Money через createFromDecimal() (проверит инварианты)
 *
 * **Возможные ошибки:**
 * - EXCEEDS_MAX_AMOUNT: результат превышает максимум
 * - NEGATIVE_RESULT: результат отрицательный (если m > 0 и rate < 0)
 *
 * @example
 * ```typescript
 * // Fee calculation: 2% от $1000
 * const orderAmount = Money.of(new Decimal(1000), 'USDC');
 * const feeRate = Ratio.of(new Decimal(0.02)); // 2%
 * const feeResult = MoneyService.portion(orderAmount, feeRate);
 * if (feeResult.ok) {
 *   console.log(feeResult.value.value().toString()); // 20 USDC
 * }
 *
 * // Allocation: 30% от бюджета $5000
 * const budget = Money.of(new Decimal(5000), 'USDC');
 * const allocRate = Ratio.of(new Decimal(0.3)); // 30%
 * const allocResult = MoneyService.portion(budget, allocRate);
 * if (allocResult.ok) {
 *   console.log(allocResult.value.value().toString()); // 1500 USDC
 * }
 * ```
 */
public static portion(m: Money, rate: Ratio): Result<Money, InvalidMoneyError> {
  const ctx = {
    amount: m.value().toString(),
    currency: m.currency(),
    rate: rate.toDecimal().toString()
  };

  return wrapOp(MoneyService.SERVICE_NAME, 'portion', ctx, () => {
    // Multiply: m * rate
    const product = multiplyDecimal(m.value(), rate.toDecimal());

    // Create Money (проверит инварианты: non-negative, finite, max)
    return this.createFromDecimal(product, m.currency(), 'portion', ctx);
  }, InvalidMoneyError);
}
```

#### 3.2. MoneyService.increaseBy()

**Сигнатура:**
```typescript
public static increaseBy(m: Money, delta: Ratio): Result<Money, InvalidMoneyError>
```

**Семантика:** "Увеличить сумму на delta процентов"

**Формула:** `result = m * (1 + delta)`

**Use cases:**
- Price increase: `increaseBy(basePrice, Ratio.fromPercent(5))` → +5% markup
- Compound interest: `increaseBy(principal, Ratio.fromPercent(3))` → +3% interest
- Discount (negative delta): `increaseBy(price, Ratio.fromPercent(-10))` → -10% discount

**Инвариант:** `delta >= -1` (иначе factor будет отрицательным)

**Алгоритм:**
1. Валидация delta через `ValidateDeltaForIncreaseBy` (delta >= -1)
2. Вычисление factor: `1 + delta`
3. Multiply: `m.value() * factor`
4. Create Money через `createFromDecimal()`

**Реализация:**

```typescript
/**
 * Увеличивает (или уменьшает) сумму на delta процентов
 *
 * @param m - Исходная сумма
 * @param delta - Изменение в долях (Ratio) - например, 0.05 для +5%, -0.1 для -10%
 * @returns Result<Money, InvalidMoneyError>
 * @throws Никогда - все ошибки оборачиваются в Result
 *
 * @remarks
 * **Семантика:** "Увеличить сумму на delta процентов"
 *
 * **Формула:** result = m * (1 + delta)
 *
 * **Use cases:**
 * - Price markup: `increaseBy(cost, Ratio.fromPercent(5))` → +5% markup
 * - Interest: `increaseBy(principal, Ratio.fromPercent(3))` → +3% interest
 * - Discount: `increaseBy(price, Ratio.fromPercent(-10))` → -10% discount
 *
 * **Инвариант:** delta >= -1
 * - delta = 0.1 → factor = 1.1 → увеличение на 10%
 * - delta = -0.5 → factor = 0.5 → уменьшение на 50%
 * - delta = -1 → factor = 0 → уменьшение на 100% (zero result)
 * - delta = -1.5 → ❌ DELTA_LESS_THAN_MINUS_ONE (factor отрицательный)
 *
 * **Процесс:**
 * 1. Валидация: delta >= -1 (через ValidateDeltaForIncreaseBy)
 * 2. Вычисление factor: 1 + delta
 * 3. Multiply: m * factor
 * 4. Create Money через createFromDecimal()
 *
 * **Возможные ошибки:**
 * - DELTA_LESS_THAN_MINUS_ONE: delta < -1
 * - EXCEEDS_MAX_AMOUNT: результат превышает максимум
 * - NEGATIVE_RESULT: результат отрицательный (не должно быть если delta >= -1)
 *
 * @example
 * ```typescript
 * // Увеличение на 10%: $100 → $110
 * const price = Money.of(new Decimal(100), 'USDC');
 * const markup = Ratio.of(new Decimal(0.1)); // +10%
 * const result = MoneyService.increaseBy(price, markup);
 * if (result.ok) {
 *   console.log(result.value.value().toString()); // 110 USDC
 * }
 *
 * // Discount 20%: $100 → $80
 * const discount = Ratio.of(new Decimal(-0.2)); // -20%
 * const discounted = MoneyService.increaseBy(price, discount);
 * if (discounted.ok) {
 *   console.log(discounted.value.value().toString()); // 80 USDC
 * }
 *
 * // Ошибка: delta < -1
 * const invalidDelta = Ratio.of(new Decimal(-1.5)); // -150%
 * const invalid = MoneyService.increaseBy(price, invalidDelta);
 * if (!invalid.ok) {
 *   console.error(invalid.error.context.reason); // DELTA_LESS_THAN_MINUS_ONE
 * }
 * ```
 */
public static increaseBy(m: Money, delta: Ratio): Result<Money, InvalidMoneyError> {
  const ctx = {
    amount: m.value().toString(),
    currency: m.currency(),
    delta: delta.toDecimal().toString()
  };

  return wrapOp(MoneyService.SERVICE_NAME, 'increaseBy', ctx, () => {
    // Валидация: delta >= -1
    const validateResult = ValidateDeltaForIncreaseBy.check(delta);
    if (isErr(validateResult)) {
      return validateResult;
    }

    // Вычисление factor: 1 + delta
    const factor = new Decimal(1).plus(delta.toDecimal());

    // Multiply: m * factor
    const product = multiplyDecimal(m.value(), factor);

    // Create Money (проверит инварианты)
    return this.createFromDecimal(product, m.currency(), 'increaseBy', ctx);
  }, InvalidMoneyError);
}
```

#### 3.3. MoneyService.decreaseBy()

**Сигнатура:**
```typescript
public static decreaseBy(m: Money, delta: Ratio): Result<Money, InvalidMoneyError>
```

**Семантика:** "Уменьшить сумму на delta процентов" (convenience для increaseBy с отрицанием)

**Формула:** `result = increaseBy(m, -delta) = m * (1 - delta)`

**Use cases:**
- Discount: `decreaseBy(price, Ratio.fromPercent(10))` → -10% скидка
- Depreciation: `decreaseBy(value, Ratio.fromPercent(15))` → -15% износ

**Инвариант:** `delta <= 1` (чтобы после отрицания было >= -1)

**Реализация:**

```typescript
/**
 * Уменьшает сумму на delta процентов
 *
 * @param m - Исходная сумма
 * @param delta - Уменьшение в долях (Ratio) - например, 0.1 для -10%
 * @returns Result<Money, InvalidMoneyError>
 * @throws Никогда - все ошибки оборачиваются в Result
 *
 * @remarks
 * **Семантика:** "Уменьшить сумму на delta процентов"
 *
 * **Convenience метод для increaseBy(-delta)**
 *
 * **Формула:** result = m * (1 - delta) = increaseBy(m, -delta)
 *
 * **Use cases:**
 * - Discount: `decreaseBy(price, Ratio.fromPercent(10))` → -10% скидка
 * - Depreciation: `decreaseBy(value, Ratio.fromPercent(15))` → -15% износ
 *
 * **Инвариант:** delta <= 1 (чтобы после отрицания было >= -1)
 * - delta = 0.1 → -delta = -0.1 → factor = 0.9 → уменьшение на 10%
 * - delta = 1 → -delta = -1 → factor = 0 → уменьшение на 100%
 * - delta = 1.5 → -delta = -1.5 → ❌ DELTA_LESS_THAN_MINUS_ONE
 *
 * @example
 * ```typescript
 * // Скидка 20%: $100 → $80
 * const price = Money.of(new Decimal(100), 'USDC');
 * const discount = Ratio.of(new Decimal(0.2)); // 20%
 * const result = MoneyService.decreaseBy(price, discount);
 * if (result.ok) {
 *   console.log(result.value.value().toString()); // 80 USDC
 * }
 * ```
 */
public static decreaseBy(m: Money, delta: Ratio): Result<Money, InvalidMoneyError> {
  // Convenience: decreaseBy(m, delta) = increaseBy(m, -delta)
  const negatedDelta = delta.negate();
  return this.increaseBy(m, negatedDelta);
}
```

---

### Phase 4: Тестирование

#### 4.1. Rules Tests

**Файл:** `__tests__/unit/money/rules/ValidateNonNegativeRatioForPortion.test.ts`

```typescript
describe('ValidateNonNegativeRatioForPortion', () => {
  it('принимает положительный rate', () => {
    const rate = Ratio.of(new Decimal(0.02)); // 2%
    const result = ValidateNonNegativeRatioForPortion.check(rate);
    expect(result.ok).toBe(true);
  });

  it('принимает нулевой rate', () => {
    const rate = Ratio.of(new Decimal(0));
    const result = ValidateNonNegativeRatioForPortion.check(rate);
    expect(result.ok).toBe(true);
  });

  it('отклоняет отрицательный rate', () => {
    const rate = Ratio.of(new Decimal(-0.1)); // -10%
    const result = ValidateNonNegativeRatioForPortion.check(rate);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context.reason).toBe(MoneyErrorReason.RATIO_OUT_OF_RANGE);
      expect(result.error.message).toContain('cannot be negative');
    }
  });
});
```

**Файл:** `__tests__/unit/money/rules/ValidateDeltaForIncreaseBy.test.ts`

```typescript
describe('ValidateDeltaForIncreaseBy', () => {
  it('принимает положительный delta', () => {
    const delta = Ratio.of(new Decimal(0.5)); // +50%
    const result = ValidateDeltaForIncreaseBy.check(delta);
    expect(result.ok).toBe(true);
  });

  it('принимает delta = -1 (граничное значение)', () => {
    const delta = Ratio.of(new Decimal(-1)); // -100%
    const result = ValidateDeltaForIncreaseBy.check(delta);
    expect(result.ok).toBe(true);
  });

  it('отклоняет delta < -1', () => {
    const delta = Ratio.of(new Decimal(-1.5)); // -150%
    const result = ValidateDeltaForIncreaseBy.check(delta);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context.reason).toBe(MoneyErrorReason.DELTA_LESS_THAN_MINUS_ONE);
    }
  });
});
```

#### 4.2. MoneyService.portion() Tests

**Файл:** `__tests__/unit/money/facade/MoneyService.ratio.test.ts`

```typescript
describe('MoneyService.portion()', () => {
  const money100 = Money.of(new Decimal(100), 'USDC');

  it('вычисляет 2% fee от $100', () => {
    const rate = Ratio.of(new Decimal(0.02)); // 2%
    const result = MoneyService.portion(money100, rate);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value().toString()).toBe('2');
      expect(result.value.currency()).toBe('USDC');
    }
  });

  it('вычисляет 30% allocation от $5000', () => {
    const budget = Money.of(new Decimal(5000), 'USDC');
    const rate = Ratio.of(new Decimal(0.3)); // 30%
    const result = MoneyService.portion(budget, rate);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value().toString()).toBe('1500');
    }
  });

  it('возвращает zero для rate = 0', () => {
    const rate = Ratio.of(new Decimal(0));
    const result = MoneyService.portion(money100, rate);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value().toString()).toBe('0');
    }
  });

  it('допускает отрицательный rate (rebate)', () => {
    const rate = Ratio.of(new Decimal(-0.1)); // -10%
    const result = MoneyService.portion(money100, rate);

    // Результат отрицательный, но это нормально для rebate/discount
    expect(result.ok).toBe(false); // Money не допускает negative
    if (!result.ok) {
      expect(result.error.context.reason).toBe(MoneyErrorReason.NEGATIVE_RESULT);
    }
  });

  it('фэйлится при overflow', () => {
    const hugeRate = Ratio.of(new Decimal(1e20));
    const result = MoneyService.portion(money100, hugeRate);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context.reason).toBe(MoneyErrorReason.EXCEEDS_MAX_AMOUNT);
    }
  });
});
```

#### 4.3. MoneyService.increaseBy() Tests

```typescript
describe('MoneyService.increaseBy()', () => {
  const money100 = Money.of(new Decimal(100), 'USDC');

  it('увеличивает на 10%: $100 → $110', () => {
    const delta = Ratio.of(new Decimal(0.1)); // +10%
    const result = MoneyService.increaseBy(money100, delta);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value().toString()).toBe('110');
    }
  });

  it('уменьшает на 20%: $100 → $80', () => {
    const delta = Ratio.of(new Decimal(-0.2)); // -20%
    const result = MoneyService.increaseBy(money100, delta);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value().toString()).toBe('80');
    }
  });

  it('уменьшает на 100%: $100 → $0 (граничный случай)', () => {
    const delta = Ratio.of(new Decimal(-1)); // -100%
    const result = MoneyService.increaseBy(money100, delta);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value().toString()).toBe('0');
    }
  });

  it('фэйлится при delta < -1', () => {
    const delta = Ratio.of(new Decimal(-1.5)); // -150%
    const result = MoneyService.increaseBy(money100, delta);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context.reason).toBe(MoneyErrorReason.DELTA_LESS_THAN_MINUS_ONE);
    }
  });

  it('не изменяет при delta = 0', () => {
    const delta = Ratio.of(new Decimal(0));
    const result = MoneyService.increaseBy(money100, delta);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value().toString()).toBe('100');
    }
  });
});
```

#### 4.4. MoneyService.decreaseBy() Tests

```typescript
describe('MoneyService.decreaseBy()', () => {
  const money100 = Money.of(new Decimal(100), 'USDC');

  it('уменьшает на 20%: $100 → $80', () => {
    const delta = Ratio.of(new Decimal(0.2)); // 20%
    const result = MoneyService.decreaseBy(money100, delta);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value().toString()).toBe('80');
    }
  });

  it('уменьшает на 100%: $100 → $0', () => {
    const delta = Ratio.of(new Decimal(1)); // 100%
    const result = MoneyService.decreaseBy(money100, delta);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.value().toString()).toBe('0');
    }
  });

  it('фэйлится при delta > 1 (приведёт к negative)', () => {
    const delta = Ratio.of(new Decimal(1.5)); // 150%
    const result = MoneyService.decreaseBy(money100, delta);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context.reason).toBe(MoneyErrorReason.DELTA_LESS_THAN_MINUS_ONE);
    }
  });
});
```

---

### Phase 5: Документация

#### 5.1. Обновить README.md в money пакете

Добавить секцию:

```markdown
## Операции с Ratio

Money поддерживает операции с Ratio для вычисления долей и процентных изменений:

### Вычисление доли (portion)

```typescript
import { MoneyService } from '@polymarket/value-objects/money';
import { Ratio } from '@polymarket/value-objects/ratio';

// Fee: 2% от $1000
const orderAmount = Money.of(new Decimal(1000), 'USDC');
const feeRate = Ratio.of(new Decimal(0.02)); // 2%
const fee = MoneyService.portion(orderAmount, feeRate);
// fee.value = $20
```

### Увеличение на процент (increaseBy)

```typescript
// Markup: +5% к цене
const cost = Money.of(new Decimal(100), 'USDC');
const markup = Ratio.of(new Decimal(0.05)); // +5%
const price = MoneyService.increaseBy(cost, markup);
// price.value = $105

// Discount: -10% от цены
const discount = Ratio.of(new Decimal(-0.1)); // -10%
const discounted = MoneyService.increaseBy(price, discount);
// discounted.value = $94.5
```

### Уменьшение на процент (decreaseBy)

```typescript
// Скидка: -20% от цены
const price = Money.of(new Decimal(100), 'USDC');
const discount = Ratio.of(new Decimal(0.2)); // 20%
const final = MoneyService.decreaseBy(price, discount);
// final.value = $80
```
```

#### 5.2. TSDoc комментарии

Все методы уже содержат подробные TSDoc комментарии в коде выше (Phase 3).

---

## Порядок реализации (рекомендуемый)

### Итерация 1: Подготовка (1-2 часа)
1. ✅ Добавить новые `MoneyErrorReason` (Phase 1)
2. ✅ Создать `ValidateDeltaForIncreaseBy` rule (Phase 2.2)
3. ✅ Написать тесты для rule (Phase 4.1)

### Итерация 2: Базовая операция (2-3 часа)
4. ✅ Реализовать `MoneyService.increaseBy()` (Phase 3.2)
5. ✅ Написать тесты для `increaseBy()` (Phase 4.3)
6. ✅ Проверить build и все тесты

### Итерация 3: Дополнительные операции (2-3 часа)
7. ✅ Реализовать `MoneyService.portion()` (Phase 3.1)
8. ✅ Реализовать `MoneyService.decreaseBy()` (Phase 3.3)
9. ✅ Написать тесты для обеих операций (Phase 4.2, 4.4)
10. ✅ Проверить build и все тесты

### Итерация 4: Документация (1 час)
11. ✅ Обновить README.md (Phase 5.1)
12. ✅ Проверить все TSDoc комментарии (Phase 5.2)
13. ✅ Запустить markdownlint

---

## Альтернативные решения (обсуждение)

### Вариант 1: Опциональная валидация rate в portion()

**Вопрос:** Нужно ли запрещать отрицательные rate в `portion()`?

**За запрет (ValidateNonNegativeRatioForPortion):**
- Семантически portion = "доля" → должна быть >= 0
- Fees, allocations всегда неотрицательные
- Явное разделение: portion для fees, increaseBy для discounts

**Против запрета:**
- Универсальность: один метод для всех случаев (fee, rebate, discount)
- Меньше кода (не нужна отдельная rule)
- Отрицательный result автоматически отклонится Money инвариантом

**Рекомендация:** Не использовать `ValidateNonNegativeRatioForPortion` в `portion()`.
Пусть `portion()` будет универсальным, а отрицательные results отклонятся через Money invariant (NEGATIVE_RESULT).

### Вариант 2: Использовать Ratio.onePlus() / Ratio.oneMinus()

**Вопрос:** Можно ли упростить `increaseBy()` через `Ratio.onePlus()`?

```typescript
// Текущая реализация
const factor = new Decimal(1).plus(delta.toDecimal());
const product = multiplyDecimal(m.value(), factor);

// Альтернатива через Ratio.onePlus()
const factor = delta.onePlus(); // возвращает Decimal(1 + delta)
const product = multiplyDecimal(m.value(), factor);
```

**Рекомендация:** Да, использовать `delta.onePlus()` для читаемости.
Аналогично для `decreaseBy()` через `delta.oneMinus()`.

---

## Зависимости

**Требуется:**
- ✅ Ratio (уже реализован)
- ✅ RatioService (уже реализован)
- ✅ Money Core (уже реализован)
- ✅ MoneyService (уже реализован)
- ✅ @polymarket/math (multiplyDecimal)
- ✅ @polymarket/errors (wrapOp, rewrap)

**Не требуется:**
- RatioService для парсинга (принимаем готовый Ratio)
- Новые math операции (используем существующий multiplyDecimal)

---

## Потенциальные проблемы

### Проблема 1: Precision loss при малых rates

**Сценарий:** `portion(Money.of(1), Ratio.of(0.0001))` → очень малое значение

**Решение:** Decimal.js гарантирует precision, Money.of() проверит инварианты.
Если результат < epsilon → Money invariant отклонит через EXCEEDS_MAX_AMOUNT или округлится до 0.

### Проблема 2: Отрицательный результат в portion()

**Сценарий:** `portion(Money.of(100), Ratio.of(-0.5))` → -50

**Решение:** Money invariant отклонит через NEGATIVE_RESULT.
Это ожидаемое поведение (не используйте отрицательные rates для portion, или разрешите negative Money).

---

## Чеклист перед реализацией

- [ ] Прочитать текущую реализацию Money
- [ ] Прочитать текущую реализацию Ratio
- [ ] Понять паттерн Rules (ValidateFactorForMoneyMultiplication)
- [ ] Понять паттерн wrapOp в MoneyService
- [ ] Решить: использовать ли ValidateNonNegativeRatioForPortion
- [ ] Решить: использовать ли Ratio.onePlus()/oneMinus()

---

## После реализации

- [ ] Запустить все тесты: `npm test -w @polymarket/value-objects`
- [ ] Проверить build: `npm run build -w @polymarket/value-objects`
- [ ] Проверить lint: `npm run lint -w @polymarket/value-objects`
- [ ] Проверить markdownlint: `markdownlint-cli2 "packages/domain/value-objects/**/*.md"`
- [ ] Создать commit с Co-Authored-By
- [ ] Обновить CHANGELOG (опционально)
