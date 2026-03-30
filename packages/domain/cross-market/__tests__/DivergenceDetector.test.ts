import { describe, it, expect } from '@jest/globals';
import { DivergenceDetector } from '../src/DivergenceDetector.js';
import { FEE_MODEL_CURRENT } from '../src/types.js';
import type { SimpleBook, MarketPair, MarketInfo } from '../src/types.js';
import { asInstrumentId } from '@polymarket/ids';

function mkPair(): MarketPair {
  const easy: MarketInfo = {
    asset: 'BTC',
    recurrence: '15m',
    endDate: '2026-03-23T02:15:00Z',
    endEpochMs: 1774231200000,
    instrumentId: asInstrumentId('token-easy')!,
    filePath: '/easy.jsonl.gz',
  };
  const hard: MarketInfo = {
    asset: 'BTC',
    recurrence: '5m',
    endDate: '2026-03-23T02:15:00Z',
    endEpochMs: 1774231200000,
    instrumentId: asInstrumentId('token-hard')!,
    filePath: '/hard.jsonl.gz',
  };
  return { easy, hard, pairType: '5m-15m', overlapMs: 300000 };
}

function mkBook(bids: [number, number][], asks: [number, number][]): SimpleBook {
  return {
    bids: bids.map(([price, size]) => ({ price, size })),
    asks: asks.map(([price, size]) => ({ price, size })),
    timestampMs: Date.now(),
  };
}

describe('DivergenceDetector', () => {
  const detector = new DivergenceDetector({
    feeModel: FEE_MODEL_CURRENT,
    minSpreadAfterFees: 0.001,
  });

  it('обнаруживает расхождение: hard_Up_bid > easy_Up_ask', () => {
    const easyBook = mkBook([[0.60, 500]], [[0.48, 500]]);
    const hardBook = mkBook([[0.55, 500]], [[0.40, 500]]);
    const pair = mkPair();

    const signal = detector.detect(easyBook, hardBook, pair, Date.now());

    expect(signal).not.toBeNull();
    expect(signal!.hardUpBestBid).toBeCloseTo(0.55, 4);
    expect(signal!.easyUpBestAsk).toBeCloseTo(0.48, 4);
    expect(signal!.optimalDepth.pnlPerUnit).toBeGreaterThan(0);
    expect(signal!.optimalDepth.execSize).toBe(500);
  });

  it('возвращает null без расхождения', () => {
    const easyBook = mkBook([[0.55, 500]], [[0.52, 500]]);
    const hardBook = mkBook([[0.48, 500]], [[0.40, 500]]);

    const signal = detector.detect(easyBook, hardBook, mkPair(), Date.now());

    expect(signal).toBeNull();
  });

  it('возвращает null при пустых стаканах', () => {
    const emptyBook = mkBook([], []);
    const normalBook = mkBook([[0.55, 500]], [[0.48, 500]]);

    expect(detector.detect(emptyBook, normalBook, mkPair(), Date.now())).toBeNull();
    expect(detector.detect(normalBook, emptyBook, mkPair(), Date.now())).toBeNull();
  });

  it('возвращает null если spread слишком мал', () => {
    const strictDetector = new DivergenceDetector({
      feeModel: FEE_MODEL_CURRENT,
      minSpreadAfterFees: 0.10, // очень высокий порог
    });

    // Маленькое расхождение
    const easyBook = mkBook([[0.55, 500]], [[0.50, 500]]);
    const hardBook = mkBook([[0.51, 500]], [[0.45, 500]]);

    const signal = strictDetector.detect(easyBook, hardBook, mkPair(), Date.now());

    expect(signal).toBeNull();
  });

  it('анализирует глубину: оптимальный depth > 1 при большом стакане', () => {
    const easyBook = mkBook(
      [[0.60, 1000]],
      [
        [0.47, 100],
        [0.48, 500],
        [0.49, 1000],
      ],
    );
    const hardBook = mkBook(
      [
        [0.56, 100],
        [0.55, 500],
        [0.54, 1000],
      ],
      [[0.40, 1000]],
    );

    const signal = detector.detect(easyBook, hardBook, mkPair(), Date.now());

    expect(signal).not.toBeNull();
    expect(signal!.depthLevels.length).toBeGreaterThan(1);
    // totalPnl на depth > 1 больше чем на depth 1 (больше size)
    expect(signal!.optimalDepth.totalPnl).toBeGreaterThan(signal!.depthLevels[0].totalPnl);
  });

  it('гарантированный PnL положительный для реалистичного расхождения', () => {
    // Реальный кейс из данных 23 марта: spread ~5 центов
    const easyBook = mkBook([[0.60, 1000]], [[0.48, 500]]);
    const hardBook = mkBook([[0.53, 500]], [[0.40, 1000]]);

    const signal = detector.detect(easyBook, hardBook, mkPair(), Date.now());

    expect(signal).not.toBeNull();
    // cost = 0.48 + (1 - 0.53) = 0.48 + 0.47 = 0.95
    // revenue = 1.00
    // gross = 0.05, fee ≈ 0.006 → net ≈ 0.044
    expect(signal!.optimalDepth.pnlPerUnit).toBeGreaterThan(0.03);
    expect(signal!.optimalDepth.pnlPerUnit).toBeLessThan(0.06);
  });

  it('содержит корректную pair reference в сигнале', () => {
    const easyBook = mkBook([[0.60, 500]], [[0.48, 500]]);
    const hardBook = mkBook([[0.55, 500]], [[0.40, 500]]);
    const pair = mkPair();

    const signal = detector.detect(easyBook, hardBook, pair, 12345678);

    expect(signal!.pair).toBe(pair);
    expect(signal!.detectedAtMs).toBe(12345678);
  });
});
