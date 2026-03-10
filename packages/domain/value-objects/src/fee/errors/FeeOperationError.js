/**
 * Ошибка операции Fee
 *
 * @remarks
 * Бросается когда операция (add, subtract и т.д.) нарушает domain правила.
 * Отличается от InvalidFeeError который используется для validation input.
 *
 * FeeOperationError = domain rule violation
 * InvalidFeeError = invalid input data
 */
import { TradingError, ErrorSource } from '@polymarket/errors';
export class FeeOperationError extends TradingError {
    context;
    constructor(message, options) {
        const ctx = {
            ...options.context,
            source: ErrorSource.RULE_VALIDATION,
            kind: 'FeeOperationError',
        };
        super(message, { ...options, context: ctx });
        this.name = 'FeeOperationError';
        this.context = ctx;
    }
}
//# sourceMappingURL=FeeOperationError.js.map