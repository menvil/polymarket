/**
 * MarketId — branded type для идентификатора рынка
 *
 * @remarks
 * Гарантирует на уровне типов, что строка прошла валидацию:
 * непустая строка без пробелов в начале/конце.
 *
 * ### Почему branded type?
 * Предотвращает случайное использование произвольной строки там,
 * где ожидается валидированный идентификатор рынка.
 *
 * @example
 * ```typescript
 * // Безопасный вариант (может вернуть undefined):
 * const id = parseMarketId('market-123');
 * if (id) {
 *   console.log(id); // '市場-123' typed as MarketId
 * }
 *
 * // Бросающий вариант (для мест где ID гарантированно валиден):
 * const id = asMarketId('market-123');
 * ```
 */

/**
 * MarketId — уникальный идентификатор рынка (branded string)
 */
export type MarketId = string & { readonly __brand: 'MarketId' };

/**
 * Парсит строку в MarketId
 *
 * @param str - Строка для парсинга
 * @returns MarketId если строка непустая, иначе undefined
 *
 * @remarks
 * Валидация: непустая строка (после trim).
 * Не изменяет исходную строку.
 *
 * @example
 * ```typescript
 * parseMarketId('market-abc'); // → MarketId('market-abc')
 * parseMarketId('');           // → undefined
 * parseMarketId('  ');         // → undefined
 * ```
 */
export function parseMarketId(str: string): MarketId | undefined {
  if (typeof str !== 'string' || str.trim().length === 0) {
    return undefined;
  }
  return str as MarketId;
}

/**
 * Конвертирует строку в MarketId, бросает если строка невалидна
 *
 * @param str - Строка для конвертации
 * @returns MarketId
 * @throws {Error} Если строка пустая или невалидная
 *
 * @remarks
 * Используйте там, где ID гарантированно валиден (например, из базы данных).
 * Для внешнего ввода используйте parseMarketId.
 *
 * @example
 * ```typescript
 * const id = asMarketId('market-123'); // MarketId
 * asMarketId('');                       // throws Error
 * ```
 */
export function asMarketId(str: string): MarketId {
  const id = parseMarketId(str);
  if (id === undefined) {
    throw new Error(`Invalid MarketId: "${str}"`);
  }
  return id;
}
