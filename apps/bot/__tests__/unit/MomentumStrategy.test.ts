/**
 * Тесты MomentumStrategy стратегии.
 *
 * @remarks
 * Проверяет momentum-сигнал:
 * - buyRatio > entryThreshold → ENTER (BUY)
 * - buyRatio < exitThreshold → EXIT (SELL)
 * - между порогами → HOLD (нет действий)
 */
import { MomentumStrategy } from '../../src/strategies/MomentumStrategy.js';
import type { MomentumStrategyConfig } from '../../src/strategies/MomentumStrategy.js';
import type { StrategySnapshot, TriggerReason } from '@polymarket/strategy';
import { Price, Quantity } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

// ── Хелперы ──────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: MomentumStrategyConfig = {
  entryThreshold: new Decimal('0.65'),
  exitThreshold: new Decimal('0.40'),
  orderSize: new Decimal('5'),
};

/** Создаёт запись TapeRecord */
function makeTrade(side: 'BUY' | 'SELL', size: number) {
  return {
    price: Price.of(new Decimal('0.50')),
    size: Quantity.of(new Decimal(size)),
    side,
    timestampMs: Date.now(),
  };
}

/** Создаёт snapshot с заданным набором trades, topOfBook и позицией */
function makeSnapshot(overrides: {
  trades?: Array<{ side: string; size: Quantity; price: Price; timestampMs: number }>;
  bestBid?: Decimal;
  bestAsk?: Decimal;
  positionQty?: Decimal;
}): StrategySnapshot {
  const {
    trades = [],
    bestBid = new Decimal('0.49'),
    bestAsk = new Decimal('0.51'),
    positionQty = new Decimal(0),
  } = overrides;

  const mockPosition = positionQty.gt(0) ? {
    quantity: { value: () => positionQty },
  } : undefined;

  const mockPortfolio = {
    getPosition: () => mockPosition,
    balance: {
      available: () => ({ value: () => new Decimal('1000') }),
    },
  };

  const mockTradeTape = trades.length > 0 ? {
    getAll: () => trades,
  } : undefined;

  return {
    instrumentId: 'test-instrument' as any,
    market: { expirationMs: Date.now() + 3_600_000 } as any,
    topOfBook: {
      bestBid: Price.of(bestBid),
      bestAsk: Price.of(bestAsk),
      spread: Price.of(bestAsk.minus(bestBid)),
      bestBidSize: undefined,
      bestAskSize: undefined,
    },
    bookHistory: undefined,
    tradeTape: mockTradeTape as any,
    openOrders: [],
    portfolio: mockPortfolio as any,
    nowMs: Date.now(),
  };
}

const REASONS = new Set<TriggerReason>(['TRADE']);

// ── Тесты ────────────────────────────────────────────────────────────────────

describe('MomentumStrategy', () => {
  let strategy: MomentumStrategy;

  beforeEach(() => {
    strategy = new MomentumStrategy(DEFAULT_CONFIG, 'test-momentum');
  });

  it('имеет корректный id и name', () => {
    expect(strategy.id).toBe('test-momentum');
    expect(strategy.name).toBe('MomentumStrategy');
  });

  it('использует дефолтный id если не указан', () => {
    const defaultStrategy = new MomentumStrategy(DEFAULT_CONFIG);
    expect(defaultStrategy.id).toBe('momentum-1');
  });

  // ── Нет данных ──────────────────────────────────────────────────────────

  describe('нет данных', () => {
    it('возвращает пустой массив если нет tradeTape', () => {
      const snapshot = makeSnapshot({});

      const intents = strategy.tick(snapshot, REASONS);

      expect(intents.length).toBe(0);
    });

    it('возвращает пустой массив если trades пуст', () => {
      const snapshot = makeSnapshot({ trades: [] });

      const intents = strategy.tick(snapshot, REASONS);

      expect(intents.length).toBe(0);
    });
  });

  // ── ENTER ───────────────────────────────────────────────────────────────

  describe('ENTER (покупка при сильном buy-momentum)', () => {
    it('покупает при buyRatio > entryThreshold и нет позиции', () => {
      const trades = [
        makeTrade('BUY', 7),
        makeTrade('BUY', 3),
        makeTrade('SELL', 2),
      ]; // buyRatio = 10/12 ≈ 0.83 > 0.65

      const snapshot = makeSnapshot({ trades });
      const intents = strategy.tick(snapshot, REASONS);

      expect(intents.length).toBe(1);
      expect(intents[0]).toMatchObject({
        type: 'PLACE',
        side: 'BUY',
      });
      // Цена = bestAsk (0.51)
      const intent = intents[0] as { price: Price };
      expect(intent.price.value().toNumber()).toBe(0.51);
    });

    it('не покупает если уже есть позиция (даже при сильном momentum)', () => {
      const trades = [
        makeTrade('BUY', 8),
        makeTrade('SELL', 2),
      ]; // buyRatio = 8/10 = 0.80 > 0.65

      const snapshot = makeSnapshot({ trades, positionQty: new Decimal('10') });
      const intents = strategy.tick(snapshot, REASONS);

      expect(intents.length).toBe(0);
    });
  });

  // ── EXIT ────────────────────────────────────────────────────────────────

  describe('EXIT (продажа при слабом buy-momentum)', () => {
    it('продаёт при buyRatio < exitThreshold и есть позиция', () => {
      const trades = [
        makeTrade('BUY', 2),
        makeTrade('SELL', 8),
      ]; // buyRatio = 2/10 = 0.20 < 0.40

      const snapshot = makeSnapshot({ trades, positionQty: new Decimal('10') });
      const intents = strategy.tick(snapshot, REASONS);

      expect(intents.length).toBe(1);
      expect(intents[0]).toMatchObject({
        type: 'PLACE',
        side: 'SELL',
      });
      // Цена = bestBid (0.49)
      const intent = intents[0] as { price: Price };
      expect(intent.price.value().toNumber()).toBe(0.49);
    });

    it('продаёт не больше orderSize', () => {
      const trades = [
        makeTrade('BUY', 1),
        makeTrade('SELL', 9),
      ]; // buyRatio = 1/10 = 0.10 < 0.40

      const snapshot = makeSnapshot({ trades, positionQty: new Decimal('100') });
      const intents = strategy.tick(snapshot, REASONS);

      expect(intents.length).toBe(1);
      const intent = intents[0] as { size: Quantity };
      // orderSize = 5, positionQty = 100 → min(100, 5) = 5
      expect(intent.size.value().toNumber()).toBe(5);
    });

    it('продаёт оставшийся размер если позиция < orderSize', () => {
      const trades = [
        makeTrade('BUY', 1),
        makeTrade('SELL', 9),
      ]; // buyRatio = 0.10 < 0.40

      const snapshot = makeSnapshot({ trades, positionQty: new Decimal('3') });
      const intents = strategy.tick(snapshot, REASONS);

      expect(intents.length).toBe(1);
      const intent = intents[0] as { size: Quantity };
      // min(3, 5) = 3
      expect(intent.size.value().toNumber()).toBe(3);
    });

    it('не продаёт если нет позиции (даже при слабом momentum)', () => {
      const trades = [
        makeTrade('BUY', 1),
        makeTrade('SELL', 9),
      ];

      const snapshot = makeSnapshot({ trades, positionQty: new Decimal(0) });
      const intents = strategy.tick(snapshot, REASONS);

      expect(intents.length).toBe(0);
    });
  });

  // ── HOLD ────────────────────────────────────────────────────────────────

  describe('HOLD (между порогами)', () => {
    it('ничего не делает при buyRatio между порогами', () => {
      const trades = [
        makeTrade('BUY', 5),
        makeTrade('SELL', 5),
      ]; // buyRatio = 0.50, между 0.40 и 0.65

      const snapshot = makeSnapshot({ trades });
      const intents = strategy.tick(snapshot, REASONS);

      expect(intents.length).toBe(0);
    });

    it('ничего не делает при buyRatio = exitThreshold (точно на границе)', () => {
      const trades = [
        makeTrade('BUY', 4),
        makeTrade('SELL', 6),
      ]; // buyRatio = 0.40 = exitThreshold → NOT less than → HOLD

      const snapshot = makeSnapshot({ trades, positionQty: new Decimal('10') });
      const intents = strategy.tick(snapshot, REASONS);

      expect(intents.length).toBe(0);
    });
  });

  // ── stop() ──────────────────────────────────────────────────────────────

  it('stop() возвращает CANCEL_ALL', () => {
    const intents = strategy.stop();

    expect(intents.length).toBe(1);
    expect(intents[0]).toEqual({ type: 'CANCEL_ALL' });
  });
});
