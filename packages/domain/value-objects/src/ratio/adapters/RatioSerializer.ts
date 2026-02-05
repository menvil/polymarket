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
import { InvalidRatioError, InvalidOperandError, ErrorSource } from '@polymarket/errors';
import { Ratio } from '../core/Ratio.js';
import { RatioService } from '../facade/RatioService.js';
import { RatioErrorReason } from '../errors/RatioErrorReason.js';

/**
 * JSON структура для Ratio
 */
export interface RatioJSON {
  ratio: string;
}

/**
 * JSON контракт для lossy сериализации (number)
 *
 * @remarks
 * ⚠️ ВНИМАНИЕ: Использует number, может привести к потере точности.
 * Для точной сериализации используй RatioJSON.
 */
export interface RatioLossyJSON {
  /**
   * Ratio value as number (может потерять точность)
   */
  ratio: number;
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

/**
 * Lossy serializer для случаев когда точность не критична
 *
 * @remarks
 * ⚠️ ВНИМАНИЕ: Использует number, что может привести к потере точности.
 * Используйте только для отображения или когда точность не критична.
 * Для точной сериализации используйте RatioSerializer.
 */
export class RatioLossySerializer {
  private static readonly SERVICE_NAME = 'RatioLossySerializer';

  /**
   * Сериализует Ratio в JSON объект (lossy)
   *
   * @param ratio - Ratio для сериализации
   * @returns Result с RatioLossyJSON или ошибкой
   *
   * @remarks
   * ⚠️ ВНИМАНИЕ: Может потерять точность для больших чисел.
   * Использует number вместо string.
   *
   * @example
   * ```typescript
   * const result = RatioLossySerializer.toJSON(ratio);
   * if (result.ok) {
   *   console.log(result.value); // { ratio: 0.02 }
   * }
   * ```
   */
  public static toJSON(ratio: Ratio): Result<RatioLossyJSON, InvalidOperandError> {
    const decimalValue = ratio.toDecimal();
    if (!decimalValue.isFinite()) {
      return Err(
        new InvalidOperandError(
          (ctx) => `Cannot serialize non-finite Ratio to JSON, got ${ctx.value}`,
          {
            context: {
              source: ErrorSource.PARSING,
              service: RatioLossySerializer.SERVICE_NAME,
              op: 'toJSON',
              value: decimalValue.toString(),
              operation: 'toJSON'
            }
          }
        )
      );
    }
    return Ok({ ratio: decimalValue.toNumber() });
  }

  /**
   * Десериализует Ratio из JSON (lossy)
   *
   * @param json - RatioLossyJSON объект { ratio: number }
   * @returns Result с Ratio или InvalidRatioError
   *
   * @example
   * ```typescript
   * const result = RatioLossySerializer.fromJSON({ ratio: 0.02 });
   * ```
   */
  public static fromJSON(json: RatioLossyJSON): Result<Ratio, InvalidRatioError> {
    return RatioService.fromDecimal(json.ratio);
  }
}
