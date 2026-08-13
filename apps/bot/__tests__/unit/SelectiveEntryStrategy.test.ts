import { describe, expect, it } from '@jest/globals';
import Decimal from 'decimal.js';
import { SelectiveEntryStrategy } from '../../src/strategies/SelectiveEntryStrategy.js';

function makeData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    midCents: 40,
    spreadCents: 1,
    bestBidCents: 39,
    bestAskCents: 41,
    compSpreadCents: 1,
    compBestBidCents: 59,
    compBestAskCents: 61,
    tickSizeCents: 1,
    deltaPct: -0.05,
    tauSec: 120,
    hasPosition: false,
    hasOpenOrder: false,
    hasInFlightFill: false,
    availableBalance: new Decimal(100),
    nowMs: 1_700_000_000_000,
    cryptoPrice: 99_950,
    strikePrice: 100_000,
    compMidCents: 60,
    complementaryInstrumentId: 'comp-instrument',
    complementaryAsset: 'comp-asset',
    riseCents: 0,
    deltaAccel: -0.03,
    compDiscrepancy: 0,
    openOrderPriceCents: null,
    openOrderAgeSec: null,
    openOrderOnComplementary: false,
    ...overrides,
  };
}

describe('SelectiveEntryStrategy', () => {
  it('minDeltaAccel использует direction-aware acceleration для DOWN', () => {
    const strategy = new SelectiveEntryStrategy({
      orderSize: new Decimal(5),
      minDeltaAccel: 0.02,
    });

    const actions = (strategy as any).decide(makeData(), new Set());

    expect(actions[0]).toMatchObject({ type: 'BUY', targetInstrumentId: 'comp-instrument' });
  });

  it('minDeltaAccel отклоняет DOWN, если raw acceleration идёт обратно к strike', () => {
    const strategy = new SelectiveEntryStrategy({
      orderSize: new Decimal(5),
      minDeltaAccel: 0.02,
    });

    const actions = (strategy as any).decide(makeData({ deltaAccel: 0.03 }), new Set());

    expect(actions).toEqual([{ type: 'HOLD' }]);
  });

  it('requireDeltaAccel без minDeltaAccel сохраняет legacy raw-поведение', () => {
    const strategy = new SelectiveEntryStrategy({
      orderSize: new Decimal(5),
      requireDeltaAccel: true,
    });

    const actions = (strategy as any).decide(makeData({ deltaAccel: 0.03 }), new Set());

    expect(actions[0]).toMatchObject({ type: 'BUY', targetInstrumentId: 'comp-instrument' });
  });
});
