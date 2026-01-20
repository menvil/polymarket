/**
 * Result<T, E> - Railway-oriented programming для явной обработки ошибок
 *
 * @remarks
 * Замена exceptions на явные Result типы.
 * TypeScript гарантирует exhaustive checking всех error cases.
 *
 * Преимущества:
 * - Явная обработка ошибок (компилятор заставляет проверять .ok)
 * - Нет неожиданных exceptions
 * - Composable через map/flatMap
 * - Type-safe error handling
 *
 * @template T - Тип успешного результата
 * @template E - Тип ошибки
 *
 * @example
 * ```typescript
 * function divide(a: number, b: number): Result<number, string> {
 *   if (b === 0) return Err('Деление на ноль');
 *   return Ok(a / b);
 * }
 *
 * const result = divide(10, 2);
 * if (result.ok) {
 *   console.log('Результат:', result.value); // 5
 * } else {
 *   console.error('Ошибка:', result.error);
 * }
 * ```
 */

/**
 * Result type - либо успех (Ok) либо ошибка (Err)
 *
 * @remarks
 * Discriminated union type - TypeScript автоматически сужает тип при проверке .ok
 */
export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

/**
 * Создаёт успешный Result
 *
 * @param value - Значение успешного результата
 * @returns Result с ok = true
 *
 * @example
 * ```typescript
 * const result = Ok(42);
 * // result: { ok: true, value: 42 }
 * ```
 */
export const Ok = <T>(value: T): Result<T, never> => ({
  ok: true,
  value,
});

/**
 * Создаёт Result с ошибкой
 *
 * @param error - Описание ошибки
 * @returns Result с ok = false
 *
 * @example
 * ```typescript
 * const result = Err('Что-то пошло не так');
 * // result: { ok: false, error: 'Что-то пошло не так' }
 * ```
 */
export const Err = <E>(error: E): Result<never, E> => ({
  ok: false,
  error,
});

/**
 * Type guard для проверки успешного Result
 *
 * @param result - Result для проверки
 * @returns true если Result успешный
 *
 * @example
 * ```typescript
 * const result = Ok(42);
 * if (isOk(result)) {
 *   console.log(result.value); // TypeScript знает что это Ok
 * }
 * ```
 */
export const isOk = <T, E>(result: Result<T, E>): result is { ok: true; value: T } =>
  result.ok === true;

/**
 * Type guard для проверки Result с ошибкой
 *
 * @param result - Result для проверки
 * @returns true если Result содержит ошибку
 *
 * @example
 * ```typescript
 * const result = Err('error');
 * if (isErr(result)) {
 *   console.error(result.error); // TypeScript знает что это Err
 * }
 * ```
 */
export const isErr = <T, E>(result: Result<T, E>): result is { ok: false; error: E } =>
  result.ok === false;

/**
 * Трансформирует успешное значение Result
 *
 * @param result - Исходный Result
 * @param fn - Функция для трансформации значения
 * @returns Новый Result с трансформированным значением или исходную ошибку
 *
 * @remarks
 * Если result.ok = false, возвращает исходную ошибку без вызова fn.
 * Если result.ok = true, применяет fn к значению.
 *
 * @example
 * ```typescript
 * const result = Ok(5);
 * const doubled = map(result, x => x * 2);
 * // doubled: Ok(10)
 *
 * const error = Err('упс');
 * const mapped = map(error, x => x * 2);
 * // mapped: Err('упс') - fn не вызывается
 * ```
 */
export const map = <T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => U
): Result<U, E> => {
  return result.ok ? Ok(fn(result.value)) : result;
};

/**
 * Цепочка Result-возвращающих операций (monadic bind)
 *
 * @param result - Исходный Result
 * @param fn - Функция возвращающая новый Result
 * @returns Новый Result или исходная ошибка
 *
 * @remarks
 * Позволяет цеплять операции которые могут упасть.
 * Если любая операция в цепочке вернёт Err, вся цепочка вернёт Err.
 *
 * @example
 * ```typescript
 * const divide = (a: number, b: number): Result<number, string> =>
 *   b === 0 ? Err('Деление на ноль') : Ok(a / b);
 *
 * const result = flatMap(
 *   divide(10, 2),  // Ok(5)
 *   x => divide(x, 0)  // Err('Деление на ноль')
 * );
 * // result: Err('Деление на ноль')
 * ```
 */
export const flatMap = <T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>
): Result<U, E> => {
  return result.ok ? fn(result.value) : result;
};

/**
 * Трансформирует ошибку Result
 *
 * @param result - Исходный Result
 * @param fn - Функция для трансформации ошибки
 * @returns Result с трансформированной ошибкой или исходное значение
 *
 * @remarks
 * Если result.ok = true, возвращает исходное значение без вызова fn.
 * Если result.ok = false, применяет fn к ошибке.
 *
 * Полезно для маппинга ошибок в разные типы.
 *
 * @example
 * ```typescript
 * const result = Err({ code: 404, message: 'Не найдено' });
 * const mapped = mapErr(result, err => err.message);
 * // mapped: Err('Не найдено')
 * ```
 */
export const mapErr = <T, E, F>(
  result: Result<T, E>,
  fn: (error: E) => F
): Result<T, F> => {
  return result.ok ? result : Err(fn(result.error));
};

/**
 * Объединяет массив Results в Result массива
 *
 * @param results - Массив Results
 * @returns Ok с массивом значений или первый Err
 *
 * @remarks
 * Если хотя бы один Result содержит ошибку, возвращает первую ошибку.
 * Если все Results успешные, возвращает массив всех значений.
 * Пустой массив возвращает Ok([]).
 *
 * @example
 * ```typescript
 * const results = [Ok(1), Ok(2), Ok(3)];
 * const combined = combine(results);
 * // combined: Ok([1, 2, 3])
 *
 * const withError = [Ok(1), Err('упс'), Ok(3)];
 * const failed = combine(withError);
 * // failed: Err('упс')
 *
 * const empty = combine([]);
 * // empty: Ok([])
 * ```
 */
export const combine = <T, E>(results: Array<Result<T, E>>): Result<T[], E> => {
  const values: T[] = [];

  for (const result of results) {
    if (!result.ok) {
      return result; // Вернуть первую ошибку
    }
    values.push(result.value);
  }

  return Ok(values);
};

/**
 * Форматирует значение в строку для сообщений об ошибках
 *
 * @param value - Значение для форматирования
 * @returns Строковое представление значения
 *
 * @remarks
 * Безопасно обрабатывает любые значения, включая специальные случаи:
 * - Циклические ссылки (через WeakSet)
 * - Error объекты с именем и сообщением
 * - Date объекты (включая Invalid Date)
 * - Map, Set с их размером
 * - Symbol и toStringTag
 * - Функции с именем
 *
 * @example
 * ```typescript
 * formatValue(42) // "42"
 * formatValue(new Error('oops')) // "Error: oops"
 * formatValue(new Date('2024-01-01')) // "Date(2024-01-01T00:00:00.000Z)"
 * formatValue(new Date('invalid')) // "Date(Invalid Date)"
 * formatValue({ a: 1 }) // '{"a":1}'
 * ```
 *
 * @internal
 */
export function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  // Error обработка с именем и сообщением
  if (value instanceof Error) {
    return value.message ? `${value.name}: ${value.message}` : value.name;
  }

  // Примитивы
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'function') {
    return `[Function${value.name ? `: ${value.name}` : ''}]`;
  }

  // Специальные встроенные типы
  if (value instanceof Date) {
    // Проверяем валидность даты перед вызовом toISOString()
    // isNaN(value.getTime()) возвращает true для Invalid Date
    if (isNaN(value.getTime())) {
      return 'Date(Invalid Date)';
    }
    return `Date(${value.toISOString()})`;
  }
  if (value instanceof Map) {
    return `Map(${value.size} entries)`;
  }
  if (value instanceof Set) {
    return `Set(${value.size} items)`;
  }
  if (value instanceof RegExp) {
    return value.toString();
  }

  // Объекты с Symbol.toStringTag
  try {
    const tag = (value as Record<symbol, unknown>)[Symbol.toStringTag];
    if (tag && typeof tag === 'string') {
      return `[${tag}]`;
    }
  } catch {
    // Ignore - getter может выбросить исключение
  }

  // Попытка JSON.stringify с обработкой циклических ссылок
  try {
    const seen = new WeakSet();
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) {
          return '[Circular]';
        }
        seen.add(val);
      }
      return val;
    }) ?? String(value);
  } catch {
    // Fallback для объектов которые нельзя сериализовать
    return String(value);
  }
}

/**
 * Unwrap успешного Result (небезопасно)
 *
 * @param result - Result для unwrap
 * @returns Значение если ok = true
 * @throws {Error} Если ok = false
 *
 * @remarks
 * ⚠️ НЕБЕЗОПАСНО - используйте только когда уверены что Result успешный.
 * Предпочитайте pattern matching через if (result.ok).
 *
 * @example
 * ```typescript
 * const result = Ok(42);
 * const value = unwrap(result); // 42
 *
 * const error = Err('упс');
 * const value = unwrap(error); // выбрасывает Error с информацией об ошибке
 * ```
 */
export const unwrap = <T, E>(result: Result<T, E>): T => {
  if (!result.ok) {
    const errorInfo = formatValue(result.error);
    throw new Error(`Called unwrap on Err result: ${errorInfo}`);
  }
  return result.value;
};

/**
 * Unwrap с fallback значением
 *
 * @param result - Result для unwrap
 * @param defaultValue - Значение по умолчанию если result - ошибка
 * @returns Значение result или defaultValue
 *
 * @remarks
 * Безопасная альтернатива unwrap - возвращает defaultValue вместо exception.
 *
 * @example
 * ```typescript
 * const result = Err('упс');
 * const value = unwrapOr(result, 42); // 42
 *
 * const success = Ok(10);
 * const value = unwrapOr(success, 42); // 10
 * ```
 */
export const unwrapOr = <T, E>(result: Result<T, E>, defaultValue: T): T => {
  return result.ok ? result.value : defaultValue;
};
