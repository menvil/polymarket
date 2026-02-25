import { Result, Ok, Err, isErr } from '@polymarket/result';
import { SignedQuantity } from '../core/SignedQuantity.js';
import { InvalidSignedQuantityError, toDecimal, rewrap, wrapOp } from '@polymarket/errors';
import { addDecimal, subtractDecimal, multiplyDecimal, divideDecimal } from '@polymarket/math';
import Decimal from 'decimal.js';
import { SignedQuantityErrorReason } from '../errors/SignedQuantityErrorReason.js';

/**
 * Фасад для работы с SignedQuantity
 *
 * @remarks
 * Единая точка входа для всех операций со знаковыми количествами.
 * Оркестрирует Core + Math.
 *
 * **Контракт "Never Throw":**
 * ВСЕ методы SignedQuantityService ГАРАНТИРОВАННО возвращают Result и НИКОГДА не бросают исключения.
 * Любые исключения из @polymarket/math, Core инвариантов ловятся и преобразуются в Result.Err.
 *
 * **Facade Error Contract:**
 * Любой Err из Facade содержит:
 * - context.op - название операции ('create', 'add', 'divide', 'abs', 'negate', etc.)
 * - context.opChain - цепочка операций (внутренние op не теряются)
 * - context.quantity - входной quantity (если применимо)
 * - context.quantity1, quantity2 - для бинарных операций (add, subtract)
 * - context.divisor - для divide
 * - context.factor - для multiply
 * - context.raw - сырой ввод (для ошибок парсинга): { field, value }
 * - context.cause - для math-исключений: { name, message, stack? } (root-cause, не перетирается)
 * - context.reason - для инвариантов Core (root, не перетирается)
 *
 * **Правило возвращаемых типов:**
 * ВСЕ операции возвращают Result<T, InvalidSignedQuantityError>
 * ОЖИДАЕМЫЕ и НЕОЖИДАННЫЕ ошибки обрабатываются через Result
 *
 * **Отличия от QuantityService:**
 * - SignedQuantity может быть отрицательным (нет проверок non-negative)
 * - Операции могут принимать отрицательные значения
 * - Дополнительные методы: abs(), negate()
 *
 * @example
 * ```typescript
 * import { SignedQuantityService } from '@polymarket/value-objects';
 *
 * // Создание положительного
 * const positive = SignedQuantityService.create(10);
 *
 * // Создание отрицательного
 * const negative = SignedQuantityService.create(-10);
 *
 * // Создание нуля
 * const zero = SignedQuantityService.create(0);
 *
 * // Операции
 * const sum = SignedQuantityService.add(positive.value, negative.value);
 * const abs = SignedQuantityService.abs(negative.value);
 * const negated = SignedQuantityService.negate(positive.value);
 * ```
 */
export class SignedQuantityService {
  private static readonly SERVICE_NAME = 'SignedQuantityService';

  /**
   * Создаёт SignedQuantity из значения
   *
   * @remarks
   * ПУБЛИЧНЫЙ способ создания SignedQuantity.
   * Возвращает Result вместо исключений.
   *
   * Core инварианты проверяются автоматически через SignedQuantity.of():
   * - finite (не NaN, не Infinity)
   * - может быть отрицательным, нулевым или положительным
   *
   * Использует toDecimal() для надёжного парсинга без instanceof.
   * Гарантирует Result - никогда не бросает исключения.
   *
   * @param value - Значение для создания (number, string, или Decimal)
   * @returns Result<SignedQuantity, InvalidSignedQuantityError>
   *
   * @example
   * ```typescript
   * // Положительное
   * const positive = SignedQuantityService.create(10);
   * if (isErr(positive)) {
   *   console.error(positive.error.context.op); // 'create'
   * }
   *
   * // Отрицательное
   * const negative = SignedQuantityService.create(-10);
   *
   * // Ноль
   * const zero = SignedQuantityService.create(0);
   * ```
   */
  public static create(value: number | string | Decimal): Result<SignedQuantity, InvalidSignedQuantityError> {
    // Безопасный парсинг value через toDecimal
    const decimalResult = toDecimal('value', value, SignedQuantityErrorReason.INVALID_FORMAT, InvalidSignedQuantityError, {
      nanReason: SignedQuantityErrorReason.NAN,
      nonFiniteReason: SignedQuantityErrorReason.NON_FINITE,
    });
    if (isErr(decimalResult)) {
      // raw уже внутри err.context.raw от toDecimal
      return Err(rewrap(SignedQuantityService.SERVICE_NAME, 'create', {}, decimalResult.error, InvalidSignedQuantityError));
    }

    return wrapOp(
      SignedQuantityService.SERVICE_NAME,
      'create',
      {
        raw: { field: 'value', value: String(value) }
      },
      () => {
        // ВАЖНО: Core получает уже Decimal -> только проверка инвариантов, не парсинг
        const quantity = SignedQuantity.of(decimalResult.value);
        return Ok(quantity);
      },
      InvalidSignedQuantityError
    );
  }

  /**
   * Создаёт SignedQuantity из уже валидированного Decimal без повторного парсинга
   *
   * @remarks
   * Внутренний хелпер для операций, результат которых уже представлен как Decimal.
   * Обходит toDecimal(), т.к. входное значение уже прошло парсинг.
   * Всё ещё проверяет Core инварианты через SignedQuantity.of().
   *
   * @param decimal - Уже готовый Decimal (не парсится повторно)
   * @returns Result<SignedQuantity, InvalidSignedQuantityError>
   */
  private static createFromDecimal(decimal: Decimal): Result<SignedQuantity, InvalidSignedQuantityError> {
    return wrapOp(
      SignedQuantityService.SERVICE_NAME,
      'create',
      { value: decimal.toString() },
      () => Ok(SignedQuantity.of(decimal)),
      InvalidSignedQuantityError
    );
  }

  /**
   * Складывает два знаковых количества
   *
   * @remarks
   * Возвращает Result потому что результат может быть non-finite (overflow → Infinity).
   * Оркестрирует: сложение через math → создание SignedQuantity через createFromDecimal() (проверит инварианты)
   *
   * Обработка ошибок:
   * 1. Сложение через addDecimal() (может бросить InvalidOperandError, ArithmeticOverflowError)
   * 2. Создание SignedQuantity через createFromDecimal()
   *
   * Все исключения ловятся и мапятся в Result.Err.
   * Метод никогда не бросает исключения.
   *
   * @param qty1 - Первое количество
   * @param qty2 - Второе количество
   * @returns Result<SignedQuantity, InvalidSignedQuantityError>
   *
   * @example
   * ```typescript
   * const result = SignedQuantityService.add(qty1, qty2);
   * if (isErr(result)) {
   *   console.error(result.error.context.op); // 'add'
   * }
   * ```
   */
  public static add(qty1: SignedQuantity, qty2: SignedQuantity): Result<SignedQuantity, InvalidSignedQuantityError> {
    const ctx = { quantity1: qty1.value().toString(), quantity2: qty2.value().toString() };
    return wrapOp(SignedQuantityService.SERVICE_NAME, 'add', ctx, () => {
      const sum = addDecimal(qty1.value(), qty2.value());
      return this.createFromDecimal(sum);
    }, InvalidSignedQuantityError);
  }

  /**
   * Вычитает знаковые количества
   *
   * @remarks
   * Оркестрирует: вычитание → создание SignedQuantity
   * ВАЖНО: Результат может быть отрицательным (в отличие от QuantityService)
   *
   * Обработка ошибок:
   * 1. Вычитание через subtractDecimal() (может бросить InvalidOperandError, ArithmeticOverflowError)
   * 2. Создание SignedQuantity через createFromDecimal()
   *
   * Все исключения ловятся и мапятся в Result.Err.
   * Метод никогда не бросает исключения.
   *
   * @param qty1 - Уменьшаемое
   * @param qty2 - Вычитаемое
   * @returns Result<SignedQuantity, InvalidSignedQuantityError>
   *
   * @example
   * ```typescript
   * const result = SignedQuantityService.subtract(qty1, qty2);
   * if (isErr(result)) {
   *   console.error(result.error.context.op); // 'subtract'
   * }
   * // Результат может быть отрицательным!
   * ```
   */
  public static subtract(
    qty1: SignedQuantity,
    qty2: SignedQuantity
  ): Result<SignedQuantity, InvalidSignedQuantityError> {
    const ctx = { quantity1: qty1.value().toString(), quantity2: qty2.value().toString() };
    return wrapOp(SignedQuantityService.SERVICE_NAME, 'subtract', ctx, () => {
      const diff = subtractDecimal(qty1.value(), qty2.value());
      return this.createFromDecimal(diff);
    }, InvalidSignedQuantityError);
  }

  /**
   * Умножает знаковое количество на коэффициент
   *
   * @remarks
   * Оркестрирует: парсинг factor → умножение → создание SignedQuantity
   * ВАЖНО: factor может быть отрицательным (в отличие от QuantityService)
   * Гарантирует Result - парсинг Decimal обёрнут в toDecimal()
   *
   * @param quantity - Количество для умножения
   * @param factor - Коэффициент (number, string, или Decimal - парсится безопасно, может быть отрицательным)
   * @returns Result<SignedQuantity, InvalidSignedQuantityError>
   *
   * @example
   * ```typescript
   * // Умножение на положительный
   * const result = SignedQuantityService.multiply(qty, 2);
   *
   * // Умножение на отрицательный (инверсия знака)
   * const result2 = SignedQuantityService.multiply(qty, -1);
   *
   * if (isErr(result)) {
   *   console.error(result.error.context.op); // 'multiply'
   *   console.error(result.error.context.factor); // '2'
   * }
   * ```
   */
  public static multiply(
    quantity: SignedQuantity,
    factor: number | string | Decimal
  ): Result<SignedQuantity, InvalidSignedQuantityError> {
    // Безопасный парсинг factor через toDecimal
    const factorResult = toDecimal('factor', factor, SignedQuantityErrorReason.INVALID_FORMAT, InvalidSignedQuantityError, {
      nanReason: SignedQuantityErrorReason.NAN,
      nonFiniteReason: SignedQuantityErrorReason.NON_FINITE,
    });
    if (isErr(factorResult)) {
      return Err(
        rewrap(SignedQuantityService.SERVICE_NAME, 'multiply', {
          quantity: quantity.value().toString(),
          factor: String(factor)
        }, factorResult.error, InvalidSignedQuantityError)
      );
    }

    const factorDecimal = factorResult.value;

    // Умножение с обработкой ожидаемых арифметических исключений
    const ctx = {
      quantity: quantity.value().toString(),
      factor: factorDecimal.toString()
    };

    return wrapOp(SignedQuantityService.SERVICE_NAME, 'multiply', ctx, () => {
      const result = multiplyDecimal(quantity.value(), factorDecimal);
      return this.createFromDecimal(result);
    }, InvalidSignedQuantityError);
  }

  /**
   * Делит знаковое количество на делитель с проверкой
   *
   * @param quantity - Количество для деления
   * @param divisor - Делитель (number, string, или Decimal - парсится безопасно)
   * @returns Result<SignedQuantity, InvalidSignedQuantityError>
   * @throws Никогда - все ошибки оборачиваются в Result
   *
   * @remarks
   * Единый контракт обработки ошибок - все ошибки оборачиваются в Result:
   * - Парсинг divisor → InvalidSignedQuantityError
   * - Деление на ноль → InvalidSignedQuantityError с reason = DIVISION_BY_ZERO
   * - DivisionByZeroError, InvalidOperandError, ArithmeticOverflowError → InvalidSignedQuantityError с причиной в context.cause
   * - Неожиданные ошибки → InvalidSignedQuantityError с полным контекстом
   * - Результат вне диапазона → InvalidSignedQuantityError
   *
   * Алгоритм:
   * 1. Парсинг divisor в Decimal через toDecimal()
   * 2. Проверка на ноль
   * 3. Деление через divideDecimal() из @polymarket/math
   * 4. Создание SignedQuantity из результата
   *
   * Все исключения ловятся и мапятся в Result.Err.
   * Метод никогда не бросает исключения.
   *
   * @example
   * ```typescript
   * const result = SignedQuantityService.divide(qty, 2);
   * if (isErr(result)) {
   *   console.error(result.error.context.op); // 'divide'
   *   console.error(result.error.context.cause); // { name, message } для исключений
   * }
   * ```
   */
  public static divide(
    quantity: SignedQuantity,
    divisor: number | string | Decimal
  ): Result<SignedQuantity, InvalidSignedQuantityError> {
    // Безопасный парсинг divisor через toDecimal
    const divisorResult = toDecimal('divisor', divisor, SignedQuantityErrorReason.INVALID_FORMAT, InvalidSignedQuantityError, {
      nanReason: SignedQuantityErrorReason.NAN,
      nonFiniteReason: SignedQuantityErrorReason.NON_FINITE,
    });
    if (isErr(divisorResult)) {
      return Err(
        rewrap(SignedQuantityService.SERVICE_NAME, 'divide', {
          quantity: quantity.value().toString(),
          divisor: String(divisor)
        }, divisorResult.error, InvalidSignedQuantityError)
      );
    }

    const divisorDecimal = divisorResult.value;

    // Проверка на ноль
    if (divisorDecimal.isZero()) {
      return Err(new InvalidSignedQuantityError(
        'Cannot divide by zero',
        {
          code: InvalidSignedQuantityError.code,
          context: {
            op: 'divide',
            quantity: quantity.value().toString(),
            divisor: divisorDecimal.toString(),
            reason: SignedQuantityErrorReason.DIVISION_BY_ZERO
          }
        }
      ));
    }

    // Делим с обработкой ожидаемых арифметических исключений
    const ctx = {
      quantity: quantity.value().toString(),
      divisor: divisorDecimal.toString()
    };

    return wrapOp(SignedQuantityService.SERVICE_NAME, 'divide', ctx, () => {
      const result = divideDecimal(quantity.value(), divisorDecimal);
      return this.createFromDecimal(result);
    }, InvalidSignedQuantityError);
  }

  /**
   * Возвращает абсолютное значение знакового количества
   *
   * @remarks
   * Преобразует отрицательное значение в положительное.
   * Положительное и ноль остаются неизменными.
   *
   * @param quantity - Знаковое количество
   * @returns Result<SignedQuantity, InvalidSignedQuantityError>
   *
   * @example
   * ```typescript
   * const negative = SignedQuantityService.create(-10);
   * const result = SignedQuantityService.abs(negative.value);
   * // result.value = SignedQuantity(10)
   *
   * const positive = SignedQuantityService.create(10);
   * const result2 = SignedQuantityService.abs(positive.value);
   * // result2.value = SignedQuantity(10)
   * ```
   */
  public static abs(quantity: SignedQuantity): Result<SignedQuantity, InvalidSignedQuantityError> {
    const ctx = { quantity: quantity.value().toString() };
    return wrapOp(SignedQuantityService.SERVICE_NAME, 'abs', ctx, () => {
      const absDecimal = quantity.abs();
      return this.createFromDecimal(absDecimal);
    }, InvalidSignedQuantityError);
  }

  /**
   * Возвращает значение с противоположным знаком
   *
   * @remarks
   * Инверсия знака: положительное → отрицательное, отрицательное → положительное, 0 → 0.
   *
   * @param quantity - Знаковое количество
   * @returns Result<SignedQuantity, InvalidSignedQuantityError>
   *
   * @example
   * ```typescript
   * const positive = SignedQuantityService.create(10);
   * const result = SignedQuantityService.negate(positive.value);
   * // result.value = SignedQuantity(-10)
   *
   * const negative = SignedQuantityService.create(-10);
   * const result2 = SignedQuantityService.negate(negative.value);
   * // result2.value = SignedQuantity(10)
   * ```
   */
  public static negate(quantity: SignedQuantity): Result<SignedQuantity, InvalidSignedQuantityError> {
    const ctx = { quantity: quantity.value().toString() };
    return wrapOp(SignedQuantityService.SERVICE_NAME, 'negate', ctx, () => {
      const negated = quantity.neg();
      return Ok(negated);
    }, InvalidSignedQuantityError);
  }
}
