import { SignedQuantity } from '../core/SignedQuantity.js';
import { InvalidDecimalPlacesError, ErrorSource } from '@polymarket/errors';
import { Result, Ok, Err } from '@polymarket/result';

/**
 * Форматирование SignedQuantity в строки
 *
 * @remarks
 * Поддерживает различные форматы отображения знаковых количеств:
 * - Стандартный: "+10", "-10", "0"
 * - Финансовый: "10", "(10)", "0"
 * - Компактный: "10", "-10", "0"
 * - С суффиксами: "+1.50K", "-1.50K", "0"
 */
export class SignedQuantityFormatter {
  private static readonly THOUSAND = 1000;
  private static readonly MILLION = 1000000;

  /**
   * Форматирует в string с фиксированным количеством decimal places
   *
   * @param quantity - Количество для форматирования
   * @param decimals - Количество знаков после запятой (default: 2, max: 100)
   * @param options - Опции форматирования
   * @returns Result с отформатированной строкой или ошибкой
   *
   * @example
   * ```typescript
   * const result = SignedQuantityFormatter.toString(qty, 2);
   * if (result.ok) {
   *   console.log(result.value); // "+10.50" или "-10.50"
   * }
   *
   * // Без знака плюс
   * const result2 = SignedQuantityFormatter.toString(qty, 2, { showPlusSign: false });
   * // "10.50" или "-10.50"
   * ```
   */
  public static toString(
    quantity: SignedQuantity,
    decimals: number = 2,
    options?: { showPlusSign?: boolean }
  ): Result<string, InvalidDecimalPlacesError> {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 100) {
      return Err(
        new InvalidDecimalPlacesError(
          (ctx) => `Decimal places must be an integer between 0 and 100, got ${ctx.decimalPlaces}`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              service: 'SignedQuantityFormatter',
              op: 'toString',
              decimalPlaces: String(decimals),
              quantity: quantity.value().toString()
            }
          }
        )
      );
    }

    const formatted = quantity.value().toFixed(decimals);
    const showPlusSign = options?.showPlusSign ?? true;

    // Добавляем знак плюс для положительных чисел
    if (showPlusSign && quantity.isPositive()) {
      return Ok(`+${formatted}`);
    }

    return Ok(formatted);
  }

  /**
   * Форматирует в компактную строку (без trailing zeros)
   *
   * @param quantity - Количество для форматирования
   * @param options - Опции форматирования
   * @returns Компактная строка
   *
   * @example
   * ```typescript
   * SignedQuantityFormatter.toCompactString(qty); // "+10.5" или "-10.5"
   * SignedQuantityFormatter.toCompactString(qty, { showPlusSign: false }); // "10.5" или "-10.5"
   * ```
   */
  public static toCompactString(
    quantity: SignedQuantity,
    options?: { showPlusSign?: boolean }
  ): string {
    const value = quantity.value().toString();
    const showPlusSign = options?.showPlusSign ?? true;

    if (showPlusSign && quantity.isPositive()) {
      return `+${value}`;
    }

    return value;
  }

  /**
   * Форматирует для отладки
   *
   * @param quantity - Количество для форматирования
   * @returns Debug строка
   *
   * @example
   * ```typescript
   * SignedQuantityFormatter.toDebugString(qty); // "SignedQuantity(+10)" или "SignedQuantity(-10)"
   * ```
   */
  public static toDebugString(quantity: SignedQuantity): string {
    const value = quantity.value().toString();
    const prefix = quantity.isPositive() ? '+' : '';
    return `SignedQuantity(${prefix}${value})`;
  }

  /**
   * Форматирует в финансовом стиле (negative in parentheses)
   *
   * @remarks
   * Финансовый формат:
   * - Положительные: "10.00"
   * - Отрицательные: "(10.00)"
   * - Ноль: "0.00"
   *
   * @param quantity - Количество для форматирования
   * @param decimals - Количество знаков после запятой (default: 2)
   * @returns Result с финансовой строкой или ошибкой
   *
   * @example
   * ```typescript
   * SignedQuantityFormatter.toFinancialString(positive); // "10.00"
   * SignedQuantityFormatter.toFinancialString(negative); // "(10.00)"
   * SignedQuantityFormatter.toFinancialString(zero); // "0.00"
   * ```
   */
  public static toFinancialString(
    quantity: SignedQuantity,
    decimals: number = 2
  ): Result<string, InvalidDecimalPlacesError> {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 100) {
      return Err(
        new InvalidDecimalPlacesError(
          (ctx) => `Decimal places must be an integer between 0 and 100, got ${ctx.decimalPlaces}`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              service: 'SignedQuantityFormatter',
              op: 'toFinancialString',
              decimalPlaces: String(decimals),
              quantity: quantity.value().toString()
            }
          }
        )
      );
    }

    const absValue = quantity.abs().toFixed(decimals);

    if (quantity.isNegative()) {
      return Ok(`(${absValue})`);
    }

    return Ok(absValue);
  }

  /**
   * Форматирует для отображения с K/M суффиксами и знаком
   *
   * @remarks
   * ⚠️ ВНИМАНИЕ: Использует toNumber() → lossy для больших значений.
   * Это форматтер для UI, точность не гарантируется.
   *
   * @param quantity - Количество для форматирования
   * @param options - Опции форматирования
   * @returns Display строка с суффиксами
   *
   * @example
   * ```typescript
   * SignedQuantityFormatter.toDisplayString(SignedQuantity.of(new Decimal(1500))); // "+1.50K"
   * SignedQuantityFormatter.toDisplayString(SignedQuantity.of(new Decimal(-1500))); // "-1.50K"
   * SignedQuantityFormatter.toDisplayString(SignedQuantity.of(new Decimal(1500000))); // "+1.50M"
   * SignedQuantityFormatter.toDisplayString(SignedQuantity.of(new Decimal(100))); // "+100.00"
   *
   * // Без знака плюс
   * SignedQuantityFormatter.toDisplayString(qty, { showPlusSign: false }); // "100.00"
   * ```
   */
  public static toDisplayString(
    quantity: SignedQuantity,
    options?: { showPlusSign?: boolean }
  ): string {
    const value = quantity.toNumber(); // lossy
    const absValue = Math.abs(value);
    const showPlusSign = options?.showPlusSign ?? true;

    let formatted: string;

    if (absValue >= SignedQuantityFormatter.MILLION) {
      formatted = `${(absValue / SignedQuantityFormatter.MILLION).toFixed(2)}M`;
    } else if (absValue >= SignedQuantityFormatter.THOUSAND) {
      // Защита от граничного случая: если после округления получается 1000.00K,
      // переходим к следующей единице измерения (M)
      const kFormatted = (absValue / SignedQuantityFormatter.THOUSAND).toFixed(2);
      if (parseFloat(kFormatted) >= 1000) {
        formatted = `${(absValue / SignedQuantityFormatter.MILLION).toFixed(2)}M`;
      } else {
        formatted = `${kFormatted}K`;
      }
    } else {
      formatted = absValue.toFixed(2);
    }

    // Добавляем знак
    if (quantity.isNegative()) {
      return `-${formatted}`;
    } else if (quantity.isPositive() && showPlusSign) {
      return `+${formatted}`;
    }

    return formatted;
  }

  /**
   * Форматирует как P&L (Profit & Loss) строку с цветным индикатором
   *
   * @remarks
   * Возвращает объект с форматированным значением и индикатором направления.
   * Полезно для UI, где нужно показать прибыль/убыток с цветом.
   *
   * @param quantity - Количество для форматирования
   * @param decimals - Количество знаков после запятой (default: 2)
   * @returns Объект с форматированной строкой и индикатором
   *
   * @example
   * ```typescript
   * const profit = SignedQuantityFormatter.toPnLString(positive);
   * // { value: "+10.00", indicator: "profit" }
   *
   * const loss = SignedQuantityFormatter.toPnLString(negative);
   * // { value: "-10.00", indicator: "loss" }
   *
   * const breakEven = SignedQuantityFormatter.toPnLString(zero);
   * // { value: "0.00", indicator: "neutral" }
   *
   * // В React:
   * const pnl = SignedQuantityFormatter.toPnLString(qty);
   * <span className={pnl.indicator}>{pnl.value}</span>
   * ```
   */
  public static toPnLString(
    quantity: SignedQuantity,
    decimals: number = 2
  ): Result<{ value: string; indicator: 'profit' | 'loss' | 'neutral' }, InvalidDecimalPlacesError> {
    const stringResult = this.toString(quantity, decimals, { showPlusSign: true });

    if (!stringResult.ok) {
      return stringResult;
    }

    let indicator: 'profit' | 'loss' | 'neutral';
    if (quantity.isPositive()) {
      indicator = 'profit';
    } else if (quantity.isNegative()) {
      indicator = 'loss';
    } else {
      indicator = 'neutral';
    }

    return Ok({
      value: stringResult.value,
      indicator
    });
  }
}
