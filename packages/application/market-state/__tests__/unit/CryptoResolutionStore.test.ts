/**
 * Тесты CryptoResolutionStore:
 * - strike/resolution set/lock + normalization
 * - getResolution: resolutionPrice приоритет, fallback на Chainlink из reader
 * - контракт lock (no-op перезаписи)
 */

import { CryptoResolutionStore, type LatestPriceReader } from '../../src/CryptoResolutionStore.js';
import { CryptoMarketDataStore, type CryptoPriceSource } from '../../src/CryptoMarketDataStore.js';

/** Фейковый reader последней цены. */
function makeReader(chainlink?: number): LatestPriceReader {
  return {
    getLatestPrice: (_s: string, source: CryptoPriceSource) =>
      source === 'polymarket_chainlink' ? chainlink : undefined,
  };
}

describe('CryptoResolutionStore', () => {
  describe('getResolution', () => {
    it('undefined без strike', () => {
      const store = new CryptoResolutionStore(makeReader(50_000));
      expect(store.getResolution('btc')).toBeUndefined();
    });

    it('по resolutionPrice (приоритет над Chainlink)', () => {
      const store = new CryptoResolutionStore(makeReader(40_000)); // chainlink ниже
      store.setTargetPrice('btc', 50_000);
      store.setResolutionPrice('btc', 50_001);
      expect(store.getResolution('btc')).toBe('UP'); // 50001 >= 50000
    });

    it('fallback на Chainlink из reader, если resolutionPrice нет', () => {
      const store = new CryptoResolutionStore(makeReader(49_999));
      store.setTargetPrice('btc', 50_000);
      expect(store.getResolution('btc')).toBe('DOWN'); // 49999 < 50000
    });

    it('undefined если нет ни resolutionPrice, ни Chainlink', () => {
      const store = new CryptoResolutionStore(makeReader(undefined));
      store.setTargetPrice('btc', 50_000);
      expect(store.getResolution('btc')).toBeUndefined();
    });
  });

  describe('lock', () => {
    it('lockTargetPrice блокирует перезапись setTargetPrice', () => {
      const store = new CryptoResolutionStore(makeReader());
      store.lockTargetPrice('btc', 70_000);
      store.setTargetPrice('btc', 99_999); // no-op
      expect(store.getTarget('btc')).toBe(70_000);
    });

    it('lockResolutionPrice блокирует перезапись setResolutionPrice', () => {
      const store = new CryptoResolutionStore(makeReader());
      store.lockResolutionPrice('btc', 71_000);
      store.setResolutionPrice('btc', 1); // no-op
      expect(store.getResolutionPrice('btc')).toBe(71_000);
    });
  });

  describe('нормализация ключа', () => {
    it('BTC/USD, btcusdt и btc — один актив', () => {
      const store = new CryptoResolutionStore(makeReader(50_000));
      store.setTargetPrice('BTC/USD', 49_000);
      expect(store.getTarget('btcusdt')).toBe(49_000);
      expect(store.hasTarget('btc')).toBe(true);
      expect(store.getResolution('BTCUSDT')).toBe('UP'); // chainlink 50000 >= 49000
    });
  });

  describe('интеграция с реальным CryptoMarketDataStore', () => {
    const BASE = 1_700_000_000_000;

    it('settlement: getResolution использует последнюю Chainlink-цену из marketData', () => {
      const marketData = new CryptoMarketDataStore();
      const resolution = new CryptoResolutionStore(marketData);

      // strike из priceToBeat
      resolution.lockTargetPrice('btc/usd', 50_000);
      // Chainlink тики идут в marketData (единый источник истины)
      marketData.updatePrice({ symbol: 'btc/usd', price: 49_500, timestampMs: BASE, receivedTsMs: BASE, source: 'chainlink' });
      marketData.updatePrice({ symbol: 'btc/usd', price: 50_250, timestampMs: BASE + 1000, receivedTsMs: BASE + 1000, source: 'chainlink' });

      // resolutionPrice не задан → fallback на последнюю Chainlink (50250 ≥ 50000)
      expect(resolution.getResolution('btc')).toBe('UP');
    });

    it('settlement: resolutionPrice (locked) имеет приоритет над Chainlink', () => {
      const marketData = new CryptoMarketDataStore();
      const resolution = new CryptoResolutionStore(marketData);

      resolution.lockTargetPrice('btc/usd', 50_000);
      marketData.updatePrice({ symbol: 'btc/usd', price: 60_000, timestampMs: BASE, receivedTsMs: BASE, source: 'chainlink' });
      // finalPrice из meta ниже strike → DOWN, несмотря на высокий Chainlink
      resolution.lockResolutionPrice('btc/usd', 49_000);

      expect(resolution.getResolution('btc')).toBe('DOWN');
    });
  });
});
