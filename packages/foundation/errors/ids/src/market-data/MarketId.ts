import { validateBrandedId } from '../core/utils/validateBrandedId.js';

/**
 * MarketId — идентификатор предсказательного рынка
 *
 * @remarks
 * Branded type для type safety.
 *
 * Представляет уникальный ID рынка в формате конкретной площадки:
 * - Polymarket: строковый slug или UUID рынка
 * - Общий формат: непустая строка до 256 символов
 *
 * Используется для:
 * - Идентификации рынка в Domain layer
 * - Ссылок из Order, Fill, Position на рынок
 *
 * @example
 * ```typescript
 * const marketId = asMarketId('will-trump-win-2024');
 * if (marketId) {
 *   console.log(marketId); // 'will-trump-win-2024' typed as MarketId
 * }
 *
 * // Unsafe (для внутреннего кода с гарантированно валидным значением):
 * const id = unsafeMarketId('market-abc');
 * ```
 */
export type MarketId = string & { readonly __brand: 'MarketId' };

/**
 * Максимальная длина MarketId
 * @internal
 */
const MAX_MARKET_ID_LENGTH = 256;

/**
 * Валидация и парсинг MarketId
 *
 * @param raw - Строка для парсинга
 * @returns MarketId или undefined если формат невалидный
 *
 * @remarks
 * Базовые ограничения:
 * - Не пустая строка
 * - Максимум 256 символов
 * - Не содержит control characters (U+0000..U+001F, U+007F..U+009F)
 * - Не содержит пробелы по краям (автоматически trim)
 *
 * @example
 * ```typescript
 * asMarketId('will-trump-win-2024'); // → MarketId
 * asMarketId('  valid  ');           // → 'valid' as MarketId (trimmed)
 * asMarketId('');                    // → undefined (пустая строка)
 * asMarketId('  ');                  // → undefined (только пробелы)
 * asMarketId('a\u0000b');           // → undefined (control character)
 * asMarketId('x'.repeat(300));      // → undefined (слишком длинная)
 * ```
 */
export function asMarketId(raw: string): MarketId | undefined {
  return validateBrandedId(raw, MAX_MARKET_ID_LENGTH) as MarketId | undefined;
}

/**
 * Unsafe constructor — bypasses validation
 *
 * @internal
 * @param raw - Raw string (без валидации)
 * @returns MarketId
 *
 * @remarks
 * Используй только если уверен что строка валидна (например, из БД или уже валидированного источника).
 * Для external input всегда используй asMarketId().
 */
/* c8 ignore next 3 */
export function unsafeMarketId(raw: string): MarketId {
  return raw as MarketId;
}
