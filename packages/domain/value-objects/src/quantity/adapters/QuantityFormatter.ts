import { Quantity } from '../core/Quantity.js';

/**
 * Форматирование Quantity в строки
 */
export class QuantityFormatter {
  /**
   * Форматирует в string с фиксированным количеством decimal places
   *
   * @param quantity - Количество для форматирования
   * @param decimals - Количество знаков после запятой (default: 2)
   * @returns Отформатированная строка
   *
   * @example
   * ```typescript
   * QuantityFormatter.toString(Quantity.of(10.5), 2); // "10.50"
   * ```
   */
  public static toString(quantity: Quantity, decimals: number = 2): string {
    return quantity.value().toFixed(decimals);
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

    if (value >= 1000000) {
      return `${(value / 1000000).toFixed(2)}M`;
    }
    if (value >= 1000) {
      return `${(value / 1000).toFixed(2)}K`;
    }
    return value.toFixed(2);
  }
}
