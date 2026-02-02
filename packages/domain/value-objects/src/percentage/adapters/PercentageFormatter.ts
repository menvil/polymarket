import { Percentage } from '../core/Percentage';

/**
 * Форматтер для Percentage
 *
 * @remarks
 * Предоставляет методы для форматирования Percentage в строки
 * для UI и логирования.
 *
 * @example
 * ```typescript
 * import { Percentage, PercentageFormatter } from '@polymarket/value-objects/percentage';
 *
 * const pct = Percentage.of(50);
 *
 * console.log(PercentageFormatter.toPercent(pct));           // "50.00%"
 * console.log(PercentageFormatter.toDecimalFraction(pct));   // "0.50"
 * console.log(PercentageFormatter.toBasisPoints(pct));       // "5000 bp"
 * ```
 */
export class PercentageFormatter {
  /**
   * Форматирует Percentage с указанным количеством знаков
   *
   * @remarks
   * Использует Decimal.toFixed() для точного форматирования.
   * Всегда возвращает строго заданное количество десятичных знаков.
   *
   * @param pct - Percentage для форматирования
   * @param decimals - Количество десятичных знаков (по умолчанию 2)
   * @returns Строка с фиксированным количеством знаков
   * @throws {RangeError} Если decimals отрицательное или не целое число
   *
   * @example
   * ```typescript
   * const pct = Percentage.of(50.5);
   * console.log(PercentageFormatter.toFixed(pct));       // "50.50"
   * console.log(PercentageFormatter.toFixed(pct, 0));    // "51"
   * console.log(PercentageFormatter.toFixed(pct, 4));    // "50.5000"
   *
   * const pct2 = Percentage.of(99.9999);
   * console.log(PercentageFormatter.toFixed(pct2));      // "100.00"
   * console.log(PercentageFormatter.toFixed(pct2, 2));   // "100.00"
   * ```
   */
  public static toFixed(pct: Percentage, decimals: number = 2): string {
    if (decimals < 0 || !Number.isInteger(decimals)) {
      throw new RangeError('decimals argument must be a non-negative integer');
    }
    return pct.value().toFixed(decimals);
  }

  /**
   * Форматирует Percentage с символом процента
   *
   * @remarks
   * Добавляет символ % после значения.
   * Используется для отображения процентов в UI.
   *
   * @param pct - Percentage для форматирования
   * @param decimals - Количество десятичных знаков (по умолчанию 2)
   * @returns Строка вида "50.00%"
   *
   * @example
   * ```typescript
   * const pct = Percentage.of(50.5);
   * console.log(PercentageFormatter.toPercent(pct));              // "50.50%"
   * console.log(PercentageFormatter.toPercent(pct, 0));           // "51%"
   * console.log(PercentageFormatter.toPercent(pct, 4));           // "50.5000%"
   *
   * const pct2 = Percentage.of(-10.25);
   * console.log(PercentageFormatter.toPercent(pct2));             // "-10.25%"
   *
   * const pct3 = Percentage.of(0.01);
   * console.log(PercentageFormatter.toPercent(pct3, 4));          // "0.0100%"
   * ```
   */
  public static toPercent(pct: Percentage, decimals: number = 2): string {
    if (decimals < 0 || !Number.isInteger(decimals)) {
      throw new RangeError('decimals argument must be a non-negative integer');
    }
    return `${pct.value().toFixed(decimals)}%`;
  }

  /**
   * Форматирует Percentage как десятичную дробь (scale 0-1)
   *
   * @remarks
   * Конвертирует из процентной шкалы (0-100) в десятичную (0-1).
   * Полезно для математических операций и API интеграций.
   *
   * @param pct - Percentage для форматирования
   * @param decimals - Количество десятичных знаков (по умолчанию 4)
   * @returns Строка вида "0.5000" для 50%
   *
   * @example
   * ```typescript
   * const pct = Percentage.of(50);
   * console.log(PercentageFormatter.toDecimalFraction(pct));      // "0.5000"
   * console.log(PercentageFormatter.toDecimalFraction(pct, 2));   // "0.50"
   *
   * const pct2 = Percentage.of(25);
   * console.log(PercentageFormatter.toDecimalFraction(pct2));     // "0.2500"
   *
   * const pct3 = Percentage.of(0.01);
   * console.log(PercentageFormatter.toDecimalFraction(pct3, 6));  // "0.000100"
   * ```
   */
  public static toDecimalFraction(pct: Percentage, decimals: number = 4): string {
    if (decimals < 0 || !Number.isInteger(decimals)) {
      throw new RangeError('decimals argument must be a non-negative integer');
    }
    return pct.toDecimal().toFixed(decimals);
  }

  /**
   * Форматирует Percentage как базисные пункты (bp)
   *
   * @remarks
   * 1 базисный пункт (bp) = 0.01%
   * Используется в финансовых расчётах для точного представления малых процентов.
   *
   * @param pct - Percentage для форматирования
   * @param decimals - Количество десятичных знаков (по умолчанию 0)
   * @returns Строка вида "5000 bp" для 50%
   *
   * @example
   * ```typescript
   * const pct = Percentage.of(50);
   * console.log(PercentageFormatter.toBasisPoints(pct));          // "5000 bp"
   *
   * const pct2 = Percentage.of(0.01);
   * console.log(PercentageFormatter.toBasisPoints(pct2));         // "1 bp"
   *
   * const pct3 = Percentage.of(2.5);
   * console.log(PercentageFormatter.toBasisPoints(pct3));         // "250 bp"
   * console.log(PercentageFormatter.toBasisPoints(pct3, 2));      // "250.00 bp"
   * ```
   */
  public static toBasisPoints(pct: Percentage, decimals: number = 0): string {
    if (decimals < 0 || !Number.isInteger(decimals)) {
      throw new RangeError('decimals argument must be a non-negative integer');
    }
    return `${pct.toBasisPoints().toFixed(decimals)} bp`;
  }

  /**
   * Форматирует Percentage компактно (сокращает большие числа)
   *
   * @remarks
   * Используется для отображения больших процентов в ограниченном пространстве.
   * Добавляет символ % после значения.
   *
   * @param pct - Percentage для форматирования
   * @param decimals - Количество десятичных знаков (по умолчанию 1)
   * @returns Строка вида "50.0%", "-10.5%"
   *
   * @example
   * ```typescript
   * const pct1 = Percentage.of(50.5);
   * console.log(PercentageFormatter.toCompact(pct1));             // "50.5%"
   *
   * const pct2 = Percentage.of(-10.25);
   * console.log(PercentageFormatter.toCompact(pct2));             // "-10.3%"
   *
   * const pct3 = Percentage.of(0.01);
   * console.log(PercentageFormatter.toCompact(pct3));             // "0.0%"
   * console.log(PercentageFormatter.toCompact(pct3, 4));          // "0.0100%"
   * ```
   */
  public static toCompact(pct: Percentage, decimals: number = 1): string {
    if (decimals < 0 || !Number.isInteger(decimals)) {
      throw new RangeError('decimals argument must be a non-negative integer');
    }
    return `${pct.value().toFixed(decimals)}%`;
  }
}
