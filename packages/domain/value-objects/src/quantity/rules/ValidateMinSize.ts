import { Result, Ok, Err } from '@polymarket/result';
import { InvalidQuantityError } from '@polymarket/errors';
import Decimal from 'decimal.js';

/**
 * Правило: Quantity должен быть >= minSize
 *
 * @remarks
 * Атомарное бизнес-правило для проверки минимального размера.
 * Проверяет что количество >= минимального размера для рынка.
 *
 * Это контекстуальное правило:
 * - Для ордеров: minSize обычно >= 1
 * - Для позиций: может быть меньше (лоты могут частично закрываться)
 * - Для вычислений: может не применяться
 *
 * Возвращает InvalidQuantityError — стандарт домена Polymarket для валидации Quantity.
 *
 * @param quantity - Количество для проверки (ТОЛЬКО Decimal)
 * @param minSize - Минимальный размер (ТОЛЬКО Decimal)
 * @returns Result<void, InvalidQuantityError>
 *
 * @example
 * ```typescript
 * const result = ValidateMinSize.check(
 *   new Decimal(0.5),
 *   new Decimal(1)
 * );
 *
 * if (!result.ok) {
 *   console.error(result.error.message);
 *   console.error(result.error.context); // { quantity, minSize }
 * }
 * ```
 */
export class ValidateMinSize {
  public static check(
    quantity: Decimal,
    minSize: Decimal
  ): Result<void, InvalidQuantityError> {
    // Валидация minSize (защита от невалидной конфигурации)
    if (!minSize.isFinite()) {
      return Err(
        new InvalidQuantityError(
          (ctx) => `minSize must be finite, got ${ctx.minSize}`,
          {
            context: {
              minSize: minSize.toString(),
              quantity: quantity.toString()
            }
          }
        )
      );
    }

    if (minSize.lessThanOrEqualTo(0)) {
      return Err(
        new InvalidQuantityError(
          (ctx) => `minSize must be positive, got ${ctx.minSize}`,
          {
            context: {
              minSize: minSize.toString(),
              quantity: quantity.toString()
            }
          }
        )
      );
    }

    // Основная проверка: quantity >= minSize
    if (quantity.lessThan(minSize)) {
      return Err(
        new InvalidQuantityError(
          (ctx) => `Quantity ${ctx.quantity} is less than minimum size ${ctx.minSize}`,
          {
            context: {
              quantity: quantity.toString(),
              minSize: minSize.toString()
            }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
