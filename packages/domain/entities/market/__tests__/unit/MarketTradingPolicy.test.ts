/**
 * Тесты для MarketTradingPolicy
 *
 * @remarks
 * Проверяет что Policy корректно отвечает на вопросы:
 * - canTrade(market, nowMs) — ACTIVE + не истёк
 * - canClose(market, nowMs) — ACTIVE + истёк
 * - canForceClose(market)   — ACTIVE (без проверки времени)
 * - canResolve(market)      — CLOSED
 */

import { describe, it, expect } from '@jest/globals';
import { Market, type Outcome } from '../../src/Market.js';
import { MarketTradingPolicy } from '../../src/MarketTradingPolicy.js';
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
const AFTER_EXPIRY = EXPIRATION_MS;      // рынок истёк (nowMs >= expirationMs)

// ==================== Тесты ====================

describe('MarketTradingPolicy.canTrade()', () => {
  it('true — ACTIVE + не истёк', () => {
    const market = makeMarket(MarketState.active());
    expect(MarketTradingPolicy.canTrade(market, BEFORE_EXPIRY)).toBe(true);
  });

  it('false — ACTIVE + истёк', () => {
    const market = makeMarket(MarketState.active());
    expect(MarketTradingPolicy.canTrade(market, AFTER_EXPIRY)).toBe(false);
  });

  it('false — CLOSED (не важно время)', () => {
    const market = makeMarket(MarketState.closed());
    expect(MarketTradingPolicy.canTrade(market, BEFORE_EXPIRY)).toBe(false);
  });

  it('false — RESOLVED (не важно время)', () => {
    const market = makeMarket(MarketState.resolved(0));
    expect(MarketTradingPolicy.canTrade(market, BEFORE_EXPIRY)).toBe(false);
  });
});

describe('MarketTradingPolicy.canClose()', () => {
  it('true — ACTIVE + истёк (стандартный lifecycle)', () => {
    const market = makeMarket(MarketState.active());
    expect(MarketTradingPolicy.canClose(market, AFTER_EXPIRY)).toBe(true);
  });

  it('false — ACTIVE + не истёк (рано закрывать)', () => {
    const market = makeMarket(MarketState.active());
    expect(MarketTradingPolicy.canClose(market, BEFORE_EXPIRY)).toBe(false);
  });

  it('false — CLOSED (уже закрыт)', () => {
    const market = makeMarket(MarketState.closed());
    expect(MarketTradingPolicy.canClose(market, AFTER_EXPIRY)).toBe(false);
  });

  it('false — RESOLVED (уже разрешён)', () => {
    const market = makeMarket(MarketState.resolved(1));
    expect(MarketTradingPolicy.canClose(market, AFTER_EXPIRY)).toBe(false);
  });
});

describe('MarketTradingPolicy.canForceClose()', () => {
  it('true — ACTIVE (даже если не истёк)', () => {
    const market = makeMarket(MarketState.active());
    expect(MarketTradingPolicy.canForceClose(market)).toBe(true);
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

describe('MarketTradingPolicy.canResolve()', () => {
  it('true — CLOSED', () => {
    const market = makeMarket(MarketState.closed());
    expect(MarketTradingPolicy.canResolve(market)).toBe(true);
  });

  it('false — ACTIVE', () => {
    const market = makeMarket(MarketState.active());
    expect(MarketTradingPolicy.canResolve(market)).toBe(false);
  });

  it('false — RESOLVED', () => {
    const market = makeMarket(MarketState.resolved(0));
    expect(MarketTradingPolicy.canResolve(market)).toBe(false);
  });
});

describe('MarketTradingPolicy — нельзя создать экземпляр', () => {
  it('бросает Error при вызове конструктора', () => {
    // @ts-expect-error - testing private constructor
    expect(() => new MarketTradingPolicy()).toThrow(Error);
  });
});

describe('Policy + Entity интеграция', () => {
  it('canClose → close() → canResolve → resolve() корректный цикл', () => {
    const market = makeMarket(MarketState.active());
    const now = AFTER_EXPIRY;

    expect(MarketTradingPolicy.canClose(market, now)).toBe(true);
    const closed = market.close(now);

    expect(MarketTradingPolicy.canResolve(closed)).toBe(true);
    const resolved = closed.resolve(0, now);

    expect(resolved.isResolved()).toBe(true);
    expect(MarketTradingPolicy.canTrade(resolved, now)).toBe(false);
  });
});
