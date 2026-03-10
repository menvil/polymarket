/**
 * Тесты ExpirationRemovalPolicy
 */
import { describe, it, expect } from '@jest/globals';
import { ExpirationRemovalPolicy } from '../src/ExpirationRemovalPolicy.js';
import type { MarketContext } from '../src/IRemovalPolicy.js';
import type { MarketId } from '@polymarket/ids';
import { Money } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeClock(nowMs: number) {
  return { now: () => new Date(nowMs) };
}

function mkt(id: string): MarketId {
  return id as unknown as MarketId;
}

function makeTimestamp(ms: number) {
  return {
    value: () => new Decimal(ms),
    toNumber: () => ms,
    toISO: () => new Date(ms).toISOString(),
  } as never;
}

function makeMarketContext(id: string, expiresAtMs: number): MarketContext {
  return {
    marketId: mkt(id),
    expiresAt: makeTimestamp(expiresAtMs),
    allocatedBalance: Money.of(new Decimal(1000), 'USDC'),
    realizedPnL: Money.ZERO['USDC'],
    openOrdersCount: 0,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ExpirationRemovalPolicy', () => {
  const NOW_MS = 1_700_000_000_000; // фиксированное время
  const LEAD_TIME_MS = 30 * 60 * 1000; // 30 минут

  it('не закрывает рынки с большим временем до истечения', () => {
    const clock = makeClock(NOW_MS);
    const policy = new ExpirationRemovalPolicy(clock, LEAD_TIME_MS);

    // Истекает через 2 часа — должен остаться открытым
    const market = makeMarketContext('m-future', NOW_MS + 2 * 60 * 60 * 1000);

    const result = policy.evaluate([market]);

    expect(result).toHaveLength(0);
  });

  it('закрывает рынки истекающие в пределах leadTime', () => {
    const clock = makeClock(NOW_MS);
    const policy = new ExpirationRemovalPolicy(clock, LEAD_TIME_MS);

    // Истекает через 10 минут — внутри leadTime (30 мин)
    const market = makeMarketContext('m-soon', NOW_MS + 10 * 60 * 1000);

    const result = policy.evaluate([market]);

    expect(result).toHaveLength(1);
    expect(String(result[0])).toBe('m-soon');
  });

  it('закрывает уже истёкшие рынки', () => {
    const clock = makeClock(NOW_MS);
    const policy = new ExpirationRemovalPolicy(clock, LEAD_TIME_MS);

    // Уже истёк 1 час назад
    const market = makeMarketContext('m-expired', NOW_MS - 60 * 60 * 1000);

    const result = policy.evaluate([market]);

    expect(result).toHaveLength(1);
  });

  it('закрывает ровно на границе leadTime', () => {
    const clock = makeClock(NOW_MS);
    const policy = new ExpirationRemovalPolicy(clock, LEAD_TIME_MS);

    // Истекает ровно через 30 минут — граница
    const market = makeMarketContext('m-boundary', NOW_MS + LEAD_TIME_MS);

    const result = policy.evaluate([market]);

    expect(result).toHaveLength(1);
  });

  it('корректно обрабатывает смешанный список рынков', () => {
    const clock = makeClock(NOW_MS);
    const policy = new ExpirationRemovalPolicy(clock, LEAD_TIME_MS);

    const markets = [
      makeMarketContext('m-ok', NOW_MS + 2 * 60 * 60 * 1000),        // 2 часа — ok
      makeMarketContext('m-close', NOW_MS + 15 * 60 * 1000),          // 15 мин — закрыть
      makeMarketContext('m-expired', NOW_MS - 30 * 60 * 1000),        // истёк — закрыть
      makeMarketContext('m-far', NOW_MS + 24 * 60 * 60 * 1000),       // 24 часа — ok
    ];

    const result = policy.evaluate(markets);

    expect(result).toHaveLength(2);
    const ids = result.map(String);
    expect(ids).toContain('m-close');
    expect(ids).toContain('m-expired');
    expect(ids).not.toContain('m-ok');
    expect(ids).not.toContain('m-far');
  });

  it('возвращает [] для пустого списка', () => {
    const clock = makeClock(NOW_MS);
    const policy = new ExpirationRemovalPolicy(clock, LEAD_TIME_MS);

    const result = policy.evaluate([]);

    expect(result).toHaveLength(0);
  });

  it('использует кастомный leadTime', () => {
    const clock = makeClock(NOW_MS);
    // Только 5 минут опережения
    const policy = new ExpirationRemovalPolicy(clock, 5 * 60 * 1000);

    // Истекает через 10 минут — за пределами 5-минутного leadTime
    const market = makeMarketContext('m-10min', NOW_MS + 10 * 60 * 1000);

    const result = policy.evaluate([market]);

    expect(result).toHaveLength(0);
  });
});
