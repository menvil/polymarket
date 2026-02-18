import { Result, Ok, Err, isErr } from '@polymarket/result';
import { Quantity } from '../core/Quantity.js';
import { InvalidQuantityError, toDecimal, rewrap, wrapOp } from '@polymarket/errors';
import { ValidateResultNonNegative } from '../rules/ValidateResultNonNegative.js';
import { ValidateFactorForQuantityMultiplication } from '../rules/ValidateFactorForQuantityMultiplication.js';
import { ValidateDivisorForQuantityDivision } from '../rules/ValidateDivisorForQuantityDivision.js';
import { ValidateStepSizeForQuantity } from '../rules/ValidateStepSizeForQuantity.js';
import { addDecimal, subtractDecimal, multiplyDecimal, divideDecimal, roundToTick } from '@polymarket/math';
import Decimal from 'decimal.js';
import { QuantityErrorReason } from '../errors/QuantityErrorReason.js';
import { Ratio } from '../../ratio/core/Ratio.js';

/**
 * Фасад для работы с Quantity
 *
 * @remarks
 * Единая точка входа для всех операций с количествами.
 * Оркестрирует Core + Math + Rules.
 *
 * **Контракт "Never Throw":**
 * ВСЕ методы QuantityService ГАРАНТИРОВАННО возвращают Result и НИКОГДА не бросают исключения.
 * Любые исключения из @polymarket/math, Core инвариантов или Rules ловятся и преобразуются в Result.Err.
 *
 * **Facade Error Contract:**
 * Любой Err из Facade содержит:
 * - context.op - название операции ('create', 'add', 'divide', 'portion', 'increaseBy', etc.)
 * - context.opChain - цепочка операций (внутренние op не теряются)
 * - context.quantity - входной quantity (если применимо)
 * - context.quantity1, quantity2 - для бинарных операций (add, subtract)
 * - context.divisor - для divide
 * - context.factor - для multiply
 * - context.stepSize - для roundToStep, increaseBy
 * - context.rate - для portion
 * - context.delta - для increaseBy
 * - context.roundingMode - для increaseBy
 * - context.raw - сырой ввод (для ошибок парсинга): { field, value }
 * - context.cause - для math-исключений: { name, message, stack? } (root-cause, не перетирается)
 * - context.reason - для инвариантов Core (root, не перетирается)
 *
 * **Правило возвращаемых типов:**
 * ВСЕ операции возвращают Result<T, InvalidQuantityError>
 * ОЖИДАЕМЫЕ и НЕОЖИДАННЫЕ ошибки обрабатываются через Result
 */
export class QuantityService {
  private static readonly SERVICE_NAME = 'QuantityService';

  /**
   * Создаёт Quantity из значения
   *
   * @remarks
   * ПУБЛИЧНЫЙ способ создания Quantity.
   * Возвращает Result вместо исключений.
   *
   * Core инварианты проверяются автоматически через Quantity.of():
   * - finite (не NaN, не Infinity)
   * - non-negative (>= 0)
   *
   * Использует toDecimal() для надёжного парсинга без instanceof.
   * Гарантирует Result - никогда не бросает исключения.
   *
   * @param value - Значение для создания (number, string, или Decimal)
   * @returns Result<Quantity, InvalidQuantityError>
   *
   * @example
   * ```typescript
   * const result = QuantityService.create(10);
   * if (isErr(result)) {
   *   console.error(result.error.context.op); // 'create'
   * }
   * const qty = result.value;
   * ```
   */
  public static create(value: number | string | Decimal): Result<Quantity, InvalidQuantityError> {
    // Безопасный парсинг value через toDecimal
    const decimalResult = toDecimal('value', value, QuantityErrorReason.INVALID_FORMAT, InvalidQuantityError, {
      nanReason: QuantityErrorReason.NAN,
      nonFiniteReason: QuantityErrorReason.NON_FINITE,
    });
    if (isErr(decimalResult)) {
      // raw уже внутри err.context.raw от toDecimal
      return Err(rewrap(QuantityService.SERVICE_NAME, 'create', {}, decimalResult.error, InvalidQuantityError));
    }

    return wrapOp(
      QuantityService.SERVICE_NAME,
      'create',
      {
        raw: { field: 'value', value: String(value) },
        value: decimalResult.value.toString()
      },
      () => {
        // ВАЖНО: Core получает уже Decimal -> только проверка инвариантов, не парсинг
        const quantity = Quantity.of(decimalResult.value);
        return Ok(quantity);
      },
      InvalidQuantityError
    );
  }

  /**
   * Складывает два количества
   *
   * @remarks
   * Возвращает Result потому что результат может быть non-finite (overflow → Infinity).
   * Оркестрирует: сложение через math → создание Quantity через create() (проверит инварианты)
   *
   * Обработка ошибок:
   * 1. Сложение через addDecimal() (может бросить InvalidOperandError, ArithmeticOverflowError)
   * 2. Создание Quantity через create()
   *
   * Все исключения ловятся и мапятся в Result.Err.
   * Метод никогда не бросает исключения.
   *
   * @param qty1 - Первое количество
   * @param qty2 - Второе количество
   * @returns Result<Quantity, InvalidQuantityError>
   *
   * @example
   * ```typescript
   * const result = QuantityService.add(qty1, qty2);
   * if (isErr(result)) {
   *   console.error(result.error.context.op); // 'add'
   * }
   * ```
   */
  public static add(qty1: Quantity, qty2: Quantity): Result<Quantity, InvalidQuantityError> {
    const ctx = { quantity1: qty1.value().toString(), quantity2: qty2.value().toString() };
    return wrapOp(QuantityService.SERVICE_NAME, 'add', ctx, () => {
      const sum = addDecimal(qty1.value(), qty2.value());
      return this.create(sum);
    }, InvalidQuantityError);
  }

  /**
   * Вычитает quantity с проверкой неотрицательности
   *
   * @remarks
   * Оркестрирует: вычитание → валидация non-negative → создание Quantity
   *
   * Обработка ошибок:
   * 1. Вычитание через subtractDecimal() (может бросить InvalidOperandError, ArithmeticOverflowError)
   * 2. Валидация через ValidateResultNonNegative
   * 3. Создание Quantity через create()
   *
   * Все исключения ловятся и мапятся в Result.Err.
   * Метод никогда не бросает исключения.
   *
   * @param qty1 - Уменьшаемое
   * @param qty2 - Вычитаемое
   * @returns Result<Quantity, InvalidQuantityError>
   *
   * @example
   * ```typescript
   * const result = QuantityService.subtract(qty1, qty2);
   * if (isErr(result)) {
   *   console.error(result.error.context.op); // 'subtract'
   * }
   * ```
   */
  public static subtract(
    qty1: Quantity,
    qty2: Quantity
  ): Result<Quantity, InvalidQuantityError> {
    const ctx = { quantity1: qty1.value().toString(), quantity2: qty2.value().toString() };
    return wrapOp(QuantityService.SERVICE_NAME, 'subtract', ctx, () => {
      const diff = subtractDecimal(qty1.value(), qty2.value());

      const validateResult = ValidateResultNonNegative.check(diff);
      if (isErr(validateResult)) {
        // wrapOp автоматически сделает rewrap для любого Err результата
        return Err(validateResult.error);
      }

      return this.create(diff);
    }, InvalidQuantityError);
  }

  /**
   * Умножает quantity на коэффициент
   *
   * @remarks
   * Оркестрирует: парсинг factor → валидация → умножение → создание Quantity
   * Гарантирует Result - парсинг Decimal обёрнут в toDecimal()
   *
   * @param quantity - Количество для умножения
   * @param factor - Коэффициент (number, string, или Decimal - парсится безопасно)
   * @returns Result<Quantity, InvalidQuantityError>
   *
   * @example
   * ```typescript
   * const result = QuantityService.multiply(qty, 2);
   * if (isErr(result)) {
   *   console.error(result.error.context.op); // 'multiply'
   *   console.error(result.error.context.factor); // '2'
   * }
   * ```
   */
  public static multiply(
    quantity: Quantity,
    factor: number | string | Decimal
  ): Result<Quantity, InvalidQuantityError> {
    // Безопасный парсинг factor через toDecimal
    const factorResult = toDecimal('factor', factor, QuantityErrorReason.INVALID_FORMAT, InvalidQuantityError, {
      nanReason: QuantityErrorReason.NAN,
      nonFiniteReason: QuantityErrorReason.NON_FINITE,
    });
    if (isErr(factorResult)) {
      return Err(
        rewrap(QuantityService.SERVICE_NAME, 'multiply', {
          quantity: quantity.value().toString(),
          factor: String(factor)
        }, factorResult.error, InvalidQuantityError)
      );
    }

    const factorDecimal = factorResult.value;

    // Валидация через rule (проверяет isNaN, isFinite)
    const validateResult = ValidateFactorForQuantityMultiplication.check(factorDecimal);
    if (isErr(validateResult)) {
      return Err(
        rewrap(QuantityService.SERVICE_NAME, 'multiply', {
          quantity: quantity.value().toString(),
          factor: factorDecimal.toString()
        }, validateResult.error, InvalidQuantityError)
      );
    }

    // Умножение с обработкой ожидаемых арифметических исключений
    const ctx = {
      quantity: quantity.value().toString(),
      factor: factorDecimal.toString()
    };

    return wrapOp(QuantityService.SERVICE_NAME, 'multiply', ctx, () => {
      const result = multiplyDecimal(quantity.value(), factorDecimal);
      return this.create(result);
    }, InvalidQuantityError);
  }

  /**
   * Делит quantity на делитель с проверкой
   *
   * @param quantity - Количество для деления
   * @param divisor - Делитель (number, string, или Decimal - парсится безопасно)
   * @returns Result<Quantity, InvalidQuantityError>
   * @throws Никогда - все ошибки оборачиваются в Result
   *
   * @remarks
   * Единый контракт обработки ошибок - все ошибки оборачиваются в Result:
   * - Парсинг divisor → InvalidQuantityError
   * - Валидация divisor → InvalidQuantityError
   * - DivisionByZeroError, InvalidOperandError, ArithmeticOverflowError → InvalidQuantityError с причиной в context.cause
   * - Неожиданные ошибки → InvalidQuantityError с полным контекстом
   * - Результат вне диапазона → InvalidQuantityError
   *
   * Алгоритм:
   * 1. Парсинг divisor в Decimal через toDecimal()
   * 2. Валидация через ValidateDivisorForQuantityDivision (isNaN, isFinite, isZero)
   * 3. Деление через divideDecimal() из @polymarket/math
   * 4. Создание Quantity из результата
   *
   * Все исключения ловятся и мапятся в Result.Err.
   * Метод никогда не бросает исключения.
   *
   * @example
   * ```typescript
   * const result = QuantityService.divide(qty, 2);
   * if (isErr(result)) {
   *   console.error(result.error.context.op); // 'divide'
   *   console.error(result.error.context.cause); // { name, message } для исключений
   * }
   * ```
   */
  public static divide(
    quantity: Quantity,
    divisor: number | string | Decimal
  ): Result<Quantity, InvalidQuantityError> {
    // Безопасный парсинг divisor через toDecimal
    const divisorResult = toDecimal('divisor', divisor, QuantityErrorReason.INVALID_FORMAT, InvalidQuantityError, {
      nanReason: QuantityErrorReason.NAN,
      nonFiniteReason: QuantityErrorReason.NON_FINITE,
    });
    if (isErr(divisorResult)) {
      return Err(
        rewrap(QuantityService.SERVICE_NAME, 'divide', {
          quantity: quantity.value().toString(),
          divisor: String(divisor)
        }, divisorResult.error, InvalidQuantityError)
      );
    }

    const divisorDecimal = divisorResult.value;

    // Валидация через rule
    const validateResult = ValidateDivisorForQuantityDivision.check(divisorDecimal);
    if (isErr(validateResult)) {
      return Err(
        rewrap(QuantityService.SERVICE_NAME, 'divide', {
          quantity: quantity.value().toString(),
          divisor: divisorDecimal.toString()
        }, validateResult.error, InvalidQuantityError)
      );
    }

    // Делим с обработкой ожидаемых арифметических исключений
    const ctx = {
      quantity: quantity.value().toString(),
      divisor: divisorDecimal.toString()
    };

    return wrapOp(QuantityService.SERVICE_NAME, 'divide', ctx, () => {
      const result = divideDecimal(quantity.value(), divisorDecimal);
      return this.create(result);
    }, InvalidQuantityError);
  }

  /**
   * Округляет до шага (step)
   *
   * @remarks
   * Оркестрирует: валидация stepSize → округление → создание Quantity
   *
   * Обработка ошибок:
   * 1. Парсинг stepSize через toDecimal()
   * 2. Валидация через ValidateStepSizeForQuantity
   * 3. Округление через roundToTick() (может бросить InvalidOperandError, ArithmeticOverflowError)
   * 4. Создание Quantity через create()
   *
   * Все исключения ловятся и мапятся в Result.Err.
   * Метод никогда не бросает исключения.
   *
   * @param quantity - Количество для округления
   * @param stepSize - Размер шага для округления (number, string, или Decimal)
   * @param roundingMode - Режим округления (по умолчанию ROUND_HALF_UP)
   * @returns Result<Quantity, InvalidQuantityError>
   *
   * @example
   * ```typescript
   * const result = QuantityService.roundToStep(qty, 0.01);
   * if (isErr(result)) {
   *   console.error(result.error.context.op); // 'roundToStep'
   * }
   * ```
   */
  public static roundToStep(
    quantity: Quantity,
    stepSize: number | string | Decimal,
    roundingMode: Decimal.Rounding = Decimal.ROUND_HALF_UP
  ): Result<Quantity, InvalidQuantityError> {
    // Безопасный парсинг stepSize через toDecimal
    const stepSizeResult = toDecimal('stepSize', stepSize, QuantityErrorReason.INVALID_FORMAT, InvalidQuantityError, {
      nanReason: QuantityErrorReason.NAN,
      nonFiniteReason: QuantityErrorReason.NON_FINITE,
    });
    if (isErr(stepSizeResult)) {
      return Err(
        rewrap(QuantityService.SERVICE_NAME, 'roundToStep', {
          quantity: quantity.value().toString(),
          stepSize: String(stepSize)
        }, stepSizeResult.error, InvalidQuantityError)
      );
    }

    const stepSizeDecimal = stepSizeResult.value;

    // Валидация через rule
    const validateResult = ValidateStepSizeForQuantity.check(stepSizeDecimal);
    if (isErr(validateResult)) {
      return Err(
        rewrap(QuantityService.SERVICE_NAME, 'roundToStep', {
          quantity: quantity.value().toString(),
          stepSize: stepSizeDecimal.toString()
        }, validateResult.error, InvalidQuantityError)
      );
    }

    // Округление через math layer
    const ctx = {
      quantity: quantity.value().toString(),
      stepSize: stepSizeDecimal.toString()
    };

    return wrapOp(QuantityService.SERVICE_NAME, 'roundToStep', ctx, () => {
      const rounded = roundToTick(quantity.value(), stepSizeDecimal, roundingMode);
      return this.create(rounded);
    }, InvalidQuantityError);
  }

  /**
   * Вычисляет часть (порцию) количества по заданному коэффициенту
   *
   * @param quantity - Исходное количество
   * @param rate - Коэффициент (Ratio) для вычисления части
   * @returns Result с новым количеством или InvalidQuantityError
   * @throws Никогда - все ошибки оборачиваются в Result
   *
   * @remarks
   * Вычисляет: `quantity * rate`
   *
   * **Use cases:**
   * - Partial close позиции: закрыть 50% позиции
   * - Расчёт комиссий: fee = amount * feeRate
   * - Risk management: maxPosition = balance * maxPositionRatio
   *
   * **Валидация:**
   * - Ratio уже валидирован (через RatioService)
   * - Результат может быть > исходного qty если rate > 1 (это нормально)
   * - Результат должен быть non-negative (проверится в Quantity.of)
   *
   * **Контракт "Never Throw":**
   * Все ошибки (math, инварианты) оборачиваются в InvalidQuantityError.
   *
   * @example
   * ```typescript
   * import { QuantityService, RatioService } from '@polymarket/value-objects';
   *
   * // Взять 25% от позиции
   * const position = expectOk(QuantityService.create(1000));
   * const rate = expectOk(RatioService.fromPercent(25));
   * const result = QuantityService.portion(position, rate);
   * // → 250
   *
   * // Комиссия 0.2%
   * const orderSize = expectOk(QuantityService.create(100000));
   * const feeRate = expectOk(RatioService.fromPercent(0.2));
   * const fee = QuantityService.portion(orderSize, feeRate);
   * // → 200
   *
   * // Rate > 100% (валидно)
   * const rate150 = expectOk(RatioService.fromPercent(150));
   * const result2 = QuantityService.portion(position, rate150);
   * // → 1500 (150% от 1000)
   * ```
   */
  public static portion(
    quantity: Quantity,
    rate: Ratio
  ): Result<Quantity, InvalidQuantityError> {
    const ctx = {
      quantity: quantity.value().toString(),
      rate: rate.toDecimal().toString()
    };

    return wrapOp(QuantityService.SERVICE_NAME, 'portion', ctx, () => {
      const result = multiplyDecimal(quantity.value(), rate.toDecimal());
      return this.create(result);
    }, InvalidQuantityError);
  }

  /**
   * Увеличивает/уменьшает количество на заданный процент с округлением к stepSize
   *
   * @param quantity - Исходное количество
   * @param delta - Относительное изменение (Ratio), может быть отрицательным
   * @param stepSize - Размер шага для округления результата
   * @param options - Опции округления
   * @returns Result с новым количеством или InvalidQuantityError
   * @throws Никогда - все ошибки оборачиваются в Result
   *
   * @remarks
   * Вычисляет: `quantity * (1 + delta)` → округляет к stepSize
   *
   * **Use cases:**
   * - Увеличение ордера на X%
   * - DCA (dollar-cost averaging) стратегии
   * - Position sizing с учётом минимального лота
   *
   * **Delta может быть отрицательным:**
   * - Положительный: увеличение (+10% → delta = 0.10)
   * - Отрицательный: уменьшение (-5% → delta = -0.05)
   * - Ограничение: delta >= -1 (иначе результат будет отрицательным)
   *
   * **Режимы округления:**
   * - `ROUND_HALF_UP` (по умолчанию): к ближайшему stepSize
   * - `ROUND_DOWN`: вниз (conservative для покупок)
   * - `ROUND_UP`: вверх (conservative для продаж)
   *
   * **Валидация:**
   * - stepSize должен быть > 0 (через ValidateStepSizeForQuantity)
   * - delta может быть отрицательным (для decrease)
   * - Результат должен быть non-negative (проверится в Quantity.of)
   *
   * **Edge cases:**
   * - delta = 0 → qty остаётся неизменным (после округления к step)
   * - delta = -1 (-100%) → qty = 0 (граничный случай)
   * - delta < -1 (< -100%) → результат отрицательный → InvalidQuantityError
   *
   * **Контракт "Never Throw":**
   * Все ошибки (парсинг, валидация, math, инварианты) оборачиваются в InvalidQuantityError.
   *
   * @example
   * ```typescript
   * import { QuantityService, RatioService } from '@polymarket/value-objects';
   *
   * // Увеличить на 10% с округлением к шагу 1
   * const qty = expectOk(QuantityService.create(95));
   * const delta = expectOk(RatioService.fromPercent(10));
   * const result = QuantityService.increaseBy(qty, delta.value, 1);
   * // 95 * 1.10 = 104.5 → round to 105
   *
   * // Уменьшить на 5% (отрицательный delta)
   * const decrease = expectOk(RatioService.fromPercent(-5));
   * const result2 = QuantityService.increaseBy(qty, decrease.value, 1);
   * // 95 * 0.95 = 90.25 → round to 90
   *
   * // С округлением вниз (conservative)
   * const result3 = QuantityService.increaseBy(
   *   qty, delta.value, 1, { roundingMode: Decimal.ROUND_DOWN }
   * );
   * // 95 * 1.10 = 104.5 → floor to 104
   *
   * // DCA стратегия: увеличивать на 10% каждый раз
   * const baseSize = expectOk(QuantityService.create(100));
   * const increment = expectOk(RatioService.fromPercent(10));
   * const order1 = baseSize; // 100
   * const order2 = expectOk(QuantityService.increaseBy(order1, increment.value, 1)); // 110
   * const order3 = expectOk(QuantityService.increaseBy(order2, increment.value, 1)); // 121
   * ```
   */
  public static increaseBy(
    quantity: Quantity,
    delta: Ratio,
    stepSize: number | string | Decimal,
    options?: { roundingMode?: Decimal.Rounding }
  ): Result<Quantity, InvalidQuantityError> {
    const roundingMode = options?.roundingMode ?? Decimal.ROUND_HALF_UP;

    // Безопасный парсинг stepSize через toDecimal
    const stepSizeResult = toDecimal('stepSize', stepSize, QuantityErrorReason.INVALID_FORMAT, InvalidQuantityError, {
      nanReason: QuantityErrorReason.NAN,
      nonFiniteReason: QuantityErrorReason.NON_FINITE,
    });
    if (isErr(stepSizeResult)) {
      return Err(
        rewrap(QuantityService.SERVICE_NAME, 'increaseBy', {
          quantity: quantity.value().toString(),
          delta: delta.toDecimal().toString(),
          stepSize: String(stepSize)
        }, stepSizeResult.error, InvalidQuantityError)
      );
    }

    const stepSizeDecimal = stepSizeResult.value;

    // Валидация stepSize через rule
    const validateResult = ValidateStepSizeForQuantity.check(stepSizeDecimal);
    if (isErr(validateResult)) {
      return Err(
        rewrap(QuantityService.SERVICE_NAME, 'increaseBy', {
          quantity: quantity.value().toString(),
          delta: delta.toDecimal().toString(),
          stepSize: stepSizeDecimal.toString()
        }, validateResult.error, InvalidQuantityError)
      );
    }

    const ctx = {
      quantity: quantity.value().toString(),
      delta: delta.toDecimal().toString(),
      stepSize: stepSizeDecimal.toString(),
      roundingMode: String(roundingMode)
    };

    return wrapOp(QuantityService.SERVICE_NAME, 'increaseBy', ctx, () => {
      // Вычисляем новое значение: quantity * (1 + delta)
      const multiplier = delta.onePlus();
      const newValue = multiplyDecimal(quantity.value(), multiplier);

      // Округляем к stepSize
      const rounded = roundToTick(newValue, stepSizeDecimal, roundingMode);

      // Создаём Quantity (автоматически проверит non-negative)
      return this.create(rounded);
    }, InvalidQuantityError);
  }
}
