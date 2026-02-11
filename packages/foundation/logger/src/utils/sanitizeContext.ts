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
 * Если пользователь пытается передать зарезервированное поле, оно игнорируется
 * с предупреждением в console.warn (не через logger, чтобы избежать рекурсии).
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
 * Попытка подделки уровня лога:
 * ```typescript
 * const context = { level: LogLevel.ERROR, userId: '123' };
 * const sanitized = sanitizeContext(context);
 * // { userId: '123' } - level удален + warning в console
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
