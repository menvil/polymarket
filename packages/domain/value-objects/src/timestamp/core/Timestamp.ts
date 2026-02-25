/**
 * Timestamp Value Object
 *
 * @remarks
 * Представляет момент времени в миллисекундах с Unix epoch (1970-01-01T00:00:00Z).
 *
 * Инварианты:
 * - Должно быть конечное число (finite)
 * - Должно быть положительное (> 0)
 * - Хранится как integer миллисекунды
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
 * import Decimal from 'decimal.js';
 *
 * // Текущее время
 * const now = Timestamp.now();
 *
 * // Из Decimal (internal use)
 * const ts = Timestamp.of(new Decimal(1609459200000));
 *
 * // Доступ к значению
 * const decimal = ts.value();    // Decimal
 * const num = ts.toNumber();     // number (для display)
 *
 * // Сравнение
 * if (ts.isBefore(now)) {
 *   console.log('ts раньше now');
 * }
 *
 * // Арифметика (через TimestampService)
 * const later = TimestampService.addMs(ts, 60000); // +1 минута
 * ```
 */

import Decimal from 'decimal.js';
import { Result, Ok, Err } from '@polymarket/result';
import { ValidationError } from '@polymarket/errors';
import { TimestampErrorReason } from '../errors/TimestampErrorReason.js';
import { TimestampInvariantViolation } from './TimestampInvariantViolation.js';
import { addDecimal, subtractDecimal } from '@polymarket/math/decimal';

/**
 * Timestamp - момент времени в epoch milliseconds
 *
 * @remarks
 * Immutable value object для представления временных меток.
 * Хранит время как Decimal integer миллисекунды с Unix epoch.
 *
 * Внутреннее представление: Decimal (для consistency с другими VOs).
 * Наружу: value() возвращает Decimal, toNumber() возвращает number (lossy).
 */
export class Timestamp {
  /**
   * Приватный конструктор - используйте static фабрики
   *
   * @param _ms - Epoch milliseconds as Decimal (integer)
   */
  private constructor(private readonly _ms: Decimal) {
    // Инвариант 1: Not NaN
    if (_ms.isNaN()) {
      throw new TimestampInvariantViolation(
        'Timestamp cannot be NaN',
        TimestampErrorReason.NOT_FINITE
      );
    }

    // Инвариант 2: Must be finite
    if (!_ms.isFinite()) {
      throw new TimestampInvariantViolation(
        'Timestamp must be finite',
        TimestampErrorReason.NOT_FINITE
      );
    }

    // Инвариант 3: Must be positive
    if (_ms.lessThanOrEqualTo(0)) {
      throw new TimestampInvariantViolation(
        'Timestamp must be positive',
        TimestampErrorReason.NOT_POSITIVE
      );
    }
  }

  /**
   * Создаёт Timestamp из Decimal (ТОЛЬКО для Core!)
   *
   * @internal ТОЛЬКО для внутреннего использования в Core и Facade
   *
   * @remarks
   * НЕ парсит - принимает готовый Decimal.
   * Все проверки инвариантов выполняются в конструкторе.
   * Для публичного API используйте TimestampService.create().
   *
   * Значение обрезается до integer (trunc).
   *
   * @param value - Epoch milliseconds (Decimal)
   * @returns Новый Timestamp
   * @throws {TimestampInvariantViolation} Если значение не соответствует инвариантам
   *
   * @example
   * ```typescript
   * // ✅ В Core и Facade
   * const ts = Timestamp.of(new Decimal(1609459200000));
   *
   * // ❌ В публичном коде - используй TimestampService.create()
   * const result = TimestampService.create(1609459200000);
   * if (!result.ok) {
   *   console.error(result.error);
   * }
   * ```
   */
  public static of(value: Decimal): Timestamp {
    // Обрезаем до integer для timestamp
    const truncated = value.trunc();
    return new Timestamp(truncated);
  }

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
    return Timestamp.of(new Decimal(Date.now()));
  }

  /**
   * Создать Timestamp из epoch milliseconds
   *
   * @param ms - Миллисекунды с Unix epoch (1970-01-01)
   * @returns Result<Timestamp, ValidationError>
   *
   * @remarks
   * Валидирует что ms конечное положительное число.
   * Обрезает до integer.
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

    return Ok(Timestamp.of(new Decimal(ms)));
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
   *   console.log(result.value.value()); // epoch ms as Decimal
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
   *   console.log(result.value.value()); // epoch ms as Decimal
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
   * Возвращает Decimal значение (epoch milliseconds)
   *
   * @returns Epoch milliseconds as Decimal
   *
   * @example
   * ```typescript
   * const ts = Timestamp.now();
   * const decimal = ts.value(); // Decimal
   * console.log(decimal.toString()); // "1705318200000"
   * ```
   */
  public value(): Decimal {
    return this._ms;
  }

  /**
   * Возвращает number значение (epoch milliseconds)
   *
   * @remarks
   * ⚠️ ВНИМАНИЕ: Преобразование в number может привести к потере точности
   * для очень больших timestamp значений (далёкое будущее).
   * Для большинства случаев (даты до ~2286 года) точность сохраняется.
   * Для вычислений используйте value() для получения Decimal.
   *
   * @returns Number значение (может потерять точность для больших значений)
   *
   * @example
   * ```typescript
   * const ts = Timestamp.now();
   * const num = ts.toNumber(); // number для display
   * const decimal = ts.value(); // Decimal для вычислений
   * ```
   */
  public toNumber(): number {
    return this._ms.toNumber();
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
    return new Date(this.toNumber());
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
    return this.toDate().toISOString();
  }

  /**
   * Проверить равенство с другим Timestamp
   *
   * @param other - Другой Timestamp
   * @returns true если моменты времени одинаковые
   *
   * @example
   * ```typescript
   * const ts1 = Timestamp.fromEpochMs(1000).value;
   * const ts2 = Timestamp.fromEpochMs(1000).value;
   * console.log(ts1.equals(ts2)); // true
   * ```
   */
  public equals(other: Timestamp): boolean {
    return this._ms.equals(other._ms);
  }

  /**
   * Проверить что этот момент раньше другого
   *
   * @param other - Другой Timestamp
   * @returns true если this < other
   *
   * @example
   * ```typescript
   * const earlier = Timestamp.fromEpochMs(1000).value;
   * const later = Timestamp.fromEpochMs(2000).value;
   * console.log(earlier.isBefore(later)); // true
   * ```
   */
  public isBefore(other: Timestamp): boolean {
    return this._ms.lessThan(other._ms);
  }

  /**
   * Проверить что этот момент позже другого
   *
   * @param other - Другой Timestamp
   * @returns true если this > other
   *
   * @example
   * ```typescript
   * const earlier = Timestamp.fromEpochMs(1000).value;
   * const later = Timestamp.fromEpochMs(2000).value;
   * console.log(later.isAfter(earlier)); // true
   * ```
   */
  public isAfter(other: Timestamp): boolean {
    return this._ms.greaterThan(other._ms);
  }

  /**
   * Проверить что этот момент не позже другого
   *
   * @param other - Другой Timestamp
   * @returns true если this <= other
   *
   * @example
   * ```typescript
   * const ts1 = Timestamp.fromEpochMs(1000).value;
   * const ts2 = Timestamp.fromEpochMs(2000).value;
   * console.log(ts1.isBeforeOrEqual(ts2)); // true
   * console.log(ts1.isBeforeOrEqual(ts1)); // true
   * ```
   */
  public isBeforeOrEqual(other: Timestamp): boolean {
    return this._ms.lessThanOrEqualTo(other._ms);
  }

  /**
   * Проверить что этот момент не раньше другого
   *
   * @param other - Другой Timestamp
   * @returns true если this >= other
   *
   * @example
   * ```typescript
   * const ts1 = Timestamp.fromEpochMs(2000).value;
   * const ts2 = Timestamp.fromEpochMs(1000).value;
   * console.log(ts1.isAfterOrEqual(ts2)); // true
   * console.log(ts1.isAfterOrEqual(ts1)); // true
   * ```
   */
  public isAfterOrEqual(other: Timestamp): boolean {
    return this._ms.greaterThanOrEqualTo(other._ms);
  }

  /**
   * Добавить миллисекунды к timestamp
   *
   * @param delta - Количество миллисекунд для добавления (может быть отрицательным)
   * @returns Result<Timestamp, ValidationError>
   *
   * @remarks
   * Валидирует что delta конечное и результат положительный.
   * Использует Decimal арифметику из @polymarket/math для точности.
   *
   * @example
   * ```typescript
   * const ts = Timestamp.fromEpochMs(1000).value;
   * const result = ts.addMs(500);
   * if (result.ok) {
   *   console.log(result.value.value().toNumber()); // 1500
   * }
   *
   * // Добавить 1 минуту
   * const later = ts.addMs(60000);
   *
   * // Вычесть время
   * const earlier = ts.addMs(-500);
   * ```
   */
  public addMs(delta: number | Decimal): Result<Timestamp, ValidationError> {
    const deltaDecimal = delta instanceof Decimal ? delta : new Decimal(delta);

    if (deltaDecimal.isNaN() || !deltaDecimal.isFinite()) {
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

    // Используем функцию addDecimal из @polymarket/math для точной арифметики
    const newMs = addDecimal(this._ms, deltaDecimal);

    // Проверяем что результат положительный
    if (newMs.lessThanOrEqualTo(0)) {
      return Err(
        new ValidationError('Resulting timestamp must be positive', {
          context: {
            field: 'result',
            current: this.toNumber(),
            delta: deltaDecimal.toNumber(),
            result: newMs.toNumber(),
            reason: TimestampErrorReason.NOT_POSITIVE,
          },
        })
      );
    }

    return Ok(Timestamp.of(newMs));
  }

  /**
   * Вычислить разницу в миллисекундах с другим Timestamp
   *
   * @param other - Другой Timestamp
   * @returns Разница в ms (this - other) as Decimal
   *
   * @remarks
   * Положительное значение если this позже, отрицательное если раньше.
   * Использует Decimal арифметику для точности.
   *
   * @example
   * ```typescript
   * const ts1 = Timestamp.fromEpochMs(2000).value;
   * const ts2 = Timestamp.fromEpochMs(1000).value;
   * const diff = ts1.diffMs(ts2);
   * console.log(diff.toNumber()); // 1000 (ts1 на 1000ms позже)
   * console.log(ts2.diffMs(ts1).toNumber()); // -1000
   * ```
   */
  public diffMs(other: Timestamp): Decimal {
    return subtractDecimal(this._ms, other._ms);
  }

  /**
   * Вычислить разницу в секундах
   *
   * @param other - Другой Timestamp
   * @returns Разница в секундах (this - other) as Decimal
   *
   * @example
   * ```typescript
   * const ts1 = Timestamp.fromEpochMs(2000).value;
   * const ts2 = Timestamp.fromEpochMs(1000).value;
   * const diff = ts1.diffSeconds(ts2);
   * console.log(diff.toNumber()); // 1
   * ```
   */
  public diffSeconds(other: Timestamp): Decimal {
    const diffMs = this.diffMs(other);
    return diffMs.dividedBy(1000);
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
    return `Timestamp(${this._ms.toString()}, ${this.toISO()})`;
  }
}
