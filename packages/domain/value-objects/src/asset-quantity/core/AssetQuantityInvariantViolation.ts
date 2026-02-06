import { AssetQuantityErrorReason } from '../errors/AssetQuantityErrorReason.js';

/**
 * Исключение при нарушении инвариантов AssetQuantity
 *
 * @remarks
 * Бросается ТОЛЬКО из Core слоя при создании AssetQuantity через конструктор/фабрику.
 * Означает что внутренний стейт будет некорректным и объект не может существовать.
 *
 * Core НЕ использует Result<T, E> - бросает исключения напрямую.
 * Facade перехватывает исключения и конвертирует в Result.Err с InvalidAssetQuantityError.
 *
 * @example
 * ```typescript
 * // В Core (internal)
 * if (condition) {
 *   throw new AssetQuantityInvariantViolation('Cannot create AssetQuantity', reason);
 * }
 *
 * // В Facade (catching)
 * try {
 *   const assetQty = AssetQuantity.of(assetId, amount);
 *   return Ok(assetQty);
 * } catch (error) {
 *   if (error instanceof AssetQuantityInvariantViolation) {
 *     return Err(new InvalidAssetQuantityError(...));
 *   }
 * }
 * ```
 */
export class AssetQuantityInvariantViolation extends Error {
  constructor(
    message: string,
    public readonly reason?: AssetQuantityErrorReason
  ) {
    super(message);
    Object.setPrototypeOf(this, AssetQuantityInvariantViolation.prototype);
    this.name = 'AssetQuantityInvariantViolation';
  }
}
