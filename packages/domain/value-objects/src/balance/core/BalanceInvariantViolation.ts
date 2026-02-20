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
 *       reason: BalanceErrorReason.NEGATIVE_AVAILABLE,
 *       available: available.value().toString()
 *     }
 *   );
 * }
 *
 * // В BalanceService.create() - ловим и мапим в InvalidBalanceError
 * try {
 *   const balance = Balance.of(available, reserved, accountId, venueId);
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
   * - TOTAL_EXCEEDS_MAX_AMOUNT - available + reserved > Money.MAX_AMOUNT
   * - NAN - amount является NaN
   * - NON_FINITE - amount не является finite (Infinity или -Infinity)
   */
  public readonly reason: import('../errors/BalanceErrorReason').BalanceErrorReason;

  /**
   * Дополнительные типизированные поля для различных сценариев ошибок
   */
  public readonly available?: string;
  public readonly reserved?: string;
  public readonly total?: string;
  public readonly maxAmount?: string;
  public readonly currency?: string;

  /**
   * Создаёт новое исключение нарушения инварианта
   *
   * @param message - Человекочитаемое сообщение об ошибке
   * @param context - Контекст с reason и дополнительными полями
   *
   * @remarks
   * Все поля из context копируются в this для удобного доступа.
   * Обязательное поле: reason.
   *
   * Безопасно копирует только известные поля, не перезаписывая свойства Error.
   */
  constructor(
    message: string,
    context: {
      reason: import('../errors/BalanceErrorReason').BalanceErrorReason;
      [key: string]: unknown;
    }
  ) {
    super(message);
    this.name = 'BalanceInvariantViolation';
    this.reason = context.reason;

    // Безопасно копируем дополнительные поля, исключая reason и защищённые свойства Error
    const safeFields: Array<keyof this> = ['available', 'reserved', 'total', 'maxAmount', 'currency'];
    for (const key of Object.keys(context)) {
      if (key !== 'reason' && safeFields.includes(key as keyof this)) {
        this[key as keyof this] = context[key] as this[keyof this];
      }
    }
  }
}
