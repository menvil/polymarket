/**
 * Приёмочный сценарий: ОДНА реализация стратегии, ДВА экземпляра с разными
 * конфигами рынка.
 *
 * @remarks
 * Это тот случай, ради которого граница `config → Policy` и добавлена.
 * Сама стратегия здесь не участвует — и не должна: пакет policy не знает
 * ни о каких стратегиях. Проверяется ровно то, что делает такой запуск
 * возможным:
 *
 * 1. две policy собираются НЕЗАВИСИМО из plain-конфигов, без ручной
 *    конверсии canonical-типов на стороне вызывающего;
 * 2. они не разделяют состояние — правка одной не задевает другую;
 * 3. каждая выбирает СВОЙ рынок из ОДНОГО общего universe.
 *
 * Пока такой границы не было, каждый будущий загрузчик (bot runtime,
 * коллектор, backtest) писал бы собственный парсер `"5m"` → `MarketDuration`,
 * и два экземпляра одной стратегии могли бы разойтись в том, что вообще
 * означает их конфигурация.
 */
import { describe, it, expect } from '@jest/globals';
import type { IClock } from '@polymarket/time';
import { MarketUniverse } from '@polymarket/market-discovery';
import type { MarketDiscoveryEntry, MarketDiscoverySnapshot } from '@polymarket/ports';
import { Market, MarketState, asMarketDuration } from '@polymarket/market';
import {
  KnownVenues,
  unsafeCryptoAssetId,
  unsafeInstrumentId,
  unsafeMarketId,
} from '@polymarket/ids';
import { MoneyService } from '@polymarket/value-objects';
import { TimestampService } from '@polymarket/timestamp';
import type { Timestamp } from '@polymarket/timestamp';
import {
  MarketFilter,
  MarketScorer,
  parsePolicyConfig,
  type PolymarketPolicyConfig,
} from '../src/index.js';

const BASE_MS = Date.parse('2026-09-02T12:00:00.000Z');

class FixedClock implements IClock {
  constructor(private readonly _ms: number) {}
  public now(): Date {
    return new Date(this._ms);
  }
}

function ts(ms: number): Timestamp {
  const result = TimestampService.create(ms);
  if (!result.ok) throw new Error('bad fixture timestamp');
  return result.value;
}

function money(amount: number) {
  const result = MoneyService.create(amount, 'USDC');
  if (!result.ok) throw new Error('bad fixture money');
  return result.value;
}

/** Canonical crypto Up/Down рынок заданной серии. */
function entry(options: {
  id: string;
  asset: string;
  nominalMs: number;
  startOffsetMin: number;
  liquidity: number;
}): MarketDiscoveryEntry {
  const startsAt = ts(BASE_MS + options.startOffsetMin * 60_000);
  const expiresAt = ts(BASE_MS + options.startOffsetMin * 60_000 + options.nominalMs);
  const created = Market.create({
    id: unsafeMarketId(options.id),
    venueId: KnownVenues.POLYMARKET,
    question: `${options.asset.toUpperCase()} Up or Down`,
    startsAt,
    expiresAt,
    state: MarketState.active(),
    outcomes: [
      { index: 0, label: 'Up', instrumentId: unsafeInstrumentId(`${options.id}-up`) },
      { index: 1, label: 'Down', instrumentId: unsafeInstrumentId(`${options.id}-down`) },
    ],
    family: 'CRYPTO_UP_DOWN',
    crypto: {
      asset: unsafeCryptoAssetId(options.asset),
      duration: asMarketDuration(options.nominalMs)!,
    },
  });
  if (!created.ok) throw new Error(`bad market fixture: ${created.error.message}`);
  return { market: created.value, metrics: { liquidity: money(options.liquidity) } };
}

function snapshot(entries: readonly MarketDiscoveryEntry[]): MarketDiscoverySnapshot {
  return {
    observedAt: ts(BASE_MS),
    entries,
    diagnostics: {
      pagesFetched: 1,
      marketsScanned: entries.length,
      tradeableMarkets: entries.length,
      unsupportedMarkets: 0,
      supportedCryptoUpDown: entries.length,
      invalidMarkets: {
        total: 0,
        classification: 0,
        eventUnavailable: 0,
        schedule: 0,
        seriesDuration: 0,
        canonicalMapping: 0,
      },
      duplicateMarkets: 0,
      eventFetches: entries.length,
      eventFetchFailures: 0,
      eventCacheHits: 0,
    },
  };
}

const FIVE_MIN = 5 * 60_000;
const FIFTEEN_MIN = 15 * 60_000;

/** Конфиг экземпляра A: та же стратегия, но BTC на 5-минутной серии. */
const CONFIG_A: PolymarketPolicyConfig = {
  kind: 'POLYMARKET',
  family: 'CRYPTO_UP_DOWN',
  assets: ['btc'],
  durations: ['5m'],
  minLiquidity: { amount: 1000, currency: 'USDC' },
};

/** Конфиг экземпляра B: та же стратегия, но ETH на 15-минутной серии. */
const CONFIG_B: PolymarketPolicyConfig = {
  kind: 'POLYMARKET',
  family: 'CRYPTO_UP_DOWN',
  assets: ['eth'],
  durations: ['15m'],
  minLiquidity: { amount: 1000, currency: 'USDC' },
};

describe('два экземпляра одной стратегии с разными конфигами рынка', () => {
  const filter = new MarketFilter();
  const scorer = new MarketScorer();

  /** Общий universe: обе серии обоих активов плюс заведомо неподходящее. */
  function sharedUniverse(): MarketUniverse {
    const universe = new MarketUniverse(new FixedClock(BASE_MS));
    universe.replace(
      snapshot([
        entry({ id: 'btc-5m', asset: 'btc', nominalMs: FIVE_MIN, startOffsetMin: 5, liquidity: 5000 }),
        entry({ id: 'btc-15m', asset: 'btc', nominalMs: FIFTEEN_MIN, startOffsetMin: 5, liquidity: 5000 }),
        entry({ id: 'eth-5m', asset: 'eth', nominalMs: FIVE_MIN, startOffsetMin: 5, liquidity: 5000 }),
        entry({ id: 'eth-15m', asset: 'eth', nominalMs: FIFTEEN_MIN, startOffsetMin: 5, liquidity: 5000 }),
        entry({ id: 'eth-15m-thin', asset: 'eth', nominalMs: FIFTEEN_MIN, startOffsetMin: 6, liquidity: 1 }),
      ]),
    );
    return universe;
  }

  it('каждый экземпляр выбирает СВОЙ рынок из общего universe', () => {
    const policyA = parsePolicyConfig(CONFIG_A);
    const policyB = parsePolicyConfig(CONFIG_B);
    const universe = sharedUniverse();
    const now = ts(BASE_MS);

    const chosenA = scorer.rank(filter.filter(universe.getAll(), policyA, now));
    const chosenB = scorer.rank(filter.filter(universe.getAll(), policyB, now));

    expect(chosenA.map((e) => String(e.market.id))).toEqual(['btc-5m']);
    expect(chosenB.map((e) => String(e.market.id))).toEqual(['eth-15m']);
  });

  it('конфиг превращается в canonical-типы без конверсии на стороне вызывающего', () => {
    // Перегрузка сужает результат по виду конфига: ручного `kind`-guard не нужно
    const policy = parsePolicyConfig(CONFIG_A);

    // Именно это раньше пришлось бы писать каждому загрузчику руками
    expect(policy.assets).toEqual([unsafeCryptoAssetId('btc')]);
    expect(policy.durations).toEqual([asMarketDuration(FIVE_MIN)]);
    expect(policy.minLiquidity?.currency()).toBe('USDC');
    expect(policy.minLiquidity?.value().toNumber()).toBe(1000);
  });

  it('policy независимы: общего состояния между экземплярами нет', () => {
    const policyA = parsePolicyConfig(CONFIG_A);
    const policyB = parsePolicyConfig(CONFIG_B);

    expect(policyA).not.toBe(policyB);
    expect(policyA.assets).not.toBe(policyB.assets);
    expect(policyA.assets).toEqual([unsafeCryptoAssetId('btc')]);
    expect(policyB.assets).toEqual([unsafeCryptoAssetId('eth')]);
  });

  it('обе policy иммутабельны', () => {
    const policyA = parsePolicyConfig(CONFIG_A);

    expect(Object.isFrozen(policyA)).toBe(true);
    expect(() => {
      (policyA as { family: string }).family = 'BINARY_OUTCOME';
    }).toThrow(TypeError);
  });

  it('повторный разбор того же конфига даёт равные, но НЕ те же policy', () => {
    // Экземпляры стратегии живут независимо: общий объект policy означал бы,
    // что правка конфигурации одного экземпляра меняет поведение другого
    const first = parsePolicyConfig(CONFIG_A);
    const second = parsePolicyConfig(CONFIG_A);

    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });

  it('конфиг не мутируется разбором: его можно переиспользовать', () => {
    const before = JSON.stringify(CONFIG_A);
    parsePolicyConfig(CONFIG_A);
    parsePolicyConfig(CONFIG_A);

    expect(JSON.stringify(CONFIG_A)).toBe(before);
  });
});
