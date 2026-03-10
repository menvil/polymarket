/**
 * Сериализация Ratio в/из JSON
 *
 * @remarks
 * ## JSON формат
 * ```json
 * { "ratio": "0.02" }
 * ```
 *
 * Значение хранится как decimal string для сохранения точности
 *
 * @example
 * ```typescript
 * const ratio = RatioService.fromPercent(2).value;
 *
 * // Serialize
 * const json = RatioSerializer.toJSON(ratio);
 * console.log(json); // { ratio: "0.02" }
 *
 * // Deserialize
 * const parsed = RatioSerializer.fromJSON(json);
 * if (parsed.ok) {
 *   console.log(parsed.value.equals(ratio)); // true
 * }
 * ```
 */
import { Result } from '@polymarket/result';
import { InvalidRatioError } from '@polymarket/errors';
import { Ratio } from '../core/Ratio.js';
/**
 * JSON структура для Ratio
 */
export interface RatioJSON {
    ratio: string;
}
export declare class RatioSerializer {
    /**
     * Сериализовать Ratio в JSON
     *
     * @param ratio - Ratio для сериализации
     * @returns JSON объект
     *
     * @example
     * ```typescript
     * const ratio = RatioService.fromPercent(2).value;
     * const json = RatioSerializer.toJSON(ratio);
     * console.log(json); // { ratio: "0.02" }
     * ```
     */
    static toJSON(ratio: Ratio): RatioJSON;
    /**
     * Десериализовать Ratio из JSON
     *
     * @param json - JSON объект (unknown type для безопасности)
     * @returns Result с Ratio или InvalidRatioError
     *
     * @example
     * ```typescript
     * const json = { ratio: "0.02" };
     * const result = RatioSerializer.fromJSON(json);
     * if (result.ok) {
     *   console.log(result.value.toDecimal()); // Decimal(0.02)
     * }
     * ```
     */
    static fromJSON(json: unknown): Result<Ratio, InvalidRatioError>;
}
//# sourceMappingURL=RatioSerializer.d.ts.map