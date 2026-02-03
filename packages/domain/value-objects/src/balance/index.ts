/**
 * Balance Value Object - баланс с разделением available/reserved
 *
 * @remarks
 * Полнофункциональный модуль для работы с балансом денежных средств.
 * Представляет баланс с разделением на available (доступные) и reserved (зарезервированные) средства.
 *
 * **Архитектура Throws+Facade:**
 * - Core Layer (Balance) - может бросать BalanceInvariantViolation при нарушении инвариантов
 * - Facade Layer (BalanceService) - ловит исключения и возвращает Result
 * - Rules Layer - атомарные бизнес-правила валидации
 * - Errors Layer - типизированные причины ошибок (enum)
 *
 * **Инварианты Balance:**
 * 1. available >= 0 (доступные средства не могут быть отрицательными)
 * 2. reserved >= 0 (зарезервированные средства не могут быть отрицательными)
 * 3. available.currency === reserved.currency (одинаковая валюта)
 *
 * **Derived values:**
 * - total = available + reserved (общая сумма средств)
 * - reservedPercentage = (reserved / total) * 100
 *
 * **Immutability:**
 * Все операции (reserve, release, updateAvailable) возвращают НОВЫЙ экземпляр Balance.
 * Исходный баланс никогда не модифицируется.
 *
 * **Основные компоненты:**
 *
 * 1. **Core Layer:**
 *    - Balance - immutable value object
 *    - BalanceInvariantViolation - исключение при нарушении инвариантов
 *
 * 2. **Facade Layer (публичный API):**
 *    - BalanceService.create() - создание баланса
 *    - BalanceService.reserve() - резервирование средств
 *    - BalanceService.release() - освобождение зарезервированных средств
 *    - BalanceService.updateAvailable() - обновление available
 *
 * 3. **Rules Layer:**
 *    - ValidateReserveAmount - проверка резервирования
 *    - ValidateReleaseAmount - проверка освобождения
 *    - ValidateCurrencyMatch - проверка совпадения валют
 *
 * 4. **Errors Layer:**
 *    - BalanceErrorReason - типизированные причины ошибок (enum)
 *
 * 5. **Adapters Layer:**
 *    - BalanceSerializer - JSON сериализация/десериализация
 *    - BalanceFormatter - форматирование для UI и логирования
 *
 * @example
 * ```typescript
 * import { BalanceService, BalanceErrorReason } from '@polymarket/value-objects/balance';
 * import { Money } from '@polymarket/value-objects/money';
 *
 * // Создание баланса
 * const balanceResult = BalanceService.create(
 *   Money.fromUSDC(10000),
 *   Money.fromUSDC(2000)
 * );
 *
 * if (!balanceResult.ok) {
 *   console.error(balanceResult.error.context.reason); // BalanceErrorReason
 *   return;
 * }
 *
 * const balance = balanceResult.value;
 *
 * // Query методы
 * console.log(balance.total().value());        // 12000
 * console.log(balance.available().value());    // 10000
 * console.log(balance.reserved().value());     // 2000
 * console.log(balance.reservedPercentage());    // 16.67%
 *
 * // Резервирование средств
 * const reserveResult = BalanceService.reserve(
 *   balance,
 *   Money.fromUSDC(3000)
 * );
 *
 * if (reserveResult.ok) {
 *   const newBalance = reserveResult.value;
 *   console.log(newBalance.available().value()); // 7000
 *   console.log(newBalance.reserved().value());  // 5000
 * } else {
 *   // Обработка ошибок с типизированным reason
 *   if (reserveResult.error.context?.reason === BalanceErrorReason.INSUFFICIENT_FUNDS) {
 *     console.log('Not enough available funds');
 *   }
 * }
 *
 * // Освобождение средств
 * const releaseResult = BalanceService.release(
 *   balance,
 *   Money.fromUSDC(1000)
 * );
 *
 * if (releaseResult.ok) {
 *   console.log(releaseResult.value.available().value()); // 11000
 *   console.log(releaseResult.value.reserved().value());  // 1000
 * }
 *
 * // Helpers
 * const emptyBalance = Balance.ZERO.USDC;
 * const balanceWithZeroReserved = Balance.withZeroReserved(Money.of(10000, 'USDC'));
 * ```
 *
 * @packageDocumentation
 */

// Core Layer
export * from './core/index.js';

// Facade Layer (публичный API)
export * from './facade/index.js';

// Rules Layer
export * from './rules/index.js';

// Errors Layer
export * from './errors/index.js';

// Adapters Layer
export * from './adapters/index.js';
