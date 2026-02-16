/**
 * EXAMPLE: Парсинг и валидация дат с использованием Result pattern
 *
 * @remarks
 * Этот файл показывает КАК использовать Result, если понадобится
 * добавить функции парсинга/валидации в модуль time.
 *
 * Сейчас это просто пример, НЕ часть основного API.
 */

import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';

/**
 * Ошибка парсинга даты
 */
export class DateParseError extends Error {
  constructor(
    public readonly input: string,
    message: string
  ) {
    super(message);
    this.name = 'DateParseError';
  }
}

/**
 * Ошибка валидации временной метки
 */
export class TimestampValidationError extends Error {
  constructor(
    public readonly timestamp: number,
    message: string
  ) {
    super(message);
    this.name = 'TimestampValidationError';
  }
}

/**
 * Парсинг ISO строки в Date
 *
 * @param isoString - ISO 8601 строка
 * @returns Result с датой или ошибкой парсинга
 *
 * @remarks
 * Используйте эту функцию когда парсите пользовательский ввод
 * или данные из внешних источников.
 *
 * @example
 * ```typescript
 * const result = parseISODate('2024-01-01T00:00:00Z');
 *
 * if (result.ok) {
 *   const clock = new PaperClock(result.value);
 * } else {
 *   console.error('Parse error:', result.error.message);
 * }
 * ```
 */
export function parseISODate(
  isoString: string
): Result<Date, DateParseError> {
  const trimmed = isoString.trim();

  if (trimmed === '') {
    return Err(new DateParseError(isoString, 'Empty date string'));
  }

  const date = new Date(trimmed);

  if (isNaN(date.getTime())) {
    return Err(
      new DateParseError(isoString, `Invalid ISO date: ${isoString}`)
    );
  }

  return Ok(date);
}

/**
 * Создание Date из Unix timestamp с валидацией
 *
 * @param milliseconds - Миллисекунды с Unix epoch
 * @returns Result с датой или ошибкой валидации
 *
 * @remarks
 * Валидирует что timestamp находится в разумном диапазоне:
 * - Не раньше 1970-01-01 (epoch)
 * - Не позже 2100-01-01
 *
 * @example
 * ```typescript
 * const result = fromUnixTimestamp(1609459200000);
 *
 * if (result.ok) {
 *   console.log('Date:', result.value.toISOString());
 * } else {
 *   console.error('Validation error:', result.error.message);
 * }
 * ```
 */
export function fromUnixTimestamp(
  milliseconds: number
): Result<Date, TimestampValidationError> {
  const MIN_TIMESTAMP = 0; // 1970-01-01
  const MAX_TIMESTAMP = 4102444800000; // 2100-01-01

  if (!Number.isFinite(milliseconds)) {
    return Err(
      new TimestampValidationError(
        milliseconds,
        'Timestamp must be a finite number'
      )
    );
  }

  if (milliseconds < MIN_TIMESTAMP) {
    return Err(
      new TimestampValidationError(
        milliseconds,
        `Timestamp ${milliseconds} is before Unix epoch (1970-01-01)`
      )
    );
  }

  if (milliseconds > MAX_TIMESTAMP) {
    return Err(
      new TimestampValidationError(
        milliseconds,
        `Timestamp ${milliseconds} is after year 2100`
      )
    );
  }

  return Ok(new Date(milliseconds));
}

/**
 * Валидация что дата находится в диапазоне
 *
 * @param date - Дата для проверки
 * @param min - Минимальная допустимая дата
 * @param max - Максимальная допустимая дата
 * @returns Result с датой или ошибкой
 *
 * @example
 * ```typescript
 * const result = validateDateRange(
 *   new Date('2024-06-15'),
 *   new Date('2024-01-01'),
 *   new Date('2024-12-31')
 * );
 *
 * if (result.ok) {
 *   // Дата в диапазоне
 *   processDate(result.value);
 * } else {
 *   // Дата вне диапазона
 *   console.error(result.error.message);
 * }
 * ```
 */
export function validateDateRange(
  date: Date,
  min: Date,
  max: Date
): Result<Date, TimestampValidationError> {
  const time = date.getTime();
  const minTime = min.getTime();
  const maxTime = max.getTime();

  if (isNaN(time)) {
    return Err(
      new TimestampValidationError(time, 'Invalid Date object')
    );
  }

  if (time < minTime) {
    return Err(
      new TimestampValidationError(
        time,
        `Date ${date.toISOString()} is before minimum ${min.toISOString()}`
      )
    );
  }

  if (time > maxTime) {
    return Err(
      new TimestampValidationError(
        time,
        `Date ${date.toISOString()} is after maximum ${max.toISOString()}`
      )
    );
  }

  return Ok(date);
}

/**
 * Пример использования в Railway-Oriented Programming стиле
 */
export function processUserDateInput(
  input: string,
  minDate: Date,
  maxDate: Date
): Result<Date, DateParseError | TimestampValidationError> {
  // Парсинг → Валидация диапазона
  const parseResult = parseISODate(input);

  if (!parseResult.ok) {
    return parseResult; // Ошибка парсинга
  }

  return validateDateRange(parseResult.value, minDate, maxDate);
}

/**
 * Пример использования с flatMap
 */
export function processUserDateInputRailway(
  input: string,
  minDate: Date,
  maxDate: Date
): Result<Date, DateParseError | TimestampValidationError> {
  // Railway-Oriented Programming
  return flatMap(
    parseISODate(input),
    (date) => validateDateRange(date, minDate, maxDate)
  );
}

// Helper для примера (обычно из @polymarket/result)
function flatMap<T, E, U, F>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, F>
): Result<U, E | F> {
  if (result.ok) {
    return fn(result.value);
  }
  return result as Result<U, E>;
}
