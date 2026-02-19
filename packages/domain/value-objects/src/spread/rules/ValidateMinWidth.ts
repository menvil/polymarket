import { type Result, Ok, Err } from '@polymarket/result';
import { InvalidSpreadError, ErrorSource } from '@polymarket/errors';
import Decimal from 'decimal.js';
import { SpreadErrorReason } from '../errors/SpreadErrorReason.js';

/**
 * Валидация: ширина спреда должна быть >= минимума
 *
 * @remarks
 * Atomic business rule для проверки минимальной ширины спреда.
 *
 * **Применение:**
 * - Обеспечение минимальной ликвидности
 * - Предотвращение слишком узких спредов
 * - Market-making rules
 *
 * @example
 * ```typescript
 * const width = new Decimal(0.01);
 * const minWidth = new Decimal(0.005);
 * const result = ValidateMinWidth.check(width, minWidth);
 * // result.ok === true
 * ```
 */
export class ValidateMinWidth {
  /**
   * Проверить что ширина >= минимума
   *
   * @param width - Ширина спреда
   * @param minWidth - Минимальная допустимая ширина
   * @returns Ok если >= минимума, Err если меньше
   */
  public static check(
    width: Decimal,
    minWidth: Decimal
  ): Result<void, InvalidSpreadError> {
    // Валидация minWidth (защита от невалидной конфигурации)
    if (!minWidth.isFinite()) {
      return Err(
        new InvalidSpreadError(
          (ctx) => `minWidth must be finite, got ${ctx.minWidth}`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              minWidth: minWidth.toString(),
              width: width.toString(),
              reason: SpreadErrorReason.INVALID_WIDTH
            }
          }
        )
      );
    }

    if (minWidth.lessThanOrEqualTo(0)) {
      return Err(
        new InvalidSpreadError(
          (ctx) => `minWidth must be positive, got ${ctx.minWidth}`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              minWidth: minWidth.toString(),
              width: width.toString(),
              reason: SpreadErrorReason.INVALID_WIDTH
            }
          }
        )
      );
    }

    // Основная проверка: width >= minWidth
    if (width.lessThan(minWidth)) {
      return Err(
        new InvalidSpreadError(
          (ctx) => `Spread width ${ctx.width} is less than minimum ${ctx.minWidth}`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              width: width.toString(),
              minWidth: minWidth.toString(),
              reason: SpreadErrorReason.WIDTH_TOO_SMALL
            }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
