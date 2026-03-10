/**
 * Serializer для Fee
 *
 * @remarks
 * Преобразует Fee в/из JSON.
 * JSON формат: { asset: AssetId, amount: string }
 *
 * Amount хранится как string для сохранения точности при сериализации.
 *
 * @example
 * ```typescript
 * import { FeeSerializer } from '@polymarket/value-objects';
 *
 * const fee = Fee.zero(AssetIdHelpers.USDC);
 * const json = FeeSerializer.toJSON(fee);
 * // { asset: { type: 'CURRENCY', currency: 'USDC' }, amount: "0" }
 *
 * const result = FeeSerializer.fromJSON(json);
 * if (result.ok) {
 *   console.log(result.value.isZero()); // true
 * }
 * ```
 */
import { Result } from '@polymarket/result';
import { InvalidFeeError } from '@polymarket/errors';
import type { AssetId } from '@polymarket/ids';
import { Fee } from '../core/Fee.js';
/**
 * JSON представление Fee
 *
 * @remarks
 * amount хранится как string для сохранения точности (как в MoneySerializer, AssetQuantitySerializer).
 * Decimal.js может терять точность при конвертации в number для больших чисел.
 */
export interface FeeJSON {
    readonly asset: AssetId;
    readonly amount: string;
}
export declare class FeeSerializer {
    /**
     * Сериализовать Fee в JSON
     *
     * @param fee - Fee для сериализации
     * @returns FeeJSON объект
     *
     * @remarks
     * amount сериализуется как string для сохранения точности.
     *
     * @example
     * ```typescript
     * const fee = Fee.zero(AssetIdHelpers.USDC);
     * const json = FeeSerializer.toJSON(fee);
     * console.log(json.amount); // "0"
     * ```
     */
    static toJSON(fee: Fee): FeeJSON;
    /**
     * Десериализовать Fee из JSON
     *
     * @param json - FeeJSON объект
     * @returns Result<Fee, InvalidFeeError>
     *
     * @remarks
     * amount принимается как string для сохранения точности.
     * Decimal constructor принимает string, number, или Decimal.
     *
     * Несмотря на то что FeeJSON типизирован с `asset: AssetId`,
     * TypeScript типы стираются в рантайме. Метод выполняет полную
     * валидацию asset через validateFeeAsset() чтобы гарантировать
     * INVALID_ASSET reason при невалидных данных (в т.ч. при вызове с `as any`).
     *
     * @example
     * ```typescript
     * const json = { asset: AssetIdHelpers.USDC, amount: "0.10" };
     * const result = FeeSerializer.fromJSON(json);
     * if (result.ok) {
     *   console.log(result.value.quantity.amount().toNumber()); // 0.1
     * }
     * ```
     */
    static fromJSON(json: FeeJSON): Result<Fee, InvalidFeeError>;
    /**
     * Десериализовать Fee из unknown (с проверкой типов)
     *
     * @param json - Значение unknown
     * @returns Result<Fee, InvalidFeeError>
     *
     * @remarks
     * Проверяет структуру объекта перед десериализацией.
     *
     * @example
     * ```typescript
     * const parsed: unknown = JSON.parse('{"asset": {...}, "amount": 0.10}');
     * const result = FeeSerializer.fromUnknown(parsed);
     * if (result.ok) {
     *   console.log(result.value.quantity.amount().toNumber());
     * }
     * ```
     */
    static fromUnknown(json: unknown): Result<Fee, InvalidFeeError>;
}
//# sourceMappingURL=FeeSerializer.d.ts.map