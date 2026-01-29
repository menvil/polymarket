import { Result } from '@polymarket/result';
import { InvalidQuantityError, InvalidOperandError } from '@polymarket/errors';
import { Quantity } from '../core/Quantity.js';
import { QuantityService } from '../facade/QuantityService.js';

/**
 * Сериализация Quantity в/из JSON (точная, через string)
 *
 * @remarks
 * Использует string для сериализации, чтобы избежать потери точности.
 * Если Quantity внутри хранит Decimal, JSON number может потерять точность.
 *
 * Для lossy сериализации (number) используй QuantityLossySerializer.
 */
export class QuantitySerializer {
  /**
   * Сериализует Quantity в JSON (string для точности)
   *
   * @param quantity - Количество для сериализации
   * @returns JSON объект { value: string }
   *
   * @example
   * ```typescript
   * const json = QuantitySerializer.toJSON(qty);
   * // { value: "10.123456789" }
   * ```
   */
  public static toJSON(quantity: Quantity): { value: string } {
    return { value: quantity.value().toString() };
  }

  /**
   * Десериализует Quantity из JSON
   *
   * @param json - JSON объект { value: string }
   * @returns Result<Quantity, InvalidQuantityError>
   *
   * @example
   * ```typescript
   * const result = QuantitySerializer.fromJSON({ value: "10.123456789" });
   * if (result.ok) {
   *   const qty = result.value;
   * }
   * ```
   */
  public static fromJSON(json: { value: string }): Result<Quantity, InvalidQuantityError> {
    return QuantityService.create(json.value);
  }
}

/**
 * Lossy serializer для случаев когда точность не критична
 *
 * @remarks
 * ⚠️ ВНИМАНИЕ: Использует number, что может привести к потере точности.
 * Используйте только для отображения или когда точность не критична.
 * Для точной сериализации используйте QuantitySerializer.
 */
export class QuantityLossySerializer {
  /**
   * Сериализует Quantity в JSON (number, lossy)
   *
   * @remarks
   * ⚠️ ВНИМАНИЕ: Может потерять точность для больших чисел.
   *
   * @param quantity - Количество для сериализации
   * @returns JSON объект { value: number }
   * @throws {InvalidOperandError} Если Quantity содержит non-finite значение
   *
   * @example
   * ```typescript
   * const json = QuantityLossySerializer.toJSON(qty);
   * // { value: 10.123456789 } (может потерять precision)
   * ```
   */
  public static toJSON(quantity: Quantity): { value: number } {
    const decimalValue = quantity.value();
    if (!decimalValue.isFinite()) {
      throw new InvalidOperandError(
        (ctx) => `Cannot serialize non-finite Quantity to JSON, got ${ctx.value}`,
        {
          context: {
            value: decimalValue.toString(),
            operation: 'toJSON'
          }
        }
      );
    }
    return { value: quantity.toNumber() };
  }

  /**
   * Десериализует Quantity из JSON (number, lossy)
   *
   * @param json - JSON объект { value: number }
   * @returns Result<Quantity, InvalidQuantityError>
   *
   * @example
   * ```typescript
   * const result = QuantityLossySerializer.fromJSON({ value: 10 });
   * ```
   */
  public static fromJSON(json: { value: number }): Result<Quantity, InvalidQuantityError> {
    return QuantityService.create(json.value);
  }
}
