/**
 * Тесты для проверки minTimeToExpiryMs в OrderRiskChecker.
 *
 * @remarks
 * Покрывает приватный метод `_checkTimeToExpiry` через публичный `checkBeforeOrder()`.
 * Проверяемые сценарии:
 * - minTimeToExpiryMs не задан в параметрах → пропуск проверки
 * - timeToExpiryMs не передан во входных данных → пропуск проверки
 * - timeToExpiryMs >= minTimeToExpiryMs → проверка пройдена
 * - timeToExpiryMs < minTimeToExpiryMs → TOO_CLOSE_TO_EXPIRY
 * - граничное значение: timeToExpiryMs === minTimeToExpiryMs → проверка пройдена
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { OrderRiskChecker } from '../../src/OrderRiskChecker.js';
import type { PreOrderCheckInput } from '../../src/PreOrderCheckInput.js';
import type { ILogger } from '@polymarket/logger';
import type { Portfolio, IPosition } from '@polymarket/portfolio';
import type { InstrumentId } from '@polymarket/ids';
import type { Price, Quantity, Side } from '@polymarket/value-objects';
import Decimal from 'decimal.js';
import { jest } from '@jest/globals';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Создаёт mock ILogger со всеми методами */
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

/** Создаёт mock Portfolio с минимальными полями */
function makePortfolio(): Portfolio {
  const available = new Decimal('10000');
  return {
    balance: {
      available: () => ({ value: () => available }),
      reserved: () => ({ value: () => new Decimal(0) }),
      total: () => ({ value: () => available }),
    },
    getPosition: () => undefined,
    getPositions: () => new Map<InstrumentId, IPosition>().values(),
    getPositionCount: () => 0,
  } as unknown as Portfolio;
}

const INSTRUMENT_ID = 'token-abc' as unknown as InstrumentId;
const BUY = 'BUY' as unknown as Side;
const SELL = 'SELL' as unknown as Side;

/**
 * Создаёт PreOrderCheckInput с возможностью переопределения полей.
 *
 * @param overrides - Частичные переопределения входных данных
 * @returns Полный PreOrderCheckInput
 */
function makeInput(overrides: Partial<PreOrderCheckInput> = {}): PreOrderCheckInput {
  return {
    portfolio: makePortfolio(),
    openOrdersCount: 0,
    side: BUY,
    price: makePrice('0.50'),
    size: makeQty('10'),
    instrumentId: INSTRUMENT_ID,
    strategyId: 'test-strategy',
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OrderRiskChecker — minTimeToExpiryMs', () => {
  let logger: ILogger;

  beforeEach(() => {
    logger = makeLogger();
  });

  // ── Пропуск проверки (параметр не задан) ────────────────────────────────

  it('Ok если minTimeToExpiryMs не задан в RiskParams', () => {
    const checker = new OrderRiskChecker({}, logger);
    const result = checker.checkBeforeOrder(
      makeInput({ timeToExpiryMs: 1000 }),
    );
    expect(result.ok).toBe(true);
  });

  // ── Пропуск проверки (входное значение не передано) ─────────────────────

  it('Ok если timeToExpiryMs не передан во входных данных', () => {
    const checker = new OrderRiskChecker(
      { minTimeToExpiryMs: 60_000 },
      logger,
    );
    const result = checker.checkBeforeOrder(
      makeInput({ timeToExpiryMs: undefined }),
    );
    expect(result.ok).toBe(true);
  });

  it('Ok если оба параметра не заданы', () => {
    const checker = new OrderRiskChecker({}, logger);
    const result = checker.checkBeforeOrder(
      makeInput({ timeToExpiryMs: undefined }),
    );
    expect(result.ok).toBe(true);
  });

  // ── Проверка пройдена (timeToExpiryMs >= minTimeToExpiryMs) ─────────────

  it('Ok если timeToExpiryMs > minTimeToExpiryMs', () => {
    const checker = new OrderRiskChecker(
      { minTimeToExpiryMs: 60_000 },
      logger,
    );
    const result = checker.checkBeforeOrder(
      makeInput({ timeToExpiryMs: 120_000 }),
    );
    expect(result.ok).toBe(true);
  });

  it('Ok если timeToExpiryMs === minTimeToExpiryMs (граничное значение)', () => {
    const checker = new OrderRiskChecker(
      { minTimeToExpiryMs: 60_000 },
      logger,
    );
    const result = checker.checkBeforeOrder(
      makeInput({ timeToExpiryMs: 60_000 }),
    );
    expect(result.ok).toBe(true);
  });

  // ── Нарушение (timeToExpiryMs < minTimeToExpiryMs) ──────────────────────

  it('Err TOO_CLOSE_TO_EXPIRY если timeToExpiryMs < minTimeToExpiryMs', () => {
    const checker = new OrderRiskChecker(
      { minTimeToExpiryMs: 60_000 },
      logger,
    );
    const result = checker.checkBeforeOrder(
      makeInput({ timeToExpiryMs: 30_000 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.riskCode).toBe('TOO_CLOSE_TO_EXPIRY');
    }
  });

  it('Err TOO_CLOSE_TO_EXPIRY если timeToExpiryMs === 0', () => {
    const checker = new OrderRiskChecker(
      { minTimeToExpiryMs: 1000 },
      logger,
    );
    const result = checker.checkBeforeOrder(
      makeInput({ timeToExpiryMs: 0 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.riskCode).toBe('TOO_CLOSE_TO_EXPIRY');
    }
  });

  it('Err TOO_CLOSE_TO_EXPIRY содержит контекст с timeToExpiryMs и minTimeToExpiryMs', () => {
    const checker = new OrderRiskChecker(
      { minTimeToExpiryMs: 60_000 },
      logger,
    );
    const result = checker.checkBeforeOrder(
      makeInput({ timeToExpiryMs: 5_000 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('5000');
      expect(result.error.message).toContain('60000');
    }
  });

  // ── Логирование ─────────────────────────────────────────────────────────

  it('логирует warn при нарушении minTimeToExpiryMs', () => {
    const checker = new OrderRiskChecker(
      { minTimeToExpiryMs: 60_000 },
      logger,
    );
    checker.checkBeforeOrder(makeInput({ timeToExpiryMs: 10_000 }));
    expect(logger.warn).toHaveBeenCalledWith(
      'Risk limit violated',
      expect.objectContaining({
        riskCode: 'TOO_CLOSE_TO_EXPIRY',
        timeToExpiryMs: 10_000,
        minTimeToExpiryMs: 60_000,
      }),
    );
  });

  it('не логирует warn если проверка пройдена', () => {
    const checker = new OrderRiskChecker(
      { minTimeToExpiryMs: 60_000 },
      logger,
    );
    checker.checkBeforeOrder(makeInput({ timeToExpiryMs: 120_000 }));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  // ── SELL: не блокируется у экспирации ───────────────────────────────────

  it('Ok для SELL даже если timeToExpiryMs === 0', () => {
    // SELL ликвидирует позицию — блокировать нельзя, даже у самой экспирации
    const checker = new OrderRiskChecker(
      { minTimeToExpiryMs: 60_000 },
      logger,
    );
    const result = checker.checkBeforeOrder(
      makeInput({ side: SELL, timeToExpiryMs: 0 }),
    );
    expect(result.ok).toBe(true);
  });

  it('Ok для SELL если timeToExpiryMs < minTimeToExpiryMs', () => {
    const checker = new OrderRiskChecker(
      { minTimeToExpiryMs: 30_000 },
      logger,
    );
    const result = checker.checkBeforeOrder(
      makeInput({ side: SELL, timeToExpiryMs: 5_000 }),
    );
    expect(result.ok).toBe(true);
  });

  // ── fail-fast: проверка expiry первая в цепочке ─────────────────────────

  it('fail-fast: TOO_CLOSE_TO_EXPIRY возвращается раньше MAX_OPEN_ORDERS_EXCEEDED', () => {
    const checker = new OrderRiskChecker(
      { minTimeToExpiryMs: 60_000, maxOpenOrders: 1 },
      logger,
    );
    const result = checker.checkBeforeOrder(
      makeInput({ timeToExpiryMs: 1_000, openOrdersCount: 100 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.riskCode).toBe('TOO_CLOSE_TO_EXPIRY');
    }
  });

  // ── updateParams: обновление minTimeToExpiryMs ──────────────────────────

  it('updateParams обновляет minTimeToExpiryMs в runtime', () => {
    const checker = new OrderRiskChecker({}, logger);
    // до обновления: нет лимита → ok
    expect(
      checker.checkBeforeOrder(makeInput({ timeToExpiryMs: 1_000 })).ok,
    ).toBe(true);

    // после обновления: 1000 < 60000 → fail
    checker.updateParams({ minTimeToExpiryMs: 60_000 });
    const result = checker.checkBeforeOrder(
      makeInput({ timeToExpiryMs: 1_000 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.riskCode).toBe('TOO_CLOSE_TO_EXPIRY');
    }
  });
});
