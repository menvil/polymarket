/**
 * Тесты для проверки minTimeToExpiryMs в OrderRiskChecker.
 *
 * @remarks
 * Покрывает приватный метод `_checkTimeToExpiry` через публичный `checkBeforeOrder()`.
 * Проверяемые сценарии:
 * - minTimeToExpiryMs не задан в параметрах → пропуск проверки
 * - BUY + лимит включён + timeToExpiryMs недоступно → RISK_INPUT_INCOMPLETE (fail-closed)
 * - SELL при недоступном/близком expiry → пропуск (ликвидация не блокируется)
 * - timeToExpiryMs >= minTimeToExpiryMs → проверка пройдена
 * - timeToExpiryMs < minTimeToExpiryMs (или отрицательное) → TOO_CLOSE_TO_EXPIRY
 * - граничное значение: timeToExpiryMs === minTimeToExpiryMs → проверка пройдена
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { unsafeStrategyId } from '@polymarket/ids';
import { OrderRiskChecker } from '../../src/OrderRiskChecker.js';
import { RiskPolicy } from '../../src/RiskPolicy.js';
import type { RiskParams } from '../../src/RiskParams.js';
import type { PreOrderCheckInput } from '../../src/PreOrderCheckInput.js';
import type { ILogger } from '@polymarket/logger';
import type { Portfolio, IPosition } from '@polymarket/portfolio';
import type { InstrumentId } from '@polymarket/ids';
import type { OutcomePrice, Quantity, Side } from '@polymarket/value-objects';
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

/** Строит OrderRiskChecker из валидных RiskParams (через RiskPolicy.create). */
function makeChecker(params: RiskParams, logger: ILogger): OrderRiskChecker {
  const r = RiskPolicy.create(params);
  if (!r.ok) throw r.error;
  return new OrderRiskChecker(r.value, logger);
}

/** Создаёт mock OutcomePrice с заданным Decimal-значением */
function makePrice(val: string): OutcomePrice {
  return { value: () => new Decimal(val) } as unknown as OutcomePrice;
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
    pendingBuyQuantityForInstrument: makeQty('0'),
    strategyId: unsafeStrategyId('test-strategy'),
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
    const checker = makeChecker({}, logger);
    const result = checker.checkBeforeOrder(
      makeInput({ timeToExpiryMs: 1000 }),
    );
    expect(result.ok).toBe(true);
  });

  // ── Fail-closed (BUY + лимит включён + значение недоступно) ──────────────

  it('Err RISK_INPUT_INCOMPLETE для BUY если timeToExpiryMs не передан, а лимит включён', () => {
    const checker = makeChecker(
      { minTimeToExpiryMs: 60_000 },
      logger,
    );
    const result = checker.checkBeforeOrder(
      makeInput({ timeToExpiryMs: undefined }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.riskCode).toBe('RISK_INPUT_INCOMPLETE');
    }
  });

  it('Ok если оба параметра не заданы', () => {
    const checker = makeChecker({}, logger);
    const result = checker.checkBeforeOrder(
      makeInput({ timeToExpiryMs: undefined }),
    );
    expect(result.ok).toBe(true);
  });

  // ── Проверка пройдена (timeToExpiryMs >= minTimeToExpiryMs) ─────────────

  it('Ok если timeToExpiryMs > minTimeToExpiryMs', () => {
    const checker = makeChecker(
      { minTimeToExpiryMs: 60_000 },
      logger,
    );
    const result = checker.checkBeforeOrder(
      makeInput({ timeToExpiryMs: 120_000 }),
    );
    expect(result.ok).toBe(true);
  });

  it('Ok если timeToExpiryMs === minTimeToExpiryMs (граничное значение)', () => {
    const checker = makeChecker(
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
    const checker = makeChecker(
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
    const checker = makeChecker(
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
    const checker = makeChecker(
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
    const checker = makeChecker(
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
    const checker = makeChecker(
      { minTimeToExpiryMs: 60_000 },
      logger,
    );
    checker.checkBeforeOrder(makeInput({ timeToExpiryMs: 120_000 }));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  // ── SELL: не блокируется у экспирации ───────────────────────────────────

  it('Ok для SELL даже если timeToExpiryMs === 0', () => {
    // SELL ликвидирует позицию — блокировать нельзя, даже у самой экспирации
    const checker = makeChecker(
      { minTimeToExpiryMs: 60_000 },
      logger,
    );
    const result = checker.checkBeforeOrder(
      makeInput({ side: SELL, timeToExpiryMs: 0 }),
    );
    expect(result.ok).toBe(true);
  });

  it('Ok для SELL если timeToExpiryMs < minTimeToExpiryMs', () => {
    const checker = makeChecker(
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
    const checker = makeChecker(
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

  it('Ok для SELL даже если timeToExpiryMs не передан (лимит включён)', () => {
    const checker = makeChecker(
      { minTimeToExpiryMs: 60_000 },
      logger,
    );
    const result = checker.checkBeforeOrder(
      makeInput({ side: SELL, timeToExpiryMs: undefined }),
    );
    expect(result.ok).toBe(true);
  });
});
