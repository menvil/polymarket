import { OutcomePrice } from '../core/OutcomePrice.js';
import { InvalidOutcomePriceError, ErrorSource } from '@polymarket/errors';
import { Result, Ok, Err } from '@polymarket/result';

/**
 * Форматтер для OutcomePrice
 *
 * @remarks
 * Предоставляет методы для форматирования OutcomePrice в строки
 * для UI и логирования.
 *
 * Все методы возвращают Result для обработки ошибок валидации параметров.
 *
 * @example
 * ```typescript
 * import { OutcomePriceService, OutcomePriceFormatter } from '@polymarket/value-objects/outcome-price';
 *
 * const price = expectOk(OutcomePriceService.create(0.5));
 *
 * const percentage = expectOk(OutcomePriceFormatter.toPercentage(price));
 * console.log(percentage);    // "50.00%"
 *
 * const fixed = expectOk(OutcomePriceFormatter.toFixed(price, 2));
 * console.log(fixed);         // "0.50"
 * ```
 */
export class OutcomePriceFormatter {
  /**
   * Форматирует OutcomePrice как процент
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
   * const price = expectOk(OutcomePriceService.create(0.5));
   *
   * const result1 = OutcomePriceFormatter.toPercentage(price);
   * if (result1.ok) {
   *   console.log(result1.value);  // "50.00%"
   * }
   *
   * const result2 = OutcomePriceFormatter.toPercentage(price, 0);
   * if (result2.ok) {
   *   console.log(result2.value);  // "50%"
   * }
   *
   * // Ошибка валидации
   * const result3 = OutcomePriceFormatter.toPercentage(price, -1);
   * if (!result3.ok) {
   *   console.log(result3.error.message); // ошибка валидации decimals
   * }
   * ```
   */
  public static toPercentage(price: OutcomePrice, decimals: number = 2): Result<string, InvalidOutcomePriceError> {
    if (decimals < 0 || !Number.isInteger(decimals)) {
      return Err(
        new InvalidOutcomePriceError('decimals argument must be a non-negative integer', {
          context: {
            source: ErrorSource.RULE_VALIDATION,
            service: 'OutcomePriceFormatter',
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
   * Форматирует OutcomePrice с указанным количеством знаков
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
   * const price = expectOk(OutcomePriceService.create(0.5));
   *
   * const result1 = OutcomePriceFormatter.toFixed(price, 2);
   * if (result1.ok) {
   *   console.log(result1.value);  // "0.50"
   * }
   *
   * const result2 = OutcomePriceFormatter.toFixed(price, 4);
   * if (result2.ok) {
   *   console.log(result2.value);  // "0.5000"
   * }
   *
   * // Ошибка валидации
   * const result3 = OutcomePriceFormatter.toFixed(price, 2.5);
   * if (!result3.ok) {
   *   console.log(result3.error.message); // ошибка валидации decimals
   * }
   * ```
   */
  public static toFixed(price: OutcomePrice, decimals: number = 4): Result<string, InvalidOutcomePriceError> {
    if (decimals < 0 || !Number.isInteger(decimals)) {
      return Err(
        new InvalidOutcomePriceError('decimals argument must be a non-negative integer', {
          context: {
            source: ErrorSource.RULE_VALIDATION,
            service: 'OutcomePriceFormatter',
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
