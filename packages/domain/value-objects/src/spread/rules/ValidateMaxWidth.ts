import { type Result, Ok, Err } from '@polymarket/result';
import { InvalidSpreadError } from '@polymarket/errors';
import Decimal from 'decimal.js';
import { SpreadErrorReason } from '../core/SpreadErrorReason.js';

/**
 * Валидация: ширина спреда должна быть <= максимума
 *
 * @remarks
 * Atomic business rule для проверки максимальной ширины спреда.
 *
 * **Применение:**
 * - Обнаружение неликвидных рынков
 * - Предупреждение о широких спредах
 * - Risk management
 *
 * @example
 * ```typescript
 * const width = new Decimal(0.05);
 * const maxWidth = new Decimal(0.10);
 * const result = ValidateMaxWidth.check(width, maxWidth);
 * // result.ok === true
 * ```
 */
export class ValidateMaxWidth {
  /**
   * Проверить что ширина <= максимума
   *
   * @param width - Ширина спреда
   * @param maxWidth - Максимальная допустимая ширина
   * @returns Ok если <= максимума, Err если больше
   */
  public static check(
    width: Decimal,
    maxWidth: Decimal
  ): Result<void, InvalidSpreadError> {
    // Валидация maxWidth (защита от невалидной конфигурации)
    if (!maxWidth.isFinite()) {
      return Err(
        new InvalidSpreadError(
          (ctx) => `maxWidth must be finite, got ${ctx.maxWidth}`,
          {
            context: {
              maxWidth: maxWidth.toString(),
              width: width.toString(),
              reason: SpreadErrorReason.INVALID_AMOUNT
            }
          }
        )
      );
    }

    if (maxWidth.lessThanOrEqualTo(0)) {
      return Err(
        new InvalidSpreadError(
          (ctx) => `maxWidth must be positive, got ${ctx.maxWidth}`,
          {
            context: {
              maxWidth: maxWidth.toString(),
              width: width.toString(),
              reason: SpreadErrorReason.INVALID_AMOUNT
            }
          }
        )
      );
    }

    // Основная проверка: width <= maxWidth
    if (width.greaterThan(maxWidth)) {
      return Err(
        new InvalidSpreadError(
          (ctx) => `Spread width ${ctx.width} exceeds maximum ${ctx.maxWidth}`,
          {
            context: {
              width: width.toString(),
              maxWidth: maxWidth.toString(),
              reason: SpreadErrorReason.WIDTH_TOO_LARGE
            }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
