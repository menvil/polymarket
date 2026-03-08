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

export class FeeOperationError extends TradingError {
  public readonly context: {
    operation: string;
    reason: FeeOperationErrorReason;
    source: ErrorSource;
    kind: string;
    [key: string]: unknown;
  };

  constructor(
    message: string,
    options: {
      context: {
        operation: string;
        reason: FeeOperationErrorReason;
        [key: string]: unknown;
      };
    }
  ) {
    super(message, {
      ...options,
      context: {
        ...options.context,
        source: ErrorSource.RULE_VALIDATION,
        kind: 'FeeOperationError',
      },
    });
    this.name = 'FeeOperationError';
    // Preserve source and kind from super context
    this.context = {
      ...options.context,
      source: ErrorSource.RULE_VALIDATION,
      kind: 'FeeOperationError',
    };
  }
}
