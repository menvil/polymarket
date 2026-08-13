/**
 * @polymarket/market-discovery — Фильтрация и скоринг рынков.
 *
 * @remarks
 * Application layer пакет для обнаружения и выбора торговых рынков.
 * Содержит stateless pure-функции для фильтрации и скоринга кандидатов.
 *
 * ### Содержимое:
 * - `MarketFilter` — фильтрация кандидатов по `IMarketFilterConfig`
 * - `MarketScorer` — скоринг и сортировка по приоритету (expiresAt ASC, liquidity DESC)
 *
 * ### Использование в инфраструктуре:
 * ```typescript
 * import { MarketFilter, MarketScorer } from '@polymarket/market-discovery';
 *
 * const filter = new MarketFilter();
 * const scorer = new MarketScorer(clock);
 *
 * const filtered = filter.filterCandidates(rawMarkets, config, Date.now());
 * const sorted = scorer.scoreAndSort(filtered);
 * const top10 = sorted.slice(0, config.maxMarketsToReturn);
 * ```
 *
 * @packageDocumentation
 */
export { MarketFilter } from './MarketFilter.js';
export { MarketScorer } from './MarketScorer.js';
