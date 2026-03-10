import { Ok, Err } from '@polymarket/result';
import { InvalidRatioError } from '@polymarket/errors';
import { ErrorSource } from '@polymarket/errors';
import { RatioErrorReason } from '../errors/RatioErrorReason.js';
export class ValidateRatioGteMinusOne {
    /**
     * Проверить, что ratio >= -1
     *
     * @param value - Значение ratio для проверки
     * @param operation - Название операции (для контекста ошибки)
     * @returns Ok(undefined) если valid, Err(InvalidRatioError) если invalid
     */
    static check(value, operation) {
        if (value.lessThan(-1)) {
            return Err(new InvalidRatioError(`Ratio must be >= -1 for operation "${operation}", got: ${value.toString()}`, {
                context: {
                    source: ErrorSource.RULE_VALIDATION,
                    op: operation,
                    ratioValue: value.toString(),
                    reason: RatioErrorReason.LESS_THAN_MINUS_ONE
                }
            }));
        }
        return Ok(undefined);
    }
}
//# sourceMappingURL=ValidateRatioGteMinusOne.js.map