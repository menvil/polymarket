/**
 * Stub для IMarketDataProvider из MarketDiscoveryService.
 *
 * @remarks
 * INTERNAL STUB — используется PolymarketMarketDataRestClient до реализации Phase 1 domain services.
 */
import type { GammaMarketData } from './types.js';

/** Интерфейс провайдера рыночных данных */
export interface IMarketDataProvider {
  getActiveMarkets(): Promise<GammaMarketData[]>;
}
