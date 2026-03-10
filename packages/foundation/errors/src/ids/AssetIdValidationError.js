import { TradingError } from '../base/index.js';
/**
 * Ошибка валидации поля AssetId (outcomeKey, protocolId, chainId, conditionId)
 *
 * @remarks
 * Возвращается публичной фабрикой `AssetId.fromOutcomeToken` при невалидном
 * значении любого из полей.
 *
 * Уровень серьёзности: low — ошибка входных данных, не системная проблема.
 *
 * Контекст ошибки содержит:
 * - `field` — имя поля ('outcomeKey' | 'protocolId' | 'chainId' | 'conditionId')
 * - `value` — невалидное значение
 *
 * @example
 * ```typescript
 * import { AssetIdValidationError } from '@polymarket/errors';
 *
 * const result = AssetIdHelpers.fromOutcomeToken(ref, 'INVALID' as OutcomeKey);
 * if (!result.ok) {
 *   if (AssetIdValidationError.is(result.error)) {
 *     console.log('Invalid field:', result.error.context?.field);
 *   }
 * }
 * ```
 */
export class AssetIdValidationError extends TradingError {
    severity = 'low';
    /**
     * Рекомендуемый код ошибки
     */
    static code = 'INVALID_ASSET_ID';
}
//# sourceMappingURL=AssetIdValidationError.js.map