import { describe, expect, it, beforeEach } from '@jest/globals';
import Decimal from 'decimal.js';
import {
  normalCdf,
  binaryUpProbability,
  probabilitySensitivityCentsPerBps,
  CexLeadLagStrategy,
} from '../../src/strategies/CexLeadLagStrategy.js';

// ─────────────────────────────────────────────────────────────────────────────
// normalCdf()
// ─────────────────────────────────────────────────────────────────────────────

describe('normalCdf', () => {
  it('Φ(0) ≈ 0.5', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 4);
  });

  it('Φ(1) ≈ 0.8413', () => {
    expect(normalCdf(1)).toBeCloseTo(0.8413, 3);
  });

  it('Φ(-1) ≈ 0.1587', () => {
    expect(normalCdf(-1)).toBeCloseTo(0.1587, 3);
  });

  it('Φ(2) ≈ 0.9772', () => {
    expect(normalCdf(2)).toBeCloseTo(0.9772, 3);
  });

  it('Φ(-2) ≈ 0.0228', () => {
    expect(normalCdf(-2)).toBeCloseTo(0.0228, 3);
  });

  it('Φ(3) ≈ 0.9987', () => {
    expect(normalCdf(3)).toBeCloseTo(0.9987, 3);
  });

  it('Φ(-3) ≈ 0.0013', () => {
    expect(normalCdf(-3)).toBeCloseTo(0.0013, 3);
  });

  it('граничные случаи: x < -8 → 0, x > 8 → 1', () => {
    expect(normalCdf(-9)).toBe(0);
    expect(normalCdf(9)).toBe(1);
  });

  it('Φ(x) + Φ(-x) ≈ 1 (симметрия)', () => {
    for (const x of [0.5, 1.0, 1.5, 2.0, 2.5]) {
      expect(normalCdf(x) + normalCdf(-x)).toBeCloseTo(1.0, 6);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// binaryUpProbability()
// ─────────────────────────────────────────────────────────────────────────────

describe('binaryUpProbability', () => {
  const sigma = 0.6;
  const tauSec = 300; // 5 минут

  it('ATM (price = strike) возвращает < 0.5 из-за drift-correction', () => {
    // С поправкой -0.5σ²T числитель отрицательный → вероятность < 0.5
    const prob = binaryUpProbability(100_000, 100_000, sigma, tauSec);
    expect(prob).toBeGreaterThan(0);
    expect(prob).toBeLessThan(0.5);
  });

  it('price >> strike (in-the-money) → вероятность > 0.5', () => {
    const prob = binaryUpProbability(105_000, 100_000, sigma, tauSec);
    expect(prob).toBeGreaterThan(0.5);
  });

  it('price << strike (out-of-the-money) → вероятность < 0.5', () => {
    const prob = binaryUpProbability(95_000, 100_000, sigma, tauSec);
    expect(prob).toBeLessThan(0.5);
  });

  it('tauSec = 0, price >= strike → 0.99', () => {
    expect(binaryUpProbability(100_001, 100_000, sigma, 0)).toBe(0.99);
  });

  it('tauSec = 0, price < strike → 0.01', () => {
    expect(binaryUpProbability(99_999, 100_000, sigma, 0)).toBe(0.01);
  });

  it('tauSec < 0 → обрабатывается как 0 (граничный случай)', () => {
    const prob = binaryUpProbability(100_001, 100_000, sigma, -1);
    expect(prob).toBe(0.99);
  });

  it('невалидные входные данные → 0.5', () => {
    expect(binaryUpProbability(0, 100_000, sigma, 300)).toBe(0.5);
    expect(binaryUpProbability(100_000, 0, sigma, 300)).toBe(0.5);
    expect(binaryUpProbability(100_000, 100_000, 0, 300)).toBe(0.5);
  });

  it('результат всегда в диапазоне [0.01, 0.99]', () => {
    const cases = [
      [100_000, 100_000, 0.6, 300],
      [50_000, 100_000, 0.6, 300],
      [200_000, 100_000, 0.6, 300],
      [100_000, 100_000, 2.0, 30],
    ];
    for (const [price, strike, s, tau] of cases) {
      const prob = binaryUpProbability(price, strike, s, tau);
      expect(prob).toBeGreaterThanOrEqual(0.01);
      expect(prob).toBeLessThanOrEqual(0.99);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// probabilitySensitivityCentsPerBps()
// ─────────────────────────────────────────────────────────────────────────────

describe('probabilitySensitivityCentsPerBps', () => {
  it('ATM при коротком tau: sensitivity > 0', () => {
    const s = probabilitySensitivityCentsPerBps(100_000, 100_000, 0.6, 60);
    expect(s).toBeGreaterThan(0);
  });

  it('ATM sensitivity > far OTM sensitivity (delta-neutral property)', () => {
    const atmSensitivity = probabilitySensitivityCentsPerBps(100_000, 100_000, 0.6, 300);
    const otmSensitivity = probabilitySensitivityCentsPerBps(80_000, 100_000, 0.6, 300);
    expect(atmSensitivity).toBeGreaterThan(otmSensitivity);
  });

  it('tauSec = 0 → возвращает 0 (нет времени для монетизации)', () => {
    expect(probabilitySensitivityCentsPerBps(100_000, 100_000, 0.6, 0)).toBe(0);
  });

  it('невалидные входные данные → 0', () => {
    expect(probabilitySensitivityCentsPerBps(0, 100_000, 0.6, 300)).toBe(0);
    expect(probabilitySensitivityCentsPerBps(100_000, 0, 0.6, 300)).toBe(0);
    expect(probabilitySensitivityCentsPerBps(100_000, 100_000, 0, 300)).toBe(0);
    expect(probabilitySensitivityCentsPerBps(100_000, 100_000, 0.6, -1)).toBe(0);
  });

  it('результат всегда >= 0', () => {
    const cases = [
      [100_000, 100_000, 0.6, 60],
      [95_000, 100_000, 0.6, 180],
      [105_000, 100_000, 0.6, 180],
      [100_000, 100_000, 1.5, 30],
    ];
    for (const [price, strike, s, tau] of cases) {
      expect(probabilitySensitivityCentsPerBps(price, strike, s, tau)).toBeGreaterThanOrEqual(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// _updateSignalPersistence() (через private access)
// ─────────────────────────────────────────────────────────────────────────────

describe('_updateSignalPersistence', () => {
  let strategy: any;

  beforeEach(() => {
    strategy = new CexLeadLagStrategy(
      { orderSize: new Decimal(5), qMax: 2 },
      'test-persistence',
    );
  });

  it('одинаковый direction и знак residual накапливают persistence', () => {
    strategy._updateSignalPersistence('up', 5, 1_000);
    const p2 = strategy._updateSignalPersistence('up', 3, 1_500);
    expect(p2).toBe(500); // 1500 - 1000
  });

  it('flat direction → persistence = 0, signalStartedAtMs = null', () => {
    strategy._updateSignalPersistence('up', 5, 1_000);
    const p = strategy._updateSignalPersistence('flat', 0, 1_500);
    expect(p).toBe(0);
    expect(strategy._signalStartedAtMs).toBeNull();
  });

  it('смена направления сбрасывает persistence', () => {
    strategy._updateSignalPersistence('up', 5, 1_000);
    strategy._updateSignalPersistence('up', 3, 1_500);
    const p = strategy._updateSignalPersistence('down', -4, 2_000);
    expect(p).toBe(0);
    expect(strategy._signalStartedAtMs).toBe(2_000);
  });

  it('смена знака residual сбрасывает persistence', () => {
    strategy._updateSignalPersistence('up', 5, 1_000);
    const p = strategy._updateSignalPersistence('up', -3, 1_500);
    // Знак изменился (5 → -3), поэтому сброс
    expect(p).toBe(0);
    expect(strategy._signalStartedAtMs).toBe(1_500);
  });

  it('первый вызов с non-flat → persistence = 0 (начало отсчёта)', () => {
    const p = strategy._updateSignalPersistence('up', 5, 1_000);
    expect(p).toBe(0);
    expect(strategy._signalStartedAtMs).toBe(1_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// _checkEntrySignalFirst() — entry gating
// ─────────────────────────────────────────────────────────────────────────────

describe('_checkEntrySignalFirst — entry gating', () => {
  let strategy: any;

  const makeData = (overrides: Record<string, unknown> = {}) => ({
    tauSec: 120,
    inventoryUnits: 0,
    signalFavorable: true,
    signalStrong: true,
    signalAdverse: false,
    signalPersistenceMs: 500,
    venueAgreement: 0.80,
    netExpectedEdgeCents: 3,
    signalDirectionForToken: 'up',
    tradeEwmaCents: 45,
    bestBidCents: 44,
    bestAskCents: 46,
    openBuyPriceCents: undefined,
    openBuyOrderId: undefined,
    positionQty: new Decimal(0),
    minOrderSize: new Decimal(1),
    minOrderValue: new Decimal(1),
    availableBalance: new Decimal(100),
    signalExpectedMoveCents: 3,
    executionPenaltyCents: 0.5,
    residualBps: 5,
    residualMagnitudeBps: 5,
    probabilitySensitivityCentsPerBps: 0.05,
    nowMs: 1_700_000_000_000,
    currentPrice: 100_000,
    targetPrice: 100_000,
    chainlinkPrice: 100_000,
    chainlinkTimestampMs: 1_700_000_000_000 - 500,
    chainlinkAgeMs: 500,
    chainlinkStale: false,
    hasInFlightFills: false,
    side: 'up' as const,
    mode: 'skewed' as const,
    marketId: 'test-market',
    tradingInstrumentId: 'up-token' as any,
    tradingAsset: undefined,
    positionOn: 'primary' as const,
    signal: {
      id: 'test',
      asset: 'btc',
      tsMs: 1_700_000_000_000,
      value: 5,
      unit: 'bps' as const,
      direction: 'up' as const,
      strength: 8,
      confidence: 0.7,
      stale: false,
      components: {},
    },
    availableTokenQty: new Decimal(0),
    venues: {},
    ...overrides,
  });

  beforeEach(() => {
    strategy = new CexLeadLagStrategy(
      {
        orderSize: new Decimal(5),
        qMax: 2,
        minEdgeCents: 2,
        exitTauSec: 20,
        maxEntryTauSec: 300,
        // Явно задаём 300ms для совместимости с тестом persistence < 300
        minSignalPersistenceMs: 300,
      },
      'test-entry',
    );
  });

  it('разрешает вход при всех выполненных условиях', () => {
    const action = strategy._checkEntrySignalFirst(makeData());
    expect(action).toBeDefined();
    expect(action?.type).toBe('BUY');
  });

  it('блокирует вход при signalStrong = false', () => {
    const action = strategy._checkEntrySignalFirst(makeData({ signalStrong: false }));
    expect(action).toBeUndefined();
  });

  it('блокирует вход при signalFavorable = false', () => {
    const action = strategy._checkEntrySignalFirst(makeData({ signalFavorable: false }));
    expect(action).toBeUndefined();
  });

  it('блокирует вход при signalPersistenceMs < 300', () => {
    const action = strategy._checkEntrySignalFirst(makeData({ signalPersistenceMs: 200 }));
    expect(action).toBeUndefined();
  });

  it('блокирует вход при venueAgreement < 0.66', () => {
    const action = strategy._checkEntrySignalFirst(makeData({ venueAgreement: 0.5 }));
    expect(action).toBeUndefined();
  });

  it('блокирует вход при netExpectedEdgeCents < minEdgeCents', () => {
    const action = strategy._checkEntrySignalFirst(makeData({ netExpectedEdgeCents: 1 }));
    expect(action).toBeUndefined();
  });

  it('блокирует вход при tauSec < exitTauSec + 5', () => {
    const action = strategy._checkEntrySignalFirst(makeData({ tauSec: 24 }));
    expect(action).toBeUndefined();
  });

  it('блокирует вход при tauSec > maxEntryTauSec', () => {
    const action = strategy._checkEntrySignalFirst(makeData({ tauSec: 400 }));
    expect(action).toBeUndefined();
  });

  it('блокирует вход при inventoryUnits >= qMax', () => {
    const action = strategy._checkEntrySignalFirst(makeData({ inventoryUnits: 2 }));
    expect(action).toBeUndefined();
  });

  it('BUY-действие включает cancelOrderId если есть открытый ордер', () => {
    const action = strategy._checkEntrySignalFirst(
      makeData({ openBuyOrderId: 'order-123', openBuyPriceCents: 100 }),
    );
    expect(action?.type).toBe('BUY');
    expect((action as any)?.cancelOrderId).toBe('order-123');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// _checkExitSignalFirst() — exit triggers
// ─────────────────────────────────────────────────────────────────────────────

describe('_checkExitSignalFirst — exit triggers', () => {
  let strategy: any;

  const makeData = (overrides: Record<string, unknown> = {}) => ({
    tauSec: 60,
    positionQty: new Decimal(5),
    avgEntryPriceCents: 50,
    availableTokenQty: new Decimal(5),
    signalAdverse: false,
    signalStrong: true,
    signalPersistenceMs: 500,
    venueAgreement: 0.8,
    netExpectedEdgeCents: 2,
    tradeEwmaCents: 50,
    bestBidCents: 49,
    bestAskCents: 51,
    side: 'up' as const,
    mode: 'skewed' as const,
    marketId: 'test-market',
    tradingInstrumentId: 'up-token' as any,
    tradingAsset: undefined,
    positionOn: 'primary' as const,
    signal: undefined,
    signalDirectionForToken: 'up' as const,
    signalFavorable: true,
    residualBps: 3,
    residualMagnitudeBps: 3,
    probabilitySensitivityCentsPerBps: 0.05,
    signalExpectedMoveCents: 2.5,
    executionPenaltyCents: 0.5,
    openBuyPriceCents: undefined,
    openBuyOrderId: undefined,
    inventoryUnits: 1,
    hasInFlightFills: false,
    hasMatchedOrders: false,
    nowMs: 1_700_000_000_000,
    currentPrice: 100_000,
    targetPrice: 100_000,
    chainlinkPrice: 100_000,
    chainlinkTimestampMs: 1_700_000_000_000 - 500,
    chainlinkAgeMs: 500,
    chainlinkStale: false,
    minOrderSize: new Decimal(1),
    minOrderValue: new Decimal(1),
    availableBalance: new Decimal(100),
    venues: {},
    ...overrides,
  });

  beforeEach(() => {
    strategy = new CexLeadLagStrategy(
      {
        orderSize: new Decimal(5),
        qMax: 2,
        exitEdgeCents: 1,
        exitTauSec: 20,
        stopLossCents: 10,
      },
      'test-exit',
    );
  });

  it('не выходит при нормальных условиях', () => {
    const action = strategy._checkExitSignalFirst(makeData());
    expect(action).toBeUndefined();
  });

  it('НЕ выходит при signalAdverse = true (отключено: удерживаем до hard/trailing stop)', () => {
    const action = strategy._checkExitSignalFirst(makeData({ signalAdverse: true }));
    expect(action).toBeUndefined();
  });

  it('выходит при tauSec < exitTauSec', () => {
    const action = strategy._checkExitSignalFirst(makeData({ tauSec: 15 }));
    expect(action?.type).toBe('SELL');
  });

  it('не делает TAU_EXIT для near-certain winner при bid выше hold порога', () => {
    strategy = new CexLeadLagStrategy(
      {
        orderSize: new Decimal(5),
        qMax: 1,
        exitTauSec: 20,
        holdToExpiryMinBidCents: 98,
        holdToExpiryMaxTauSec: 90,
        holdToExpiryStopBidCents: 95,
      },
      'test-hold-tau',
    );
    strategy._entryPriceCents = 95;

    const action = strategy._checkExitSignalFirst(makeData({
      tauSec: 15,
      tradeEwmaCents: 99,
      bestBidCents: 99,
      avgEntryPriceCents: 95,
    }));

    expect(action).toBeUndefined();
  });

  it('разрешает TAU_EXIT, если near-certain bid провалился ниже stop порога', () => {
    strategy = new CexLeadLagStrategy(
      {
        orderSize: new Decimal(5),
        qMax: 1,
        exitTauSec: 20,
        holdToExpiryMinBidCents: 98,
        holdToExpiryMaxTauSec: 90,
        holdToExpiryStopBidCents: 95,
      },
      'test-hold-tau-stop',
    );
    strategy._entryPriceCents = 95;

    const action = strategy._checkExitSignalFirst(makeData({
      tauSec: 15,
      tradeEwmaCents: 96,
      bestBidCents: 94,
      avgEntryPriceCents: 95,
    }));

    expect(action?.type).toBe('SELL');
  });

  it('НЕ выходит при signal collapse (signalStrong = false) — удерживаем до stop/tau', () => {
    const action = strategy._checkExitSignalFirst(makeData({ signalStrong: false }));
    expect(action).toBeUndefined();
  });

  it('НЕ выходит при signal collapse (signalPersistenceMs < 150) — удерживаем до stop/tau', () => {
    const action = strategy._checkExitSignalFirst(makeData({ signalPersistenceMs: 100 }));
    expect(action).toBeUndefined();
  });

  it('НЕ выходит при signal collapse (venueAgreement < 0.5) — удерживаем до stop/tau', () => {
    const action = strategy._checkExitSignalFirst(makeData({ venueAgreement: 0.4 }));
    expect(action).toBeUndefined();
  });

  it('НЕ выходит при netExpectedEdgeCents <= -exitEdgeCents — удерживаем до stop/tau', () => {
    const action = strategy._checkExitSignalFirst(makeData({ netExpectedEdgeCents: -1.5 }));
    expect(action).toBeUndefined();
  });

  it('выходит при stop-loss: tradeEwma < entryPrice - stopLossCents', () => {
    strategy._entryPriceCents = 50;
    const action = strategy._checkExitSignalFirst(makeData({ tradeEwmaCents: 38 })); // 50 - 12 < 50 - 10
    expect(action?.type).toBe('SELL');
  });

  it('НЕ выходит при tradeEwma чуть выше порога stop-loss', () => {
    strategy._entryPriceCents = 50;
    const action = strategy._checkExitSignalFirst(makeData({ tradeEwmaCents: 42 })); // 50 - 8 > 50 - 10
    expect(action).toBeUndefined();
  });

  it('аварийный выход использует best bid со slippage для STOP_LOSS', () => {
    strategy._entryPriceCents = 50;
    const action = strategy._checkExitSignalFirst(makeData({
      tradeEwmaCents: 38,
      bestBidCents: 37,
    }));
    expect(action?.type).toBe('SELL');
    // emergencyExitSlippageCents = 2 (default), bestBid - 2 = 35
    expect((action as any)?.price).toBe(35);
  });

  it('partial trailing stop продаёт только configured долю и больше не трейлит runner', () => {
    strategy = new CexLeadLagStrategy(
      {
        orderSize: new Decimal(3),
        qMax: 2,
        exitTauSec: 20,
        stopLossCents: 10,
        trailingExitRatio: 0.6,
      },
      'test-partial-trailing',
    );
    strategy._entryPriceCents = 40;
    strategy._trailingStopCents = 63;

    const first = strategy._checkExitSignalFirst(makeData({
      positionQty: new Decimal(6),
      availableTokenQty: new Decimal(6),
      tradeEwmaCents: 62,
      bestBidCents: 62,
    }));

    expect(first?.type).toBe('SELL');
    expect((first as any)?.size.toString()).toBe('3.6');
    expect(strategy._trailingScaleOutDone).toBe(true);

    const second = strategy._checkExitSignalFirst(makeData({
      positionQty: new Decimal(2.4),
      availableTokenQty: new Decimal(2.4),
      tradeEwmaCents: 61,
      bestBidCents: 61,
    }));

    expect(second).toBeUndefined();
  });

  it('не делает partial trailing, если split создаёт sell/runner меньше minOrderSize', () => {
    strategy = new CexLeadLagStrategy(
      {
        orderSize: new Decimal(5),
        qMax: 1,
        exitTauSec: 20,
        stopLossCents: 10,
        trailingExitRatio: 0.5,
      },
      'test-partial-min-size',
    );
    strategy._entryPriceCents = 40;
    strategy._trailingStopCents = 63;

    const action = strategy._checkExitSignalFirst(makeData({
      positionQty: new Decimal(5),
      availableTokenQty: new Decimal(5),
      minOrderSize: new Decimal(5),
      tradeEwmaCents: 62,
      bestBidCents: 62,
    }));

    expect(action).toBeUndefined();
    expect(strategy._trailingScaleOutDone).toBe(false);
  });

  it('signal collapse после grace продаёт configured долю прибыльной позиции', () => {
    strategy = new CexLeadLagStrategy(
      {
        orderSize: new Decimal(10),
        qMax: 1,
        exitTauSec: 20,
        stopLossCents: 10,
        signalExitEnabled: true,
        signalExitGraceMs: 500,
        signalExitMinProfitCents: 2,
        signalExitRatio: 0.5,
      },
      'test-signal-exit',
    );
    strategy._entryPriceCents = 40;

    const first = strategy._checkExitSignalFirst(makeData({
      nowMs: 1_000,
      positionQty: new Decimal(10),
      availableTokenQty: new Decimal(10),
      minOrderSize: new Decimal(5),
      tradeEwmaCents: 45,
      signalFavorable: false,
      signalStrong: false,
      signalPersistenceMs: 0,
      venueAgreement: 0,
    }));
    expect(first).toBeUndefined();

    const second = strategy._checkExitSignalFirst(makeData({
      nowMs: 1_500,
      positionQty: new Decimal(10),
      availableTokenQty: new Decimal(10),
      minOrderSize: new Decimal(5),
      tradeEwmaCents: 45,
      signalFavorable: false,
      signalStrong: false,
      signalPersistenceMs: 0,
      venueAgreement: 0,
    }));

    expect(second?.type).toBe('SELL');
    expect((second as any)?.size.toString()).toBe('5');
    expect(strategy._signalExitDone).toBe(true);
    expect(strategy._trailingScaleOutDone).toBe(true);
  });

  it('не делает SIGNAL_COLLAPSE exit для near-certain winner при bid выше hold порога', () => {
    strategy = new CexLeadLagStrategy(
      {
        orderSize: new Decimal(10),
        qMax: 1,
        exitTauSec: 20,
        signalExitEnabled: true,
        signalExitGraceMs: 500,
        signalExitMinProfitCents: 1,
        holdToExpiryMinBidCents: 98,
        holdToExpiryMaxTauSec: 90,
        holdToExpiryStopBidCents: 95,
      },
      'test-hold-signal-collapse',
    );
    strategy._entryPriceCents = 98;

    strategy._checkExitSignalFirst(makeData({
      nowMs: 1_000,
      tauSec: 60,
      tradeEwmaCents: 99,
      bestBidCents: 99,
      avgEntryPriceCents: 98,
      signalFavorable: false,
      signalStrong: false,
      signalPersistenceMs: 0,
      venueAgreement: 0,
    }));
    const second = strategy._checkExitSignalFirst(makeData({
      nowMs: 1_500,
      tauSec: 60,
      tradeEwmaCents: 99,
      bestBidCents: 99,
      avgEntryPriceCents: 98,
      signalFavorable: false,
      signalStrong: false,
      signalPersistenceMs: 0,
      venueAgreement: 0,
    }));

    expect(second).toBeUndefined();
    expect(strategy._signalExitDone).toBe(false);
  });

  it('adverse signal после grace закрывает доступную позицию', () => {
    strategy = new CexLeadLagStrategy(
      {
        orderSize: new Decimal(10),
        qMax: 1,
        exitTauSec: 20,
        stopLossCents: 10,
        signalExitEnabled: true,
        adverseExitGraceMs: 300,
        adverseExitRatio: 1,
      },
      'test-adverse-exit',
    );
    strategy._entryPriceCents = 40;

    const first = strategy._checkExitSignalFirst(makeData({
      nowMs: 2_000,
      positionQty: new Decimal(10),
      availableTokenQty: new Decimal(10),
      tradeEwmaCents: 42,
      signalFavorable: false,
      signalAdverse: true,
      signalStrong: true,
      signalDirectionForToken: 'down',
    }));
    expect(first).toBeUndefined();

    const second = strategy._checkExitSignalFirst(makeData({
      nowMs: 2_300,
      positionQty: new Decimal(10),
      availableTokenQty: new Decimal(10),
      tradeEwmaCents: 42,
      signalFavorable: false,
      signalAdverse: true,
      signalStrong: true,
      signalDirectionForToken: 'down',
    }));

    expect(second?.type).toBe('SELL');
    expect((second as any)?.size.toString()).toBe('10');
    expect(strategy._adverseExitDone).toBe(true);
  });

  it('не делает ADVERSE_SIGNAL exit для near-certain winner при bid выше hold порога', () => {
    strategy = new CexLeadLagStrategy(
      {
        orderSize: new Decimal(10),
        qMax: 1,
        exitTauSec: 20,
        signalExitEnabled: true,
        adverseExitGraceMs: 300,
        holdToExpiryMinBidCents: 98,
        holdToExpiryMaxTauSec: 90,
        holdToExpiryStopBidCents: 95,
      },
      'test-hold-adverse',
    );
    strategy._entryPriceCents = 98;

    strategy._checkExitSignalFirst(makeData({
      nowMs: 2_000,
      tauSec: 60,
      tradeEwmaCents: 99,
      bestBidCents: 99,
      avgEntryPriceCents: 98,
      signalFavorable: false,
      signalAdverse: true,
      signalStrong: true,
      signalDirectionForToken: 'down',
    }));
    const second = strategy._checkExitSignalFirst(makeData({
      nowMs: 2_300,
      tauSec: 60,
      tradeEwmaCents: 99,
      bestBidCents: 99,
      avgEntryPriceCents: 98,
      signalFavorable: false,
      signalAdverse: true,
      signalStrong: true,
      signalDirectionForToken: 'down',
    }));

    expect(second).toBeUndefined();
    expect(strategy._adverseExitDone).toBe(false);
  });

  it('позиция, найденная после рестарта, не получает новый trailing stop', () => {
    strategy = new CexLeadLagStrategy(
      {
        orderSize: new Decimal(3),
        qMax: 2,
        exitTauSec: 20,
        stopLossCents: 10,
        trailingExitRatio: 0.6,
      },
      'test-restart-runner',
    );

    const actions = strategy.decide(makeData({
      positionQty: new Decimal(2.4),
      availableTokenQty: new Decimal(2.4),
      avgEntryPriceCents: 40,
      tradeEwmaCents: 62,
      bestBidCents: 62,
      tauSec: 60,
    }), new Set());

    expect(actions).toEqual([]);
    expect(strategy._entryPriceCents).toBe(40);
    expect(strategy._trailingScaleOutDone).toBe(true);
    expect(strategy._signalExitDone).toBe(true);
  });

  it('не блокирует аварийный выход из-за in-flight флага, если позиция уже видна', () => {
    const actions = strategy.decide(makeData({
      tauSec: 15,
      hasInFlightFills: true,
      positionQty: new Decimal(5),
      availableTokenQty: new Decimal(5),
      tradeEwmaCents: 64,
      bestBidCents: 63,
    }), new Set());

    expect(actions).toHaveLength(1);
    expect(actions[0]?.type).toBe('SELL');
  });

  it('SELL intent маршрутизируется на targetInstrumentId/targetAsset для complementary позиции', () => {
    const targetInstrumentId = 'down-token' as any;
    const targetAsset = { type: 'POLYMARKET_CTF_TOKEN', tokenId: 'down-token' } as any;

    const intents = strategy.toIntents([
      {
        type: 'SELL',
        price: 62,
        size: new Decimal(5),
        targetInstrumentId,
        targetAsset,
      },
    ]);

    expect(intents).toHaveLength(2);
    expect(intents[0]).toEqual({ type: 'CANCEL_ALL' });
    expect(intents[1]).toMatchObject({
      type: 'PLACE',
      side: 'SELL',
      targetInstrumentId,
      targetAsset,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// _venueAgreementByResidual() — residual-based venue agreement
// ─────────────────────────────────────────────────────────────────────────────

describe('_venueAgreementByResidual', () => {
  const CHAINLINK = 100_000;

  function makeSnapshot(
    venues: Record<string, { mid: number; spreadBps?: number; ageMs?: number } | null>,
    nowMs = 1_700_000_000_000,
  ): any {
    const map = new Map<string, any>();
    for (const [venue, data] of Object.entries(venues)) {
      if (data === null) continue;
      map.set(venue, {
        mid: data.mid,
        spreadBps: data.spreadBps ?? 5,
        lastReceivedTsMs: nowMs - (data.ageMs ?? 100),
      });
    }
    return {
      nowMs,
      cryptoVenueState: { get: (v: string) => map.get(v) },
    };
  }

  let strategy: any;

  beforeEach(() => {
    strategy = new CexLeadLagStrategy(
      {
        orderSize: new Decimal(5),
        qMax: 2,
        signalThresholdBps: 1,
        signalStaleMs: 2000,
        maxSpreadBps: 20,
        venues: ['binance', 'coinbase', 'okx'],
      },
      'test-agreement',
    );
  });

  it('все три биржи выше Chainlink → agreement = 1.0', () => {
    const snapshot = makeSnapshot({
      binance: { mid: 100_200 }, // +20 bps
      coinbase: { mid: 100_150 }, // +15 bps
      okx: { mid: 100_100 },    // +10 bps
    });
    const result = strategy._venueAgreementByResidual(snapshot, CHAINLINK);
    expect(result).toBe(1.0);
  });

  it('две биржи выше, одна ниже → agreement = 2/3', () => {
    const snapshot = makeSnapshot({
      binance: { mid: 100_200 },  // +20 bps
      coinbase: { mid: 100_150 }, // +15 bps
      okx: { mid: 99_900 },       // -10 bps
    });
    const result = strategy._venueAgreementByResidual(snapshot, CHAINLINK);
    expect(result).toBeCloseTo(2 / 3, 5);
  });

  it('residual ниже signalThresholdBps игнорируется', () => {
    // signalThresholdBps = 1, residual < 1 bps = < $10 на $100k
    const snapshot = makeSnapshot({
      binance: { mid: 100_000.5 }, // ~0.05 bps — ниже порога
      coinbase: { mid: 100_200 },  // +20 bps — считается
      okx: { mid: 100_150 },       // +15 bps — считается
    });
    // binance игнорируется → только coinbase и okx → agreement = 1.0
    const result = strategy._venueAgreementByResidual(snapshot, CHAINLINK);
    expect(result).toBe(1.0);
  });

  it('stale биржа игнорируется', () => {
    const snapshot = makeSnapshot({
      binance: { mid: 100_200, ageMs: 3000 }, // stale (> 2000ms)
      coinbase: { mid: 100_150 },
      okx: { mid: 99_800 }, // -20 bps
    });
    // binance игнорируется → coinbase (+) и okx (-) → agreement = 1/2
    const result = strategy._venueAgreementByResidual(snapshot, CHAINLINK);
    expect(result).toBe(0.5);
  });

  it('wide-spread биржа игнорируется', () => {
    const snapshot = makeSnapshot({
      binance: { mid: 100_200, spreadBps: 25 }, // > maxSpreadBps=20, игнорируется
      coinbase: { mid: 100_150 },
      okx: { mid: 100_100 },
    });
    // binance игнорируется → coinbase и okx оба positive → 1.0
    const result = strategy._venueAgreementByResidual(snapshot, CHAINLINK);
    expect(result).toBe(1.0);
  });

  it('биржа недоступна (null) игнорируется', () => {
    const snapshot = makeSnapshot({
      binance: null,
      coinbase: { mid: 100_150 },
      okx: { mid: 100_100 },
    });
    const result = strategy._venueAgreementByResidual(snapshot, CHAINLINK);
    expect(result).toBe(1.0);
  });

  it('нет активных бирж → 0', () => {
    const snapshot = makeSnapshot({
      binance: null,
      coinbase: null,
      okx: null,
    });
    const result = strategy._venueAgreementByResidual(snapshot, CHAINLINK);
    expect(result).toBe(0);
  });

  it('chainlinkPrice = 0 → 0 (защита от деления на ноль)', () => {
    const snapshot = makeSnapshot({
      binance: { mid: 100_200 },
      coinbase: { mid: 100_150 },
    });
    const result = strategy._venueAgreementByResidual(snapshot, 0);
    expect(result).toBe(0);
  });

  it('basis вычитается из mid перед расчётом residual', () => {
    // binance имеет basis=+300, поэтому adjustedMid = 100_200 - 300 = 99_900 → residual отрицательный
    strategy._basisByVenue = { binance: 300 };
    const snapshot = makeSnapshot({
      binance: { mid: 100_200 },  // raw +20 bps, после basis: -10 bps
      coinbase: { mid: 100_150 }, // +15 bps
      okx: { mid: 100_100 },      // +10 bps
    });
    // binance (−), coinbase (+), okx (+) → agreement = 2/3
    const result = strategy._venueAgreementByResidual(snapshot, CHAINLINK);
    expect(result).toBeCloseTo(2 / 3, 5);
  });
});
