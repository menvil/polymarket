/**
 * Balance Facade - публичный API для работы с балансом
 *
 * @remarks
 * Этот модуль содержит BalanceService - единую точку входа для всех операций с Balance.
 *
 * **Контракт "Never Throw":**
 * ВСЕ методы BalanceService ГАРАНТИРОВАННО возвращают Result и НИКОГДА не бросают исключения.
 *
 * **Основные операции:**
 *
 * 1. **create(available, reserved)** - создание баланса
 *    - Проверяет инварианты (available >= 0, reserved >= 0, same currency)
 *    - Возвращает Result<Balance, InvalidBalanceError>
 *
 * 2. **reserve(balance, amount)** - резервирование средств
 *    - Проверяет валюту и достаточность средств
 *    - Возвращает новый Balance с обновлёнными available/reserved
 *    - available - amount, reserved + amount
 *
 * 3. **unfreezeReserved(balance, amount)** - размораживание зарезервированных средств
 *    - Проверяет валюту и достаточность reserved
 *    - Возвращает новый Balance с обновлёнными available/reserved
 *    - available + amount, reserved - amount (total не изменяется)
 *
 * 4. **consumeReserved(balance, amount)** - списание зарезервированных средств
 *    - Проверяет валюту и достаточность reserved
 *    - Возвращает новый Balance с уменьшенным reserved
 *    - available не изменяется, reserved - amount (total уменьшается)
 *
 * 5. **updateAvailable(balance, newAvailable)** - обновление available
 *    - Проверяет валюту
 *    - Возвращает новый Balance с новым available (reserved не изменяется)
 *
 * **Immutability:**
 * Все операции возвращают НОВЫЙ экземпляр Balance.
 * Исходный баланс никогда не модифицируется.
 *
 * @example
 * ```typescript
 * import { BalanceService } from '@polymarket/value-objects/balance';
 * import { Money } from '@polymarket/value-objects/money';
 *
 * // Создание баланса
 * const accountId: AccountId = { kind: 'WALLET', address: '0x...' as WalletAddress };
 * const venueId: VenueId = 'POLYMARKET' as VenueId;
 * const balanceResult = BalanceService.create(
 *   Money.fromUSDC(10000),
 *   Money.fromUSDC(2000),
 *   accountId,
 *   venueId
 * );
 *
 * if (!balanceResult.ok) {
 *   console.error(balanceResult.error.context.reason);
 *   return;
 * }
 *
 * const balance = balanceResult.value;
 *
 * // Резервирование
 * const reserveResult = BalanceService.reserve(
 *   balance,
 *   Money.fromUSDC(3000)
 * );
 *
 * if (reserveResult.ok) {
 *   console.log(reserveResult.value.available().value()); // 7000
 *   console.log(reserveResult.value.reserved().value());  // 5000
 * }
 *
 * // Размораживание (reserved → available)
 * const unfreezeResult = BalanceService.unfreezeReserved(
 *   reserveResult.value,
 *   Money.fromUSDC(1000)
 * );
 *
 * if (unfreezeResult.ok) {
 *   console.log(unfreezeResult.value.available().value()); // 8000
 *   console.log(unfreezeResult.value.reserved().value());  // 4000
 * }
 *
 * // Списание (уменьшает total)
 * const consumeResult = BalanceService.consumeReserved(
 *   reserveResult.value,
 *   Money.fromUSDC(1000)
 * );
 *
 * if (consumeResult.ok) {
 *   console.log(consumeResult.value.available().value()); // 7000 (не изменился)
 *   console.log(consumeResult.value.reserved().value());  // 4000
 *   console.log(consumeResult.value.total().value());     // 11000 (уменьшился)
 * }
 * ```
 *
 * @packageDocumentation
 */

export * from './BalanceService.js';
