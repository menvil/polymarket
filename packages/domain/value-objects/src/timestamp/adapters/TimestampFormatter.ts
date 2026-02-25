/**
 * Formatter для Timestamp
 *
 * @remarks
 * Форматирует Timestamp для отображения в UI.
 *
 * @example
 * ```typescript
 * import { TimestampFormatter } from '@polymarket/value-objects';
 *
 * const ts = Timestamp.now();
 *
 * TimestampFormatter.toISO(ts);        // "2024-01-15T10:30:00.000Z"
 * TimestampFormatter.toDisplay(ts);    // "2024-01-15 10:30:00"
 * TimestampFormatter.toDate(ts);       // "2024-01-15"
 * TimestampFormatter.toTime(ts);       // "10:30:00"
 * TimestampFormatter.toRelative(ts);   // "2 minutes ago"
 * ```
 */

import { Timestamp } from '../core/Timestamp.js';

export class TimestampFormatter {
  /**
   * Форматировать как ISO 8601 строку
   *
   * @param timestamp - Timestamp для форматирования
   * @returns ISO строка в UTC ("YYYY-MM-DDTHH:mm:ss.sssZ")
   *
   * @example
   * ```typescript
   * const ts = Timestamp.now();
   * console.log(TimestampFormatter.toISO(ts));
   * // "2024-01-15T10:30:00.000Z"
   * ```
   */
  public static toISO(timestamp: Timestamp): string {
    return timestamp.toISO();
  }

  /**
   * Форматировать для отображения (без миллисекунд, пробел вместо T)
   *
   * @param timestamp - Timestamp для форматирования
   * @returns Строка вида "YYYY-MM-DD HH:mm:ss"
   *
   * @example
   * ```typescript
   * const ts = Timestamp.now();
   * console.log(TimestampFormatter.toDisplay(ts));
   * // "2024-01-15 10:30:00"
   * ```
   */
  public static toDisplay(timestamp: Timestamp): string {
    const iso = timestamp.toISO();
    // Убираем миллисекунды и Z, заменяем T на пробел
    return iso.slice(0, 19).replace('T', ' ');
  }

  /**
   * Форматировать только дату (без времени)
   *
   * @param timestamp - Timestamp для форматирования
   * @returns Строка вида "YYYY-MM-DD"
   *
   * @example
   * ```typescript
   * const ts = Timestamp.now();
   * console.log(TimestampFormatter.toDate(ts));
   * // "2024-01-15"
   * ```
   */
  public static toDate(timestamp: Timestamp): string {
    return timestamp.toISO().slice(0, 10);
  }

  /**
   * Форматировать только время (без даты)
   *
   * @param timestamp - Timestamp для форматирования
   * @returns Строка вида "HH:mm:ss"
   *
   * @example
   * ```typescript
   * const ts = Timestamp.now();
   * console.log(TimestampFormatter.toTime(ts));
   * // "10:30:00"
   * ```
   */
  public static toTime(timestamp: Timestamp): string {
    return timestamp.toISO().slice(11, 19);
  }

  /**
   * Форматировать как epoch milliseconds строка
   *
   * @param timestamp - Timestamp для форматирования
   * @returns Строка с epoch ms
   *
   * @example
   * ```typescript
   * const ts = Timestamp.now();
   * console.log(TimestampFormatter.toEpochMs(ts));
   * // "1705318200000"
   * ```
   */
  public static toEpochMs(timestamp: Timestamp): string {
    return String(timestamp.value);
  }

  /**
   * Форматировать как относительное время ("X ago" / "in X")
   *
   * @param timestamp - Timestamp для форматирования
   * @param now - Текущее время (по умолчанию Timestamp.now())
   * @returns Строка вида "2 minutes ago" или "in 5 seconds"
   *
   * @remarks
   * Использует следующую логику:
   * - < 1 минуты: "X seconds ago"
   * - < 1 часа: "X minutes ago"
   * - < 1 дня: "X hours ago"
   * - >= 1 дня: "X days ago"
   *
   * @example
   * ```typescript
   * const past = Timestamp.fromEpochMs(Date.now() - 120000).value!;
   * console.log(TimestampFormatter.toRelative(past));
   * // "2 minutes ago"
   *
   * const future = Timestamp.fromEpochMs(Date.now() + 30000).value!;
   * console.log(TimestampFormatter.toRelative(future));
   * // "in 30 seconds"
   * ```
   */
  public static toRelative(timestamp: Timestamp, now: Timestamp = Timestamp.now()): string {
    const diffMs = now.diffMs(timestamp);
    const isPast = diffMs > 0;
    const absDiffMs = Math.abs(diffMs);

    // Конвертируем в разные единицы времени
    const seconds = Math.floor(absDiffMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    let timeStr: string;

    if (days > 0) {
      timeStr = `${days} ${days === 1 ? 'day' : 'days'}`;
    } else if (hours > 0) {
      timeStr = `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
    } else if (minutes > 0) {
      timeStr = `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
    } else {
      timeStr = `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
    }

    return isPast ? `${timeStr} ago` : `in ${timeStr}`;
  }

  /**
   * Форматировать для логирования (ISO + epoch ms)
   *
   * @param timestamp - Timestamp для форматирования
   * @returns Строка вида "2024-01-15T10:30:00.000Z (1705318200000)"
   *
   * @example
   * ```typescript
   * const ts = Timestamp.now();
   * console.log(TimestampFormatter.toLogString(ts));
   * // "2024-01-15T10:30:00.000Z (1705318200000)"
   * ```
   */
  public static toLogString(timestamp: Timestamp): string {
    return `${timestamp.toISO()} (${timestamp.value})`;
  }
}
