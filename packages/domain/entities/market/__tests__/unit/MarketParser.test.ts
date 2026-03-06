/**
 * Тесты для MarketParser (валидация raw данных → MarketSnapshot с доменными типами)
 *
 * @remarks
 * Проверяет:
 * - from() возвращает Ok(MarketSnapshot) с доменными типами для валидных данных
 * - from() возвращает Err для каждого класса невалидных данных
 * - from() корректно обрабатывает все три статуса (ACTIVE, CLOSED, RESOLVED)
 * - MarketParser нельзя инстанциировать
 *
 * Тесты для Market.fromSnapshot() — в Market.test.ts (там же проверяется полный pipeline)
 */

import { describe, it, expect } from '@jest/globals';
import { MarketParser } from '../../src/view/MarketParser.js';
import { Market } from '../../src/Market.js';
import { MarketValidationError } from '@polymarket/errors/market';

// ==================== Тестовые данные ====================

const EXPIRATION_MS = 1_700_000_000_000;
const EXPIRATION_DATE = new Date(EXPIRATION_MS).toISOString();

/** Корректный OutcomeTokenJSON для тестов */
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

/** Минимально валидный raw объект для ACTIVE рынка */
function validActiveSnapshot() {
  return {
    id: 'market-abc',
    slug: 'will-trump-win',
    question: 'Will Trump win?',
    outcomes: [
      { token: YES_TOKEN_JSON, index: 0, name: 'Yes' },
      { token: NO_TOKEN_JSON, index: 1, name: 'No' },
    ],
    expirationDate: EXPIRATION_DATE,
    state: { status: 'ACTIVE' },
  };
}

// ==================== Тесты ====================

describe('MarketParser.from() — валидные данные (возвращает MarketSnapshot с доменными типами)', () => {
  it('возвращает Ok(MarketSnapshot) для ACTIVE рынка', () => {
    const result = MarketParser.from(validActiveSnapshot());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.id).toBe('market-abc');
    expect(result.value.slug).toBe('will-trump-win');
    expect(result.value.question).toBe('Will Trump win?');
    expect(result.value.state).toEqual({ status: 'ACTIVE' });
    // expirationMs — число, не ISO строка
    expect(result.value.expirationMs).toBe(EXPIRATION_MS);
    // token — OutcomeToken объект, outcomeKey() — метод
    expect(result.value.outcomes[0].token.outcomeKey()).toBe('UP');
    expect(result.value.outcomes[0].index).toBe(0);
    expect(result.value.outcomes[0].name).toBe('Yes');
    expect(result.value.outcomes[1].token.outcomeKey()).toBe('DOWN');
  });

  it('возвращает Ok(MarketSnapshot) для CLOSED рынка', () => {
    const result = MarketParser.from({ ...validActiveSnapshot(), state: { status: 'CLOSED' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toEqual({ status: 'CLOSED' });
  });

  it('возвращает Ok(MarketSnapshot) для RESOLVED рынка с resolvedOutcomeIndex=0', () => {
    const result = MarketParser.from({
      ...validActiveSnapshot(),
      state: { status: 'RESOLVED', resolvedOutcomeIndex: 0 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toEqual({ status: 'RESOLVED', resolvedOutcomeIndex: 0 });
  });

  it('возвращает Ok(MarketSnapshot) для RESOLVED рынка с resolvedOutcomeIndex=1', () => {
    const result = MarketParser.from({
      ...validActiveSnapshot(),
      state: { status: 'RESOLVED', resolvedOutcomeIndex: 1 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toEqual({ status: 'RESOLVED', resolvedOutcomeIndex: 1 });
  });
});

describe('Market.fromSnapshot() — полный pipeline (MarketParser.from → fromSnapshot)', () => {
  it('реконструирует ACTIVE рынок из snapshot', () => {
    const snapshotResult = MarketParser.from(validActiveSnapshot());
    expect(snapshotResult.ok).toBe(true);
    if (!snapshotResult.ok) return;

    const marketResult = Market.fromSnapshot(snapshotResult.value);
    expect(marketResult.ok).toBe(true);
    if (!marketResult.ok) return;

    expect(marketResult.value.id).toBe('market-abc');
    expect(marketResult.value.slug).toBe('will-trump-win');
    expect(marketResult.value.question).toBe('Will Trump win?');
    expect(marketResult.value.isActive()).toBe(true);
    expect(marketResult.value.expirationDate.toISOString()).toBe(EXPIRATION_DATE);
  });

  it('реконструирует CLOSED рынок из snapshot', () => {
    const snapshotResult = MarketParser.from({
      ...validActiveSnapshot(),
      state: { status: 'CLOSED' },
    });
    expect(snapshotResult.ok).toBe(true);
    if (!snapshotResult.ok) return;

    const marketResult = Market.fromSnapshot(snapshotResult.value);
    expect(marketResult.ok).toBe(true);
    if (!marketResult.ok) return;
    expect(marketResult.value.isClosed()).toBe(true);
  });

  it('реконструирует RESOLVED рынок с resolvedOutcomeIndex=0', () => {
    const snapshotResult = MarketParser.from({
      ...validActiveSnapshot(),
      state: { status: 'RESOLVED', resolvedOutcomeIndex: 0 },
    });
    expect(snapshotResult.ok).toBe(true);
    if (!snapshotResult.ok) return;

    const marketResult = Market.fromSnapshot(snapshotResult.value);
    expect(marketResult.ok).toBe(true);
    if (!marketResult.ok) return;
    expect(marketResult.value.isResolved()).toBe(true);
    const state = marketResult.value.state;
    if (state.status === 'RESOLVED') {
      expect(state.resolvedOutcomeIndex).toBe(0);
    }
  });

  it('реконструированный рынок не содержит уведомлений', () => {
    const snapshotResult = MarketParser.from(validActiveSnapshot());
    expect(snapshotResult.ok).toBe(true);
    if (!snapshotResult.ok) return;

    const marketResult = Market.fromSnapshot(snapshotResult.value);
    expect(marketResult.ok).toBe(true);
    if (!marketResult.ok) return;
    expect(marketResult.value.pullNotifications()).toEqual([]);
  });
});

describe('MarketParser.from() — невалидные данные', () => {
  it('возвращает Err для null', () => {
    const result = MarketParser.from(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketValidationError);
    }
  });

  it('возвращает Err для массива', () => {
    const result = MarketParser.from([]);
    expect(result.ok).toBe(false);
  });

  it('возвращает Err для отсутствующего id (не строка)', () => {
    const { id: _, ...noId } = validActiveSnapshot();
    const result = MarketParser.from(noId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('id');
    }
  });

  it('возвращает Err для пустого id (строка, но пустая)', () => {
    const result = MarketParser.from({ ...validActiveSnapshot(), id: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('id');
    }
  });

  it('возвращает Err для slug не-строки', () => {
    const result = MarketParser.from({ ...validActiveSnapshot(), slug: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.toLowerCase()).toContain('slug');
    }
  });

  it('возвращает Err для невалидного slug', () => {
    const result = MarketParser.from({ ...validActiveSnapshot(), slug: 'INVALID SLUG' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.toLowerCase()).toContain('slug');
    }
  });

  it('возвращает Err для пустого question', () => {
    const result = MarketParser.from({ ...validActiveSnapshot(), question: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.toLowerCase()).toContain('question');
    }
  });

  it('возвращает Err для outcomes не-массива', () => {
    const result = MarketParser.from({ ...validActiveSnapshot(), outcomes: 'bad' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.toLowerCase()).toContain('outcomes');
    }
  });

  it('возвращает Err для outcomes неправильной длины', () => {
    const result = MarketParser.from({
      ...validActiveSnapshot(),
      outcomes: [{ token: YES_TOKEN_JSON, index: 0, name: 'Yes' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.toLowerCase()).toContain('outcomes');
    }
  });

  it('возвращает Err если outcomes[0] не объект', () => {
    const result = MarketParser.from({ ...validActiveSnapshot(), outcomes: [null, { token: NO_TOKEN_JSON, index: 1, name: 'No' }] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.toLowerCase()).toContain('outcomes[0]');
    }
  });

  it('возвращает Err для невалидного outcomes[0].token', () => {
    const snapshot = validActiveSnapshot();
    snapshot.outcomes[0] = { token: { invalid: true } as never, index: 0, name: 'Yes' };
    const result = MarketParser.from(snapshot);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.toLowerCase()).toContain('outcomes[0].token');
    }
  });

  it('возвращает Err для пустого outcomes[0].name', () => {
    const snapshot = validActiveSnapshot();
    snapshot.outcomes[0] = { token: YES_TOKEN_JSON, index: 0, name: '' };
    const result = MarketParser.from(snapshot);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.toLowerCase()).toContain('outcomes[0].name');
    }
  });

  it('возвращает Err если outcomes[1] не объект', () => {
    const result = MarketParser.from({ ...validActiveSnapshot(), outcomes: [{ token: YES_TOKEN_JSON, index: 0, name: 'Yes' }, null] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.toLowerCase()).toContain('outcomes[1]');
    }
  });

  it('возвращает Err для невалидного outcomes[1].token', () => {
    const snapshot = validActiveSnapshot();
    snapshot.outcomes[1] = { token: { invalid: true } as never, index: 1, name: 'No' };
    const result = MarketParser.from(snapshot);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.toLowerCase()).toContain('outcomes[1].token');
    }
  });

  it('возвращает Err для пустого outcomes[1].name', () => {
    const snapshot = validActiveSnapshot();
    snapshot.outcomes[1] = { token: NO_TOKEN_JSON, index: 1, name: '' };
    const result = MarketParser.from(snapshot);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.toLowerCase()).toContain('outcomes[1].name');
    }
  });

  it('возвращает Err для expirationDate не-строки', () => {
    const result = MarketParser.from({ ...validActiveSnapshot(), expirationDate: 12345 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.toLowerCase()).toContain('expirationdate');
    }
  });

  it('возвращает Err для невалидного expirationDate', () => {
    const result = MarketParser.from({ ...validActiveSnapshot(), expirationDate: 'not-a-date' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.toLowerCase()).toContain('expirationdate');
    }
  });

  it('возвращает Err если state не объект', () => {
    const result = MarketParser.from({ ...validActiveSnapshot(), state: null });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.toLowerCase()).toContain('state');
    }
  });

  it('возвращает Err для невалидного state.status', () => {
    const result = MarketParser.from({
      ...validActiveSnapshot(),
      state: { status: 'PENDING' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.toLowerCase()).toContain('status');
    }
  });

  it('возвращает Err для RESOLVED без resolvedOutcomeIndex', () => {
    const result = MarketParser.from({
      ...validActiveSnapshot(),
      state: { status: 'RESOLVED' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message.toLowerCase()).toContain('resolvedoutcomeindex');
    }
  });
});

describe('MarketParser — нельзя создать экземпляр', () => {
  it('бросает Error при вызове конструктора', () => {
    // @ts-expect-error - testing private constructor
    expect(() => new MarketParser()).toThrow(Error);
  });
});
