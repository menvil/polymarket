import { Result } from '@polymarket/result';
import { InvalidMoneyError } from '@polymarket/errors';
import Decimal from 'decimal.js';
/**
 * Правило: Factor для операции умножения Money должен быть finite и не NaN
 *
 * @remarks
 * Policy конкретной операции умножения Money.
 *
 * Проверяет:
 * - factor не NaN (иначе результат станет NaN, нарушит инвариант)
 * - factor isFinite (иначе результат может стать infinite, нарушит инвариант)
 *
 * Возвращает InvalidMoneyError — стандарт домена Polymarket для валидации Money.
 *
 * @param factor - Factor для проверки (ТОЛЬКО Decimal)
 * @returns Result<void, InvalidMoneyError>
 *
 * @example
 * ```typescript
 * const validateResult = ValidateFactorForMoneyMultiplication.check(new Decimal(2));
 * if (!validateResult.ok) {
 *   console.error(validateResult.error.context); // { factor, reason }
 * }
 * ```
 */
export declare class ValidateFactorForMoneyMultiplication {
    static check(factor: Decimal): Result<void, InvalidMoneyError>;
}
//# sourceMappingURL=ValidateFactorForMoneyMultiplication.d.ts.map