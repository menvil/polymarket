/**
 * Timestamp Value Object
 *
 * @remarks
 * Представляет момент времени в миллисекундах с Unix epoch (1970-01-01T00:00:00Z).
 *
 * Инварианты:
 * - Должно быть конечное число (finite)
 * - Должно быть положительное (> 0)
 * - Хранится как integer (ms обрезаются до целого)
 *
 * Используется для:
 * - Timestamp событий (trades, orders, positions)
 * - Сравнение хронологического порядка
 * - Валидация FIFO/LIFO алгоритмов
 * - Временные метки в блокчейне
 *
 * @example
 * ```typescript
 * import { Timestamp } from '@polymarket/value-objects';
 *
 * // Текущее время
 * const now = Timestamp.now();
 *
 * // Из epoch ms
 * const ts = Timestamp.fromEpochMs(1609459200000);
 *
 * // Из Date
 * const ts2 = Timestamp.fromDate(new Date());
 *
 * // Сравнение
 * if (ts.isBefore(ts2)) {
 *   console.log('ts раньше ts2');
 * }
 *
 * // Арифметика
 * const later = ts.addMs(60000); // +1 минута
 * const diff = ts2.diffMs(ts);   // разница в ms
 * ```
 */

import { Result, Ok, Err } from '@polymarket/result';
import { ValidationError } from '@polymarket/errors';
import { TimestampErrorReason } from '../errors/TimestampErrorReason.js';

/**
 * Timestamp - момент времени в epoch milliseconds
 *
 * @remarks
 * Immutable value object для представления временных меток.
 * Хранит время как integer миллисекунды с Unix epoch.
 */
export class Timestamp {
  /**
   * Приватный конструктор - используйте static фабрики
   *
   * @param _ms - Epoch milliseconds (integer)
   */
  private constructor(private readonly _ms: number) {}

  /**
   * Создать Timestamp для текущего момента
   *
   * @returns Timestamp текущего времени
   *
   * @remarks
   * Использует Date.now() для получения текущего epoch ms.
   *
   * @example
   * ```typescript
   * const now = Timestamp.now();
   * console.log(now.toISO()); // "2024-01-15T10:30:00.000Z"
   * ```
   */
  public static now(): Timestamp {
    return new Timestamp(Date.now());
  }

  /**
   * Создать Timestamp из epoch milliseconds
   *
   * @param ms - Миллисекунды с Unix epoch (1970-01-01)
   * @returns Result<Timestamp, ValidationError>
   *
   * @remarks
   * Валидирует что ms конечное положительное число.
   * Обрезает до integer (Math.trunc).
   *
   * @example
   * ```typescript
   * const result = Timestamp.fromEpochMs(1609459200000);
   * if (result.ok) {
   *   console.log(result.value.toISO()); // "2021-01-01T00:00:00.000Z"
   * }
   *
   * // Невалидные значения
   * Timestamp.fromEpochMs(NaN);      // Err
   * Timestamp.fromEpochMs(Infinity); // Err
   * Timestamp.fromEpochMs(-100);     // Err
   * ```
   */
  public static fromEpochMs(ms: number): Result<Timestamp, ValidationError> {
    if (!Number.isFinite(ms)) {
      return Err(
        new ValidationError('Invalid timestamp: not finite', {
          context: {
            field: 'timestamp',
            value: ms,
            type: typeof ms,
            reason: TimestampErrorReason.NOT_FINITE,
          },
        })
      );
    }

    if (ms <= 0) {
      return Err(
        new ValidationError('Invalid timestamp: must be positive', {
          context: {
            field: 'timestamp',
            value: ms,
            reason: TimestampErrorReason.NOT_POSITIVE,
          },
        })
      );
    }

    return Ok(new Timestamp(Math.trunc(ms)));
  }

  /**
   * Создать Timestamp из Date объекта
   *
   * @param date - JavaScript Date
   * @returns Result<Timestamp, ValidationError>
   *
   * @remarks
   * Извлекает epoch ms через date.getTime() и валидирует.
   *
   * @example
   * ```typescript
   * const result = Timestamp.fromDate(new Date());
   * if (result.ok) {
   *   console.log(result.value.value); // epoch ms
   * }
   *
   * // Невалидный Date
   * Timestamp.fromDate(new Date('invalid')); // Err
   * ```
   */
  public static fromDate(date: Date): Result<Timestamp, ValidationError> {
    const ms = date.getTime();

    if (!Number.isFinite(ms)) {
      return Err(
        new ValidationError('Invalid Date: not finite', {
          context: {
            field: 'date',
            value: date,
            reason: TimestampErrorReason.INVALID_DATE,
          },
        })
      );
    }

    return this.fromEpochMs(ms);
  }

  /**
   * Создать Timestamp из ISO 8601 строки
   *
   * @param iso - ISO строка (например "2024-01-15T10:30:00.000Z")
   * @returns Result<Timestamp, ValidationError>
   *
   * @remarks
   * Парсит через Date.parse() и валидирует результат.
   *
   * @example
   * ```typescript
   * const result = Timestamp.fromISO('2024-01-15T10:30:00.000Z');
   * if (result.ok) {
   *   console.log(result.value.value); // epoch ms
   * }
   *
   * // Невалидная строка
   * Timestamp.fromISO('invalid'); // Err
   * ```
   */
  public static fromISO(iso: string): Result<Timestamp, ValidationError> {
    const ms = Date.parse(iso);

    if (Number.isNaN(ms)) {
      return Err(
        new ValidationError(`Invalid ISO timestamp: ${iso}`, {
          context: {
            field: 'iso',
            value: iso,
            reason: TimestampErrorReason.INVALID_ISO,
          },
        })
      );
    }

    return this.fromEpochMs(ms);
  }

  /**
   * Получить epoch milliseconds
   *
   * @returns Integer миллисекунды с Unix epoch
   *
   * @example
   * ```typescript
   * const ts = Timestamp.now();
   * console.log(ts.value); // 1705318200000
   * ```
   */
  public get value(): number {
    return this._ms;
  }

  /**
   * Преобразовать в JavaScript Date
   *
   * @returns Date объект
   *
   * @example
   * ```typescript
   * const ts = Timestamp.now();
   * const date = ts.toDate();
   * console.log(date.getFullYear()); // 2024
   * ```
   */
  public toDate(): Date {
    return new Date(this._ms);
  }

  /**
   * Преобразовать в ISO 8601 строку
   *
   * @returns ISO строка в UTC ("YYYY-MM-DDTHH:mm:ss.sssZ")
   *
   * @example
   * ```typescript
   * const ts = Timestamp.now();
   * console.log(ts.toISO()); // "2024-01-15T10:30:00.000Z"
   * ```
   */
  public toISO(): string {
    return new Date(this._ms).toISOString();
  }

  /**
   * Проверить равенство с другим Timestamp
   *
   * @param other - Другой Timestamp
   * @returns true если моменты времени одинаковые
   *
   * @example
   * ```typescript
   * const ts1 = Timestamp.fromEpochMs(1000).value!;
   * const ts2 = Timestamp.fromEpochMs(1000).value!;
   * console.log(ts1.equals(ts2)); // true
   * ```
   */
  public equals(other: Timestamp): boolean {
    return this._ms === other._ms;
  }

  /**
   * Проверить что этот момент раньше другого
   *
   * @param other - Другой Timestamp
   * @returns true если this < other
   *
   * @example
   * ```typescript
   * const earlier = Timestamp.fromEpochMs(1000).value!;
   * const later = Timestamp.fromEpochMs(2000).value!;
   * console.log(earlier.isBefore(later)); // true
   * ```
   */
  public isBefore(other: Timestamp): boolean {
    return this._ms < other._ms;
  }

  /**
   * Проверить что этот момент позже другого
   *
   * @param other - Другой Timestamp
   * @returns true если this > other
   *
   * @example
   * ```typescript
   * const earlier = Timestamp.fromEpochMs(1000).value!;
   * const later = Timestamp.fromEpochMs(2000).value!;
   * console.log(later.isAfter(earlier)); // true
   * ```
   */
  public isAfter(other: Timestamp): boolean {
    return this._ms > other._ms;
  }

  /**
   * Проверить что этот момент не позже другого
   *
   * @param other - Другой Timestamp
   * @returns true если this <= other
   *
   * @example
   * ```typescript
   * const ts1 = Timestamp.fromEpochMs(1000).value!;
   * const ts2 = Timestamp.fromEpochMs(2000).value!;
   * console.log(ts1.isBeforeOrEqual(ts2)); // true
   * console.log(ts1.isBeforeOrEqual(ts1)); // true
   * ```
   */
  public isBeforeOrEqual(other: Timestamp): boolean {
    return this._ms <= other._ms;
  }

  /**
   * Проверить что этот момент не раньше другого
   *
   * @param other - Другой Timestamp
   * @returns true если this >= other
   *
   * @example
   * ```typescript
   * const ts1 = Timestamp.fromEpochMs(2000).value!;
   * const ts2 = Timestamp.fromEpochMs(1000).value!;
   * console.log(ts1.isAfterOrEqual(ts2)); // true
   * console.log(ts1.isAfterOrEqual(ts1)); // true
   * ```
   */
  public isAfterOrEqual(other: Timestamp): boolean {
    return this._ms >= other._ms;
  }

  /**
   * Добавить миллисекунды к timestamp
   *
   * @param delta - Количество миллисекунд для добавления (может быть отрицательным)
   * @returns Result<Timestamp, ValidationError>
   *
   * @remarks
   * Валидирует что delta конечное и результат положительный.
   *
   * @example
   * ```typescript
   * const ts = Timestamp.fromEpochMs(1000).value!;
   * const result = ts.addMs(500);
   * if (result.ok) {
   *   console.log(result.value.value); // 1500
   * }
   *
   * // Добавить 1 минуту
   * const later = ts.addMs(60000);
   *
   * // Вычесть время
   * const earlier = ts.addMs(-500);
   * ```
   */
  public addMs(delta: number): Result<Timestamp, ValidationError> {
    if (!Number.isFinite(delta)) {
      return Err(
        new ValidationError('Invalid delta: not finite', {
          context: {
            field: 'delta',
            value: delta,
            reason: TimestampErrorReason.INVALID_DELTA,
          },
        })
      );
    }

    return Timestamp.fromEpochMs(this._ms + delta);
  }

  /**
   * Вычислить разницу в миллисекундах с другим Timestamp
   *
   * @param other - Другой Timestamp
   * @returns Разница в ms (this - other)
   *
   * @remarks
   * Положительное значение если this позже, отрицательное если раньше.
   *
   * @example
   * ```typescript
   * const ts1 = Timestamp.fromEpochMs(2000).value!;
   * const ts2 = Timestamp.fromEpochMs(1000).value!;
   * console.log(ts1.diffMs(ts2)); // 1000 (ts1 на 1000ms позже)
   * console.log(ts2.diffMs(ts1)); // -1000
   * ```
   */
  public diffMs(other: Timestamp): number {
    return this._ms - other._ms;
  }

  /**
   * Вычислить разницу в секундах
   *
   * @param other - Другой Timestamp
   * @returns Разница в секундах (this - other)
   *
   * @example
   * ```typescript
   * const ts1 = Timestamp.fromEpochMs(2000).value!;
   * const ts2 = Timestamp.fromEpochMs(1000).value!;
   * console.log(ts1.diffSeconds(ts2)); // 1
   * ```
   */
  public diffSeconds(other: Timestamp): number {
    return (this._ms - other._ms) / 1000;
  }

  /**
   * Преобразовать в строку для отладки
   *
   * @returns Строка с epoch ms и ISO представлением
   *
   * @example
   * ```typescript
   * const ts = Timestamp.now();
   * console.log(ts.toString());
   * // "Timestamp(1705318200000, 2024-01-15T10:30:00.000Z)"
   * ```
   */
  public toString(): string {
    return `Timestamp(${this._ms}, ${this.toISO()})`;
  }
}
