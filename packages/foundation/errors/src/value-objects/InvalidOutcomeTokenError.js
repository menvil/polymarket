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
import { TradingError } from '../base/index.js';
export class InvalidOutcomeTokenError extends TradingError {
    severity = 'low';
    /**
     * Рекомендуемый код ошибки
     */
    static code = 'INVALID_OUTCOME_TOKEN';
}
//# sourceMappingURL=InvalidOutcomeTokenError.js.map