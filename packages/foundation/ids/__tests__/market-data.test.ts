import { describe, it, expect } from '@jest/globals';
import {
  type MarketDataSourceId,
  KnownMarketDataSources,
  sourceToVenue,
  isLiveSource,
  isReplaySource,
} from '../src/index.js';

describe('Market Data IDs', () => {
  describe('MarketDataSourceId', () => {
    it('should have known sources', () => {
      const polymarketWs: MarketDataSourceId = KnownMarketDataSources.POLYMARKET_WS;
      const polymarketReplay: MarketDataSourceId = KnownMarketDataSources.POLYMARKET_REPLAY;

      expect(polymarketWs).toBe('POLYMARKET_WS');
      expect(polymarketReplay).toBe('POLYMARKET_REPLAY');
    });

    it('should map source to venue', () => {
      expect(sourceToVenue(KnownMarketDataSources.POLYMARKET_WS)).toBe('POLYMARKET');
      expect(sourceToVenue(KnownMarketDataSources.POLYMARKET_REPLAY)).toBe('POLYMARKET');
      expect(sourceToVenue(KnownMarketDataSources.KALSHI_WS)).toBe('KALSHI');
    });

    it('should detect live sources', () => {
      expect(isLiveSource(KnownMarketDataSources.POLYMARKET_WS)).toBe(true);
      expect(isLiveSource(KnownMarketDataSources.POLYMARKET_REST)).toBe(true);
      expect(isLiveSource(KnownMarketDataSources.POLYMARKET_REPLAY)).toBe(false);
    });

    it('should detect replay sources', () => {
      expect(isReplaySource(KnownMarketDataSources.POLYMARKET_REPLAY)).toBe(true);
      expect(isReplaySource(KnownMarketDataSources.KALSHI_REPLAY)).toBe(true);
      expect(isReplaySource(KnownMarketDataSources.POLYMARKET_WS)).toBe(false);
    });
  });
});
