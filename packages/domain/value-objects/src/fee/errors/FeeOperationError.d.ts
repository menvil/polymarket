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
import type { FeeOperationErrorReason } from './FeeOperationErrorReason.js';
export declare class FeeOperationError extends TradingError {
    readonly context: {
        operation: string;
        reason: FeeOperationErrorReason;
        source: ErrorSource;
        kind: string;
        [key: string]: unknown;
    };
    constructor(message: string, options: {
        context: {
            operation: string;
            reason: FeeOperationErrorReason;
            [key: string]: unknown;
        };
    });
}
//# sourceMappingURL=FeeOperationError.d.ts.map