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
import { type MarketClosedNotification, type MarketResolvedNotification } from '../../src/MarketNotifications.js';
import {
  MarketState,
  type OutcomeIndex,
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
const NOW = 0;

/** OnChainConditionRef для тестов */
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

// Вспомогательная функция для извлечения значения из Result в тестах
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }, ctx = ''): T {
  if (!result.ok) throw new Error(`Expected Ok result in test setup${ctx ? `: ${ctx}` : ''}`);
  return result.value;
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
        { token: UP_TOKEN, index: 0, name: 'Yes' },
        { token: DOWN_TOKEN, index: 1, name: 'Yes' },
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
        { token: UP_TOKEN, index: 0, name: 'Yes' },
        { token: UP_TOKEN, index: 1, name: 'No' },
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
        { token: UP_TOKEN, index: 0, name: '' },
        { token: DOWN_TOKEN, index: 1, name: 'No' },
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
        { token: UP_TOKEN, index: 0, name: 'Yes' },
        { token: DOWN_TOKEN, index: 1, name: '' },
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

  it('возвращает Err при невалидном state объекте', () => {
    const result = makeMarket({ state: { status: 'INVALID' } as never });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.field).toBe('state');
    }
  });

  it('возвращает Err (не TypeError) для пустого outcomes массива', () => {
    const result = makeMarket({ outcomes: [] as never });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketValidationError);
      expect(result.error.context?.field).toBe('outcomes');
    }
  });

  it('возвращает Err (не TypeError) для outcomes с одним элементом', () => {
    const result = makeMarket({
      outcomes: [{ token: UP_TOKEN, index: 0, name: 'Yes' }] as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketValidationError);
    }
  });

  it('возвращает Err (не TypeError) если outcomes не массив', () => {
    const result = makeMarket({ outcomes: 'not an array' as never });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketValidationError);
    }
  });

  it('возвращает Err для outcomes с 3 элементами (только 2 допустимо)', () => {
    const result = makeMarket({
      outcomes: [
        { token: UP_TOKEN, index: 0, name: 'Yes' },
        { token: DOWN_TOKEN, index: 1, name: 'No' },
        { token: UP_TOKEN, index: 2, name: 'Maybe' },
      ] as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketValidationError);
      expect(result.error.context?.field).toBe('outcomes');
    }
  });

  it('возвращает Err для state: null', () => {
    const result = makeMarket({ state: null as never });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.field).toBe('state');
    }
  });

  it('возвращает Err для RESOLVED без resolvedOutcomeIndex (runtime защита от as-кастов)', () => {
    // TypeScript не поймает это статически, но runtime проверка защитит
    const result = makeMarket({ state: { status: 'RESOLVED' } as never });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketValidationError);
      expect(result.error.context?.field).toBe('state.resolvedOutcomeIndex');
    }
  });

  it('возвращает Err для RESOLVED с resolvedOutcomeIndex=2 (runtime защита)', () => {
    const result = makeMarket({ state: { status: 'RESOLVED', resolvedOutcomeIndex: 2 } as never });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.field).toBe('state.resolvedOutcomeIndex');
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
      const closed = unwrap(result.value.close(NOW));
      expect(closed.isClosed()).toBe(true);
      expect(closed.state.status).toBe('CLOSED');
    }
  });

  it('close() не мутирует исходный Market', () => {
    const result = makeMarket({ state: MarketState.active() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const original = result.value;
      original.close(NOW);
      expect(original.isActive()).toBe(true);
    }
  });

  it('CLOSED → close(): возвращает Err(MarketAlreadyClosedError)', () => {
    const result = makeMarket({ state: MarketState.closed() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const closeResult = result.value.close(NOW);
      expect(closeResult.ok).toBe(false);
      if (!closeResult.ok) {
        expect(closeResult.error).toBeInstanceOf(MarketAlreadyClosedError);
        expect(closeResult.error).toBeInstanceOf(MarketLifecycleError); // подкласс
      }
    }
  });

  it('RESOLVED → close(): возвращает Err(MarketAlreadyResolvedError)', () => {
    const result = makeMarket({ state: MarketState.resolved(0) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const closeResult = result.value.close(NOW);
      expect(closeResult.ok).toBe(false);
      if (!closeResult.ok) {
        expect(closeResult.error).toBeInstanceOf(MarketAlreadyResolvedError);
        expect(closeResult.error).toBeInstanceOf(MarketLifecycleError); // подкласс
      }
    }
  });

  it('MarketAlreadyClosedError содержит context с marketId и currentStatus', () => {
    const result = makeMarket({ state: MarketState.closed() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const closeResult = result.value.close(NOW);
      expect(closeResult.ok).toBe(false);
      if (!closeResult.ok) {
        expect(closeResult.error).toBeInstanceOf(MarketAlreadyClosedError);
        expect(closeResult.error.context?.marketId).toBe('market-abc');
        expect(closeResult.error.context?.currentStatus).toBe('CLOSED');
      }
    }
  });
});

describe('Market.resolve() lifecycle', () => {
  it('CLOSED → RESOLVED(0): возвращает новый Market с resolvedOutcomeIndex=0', () => {
    const result = makeMarket({ state: MarketState.closed() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const resolved = unwrap(result.value.resolve(0, NOW));
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
      const resolved = unwrap(result.value.resolve(1, NOW));
      expect(resolved.isResolved()).toBe(true);
      const state = resolved.state;
      if (state.status === 'RESOLVED') {
        expect(state.resolvedOutcomeIndex).toBe(1);
      }
    }
  });

  it('ACTIVE → resolve(): возвращает Err(MarketInvalidTransitionError)', () => {
    const result = makeMarket({ state: MarketState.active() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const resolveResult = result.value.resolve(0, NOW);
      expect(resolveResult.ok).toBe(false);
      if (!resolveResult.ok) {
        expect(resolveResult.error).toBeInstanceOf(MarketInvalidTransitionError);
        expect(resolveResult.error).toBeInstanceOf(MarketLifecycleError); // подкласс
      }
    }
  });

  it('RESOLVED → resolve(): возвращает Err(MarketAlreadyResolvedError)', () => {
    const result = makeMarket({ state: MarketState.resolved(0) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const resolveResult = result.value.resolve(1, NOW);
      expect(resolveResult.ok).toBe(false);
      if (!resolveResult.ok) {
        expect(resolveResult.error).toBeInstanceOf(MarketAlreadyResolvedError);
        expect(resolveResult.error).toBeInstanceOf(MarketLifecycleError); // подкласс
      }
    }
  });

  it('resolve() возвращает Err(MarketValidationError) при outcomeIndex >= outcomes.length', () => {
    const result = makeMarket({ state: MarketState.closed() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const resolveResult = result.value.resolve(2 as OutcomeIndex, NOW);
      expect(resolveResult.ok).toBe(false);
      if (!resolveResult.ok) {
        expect(resolveResult.error).toBeInstanceOf(MarketValidationError);
      }
    }
  });

  it('resolve() возвращает Err(MarketValidationError) при NaN outcomeIndex', () => {
    const result = makeMarket({ state: MarketState.closed() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const resolveResult = result.value.resolve(NaN as OutcomeIndex, NOW);
      expect(resolveResult.ok).toBe(false);
      if (!resolveResult.ok) {
        expect(resolveResult.error).toBeInstanceOf(MarketValidationError);
      }
    }
  });

  it('resolve() возвращает Err(MarketValidationError) при дробном outcomeIndex (0.5)', () => {
    const result = makeMarket({ state: MarketState.closed() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const resolveResult = result.value.resolve(0.5 as OutcomeIndex, NOW);
      expect(resolveResult.ok).toBe(false);
      if (!resolveResult.ok) {
        expect(resolveResult.error).toBeInstanceOf(MarketValidationError);
      }
    }
  });

  it('resolve() возвращает Err(MarketValidationError) при null outcomeIndex', () => {
    const result = makeMarket({ state: MarketState.closed() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const resolveResult = result.value.resolve(null as unknown as OutcomeIndex, NOW);
      expect(resolveResult.ok).toBe(false);
      if (!resolveResult.ok) {
        expect(resolveResult.error).toBeInstanceOf(MarketValidationError);
      }
    }
  });

  it('resolve() возвращает Err(MarketValidationError) при строковом outcomeIndex', () => {
    const result = makeMarket({ state: MarketState.closed() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const resolveResult = result.value.resolve('0' as unknown as OutcomeIndex, NOW);
      expect(resolveResult.ok).toBe(false);
      if (!resolveResult.ok) {
        expect(resolveResult.error).toBeInstanceOf(MarketValidationError);
      }
    }
  });

  it('MarketInvalidTransitionError для resolve() из ACTIVE содержит "Call close() first"', () => {
    const result = makeMarket({ state: MarketState.active() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const resolveResult = result.value.resolve(0, NOW);
      expect(resolveResult.ok).toBe(false);
      if (!resolveResult.ok) {
        expect(resolveResult.error).toBeInstanceOf(MarketInvalidTransitionError);
        expect(resolveResult.error.message).toContain('Call close() first');
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

    const closed = unwrap(active.close(NOW));
    expect(closed.isClosed()).toBe(true);

    const resolved = unwrap(closed.resolve(0, NOW));
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
      const closed = unwrap(market.close(NOW));
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

describe('Market.pullNotifications()', () => {
  it('create() не эмитирует событий', () => {
    const result = makeMarket();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.pullNotifications()).toEqual([]);
    }
  });

  it('close() эмитирует MarketClosedNotification с корректными полями', () => {
    const result = makeMarket({ state: MarketState.active() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const CLOSE_NOW = 1_700_000_000_000;
    const closed = unwrap(result.value.close(CLOSE_NOW));
    const events = closed.pullNotifications();

    expect(events).toHaveLength(1);
    const event = events[0] as MarketClosedNotification;
    expect(event.type).toBe('MARKET_CLOSED');
    expect(event.marketId).toBe('market-abc');
    expect(event.slug).toBe('will-trump-win');
    expect(event.occurredAt).toBe(CLOSE_NOW);
  });

  it('resolve() эмитирует MarketResolvedNotification с корректными полями', () => {
    const result = makeMarket({ state: MarketState.closed() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const RESOLVE_NOW = 1_700_000_001_000;
    const resolved = unwrap(result.value.resolve(1, RESOLVE_NOW));
    const events = resolved.pullNotifications();

    expect(events).toHaveLength(1);
    const event = events[0] as MarketResolvedNotification;
    expect(event.type).toBe('MARKET_RESOLVED');
    expect(event.marketId).toBe('market-abc');
    expect(event.slug).toBe('will-trump-win');
    expect(event.resolvedOutcomeIndex).toBe(1);
    expect(event.occurredAt).toBe(RESOLVE_NOW);
  });

  it('pullNotifications() очищает буфер — повторный вызов возвращает []', () => {
    const result = makeMarket({ state: MarketState.active() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const closed = unwrap(result.value.close(NOW));
    expect(closed.pullNotifications()).toHaveLength(1);
    expect(closed.pullNotifications()).toHaveLength(0); // буфер очищен
  });

  it('исходный market не накапливает события после close()', () => {
    const result = makeMarket({ state: MarketState.active() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const original = result.value;
    original.close(NOW); // возвращает новый экземпляр, original не меняется
    expect(original.pullNotifications()).toHaveLength(0);
  });

  it('полный цикл: close + resolve — каждый шаг имеет своё событие', () => {
    const result = makeMarket({ state: MarketState.active() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const closed = unwrap(result.value.close(NOW));
    const closeEvents = closed.pullNotifications();
    expect(closeEvents[0].type).toBe('MARKET_CLOSED');

    const resolved = unwrap(closed.resolve(0, NOW));
    const resolveEvents = resolved.pullNotifications();
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
