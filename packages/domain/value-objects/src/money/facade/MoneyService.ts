import { Result, Ok, Err, isErr } from '@polymarket/result';
import Decimal from 'decimal.js';
import {
  InvalidMoneyError,
  ErrorSource,
  toDecimal,
  rewrap,
  wrapOp,
  unexpectedError
} from '@polymarket/errors';
import { addDecimal, subtractDecimal, multiplyDecimal, divideDecimal } from '@polymarket/math';
import { Money, type SupportedCurrency } from '../core/Money';
import { MoneyInvariantViolation } from '../core/MoneyInvariantViolation';
import { ValidateFactorForMoneyMultiplication } from '../rules/ValidateFactorForMoneyMultiplication';
import { ValidateDivisorForMoneyDivision } from '../rules/ValidateDivisorForMoneyDivision';
import { ValidateDeltaForIncreaseBy } from '../rules/ValidateDeltaForIncreaseBy';
import { MoneyErrorReason } from '../errors/MoneyErrorReason';
import { Ratio } from '../../ratio/core/Ratio.js';

/**
 * Facade для безопасного создания и операций с Money - публичный API
 *
 * @remarks
 * Единая точка входа для всех операций с Money.
 * Оркестрирует Core + Math + Rules.
 *
 * **Контракт "Never Throw":**
 * ВСЕ методы MoneyService ГАРАНТИРОВАННО возвращают Result и НИКОГДА не бросают исключения.
 * Любые исключения из @polymarket/math, Core инвариантов или Rules ловятся и преобразуются в Result.Err.
 *
 * **Facade Error Contract:**
 * Любой Err из Facade содержит:
 * - context.op - название операции (верхний уровень)
 * - context.opChain - цепочка операций (внутренние op не теряются)
 * - context.amount/factor/divisor - входные параметры (если применимо)
 * - context.raw - сырой ввод (для ошибок парсинга): { field, value }
 * - context.cause - для math-исключений: { name, message, stack? } (root-cause, не перетирается)
 * - context.reason - для инвариантов Core и специальных случаев (root, не перетирается)
 * - context.currency - валюта
 *
 * **Правило возвращаемых типов:**
 * ВСЕ операции возвращают Result<T, InvalidMoneyError>
 * ОЖИДАЕМЫЕ и НЕОЖИДАННЫЕ ошибки обрабатываются через Result
 *
 * Специальные reason значения в context.reason (MoneyErrorReason enum):
 * - MoneyErrorReason.INVALID_FORMAT - ошибка парсинга значения
 * - MoneyErrorReason.NAN - значение NaN
 * - MoneyErrorReason.NON_FINITE - значение не finite (Infinity)
 * - MoneyErrorReason.EXCEEDS_MAX_AMOUNT - результат превышает максимальную сумму
 * - MoneyErrorReason.CURRENCY_MISMATCH - несовпадение валют в add/subtract
 * - MoneyErrorReason.DIVISION_BY_ZERO - деление на ноль
 * - MoneyErrorReason.UNSUPPORTED_CURRENCY - неподдерживаемая валюта
 * - MoneyErrorReason.NEGATIVE_RESULT - результат операции меньше нуля
 *
 * @example
 * ```typescript
 * import { MoneyService, MoneyErrorReason } from '@polymarket/value-objects/money';
 *
 * const result = MoneyService.create(100, 'USDC');
 * if (result.ok) {
 *   console.log(result.value.value()); // Decimal(100)
 * } else {
 *   console.error(result.error.message);
 *   console.error(result.error.context.reason); // MoneyErrorReason.INVALID_FORMAT, etc.
 * }
 * ```
 */
export class MoneyService {
  private static readonly SERVICE_NAME = 'MoneyService';

  /**
   * Создаёт Money с обработкой через Result.
   *
   * @param value - Сумма (number, string, Decimal)
   * @param currency - Валюта (default 'USDC')
   * @returns Result<Money, InvalidMoneyError>
   * @throws Никогда - все ошибки оборачиваются в Result
   *
   * @remarks
   * ПУБЛИЧНЫЙ способ создания Money.
   * Возвращает Result вместо исключений.
   *
   * Процесс:
   * 1. Парсит в Decimal через toDecimal('value', value)
   * 2. Вызывает createFromDecimal() (проверит инварианты)
   *
   * Обработка ошибок:
   * - Parse fail (toDecimal error) → InvalidMoneyError(reason: 'INVALID_FORMAT', raw: { field, value })
   * - Invariant fail (MoneyInvariantViolation) → InvalidMoneyError с reason (EXCEEDS_MAX_AMOUNT, NON_FINITE, NAN)
   *
   * @example
   * ```typescript
   * const result = MoneyService.create(100);
   * if (result.ok) {
   *   console.log(result.value.value());
   * }
   * ```
   */
  public static create(
    value: number | string | Decimal,
    currency: SupportedCurrency = 'USDC'
  ): Result<Money, InvalidMoneyError> {
    // Безопасный парсинг value через toDecimal
    const decimalResult = toDecimal('value', value, MoneyErrorReason.INVALID_FORMAT, InvalidMoneyError, {
      nanReason: MoneyErrorReason.NAN,
      nonFiniteReason: MoneyErrorReason.NON_FINITE
    });
    if (isErr(decimalResult)) {
      // raw уже внутри err.context.raw от toDecimal
      return Err(rewrap(MoneyService.SERVICE_NAME, 'create', { currency }, decimalResult.error, InvalidMoneyError));
    }

    // Создание через createFromDecimal (проверит инварианты)
    return this.createFromDecimal(decimalResult.value, currency, 'create', {});
  }

  /**
   * Создаёт Money из Decimal с проверкой инвариантов
   *
   * @param decimal - Значение amount (уже распарсенный Decimal)
   * @param currency - Валюта
   * @returns Result<Money, InvalidMoneyError>
   *
   * @remarks
   * Внутренний helper для использования в wrapOp и math операциях.
   * НЕ парсит - принимает готовый Decimal.
   * Только проверяет инварианты через Money.of().
   *
   * Ловит MoneyInvariantViolation и мапит через mapInvariantToOverflow:
   * - EXCEEDS_MAX_AMOUNT, NON_FINITE, NAN → ArithmeticOverflowError
   * - Остальные → InvalidMoneyError (unexpected)
   *
   * Используется в:
   * - add/subtract/multiply/divide для создания результата
   * - create() после парсинга через toDecimal
   */
  private static createFromDecimal(
    decimal: Decimal,
    currency: SupportedCurrency,
    op: string = 'createFromDecimal',
    ctx: Record<string, unknown> = {}
  ): Result<Money, InvalidMoneyError> {
    try {
      return Ok(Money.of(decimal, currency));
    } catch (error) {
      if (error instanceof MoneyInvariantViolation) {
        return this.mapInvariantToOverflow(op, {
          ...ctx,
          value: decimal.toString(),
          currency
        }, error);
      }

      // Unexpected error - возвращаем InvalidMoneyError
      return Err(unexpectedError(error, InvalidMoneyError));
    }
  }

  /**
   * Мапит MoneyInvariantViolation → InvalidMoneyError
   *
   * @param op - Операция (add/subtract/multiply/divide)
   * @param ctx - Контекст (a, b, result, amount, factor, divisor, etc.)
   * @param e - MoneyInvariantViolation из Money.of()
   * @returns Err(InvalidMoneyError) с reason в context
   *
   * @remarks
   * DRY helper для всех math операций.
   * Все типы MoneyInvariantViolation мапятся в InvalidMoneyError с сохранением reason.
   *
   * **ВАЖНО:** НЕ throw - всегда возвращает Result.
   */
  private static mapInvariantToOverflow(
    op: string,
    ctx: Record<string, unknown>,
    e: MoneyInvariantViolation
  ): Result<never, InvalidMoneyError> {
    const { reason } = e;
    // Все типы инвариантных нарушений мапим в InvalidMoneyError с reason
    return Err(
      new InvalidMoneyError(`Money ${op} result is invalid: ${reason}`, {
        context: {
          source: ErrorSource.CORE_INVARIANT,
          service: MoneyService.SERVICE_NAME, // Set root service field
          op,
          ...ctx,
          reason
        }
      })
    );
  }

  /**
   * Складывает две суммы.
   *
   * @param a - Первая
   * @param b - Вторая
   * @returns Result<Money, InvalidMoneyError>
   * @throws Никогда - все ошибки оборачиваются в Result
   *
   * @remarks
   * Процесс:
   * 1. Проверка валют (ДО wrapOp - это не math error)
   * 2. Операция через @polymarket/math
   * 3. Money.of() (проверит инварианты через createFromDecimal)
   * 4. Маппинг через mapInvariantToOverflow
   *
   * Service НЕ проверяет MAX руками.
   *
   * @example
   * ```typescript
   * const result = MoneyService.add(Money.of(new Decimal(100)), Money.of(new Decimal(50)));
   * if (result.ok) {
   *   console.log(result.value.value().toNumber()); // 150
   * }
   * ```
   */
  public static add(
    a: Money,
    b: Money
  ): Result<Money, InvalidMoneyError> {
    // Проверка валют ДО wrapOp (это не math error)
    if (!a.hasSameCurrency(b)) {
      const baseError = new InvalidMoneyError('Cannot add Money with different currencies', {
        context: {
          reason: MoneyErrorReason.CURRENCY_MISMATCH,
          expected: a.currency(),
          actual: b.currency()
        }
      });
      return Err(rewrap(MoneyService.SERVICE_NAME, 'add', { a: a.value().toString(), b: b.value().toString(), currency: a.currency() }, baseError, InvalidMoneyError));
    }

    const ctx = { a: a.value().toString(), b: b.value().toString(), currency: a.currency() };
    return wrapOp(MoneyService.SERVICE_NAME, 'add', ctx, () => {
      const sum = addDecimal(a.value(), b.value());
      return this.createFromDecimal(sum, a.currency(), 'add', ctx);
    }, InvalidMoneyError);
  }

  /**
   * Вычитает одну сумму из другой.
   *
   * @param a - Уменьшаемое
   * @param b - Вычитаемое
   * @returns Result<Money, InvalidMoneyError>
   * @throws Никогда - все ошибки оборачиваются в Result
   *
   * @remarks
   * Процесс:
   * 1. Проверка валют (ДО wrapOp - это не math error)
   * 2. Операция через @polymarket/math
   * 3. Money.of() (проверит инварианты через createFromDecimal)
   * 4. Маппинг через mapInvariantToOverflow
   *
   * @example
   * ```typescript
   * const result = MoneyService.subtract(Money.of(new Decimal(100)), Money.of(new Decimal(30)));
   * if (result.ok) {
   *   console.log(result.value.value().toNumber()); // 70
   * }
   * ```
   */
  public static subtract(
    a: Money,
    b: Money
  ): Result<Money, InvalidMoneyError> {
    // Проверка валют ДО wrapOp (это не math error)
    if (!a.hasSameCurrency(b)) {
      const baseError = new InvalidMoneyError('Cannot subtract Money with different currencies', {
        context: {
          reason: MoneyErrorReason.CURRENCY_MISMATCH,
          expected: a.currency(),
          actual: b.currency()
        }
      });
      return Err(rewrap(MoneyService.SERVICE_NAME, 'subtract', { a: a.value().toString(), b: b.value().toString(), currency: a.currency() }, baseError, InvalidMoneyError));
    }

    const ctx = { a: a.value().toString(), b: b.value().toString(), currency: a.currency() };
    return wrapOp(MoneyService.SERVICE_NAME, 'subtract', ctx, () => {
      const diff = subtractDecimal(a.value(), b.value());
      return this.createFromDecimal(diff, a.currency(), 'subtract', ctx);
    }, InvalidMoneyError);
  }

  /**
   * Умножает сумму на фактор.
   *
   * @param m - Money
   * @param factor - Множитель (number, string, или Decimal)
   * @returns Result<Money, InvalidMoneyError>
   * @throws Никогда - все ошибки оборачиваются в Result
   *
   * @remarks
   * Проверяет валидность фактора (не NaN, finite).
   * Service проверяет INPUTS, не результат (делегирует core).
   *
   * Алгоритм:
   * 1. Парсинг factor через toDecimal('factor', factor)
   * 2. Валидация factor через ValidateFactorForMoneyMultiplication (isNaN, isFinite)
   * 3. Умножение через multiplyDecimal() из @polymarket/math
   * 4. Создание Money из результата
   *
   * Все ошибки оборачиваются в Result.
   *
   * @example
   * ```typescript
   * const result = MoneyService.multiply(Money.of(new Decimal(100)), 1.5);
   * if (result.ok) {
   *   console.log(result.value.value().toNumber()); // 150
   * }
   * ```
   */
  public static multiply(
    m: Money,
    factor: number | string | Decimal
  ): Result<Money, InvalidMoneyError> {
    // Безопасный парсинг factor через toDecimal
    const factorResult = toDecimal('factor', factor, MoneyErrorReason.INVALID_FORMAT, InvalidMoneyError, {
      nanReason: MoneyErrorReason.NAN,
      nonFiniteReason: MoneyErrorReason.NON_FINITE
    });
    if (isErr(factorResult)) {
      return Err(
        rewrap(MoneyService.SERVICE_NAME, 'multiply', {
          amount: m.value().toString(),
          factor: String(factor),
          currency: m.currency()
        }, factorResult.error, InvalidMoneyError)
      );
    }

    const factorDecimal = factorResult.value;

    // Валидация через rule (проверяет isNaN, isFinite)
    const validateResult = ValidateFactorForMoneyMultiplication.check(factorDecimal);
    if (isErr(validateResult)) {
      return Err(
        rewrap(MoneyService.SERVICE_NAME, 'multiply', {
          amount: m.value().toString(),
          factor: factorDecimal.toString(),
          currency: m.currency()
        }, validateResult.error, InvalidMoneyError)
      );
    }

    // Умножение с обработкой ожидаемых арифметических исключений
    const ctx = {
      amount: m.value().toString(),
      factor: factorDecimal.toString(),
      currency: m.currency()
    };

    return wrapOp(MoneyService.SERVICE_NAME, 'multiply', ctx, () => {
      const product = multiplyDecimal(m.value(), factorDecimal);
      return this.createFromDecimal(product, m.currency(), 'multiply', ctx);
    }, InvalidMoneyError);
  }

  /**
   * Делит сумму на делитель.
   *
   * @param m - Money
   * @param divisor - Делитель (number, string, или Decimal)
   * @returns Result<Money, InvalidMoneyError>
   * @throws Никогда - все ошибки оборачиваются в Result
   *
   * @remarks
   * Проверяет валидность делителя (не NaN, finite, не ноль).
   * Service проверяет INPUTS, не результат (делегирует core).
   *
   * Алгоритм:
   * 1. Парсинг divisor через toDecimal('divisor', divisor)
   * 2. Валидация divisor через ValidateDivisorForMoneyDivision (isNaN, isFinite, isZero)
   * 3. Деление через divideDecimal() из @polymarket/math
   * 4. Создание Money из результата
   *
   * Все ошибки оборачиваются в Result.
   *
   * @example
   * ```typescript
   * const result = MoneyService.divide(Money.of(new Decimal(100)), 2);
   * if (result.ok) {
   *   console.log(result.value.value().toNumber()); // 50
   * }
   * ```
   */
  public static divide(
    m: Money,
    divisor: number | string | Decimal
  ): Result<Money, InvalidMoneyError> {
    // Безопасный парсинг divisor через toDecimal
    const divisorResult = toDecimal('divisor', divisor, MoneyErrorReason.INVALID_FORMAT, InvalidMoneyError, {
      nanReason: MoneyErrorReason.NAN,
      nonFiniteReason: MoneyErrorReason.NON_FINITE
    });
    if (isErr(divisorResult)) {
      return Err(
        rewrap(MoneyService.SERVICE_NAME, 'divide', {
          amount: m.value().toString(),
          divisor: String(divisor),
          currency: m.currency()
        }, divisorResult.error, InvalidMoneyError)
      );
    }

    const divisorDecimal = divisorResult.value;

    // Валидация через rule
    const validateResult = ValidateDivisorForMoneyDivision.check(divisorDecimal);
    if (isErr(validateResult)) {
      return Err(
        rewrap(MoneyService.SERVICE_NAME, 'divide', {
          amount: m.value().toString(),
          divisor: divisorDecimal.toString(),
          currency: m.currency()
        }, validateResult.error, InvalidMoneyError)
      );
    }

    // Деление с обработкой ожидаемых арифметических исключений
    const ctx = {
      amount: m.value().toString(),
      divisor: divisorDecimal.toString(),
      currency: m.currency()
    };

    return wrapOp(MoneyService.SERVICE_NAME, 'divide', ctx, () => {
      const quotient = divideDecimal(m.value(), divisorDecimal);
      return this.createFromDecimal(quotient, m.currency(), 'divide', ctx);
    }, InvalidMoneyError);
  }

  /**
   * Сравнивает две суммы (a < b)
   *
   * @param a - Первая сумма
   * @param b - Вторая сумма
   * @returns Result<boolean, InvalidMoneyError>
   * @throws Никогда - все ошибки в Result
   *
   * @example
   * ```typescript
   * const result = MoneyService.isLessThan(Money.of(new Decimal(100)), Money.of(new Decimal(200)));
   * if (isErr(result)) {
   *   console.error('Currency mismatch');
   * } else if (result.value) {
   *   console.log('a < b');
   * }
   * ```
   */
  public static isLessThan(a: Money, b: Money): Result<boolean, InvalidMoneyError> {
    const ctx = { a: a.value().toString(), b: b.value().toString(), currency: a.currency() };
    return wrapOp(MoneyService.SERVICE_NAME, 'isLessThan', ctx, () => {
      if (!a.hasSameCurrency(b)) {
        throw new InvalidMoneyError('Cannot compare Money with different currencies', {
          context: {
            reason: MoneyErrorReason.CURRENCY_MISMATCH,
            expected: a.currency(),
            actual: b.currency()
          }
        });
      }
      return Ok(a.value().lessThan(b.value()));
    }, InvalidMoneyError);
  }

  /**
   * Сравнивает две суммы (a <= b)
   *
   * @param a - Первая сумма
   * @param b - Вторая сумма
   * @returns Result<boolean, InvalidMoneyError>
   * @throws Никогда - все ошибки в Result
   */
  public static isLessThanOrEqual(a: Money, b: Money): Result<boolean, InvalidMoneyError> {
    const ctx = { a: a.value().toString(), b: b.value().toString(), currency: a.currency() };
    return wrapOp(MoneyService.SERVICE_NAME, 'isLessThanOrEqual', ctx, () => {
      if (!a.hasSameCurrency(b)) {
        throw new InvalidMoneyError('Cannot compare Money with different currencies', {
          context: {
            reason: MoneyErrorReason.CURRENCY_MISMATCH,
            expected: a.currency(),
            actual: b.currency()
          }
        });
      }
      return Ok(a.value().lessThanOrEqualTo(b.value()));
    }, InvalidMoneyError);
  }

  /**
   * Сравнивает две суммы (a > b)
   *
   * @param a - Первая сумма
   * @param b - Вторая сумма
   * @returns Result<boolean, InvalidMoneyError>
   * @throws Никогда - все ошибки в Result
   */
  public static isGreaterThan(a: Money, b: Money): Result<boolean, InvalidMoneyError> {
    const ctx = { a: a.value().toString(), b: b.value().toString(), currency: a.currency() };
    return wrapOp(MoneyService.SERVICE_NAME, 'isGreaterThan', ctx, () => {
      if (!a.hasSameCurrency(b)) {
        throw new InvalidMoneyError('Cannot compare Money with different currencies', {
          context: {
            reason: MoneyErrorReason.CURRENCY_MISMATCH,
            expected: a.currency(),
            actual: b.currency()
          }
        });
      }
      return Ok(a.value().greaterThan(b.value()));
    }, InvalidMoneyError);
  }

  /**
   * Сравнивает две суммы (a >= b)
   *
   * @param a - Первая сумма
   * @param b - Вторая сумма
   * @returns Result<boolean, InvalidMoneyError>
   * @throws Никогда - все ошибки в Result
   */
  public static isGreaterThanOrEqual(a: Money, b: Money): Result<boolean, InvalidMoneyError> {
    const ctx = { a: a.value().toString(), b: b.value().toString(), currency: a.currency() };
    return wrapOp(MoneyService.SERVICE_NAME, 'isGreaterThanOrEqual', ctx, () => {
      if (!a.hasSameCurrency(b)) {
        throw new InvalidMoneyError('Cannot compare Money with different currencies', {
          context: {
            reason: MoneyErrorReason.CURRENCY_MISMATCH,
            expected: a.currency(),
            actual: b.currency()
          }
        });
      }
      return Ok(a.value().greaterThanOrEqualTo(b.value()));
    }, InvalidMoneyError);
  }

  /**
   * Проверяет равенство двух сумм
   *
   * @param a - Первая сумма
   * @param b - Вторая сумма
   * @returns Result<boolean, InvalidMoneyError>
   * @throws Никогда - все ошибки в Result
   *
   * @example
   * ```typescript
   * const result = MoneyService.equals(Money.of(new Decimal(100)), Money.of(new Decimal(100)));
   * if (result.ok && result.value) {
   *   console.log('Equal');
   * }
   * ```
   */
  public static equals(a: Money, b: Money): Result<boolean, InvalidMoneyError> {
    const ctx = { a: a.value().toString(), b: b.value().toString(), currency: a.currency() };
    return wrapOp(MoneyService.SERVICE_NAME, 'equals', ctx, () => {
      if (!a.hasSameCurrency(b)) {
        throw new InvalidMoneyError('Cannot compare Money with different currencies', {
          context: {
            reason: MoneyErrorReason.CURRENCY_MISMATCH,
            expected: a.currency(),
            actual: b.currency()
          }
        });
      }
      return Ok(a.value().equals(b.value()));
    }, InvalidMoneyError);
  }

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
   * - Price markup: `increaseBy(cost, RatioService.fromPercent(5))` → +5% markup
   * - Interest: `increaseBy(principal, RatioService.fromPercent(3))` → +3% interest
   * - Discount: `increaseBy(price, RatioService.fromPercent(-10))` → -10% discount
   *
   * **Инвариант:** delta >= -1
   * - delta = 0.1 → factor = 1.1 → увеличение на 10%
   * - delta = -0.5 → factor = 0.5 → уменьшение на 50%
   * - delta = -1 → factor = 0 → уменьшение на 100% (zero result)
   * - delta = -1.5 → ❌ DELTA_LESS_THAN_MINUS_ONE (factor отрицательный)
   *
   * **Процесс:**
   * 1. Валидация: delta >= -1 (через ValidateDeltaForIncreaseBy)
   * 2. Вычисление factor: 1 + delta (используем delta.onePlus())
   * 3. Multiply: m * factor
   * 4. Create Money через createFromDecimal()
   *
   * **Возможные ошибки:**
   * - DELTA_LESS_THAN_MINUS_ONE: delta < -1
   * - EXCEEDS_MAX_AMOUNT: результат превышает максимум
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

      // Вычисление factor: 1 + delta (используем Ratio.onePlus() для читаемости)
      const factor = delta.onePlus();

      // Multiply: m * factor
      const product = multiplyDecimal(m.value(), factor);

      // Create Money (проверит инварианты)
      return this.createFromDecimal(product, m.currency(), 'increaseBy', ctx);
    }, InvalidMoneyError);
  }

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
   * - Discount: `decreaseBy(price, RatioService.fromPercent(10))` → -10% скидка
   * - Depreciation: `decreaseBy(value, RatioService.fromPercent(15))` → -15% износ
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
    const result = this.increaseBy(m, negatedDelta);

    // Rewrap error чтобы заменить op с "increaseBy" на "decreaseBy"
    if (!result.ok) {
      return Err(rewrap(
        MoneyService.SERVICE_NAME,
        'decreaseBy',
        { m: m.value().toString(), delta: negatedDelta.toDecimal().toString(), currency: m.currency() },
        result.error,
        InvalidMoneyError
      ));
    }

    return result;
  }

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
   * - Fee: `portion(orderAmount, RatioService.fromPercent(2))` → 2% trading fee
   * - Rebate: `portion(paidAmount, RatioService.fromBps(25))` → 0.25% cashback
   * - Allocation: `portion(budget, RatioService.fromDecimal(0.3))` → 30% от бюджета
   *
   * **Знак rate:**
   * - Положительный rate (>= 0): стандартный случай (fees, allocations)
   * - Отрицательный rate (< 0): допустимо, результат будет отрицательным
   *
   * **Процесс:**
   * 1. Multiply: m.value() * rate.toDecimal()
   * 2. Create Money через createFromDecimal() (проверит инварианты)
   *
   * **Возможные ошибки:**
   * - EXCEEDS_MAX_AMOUNT: результат превышает максимум
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
}
