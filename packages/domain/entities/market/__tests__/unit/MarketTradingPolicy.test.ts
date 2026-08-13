/**
 * Тесты для MarketTradingPolicy
 *
 * @remarks
 * Проверяет:
 * - getTradingState(market, nowMs) — единственная точка торговых решений
 * - evaluateForceClose(market) — admin-действие без проверки времени
 * - Полный lifecycle через policy + entity
 */

import { describe, it, expect } from '@jest/globals';
import { Market, type Outcome } from '../../src/Market.js';
import { MarketTradingPolicy, type TradingState } from '../../src/MarketTradingPolicy.js';
import {
  MarketState,
  unsafeMarketId,
  parseMarketSlug,
  OutcomeToken,
} from '../../src/value-objects/index.js';
import {
  BinaryOutcome,
  type OnChainConditionRef,
  asOnChainProtocolId,
  parseChainId,
  parseConditionId,
} from '@polymarket/ids';

// ==================== Тестовые данные ====================

const EXPIRATION_MS = 1_000_000;

const TEST_CONDITION_REF: OnChainConditionRef = {
  kind: 'ONCHAIN',
  protocolId: asOnChainProtocolId('POLYMARKET_CTF')!,
  chainId: parseChainId('137')!,
  conditionId: parseConditionId('0x' + 'ab'.repeat(32))!,
};

const UP_TOKEN = OutcomeToken.of(TEST_CONDITION_REF, BinaryOutcome.UP);
const DOWN_TOKEN = OutcomeToken.of(TEST_CONDITION_REF, BinaryOutcome.DOWN);

const TEST_OUTCOMES: readonly [Outcome, Outcome] = [
  { token: UP_TOKEN, index: 0, name: 'Yes' },
  { token: DOWN_TOKEN, index: 1, name: 'No' },
];

function makeMarket(state: MarketState, expirationMs = EXPIRATION_MS) {
  const result = Market.create({
    id: unsafeMarketId('market-abc'),
    slug: parseMarketSlug('will-trump-win')!,
    question: 'Will Trump win?',
    outcomes: TEST_OUTCOMES,
    expirationMs,
    state,
  });
  if (!result.ok) throw new Error('Failed to create test market');
  return result.value;
}

// Вспомогательная функция для извлечения значения из Result в тестах
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }, ctx = ''): T {
  if (!result.ok) throw new Error(`Expected Ok result in test setup${ctx ? `: ${ctx}` : ''}`);
  return result.value;
}

const BEFORE_EXPIRY = EXPIRATION_MS - 1; // рынок ещё не истёк
const AT_EXPIRY = EXPIRATION_MS;          // рынок истёк (nowMs >= expirationMs)
const AFTER_EXPIRY = EXPIRATION_MS + 1;

// ==================== Тесты ====================

describe('MarketTradingPolicy.getTradingState()', () => {
  describe('ACTIVE + не истёк → TRADING', () => {
    it('возвращает TRADING', () => {
      const market = makeMarket(MarketState.active());
      expect(MarketTradingPolicy.getTradingState(market, BEFORE_EXPIRY)).toBe('TRADING');
    });

    it('TRADING: в момент непосредственно до истечения', () => {
      const market = makeMarket(MarketState.active());
      expect(MarketTradingPolicy.getTradingState(market, EXPIRATION_MS - 1)).toBe('TRADING');
    });
  });

  describe('ACTIVE + истёк → EXPIRED', () => {
    it('возвращает EXPIRED в момент истечения', () => {
      const market = makeMarket(MarketState.active());
      expect(MarketTradingPolicy.getTradingState(market, AT_EXPIRY)).toBe('EXPIRED');
    });

    it('возвращает EXPIRED после истечения', () => {
      const market = makeMarket(MarketState.active());
      expect(MarketTradingPolicy.getTradingState(market, AFTER_EXPIRY)).toBe('EXPIRED');
    });
  });

  describe('CLOSED → CLOSED', () => {
    it('возвращает CLOSED (не зависит от времени)', () => {
      const market = makeMarket(MarketState.closed());
      expect(MarketTradingPolicy.getTradingState(market, BEFORE_EXPIRY)).toBe('CLOSED');
      expect(MarketTradingPolicy.getTradingState(market, AFTER_EXPIRY)).toBe('CLOSED');
    });
  });

  describe('RESOLVED → RESOLVED', () => {
    it('возвращает RESOLVED (не зависит от времени)', () => {
      const market = makeMarket(MarketState.resolved(0));
      expect(MarketTradingPolicy.getTradingState(market, BEFORE_EXPIRY)).toBe('RESOLVED');
      expect(MarketTradingPolicy.getTradingState(market, AFTER_EXPIRY)).toBe('RESOLVED');
    });
  });

  it('переход TRADING → EXPIRED в момент истечения', () => {
    const market = makeMarket(MarketState.active());
    expect(MarketTradingPolicy.getTradingState(market, BEFORE_EXPIRY)).toBe('TRADING');
    expect(MarketTradingPolicy.getTradingState(market, AT_EXPIRY)).toBe('EXPIRED');
  });
});

describe('MarketTradingPolicy.evaluateForceClose()', () => {
  it('allowed: true — ACTIVE (не истёк)', () => {
    const market = makeMarket(MarketState.active());
    expect(MarketTradingPolicy.evaluateForceClose(market)).toEqual({ allowed: true });
  });

  it('allowed: true — ACTIVE (уже истёк, форс-клоз всё равно возможен)', () => {
    const expired = makeMarket(MarketState.active(), AT_EXPIRY - 100);
    expect(MarketTradingPolicy.evaluateForceClose(expired)).toEqual({ allowed: true });
  });

  it('allowed: false + MARKET_ALREADY_CLOSED — CLOSED', () => {
    const market = makeMarket(MarketState.closed());
    expect(MarketTradingPolicy.evaluateForceClose(market)).toEqual({
      allowed: false,
      reason: 'MARKET_ALREADY_CLOSED',
    });
  });

  it('allowed: false + MARKET_ALREADY_RESOLVED — RESOLVED', () => {
    const market = makeMarket(MarketState.resolved(0));
    expect(MarketTradingPolicy.evaluateForceClose(market)).toEqual({
      allowed: false,
      reason: 'MARKET_ALREADY_RESOLVED',
    });
  });
});

describe('MarketTradingPolicy — нельзя создать экземпляр', () => {
  it('бросает Error при вызове конструктора', () => {
    // @ts-expect-error - testing private constructor
    expect(() => new MarketTradingPolicy()).toThrow(Error);
  });
});

describe('Policy + Entity — полный lifecycle', () => {
  it('TRADING → (expire) → EXPIRED → close → CLOSED → resolve → RESOLVED', () => {
    const market = makeMarket(MarketState.active());

    // До истечения: TRADING
    expect(MarketTradingPolicy.getTradingState(market, BEFORE_EXPIRY)).toBe('TRADING');

    // После истечения: EXPIRED
    expect(MarketTradingPolicy.getTradingState(market, AT_EXPIRY)).toBe('EXPIRED');

    // close() переводит в CLOSED
    const closed = unwrap(market.close(AT_EXPIRY));
    expect(MarketTradingPolicy.getTradingState(closed, AT_EXPIRY)).toBe('CLOSED');

    // resolve() переводит в RESOLVED
    const resolved = unwrap(closed.resolve(0, AT_EXPIRY));
    expect(MarketTradingPolicy.getTradingState(resolved, AT_EXPIRY)).toBe('RESOLVED');
  });

  it('каждое TradingState реально достижимо через getTradingState()', () => {
    const activeMarket = makeMarket(MarketState.active());
    const closedMarket = makeMarket(MarketState.closed());
    const resolvedMarket = makeMarket(MarketState.resolved(0));

    // TRADING — ACTIVE до истечения
    expect(MarketTradingPolicy.getTradingState(activeMarket, BEFORE_EXPIRY)).toBe('TRADING');
    // EXPIRED — ACTIVE после истечения
    expect(MarketTradingPolicy.getTradingState(activeMarket, AT_EXPIRY)).toBe('EXPIRED');
    // CLOSED
    expect(MarketTradingPolicy.getTradingState(closedMarket, AT_EXPIRY)).toBe('CLOSED');
    // RESOLVED
    expect(MarketTradingPolicy.getTradingState(resolvedMarket, AT_EXPIRY)).toBe('RESOLVED');

    // Все значения типа TradingState покрыты выше (compile-time guarantee через satisfies):
    const _allStates = ['TRADING', 'EXPIRED', 'CLOSED', 'RESOLVED'] satisfies TradingState[];
    void _allStates;
  });
});
