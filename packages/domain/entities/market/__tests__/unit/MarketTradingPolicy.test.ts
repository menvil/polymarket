/**
 * Тесты MarketTradingPolicy — производная фаза рынка
 *
 * @remarks
 * Модельный рынок — 12:00–12:05. Проверяется, что фаза целиком определяется
 * парой (подтверждённое состояние, момент наблюдения) и что подтверждённые
 * терминальные состояния сильнее расписания.
 */

import { describe, it, expect } from '@jest/globals';
import { MarketState, MarketTradingPolicy, type MarketPhase } from '../../src/index.js';
import { at, makeMarket } from './fixtures.js';

describe('MarketTradingPolicy.getPhase() — состояние ACTIVE', () => {
  it('11:59 → PRE_OPEN', () => {
    expect(MarketTradingPolicy.getPhase(makeMarket(), at('11:59:00'))).toBe('PRE_OPEN');
  });

  it('11:59:59.999 → PRE_OPEN (граница слева)', () => {
    expect(MarketTradingPolicy.getPhase(makeMarket(), at('11:59:59.999'))).toBe('PRE_OPEN');
  });

  it('12:00 → OPEN (startsAt включён)', () => {
    expect(MarketTradingPolicy.getPhase(makeMarket(), at('12:00:00'))).toBe('OPEN');
  });

  it('12:02 → OPEN', () => {
    expect(MarketTradingPolicy.getPhase(makeMarket(), at('12:02:00'))).toBe('OPEN');
  });

  it('12:04:59.999 → OPEN (граница справа)', () => {
    expect(MarketTradingPolicy.getPhase(makeMarket(), at('12:04:59.999'))).toBe('OPEN');
  });

  it('12:05 → ENDED (expiresAt включён)', () => {
    expect(MarketTradingPolicy.getPhase(makeMarket(), at('12:05:00'))).toBe('ENDED');
  });

  it('12:30 → ENDED: расписание истекло, площадка всё ещё публикует ACTIVE', () => {
    const market = makeMarket();

    expect(MarketTradingPolicy.getPhase(market, at('12:30:00'))).toBe('ENDED');
    expect(market.state.status).toBe('ACTIVE');
  });
});

describe('MarketTradingPolicy.getPhase() — подтверждённые состояния', () => {
  const anyTime = ['11:00:00', '12:00:00', '12:02:00', '12:05:00', '23:59:59'];

  it.each(anyTime)('CLOSED → CLOSED независимо от часов (%s)', (time) => {
    const market = makeMarket({ state: MarketState.closed() });

    expect(MarketTradingPolicy.getPhase(market, at(time))).toBe('CLOSED');
  });

  it.each(anyTime)('RESOLVED → RESOLVED независимо от часов (%s)', (time) => {
    const market = makeMarket({ state: MarketState.resolved(0) });

    expect(MarketTradingPolicy.getPhase(market, at(time))).toBe('RESOLVED');
  });
});

describe('MarketTradingPolicy — свойства политики', () => {
  it('фаза не хранится в Market: наблюдение не меняет entity', () => {
    const market = makeMarket();

    MarketTradingPolicy.getPhase(market, at('11:59:00'));
    MarketTradingPolicy.getPhase(market, at('12:30:00'));

    expect(market.state.status).toBe('ACTIVE');
  });

  it('покрывает все значения MarketPhase на одном жизненном пути', () => {
    const active = makeMarket();
    const closed = active.markClosed();
    if (!closed.ok) throw new Error('markClosed must succeed for ACTIVE market');
    const resolved = closed.value.markResolved(0);
    if (!resolved.ok) throw new Error('markResolved must succeed for CLOSED market');

    const observed: MarketPhase[] = [
      MarketTradingPolicy.getPhase(active, at('11:59:00')),
      MarketTradingPolicy.getPhase(active, at('12:02:00')),
      MarketTradingPolicy.getPhase(active, at('12:05:00')),
      MarketTradingPolicy.getPhase(closed.value, at('12:05:00')),
      MarketTradingPolicy.getPhase(resolved.value, at('12:05:00')),
    ];

    expect(observed).toEqual(['PRE_OPEN', 'OPEN', 'ENDED', 'CLOSED', 'RESOLVED']);
  });

  it('нельзя инстанцировать — это static utility класс', () => {
    expect(() => new (MarketTradingPolicy as unknown as new () => unknown)()).toThrow(
      'MarketTradingPolicy is a static utility class and cannot be instantiated'
    );
  });
});
