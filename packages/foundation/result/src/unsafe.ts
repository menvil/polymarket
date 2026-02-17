/**
 * @polymarket/result/unsafe — небезопасные операции с Result
 *
 * @remarks
 * Этот модуль содержит операции которые **бросают исключения**.
 * Импортируйте из него осознанно, только когда уверены что Result успешный.
 *
 * ⚠️ ПРЕДУПРЕЖДЕНИЕ: функции из этого модуля нарушают Railway-Oriented Programming.
 * Используйте их только на «границах» системы (тесты, точки входа).
 *
 * **Безопасные альтернативы:**
 * - Вместо `unwrap(result)` → `unwrapOr(result, defaultValue)`
 * - Вместо `unwrap(result)` → `if (result.ok) { ... }`
 * - Вместо `unwrap(result)` → `match(result, { ok: ..., err: ... })`
 *
 * @example
 * ```typescript
 * // ⛔ Не рекомендуется в продакшен коде:
 * import { unwrap } from '@polymarket/result/unsafe';
 * const value = unwrap(result); // может бросить Error
 *
 * // ✅ Рекомендуется:
 * import { unwrapOr, match } from '@polymarket/result';
 * const value = unwrapOr(result, defaultValue);
 * ```
 */

import { Result, formatValue } from './result.js';

export { unwrap } from './result.js';

/**
 * Извлекает значение из Ok с кастомным сообщением ошибки
 *
 * @param result - Result для извлечения значения
 * @param message - Сообщение для исключения
 * @returns Значение если ok = true
 * @throws {Error} С кастомным сообщением если ok = false
 *
 * @remarks
 * ⚠️ НЕБЕЗОПАСНО — бросает `Error` если result содержит ошибку.
 * Используйте только когда логически невозможно получить Err в данном месте.
 *
 * **Безопасные альтернативы:** `unwrapOr`, `match`, if/else.
 *
 * @example
 * ```typescript
 * // В тестах:
 * const result = Ok(42);
 * const value = expect(result, 'Результат должен быть Ok'); // 42
 *
 * // При Err бросит: Error: 'Результат должен быть Ok: описание_ошибки'
 * ```
 */
export const expect = <T, E>(result: Result<T, E>, message: string): T => {
  if (!result.ok) {
    const errorInfo = formatValue(result.error);
    throw new Error(`${message}: ${errorInfo}`);
  }
  return result.value;
};

/**
 * Извлекает ошибку из Err — бросает исключение если Result успешный
 *
 * @param result - Result для извлечения ошибки
 * @returns Ошибка если ok = false
 * @throws {Error} Если ok = true
 *
 * @remarks
 * ⚠️ НЕБЕЗОПАСНО — бросает `Error` если result содержит значение.
 * Используется преимущественно в тестах.
 *
 * @example
 * ```typescript
 * // В тестах:
 * const result = Err('network error');
 * const error = unwrapErr(result); // 'network error'
 * ```
 */
export const unwrapErr = <T, E>(result: Result<T, E>): E => {
  if (result.ok) {
    const valueInfo = formatValue(result.value);
    throw new Error(`Called unwrapErr on Ok result: ${valueInfo}`);
  }
  return result.error;
};

/**
 * Извлекает ошибку с кастомным сообщением исключения
 *
 * @param result - Result для извлечения ошибки
 * @param message - Сообщение для исключения
 * @returns Ошибка если ok = false
 * @throws {Error} С кастомным сообщением если ok = true
 *
 * @remarks
 * ⚠️ НЕБЕЗОПАСНО — бросает `Error` если result содержит значение.
 * Используется преимущественно в тестах.
 *
 * @example
 * ```typescript
 * // В тестах:
 * const result = Err('validation failed');
 * const err = expectErr(result, 'Should have failed'); // 'validation failed'
 * ```
 */
export const expectErr = <T, E>(result: Result<T, E>, message: string): E => {
  if (result.ok) {
    const valueInfo = formatValue(result.value);
    throw new Error(`${message}: expected Err but got Ok(${valueInfo})`);
  }
  return result.error;
};
