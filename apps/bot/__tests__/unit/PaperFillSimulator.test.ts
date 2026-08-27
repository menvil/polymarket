/**
 * Тесты PaperFillSimulator.
 *
 * @remarks
 * Проверяет оба механизма симуляции fills:
 * 1. Book crossing: BOOK_UPDATED → full fill при пересечении цены
 * 2. Tape matching: TRADE_RECEIVED → partial или full fill по объёму
 *
 * ProcessFillUseCase и EventBus мокаются для изоляции.
 */

import { PaperFillSimulator } from '../../src/paper/PaperFillSimulator.js';
import type { PendingPaperOrder } from '../../src/paper/PaperFillSimulator.js';
import { OutcomePrice, Quantity } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

// ── Хелперы и моки ──────────────────────────────────────────────────────────

/** Создаёт mock EventBus с возможностью вручную триггерить события */
function makeEventBus() {
  const handlers: Record<string, Array<(event: unknown) => void>> = {};

  return {
    subscribe: jest.fn((type: string, handler: (event: unknown) => void) => {
      if (!handlers[type]) handlers[type] = [];
      handlers[type].push(handler);
      // Возвращает unsubscribe
      return () => {
        handlers[type] = handlers[type].filter((h) => h !== handler);
      };
    }),
    publish: jest.fn(),
    publishAll: jest.fn(),
    // Хелпер для тестов: отправить событие в подписчики
    emit: (type: string, event: unknown) => {
      for (const h of handlers[type] ?? []) {
        void h(event);
      }
    },
  };
}

/** Создаёт mock ProcessFillUseCase */
function makeProcessFillUseCase() {
  return {
    execute: jest.fn().mockResolvedValue({ ok: true, value: undefined }),
  };
}

/** Создаёт mock IClock */
function makeClock(nowMs = 1_000_000) {
  return {
    now: () => new Date(nowMs),
  };
}

/** Создаёт mock ILogger */
function makeLogger() {
  return {
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn(),
  };
}

/** Создаёт mock PortfolioStore с заданной позицией по instr-abc */
function makePortfolioStore(positionQty: Decimal) {
  return {
    get: jest.fn().mockReturnValue({
      getPosition: jest.fn().mockReturnValue(
        positionQty.gt(0)
          ? {
              quantity: { value: () => positionQty },
            }
          : undefined,
      ),
    }),
    save: jest.fn(),
  };
}

/** Создаёт PendingPaperOrder для тестов */
function makeOrder(overrides: Partial<PendingPaperOrder> = {}): PendingPaperOrder {
  return {
    orderId: 'order-1' as any,
    instrumentId: 'instr-abc' as any,
    marketId: 'market-abc' as any,
    side: 'BUY',
    price: OutcomePrice.of(new Decimal('0.48')),
    totalSize: Quantity.of(new Decimal('10')),
    remainingSize: new Decimal('10'),
    accountId: 'venue:POLYMARKET:test' as any,
    asset: { type: 'POLYMARKET_CTF_TOKEN', tokenId: 'abc' } as any,
    postOnly: false,
    placedAtMs: 1_000_000,
    ...overrides,
  };
}

/** Создаёт BOOK_UPDATED событие (canonical envelope M-003; metadata тестом не читается) */
function makeBookEvent(instrumentId: string, bestBid?: number, bestAsk?: number) {
  return {
    type: 'BOOK_UPDATED',
    payload: {
      instrumentId,
      topOfBook: {
        bestBid: bestBid !== undefined ? OutcomePrice.of(new Decimal(bestBid)) : undefined,
        bestAsk: bestAsk !== undefined ? OutcomePrice.of(new Decimal(bestAsk)) : undefined,
      },
    },
  };
}

/** Создаёт TRADE_RECEIVED событие (canonical envelope M-003; metadata тестом не читается) */
function makeTradeEvent(instrumentId: string, price: number, size: number) {
  return {
    type: 'TRADE_RECEIVED',
    payload: {
      instrumentId,
      price: OutcomePrice.of(new Decimal(price)),
      size: Quantity.of(new Decimal(size)),
    },
  };
}

/** Пауза для ожидания async операций */
const tick = () => new Promise((r) => setTimeout(r, 10));

// ── Тесты ────────────────────────────────────────────────────────────────────

describe('PaperFillSimulator', () => {
  let eventBus: ReturnType<typeof makeEventBus>;
  let processFillUseCase: ReturnType<typeof makeProcessFillUseCase>;
  let simulator: PaperFillSimulator;

  beforeEach(() => {
    eventBus = makeEventBus();
    processFillUseCase = makeProcessFillUseCase();

    simulator = new PaperFillSimulator({
      processFillUseCase: processFillUseCase as any,
      eventBus: eventBus as any,
      clock: makeClock(),
      logger: makeLogger() as any,
      config: {
        fillOnBookCrossing: true,
        fillOnTape: true,
        fillAtOrderPrice: true,
      },
    });

    simulator.start();
  });

  afterEach(() => {
    simulator.stop();
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  it('start() подписывается на BOOK_UPDATED и TRADE_RECEIVED', () => {
    expect(eventBus.subscribe).toHaveBeenCalledWith('BOOK_UPDATED', expect.any(Function));
    expect(eventBus.subscribe).toHaveBeenCalledWith('TRADE_RECEIVED', expect.any(Function));
  });

  it('stop() отписывается и очищает pending ордера', () => {
    simulator.trackOrder(makeOrder());
    expect(simulator.pendingCount).toBe(1);

    simulator.stop();

    expect(simulator.pendingCount).toBe(0);
  });

  it('trackOrder / removeOrder управляют pending списком', () => {
    expect(simulator.pendingCount).toBe(0);

    simulator.trackOrder(makeOrder({ orderId: 'o-1' as any }));
    simulator.trackOrder(makeOrder({ orderId: 'o-2' as any }));
    expect(simulator.pendingCount).toBe(2);

    simulator.removeOrder('o-1' as any);
    expect(simulator.pendingCount).toBe(1);
  });

  // ── Book crossing: BUY ────────────────────────────────────────────────────

  describe('Book crossing — BUY ордера', () => {
    it('full fill когда bestAsk ≤ orderPrice', async () => {
      simulator.trackOrder(makeOrder({ side: 'BUY', price: OutcomePrice.of(new Decimal('0.48')) }));

      // bestAsk = 0.47 ≤ 0.48 → fill
      eventBus.emit('BOOK_UPDATED', makeBookEvent('instr-abc', 0.45, 0.47));
      await tick();

      expect(processFillUseCase.execute).toHaveBeenCalledTimes(1);
      expect(simulator.pendingCount).toBe(0); // ордер удалён после full fill
    });

    it('full fill когда bestAsk = orderPrice (граничное значение)', async () => {
      simulator.trackOrder(makeOrder({ side: 'BUY', price: OutcomePrice.of(new Decimal('0.48')) }));

      eventBus.emit('BOOK_UPDATED', makeBookEvent('instr-abc', 0.46, 0.48));
      await tick();

      expect(processFillUseCase.execute).toHaveBeenCalledTimes(1);
    });

    it('нет fill когда bestAsk > orderPrice', async () => {
      simulator.trackOrder(makeOrder({ side: 'BUY', price: OutcomePrice.of(new Decimal('0.48')) }));

      // bestAsk = 0.50 > 0.48 → нет fill
      eventBus.emit('BOOK_UPDATED', makeBookEvent('instr-abc', 0.47, 0.50));
      await tick();

      expect(processFillUseCase.execute).not.toHaveBeenCalled();
      expect(simulator.pendingCount).toBe(1); // ордер остаётся
    });

    it('нет fill для другого инструмента', async () => {
      simulator.trackOrder(makeOrder({ side: 'BUY', instrumentId: 'instr-abc' as any }));

      eventBus.emit('BOOK_UPDATED', makeBookEvent('instr-XYZ', 0.45, 0.47));
      await tick();

      expect(processFillUseCase.execute).not.toHaveBeenCalled();
    });
  });

  // ── Book crossing: SELL ───────────────────────────────────────────────────

  describe('Book crossing — SELL ордера', () => {
    it('full fill когда bestBid ≥ orderPrice', async () => {
      simulator.trackOrder(makeOrder({
        side: 'SELL',
        price: OutcomePrice.of(new Decimal('0.55')),
      }));

      // bestBid = 0.56 ≥ 0.55 → fill
      eventBus.emit('BOOK_UPDATED', makeBookEvent('instr-abc', 0.56, 0.58));
      await tick();

      expect(processFillUseCase.execute).toHaveBeenCalledTimes(1);
      expect(simulator.pendingCount).toBe(0);
    });

    it('нет fill когда bestBid < orderPrice', async () => {
      simulator.trackOrder(makeOrder({
        side: 'SELL',
        price: OutcomePrice.of(new Decimal('0.55')),
      }));

      eventBus.emit('BOOK_UPDATED', makeBookEvent('instr-abc', 0.53, 0.55));
      await tick();

      expect(processFillUseCase.execute).not.toHaveBeenCalled();
    });

    it('не исполняет SELL если в портфеле нет позиции', async () => {
      simulator.stop();
      const logger = makeLogger();
      const sim = new PaperFillSimulator({
        processFillUseCase: processFillUseCase as any,
        portfolioStore: makePortfolioStore(new Decimal(0)) as any,
        eventBus: eventBus as any,
        clock: makeClock(),
        logger: logger as any,
        config: { fillOnBookCrossing: true, fillOnTape: true, fillAtOrderPrice: true },
      });
      sim.start();
      sim.trackOrder(makeOrder({
        side: 'SELL',
        price: OutcomePrice.of(new Decimal('0.55')),
        totalSize: Quantity.of(new Decimal('10')),
      }));

      eventBus.emit('BOOK_UPDATED', makeBookEvent('instr-abc', 0.56, 0.58));
      await tick();

      expect(processFillUseCase.execute).not.toHaveBeenCalled();
      expect(sim.pendingCount).toBe(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Paper SELL fill blocked'),
        expect.objectContaining({ positionQty: '0', fillSize: '10' }),
      );
      sim.stop();
    });

    it('исполняет SELL с зарезервированными токенами когда общей позиции достаточно', async () => {
      simulator.stop();
      const sim = new PaperFillSimulator({
        processFillUseCase: processFillUseCase as any,
        portfolioStore: makePortfolioStore(new Decimal(10)) as any,
        eventBus: eventBus as any,
        clock: makeClock(),
        logger: makeLogger() as any,
        config: { fillOnBookCrossing: true, fillOnTape: true, fillAtOrderPrice: true },
      });
      sim.start();
      sim.trackOrder(makeOrder({
        side: 'SELL',
        price: OutcomePrice.of(new Decimal('0.55')),
        totalSize: Quantity.of(new Decimal('10')),
      }));

      eventBus.emit('BOOK_UPDATED', makeBookEvent('instr-abc', 0.56, 0.58));
      await tick();

      expect(processFillUseCase.execute).toHaveBeenCalledTimes(1);
      expect(sim.pendingCount).toBe(0);
      sim.stop();
    });
  });

  // ── Tape matching: BUY ────────────────────────────────────────────────────

  describe('Tape matching — BUY ордера', () => {
    it('full fill когда trade.size >= remainingSize', async () => {
      simulator.trackOrder(makeOrder({
        side: 'BUY',
        price: OutcomePrice.of(new Decimal('0.48')),
        totalSize: Quantity.of(new Decimal('10')),
        remainingSize: new Decimal('10'),
      }));

      // trade @ 0.47 (≤ 0.48), size=15 ≥ 10 → full fill
      eventBus.emit('TRADE_RECEIVED', makeTradeEvent('instr-abc', 0.47, 15));
      await tick();

      expect(processFillUseCase.execute).toHaveBeenCalledTimes(1);
      expect(simulator.pendingCount).toBe(0);
    });

    it('partial fill когда trade.size < remainingSize', async () => {
      simulator.trackOrder(makeOrder({
        side: 'BUY',
        price: OutcomePrice.of(new Decimal('0.48')),
        totalSize: Quantity.of(new Decimal('10')),
        remainingSize: new Decimal('10'),
      }));

      // trade size=4 < 10 → partial fill, ордер остаётся с remainingSize=6
      eventBus.emit('TRADE_RECEIVED', makeTradeEvent('instr-abc', 0.47, 4));
      await tick();

      expect(processFillUseCase.execute).toHaveBeenCalledTimes(1);
      expect(simulator.pendingCount).toBe(1); // ордер ещё висит
    });

    it('несколько tape событий накапливаются до full fill', async () => {
      simulator.trackOrder(makeOrder({
        side: 'BUY',
        price: OutcomePrice.of(new Decimal('0.48')),
        totalSize: Quantity.of(new Decimal('10')),
        remainingSize: new Decimal('10'),
      }));

      // 3 trade события по 4 токена → 4 + 4 + 4 = 12, но remainingSize = 10 → full fill после 3-го
      eventBus.emit('TRADE_RECEIVED', makeTradeEvent('instr-abc', 0.47, 4));
      await tick();
      expect(simulator.pendingCount).toBe(1); // ещё 6 осталось

      eventBus.emit('TRADE_RECEIVED', makeTradeEvent('instr-abc', 0.46, 4));
      await tick();
      expect(simulator.pendingCount).toBe(1); // ещё 2 осталось

      eventBus.emit('TRADE_RECEIVED', makeTradeEvent('instr-abc', 0.45, 4));
      await tick();
      expect(simulator.pendingCount).toBe(0); // full fill!

      expect(processFillUseCase.execute).toHaveBeenCalledTimes(3);
    });

    it('нет fill когда trade.price > orderPrice (BUY)', async () => {
      simulator.trackOrder(makeOrder({
        side: 'BUY',
        price: OutcomePrice.of(new Decimal('0.48')),
      }));

      // trade @ 0.50 > 0.48 → не матчится
      eventBus.emit('TRADE_RECEIVED', makeTradeEvent('instr-abc', 0.50, 10));
      await tick();

      expect(processFillUseCase.execute).not.toHaveBeenCalled();
    });
  });

  // ── Tape matching: SELL ───────────────────────────────────────────────────

  describe('Tape matching — SELL ордера', () => {
    it('full fill когда trade.price >= orderPrice', async () => {
      simulator.trackOrder(makeOrder({
        side: 'SELL',
        price: OutcomePrice.of(new Decimal('0.55')),
        totalSize: Quantity.of(new Decimal('5')),
        remainingSize: new Decimal('5'),
      }));

      // trade @ 0.57 ≥ 0.55, size=5 → full fill
      eventBus.emit('TRADE_RECEIVED', makeTradeEvent('instr-abc', 0.57, 5));
      await tick();

      expect(processFillUseCase.execute).toHaveBeenCalledTimes(1);
      expect(simulator.pendingCount).toBe(0);
    });

    it('partial fill для SELL', async () => {
      simulator.trackOrder(makeOrder({
        side: 'SELL',
        price: OutcomePrice.of(new Decimal('0.55')),
        totalSize: Quantity.of(new Decimal('10')),
        remainingSize: new Decimal('10'),
      }));

      eventBus.emit('TRADE_RECEIVED', makeTradeEvent('instr-abc', 0.56, 3));
      await tick();

      expect(processFillUseCase.execute).toHaveBeenCalledTimes(1);
      expect(simulator.pendingCount).toBe(1); // ещё 7 осталось
    });

    it('не исполняет tape SELL если размер fill превышает позицию', async () => {
      simulator.stop();
      const logger = makeLogger();
      const sim = new PaperFillSimulator({
        processFillUseCase: processFillUseCase as any,
        portfolioStore: makePortfolioStore(new Decimal(2)) as any,
        eventBus: eventBus as any,
        clock: makeClock(),
        logger: logger as any,
        config: { fillOnBookCrossing: true, fillOnTape: true, fillAtOrderPrice: true },
      });
      sim.start();
      sim.trackOrder(makeOrder({
        side: 'SELL',
        price: OutcomePrice.of(new Decimal('0.55')),
        totalSize: Quantity.of(new Decimal('10')),
        remainingSize: new Decimal('10'),
      }));

      eventBus.emit('TRADE_RECEIVED', makeTradeEvent('instr-abc', 0.56, 3));
      await tick();

      expect(processFillUseCase.execute).not.toHaveBeenCalled();
      expect(sim.pendingCount).toBe(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Paper SELL fill blocked'),
        expect.objectContaining({ positionQty: '2', fillSize: '3' }),
      );
      sim.stop();
    });
  });

  // ── Конфигурация ─────────────────────────────────────────────────────────

  describe('конфигурация симуляции', () => {
    it('fillOnBookCrossing=false отключает подписку на BOOK_UPDATED', () => {
      simulator.stop();
      const sim2 = new PaperFillSimulator({
        processFillUseCase: processFillUseCase as any,
        eventBus: eventBus as any,
        clock: makeClock(),
        logger: makeLogger() as any,
        config: { fillOnBookCrossing: false, fillOnTape: true, fillAtOrderPrice: true },
      });
      const callsBefore = eventBus.subscribe.mock.calls.length;
      sim2.start();

      const bookCalls = eventBus.subscribe.mock.calls
        .slice(callsBefore)
        .filter((c) => c[0] === 'BOOK_UPDATED');
      expect(bookCalls.length).toBe(0);
      sim2.stop();
    });

    it('fillOnTape=false отключает подписку на TRADE_RECEIVED', () => {
      simulator.stop();
      const sim2 = new PaperFillSimulator({
        processFillUseCase: processFillUseCase as any,
        eventBus: eventBus as any,
        clock: makeClock(),
        logger: makeLogger() as any,
        config: { fillOnBookCrossing: true, fillOnTape: false, fillAtOrderPrice: true },
      });
      const callsBefore = eventBus.subscribe.mock.calls.length;
      sim2.start();

      const tapeCalls = eventBus.subscribe.mock.calls
        .slice(callsBefore)
        .filter((c) => c[0] === 'TRADE_RECEIVED');
      expect(tapeCalls.length).toBe(0);
      sim2.stop();
    });
  });

  // ── Несколько ордеров одновременно ────────────────────────────────────────

  describe('несколько pending ордеров', () => {
    it('book crossing обрабатывает все matching ордера', async () => {
      simulator.trackOrder(makeOrder({ orderId: 'o-1' as any, side: 'BUY', price: OutcomePrice.of(new Decimal('0.48')) }));
      simulator.trackOrder(makeOrder({ orderId: 'o-2' as any, side: 'BUY', price: OutcomePrice.of(new Decimal('0.50')) }));

      // bestAsk = 0.47 ≤ 0.48 и ≤ 0.50 → оба fill
      eventBus.emit('BOOK_UPDATED', makeBookEvent('instr-abc', 0.45, 0.47));
      await tick();

      expect(processFillUseCase.execute).toHaveBeenCalledTimes(2);
      expect(simulator.pendingCount).toBe(0);
    });

    it('tape matching обрабатывает все matching ордера', async () => {
      simulator.trackOrder(makeOrder({ orderId: 'o-1' as any, side: 'BUY', price: OutcomePrice.of(new Decimal('0.48')), totalSize: Quantity.of(new Decimal('5')), remainingSize: new Decimal('5') }));
      simulator.trackOrder(makeOrder({ orderId: 'o-2' as any, side: 'BUY', price: OutcomePrice.of(new Decimal('0.50')), totalSize: Quantity.of(new Decimal('5')), remainingSize: new Decimal('5') }));

      // trade size=10: покрывает оба ордера по 5
      eventBus.emit('TRADE_RECEIVED', makeTradeEvent('instr-abc', 0.47, 10));
      await tick();

      expect(processFillUseCase.execute).toHaveBeenCalledTimes(2);
      expect(simulator.pendingCount).toBe(0);
    });
  });

  // ── ProcessFillUseCase ошибка ─────────────────────────────────────────────

  it('логирует ошибку если ProcessFillUseCase вернул Err', async () => {
    const logger = makeLogger();
    const failingUseCase = {
      execute: jest.fn().mockResolvedValue({ ok: false, error: new Error('portfolio error') }),
    };
    const sim = new PaperFillSimulator({
      processFillUseCase: failingUseCase as any,
      eventBus: eventBus as any,
      clock: makeClock(),
      logger: logger as any,
      config: { fillOnBookCrossing: true, fillOnTape: true, fillAtOrderPrice: true },
    });
    sim.start();
    sim.trackOrder(makeOrder({ side: 'BUY', price: OutcomePrice.of(new Decimal('0.48')) }));

    eventBus.emit('BOOK_UPDATED', makeBookEvent('instr-abc', 0.45, 0.47));
    await tick();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('ProcessFillUseCase failed'),
      expect.any(Object),
    );
    sim.stop();
  });
});
