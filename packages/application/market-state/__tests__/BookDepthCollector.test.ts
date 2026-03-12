/**
 * Тесты BookDepthCollector.
 *
 * @remarks
 * Покрывает:
 * - start() / stop(): подписка и отписка от событий
 * - BOOK_DEPTH: запись снапшотов в историю per tokenId
 * - Ленивое создание OrderBookHistory при первом снапшоте
 * - MARKET_CLOSED: cleanup историй для закрытого рынка
 * - getHistory(): возвращает историю или undefined
 * - Политика хранения (maxCount) применяется корректно
 * - instrumentCount() / clear()
 * - Повторный start() не создаёт дублирующих подписок
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { BookDepthCollector } from '../src/BookDepthCollector.js';
import type { BookDepthCollectorDeps } from '../src/BookDepthCollector.js';
import type { IEventBus } from '@polymarket/event-bus';
import type { ApplicationEvent } from '@polymarket/event-bus';
import type { ILogger } from '@polymarket/logger';
import type { InstrumentId, MarketId } from '@polymarket/ids';
import type { OrderBookSnapshot } from '@polymarket/order-book';
import { TimestampService } from '@polymarket/value-objects';
import type { Timestamp, Money } from '@polymarket/value-objects';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeTimestamp(ms: number): Timestamp {
  const result = TimestampService.create(ms);
  if (!result.ok) throw new Error(`Invalid ts: ${ms}`);
  return result.value;
}

function makeLogger(): ILogger {
  return {
    trace: jest.fn() as ILogger['trace'],
    debug: jest.fn() as ILogger['debug'],
    info:  jest.fn() as ILogger['info'],
    warn:  jest.fn() as ILogger['warn'],
    error: jest.fn() as ILogger['error'],
    fatal: jest.fn() as ILogger['fatal'],
    child: jest.fn() as ILogger['child'],
  };
}

/** Минимальный снапшот стакана для тестов */
function makeSnapshot(marketId: string, tokenId: string): OrderBookSnapshot {
  return { marketId, tokenId, bids: [], asks: [], timestamp: undefined };
}

/** Базовое время */
const T0 = 1_700_000_000_000;

const TOKEN_A   = 'token-a'   as unknown as InstrumentId;
const TOKEN_B   = 'token-b'   as unknown as InstrumentId;
const MARKET_1  = 'market-1'  as unknown as MarketId;

// ── EventBus stub ──────────────────────────────────────────────────────────────

/**
 * Простой stub EventBus: handlers хранятся по типу события,
 * emit() вызывает все подписчики синхронно (для тестов достаточно).
 */
function makeEventBus(): IEventBus & {
  emit(event: ApplicationEvent): Promise<void>;
} {
  const handlers = new Map<string, Array<(e: ApplicationEvent) => Promise<void>>>();

  const subscribe = jest.fn(<K extends ApplicationEvent['type']>(
    type: K,
    handler: (e: Extract<ApplicationEvent, { type: K }>) => Promise<void>,
  ) => {
    if (!handlers.has(type)) handlers.set(type, []);
    handlers.get(type)!.push(handler as (e: ApplicationEvent) => Promise<void>);
    return () => {
      const arr = handlers.get(type) ?? [];
      const idx = arr.indexOf(handler as (e: ApplicationEvent) => Promise<void>);
      if (idx >= 0) arr.splice(idx, 1);
    };
  });

  const publish = jest.fn(async (event: ApplicationEvent) => {
    for (const h of handlers.get(event.type) ?? []) await h(event);
  });

  const emit = async (event: ApplicationEvent) => {
    for (const h of handlers.get(event.type) ?? []) await h(event);
  };

  return { subscribe, publish, emit } as unknown as IEventBus & {
    emit(event: ApplicationEvent): Promise<void>;
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('BookDepthCollector', () => {
  let eventBus: ReturnType<typeof makeEventBus>;
  let logger: ILogger;
  let deps: BookDepthCollectorDeps;

  beforeEach(() => {
    eventBus = makeEventBus();
    logger = makeLogger();
    deps = { eventBus, logger };
  });

  // ── start / stop ─────────────────────────────────────────────────────────────

  describe('start() / stop()', () => {
    it('start() подписывается на BOOK_DEPTH и MARKET_CLOSED', () => {
      const collector = new BookDepthCollector(deps, { maxCount: 100 });
      collector.start();
      expect(eventBus.subscribe).toHaveBeenCalledWith('BOOK_DEPTH', expect.any(Function));
      expect(eventBus.subscribe).toHaveBeenCalledWith('MARKET_CLOSED', expect.any(Function));
    });

    it('stop() отписывается — последующие события игнорируются', async () => {
      const collector = new BookDepthCollector(deps, { maxCount: 100 });
      collector.start();
      collector.stop();

      await eventBus.emit({
        type: 'BOOK_DEPTH',
        instrumentId: TOKEN_A,
        snapshot: makeSnapshot('market-1', String(TOKEN_A)),
        timestamp: makeTimestamp(T0),
      });

      expect(collector.getHistory(TOKEN_A)).toBeUndefined();
    });

    it('повторный start() не создаёт дублирующих подписок', async () => {
      const collector = new BookDepthCollector(deps, { maxCount: 100 });
      collector.start();
      collector.start(); // второй start

      await eventBus.emit({
        type: 'BOOK_DEPTH',
        instrumentId: TOKEN_A,
        snapshot: makeSnapshot('market-1', String(TOKEN_A)),
        timestamp: makeTimestamp(T0),
      });

      // Должен быть ровно 1 снапшот, не 2
      expect(collector.getHistory(TOKEN_A)?.size()).toBe(1);
    });
  });

  // ── BOOK_DEPTH → запись ───────────────────────────────────────────────────────

  describe('запись снапшотов (BOOK_DEPTH)', () => {
    it('создаёт историю лениво при первом снапшоте', async () => {
      const collector = new BookDepthCollector(deps, { maxCount: 100 });
      collector.start();

      expect(collector.getHistory(TOKEN_A)).toBeUndefined();

      await eventBus.emit({
        type: 'BOOK_DEPTH',
        instrumentId: TOKEN_A,
        snapshot: makeSnapshot('market-1', String(TOKEN_A)),
        timestamp: makeTimestamp(T0),
      });

      expect(collector.getHistory(TOKEN_A)).toBeDefined();
      expect(collector.getHistory(TOKEN_A)?.size()).toBe(1);
    });

    it('накапливает несколько снапшотов для одного инструмента', async () => {
      const collector = new BookDepthCollector(deps, { maxCount: 100 });
      collector.start();

      for (let i = 0; i < 5; i++) {
        await eventBus.emit({
          type: 'BOOK_DEPTH',
          instrumentId: TOKEN_A,
          snapshot: makeSnapshot('market-1', String(TOKEN_A)),
          timestamp: makeTimestamp(T0 + i * 1000),
        });
      }

      expect(collector.getHistory(TOKEN_A)?.size()).toBe(5);
    });

    it('ведёт раздельные истории для разных инструментов', async () => {
      const collector = new BookDepthCollector(deps, { maxCount: 100 });
      collector.start();

      await eventBus.emit({
        type: 'BOOK_DEPTH',
        instrumentId: TOKEN_A,
        snapshot: makeSnapshot('market-1', String(TOKEN_A)),
        timestamp: makeTimestamp(T0),
      });
      await eventBus.emit({
        type: 'BOOK_DEPTH',
        instrumentId: TOKEN_A,
        snapshot: makeSnapshot('market-1', String(TOKEN_A)),
        timestamp: makeTimestamp(T0 + 1000),
      });
      await eventBus.emit({
        type: 'BOOK_DEPTH',
        instrumentId: TOKEN_B,
        snapshot: makeSnapshot('market-2', String(TOKEN_B)),
        timestamp: makeTimestamp(T0),
      });

      expect(collector.getHistory(TOKEN_A)?.size()).toBe(2);
      expect(collector.getHistory(TOKEN_B)?.size()).toBe(1);
      expect(collector.instrumentCount()).toBe(2);
    });

    it('применяет политику maxCount (FIFO)', async () => {
      const collector = new BookDepthCollector(deps, { maxCount: 3 });
      collector.start();

      for (let i = 0; i < 5; i++) {
        await eventBus.emit({
          type: 'BOOK_DEPTH',
          instrumentId: TOKEN_A,
          snapshot: makeSnapshot('market-1', String(TOKEN_A)),
          timestamp: makeTimestamp(T0 + i * 1000),
        });
      }

      // maxCount=3 → только последние 3
      expect(collector.getHistory(TOKEN_A)?.size()).toBe(3);
    });

    it('использует timestamp из события как nowMs', async () => {
      const collector = new BookDepthCollector(deps, { maxAgeMs: 60_000 });
      collector.start();

      // Добавляем снапшот в T0
      await eventBus.emit({
        type: 'BOOK_DEPTH',
        instrumentId: TOKEN_A,
        snapshot: makeSnapshot('market-1', String(TOKEN_A)),
        timestamp: makeTimestamp(T0),
      });

      // Добавляем новый снапшот через 90s — старый должен вытесниться (60s retention)
      await eventBus.emit({
        type: 'BOOK_DEPTH',
        instrumentId: TOKEN_A,
        snapshot: makeSnapshot('market-1', String(TOKEN_A)),
        timestamp: makeTimestamp(T0 + 90_000),
      });

      expect(collector.getHistory(TOKEN_A)?.size()).toBe(1);
    });
  });

  // ── MARKET_CLOSED → cleanup ───────────────────────────────────────────────────

  describe('cleanup при MARKET_CLOSED', () => {
    it('удаляет историю токенов закрытого рынка', async () => {
      const collector = new BookDepthCollector(deps, { maxCount: 100 });
      collector.start();

      await eventBus.emit({
        type: 'BOOK_DEPTH',
        instrumentId: TOKEN_A,
        snapshot: makeSnapshot(String(MARKET_1), String(TOKEN_A)),
        timestamp: makeTimestamp(T0),
      });

      expect(collector.getHistory(TOKEN_A)).toBeDefined();

      await eventBus.emit({
        type: 'MARKET_CLOSED',
        marketId: MARKET_1,
        reason: 'EXPIRED',
        timestamp: makeTimestamp(T0 + 1000),
        realizedPnL: {} as Money,
      });

      expect(collector.getHistory(TOKEN_A)).toBeUndefined();
      expect(collector.instrumentCount()).toBe(0);
    });

    it('не трогает историю других рынков при закрытии', async () => {
      const collector = new BookDepthCollector(deps, { maxCount: 100 });
      collector.start();

      const MARKET_2 = 'market-2' as unknown as MarketId;

      await eventBus.emit({
        type: 'BOOK_DEPTH',
        instrumentId: TOKEN_A,
        snapshot: makeSnapshot(String(MARKET_1), String(TOKEN_A)),
        timestamp: makeTimestamp(T0),
      });
      await eventBus.emit({
        type: 'BOOK_DEPTH',
        instrumentId: TOKEN_B,
        snapshot: makeSnapshot(String(MARKET_2), String(TOKEN_B)),
        timestamp: makeTimestamp(T0),
      });

      // Закрываем только market-1
      await eventBus.emit({
        type: 'MARKET_CLOSED',
        marketId: MARKET_1,
        reason: 'EXPIRED',
        timestamp: makeTimestamp(T0 + 1000),
        realizedPnL: {} as Money,
      });

      expect(collector.getHistory(TOKEN_A)).toBeUndefined();
      expect(collector.getHistory(TOKEN_B)).toBeDefined(); // market-2 не тронут
    });
  });

  // ── getHistory / instrumentCount / clear ──────────────────────────────────────

  describe('getHistory() / instrumentCount() / clear()', () => {
    it('getHistory() возвращает undefined если снапшотов не было', () => {
      const collector = new BookDepthCollector(deps, { maxCount: 100 });
      collector.start();
      expect(collector.getHistory(TOKEN_A)).toBeUndefined();
    });

    it('instrumentCount() возвращает количество активных инструментов', async () => {
      const collector = new BookDepthCollector(deps, { maxCount: 100 });
      collector.start();

      expect(collector.instrumentCount()).toBe(0);

      await eventBus.emit({
        type: 'BOOK_DEPTH',
        instrumentId: TOKEN_A,
        snapshot: makeSnapshot('market-1', String(TOKEN_A)),
        timestamp: makeTimestamp(T0),
      });

      expect(collector.instrumentCount()).toBe(1);
    });

    it('clear() удаляет все истории', async () => {
      const collector = new BookDepthCollector(deps, { maxCount: 100 });
      collector.start();

      await eventBus.emit({
        type: 'BOOK_DEPTH',
        instrumentId: TOKEN_A,
        snapshot: makeSnapshot('market-1', String(TOKEN_A)),
        timestamp: makeTimestamp(T0),
      });

      expect(collector.instrumentCount()).toBe(1);
      collector.clear();
      expect(collector.instrumentCount()).toBe(0);
      expect(collector.getHistory(TOKEN_A)).toBeUndefined();
    });
  });
});
