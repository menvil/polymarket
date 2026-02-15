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
  /**
   * Проверяет что строка не содержит hex/bin/oct литералы
   *
   * @remarks
   * Decimal.js принимает 0x, 0b, 0o префиксы, но для Ratio это нежелательно
   *
   * @param value - Значение для проверки
   * @returns true если строка содержит недопустимые префиксы
   */
  private static hasInvalidPrefix(value: string): boolean {
    const lower = value.toLowerCase().trim();
    return lower.startsWith('0x') || lower.startsWith('0b') || lower.startsWith('0o');
  }

  public static parse(input: string): Result<Ratio, InvalidRatioError> {
    const trimmed = input.trim();

    // Reject empty string (Number("") returns 0, which is unexpected)
    if (trimmed === '') {
      return Err(
        new InvalidRatioError(`Invalid format: empty string`, {
          context: {
            source: ErrorSource.PARSING,
            op: 'parse',
            input,
            reason: RatioErrorReason.INVALID_FORMAT
          }
        })
      );
    }

    // Format: "2%"
    if (trimmed.endsWith('%')) {
      const percentStr = trimmed.slice(0, -1).trim();

      // Reject hex/bin/oct literals
      if (this.hasInvalidPrefix(percentStr)) {
        return Err(
          new InvalidRatioError(`Invalid percent format: hex/bin/oct literals not allowed: "${input}"`, {
            context: {
              source: ErrorSource.PARSING,
              op: 'parse',
              input,
              reason: RatioErrorReason.INVALID_FORMAT
            }
          })
        );
      }
      // Передаем строку напрямую в RatioService.fromPercent для сохранения точности
      // RatioService сам валидирует формат через toDecimal()
      const result = RatioService.fromPercent(percentStr);
      if (!result.ok) {
        // Re-wrap error с правильным source и op
        return Err(
          new InvalidRatioError(`Invalid percent format: "${input}"`, {
            context: {
              source: ErrorSource.PARSING,
              op: 'parse',
              input,
              reason: RatioErrorReason.INVALID_FORMAT,
              cause: result.error.message
            }
          })
        );
      }
      return result;
    }

    // Format: "200 bps"
    if (trimmed.endsWith('bps')) {
      const bpsStr = trimmed.slice(0, -3).trim();

      // Reject hex/bin/oct literals
      if (this.hasInvalidPrefix(bpsStr)) {
        return Err(
          new InvalidRatioError(`Invalid bps format: hex/bin/oct literals not allowed: "${input}"`, {
            context: {
              source: ErrorSource.PARSING,
              op: 'parse',
              input,
              reason: RatioErrorReason.INVALID_FORMAT
            }
          })
        );
      }

      // Передаем строку напрямую в RatioService.fromBps для сохранения точности
      // RatioService сам валидирует формат через toDecimal()
      const result = RatioService.fromBps(bpsStr);
      if (!result.ok) {
        // Re-wrap error с правильным source и op
        return Err(
          new InvalidRatioError(`Invalid bps format: "${input}"`, {
            context: {
              source: ErrorSource.PARSING,
              op: 'parse',
              input,
              reason: RatioErrorReason.INVALID_FORMAT,
              cause: result.error.message
            }
          })
        );
      }
      return result;
    }

    // Format: "0.02" (decimal)
    // Reject hex/bin/oct literals
    if (this.hasInvalidPrefix(trimmed)) {
      return Err(
        new InvalidRatioError(`Invalid decimal format: hex/bin/oct literals not allowed: "${input}"`, {
          context: {
            source: ErrorSource.PARSING,
            op: 'parse',
            input,
            reason: RatioErrorReason.INVALID_FORMAT
          }
        })
      );
    }

    // Передаем строку напрямую в RatioService.fromDecimal для сохранения точности
    // RatioService сам валидирует формат через toDecimal()
    const result = RatioService.fromDecimal(trimmed);
    if (!result.ok) {
      // Re-wrap error с правильным source и op
      return Err(
        new InvalidRatioError(`Invalid decimal format: "${input}"`, {
          context: {
            source: ErrorSource.PARSING,
            op: 'parse',
            input,
            reason: RatioErrorReason.INVALID_FORMAT,
            cause: result.error.message
          }
        })
      );
    }
    return result;
  }
}
