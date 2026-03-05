/**
 * Тесты для Market entity
 *
 * @remarks
 * Проверяет:
 * - create() с валидными/невалидными данными
 * - expirationDate иммутабельность
 * - isExpiredAt(nowMs) детерминизм
 * - lifecycle: close(), resolve() с lifecycle guards
 * - predicates: isActive, isClosed, isResolved, canTrade
 * - equals(), toString()
 */

import { describe, it, expect } from '@jest/globals';
import { Market, type Outcome } from '../../src/Market.js';
import { type MarketClosedEvent, type MarketResolvedEvent } from '../../src/MarketEvents.js';
import {
  MarketState,
  asMarketId,
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
import {
  MarketLifecycleError,
  MarketValidationError,
  MarketAlreadyClosedError,
  MarketAlreadyResolvedError,
  MarketInvalidTransitionError,
} from '@polymarket/errors/market';

// ==================== Тестовые данные ====================

const EXPIRATION_FUTURE = Date.now() + 86_400_000;
const EXPIRATION_PAST = Date.now() - 86_400_000;

/** OnChainConditionRef для тестов */
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

function makeMarket(overrides: Partial<Parameters<typeof Market.create>[0]> = {}) {
  return Market.create({
    id: unsafeMarketId('market-abc'),
    slug: parseMarketSlug('will-trump-win')!,
    question: 'Will Trump win?',
    outcomes: TEST_OUTCOMES,
    expirationMs: EXPIRATION_FUTURE,
    state: MarketState.active(),
    ...overrides,
  });
}

// ==================== Тесты ====================

describe('Market.create()', () => {
  it('создаёт Market с валидными данными', () => {
    const result = makeMarket();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe('market-abc');
      expect(result.value.slug).toBe('will-trump-win');
      expect(result.value.question).toBe('Will Trump win?');
    }
  });

  it('asMarketId возвращает undefined для невалидных строк', () => {
    expect(asMarketId('')).toBeUndefined();
    expect(asMarketId('  ')).toBeUndefined();
    expect(asMarketId('valid-id')).toBeDefined();
  });

  it('возвращает Err при одинаковых outcomeNames', () => {
    const result = makeMarket({
      outcomes: [
        { token: YES_TOKEN, index: 0, name: 'Yes' },
        { token: NO_TOKEN, index: 1, name: 'Yes' },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketValidationError);
      expect(result.error.context?.field).toBe('outcomes');
    }
  });

  it('возвращает Err при одинаковых outcomeTokens', () => {
    const result = makeMarket({
      outcomes: [
        { token: YES_TOKEN, index: 0, name: 'Yes' },
        { token: YES_TOKEN, index: 1, name: 'No' },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketValidationError);
      expect(result.error.context?.field).toBe('outcomes');
    }
  });

  it('возвращает Err при пустом question', () => {
    const result = makeMarket({ question: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketValidationError);
      expect(result.error.context?.field).toBe('question');
    }
  });

  it('возвращает Err при пустом outcomes[0].name', () => {
    const result = makeMarket({
      outcomes: [
        { token: YES_TOKEN, index: 0, name: '' },
        { token: NO_TOKEN, index: 1, name: 'No' },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.field).toBe('outcomes[0].name');
    }
  });

  it('возвращает Err при пустом outcomes[1].name', () => {
    const result = makeMarket({
      outcomes: [
        { token: YES_TOKEN, index: 0, name: 'Yes' },
        { token: NO_TOKEN, index: 1, name: '' },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.field).toBe('outcomes[1].name');
    }
  });

  it('возвращает Err при Infinity expirationMs', () => {
    const result = makeMarket({ expirationMs: Infinity });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.field).toBe('expirationMs');
    }
  });

  it('возвращает Err при NaN expirationMs', () => {
    const result = makeMarket({ expirationMs: NaN });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.field).toBe('expirationMs');
    }
  });

  it('создаёт outcomes с правильными индексами и token', () => {
    const result = makeMarket();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.outcomes[0].index).toBe(0);
      expect(result.value.outcomes[1].index).toBe(1);
      expect(result.value.outcomes[0].name).toBe('Yes');
      expect(result.value.outcomes[1].name).toBe('No');
      expect(result.value.outcomes[0].token.outcomeKey()).toBe(BinaryOutcome.UP);
      expect(result.value.outcomes[1].token.outcomeKey()).toBe(BinaryOutcome.DOWN);
    }
  });
});

describe('Market.expirationDate (иммутабельность)', () => {
  it('возвращает новый Date объект при каждом вызове', () => {
    const result = makeMarket();
    expect(result.ok).toBe(true);
    if (result.ok) {
      const d1 = result.value.expirationDate;
      const d2 = result.value.expirationDate;
      expect(d1).not.toBe(d2);
      expect(d1.getTime()).toBe(d2.getTime());
    }
  });
});

describe('Market.isExpiredAt(nowMs)', () => {
  it('возвращает false если nowMs < expirationMs', () => {
    const result = makeMarket({ expirationMs: 1_000_000 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.isExpiredAt(500_000)).toBe(false);
    }
  });

  it('возвращает true если nowMs >= expirationMs', () => {
    const result = makeMarket({ expirationMs: 1_000_000 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.isExpiredAt(1_000_000)).toBe(true);
      expect(result.value.isExpiredAt(2_000_000)).toBe(true);
    }
  });

  it('не использует Date.now() (детерминизм)', () => {
    const result = makeMarket({ expirationMs: EXPIRATION_PAST });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.isExpiredAt(EXPIRATION_PAST + 1)).toBe(true);
      expect(result.value.isExpiredAt(0)).toBe(false);
    }
  });
});

describe('Market.timeToExpiryAt(nowMs)', () => {
  it('возвращает положительное число до истечения', () => {
    const result = makeMarket({ expirationMs: 1_000_000 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.timeToExpiryAt(0)).toBe(1_000_000);
    }
  });

  it('возвращает отрицательное число после истечения', () => {
    const result = makeMarket({ expirationMs: 1_000_000 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.timeToExpiryAt(2_000_000)).toBe(-1_000_000);
    }
  });
});

describe('Market predicates', () => {
  it('isActive() = true для ACTIVE', () => {
    const result = makeMarket({ state: MarketState.active() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.isActive()).toBe(true);
      expect(result.value.isClosed()).toBe(false);
      expect(result.value.isResolved()).toBe(false);
    }
  });

  it('isClosed() = true для CLOSED', () => {
    const result = makeMarket({ state: MarketState.closed() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.isClosed()).toBe(true);
      expect(result.value.isActive()).toBe(false);
      expect(result.value.isResolved()).toBe(false);
    }
  });

  it('isResolved() = true для RESOLVED', () => {
    const result = makeMarket({ state: MarketState.resolved(0) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.isResolved()).toBe(true);
      expect(result.value.isActive()).toBe(false);
      expect(result.value.isClosed()).toBe(false);
    }
  });

  it('canTrade() = true только если ACTIVE и не истёк', () => {
    const result = makeMarket({ state: MarketState.active(), expirationMs: EXPIRATION_FUTURE });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.canTrade()).toBe(true);
    }
  });

  it('canTrade() = false если ACTIVE но истёк', () => {
    const result = makeMarket({ state: MarketState.active(), expirationMs: EXPIRATION_PAST });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.canTrade()).toBe(false);
    }
  });

  it('canTrade() = false для CLOSED', () => {
    const result = makeMarket({ state: MarketState.closed() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.canTrade()).toBe(false);
    }
  });

  it('backward-compat getter status возвращает текущий статус', () => {
    const result = makeMarket({ state: MarketState.active() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('ACTIVE');
    }
  });
});

describe('Market.close() lifecycle', () => {
  it('ACTIVE → CLOSED: возвращает новый Market', () => {
    const result = makeMarket({ state: MarketState.active() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const closed = result.value.close();
      expect(closed.isClosed()).toBe(true);
      expect(closed.state.status).toBe('CLOSED');
    }
  });

  it('close() не мутирует исходный Market', () => {
    const result = makeMarket({ state: MarketState.active() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const original = result.value;
      original.close();
      expect(original.isActive()).toBe(true);
    }
  });

  it('CLOSED → close(): бросает MarketAlreadyClosedError', () => {
    const result = makeMarket({ state: MarketState.closed() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(() => result.value.close()).toThrow(MarketAlreadyClosedError);
      expect(() => result.value.close()).toThrow(MarketLifecycleError); // подкласс
    }
  });

  it('RESOLVED → close(): бросает MarketAlreadyResolvedError', () => {
    const result = makeMarket({ state: MarketState.resolved(0) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(() => result.value.close()).toThrow(MarketAlreadyResolvedError);
      expect(() => result.value.close()).toThrow(MarketLifecycleError); // подкласс
    }
  });

  it('MarketAlreadyClosedError содержит context с marketId и currentStatus', () => {
    const result = makeMarket({ state: MarketState.closed() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      try {
        result.value.close();
        expect(true).toBe(false);
      } catch (e) {
        expect(e).toBeInstanceOf(MarketAlreadyClosedError);
        const err = e as MarketAlreadyClosedError;
        expect(err.context?.marketId).toBe('market-abc');
        expect(err.context?.currentStatus).toBe('CLOSED');
      }
    }
  });
});

describe('Market.resolve() lifecycle', () => {
  it('CLOSED → RESOLVED(0): возвращает новый Market с resolvedOutcomeIndex=0', () => {
    const result = makeMarket({ state: MarketState.closed() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const resolved = result.value.resolve(0);
      expect(resolved.isResolved()).toBe(true);
      const state = resolved.state;
      if (state.status === 'RESOLVED') {
        expect(state.resolvedOutcomeIndex).toBe(0);
      }
    }
  });

  it('CLOSED → RESOLVED(1): возвращает новый Market с resolvedOutcomeIndex=1', () => {
    const result = makeMarket({ state: MarketState.closed() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const resolved = result.value.resolve(1);
      expect(resolved.isResolved()).toBe(true);
      const state = resolved.state;
      if (state.status === 'RESOLVED') {
        expect(state.resolvedOutcomeIndex).toBe(1);
      }
    }
  });

  it('ACTIVE → resolve(): бросает MarketInvalidTransitionError', () => {
    const result = makeMarket({ state: MarketState.active() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(() => result.value.resolve(0)).toThrow(MarketInvalidTransitionError);
      expect(() => result.value.resolve(0)).toThrow(MarketLifecycleError); // подкласс
    }
  });

  it('RESOLVED → resolve(): бросает MarketAlreadyResolvedError', () => {
    const result = makeMarket({ state: MarketState.resolved(0) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(() => result.value.resolve(1)).toThrow(MarketAlreadyResolvedError);
      expect(() => result.value.resolve(1)).toThrow(MarketLifecycleError); // подкласс
    }
  });

  it('MarketInvalidTransitionError для resolve() из ACTIVE содержит "Call close() first"', () => {
    const result = makeMarket({ state: MarketState.active() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      try {
        result.value.resolve(0);
        expect(true).toBe(false);
      } catch (e) {
        expect(e).toBeInstanceOf(MarketInvalidTransitionError);
        expect((e as Error).message).toContain('Call close() first');
      }
    }
  });
});

describe('Market полный lifecycle ACTIVE → CLOSED → RESOLVED', () => {
  it('корректный цикл: create → close → resolve', () => {
    const result = makeMarket();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const active = result.value;
    expect(active.isActive()).toBe(true);

    const closed = active.close();
    expect(closed.isClosed()).toBe(true);

    const resolved = closed.resolve(0);
    expect(resolved.isResolved()).toBe(true);
    const state = resolved.state;
    if (state.status === 'RESOLVED') {
      expect(state.resolvedOutcomeIndex).toBe(0);
    }
  });
});

describe('Market.equals()', () => {
  it('возвращает true для рынков с одинаковым id', () => {
    const r1 = makeMarket();
    const r2 = makeMarket();
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.value.equals(r2.value)).toBe(true);
    }
  });

  it('возвращает true после перехода состояния (тот же рынок, другой объект)', () => {
    const result = makeMarket();
    expect(result.ok).toBe(true);
    if (result.ok) {
      const market = result.value;
      const closed = market.close();
      expect(market.equals(closed)).toBe(true);
    }
  });

  it('возвращает false для рынков с разными id', () => {
    const r1 = makeMarket({ id: unsafeMarketId('market-aaa') });
    const r2 = makeMarket({ id: unsafeMarketId('market-bbb') });
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.value.equals(r2.value)).toBe(false);
    }
  });
});

describe('Market.pullEvents()', () => {
  it('create() не эмитирует событий', () => {
    const result = makeMarket();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.pullEvents()).toEqual([]);
    }
  });

  it('close() эмитирует MarketClosedEvent', () => {
    const result = makeMarket({ state: MarketState.active() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const closed = result.value.close();
    const events = closed.pullEvents();

    expect(events).toHaveLength(1);
    const event = events[0] as MarketClosedEvent;
    expect(event.type).toBe('MARKET_CLOSED');
    expect(event.marketId).toBe('market-abc');
    expect(event.slug).toBe('will-trump-win');
    expect(typeof event.occurredAt).toBe('number');
  });

  it('resolve() эмитирует MarketResolvedEvent с корректным resolvedOutcomeIndex', () => {
    const result = makeMarket({ state: MarketState.closed() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const resolved = result.value.resolve(1);
    const events = resolved.pullEvents();

    expect(events).toHaveLength(1);
    const event = events[0] as MarketResolvedEvent;
    expect(event.type).toBe('MARKET_RESOLVED');
    expect(event.marketId).toBe('market-abc');
    expect(event.slug).toBe('will-trump-win');
    expect(event.resolvedOutcomeIndex).toBe(1);
    expect(typeof event.occurredAt).toBe('number');
  });

  it('pullEvents() очищает буфер — повторный вызов возвращает []', () => {
    const result = makeMarket({ state: MarketState.active() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const closed = result.value.close();
    expect(closed.pullEvents()).toHaveLength(1);
    expect(closed.pullEvents()).toHaveLength(0); // буфер очищен
  });

  it('исходный market не накапливает события после close()', () => {
    const result = makeMarket({ state: MarketState.active() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const original = result.value;
    original.close(); // возвращает новый экземпляр, original не меняется
    expect(original.pullEvents()).toHaveLength(0);
  });

  it('полный цикл: close + resolve — каждый шаг имеет своё событие', () => {
    const result = makeMarket({ state: MarketState.active() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const closed = result.value.close();
    const closeEvents = closed.pullEvents();
    expect(closeEvents[0].type).toBe('MARKET_CLOSED');

    const resolved = closed.resolve(0);
    const resolveEvents = resolved.pullEvents();
    expect(resolveEvents[0].type).toBe('MARKET_RESOLVED');
  });
});

describe('Market.toString()', () => {
  it('возвращает строку с id, статусом и вопросом', () => {
    const result = makeMarket();
    expect(result.ok).toBe(true);
    if (result.ok) {
      const str = result.value.toString();
      expect(str).toContain('market-abc');
      expect(str).toContain('ACTIVE');
      expect(str).toContain('Will Trump win?');
    }
  });
});
