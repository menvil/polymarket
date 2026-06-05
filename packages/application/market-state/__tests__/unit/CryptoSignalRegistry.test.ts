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

describe('CryptoSignalRegistry — покрытие сигналов', () => {
  const registry = createDefaultCryptoSignalRegistry();

  describe('M5b experimental-флаг', () => {
    it('диагностические помечены, торговые — нет', () => {
      expect(registry.isExperimental('cex_weighted_microprice_momentum')).toBe(true);
      expect(registry.isExperimental('cex_vs_chainlink_basis')).toBe(true);
      expect(registry.isExperimental('cex_chainlink_rolling_divergence')).toBe(true);
      expect(registry.isExperimental('cex_chainlink_lead_lag')).toBe(false);
      expect(registry.isExperimental('cex_chainlink_linear_lead_lag')).toBe(false);
    });
  });

  describe('U1 thresholdBps boundary (через basis)', () => {
    it('thresholdBps=0 и value=0 → flat, без NaN', () => {
      const store = new CryptoMarketDataStore();
      const now = BASE + 10_000;
      feedChainlink(store, now, 50_000);
      feedBook(store, 'binance', now, 50_000); // microprice == chainlink → value 0
      feedBook(store, 'coinbase', now, 50_000);

      const r = registry.evaluate('cex_vs_chainlink_basis', makeContext(store, now), {
        venues: ['binance', 'coinbase'], thresholdBps: 0,
      });
      expect(r).toBeDefined();
      expect(r!.direction).toBe('flat');
      expect(Number.isNaN(r!.strength)).toBe(false);
      expect(Number.isNaN(r!.confidence)).toBe(false);
      expect(r!.strength).toBe(0);
    });

    it('отрицательный thresholdBps нормализуется (не ломает direction)', () => {
      const store = new CryptoMarketDataStore();
      const now = BASE + 10_000;
      feedChainlink(store, now, 50_000);
      feedBook(store, 'binance', now, 50_050);
      feedBook(store, 'coinbase', now, 50_050);
      const r = registry.evaluate('cex_vs_chainlink_basis', makeContext(store, now), {
        venues: ['binance', 'coinbase'], thresholdBps: -1,
      });
      expect(r).toBeDefined();
      expect(r!.direction).toBe('up'); // value>0, threshold нормализован к MIN
      expect(Number.isFinite(r!.strength)).toBe(true);
    });
  });

  describe('cex_weighted_microprice_momentum', () => {
    it('растущий microprice → direction up', () => {
      const store = new CryptoMarketDataStore();
      const now = BASE + 10_000;
      // previous (lookback=1000 назад) и current
      feedBook(store, 'binance', now - 1_000, 50_000);
      feedBook(store, 'coinbase', now - 1_000, 50_000);
      feedBook(store, 'binance', now, 50_050);
      feedBook(store, 'coinbase', now, 50_050);

      const r = registry.evaluate('cex_weighted_microprice_momentum', makeContext(store, now), {
        venues: ['binance', 'coinbase'], lookbackMs: 1_000, thresholdBps: 0.5,
      });
      expect(r).toBeDefined();
      expect(r!.direction).toBe('up');
      expect(r!.value).toBeGreaterThan(0);
    });
  });

  describe('cex_chainlink_lead_lag confidence/agreement', () => {
    function feedUpSignal(store: CryptoMarketDataStore, now: number): void {
      feedChainlink(store, now, 50_000);
      // оба venue выше chainlink → положительный residual, согласие
      feedBook(store, 'binance', now, 50_100);
      feedBook(store, 'coinbase', now, 50_100);
    }

    it('agreement в components при согласии бирж', () => {
      const store = new CryptoMarketDataStore();
      const now = BASE + 10_000;
      feedUpSignal(store, now);
      const r = registry.evaluate('cex_chainlink_lead_lag', makeContext(store, now), {
        venues: ['binance', 'coinbase'], thresholdBps: 0.5,
      });
      expect(r).toBeDefined();
      expect(r!.direction).toBe('up');
      expect(r!.components.agreement).toBeGreaterThan(0);
      expect(r!.stale).toBe(false);
    });

    it('confidenceByScore переопределяет эвристику', () => {
      const store = new CryptoMarketDataStore();
      const now = BASE + 10_000;
      feedUpSignal(store, now);
      const r = registry.evaluate('cex_chainlink_lead_lag', makeContext(store, now), {
        venues: ['binance', 'coinbase'], thresholdBps: 0.5,
        confidenceByScore: { '10': 0.77 },
      });
      expect(r).toBeDefined();
      const bucket = Number(r!.components.scoreBucket);
      if (bucket === 10) expect(r!.confidence).toBe(0.77);
      expect(Boolean(r!.components.calibrated)).toBe(true);
    });
  });

  describe('cex_chainlink_linear_lead_lag', () => {
    it('intercept + веса дают предсказание', () => {
      const store = new CryptoMarketDataStore();
      const now = BASE + 10_000;
      feedChainlink(store, now, 50_000);
      feedBook(store, 'binance', now, 50_050);
      feedBook(store, 'coinbase', now, 50_050);
      const r = registry.evaluate('cex_chainlink_linear_lead_lag', makeContext(store, now), {
        venues: ['binance', 'coinbase'], weights: { binance: 1, coinbase: 1 },
        thresholdBps: 0.5,
      });
      expect(r).toBeDefined();
      expect(Number(r!.components.predDeltaUsd)).toBeGreaterThan(0);
    });
  });

  describe('cex_chainlink_rolling_divergence', () => {
    function feedSeries(store: CryptoMarketDataStore, now: number): void {
      for (const off of [3_000, 2_000, 1_000]) {
        feedChainlink(store, now - off, 50_000);
        feedBook(store, 'binance', now - off, 50_050);
        feedBook(store, 'coinbase', now - off, 50_050);
      }
      // текущее состояние
      feedChainlink(store, now, 50_000);
      feedBook(store, 'binance', now, 50_080);
      feedBook(store, 'coinbase', now, 50_080);
    }

    it('даёт результат при достаточном числе basis samples', () => {
      const store = new CryptoMarketDataStore();
      const now = BASE + 100_000;
      feedSeries(store, now);
      const r = registry.evaluate('cex_chainlink_rolling_divergence', makeContext(store, now), {
        venues: ['binance', 'coinbase'], minBasisSamples: 3, staleMs: 2_000, lookbackMs: 60_000,
      });
      expect(r).toBeDefined();
    });

    it('undefined при нехватке basis samples', () => {
      const store = new CryptoMarketDataStore();
      const now = BASE + 100_000;
      feedChainlink(store, now, 50_000);
      feedBook(store, 'binance', now, 50_080);
      feedBook(store, 'coinbase', now, 50_080);
      const r = registry.evaluate('cex_chainlink_rolling_divergence', makeContext(store, now), {
        venues: ['binance', 'coinbase'], minBasisSamples: 3,
      });
      expect(r).toBeUndefined();
    });
  });
});

describe('CryptoSignalRegistry — #1 sanitize офлайн-конфига', () => {
  const registry = createDefaultCryptoSignalRegistry();

  it('NaN basisByVenue не отравляет lead_lag (нет NaN в value/strength)', () => {
    const store = new CryptoMarketDataStore();
    const now = BASE + 10_000;
    feedChainlink(store, now, 50_000);
    feedBook(store, 'binance', now, 50_100);
    feedBook(store, 'coinbase', now, 50_100);
    const r = registry.evaluate('cex_chainlink_lead_lag', makeContext(store, now), {
      venues: ['binance', 'coinbase'],
      basisByVenue: { binance: Number.NaN, coinbase: Number.POSITIVE_INFINITY },
    });
    expect(r).toBeDefined();
    expect(Number.isFinite(r!.value)).toBe(true);
    expect(Number.isFinite(r!.strength)).toBe(true);
  });

  it('NaN linearInterceptUsd не отравляет linear', () => {
    const store = new CryptoMarketDataStore();
    const now = BASE + 10_000;
    feedChainlink(store, now, 50_000);
    feedBook(store, 'binance', now, 50_050);
    feedBook(store, 'coinbase', now, 50_050);
    const r = registry.evaluate('cex_chainlink_linear_lead_lag', makeContext(store, now), {
      venues: ['binance', 'coinbase'], weights: { binance: 1, coinbase: 1 },
      linearInterceptUsd: Number.NaN,
    });
    expect(r).toBeDefined();
    expect(Number.isFinite(r!.value)).toBe(true);
    expect(Number.isFinite(Number(r!.components.predDeltaUsd))).toBe(true);
  });

  it('confidenceByScore клампится в [0,1], NaN → fallback на эвристику', () => {
    const store = new CryptoMarketDataStore();
    const now = BASE + 10_000;
    feedChainlink(store, now, 50_000);
    feedBook(store, 'binance', now, 50_100);
    feedBook(store, 'coinbase', now, 50_100);

    const over = registry.evaluate('cex_chainlink_lead_lag', makeContext(store, now), {
      venues: ['binance', 'coinbase'], confidenceByScore: { '10': 1.5 },
    });
    expect(over!.confidence).toBeLessThanOrEqual(1);
    expect(over!.confidence).toBeGreaterThanOrEqual(0);

    const bad = registry.evaluate('cex_chainlink_lead_lag', makeContext(store, now), {
      venues: ['binance', 'coinbase'], confidenceByScore: { '10': Number.NaN },
    });
    expect(Number.isFinite(bad!.confidence)).toBe(true);
  });
});
