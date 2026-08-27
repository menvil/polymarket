import type { Result } from '@polymarket/result';
import { InvalidTokenBalanceError } from '../errors/InvalidTokenBalanceError.js';
import type { Quantity } from '../../quantity/core/Quantity.js';
import type { ReservablePolicy } from '../../shared/reservable/index.js';
import { validateReservableAmount } from '../../shared/reservable/index.js';
import { TokenBalanceErrorReason } from '../errors/TokenBalanceErrorReason.js';

/**
 * Описание домена для этого правила.
 *
 * @remarks
 * Имена полей и слова сообщений сохранены ДОСЛОВНО от прежней копии:
 * контекст ошибки закреплён тестами потребителей.
 */
const POLICY: ReservablePolicy<InvalidTokenBalanceError> = {
  ErrorConstructor: InvalidTokenBalanceError,
  amountField: 'reserveQty',
  limitField: 'available',
  label: 'Reserve quantity',
  verb: 'reserve',
  limitLabel: 'available',
  invalidFormatReason: TokenBalanceErrorReason.INVALID_FORMAT,
  insufficientReason: TokenBalanceErrorReason.INSUFFICIENT_AVAILABLE
};

/**
 * Правило: reserve quantity должна быть пригодной и не превышать пул `available`.
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
   * @param reserveQty - Переносимая величина
   * @param available - Пул, из которого она изымается
   * @returns `Ok(void)` либо `InvalidTokenBalanceError` с причиной отказа
   * @throws Никогда — все ошибки в `Result`
   */
  public static check(
    reserveQty: Quantity,
    available: Quantity
  ): Result<void, InvalidTokenBalanceError> {
    return validateReservableAmount(reserveQty, available, POLICY);
  }
}
