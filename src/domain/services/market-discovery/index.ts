/**
 * Market discovery module exports
 *
 * @remarks
 * Provides market scanning, filtering, and selection from Polymarket Gamma API.
 *
 * @module domain/services/market-discovery
 */

// Types
export type {
  GammaMarketData,
  MarketCandidate,
  MarketFilterConfig,
  MarketScoringWeights,
  MarketDiscoveryResult,
  IMarketDiscoveryService,
} from './types.js';

// Service
export {
  MarketDiscoveryService,
  type MarketDiscoveryConfig,
  type IMarketDataProvider,
} from './MarketDiscoveryService.js';

// Components
export { MarketFilter } from './MarketFilter.js';
export { MarketScorer, DEFAULT_SCORING_WEIGHTS } from './MarketScorer.js';

// Market Data Client (replaces deprecated GammaApiClient)
export {
  PolymarketMarketDataRestClient,
  type MarketDataClientConfig,
} from '../../../infrastructure/polymarket/rest/clients/PolymarketMarketDataRestClient.js';
