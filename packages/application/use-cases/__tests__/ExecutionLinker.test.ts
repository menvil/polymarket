/**
 * Тесты ExecutionLinker (Этап 7 плана миграции).
 *
 * @remarks
 * Использует реальный `TradeIndexCollector` (не мок) — тестирует настоящее
 * end-to-end поведение `findMatch()` через `link()`. Персистентность
 * (`ExecutionMetadata`) не строится — `link()` только логирует исход, поэтому
 * тесты проверяют логи, а не мутацию `Fill`.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import Decimal from 'decimal.js';
import { ExecutionLinker } from '../src/services/ExecutionLinker.js';
import { TradeIndexCollector } from '@polymarket/market-state';
import { Trade } from '@polymarket/trade';
import { PaperClock } from '@polymarket/time';
import { Price, Quantity } from '@polymarket/value-objects';
import { Timestamp } from '@polymarket/timestamp';
import type { AccountId, AssetId, FillId, OrderId, VenueId, MarketId } from '@polymarket/ids';
import { asVenueTradeId, asVenueId } from '@polymarket/ids';
import type { Fill } from '@polymarket/fill';
import type { ILogger } from '@polymarket/logger';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeLogger(): { logger: ILogger; debugCalls: unknown[][]; warnCalls: unknown[][] } {
  const debugCalls: unknown[][] = [];
  const warnCalls: unknown[][] = [];
  const logger = {
    trace: () => {},
    debug: (...args: unknown[]) => { debugCalls.push(args); },
    info: () => {},
    warn: (...args: unknown[]) => { warnCalls.push(args); },
    error: () => {},
    fatal: () => {},
    child: () => logger,
  } as unknown as ILogger;
  return { logger, debugCalls, warnCalls };
}

const T0 = 1_700_000_000_000;
const ACCOUNT_ID = 'acc-linker-test' as unknown as AccountId;
const VENUE_ID_TYPED = asVenueId('POLYMARKET')!;
const TOKEN_ID = { type: 'POLYMARKET_CTF_TOKEN', tokenId: 'token-yes' } as unknown as AssetId;
const ORDER_ID = 'order-1' as unknown as OrderId;
const MARKET_ID = 'market-1' as unknown as MarketId;

function ts(ms: number): Timestamp {
  return Timestamp.of(new Decimal(ms));
}

function makeFill(overrides: { id: string; price: string; size: string; timestampMs: number }): Fill {
  return {
    id: overrides.id as unknown as FillId,
    orderId: ORDER_ID,
    accountId: ACCOUNT_ID,
    venueId: 'POLYMARKET' as unknown as VenueId,
    marketId: MARKET_ID,
    tokenId: TOKEN_ID,
    price: Price.of(new Decimal(overrides.price)),
    size: Quantity.of(new Decimal(overrides.size)),
    side: 'BUY',
    timestamp: ts(overrides.timestampMs),
  } as unknown as Fill;
}

function makeTrade(overrides: { idSuffix: string; price: string; size: string; ms: number }): Trade {
  const result = Trade.create({
    id: asVenueTradeId(`trade-${overrides.idSuffix}`)!,
    venueId: VENUE_ID_TYPED,
    marketId: MARKET_ID,
    tokenId: TOKEN_ID,
    price: Price.of(new Decimal(overrides.price)),
    size: Quantity.of(new Decimal(overrides.size)),
    aggressorSide: 'BUY',
    timestamp: ts(overrides.ms),
  });
  if (!result.ok) throw new Error(`Failed to build test Trade: ${result.error.message}`);
  return result.value;
}

function makeTradeIndex(): TradeIndexCollector {
  const result = TradeIndexCollector.create({ maxCount: 1000 }, new PaperClock(new Date(T0)));
  if (!result.ok) throw new Error(`Failed to create TradeIndexCollector: ${result.error.message}`);
  return result.value;
}

describe('ExecutionLinker', () => {
  let tradeIndex: TradeIndexCollector;
  let log: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    tradeIndex = makeTradeIndex();
    log = makeLogger();
  });

  it('находит совпадающий Trade и логирует match (debug)', () => {
    const trade = makeTrade({ idSuffix: '1', price: '0.65', size: '100', ms: T0 });
    tradeIndex.record(trade);
    const linker = new ExecutionLinker({ tradeIndex, logger: log.logger });

    const fill = makeFill({ id: 'fill-1', price: '0.65', size: '100', timestampMs: T0 + 1000 });
    linker.link(fill);

    expect(log.debugCalls).toHaveLength(1);
    const [message, context] = log.debugCalls[0] as [string, Record<string, unknown>];
    expect(message).toBe('Fill linked to market trade');
    expect(context['tradeId']).toBe(String(trade.id));
    expect(context['fillId']).toBe(String(fill.id));
  });

  it('не находит совпадение — логирует no-match (debug), не бросает', () => {
    const linker = new ExecutionLinker({ tradeIndex, logger: log.logger });
    const fill = makeFill({ id: 'fill-1', price: '0.65', size: '100', timestampMs: T0 });

    expect(() => linker.link(fill)).not.toThrow();
    expect(log.debugCalls).toHaveLength(1);
    const [message] = log.debugCalls[0] as [string, Record<string, unknown>];
    expect(message).toBe('No matching market trade found for fill');
    expect(log.warnCalls).toHaveLength(0);
  });

  it('уважает переданный windowMs (не находит трейд вне явно заданного окна)', () => {
    const trade = makeTrade({ idSuffix: '1', price: '0.65', size: '100', ms: T0 });
    tradeIndex.record(trade);
    const linker = new ExecutionLinker({ tradeIndex, logger: log.logger });

    // Дефолтное окно (30s) нашло бы совпадение — передаём узкое окно явно.
    const fill = makeFill({ id: 'fill-1', price: '0.65', size: '100', timestampMs: T0 + 10_000 });
    linker.link(fill, 5_000);

    const [message] = log.debugCalls[0] as [string, Record<string, unknown>];
    expect(message).toBe('No matching market trade found for fill');
  });

  it('никогда не бросает наружу, даже если tradeIndex.findMatch бросает', () => {
    const throwingIndex = {
      findMatch: () => { throw new Error('boom'); },
    } as unknown as TradeIndexCollector;
    const linker = new ExecutionLinker({ tradeIndex: throwingIndex, logger: log.logger });
    const fill = makeFill({ id: 'fill-1', price: '0.65', size: '100', timestampMs: T0 });

    expect(() => linker.link(fill)).not.toThrow();
    expect(log.warnCalls).toHaveLength(1);
    const [message, context] = log.warnCalls[0] as [string, Record<string, unknown>];
    expect(message).toContain('threw unexpectedly');
    expect(context['error']).toBe('boom');
  });
});
