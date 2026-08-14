/**
 * Timestamp Value Object
 *
 * @remarks
 * Представляет момент времени в миллисекундах с Unix epoch (1970-01-01T00:00:00Z).
 *
 * Инварианты:
 * - `isFinite` - не NaN и не Infinity
 * - `isInteger` - целое число миллисекунд (дробные значения не допускаются)
 * - `>= 0` - неотрицательный Unix timestamp (0 = 1970-01-01T00:00:00Z)
 * - `<= 9999999999999` - разумный верхний предел (~год 2286)
 *
 * Используется для:
 * - Timestamp событий (trades, orders, positions)
 * - Сравнение хронологического порядка
 * - Валидация FIFO/LIFO алгоритмов
 * - Временные метки в блокчейне
 *
 * @example
 * ```typescript
 * import { Timestamp } from '@polymarket/timestamp';
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
 * ```
 */

import Decimal from 'decimal.js';
import { TimestampErrorReason } from '../errors/TimestampErrorReason.js';
import { TimestampInvariantViolation } from './TimestampInvariantViolation.js';
import { addDecimal, subtractDecimal, divideDecimal } from '@polymarket/math';
import type { IClock } from '@polymarket/time';

/**
 * Timestamp - момент времени в epoch milliseconds
 *
 * @remarks
 * Immutable value object для представления временных меток.
 * Хранит время как Decimal integer миллисекунды с Unix epoch.
 *
 * Внутреннее представление: Decimal (для consistency с другими VOs).
 * Наружу: value() возвращает Decimal, toNumber() возвращает number (lossy).
 *
 * Core содержит ТОЛЬКО:
 * - of(Decimal) — создание из валидированного Decimal
 * - now() — convenience для текущего времени
 * - Instance методы (value, comparisons, arithmetic)
 *
 * Для создания из number/string используйте TimestampService.
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

    // Инвариант 3: Must be non-negative (>= 0)
    if (_ms.lessThan(0)) {
      throw new TimestampInvariantViolation(
        `Timestamp must be non-negative, got: ${_ms.toString()}`,
        TimestampErrorReason.NEGATIVE
      );
    }

    // Инвариант 4: Must be within reasonable bounds (<= 9999999999999, ~year 2286)
    const MAX_TIMESTAMP = new Decimal(9999999999999);
    if (_ms.greaterThan(MAX_TIMESTAMP)) {
      throw new TimestampInvariantViolation(
        `Timestamp too large (must be <= ${MAX_TIMESTAMP.toString()}), got: ${_ms.toString()}`,
        TimestampErrorReason.OUT_OF_RANGE
      );
    }

    // Инвариант 5: Must be integer
    if (!_ms.isInteger()) {
      throw new TimestampInvariantViolation(
        `Timestamp must be integer milliseconds, got: ${_ms.toString()}`,
        TimestampErrorReason.NOT_INTEGER
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
   * ВАЖНО: Timestamp должен быть integer миллисекундами.
   * Дробные значения не допускаются (бросит TimestampInvariantViolation).
   *
   * @param value - Epoch milliseconds (Decimal integer)
   * @returns Новый Timestamp
   * @throws {TimestampInvariantViolation} Если значение не соответствует инвариантам
   *
   * @example
   * ```typescript
   * // ✅ В Core и Facade
   * const ts = Timestamp.of(new Decimal(1609459200000));
   *
   * // ❌ Дробные миллисекунды - ошибка
   * const ts = Timestamp.of(new Decimal(1609459200000.123)); // throws
   *
   * // ❌ В публичном коде - используй TimestampService.create()
   * const result = TimestampService.create(1609459200000);
   * if (!result.ok) {
   *   console.error(result.error);
   * }
   * ```
   */
  public static of(value: Decimal): Timestamp {
    return new Timestamp(value);
  }

  /**
   * Создать Timestamp для текущего момента
   *
   * @param clock - Опциональный источник времени (IClock). Если не указан, использует Date.now()
   * @returns Timestamp текущего времени
   *
   * @remarks
   * Поддерживает dependency injection через IClock для детерминированного времени.
   * Если clock не указан, использует Date.now() (реальное системное время).
   * Не возвращает Result т.к. время из clock всегда валидно.
   *
   * @example
   * ```typescript
   * // Реальное системное время (default)
   * const now = Timestamp.now();
   * console.log(now.toISO()); // "2024-01-15T10:30:00.000Z"
   *
   * // С IClock для детерминизма
   * const liveClock = new LiveClock();
   * const now2 = Timestamp.now(liveClock);
   *
   * // С PaperClock для тестирования
   * const paperClock = new PaperClock(new Date('2024-01-01'));
   * const now3 = Timestamp.now(paperClock); // Фиксированное время
   * ```
   */
  public static now(clock?: IClock): Timestamp {
    const nowMs = clock
      ? new Decimal(clock.now().getTime())
      : new Decimal(Date.now());
    return Timestamp.of(nowMs);
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
   * const ts1 = Timestamp.of(new Decimal(1000));
   * const ts2 = Timestamp.of(new Decimal(1000));
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
   * const earlier = Timestamp.of(new Decimal(1000));
   * const later = Timestamp.of(new Decimal(2000));
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
   * const earlier = Timestamp.of(new Decimal(1000));
   * const later = Timestamp.of(new Decimal(2000));
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
   * const ts1 = Timestamp.of(new Decimal(1000));
   * const ts2 = Timestamp.of(new Decimal(2000));
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
   * const ts1 = Timestamp.of(new Decimal(2000));
   * const ts2 = Timestamp.of(new Decimal(1000));
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
   * @param delta - Количество миллисекунд для добавления (Decimal integer, может быть отрицательным)
   * @returns Новый Timestamp
   * @throws {TimestampInvariantViolation} Если delta не integer или результат невалиден
   *
   * @remarks
   * Использует Decimal арифметику из @polymarket/math для точности.
   * Бросает исключение если:
   * - delta не является integer (дробные миллисекунды не допускаются)
   * - результат не соответствует инвариантам (отрицательный или не integer)
   *
   * Для публичного API используйте TimestampService.addMs() который возвращает Result.
   *
   * @example
   * ```typescript
   * const ts = Timestamp.of(new Decimal(1000));
   * const later = ts.addMs(new Decimal(500));
   * console.log(later.value().toNumber()); // 1500
   *
   * // Вычесть время
   * const earlier = ts.addMs(new Decimal(-500));
   * console.log(earlier.value().toNumber()); // 500
   *
   * // ❌ Дробные миллисекунды - ошибка
   * const invalid = ts.addMs(new Decimal(0.5)); // throws TimestampInvariantViolation
   * ```
   */
  public addMs(delta: Decimal): Timestamp {
    // Проверка: delta должен быть integer (дробные миллисекунды не допускаются)
    if (!delta.isInteger()) {
      throw new TimestampInvariantViolation(
        `Delta must be integer milliseconds, got: ${delta.toString()}`,
        TimestampErrorReason.NOT_INTEGER
      );
    }

    // Используем функцию addDecimal из @polymarket/math для точной арифметики
    const newMs = addDecimal(this._ms, delta);

    // Timestamp.of() проверит инварианты (positive, integer)
    return Timestamp.of(newMs);
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
   * const ts1 = Timestamp.of(new Decimal(2000));
   * const ts2 = Timestamp.of(new Decimal(1000));
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
   * const ts1 = Timestamp.of(new Decimal(2000));
   * const ts2 = Timestamp.of(new Decimal(1000));
   * const diff = ts1.diffSeconds(ts2);
   * console.log(diff.toNumber()); // 1
   * ```
   */
  public diffSeconds(other: Timestamp): Decimal {
    const diffMs = this.diffMs(other);
    return divideDecimal(diffMs, new Decimal(1000));
  }

}
