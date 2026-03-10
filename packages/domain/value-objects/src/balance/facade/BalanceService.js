import { Ok, Err, isErr } from '@polymarket/result';
import { accountIdEquals } from '@polymarket/ids';
import { InvalidBalanceError, ErrorSource, rewrap, currencyMismatchError, wrapOp, toCause } from '@polymarket/errors';
import { Balance } from '../core/Balance.js';
import { BalanceInvariantViolation } from '../core/BalanceInvariantViolation.js';
import { MoneyService } from '../../money/facade/MoneyService.js';
import { ValidateReserveAmount } from '../rules/ValidateReserveAmount.js';
import { ValidateReleaseAmount } from '../rules/ValidateReleaseAmount.js';
import { ValidateCurrencyMatch } from '../rules/ValidateCurrencyMatch.js';
import { BalanceErrorReason } from '../errors/BalanceErrorReason.js';
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
 * Все операции (reserve, unfreezeReserved, consumeReserved, updateAvailable) возвращают НОВЫЙ экземпляр Balance.
 * Исходный баланс никогда не модифицируется.
 *
 * @example
 * ```typescript
 * import { BalanceService } from '@polymarket/value-objects/balance';
 * import { Money } from '@polymarket/value-objects/money';
 * import { parseAccountId, asVenueId } from '@polymarket/ids';
 *
 * const accountId = parseAccountId('venue:POLYMARKET:0xabc');
 * const venueId = asVenueId('POLYMARKET');
 *
 * // Создание баланса
 * const result = BalanceService.create(
 *   Money.fromUSDC(10000),
 *   Money.fromUSDC(2000),
 *   accountId,
 *   venueId
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
    static SERVICE_NAME = 'BalanceService';
    /**
     * Создаёт Balance из available и reserved Money
     *
     * @param available - Доступные средства
     * @param reserved - Зарезервированные средства
     * @param accountId - ID аккаунта владельца
     * @param venueId - ID площадки (venue)
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
     *   Money.fromUSDC(2000),
     *   accountId,
     *   venueId
     * );
     * if (isErr(result)) {
     *   console.error(result.error.context.reason);
     *   // BalanceErrorReason.NEGATIVE_AVAILABLE
     *   // BalanceErrorReason.NEGATIVE_RESERVED
     *   // BalanceErrorReason.CURRENCY_MISMATCH
     * }
     * ```
     */
    static create(available, reserved, accountId, venueId) {
        return wrapOp(BalanceService.SERVICE_NAME, 'create', {
            available: available.value().toString(),
            reserved: reserved.value().toString(),
            currency: available.currency()
        }, () => {
            const balance = Balance.of(available, reserved, accountId, venueId);
            return Ok(balance);
        }, InvalidBalanceError);
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
    static reserve(balance, amount) {
        const op = 'reserve';
        const ctx = {
            available: balance.available().value().toString(),
            reserved: balance.reserved().value().toString(),
            amount: amount.value().toString(),
            currency: balance.currency()
        };
        return wrapOp(BalanceService.SERVICE_NAME, op, ctx, () => {
            // Проверка 1: Валюты должны совпадать
            const currencyCheck = ValidateCurrencyMatch.check(amount, balance.currency());
            if (isErr(currencyCheck)) {
                return Err(rewrap(BalanceService.SERVICE_NAME, op, ctx, currencyCheck.error, InvalidBalanceError));
            }
            // Проверка 2: Достаточно ли средств для резервирования
            const reserveCheck = ValidateReserveAmount.check(amount, balance.available());
            if (isErr(reserveCheck)) {
                return Err(rewrap(BalanceService.SERVICE_NAME, op, ctx, reserveCheck.error, InvalidBalanceError));
            }
            // Вычисляем новые значения
            const newAvailableResult = this.subtractMoney(balance.available(), amount);
            if (isErr(newAvailableResult)) {
                return Err(rewrap(BalanceService.SERVICE_NAME, op, ctx, newAvailableResult.error, InvalidBalanceError));
            }
            const newReservedResult = this.addMoney(balance.reserved(), amount);
            if (isErr(newReservedResult)) {
                return Err(rewrap(BalanceService.SERVICE_NAME, op, ctx, newReservedResult.error, InvalidBalanceError));
            }
            // Создаём новый Balance (сохраняем accountId и venueId)
            return this.create(newAvailableResult.value, newReservedResult.value, balance.accountId(), balance.venueId());
        }, InvalidBalanceError);
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
    static unfreezeReserved(balance, amount) {
        const op = 'unfreezeReserved';
        const ctx = {
            available: balance.available().value().toString(),
            reserved: balance.reserved().value().toString(),
            amount: amount.value().toString(),
            currency: balance.currency()
        };
        return wrapOp(BalanceService.SERVICE_NAME, op, ctx, () => {
            // Проверка 1: Валюты должны совпадать
            const currencyCheck = ValidateCurrencyMatch.check(amount, balance.currency());
            if (isErr(currencyCheck)) {
                return Err(rewrap(BalanceService.SERVICE_NAME, op, ctx, currencyCheck.error, InvalidBalanceError));
            }
            // Проверка 2: Достаточно ли зарезервированных средств
            const releaseCheck = ValidateReleaseAmount.check(amount, balance.reserved());
            if (isErr(releaseCheck)) {
                return Err(rewrap(BalanceService.SERVICE_NAME, op, ctx, releaseCheck.error, InvalidBalanceError));
            }
            // Вычисляем новые значения
            const newAvailableResult = this.addMoney(balance.available(), amount);
            if (isErr(newAvailableResult)) {
                return Err(rewrap(BalanceService.SERVICE_NAME, op, ctx, newAvailableResult.error, InvalidBalanceError));
            }
            const newReservedResult = this.subtractMoney(balance.reserved(), amount);
            if (isErr(newReservedResult)) {
                return Err(rewrap(BalanceService.SERVICE_NAME, op, ctx, newReservedResult.error, InvalidBalanceError));
            }
            // Создаём новый Balance (сохраняем accountId и venueId)
            return this.create(newAvailableResult.value, newReservedResult.value, balance.accountId(), balance.venueId());
        }, InvalidBalanceError);
    }
    /**
     * Списывает зарезервированные средства (исполнение сделки)
     *
     * @param balance - Текущий баланс
     * @param amount - Сумма для списания
     * @returns Result с новым Balance или InvalidBalanceError
     * @throws Никогда - все ошибки оборачиваются в Result
     *
     * @remarks
     * Создаёт НОВЫЙ Balance с:
     * - available не меняется
     * - reserved = balance.reserved - amount
     *
     * **Use cases:**
     * - Исполнение сделки (списание зарезервированных средств)
     * - Комиссия за операцию (списание из reserved)
     * - Любое списание БЕЗ возврата в available
     *
     * **Важно:** Это списание БЕЗ возврата в available.
     * Если нужно вернуть средства в available - используйте unfreezeReserved().
     *
     * **Если списалось меньше запланированного:**
     * ```typescript
     * // Зарезервировали 100, списалось только 80
     * consumeReserved(balance, Money.of(80));      // списываем фактическое
     * unfreezeReserved(balance, Money.of(20));     // размораживаем остаток
     * ```
     *
     * **Если нужно списать больше reserved:**
     * ```typescript
     * // reserved = 100, нужно списать 120
     * reserve(balance, Money.of(20));              // дорезервировать недостающее
     * consumeReserved(balance, Money.of(120));     // теперь можно списать
     * ```
     *
     * Процесс:
     * 1. Проверяет валюту через ValidateCurrencyMatch
     * 2. Проверяет достаточность reserved через ValidateReleaseAmount
     * 3. Вычисляет новый reserved через MoneyService
     * 4. Создаёт новый Balance через create()
     *
     * Обработка ошибок:
     * - Currency mismatch → InvalidBalanceError(CURRENCY_MISMATCH)
     * - Insufficient reserved → InvalidBalanceError(INSUFFICIENT_RESERVED)
     * - Invariant fail → InvalidBalanceError с reason
     *
     * @example
     * ```typescript
     * // Исполнение сделки - списываем из reserved
     * const balance = expectOk(BalanceService.create(
     *   Money.fromUSDC(7000),
     *   Money.fromUSDC(5000)
     * ));
     *
     * const result = BalanceService.consumeReserved(balance, Money.fromUSDC(2000));
     * if (result.ok) {
     *   console.log(result.value.available().value()); // 7000 (не изменилось!)
     *   console.log(result.value.reserved().value());  // 3000 (было 5000)
     * } else {
     *   console.error(result.error.context.reason);
     *   // BalanceErrorReason.INSUFFICIENT_RESERVED
     *   // BalanceErrorReason.CURRENCY_MISMATCH
     * }
     * ```
     */
    static consumeReserved(balance, amount) {
        const op = 'consumeReserved';
        const ctx = {
            available: balance.available().value().toString(),
            reserved: balance.reserved().value().toString(),
            amount: amount.value().toString(),
            currency: balance.currency()
        };
        return wrapOp(BalanceService.SERVICE_NAME, op, ctx, () => {
            // Проверка 1: Валюты должны совпадать
            const currencyCheck = ValidateCurrencyMatch.check(amount, balance.currency());
            if (isErr(currencyCheck)) {
                return Err(rewrap(BalanceService.SERVICE_NAME, op, ctx, currencyCheck.error, InvalidBalanceError));
            }
            // Проверка 2: Достаточно ли зарезервированных средств
            const releaseCheck = ValidateReleaseAmount.check(amount, balance.reserved());
            if (isErr(releaseCheck)) {
                return Err(rewrap(BalanceService.SERVICE_NAME, op, ctx, releaseCheck.error, InvalidBalanceError));
            }
            // Вычисляем новый reserved (available не меняется!)
            const newReservedResult = this.subtractMoney(balance.reserved(), amount);
            if (isErr(newReservedResult)) {
                return Err(rewrap(BalanceService.SERVICE_NAME, op, ctx, newReservedResult.error, InvalidBalanceError));
            }
            // Создаём новый Balance: available остается тем же, reserved уменьшается
            return this.create(balance.available(), newReservedResult.value, balance.accountId(), balance.venueId());
        }, InvalidBalanceError);
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
    static updateAvailable(balance, newAvailable) {
        const op = 'updateAvailable';
        const ctx = {
            oldAvailable: balance.available().value().toString(),
            newAvailable: newAvailable.value().toString(),
            reserved: balance.reserved().value().toString(),
            currency: balance.currency()
        };
        return wrapOp(BalanceService.SERVICE_NAME, op, ctx, () => {
            // Проверка: Валюты должны совпадать
            const currencyCheck = ValidateCurrencyMatch.check(newAvailable, balance.currency());
            if (isErr(currencyCheck)) {
                return Err(rewrap(BalanceService.SERVICE_NAME, op, ctx, currencyCheck.error, InvalidBalanceError));
            }
            // Balance.of может бросить BalanceInvariantViolation - ловим локально для правильного reason
            try {
                const newBalance = Balance.of(newAvailable, balance.reserved(), balance.accountId(), balance.venueId());
                return Ok(newBalance);
            }
            catch (error) {
                if (error instanceof BalanceInvariantViolation) {
                    return Err(new InvalidBalanceError(error.message, {
                        context: {
                            source: ErrorSource.CORE_INVARIANT,
                            service: BalanceService.SERVICE_NAME, // Set root service field
                            ...ctx,
                            op,
                            reason: error.reason
                        }
                    }));
                }
                throw error; // пробрасываем дальше, wrapOp поймает как unexpected
            }
        }, InvalidBalanceError);
    }
    /**
     * Зачисляет средства в available (кредитование)
     *
     * @param balance - Текущий баланс
     * @param amount - Сумма для зачисления
     * @returns Result с новым Balance или InvalidBalanceError
     * @throws Никогда — все ошибки оборачиваются в Result
     *
     * @remarks
     * Создаёт НОВЫЙ Balance с:
     * - available = balance.available + amount
     * - reserved = balance.reserved (не изменяется)
     *
     * **Use cases:**
     * - Получение прибыли от закрытой позиции
     * - Пополнение счёта
     * - Возврат комиссии
     *
     * @example
     * ```typescript
     * const result = BalanceService.credit(balance, Money.of(new Decimal(500), 'USDC'));
     * if (result.ok) {
     *   console.log(result.value.available().value()); // available + 500
     *   console.log(result.value.reserved().value());  // reserved (не изменился)
     * }
     * ```
     */
    static credit(balance, amount) {
        const op = 'credit';
        const ctx = {
            available: balance.available().value().toString(),
            reserved: balance.reserved().value().toString(),
            amount: amount.value().toString(),
            currency: balance.currency(),
        };
        return wrapOp(BalanceService.SERVICE_NAME, op, ctx, () => {
            const currencyCheck = ValidateCurrencyMatch.check(amount, balance.currency());
            if (isErr(currencyCheck)) {
                return Err(rewrap(BalanceService.SERVICE_NAME, op, ctx, currencyCheck.error, InvalidBalanceError));
            }
            const newAvailableResult = this.addMoney(balance.available(), amount);
            if (isErr(newAvailableResult)) {
                return Err(rewrap(BalanceService.SERVICE_NAME, op, ctx, newAvailableResult.error, InvalidBalanceError));
            }
            return this.create(newAvailableResult.value, balance.reserved(), balance.accountId(), balance.venueId());
        }, InvalidBalanceError);
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
     * - accountId1 === accountId2 (через accountIdEquals, case-insensitive для wallet address)
     * - venueId1 === venueId2 (точное равенство строк)
     *
     * **Проверки:**
     * 1. Валюты должны совпадать (иначе CURRENCY_MISMATCH)
     * 2. Сравнение available через MoneyService.equals()
     * 3. Сравнение reserved через MoneyService.equals()
     * 4. Сравнение accountId через accountIdEquals()
     * 5. Сравнение venueId (прямое сравнение строк)
     *
     * **Архитектура:**
     * Этот метод находится в Facade потому что:
     * - Использует MoneyService для сравнения
     * - Возвращает Result (может вернуть ошибку)
     * - Работает с двумя Balance объектами (не intrinsic state)
     *
     * @example
     * ```typescript
     * const accountId1: AccountId = { kind: 'WALLET', address: '0x...' as WalletAddress };
     * const accountId2: AccountId = { kind: 'WALLET', address: '0xABC...' as WalletAddress };
     * const venueId1: VenueId = 'POLYMARKET' as VenueId;
     * const venueId2: VenueId = 'KALSHI' as VenueId;
     *
     * // Одинаковые балансы - true
     * const balance1 = expectOk(BalanceService.create(Money.of(new Decimal(100), 'USDC'), Money.of(new Decimal(50), 'USDC'), accountId1, venueId1));
     * const balance2 = expectOk(BalanceService.create(Money.of(new Decimal(100), 'USDC'), Money.of(new Decimal(50), 'USDC'), accountId1, venueId1));
     * const result1 = BalanceService.equals(balance1, balance2);
     * console.log(result1.value); // true
     *
     * // Разный reserved - false
     * const balance3 = expectOk(BalanceService.create(Money.of(new Decimal(100), 'USDC'), Money.of(new Decimal(51), 'USDC'), accountId1, venueId1));
     * const result2 = BalanceService.equals(balance1, balance3);
     * console.log(result2.value); // false
     * ```
     */
    static equals(balance1, balance2) {
        // Проверка совпадения валют
        if (!balance1.hasSameCurrency(balance2)) {
            return Err(currencyMismatchError(balance1.currency(), balance2.currency(), BalanceErrorReason.CURRENCY_MISMATCH, InvalidBalanceError));
        }
        // Сравниваем available через MoneyService
        const availableEqual = MoneyService.equals(balance1.available(), balance2.available());
        if (isErr(availableEqual)) {
            return Err(new InvalidBalanceError('Failed to compare available amounts', {
                context: {
                    reason: BalanceErrorReason.INVALID_FORMAT,
                    cause: toCause(availableEqual.error)
                }
            }));
        }
        // Если available не равны - сразу false
        if (!availableEqual.value) {
            return Ok(false);
        }
        // Сравниваем reserved через MoneyService
        const reservedEqual = MoneyService.equals(balance1.reserved(), balance2.reserved());
        if (isErr(reservedEqual)) {
            return Err(new InvalidBalanceError('Failed to compare reserved amounts', {
                context: {
                    reason: BalanceErrorReason.INVALID_FORMAT,
                    cause: toCause(reservedEqual.error)
                }
            }));
        }
        // Если reserved не равны - сразу false
        if (!reservedEqual.value) {
            return Ok(false);
        }
        // Сравниваем accountId через accountIdEquals
        if (!accountIdEquals(balance1.accountId(), balance2.accountId())) {
            return Ok(false);
        }
        // Сравниваем venueId (прямое сравнение строк)
        if (balance1.venueId() !== balance2.venueId()) {
            return Ok(false);
        }
        return Ok(true);
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
     * const balance = Balance.of(Money.of(1000, 'USDC'), Money.of(500, 'USDC'), accountId, venueId);
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
    static canAfford(balance, amount) {
        // Проверка совпадения валют
        if (balance.currency() !== amount.currency()) {
            return Err(new InvalidBalanceError(`currency mismatch: expected ${balance.currency()}, got ${amount.currency()}`, {
                context: {
                    source: ErrorSource.RULE_VALIDATION,
                    reason: BalanceErrorReason.CURRENCY_MISMATCH,
                    expected: balance.currency(),
                    actual: amount.currency()
                }
            }));
        }
        // Сравниваем available с amount через MoneyService
        // available >= amount эквивалентно isGreaterThanOrEqual(available, amount)
        const comparison = MoneyService.isGreaterThanOrEqual(balance.available(), amount);
        if (isErr(comparison)) {
            return Err(new InvalidBalanceError('Failed to compare available with amount', {
                context: {
                    reason: BalanceErrorReason.INVALID_FORMAT,
                    cause: toCause(comparison.error)
                }
            }));
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
    static addMoney(a, b) {
        const result = MoneyService.add(a, b);
        if (isErr(result)) {
            // Преобразуем InvalidMoneyError в InvalidBalanceError
            return Err(new InvalidBalanceError(result.error.message, {
                context: {
                    ...result.error.context,
                    reason: BalanceErrorReason.INVALID_FORMAT
                }
            }));
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
    static subtractMoney(a, b) {
        const result = MoneyService.subtract(a, b);
        if (isErr(result)) {
            // Преобразуем InvalidMoneyError в InvalidBalanceError
            return Err(new InvalidBalanceError(result.error.message, {
                context: {
                    ...result.error.context,
                    reason: BalanceErrorReason.INVALID_FORMAT
                }
            }));
        }
        return Ok(result.value);
    }
}
//# sourceMappingURL=BalanceService.js.map