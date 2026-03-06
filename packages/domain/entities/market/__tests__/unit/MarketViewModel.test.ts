/**
 * Тесты для MarketViewModel (toSnapshot, getMarketUrl)
 *
 * @remarks
 * Проверяет:
 * - getMarketUrl() строит корректный URL
 * - toSnapshot() сериализует Market в доменно-типизированный MarketSnapshot
 * - round-trip: Market → toSnapshot() → Market.fromSnapshot() → Market
 */

import { describe, it, expect } from '@jest/globals';
import { Market, type Outcome } from '../../src/Market.js';
import {
  MarketState,
  parseMarketSlug,
  unsafeMarketId,
  OutcomeToken,
} from '../../src/value-objects/index.js';
import {
  BinaryOutcome,
  type OnChainConditionRef,
  asOnChainProtocolId,
  parseChainId,
  parseConditionId,
} from '@polymarket/ids';
import { MarketViewModel } from '../../src/view/MarketViewModel.js';

// ==================== Тестовые данные ====================

const EXPIRATION_MS = 1_700_000_000_000;
const NOW = 0;

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

function makeActiveMarket() {
  return Market.create({
    id: unsafeMarketId('market-abc'),
    slug: parseMarketSlug('will-trump-win')!,
    question: 'Will Trump win?',
    outcomes: TEST_OUTCOMES,
    expirationMs: EXPIRATION_MS,
    state: MarketState.active(),
  });
}

// ==================== Тесты ====================

describe('MarketViewModel.getMarketUrl()', () => {
  it('возвращает URL вида https://polymarket.com/event/{slug}', () => {
    const result = makeActiveMarket();
    expect(result.ok).toBe(true);
    if (result.ok) {
      const url = MarketViewModel.getMarketUrl(result.value);
      expect(url).toBe('https://polymarket.com/event/will-trump-win');
    }
  });
});

describe('MarketViewModel.toSnapshot()', () => {
  it('сериализует ACTIVE рынок корректно', () => {
    const result = makeActiveMarket();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const snapshot = MarketViewModel.toSnapshot(result.value);
    expect(snapshot.id).toBe('market-abc');
    expect(snapshot.slug).toBe('will-trump-win');
    expect(snapshot.question).toBe('Will Trump win?');
    // token — OutcomeToken объект, outcomeKey() — метод
    expect(snapshot.outcomes[0].token.outcomeKey()).toBe('UP');
    expect(snapshot.outcomes[0].index).toBe(0);
    expect(snapshot.outcomes[0].name).toBe('Yes');
    expect(snapshot.outcomes[1].token.outcomeKey()).toBe('DOWN');
    expect(snapshot.outcomes[1].index).toBe(1);
    expect(snapshot.outcomes[1].name).toBe('No');
    // expirationMs — число
    expect(snapshot.expirationMs).toBe(EXPIRATION_MS);
    expect(snapshot.state).toEqual({ status: 'ACTIVE' });
  });

  it('сериализует CLOSED рынок корректно', () => {
    const result = makeActiveMarket();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const snapshot = MarketViewModel.toSnapshot(result.value.close(NOW));
    expect(snapshot.state).toEqual({ status: 'CLOSED' });
  });

  it('сериализует RESOLVED рынок с resolvedOutcomeIndex', () => {
    const result = makeActiveMarket();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const snapshot = MarketViewModel.toSnapshot(result.value.close(NOW).resolve(1, NOW));
    expect(snapshot.state).toEqual({ status: 'RESOLVED', resolvedOutcomeIndex: 1 });
  });
});

describe('MarketViewModel.toSnapshot() — round-trip через Market.fromSnapshot()', () => {
  it('round-trip для ACTIVE рынка', () => {
    const result = makeActiveMarket();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Market → snapshot → Market (без MarketParser — snapshot уже доменно-типизирован)
    const snapshot = MarketViewModel.toSnapshot(result.value);
    const restoredResult = Market.fromSnapshot(snapshot);
    expect(restoredResult.ok).toBe(true);
    if (!restoredResult.ok) return;

    expect(restoredResult.value.id).toBe(result.value.id);
    expect(restoredResult.value.slug).toBe(result.value.slug);
    expect(restoredResult.value.question).toBe(result.value.question);
    expect(restoredResult.value.isActive()).toBe(true);
    expect(restoredResult.value.expirationMs).toBe(EXPIRATION_MS);
  });

  it('round-trip для RESOLVED рынка', () => {
    const result = makeActiveMarket();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const resolved = result.value.close(NOW).resolve(0, NOW);
    const snapshot = MarketViewModel.toSnapshot(resolved);
    const restoredResult = Market.fromSnapshot(snapshot);
    expect(restoredResult.ok).toBe(true);
    if (!restoredResult.ok) return;

    expect(restoredResult.value.isResolved()).toBe(true);
    const state = restoredResult.value.state;
    if (state.status === 'RESOLVED') {
      expect(state.resolvedOutcomeIndex).toBe(0);
    }
  });
});

describe('MarketViewModel.toString()', () => {
  it('возвращает строковое представление рынка', () => {
    const result = makeActiveMarket();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const str = MarketViewModel.toString(result.value);
    expect(str).toContain('market-abc');
    expect(str).toContain('ACTIVE');
  });
});

describe('MarketViewModel — нельзя создать экземпляр', () => {
  it('бросает Error при вызове конструктора', () => {
    // @ts-expect-error - testing private constructor
    expect(() => new MarketViewModel()).toThrow(Error);
  });
});
