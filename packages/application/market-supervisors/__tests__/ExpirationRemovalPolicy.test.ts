/**
 * Тесты ExpirationRemovalPolicy
 */
import { describe, it, expect } from '@jest/globals';
import { ExpirationRemovalPolicy } from '../src/ExpirationRemovalPolicy.js';
import type { MarketContext } from '../src/IRemovalPolicy.js';
import type { MarketId } from '@polymarket/ids';
import { Money, TimestampService } from '@polymarket/value-objects';
import type { Timestamp } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeClock(nowMs: number) {
  return { now: () => new Date(nowMs) };
}

function mkt(id: string): MarketId {
  return id as unknown as MarketId;
}

function makeTimestamp(ms: number): Timestamp {
  const result = TimestampService.create(ms);
  if (!result.ok) throw new Error(`Invalid timestamp ms=${ms}: ${result.error.message}`);
  return result.value;
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
  const NOW_MS = 1_700_000_000_000;
  const LEAD_TIME_MS = 30 * 60 * 1000;

  describe('конструктор', () => {
    it('отрицательный leadTimeMs → RangeError', () => {
      const clock = makeClock(NOW_MS);
      expect(() => new ExpirationRemovalPolicy(clock, -1)).toThrow(RangeError);
      expect(() => new ExpirationRemovalPolicy(clock, -1)).toThrow('leadTimeMs must be >= 0');
    });

    it('использует default leadTime 30 минут без второго аргумента', () => {
      const clock = makeClock(NOW_MS);
      const policy = new ExpirationRemovalPolicy(clock);

      const mInside = makeMarketContext('m-20min', NOW_MS + 20 * 60 * 1000);
      const mOutside = makeMarketContext('m-45min', NOW_MS + 45 * 60 * 1000);

      const result = policy.evaluate([mInside, mOutside]);

      expect(result).toHaveLength(1);
      expect(String(result[0])).toBe('m-20min');
    });
  });

  it('не закрывает рынки с большим временем до истечения', () => {
    const clock = makeClock(NOW_MS);
    const policy = new ExpirationRemovalPolicy(clock, LEAD_TIME_MS);

    const market = makeMarketContext('m-future', NOW_MS + 2 * 60 * 60 * 1000);

    expect(policy.evaluate([market])).toHaveLength(0);
  });

  it('закрывает рынки истекающие в пределах leadTime', () => {
    const clock = makeClock(NOW_MS);
    const policy = new ExpirationRemovalPolicy(clock, LEAD_TIME_MS);

    const market = makeMarketContext('m-soon', NOW_MS + 10 * 60 * 1000);
    const result = policy.evaluate([market]);

    expect(result).toHaveLength(1);
    expect(String(result[0])).toBe('m-soon');
  });

  it('закрывает уже истёкшие рынки', () => {
    const clock = makeClock(NOW_MS);
    const policy = new ExpirationRemovalPolicy(clock, LEAD_TIME_MS);

    const market = makeMarketContext('m-expired', NOW_MS - 60 * 60 * 1000);

    expect(policy.evaluate([market])).toHaveLength(1);
  });

  it('закрывает ровно на границе leadTime', () => {
    const clock = makeClock(NOW_MS);
    const policy = new ExpirationRemovalPolicy(clock, LEAD_TIME_MS);

    const market = makeMarketContext('m-boundary', NOW_MS + LEAD_TIME_MS);

    expect(policy.evaluate([market])).toHaveLength(1);
  });

  it('корректно обрабатывает смешанный список рынков', () => {
    const clock = makeClock(NOW_MS);
    const policy = new ExpirationRemovalPolicy(clock, LEAD_TIME_MS);

    const markets = [
      makeMarketContext('m-ok', NOW_MS + 2 * 60 * 60 * 1000),
      makeMarketContext('m-close', NOW_MS + 15 * 60 * 1000),
      makeMarketContext('m-expired', NOW_MS - 30 * 60 * 1000),
      makeMarketContext('m-far', NOW_MS + 24 * 60 * 60 * 1000),
    ];

    const result = policy.evaluate(markets);
    const ids = result.map(String);

    expect(result).toHaveLength(2);
    expect(ids).toContain('m-close');
    expect(ids).toContain('m-expired');
    expect(ids).not.toContain('m-ok');
    expect(ids).not.toContain('m-far');
  });

  it('возвращает [] для пустого списка', () => {
    const clock = makeClock(NOW_MS);
    const policy = new ExpirationRemovalPolicy(clock, LEAD_TIME_MS);

    expect(policy.evaluate([])).toHaveLength(0);
  });

  it('использует кастомный leadTime', () => {
    const clock = makeClock(NOW_MS);
    const policy = new ExpirationRemovalPolicy(clock, 5 * 60 * 1000);

    const market = makeMarketContext('m-10min', NOW_MS + 10 * 60 * 1000);

    expect(policy.evaluate([market])).toHaveLength(0);
  });

  it('clock возвращает невалидную дату (NaN) → evaluate безопасно возвращает []', () => {
    const brokenClock = { now: () => new Date(NaN) };
    const policy = new ExpirationRemovalPolicy(brokenClock, LEAD_TIME_MS);
    const market = makeMarketContext('m-any', NOW_MS + 60_000);

    expect(policy.evaluate([market])).toEqual([]);
  });
});
