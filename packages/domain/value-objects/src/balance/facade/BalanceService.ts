import { Result, Ok, Err, isErr } from '@polymarket/result';
import { InvalidBalanceError } from '@polymarket/errors';
import { Balance } from '../core/Balance.js';
import { BalanceInvariantViolation } from '../core/BalanceInvariantViolation.js';
import { Money } from '../../money/core/Money.js';
import { MoneyService } from '../../money/facade/MoneyService.js';
import { ValidateReserveAmount } from '../rules/ValidateReserveAmount.js';
import { ValidateReleaseAmount } from '../rules/ValidateReleaseAmount.js';
import { ValidateCurrencyMatch } from '../rules/ValidateCurrencyMatch.js';
import { BalanceErrorReason } from '../errors/BalanceErrorReason.js';
import { rewrap, unexpectedError } from '../../shared/facade/errorUtils.js';

/**
 * Фасад для работы с Balance - публичный API
 *
 * @remarks
 * Единая точка входа для всех операций с балансом.
 * Оркестрирует Core + Rules для безопасных операций.
 *
 * **Контракт "Never Throw":**
 * ВСЕ методы BalanceService ГАРАНТИРОВАННО возвращают Result и НИКОГДА не бросают исключения.
 * Любые исключения из Core инвариантов или Rules ловятся и преобразуются в Result.Err.
 *
 * **Facade Error Contract:**
 * Любой Err из Facade содержит:
 * - context.op - название операции (верхний уровень)
 * - context.opChain - цепочка операций (внутренние op не теряются)
 * - context.available/reserved/amount - входные параметры (если применимо)
 * - context.reason - типизированная причина из BalanceErrorReason enum (root, не перетирается)
 * - context.currency - валюта баланса
 *
 * **Правило возвращаемых типов:**
 * ВСЕ операции возвращают Result<T, InvalidBalanceError>
 * ОЖИДАЕМЫЕ и НЕОЖИДАННЫЕ ошибки обрабатываются через Result
 *
 * **Immutability:**
 * Все операции (reserve, release, updateAvailable) возвращают НОВЫЙ экземпляр Balance.
 * Исходный баланс никогда не модифицируется.
 *
 * @example
 * ```typescript
 * import { BalanceService } from '@polymarket/value-objects/balance';
 * import { Money } from '@polymarket/value-objects/money';
 *
 * // Создание баланса
 * const result = BalanceService.create(
 *   Money.fromUSDC(10000),
 *   Money.fromUSDC(2000)
 * );
 * if (isErr(result)) {
 *   console.error(result.error.context.reason); // BalanceErrorReason
 *   return;
 * }
 * const balance = result.value;
 *
 * // Резервирование средств
 * const reserveResult = BalanceService.reserve(balance, Money.fromUSDC(3000));
 * if (reserveResult.ok) {
 *   console.log(reserveResult.value.reserved().value()); // 5000
 * }
 * ```
 */
export class BalanceService {
  /**
   * Создаёт Balance из available и reserved Money
   *
   * @param available - Доступные средства
   * @param reserved - Зарезервированные средства
   * @returns Result<Balance, InvalidBalanceError>
   * @throws Никогда - все ошибки оборачиваются в Result
   *
   * @remarks
   * ПУБЛИЧНЫЙ способ создания Balance.
   * Возвращает Result вместо исключений.
   *
   * Процесс:
   * 1. Вызывает Balance.of() для создания (проверит инварианты)
   * 2. Ловит BalanceInvariantViolation и мапит в InvalidBalanceError
   *
   * Обработка ошибок:
   * - Invariant fail (BalanceInvariantViolation) → InvalidBalanceError с reason из enum
   * - Unexpected error → InvalidBalanceError с cause
   *
   * Проверяемые инварианты (в Balance.of):
   * - available >= 0
   * - reserved >= 0
   * - available.currency === reserved.currency
   *
   * @example
   * ```typescript
   * const result = BalanceService.create(
   *   Money.fromUSDC(10000),
   *   Money.fromUSDC(2000)
   * );
   * if (isErr(result)) {
   *   console.error(result.error.context.reason);
   *   // BalanceErrorReason.NEGATIVE_AVAILABLE
   *   // BalanceErrorReason.NEGATIVE_RESERVED
   *   // BalanceErrorReason.CURRENCY_MISMATCH
   * }
   * ```
   */
  public static create(
    available: Money,
    reserved: Money
  ): Result<Balance, InvalidBalanceError> {
    try {
      const balance = Balance.of(available, reserved);
      return Ok(balance);
    } catch (error) {
      // BalanceInvariantViolation - доменные ограничения Core
      if (error instanceof BalanceInvariantViolation) {
        return Err(
          new InvalidBalanceError(error.message, {
            context: {
              op: 'create',
              reason: error.reason as BalanceErrorReason,
              available: available.value().toNumber(),
              reserved: reserved.value().toNumber(),
              currency: available.currency()
            }
          })
        );
      }

      // Неожиданная ошибка
      return Err(
        unexpectedError(
          'create',
          {
            available: available.value().toString(),
            reserved: reserved.value().toString(),
            currency: available.currency()
          },
          error,
          'balance',
          InvalidBalanceError
        )
      );
    }
  }

  /**
   * Резервирует средства из available
   *
   * @param balance - Текущий баланс
   * @param amount - Сумма для резервирования
   * @returns Result с новым Balance или InvalidBalanceError
   * @throws Никогда - все ошибки оборачиваются в Result
   *
   * @remarks
   * Создаёт НОВЫЙ Balance с:
   * - available = balance.available - amount
   * - reserved = balance.reserved + amount
   *
   * Процесс:
   * 1. Проверяет валюту через ValidateCurrencyMatch
   * 2. Проверяет достаточность средств через ValidateReserveAmount
   * 3. Вычисляет новые available и reserved через MoneyService
   * 4. Создаёт новый Balance через Balance.of()
   *
   * Обработка ошибок:
   * - Currency mismatch → InvalidBalanceError(CURRENCY_MISMATCH)
   * - Insufficient funds → InvalidBalanceError(INSUFFICIENT_FUNDS)
   * - Invariant fail → InvalidBalanceError с reason
   *
   * @example
   * ```typescript
   * const balance = expectOk(BalanceService.create(
   *   Money.fromUSDC(10000),
   *   Money.fromUSDC(2000)
   * ));
   *
   * const result = BalanceService.reserve(balance, Money.fromUSDC(3000));
   * if (result.ok) {
   *   console.log(result.value.available().value()); // 7000
   *   console.log(result.value.reserved().value());  // 5000
   * } else {
   *   console.error(result.error.context.reason);
   *   // BalanceErrorReason.INSUFFICIENT_FUNDS
   *   // BalanceErrorReason.CURRENCY_MISMATCH
   * }
   * ```
   */
  public static reserve(
    balance: Balance,
    amount: Money
  ): Result<Balance, InvalidBalanceError> {
    const op = 'reserve';
    const ctx = {
      available: balance.available().value().toString(),
      reserved: balance.reserved().value().toString(),
      amount: amount.value().toString(),
      currency: balance.currency()
    };

    try {
      // Проверка 1: Валюты должны совпадать
      const currencyCheck = ValidateCurrencyMatch.check(amount, balance.currency());
      if (isErr(currencyCheck)) {
        return Err(rewrap(op, ctx, currencyCheck.error, InvalidBalanceError));
      }

      // Проверка 2: Достаточно ли средств для резервирования
      const reserveCheck = ValidateReserveAmount.check(amount, balance.available());
      if (isErr(reserveCheck)) {
        return Err(rewrap(op, ctx, reserveCheck.error, InvalidBalanceError));
      }

      // Вычисляем новые значения
      const newAvailableResult = this.subtractMoney(balance.available(), amount);
      if (isErr(newAvailableResult)) {
        return Err(rewrap(op, ctx, newAvailableResult.error, InvalidBalanceError));
      }

      const newReservedResult = this.addMoney(balance.reserved(), amount);
      if (isErr(newReservedResult)) {
        return Err(rewrap(op, ctx, newReservedResult.error, InvalidBalanceError));
      }

      // Создаём новый Balance
      return this.create(newAvailableResult.value, newReservedResult.value);
    } catch (error) {
      return Err(unexpectedError(op, ctx, error, 'balance', InvalidBalanceError));
    }
  }

  /**
   * Освобождает зарезервированные средства
   *
   * @param balance - Текущий баланс
   * @param amount - Сумма для освобождения
   * @returns Result с новым Balance или InvalidBalanceError
   * @throws Никогда - все ошибки оборачиваются в Result
   *
   * @remarks
   * Создаёт НОВЫЙ Balance с:
   * - available = balance.available + amount
   * - reserved = balance.reserved - amount
   *
   * Процесс:
   * 1. Проверяет валюту через ValidateCurrencyMatch
   * 2. Проверяет достаточность reserved через ValidateReleaseAmount
   * 3. Вычисляет новые available и reserved через MoneyService
   * 4. Создаёт новый Balance через Balance.of()
   *
   * Обработка ошибок:
   * - Currency mismatch → InvalidBalanceError(CURRENCY_MISMATCH)
   * - Insufficient reserved → InvalidBalanceError(INSUFFICIENT_RESERVED)
   * - Invariant fail → InvalidBalanceError с reason
   *
   * @example
   * ```typescript
   * const balance = expectOk(BalanceService.create(
   *   Money.fromUSDC(7000),
   *   Money.fromUSDC(5000)
   * ));
   *
   * const result = BalanceService.release(balance, Money.fromUSDC(2000));
   * if (result.ok) {
   *   console.log(result.value.available().value()); // 9000
   *   console.log(result.value.reserved().value());  // 3000
   * } else {
   *   console.error(result.error.context.reason);
   *   // BalanceErrorReason.INSUFFICIENT_RESERVED
   *   // BalanceErrorReason.CURRENCY_MISMATCH
   * }
   * ```
   */
  public static release(
    balance: Balance,
    amount: Money
  ): Result<Balance, InvalidBalanceError> {
    const op = 'release';
    const ctx = {
      available: balance.available().value().toString(),
      reserved: balance.reserved().value().toString(),
      amount: amount.value().toString(),
      currency: balance.currency()
    };

    try {
      // Проверка 1: Валюты должны совпадать
      const currencyCheck = ValidateCurrencyMatch.check(amount, balance.currency());
      if (isErr(currencyCheck)) {
        return Err(rewrap(op, ctx, currencyCheck.error, InvalidBalanceError));
      }

      // Проверка 2: Достаточно ли зарезервированных средств
      const releaseCheck = ValidateReleaseAmount.check(amount, balance.reserved());
      if (isErr(releaseCheck)) {
        return Err(rewrap(op, ctx, releaseCheck.error, InvalidBalanceError));
      }

      // Вычисляем новые значения
      const newAvailableResult = this.addMoney(balance.available(), amount);
      if (isErr(newAvailableResult)) {
        return Err(rewrap(op, ctx, newAvailableResult.error, InvalidBalanceError));
      }

      const newReservedResult = this.subtractMoney(balance.reserved(), amount);
      if (isErr(newReservedResult)) {
        return Err(rewrap(op, ctx, newReservedResult.error, InvalidBalanceError));
      }

      // Создаём новый Balance
      return this.create(newAvailableResult.value, newReservedResult.value);
    } catch (error) {
      return Err(unexpectedError(op, ctx, error, 'balance', InvalidBalanceError));
    }
  }

  /**
   * Обновляет доступные средства (available)
   *
   * @param balance - Текущий баланс
   * @param newAvailable - Новое значение available
   * @returns Result с новым Balance или InvalidBalanceError
   * @throws Никогда - все ошибки оборачиваются в Result
   *
   * @remarks
   * Создаёт НОВЫЙ Balance с:
   * - available = newAvailable
   * - reserved = balance.reserved (не изменяется)
   *
   * Процесс:
   * 1. Проверяет валюту через ValidateCurrencyMatch
   * 2. Создаёт новый Balance через Balance.of()
   *
   * Обработка ошибок:
   * - Currency mismatch → InvalidBalanceError(CURRENCY_MISMATCH)
   * - Invariant fail → InvalidBalanceError с reason (например NEGATIVE_AVAILABLE)
   *
   * @example
   * ```typescript
   * const balance = expectOk(BalanceService.create(
   *   Money.fromUSDC(10000),
   *   Money.fromUSDC(2000)
   * ));
   *
   * const result = BalanceService.updateAvailable(
   *   balance,
   *   Money.fromUSDC(15000)
   * );
   * if (result.ok) {
   *   console.log(result.value.available().value()); // 15000
   *   console.log(result.value.reserved().value());  // 2000 (не изменилось)
   * }
   * ```
   */
  public static updateAvailable(
    balance: Balance,
    newAvailable: Money
  ): Result<Balance, InvalidBalanceError> {
    const op = 'updateAvailable';
    const ctx = {
      oldAvailable: balance.available().value().toString(),
      newAvailable: newAvailable.value().toString(),
      reserved: balance.reserved().value().toString(),
      currency: balance.currency()
    };

    try {
      // Проверка: Валюты должны совпадать
      const currencyCheck = ValidateCurrencyMatch.check(newAvailable, balance.currency());
      if (isErr(currencyCheck)) {
        return Err(rewrap(op, ctx, currencyCheck.error, InvalidBalanceError));
      }

      // Создаём новый Balance с новым available
      const newBalance = Balance.of(newAvailable, balance.reserved());
      return Ok(newBalance);
    } catch (error) {
      if (error instanceof BalanceInvariantViolation) {
        return Err(
          new InvalidBalanceError(error.message, {
            context: {
              ...ctx,
              op,
              reason: error.reason as BalanceErrorReason
            }
          })
        );
      }
      return Err(unexpectedError(op, ctx, error, 'balance', InvalidBalanceError));
    }
  }

  /**
   * Helper: складывает два Money через MoneyService
   *
   * @remarks
   * Внутренний метод для арифметических операций.
   * Использует MoneyService.add() и мапит ошибки в InvalidBalanceError.
   *
   * @param a - Первое слагаемое
   * @param b - Второе слагаемое
   * @returns Result<Money, InvalidBalanceError>
   */
  private static addMoney(a: Money, b: Money): Result<Money, InvalidBalanceError> {
    const result = MoneyService.add(a, b);
    if (isErr(result)) {
      // Преобразуем InvalidMoneyError в InvalidBalanceError
      return Err(
        new InvalidBalanceError(result.error.message, {
          context: {
            ...result.error.context,
            reason: BalanceErrorReason.INVALID_FORMAT
          }
        })
      );
    }
    return Ok(result.value);
  }

  /**
   * Helper: вычитает Money через MoneyService
   *
   * @remarks
   * Внутренний метод для арифметических операций.
   * Использует MoneyService.subtract() и мапит ошибки в InvalidBalanceError.
   *
   * @param a - Уменьшаемое
   * @param b - Вычитаемое
   * @returns Result<Money, InvalidBalanceError>
   */
  private static subtractMoney(a: Money, b: Money): Result<Money, InvalidBalanceError> {
    const result = MoneyService.subtract(a, b);
    if (isErr(result)) {
      // Преобразуем InvalidMoneyError в InvalidBalanceError
      return Err(
        new InvalidBalanceError(result.error.message, {
          context: {
            ...result.error.context,
            reason: BalanceErrorReason.INVALID_FORMAT
          }
        })
      );
    }
    return Ok(result.value);
  }
}
