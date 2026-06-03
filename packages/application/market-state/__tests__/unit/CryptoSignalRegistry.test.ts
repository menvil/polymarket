/**
 * Тесты #9/#10 для weightedVenuePrice через сигнал cex_vs_chainlink_basis:
 * - #9: устаревшие/широкие биржи отсеиваются до усреднения, иначе агрегат не выдаётся
 * - #10: агрегат отклоняется при рассинхроне бирж по времени (cross-venue skew)
 */

import { CryptoMarketDataStore } from '../../src/CryptoMarketDataStore.js';
import {
  createDefaultCryptoSignalRegistry,
  type CryptoSignalContext,
} from '../../src/CryptoSignalRegistry.js';
import type { CexVenue } from '../../src/CryptoMarketDataStore.js';

const BASE = 1_700_000_000_000;

/** Скармливает книгу биржи с узким спредом и microprice = mid. */
function feedBook(store: CryptoMarketDataStore, venue: CexVenue, tsMs: number, mid: number): void {
  store.updateCexBook({
    venue,
    symbol: 'BTCUSDT',
    asset: 'btc',
    exchangeTsMs: tsMs,
    receivedTsMs: tsMs,
    bids: [[mid - 1, 1]],
    asks: [[mid + 1, 1]],
  });
}

function feedChainlink(store: CryptoMarketDataStore, tsMs: number, price: number): void {
  store.updatePrice({
    symbol: 'btc/usd', price, timestampMs: tsMs, receivedTsMs: tsMs, source: 'chainlink',
  });
}

function makeContext(store: CryptoMarketDataStore, nowMs: number): CryptoSignalContext {
  return {
    asset: 'btc',
    nowMs,
    priceHistory: store.getPriceHistory('btc'),
    venueState: store.getVenueState('btc'),
    venueHistory: store.getVenueHistory('btc'),
  };
}

describe('weightedVenuePrice фильтрация — #9/#10', () => {
  const registry = createDefaultCryptoSignalRegistry();

  describe('#9 отсев устаревших бирж', () => {
    it('исключает устаревшую биржу, агрегирует только свежие', () => {
      const store = new CryptoMarketDataStore();
      const now = BASE + 10_000;
      feedChainlink(store, now, 50_000);
      feedBook(store, 'binance', now, 50_010);
      feedBook(store, 'coinbase', now, 50_010);
      feedBook(store, 'okx', now - 5_000, 50_010); // age 5000 > staleMs(2000) → отсев

      const ctx = makeContext(store, now);
      const result = registry.evaluate('cex_vs_chainlink_basis', ctx, {
        venues: ['binance', 'coinbase', 'okx'],
      });

      expect(result).toBeDefined();
      expect(result!.components.venueCount).toBe(2);
    });

    it('не выдаёт агрегат, если свежих бирж меньше minVenueCount', () => {
      const store = new CryptoMarketDataStore();
      const now = BASE + 10_000;
      feedChainlink(store, now, 50_000);
      feedBook(store, 'binance', now, 50_010);
      feedBook(store, 'coinbase', now - 5_000, 50_010); // stale
      feedBook(store, 'okx', now - 5_000, 50_010);      // stale

      const ctx = makeContext(store, now);
      const result = registry.evaluate('cex_vs_chainlink_basis', ctx, {
        venues: ['binance', 'coinbase', 'okx'],
      });

      // только 1 свежая биржа, minVenueCount = min(2, 3) = 2 → undefined
      expect(result).toBeUndefined();
    });
  });

  describe('#10 cross-venue skew', () => {
    it('отклоняет агрегат при рассинхроне бирж больше порога', () => {
      const store = new CryptoMarketDataStore();
      const now = BASE + 10_000;
      feedChainlink(store, now, 50_000);
      feedBook(store, 'binance', now, 50_010);
      feedBook(store, 'coinbase', now - 1_900, 50_010); // обе свежие (<2000), но skew 1900 > 250

      const ctx = makeContext(store, now);
      const result = registry.evaluate('cex_vs_chainlink_basis', ctx, {
        venues: ['binance', 'coinbase'],
      });

      expect(result).toBeUndefined();
    });

    it('принимает агрегат при увеличенном пороге skew', () => {
      const store = new CryptoMarketDataStore();
      const now = BASE + 10_000;
      feedChainlink(store, now, 50_000);
      feedBook(store, 'binance', now, 50_010);
      feedBook(store, 'coinbase', now - 1_900, 50_010);

      const ctx = makeContext(store, now);
      const result = registry.evaluate('cex_vs_chainlink_basis', ctx, {
        venues: ['binance', 'coinbase'],
        maxCrossVenueSkewMs: 3_000,
      });

      expect(result).toBeDefined();
      expect(result!.components.venueCount).toBe(2);
      expect(result!.components.crossVenueSkewMs).toBe(1_900);
    });
  });

  describe('#5 cross-venue skew в cex_chainlink_lead_lag', () => {
    it('отклоняет lead-lag при рассинхроне бирж больше порога', () => {
      const store = new CryptoMarketDataStore();
      const now = BASE + 10_000;
      feedChainlink(store, now, 50_000);
      feedBook(store, 'binance', now, 50_050);
      feedBook(store, 'coinbase', now - 1_900, 50_050); // обе fresh, skew 1900 > 250

      const result = registry.evaluate('cex_chainlink_lead_lag', makeContext(store, now), {
        venues: ['binance', 'coinbase'],
      });
      expect(result).toBeUndefined();
    });

    it('строит lead-lag при увеличенном пороге skew', () => {
      const store = new CryptoMarketDataStore();
      const now = BASE + 10_000;
      feedChainlink(store, now, 50_000);
      feedBook(store, 'binance', now, 50_050);
      feedBook(store, 'coinbase', now - 1_900, 50_050);

      const result = registry.evaluate('cex_chainlink_lead_lag', makeContext(store, now), {
        venues: ['binance', 'coinbase'],
        maxCrossVenueSkewMs: 3_000,
      });
      expect(result).toBeDefined();
      expect(result!.components.crossVenueSkewMs).toBe(1_900);
    });
  });

  describe('#6 linear lead-lag требует ненулевые веса', () => {
    it('не строит сигнал без weights (иначе только intercept)', () => {
      const store = new CryptoMarketDataStore();
      const now = BASE + 10_000;
      feedChainlink(store, now, 50_000);
      feedBook(store, 'binance', now, 50_050);
      feedBook(store, 'coinbase', now, 50_050);

      const result = registry.evaluate('cex_chainlink_linear_lead_lag', makeContext(store, now), {
        venues: ['binance', 'coinbase'],
      });
      expect(result).toBeUndefined();
    });

    it('строит сигнал при заданных весах', () => {
      const store = new CryptoMarketDataStore();
      const now = BASE + 10_000;
      feedChainlink(store, now, 50_000);
      feedBook(store, 'binance', now, 50_050);
      feedBook(store, 'coinbase', now, 50_050);

      const result = registry.evaluate('cex_chainlink_linear_lead_lag', makeContext(store, now), {
        venues: ['binance', 'coinbase'],
        weights: { binance: 1, coinbase: 1 },
      });
      expect(result).toBeDefined();
      expect(result!.components.venueCount).toBe(2);
    });

    it('#5 linear отклоняет агрегат при cross-venue skew', () => {
      const store = new CryptoMarketDataStore();
      const now = BASE + 10_000;
      feedChainlink(store, now, 50_000);
      feedBook(store, 'binance', now, 50_050);
      feedBook(store, 'coinbase', now - 1_900, 50_050); // skew 1900 > 250

      const result = registry.evaluate('cex_chainlink_linear_lead_lag', makeContext(store, now), {
        venues: ['binance', 'coinbase'],
        weights: { binance: 1, coinbase: 1 },
      });
      expect(result).toBeUndefined();
    });
  });

  describe('chainlink stale guard в basis', () => {
    it('не выдаёт basis при устаревшем Chainlink', () => {
      const store = new CryptoMarketDataStore();
      const now = BASE + 10_000;
      feedChainlink(store, now - 5_000, 50_000); // chainlink age 5000 > 2000
      feedBook(store, 'binance', now, 50_010);
      feedBook(store, 'coinbase', now, 50_010);

      const ctx = makeContext(store, now);
      const result = registry.evaluate('cex_vs_chainlink_basis', ctx, {
        venues: ['binance', 'coinbase'],
      });

      expect(result).toBeUndefined();
    });
  });
});
