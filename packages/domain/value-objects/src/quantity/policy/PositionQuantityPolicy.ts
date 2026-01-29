import { Result, Ok, Err } from '@polymarket/result';
import { InvalidQuantityError } from '@polymarket/errors';
import Decimal from 'decimal.js';

/**
 * Политика для количеств в позициях
 *
 * @remarks
 * Позиции могут иметь дробные количества (лоты частично закрываются).
 * Правила мягче чем для ордеров.
 */
export class PositionQuantityPolicy {
  /**
   * Валидирует quantity для позиции
   *
   * @remarks
   * Позиция может быть >= 0:
   * - 0 = пустая позиция / закрыто / нулевой остаток (это нормально)
   * - > 0 = активная позиция
   * - Может быть < orderMinSize после частичного закрытия
   *
   * @param quantity - Количество для проверки (ТОЛЬКО Decimal)
   * @returns Result<void, InvalidQuantityError>
   *
   * @example
   * ```typescript
   * const result = PositionQuantityPolicy.validateForPosition(new Decimal(0));
   * expect(result.ok).toBe(true); // 0 допустим для позиции
   * ```
   */
  public static validateForPosition(
    quantity: Decimal
  ): Result<void, InvalidQuantityError> {
    // Для позиций допускается >= 0 (allow zero)
    if (quantity.isNegative()) {
      return Err(
        new InvalidQuantityError(
          (ctx) => `Position quantity cannot be negative, got ${ctx.quantity}`,
          {
            context: { quantity: quantity.toString() }
          }
        )
      );
    }

    if (!quantity.isFinite()) {
      return Err(
        new InvalidQuantityError(
          (ctx) => `Position quantity must be finite, got ${ctx.quantity}`,
          {
            context: { quantity: quantity.toString() }
          }
        )
      );
    }

    return Ok(undefined);
  }

  /**
   * Валидирует закрытие части позиции
   *
   * @remarks
   * Проверяет:
   * - closeQuantity > 0
   * - closeQuantity <= currentQuantity
   *
   * Предполагается что currentQuantity и closeQuantity finite (источник — Quantity).
   *
   * @param currentQuantity - Текущее количество в позиции (ТОЛЬКО Decimal)
   * @param closeQuantity - Количество для закрытия (ТОЛЬКО Decimal)
   * @returns Result<void, InvalidQuantityError>
   *
   * @example
   * ```typescript
   * const result = PositionQuantityPolicy.validatePartialClose(
   *   new Decimal(10),
   *   new Decimal(5)
   * );
   * expect(result.ok).toBe(true);
   * ```
   */
  public static validatePartialClose(
    currentQuantity: Decimal,
    closeQuantity: Decimal
  ): Result<void, InvalidQuantityError> {
    // closeQuantity должен быть > 0
    if (closeQuantity.lessThanOrEqualTo(0)) {
      return Err(
        new InvalidQuantityError(
          (ctx) => `Close quantity must be positive, got ${ctx.closeQuantity}`,
          {
            context: { closeQuantity: closeQuantity.toString() }
          }
        )
      );
    }

    // closeQuantity не должен превышать current
    if (closeQuantity.greaterThan(currentQuantity)) {
      return Err(
        new InvalidQuantityError(
          (ctx) => `Cannot close ${ctx.close} when position is ${ctx.current}`,
          {
            context: {
              current: currentQuantity.toString(),
              close: closeQuantity.toString()
            }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
