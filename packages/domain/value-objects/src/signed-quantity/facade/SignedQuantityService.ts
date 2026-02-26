import { Result, Ok, Err, isErr } from '@polymarket/result';
import { SignedQuantity } from '../core/SignedQuantity.js';
import { InvalidSignedQuantityError, toDecimal, rewrap, wrapOp } from '@polymarket/errors';
import { addDecimal, subtractDecimal, multiplyDecimal, divideDecimal, roundToTick } from '@polymarket/math';
import Decimal from 'decimal.js';
import { SignedQuantityErrorReason } from '../errors/SignedQuantityErrorReason.js';
import { Ratio } from '../../ratio/core/Ratio.js';
import { ValidateStepSizeForQuantity } from '../../quantity/rules/ValidateStepSizeForQuantity.js';
import { ValidateFactorForSignedQuantityScale, ValidateDeltaForAdjustByNoCrossZero } from '../rules/index.js';

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

  /**
   * Масштабирует знаковое количество на rate (безопасная операция)
   *
   * @remarks
   * Масштабирует количество на неотрицательный rate.
   * Требует rate >= 0 для предотвращения инверсии знака.
   *
   * Алгоритм:
   * 1. Извлечь rate как Decimal через Ratio.toDecimal()
   * 2. Валидация rate >= 0 и isFinite через ValidateFactorForSignedQuantityScale
   * 3. Умножение через multiplyDecimal()
   * 4. Создание SignedQuantity через createFromDecimal()
   *
   * @param quantity - Знаковое количество для масштабирования
   * @param rate - Коэффициент масштабирования (должен быть >= 0)
   * @returns Result<SignedQuantity, InvalidSignedQuantityError>
   *
   * @example
   * ```typescript
   * const qty = SignedQuantityService.create(100).value;
   * const rate = RatioService.fromDecimal(2).value;
   *
   * // Масштабирование на 2x
   * const result = SignedQuantityService.scale(qty, rate);
   * // result.value = SignedQuantity(200)
   *
   * // Ошибка для negative rate
   * const negRate = RatioService.fromDecimal(-1).value;
   * const errorResult = SignedQuantityService.scale(qty, negRate);
   * // errorResult.error.context.reason = NEGATIVE_SCALE_FACTOR
   * ```
   */
  public static scale(
    quantity: SignedQuantity,
    rate: Ratio
  ): Result<SignedQuantity, InvalidSignedQuantityError> {
    const rateDec = rate.toDecimal();

    // Валидация: rate должен быть >= 0 и finite
    const validateResult = ValidateFactorForSignedQuantityScale.check(rateDec);
    if (isErr(validateResult)) {
      return Err(
        rewrap(SignedQuantityService.SERVICE_NAME, 'scale', {
          quantity: quantity.value().toString(),
          rate: rateDec.toString()
        }, validateResult.error, InvalidSignedQuantityError)
      );
    }

    const ctx = {
      quantity: quantity.value().toString(),
      rate: rateDec.toString()
    };

    return wrapOp(SignedQuantityService.SERVICE_NAME, 'scale', ctx, () => {
      const result = multiplyDecimal(quantity.value(), rateDec);
      return this.createFromDecimal(result);
    }, InvalidSignedQuantityError);
  }

  /**
   * Вычисляет часть знакового количества (гибкая операция)
   *
   * @remarks
   * Вычисляет часть количества как quantity * rate.
   * В отличие от scale(), принимает любой rate (включая отрицательный),
   * что позволяет инвертировать знак результата.
   *
   * Алгоритм:
   * 1. Извлечь rate как Decimal через Ratio.toDecimal()
   * 2. Умножение через multiplyDecimal() (БЕЗ валидации знака rate)
   * 3. Создание SignedQuantity через createFromDecimal()
   *
   * @param quantity - Знаковое количество
   * @param rate - Коэффициент (может быть любым finite)
   * @returns Result<SignedQuantity, InvalidSignedQuantityError>
   *
   * @example
   * ```typescript
   * const qty = SignedQuantityService.create(100).value;
   * const rate = RatioService.fromDecimal(0.25).value;
   *
   * // Взять 25%
   * const result = SignedQuantityService.portion(qty, rate);
   * // result.value = SignedQuantity(25)
   *
   * // Negative rate инвертирует знак
   * const negRate = RatioService.fromDecimal(-0.5).value;
   * const inverted = SignedQuantityService.portion(qty, negRate);
   * // inverted.value = SignedQuantity(-50)
   * ```
   */
  public static portion(
    quantity: SignedQuantity,
    rate: Ratio
  ): Result<SignedQuantity, InvalidSignedQuantityError> {
    const rateDec = rate.toDecimal();

    const ctx = {
      quantity: quantity.value().toString(),
      rate: rateDec.toString()
    };

    return wrapOp(SignedQuantityService.SERVICE_NAME, 'portion', ctx, () => {
      const result = multiplyDecimal(quantity.value(), rateDec);
      return this.createFromDecimal(result);
    }, InvalidSignedQuantityError);
  }

  /**
   * Округляет знаковое количество до шага
   *
   * @remarks
   * Округляет количество до ближайшего кратного stepSize с указанным режимом округления.
   * Корректно обрабатывает отрицательные значения согласно режиму округления.
   *
   * Режимы округления (Decimal.Rounding):
   * - ROUND_HALF_UP (default) - к ближайшему, .5 вверх
   * - ROUND_DOWN - к нулю (floor для positive, ceil для negative)
   * - ROUND_UP - от нуля (ceil для positive, floor для negative)
   * - ROUND_FLOOR - всегда к -Infinity
   * - ROUND_CEIL - всегда к +Infinity
   *
   * Алгоритм:
   * 1. Парсинг stepSize в Decimal через toDecimal()
   * 2. Валидация stepSize > 0 и isFinite через ValidateStepSizeForQuantity
   * 3. Округление через roundToTick()
   * 4. Создание SignedQuantity через createFromDecimal()
   *
   * @param quantity - Знаковое количество для округления
   * @param stepSize - Размер шага (должен быть > 0)
   * @param roundingMode - Режим округления (default: ROUND_HALF_UP)
   * @returns Result<SignedQuantity, InvalidSignedQuantityError>
   *
   * @example
   * ```typescript
   * const qty = SignedQuantityService.create(10.567).value;
   *
   * // Округление до 0.01 (центы) - ROUND_HALF_UP
   * const result = SignedQuantityService.roundToStep(qty, 0.01);
   * // result.value = SignedQuantity(10.57)
   *
   * // Округление negative - ROUND_DOWN (к нулю)
   * const negQty = SignedQuantityService.create(-10.567).value;
   * const negResult = SignedQuantityService.roundToStep(negQty, 0.01, Decimal.ROUND_DOWN);
   * // negResult.value = SignedQuantity(-10.56) - к нулю
   *
   * // ROUND_FLOOR - к -Infinity
   * const floorResult = SignedQuantityService.roundToStep(negQty, 0.01, Decimal.ROUND_FLOOR);
   * // floorResult.value = SignedQuantity(-10.57) - к -Infinity
   * ```
   */
  public static roundToStep(
    quantity: SignedQuantity,
    stepSize: number | string | Decimal,
    roundingMode: Decimal.Rounding = Decimal.ROUND_HALF_UP
  ): Result<SignedQuantity, InvalidSignedQuantityError> {
    // Парсинг stepSize
    const stepSizeResult = toDecimal('stepSize', stepSize, SignedQuantityErrorReason.INVALID_FORMAT, InvalidSignedQuantityError, {
      nanReason: SignedQuantityErrorReason.NAN,
      nonFiniteReason: SignedQuantityErrorReason.NON_FINITE,
    });
    if (isErr(stepSizeResult)) {
      return Err(
        rewrap(SignedQuantityService.SERVICE_NAME, 'roundToStep', {
          quantity: quantity.value().toString(),
          stepSize: String(stepSize)
        }, stepSizeResult.error, InvalidSignedQuantityError)
      );
    }

    const stepSizeDec = stepSizeResult.value;

    // Валидация stepSize через правило из Quantity (stepSize > 0 и finite)
    const validateResult = ValidateStepSizeForQuantity.check(stepSizeDec);
    if (isErr(validateResult)) {
      // ValidateStepSizeForQuantity возвращает InvalidQuantityError, нужно rewrap в InvalidSignedQuantityError
      return Err(
        rewrap(SignedQuantityService.SERVICE_NAME, 'roundToStep', {
          quantity: quantity.value().toString(),
          stepSize: stepSizeDec.toString(),
          roundingMode: String(roundingMode)
        }, validateResult.error, InvalidSignedQuantityError)
      );
    }

    const ctx = {
      quantity: quantity.value().toString(),
      stepSize: stepSizeDec.toString(),
      roundingMode: String(roundingMode)
    };

    return wrapOp(SignedQuantityService.SERVICE_NAME, 'roundToStep', ctx, () => {
      const rounded = roundToTick(quantity.value(), stepSizeDec, roundingMode);
      return this.createFromDecimal(rounded);
    }, InvalidSignedQuantityError);
  }

  /**
   * Изменяет знаковое количество на процент с округлением
   *
   * @remarks
   * Применяет процентное изменение к количеству: quantity * (1 + delta), затем округляет до stepSize.
   *
   * Опция allowCrossZero контролирует поведение при пересечении нуля:
   * - allowCrossZero = true (default): разрешает смену знака (long → short или наоборот)
   * - allowCrossZero = false: запрещает пересечение нуля (защита от случайного флипа позиции)
   *
   * При allowCrossZero = false:
   * - Если original === 0 → ошибка CANNOT_ADJUST_ZERO
   * - Если sign(original) !== sign(result) && result !== 0 → ошибка RESULT_CROSSES_ZERO
   * - Если result === 0 → OK (граничный случай)
   *
   * Алгоритм:
   * 1. Парсинг stepSize в Decimal через toDecimal()
   * 2. Валидация stepSize > 0 и isFinite через ValidateStepSizeForQuantity
   * 3. Вычисление multiplier = delta.onePlus() (1 + delta)
   * 4. Умножение quantity * multiplier через multiplyDecimal()
   * 5. Округление до stepSize через roundToTick()
   * 6. Если allowCrossZero = false: валидация через ValidateDeltaForAdjustByNoCrossZero
   * 7. Создание SignedQuantity через createFromDecimal()
   *
   * @param quantity - Знаковое количество для изменения
   * @param delta - Процентное изменение (Ratio: 0.1 для +10%, -0.2 для -20%)
   * @param stepSize - Размер шага для округления (должен быть > 0)
   * @param options - Опции: roundingMode (default: ROUND_HALF_UP), allowCrossZero (default: true)
   * @returns Result<SignedQuantity, InvalidSignedQuantityError>
   *
   * @example
   * ```typescript
   * const qty = SignedQuantityService.create(100).value;
   * const delta = RatioService.fromPercent(10).value; // +10%
   *
   * // Увеличение на 10% с округлением до 0.01
   * const result = SignedQuantityService.adjustBy(qty, delta, 0.01);
   * // result.value = SignedQuantity(110)
   *
   * // Уменьшение на 20%
   * const decrease = RatioService.fromPercent(-20).value;
   * const decreased = SignedQuantityService.adjustBy(qty, decrease, 0.01);
   * // decreased.value = SignedQuantity(80)
   *
   * // allowCrossZero = false (защита от флипа)
   * const large = RatioService.fromPercent(-150).value; // -150%
   * const errorResult = SignedQuantityService.adjustBy(qty, large, 0.01, { allowCrossZero: false });
   * // errorResult.error.context.reason = RESULT_CROSSES_ZERO
   *
   * // Граничный случай: result === 0 допустим
   * const exact = RatioService.fromPercent(-100).value;
   * const zeroResult = SignedQuantityService.adjustBy(qty, exact, 0.01, { allowCrossZero: false });
   * // zeroResult.value = SignedQuantity(0) - OK
   * ```
   */
  public static adjustBy(
    quantity: SignedQuantity,
    delta: Ratio,
    stepSize: number | string | Decimal,
    options?: {
      roundingMode?: Decimal.Rounding;
      allowCrossZero?: boolean;
    }
  ): Result<SignedQuantity, InvalidSignedQuantityError> {
    // Извлекаем опции с defaults
    const roundingMode = options?.roundingMode ?? Decimal.ROUND_HALF_UP;
    const allowCrossZero = options?.allowCrossZero ?? true;

    // Парсинг stepSize
    const stepSizeResult = toDecimal('stepSize', stepSize, SignedQuantityErrorReason.INVALID_FORMAT, InvalidSignedQuantityError, {
      nanReason: SignedQuantityErrorReason.NAN,
      nonFiniteReason: SignedQuantityErrorReason.NON_FINITE,
    });
    if (isErr(stepSizeResult)) {
      return Err(
        rewrap(SignedQuantityService.SERVICE_NAME, 'adjustBy', {
          quantity: quantity.value().toString(),
          delta: delta.toDecimal().toString(),
          stepSize: String(stepSize)
        }, stepSizeResult.error, InvalidSignedQuantityError)
      );
    }

    const stepSizeDec = stepSizeResult.value;

    // Валидация stepSize через правило из Quantity
    const validateStepResult = ValidateStepSizeForQuantity.check(stepSizeDec);
    if (isErr(validateStepResult)) {
      return Err(
        rewrap(SignedQuantityService.SERVICE_NAME, 'adjustBy', {
          quantity: quantity.value().toString(),
          delta: delta.toDecimal().toString(),
          stepSize: stepSizeDec.toString(),
          roundingMode: String(roundingMode),
          allowCrossZero: String(allowCrossZero)
        }, validateStepResult.error, InvalidSignedQuantityError)
      );
    }

    const ctx = {
      quantity: quantity.value().toString(),
      delta: delta.toDecimal().toString(),
      stepSize: stepSizeDec.toString(),
      roundingMode: String(roundingMode),
      allowCrossZero: String(allowCrossZero)
    };

    return wrapOp(SignedQuantityService.SERVICE_NAME, 'adjustBy', ctx, () => {
      // Вычисляем multiplier = (1 + delta)
      const multiplier = delta.onePlus();

      // Умножаем quantity * multiplier
      const newValue = multiplyDecimal(quantity.value(), multiplier);

      // Округляем до stepSize
      const rounded = roundToTick(newValue, stepSizeDec, roundingMode);

      // Если allowCrossZero = false, проверяем пересечение нуля
      if (!allowCrossZero) {
        const validateCrossResult = ValidateDeltaForAdjustByNoCrossZero.check(quantity.value(), rounded);
        if (isErr(validateCrossResult)) {
          return Err(validateCrossResult.error);
        }
      }

      // Создаём результат
      return this.createFromDecimal(rounded);
    }, InvalidSignedQuantityError);
  }
}
