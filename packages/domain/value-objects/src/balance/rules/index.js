/**
 * Balance Rules - правила валидации операций с балансом
 *
 * @remarks
 * Этот модуль содержит атомарные бизнес-правила для валидации операций с Balance.
 *
 * Все правила:
 * - Имеют статический метод check()
 * - Возвращают Result<void, InvalidBalanceError>
 * - Используют типизированные BalanceErrorReason для причин ошибок
 * - Не зависят друг от друга (атомарные)
 *
 * **Правила валидации:**
 *
 * 1. **ValidateReserveAmount** - проверка резервирования средств
 *    - reserveAmount <= available (достаточно средств для резервирования)
 *    - reserveAmount > 0 (нельзя резервировать нулевую или отрицательную сумму)
 *    - reserveAmount isFinite (защита от Infinity/NaN)
 *
 * 2. **ValidateReleaseAmount** - проверка освобождения средств
 *    - releaseAmount <= reserved (достаточно зарезервированных средств)
 *    - releaseAmount > 0 (нельзя освобождать нулевую или отрицательную сумму)
 *    - releaseAmount isFinite (защита от Infinity/NaN)
 *
 * 3. **ValidateCurrencyMatch** - проверка совпадения валют
 *    - amount.currency() === balanceCurrency (операция в той же валюте)
 *
 * @example
 * ```typescript
 * import {
 *   ValidateReserveAmount,
 *   ValidateReleaseAmount,
 *   ValidateCurrencyMatch
 * } from '@polymarket/value-objects/balance';
 * import { Money } from '@polymarket/value-objects/money';
 *
 * const balance = Balance.of(
 *   Money.fromUSDC(10000),
 *   Money.fromUSDC(2000)
 * );
 *
 * // Проверка резервирования
 * const reserveCheck = ValidateReserveAmount.check(
 *   Money.fromUSDC(5000),
 *   balance.available()
 * );
 *
 * // Проверка освобождения
 * const releaseCheck = ValidateReleaseAmount.check(
 *   Money.fromUSDC(1000),
 *   balance.reserved()
 * );
 *
 * // Проверка валюты
 * const currencyCheck = ValidateCurrencyMatch.check(
 *   Money.fromUSDC(5000),
 *   balance.currency()
 * );
 * ```
 *
 * @packageDocumentation
 */
export * from './ValidateReserveAmount.js';
export * from './ValidateReleaseAmount.js';
export * from './ValidateCurrencyMatch.js';
//# sourceMappingURL=index.js.map