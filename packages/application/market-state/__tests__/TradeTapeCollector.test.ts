/**
 * Тесты TradeTapeCollector.
 *
 * @remarks
 * Покрывает:
 * - Конфиг-валидация (RangeError если пустой конфиг)
 * - start() / stop(): подписка и отписка
 * - TRADE_RECEIVED: запись трейдов per tokenId
 * - Ленивое создание TradeTape при первом трейде
 * - Раздельные ленты для разных инструментов
 * - maxCount FIFO (обрабатывается внутри TradeTape)
 * - maxAgeMs авто-вытеснение (обрабатывается внутри TradeTape)
 * - MARKET_CLOSED: cleanup лент закрытого рынка
 * - getTape(): возвращает TradeTape или undefined
 * - instrumentCount() / clear()
 * - Повторный start() не дублирует подписки
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { PaperClock } from '@polymarket/time';
import { TradeTapeCollector } from '../src/TradeTapeCollector.js';
import type { TradeTapeCollectorDeps } from '../src/TradeTapeCollector.js';
import type { IEventBus, ApplicationEvent } from '@polymarket/event-bus';
import type { ILogger } from '@polymarket/logger';
import type { IMarketCatalog, InstrumentInfo } from '@polymarket/ports';
import type { InstrumentId, MarketId } from '@polymarket/ids';
import { TimestampService, PriceService, QuantityService } from '@polymarket/value-objects';
import type { Timestamp, Price, Quantity, Money } from '@polymarket/value-objects';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeTs(ms: number): Timestamp {
  const r = TimestampService.create(ms);
  if (!r.ok) throw new Error(`Invalid ts: ${ms}`);
  return r.value;
}

function makePrice(v: string): Price {
  const r = PriceService.create(v);
  if (!r.ok) throw new Error(`Invalid price: ${v}`);
  return r.value;
}

function makeQty(v: string): Quantity {
  const r = QuantityService.create(v);
  if (!r.ok) throw new Error(`Invalid qty: ${v}`);
  return r.value;
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

const TOKEN_A  = 'token-a'  as unknown as InstrumentId;
const TOKEN_B  = 'token-b'  as unknown as InstrumentId;
const MARKET_1 = 'market-1' as unknown as MarketId;
const MARKET_2 = 'market-2' as unknown as MarketId;

const T0 = 1_700_000_000_000;

/** Детерминированный clock для тестов */
const clock = new PaperClock(new Date(T0));

// ── EventBus stub ──────────────────────────────────────────────────────────────

function makeEventBus(): IEventBus & { emit(e: ApplicationEvent): Promise<void> } {
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

  const publish = jest.fn(async (_: ApplicationEvent) => {});
  const emit = async (event: ApplicationEvent) => {
    for (const h of handlers.get(event.type) ?? []) await h(event);
  };

  return { subscribe, publish, emit } as unknown as IEventBus & {
    emit(e: ApplicationEvent): Promise<void>;
  };
}

// ── Catalog stub ───────────────────────────────────────────────────────────────

function makeCatalog(mapping: Map<string, string> = new Map()): IMarketCatalog {
  return {
    get: jest.fn((instrumentId: InstrumentId) => {
      const marketId = mapping.get(String(instrumentId));
      if (!marketId) return undefined;
      return { instrumentId, marketId: marketId as unknown as MarketId } as InstrumentInfo;
    }),
    getByMarketId: jest.fn(() => undefined),
    getAll: jest.fn(() => []),
    register: jest.fn(),
    remove: jest.fn(),
    clear: jest.fn(),
  } as unknown as IMarketCatalog;
}

// ── Trade event helper ─────────────────────────────────────────────────────────

function tradeEvent(
  instrumentId: InstrumentId,
  price: string,
  size: string,
  side: 'BUY' | 'SELL',
  ts: number,
): Extract<ApplicationEvent, { type: 'TRADE_RECEIVED' }> {
  return {
    type: 'TRADE_RECEIVED',
    instrumentId,
    price: makePrice(price),
    size: makeQty(size),
    side,
    timestamp: makeTs(ts),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('TradeTapeCollector', () => {
  let eventBus: ReturnType<typeof makeEventBus>;
  let catalog: IMarketCatalog;
  let logger: ILogger;
  let deps: TradeTapeCollectorDeps;

  beforeEach(() => {
    eventBus = makeEventBus();
    catalog = makeCatalog(new Map([
      [String(TOKEN_A), String(MARKET_1)],
      [String(TOKEN_B), String(MARKET_2)],
    ]));
    logger = makeLogger();
    deps = { eventBus, catalog, logger, clock };
  });

  // ── Валидация конфига ──────────────────────────────────────────────────────

  describe('конфиг', () => {
    it('бросает RangeError если конфиг пустой', () => {
      expect(() => new TradeTapeCollector(deps, {})).toThrow(RangeError);
    });

    it('принимает конфиг с maxCount — записывает трейды', async () => {
      const c = new TradeTapeCollector(deps, { maxCount: 100 });
      c.start();
      await eventBus.emit(tradeEvent(TOKEN_A, '0.65', '100', 'BUY', T0));
      expect(c.getTape(TOKEN_A)?.size()).toBe(1);
    });

    it('принимает конфиг с maxAgeMs — вытесняет устаревшие', async () => {
      const c = new TradeTapeCollector(deps, { maxAgeMs: 60_000 });
      c.start();
      await eventBus.emit(tradeEvent(TOKEN_A, '0.65', '100', 'BUY', T0));
      await eventBus.emit(tradeEvent(TOKEN_A, '0.64', '200', 'SELL', T0 + 90_000));
      expect(c.getTape(TOKEN_A)?.size()).toBe(1);
    });

    it('принимает конфиг с обоими ограничениями — применяет оба', async () => {
      const c = new TradeTapeCollector(deps, { maxCount: 2, maxAgeMs: 60_000 });
      c.start();
      for (let i = 0; i < 5; i++) {
        await eventBus.emit(tradeEvent(TOKEN_A, '0.65', `${100 * (i + 1)}`, 'BUY', T0 + i * 1000));
      }
      expect(c.getTape(TOKEN_A)?.size()).toBe(2);
    });
  });

  // ── start / stop ─────────────────────────────────────────────────────────────

  describe('start() / stop()', () => {
    it('start() подписывается на TRADE_RECEIVED и MARKET_CLOSED', () => {
      const c = new TradeTapeCollector(deps, { maxCount: 100 });
      c.start();
      expect(eventBus.subscribe).toHaveBeenCalledWith('TRADE_RECEIVED', expect.any(Function));
      expect(eventBus.subscribe).toHaveBeenCalledWith('MARKET_CLOSED', expect.any(Function));
    });

    it('stop() отписывается — последующие трейды игнорируются', async () => {
      const c = new TradeTapeCollector(deps, { maxCount: 100 });
      c.start();
      c.stop();

      await eventBus.emit(tradeEvent(TOKEN_A, '0.65', '100', 'BUY', T0));

      expect(c.getTape(TOKEN_A)).toBeUndefined();
    });

    it('повторный start() не создаёт дублирующих подписок', async () => {
      const c = new TradeTapeCollector(deps, { maxCount: 100 });
      c.start();
      c.start(); // второй start

      await eventBus.emit(tradeEvent(TOKEN_A, '0.65', '100', 'BUY', T0));

      // Должна быть ровно 1 запись, не 2
      expect(c.getTape(TOKEN_A)?.size()).toBe(1);
    });
  });

  // ── Запись трейдов ─────────────────────────────────────────────────────────

  describe('запись трейдов (TRADE_RECEIVED)', () => {
    it('getTape() возвращает undefined до первого трейда', async () => {
      const c = new TradeTapeCollector(deps, { maxCount: 100 });
      c.start();
      expect(c.getTape(TOKEN_A)).toBeUndefined();
    });

    it('создаёт ленту лениво при первом трейде', async () => {
      const c = new TradeTapeCollector(deps, { maxCount: 100 });
      c.start();

      await eventBus.emit(tradeEvent(TOKEN_A, '0.65', '100', 'BUY', T0));

      expect(c.getTape(TOKEN_A)).toBeDefined();
      expect(c.getTape(TOKEN_A)?.size()).toBe(1);
    });

    it('накапливает несколько трейдов для одного инструмента', async () => {
      const c = new TradeTapeCollector(deps, { maxCount: 100 });
      c.start();

      await eventBus.emit(tradeEvent(TOKEN_A, '0.65', '100', 'BUY',  T0));
      await eventBus.emit(tradeEvent(TOKEN_A, '0.64', '200', 'SELL', T0 + 1000));
      await eventBus.emit(tradeEvent(TOKEN_A, '0.66', '150', 'BUY',  T0 + 2000));

      expect(c.getTape(TOKEN_A)?.size()).toBe(3);
    });

    it('ведёт раздельные ленты для разных инструментов', async () => {
      const c = new TradeTapeCollector(deps, { maxCount: 100 });
      c.start();

      await eventBus.emit(tradeEvent(TOKEN_A, '0.65', '100', 'BUY',  T0));
      await eventBus.emit(tradeEvent(TOKEN_A, '0.64', '200', 'BUY',  T0 + 1000));
      await eventBus.emit(tradeEvent(TOKEN_B, '0.30', '500', 'SELL', T0));

      expect(c.getTape(TOKEN_A)?.size()).toBe(2);
      expect(c.getTape(TOKEN_B)?.size()).toBe(1);
      expect(c.instrumentCount()).toBe(2);
    });

    it('TapeRecord содержит корректные поля из события', async () => {
      const c = new TradeTapeCollector(deps, { maxCount: 100 });
      c.start();

      await eventBus.emit(tradeEvent(TOKEN_A, '0.65', '100', 'BUY', T0));

      const all = c.getTape(TOKEN_A)?.getAll() ?? [];
      expect(all).toHaveLength(1);
      expect(all[0]?.price.value().toString()).toBe('0.65');
      expect(all[0]?.size.value().toString()).toBe('100');
      expect(all[0]?.side).toBe('BUY');
      expect(all[0]?.timestamp.toNumber()).toBe(T0);
    });
  });

  // ── maxCount FIFO ──────────────────────────────────────────────────────────

  describe('maxCount (FIFO)', () => {
    it('вытесняет старые трейды при превышении maxCount', async () => {
      const c = new TradeTapeCollector(deps, { maxCount: 3 });
      c.start();

      for (let i = 0; i < 5; i++) {
        await eventBus.emit(tradeEvent(TOKEN_A, '0.65', `${(i + 1) * 100}`, 'BUY', T0 + i * 1000));
      }

      const tape = c.getTape(TOKEN_A);
      expect(tape?.size()).toBe(3);
      // Последние 3: i=2,3,4 → size=300,400,500
      const all = tape?.getAll() ?? [];
      expect(all[0]?.size.value().toString()).toBe('300');
      expect(all[2]?.size.value().toString()).toBe('500');
    });

    it('не вытесняет если размер < maxCount', async () => {
      const c = new TradeTapeCollector(deps, { maxCount: 10 });
      c.start();

      await eventBus.emit(tradeEvent(TOKEN_A, '0.65', '100', 'BUY', T0));
      await eventBus.emit(tradeEvent(TOKEN_A, '0.64', '200', 'BUY', T0 + 1000));

      expect(c.getTape(TOKEN_A)?.size()).toBe(2);
    });
  });

  // ── maxAgeMs авто-вытеснение ───────────────────────────────────────────────

  describe('maxAgeMs (авто-вытеснение)', () => {
    it('вытесняет трейды старше maxAgeMs при новом трейде', async () => {
      const c = new TradeTapeCollector(deps, { maxAgeMs: 60_000 });
      c.start();

      await eventBus.emit(tradeEvent(TOKEN_A, '0.65', '100', 'BUY',  T0));           // T0 - старый
      await eventBus.emit(tradeEvent(TOKEN_A, '0.64', '200', 'SELL', T0 + 90_000));  // T0+90s — вытесняет T0

      const tape = c.getTape(TOKEN_A);
      expect(tape?.size()).toBe(1);
      expect(tape?.getAll()[0]?.side).toBe('SELL');
    });

    it('не вытесняет трейды моложе maxAgeMs', async () => {
      const c = new TradeTapeCollector(deps, { maxAgeMs: 60_000 });
      c.start();

      await eventBus.emit(tradeEvent(TOKEN_A, '0.65', '100', 'BUY',  T0));
      await eventBus.emit(tradeEvent(TOKEN_A, '0.64', '200', 'BUY',  T0 + 30_000)); // 30s — свежий
      await eventBus.emit(tradeEvent(TOKEN_A, '0.63', '300', 'SELL', T0 + 50_000)); // 50s — свежий

      expect(c.getTape(TOKEN_A)?.size()).toBe(3);
    });

    it('оба ограничения работают одновременно', async () => {
      const c = new TradeTapeCollector(deps, { maxCount: 2, maxAgeMs: 60_000 });
      c.start();

      await eventBus.emit(tradeEvent(TOKEN_A, '0.65', '100', 'BUY',  T0));
      await eventBus.emit(tradeEvent(TOKEN_A, '0.64', '200', 'BUY',  T0 + 10_000));
      await eventBus.emit(tradeEvent(TOKEN_A, '0.63', '300', 'BUY',  T0 + 20_000));
      // Через 90s — все три предыдущих устарели по maxAgeMs(60s), cutoff=T0+30000
      await eventBus.emit(tradeEvent(TOKEN_A, '0.62', '400', 'SELL', T0 + 90_000));

      expect(c.getTape(TOKEN_A)?.size()).toBe(1);
    });
  });

  // ── MARKET_CLOSED cleanup ──────────────────────────────────────────────────

  describe('cleanup при MARKET_CLOSED', () => {
    it('удаляет ленты инструментов закрытого рынка', async () => {
      const c = new TradeTapeCollector(deps, { maxCount: 100 });
      c.start();

      await eventBus.emit(tradeEvent(TOKEN_A, '0.65', '100', 'BUY', T0));
      expect(c.getTape(TOKEN_A)).toBeDefined();

      await eventBus.emit({
        type: 'MARKET_CLOSED',
        marketId: MARKET_1,
        reason: 'EXPIRED',
        realizedPnL: {} as Money,
        timestamp: makeTs(T0 + 1000),
      });

      expect(c.getTape(TOKEN_A)).toBeUndefined();
      expect(c.instrumentCount()).toBe(0);
    });

    it('не трогает ленты других рынков', async () => {
      const c = new TradeTapeCollector(deps, { maxCount: 100 });
      c.start();

      await eventBus.emit(tradeEvent(TOKEN_A, '0.65', '100', 'BUY', T0)); // market-1
      await eventBus.emit(tradeEvent(TOKEN_B, '0.30', '500', 'BUY', T0)); // market-2

      await eventBus.emit({
        type: 'MARKET_CLOSED',
        marketId: MARKET_1,
        reason: 'EXPIRED',
        realizedPnL: {} as Money,
        timestamp: makeTs(T0 + 1000),
      });

      expect(c.getTape(TOKEN_A)).toBeUndefined(); // удалён
      expect(c.getTape(TOKEN_B)).toBeDefined();   // остался
    });
  });

  // ── getTape → TradeTape API ────────────────────────────────────────────────

  describe('getTape() → TradeTape API', () => {
    it('getTape().getRecent() возвращает трейды за последние N мс', async () => {
      const c = new TradeTapeCollector(deps, { maxCount: 100 });
      c.start();

      await eventBus.emit(tradeEvent(TOKEN_A, '0.65', '100', 'BUY',  T0 - 120_000)); // вне окна
      await eventBus.emit(tradeEvent(TOKEN_A, '0.64', '200', 'SELL', T0 - 30_000));  // в окне
      await eventBus.emit(tradeEvent(TOKEN_A, '0.63', '300', 'BUY',  T0));           // в окне

      const recent = c.getTape(TOKEN_A)?.getRecent(60_000, T0) ?? [];
      expect(recent).toHaveLength(2);
      expect(recent[0]?.side).toBe('SELL');
      expect(recent[1]?.side).toBe('BUY');
    });

    it('getTape().getWindow() возвращает трейды в диапазоне с правильным содержимым', async () => {
      const c = new TradeTapeCollector(deps, { maxCount: 100 });
      c.start();

      await eventBus.emit(tradeEvent(TOKEN_A, '0.65', '100', 'BUY',  T0));           // вне окна
      await eventBus.emit(tradeEvent(TOKEN_A, '0.64', '200', 'SELL', T0 + 1000));    // граница — включён
      await eventBus.emit(tradeEvent(TOKEN_A, '0.63', '300', 'BUY',  T0 + 2000));    // граница — включён

      const w = c.getTape(TOKEN_A)?.getWindow(T0 + 1000, T0 + 2000) ?? [];
      expect(w).toHaveLength(2);
      expect(w[0]?.side).toBe('SELL');
      expect(w[0]?.price.value().toString()).toBe('0.64');
      expect(w[1]?.side).toBe('BUY');
      expect(w[1]?.price.value().toString()).toBe('0.63');
    });

    it('getTape() возвращает undefined если нет трейдов', () => {
      const c = new TradeTapeCollector(deps, { maxCount: 100 });
      expect(c.getTape(TOKEN_A)).toBeUndefined();
    });
  });

  // ── recordDirect ──────────────────────────────────────────────────────────────

  describe('recordDirect()', () => {
    it('записывает трейд без подписки на EventBus', () => {
      const c = new TradeTapeCollector(deps, { maxCount: 100 });
      // start() не вызывается

      c.recordDirect(TOKEN_A, makePrice('0.65'), makeQty('100'), 'BUY', makeTs(T0));

      expect(c.getTape(TOKEN_A)).toBeDefined();
      expect(c.getTape(TOKEN_A)?.size()).toBe(1);
    });

    it('накапливает трейды через recordDirect', () => {
      const c = new TradeTapeCollector(deps, { maxCount: 100 });

      c.recordDirect(TOKEN_A, makePrice('0.65'), makeQty('100'), 'BUY', makeTs(T0));
      c.recordDirect(TOKEN_A, makePrice('0.64'), makeQty('200'), 'SELL', makeTs(T0 + 1000));

      expect(c.getTape(TOKEN_A)?.size()).toBe(2);
    });
  });

  // ── clearMarket (пассивная очистка, без подписки) ──────────────────────────

  describe('clearMarket()', () => {
    it('удаляет ленты инструментов рынка без подписки на EventBus', () => {
      const c = new TradeTapeCollector(deps, { maxCount: 100 });
      // start() не вызывается — пассивный режим (как при использовании из MarketDataStore)

      c.recordDirect(TOKEN_A, makePrice('0.65'), makeQty('100'), 'BUY', makeTs(T0));
      expect(c.instrumentCount()).toBe(1);

      c.clearMarket(MARKET_1);

      expect(c.getTape(TOKEN_A)).toBeUndefined();
      expect(c.instrumentCount()).toBe(0);
    });
  });

  // ── Инструмент не в каталоге ───────────────────────────────────────────────

  describe('инструмент не в каталоге', () => {
    it('создаёт ленту для инструмента без marketId в каталоге', async () => {
      // catalog не содержит TOKEN_A (не задан при инициализации теста)
      const unknownCatalog = makeCatalog(new Map()); // пустой маппинг
      const c = new TradeTapeCollector({ ...deps, catalog: unknownCatalog }, { maxCount: 100 });
      c.start();

      await eventBus.emit(tradeEvent(TOKEN_A, '0.65', '100', 'BUY', T0));

      // Лента создана, несмотря на отсутствие в каталоге
      expect(c.getTape(TOKEN_A)).toBeDefined();
      expect(c.getTape(TOKEN_A)?.size()).toBe(1);
    });

    it('не регистрирует в reverse index если инструмент не в каталоге — MARKET_CLOSED не удаляет', async () => {
      const unknownCatalog = makeCatalog(new Map());
      const c = new TradeTapeCollector({ ...deps, catalog: unknownCatalog }, { maxCount: 100 });
      c.start();

      await eventBus.emit(tradeEvent(TOKEN_A, '0.65', '100', 'BUY', T0));

      await eventBus.emit({
        type: 'MARKET_CLOSED',
        marketId: MARKET_1,
        reason: 'EXPIRED',
        realizedPnL: {} as Money,
        timestamp: makeTs(T0 + 1000),
      });

      // Инструмент был без marketId — не попал в reverse index — лента сохраняется
      expect(c.getTape(TOKEN_A)).toBeDefined();
    });
  });

  // ── Обработка ошибок ──────────────────────────────────────────────────────

  describe('обработка ошибок в обработчике TRADE_RECEIVED', () => {
    it('логирует ошибку и не падает если _record бросает Error', async () => {
      const c = new TradeTapeCollector(deps, { maxCount: 100 });
      c.start();

      (catalog as any).get = () => { throw new Error('catalog exploded'); };

      await expect(eventBus.emit(tradeEvent(TOKEN_A, '0.65', '100', 'BUY', T0))).resolves.not.toThrow();

      expect((logger as any).error).toHaveBeenCalledWith(
        'TradeTapeCollector: failed to record trade',
        expect.objectContaining({ instrumentId: String(TOKEN_A), err: expect.any(Error) }),
      );
    });

    it('нормализует non-Error исключение в Error при логировании', async () => {
      const c = new TradeTapeCollector(deps, { maxCount: 100 });
      c.start();

      (catalog as any).get = () => { throw 42; };

      await expect(eventBus.emit(tradeEvent(TOKEN_A, '0.65', '100', 'BUY', T0))).resolves.not.toThrow();

      const call = (logger as any).error.mock.calls[0][1];
      expect(call.err).toBeInstanceOf(Error);
      expect(call.err.message).toBe('42');
    });
  });

  // ── getWindow() граничные значения ────────────────────────────────────────

  describe('getWindow() граничные значения', () => {
    it('включает трейды точно на границах fromMs и toMs', async () => {
      const c = new TradeTapeCollector(deps, { maxCount: 100 });
      c.start();

      await eventBus.emit(tradeEvent(TOKEN_A, '0.65', '100', 'BUY',  T0));
      await eventBus.emit(tradeEvent(TOKEN_A, '0.64', '200', 'SELL', T0 + 1000));
      await eventBus.emit(tradeEvent(TOKEN_A, '0.63', '300', 'BUY',  T0 + 2000));

      // Граничные значения включены
      const w = c.getTape(TOKEN_A)?.getWindow(T0, T0 + 2000) ?? [];
      expect(w).toHaveLength(3);
    });

    it('не включает трейды вне диапазона', async () => {
      const c = new TradeTapeCollector(deps, { maxCount: 100 });
      c.start();

      await eventBus.emit(tradeEvent(TOKEN_A, '0.65', '100', 'BUY',  T0 - 1));      // до диапазона
      await eventBus.emit(tradeEvent(TOKEN_A, '0.64', '200', 'SELL', T0));           // в диапазоне
      await eventBus.emit(tradeEvent(TOKEN_A, '0.63', '300', 'BUY',  T0 + 1000));    // в диапазоне
      await eventBus.emit(tradeEvent(TOKEN_A, '0.62', '400', 'SELL', T0 + 1001));    // после диапазона

      const w = c.getTape(TOKEN_A)?.getWindow(T0, T0 + 1000) ?? [];
      expect(w).toHaveLength(2);
      expect(w[0]?.side).toBe('SELL');
      expect(w[1]?.side).toBe('BUY');
    });
  });

  // ── instrumentCount / clear ────────────────────────────────────────────────

  describe('instrumentCount() / clear()', () => {
    it('instrumentCount() возвращает 0 изначально', () => {
      const c = new TradeTapeCollector(deps, { maxCount: 100 });
      expect(c.instrumentCount()).toBe(0);
    });

    it('instrumentCount() растёт при появлении новых инструментов', async () => {
      const c = new TradeTapeCollector(deps, { maxCount: 100 });
      c.start();

      await eventBus.emit(tradeEvent(TOKEN_A, '0.65', '100', 'BUY', T0));
      expect(c.instrumentCount()).toBe(1);

      await eventBus.emit(tradeEvent(TOKEN_B, '0.30', '500', 'BUY', T0));
      expect(c.instrumentCount()).toBe(2);
    });

    it('clear() удаляет все ленты', async () => {
      const c = new TradeTapeCollector(deps, { maxCount: 100 });
      c.start();

      await eventBus.emit(tradeEvent(TOKEN_A, '0.65', '100', 'BUY', T0));
      await eventBus.emit(tradeEvent(TOKEN_B, '0.30', '500', 'BUY', T0));

      c.clear();
      expect(c.instrumentCount()).toBe(0);
      expect(c.getTape(TOKEN_A)).toBeUndefined();
    });
  });
});
