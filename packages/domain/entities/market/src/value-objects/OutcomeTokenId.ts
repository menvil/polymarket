/**
 * OutcomeTokenId — branded type для идентификатора токена исхода
 *
 * @remarks
 * Идентификаторы токенов исходов в Polymarket — это строковые токен-адреса.
 * Branded type предотвращает путаницу с другими строковыми идентификаторами.
 *
 * @example
 * ```typescript
 * const tokenId = parseOutcomeTokenId('21742633143463906290569050155826241533067272736897614950488156847949938836455');
 * if (tokenId) {
 *   // tokenId typed as OutcomeTokenId
 * }
 * ```
 */

/**
 * OutcomeTokenId — идентификатор токена исхода рынка (branded string)
 */
export type OutcomeTokenId = string & { readonly __brand: 'OutcomeTokenId' };

/**
 * Парсит строку в OutcomeTokenId
 *
 * @param str - Строка для парсинга
 * @returns OutcomeTokenId если строка непустая, иначе undefined
 *
 * @remarks
 * Валидация: непустая строка (после trim).
 *
 * @example
 * ```typescript
 * parseOutcomeTokenId('21742633143...'); // → OutcomeTokenId
 * parseOutcomeTokenId('');              // → undefined
 * ```
 */
export function parseOutcomeTokenId(str: string): OutcomeTokenId | undefined {
  if (typeof str !== 'string' || str.trim().length === 0) {
    return undefined;
  }
  return str as OutcomeTokenId;
}
