/**
 * Тесты DumbStrategy.
 *
 * @remarks
 * Проверяет сценарии:
 * 1. ENTER — лимитная покупка на buyOffsetPct% ниже refPrice
 * 2. REPRICE_BUY — переставить ордер если рынок ушёл вверх на > repriceThreshold USDC
 * 3. HOLD — ждём пока ордер в рынке (дрейф в пределах threshold)
 * 4. EXIT — продажа с наценкой profitMarginPct% после исполнения BUY
 * 5. Граничные случаи: нет данных, недостаточно баланса, цена вне диапазона
 */
import { DumbStrategy } from '../../src/strategies/DumbStrategy.js';
import type { DumbStrategyConfig } from '../../src/strategies/DumbStrategy.js';
import type { StrategySnapshot, TriggerReason } from '@polymarket/strategy';
import { Price, Quantity } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

// ── Хелперы ──────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: DumbStrategyConfig = {
  orderSize: new Decimal('5'),
  buyOffsetPct: new Decimal('10'),      // BUY на 10% ниже refPrice
  profitMarginPct: new Decimal('5'),    // SELL на 5% выше цены входа
  repriceThreshold: new Decimal('0.08'), // переставляем при дрейфе >= 8 центов
};

/** Создаёт mock ордер с side, ценой и orderId */
function makeOrder(side: 'BUY' | 'SELL', price: Decimal, id = `order-${side.toLowerCase()}`) {
  return {
    id: id as any,
    side,
    price: Price.of(price),
  };
}

/**
 * Создаёт минимальный StrategySnapshot для тестирования DumbStrategy.
 */
function makeSnapshot(overrides: Partial<{
  bestAsk: Decimal;
  positionQty: Decimal;
  entryPrice: Decimal;
  availableBalance: Decimal;
  openOrders: ReturnType<typeof makeOrder>[];
}>): StrategySnapshot {
  const {
    bestAsk = new Decimal('0.50'),
    positionQty = new Decimal(0),
    entryPrice,
    availableBalance = new Decimal('1000'),
    openOrders = [],
  } = overrides;

  const mockPosition = positionQty.gt(0) ? {
    quantity: { value: () => positionQty },
    averageEntryPrice: { value: () => entryPrice ?? new Decimal('0.45') },
  } : undefined;

  const mockPortfolio = {
    getPosition: () => mockPosition,
    balance: {
      available: () => ({ value: () => availableBalance }),
    },
  };

  // Защита от инварианта Price (>= 0.0001)
  const bestBidValue = Decimal.max(bestAsk.minus('0.02'), new Decimal('0.0001'));

  return {
    instrumentId: 'test-instrument' as any,
    market: { expirationMs: Date.now() + 3_600_000 } as any,
    topOfBook: {
      bestBid: Price.of(bestBidValue),
      bestAsk: Price.of(bestAsk),
      spread: Price.of(new Decimal('0.02')),
      bestBidSize: undefined,
      bestAskSize: undefined,
    },
    bookHistory: undefined,
    tradeTape: undefined,
    openOrders: openOrders as any,
    matchedOrders: [],
    portfolio: mockPortfolio as any,
    nowMs: Date.now(),
    hasInFlightFills: false,
    constraints: undefined,
    complementaryConstraints: undefined,
  };
}

const REASONS = new Set<TriggerReason>(['BOOK']);

// ── Тесты ────────────────────────────────────────────────────────────────────

describe('DumbStrategy', () => {
  let strategy: DumbStrategy;

  beforeEach(() => {
    strategy = new DumbStrategy(DEFAULT_CONFIG, 'test-dumb');
  });

  it('имеет корректный id и name', () => {
    expect(strategy.id).toBe('test-dumb');
    expect(strategy.name).toBe('DumbStrategy');
  });

  it('использует дефолтный id если не указан', () => {
    expect(new DumbStrategy(DEFAULT_CONFIG).id).toBe('dumb-1');
  });

  // ── Нет данных ──────────────────────────────────────────────────────────

  it('возвращает [] если нет topOfBook', () => {
    const snapshot: StrategySnapshot = {
      instrumentId: 'test' as any,
      market: { expirationMs: Date.now() + 3_600_000 } as any,
      topOfBook: undefined,
      bookHistory: undefined,
      tradeTape: undefined,
      openOrders: [],
      matchedOrders: [],
      portfolio: undefined,
      hasInFlightFills: false,
      constraints: undefined,
      complementaryConstraints: undefined,
      nowMs: Date.now(),
    };

    expect(strategy.tick(snapshot, REASONS)).toHaveLength(0);
  });

  // ── ENTER ───────────────────────────────────────────────────────────────

  describe('ENTER (нет позиции, нет ордеров)', () => {
    it('выставляет BUY на buyOffsetPct% ниже bestAsk', () => {
      const snapshot = makeSnapshot({ bestAsk: new Decimal('0.50') });
      const intents = strategy.tick(snapshot, REASONS);

      expect(intents).toHaveLength(1);
      expect(intents[0]).toMatchObject({ type: 'PLACE', side: 'BUY' });

      const intent = intents[0] as { price: Price; size: Quantity };
      // targetBuyPrice = 0.50 * (1 - 10/100) = 0.50 * 0.9 = 0.45
      expect(intent.price.value().toNumber()).toBe(0.45);
      expect(intent.size.value().toNumber()).toBe(5);
    });

    it('не выставляет BUY если баланса не хватает', () => {
      // cost = 0.45 * 5 = 2.25, баланс = 1.00 < 2.25
      const snapshot = makeSnapshot({
        bestAsk: new Decimal('0.50'),
        availableBalance: new Decimal('1.00'),
      });

      expect(strategy.tick(snapshot, REASONS)).toHaveLength(0);
    });

    it('выставляет BUY если баланс ровно равен стоимости', () => {
      // cost = 0.45 * 5 = 2.25
      const snapshot = makeSnapshot({
        bestAsk: new Decimal('0.50'),
        availableBalance: new Decimal('2.25'),
      });
      const intents = strategy.tick(snapshot, REASONS);

      expect(intents).toHaveLength(1);
      expect(intents[0]).toMatchObject({ type: 'PLACE', side: 'BUY' });
    });

    it('не выставляет BUY если buyOffsetPct = 100% (targetBuyPrice = 0)', () => {
      const config100: DumbStrategyConfig = {
        ...DEFAULT_CONFIG,
        buyOffsetPct: new Decimal('100'),
      };
      const s = new DumbStrategy(config100, 'test');
      const snapshot = makeSnapshot({ bestAsk: new Decimal('0.50') });

      expect(s.tick(snapshot, REASONS)).toHaveLength(0);
    });
  });

  // ── REPRICE_BUY ─────────────────────────────────────────────────────────

  describe('REPRICE_BUY (рынок ушёл вверх на >= repriceThreshold)', () => {
    it('переставляет ордер если дрейф >= repriceThreshold (0.08)', () => {
      // Ордер @ 0.45 (был bestAsk=0.50 → target=0.45).
      // bestAsk вырос до 0.60 → newTarget = 0.60 * 0.9 = 0.54
      // drift = 0.54 - 0.45 = 0.09 >= 0.08 → REPRICE: только CANCEL
      // Новый PLACE придёт на следующем тике (нет открытых ордеров)
      const openOrders = [makeOrder('BUY', new Decimal('0.45'))];
      const snapshot = makeSnapshot({
        bestAsk: new Decimal('0.60'),
        openOrders,
      });

      const intents = strategy.tick(snapshot, REASONS);

      expect(intents).toHaveLength(1);
      expect(intents[0]).toMatchObject({ type: 'CANCEL', orderId: 'order-buy' });
    });

    it('НЕ переставляет если рынок ушёл ВНИЗ (HOLD — ордер приближается к рынку)', () => {
      // Ордер @ 0.45, bestAsk упал до 0.40 → newTarget = 0.36
      // targetPrice=0.36 < orderPrice=0.45 → HOLD
      const openOrders = [makeOrder('BUY', new Decimal('0.45'))];
      const snapshot = makeSnapshot({
        bestAsk: new Decimal('0.40'),
        openOrders,
      });

      expect(strategy.tick(snapshot, REASONS)).toHaveLength(0);
    });

    it('НЕ переставляет если дрейф < threshold (HOLD)', () => {
      // Ордер @ 0.45, bestAsk чуть вырос до 0.51.
      // newTarget = 0.51 * 0.9 = 0.459
      // drift = 0.459 - 0.45 = 0.009 < 0.08 → HOLD
      const openOrders = [makeOrder('BUY', new Decimal('0.45'))];
      const snapshot = makeSnapshot({
        bestAsk: new Decimal('0.51'),
        openOrders,
      });

      expect(strategy.tick(snapshot, REASONS)).toHaveLength(0);
    });

    it('НЕ переставляет если bestAsk не изменился (drift = 0)', () => {
      // Ордер @ 0.45, bestAsk = 0.50 → newTarget = 0.45 = orderPrice → drift = 0
      const openOrders = [makeOrder('BUY', new Decimal('0.45'))];
      const snapshot = makeSnapshot({
        bestAsk: new Decimal('0.50'),
        openOrders,
      });

      expect(strategy.tick(snapshot, REASONS)).toHaveLength(0);
    });

    it('переставляет точно на границе threshold (gte 0.08)', () => {
      // Ордер @ 0.45. Хотим drift ровно 0.08.
      // newTarget = 0.45 + 0.08 = 0.53
      // bestAsk = 0.53 / 0.9 ≈ 0.5889
      const openOrders = [makeOrder('BUY', new Decimal('0.45'))];
      const snapshot = makeSnapshot({
        bestAsk: new Decimal('0.5889'),
        openOrders,
      });

      // drift = 0.5889 * 0.9 - 0.45 ≈ 0.08001 >= 0.08 → REPRICE (только CANCEL)
      const intents = strategy.tick(snapshot, REASONS);
      expect(intents).toHaveLength(1);
      expect(intents[0]).toMatchObject({ type: 'CANCEL' });
    });

    it('использует orderId из открытого ордера для CANCEL', () => {
      const openOrders = [makeOrder('BUY', new Decimal('0.45'), 'my-custom-order-id')];
      const snapshot = makeSnapshot({
        bestAsk: new Decimal('0.60'),
        openOrders,
      });

      const intents = strategy.tick(snapshot, REASONS);

      expect(intents[0]).toMatchObject({ type: 'CANCEL', orderId: 'my-custom-order-id' });
    });
  });

  // ── EXIT ────────────────────────────────────────────────────────────────

  describe('EXIT (есть позиция, нет SELL ордеров)', () => {
    it('продаёт по entryPrice * (1 + profitMarginPct/100)', () => {
      const snapshot = makeSnapshot({
        positionQty: new Decimal('10'),
        entryPrice: new Decimal('0.48'),
      });

      const intents = strategy.tick(snapshot, REASONS);

      expect(intents).toHaveLength(1);
      expect(intents[0]).toMatchObject({ type: 'PLACE', side: 'SELL' });

      // sellPrice = 0.48 * 1.05 = 0.504
      const intent = intents[0] as { price: Price; size: Quantity };
      expect(intent.price.value().toNumber()).toBeCloseTo(0.504, 8);
    });

    it('продаёт всю позицию (DumbStrategy не дробит SELL по orderSize)', () => {
      const snapshot = makeSnapshot({
        positionQty: new Decimal('100'),
        entryPrice: new Decimal('0.40'),
      });

      const intents = strategy.tick(snapshot, REASONS);
      const intent = intents[0] as { size: Quantity };
      // DumbStrategy продаёт всю позицию целиком (orderSize ограничивает только BUY)
      expect(intent.size.value().toNumber()).toBe(100);
    });

    it('продаёт оставшийся размер если позиция < orderSize', () => {
      const snapshot = makeSnapshot({
        positionQty: new Decimal('3'),
        entryPrice: new Decimal('0.40'),
      });

      const intents = strategy.tick(snapshot, REASONS);
      const intent = intents[0] as { size: Quantity };
      // min(3, 5) = 3
      expect(intent.size.value().toNumber()).toBe(3);
    });

    it('не продаёт если sellPrice > 0.99', () => {
      // entryPrice = 0.96, sellPrice = 0.96 * 1.05 = 1.008 > 0.99
      const snapshot = makeSnapshot({
        positionQty: new Decimal('10'),
        entryPrice: new Decimal('0.96'),
      });

      expect(strategy.tick(snapshot, REASONS)).toHaveLength(0);
    });

    it('ждёт если SELL ордер уже выставлен (HOLD)', () => {
      const openOrders = [makeOrder('SELL', new Decimal('0.504'), 'sell-order')];
      const snapshot = makeSnapshot({
        positionQty: new Decimal('10'),
        entryPrice: new Decimal('0.48'),
        openOrders,
      });

      expect(strategy.tick(snapshot, REASONS)).toHaveLength(0);
    });
  });

  // ── Полный цикл ───────────────────────────────────────────────────────

  describe('полный цикл BUY → REPRICE → FILL → SELL', () => {
    it('симулирует реальный сценарий', () => {
      // Шаг 1: нет позиции → ставим BUY @ 0.50 * 0.9 = 0.45
      const snap1 = makeSnapshot({ bestAsk: new Decimal('0.50') });
      const intents1 = strategy.tick(snap1, REASONS);
      expect(intents1).toMatchObject([{ type: 'PLACE', side: 'BUY' }]);
      expect((intents1[0] as { price: Price }).price.value().toNumber()).toBe(0.45);

      // Шаг 2: ордер в рынке, цена без движения → HOLD
      const snap2 = makeSnapshot({
        bestAsk: new Decimal('0.50'),
        openOrders: [makeOrder('BUY', new Decimal('0.45'))],
      });
      expect(strategy.tick(snap2, REASONS)).toHaveLength(0);

      // Шаг 3: цена ушла на 0.60 → newTarget=0.54, drift=0.09 >= 0.08 → REPRICE (только CANCEL)
      const snap3 = makeSnapshot({
        bestAsk: new Decimal('0.60'),
        openOrders: [makeOrder('BUY', new Decimal('0.45'), 'stale-order')],
      });
      const intents3 = strategy.tick(snap3, REASONS);
      expect(intents3).toMatchObject([{ type: 'CANCEL', orderId: 'stale-order' }]);

      // Шаг 3b: ордер отменён, нет открытых ордеров → новый PLACE @ 0.60 * 0.9 = 0.54
      const snap3b = makeSnapshot({ bestAsk: new Decimal('0.60') });
      const intents3b = strategy.tick(snap3b, REASONS);
      expect(intents3b).toMatchObject([{ type: 'PLACE', side: 'BUY' }]);
      const newBuyPrice = (intents3b[0] as { price: Price }).price.value().toNumber();
      expect(newBuyPrice).toBeCloseTo(0.54, 5); // 0.60 * 0.9

      // Шаг 4: BUY исполнился @ 0.54 → позиция открыта, ставим SELL @ 0.54 * 1.05 = 0.567
      const snap4 = makeSnapshot({
        bestAsk: new Decimal('0.60'),
        positionQty: new Decimal('5'),
        entryPrice: new Decimal('0.54'),
      });
      const intents4 = strategy.tick(snap4, REASONS);
      expect(intents4).toMatchObject([{ type: 'PLACE', side: 'SELL' }]);
      const sellPrice = (intents4[0] as { price: Price }).price.value().toNumber();
      expect(sellPrice).toBeCloseTo(0.567, 5); // 0.54 * 1.05
    });
  });

  // ── stop() ──────────────────────────────────────────────────────────────

  it('stop() возвращает CANCEL_ALL', () => {
    const intents = strategy.stop();
    expect(intents).toEqual([{ type: 'CANCEL_ALL' }]);
  });

  it('getMetrics() возвращает пустой объект', () => {
    expect(strategy.getMetrics()).toEqual({});
  });
});
