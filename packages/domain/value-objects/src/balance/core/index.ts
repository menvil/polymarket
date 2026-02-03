/**
 * Balance Core - базовые типы и value object
 *
 * @remarks
 * Этот модуль содержит Core Layer для Balance:
 * - Balance - immutable value object с инвариантами
 * - BalanceInvariantViolation - исключение при нарушении инвариантов
 *
 * **Инварианты Balance:**
 * 1. available >= 0 (доступные средства не могут быть отрицательными)
 * 2. reserved >= 0 (зарезервированные средства не могут быть отрицательными)
 * 3. available.currency === reserved.currency (одинаковая валюта)
 *
 * **ВАЖНО:**
 * - BalanceInvariantViolation - внутреннее исключение Core Layer
 * - Facade Layer (BalanceService) ловит его и мапит в InvalidBalanceError
 * - Пользователи должны использовать BalanceService, а не Balance.of() напрямую
 *
 * @example
 * ```typescript
 * import { Balance } from '@polymarket/value-objects/balance';
 * import { Money } from '@polymarket/value-objects/money';
 *
 * // Прямое создание (может throw BalanceInvariantViolation)
 * const balance = Balance.of(
 *   Money.fromUSDC(10000),
 *   Money.fromUSDC(2000)
 * );
 *
 * // Query методы (чистые, не могут fail)
 * console.log(balance.total().value());        // 12000
 * console.log(balance.available().value());    // 10000
 * console.log(balance.reserved().value());     // 2000
 * console.log(balance.reservedPercentage());    // 16.67
 * console.log(balance.isEmpty());               // false
 * console.log(balance.hasReserved());           // true
 *
 * // Helpers
 * const empty = Balance.ZERO.USDC;
 * const withZero = Balance.withZeroReserved(Money.of(10000, 'USDC'));
 * ```
 *
 * @packageDocumentation
 */

export * from './Balance.js';
export * from './BalanceInvariantViolation.js';
