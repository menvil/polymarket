/**
 * Защита системных полей логов от переопределения
 *
 * @remarks
 * Системные поля (timestamp, level, message) должны контролироваться только логгером,
 * их нельзя переопределять через bindings или context. Это обеспечивает:
 * - Целостность логов
 * - Корректную работу алертинга
 * - Надежность парсинга логов в log aggregation системах
 *
 * Функция fail-safe: не бросает исключения даже при опасных объектах с throwing getters
 * или экзотичных объектах (Proxy). При ошибках возвращает безопасный fallback.
 *
 * Зарезервированные поля игнорируются молча (без console.warn) чтобы не нарушать
 * log-level фильтр.
 *
 * @param context - Контекст от пользователя (bindings или log context)
 * @returns Sanitized контекст без зарезервированных полей
 *
 * @example
 * Базовое использование:
 * ```typescript
 * const context = { userId: '123', timestamp: '1970-01-01' };
 * const sanitized = sanitizeContext(context);
 * // { userId: '123' } - timestamp удален
 * ```
 *
 * @example
 * Fail-safe с throwing getter:
 * ```typescript
 * const dangerous = {
 *   get boom() { throw new Error('explosion'); },
 *   safe: 'value'
 * };
 * const sanitized = sanitizeContext(dangerous);
 * // { safe: 'value', boom: '[Error reading property: explosion]' }
 * ```
 */

/**
 * Зарезервированные поля, которые нельзя переопределять
 *
 * @internal
 */
const RESERVED_FIELDS = new Set(['timestamp', 'level', 'message']);

/**
 * Фильтрует контекст, удаляя зарезервированные поля
 *
 * @param context - Контекст для фильтрации
 * @returns Sanitized контекст
 */
export function sanitizeContext(
  context: Record<string, unknown>
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  // Используем Object.keys() + bracket notation вместо Object.entries()
  // чтобы избежать вызова геттеров, которые могут бросать исключения
  try {
    const keys = Object.keys(context);
    for (const key of keys) {
      if (!RESERVED_FIELDS.has(key)) {
        try {
          // Безопасное чтение значения - геттер может бросить исключение
          sanitized[key] = context[key];
        } catch (error) {
          // Геттер бросил исключение - заменяем на error placeholder
          sanitized[key] = `[Error reading property: ${error instanceof Error ? error.message : String(error)}]`;
        }
      }
      // Убираем console.warn - не нарушаем log-level фильтр
      // Если нужно логировать попытки override, это должен делать caller
    }
  } catch (error) {
    // Object.keys может упасть на Proxy или экзотичном объекте
    // Возвращаем пустой объект - fail-safe
    return {};
  }

  return sanitized;
}
