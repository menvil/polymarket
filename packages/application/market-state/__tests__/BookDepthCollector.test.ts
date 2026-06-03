/**
 * Тесты BookDepthCollector (пассивный буфер, #1).
 *
 * @remarks
 * Коллектор больше не подписывается на EventBus — данные приходят через
 * recordDirect(), очистка через clearMarket(). Покрывает:
 * - конструктор (валидация политики)
 * - recordDirect: ленивое создание истории, накопление
 * - политика maxCount / maxAgeMs
 * - clearMarket: cleanup рынка, no-op для неизвестного
 * - getHistory / instrumentCount / clear
 */
import { describe, it, expect } from '@jest/globals';
import { PaperClock } from '@polymarket/time';
import { BookDepthCollector } from '../src/BookDepthCollector.js';
import type { BookDepthCollectorDeps } from '../src/BookDepthCollector.js';
import type { ILogger } from '@polymarket/logger';
import type { InstrumentId } from '@polymarket/ids';
import type { OrderBookSnapshot } from '@polymarket/order-book';

function makeLogger(): ILogger {
  const noop = (): void => undefined;
  return {
    trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
    child: () => makeLogger(),
  } as unknown as ILogger;
}

function makeSnapshot(marketId: string, tokenId: string): OrderBookSnapshot {
  return { marketId, tokenId, bids: [], asks: [], timestamp: undefined } as unknown as OrderBookSnapshot;
}

const T0 = 1_700_000_000_000;
const TOKEN_A = 'token-a' as unknown as InstrumentId;
const TOKEN_B = 'token-b' as unknown as InstrumentId;

function makeDeps(): BookDepthCollectorDeps {
  return { logger: makeLogger(), clock: new PaperClock(new Date(T0)) };
}

describe('BookDepthCollector (passive)', () => {
  describe('конструктор', () => {
    it('бросает RangeError на пустой политике', () => {
      expect(() => new BookDepthCollector(makeDeps(), {})).toThrow(RangeError);
    });

    it('принимает maxCount или maxAgeMs', () => {
      expect(() => new BookDepthCollector(makeDeps(), { maxCount: 100 })).not.toThrow();
      expect(() => new BookDepthCollector(makeDeps(), { maxAgeMs: 60_000 })).not.toThrow();
    });
  });

  describe('recordDirect', () => {
    it('лениво создаёт историю и пишет снапшот', () => {
      const c = new BookDepthCollector(makeDeps(), { maxCount: 100 });
      expect(c.getHistory(TOKEN_A)).toBeUndefined();

      c.recordDirect(TOKEN_A, makeSnapshot('market-1', String(TOKEN_A)), T0);
      expect(c.getHistory(TOKEN_A)?.size()).toBe(1);
    });

    it('накапливает несколько снапшотов', () => {
      const c = new BookDepthCollector(makeDeps(), { maxCount: 100 });
      for (let i = 0; i < 3; i++) {
        c.recordDirect(TOKEN_A, makeSnapshot('market-1', String(TOKEN_A)), T0 + i * 1000);
      }
      expect(c.getHistory(TOKEN_A)?.size()).toBe(3);
    });

    it('изолирует истории по инструментам', () => {
      const c = new BookDepthCollector(makeDeps(), { maxCount: 100 });
      c.recordDirect(TOKEN_A, makeSnapshot('market-1', String(TOKEN_A)), T0);
      c.recordDirect(TOKEN_B, makeSnapshot('market-1', String(TOKEN_B)), T0);
      expect(c.instrumentCount()).toBe(2);
    });
  });

  describe('maxCount (FIFO)', () => {
    it('вытесняет старые снапшоты при превышении', () => {
      const c = new BookDepthCollector(makeDeps(), { maxCount: 3 });
      for (let i = 0; i < 5; i++) {
        c.recordDirect(TOKEN_A, makeSnapshot('market-1', String(TOKEN_A)), T0 + i * 1000);
      }
      expect(c.getHistory(TOKEN_A)?.size()).toBe(3);
    });
  });

  describe('clearMarket', () => {
    it('удаляет истории всех инструментов рынка', () => {
      const c = new BookDepthCollector(makeDeps(), { maxCount: 100 });
      c.recordDirect(TOKEN_A, makeSnapshot('market-1', String(TOKEN_A)), T0);
      c.recordDirect(TOKEN_B, makeSnapshot('market-1', String(TOKEN_B)), T0);
      expect(c.instrumentCount()).toBe(2);

      c.clearMarket('market-1');
      expect(c.getHistory(TOKEN_A)).toBeUndefined();
      expect(c.getHistory(TOKEN_B)).toBeUndefined();
      expect(c.instrumentCount()).toBe(0);
    });

    it('no-op для неизвестного рынка', () => {
      const c = new BookDepthCollector(makeDeps(), { maxCount: 100 });
      c.recordDirect(TOKEN_A, makeSnapshot('market-1', String(TOKEN_A)), T0);
      c.clearMarket('market-unknown');
      expect(c.getHistory(TOKEN_A)).toBeDefined();
      expect(c.instrumentCount()).toBe(1);
    });
  });

  describe('clear', () => {
    it('удаляет все истории', () => {
      const c = new BookDepthCollector(makeDeps(), { maxCount: 100 });
      c.recordDirect(TOKEN_A, makeSnapshot('market-1', String(TOKEN_A)), T0);
      c.recordDirect(TOKEN_B, makeSnapshot('market-2', String(TOKEN_B)), T0);
      c.clear();
      expect(c.instrumentCount()).toBe(0);
    });
  });
});
