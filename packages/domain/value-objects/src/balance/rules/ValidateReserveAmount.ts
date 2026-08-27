import type { Result } from '@polymarket/result';
import { InvalidBalanceError } from '@polymarket/errors';
import type { Money } from '../../money/core/Money.js';
import type { ReservablePolicy } from '../../shared/reservable/index.js';
import { validateReservableAmount } from '../../shared/reservable/index.js';
import { BalanceErrorReason } from '../errors/BalanceErrorReason.js';

/**
 * Описание домена для этого правила.
 *
 * @remarks
 * Имена полей и слова сообщений сохранены ДОСЛОВНО от прежней копии:
 * контекст ошибки закреплён тестами потребителей.
 */
const POLICY: ReservablePolicy<InvalidBalanceError> = {
  ErrorConstructor: InvalidBalanceError,
  amountField: 'reserveAmount',
  limitField: 'available',
  label: 'Reserve amount',
  verb: 'reserve',
  limitLabel: 'available',
  invalidFormatReason: BalanceErrorReason.INVALID_FORMAT,
  insufficientReason: BalanceErrorReason.INSUFFICIENT_FUNDS
};

/**
 * Правило: reserve amount должна быть пригодной и не превышать пул `available`.
 *
 * @remarks
 * Проверка общая для всех резервируемых остатков и живёт в
 * `shared/reservable` — раньше этот алгоритм существовал в четырёх
 * построчно совпадавших копиях. Здесь остаётся привязка к домену.
 *
 * @example
 * ```typescript
 * ValidateReserveAmount.check(amount, balance.available());
 * ```
 */
export class ValidateReserveAmount {
  /**
   * Проверяет величину относительно пула.
   *
   * @param reserveAmount - Переносимая величина
   * @param available - Пул, из которого она изымается
   * @returns `Ok(void)` либо `InvalidBalanceError` с причиной отказа
   * @throws Никогда — все ошибки в `Result`
   */
  public static check(
    reserveAmount: Money,
    available: Money
  ): Result<void, InvalidBalanceError> {
    return validateReservableAmount(reserveAmount, available, POLICY);
  }
}
