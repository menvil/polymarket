import { Result, Ok, Err } from '@polymarket/result';
import { InvalidQuantityError } from '@polymarket/errors';
import Decimal from 'decimal.js';
import { Quantity } from '../core/Quantity.js';

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
   * Принимает Quantity (уже валидированный объект), поэтому проверки
   * finite/negative не нужны - они гарантированы Core инвариантами.
   *
   * @param quantity - Количество для проверки (Quantity объект)
   * @returns Result<void, InvalidQuantityError>
   *
   * @example
   * ```typescript
   * const qty = Quantity.of(0);
   * const result = PositionQuantityPolicy.validateForPosition(qty);
   * expect(result.ok).toBe(true); // 0 допустим для позиции
   * ```
   */
  public static validateForPosition(
    _quantity: Quantity
  ): Result<void, InvalidQuantityError> {
    // Для позиций допускается >= 0 (allow zero)
    // Проверки finite/negative не нужны - гарантированы Core инвариантами
    // Параметр принимается для консистентности API, но не используется
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
    // Defensive: currentQuantity должен быть finite и >= 0
    if (!currentQuantity.isFinite()) {
      return Err(
        new InvalidQuantityError(
          (ctx) => `Current position quantity must be finite, got ${ctx.current}`,
          {
            context: { current: currentQuantity.toString() }
          }
        )
      );
    }

    if (currentQuantity.isNegative()) {
      return Err(
        new InvalidQuantityError(
          (ctx) => `Current position quantity cannot be negative, got ${ctx.current}`,
          {
            context: { current: currentQuantity.toString() }
          }
        )
      );
    }

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
