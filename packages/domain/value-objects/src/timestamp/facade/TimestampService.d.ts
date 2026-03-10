/**
 * Фасад для работы с Timestamp - публичный API
 *
 * @remarks
 * Единая точка входа для создания Timestamp.
 * Принимает number, string, или Decimal и конвертирует в Timestamp.
 * Делегирует в Core с добавлением wrapOp для error context.
 *
 * **Контракт "Never Throw":**
 * Фабричные методы (create, fromDate, fromISO, addMs) возвращают Result и НИКОГДА не бросают исключения.
 * Утилитные методы (now, diffMs, diffSeconds) возвращают значения напрямую.
 *
 * @example
 * ```typescript
 * import { TimestampService } from '@polymarket/value-objects';
 * import Decimal from 'decimal.js';
 *
 * // Из number
 * const result1 = TimestampService.create(1609459200000);
 *
 * // Из string
 * const result2 = TimestampService.create('1609459200000');
 *
 * // Из Decimal
 * const result3 = TimestampService.create(new Decimal(1609459200000));
 *
 * if (result1.ok) {
 *   console.log(result1.value.toISO()); // "2021-01-01T00:00:00.000Z"
 *   console.log(result1.value.value()); // Decimal
 *   console.log(result1.value.toNumber()); // number
 * }
 * ```
 */
import Decimal from 'decimal.js';
import { Result } from '@polymarket/result';
import { InvalidTimestampError } from '@polymarket/errors';
import { Timestamp } from '../core/Timestamp.js';
import type { IClock } from '@polymarket/time';
export declare class TimestampService {
    private static readonly SERVICE_NAME;
    /**
     * Универсальная фабрика для создания Timestamp
     *
     * @param value - Epoch milliseconds (number, string, или Decimal)
     * @returns Result<Timestamp, InvalidTimestampError>
     *
     * @remarks
     * Принимает number, string, или Decimal и конвертирует в Timestamp.
     * Валидирует инварианты (finite, positive, integer).
     * Дробные значения обрезаются до integer.
     *
     * @example
     * ```typescript
     * // Из number
     * const ts1 = TimestampService.create(1609459200000);
     *
     * // Из string
     * const ts2 = TimestampService.create('1609459200000');
     *
     * // Из Decimal
     * const ts3 = TimestampService.create(new Decimal(1609459200000));
     *
     * // Дробные значения обрезаются
     * const ts4 = TimestampService.create(1609459200000.789); // OK, станет 1609459200000
     *
     * if (ts1.ok) {
     *   console.log(ts1.value.toISO());
     * }
     * ```
     */
    static create(value: number | string | Decimal): Result<Timestamp, InvalidTimestampError>;
    /**
     * Создать Timestamp из Date объекта
     *
     * @param date - JavaScript Date
     * @returns Result<Timestamp, InvalidTimestampError>
     *
     * @remarks
     * Извлекает epoch ms через date.getTime() и делегирует в create().
     * create() уже проверяет finite, positive и делает truncate.
     *
     * @example
     * ```typescript
     * const result = TimestampService.fromDate(new Date());
     * if (result.ok) {
     *   console.log(result.value.toISO());
     * }
     * ```
     */
    static fromDate(date: Date): Result<Timestamp, InvalidTimestampError>;
    /**
     * Создать Timestamp из ISO 8601 строки
     *
     * @param iso - ISO строка (например "2024-01-15T10:30:00.000Z")
     * @returns Result<Timestamp, InvalidTimestampError>
     *
     * @example
     * ```typescript
     * const result = TimestampService.fromISO('2024-01-15T10:30:00.000Z');
     * if (result.ok) {
     *   console.log(result.value.value());
     * }
     * ```
     */
    static fromISO(iso: string): Result<Timestamp, InvalidTimestampError>;
    /**
     * Создать Timestamp для текущего момента
     *
     * @param clock - Опциональный источник времени (IClock). Если не указан, использует Date.now()
     * @returns Timestamp текущего времени
     *
     * @remarks
     * Поддерживает dependency injection через IClock для детерминированного времени.
     *
     * **Fallback поведение (Never Throw):**
     * 1. Если clock бросает исключение → fallback на `Date.now()`.
     * 2. Если `Date.now()` также невалиден → fallback на epoch 1ms.
     * Broken IClock implementations fail silently — monitor clock health externally.
     *
     * @example
     * ```typescript
     * // Реальное системное время (default)
     * const now = TimestampService.now();
     * console.log(now.toISO());
     *
     * // С LiveClock (явно)
     * const liveClock = new LiveClock();
     * const now2 = TimestampService.now(liveClock);
     *
     * // С PaperClock для тестирования
     * const paperClock = new PaperClock(new Date('2024-01-01'));
     * const now3 = TimestampService.now(paperClock); // Фиксированное время
     * ```
     */
    static now(clock?: IClock): Timestamp;
    /**
     * Добавить миллисекунды к timestamp
     *
     * @param timestamp - Исходный Timestamp
     * @param delta - Количество миллисекунд для добавления (может быть отрицательным)
     * @returns Result<Timestamp, InvalidTimestampError>
     *
     * @remarks
     * Принимает number или Decimal. Number конвертируется в Decimal с truncate.
     *
     * @example
     * ```typescript
     * const ts = TimestampService.now();
     * const result = TimestampService.addMs(ts, 60000); // +1 минута
     * if (result.ok) {
     *   console.log(result.value.toISO());
     * }
     * ```
     */
    static addMs(timestamp: Timestamp, delta: number | Decimal): Result<Timestamp, InvalidTimestampError>;
    /**
     * Вычислить разницу в миллисекундах между двумя timestamps
     *
     * @param ts1 - Первый Timestamp
     * @param ts2 - Второй Timestamp
     * @returns Разница в ms (ts1 - ts2) as Decimal
     *
     * @remarks
     * Не возвращает Result, т.к. операция не может fail для валидных Timestamp.
     * Возвращает Decimal для точности.
     *
     * @example
     * ```typescript
     * const diff = TimestampService.diffMs(ts1, ts2);
     * console.log(`Difference: ${diff.toNumber()}ms`);
     * ```
     */
    static diffMs(ts1: Timestamp, ts2: Timestamp): Decimal;
    /**
     * Вычислить разницу в секундах между двумя timestamps
     *
     * @param ts1 - Первый Timestamp
     * @param ts2 - Второй Timestamp
     * @returns Разница в секундах (ts1 - ts2) as Decimal
     *
     * @example
     * ```typescript
     * const diff = TimestampService.diffSeconds(ts1, ts2);
     * console.log(`Difference: ${diff.toNumber()}s`);
     * ```
     */
    static diffSeconds(ts1: Timestamp, ts2: Timestamp): Decimal;
}
//# sourceMappingURL=TimestampService.d.ts.map