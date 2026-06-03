/**
 * Тесты CryptoResolutionStore:
 * - strike/resolution set/lock + normalization
 * - getResolution: resolutionPrice приоритет, fallback на Chainlink из reader
 * - контракт lock (no-op перезаписи)
 */

import { CryptoResolutionStore, type LatestPriceReader } from '../../src/CryptoResolutionStore.js';
import { CryptoMarketDataStore, type CryptoPriceSource, type CryptoPricePoint } from '../../src/CryptoMarketDataStore.js';

/**
 * Фейковый reader. `chainlink` — цена Chainlink (ts по умолчанию 0); `chainlinkTsMs`
 * задаёт timestamp для проверок свежести (#4).
 */
function makeReader(chainlink?: number, chainlinkTsMs = 0): LatestPriceReader {
  const point = (): CryptoPricePoint | undefined =>
    chainlink === undefined
      ? undefined
      : { asset: 'btc', source: 'polymarket_chainlink', price: chainlink, exchangeTsMs: chainlinkTsMs, receivedTsMs: chainlinkTsMs };
  return {
    getLatestPricePoint: (_s: string, source: CryptoPriceSource) =>
      source === 'polymarket_chainlink' ? point() : undefined,
    getNearestPricePoint: (_s: string, source: CryptoPriceSource, tsMs: number, maxDistanceMs: number) => {
      if (source !== 'polymarket_chainlink') return undefined;
      const p = point();
      return p && Math.abs(p.exchangeTsMs - tsMs) <= maxDistanceMs ? p : undefined;
    },
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

  describe('#3 startMarket', () => {
    it('сбрасывает прошлый resolution и locked target/resolution, ставит новый strike', () => {
      const store = new CryptoResolutionStore(makeReader());
      store.lockTargetPrice('btc', 49_000);
      store.lockResolutionPrice('btc', 49_500);

      store.startMarket({ symbolOrAsset: 'btc', targetPrice: 60_000 });

      // старый locked target/resolution сброшены, новый target взят
      expect(store.getTarget('btc')).toBe(60_000);
      expect(store.getResolutionPrice('btc')).toBeUndefined();
    });

    it('getResolution после startMarket не использует старый resolution', () => {
      const store = new CryptoResolutionStore(makeReader(55_000)); // chainlink 55000
      store.lockTargetPrice('btc', 50_000);
      store.lockResolutionPrice('btc', 49_000); // старый рынок → DOWN
      expect(store.getResolution('btc')).toBe('DOWN');

      store.startMarket({ symbolOrAsset: 'btc', targetPrice: 50_000 });
      // старый resolution 49000 сброшен → fallback на chainlink 55000 >= 50000 → UP
      expect(store.getResolution('btc')).toBe('UP');
    });

    it('startMarket без target только сбрасывает (strike доставится позже)', () => {
      const store = new CryptoResolutionStore(makeReader());
      store.lockTargetPrice('btc', 49_000);
      store.startMarket({ symbolOrAsset: 'btc', settlementTsMs: 5_000 });
      expect(store.hasTarget('btc')).toBe(false);
      // lock снят — поздний strike (Chainlink/kline) проходит
      store.setTargetPrice('btc', 51_000);
      expect(store.getTarget('btc')).toBe(51_000);
    });
  });

  describe('#3 resetAsset', () => {
    it('сбрасывает strike/resolution и locks при ротации', () => {
      const store = new CryptoResolutionStore(makeReader(50_000));
      store.lockTargetPrice('btc', 49_000);
      store.lockResolutionPrice('btc', 49_500);
      expect(store.getResolution('btc')).toBe('UP');

      store.resetAsset('btc');
      expect(store.getTarget('btc')).toBeUndefined();
      expect(store.getResolutionPrice('btc')).toBeUndefined();
      expect(store.getResolution('btc')).toBeUndefined();

      // После reset новый рынок может задать свой strike (lock снят)
      store.setTargetPrice('btc', 51_000);
      expect(store.getTarget('btc')).toBe(51_000);
    });
  });

  describe('#4 settlement-guard', () => {
    it('не резолвит рынок до истечения', () => {
      const store = new CryptoResolutionStore(makeReader(50_000));
      store.setTargetPrice('btc', 49_000);
      // nowMs < settlementTsMs → undefined, несмотря на наличие данных
      expect(store.getResolution('btc', { nowMs: 1_000, settlementTsMs: 2_000 })).toBeUndefined();
      // после истечения — резолвит
      expect(store.getResolution('btc', { nowMs: 2_000, settlementTsMs: 2_000 })).toBe('UP');
    });

    it('не резолвит по устаревшей Chainlink-цене (freshness)', () => {
      // chainlink ts=0, settlement в 20_000, maxLag 5_000 → цена слишком старая
      const store = new CryptoResolutionStore(makeReader(50_000, 0));
      store.setTargetPrice('btc', 49_000);
      expect(store.getResolution('btc', { nowMs: 20_000, settlementTsMs: 20_000, maxResolutionLagMs: 5_000 })).toBeUndefined();
      // свежая цена (в пределах лага) — резолвит
      const fresh = new CryptoResolutionStore(makeReader(50_000, 19_000));
      fresh.setTargetPrice('btc', 49_000);
      expect(fresh.getResolution('btc', { nowMs: 20_000, settlementTsMs: 20_000, maxResolutionLagMs: 5_000 })).toBe('UP');
    });

    it('settlementTsMs берётся из startMarket (lifecycle-state)', () => {
      const store = new CryptoResolutionStore(makeReader(50_000, 2_000));
      store.startMarket({ symbolOrAsset: 'btc', targetPrice: 49_000, settlementTsMs: 2_000 });
      // nowMs до settlement (из state) → undefined без явного settlementTsMs в opts
      expect(store.getResolution('btc', { nowMs: 1_000 })).toBeUndefined();
      // после — резолвит (chainlink ts=2000 рядом с settlement)
      expect(store.getResolution('btc', { nowMs: 2_000 })).toBe('UP');
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
