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
 * - toString()
 */

import { describe, it, expect } from '@jest/globals';
import { Market } from '../../src/Market.js';
import {
  MarketState,
  asMarketId,
  parseMarketSlug,
  parseOutcomeTokenId,
} from '../../src/value-objects/index.js';
import { MarketLifecycleError, MarketValidationError } from '../../src/errors/MarketErrors.js';

// ==================== Хелперы ====================

const EXPIRATION_FUTURE = Date.now() + 86_400_000; // +1 day
const EXPIRATION_PAST = Date.now() - 86_400_000; // -1 day

function makeMarket(overrides: Partial<Parameters<typeof Market.create>[0]> = {}) {
  return Market.create({
    id: asMarketId('market-abc'),
    slug: parseMarketSlug('will-trump-win')!,
    question: 'Will Trump win?',
    outcomeNames: ['Yes', 'No'],
    outcomeTokenIds: [
      parseOutcomeTokenId('token-yes')!,
      parseOutcomeTokenId('token-no')!,
    ],
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

  it('asMarketId бросает Error для пустой строки (защита на уровне branded type)', () => {
    expect(() => asMarketId('')).toThrow(Error);
    expect(() => asMarketId('  ')).toThrow(Error);
  });

  it('возвращает Err при невалидном slug', () => {
    // parseMarketSlug возвращает undefined для 'UPPER', поэтому передаём вручную
    const result = Market.create({
      id: asMarketId('market-abc'),
      // @ts-expect-error - intentionally passing invalid slug for testing
      slug: 'UPPER_CASE',
      question: 'Will Trump win?',
      outcomeNames: ['Yes', 'No'],
      outcomeTokenIds: [parseOutcomeTokenId('token-yes')!, parseOutcomeTokenId('token-no')!],
      expirationMs: EXPIRATION_FUTURE,
      state: MarketState.active(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketValidationError);
      expect(result.error.context?.field).toBe('slug');
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

  it('возвращает Err при пустом outcomeNames[0]', () => {
    const result = makeMarket({ outcomeNames: ['', 'No'] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.field).toBe('outcomeNames[0]');
    }
  });

  it('возвращает Err при пустом outcomeNames[1]', () => {
    const result = makeMarket({ outcomeNames: ['Yes', ''] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.field).toBe('outcomeNames[1]');
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

  it('создаёт outcomes с правильными индексами', () => {
    const result = makeMarket();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.outcomes[0].index).toBe(0);
      expect(result.value.outcomes[1].index).toBe(1);
      expect(result.value.outcomes[0].name).toBe('Yes');
      expect(result.value.outcomes[1].name).toBe('No');
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
      expect(d1).not.toBe(d2); // разные объекты
      expect(d1.getTime()).toBe(d2.getTime()); // одинаковое время
    }
  });
});

describe('Market.isExpiredAt(nowMs)', () => {
  it('возвращает false если nowMs < expirationMs', () => {
    const expirationMs = 1_000_000;
    const result = makeMarket({ expirationMs });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.isExpiredAt(500_000)).toBe(false);
    }
  });

  it('возвращает true если nowMs >= expirationMs', () => {
    const expirationMs = 1_000_000;
    const result = makeMarket({ expirationMs });
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
      // Явно передаём "прошедшее" время — не зависит от системных часов
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
    const activeNotExpired = makeMarket({
      state: MarketState.active(),
      expirationMs: EXPIRATION_FUTURE,
    });
    expect(activeNotExpired.ok).toBe(true);
    if (activeNotExpired.ok) {
      expect(activeNotExpired.value.canTrade()).toBe(true);
    }
  });

  it('canTrade() = false если ACTIVE но истёк', () => {
    const activeExpired = makeMarket({
      state: MarketState.active(),
      expirationMs: EXPIRATION_PAST,
    });
    expect(activeExpired.ok).toBe(true);
    if (activeExpired.ok) {
      expect(activeExpired.value.canTrade()).toBe(false);
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
      expect(original.isActive()).toBe(true); // оригинал не изменился
    }
  });

  it('CLOSED → close(): бросает MarketLifecycleError', () => {
    const result = makeMarket({ state: MarketState.closed() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(() => result.value.close()).toThrow(MarketLifecycleError);
    }
  });

  it('RESOLVED → close(): бросает MarketLifecycleError', () => {
    const result = makeMarket({ state: MarketState.resolved(0) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(() => result.value.close()).toThrow(MarketLifecycleError);
    }
  });

  it('MarketLifecycleError содержит context с marketId и currentStatus', () => {
    const result = makeMarket({ state: MarketState.closed() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      try {
        result.value.close();
        expect(true).toBe(false); // должно бросить
      } catch (e) {
        expect(e).toBeInstanceOf(MarketLifecycleError);
        const err = e as MarketLifecycleError;
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

  it('ACTIVE → resolve(): бросает MarketLifecycleError', () => {
    const result = makeMarket({ state: MarketState.active() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(() => result.value.resolve(0)).toThrow(MarketLifecycleError);
    }
  });

  it('RESOLVED → resolve(): бросает MarketLifecycleError', () => {
    const result = makeMarket({ state: MarketState.resolved(0) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(() => result.value.resolve(1)).toThrow(MarketLifecycleError);
    }
  });

  it('MarketLifecycleError для resolve() из ACTIVE содержит "Call close() first"', () => {
    const result = makeMarket({ state: MarketState.active() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      try {
        result.value.resolve(0);
        expect(true).toBe(false);
      } catch (e) {
        expect(e).toBeInstanceOf(MarketLifecycleError);
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
