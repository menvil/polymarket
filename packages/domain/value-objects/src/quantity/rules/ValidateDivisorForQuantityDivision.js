import { Ok, Err } from '@polymarket/result';
import { InvalidQuantityError, ErrorSource } from '@polymarket/errors';
/**
 * Правило: Делитель для операции деления Quantity должен быть положительным и finite
 *
 * @remarks
 * Policy конкретной операции деления Quantity.
 *
 * Математически можно делить на отрицательное,
 * но в контексте Quantity это нарушит инвариант (результат может стать отрицательным).
 *
 * Проверяет:
 * - divisor > 0
 * - divisor isFinite
 *
 * Возвращает InvalidQuantityError — стандарт домена Polymarket для валидации Quantity.
 *
 * @param divisor - Делитель для проверки (ТОЛЬКО Decimal)
 * @returns Result<void, InvalidQuantityError>
 *
 * @example
 * ```typescript
 * const validateResult = ValidateDivisorForQuantityDivision.check(new Decimal(2));
 * if (!validateResult.ok) {
 *   console.error(validateResult.error.context); // { divisor }
 * }
 * ```
 */
export class ValidateDivisorForQuantityDivision {
    static check(divisor) {
        // Проверка 1: делитель должен быть finite (исключает NaN, Infinity, -Infinity)
        if (!divisor.isFinite()) {
            return Err(new InvalidQuantityError((ctx) => `Divisor for Quantity division must be finite, got ${ctx.divisor}`, {
                context: {
                    source: ErrorSource.RULE_VALIDATION,
                    divisor: divisor.toString()
                }
            }));
        }
        // Проверка 2: делитель должен быть положительным (> 0)
        if (divisor.lessThanOrEqualTo(0)) {
            return Err(new InvalidQuantityError((ctx) => `Divisor for Quantity division must be positive, got ${ctx.divisor}`, {
                context: {
                    source: ErrorSource.RULE_VALIDATION,
                    divisor: divisor.toString()
                }
            }));
        }
        return Ok(undefined);
    }
}
//# sourceMappingURL=ValidateDivisorForQuantityDivision.js.map