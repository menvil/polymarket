/**
 * InsufficientFundsError - ошибка недостаточных средств
 *
 * @remarks
 * Выбрасывается когда попытка использовать средства превышает доступный баланс.
 * Типичные случаи:
 * - Попытка зарезервировать больше cash чем доступно
 * - Попытка разместить BUY ордер без достаточных средств
 * - Попытка вывести больше средств чем есть на балансе
 *
 * Уровень серьезности: medium (операция не может быть выполнена, но это не критичная ошибка).
 *
 * @example
 * ```typescript
 * import { InsufficientFundsError } from '@polymarket/errors';
 *
 * // Простое создание
 * throw new InsufficientFundsError(1000, 500);
 * // "Insufficient funds: requested 1000, available 500"
 *
 * // Проверка типа ошибки
 * try {
 *   portfolio.reserveCash(Money.fromValue(1000));
 * } catch (error) {
 *   if (InsufficientFundsError.is(error)) {
 *     console.log('Error code:', error.code); // 'INSUFFICIENT_FUNDS'
 *     console.log('Requested:', error.requested);
 *     console.log('Available:', error.available);
 *   }
 * }
 * ```
 */

import { TradingError, ErrorSeverity } from '../base/index.js';

/**
 * InsufficientFundsError - ошибка недостаточных средств
 *
 * @remarks
 * Уровень серьезности: medium
 * Рекомендуемый код ошибки: INSUFFICIENT_FUNDS
 */
export class InsufficientFundsError extends TradingError {
  public readonly severity: ErrorSeverity = 'medium';

  /**
   * Рекомендуемый код ошибки
   */
  public static readonly code = 'INSUFFICIENT_FUNDS';

  /**
   * Создаёт ошибку недостаточных средств
   *
   * @param requested - Запрошенная сумма
   * @param available - Доступная сумма
   */
  constructor(
    public readonly requested: number,
    public readonly available: number
  ) {
    super(
      `Insufficient funds: requested ${requested}, available ${available}`,
      { code: InsufficientFundsError.code, context: { requested, available } }
    );
  }
}
