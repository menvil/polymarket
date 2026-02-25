/**
 * Фасад для работы с Timestamp - публичный API
 *
 * @remarks
 * Единая точка входа для создания Timestamp.
 * Делегирует в Core с добавлением wrapOp для error context.
 *
 * **Контракт "Never Throw":**
 * ВСЕ методы TimestampService ГАРАНТИРОВАННО возвращают Result и НИКОГДА не бросают исключения.
 *
 * @example
 * ```typescript
 * import { TimestampService } from '@polymarket/value-objects';
 *
 * const result = TimestampService.fromEpochMs(1609459200000);
 * if (result.ok) {
 *   console.log(result.value.toISO()); // "2021-01-01T00:00:00.000Z"
 * }
 * ```
 */

import { Result } from '@polymarket/result';
import { ValidationError, wrapOp } from '@polymarket/errors';
import { Timestamp } from '../core/Timestamp.js';

export class TimestampService {
  private static readonly SERVICE_NAME = 'TimestampService';

  /**
   * Создать Timestamp из epoch milliseconds
   *
   * @param ms - Миллисекунды с Unix epoch (1970-01-01)
   * @returns Result<Timestamp, ValidationError>
   *
   * @remarks
   * Валидирует что ms конечное положительное число.
   * Добавляет wrapOp для error context.
   *
   * @example
   * ```typescript
   * const result = TimestampService.fromEpochMs(1609459200000);
   * if (result.ok) {
   *   console.log(result.value.value); // 1609459200000
   * }
   * ```
   */
  public static fromEpochMs(ms: number): Result<Timestamp, ValidationError> {
    return wrapOp(
      TimestampService.SERVICE_NAME,
      'fromEpochMs',
      { value: ms },
      () => Timestamp.fromEpochMs(ms),
      ValidationError
    );
  }

  /**
   * Создать Timestamp из Date объекта
   *
   * @param date - JavaScript Date
   * @returns Result<Timestamp, ValidationError>
   *
   * @example
   * ```typescript
   * const result = TimestampService.fromDate(new Date());
   * if (result.ok) {
   *   console.log(result.value.toISO());
   * }
   * ```
   */
  public static fromDate(date: Date): Result<Timestamp, ValidationError> {
    return wrapOp(
      TimestampService.SERVICE_NAME,
      'fromDate',
      { date: String(date) },
      () => Timestamp.fromDate(date),
      ValidationError
    );
  }

  /**
   * Создать Timestamp из ISO 8601 строки
   *
   * @param iso - ISO строка (например "2024-01-15T10:30:00.000Z")
   * @returns Result<Timestamp, ValidationError>
   *
   * @example
   * ```typescript
   * const result = TimestampService.fromISO('2024-01-15T10:30:00.000Z');
   * if (result.ok) {
   *   console.log(result.value.value);
   * }
   * ```
   */
  public static fromISO(iso: string): Result<Timestamp, ValidationError> {
    return wrapOp(
      TimestampService.SERVICE_NAME,
      'fromISO',
      { value: iso },
      () => Timestamp.fromISO(iso),
      ValidationError
    );
  }

  /**
   * Создать Timestamp для текущего момента
   *
   * @returns Timestamp текущего времени
   *
   * @remarks
   * Не возвращает Result, т.к. Date.now() всегда валиден.
   *
   * @example
   * ```typescript
   * const now = TimestampService.now();
   * console.log(now.toISO());
   * ```
   */
  public static now(): Timestamp {
    return Timestamp.now();
  }

  /**
   * Добавить миллисекунды к timestamp
   *
   * @param timestamp - Исходный Timestamp
   * @param delta - Количество миллисекунд для добавления (может быть отрицательным)
   * @returns Result<Timestamp, ValidationError>
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
  public static addMs(
    timestamp: Timestamp,
    delta: number
  ): Result<Timestamp, ValidationError> {
    return wrapOp(
      TimestampService.SERVICE_NAME,
      'addMs',
      { timestamp: timestamp.value, delta },
      () => timestamp.addMs(delta),
      ValidationError
    );
  }

  /**
   * Вычислить разницу в миллисекундах между двумя timestamps
   *
   * @param ts1 - Первый Timestamp
   * @param ts2 - Второй Timestamp
   * @returns Разница в ms (ts1 - ts2)
   *
   * @remarks
   * Не возвращает Result, т.к. операция не может fail для валидных Timestamp.
   *
   * @example
   * ```typescript
   * const diff = TimestampService.diffMs(ts1, ts2);
   * console.log(`Difference: ${diff}ms`);
   * ```
   */
  public static diffMs(ts1: Timestamp, ts2: Timestamp): number {
    return ts1.diffMs(ts2);
  }

  /**
   * Вычислить разницу в секундах между двумя timestamps
   *
   * @param ts1 - Первый Timestamp
   * @param ts2 - Второй Timestamp
   * @returns Разница в секундах (ts1 - ts2)
   *
   * @example
   * ```typescript
   * const diff = TimestampService.diffSeconds(ts1, ts2);
   * console.log(`Difference: ${diff}s`);
   * ```
   */
  public static diffSeconds(ts1: Timestamp, ts2: Timestamp): number {
    return ts1.diffSeconds(ts2);
  }
}
