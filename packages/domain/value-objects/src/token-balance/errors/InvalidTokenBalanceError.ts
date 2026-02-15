import { ErrorSource } from '@polymarket/errors';
import { TokenBalanceErrorReason } from './TokenBalanceErrorReason.js';

/**
 * Ошибка создания или операции с TokenBalance
 *
 * @remarks
 * Используется в TokenBalanceService для возврата типизированных ошибок через Result<T, E>.
 *
 * Содержит:
 * - message - человекочитаемое описание
 * - context.reason - типизированная причина (TokenBalanceErrorReason)
 * - context.details - дополнительная информация (входные данные, причина)
 * - source - откуда пришла ошибка (ErrorSource)
 *
 * @example
 * ```typescript
 * const result = TokenBalanceService.create(token, qty, accountId, venueId);
 * if (!result.ok) {
 *   if (result.error.context?.reason === TokenBalanceErrorReason.INVALID_AMOUNT) {
 *     console.error('Invalid amount provided');
 *   }
 * }
 * ```
 */
export class InvalidTokenBalanceError extends Error {
  public readonly context?: {
    reason?: TokenBalanceErrorReason;
    details?: unknown;
    source?: ErrorSource;
  };

  constructor(
    message: string,
    context?: {
      reason?: TokenBalanceErrorReason;
      details?: unknown;
    },
    source?: ErrorSource
  ) {
    super(message);
    Object.setPrototypeOf(this, InvalidTokenBalanceError.prototype);
    this.name = 'InvalidTokenBalanceError';
    this.context = { ...context, source };
  }
}
