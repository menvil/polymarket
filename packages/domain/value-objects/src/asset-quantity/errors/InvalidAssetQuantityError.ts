import { ErrorSource } from '@polymarket/errors';
import { AssetQuantityErrorReason } from './AssetQuantityErrorReason.js';

/**
 * Ошибка создания или операции с AssetQuantity
 *
 * @remarks
 * Используется в AssetQuantityService для возврата типизированных ошибок через Result<T, E>.
 *
 * Содержит:
 * - message - человекочитаемое описание
 * - context.reason - типизированная причина (AssetQuantityErrorReason)
 * - context.details - дополнительная информация (входные данные, причина)
 * - source - откуда пришла ошибка (ErrorSource)
 *
 * @example
 * ```typescript
 * const result = AssetQuantityService.create(assetId, qty);
 * if (!result.ok) {
 *   if (result.error.context?.reason === AssetQuantityErrorReason.INVALID_AMOUNT) {
 *     console.error('Invalid amount provided');
 *   }
 * }
 * ```
 */
export class InvalidAssetQuantityError extends Error {
  public readonly context?: {
    reason?: AssetQuantityErrorReason;
    details?: unknown;
    source?: ErrorSource;
  };

  constructor(
    message: string,
    context?: {
      reason?: AssetQuantityErrorReason;
      details?: unknown;
    },
    source?: ErrorSource
  ) {
    super(message);
    Object.setPrototypeOf(this, InvalidAssetQuantityError.prototype);
    this.name = 'InvalidAssetQuantityError';
    this.context = { ...context, source };
  }
}
