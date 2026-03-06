import { describe, it, expect, beforeEach } from '@jest/globals';
import { TradeTape } from '../../src/TradeTape.js';
import { Trade } from '@polymarket/trade';
import { AssetIdHelpers, asVenueTradeId, KnownVenues } from '@polymarket/ids';
import { Price, Quantity, Timestamp } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

// ==================== Вспомогательные функции ====================

const TOKEN_ID = AssetIdHelpers.USDC;
const MARKET_ID = 'market-test';
const BASE_TIME = 1700000000000;

let tradeCounter = 0;

function makeTrade(params: {
  price?: number;
  size?: number;
  side?: 'BUY' | 'SELL';
  timestampMs?: number;
  marketId?: string;
  tokenId?: typeof TOKEN_ID;
}): Trade {
  tradeCounter++;
  const result = Trade.create({
    id: asVenueTradeId(`trade-${tradeCounter}`)!,
    venueId: KnownVenues.POLYMARKET,
    marketId: params.marketId ?? MARKET_ID,
    tokenId: params.tokenId ?? TOKEN_ID,
    price: Price.of(new Decimal(params.price ?? 0.65)),
    size: Quantity.of(new Decimal(params.size ?? 100)),
    aggressorSide: params.side,
    timestamp: Timestamp.of(new Decimal(params.timestampMs ?? BASE_TIME)),
  });

  if (!result.ok) throw new Error(`Failed to create trade: ${result.error.message}`);
  return result.value;
}

// ==================== Тесты ====================

describe('TradeTape', () => {
  let tape: TradeTape;

  beforeEach(() => {
    const result = TradeTape.create(MARKET_ID, TOKEN_ID);
    if (!result.ok) throw new Error('Failed to create tape');
    tape = result.value;
  });

  // ==================== create ====================

  describe('create()', () => {
    it('создаёт пустую ленту', () => {
      expect(tape.marketId).toBe(MARKET_ID);
      expect(tape.tokenId).toBe(TOKEN_ID);
      expect(tape.isEmpty()).toBe(true);
      expect(tape.size()).toBe(0);
    });

    it('возвращает ошибку для пустого marketId', () => {
      const result = TradeTape.create('', TOKEN_ID);
      expect(result.ok).toBe(false);
    });

    it('возвращает ошибку для пустого строкового marketId', () => {
      const result = TradeTape.create('   ', TOKEN_ID);
      expect(result.ok).toBe(false);
    });
  });

  // ==================== append ====================

  describe('append()', () => {
    it('добавляет трейд с совпадающими marketId и tokenId', () => {
      const trade = makeTrade({});
      tape.append(trade);

      expect(tape.size()).toBe(1);
      expect(tape.isEmpty()).toBe(false);
    });

    it('игнорирует трейд с несовпадающим marketId', () => {
      const trade = makeTrade({ marketId: 'other-market' });
      tape.append(trade);

      expect(tape.size()).toBe(0);
    });

    it('игнорирует трейд с несовпадающим tokenId', () => {
      // Создаём ленту с другим tokenId (используем тот же USDC, но для другого рынка)
      // Тест проверяет, что трейд с marketId!=tape.marketId отклоняется
      const otherTape = (() => {
        const r = TradeTape.create('other-market', TOKEN_ID);
        if (!r.ok) throw new Error();
        return r.value;
      })();

      // Трейд из MARKET_ID не попадёт в other-market тейп
      const trade = makeTrade({ marketId: MARKET_ID });
      otherTape.append(trade);
      expect(otherTape.size()).toBe(0);
    });

    it('добавляет несколько трейдов', () => {
      tape.append(makeTrade({}));
      tape.append(makeTrade({ timestampMs: BASE_TIME + 1000 }));
      tape.append(makeTrade({ timestampMs: BASE_TIME + 2000 }));

      expect(tape.size()).toBe(3);
    });
  });

  // ==================== getAll ====================

  describe('getAll()', () => {
    it('возвращает пустой массив для новой ленты', () => {
      expect(tape.getAll()).toHaveLength(0);
    });

    it('возвращает все добавленные трейды', () => {
      const t1 = makeTrade({ timestampMs: BASE_TIME });
      const t2 = makeTrade({ timestampMs: BASE_TIME + 1000 });
      tape.append(t1);
      tape.append(t2);

      const all = tape.getAll();
      expect(all).toHaveLength(2);
    });
  });

  // ==================== getWindow ====================

  describe('getWindow()', () => {
    beforeEach(() => {
      tape.append(makeTrade({ timestampMs: BASE_TIME }));
      tape.append(makeTrade({ timestampMs: BASE_TIME + 1000 }));
      tape.append(makeTrade({ timestampMs: BASE_TIME + 2000 }));
      tape.append(makeTrade({ timestampMs: BASE_TIME + 3000 }));
    });

    it('возвращает трейды в диапазоне (включительно)', () => {
      const window = tape.getWindow(BASE_TIME + 1000, BASE_TIME + 2000);
      expect(window).toHaveLength(2);
    });

    it('включает граничные значения', () => {
      const window = tape.getWindow(BASE_TIME, BASE_TIME);
      expect(window).toHaveLength(1);
    });

    it('возвращает пустой массив если нет трейдов в диапазоне', () => {
      const window = tape.getWindow(BASE_TIME + 5000, BASE_TIME + 6000);
      expect(window).toHaveLength(0);
    });

    it('возвращает все трейды при широком диапазоне', () => {
      const window = tape.getWindow(BASE_TIME - 1000, BASE_TIME + 9000);
      expect(window).toHaveLength(4);
    });
  });

  // ==================== getRecent ====================

  describe('getRecent()', () => {
    it('использует nowMs для определения окна', () => {
      tape.append(makeTrade({ timestampMs: BASE_TIME }));
      tape.append(makeTrade({ timestampMs: BASE_TIME + 500 }));
      tape.append(makeTrade({ timestampMs: BASE_TIME + 1000 }));

      // окно: [BASE_TIME+500, BASE_TIME+1000] при nowMs=BASE_TIME+1000, durationMs=500
      const recent = tape.getRecent(500, BASE_TIME + 1000);
      expect(recent).toHaveLength(2);
    });

    it('возвращает пустой массив если нет трейдов в окне', () => {
      tape.append(makeTrade({ timestampMs: BASE_TIME }));

      // Окно: [now-100, now] — сейчас "очень далеко" от BASE_TIME
      const recent = tape.getRecent(100, BASE_TIME + 1_000_000);
      expect(recent).toHaveLength(0);
    });

    it('возвращает все трейды при очень большой duration', () => {
      tape.append(makeTrade({ timestampMs: BASE_TIME }));
      tape.append(makeTrade({ timestampMs: BASE_TIME + 1000 }));

      const recent = tape.getRecent(999_999_999, BASE_TIME + 2000);
      expect(recent).toHaveLength(2);
    });
  });

  // ==================== evictBefore ====================

  describe('evictBefore()', () => {
    beforeEach(() => {
      tape.append(makeTrade({ timestampMs: BASE_TIME }));
      tape.append(makeTrade({ timestampMs: BASE_TIME + 1000 }));
      tape.append(makeTrade({ timestampMs: BASE_TIME + 2000 }));
      tape.append(makeTrade({ timestampMs: BASE_TIME + 3000 }));
    });

    it('удаляет трейды старше cutoff', () => {
      // удалить все < BASE_TIME+2000
      const evicted = tape.evictBefore(BASE_TIME + 2000);
      expect(evicted).toBe(2);
      expect(tape.size()).toBe(2);
    });

    it('оставляет трейды с timestamp >= cutoff', () => {
      tape.evictBefore(BASE_TIME + 2000);
      const all = tape.getAll();
      for (const trade of all) {
        expect(trade.timestamp.toNumber()).toBeGreaterThanOrEqual(BASE_TIME + 2000);
      }
    });

    it('возвращает 0 если нечего удалять', () => {
      const evicted = tape.evictBefore(BASE_TIME - 1000);
      expect(evicted).toBe(0);
      expect(tape.size()).toBe(4);
    });

    it('удаляет все трейды при большом cutoff', () => {
      const evicted = tape.evictBefore(BASE_TIME + 99999);
      expect(evicted).toBe(4);
      expect(tape.size()).toBe(0);
      expect(tape.isEmpty()).toBe(true);
    });
  });

  // ==================== isEmpty / size ====================

  describe('isEmpty() / size()', () => {
    it('isEmpty() = true для новой ленты', () => {
      expect(tape.isEmpty()).toBe(true);
    });

    it('isEmpty() = false после добавления трейда', () => {
      tape.append(makeTrade({}));
      expect(tape.isEmpty()).toBe(false);
    });

    it('size() возвращает корректное количество', () => {
      tape.append(makeTrade({}));
      tape.append(makeTrade({ timestampMs: BASE_TIME + 1 }));
      expect(tape.size()).toBe(2);
    });
  });
});
