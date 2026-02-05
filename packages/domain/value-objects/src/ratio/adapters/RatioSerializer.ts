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
import { Result, Ok, Err, isErr } from '@polymarket/result';
import { InvalidRatioError, ErrorSource } from '@polymarket/errors';
import { Ratio } from '../core/Ratio.js';
import { RatioService } from '../facade/RatioService.js';
import { RatioErrorReason } from '../errors/RatioErrorReason.js';

/**
 * JSON структура для Ratio
 */
export interface RatioJSON {
  ratio: string;
}

export class RatioSerializer {
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
  public static toJSON(ratio: Ratio): RatioJSON {
    return {
      ratio: ratio.toDecimal().toString()
    };
  }

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
  public static fromJSON(json: unknown): Result<Ratio, InvalidRatioError> {
    // Validate structure
    if (typeof json !== 'object' || json === null) {
      return Err(
        new InvalidRatioError('Invalid JSON: expected object', {
          context: {
            source: ErrorSource.PARSING,
            op: 'fromJSON',
            json: String(json),
            reason: RatioErrorReason.INVALID_JSON_STRUCTURE
          }
        })
      );
    }

    const obj = json as Record<string, unknown>;

    // Validate "ratio" field
    if (typeof obj.ratio !== 'string') {
      return Err(
        new InvalidRatioError('Invalid JSON: "ratio" field must be string', {
          context: {
            source: ErrorSource.PARSING,
            op: 'fromJSON',
            json: JSON.stringify(json),
            reason: RatioErrorReason.INVALID_JSON_STRUCTURE
          }
        })
      );
    }

    // Parse ratio value
    const ratioResult = RatioService.fromDecimal(obj.ratio);
    if (isErr(ratioResult)) {
      return ratioResult;
    }

    return Ok(ratioResult.value);
  }
}
