/**
 * Нарушение инвариантов Balance
 *
 * @remarks
 * Бросается из Balance.of() при нарушении Core инвариантов:
 * - available >= 0
 * - reserved >= 0
 * - available.currency === reserved.currency
 *
 * **ВАЖНО:** Это исключение НЕ должно покидать Core Layer.
 * Facade Layer (BalanceService) ловит его и мапит в InvalidBalanceError.
 *
 * Это внутреннее исключение для защиты инвариантов value object,
 * а не публичная ошибка для потребителей API.
 *
 * @example
 * ```typescript
 * // В Balance.of() - бросаем при нарушении инварианта
 * if (available.value().isNegative()) {
 *   throw new BalanceInvariantViolation(
 *     'Available amount cannot be negative',
 *     {
 *       reason: 'NEGATIVE_AVAILABLE',
 *       available: available.value().toNumber()
 *     }
 *   );
 * }
 *
 * // В BalanceService.create() - ловим и мапим в InvalidBalanceError
 * try {
 *   const balance = Balance.of(available, reserved);
 *   return Ok(balance);
 * } catch (error) {
 *   if (error instanceof BalanceInvariantViolation) {
 *     return Err(
 *       new InvalidBalanceError(error.message, {
 *         context: {
 *           op: 'create',
 *           reason: error.reason,
 *           ...
 *         }
 *       })
 *     );
 *   }
 * }
 * ```
 */
export class BalanceInvariantViolation extends Error {
  /**
   * Типизированная причина нарушения инварианта
   *
   * @remarks
   * Возможные значения:
   * - NEGATIVE_AVAILABLE - available amount < 0
   * - NEGATIVE_RESERVED - reserved amount < 0
   * - CURRENCY_MISMATCH - available.currency !== reserved.currency
   */
  public readonly reason: string;

  /**
   * Создаёт новое исключение нарушения инварианта
   *
   * @param message - Человекочитаемое сообщение об ошибке
   * @param context - Контекст с reason и дополнительными полями
   *
   * @remarks
   * Все поля из context копируются в this для удобного доступа.
   * Обязательное поле: reason.
   */
  constructor(message: string, context: { reason: string; [key: string]: unknown }) {
    super(message);
    this.name = 'BalanceInvariantViolation';
    this.reason = context.reason;

    // Копируем все дополнительные поля из context в this
    Object.assign(this, context);
  }
}
