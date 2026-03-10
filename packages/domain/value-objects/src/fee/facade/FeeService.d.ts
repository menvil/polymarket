/**
 * Фасад для работы с Fee - публичный API
 *
 * @remarks
 * Публичный API для работы с Fee со строгой валидацией.
 *
 * **Result-based методы (Never Throws):**
 * - `create()` - создание Fee с валидацией (Result<Fee, InvalidFeeError>)
 * - `add()` - сложение fees (Result<Fee, FeeOperationError>)
 *
 * **Простые методы:**
 * - `of()` - marked @internal, создание без валидации
 * - `zero()` - создание нулевой комиссии
 * - `equals()` - проверка равенства
 *
 * @example
 * ```typescript
 * import { FeeService } from '@polymarket/value-objects';
 * import { AssetIdHelpers } from '@polymarket/ids';
 *
 * // Result-based create
 * const result = FeeService.create(AssetIdHelpers.USDC, 0.10);
 * if (result.ok) {
 *   console.log(result.value.quantity.amount().toNumber()); // 0.1
 * }
 *
 * // Result-based add
 * const addResult = FeeService.add(fee1, fee2);
 * if (addResult.ok) {
 *   console.log(addResult.value.quantity.amount().toNumber());
 * }
 * ```
 */
import type { AssetId } from '@polymarket/ids';
import { Result } from '@polymarket/result';
import { InvalidFeeError } from '@polymarket/errors';
import type Decimal from 'decimal.js';
import { AssetQuantity } from '../../asset-quantity/index.js';
import { Fee, FeeOperationError } from '../index.js';
export declare class FeeService {
    private static readonly SERVICE_NAME;
    /**
     * Создать Fee с валидацией
     *
     * @param asset - AssetId (currency или outcome token)
     * @param amount - Сумма комиссии (number, string, или Decimal)
     * @returns Result<Fee, InvalidFeeError>
     *
     * @remarks
     * Проверяет инварианты:
     * - amount должен быть finite (не NaN, не Infinity)
     * - amount должен быть >= 0 (non-negative)
     * - asset должен быть валидный AssetId
     *
     * Это основной метод для создания Fee. Never throws - все ошибки через Result.
     *
     * @example
     * ```typescript
     * import { FeeService } from '@polymarket/value-objects';
     * import { AssetIdHelpers } from '@polymarket/ids';
     *
     * // Создание из number
     * const result = FeeService.create(AssetIdHelpers.USDC, 0.10);
     * if (result.ok) {
     *   console.log(result.value.quantity.amount().toNumber()); // 0.1
     * } else {
     *   console.error(result.error.message);
     * }
     *
     * // Создание из string (для точности)
     * const preciseResult = FeeService.create(AssetIdHelpers.USDC, '0.123456789012345');
     * if (preciseResult.ok) {
     *   console.log(preciseResult.value.quantity.amount().value().toString());
     * }
     *
     * // Ошибки валидации
     * const negativeResult = FeeService.create(AssetIdHelpers.USDC, -10);
     * expect(negativeResult.ok).toBe(false);
     * if (!negativeResult.ok) {
     *   console.log(negativeResult.error.context.reason); // FeeErrorReason.NEGATIVE_FEE
     * }
     * ```
     */
    static create(asset: AssetId, amount: number | string | Decimal): Result<Fee, InvalidFeeError>;
    /**
     * Создать Fee из AssetQuantity
     *
     * @internal ТОЛЬКО для внутреннего использования в Core и Facade
     *
     * @param quantity - Количество актива (должно быть >= 0)
     * @returns Fee
     *
     * @remarks
     * AssetQuantity уже гарантирует amount >= 0 через Quantity инвариант,
     * поэтому дополнительная валидация не требуется.
     *
     * @example
     * ```typescript
     * const qty = Quantity.of(new Decimal('0.10'));
     * const assetQty = AssetQuantity.usdc(qty);
     * const fee = FeeService.of(assetQty);
     * console.log(fee.quantity.amount().toNumber()); // 0.10
     * ```
     */
    static of(quantity: AssetQuantity): Fee;
    /**
     * Создать нулевую комиссию для указанного актива
     *
     * @param asset - Asset identifier
     * @returns Fee с amount = 0
     *
     * @example
     * ```typescript
     * import { AssetIdHelpers } from '@polymarket/ids';
     *
     * const zeroFee = FeeService.zero(AssetIdHelpers.USDC);
     * console.log(zeroFee.isZero()); // true
     * ```
     */
    static zero(asset: AssetId): Fee;
    /**
     * Сложить две комиссии
     *
     * @param fee1 - Первая комиссия
     * @param fee2 - Вторая комиссия
     * @returns Result<Fee, FeeOperationError>
     *
     * @remarks
     * Never throws - все ошибки через Result.
     * Проверяет что assets совпадают перед сложением.
     *
     * @example
     * ```typescript
     * import { FeeService, FeeOperationErrorReason } from '@polymarket/value-objects';
     *
     * const result = FeeService.add(fee1, fee2);
     * if (result.ok) {
     *   console.log(result.value.quantity.amount().toNumber());
     * } else {
     *   if (result.error.context?.reason === FeeOperationErrorReason.ASSET_MISMATCH) {
     *     console.error('Cannot add fees with different assets');
     *   }
     * }
     * ```
     */
    static add(fee1: Fee, fee2: Fee): Result<Fee, FeeOperationError>;
    /**
     * Проверить равенство двух fees
     *
     * @param fee1 - Первая Fee
     * @param fee2 - Вторая Fee
     * @returns true если fees равны
     *
     * @example
     * ```typescript
     * if (FeeService.equals(fee1, fee2)) {
     *   console.log('Same fee');
     * }
     * ```
     */
    static equals(fee1: Fee, fee2: Fee): boolean;
}
//# sourceMappingURL=FeeService.d.ts.map