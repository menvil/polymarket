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
import type { BookDepthCollectorDeps, BookDepthCollectorConfig } from '../src/BookDepthCollector.js';
import type { ILogger } from '@polymarket/logger';
import type { InstrumentId, MarketId } from '@polymarket/ids';
import { Orderbook } from '@polymarket/orderbook';
import { TimestampService } from '@polymarket/timestamp';
import type { Timestamp } from '@polymarket/timestamp';
import { KnownVenues } from '@polymarket/ids';

/** Разворачивает `Result` для тестов, где конфиг заведомо валиден. */
function makeCollector(
  deps: BookDepthCollectorDeps,
  config: BookDepthCollectorConfig,
): BookDepthCollector {
  const result = BookDepthCollector.create(deps, config);
  if (!result.ok) throw result.error;
  return result.value;
}

function makeLogger(): ILogger {
  const noop = (): void => undefined;
  return {
    trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
    child: () => makeLogger(),
  } as unknown as ILogger;
}

/** Создаёт Timestamp VO из миллисекунд (бросает если невалидный) */
function makeTimestamp(ms: number): Timestamp {
  const result = TimestampService.create(ms);
  if (!result.ok) throw new Error(`Invalid timestamp: ${ms}`);
  return result.value;
}

/** Создаёт пустой (без уровней) Orderbook — content самих bids/asks не важен для этих тестов. */
function makeBook(marketId: string, tokenId: InstrumentId, receivedAtMs: number): Orderbook {
  return Orderbook.fromLevels({
      venueId: KnownVenues.POLYMARKET,
      marketId: marketId as unknown as MarketId,
      instrumentId: tokenId,
      bids: [],
      asks: [],
      receivedAt: makeTimestamp(receivedAtMs),
    });
}

const T0 = 1_700_000_000_000;
const TOKEN_A = 'token-a' as unknown as InstrumentId;
const TOKEN_B = 'token-b' as unknown as InstrumentId;

function makeDeps(): BookDepthCollectorDeps {
  return { logger: makeLogger(), clock: new PaperClock(new Date(T0)) };
}

describe('BookDepthCollector (passive)', () => {
  describe('create', () => {
    it('возвращает Err на пустой политике', () => {
      const result = BookDepthCollector.create(makeDeps(), {});
      expect(result.ok).toBe(false);
    });

    it('возвращает Ok при maxCount или maxAgeMs', () => {
      expect(BookDepthCollector.create(makeDeps(), { maxCount: 100 }).ok).toBe(true);
      expect(BookDepthCollector.create(makeDeps(), { maxAgeMs: 60_000 }).ok).toBe(true);
    });
  });

  describe('recordDirect', () => {
    it('лениво создаёт историю и пишет снапшот', () => {
      const c = makeCollector(makeDeps(), { maxCount: 100 });
      expect(c.getHistory(TOKEN_A)).toBeUndefined();

      c.recordDirect(TOKEN_A, makeBook('market-1', TOKEN_A, T0));
      expect(c.getHistory(TOKEN_A)?.size()).toBe(1);
    });

    it('накапливает несколько снапшотов', () => {
      const c = makeCollector(makeDeps(), { maxCount: 100 });
      for (let i = 0; i < 3; i++) {
        c.recordDirect(TOKEN_A, makeBook('market-1', TOKEN_A, T0 + i * 1000));
      }
      expect(c.getHistory(TOKEN_A)?.size()).toBe(3);
    });

    it('изолирует истории по инструментам', () => {
      const c = makeCollector(makeDeps(), { maxCount: 100 });
      c.recordDirect(TOKEN_A, makeBook('market-1', TOKEN_A, T0));
      c.recordDirect(TOKEN_B, makeBook('market-1', TOKEN_B, T0));
      expect(c.instrumentCount()).toBe(2);
    });
  });

  describe('maxCount (FIFO)', () => {
    it('вытесняет старые снапшоты при превышении', () => {
      const c = makeCollector(makeDeps(), { maxCount: 3 });
      for (let i = 0; i < 5; i++) {
        c.recordDirect(TOKEN_A, makeBook('market-1', TOKEN_A, T0 + i * 1000));
      }
      expect(c.getHistory(TOKEN_A)?.size()).toBe(3);
    });
  });

  describe('clearMarket', () => {
    it('удаляет истории всех инструментов рынка', () => {
      const c = makeCollector(makeDeps(), { maxCount: 100 });
      c.recordDirect(TOKEN_A, makeBook('market-1', TOKEN_A, T0));
      c.recordDirect(TOKEN_B, makeBook('market-1', TOKEN_B, T0));
      expect(c.instrumentCount()).toBe(2);

      c.clearMarket('market-1' as unknown as MarketId);
      expect(c.getHistory(TOKEN_A)).toBeUndefined();
      expect(c.getHistory(TOKEN_B)).toBeUndefined();
      expect(c.instrumentCount()).toBe(0);
    });

    it('no-op для неизвестного рынка', () => {
      const c = makeCollector(makeDeps(), { maxCount: 100 });
      c.recordDirect(TOKEN_A, makeBook('market-1', TOKEN_A, T0));
      c.clearMarket('market-unknown' as unknown as MarketId);
      expect(c.getHistory(TOKEN_A)).toBeDefined();
      expect(c.instrumentCount()).toBe(1);
    });

    it('#U4 смена marketId у инструмента → чистится по новому рынку', () => {
      const c = makeCollector(makeDeps(), { maxCount: 100 });
      c.recordDirect(TOKEN_A, makeBook('market-1', TOKEN_A, T0));
      c.recordDirect(TOKEN_A, makeBook('market-2', TOKEN_A, T0 + 1)); // «переехал»

      c.clearMarket('market-1' as unknown as MarketId); // старый рынок — инструмент уже не там
      expect(c.getHistory(TOKEN_A)).toBeDefined();
      c.clearMarket('market-2' as unknown as MarketId); // новый рынок — чистится
      expect(c.getHistory(TOKEN_A)).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('удаляет все истории', () => {
      const c = makeCollector(makeDeps(), { maxCount: 100 });
      c.recordDirect(TOKEN_A, makeBook('market-1', TOKEN_A, T0));
      c.recordDirect(TOKEN_B, makeBook('market-2', TOKEN_B, T0));
      c.clear();
      expect(c.instrumentCount()).toBe(0);
    });
  });
});
