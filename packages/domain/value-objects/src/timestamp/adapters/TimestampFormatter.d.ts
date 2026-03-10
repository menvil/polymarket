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
 * TimestampFormatter.toDisplay(ts);    // "2024-01-15 10:30:00 UTC"
 * TimestampFormatter.toDate(ts);       // "2024-01-15"
 * TimestampFormatter.toTime(ts);       // "10:30:00"
 * TimestampFormatter.toRelative(ts);   // "2 minutes ago"
 * ```
 */
import { Timestamp } from '../core/Timestamp.js';
export declare class TimestampFormatter {
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
    static toISO(timestamp: Timestamp): string;
    /**
     * Форматировать для отображения (без миллисекунд, с явным указанием UTC)
     *
     * @param timestamp - Timestamp для форматирования
     * @returns Строка вида "YYYY-MM-DD HH:mm:ss UTC"
     *
     * @remarks
     * Явно указывает timezone (UTC), чтобы не вводить в заблуждение.
     * Timestamp всегда хранится в UTC, поэтому важно это отображать.
     *
     * @example
     * ```typescript
     * const ts = Timestamp.now();
     * console.log(TimestampFormatter.toDisplay(ts));
     * // "2024-01-15 10:30:00 UTC"
     * ```
     */
    static toDisplay(timestamp: Timestamp): string;
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
    static toDate(timestamp: Timestamp): string;
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
    static toTime(timestamp: Timestamp): string;
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
    static toEpochMs(timestamp: Timestamp): string;
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
     * const past = unwrap(TimestampService.create(Date.now() - 120000));
     * console.log(TimestampFormatter.toRelative(past));
     * // "2 minutes ago"
     *
     * const future = unwrap(TimestampService.create(Date.now() + 30000));
     * console.log(TimestampFormatter.toRelative(future));
     * // "in 30 seconds"
     * ```
     */
    static toRelative(timestamp: Timestamp, now?: Timestamp): string;
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
    static toLogString(timestamp: Timestamp): string;
    /**
     * Преобразовать в строку для отладки
     *
     * @param timestamp - Timestamp для форматирования
     * @returns Строка с epoch ms и ISO представлением
     *
     * @example
     * ```typescript
     * const ts = Timestamp.now();
     * console.log(TimestampFormatter.toString(ts));
     * // "Timestamp(1705318200000, 2024-01-15T10:30:00.000Z)"
     * ```
     */
    static toString(timestamp: Timestamp): string;
}
//# sourceMappingURL=TimestampFormatter.d.ts.map