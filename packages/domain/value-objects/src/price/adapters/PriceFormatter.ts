import { Price } from '../core/Price.js';
import { InvalidPriceError } from '@polymarket/errors';
import { Result, Ok, Err } from '@polymarket/result';
import { ErrorSource } from '../../shared/facade/ErrorSource.js';

/**
 * Форматтер для Price
 *
 * @remarks
 * Предоставляет методы для форматирования Price в строки
 * для UI и логирования.
 *
 * Все методы возвращают Result для обработки ошибок валидации параметров.
 *
 * @example
 * ```typescript
 * import { PriceService, PriceFormatter } from '@polymarket/value-objects/price';
 *
 * const price = expectOk(PriceService.create(0.5));
 *
 * const percentage = expectOk(PriceFormatter.toPercentage(price));
 * console.log(percentage);    // "50.00%"
 *
 * const fixed = expectOk(PriceFormatter.toFixed(price, 2));
 * console.log(fixed);         // "0.50"
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
   * @returns Result с отформатированной строкой вида "50.00%" или ошибкой валидации
   * @throws Никогда не бросает исключения, возвращает Result
   *
   * @example
   * ```typescript
   * const price = expectOk(PriceService.create(0.5));
   *
   * const result1 = PriceFormatter.toPercentage(price);
   * if (result1.ok) {
   *   console.log(result1.value);  // "50.00%"
   * }
   *
   * const result2 = PriceFormatter.toPercentage(price, 0);
   * if (result2.ok) {
   *   console.log(result2.value);  // "50%"
   * }
   *
   * // Ошибка валидации
   * const result3 = PriceFormatter.toPercentage(price, -1);
   * if (!result3.ok) {
   *   console.log(result3.error.message); // ошибка валидации decimals
   * }
   * ```
   */
  public static toPercentage(price: Price, decimals: number = 2): Result<string, InvalidPriceError> {
    if (decimals < 0 || !Number.isInteger(decimals)) {
      return Err(
        new InvalidPriceError('decimals argument must be a non-negative integer', {
          context: {
            source: ErrorSource.RULE_VALIDATION,
            service: 'PriceFormatter',
            op: 'toPercentage',
            decimals: String(decimals),
            priceValue: price.value().toString()
          }
        })
      );
    }
    const percentage = price.value().times(100);
    return Ok(`${percentage.toFixed(decimals)}%`);
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
   * @returns Result с отформатированной строкой или ошибкой валидации
   * @throws Никогда не бросает исключения, возвращает Result
   *
   * @example
   * ```typescript
   * const price = expectOk(PriceService.create(0.5));
   *
   * const result1 = PriceFormatter.toFixed(price, 2);
   * if (result1.ok) {
   *   console.log(result1.value);  // "0.50"
   * }
   *
   * const result2 = PriceFormatter.toFixed(price, 4);
   * if (result2.ok) {
   *   console.log(result2.value);  // "0.5000"
   * }
   *
   * // Ошибка валидации
   * const result3 = PriceFormatter.toFixed(price, 2.5);
   * if (!result3.ok) {
   *   console.log(result3.error.message); // ошибка валидации decimals
   * }
   * ```
   */
  public static toFixed(price: Price, decimals: number = 4): Result<string, InvalidPriceError> {
    if (decimals < 0 || !Number.isInteger(decimals)) {
      return Err(
        new InvalidPriceError('toFixed() decimals argument must be a non-negative integer', {
          context: {
            source: ErrorSource.RULE_VALIDATION,
            service: 'PriceFormatter',
            op: 'toFixed',
            decimals: String(decimals),
            priceValue: price.value().toString()
          }
        })
      );
    }
    return Ok(price.value().toFixed(decimals));
  }
}
