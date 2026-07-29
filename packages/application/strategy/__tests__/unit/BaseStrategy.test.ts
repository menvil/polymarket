import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { BaseStrategy } from '../../src/BaseStrategy.js';
import type { StrategySnapshot } from '../../src/types/StrategySnapshot.js';
import type { StrategyIntent } from '../../src/types/StrategyIntent.js';
import type { TriggerReason } from '../../src/types/TriggerReason.js';

// ── Тестовые типы ──────────────────────────────────────────

interface TestData {
  value: number;
}

type TestAction = 'BUY' | 'SELL' | 'HOLD';

// ── Тестовая реализация ────────────────────────────────────

class TestStrategy extends BaseStrategy<TestData, TestAction> {
  readonly id = 'test-1';
  readonly name = 'TestStrategy';

  /** Контроль возврата из gather() */
  gatherResult: TestData | undefined = { value: 42 };

  /** Контроль возврата из decide() */
  decideResult: TestAction[] = ['BUY'];

  /** Контроль возврата из toIntents() */
  intentsResult: StrategyIntent[] = [{ type: 'CANCEL_ALL' }];

  /** Записи вызовов для проверки */
  gatherCalls: StrategySnapshot[] = [];
  decideCalls: Array<{ data: TestData; reasons: ReadonlySet<TriggerReason> }> = [];
  toIntentsCalls: TestAction[][] = [];

  protected gather(snapshot: StrategySnapshot): TestData | undefined {
    this.gatherCalls.push(snapshot);
    return this.gatherResult;
  }

  protected decide(data: TestData, reasons: ReadonlySet<TriggerReason>): TestAction[] {
    this.decideCalls.push({ data, reasons });
    return this.decideResult;
  }

  protected toIntents(actions: TestAction[]): StrategyIntent[] {
    this.toIntentsCalls.push(actions);
    return this.intentsResult;
  }

  /** Публичные обёртки для тестирования protected helpers */
  publicAdjustSellSize(desired: Decimal, positionQty: Decimal, minOrderSize: Decimal): Decimal {
    return this.adjustSellSize(desired, positionQty, minOrderSize);
  }

  publicAdjustBuySize(desired: Decimal, price: Decimal, minOrderValue: Decimal, minOrderSize: Decimal): Decimal | undefined {
    return this.adjustBuySize(desired, price, minOrderValue, minOrderSize);
  }

  publicAdjustBuySizeAllowingIncrease(
    desired: Decimal,
    price: Decimal,
    minOrderValue: Decimal,
    minOrderSize: Decimal,
  ): Decimal | undefined {
    return this.adjustBuySizeAllowingIncrease(desired, price, minOrderValue, minOrderSize);
  }
}

// ── Helpers ────────────────────────────────────────────────

function makeSnapshot(overrides: Partial<StrategySnapshot> = {}): StrategySnapshot {
  return {
    instrumentId: 'token-1' as any,
    market: {} as any,
    topOfBook: undefined,
    bookHistory: undefined,
    tradeTape: undefined,
    openOrders: [],
    matchedOrders: [],
    hasInFlightFills: false,
    constraints: undefined,
    complementaryConstraints: undefined,
    portfolio: undefined,
    nowMs: 1000,
    ...overrides,
  };
}

function makeReasons(...reasons: TriggerReason[]): ReadonlySet<TriggerReason> {
  return new Set(reasons);
}

// ── Тесты ──────────────────────────────────────────────────

describe('BaseStrategy', () => {
  // ── tick() pipeline ────────────────────────────────────

  describe('tick()', () => {
    it('should call gather → decide → toIntents in order', () => {
      const strategy = new TestStrategy();
      const snapshot = makeSnapshot();
      const reasons = makeReasons('BOOK');

      const intents = strategy.tick(snapshot, reasons);

      expect(strategy.gatherCalls).toHaveLength(1);
      expect(strategy.gatherCalls[0]).toBe(snapshot);
      expect(strategy.decideCalls).toHaveLength(1);
      expect(strategy.decideCalls[0].data).toEqual({ value: 42 });
      expect(strategy.decideCalls[0].reasons).toBe(reasons);
      expect(strategy.toIntentsCalls).toHaveLength(1);
      expect(strategy.toIntentsCalls[0]).toEqual(['BUY']);
      expect(intents).toEqual([{ type: 'CANCEL_ALL' }]);
    });

    it('should return [] when gather returns undefined', () => {
      const strategy = new TestStrategy();
      strategy.gatherResult = undefined;

      const intents = strategy.tick(makeSnapshot(), makeReasons('BOOK'));

      expect(intents).toEqual([]);
      expect(strategy.gatherCalls).toHaveLength(1);
      expect(strategy.decideCalls).toHaveLength(0);
      expect(strategy.toIntentsCalls).toHaveLength(0);
    });

    it('should return [] when decide returns empty array', () => {
      const strategy = new TestStrategy();
      strategy.decideResult = [];

      const intents = strategy.tick(makeSnapshot(), makeReasons('TRADE'));

      expect(intents).toEqual([]);
      expect(strategy.gatherCalls).toHaveLength(1);
      expect(strategy.decideCalls).toHaveLength(1);
      expect(strategy.toIntentsCalls).toHaveLength(0);
    });

    it('should pass reasons to decide', () => {
      const strategy = new TestStrategy();
      const reasons = makeReasons('FILL', 'ORDER_UPDATE');

      strategy.tick(makeSnapshot(), reasons);

      expect(strategy.decideCalls[0].reasons).toBe(reasons);
    });

    it('should return intents from toIntents', () => {
      const strategy = new TestStrategy();
      const expected: StrategyIntent[] = [
        { type: 'CANCEL_ALL' },
        { type: 'CANCEL', orderId: 'order-1' as any },
      ];
      strategy.intentsResult = expected;

      const intents = strategy.tick(makeSnapshot(), makeReasons('BOOK'));

      expect(intents).toBe(expected);
    });
  });

  // ── initialize() ──────────────────────────────────────

  describe('initialize()', () => {
    it('should return Ok(undefined) by default', async () => {
      const strategy = new TestStrategy();

      const result = await strategy.initialize();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeUndefined();
      }
    });
  });

  // ── stop() ────────────────────────────────────────────

  describe('stop()', () => {
    it('should return CANCEL_ALL by default', () => {
      const strategy = new TestStrategy();

      const intents = strategy.stop();

      expect(intents).toEqual([{ type: 'CANCEL_ALL' }]);
    });
  });

  // ── getMetrics() ──────────────────────────────────────

  describe('getMetrics()', () => {
    it('should return empty object by default', () => {
      const strategy = new TestStrategy();

      const metrics = strategy.getMetrics();

      expect(metrics).toEqual({});
    });
  });

  // ── id / name ─────────────────────────────────────────

  describe('id / name', () => {
    it('should expose id and name', () => {
      const strategy = new TestStrategy();

      expect(strategy.id).toBe('test-1');
      expect(strategy.name).toBe('TestStrategy');
    });
  });

  // ── adjustSellSize() ──────────────────────────────────

  describe('adjustSellSize()', () => {
    const strategy = new TestStrategy();
    const d = (v: string) => new Decimal(v);

    it('should return positionQty when positionQty < minOrderSize', () => {
      // positionQty=4, minOrderSize=5 → позиция слишком мала → возвращаем как есть
      expect(strategy.publicAdjustSellSize(d('4'), d('4'), d('5'))).toEqual(d('4'));
    });

    it('should clamp up to minOrderSize when desired < minOrderSize', () => {
      // positionQty=15, desired=3, minOrderSize=5 → effective=5, remainder=10>=5 → 5
      expect(strategy.publicAdjustSellSize(d('3'), d('15'), d('5'))).toEqual(d('5'));
    });

    it('should sell entire position when remainder < minOrderSize', () => {
      // positionQty=9, desired=5, minOrderSize=5 → remainder=4<5 → продать 9
      expect(strategy.publicAdjustSellSize(d('5'), d('9'), d('5'))).toEqual(d('9'));
    });

    it('should use desired when remainder >= minOrderSize', () => {
      // positionQty=15, desired=5, minOrderSize=5 → remainder=10>=5 → 5
      expect(strategy.publicAdjustSellSize(d('5'), d('15'), d('5'))).toEqual(d('5'));
    });

    it('should sell entire position when desired equals positionQty', () => {
      // positionQty=5, desired=5, minOrderSize=5 → remainder=0 → 5
      expect(strategy.publicAdjustSellSize(d('5'), d('5'), d('5'))).toEqual(d('5'));
    });

    it('should sell entire position when positionQty equals minOrderSize and desired < min', () => {
      // positionQty=5, desired=3, minOrderSize=5 → effective=5, remainder=0 → 5
      expect(strategy.publicAdjustSellSize(d('3'), d('5'), d('5'))).toEqual(d('5'));
    });
  });

  // ── adjustBuySize() ───────────────────────────────────

  describe('adjustBuySize()', () => {
    const strategy = new TestStrategy();
    const d = (v: string) => new Decimal(v);

    it('should return desired when it meets all constraints', () => {
      // desired=10, price=0.55, minOrderValue=1, minOrderSize=5 → value=5.5>=1 → 10
      expect(strategy.publicAdjustBuySize(d('10'), d('0.55'), d('1'), d('5'))).toEqual(d('10'));
    });

    it('desired < minOrderSize → undefined (молчаливый overbuy запрещён)', () => {
      // desired=3, minOrderSize=5: клампирование вверх покупало бы больше
      // конфигурации стратегии → helper возвращает undefined.
      expect(strategy.publicAdjustBuySize(d('3'), d('0.55'), d('1'), d('5'))).toBeUndefined();
    });

    it('price × desired < minOrderValue → undefined (не увеличивает size)', () => {
      // desired=5, price=0.117 → notional 0.585 < minOrderValue=1 → undefined.
      expect(strategy.publicAdjustBuySize(d('5'), d('0.117'), d('1'), d('5'))).toBeUndefined();
    });

    it('value ровно равен minOrderValue → desired проходит', () => {
      // desired=5, price=0.20 → value=1.0 >= 1 → 5
      expect(strategy.publicAdjustBuySize(d('5'), d('0.20'), d('1'), d('5'))).toEqual(d('5'));
    });

    it('desired <= 0 → undefined', () => {
      expect(strategy.publicAdjustBuySize(d('0'), d('0.55'), d('1'), d('5'))).toBeUndefined();
    });

    it('price = 0 → undefined', () => {
      expect(strategy.publicAdjustBuySize(d('10'), d('0'), d('1'), d('5'))).toBeUndefined();
    });

    it('price < 0 → undefined', () => {
      expect(strategy.publicAdjustBuySize(d('10'), d('-0.5'), d('1'), d('5'))).toBeUndefined();
    });

    it('price = NaN → undefined', () => {
      expect(strategy.publicAdjustBuySize(d('10'), new Decimal(NaN), d('1'), d('5'))).toBeUndefined();
    });

    it('price = Infinity → undefined', () => {
      expect(strategy.publicAdjustBuySize(d('10'), new Decimal(Infinity), d('1'), d('5'))).toBeUndefined();
    });

    it('desiredSize = NaN → undefined', () => {
      expect(strategy.publicAdjustBuySize(new Decimal(NaN), d('0.55'), d('1'), d('5'))).toBeUndefined();
    });

    it('desiredSize = Infinity → undefined', () => {
      expect(strategy.publicAdjustBuySize(new Decimal(Infinity), d('0.55'), d('1'), d('5'))).toBeUndefined();
    });

    it('minOrderValue < 0 → undefined', () => {
      expect(strategy.publicAdjustBuySize(d('10'), d('0.55'), d('-1'), d('5'))).toBeUndefined();
    });

    it('minOrderSize < 0 → undefined', () => {
      expect(strategy.publicAdjustBuySize(d('10'), d('0.55'), d('1'), d('-5'))).toBeUndefined();
    });
  });

  // ── adjustBuySizeAllowingIncrease() ───────────────────

  describe('adjustBuySizeAllowingIncrease()', () => {
    const strategy = new TestStrategy();
    const d = (v: string) => new Decimal(v);

    it('увеличивает до minOrderSize (явный opt-in overbuy)', () => {
      expect(strategy.publicAdjustBuySizeAllowingIncrease(d('3'), d('0.55'), d('1'), d('5'))).toEqual(d('5'));
    });

    it('увеличивает до размера, покрывающего minOrderValue (ceil до 2 dp)', () => {
      // price=0.01, minOrderValue=1 → нужен size 100 (> minOrderSize=5).
      expect(strategy.publicAdjustBuySizeAllowingIncrease(d('5'), d('0.01'), d('1'), d('5'))).toEqual(d('100'));
    });

    it('валидный desired возвращается без изменений', () => {
      expect(strategy.publicAdjustBuySizeAllowingIncrease(d('10'), d('0.55'), d('1'), d('5'))).toEqual(d('10'));
    });

    it('desired <= 0 или price <= 0 → undefined', () => {
      expect(strategy.publicAdjustBuySizeAllowingIncrease(d('0'), d('0.55'), d('1'), d('5'))).toBeUndefined();
      expect(strategy.publicAdjustBuySizeAllowingIncrease(d('5'), d('0'), d('1'), d('5'))).toBeUndefined();
    });

    it('price < 0 → undefined', () => {
      expect(strategy.publicAdjustBuySizeAllowingIncrease(d('5'), d('-0.5'), d('1'), d('5'))).toBeUndefined();
    });

    it('price = NaN → undefined', () => {
      expect(strategy.publicAdjustBuySizeAllowingIncrease(d('5'), new Decimal(NaN), d('1'), d('5'))).toBeUndefined();
    });

    it('price = Infinity → undefined', () => {
      expect(strategy.publicAdjustBuySizeAllowingIncrease(d('5'), new Decimal(Infinity), d('1'), d('5'))).toBeUndefined();
    });

    it('desiredSize = NaN → undefined', () => {
      expect(strategy.publicAdjustBuySizeAllowingIncrease(new Decimal(NaN), d('0.55'), d('1'), d('5'))).toBeUndefined();
    });

    it('minOrderValue < 0 → undefined', () => {
      expect(strategy.publicAdjustBuySizeAllowingIncrease(d('5'), d('0.55'), d('-1'), d('5'))).toBeUndefined();
    });

    it('minOrderSize < 0 → undefined', () => {
      expect(strategy.publicAdjustBuySizeAllowingIncrease(d('5'), d('0.55'), d('1'), d('-5'))).toBeUndefined();
    });
  });
});
