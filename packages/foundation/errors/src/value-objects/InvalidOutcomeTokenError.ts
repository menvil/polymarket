/**
 * InvalidOutcomeTokenError - ошибка валидации outcome token
 *
 * @remarks
 * Выбрасывается когда outcome token невалиден.
 * Уровень серьезности: medium (проблемы валидации могут повлиять на операции).
 *
 * Причины невалидности:
 * - ConditionRef не является OnChainConditionRef
 * - Невалидный outcomeKey
 * - Невалидный protocolId, chainId, или conditionId
 * - AssetId имеет неправильный type
 *
 * @example
 * ```typescript
 * import { InvalidOutcomeTokenError } from '@polymarket/errors';
 *
 * throw new InvalidOutcomeTokenError('OutcomeToken requires on-chain condition', {
 *   code: InvalidOutcomeTokenError.code
 * });
 * ```
 */

import { TradingError, ErrorSeverity } from '../base/index.js';

export class InvalidOutcomeTokenError extends TradingError {
  public readonly severity: ErrorSeverity = 'medium';

  /**
   * Рекомендуемый код ошибки
   */
  public static readonly code = 'INVALID_OUTCOME_TOKEN';
}
