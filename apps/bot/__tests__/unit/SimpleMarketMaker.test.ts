/**
 * Тесты SimpleMarketMaker стратегии.
 *
 * @remarks
 * Проверяет три основных сценария:
 * 1. Близко к экспирации → CANCEL_ALL + SELL
 * 2. Узкий спред → CANCEL_ALL
 * 3. Нормальный режим → BUY + SELL котировки
 */
import { SimpleMarketMaker } from '../../src/strategies/SimpleMarketMaker.js';
import type { SimpleMarketMakerConfig } from '../../src/strategies/SimpleMarketMaker.js';
import type { StrategySnapshot, TriggerReason } from '@polymarket/strategy';
import { Price } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

// ── Хелперы ──────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: SimpleMarketMakerConfig = {
  spreadOffset: new Decimal('0.02'),
  minSpread: new Decimal('0.01'),
  orderSize: new Decimal('10'),
  exitThresholdMs: 60_000,
};

/**
 * Создаёт минимальный StrategySnapshot для тестирования.
 */
function makeSnapshot(overrides: Partial<{
  bestBid: Decimal;
  bestAsk: Decimal;
  spread: Decimal;
  positionQty: Decimal;
  availableBalance: Decimal;
  expirationMs: number;
  nowMs: number;
  openOrderCount: number;
}>): StrategySnapshot {
  const {
    bestBid,
    bestAsk,
    spread,
    positionQty = new Decimal(0),
    availableBalance = new Decimal('1000'),
    expirationMs = Date.now() + 3_600_000,
    nowMs = Date.now(),
    openOrderCount = 0,
  } = overrides;

  // Mock portfolio с позицией
  const mockPosition = positionQty.gt(0) ? {
    quantity: { value: () => positionQty },
  } : undefined;

  const mockPortfolio = {
    getPosition: () => mockPosition,
    balance: {
      available: () => ({ value: () => availableBalance }),
    },
  };

  // Генерируем mock open orders
  const openOrders = Array.from({ length: openOrderCount }, () => ({}));

  return {
    instrumentId: 'test-instrument' as any,
    market: { expirationMs } as any,
    topOfBook: bestBid !== undefined ? {
      bestBid: bestBid ? Price.of(bestBid) : undefined,
      bestAsk: bestAsk ? Price.of(bestAsk) : undefined,
      spread: spread ? Price.of(spread) : undefined,
      bestBidSize: undefined,
      bestAskSize: undefined,
    } : undefined,
    bookHistory: undefined,
    tradeTape: undefined,
    openOrders: openOrders as any,
    portfolio: mockPortfolio as any,
    nowMs,
  };
}

// ── Тесты ────────────────────────────────────────────────────────────────────

describe('SimpleMarketMaker', () => {
  let strategy: SimpleMarketMaker;

  beforeEach(() => {
    strategy = new SimpleMarketMaker(DEFAULT_CONFIG, 'test-mm');
  });

  it('имеет корректный id и name', () => {
    expect(strategy.id).toBe('test-mm');
    expect(strategy.name).toBe('SimpleMarketMaker');
  });

  it('использует дефолтный id если не указан', () => {
    const defaultStrategy = new SimpleMarketMaker(DEFAULT_CONFIG);
    expect(defaultStrategy.id).toBe('smm-1');
  });

  // ── Экспирация ──────────────────────────────────────────────────────────

  describe('близко к экспирации', () => {
    it('отменяет все ордера и выходит из позиции при SELL', () => {
      const nowMs = 1_000_000;
      const snapshot = makeSnapshot({
        bestBid: new Decimal('0.50'),
        bestAsk: new Decimal('0.55'),
        spread: new Decimal('0.05'),
        expirationMs: nowMs + 30_000, // 30s < 60s threshold
        nowMs,
        positionQty: new Decimal('5'),
      });

      const reasons = new Set<TriggerReason>(['BOOK']);
      const intents = strategy.tick(snapshot, reasons);

      expect(intents.length).toBe(2);
      expect(intents[0]).toEqual({ type: 'CANCEL_ALL' });
      expect(intents[1]).toMatchObject({
        type: 'PLACE',
        side: 'SELL',
      });
    });

    it('отменяет все ордера без SELL если нет позиции', () => {
      const nowMs = 1_000_000;
      const snapshot = makeSnapshot({
        bestBid: new Decimal('0.50'),
        bestAsk: new Decimal('0.55'),
        spread: new Decimal('0.05'),
        expirationMs: nowMs + 10_000,
        nowMs,
        positionQty: new Decimal(0),
      });

      const intents = strategy.tick(snapshot, new Set<TriggerReason>(['TIMER']));

      expect(intents.length).toBe(1);
      expect(intents[0]).toEqual({ type: 'CANCEL_ALL' });
    });
  });

  // ── Узкий спред ─────────────────────────────────────────────────────────

  describe('узкий спред', () => {
    it('отменяет все ордера если спред < minSpread', () => {
      const snapshot = makeSnapshot({
        bestBid: new Decimal('0.50'),
        bestAsk: new Decimal('0.505'),
        spread: new Decimal('0.005'), // < 0.01 minSpread
      });

      const intents = strategy.tick(snapshot, new Set<TriggerReason>(['BOOK']));

      expect(intents.length).toBe(1);
      expect(intents[0]).toEqual({ type: 'CANCEL_ALL' });
    });
  });

  // ── Нормальный режим ───────────────────────────────────────────────────

  describe('нормальный режим', () => {
    it('выставляет bid и ask котировки с offset от mid', () => {
      const snapshot = makeSnapshot({
        bestBid: new Decimal('0.48'),
        bestAsk: new Decimal('0.52'),
        spread: new Decimal('0.04'),
      });

      const intents = strategy.tick(snapshot, new Set<TriggerReason>(['BOOK']));

      // mid = 0.50, bidPrice = 0.48, askPrice = 0.52
      expect(intents.length).toBe(2);
      expect(intents[0]).toMatchObject({ type: 'PLACE', side: 'BUY' });
      expect(intents[1]).toMatchObject({ type: 'PLACE', side: 'SELL' });

      // Проверяем цены: mid = 0.50, offset = 0.02
      const buyIntent = intents[0] as { price: Price };
      const sellIntent = intents[1] as { price: Price };
      expect(buyIntent.price.value().toNumber()).toBe(0.48);
      expect(sellIntent.price.value().toNumber()).toBe(0.52);
    });

    it('отменяет старые ордера перед выставлением новых', () => {
      const snapshot = makeSnapshot({
        bestBid: new Decimal('0.48'),
        bestAsk: new Decimal('0.52'),
        spread: new Decimal('0.04'),
        openOrderCount: 2,
      });

      const intents = strategy.tick(snapshot, new Set<TriggerReason>(['BOOK']));

      expect(intents.length).toBe(3);
      expect(intents[0]).toEqual({ type: 'CANCEL_ALL' });
      expect(intents[1]).toMatchObject({ type: 'PLACE', side: 'BUY' });
      expect(intents[2]).toMatchObject({ type: 'PLACE', side: 'SELL' });
    });

    it('не выставляет ордера если нет topOfBook', () => {
      const snapshot = makeSnapshot({});

      const intents = strategy.tick(snapshot, new Set<TriggerReason>(['TIMER']));

      expect(intents.length).toBe(0);
    });

    it('не выставляет ордера если bestBid отсутствует', () => {
      const snapshot = makeSnapshot({
        bestBid: undefined,
        bestAsk: new Decimal('0.55'),
        spread: new Decimal('0.05'),
      });

      const intents = strategy.tick(snapshot, new Set<TriggerReason>(['BOOK']));

      expect(intents.length).toBe(0);
    });

    it('не выставляет ордера если bidPrice < 0.01', () => {
      const snapshot = makeSnapshot({
        bestBid: new Decimal('0.01'),
        bestAsk: new Decimal('0.02'),
        spread: new Decimal('0.01'),
      });

      const intents = strategy.tick(snapshot, new Set<TriggerReason>(['BOOK']));

      // mid = 0.015, bidPrice = -0.005 → вне границ → нет ордеров
      expect(intents.length).toBe(0);
    });

    it('не выставляет ордера если askPrice > 0.99', () => {
      const snapshot = makeSnapshot({
        bestBid: new Decimal('0.98'),
        bestAsk: new Decimal('0.99'),
        spread: new Decimal('0.01'),
      });

      const intents = strategy.tick(snapshot, new Set<TriggerReason>(['BOOK']));

      // mid = 0.985, askPrice = 1.005 → вне границ → нет ордеров
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
