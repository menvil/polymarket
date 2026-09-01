/**
 * @polymarket/market-discovery — universe рынков, фильтрация и скоринг.
 *
 * @remarks
 * Application-layer пакет обнаружения и выбора торговых рынков.
 *
 * ### Содержимое
 * - `MarketUniverse` — in-memory source of truth текущего canonical universe
 *   (`MarketDiscoverySnapshot` → lookup/итерация по `Market`);
 * - `MarketFilter` — LEGACY-фильтрация кандидатов по `IMarketFilterConfig`;
 * - `MarketScorer` — LEGACY-скоринг и сортировка (expiresAt ASC, liquidity DESC).
 *
 * ### Состояние миграции
 *
 * `MarketUniverse` работает с canonical `Market`. `MarketFilter`/`MarketScorer`
 * пока работают с LEGACY-контрактом `DiscoveredMarket` и НЕ участвуют в
 * Polymarket V2 Discovery: owner selection вынесен из Infrastructure и станет
 * Policy НАД universe в следующем MR — тогда Filter/Scorer будут мигрированы
 * на `MarketDiscoveryEntry`, а `DiscoveredMarket` исчезнет.
 *
 * @example
 * ```typescript
 * import { MarketUniverse } from '@polymarket/market-discovery';
 *
 * const universe = new MarketUniverse(clock);
 * await discovery.refresh();
 * universe.replace(discovery.getSnapshot());
 * ```
 *
 * @packageDocumentation
 */
export { MarketUniverse } from './MarketUniverse.js';
export { MarketFilter } from './MarketFilter.js';
export { MarketScorer } from './MarketScorer.js';
