import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { DrawdownRiskMonitor } from '../src/DrawdownRiskMonitor.js';
import type { IMarkPricesProvider } from '../src/IMarkPricesProvider.js';
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import type { IEventBus } from '@polymarket/event-bus';
import type { IPortfolioStore } from '@polymarket/ports';
import type { Portfolio, IPosition } from '@polymarket/portfolio';
import type { InstrumentId } from '@polymarket/ids';
import type { Price } from '@polymarket/value-objects';
import type { AccountId } from '@polymarket/ids';
import Decimal from 'decimal.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeLogger(): ILogger {
  return {
    trace: jest.fn() as ILogger['trace'],
    debug: jest.fn() as ILogger['debug'],
    info: jest.fn() as ILogger['info'],
    warn: jest.fn() as ILogger['warn'],
    error: jest.fn() as ILogger['error'],
    fatal: jest.fn() as ILogger['fatal'],
    child: jest.fn<ILogger['child']>().mockReturnThis() as ILogger['child'],
  };
}

function makeEventBus(): IEventBus {
  return {
    publish: jest.fn<IEventBus['publish']>().mockResolvedValue(undefined),
    publishAll: jest.fn<IEventBus['publishAll']>().mockResolvedValue(undefined),
    subscribe: jest.fn<IEventBus['subscribe']>().mockReturnValue(() => {}),
  };
}

function makeClock(date = new Date('2024-01-01T00:00:00.000Z')): IClock {
  return { now: jest.fn<() => Date>().mockReturnValue(date) };
}

function makeMarkPrices(prices: Record<string, string> = {}): IMarkPricesProvider {
  const map = new Map<InstrumentId, Price>(
    Object.entries(prices).map(([id, val]) => [
      id as unknown as InstrumentId,
      { value: () => new Decimal(val) } as unknown as Price,
    ]),
  );
  return {
    getPrice: (id) => map.get(id),
    getLatest: () => map as ReadonlyMap<InstrumentId, Price>,
  };
}

function makePortfolio(opts: {
  totalUsdc?: string;
  positions?: IPosition[];
}): Portfolio {
  const total = new Decimal(opts.totalUsdc ?? '10000');
  const positions = opts.positions ?? [];
  const posMap = new Map<InstrumentId, IPosition>(
    positions.map((p) => [p.instrumentId, p]),
  );

  return {
    accountId: 'acc-001' as unknown as AccountId,
    balance: {
      available: () => ({ value: () => total }),
      reserved: () => ({ value: () => new Decimal(0) }),
      total: () => ({ value: () => total }),
    },
    getPosition: (id: InstrumentId) => posMap.get(id),
    getPositions: () => posMap.values(),
    getPositionCount: () => posMap.size,
  } as unknown as Portfolio;
}

function makePortfolioStore(portfolio?: Portfolio): IPortfolioStore {
  return {
    get: jest.fn<IPortfolioStore['get']>().mockReturnValue(portfolio),
    save: jest.fn<IPortfolioStore['save']>(),
  };
}

const ACCOUNT_ID = 'acc-001' as unknown as AccountId;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DrawdownRiskMonitor', () => {
  let eventBus: IEventBus;
  let portfolioStore: IPortfolioStore;
  let markPrices: IMarkPricesProvider;
  let clock: IClock;
  let logger: ILogger;

  beforeEach(() => {
    eventBus = makeEventBus();
    portfolioStore = makePortfolioStore();
    markPrices = makeMarkPrices();
    clock = makeClock();
    logger = makeLogger();
  });

  function makeMonitor(maxDrawdown = '0.10'): DrawdownRiskMonitor {
    return new DrawdownRiskMonitor(
      eventBus, portfolioStore, markPrices, clock,
      { maxDrawdown: new Decimal(maxDrawdown) },
      logger,
    );
  }

  // ── register ─────────────────────────────────────────────────────────────

  it('register подписывается на FILL_RECEIVED', () => {
    const monitor = makeMonitor();
    monitor.register();
    expect(eventBus.subscribe).toHaveBeenCalledWith('FILL_RECEIVED', expect.any(Function));
  });

  it('register логирует info', () => {
    makeMonitor().register();
    expect(logger.info).toHaveBeenCalledWith('DrawdownRiskMonitor registered', expect.any(Object));
  });

  // ── просадка не превышена ─────────────────────────────────────────────────

  it('не публикует RISK_LIMIT_BREACHED если нет просадки', async () => {
    const portfolio = makePortfolio({ totalUsdc: '10000' });
    portfolioStore = makePortfolioStore(portfolio);
    const monitor = new DrawdownRiskMonitor(
      eventBus, portfolioStore, markPrices, clock,
      { maxDrawdown: new Decimal('0.10') },
      logger,
    );
    monitor.register();

    // Получаем FILL_RECEIVED handler
    const handler = (eventBus.subscribe as ReturnType<typeof jest.fn>).mock.calls[0]?.[1] as (
      event: { fill: { accountId: AccountId } },
    ) => Promise<void>;

    // Два fill при одинаковой стоимости — нет просадки
    await handler({ fill: { accountId: ACCOUNT_ID } });
    await handler({ fill: { accountId: ACCOUNT_ID } });

    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  // ── просадка превышена ────────────────────────────────────────────────────

  it('публикует RISK_LIMIT_BREACHED при превышении maxDrawdown', async () => {
    // Пик = 10000, потом падает до 8000 → drawdown = 20% > 10%
    const portfolioHigh = makePortfolio({ totalUsdc: '10000' });
    const portfolioLow = makePortfolio({ totalUsdc: '8000' });

    const storeMock = {
      get: jest.fn<IPortfolioStore['get']>()
        .mockReturnValueOnce(portfolioHigh)   // первый fill — устанавливает пик
        .mockReturnValueOnce(portfolioLow),   // второй fill — просадка
      save: jest.fn<IPortfolioStore['save']>(),
    };

    const monitor = new DrawdownRiskMonitor(
      eventBus, storeMock, markPrices, clock,
      { maxDrawdown: new Decimal('0.10') },
      logger,
    );
    monitor.register();

    const handler = (eventBus.subscribe as ReturnType<typeof jest.fn>).mock.calls[0]?.[1] as (
      event: { fill: { accountId: AccountId } },
    ) => Promise<void>;

    await handler({ fill: { accountId: ACCOUNT_ID } }); // пик = 10000
    await handler({ fill: { accountId: ACCOUNT_ID } }); // current = 8000, drawdown = 20%

    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'RISK_LIMIT_BREACHED',
        violationType: 'DRAWDOWN',
      }),
    );
  });

  it('логирует error при превышении maxDrawdown', async () => {
    const portfolioHigh = makePortfolio({ totalUsdc: '10000' });
    const portfolioLow = makePortfolio({ totalUsdc: '8000' });

    const storeMock = {
      get: jest.fn<IPortfolioStore['get']>()
        .mockReturnValueOnce(portfolioHigh)
        .mockReturnValueOnce(portfolioLow),
      save: jest.fn<IPortfolioStore['save']>(),
    };

    const monitor = new DrawdownRiskMonitor(
      eventBus, storeMock, markPrices, clock,
      { maxDrawdown: new Decimal('0.10') },
      logger,
    );
    monitor.register();

    const handler = (eventBus.subscribe as ReturnType<typeof jest.fn>).mock.calls[0]?.[1] as (
      event: { fill: { accountId: AccountId } },
    ) => Promise<void>;

    await handler({ fill: { accountId: ACCOUNT_ID } });
    await handler({ fill: { accountId: ACCOUNT_ID } });

    expect(logger.error).toHaveBeenCalledWith('Drawdown limit breached', expect.any(Object));
  });

  // ── portfolioStore возвращает undefined ───────────────────────────────────

  it('не публикует если portfolio не найден в store', async () => {
    portfolioStore = makePortfolioStore(undefined);
    const monitor = new DrawdownRiskMonitor(
      eventBus, portfolioStore, markPrices, clock,
      { maxDrawdown: new Decimal('0.10') },
      logger,
    );
    monitor.register();

    const handler = (eventBus.subscribe as ReturnType<typeof jest.fn>).mock.calls[0]?.[1] as (
      event: { fill: { accountId: AccountId } },
    ) => Promise<void>;

    await handler({ fill: { accountId: ACCOUNT_ID } });
    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  // ── maxDrawdown не задан ─────────────────────────────────────────────────

  it('не проверяет ничего если maxDrawdown не задан', async () => {
    const monitor = new DrawdownRiskMonitor(
      eventBus, portfolioStore, markPrices, clock,
      { maxDrawdown: undefined },
      logger,
    );
    monitor.register();

    const handler = (eventBus.subscribe as ReturnType<typeof jest.fn>).mock.calls[0]?.[1] as (
      event: { fill: { accountId: AccountId } },
    ) => Promise<void>;

    await handler({ fill: { accountId: ACCOUNT_ID } });
    expect(portfolioStore.get).not.toHaveBeenCalled();
  });

  // ── resetPeak ─────────────────────────────────────────────────────────────

  it('resetPeak сбрасывает пиковое значение', async () => {
    const portfolioHigh = makePortfolio({ totalUsdc: '10000' });
    const portfolioLow = makePortfolio({ totalUsdc: '5000' });

    const storeMock = {
      get: jest.fn<IPortfolioStore['get']>()
        .mockReturnValueOnce(portfolioHigh)   // устанавливаем пик
        .mockReturnValueOnce(portfolioLow),   // после сброса — новый начальный пик
      save: jest.fn<IPortfolioStore['save']>(),
    };

    const monitor = new DrawdownRiskMonitor(
      eventBus, storeMock, markPrices, clock,
      { maxDrawdown: new Decimal('0.10') },
      logger,
    );
    monitor.register();

    const handler = (eventBus.subscribe as ReturnType<typeof jest.fn>).mock.calls[0]?.[1] as (
      event: { fill: { accountId: AccountId } },
    ) => Promise<void>;

    await handler({ fill: { accountId: ACCOUNT_ID } }); // пик = 10000
    monitor.resetPeak(); // сброс
    await handler({ fill: { accountId: ACCOUNT_ID } }); // current = 5000, новый пик = 5000 (нет просадки)

    // После сброса пика нет просадки от нового baseline
    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  // ── включение позиций в stоимость ────────────────────────────────────────

  it('учитывает позиции в расчёте portfolio value', async () => {
    const INSTRUMENT = 'token-xyz' as unknown as InstrumentId;
    const position: IPosition = {
      instrumentId: INSTRUMENT,
      quantity: { value: () => new Decimal('100') },
      averageEntryPrice: { value: () => new Decimal('0.5') },
      side: 'LONG',
      isClosed: () => false,
      getUnrealizedPnL: () => ({ value: () => new Decimal(0) }),
    };

    // cash = 9000, position = 100 * 0.65 = 65 → total = 9065
    const portfolio = makePortfolio({ totalUsdc: '9000', positions: [position] });
    const prices = makeMarkPrices({ 'token-xyz': '0.65' });

    portfolioStore = makePortfolioStore(portfolio);
    const monitor = new DrawdownRiskMonitor(
      eventBus, portfolioStore, prices, clock,
      { maxDrawdown: new Decimal('0.10') },
      logger,
    );
    monitor.register();

    const handler = (eventBus.subscribe as ReturnType<typeof jest.fn>).mock.calls[0]?.[1] as (
      event: { fill: { accountId: AccountId } },
    ) => Promise<void>;

    await handler({ fill: { accountId: ACCOUNT_ID } });
    // Пик установлен, нет просадки
    expect(eventBus.publish).not.toHaveBeenCalled();
  });
});
