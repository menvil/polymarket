import { Result, Ok, Err } from '@polymarket/result';
import { Quantity, QuantityInvariantViolation } from '../core/Quantity.js';
import { InvalidQuantityError } from '@polymarket/errors';
import { OrderQuantityPolicy } from '../policy/OrderQuantityPolicy.js';
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
}
