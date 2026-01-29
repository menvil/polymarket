import { Result, Ok, Err } from '@polymarket/result';
import { InvalidQuantityError } from '@polymarket/errors';
import Decimal from 'decimal.js';

/**
 * Правило: Результат операции должен быть неотрицательным
 *
 * @remarks
 * Это правило не про Quantity как объект, а про результат операции.
 *
 * Используется когда результат операции (например, subtract) не должен быть отрицательным.
 *
 * Отличается от Core инварианта:
 * - Core инвариант: объект Quantity НЕ МОЖЕТ существовать с negative значением
 * - Rule: операция НЕ ДОЛЖНА давать negative результат в этом контексте
 *
 * Возвращает InvalidQuantityError — стандарт домена Polymarket для валидации Quantity.
 *
 * @param result - Результат операции для проверки (ТОЛЬКО Decimal)
 * @returns Result<void, InvalidQuantityError>
 *
 * @example
 * ```typescript
 * const diff = subtractDecimal(qty1.value(), qty2.value());
 * const validateResult = ValidateResultNonNegative.check(diff);
 *
 * if (!validateResult.ok) {
 *   console.error(validateResult.error.message);
 *   console.error(validateResult.error.context); // { result }
 * }
 * ```
 */
export class ValidateResultNonNegative {
  public static check(result: Decimal): Result<void, InvalidQuantityError> {
    if (result.isNegative()) {
      return Err(
        new InvalidQuantityError(
          (ctx) => `Operation result ${ctx.result} cannot be negative`,
          {
            code: InvalidQuantityError.code,
            context: { result: result.toString() }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
