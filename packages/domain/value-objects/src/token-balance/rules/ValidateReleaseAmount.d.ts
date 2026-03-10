import { Result } from '@polymarket/result';
import { Quantity } from '../../quantity/core/Quantity.js';
import { InvalidTokenBalanceError } from '../errors/InvalidTokenBalanceError.js';
/**
 * Правило: Освобождаемое/списываемое количество должно быть <= зарезервированным токенам
 *
 * @remarks
 * Policy для операций unfreezeReserved() и consumeReserved() баланса токенов.
 *
 * Проверяет:
 * - releaseQty <= reserved (достаточно зарезервированных токенов для освобождения/списания)
 * - releaseQty > 0 (нельзя освобождать нулевое или отрицательное количество)
 * - releaseQty isFinite (защита от Infinity/NaN)
 *
 * Возвращает InvalidTokenBalanceError — стандарт домена Polymarket для валидации TokenBalance.
 *
 * @param releaseQty - Количество для освобождения/списания
 * @param reserved - Зарезервированные токены
 * @returns Result<void, InvalidTokenBalanceError>
 *
 * @example
 * ```typescript
 * import { ValidateReleaseAmount } from '@polymarket/value-objects/token-balance';
 * import { Quantity } from '@polymarket/value-objects/quantity';
 * import Decimal from 'decimal.js';
 *
 * const reserved = Quantity.of(new Decimal(50));
 * const releaseQty = Quantity.of(new Decimal(20));
 *
 * // ✅ Достаточно зарезервированных токенов
 * const result1 = ValidateReleaseAmount.check(releaseQty, reserved);
 * // result1.ok === true
 *
 * // ❌ Недостаточно зарезервированных токенов
 * const result2 = ValidateReleaseAmount.check(
 *   Quantity.of(new Decimal(100)),
 *   reserved
 * );
 * if (!result2.ok) {
 *   console.error(result2.error.context?.reason);
 *   // TokenBalanceErrorReason.INSUFFICIENT_RESERVED
 * }
 *
 * // ❌ Попытка освободить 0 или отрицательное количество
 * const result3 = ValidateReleaseAmount.check(
 *   Quantity.ZERO,
 *   reserved
 * );
 * if (!result3.ok) {
 *   console.error(result3.error.context?.reason);
 *   // TokenBalanceErrorReason.INVALID_FORMAT
 * }
 * ```
 */
export declare class ValidateReleaseAmount {
    static check(releaseQty: Quantity, reserved: Quantity): Result<void, InvalidTokenBalanceError>;
}
//# sourceMappingURL=ValidateReleaseAmount.d.ts.map