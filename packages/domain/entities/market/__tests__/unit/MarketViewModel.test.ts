/**
 * Тесты MarketViewModel — представление канонического Market наружу
 *
 * @remarks
 * Проверяет обе формы представления и их согласованность с обратным
 * направлением (`MarketParser` / `Market.fromSnapshot`):
 * - `toSnapshot()` — доменные типы, in-memory;
 * - `toJSON()` — примитивы, БД/сеть.
 */

import { describe, it, expect } from '@jest/globals';
import { Market, MarketParser, MarketState, MarketViewModel } from '../../src/index.js';
import { makeMarket, unwrap, DOWN_INSTRUMENT, UP_INSTRUMENT } from './fixtures.js';

describe('MarketViewModel.toSnapshot()', () => {
  it('переносит структуру рынка без деградации типов', () => {
    const market = makeMarket();
    const snapshot = MarketViewModel.toSnapshot(market);

    expect(snapshot.id).toBe('btc-up-down-1200');
    expect(snapshot.venueId).toBe('POLYMARKET');
    expect(snapshot.slug).toBe('bitcoin-up-or-down-september-1-12pm-et');
    expect(snapshot.family).toBe('CRYPTO_UP_DOWN');
    expect(snapshot.startsAt.equals(market.startsAt)).toBe(true);
    expect(snapshot.expiresAt.equals(market.expiresAt)).toBe(true);
    expect(snapshot.outcomes[0]).toEqual({ index: 0, label: 'Up', instrumentId: UP_INSTRUMENT });
    expect(snapshot.outcomes[1]).toEqual({ index: 1, label: 'Down', instrumentId: DOWN_INSTRUMENT });
    expect(snapshot.crypto).toEqual({ asset: 'btc', duration: 300_000 });
  });

  it('сериализует ACTIVE состояние', () => {
    expect(MarketViewModel.toSnapshot(makeMarket()).state).toEqual({ status: 'ACTIVE' });
  });

  it('сериализует CLOSED состояние', () => {
    const closed = unwrap(makeMarket().markClosed());

    expect(MarketViewModel.toSnapshot(closed).state).toEqual({ status: 'CLOSED' });
  });

  it('сериализует RESOLVED состояние вместе с индексом победителя', () => {
    const resolved = unwrap(unwrap(makeMarket().markClosed()).markResolved(1));

    expect(MarketViewModel.toSnapshot(resolved).state).toEqual({
      status: 'RESOLVED',
      resolvedOutcomeIndex: 1,
    });
  });

  it('копирует исходы — мутация снапшота не задевает entity', () => {
    const market = makeMarket();
    const snapshot = MarketViewModel.toSnapshot(market);

    (snapshot.outcomes[0] as { label: string }).label = 'Mutated';

    expect(market.outcomes[0].label).toBe('Up');
  });

  it('копирует состояние — снапшот не делит ссылку с entity', () => {
    const market = makeMarket({ state: MarketState.resolved(1) });
    const snapshot = MarketViewModel.toSnapshot(market);

    expect(snapshot.state).toEqual(market.state);
    expect(snapshot.state).not.toBe(market.state);
    expect(Object.isFrozen(snapshot.state)).toBe(true);
  });
});

describe('MarketViewModel.toJSON()', () => {
  it('сериализует рынок в JSON-примитивы', () => {
    const json = MarketViewModel.toJSON(makeMarket());

    expect(json).toEqual({
      id: 'btc-up-down-1200',
      venueId: 'POLYMARKET',
      slug: 'bitcoin-up-or-down-september-1-12pm-et',
      question: 'Bitcoin Up or Down — September 1, 12:00–12:05 ET?',
      startsAt: Date.parse('2026-09-01T12:00:00.000Z'),
      expiresAt: Date.parse('2026-09-01T12:05:00.000Z'),
      state: { status: 'ACTIVE' },
      outcomes: [
        { index: 0, label: 'Up', instrumentId: '71476031705491' },
        { index: 1, label: 'Down', instrumentId: '22993088410122' },
      ],
      family: 'CRYPTO_UP_DOWN',
      crypto: { asset: 'btc', duration: 300_000 },
    });
  });

  it('переживает JSON.stringify/parse без потерь', () => {
    const json = MarketViewModel.toJSON(makeMarket({ state: MarketState.resolved(0) }));

    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  it('не добавляет slug, когда площадка его не публикует', () => {
    const market = makeMarket();
    const withoutSlug = unwrap(MarketParser.from({
      ...MarketViewModel.toJSON(market),
      slug: undefined,
    }));

    expect('slug' in MarketViewModel.toJSON(unwrap(Market.fromSnapshot(withoutSlug)))).toBe(false);
  });

  it('добавляет resolvedOutcomeIndex только для RESOLVED', () => {
    expect(MarketViewModel.toJSON(makeMarket()).state).toEqual({ status: 'ACTIVE' });
    expect(MarketViewModel.toJSON(makeMarket({ state: MarketState.resolved(1) })).state).toEqual({
      status: 'RESOLVED',
      resolvedOutcomeIndex: 1,
    });
  });
});

describe('MarketViewModel — полный round-trip через сериализацию', () => {
  it('Market → toJSON → MarketParser → fromSnapshot даёт эквивалентный рынок', () => {
    const market = makeMarket({ state: MarketState.resolved(1) });

    const wire = JSON.parse(JSON.stringify(MarketViewModel.toJSON(market))) as unknown;
    const snapshot = unwrap(MarketParser.from(wire));
    const restored = unwrap(Market.fromSnapshot(snapshot));

    expect(MarketViewModel.toJSON(restored)).toEqual(MarketViewModel.toJSON(market));
    expect(restored.equals(market)).toBe(true);
  });
});

describe('MarketViewModel — прочее', () => {
  it('toString() делегирует в Market.toString()', () => {
    const market = makeMarket();

    expect(MarketViewModel.toString(market)).toBe(market.toString());
  });

  it('нельзя инстанцировать — это static utility класс', () => {
    expect(() => new (MarketViewModel as unknown as new () => unknown)()).toThrow(
      'MarketViewModel is a static utility class and cannot be instantiated'
    );
  });
});
