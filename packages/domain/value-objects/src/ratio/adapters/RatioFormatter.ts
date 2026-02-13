/**
 * Форматирование Ratio в строки
 *
 * @remarks
 * Все методы возвращают Result<string, InvalidRatioError>
 * Поддерживаются форматы:
 * - Decimal: "0.02"
 * - Percent: "2.00%"
 * - Basis points: "200 bps"
 *
 * @example
 * ```typescript
 * const ratio = RatioService.fromPercent(2.5).value;
 *
 * RatioFormatter.toDecimal(ratio); // "0.025"
 * RatioFormatter.toPercent(ratio, 2); // "2.50%"
 * RatioFormatter.toBps(ratio, 0); // "250 bps"
 * ```
 */
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidRatioError, ErrorSource } from '@polymarket/errors';
import { Ratio } from '../core/Ratio.js';
import { RatioErrorReason } from '../errors/RatioErrorReason.js';
import { RatioService } from '../facade/RatioService.js';

export class RatioFormatter {
  /**
   * Форматировать как decimal string
   *
   * @param ratio - Ratio для форматирования
   * @param decimals - Количество десятичных знаков (по умолчанию 4)
   * @returns Result с отформатированной строкой
   *
   * @example
   * ```typescript
   * const ratio = RatioService.fromPercent(2).value;
   * RatioFormatter.toDecimal(ratio, 4); // "0.0200"
   * ```
   */
  public static toDecimal(ratio: Ratio, decimals: number = 4): Result<string, InvalidRatioError> {
    // Validate decimals (inline validation following existing pattern)
    if (decimals < 0 || !Number.isInteger(decimals)) {
      return Err(
        new InvalidRatioError('decimals argument must be a non-negative integer', {
          context: {
            source: ErrorSource.RULE_VALIDATION,
            op: 'toDecimal',
            decimals: decimals.toString(),
            reason: RatioErrorReason.INVALID_DECIMALS
          }
        })
      );
    }

    // Format
    const formatted = ratio.toDecimal().toFixed(decimals);
    return Ok(formatted);
  }

  /**
   * Форматировать как процент
   *
   * @param ratio - Ratio для форматирования
   * @param decimals - Количество десятичных знаков (по умолчанию 2)
   * @returns Result с отформатированной строкой (например, "2.50%")
   *
   * @example
   * ```typescript
   * const ratio = RatioService.fromPercent(2.5).value;
   * RatioFormatter.toPercent(ratio, 2); // "2.50%"
   * RatioFormatter.toPercent(ratio, 1); // "2.5%"
   * ```
   */
  public static toPercent(ratio: Ratio, decimals: number = 2): Result<string, InvalidRatioError> {
    // Validate decimals (inline validation following existing pattern)
    if (decimals < 0 || !Number.isInteger(decimals)) {
      return Err(
        new InvalidRatioError('decimals argument must be a non-negative integer', {
          context: {
            source: ErrorSource.RULE_VALIDATION,
            op: 'toPercent',
            decimals: decimals.toString(),
            reason: RatioErrorReason.INVALID_DECIMALS
          }
        })
      );
    }

    // Convert to percent (multiply by 100)
    const percent = ratio.toDecimal().mul(100);
    const formatted = percent.toFixed(decimals) + '%';
    return Ok(formatted);
  }

  /**
   * Форматировать как basis points
   *
   * @param ratio - Ratio для форматирования
   * @param decimals - Количество десятичных знаков (по умолчанию 0)
   * @returns Result с отформатированной строкой (например, "250 bps")
   *
   * @example
   * ```typescript
   * const ratio = RatioService.fromPercent(2.5).value;
   * RatioFormatter.toBps(ratio, 0); // "250 bps"
   * RatioFormatter.toBps(ratio, 1); // "250.0 bps"
   * ```
   */
  public static toBps(ratio: Ratio, decimals: number = 0): Result<string, InvalidRatioError> {
    // Validate decimals (inline validation following existing pattern)
    if (decimals < 0 || !Number.isInteger(decimals)) {
      return Err(
        new InvalidRatioError('decimals argument must be a non-negative integer', {
          context: {
            source: ErrorSource.RULE_VALIDATION,
            op: 'toBps',
            decimals: decimals.toString(),
            reason: RatioErrorReason.INVALID_DECIMALS
          }
        })
      );
    }

    // Convert to bps (multiply by 10000)
    const bps = ratio.toDecimal().mul(10000);
    const formatted = bps.toFixed(decimals) + ' bps';
    return Ok(formatted);
  }

  /**
   * Парсинг строки в Ratio
   *
   * @remarks
   * Поддерживаются форматы:
   * - "0.02" - decimal
   * - "2%" - percent
   * - "200 bps" - basis points
   *
   * @param input - Строка для парсинга
   * @returns Result с Ratio или InvalidRatioError
   *
   * @example
   * ```typescript
   * RatioFormatter.parse("0.02");   // Ok(Ratio(0.02))
   * RatioFormatter.parse("2%");     // Ok(Ratio(0.02))
   * RatioFormatter.parse("200 bps"); // Ok(Ratio(0.02))
   * RatioFormatter.parse("invalid"); // Err(InvalidRatioError)
   * ```
   */
  public static parse(input: string): Result<Ratio, InvalidRatioError> {
    const trimmed = input.trim();

    // Format: "2%"
    if (trimmed.endsWith('%')) {
      const percentStr = trimmed.slice(0, -1).trim();
      // Используем Number() вместо parseFloat() чтобы отвергать trailing garbage
      // parseFloat("2abc") -> 2, Number("2abc") -> NaN
      const percentNum = Number(percentStr);
      if (isNaN(percentNum) || !isFinite(percentNum)) {
        return Err(
          new InvalidRatioError(`Invalid percent format: "${input}"`, {
            context: {
              source: ErrorSource.PARSING,
              op: 'parse',
              input,
              reason: RatioErrorReason.INVALID_FORMAT
            }
          })
        );
      }
      return RatioService.fromPercent(percentNum);
    }

    // Format: "200 bps"
    if (trimmed.endsWith('bps')) {
      const bpsStr = trimmed.slice(0, -3).trim();
      // Используем Number() вместо parseFloat() чтобы отвергать trailing garbage
      const bpsNum = Number(bpsStr);
      if (isNaN(bpsNum) || !isFinite(bpsNum)) {
        return Err(
          new InvalidRatioError(`Invalid bps format: "${input}"`, {
            context: {
              source: ErrorSource.PARSING,
              op: 'parse',
              input,
              reason: RatioErrorReason.INVALID_FORMAT
            }
          })
        );
      }
      return RatioService.fromBps(bpsNum);
    }

    // Format: "0.02" (decimal)
    // Используем Number() вместо parseFloat() чтобы отвергать trailing garbage
    const decimalNum = Number(trimmed);
    if (isNaN(decimalNum) || !isFinite(decimalNum)) {
      return Err(
        new InvalidRatioError(`Invalid decimal format: "${input}"`, {
          context: {
            source: ErrorSource.PARSING,
            op: 'parse',
            input,
            reason: RatioErrorReason.INVALID_FORMAT
          }
        })
      );
    }
    return RatioService.fromDecimal(decimalNum);
  }
}
