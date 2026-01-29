import { Result, Ok, Err } from '@polymarket/result';
import { Quantity, QuantityInvariantViolation } from '../core/Quantity.js';
import { InvalidQuantityError } from '@polymarket/errors';
import { OrderQuantityPolicy } from '../policy/OrderQuantityPolicy.js';
import { ValidateResultNonNegative } from '../rules/ValidateResultNonNegative.js';
import { ValidateFactorForQuantityMultiplication } from '../rules/ValidateFactorForQuantityMultiplication.js';
import { addDecimal, subtractDecimal, multiplyDecimal } from '@polymarket/math';
import Decimal from 'decimal.js';

/**
 * Фасад для работы с Quantity
 *
 * @remarks
 * Единая точка входа для всех операций с количествами.
 * Оркестрирует Core + Math + Rules + Policy.
 *
 * **Facade Error Contract:**
 * Любой Err из Facade содержит:
 * - context.op - название операции
 * - context.quantity - входной quantity (если применимо)
 * - context.divisor|factor|tickSize - входные параметры (если применимо)
 * - context.cause - для math-исключений: { name, message }
 *
 * **Правило возвращаемых типов:**
 * ВСЕ операции возвращают Result<Quantity, Error>
 * Причина: @polymarket/math может вернуть non-finite или бросить overflow
 */
export class QuantityService {
  /**
   * Создаёт Quantity (без проверки minSize)
   *
   * @remarks
   * Мапит QuantityInvariantViolation.reason в InvalidQuantityError.context
   * Оптимизация: если value уже Decimal, использует fromDecimal() без повторного парсинга
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
            code: InvalidQuantityError.code,
            context: {
              op: 'create',
              value: String(value),
              reason: error.reason
            }
          })
        );
      }
      if (error instanceof Error) {
        return Err(
          new InvalidQuantityError(error.message, {
            code: InvalidQuantityError.code,
            context: {
              op: 'create',
              value: String(value)
            }
          })
        );
      }
      throw error;
    }
  }

  /**
   * Создаёт Quantity для ордера (с проверкой minSize)
   *
   * @remarks
   * Парсит value в Decimal один раз, затем использует для валидации и создания.
   * Гарантирует единый режим Decimal (нет повторного парсинга).
   *
   * @param value - Значение для создания (number, string, или Decimal)
   * @param orderMinSize - Минимальный размер ордера (ТОЛЬКО Decimal)
   * @returns Result<Quantity, InvalidQuantityError>
   *
   * @example
   * ```typescript
   * const result = QuantityService.createForOrder(10, new Decimal(1));
   * if (!result.ok) {
   *   console.error(result.error.context.op); // 'createForOrder'
   * }
   * ```
   */
  public static createForOrder(
    value: number | string | Decimal,
    orderMinSize: Decimal
  ): Result<Quantity, InvalidQuantityError> {
    // Парсим в Decimal один раз
    const decimal = value instanceof Decimal ? value : new Decimal(value);

    // Проверяем политику ордера
    const policyResult = OrderQuantityPolicy.validateForOrder(decimal, orderMinSize);
    if (!policyResult.ok) {
      // Добавляем op к ошибке из policy
      return Err(
        new InvalidQuantityError(policyResult.error.message, {
          code: InvalidQuantityError.code,
          context: {
            op: 'createForOrder',
            ...policyResult.error.context
          }
        })
      );
    }

    // Используем create() который уже оптимизирован для Decimal
    const createResult = this.create(decimal);
    if (!createResult.ok) {
      // Перезаписываем op с 'create' на 'createForOrder'
      return Err(
        new InvalidQuantityError(createResult.error.message, {
          code: InvalidQuantityError.code,
          context: {
            ...createResult.error.context,
            op: 'createForOrder'
          }
        })
      );
    }

    return createResult;
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
      // Перезаписываем op и добавляем context
      return Err(
        new InvalidQuantityError(createResult.error.message, {
          code: InvalidQuantityError.code,
          context: {
            op: 'add',
            quantity1: qty1.value().toString(),
            quantity2: qty2.value().toString(),
            reason: createResult.error.context?.reason
          }
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
      // Добавляем op к ошибке из rule
      return Err(
        new InvalidQuantityError(validateResult.error.message, {
          code: InvalidQuantityError.code,
          context: {
            op: 'subtract',
            quantity1: qty1.value().toString(),
            quantity2: qty2.value().toString(),
            ...validateResult.error.context
          }
        })
      );
    }

    const createResult = this.create(diff);
    if (!createResult.ok) {
      return Err(
        new InvalidQuantityError(createResult.error.message, {
          code: InvalidQuantityError.code,
          context: {
            op: 'subtract',
            quantity1: qty1.value().toString(),
            quantity2: qty2.value().toString(),
            ...createResult.error.context
          }
        })
      );
    }

    return createResult;
  }

  /**
   * Умножает quantity на коэффициент
   *
   * @remarks
   * Оркестрирует: парсинг factor (только в фасаде) → валидация → умножение → создание Quantity
   *
   * @param quantity - Количество для умножения
   * @param factor - Коэффициент (number или Decimal, парсится в фасаде)
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
    // Парсим factor только в фасаде
    const factorDecimal = factor instanceof Decimal ? factor : new Decimal(factor);

    // Валидация через rule (принимает только Decimal)
    const validateResult = ValidateFactorForQuantityMultiplication.check(factorDecimal);
    if (!validateResult.ok) {
      return Err(
        new InvalidQuantityError(validateResult.error.message, {
          code: InvalidQuantityError.code,
          context: {
            op: 'multiply',
            quantity: quantity.value().toString(),
            ...validateResult.error.context
          }
        })
      );
    }

    // Умножение через math layer
    const result = multiplyDecimal(quantity.value(), factorDecimal);

    const createResult = this.create(result);
    if (!createResult.ok) {
      return Err(
        new InvalidQuantityError(createResult.error.message, {
          code: InvalidQuantityError.code,
          context: {
            op: 'multiply',
            quantity: quantity.value().toString(),
            factor: factorDecimal.toString(),
            ...createResult.error.context
          }
        })
      );
    }

    return createResult;
  }
}
