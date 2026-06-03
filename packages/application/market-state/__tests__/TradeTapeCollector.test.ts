/**
 * Тесты TradeTapeCollector (пассивный буфер, #1/#2).
 *
 * @remarks
 * Коллектор больше не подписывается на EventBus — данные через recordDirect(),
 * очистка через clearMarket(). recordDirect принимает опциональный marketId (#2):
 * он надёжнее каталога и закрывает дыру утечки для инструментов вне каталога.
 */
import { describe, it, expect } from '@jest/globals';
import { PaperClock } from '@polymarket/time';
import { TradeTapeCollector } from '../src/TradeTapeCollector.js';
import type { TradeTapeCollectorDeps } from '../src/TradeTapeCollector.js';
import type { ILogger } from '@polymarket/logger';
import type { InstrumentId, MarketId } from '@polymarket/ids';
import type { IMarketCatalog } from '@polymarket/ports';
import { Price, Quantity, TimestampService } from '@polymarket/value-objects';
import type { Timestamp, Side } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

function makeLogger(): ILogger {
  const noop = (): void => undefined;
  return {
    trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
    child: () => makeLogger(),
  } as unknown as ILogger;
}

function makeTs(ms: number): Timestamp {
  const r = TimestampService.create(ms);
  if (!r.ok) throw new Error(`bad ts ${ms}`);
  return r.value;
}
const px = (v: string): Price => Price.of(new Decimal(v));
const qty = (v: string): Quantity => Quantity.of(new Decimal(v));

const T0 = 1_700_000_000_000;
const TOKEN_A = 'token-a' as unknown as InstrumentId;
const TOKEN_B = 'token-b' as unknown as InstrumentId;
const MARKET_1 = 'market-1' as unknown as MarketId;
const MARKET_2 = 'market-2' as unknown as MarketId;

function makeCatalog(mapping: Map<string, string> = new Map()): IMarketCatalog {
  return {
    get: (id: InstrumentId) => {
      const marketId = mapping.get(String(id));
      return marketId ? ({ marketId } as unknown as ReturnType<IMarketCatalog['get']>) : undefined;
    },
  } as unknown as IMarketCatalog;
}

function makeDeps(catalog: IMarketCatalog = makeCatalog()): TradeTapeCollectorDeps {
  return { catalog, logger: makeLogger(), clock: new PaperClock(new Date(T0)) };
}

function rec(c: TradeTapeCollector, id: InstrumentId, side: Side, ms: number, marketId?: MarketId): void {
  c.recordDirect(id, px('0.65'), qty('100'), side, makeTs(ms), marketId);
}

describe('TradeTapeCollector (passive)', () => {
  describe('конструктор', () => {
    it('бросает RangeError на пустой политике', () => {
      expect(() => new TradeTapeCollector(makeDeps(), {})).toThrow(RangeError);
    });
  });

  describe('recordDirect', () => {
    it('лениво создаёт ленту и пишет трейд', () => {
      const c = new TradeTapeCollector(makeDeps(), { maxCount: 100 });
      expect(c.getTape(TOKEN_A)).toBeUndefined();
      rec(c, TOKEN_A, 'BUY', T0);
      expect(c.getTape(TOKEN_A)?.size()).toBe(1);
    });

    it('накапливает трейды', () => {
      const c = new TradeTapeCollector(makeDeps(), { maxCount: 100 });
      rec(c, TOKEN_A, 'BUY', T0);
      rec(c, TOKEN_A, 'SELL', T0 + 1000);
      expect(c.getTape(TOKEN_A)?.size()).toBe(2);
    });
  });

  describe('maxCount (FIFO)', () => {
    it('вытесняет старые трейды', () => {
      const c = new TradeTapeCollector(makeDeps(), { maxCount: 3 });
      for (let i = 0; i < 5; i++) rec(c, TOKEN_A, 'BUY', T0 + i * 1000);
      expect(c.getTape(TOKEN_A)?.size()).toBe(3);
    });
  });

  describe('clearMarket (#2)', () => {
    it('чистит по marketId из каталога', () => {
      const catalog = makeCatalog(new Map([[String(TOKEN_A), String(MARKET_1)]]));
      const c = new TradeTapeCollector(makeDeps(catalog), { maxCount: 100 });
      rec(c, TOKEN_A, 'BUY', T0);
      c.clearMarket(MARKET_1);
      expect(c.getTape(TOKEN_A)).toBeUndefined();
    });

    it('явный marketId в recordDirect перекрывает каталог (инструмент вне каталога)', () => {
      // Каталог НЕ знает TOKEN_A — без явного marketId лента не попала бы в индекс
      const c = new TradeTapeCollector(makeDeps(makeCatalog()), { maxCount: 100 });
      rec(c, TOKEN_A, 'BUY', T0, MARKET_1);
      expect(c.getTape(TOKEN_A)).toBeDefined();

      c.clearMarket(MARKET_1);
      expect(c.getTape(TOKEN_A)).toBeUndefined(); // дыра утечки закрыта
    });

    it('no-op для другого рынка', () => {
      const c = new TradeTapeCollector(makeDeps(), { maxCount: 100 });
      rec(c, TOKEN_A, 'BUY', T0, MARKET_1);
      c.clearMarket(MARKET_2);
      expect(c.getTape(TOKEN_A)).toBeDefined();
    });

    it('#1 поздняя регистрация marketId: первый трейд без marketId, потом с marketId — чистится', () => {
      // Каталог пуст, первый трейд без marketId → лента создана вне reverse index
      const c = new TradeTapeCollector(makeDeps(makeCatalog()), { maxCount: 100 });
      rec(c, TOKEN_A, 'BUY', T0);            // marketId неизвестен
      expect(c.getTape(TOKEN_A)).toBeDefined();

      rec(c, TOKEN_A, 'BUY', T0 + 1, MARKET_1); // marketId стал известен → поздняя регистрация
      c.clearMarket(MARKET_1);
      expect(c.getTape(TOKEN_A)).toBeUndefined(); // утечка закрыта
    });

    it('#1 трейд без marketId остаётся до clear(), но не ломает cleanup известных рынков', () => {
      const c = new TradeTapeCollector(makeDeps(makeCatalog()), { maxCount: 100 });
      rec(c, TOKEN_A, 'BUY', T0);            // marketId неизвестен — вне reverse index
      rec(c, TOKEN_B, 'BUY', T0, MARKET_1);  // известный рынок

      c.clearMarket(MARKET_1);
      expect(c.getTape(TOKEN_B)).toBeUndefined(); // известный рынок очищен
      expect(c.getTape(TOKEN_A)).toBeDefined();   // неизвестный остаётся (не падаем)

      c.clear();
      expect(c.getTape(TOKEN_A)).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('удаляет все ленты', () => {
      const c = new TradeTapeCollector(makeDeps(), { maxCount: 100 });
      rec(c, TOKEN_A, 'BUY', T0, MARKET_1);
      c.clear();
      expect(c.getTape(TOKEN_A)).toBeUndefined();
    });
  });
});
