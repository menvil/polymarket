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
import { Result, Ok, Err, isErr } from '@polymarket/result';
import { InvalidTimestampError, toDecimal, rewrap, wrapOp } from '@polymarket/errors';
import { Timestamp } from '../core/Timestamp.js';
import { TimestampErrorReason } from '../errors/TimestampErrorReason.js';
import type { IClock } from '@polymarket/time';

export class TimestampService {
  private static readonly SERVICE_NAME = 'TimestampService';

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
  public static create(value: number | string | Decimal): Result<Timestamp, InvalidTimestampError> {
    // Безопасный парсинг value через toDecimal
    const decimalResult = toDecimal('value', value, TimestampErrorReason.INVALID_FORMAT, InvalidTimestampError);
    if (isErr(decimalResult)) {
      // raw уже внутри err.context.raw от toDecimal
      return Err(rewrap(TimestampService.SERVICE_NAME, 'create', {}, decimalResult.error, InvalidTimestampError));
    }

    // Truncate до integer
    const decimal = decimalResult.value.trunc();

    return wrapOp(
      TimestampService.SERVICE_NAME,
      'create',
      { raw: { field: 'value', value: String(value) } },
      () => {
        // ВАЖНО: Core получает уже Decimal -> только проверка инвариантов, не парсинг
        const timestamp = Timestamp.of(decimal);
        return Ok(timestamp);
      },
      InvalidTimestampError
    );
  }

  /**
   * Создать Timestamp из epoch milliseconds
   *
   * @param ms - Миллисекунды с Unix epoch (1970-01-01)
   * @returns Result<Timestamp, InvalidTimestampError>
   *
   * @remarks
   * Дробные значения обрезаются до integer.
   * Core проверит что значение конечное, положительное, и integer.
   *
   * @example
   * ```typescript
   * const result = TimestampService.fromEpochMs(1609459200000);
   * if (result.ok) {
   *   console.log(result.value.value().toNumber()); // 1609459200000
   * }
   *
   * // Дробные значения обрезаются
   * const result2 = TimestampService.fromEpochMs(1609459200000.789); // → 1609459200000
   * ```
   */
  public static fromEpochMs(ms: number): Result<Timestamp, InvalidTimestampError> {
    // Безопасный парсинг ms через toDecimal
    const decimalResult = toDecimal('ms', ms, TimestampErrorReason.INVALID_FORMAT, InvalidTimestampError);
    if (isErr(decimalResult)) {
      return Err(rewrap(TimestampService.SERVICE_NAME, 'fromEpochMs', {}, decimalResult.error, InvalidTimestampError));
    }

    // Truncate до integer
    const decimal = decimalResult.value.trunc();

    const ctx = { raw: { field: 'ms', value: String(ms) } };

    return wrapOp(
      TimestampService.SERVICE_NAME,
      'fromEpochMs',
      ctx,
      () => {
        // Core проверит finite, positive, integer
        const timestamp = Timestamp.of(decimal);
        return Ok(timestamp);
      },
      InvalidTimestampError
    );
  }

  /**
   * Создать Timestamp из Date объекта
   *
   * @param date - JavaScript Date
   * @returns Result<Timestamp, InvalidTimestampError>
   *
   * @remarks
   * Извлекает epoch ms через date.getTime() и делегирует в fromEpochMs.
   * Лишняя валидация убрана - fromEpochMs уже проверяет finite и positive.
   *
   * @example
   * ```typescript
   * const result = TimestampService.fromDate(new Date());
   * if (result.ok) {
   *   console.log(result.value.toISO());
   * }
   * ```
   */
  public static fromDate(date: Date): Result<Timestamp, InvalidTimestampError> {
    const ms = date.getTime();
    // Делегируем в fromEpochMs - он проверит finite, positive и сделает truncate
    return this.fromEpochMs(ms);
  }

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
  public static fromISO(iso: string): Result<Timestamp, InvalidTimestampError> {
    const ctx = { raw: { field: 'iso', value: iso } };

    return wrapOp(
      TimestampService.SERVICE_NAME,
      'fromISO',
      ctx,
      () => {
        const ms = Date.parse(iso);

        if (Number.isNaN(ms)) {
          throw new InvalidTimestampError(`Invalid ISO timestamp: ${iso}`, {
            context: {
              field: 'iso',
              value: iso,
              reason: TimestampErrorReason.INVALID_ISO,
            },
          });
        }

        // Используем fromEpochMs для валидации и truncate
        return this.fromEpochMs(ms);
      },
      InvalidTimestampError
    );
  }

  /**
   * Создать Timestamp для текущего момента
   *
   * @param clock - Опциональный источник времени (IClock). Если не указан, использует Date.now()
   * @returns Timestamp текущего времени
   *
   * @remarks
   * Поддерживает dependency injection через IClock для детерминированного времени.
   * Не возвращает Result, т.к. время из clock всегда валидно.
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
  public static now(clock?: IClock): Timestamp {
    return Timestamp.now(clock);
  }

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
  public static addMs(
    timestamp: Timestamp,
    delta: number | Decimal
  ): Result<Timestamp, InvalidTimestampError> {
    // Безопасный парсинг delta через toDecimal
    const deltaResult = toDecimal('delta', delta, TimestampErrorReason.INVALID_FORMAT, InvalidTimestampError);
    if (isErr(deltaResult)) {
      return Err(
        rewrap(TimestampService.SERVICE_NAME, 'addMs', {
          timestamp: timestamp.value().toString(),
          delta: String(delta)
        }, deltaResult.error, InvalidTimestampError)
      );
    }

    // Truncate до integer
    const deltaDecimal = deltaResult.value.trunc();

    const ctx = {
      timestamp: timestamp.value().toString(),
      delta: deltaDecimal.toString()
    };

    return wrapOp(
      TimestampService.SERVICE_NAME,
      'addMs',
      ctx,
      () => {
        // timestamp.addMs() → Timestamp.of() проверит инварианты результата
        return Ok(timestamp.addMs(deltaDecimal));
      },
      InvalidTimestampError
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
