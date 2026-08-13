import { describe, it, expect, beforeEach } from '@jest/globals';
import { unsafeStrategyId } from '@polymarket/ids';
import { OrderRiskChecker } from '../src/OrderRiskChecker.js';
import { RiskPolicy } from '../src/RiskPolicy.js';
import type { RiskParams } from '../src/RiskParams.js';
import type { PreOrderCheckInput } from '../src/PreOrderCheckInput.js';
import type { ILogger } from '@polymarket/logger';
import type { Portfolio, IPosition } from '@polymarket/portfolio';
import type { InstrumentId } from '@polymarket/ids';
import type { Price, Side } from '@polymarket/value-objects';
import { Money, Quantity } from '@polymarket/value-objects';
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

/**
 * Строит OrderRiskChecker из валидных RiskParams (через RiskPolicy.create).
 * Бросает, если параметры невалидны — в тестах поведения используем только
 * валидные конфигурации.
 */
function makeChecker(params: RiskParams, logger: ILogger): OrderRiskChecker {
  const r = RiskPolicy.create(params);
  if (!r.ok) throw r.error;
  return new OrderRiskChecker(r.value, logger);
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
  reservedUsdc?: string;
  positions?: IPosition[];
}): Portfolio {
  const available = new Decimal(opts.availableUsdc ?? '10000');
  const reserved = new Decimal(opts.reservedUsdc ?? '0');
  const positions = opts.positions ?? [];
  const posMap = new Map<InstrumentId, IPosition>(
    positions.map((p) => [p.instrumentId, p]),
  );

  return {
    balance: {
      available: () => ({ value: () => available }),
      reserved: () => ({ value: () => reserved }),
      total: () => ({ value: () => available.plus(reserved) }),
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
    pendingBuyQuantityForInstrument: makeQty('0'),
    strategyId: unsafeStrategyId('test-strategy'),
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
    const checker = makeChecker({}, logger);
    const result = checker.checkBeforeOrder(makeInput());
    expect(result.ok).toBe(true);
  });

  // ── maxOpenOrders ────────────────────────────────────────────────────────

  it('Ok если openOrdersCount < maxOpenOrders', () => {
    const checker = makeChecker({ maxOpenOrders: 5 }, logger);
    expect(checker.checkBeforeOrder(makeInput({ openOrdersCount: 4 })).ok).toBe(true);
  });

  it('Err если openOrdersCount >= maxOpenOrders', () => {
    const checker = makeChecker({ maxOpenOrders: 5 }, logger);
    const result = checker.checkBeforeOrder(makeInput({ openOrdersCount: 5 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.riskCode).toBe('MAX_OPEN_ORDERS_EXCEEDED');
    }
  });

  it('fail-fast: не проверяет остальные лимиты после maxOpenOrders', () => {
    const checker = makeChecker(
      { maxOpenOrders: 1, maxOrderNotional: Money.of(new Decimal('10'), 'USDC') }, // notional тоже нарушен
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
    const checker = makeChecker({ maxOrderNotional: Money.of(new Decimal('65'), 'USDC') }, logger);
    expect(checker.checkBeforeOrder(makeInput()).ok).toBe(true);
  });

  it('Err если notional > maxOrderNotional', () => {
    // 0.65 * 100 = 65 > 64
    const checker = makeChecker({ maxOrderNotional: Money.of(new Decimal('64'), 'USDC') }, logger);
    const result = checker.checkBeforeOrder(makeInput());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.riskCode).toBe('ORDER_NOTIONAL_EXCEEDED');
  });

  // ── minAvailableBalance ──────────────────────────────────────────────────

  it('Ok если balance после резервирования >= minAvailableBalance', () => {
    // available=10000, notional=65, after=9935 >= 9000
    const checker = makeChecker(
      { minAvailableBalance: Money.of(new Decimal('9000'), 'USDC') },
      logger,
    );
    expect(checker.checkBeforeOrder(makeInput()).ok).toBe(true);
  });

  it('Err если balance после резервирования < minAvailableBalance', () => {
    // available=100, notional=65, after=35 < 50
    const checker = makeChecker(
      { minAvailableBalance: Money.of(new Decimal('50'), 'USDC') },
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
    const checker = makeChecker({ maxPositionSize: Quantity.of(new Decimal('200')) }, logger);
    // 50 + 100 = 150 <= 200
    expect(checker.checkBeforeOrder(makeInput({ portfolio })).ok).toBe(true);
  });

  it('Err BUY если позиция + size > maxPositionSize', () => {
    const position = makePosition(INSTRUMENT_ID, '150', '0.60');
    const portfolio = makePortfolio({ positions: [position] });
    const checker = makeChecker({ maxPositionSize: Quantity.of(new Decimal('200')) }, logger);
    // 150 + 100 = 250 > 200
    const result = checker.checkBeforeOrder(makeInput({ portfolio }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.riskCode).toBe('POSITION_LIMIT_EXCEEDED');
  });

  it('SELL не проверяет maxPositionSize (закрытие)', () => {
    const position = makePosition(INSTRUMENT_ID, '5000', '0.60');
    const portfolio = makePortfolio({ positions: [position] });
    const checker = makeChecker({ maxPositionSize: Quantity.of(new Decimal('1')) }, logger);
    // SELL — лимит на размер не применяется
    expect(checker.checkBeforeOrder(makeInput({ portfolio, side: SELL })).ok).toBe(true);
  });

  it('Ok BUY если нет существующей позиции', () => {
    const checker = makeChecker({ maxPositionSize: Quantity.of(new Decimal('200')) }, logger);
    // нет позиции → 0 + 100 = 100 <= 200
    expect(checker.checkBeforeOrder(makeInput()).ok).toBe(true);
  });

  // ── maxTotalExposure ──────────────────────────────────────────────────────

  it('Ok если total exposure <= maxTotalExposure', () => {
    // positions exposure = 50 * 0.60 = 30, orderNotional = 65 → total = 95 <= 200
    const position = makePosition(INSTRUMENT_ID, '50', '0.60');
    const portfolio = makePortfolio({ positions: [position] });
    const checker = makeChecker({ maxTotalExposure: Money.of(new Decimal('200'), 'USDC') }, logger);
    expect(checker.checkBeforeOrder(makeInput({ portfolio })).ok).toBe(true);
  });

  it('Err если total exposure > maxTotalExposure', () => {
    // positions exposure = 500 * 0.80 = 400, orderNotional = 65 → total = 465 > 400
    const position = makePosition(INSTRUMENT_ID, '500', '0.80');
    const portfolio = makePortfolio({ positions: [position] });
    const checker = makeChecker({ maxTotalExposure: Money.of(new Decimal('400'), 'USDC') }, logger);
    const result = checker.checkBeforeOrder(makeInput({ portfolio }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.riskCode).toBe('TOTAL_EXPOSURE_EXCEEDED');
  });

  it('total exposure учитывает reserved USDC (pending BUY-ордера)', () => {
    // costBasis=0, reserved=350, newNotional=65 → total=415 > 400
    const portfolio = makePortfolio({ reservedUsdc: '350' });
    const checker = makeChecker({ maxTotalExposure: Money.of(new Decimal('400'), 'USDC') }, logger);
    const result = checker.checkBeforeOrder(makeInput({ portfolio }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.riskCode).toBe('TOTAL_EXPOSURE_EXCEEDED');
  });

  it('SELL не проверяет maxTotalExposure (ликвидация)', () => {
    // Экспозиция 150 при лимите 100 — SELL должен проходить.
    const position = makePosition(INSTRUMENT_ID, '150', '1.00');
    const portfolio = makePortfolio({ positions: [position] });
    const checker = makeChecker({ maxTotalExposure: Money.of(new Decimal('100'), 'USDC') }, logger);
    expect(checker.checkBeforeOrder(makeInput({ portfolio, side: SELL })).ok).toBe(true);
  });

  // ── maxPositionSize: pending BUY quantity ────────────────────────────────

  it('Err BUY если filled + pending + new > maxPositionSize', () => {
    // filled=40, pending=40, new=40 → 120 > 100
    const position = makePosition(INSTRUMENT_ID, '40', '0.60');
    const portfolio = makePortfolio({ positions: [position] });
    const checker = makeChecker({ maxPositionSize: Quantity.of(new Decimal('100')) }, logger);
    const result = checker.checkBeforeOrder(makeInput({
      portfolio,
      size: makeQty('40'),
      pendingBuyQuantityForInstrument: makeQty('40'),
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.riskCode).toBe('POSITION_LIMIT_EXCEEDED');
  });

  it('Ok BUY если filled + pending + new <= maxPositionSize', () => {
    // filled=20, pending=20, new=20 → 60 <= 100
    const position = makePosition(INSTRUMENT_ID, '20', '0.60');
    const portfolio = makePortfolio({ positions: [position] });
    const checker = makeChecker({ maxPositionSize: Quantity.of(new Decimal('100')) }, logger);
    expect(checker.checkBeforeOrder(makeInput({
      portfolio,
      size: makeQty('20'),
      pendingBuyQuantityForInstrument: makeQty('20'),
    })).ok).toBe(true);
  });

  it('SELL игнорирует pendingBuyQuantityForInstrument', () => {
    const position = makePosition(INSTRUMENT_ID, '90', '0.60');
    const portfolio = makePortfolio({ positions: [position] });
    const checker = makeChecker({ maxPositionSize: Quantity.of(new Decimal('100')) }, logger);
    // filled 90 + pending 90 + new 90 всё > 100, но SELL не проверяет position
    expect(checker.checkBeforeOrder(makeInput({
      portfolio,
      side: SELL,
      size: makeQty('90'),
      pendingBuyQuantityForInstrument: makeQty('90'),
    })).ok).toBe(true);
  });

  // ── RISK_INPUT_INCOMPLETE (fail-closed expiry) ───────────────────────────

  it('Err RISK_INPUT_INCOMPLETE для BUY если expiry-лимит включён, а timeToExpiryMs недоступно', () => {
    const checker = makeChecker({ minTimeToExpiryMs: 60_000 }, logger);
    const result = checker.checkBeforeOrder(makeInput({ timeToExpiryMs: undefined }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.riskCode).toBe('RISK_INPUT_INCOMPLETE');
  });

  it('SELL проходит при недоступном expiry (expiry-лимит включён)', () => {
    const checker = makeChecker({ minTimeToExpiryMs: 60_000 }, logger);
    expect(checker.checkBeforeOrder(makeInput({ side: SELL, timeToExpiryMs: undefined })).ok).toBe(true);
  });

  it('Err TOO_CLOSE_TO_EXPIRY для BUY при отрицательном timeToExpiryMs (рынок истёк)', () => {
    const checker = makeChecker({ minTimeToExpiryMs: 0 }, logger);
    const result = checker.checkBeforeOrder(makeInput({ timeToExpiryMs: -1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.riskCode).toBe('TOO_CLOSE_TO_EXPIRY');
  });

  // ── Fail-closed валидация входов ──────────────────────────────────────────

  it('Err RISK_INPUT_INCOMPLETE для BUY если pendingBuyQuantityForInstrument = NaN', () => {
    const checker = makeChecker({ maxPositionSize: Quantity.of(new Decimal('100')) }, logger);
    const result = checker.checkBeforeOrder(makeInput({ pendingBuyQuantityForInstrument: makeQty('NaN') }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.riskCode).toBe('RISK_INPUT_INCOMPLETE');
  });

  it('Err RISK_INPUT_INCOMPLETE для BUY если pending отрицательный', () => {
    const checker = makeChecker({ maxPositionSize: Quantity.of(new Decimal('100')) }, logger);
    const result = checker.checkBeforeOrder(makeInput({ pendingBuyQuantityForInstrument: makeQty('-1') }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.riskCode).toBe('RISK_INPUT_INCOMPLETE');
  });

  it('Err RISK_INPUT_INCOMPLETE если pending не Quantity (сторонний adapter, .value() бросает)', () => {
    const checker = makeChecker({ maxPositionSize: Quantity.of(new Decimal('100')) }, logger);
    // Имитируем повреждённый adapter, вернувший голый number вместо Quantity —
    // .value() на числе бросает TypeError, перехватывается defensively.
    const result = checker.checkBeforeOrder(makeInput({
      pendingBuyQuantityForInstrument: 50 as unknown as Quantity,
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.riskCode).toBe('RISK_INPUT_INCOMPLETE');
  });

  it('Err RISK_INPUT_INCOMPLETE если openOrdersCount отрицательный/дробный', () => {
    const checker = makeChecker({ maxOpenOrders: 5 }, logger);
    expect(checker.checkBeforeOrder(makeInput({ openOrdersCount: -1 })).ok).toBe(false);
    const frac = checker.checkBeforeOrder(makeInput({ openOrdersCount: 1.5 }));
    expect(frac.ok).toBe(false);
    if (!frac.ok) expect(frac.error.riskCode).toBe('RISK_INPUT_INCOMPLETE');
  });

  it('Err RISK_INPUT_INCOMPLETE если timeToExpiryMs не finite (Infinity)', () => {
    const checker = makeChecker({ minTimeToExpiryMs: 1000 }, logger);
    const result = checker.checkBeforeOrder(makeInput({ timeToExpiryMs: Infinity }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.riskCode).toBe('RISK_INPUT_INCOMPLETE');
  });

  it('SELL с невалидным pending НЕ блокируется (pending для SELL не используется)', () => {
    const checker = makeChecker({ maxPositionSize: Quantity.of(new Decimal('100')) }, logger);
    // SELL: pending нерелевантен — даже мусорное значение не должно блокировать.
    const result = checker.checkBeforeOrder(makeInput({
      side: SELL,
      pendingBuyQuantityForInstrument: makeQty('NaN'),
    }));
    expect(result.ok).toBe(true);
  });

  // ── side fail-closed ───────────────────────────────────────────────────────

  it('Err RISK_INPUT_INCOMPLETE для неизвестного side (даже при пустой политике)', () => {
    const checker = makeChecker({}, logger);
    const result = checker.checkBeforeOrder(makeInput({ side: 'UNKNOWN' as unknown as Side }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.riskCode).toBe('RISK_INPUT_INCOMPLETE');
  });

  // ── price / size / notional fail-closed ───────────────────────────────────

  it('Err RISK_INPUT_INCOMPLETE если price.value() = NaN', () => {
    const checker = makeChecker({ maxOrderNotional: Money.of(new Decimal('1000'), 'USDC') }, logger);
    const result = checker.checkBeforeOrder(makeInput({ price: makePrice('NaN') }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.riskCode).toBe('RISK_INPUT_INCOMPLETE');
  });

  it('Err RISK_INPUT_INCOMPLETE если size.value() = Infinity', () => {
    const checker = makeChecker({ maxOrderNotional: Money.of(new Decimal('1000'), 'USDC') }, logger);
    const result = checker.checkBeforeOrder(makeInput({ size: makeQty('Infinity') }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.riskCode).toBe('RISK_INPUT_INCOMPLETE');
  });

  it('Err RISK_INPUT_INCOMPLETE если size <= 0 (zero и отрицательный)', () => {
    const checker = makeChecker({}, logger);
    expect(checker.checkBeforeOrder(makeInput({ size: makeQty('0') })).ok).toBe(false);
    const neg = checker.checkBeforeOrder(makeInput({ size: makeQty('-5') }));
    expect(neg.ok).toBe(false);
    if (!neg.ok) expect(neg.error.riskCode).toBe('RISK_INPUT_INCOMPLETE');
  });

  it('Err RISK_INPUT_INCOMPLETE если price.value() бросает (повреждённый VO)', () => {
    const checker = makeChecker({}, logger);
    const throwingPrice = { value: () => { throw new Error('bad price VO'); } } as unknown as Price;
    const result = checker.checkBeforeOrder(makeInput({ price: throwingPrice }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.riskCode).toBe('RISK_INPUT_INCOMPLETE');
  });

  // ── portfolio-derived fail-closed ─────────────────────────────────────────

  it('Err RISK_INPUT_INCOMPLETE если reserved = NaN при активном maxTotalExposure + BUY', () => {
    const portfolio = makePortfolio({ reservedUsdc: 'NaN' });
    const checker = makeChecker({ maxTotalExposure: Money.of(new Decimal('100'), 'USDC') }, logger);
    const result = checker.checkBeforeOrder(makeInput({ portfolio }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.riskCode).toBe('RISK_INPUT_INCOMPLETE');
  });

  // ── boundary: projected position (=== allow, > reject) ────────────────────

  it('projectedPosition === maxPositionSize → allow', () => {
    // filled 40 + pending 30 + new 30 = 100 == limit 100 → allow
    const position = makePosition(INSTRUMENT_ID, '40', '0.60');
    const portfolio = makePortfolio({ positions: [position] });
    const checker = makeChecker({ maxPositionSize: Quantity.of(new Decimal('100')) }, logger);
    expect(checker.checkBeforeOrder(makeInput({
      portfolio,
      size: makeQty('30'),
      pendingBuyQuantityForInstrument: makeQty('30'),
    })).ok).toBe(true);
  });

  it('projectedPosition > maxPositionSize → reject', () => {
    // filled 40 + pending 30 + new 31 = 101 > 100 → reject
    const position = makePosition(INSTRUMENT_ID, '40', '0.60');
    const portfolio = makePortfolio({ positions: [position] });
    const checker = makeChecker({ maxPositionSize: Quantity.of(new Decimal('100')) }, logger);
    const result = checker.checkBeforeOrder(makeInput({
      portfolio,
      size: makeQty('31'),
      pendingBuyQuantityForInstrument: makeQty('30'),
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.riskCode).toBe('POSITION_LIMIT_EXCEEDED');
  });

  // ── boundary: projected exposure (=== allow, > reject) ────────────────────

  it('projectedExposure === maxTotalExposure → allow', () => {
    // costBasis 0 + reserved 40 + notional (0.6×100=60) = 100 == limit 100 → allow
    const portfolio = makePortfolio({ reservedUsdc: '40' });
    const checker = makeChecker({ maxTotalExposure: Money.of(new Decimal('100'), 'USDC') }, logger);
    expect(checker.checkBeforeOrder(makeInput({
      portfolio,
      price: makePrice('0.6'),
      size: makeQty('100'),
    })).ok).toBe(true);
  });

  it('projectedExposure > maxTotalExposure → reject', () => {
    // costBasis 0 + reserved 41 + notional 60 = 101 > 100 → reject
    const portfolio = makePortfolio({ reservedUsdc: '41' });
    const checker = makeChecker({ maxTotalExposure: Money.of(new Decimal('100'), 'USDC') }, logger);
    const result = checker.checkBeforeOrder(makeInput({
      portfolio,
      price: makePrice('0.6'),
      size: makeQty('100'),
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.riskCode).toBe('TOTAL_EXPOSURE_EXCEEDED');
  });

  // ── SELL сохраняет operational limits ─────────────────────────────────────

  it('SELL блокируется maxOpenOrders (антиспам сохраняется)', () => {
    const checker = makeChecker({ maxOpenOrders: 5 }, logger);
    const result = checker.checkBeforeOrder(makeInput({ side: SELL, openOrdersCount: 5 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.riskCode).toBe('MAX_OPEN_ORDERS_EXCEEDED');
  });

  it('SELL блокируется maxOrderNotional (fat-finger guard сохраняется)', () => {
    // 0.65 × 100 = 65 > 64
    const checker = makeChecker({ maxOrderNotional: Money.of(new Decimal('64'), 'USDC') }, logger);
    const result = checker.checkBeforeOrder(makeInput({ side: SELL }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.riskCode).toBe('ORDER_NOTIONAL_EXCEEDED');
  });

  // ── логирование ──────────────────────────────────────────────────────────

  it('логирует warn при нарушении лимита', () => {
    const checker = makeChecker({ maxOpenOrders: 1 }, logger);
    checker.checkBeforeOrder(makeInput({ openOrdersCount: 5 }));
    expect(logger.warn).toHaveBeenCalledWith('Risk limit violated', expect.any(Object));
  });
});
