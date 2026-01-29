import { Result, Ok } from '@polymarket/result';
import { InvalidQuantityError } from '@polymarket/errors';
import { ValidateMinSize } from '../rules/ValidateMinSize.js';
import Decimal from 'decimal.js';

/**
 * Политика для количеств в ордерах
 *
 * @remarks
 * Комбинирует правила для создания/обновления ордеров.
 *
 * Проверяет только правила для Quantity.
 * Дополнительные правила обновления ордера (например, нельзя уменьшить ниже исполненного)
 * должны находиться в Order aggregate policy, а не в Quantity policy.
 */
export class OrderQuantityPolicy {
  /**
   * Валидирует quantity для размещения ордера
   *
   * @param quantity - Количество для проверки (ТОЛЬКО Decimal)
   * @param orderMinSize - Минимальный размер ордера для рынка (ТОЛЬКО Decimal)
   * @returns Result<void, InvalidQuantityError>
   *
   * @example
   * ```typescript
   * const result = OrderQuantityPolicy.validateForOrder(
   *   new Decimal(10),
   *   new Decimal(1)
   * );
   *
   * if (!result.ok) {
   *   console.error(result.error.message);
   * }
   * ```
   */
  public static validateForOrder(
    quantity: Decimal,
    orderMinSize: Decimal
  ): Result<void, InvalidQuantityError> {
    // 1. Проверяем minSize через rule
    const minSizeResult = ValidateMinSize.check(quantity, orderMinSize);
    if (!minSizeResult.ok) {
      return minSizeResult;
    }

    // 2. Дополнительные проверки для ордеров (если нужно в будущем)
    // Например: проверка максимального размера, если требуется

    return Ok(undefined);
  }
}
