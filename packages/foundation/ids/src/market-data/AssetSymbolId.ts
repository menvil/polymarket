import { validateBrandedId } from '../core/utils/validateBrandedId.js';

/**
 * AssetSymbolId — символ ЛЮБОГО торгуемого/котируемого актива.
 *
 * @remarks
 * Нормализованный тикер актива безотносительно его природы: `btc`, `eth`,
 * `sol`, но также `usd`, `usdt`, `usdc`. Нужен там, где актив участвует в
 * ПАРЕ и сторона пары заранее не известна — прежде всего в идентичности
 * референсных котировок (`baseAsset`/`quoteAsset`).
 *
 * ### Чем отличается от соседних типов
 *
 * - {@link CryptoAssetId} — БАЗОВЫЙ криптоактив prediction-рынка (`btc`,
 *   `eth`), используется в `priceToBeat`/`finalPrice` и signal-реестрах.
 *   Котируемый актив им описывать нельзя: `usd` — не криптоактив, и
 *   `asCryptoAssetId('usd')` проходит лишь потому, что валидатор проверяет
 *   ФОРМУ строки, а не смысл. Тип остаётся за своей семантикой.
 * - `AssetId` — структурный union (`CURRENCY` | `OUTCOME_TOKEN`) для учёта
 *   позиций и балансов; тикером пары не является.
 * - `SupportedCurrency` — закрытый список расчётных валют (сейчас только
 *   `USDC`); пару `BTC/USD` он не представляет.
 *
 * ### Пространство значений открытое
 *
 * Тикеры приходят от бирж и оракулов, их набор не фиксирован, поэтому
 * branded ID через {@link asAssetSymbolId}, а не литеральный union.
 *
 * ### Нормализация выполняется здесь
 *
 * В отличие от {@link CryptoAssetId}, конструктор сам приводит значение к
 * нижнему регистру. Причина: символ используется как КЛЮЧ сопоставления
 * потоков, и `BTC` рядом с `btc` дали бы два разных актива там, где актив
 * один. Оставлять это вызывающему — значит расставить грабли по всем
 * source-адаптерам.
 *
 * @example
 * ```typescript
 * const base = asAssetSymbolId('BTC');   // → 'btc'
 * const quote = asAssetSymbolId('usdt'); // → 'usdt'
 *
 * // USDT и USD — РАЗНЫЕ активы; эквивалентность решает стратегия
 * asAssetSymbolId('usdt') === asAssetSymbolId('usd'); // false
 * ```
 */
export type AssetSymbolId = string & { readonly __brand: 'AssetSymbolId' };

/**
 * Максимальная длина AssetSymbolId
 * @internal
 */
const MAX_ASSET_SYMBOL_ID_LENGTH = 32;

/**
 * Валидация и нормализация AssetSymbolId.
 *
 * @param raw - Тикер актива в любом регистре (`BTC`, `btc`, `  USD  `)
 * @returns `AssetSymbolId` в нижнем регистре либо `undefined`, если строка
 *   пуста, слишком длинна или содержит control characters
 *
 * @remarks
 * Приводит к нижнему регистру и обрезает пробелы — см. раздел про
 * нормализацию в докблоке {@link AssetSymbolId}. Смысл актива НЕ
 * проверяется: список тикеров открыт, и валидатор отвечает только за форму.
 *
 * @example
 * ```typescript
 * asAssetSymbolId('BTC');            // → 'btc'
 * asAssetSymbolId('  usdt  ');       // → 'usdt'
 * asAssetSymbolId('');               // → undefined
 * asAssetSymbolId('x'.repeat(40));   // → undefined
 * ```
 */
export function asAssetSymbolId(raw: string): AssetSymbolId | undefined {
  if (typeof raw !== 'string') return undefined;
  const validated = validateBrandedId(raw, MAX_ASSET_SYMBOL_ID_LENGTH);
  return validated === undefined ? undefined : (validated.toLowerCase() as AssetSymbolId);
}

/**
 * Unsafe constructor — bypasses validation.
 *
 * @internal
 * @param raw - Raw string (без валидации и нормализации)
 * @returns AssetSymbolId
 *
 * @remarks
 * Только для кода с гарантированно валидным нормализованным значением.
 * Для внешнего ввода всегда {@link asAssetSymbolId}.
 */
/* c8 ignore next 3 */
export function unsafeAssetSymbolId(raw: string): AssetSymbolId {
  return raw as AssetSymbolId;
}
