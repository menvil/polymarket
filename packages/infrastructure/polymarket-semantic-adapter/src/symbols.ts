/**
 * Разбор vendor-символов RTDS в canonical-пару активов.
 *
 * @remarks
 * ### Зачем это здесь
 *
 * Ровно здесь заканчивается знание о форматах источников. Polymarket RTDS
 * даёт символ в двух разных нативных формах:
 *
 * ```text
 * Binance     btcusdt      слитно, нижним регистром
 * Chainlink   btc/usd      через слэш
 * ```
 *
 * Если пропустить их наружу как есть, разбирать эти форматы придётся
 * Application — то есть нормализация просто переедет за границу адаптера.
 * Именно так и произошло в legacy: `StrategyScheduler.normalizeCryptoAsset`
 * режет символы регулярками, ПРИ ЭТОМ теряя котируемый актив целиком
 * (`btcusdt` → `btc`), из-за чего `BTC/USDT` и `BTC/USD` там неразличимы.
 *
 * ### Что НЕ делается
 *
 * `USDT` не приводится к `USD`. Это разные котировки с разными ценами, и
 * решение «считать ли их взаимозаменяемыми» принадлежит стратегии, а не
 * границе наблюдения: приняв его здесь, мы бы необратимо стёрли различие.
 */
import { asAssetSymbolId } from '@polymarket/ids';
import type { AssetSymbolId } from '@polymarket/ids';

/** Canonical идентичность торговой пары наблюдения. */
export interface AssetPairSymbols {
  /** Базовый актив (`btc`, `eth`, ...). */
  readonly baseAsset: AssetSymbolId;
  /** Котируемый актив (`usdt`, `usd`, ...). */
  readonly quoteAsset: AssetSymbolId;
}

/**
 * Котируемые активы, известные слитному формату Binance.
 *
 * @remarks
 * Порядок значим: список отсортирован по УБЫВАНИЮ длины, чтобы `usdt`
 * проверялся раньше `usd` — иначе `btcusdt` разобрался бы как `btcu`+`sdt`…
 * точнее, как база `btcu` и котировка `usd`, что тихо испортило бы
 * идентичность пары.
 *
 * Список закрыт намеренно: угадывать границу базы и котировки в слитной
 * строке нельзя, а неизвестная котировка обязана привести к явному отказу,
 * а не к правдоподобной ошибке.
 */
const BINANCE_QUOTE_ASSETS: readonly string[] = ['usdt', 'usdc', 'busd', 'usd', 'btc', 'eth', 'bnb'];

/**
 * Разбирает vendor-символ RTDS в canonical-пару.
 *
 * @param nativeSymbol - Символ в нативной форме источника (`btcusdt`, `btc/usd`)
 * @returns Пара активов либо `undefined`, если символ разобрать НЕЛЬЗЯ
 *
 * @remarks
 * Поддержаны обе формы, которые встречаются в контуре:
 * - разделённая (`btc/usd`, `btc-usd`) — база и котировка заданы явно;
 * - слитная (`btcusdt`) — котировка ищется суффиксом по закрытому списку
 *   {@link BINANCE_QUOTE_ASSETS}.
 *
 * Неразобранный символ — это `undefined`, а НЕ догадка: наблюдение без
 * canonical-идентичности бесполезно downstream, и лучше отбросить его явно,
 * чем опубликовать с неверной парой.
 *
 * @example
 * ```typescript
 * parseAssetPair('btc/usd');  // → { baseAsset: 'btc', quoteAsset: 'usd' }
 * parseAssetPair('btcusdt');  // → { baseAsset: 'btc', quoteAsset: 'usdt' }
 * parseAssetPair('weirdpair'); // → undefined
 * ```
 */
export function parseAssetPair(nativeSymbol: string): AssetPairSymbols | undefined {
  const normalized = nativeSymbol.trim().toLowerCase();
  if (normalized === '') {
    return undefined;
  }

  // Явный разделитель — база и котировка заданы источником, гадать не нужно
  const separator = normalized.includes('/') ? '/' : normalized.includes('-') ? '-' : undefined;
  if (separator !== undefined) {
    const [base, quote, ...rest] = normalized.split(separator);
    if (rest.length > 0 || base === undefined || quote === undefined) {
      return undefined;
    }
    return build(base, quote);
  }

  // Слитная форма — котировка ищется суффиксом по закрытому списку
  for (const quote of BINANCE_QUOTE_ASSETS) {
    if (!normalized.endsWith(quote)) continue;
    const base = normalized.slice(0, normalized.length - quote.length);
    if (base === '') continue;
    return build(base, quote);
  }

  return undefined;
}

/**
 * Валидирует разобранные части как canonical-идентификаторы активов.
 *
 * @param base - Базовый актив (уже в нижнем регистре)
 * @param quote - Котируемый актив (уже в нижнем регистре)
 * @returns Пара либо `undefined`, если хоть одна часть непригодна
 */
function build(base: string, quote: string): AssetPairSymbols | undefined {
  const baseAsset = asAssetSymbolId(base);
  const quoteAsset = asAssetSymbolId(quote);
  if (baseAsset === undefined || quoteAsset === undefined) {
    return undefined;
  }
  return { baseAsset, quoteAsset };
}
