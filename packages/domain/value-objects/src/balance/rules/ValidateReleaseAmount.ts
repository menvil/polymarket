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
  amountField: 'releaseAmount',
  limitField: 'reserved',
  label: 'Amount to unfreeze/consume',
  verb: 'unfreeze/consume',
  limitLabel: 'reserved',
  invalidFormatReason: BalanceErrorReason.INVALID_FORMAT,
  insufficientReason: BalanceErrorReason.INSUFFICIENT_RESERVED,
  insufficientAmountField: 'releaseAmount'
};

/**
 * Правило: amount to unfreeze/consume должна быть пригодной и не превышать пул `reserved`.
 *
 * @remarks
 * Проверка общая для всех резервируемых остатков и живёт в
 * `shared/reservable` — раньше этот алгоритм существовал в четырёх
 * построчно совпадавших копиях. Здесь остаётся привязка к домену.
 *
 * @example
 * ```typescript
 * ValidateReleaseAmount.check(amount, balance.reserved());
 * ```
 */
export class ValidateReleaseAmount {
  /**
   * Проверяет величину относительно пула.
   *
   * @param releaseAmount - Переносимая величина
   * @param reserved - Пул, из которого она изымается
   * @returns `Ok(void)` либо `InvalidBalanceError` с причиной отказа
   * @throws Никогда — все ошибки в `Result`
   */
  public static check(
    releaseAmount: Money,
    reserved: Money
  ): Result<void, InvalidBalanceError> {
    return validateReservableAmount(releaseAmount, reserved, POLICY);
  }
}
