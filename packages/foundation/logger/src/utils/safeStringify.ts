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
    // Circular reference detection
    if (error instanceof TypeError && error.message.includes('circular')) {
      return '{"__error":"Circular reference detected"}';
    }

    // Unknown serialization error - log to console.error (не через logger!)
    // eslint-disable-next-line no-console
    console.error('[Logger] Serialization error:', error);
    return '{"__error":"Serialization failed"}';
  }
}
