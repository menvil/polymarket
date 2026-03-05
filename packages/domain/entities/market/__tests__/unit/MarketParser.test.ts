/**
 * Тесты для MarketParser (реконструкция Market из raw данных)
 *
 * @remarks
 * Проверяет:
 * - from() успешно реконструирует Market из валидного snapshot
 * - from() возвращает Err для каждого класса невалидных данных
 * - from() корректно обрабатывает все три статуса (ACTIVE, CLOSED, RESOLVED)
 * - Не регрессирует с MarketParser — бросает ошибки без instantiation
 */

import { describe, it, expect } from '@jest/globals';
import { MarketParser } from '../../src/view/MarketParser.js';
import { MarketValidationError } from '@polymarket/errors/market';

// ==================== Тестовые данные ====================

const EXPIRATION_DATE = new Date(1_700_000_000_000).toISOString();

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

/** Минимально валидный snapshot для ACTIVE рынка */
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

describe('MarketParser.from() — валидные данные', () => {
  it('реконструирует ACTIVE рынок из snapshot', () => {
    const result = MarketParser.from(validActiveSnapshot());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.id).toBe('market-abc');
    expect(result.value.slug).toBe('will-trump-win');
    expect(result.value.question).toBe('Will Trump win?');
    expect(result.value.isActive()).toBe(true);
    expect(result.value.expirationDate.toISOString()).toBe(EXPIRATION_DATE);
  });

  it('реконструирует CLOSED рынок из snapshot', () => {
    const result = MarketParser.from({ ...validActiveSnapshot(), state: { status: 'CLOSED' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.isClosed()).toBe(true);
  });

  it('реконструирует RESOLVED рынок с resolvedOutcomeIndex=0', () => {
    const result = MarketParser.from({
      ...validActiveSnapshot(),
      state: { status: 'RESOLVED', resolvedOutcomeIndex: 0 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.isResolved()).toBe(true);
    const state = result.value.state;
    if (state.status === 'RESOLVED') {
      expect(state.resolvedOutcomeIndex).toBe(0);
    }
  });

  it('реконструирует RESOLVED рынок с resolvedOutcomeIndex=1', () => {
    const result = MarketParser.from({
      ...validActiveSnapshot(),
      state: { status: 'RESOLVED', resolvedOutcomeIndex: 1 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const state = result.value.state;
    if (state.status === 'RESOLVED') {
      expect(state.resolvedOutcomeIndex).toBe(1);
    }
  });

  it('реконструированный рынок не содержит событий (pullEvents = [])', () => {
    const result = MarketParser.from(validActiveSnapshot());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pullNotifications()).toEqual([]);
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
