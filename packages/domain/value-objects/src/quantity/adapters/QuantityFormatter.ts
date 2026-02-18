import { Quantity } from '../core/Quantity.js';
import { InvalidDecimalPlacesError, ErrorSource } from '@polymarket/errors';
import { Result, Ok, Err } from '@polymarket/result';

/**
 * Форматирование Quantity в строки
 */
export class QuantityFormatter {
  private static readonly THOUSAND = 1000;
  private static readonly MILLION = 1000000;
  /**
   * Форматирует в string с фиксированным количеством decimal places
   *
   * @param quantity - Количество для форматирования
   * @param decimals - Количество знаков после запятой (default: 2, max: 100)
   * @returns Result с отформатированной строкой или ошибкой
   *
   * @example
   * ```typescript
   * const result = QuantityFormatter.toString(Quantity.of(10.5), 2);
   * if (result.ok) {
   *   console.log(result.value); // "10.50"
   * }
   * ```
   */
  public static toString(quantity: Quantity, decimals: number = 2): Result<string, InvalidDecimalPlacesError> {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 100) {
      return Err(
        new InvalidDecimalPlacesError(
          (ctx) => `Decimal places must be an integer between 0 and 100, got ${ctx.decimalPlaces}`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              service: 'QuantityFormatter',
              op: 'toString',
              decimalPlaces: String(decimals),
              quantity: quantity.value().toString()
            }
          }
        )
      );
    }
    return Ok(quantity.value().toFixed(decimals));
  }

  /**
   * Форматирует в компактную строку (без trailing zeros)
   *
   * @param quantity - Количество для форматирования
   * @returns Компактная строка
   *
   * @example
   * ```typescript
   * QuantityFormatter.toCompactString(Quantity.of(10.5)); // "10.5"
   * QuantityFormatter.toCompactString(Quantity.of(10)); // "10"
   * ```
   */
  public static toCompactString(quantity: Quantity): string {
    return quantity.value().toString();
  }

  /**
   * Форматирует для отладки
   *
   * @param quantity - Количество для форматирования
   * @returns Debug строка
   *
   * @example
   * ```typescript
   * QuantityFormatter.toDebugString(Quantity.of(10)); // "Quantity(10)"
   * ```
   */
  public static toDebugString(quantity: Quantity): string {
    return `Quantity(${quantity.value().toString()})`;
  }

  /**
   * Форматирует для отображения с K/M суффиксами
   *
   * @remarks
   * ⚠️ ВНИМАНИЕ: Использует toNumber() → lossy для больших значений.
   * Это форматтер для UI, точность не гарантируется.
   *
   * @param quantity - Количество для форматирования
   * @returns Display строка с суффиксами
   *
   * @example
   * ```typescript
   * QuantityFormatter.toDisplayString(Quantity.of(1500)); // "1.50K"
   * QuantityFormatter.toDisplayString(Quantity.of(1500000)); // "1.50M"
   * QuantityFormatter.toDisplayString(Quantity.of(100)); // "100.00"
   * ```
   */
  public static toDisplayString(quantity: Quantity): string {
    const value = quantity.toNumber(); // lossy

    if (value >= QuantityFormatter.MILLION) {
      return `${(value / QuantityFormatter.MILLION).toFixed(2)}M`;
    }
    if (value >= QuantityFormatter.THOUSAND) {
      return `${(value / QuantityFormatter.THOUSAND).toFixed(2)}K`;
    }
    return value.toFixed(2);
  }
}
