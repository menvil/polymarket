import { describe, it, expect } from '@jest/globals';
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
});
