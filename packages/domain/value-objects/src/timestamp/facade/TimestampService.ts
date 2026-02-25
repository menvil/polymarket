/**
 * Фасад для работы с Timestamp - публичный API
 *
 * @remarks
 * Единая точка входа для создания Timestamp.
 * Принимает number, string, или Decimal и конвертирует в Timestamp.
 * Делегирует в Core с добавлением wrapOp для error context.
 *
 * **Контракт "Never Throw":**
 * ВСЕ методы TimestampService ГАРАНТИРОВАННО возвращают Result и НИКОГДА не бросают исключения.
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
import { Result, Ok } from '@polymarket/result';
import { ValidationError, wrapOp } from '@polymarket/errors';
import { Timestamp } from '../core/Timestamp.js';
import { TimestampErrorReason } from '../errors/TimestampErrorReason.js';

export class TimestampService {
  private static readonly SERVICE_NAME = 'TimestampService';

  /**
   * Универсальная фабрика для создания Timestamp
   *
   * @param value - Epoch milliseconds (number, string, или Decimal)
   * @returns Result<Timestamp, ValidationError>
   *
   * @remarks
   * Принимает number, string, или Decimal и конвертирует в Timestamp.
   * Валидирует инварианты (finite, positive).
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
   * if (ts1.ok) {
   *   console.log(ts1.value.toISO());
   * }
   * ```
   */
  public static create(value: number | string | Decimal): Result<Timestamp, ValidationError> {
    return wrapOp(
      TimestampService.SERVICE_NAME,
      'create',
      { value: String(value) },
      () => {
        let decimal: Decimal;

        if (value instanceof Decimal) {
          decimal = value;
        } else if (typeof value === 'string') {
          try {
            decimal = new Decimal(value);
          } catch (error) {
            throw new ValidationError(`Invalid timestamp string: ${value}`, {
              context: {
                field: 'value',
                value,
                reason: TimestampErrorReason.INVALID_ISO,
              },
            });
          }
        } else if (typeof value === 'number') {
          if (!Number.isFinite(value)) {
            throw new ValidationError('Invalid timestamp: not finite', {
              context: {
                field: 'value',
                value,
                reason: TimestampErrorReason.NOT_FINITE,
              },
            });
          }
          decimal = new Decimal(value);
        } else {
          throw new ValidationError(`Invalid timestamp type: ${typeof value}`, {
            context: {
              field: 'value',
              value,
              reason: TimestampErrorReason.NOT_FINITE,
            },
          });
        }

        // Timestamp.of() бросит TimestampInvariantViolation если невалидно
        return Ok(Timestamp.of(decimal));
      },
      ValidationError
    );
  }

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
   *   console.log(result.value.value().toNumber()); // 1609459200000
   * }
   * ```
   */
  public static fromEpochMs(ms: number): Result<Timestamp, ValidationError> {
    return wrapOp(
      TimestampService.SERVICE_NAME,
      'fromEpochMs',
      { value: ms },
      () => {
        const result = Timestamp.fromEpochMs(ms);
        if (!result.ok) {
          throw result.error;
        }
        return Ok(result.value);
      },
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
      () => {
        const result = Timestamp.fromDate(date);
        if (!result.ok) {
          throw result.error;
        }
        return Ok(result.value);
      },
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
   *   console.log(result.value.value());
   * }
   * ```
   */
  public static fromISO(iso: string): Result<Timestamp, ValidationError> {
    return wrapOp(
      TimestampService.SERVICE_NAME,
      'fromISO',
      { value: iso },
      () => {
        const result = Timestamp.fromISO(iso);
        if (!result.ok) {
          throw result.error;
        }
        return Ok(result.value);
      },
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
    delta: number | Decimal
  ): Result<Timestamp, ValidationError> {
    return wrapOp(
      TimestampService.SERVICE_NAME,
      'addMs',
      { timestamp: timestamp.toNumber(), delta: typeof delta === 'number' ? delta : delta.toNumber() },
      () => timestamp.addMs(delta),
      ValidationError
    );
  }

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
  public static diffMs(ts1: Timestamp, ts2: Timestamp): Decimal {
    return ts1.diffMs(ts2);
  }

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
  public static diffSeconds(ts1: Timestamp, ts2: Timestamp): Decimal {
    return ts1.diffSeconds(ts2);
  }
}
