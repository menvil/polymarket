import { Price } from '../core/Price.js';

/**
 * Форматтер для Price
 *
 * @remarks
 * Предоставляет методы для форматирования Price в строки
 * для UI и логирования.
 *
 * @example
 * ```typescript
 * import { PriceService, PriceFormatter } from '@polymarket/value-objects/price';
 *
 * const price = expectOk(PriceService.create(0.5));
 *
 * console.log(PriceFormatter.toPercentage(price));    // "50.00%"
 * console.log(PriceFormatter.toFixed(price, 2));      // "0.50"
 * console.log(PriceFormatter.toFixed(price, 4));      // "0.5000"
 * ```
 */
export class PriceFormatter {
  /**
   * Форматирует Price как процент
   *
   * @remarks
   * Умножает значение на 100 и добавляет знак процента.
   * Используется для отображения вероятностей в UI.
   *
   * @param price - Цена для форматирования
   * @param decimals - Количество десятичных знаков (по умолчанию 2)
   * @returns Строка вида "50.00%"
   *
   * @example
   * ```typescript
   * const price = expectOk(PriceService.create(0.5));
   * console.log(PriceFormatter.toPercentage(price));       // "50.00%"
   * console.log(PriceFormatter.toPercentage(price, 0));    // "50%"
   * console.log(PriceFormatter.toPercentage(price, 4));    // "50.0000%"
   *
   * const price2 = expectOk(PriceService.create(0.6789));
   * console.log(PriceFormatter.toPercentage(price2));      // "67.89%"
   * console.log(PriceFormatter.toPercentage(price2, 1));   // "67.9%"
   * ```
   */
  public static toPercentage(price: Price, decimals: number = 2): string {
    if (decimals < 0 || !Number.isInteger(decimals)) {
      throw new RangeError('decimals argument must be a non-negative integer');
    }
    const percentage = price.value().times(100);
    return `${percentage.toFixed(decimals)}%`;
  }

  /**
   * Форматирует Price с указанным количеством знаков
   *
   * @remarks
   * Использует Decimal.toFixed() для точного форматирования.
   * Всегда возвращает строго заданное количество десятичных знаков.
   *
   * @param price - Цена для форматирования
   * @param decimals - Количество десятичных знаков (по умолчанию 4)
   * @returns Строка с фиксированным количеством знаков
   *
   * @example
   * ```typescript
   * const price = expectOk(PriceService.create(0.5));
   * console.log(PriceFormatter.toFixed(price, 2));    // "0.50"
   * console.log(PriceFormatter.toFixed(price, 4));    // "0.5000"
   * console.log(PriceFormatter.toFixed(price, 0));    // "1"
   *
   * const price2 = expectOk(PriceService.create(0.123456));
   * console.log(PriceFormatter.toFixed(price2, 2));   // "0.12"
   * console.log(PriceFormatter.toFixed(price2, 6));   // "0.123456"
   * ```
   */
  public static toFixed(price: Price, decimals: number = 4): string {
    if (decimals < 0 || !Number.isInteger(decimals)) {
      throw new RangeError('toFixed() decimals argument must be a non-negative integer');
    }
    return price.value().toFixed(decimals);
  }
}
