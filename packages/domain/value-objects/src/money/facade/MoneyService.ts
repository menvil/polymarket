import { Result, Ok, Err } from '@polymarket/result';
import Decimal from 'decimal.js';
import { InvalidMoneyError } from '@polymarket/errors';
import { addDecimal, subtractDecimal, multiplyDecimal, divideDecimal } from '@polymarket/math';
import { Money, SupportedCurrency } from '../core/Money';
import { MoneyInvariantViolation } from '../core/MoneyInvariantViolation';
import { ValidateFactorForMoneyMultiplication } from '../rules/ValidateFactorForMoneyMultiplication';
import { ValidateDivisorForMoneyDivision } from '../rules/ValidateDivisorForMoneyDivision';
import { MoneyErrorReason } from '../errors/MoneyErrorReason';
import { toDecimal, rewrap, wrapOp, unexpectedError } from '../../shared/facade/errorUtils';

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
    const decimalResult = toDecimal('value', value, MoneyErrorReason.INVALID_FORMAT, InvalidMoneyError);
    if (!decimalResult.ok) {
      // raw уже внутри err.context.raw от toDecimal
      return Err(rewrap('create', { currency }, decimalResult.error, InvalidMoneyError));
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
   * Только проверяет инварианты через Money.fromDecimal().
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
      return Ok(Money.fromDecimal(decimal, currency));
    } catch (error) {
      if (error instanceof MoneyInvariantViolation) {
        return this.mapInvariantToOverflow(op, {
          ...ctx,
          value: decimal.toString(),
          currency
        }, error);
      }

      // Unexpected error - возвращаем InvalidMoneyError
      return Err(unexpectedError(op, { value: decimal.toString(), currency, ...ctx }, error, 'money', InvalidMoneyError));
    }
  }

  /**
   * Мапит MoneyInvariantViolation → InvalidMoneyError
   *
   * @param op - Операция (add/subtract/multiply/divide)
   * @param ctx - Контекст (a, b, result, amount, factor, divisor, etc.)
   * @param e - MoneyInvariantViolation из Money.fromDecimal()
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
   * 3. Money.fromDecimal() (проверит инварианты через createFromDecimal)
   * 4. Маппинг через mapInvariantToOverflow
   *
   * Service НЕ проверяет MAX руками.
   *
   * @example
   * ```typescript
   * const result = MoneyService.add(Money.of(100), Money.of(50));
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
      return Err(rewrap('add', { a: a.value().toString(), b: b.value().toString(), currency: a.currency() }, baseError, InvalidMoneyError));
    }

    const ctx = { a: a.value().toString(), b: b.value().toString(), currency: a.currency() };
    return wrapOp('add', ctx, () => {
      const sum = addDecimal(a.value(), b.value());
      return this.createFromDecimal(sum, a.currency(), 'add', ctx);
    }, 'money', InvalidMoneyError);
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
   * 3. Money.fromDecimal() (проверит инварианты через createFromDecimal)
   * 4. Маппинг через mapInvariantToOverflow
   *
   * @example
   * ```typescript
   * const result = MoneyService.subtract(Money.of(100), Money.of(30));
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
      return Err(rewrap('subtract', { a: a.value().toString(), b: b.value().toString(), currency: a.currency() }, baseError, InvalidMoneyError));
    }

    const ctx = { a: a.value().toString(), b: b.value().toString(), currency: a.currency() };
    return wrapOp('subtract', ctx, () => {
      const diff = subtractDecimal(a.value(), b.value());
      return this.createFromDecimal(diff, a.currency(), 'subtract', ctx);
    }, 'money', InvalidMoneyError);
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
   * const result = MoneyService.multiply(Money.of(100), 1.5);
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
    const factorResult = toDecimal('factor', factor, MoneyErrorReason.INVALID_FORMAT, InvalidMoneyError);
    if (!factorResult.ok) {
      return Err(
        rewrap('multiply', {
          amount: m.value().toString(),
          factor: String(factor),
          currency: m.currency()
        }, factorResult.error, InvalidMoneyError)
      );
    }

    const factorDecimal = factorResult.value;

    // Валидация через rule (проверяет isNaN, isFinite)
    const validateResult = ValidateFactorForMoneyMultiplication.check(factorDecimal);
    if (!validateResult.ok) {
      return Err(
        rewrap('multiply', {
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

    return wrapOp('multiply', ctx, () => {
      const product = multiplyDecimal(m.value(), factorDecimal);
      return this.createFromDecimal(product, m.currency(), 'multiply', ctx);
    }, 'money', InvalidMoneyError);
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
   * const result = MoneyService.divide(Money.of(100), 2);
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
    const divisorResult = toDecimal('divisor', divisor, MoneyErrorReason.INVALID_FORMAT, InvalidMoneyError);
    if (!divisorResult.ok) {
      return Err(
        rewrap('divide', {
          amount: m.value().toString(),
          divisor: String(divisor),
          currency: m.currency()
        }, divisorResult.error, InvalidMoneyError)
      );
    }

    const divisorDecimal = divisorResult.value;

    // Валидация через rule
    const validateResult = ValidateDivisorForMoneyDivision.check(divisorDecimal);
    if (!validateResult.ok) {
      return Err(
        rewrap('divide', {
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

    return wrapOp('divide', ctx, () => {
      const quotient = divideDecimal(m.value(), divisorDecimal);
      return this.createFromDecimal(quotient, m.currency(), 'divide', ctx);
    }, 'money', InvalidMoneyError);
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
   * const result = MoneyService.isLessThan(Money.of(100), Money.of(200));
   * if (!result.ok) {
   *   console.error('Currency mismatch');
   * } else if (result.value) {
   *   console.log('a < b');
   * }
   * ```
   */
  public static isLessThan(a: Money, b: Money): Result<boolean, InvalidMoneyError> {
    if (!a.hasSameCurrency(b)) {
      return Err(new InvalidMoneyError('Cannot compare Money with different currencies', {
        context: {
          op: 'isLessThan',
          reason: MoneyErrorReason.CURRENCY_MISMATCH,
          expected: a.currency(),
          actual: b.currency()
        }
      }));
    }
    return Ok(a.value().lessThan(b.value()));
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
    if (!a.hasSameCurrency(b)) {
      return Err(new InvalidMoneyError('Cannot compare Money with different currencies', {
        context: {
          op: 'isLessThanOrEqual',
          reason: MoneyErrorReason.CURRENCY_MISMATCH,
          expected: a.currency(),
          actual: b.currency()
        }
      }));
    }
    return Ok(a.value().lessThanOrEqualTo(b.value()));
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
    if (!a.hasSameCurrency(b)) {
      return Err(new InvalidMoneyError('Cannot compare Money with different currencies', {
        context: {
          op: 'isGreaterThan',
          reason: MoneyErrorReason.CURRENCY_MISMATCH,
          expected: a.currency(),
          actual: b.currency()
        }
      }));
    }
    return Ok(a.value().greaterThan(b.value()));
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
    if (!a.hasSameCurrency(b)) {
      return Err(new InvalidMoneyError('Cannot compare Money with different currencies', {
        context: {
          op: 'isGreaterThanOrEqual',
          reason: MoneyErrorReason.CURRENCY_MISMATCH,
          expected: a.currency(),
          actual: b.currency()
        }
      }));
    }
    return Ok(a.value().greaterThanOrEqualTo(b.value()));
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
   * const result = MoneyService.equals(Money.of(100), Money.of(100));
   * if (result.ok && result.value) {
   *   console.log('Equal');
   * }
   * ```
   */
  public static equals(a: Money, b: Money): Result<boolean, InvalidMoneyError> {
    if (!a.hasSameCurrency(b)) {
      return Err(new InvalidMoneyError('Cannot compare Money with different currencies', {
        context: {
          op: 'equals',
          reason: MoneyErrorReason.CURRENCY_MISMATCH,
          expected: a.currency(),
          actual: b.currency()
        }
      }));
    }
    return Ok(a.value().equals(b.value()));
  }

  /**
   * Проверяет что сумма равна нулю
   *
   * @param money - Money для проверки
   * @returns true если сумма равна 0
   *
   * @example
   * ```typescript
   * MoneyService.isZero(Money.ZERO.USDC); // true
   * MoneyService.isZero(Money.of(100));   // false
   * ```
   */
  public static isZero(money: Money): boolean {
    return money.value().isZero();
  }

  /**
   * Проверяет что сумма положительная (> 0)
   *
   * @param money - Money для проверки
   * @returns true если сумма > 0
   *
   * @example
   * ```typescript
   * MoneyService.isPositive(Money.of(100));  // true
   * MoneyService.isPositive(Money.ZERO.USDC); // false
   * ```
   */
  public static isPositive(money: Money): boolean {
    return money.value().greaterThan(0);
  }

  /**
   * Проверяет что сумма отрицательная (< 0)
   *
   * @param money - Money для проверки
   * @returns true если сумма < 0
   *
   * @example
   * ```typescript
   * MoneyService.isNegative(Money.of(-100)); // true
   * MoneyService.isNegative(Money.of(100));  // false
   * ```
   */
  public static isNegative(money: Money): boolean {
    return money.value().lessThan(0);
  }
}
