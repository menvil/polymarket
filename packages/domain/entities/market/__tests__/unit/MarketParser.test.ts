/**
 * Тесты MarketParser — разбор сериализованного канонического рынка
 *
 * @remarks
 * Парсер принимает `unknown` и обязан на любом мусоре возвращать `Err`,
 * а не бросать. Доменные инварианты (различимость исходов, `startsAt < expiresAt`)
 * здесь не проверяются — за них отвечает `Market.create()`, и это проверено
 * отдельным тестом «граница ответственности».
 */

import { describe, it, expect } from '@jest/globals';
import { Market, MarketParser, MarketValidationError, MarketViewModel } from '../../src/index.js';
import { makeMarket, unwrap } from './fixtures.js';

/** Валидная сериализованная форма модельного рынка */
function validJSON(): Record<string, unknown> {
  return MarketViewModel.toJSON(makeMarket()) as unknown as Record<string, unknown>;
}

describe('MarketParser.from() — валидные данные', () => {
  it('разбирает сериализованный рынок в доменно-типизированный снапшот', () => {
    const snapshot = unwrap(MarketParser.from(validJSON()));

    expect(snapshot.id).toBe('btc-up-down-1200');
    expect(snapshot.venueId).toBe('POLYMARKET');
    expect(snapshot.slug).toBe('bitcoin-up-or-down-september-1-12pm-et');
    expect(snapshot.family).toBe('CRYPTO_UP_DOWN');
    expect(snapshot.startsAt.toISO()).toBe('2026-09-01T12:00:00.000Z');
    expect(snapshot.expiresAt.toISO()).toBe('2026-09-01T12:05:00.000Z');
    expect(snapshot.state).toEqual({ status: 'ACTIVE' });
    expect(snapshot.crypto).toEqual({ asset: 'btc', duration: 300_000 });
  });

  it('разбирает исходы с canonical InstrumentId', () => {
    const snapshot = unwrap(MarketParser.from(validJSON()));

    expect(snapshot.outcomes[0]).toEqual({ index: 0, label: 'Up', instrumentId: '71476031705491' });
    expect(snapshot.outcomes[1]).toEqual({ index: 1, label: 'Down', instrumentId: '22993088410122' });
  });

  it('обрезает пробелы в question и метках исходов', () => {
    const snapshot = unwrap(MarketParser.from({
      ...validJSON(),
      question: '  Bitcoin Up or Down?  ',
      outcomes: [
        { index: 0, label: '  Up ', instrumentId: '71476031705491' },
        { index: 1, label: ' Down  ', instrumentId: '22993088410122' },
      ],
    }));

    expect(snapshot.question).toBe('Bitcoin Up or Down?');
    expect(snapshot.outcomes[0].label).toBe('Up');
    expect(snapshot.outcomes[1].label).toBe('Down');
  });

  it('принимает рынок без slug', () => {
    const { slug: _slug, ...withoutSlug } = validJSON();
    const snapshot = unwrap(MarketParser.from(withoutSlug));

    expect(snapshot.slug).toBeUndefined();
    expect('slug' in snapshot).toBe(false);
  });

  it('разбирает состояние CLOSED', () => {
    const snapshot = unwrap(MarketParser.from({ ...validJSON(), state: { status: 'CLOSED' } }));

    expect(snapshot.state).toEqual({ status: 'CLOSED' });
  });

  it('разбирает состояние RESOLVED вместе с индексом победителя', () => {
    const snapshot = unwrap(MarketParser.from({
      ...validJSON(),
      state: { status: 'RESOLVED', resolvedOutcomeIndex: 1 },
    }));

    expect(snapshot.state).toEqual({ status: 'RESOLVED', resolvedOutcomeIndex: 1 });
  });
});

describe('MarketParser.from() — структура входа', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['строка', 'not an object'],
    ['число', 42],
    ['массив', []],
  ])('отклоняет %s', (_label, raw) => {
    const result = MarketParser.from(raw);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketValidationError);
    }
  });
});

describe('MarketParser.from() — identity', () => {
  it('отклоняет нестроковый id', () => {
    const result = MarketParser.from({ ...validJSON(), id: 123 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context?.field).toBe('id');
  });

  it('отклоняет пустой id', () => {
    const result = MarketParser.from({ ...validJSON(), id: '   ' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context?.field).toBe('id');
  });

  it('отклоняет нестроковый venueId', () => {
    const result = MarketParser.from({ ...validJSON(), venueId: null });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context?.field).toBe('venueId');
  });

  it('отклоняет venueId в неверном формате', () => {
    const result = MarketParser.from({ ...validJSON(), venueId: 'poly-market' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context?.field).toBe('venueId');
  });

  it('отклоняет slug в неверном формате', () => {
    const result = MarketParser.from({ ...validJSON(), slug: 'UPPER_CASE' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context?.field).toBe('slug');
  });

  it('отклоняет нестроковый slug', () => {
    const result = MarketParser.from({ ...validJSON(), slug: 42 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context?.field).toBe('slug');
  });

  it('отклоняет пустой question', () => {
    const result = MarketParser.from({ ...validJSON(), question: '  ' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context?.field).toBe('question');
  });
});

describe('MarketParser.from() — расписание', () => {
  it('отклоняет startsAt не-числом', () => {
    const result = MarketParser.from({ ...validJSON(), startsAt: '2026-09-01T12:00:00.000Z' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context?.field).toBe('startsAt');
  });

  it('отклоняет отсутствующий expiresAt', () => {
    const { expiresAt: _expiresAt, ...withoutExpiry } = validJSON();
    const result = MarketParser.from(withoutExpiry);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context?.field).toBe('expiresAt');
  });

  it('отклоняет отрицательный timestamp', () => {
    const result = MarketParser.from({ ...validJSON(), startsAt: -1 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context?.field).toBe('startsAt');
  });

  it('обрезает дробный timestamp — канонический контракт TimestampService', () => {
    const result = MarketParser.from({ ...validJSON(), expiresAt: 1_772_366_700_000.5 });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.expiresAt.toNumber()).toBe(1_772_366_700_000);
  });

  it('отклоняет NaN timestamp', () => {
    const result = MarketParser.from({ ...validJSON(), startsAt: NaN });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context?.field).toBe('startsAt');
  });
});

describe('MarketParser.from() — исходы', () => {
  it('отклоняет outcomes не-массивом', () => {
    const result = MarketParser.from({ ...validJSON(), outcomes: {} });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context?.field).toBe('outcomes');
  });

  it('отклоняет массив не из двух исходов', () => {
    const result = MarketParser.from({
      ...validJSON(),
      outcomes: [{ index: 0, label: 'Up', instrumentId: '714' }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context?.field).toBe('outcomes');
  });

  it('отклоняет исход, не являющийся объектом', () => {
    const result = MarketParser.from({
      ...validJSON(),
      outcomes: ['up', { index: 1, label: 'Down', instrumentId: '229' }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context?.field).toBe('outcomes[0]');
  });

  it('отклоняет исход с индексом не по позиции', () => {
    const result = MarketParser.from({
      ...validJSON(),
      outcomes: [
        { index: 1, label: 'Up', instrumentId: '714' },
        { index: 1, label: 'Down', instrumentId: '229' },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context?.field).toBe('outcomes[0].index');
  });

  it('отклоняет пустую метку исхода', () => {
    const result = MarketParser.from({
      ...validJSON(),
      outcomes: [
        { index: 0, label: 'Up', instrumentId: '714' },
        { index: 1, label: '   ', instrumentId: '229' },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context?.field).toBe('outcomes[1].label');
  });

  it('отклоняет нестроковый instrumentId', () => {
    const result = MarketParser.from({
      ...validJSON(),
      outcomes: [
        { index: 0, label: 'Up', instrumentId: 714 },
        { index: 1, label: 'Down', instrumentId: '229' },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context?.field).toBe('outcomes[0].instrumentId');
  });

  it('отклоняет instrumentId, не проходящий валидацию VO', () => {
    const result = MarketParser.from({
      ...validJSON(),
      outcomes: [
        { index: 0, label: 'Up', instrumentId: '714' },
        { index: 1, label: 'Down', instrumentId: '' },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context?.field).toBe('outcomes[1].instrumentId');
  });
});

describe('MarketParser.from() — состояние', () => {
  it('отклоняет state не-объектом', () => {
    const result = MarketParser.from({ ...validJSON(), state: 'ACTIVE' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context?.field).toBe('state');
  });

  it('отклоняет неизвестный статус', () => {
    const result = MarketParser.from({ ...validJSON(), state: { status: 'UPCOMING' } });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context?.field).toBe('state.status');
  });

  it('отклоняет RESOLVED без индекса победителя', () => {
    const result = MarketParser.from({ ...validJSON(), state: { status: 'RESOLVED' } });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context?.field).toBe('state.resolvedOutcomeIndex');
  });

  it('отклоняет RESOLVED с индексом вне диапазона', () => {
    const result = MarketParser.from({
      ...validJSON(),
      state: { status: 'RESOLVED', resolvedOutcomeIndex: 2 },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context?.field).toBe('state.resolvedOutcomeIndex');
  });
});

describe('MarketParser.from() — семейство и спецификация', () => {
  it('отклоняет неизвестное семейство', () => {
    const result = MarketParser.from({ ...validJSON(), family: 'SPORTS' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context?.field).toBe('family');
  });

  it('отклоняет CRYPTO_UP_DOWN без crypto-спецификации', () => {
    const { crypto: _crypto, ...withoutCrypto } = validJSON();
    const result = MarketParser.from(withoutCrypto);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context?.field).toBe('crypto');
  });

  it('отклоняет нестроковый crypto.asset', () => {
    const result = MarketParser.from({ ...validJSON(), crypto: { asset: 1, duration: 300_000 } });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context?.field).toBe('crypto.asset');
  });

  it('отклоняет пустой crypto.asset', () => {
    const result = MarketParser.from({ ...validJSON(), crypto: { asset: '  ', duration: 300_000 } });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context?.field).toBe('crypto.asset');
  });

  it('отклоняет нечисловую crypto.duration', () => {
    const result = MarketParser.from({ ...validJSON(), crypto: { asset: 'btc', duration: '5m' } });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context?.field).toBe('crypto.duration');
  });

  it('отклоняет неположительную crypto.duration', () => {
    const result = MarketParser.from({ ...validJSON(), crypto: { asset: 'btc', duration: -1 } });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.context?.field).toBe('crypto.duration');
  });
});

describe('MarketParser — граница ответственности с Market.create()', () => {
  it('пропускает доменное нарушение (startsAt >= expiresAt) — его ловит create()', () => {
    const json = validJSON();
    const swapped = { ...json, startsAt: json.expiresAt, expiresAt: json.startsAt };

    const snapshot = MarketParser.from(swapped);
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;

    const market = Market.fromSnapshot(snapshot.value);
    expect(market.ok).toBe(false);
    if (!market.ok) expect(market.error.context?.field).toBe('startsAt');
  });

  it('пропускает одинаковые instrument identity — их ловит create()', () => {
    const snapshot = MarketParser.from({
      ...validJSON(),
      outcomes: [
        { index: 0, label: 'Up', instrumentId: '714' },
        { index: 1, label: 'Down', instrumentId: '714' },
      ],
    });
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;

    const market = Market.fromSnapshot(snapshot.value);
    expect(market.ok).toBe(false);
    if (!market.ok) expect(market.error.message).toContain('instrument identities must be distinct');
  });

  it('нельзя инстанцировать — это static utility класс', () => {
    expect(() => new (MarketParser as unknown as new () => unknown)()).toThrow(
      'MarketParser is a static utility class and cannot be instantiated'
    );
  });
});
