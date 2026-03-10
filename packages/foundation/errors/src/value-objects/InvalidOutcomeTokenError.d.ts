/**
 * InvalidOutcomeTokenError - ошибка валидации outcome token
 *
 * @remarks
 * Выбрасывается когда outcome token невалиден.
 * Уровень серьезности: low (ошибка валидации, пользователь может исправить).
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
 * throw new InvalidOutcomeTokenError('OutcomeToken requires on-chain condition');
 * ```
 */
import { TradingError, ErrorSeverity } from '../base/index.js';
export declare class InvalidOutcomeTokenError extends TradingError {
    readonly severity: ErrorSeverity;
    /**
     * Рекомендуемый код ошибки
     */
    static readonly code = "INVALID_OUTCOME_TOKEN";
}
//# sourceMappingURL=InvalidOutcomeTokenError.d.ts.map