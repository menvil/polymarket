/**
 * MarketSlug — branded type для URL-safe слага рынка
 *
 * @remarks
 * Слаг — это URL-safe строка, используемая для идентификации рынка в URL.
 * Разрешены только строчные буквы, цифры и дефис (a-z, 0-9, -).
 *
 * ### Почему именно такие правила?
 * Polymarket использует слаги в URL вида `polymarket.com/event/{slug}`.
 * Ограничение символов гарантирует безопасность в URL без дополнительного кодирования.
 *
 * @example
 * ```typescript
 * parseMarketSlug('will-trump-win-2024'); // → MarketSlug
 * parseMarketSlug('UPPER_CASE');          // → undefined (заглавные буквы запрещены)
 * parseMarketSlug('');                    // → undefined
 * ```
 */

/**
 * Регулярное выражение для валидации слага
 *
 * @remarks
 * Допустимые символы: a-z, 0-9, дефис (-)
 * Минимальная длина: 1 символ
 */
const SLUG_REGEX = /^[a-z0-9-]+$/;

/**
 * MarketSlug — URL-safe слаг рынка (branded string)
 */
export type MarketSlug = string & { readonly __brand: 'MarketSlug' };

/**
 * Парсит строку в MarketSlug
 *
 * @param str - Строка для парсинга
 * @returns MarketSlug если строка валидна, иначе undefined
 *
 * @remarks
 * Правила валидации:
 * - Непустая строка
 * - Только символы: a-z, 0-9, дефис (-)
 *
 * @example
 * ```typescript
 * parseMarketSlug('will-trump-win-2024'); // → MarketSlug
 * parseMarketSlug('my-market-123');       // → MarketSlug
 * parseMarketSlug('UPPER_CASE');          // → undefined
 * parseMarketSlug('with space');          // → undefined
 * parseMarketSlug('');                    // → undefined
 * ```
 */
export function parseMarketSlug(str: string): MarketSlug | undefined {
  if (typeof str !== 'string' || str.length === 0) {
    return undefined;
  }
  if (!SLUG_REGEX.test(str)) {
    return undefined;
  }
  return str as MarketSlug;
}
