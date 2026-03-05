/**
 * Тесты для MarketTradingPolicy
 *
 * @remarks
 * Проверяет:
 * - getTradingState(market, nowMs) — единственная точка торговых решений
 * - canForceClose(market) — admin-действие без проверки времени
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

const YES_TOKEN = OutcomeToken.of(TEST_CONDITION_REF, BinaryOutcome.UP);
const NO_TOKEN = OutcomeToken.of(TEST_CONDITION_REF, BinaryOutcome.DOWN);

const TEST_OUTCOMES: readonly [Outcome, Outcome] = [
  { token: YES_TOKEN, index: 0, name: 'Yes' },
  { token: NO_TOKEN, index: 1, name: 'No' },
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

describe('MarketTradingPolicy.canForceClose()', () => {
  it('true — ACTIVE (не истёк)', () => {
    const market = makeMarket(MarketState.active());
    expect(MarketTradingPolicy.canForceClose(market)).toBe(true);
  });

  it('true — ACTIVE (уже истёк, форс-клоз всё равно возможен)', () => {
    const expired = makeMarket(MarketState.active(), AT_EXPIRY - 100);
    expect(MarketTradingPolicy.canForceClose(expired)).toBe(true);
  });

  it('false — CLOSED', () => {
    const market = makeMarket(MarketState.closed());
    expect(MarketTradingPolicy.canForceClose(market)).toBe(false);
  });

  it('false — RESOLVED', () => {
    const market = makeMarket(MarketState.resolved(0));
    expect(MarketTradingPolicy.canForceClose(market)).toBe(false);
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
    const closed = market.close(AT_EXPIRY);
    expect(MarketTradingPolicy.getTradingState(closed, AT_EXPIRY)).toBe('CLOSED');

    // resolve() переводит в RESOLVED
    const resolved = closed.resolve(0, AT_EXPIRY);
    expect(MarketTradingPolicy.getTradingState(resolved, AT_EXPIRY)).toBe('RESOLVED');
  });

  it('exhaustive switch покрывает все состояния', () => {
    const states = ['TRADING', 'EXPIRED', 'CLOSED', 'RESOLVED'] satisfies TradingState[];
    expect(states).toHaveLength(4);
  });
});
