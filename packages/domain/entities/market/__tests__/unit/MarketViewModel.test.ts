/**
 * Тесты для MarketViewModel (toJSON, fromJSON, getMarketUrl)
 *
 * @remarks
 * Проверяет:
 * - getMarketUrl() строит корректный URL
 * - toJSON() сериализует Market в корректный JSON
 * - fromJSON() десериализует JSON обратно в Market (round-trip)
 * - fromJSON() корректно обрабатывает невалидные данные
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
import { MarketValidationError } from '@polymarket/errors/market';

// ==================== Тестовые данные ====================

const EXPIRATION_MS = 1_700_000_000_000;

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

/** Корректный OutcomeTokenJSON для использования в fromJSON тестах */
const YES_TOKEN_JSON = {
  conditionRef: {
    kind: 'ONCHAIN' as const,
    protocolId: 'POLYMARKET_CTF',
    chainId: 137,
    conditionId: '0x' + 'ab'.repeat(32),
  },
  outcomeKey: 'UP',
};

const NO_TOKEN_JSON = {
  ...YES_TOKEN_JSON,
  outcomeKey: 'DOWN',
};

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

describe('MarketViewModel.toJSON()', () => {
  it('сериализует ACTIVE рынок корректно', () => {
    const result = makeActiveMarket();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const json = MarketViewModel.toJSON(result.value);
    expect(json.id).toBe('market-abc');
    expect(json.slug).toBe('will-trump-win');
    expect(json.question).toBe('Will Trump win?');
    expect(json.outcomes[0].token.outcomeKey).toBe('UP');
    expect(json.outcomes[0].index).toBe(0);
    expect(json.outcomes[0].name).toBe('Yes');
    expect(json.outcomes[1].token.outcomeKey).toBe('DOWN');
    expect(json.outcomes[1].index).toBe(1);
    expect(json.outcomes[1].name).toBe('No');
    expect(json.expirationDate).toBe(new Date(EXPIRATION_MS).toISOString());
    expect(json.state).toEqual({ status: 'ACTIVE' });
  });

  it('сериализует CLOSED рынок корректно', () => {
    const result = makeActiveMarket();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const closed = result.value.close();
    const json = MarketViewModel.toJSON(closed);
    expect(json.state).toEqual({ status: 'CLOSED' });
  });

  it('сериализует RESOLVED рынок с resolvedOutcomeIndex', () => {
    const result = makeActiveMarket();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const resolved = result.value.close().resolve(1);
    const json = MarketViewModel.toJSON(resolved);
    expect(json.state).toEqual({ status: 'RESOLVED', resolvedOutcomeIndex: 1 });
  });
});

describe('MarketViewModel.fromJSON() — round-trip', () => {
  it('round-trip для ACTIVE рынка', () => {
    const result = makeActiveMarket();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const json = MarketViewModel.toJSON(result.value);
    const restored = MarketViewModel.fromJSON(json);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;

    expect(restored.value.id).toBe(result.value.id);
    expect(restored.value.slug).toBe(result.value.slug);
    expect(restored.value.question).toBe(result.value.question);
    expect(restored.value.isActive()).toBe(true);
    expect(restored.value.expirationDate.toISOString()).toBe(
      result.value.expirationDate.toISOString()
    );
  });

  it('round-trip для RESOLVED рынка', () => {
    const result = makeActiveMarket();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const resolved = result.value.close().resolve(0);
    const json = MarketViewModel.toJSON(resolved);
    const restored = MarketViewModel.fromJSON(json);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;

    expect(restored.value.isResolved()).toBe(true);
    const state = restored.value.state;
    if (state.status === 'RESOLVED') {
      expect(state.resolvedOutcomeIndex).toBe(0);
    }
  });
});

describe('MarketViewModel.fromJSON() — невалидные данные', () => {
  it('возвращает Err для null', () => {
    const result = MarketViewModel.fromJSON(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketValidationError);
    }
  });

  it('возвращает Err для массива', () => {
    const result = MarketViewModel.fromJSON([]);
    expect(result.ok).toBe(false);
  });

  it('возвращает Err для отсутствующего id', () => {
    const result = MarketViewModel.fromJSON({ slug: 'test', question: 'q' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('id');
    }
  });

  it('возвращает Err для невалидного slug', () => {
    const result = MarketViewModel.fromJSON({
      id: 'market-abc',
      slug: 'INVALID SLUG',
      question: 'Will Trump win?',
      outcomes: [
        { token: YES_TOKEN_JSON, index: 0, name: 'Yes' },
        { token: NO_TOKEN_JSON, index: 1, name: 'No' },
      ],
      expirationDate: new Date(EXPIRATION_MS).toISOString(),
      state: { status: 'ACTIVE' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.toLowerCase()).toContain('slug');
    }
  });

  it('возвращает Err для невалидного outcomes[0].token', () => {
    const result = MarketViewModel.fromJSON({
      id: 'market-abc',
      slug: 'will-trump-win',
      question: 'Will Trump win?',
      outcomes: [
        { token: { invalid: true }, index: 0, name: 'Yes' },
        { token: NO_TOKEN_JSON, index: 1, name: 'No' },
      ],
      expirationDate: new Date(EXPIRATION_MS).toISOString(),
      state: { status: 'ACTIVE' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.toLowerCase()).toContain('outcomes[0].token');
    }
  });

  it('возвращает Err для невалидного expirationDate', () => {
    const result = MarketViewModel.fromJSON({
      id: 'market-abc',
      slug: 'will-trump-win',
      question: 'Will Trump win?',
      outcomes: [
        { token: YES_TOKEN_JSON, index: 0, name: 'Yes' },
        { token: NO_TOKEN_JSON, index: 1, name: 'No' },
      ],
      expirationDate: 'not-a-date',
      state: { status: 'ACTIVE' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.toLowerCase()).toContain('expirationdate');
    }
  });

  it('возвращает Err для невалидного state.status', () => {
    const result = MarketViewModel.fromJSON({
      id: 'market-abc',
      slug: 'will-trump-win',
      question: 'Will Trump win?',
      outcomes: [
        { token: YES_TOKEN_JSON, index: 0, name: 'Yes' },
        { token: NO_TOKEN_JSON, index: 1, name: 'No' },
      ],
      expirationDate: new Date(EXPIRATION_MS).toISOString(),
      state: { status: 'PENDING' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.toLowerCase()).toContain('status');
    }
  });

  it('возвращает Err для RESOLVED без resolvedOutcomeIndex', () => {
    const result = MarketViewModel.fromJSON({
      id: 'market-abc',
      slug: 'will-trump-win',
      question: 'Will Trump win?',
      outcomes: [
        { token: YES_TOKEN_JSON, index: 0, name: 'Yes' },
        { token: NO_TOKEN_JSON, index: 1, name: 'No' },
      ],
      expirationDate: new Date(EXPIRATION_MS).toISOString(),
      state: { status: 'RESOLVED' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.toLowerCase()).toContain('resolvedoutcomeindex');
    }
  });
});

describe('MarketViewModel — нельзя создать экземпляр', () => {
  it('бросает Error при вызове конструктора', () => {
    // @ts-expect-error - testing private constructor
    expect(() => new MarketViewModel()).toThrow(Error);
  });
});
