import { ErrorSource } from '@polymarket/errors';
import { OutcomeTokenErrorReason } from './OutcomeTokenErrorReason.js';

/**
 * Ошибка создания или операции с OutcomeToken
 *
 * @remarks
 * Используется в OutcomeTokenService для возврата типизированных ошибок через Result<T, E>.
 *
 * Содержит:
 * - message - человекочитаемое описание
 * - context.reason - типизированная причина (OutcomeTokenErrorReason)
 * - context.details - дополнительная информация (входные данные, причина)
 * - source - откуда пришла ошибка (ErrorSource)
 *
 * @example
 * ```typescript
 * const result = OutcomeTokenService.create(conditionRef, outcomeKey);
 * if (!result.ok) {
 *   if (result.error.context?.reason === OutcomeTokenErrorReason.NOT_ONCHAIN_CONDITION) {
 *     console.error('Only on-chain conditions can have outcome tokens');
 *   }
 * }
 * ```
 */
export class InvalidOutcomeTokenError extends Error {
  public readonly context?: {
    reason?: OutcomeTokenErrorReason;
    details?: unknown;
    source?: ErrorSource;
  };

  constructor(
    message: string,
    context?: {
      reason?: OutcomeTokenErrorReason;
      details?: unknown;
    },
    source?: ErrorSource
  ) {
    super(message);
    Object.setPrototypeOf(this, InvalidOutcomeTokenError.prototype);
    this.name = 'InvalidOutcomeTokenError';
    this.context = { ...context, source };
  }
}
