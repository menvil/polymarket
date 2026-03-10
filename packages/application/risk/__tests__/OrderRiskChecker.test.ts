import { describe, it, expect, beforeEach } from '@jest/globals';
import { OrderRiskChecker } from '../src/OrderRiskChecker.js';
import type { PreOrderCheckInput } from '../src/PreOrderCheckInput.js';
import type { ILogger } from '@polymarket/logger';
import type { Portfolio, IPosition } from '@polymarket/portfolio';
import type { InstrumentId } from '@polymarket/ids';
import type { Price, Quantity, Side } from '@polymarket/value-objects';
import Decimal from 'decimal.js';
import { jest } from '@jest/globals';

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

/** Создаёт mock Price с заданным Decimal-значением */
function makePrice(val: string): Price {
  return { value: () => new Decimal(val) } as unknown as Price;
}

/** Создаёт mock Quantity с заданным Decimal-значением */
function makeQty(val: string): Quantity {
  return { value: () => new Decimal(val) } as unknown as Quantity;
}

/** Создаёт mock IPosition */
function makePosition(
  instrumentId: InstrumentId,
  quantity: string,
  entryPrice: string,
  side: 'LONG' | 'SHORT' = 'LONG',
): IPosition {
  return {
    instrumentId,
    quantity: { value: () => new Decimal(quantity) },
    averageEntryPrice: { value: () => new Decimal(entryPrice) },
    side,
    isClosed: () => false,
    getUnrealizedPnL: () => ({ value: () => new Decimal(0) }),
  };
}

/** Создаёт mock Portfolio */
function makePortfolio(opts: {
  availableUsdc?: string;
  positions?: IPosition[];
}): Portfolio {
  const available = new Decimal(opts.availableUsdc ?? '10000');
  const positions = opts.positions ?? [];
  const posMap = new Map<InstrumentId, IPosition>(
    positions.map((p) => [p.instrumentId, p]),
  );

  return {
    balance: {
      available: () => ({ value: () => available }),
      reserved: () => ({ value: () => new Decimal(0) }),
      total: () => ({ value: () => available }),
    },
    getPosition: (id: InstrumentId) => posMap.get(id),
    getPositions: () => posMap.values(),
    getPositionCount: () => posMap.size,
  } as unknown as Portfolio;
}

const INSTRUMENT_ID = 'token-abc' as unknown as InstrumentId;
const BUY = 'BUY' as unknown as Side;
const SELL = 'SELL' as unknown as Side;

function makeInput(overrides: Partial<PreOrderCheckInput> = {}): PreOrderCheckInput {
  return {
    portfolio: makePortfolio({}),
    openOrdersCount: 0,
    side: BUY,
    price: makePrice('0.65'),
    size: makeQty('100'),
    instrumentId: INSTRUMENT_ID,
    strategyId: 'test-strategy',
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OrderRiskChecker', () => {
  let logger: ILogger;

  beforeEach(() => {
    logger = makeLogger();
  });

  // ── Нет лимитов ──────────────────────────────────────────────────────────

  it('Ok если нет лимитов', () => {
    const checker = new OrderRiskChecker({}, logger);
    const result = checker.checkBeforeOrder(makeInput());
    expect(result.ok).toBe(true);
  });

  // ── maxOpenOrders ────────────────────────────────────────────────────────

  it('Ok если openOrdersCount < maxOpenOrders', () => {
    const checker = new OrderRiskChecker({ maxOpenOrders: 5 }, logger);
    expect(checker.checkBeforeOrder(makeInput({ openOrdersCount: 4 })).ok).toBe(true);
  });

  it('Err если openOrdersCount >= maxOpenOrders', () => {
    const checker = new OrderRiskChecker({ maxOpenOrders: 5 }, logger);
    const result = checker.checkBeforeOrder(makeInput({ openOrdersCount: 5 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.riskCode).toBe('MAX_OPEN_ORDERS_EXCEEDED');
    }
  });

  it('fail-fast: не проверяет остальные лимиты после maxOpenOrders', () => {
    const checker = new OrderRiskChecker(
      { maxOpenOrders: 1, maxOrderNotional: new Decimal('10') }, // notional тоже нарушен
      logger,
    );
    const result = checker.checkBeforeOrder(
      makeInput({ openOrdersCount: 2, price: makePrice('0.9'), size: makeQty('1000') }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.riskCode).toBe('MAX_OPEN_ORDERS_EXCEEDED');
    }
  });

  // ── maxOrderNotional ─────────────────────────────────────────────────────

  it('Ok если notional <= maxOrderNotional', () => {
    // 0.65 * 100 = 65
    const checker = new OrderRiskChecker({ maxOrderNotional: new Decimal('65') }, logger);
    expect(checker.checkBeforeOrder(makeInput()).ok).toBe(true);
  });

  it('Err если notional > maxOrderNotional', () => {
    // 0.65 * 100 = 65 > 64
    const checker = new OrderRiskChecker({ maxOrderNotional: new Decimal('64') }, logger);
    const result = checker.checkBeforeOrder(makeInput());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.riskCode).toBe('ORDER_NOTIONAL_EXCEEDED');
  });

  // ── minAvailableBalance ──────────────────────────────────────────────────

  it('Ok если balance после резервирования >= minAvailableBalance', () => {
    // available=10000, notional=65, after=9935 >= 9000
    const checker = new OrderRiskChecker(
      { minAvailableBalance: new Decimal('9000') },
      logger,
    );
    expect(checker.checkBeforeOrder(makeInput()).ok).toBe(true);
  });

  it('Err если balance после резервирования < minAvailableBalance', () => {
    // available=100, notional=65, after=35 < 50
    const checker = new OrderRiskChecker(
      { minAvailableBalance: new Decimal('50') },
      logger,
    );
    const portfolio = makePortfolio({ availableUsdc: '100' });
    const result = checker.checkBeforeOrder(makeInput({ portfolio }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.riskCode).toBe('INSUFFICIENT_AVAILABLE_BALANCE');
  });

  // ── maxPositionSize ───────────────────────────────────────────────────────

  it('Ok BUY если позиция + size <= maxPositionSize', () => {
    const position = makePosition(INSTRUMENT_ID, '50', '0.60');
    const portfolio = makePortfolio({ positions: [position] });
    const checker = new OrderRiskChecker({ maxPositionSize: new Decimal('200') }, logger);
    // 50 + 100 = 150 <= 200
    expect(checker.checkBeforeOrder(makeInput({ portfolio })).ok).toBe(true);
  });

  it('Err BUY если позиция + size > maxPositionSize', () => {
    const position = makePosition(INSTRUMENT_ID, '150', '0.60');
    const portfolio = makePortfolio({ positions: [position] });
    const checker = new OrderRiskChecker({ maxPositionSize: new Decimal('200') }, logger);
    // 150 + 100 = 250 > 200
    const result = checker.checkBeforeOrder(makeInput({ portfolio }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.riskCode).toBe('POSITION_LIMIT_EXCEEDED');
  });

  it('SELL не проверяет maxPositionSize (закрытие)', () => {
    const position = makePosition(INSTRUMENT_ID, '5000', '0.60');
    const portfolio = makePortfolio({ positions: [position] });
    const checker = new OrderRiskChecker({ maxPositionSize: new Decimal('1') }, logger);
    // SELL — лимит на размер не применяется
    expect(checker.checkBeforeOrder(makeInput({ portfolio, side: SELL })).ok).toBe(true);
  });

  it('Ok BUY если нет существующей позиции', () => {
    const checker = new OrderRiskChecker({ maxPositionSize: new Decimal('200') }, logger);
    // нет позиции → 0 + 100 = 100 <= 200
    expect(checker.checkBeforeOrder(makeInput()).ok).toBe(true);
  });

  // ── maxTotalExposure ──────────────────────────────────────────────────────

  it('Ok если total exposure <= maxTotalExposure', () => {
    // positions exposure = 50 * 0.60 = 30, orderNotional = 65 → total = 95 <= 200
    const position = makePosition(INSTRUMENT_ID, '50', '0.60');
    const portfolio = makePortfolio({ positions: [position] });
    const checker = new OrderRiskChecker({ maxTotalExposure: new Decimal('200') }, logger);
    expect(checker.checkBeforeOrder(makeInput({ portfolio })).ok).toBe(true);
  });

  it('Err если total exposure > maxTotalExposure', () => {
    // positions exposure = 500 * 0.80 = 400, orderNotional = 65 → total = 465 > 400
    const position = makePosition(INSTRUMENT_ID, '500', '0.80');
    const portfolio = makePortfolio({ positions: [position] });
    const checker = new OrderRiskChecker({ maxTotalExposure: new Decimal('400') }, logger);
    const result = checker.checkBeforeOrder(makeInput({ portfolio }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.riskCode).toBe('TOTAL_EXPOSURE_EXCEEDED');
  });

  // ── updateParams ──────────────────────────────────────────────────────────

  it('updateParams обновляет лимиты в runtime', () => {
    const checker = new OrderRiskChecker({ maxOpenOrders: 5 }, logger);
    // до обновления: ok (1 < 5)
    expect(checker.checkBeforeOrder(makeInput({ openOrdersCount: 1 })).ok).toBe(true);
    // после обновления: fail (1 >= 1)
    checker.updateParams({ maxOpenOrders: 1 });
    expect(checker.checkBeforeOrder(makeInput({ openOrdersCount: 1 })).ok).toBe(false);
  });

  it('updateParams логирует info', () => {
    const checker = new OrderRiskChecker({}, logger);
    checker.updateParams({ maxOpenOrders: 10 });
    expect(logger.info).toHaveBeenCalledWith('Risk params updated', expect.any(Object));
  });

  // ── логирование ──────────────────────────────────────────────────────────

  it('логирует warn при нарушении лимита', () => {
    const checker = new OrderRiskChecker({ maxOpenOrders: 1 }, logger);
    checker.checkBeforeOrder(makeInput({ openOrdersCount: 5 }));
    expect(logger.warn).toHaveBeenCalledWith('Risk limit violated', expect.any(Object));
  });
});
