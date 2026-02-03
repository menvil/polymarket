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
import { rewrap, unexpectedError, currencyMismatchError, wrapOp } from '../../shared/facade/errorUtils.js';

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

    return wrapOp(op, ctx, () => {
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
    }, 'balance', InvalidBalanceError);
  }

  /**
   * Размораживает зарезервированные средства (возврат в available)
   *
   * @param balance - Текущий баланс
   * @param amount - Сумма для разморозки
   * @returns Result с новым Balance или InvalidBalanceError
   * @throws Никогда - все ошибки оборачиваются в Result
   *
   * @remarks
   * Создаёт НОВЫЙ Balance с:
   * - available = balance.available + amount
   * - reserved = balance.reserved - amount
   *
   * **Use cases:**
   * - Отмена сделки (возврат зарезервированных средств)
   * - Частичное исполнение (возврат неиспользованного остатка)
   * - Истечение срока резервирования
   *
   * **Важно:** Для списания reserved БЕЗ возврата в available используйте consumeReserved().
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
   * // Отмена сделки - возвращаем зарезервированные средства
   * const balance = expectOk(BalanceService.create(
   *   Money.fromUSDC(7000),
   *   Money.fromUSDC(5000)
   * ));
   *
   * const result = BalanceService.unfreezeReserved(balance, Money.fromUSDC(2000));
   * if (result.ok) {
   *   console.log(result.value.available().value()); // 9000 (было 7000)
   *   console.log(result.value.reserved().value());  // 3000 (было 5000)
   * } else {
   *   console.error(result.error.context.reason);
   *   // BalanceErrorReason.INSUFFICIENT_RESERVED
   *   // BalanceErrorReason.CURRENCY_MISMATCH
   * }
   * ```
   */
  public static unfreezeReserved(
    balance: Balance,
    amount: Money
  ): Result<Balance, InvalidBalanceError> {
    const op = 'unfreezeReserved';
    const ctx = {
      available: balance.available().value().toString(),
      reserved: balance.reserved().value().toString(),
      amount: amount.value().toString(),
      currency: balance.currency()
    };

    return wrapOp(op, ctx, () => {
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
    }, 'balance', InvalidBalanceError);
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

    return wrapOp(op, ctx, () => {
      // Проверка: Валюты должны совпадать
      const currencyCheck = ValidateCurrencyMatch.check(newAvailable, balance.currency());
      if (isErr(currencyCheck)) {
        return Err(rewrap(op, ctx, currencyCheck.error, InvalidBalanceError));
      }

      // Balance.of может бросить BalanceInvariantViolation - ловим локально для правильного reason
      try {
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
        throw error; // пробрасываем дальше, wrapOp поймает как unexpected
      }
    }, 'balance', InvalidBalanceError);
  }

  /**
   * Сравнивает два баланса на точное равенство
   *
   * @param balance1 - Первый баланс
   * @param balance2 - Второй баланс
   * @returns Result с true если балансы равны, false в противном случае
   *
   * @remarks
   * **Strict equality (без epsilon):**
   * - available1 === available2 (точное равенство)
   * - reserved1 === reserved2 (точное равенство)
   * - currency1 === currency2 (точное равенство)
   *
   * **Проверки:**
   * 1. Валюты должны совпадать (иначе CURRENCY_MISMATCH)
   * 2. Сравнение available и reserved через MoneyService.equals()
   *
   * **Архитектура:**
   * Этот метод находится в Facade потому что:
   * - Использует MoneyService для сравнения
   * - Возвращает Result (может вернуть ошибку)
   * - Работает с двумя Balance объектами (не intrinsic state)
   *
   * @example
   * ```typescript
   * const balance1 = Balance.of(Money.of(100, 'USDC'), Money.of(50, 'USDC'));
   * const balance2 = Balance.of(Money.of(100, 'USDC'), Money.of(50, 'USDC'));
   * const balance3 = Balance.of(Money.of(100, 'USDC'), Money.of(51, 'USDC'));
   *
   * const result1 = BalanceService.equals(balance1, balance2);
   * console.log(result1.value); // true
   *
   * const result2 = BalanceService.equals(balance1, balance3);
   * console.log(result2.value); // false
   * ```
   */
  public static equals(
    balance1: Balance,
    balance2: Balance
  ): Result<boolean, InvalidBalanceError> {
    // Проверка совпадения валют
    if (!balance1.hasSameCurrency(balance2)) {
      return Err(
        currencyMismatchError(
          'equals',
          balance1.currency(),
          balance2.currency(),
          BalanceErrorReason.CURRENCY_MISMATCH,
          InvalidBalanceError
        )
      );
    }

    // Сравниваем available через MoneyService
    const availableEqual = MoneyService.equals(balance1.available(), balance2.available());
    if (isErr(availableEqual)) {
      return Err(
        new InvalidBalanceError('Failed to compare available amounts', {
          context: {
            reason: BalanceErrorReason.INVALID_FORMAT,
            cause: availableEqual.error
          }
        })
      );
    }

    // Если available не равны - сразу false
    if (!availableEqual.value) {
      return Ok(false);
    }

    // Сравниваем reserved через MoneyService
    const reservedEqual = MoneyService.equals(balance1.reserved(), balance2.reserved());
    if (isErr(reservedEqual)) {
      return Err(
        new InvalidBalanceError('Failed to compare reserved amounts', {
          context: {
            reason: BalanceErrorReason.INVALID_FORMAT,
            cause: reservedEqual.error
          }
        })
      );
    }

    return Ok(reservedEqual.value);
  }

  /**
   * Проверяет, достаточно ли available средств для указанной суммы
   *
   * @param balance - Баланс для проверки
   * @param amount - Требуемая сумма
   * @returns Result с true если available >= amount, false в противном случае
   *
   * @remarks
   * **Проверки:**
   * 1. Валюта amount должна совпадать с валютой balance (иначе CURRENCY_MISMATCH)
   * 2. available >= amount (через MoneyService.compare)
   *
   * **Архитектура:**
   * Этот метод находится в Facade потому что:
   * - Использует MoneyService для сравнения
   * - Возвращает Result (может вернуть ошибку несовпадения валют)
   * - Работает с Balance + Money (не intrinsic state)
   *
   * **Use case:**
   * Используется перед операциями с деньгами:
   * - Перед reserve() - проверяем что можем зарезервировать
   * - Перед покупкой - проверяем что можем купить
   * - Перед переводом - проверяем что можем отправить
   *
   * @example
   * ```typescript
   * const balance = Balance.of(Money.of(1000, 'USDC'), Money.of(500, 'USDC'));
   *
   * // Проверяем что можем зарезервировать 300
   * const canReserve = BalanceService.canAfford(balance, Money.of(300, 'USDC'));
   * console.log(canReserve.value); // true
   *
   * // Проверяем что можем зарезервировать 1500
   * const canReserveLarge = BalanceService.canAfford(balance, Money.of(1500, 'USDC'));
   * console.log(canReserveLarge.value); // false
   *
   * // Ошибка если валюты не совпадают
   * const canAffordEur = BalanceService.canAfford(balance, Money.of(100, 'EUR'));
   * // => Err(CURRENCY_MISMATCH)
   * ```
   */
  public static canAfford(
    balance: Balance,
    amount: Money
  ): Result<boolean, InvalidBalanceError> {
    // Проверка совпадения валют
    if (balance.currency() !== amount.currency()) {
      return Err(
        currencyMismatchError(
          'canAfford',
          balance.currency(),
          amount.currency(),
          BalanceErrorReason.CURRENCY_MISMATCH,
          InvalidBalanceError
        )
      );
    }

    // Сравниваем available с amount через MoneyService
    // available >= amount эквивалентно isGreaterThanOrEqual(available, amount)
    const comparison = MoneyService.isGreaterThanOrEqual(balance.available(), amount);
    if (isErr(comparison)) {
      return Err(
        new InvalidBalanceError('Failed to compare available with amount', {
          context: {
            reason: BalanceErrorReason.INVALID_FORMAT,
            cause: comparison.error
          }
        })
      );
    }

    return Ok(comparison.value);
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
