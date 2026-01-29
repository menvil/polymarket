import { Result } from '@polymarket/result';
import { InvalidQuantityError } from '@polymarket/errors';
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
