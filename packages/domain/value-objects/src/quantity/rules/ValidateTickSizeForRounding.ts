import { Result, Ok, Err } from '@polymarket/result';
import { InvalidQuantityError } from '@polymarket/errors';
import Decimal from 'decimal.js';

/**
 * Правило: TickSize для округления Quantity должен быть положительным и finite
 *
 * @remarks
 * Policy для операции округления Quantity.
 *
 * Проверяет:
 * - tickSize > 0 (tickSize <= 0 не имеет смысла для округления)
 * - tickSize isFinite
 *
 * Возвращает InvalidQuantityError — стандарт домена Polymarket для валидации Quantity.
 *
 * @param tickSize - TickSize для проверки (ТОЛЬКО Decimal)
 * @returns Result<void, InvalidQuantityError>
 *
 * @example
 * ```typescript
 * const validateResult = ValidateTickSizeForRounding.check(new Decimal(0.01));
 * if (!validateResult.ok) {
 *   console.error(validateResult.error.context); // { tickSize }
 * }
 * ```
 */
export class ValidateTickSizeForRounding {
  public static check(tickSize: Decimal): Result<void, InvalidQuantityError> {
    if (tickSize.lessThanOrEqualTo(0)) {
      return Err(
        new InvalidQuantityError(
          (ctx) => `Tick size must be positive, got ${ctx.tickSize}`,
          {
            code: InvalidQuantityError.code,
            context: { tickSize: tickSize.toString() }
          }
        )
      );
    }

    if (!tickSize.isFinite()) {
      return Err(
        new InvalidQuantityError(
          (ctx) => `Tick size must be finite, got ${ctx.tickSize}`,
          {
            code: InvalidQuantityError.code,
            context: { tickSize: tickSize.toString() }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
