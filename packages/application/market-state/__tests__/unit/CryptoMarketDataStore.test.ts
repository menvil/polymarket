/**
 * Тесты Tier 1 для CryptoMarketDataStore:
 * - #6 look-ahead guard в recentTradePressure
 * - #5 трейды не дедуплицируются по timestamp
 * - #8 окна getRecent привязаны к nowMs
 * - #14 timestamp-guard на входе (отбраковка битых timestamp, защита prune)
 */

import { CryptoMarketDataStore } from '../../src/CryptoMarketDataStore.js';

/** Реалистичный epoch-ms база (≈2023-11), чтобы проходить MIN_PLAUSIBLE_EPOCH_MS. */
const BASE = 1_700_000_000_000;

describe('CryptoMarketDataStore — Tier 1', () => {
  describe('#6 look-ahead guard в recentTradePressure', () => {
    it('не учитывает трейды из будущего относительно времени снапшота книги', () => {
      const store = new CryptoMarketDataStore();

      // Трейд внутри окна (buy) и «будущий» трейд (sell) после времени книги.
      store.updateCexTrade({
        venue: 'binance', symbol: 'BTCUSDT',
        exchangeTsMs: BASE + 900, receivedTsMs: BASE + 900,
        price: 50_000, size: 1, side: 'buy',
      });
      store.updateCexTrade({
        venue: 'binance', symbol: 'BTCUSDT',
        exchangeTsMs: BASE + 2_000, receivedTsMs: BASE + 2_000,
        price: 50_000, size: 1, side: 'sell',
      });

      // Книга в момент BASE+1000: окно давления [BASE, BASE+1000].
      // Будущий sell (BASE+2000) должен быть пропущен → остаётся только buy → +1.
      store.updateCexBook({
        venue: 'binance', symbol: 'BTCUSDT',
        exchangeTsMs: BASE + 1_000, receivedTsMs: BASE + 1_000,
        bids: [[49_999, 2]], asks: [[50_001, 2]],
      });

      const state = store.getVenueState('btc')?.get('binance');
      expect(state).toBeDefined();
      expect(state!.recentTradePressure).toBe(1);
    });
  });

  describe('#5 трейды с одинаковым timestamp не теряются', () => {
    it('сохраняет несколько трейдов с одинаковым exchangeTsMs', () => {
      const store = new CryptoMarketDataStore();

      store.updateCexTrade({
        venue: 'binance', symbol: 'BTCUSDT',
        exchangeTsMs: BASE + 500, receivedTsMs: BASE + 500,
        price: 50_000, size: 1, side: 'buy',
      });
      store.updateCexTrade({
        venue: 'binance', symbol: 'BTCUSDT',
        exchangeTsMs: BASE + 500, receivedTsMs: BASE + 500,
        price: 50_010, size: 2, side: 'sell',
      });

      const trades = store.getVenueHistory('btc')?.getRecentTrades('binance', 10_000, BASE + 1_000);
      expect(trades).toHaveLength(2);
    });
  });

  describe('#8 окна getRecent привязаны к nowMs', () => {
    it('исключает устаревшие точки, если nowMs далеко впереди последнего тика', () => {
      const store = new CryptoMarketDataStore();
      store.updatePrice({
        symbol: 'btc/usd', price: 50_000,
        timestampMs: BASE + 1_000, receivedTsMs: BASE + 1_000, source: 'chainlink',
      });

      const view = store.getPriceHistory('btc')!;
      // legacy: окно от последнего тика → точка попадает.
      expect(view.getRecent('polymarket_chainlink', 1_000)).toHaveLength(1);
      // nowMs впереди: окно [BASE+9000, BASE+10000] → точка устарела, исключена.
      expect(view.getRecent('polymarket_chainlink', 1_000, BASE + 10_000)).toHaveLength(0);
    });

    it('исключает точки из будущего относительно nowMs (верхняя граница)', () => {
      const store = new CryptoMarketDataStore();
      store.updatePrice({
        symbol: 'btc/usd', price: 50_000,
        timestampMs: BASE + 1_000, receivedTsMs: BASE + 1_000, source: 'chainlink',
      });
      store.updatePrice({
        symbol: 'btc/usd', price: 50_100,
        timestampMs: BASE + 10_000, receivedTsMs: BASE + 10_000, source: 'chainlink',
      });

      const view = store.getPriceHistory('btc')!;
      const recent = view.getRecent('polymarket_chainlink', 5_000, BASE + 1_000);
      expect(recent).toHaveLength(1);
      expect(recent[0]!.price).toBe(50_000);
    });
  });

  describe('#4 top-N book storage', () => {
    function deepBook(levels: number): (readonly [number, number])[] {
      const bids: (readonly [number, number])[] = [];
      for (let i = 0; i < levels; i++) bids.push([50_000 - i, 1]);
      return bids;
    }

    it('обрезает стакан до maxBookLevels', () => {
      const store = new CryptoMarketDataStore({ maxBookLevels: 5 });
      store.updateCexBook({
        venue: 'binance', symbol: 'BTCUSDT', asset: 'btc',
        exchangeTsMs: BASE, receivedTsMs: BASE,
        bids: deepBook(30).map(([p]) => [p, 1] as const),
        asks: Array.from({ length: 30 }, (_, i) => [50_001 + i, 1] as const),
      });

      const books = store.getVenueHistory('btc')?.getRecentBooks('binance', 10_000, BASE + 100);
      expect(books).toHaveLength(1);
      expect(books![0]!.bids).toHaveLength(5);
      expect(books![0]!.asks).toHaveLength(5);
      // top-of-book сохранён
      expect(books![0]!.bids[0]![0]).toBe(50_000);
    });

    it('дефолтный лимит 20 уровней', () => {
      const store = new CryptoMarketDataStore();
      store.updateCexBook({
        venue: 'binance', symbol: 'BTCUSDT', asset: 'btc',
        exchangeTsMs: BASE, receivedTsMs: BASE,
        bids: Array.from({ length: 50 }, (_, i) => [50_000 - i, 1] as const),
        asks: Array.from({ length: 50 }, (_, i) => [50_001 + i, 1] as const),
      });

      const books = store.getVenueHistory('btc')?.getRecentBooks('binance', 10_000, BASE + 100);
      expect(books![0]!.bids).toHaveLength(20);
    });
  });

  describe('#7 material-move notify', () => {
    function feedBook(store: CryptoMarketDataStore, tsMs: number, mid: number): void {
      store.updateCexBook({
        venue: 'binance', symbol: 'BTCUSDT', asset: 'btc',
        exchangeTsMs: tsMs, receivedTsMs: tsMs,
        bids: [[mid - 1, 1]], asks: [[mid + 1, 1]],
      });
    }

    it('по умолчанию не уведомляет о CEX-движении', () => {
      const store = new CryptoMarketDataStore();
      const reasons: string[] = [];
      store.setOnChange((_asset, reason) => reasons.push(reason));

      feedBook(store, BASE, 50_000);
      feedBook(store, BASE + 100, 50_100);

      expect(reasons).toHaveLength(0);
    });

    it('будит только при движении ≥ materialMoveBps', () => {
      const store = new CryptoMarketDataStore({ materialMoveBps: 5, materialMoveMinIntervalMs: 50 });
      const reasons: string[] = [];
      store.setOnChange((_asset, reason) => reasons.push(reason));

      feedBook(store, BASE, 50_000);          // первое наблюдение — без события
      feedBook(store, BASE + 100, 50_001);    // +0.2 bps < 5 → молчим
      expect(reasons).toHaveLength(0);

      feedBook(store, BASE + 200, 50_050);    // +10 bps ≥ 5, интервал 200 ≥ 50 → событие
      expect(reasons).toEqual(['CRYPTO_MARKET_DATA']);
    });

    it('подавляет уведомления чаще materialMoveMinIntervalMs', () => {
      const store = new CryptoMarketDataStore({ materialMoveBps: 5, materialMoveMinIntervalMs: 500 });
      const reasons: string[] = [];
      store.setOnChange((_asset, reason) => reasons.push(reason));

      feedBook(store, BASE, 50_000);          // база
      feedBook(store, BASE + 50, 50_100);     // +20 bps, но интервал 50 < 500 → подавлено
      expect(reasons).toHaveLength(0);

      feedBook(store, BASE + 600, 50_100);    // тот же сдвиг от базы, интервал 600 ≥ 500 → событие
      expect(reasons).toEqual(['CRYPTO_MARKET_DATA']);
    });

    it('notifyCexChanges=true — сырой режим (на каждом апдейте)', () => {
      const store = new CryptoMarketDataStore({ notifyCexChanges: true });
      const reasons: string[] = [];
      store.setOnChange((_asset, reason) => reasons.push(reason));

      feedBook(store, BASE, 50_000);
      feedBook(store, BASE + 100, 50_000);

      expect(reasons).toEqual(['CRYPTO_MARKET_DATA', 'CRYPTO_MARKET_DATA']);
    });
  });

  describe('#14 timestamp-guard на входе', () => {
    it('отбраковывает timestamp в секундах (ниже плотного epoch-ms)', () => {
      const store = new CryptoMarketDataStore();
      store.updatePrice({
        symbol: 'btc/usd', price: 50_000,
        timestampMs: 1_700_000_000, receivedTsMs: BASE, source: 'chainlink',
      });
      expect(store.rejectedTickCount()).toBe(1);
      expect(store.getPriceHistory('btc')).toBeUndefined();
    });

    it('отбраковывает timestamp слишком далеко в будущем', () => {
      const store = new CryptoMarketDataStore({ maxFutureSkewMs: 5_000 });
      store.updatePrice({
        symbol: 'btc/usd', price: 50_000,
        timestampMs: BASE + 1_000_000, receivedTsMs: BASE, source: 'chainlink',
      });
      expect(store.rejectedTickCount()).toBe(1);
    });

    it('отбраковывает не-конечный timestamp', () => {
      const store = new CryptoMarketDataStore();
      store.updatePrice({
        symbol: 'btc/usd', price: 50_000,
        timestampMs: Number.NaN, receivedTsMs: BASE, source: 'chainlink',
      });
      expect(store.rejectedTickCount()).toBe(1);
    });

    it('битый будущий timestamp НЕ вычищает уже накопленную историю (защита prune)', () => {
      const store = new CryptoMarketDataStore();
      store.updatePrice({
        symbol: 'btc/usd', price: 50_000,
        timestampMs: BASE, receivedTsMs: BASE, source: 'chainlink',
      });
      // Битый тик на 1 час вперёд — без guard prune снёс бы реальную точку.
      store.updatePrice({
        symbol: 'btc/usd', price: 99_999,
        timestampMs: BASE + 3_600_000, receivedTsMs: BASE, source: 'chainlink',
      });

      const latest = store.getPriceHistory('btc')?.getLatest('polymarket_chainlink');
      expect(latest?.price).toBe(50_000);
      expect(store.rejectedTickCount()).toBe(1);
    });

    it('принимает валидный timestamp в пределах допустимого опережения', () => {
      const store = new CryptoMarketDataStore({ maxFutureSkewMs: 5_000 });
      store.updatePrice({
        symbol: 'btc/usd', price: 50_000,
        timestampMs: BASE + 1_000, receivedTsMs: BASE, source: 'chainlink',
      });
      expect(store.rejectedTickCount()).toBe(0);
      expect(store.getPriceHistory('btc')?.getLatest('polymarket_chainlink')?.price).toBe(50_000);
    });
  });
});
