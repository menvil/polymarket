import { Result, Ok, Err } from '@polymarket/result';
import { Quantity, QuantityInvariantViolation } from '../core/Quantity.js';
import { InvalidQuantityError, DivisionByZeroError, ArithmeticOverflowError } from '@polymarket/errors';
import { ValidateResultNonNegative } from '../rules/ValidateResultNonNegative.js';
import { ValidateFactorForQuantityMultiplication } from '../rules/ValidateFactorForQuantityMultiplication.js';
import { ValidateDivisorForQuantityDivision } from '../rules/ValidateDivisorForQuantityDivision.js';
import { ValidateStepSizeForQuantity } from '../rules/ValidateStepSizeForQuantity.js';
import { addDecimal, subtractDecimal, multiplyDecimal, divideDecimal, roundToTick } from '@polymarket/math';
import { withOperationContext } from './errorUtils.js';
import Decimal from 'decimal.js';

/**
 * Фасад для работы с Quantity
 *
 * @remarks
 * Единая точка входа для всех операций с количествами.
 * Оркестрирует Core + Math + Rules.
 *
 * **Facade Error Contract:**
 * Любой Err из Facade содержит:
 * - context.op - название операции
 * - context.quantity - входной quantity (если применимо)
 * - context.divisor|factor|stepSize - входные параметры (если применимо)
 * - context.cause - для math-исключений: { name, message }
 *
 * **Правило возвращаемых типов:**
 * ВСЕ операции возвращают Result<T, InvalidQuantityError>
 * ОЖИДАЕМЫЕ ошибки обрабатываются через Result
 * НЕОЖИДАННЫЕ ошибки (баги) → rethrow для отладки
 */
export class QuantityService {
  /**
   * Создаёт Quantity с валидацией инвариантов
   *
   * @remarks
   * Core инварианты проверяются автоматически через Quantity.fromDecimal():
   * - finite (не NaN, не Infinity)
   * - non-negative (>= 0)
   *
   * Оптимизация: если value уже Decimal, использует fromDecimal() без повторного парсинга
   * Гарантирует Result - никогда не бросает исключения
   *
   * @param value - Значение для создания (number, string, или Decimal)
   * @returns Result<Quantity, InvalidQuantityError>
   *
   * @example
   * ```typescript
   * const result = QuantityService.create(10);
   * if (!result.ok) {
   *   console.error(result.error.context.op); // 'create'
   * }
   * const qty = result.value;
   * ```
   */
  public static create(value: number | string | Decimal): Result<Quantity, InvalidQuantityError> {
    try {
      // Оптимизация: избегаем повторного парсинга Decimal
      const quantity = value instanceof Decimal
        ? Quantity.fromDecimal(value)
        : Quantity.of(value);
      return Ok(quantity);
    } catch (error) {
      if (error instanceof QuantityInvariantViolation) {
        return Err(
          new InvalidQuantityError(error.message, {
              context: {
              op: 'create',
              value: String(value),
              reason: error.reason
            }
          })
        );
      }
      // Любая другая ошибка (парсинг Decimal, etc.)
      if (error instanceof Error) {
        return Err(
          new InvalidQuantityError(error.message, {
              context: {
              op: 'create',
              value: String(value)
            }
          })
        );
      }
      // Unknown error (не Error) - rethrow для debugging
      throw error;
    }
  }

  /**
   * Складывает два количества
   *
   * @remarks
   * Возвращает Result потому что результат может быть non-finite (overflow → Infinity).
   * Оркестрирует: сложение через math → создание Quantity через create() (проверит инварианты)
   *
   * @param qty1 - Первое количество
   * @param qty2 - Второе количество
   * @returns Result<Quantity, InvalidQuantityError>
   *
   * @example
   * ```typescript
   * const result = QuantityService.add(qty1, qty2);
   * if (!result.ok) {
   *   console.error(result.error.context.op); // 'add'
   * }
   * ```
   */
  public static add(qty1: Quantity, qty2: Quantity): Result<Quantity, InvalidQuantityError> {
    const sum = addDecimal(qty1.value(), qty2.value());

    // create() проверит инварианты (включая finite) и вернёт Result
    const createResult = this.create(sum);
    if (!createResult.ok) {
      return Err(
        withOperationContext(createResult.error, 'add', {
          quantity1: qty1.value().toString(),
          quantity2: qty2.value().toString()
        })
      );
    }

    return createResult;
  }

  /**
   * Вычитает quantity с проверкой неотрицательности
   *
   * @remarks
   * Оркестрирует: вычитание → валидация non-negative → создание Quantity
   *
   * @param qty1 - Уменьшаемое
   * @param qty2 - Вычитаемое
   * @returns Result<Quantity, InvalidQuantityError>
   *
   * @example
   * ```typescript
   * const result = QuantityService.subtract(qty1, qty2);
   * if (!result.ok) {
   *   console.error(result.error.context.op); // 'subtract'
   * }
   * ```
   */
  public static subtract(
    qty1: Quantity,
    qty2: Quantity
  ): Result<Quantity, InvalidQuantityError> {
    const diff = subtractDecimal(qty1.value(), qty2.value());

    // Проверяем что результат неотрицательный
    const validateResult = ValidateResultNonNegative.check(diff);
    if (!validateResult.ok) {
      return Err(
        withOperationContext(validateResult.error, 'subtract', {
          quantity1: qty1.value().toString(),
          quantity2: qty2.value().toString()
        })
      );
    }

    const createResult = this.create(diff);
    if (!createResult.ok) {
      return Err(
        withOperationContext(createResult.error, 'subtract', {
          quantity1: qty1.value().toString(),
          quantity2: qty2.value().toString()
        })
      );
    }

    return createResult;
  }

  /**
   * Умножает quantity на коэффициент
   *
   * @remarks
   * Оркестрирует: парсинг factor → валидация → умножение → создание Quantity
   * Гарантирует Result - парсинг Decimal обёрнут в try/catch
   *
   * @param quantity - Количество для умножения
   * @param factor - Коэффициент (number или Decimal, парсится безопасно)
   * @returns Result<Quantity, InvalidQuantityError>
   *
   * @example
   * ```typescript
   * const result = QuantityService.multiply(qty, 2);
   * if (!result.ok) {
   *   console.error(result.error.context.op); // 'multiply'
   *   console.error(result.error.context.factor); // '2'
   * }
   * ```
   */
  public static multiply(
    quantity: Quantity,
    factor: number | Decimal
  ): Result<Quantity, InvalidQuantityError> {
    // Безопасный парсинг factor
    let factorDecimal: Decimal;
    try {
      factorDecimal = factor instanceof Decimal ? factor : new Decimal(factor);
    } catch (error) {
      return Err(
        new InvalidQuantityError(
          error instanceof Error ? error.message : 'Invalid factor',
          {
            context: {
              op: 'multiply',
              quantity: quantity.value().toString(),
              factor: String(factor)
            }
          }
        )
      );
    }

    // Валидация через rule (принимает только Decimal)
    const validateResult = ValidateFactorForQuantityMultiplication.check(factorDecimal);
    if (!validateResult.ok) {
      return Err(
        withOperationContext(validateResult.error, 'multiply', {
          quantity: quantity.value().toString()
        })
      );
    }

    // Умножение через math layer
    const result = multiplyDecimal(quantity.value(), factorDecimal);

    const createResult = this.create(result);
    if (!createResult.ok) {
      return Err(
        withOperationContext(createResult.error, 'multiply', {
          quantity: quantity.value().toString(),
          factor: factorDecimal.toString()
        })
      );
    }

    return createResult;
  }

  /**
   * Делит quantity на делитель с проверкой
   *
   * @remarks
   * Единый контракт обработки ошибок:
   * - Парсинг divisor → Result (не бросает)
   * - Валидация divisor → Result
   * - divideDecimal() может бросить исключения → ловим и мапим в Result
   * - create() возвращает Result
   *
   * Все ожидаемые ошибки (parsing, validation, math exceptions) → Result.Err
   * Неожиданные ошибки → rethrow (баги)
   *
   * @param quantity - Количество для деления
   * @param divisor - Делитель (number или Decimal, парсится безопасно)
   * @returns Result<Quantity, InvalidQuantityError>
   *
   * @example
   * ```typescript
   * const result = QuantityService.divide(qty, 2);
   * if (!result.ok) {
   *   console.error(result.error.context.op); // 'divide'
   *   console.error(result.error.context.cause); // { name, message } для math-исключений
   * }
   * ```
   */
  public static divide(
    quantity: Quantity,
    divisor: number | Decimal
  ): Result<Quantity, InvalidQuantityError> {
    // Безопасный парсинг divisor
    let divisorDecimal: Decimal;
    try {
      divisorDecimal = divisor instanceof Decimal ? divisor : new Decimal(divisor);
    } catch (error) {
      return Err(
        new InvalidQuantityError(
          error instanceof Error ? error.message : 'Invalid divisor',
          {
            context: {
              op: 'divide',
              quantity: quantity.value().toString(),
              divisor: String(divisor)
            }
          }
        )
      );
    }

    // Валидация через rule (принимает только Decimal)
    const validateResult = ValidateDivisorForQuantityDivision.check(divisorDecimal);
    if (!validateResult.ok) {
      return Err(
        withOperationContext(validateResult.error, 'divide', {
          quantity: quantity.value().toString()
        })
      );
    }

    // Делим с обработкой ожидаемых арифметических исключений
    try {
      const result = divideDecimal(quantity.value(), divisorDecimal);

      // create() может вернуть Err если результат non-finite (overflow)
      const createResult = this.create(result);
      if (!createResult.ok) {
        return Err(
          withOperationContext(createResult.error, 'divide', {
            quantity: quantity.value().toString(),
            divisor: divisorDecimal.toString()
          })
        );
      }

      return createResult;
    } catch (error) {
      // Мапим ТОЛЬКО ожидаемые типы ошибок из @polymarket/math
      if (error instanceof DivisionByZeroError || error instanceof ArithmeticOverflowError) {
        return Err(
          new InvalidQuantityError(
            `Division failed: ${error.message}`,
            {
                  context: {
                op: 'divide',
                quantity: quantity.value().toString(),
                divisor: divisorDecimal.toString(),
                cause: {
                  name: error.name,
                  message: error.message
                }
              }
            }
          )
        );
      }

      // Все остальные ошибки - rethrow (это баги или неожиданные ситуации)
      throw error;
    }
  }

  /**
   * Округляет до шага (step)
   *
   * @remarks
   * Оркестрирует: валидация stepSize → округление → создание Quantity
   *
   * @param quantity - Количество для округления
   * @param stepSize - Размер шага для округления (ТОЛЬКО Decimal)
   * @param roundingMode - Режим округления (по умолчанию ROUND_HALF_UP)
   * @returns Result<Quantity, InvalidQuantityError>
   *
   * @example
   * ```typescript
   * const result = QuantityService.roundToStep(qty, new Decimal(0.01));
   * if (!result.ok) {
   *   console.error(result.error.context.op); // 'roundToStep'
   * }
   * ```
   */
  public static roundToStep(
    quantity: Quantity,
    stepSize: Decimal,
    roundingMode: Decimal.Rounding = Decimal.ROUND_HALF_UP
  ): Result<Quantity, InvalidQuantityError> {
    // Валидация через rule
    const validateResult = ValidateStepSizeForQuantity.check(stepSize);
    if (!validateResult.ok) {
      return Err(
        withOperationContext(validateResult.error, 'roundToStep', {
          quantity: quantity.value().toString()
        })
      );
    }

    // Округление через math layer
    const rounded = roundToTick(quantity.value(), stepSize, roundingMode);

    const createResult = this.create(rounded);
    if (!createResult.ok) {
      return Err(
        withOperationContext(createResult.error, 'roundToStep', {
          quantity: quantity.value().toString(),
          stepSize: stepSize.toString()
        })
      );
    }

    return createResult;
  }
}
