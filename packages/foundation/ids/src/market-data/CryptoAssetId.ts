import { validateBrandedId } from '../core/utils/validateBrandedId.js';

/**
 * CryptoAssetId — идентификатор базового криптоактива (BTC, ETH, SOL, ...)
 *
 * @remarks
 * Branded type для type safety.
 *
 * Представляет нормализованный символ криптоактива, лежащего в основе
 * crypto-прогнозных рынков (`priceToBeat`/`finalPrice` в `@polymarket/cross-market`,
 * `CryptoMarketDataStore`/`CryptoResolutionStore`/`CryptoSignalRegistry` в
 * `@polymarket/market-state`). Пространство значений открытое (произвольные
 * тикеры бирж после нормализации — `'btc'`, `'eth'`, `'matic'`, ...), не
 * маленький закрытый список — поэтому branded ID через {@link asCryptoAssetId},
 * а не литеральный union (в отличие от `CexVenue`, у которого набор бирж
 * действительно закрыт и небольшой).
 *
 * @example
 * ```typescript
 * const assetId = asCryptoAssetId('btc');
 * if (assetId) {
 *   console.log(assetId); // 'btc' typed as CryptoAssetId
 * }
 *
 * // Unsafe (для внутреннего кода с гарантированно валидным значением):
 * const id = unsafeCryptoAssetId('eth');
 * ```
 */
export type CryptoAssetId = string & { readonly __brand: 'CryptoAssetId' };

/**
 * Максимальная длина CryptoAssetId
 * @internal
 */
const MAX_CRYPTO_ASSET_ID_LENGTH = 32;

/**
 * Валидация и парсинг CryptoAssetId
 *
 * @param raw - Строка для парсинга (обычно уже нормализованная через
 *   `normalizeAsset`/`inferAssetFromSymbol`)
 * @returns CryptoAssetId или undefined если формат невалидный
 *
 * @remarks
 * Базовые ограничения:
 * - Не пустая строка
 * - Максимум 32 символа
 * - Не содержит control characters (U+0000..U+001F, U+007F..U+009F)
 * - Не содержит пробелы по краям (автоматически trim)
 *
 * Валидатор не проверяет принадлежность к какому-либо конкретному списку
 * активов — пространство значений открытое (см. докблок типа выше).
 *
 * @example
 * ```typescript
 * asCryptoAssetId('btc');           // → CryptoAssetId
 * asCryptoAssetId('  eth  ');       // → 'eth' as CryptoAssetId (trimmed)
 * asCryptoAssetId('');              // → undefined (пустая строка)
 * asCryptoAssetId('  ');            // → undefined (только пробелы)
 * asCryptoAssetId('a\u0000b');    // → undefined (control character)
 * asCryptoAssetId('x'.repeat(50));  // → undefined (слишком длинная)
 * ```
 */
export function asCryptoAssetId(raw: string): CryptoAssetId | undefined {
  return validateBrandedId(raw, MAX_CRYPTO_ASSET_ID_LENGTH) as CryptoAssetId | undefined;
}

/**
 * Unsafe constructor — bypasses validation
 *
 * @internal
 * @param raw - Raw string (без валидации)
 * @returns CryptoAssetId
 *
 * @remarks
 * Используй только если уверен что строка валидна (например, уже
 * нормализована и провалидирована выше по стеку). Для external input
 * всегда используй asCryptoAssetId().
 */
/* c8 ignore next 3 */
export function unsafeCryptoAssetId(raw: string): CryptoAssetId {
  return raw as CryptoAssetId;
}
