/**
 * Тесты канонического Market
 *
 * @remarks
 * Покрывают четыре группы контракта:
 * - **Construction** — доменные инварианты `create()`;
 * - **Time** — детерминированные методы расписания (без wall clock);
 * - **Observed state transitions** — `markClosed()` / `markResolved()`;
 * - **Snapshot** — round-trip `Market → MarketSnapshot → Market`.
 */

import { describe, it, expect } from '@jest/globals';
import {
  Market,
  MarketState,
  MarketViewModel,
  asMarketDuration,
  unsafeMarketId,
  unsafeInstrumentId,
  unsafeCryptoAssetId,
  asVenueId,
  parseMarketSlug,
  KnownVenues,
  MarketValidationError,
  MarketLifecycleError,
  MarketAlreadyResolvedError,
  type MarketProps,
  type OutcomeIndex,
  type VenueId,
  type MarketSlug,
} from '../../src/index.js';
import {
  at,
  baseProps,
  makeMarket,
  makeMarketResult,
  unwrap,
  DOWN_INSTRUMENT,
  EXPIRES_AT,
  FIVE_MINUTES,
  STARTS_AT,
  UP_INSTRUMENT,
} from './fixtures.js';

// ==================== Construction ====================

describe('Market.create() — валидный рынок', () => {
  it('создаёт canonical Market со всеми структурными полями', () => {
    const market = makeMarket();

    expect(market.id).toBe('btc-up-down-1200');
    expect(market.venueId).toBe(KnownVenues.POLYMARKET);
    expect(market.slug).toBe('bitcoin-up-or-down-september-1-12pm-et');
    expect(market.question).toBe('Bitcoin Up or Down — September 1, 12:00–12:05 ET?');
    expect(market.family).toBe('CRYPTO_UP_DOWN');
    expect(market.state.status).toBe('ACTIVE');
  });

  it('переносит расписание как Timestamp, без bare number внутри', () => {
    const market = makeMarket();

    expect(market.startsAt.toISO()).toBe('2026-09-01T12:00:00.000Z');
    expect(market.expiresAt.toISO()).toBe('2026-09-01T12:05:00.000Z');
  });

  it('переносит crypto-спецификацию семейства CRYPTO_UP_DOWN', () => {
    const market = makeMarket();

    expect(market.crypto?.asset).toBe('btc');
    expect(market.crypto?.duration).toBe(300_000);
  });

  it('хранит ровно два исхода с их canonical instrument identity', () => {
    const market = makeMarket();

    expect(market.outcomes).toHaveLength(2);
    expect(market.outcomes[0]).toEqual({ index: 0, label: 'Up', instrumentId: UP_INSTRUMENT });
    expect(market.outcomes[1]).toEqual({ index: 1, label: 'Down', instrumentId: DOWN_INSTRUMENT });
  });

  it('нормализует метки исходов и вопрос через trim', () => {
    const market = makeMarket({
      question: '  Bitcoin Up or Down?  ',
      outcomes: [
        { index: 0, label: '  Up  ', instrumentId: UP_INSTRUMENT },
        { index: 1, label: ' Down ', instrumentId: DOWN_INSTRUMENT },
      ],
    });

    expect(market.question).toBe('Bitcoin Up or Down?');
    expect(market.outcomes[0].label).toBe('Up');
    expect(market.outcomes[1].label).toBe('Down');
  });

  it('создаёт рынок без slug — площадка может его не публиковать', () => {
    const props = baseProps();
    const withoutSlug: MarketProps = {
      id: props.id,
      venueId: props.venueId,
      question: props.question,
      startsAt: props.startsAt,
      expiresAt: props.expiresAt,
      state: props.state,
      outcomes: props.outcomes,
      family: props.family,
      crypto: props.crypto,
    };

    const result = Market.create(withoutSlug);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.slug).toBeUndefined();
    }
  });
});

describe('Market.create() — иммутабельность результата', () => {
  it('замораживает массив исходов и каждый исход в нём', () => {
    const market = makeMarket();

    expect(Object.isFrozen(market.outcomes)).toBe(true);
    expect(Object.isFrozen(market.outcomes[0])).toBe(true);
    expect(Object.isFrozen(market.outcomes[1])).toBe(true);
  });

  it('замораживает crypto-спецификацию', () => {
    const market = makeMarket();

    expect(Object.isFrozen(market.crypto)).toBe(true);
  });

  it('нормализует state — мутация переданного объекта не меняет entity', () => {
    const mutableState = { status: 'CLOSED' } as MarketState;
    const market = makeMarket({ state: mutableState });

    (mutableState as { status: string }).status = 'ACTIVE';

    expect(market.state.status).toBe('CLOSED');
    expect(market.state).not.toBe(mutableState);
    expect(Object.isFrozen(market.state)).toBe(true);
  });

  it('не связан с исходным массивом props — мутация props не меняет entity', () => {
    const outcomes: MarketProps['outcomes'] = [
      { index: 0, label: 'Up', instrumentId: UP_INSTRUMENT },
      { index: 1, label: 'Down', instrumentId: DOWN_INSTRUMENT },
    ];
    const market = makeMarket({ outcomes });

    (outcomes as unknown as Array<{ label: string }>)[0].label = 'Mutated';

    expect(market.outcomes[0].label).toBe('Up');
  });
});

describe('Market.create() — отклонение невалидных данных', () => {
  it.each([
    ['пустой', ''],
    ['из одних пробелов', '   '],
    ['с необрезанными пробелами', ' btc-up-down-1200 '],
  ])('отклоняет неканонический id (%s)', (_label, id) => {
    const result = makeMarketResult({ id: unsafeMarketId(id) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketValidationError);
      expect(result.error.context?.field).toBe('id');
    }
  });

  it.each([
    ['пустой', ''],
    ['из одних пробелов', '   '],
    ['в нижнем регистре', 'polymarket'],
    ['с дефисом', 'POLY-MARKET'],
  ])('отклоняет неканонический venueId (%s)', (_label, venueId) => {
    const result = makeMarketResult({ venueId: venueId as VenueId });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.field).toBe('venueId');
    }
  });

  it.each([
    ['пустой', ''],
    ['из одних пробелов', '   '],
    ['в верхнем регистре', 'BTC-UP-DOWN'],
    ['с подчёркиванием', 'btc_up_down'],
  ])('отклоняет неканонический slug (%s)', (_label, slug) => {
    const result = makeMarketResult({ slug: slug as MarketSlug });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.field).toBe('slug');
    }
  });

  it('отклоняет неканонический instrumentId исхода', () => {
    const result = makeMarketResult({
      outcomes: [
        { index: 0, label: 'Up', instrumentId: UP_INSTRUMENT },
        { index: 1, label: 'Down', instrumentId: unsafeInstrumentId(' 2299 ') },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.field).toBe('outcomes[1].instrumentId');
    }
  });

  it('отклоняет пустой question', () => {
    const result = makeMarketResult({ question: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketValidationError);
      expect(result.error.context?.field).toBe('question');
    }
  });

  it('отклоняет question из одних пробелов', () => {
    const result = makeMarketResult({ question: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.field).toBe('question');
    }
  });

  it('отклоняет одинаковые метки исходов', () => {
    const result = makeMarketResult({
      outcomes: [
        { index: 0, label: 'Up', instrumentId: UP_INSTRUMENT },
        { index: 1, label: 'Up', instrumentId: DOWN_INSTRUMENT },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketValidationError);
      expect(result.error.message).toContain('labels must be distinct');
    }
  });

  it('отклоняет одинаковые instrument identity исходов', () => {
    const result = makeMarketResult({
      outcomes: [
        { index: 0, label: 'Up', instrumentId: UP_INSTRUMENT },
        { index: 1, label: 'Down', instrumentId: UP_INSTRUMENT },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketValidationError);
      expect(result.error.message).toContain('instrument identities must be distinct');
    }
  });

  it('отклоняет пустую метку исхода', () => {
    const result = makeMarketResult({
      outcomes: [
        { index: 0, label: '', instrumentId: UP_INSTRUMENT },
        { index: 1, label: 'Down', instrumentId: DOWN_INSTRUMENT },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.field).toBe('outcomes[0].label');
    }
  });

  it('отклоняет пустой instrumentId исхода', () => {
    const result = makeMarketResult({
      outcomes: [
        { index: 0, label: 'Up', instrumentId: UP_INSTRUMENT },
        { index: 1, label: 'Down', instrumentId: unsafeInstrumentId('') },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.field).toBe('outcomes[1].instrumentId');
    }
  });

  it('отклоняет неканонический crypto.asset', () => {
    const result = makeMarketResult({
      crypto: { asset: unsafeCryptoAssetId(' btc '), duration: FIVE_MINUTES },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.field).toBe('crypto.asset');
    }
  });

  it('отклоняет исход, стоящий не на своей позиции', () => {
    const result = makeMarketResult({
      outcomes: [
        { index: 1, label: 'Up', instrumentId: UP_INSTRUMENT },
        { index: 1, label: 'Down', instrumentId: DOWN_INSTRUMENT },
      ] as unknown as MarketProps['outcomes'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.field).toBe('outcomes[0].index');
    }
  });

  it('требует ровно два исхода: пустой массив отклоняется', () => {
    const result = makeMarketResult({ outcomes: [] as never });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketValidationError);
      expect(result.error.context?.field).toBe('outcomes');
    }
  });

  it('требует ровно два исхода: один исход отклоняется', () => {
    const result = makeMarketResult({
      outcomes: [{ index: 0, label: 'Up', instrumentId: UP_INSTRUMENT }] as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.field).toBe('outcomes');
    }
  });

  it('требует ровно два исхода: три исхода отклоняются', () => {
    const result = makeMarketResult({
      outcomes: [
        { index: 0, label: 'Up', instrumentId: UP_INSTRUMENT },
        { index: 1, label: 'Down', instrumentId: DOWN_INSTRUMENT },
        { index: 1, label: 'Flat', instrumentId: unsafeInstrumentId('333') },
      ] as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.field).toBe('outcomes');
    }
  });

  it('требует ровно два исхода: не-массив отклоняется без TypeError', () => {
    const result = makeMarketResult({ outcomes: 'not an array' as never });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketValidationError);
    }
  });

  it('отклоняет расписание, где startsAt позже expiresAt', () => {
    const result = makeMarketResult({ startsAt: EXPIRES_AT, expiresAt: STARTS_AT });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.field).toBe('startsAt');
      expect(result.error.message).toContain('strictly before');
    }
  });

  it('отклоняет расписание нулевой длительности', () => {
    const result = makeMarketResult({ startsAt: STARTS_AT, expiresAt: STARTS_AT });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.field).toBe('startsAt');
    }
  });

  it('отклоняет startsAt, который не является Timestamp', () => {
    const result = makeMarketResult({ startsAt: 1_772_366_400_000 as never });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.field).toBe('startsAt');
    }
  });

  it('отклоняет expiresAt, который не является Timestamp', () => {
    const result = makeMarketResult({ expiresAt: null as never });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.field).toBe('expiresAt');
    }
  });

  it('отклоняет невалидный state объект', () => {
    const result = makeMarketResult({ state: { status: 'UPCOMING' } as never });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.field).toBe('state');
    }
  });

  it('отклоняет state: null', () => {
    const result = makeMarketResult({ state: null as never });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.field).toBe('state');
    }
  });

  it('отклоняет RESOLVED без resolvedOutcomeIndex (защита от as-кастов)', () => {
    const result = makeMarketResult({ state: { status: 'RESOLVED' } as never });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.field).toBe('state.resolvedOutcomeIndex');
    }
  });

  it('отклоняет RESOLVED с индексом вне набора исходов', () => {
    const result = makeMarketResult({
      state: { status: 'RESOLVED', resolvedOutcomeIndex: 2 } as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.field).toBe('state.resolvedOutcomeIndex');
    }
  });

  it('отклоняет неизвестное семейство рынка', () => {
    const result = makeMarketResult({ family: 'SPORTS' as never });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.field).toBe('family');
    }
  });

  it('отклоняет CRYPTO_UP_DOWN без crypto-спецификации', () => {
    const props = baseProps();
    const result = Market.create({
      id: props.id,
      venueId: props.venueId,
      question: props.question,
      startsAt: props.startsAt,
      expiresAt: props.expiresAt,
      state: props.state,
      outcomes: props.outcomes,
      family: 'CRYPTO_UP_DOWN',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.field).toBe('crypto');
    }
  });

  it('отклоняет crypto-спецификацию с пустым активом', () => {
    const result = makeMarketResult({
      crypto: { asset: unsafeCryptoAssetId(''), duration: FIVE_MINUTES },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.field).toBe('crypto.asset');
    }
  });

  it('отклоняет crypto-спецификацию с неположительной длительностью', () => {
    const result = makeMarketResult({
      crypto: { asset: unsafeCryptoAssetId('btc'), duration: 0 as never },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.field).toBe('crypto.duration');
    }
  });
});

// ==================== Time ====================

describe('Market — расписание рынка 12:00–12:05', () => {
  it('11:59:59 — торги ещё не начались', () => {
    expect(makeMarket().isStartedAt(at('11:59:59'))).toBe(false);
  });

  it('12:00:00 — торги начались (граница включена)', () => {
    expect(makeMarket().isStartedAt(at('12:00:00'))).toBe(true);
  });

  it('12:04:59 — рынок ещё не истёк', () => {
    expect(makeMarket().isExpiredAt(at('12:04:59'))).toBe(false);
  });

  it('12:05:00 — рынок истёк (граница включена)', () => {
    expect(makeMarket().isExpiredAt(at('12:05:00'))).toBe(true);
  });

  it('timeToStartAt положителен до старта и отрицателен после', () => {
    const market = makeMarket();

    expect(market.timeToStartAt(at('11:59:59')).toNumber()).toBe(1_000);
    expect(market.timeToStartAt(at('12:00:30')).toNumber()).toBe(-30_000);
  });

  it('timeToExpiryAt положителен до истечения и отрицателен после', () => {
    const market = makeMarket();

    expect(market.timeToExpiryAt(at('12:04:59')).toNumber()).toBe(1_000);
    expect(market.timeToExpiryAt(at('12:06:00')).toNumber()).toBe(-60_000);
  });

  it('duration() возвращает фактический интервал расписания', () => {
    expect(makeMarket().duration().toNumber()).toBe(300_000);
  });

  it('duration() возвращает Decimal-арифметику, а не примитив number', () => {
    const duration = makeMarket().duration();

    expect(typeof duration).toBe('object');
    expect(duration.dividedBy(60_000).toNumber()).toBe(5);
  });

  it('номинальная длительность серии может расходиться с расписанием', () => {
    // Площадка сдвинула публикацию на 2 секунды, серия осталась 5-минутной
    const market = makeMarket({ expiresAt: at('12:04:58') });

    expect(market.duration().toNumber()).toBe(298_000);
    expect(market.crypto?.duration).toBe(300_000);
  });

  it('истечение расписания не меняет state — рынок остаётся ACTIVE', () => {
    const market = makeMarket();

    expect(market.isExpiredAt(at('12:30:00'))).toBe(true);
    expect(market.state.status).toBe('ACTIVE');
    expect(market.isActive()).toBe(true);
  });
});

// ==================== Predicates ====================

describe('Market — предикаты состояния', () => {
  it('isActive() истинен только для ACTIVE', () => {
    const market = makeMarket({ state: MarketState.active() });

    expect(market.isActive()).toBe(true);
    expect(market.isClosed()).toBe(false);
    expect(market.isResolved()).toBe(false);
  });

  it('isClosed() истинен только для CLOSED', () => {
    const market = makeMarket({ state: MarketState.closed() });

    expect(market.isClosed()).toBe(true);
    expect(market.isActive()).toBe(false);
    expect(market.isResolved()).toBe(false);
  });

  it('isResolved() истинен только для RESOLVED', () => {
    const market = makeMarket({ state: MarketState.resolved(0) });

    expect(market.isResolved()).toBe(true);
    expect(market.isActive()).toBe(false);
    expect(market.isClosed()).toBe(false);
  });

  it('resolvedOutcome разворачивает индекс победителя в сам исход', () => {
    const market = makeMarket({ state: MarketState.resolved(1) });

    expect(market.resolvedOutcome).toEqual({
      index: 1,
      label: 'Down',
      instrumentId: DOWN_INSTRUMENT,
    });
  });

  it('resolvedOutcome === undefined, пока исход не объявлен', () => {
    expect(makeMarket({ state: MarketState.active() }).resolvedOutcome).toBeUndefined();
    expect(makeMarket({ state: MarketState.closed() }).resolvedOutcome).toBeUndefined();
  });
});

// ==================== State transitions ====================

describe('Market.markClosed() — фиксация наблюдённого закрытия', () => {
  it('ACTIVE → CLOSED возвращает новый Market', () => {
    const closed = unwrap(makeMarket().markClosed());

    expect(closed.isClosed()).toBe(true);
    expect(closed.state.status).toBe('CLOSED');
  });

  it('не мутирует исходный Market', () => {
    const market = makeMarket();
    market.markClosed();

    expect(market.isActive()).toBe(true);
  });

  it('сохраняет всю структуру рынка при переходе', () => {
    const market = makeMarket();
    const closed = unwrap(market.markClosed());

    expect(closed.id).toBe(market.id);
    expect(closed.venueId).toBe(market.venueId);
    expect(closed.slug).toBe(market.slug);
    expect(closed.question).toBe(market.question);
    expect(closed.startsAt.equals(market.startsAt)).toBe(true);
    expect(closed.expiresAt.equals(market.expiresAt)).toBe(true);
    expect(closed.outcomes).toEqual(market.outcomes);
    expect(closed.family).toBe(market.family);
    expect(closed.crypto).toEqual(market.crypto);
  });

  it('CLOSED → markClosed() идемпотентно и возвращает тот же экземпляр', () => {
    const closed = makeMarket({ state: MarketState.closed() });
    const result = closed.markClosed();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(closed); // no-op отличим по ссылке
    }
  });

  it('RESOLVED → markClosed() отклоняется как MarketAlreadyResolvedError', () => {
    const result = makeMarket({ state: MarketState.resolved(0) }).markClosed();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketAlreadyResolvedError);
      expect(result.error).toBeInstanceOf(MarketLifecycleError);
    }
  });

  it('ошибка конфликта содержит marketId, venueId и текущий статус', () => {
    const result = makeMarket({ state: MarketState.resolved(0) }).markClosed();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.marketId).toBe('btc-up-down-1200');
      expect(result.error.context?.venueId).toBe('POLYMARKET');
      expect(result.error.context?.currentStatus).toBe('RESOLVED');
    }
  });
});

describe('Market.markResolved() — фиксация объявленного исхода', () => {
  it('CLOSED → RESOLVED(0) фиксирует победу первого исхода', () => {
    const resolved = unwrap(makeMarket({ state: MarketState.closed() }).markResolved(0));

    expect(resolved.isResolved()).toBe(true);
    expect(resolved.resolvedOutcome?.label).toBe('Up');
  });

  it('CLOSED → RESOLVED(1) фиксирует победу второго исхода', () => {
    const resolved = unwrap(makeMarket({ state: MarketState.closed() }).markResolved(1));

    expect(resolved.isResolved()).toBe(true);
    expect(resolved.resolvedOutcome?.label).toBe('Down');
  });

  it('ACTIVE → markResolved() разрешён: CLOSED мог не попасть между опросами', () => {
    const resolved = unwrap(makeMarket({ state: MarketState.active() }).markResolved(1));

    expect(resolved.isResolved()).toBe(true);
    expect(resolved.resolvedOutcome?.label).toBe('Down');
  });

  it('RESOLVED(i) → markResolved(i) идемпотентно и возвращает тот же экземпляр', () => {
    const resolved = makeMarket({ state: MarketState.resolved(0) });
    const result = resolved.markResolved(0);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(resolved);
    }
  });

  it('RESOLVED(0) → markResolved(1) отклоняется как конфликт исхода', () => {
    const result = makeMarket({ state: MarketState.resolved(0) }).markResolved(1);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketAlreadyResolvedError);
      expect(result.error).toBeInstanceOf(MarketLifecycleError);
      expect(result.error.context?.resolvedOutcomeIndex).toBe(0);
      expect(result.error.context?.observedOutcomeIndex).toBe(1);
    }
  });

  it('RESOLVED → markClosed() отклоняется как регрессия состояния', () => {
    const result = makeMarket({ state: MarketState.resolved(0) }).markClosed();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketAlreadyResolvedError);
    }
  });

  it('отклоняет индекс вне набора исходов', () => {
    const result = makeMarket({ state: MarketState.closed() }).markResolved(2 as OutcomeIndex);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketValidationError);
    }
  });

  it.each([
    ['NaN', NaN],
    ['дробный', 0.5],
    ['null', null],
    ['строка', '0'],
  ])('отклоняет %s индекс исхода', (_label, index) => {
    const result = makeMarket({ state: MarketState.closed() })
      .markResolved(index as unknown as OutcomeIndex);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketValidationError);
    }
  });
});

describe('Market — полный наблюдаемый цикл ACTIVE → CLOSED → RESOLVED', () => {
  it('проходит все три состояния без мутации предыдущих экземпляров', () => {
    const active = makeMarket();
    const closed = unwrap(active.markClosed());
    const resolved = unwrap(closed.markResolved(0));

    expect(active.state.status).toBe('ACTIVE');
    expect(closed.state.status).toBe('CLOSED');
    expect(resolved.state.status).toBe('RESOLVED');
    expect(resolved.resolvedOutcome?.instrumentId).toBe(UP_INSTRUMENT);
  });
});

// ==================== Identity ====================

describe('Market.equals()', () => {
  it('истинен для одного и того же рынка в разных наблюдениях', () => {
    const market = makeMarket();
    const closed = unwrap(market.markClosed());

    expect(market.equals(closed)).toBe(true);
  });

  it('ложен для разных id', () => {
    expect(makeMarket().equals(makeMarket({ id: unsafeMarketId('other') }))).toBe(false);
  });

  it('ложен для одинакового id на разных площадках', () => {
    const kalshi = makeMarket({ venueId: asVenueId('KALSHI')! });

    expect(makeMarket().equals(kalshi)).toBe(false);
  });
});

// ==================== Snapshot round-trip ====================

describe('Market ⇄ MarketSnapshot round-trip', () => {
  it('Market → snapshot → Market даёт эквивалентный рынок', () => {
    const market = makeMarket();
    const restored = unwrap(Market.fromSnapshot(MarketViewModel.toSnapshot(market)));

    expect(restored.id).toBe(market.id);
    expect(restored.venueId).toBe(market.venueId);
    expect(restored.slug).toBe(market.slug);
    expect(restored.question).toBe(market.question);
    expect(restored.startsAt.equals(market.startsAt)).toBe(true);
    expect(restored.expiresAt.equals(market.expiresAt)).toBe(true);
    expect(restored.state).toEqual(market.state);
    expect(restored.outcomes).toEqual(market.outcomes);
    expect(restored.family).toBe(market.family);
    expect(restored.crypto).toEqual(market.crypto);
  });

  it('сохраняет состояние RESOLVED вместе с индексом победителя', () => {
    const market = makeMarket({ state: MarketState.resolved(1) });
    const restored = unwrap(Market.fromSnapshot(MarketViewModel.toSnapshot(market)));

    expect(restored.state).toEqual({ status: 'RESOLVED', resolvedOutcomeIndex: 1 });
    expect(restored.resolvedOutcome?.label).toBe('Down');
  });

  it('не подменяет отсутствующие поля на undefined-значения', () => {
    const props = baseProps();
    const market = unwrap(Market.create({
      id: props.id,
      venueId: props.venueId,
      question: props.question,
      startsAt: props.startsAt,
      expiresAt: props.expiresAt,
      state: props.state,
      outcomes: props.outcomes,
      family: props.family,
      crypto: props.crypto,
    }));

    const snapshot = MarketViewModel.toSnapshot(market);

    expect('slug' in snapshot).toBe(false);
    expect(unwrap(Market.fromSnapshot(snapshot)).slug).toBeUndefined();
  });

  it('fromSnapshot проверяет те же инварианты, что и create', () => {
    const snapshot = MarketViewModel.toSnapshot(makeMarket());
    const broken = { ...snapshot, question: '   ' };

    const result = Market.fromSnapshot(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.field).toBe('question');
    }
  });
});

// ==================== toString ====================

describe('Market.toString()', () => {
  it('содержит площадку, id, статус и вопрос', () => {
    const str = makeMarket().toString();

    expect(str).toContain('POLYMARKET');
    expect(str).toContain('btc-up-down-1200');
    expect(str).toContain('ACTIVE');
    expect(str).toContain('Bitcoin Up or Down');
  });
});

// ==================== Фикстуры канонических VO ====================

describe('Canonical VO, используемые Market', () => {
  it('asMarketDuration принимает положительные целые миллисекунды', () => {
    expect(asMarketDuration(300_000)).toBe(300_000);
  });

  it('parseMarketSlug остаётся URL-safe валидатором', () => {
    expect(parseMarketSlug('btc-up-down-1200')).toBe('btc-up-down-1200');
    expect(parseMarketSlug('BTC_UP')).toBeUndefined();
  });
});
