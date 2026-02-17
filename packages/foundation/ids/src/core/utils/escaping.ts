/**
 * Escaping utilities для сериализации ID с colon separators
 *
 * @remarks
 * Используется для безопасной сериализации строк содержащих ':' или '\' в составных ID.
 * Гарантирует round-trip serialization для:
 * - AccountId (wallet address, venue, subaccount name)
 * - ConditionRef (marketId для OFFCHAIN refs)
 *
 * Escaping rules:
 * - '\' → '\\'
 * - ':' → '\:'
 *
 * @packageDocumentation
 */

/**
 * Escape backslashes и colons в строке
 *
 * @param str - Строка для escaping
 * @returns Escaped строка где '\' → '\\' и ':' → '\:'
 *
 * @remarks
 * Порядок важен! Сначала экранируем backslash, потом colon.
 *
 * @example
 * ```typescript
 * escape('A:B');      // → 'A\\:B'
 * escape('A\\B');     // → 'A\\\\B'
 * escape('A\\:B');    // → 'A\\\\\\:B'
 * escape('normal');   // → 'normal'
 * ```
 */
export function escapeId(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
}

/**
 * Unescape backslashes и colons в строке
 *
 * @param str - Escaped строка для парсинга
 * @returns Original строка с unescaped символами
 *
 * @remarks
 * Корректно обрабатывает:
 * - '\\\\' → '\' (escaped backslash)
 * - '\\:' → ':' (escaped colon)
 * - Любой другой '\X' остается как есть (не является escape sequence)
 *
 * @example
 * ```typescript
 * unescape('A\\:B');        // → 'A:B'
 * unescape('A\\\\B');       // → 'A\B'
 * unescape('A\\\\\\:B');    // → 'A\:B'
 * unescape('normal');       // → 'normal'
 * ```
 */
export function unescapeId(str: string): string {
  let result = '';
  let i = 0;

  while (i < str.length) {
    const char = str[i];

    if (char === '\\' && i + 1 < str.length) {
      const next = str[i + 1];

      // Escape sequences: \\ and \:
      if (next === '\\') {
        result += '\\';
        i += 2;
        continue;
      }

      if (next === ':') {
        result += ':';
        i += 2;
        continue;
      }

      // Not an escape sequence - keep both characters
      // (но в валидной escaped строке такого не должно быть)
    }

    result += char;
    i++;
  }

  return result;
}

/**
 * Split строку по ':' с учётом escaped separators
 *
 * @param str - Escaped строка для split
 * @returns Массив escaped частей (НЕ unescape'нутых!)
 *
 * @remarks
 * Корректно обрабатывает escaped colons ('\\:') - они НЕ являются separators.
 *
 * ⚠️ ВАЖНО: Возвращаемые части остаются escaped! Caller должен вызвать unescape()
 * на каждой части при необходимости.
 *
 * @example
 * ```typescript
 * splitEscaped('A:B:C');              // → ['A', 'B', 'C']
 * splitEscaped('A\\:B:C');            // → ['A\\:B', 'C'] (НЕ unescape'нуто!)
 * splitEscaped('A\\\\:B');            // → ['A\\\\', 'B']
 * splitEscaped('A\\\\\\:B:C');        // → ['A\\\\\\:B', 'C']
 * splitEscaped('');                   // → ['']
 *
 * // Чтобы получить unescape'нутые части:
 * const parts = splitEscaped('A\\:B:C').map(unescapeId);  // → ['A:B', 'C']
 * ```
 */
export function splitEscaped(str: string): string[] {
  const parts: string[] = [];
  let current = '';
  let i = 0;

  while (i < str.length) {
    const char = str[i];

    if (char === '\\' && i + 1 < str.length) {
      const next = str[i + 1];

      // Escape sequences: \\ and \:
      if (next === '\\' || next === ':') {
        current += char + next;
        i += 2;
        continue;
      }
    }

    // Unescaped colon - это separator
    if (char === ':') {
      parts.push(current);
      current = '';
      i++;
      continue;
    }

    current += char;
    i++;
  }

  // Последняя часть
  parts.push(current);

  return parts;
}
