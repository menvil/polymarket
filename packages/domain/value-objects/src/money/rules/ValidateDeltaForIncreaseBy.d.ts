import { Result } from '@polymarket/result';
import { InvalidMoneyError } from '@polymarket/errors';
import { Ratio } from '../../ratio/core/Ratio.js';
/**
 * Правило: Delta для increaseBy должен быть >= -1
 *
 * @remarks
 * Business rule для операции increaseBy (увеличение на процент).
 * Запрещает delta < -1, так как это приведёт к отрицательному factor.
 *
 * factor = 1 + delta
 * - delta = 0.1 → factor = 1.1 (увеличение на 10%)
 * - delta = -0.5 → factor = 0.5 (уменьшение на 50%)
 * - delta = -1 → factor = 0 (уменьшение на 100%, zero result)
 * - delta = -1.5 → factor = -0.5 ❌ (отрицательный factor)
 *
 * Проверяет:
 * - delta >= -1
 *
 * @param delta - Ratio для проверки
 * @returns Result<void, InvalidMoneyError>
 *
 * @example
 * ```typescript
 * const validateResult = ValidateDeltaForIncreaseBy.check(
 *   Ratio.of(new Decimal(-1.5)) // -150%
 * );
 * if (!validateResult.ok) {
 *   console.error(validateResult.error.context.reason); // DELTA_LESS_THAN_MINUS_ONE
 * }
 * ```
 */
export declare class ValidateDeltaForIncreaseBy {
    static check(delta: Ratio): Result<void, InvalidMoneyError>;
}
//# sourceMappingURL=ValidateDeltaForIncreaseBy.d.ts.map