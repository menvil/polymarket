/**
 * InvalidAssetQuantityError - ошибка валидации asset quantity
 *
 * @remarks
 * Выбрасывается когда asset quantity невалиден.
 * Уровень серьезности: low (ошибка валидации, пользователь может исправить).
 *
 * Причины невалидности:
 * - Невалидный AssetId
 * - Невалидный amount (negative, non-finite)
 * - Ошибки при создании из JSON
 *
 * @example
 * ```typescript
 * import { InvalidAssetQuantityError } from '@polymarket/errors';
 *
 * throw new InvalidAssetQuantityError('Invalid asset quantity');
 * ```
 */
import { TradingError } from '../base/index.js';
export class InvalidAssetQuantityError extends TradingError {
    severity = 'low';
    /**
     * Рекомендуемый код ошибки
     */
    static code = 'INVALID_ASSET_QUANTITY';
}
//# sourceMappingURL=InvalidAssetQuantityError.js.map