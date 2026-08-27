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
  amountField: 'releaseQty',
  limitField: 'reserved',
  label: 'Release quantity',
  verb: 'release',
  limitLabel: 'reserved',
  invalidFormatReason: TokenBalanceErrorReason.INVALID_FORMAT,
  insufficientReason: TokenBalanceErrorReason.INSUFFICIENT_RESERVED
};

/**
 * Правило: release quantity должна быть пригодной и не превышать пул `reserved`.
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
   * @param releaseQty - Переносимая величина
   * @param reserved - Пул, из которого она изымается
   * @returns `Ok(void)` либо `InvalidTokenBalanceError` с причиной отказа
   * @throws Никогда — все ошибки в `Result`
   */
  public static check(
    releaseQty: Quantity,
    reserved: Quantity
  ): Result<void, InvalidTokenBalanceError> {
    return validateReservableAmount(releaseQty, reserved, POLICY);
  }
}
