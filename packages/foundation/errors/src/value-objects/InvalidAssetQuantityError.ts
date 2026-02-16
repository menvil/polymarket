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

import { TradingError, ErrorSeverity } from '../base/index.js';

export class InvalidAssetQuantityError extends TradingError {
  public readonly severity: ErrorSeverity = 'low';

  /**
   * Рекомендуемый код ошибки
   */
  public static readonly code = 'INVALID_ASSET_QUANTITY';
}
