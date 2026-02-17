/**
 * Безопасная сериализация объектов в JSON
 *
 * @remarks
 * Обрабатывает все edge cases, которые могут привести к падению JSON.stringify:
 * - Circular references (циклические ссылки)
 * - BigInt значения
 * - Symbol ключи/значения
 * - Function значения
 *
 * Logger должен быть fail-safe и никогда не бросать исключения,
 * поэтому все проблемные значения заменяются на строковые представления.
 *
 * @param obj - Объект для сериализации
 * @param indent - Количество пробелов для pretty print (undefined = compact)
 * @returns JSON строка или fallback message в случае ошибки
 *
 * @example
 * Базовое использование:
 * ```typescript
 * const result = safeStringify({ name: 'John', age: 30 });
 * // '{"name":"John","age":30}'
 * ```
 *
 * @example
 * Pretty print:
 * ```typescript
 * const result = safeStringify({ name: 'John', age: 30 }, 2);
 * // '{\n  "name": "John",\n  "age": 30\n}'
 * ```
 *
 * @example
 * Обработка circular reference:
 * ```typescript
 * const circular: any = { name: 'test' };
 * circular.self = circular;
 *
 * const result = safeStringify(circular);
 * // '{"__error":"Circular reference detected"}'
 * ```
 *
 * @example
 * Обработка BigInt:
 * ```typescript
 * const result = safeStringify({ value: BigInt(123) });
 * // '{"value":"BigInt(123)"}'
 * ```
 */
export function safeStringify(obj: unknown, indent?: number): string {
  // Первая попытка - стандартная сериализация
  try {
    return JSON.stringify(
      obj,
      (_key, value) => {
        // Handle BigInt - convert to string representation
        if (typeof value === 'bigint') {
          return `BigInt(${value.toString()})`;
        }

        // Handle Symbol - convert to string representation
        if (typeof value === 'symbol') {
          return value.toString();
        }

        // Handle Function - show function name
        if (typeof value === 'function') {
          return `[Function: ${value.name || 'anonymous'}]`;
        }

        return value;
      },
      indent
    );
  } catch (error) {
    // Circular reference - попытка сохранить хотя бы примитивные поля
    if (error instanceof TypeError && error.message.includes('circular')) {
      try {
        // Пытаемся извлечь примитивные значения из объекта
        const safe = extractPrimitiveFields(obj);
        // Добавляем метку о circular reference в сам объект, а не через slice,
        // чтобы избежать невалидного JSON при пустом safe (иначе получили бы {,"__error":...}).
        return JSON.stringify({ ...safe, __error: 'Circular reference detected' }, null, indent);
      } catch {
        // Даже это не помогло - возвращаем минимальный fallback
        return '{"__error":"Circular reference detected"}';
      }
    }

    // Unknown serialization error
    // eslint-disable-next-line no-console
    console.error('[Logger] Serialization error:', error);
    return '{"__error":"Serialization failed"}';
  }
}

/**
 * Извлекает примитивные поля из объекта (без circular references)
 *
 * @param obj - Объект для извлечения
 * @returns Объект только с примитивными полями
 *
 * @internal
 */
function extractPrimitiveFields(obj: unknown): Record<string, unknown> {
  if (typeof obj !== 'object' || obj === null) {
    return {};
  }

  const result: Record<string, unknown> = {};

  try {
    for (const key of Object.keys(obj)) {
      try {
        const value = (obj as Record<string, unknown>)[key];
        const type = typeof value;

        // Сохраняем только примитивы и null
        if (
          type === 'string' ||
          type === 'number' ||
          type === 'boolean' ||
          value === null ||
          value === undefined
        ) {
          result[key] = value;
        }
      } catch {
        // Геттер бросил исключение - пропускаем
      }
    }
  } catch {
    // Object.keys упал - возвращаем пустой объект
  }

  return result;
}
