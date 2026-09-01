/**
 * Приёмочный тест контура: universe → policy → filter → scorer.
 *
 * @remarks
 * Отдельные правила отбора и порядка проверяются в `MarketFilter.test.ts` и
 * `MarketScorer.test.ts`. Здесь проверяется то, чего не видно ни в одном из
 * них по отдельности: что цепочка СОБИРАЕТСЯ, что через неё проходят только
 * canonical-записи, и что порядок ответственностей именно такой — сначала
 * «подходит ли», затем «в каком порядке».
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
import { MarketFilter, MarketScorer, createPolymarketPolicy } from '../src/index.js';

const BASE_MS = Date.parse('2026-09-01T18:00:00.000Z');
const BTC = unsafeCryptoAssetId('btc');
const ETH = unsafeCryptoAssetId('eth');
const FIVE_MIN = asMarketDuration(5 * 60_000)!;
const FIFTEEN_MIN = asMarketDuration(15 * 60_000)!;

/** Часы, остановленные на фиксированном моменте. */
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

/** Canonical crypto Up/Down рынок с заданной серией и окном. */
function entry(options: {
  id: string;
  asset: typeof BTC;
  nominal: typeof FIVE_MIN;
  startOffsetMin: number;
  windowMin: number;
  liquidity: number;
  question?: string;
}): MarketDiscoveryEntry {
  const startsAt = ts(BASE_MS + options.startOffsetMin * 60_000);
  const expiresAt = ts(BASE_MS + (options.startOffsetMin + options.windowMin) * 60_000);
  const created = Market.create({
    id: unsafeMarketId(options.id),
    venueId: KnownVenues.POLYMARKET,
    question: options.question ?? `${options.id} Up or Down`,
    startsAt,
    expiresAt,
    state: MarketState.active(),
    outcomes: [
      { index: 0, label: 'Up', instrumentId: unsafeInstrumentId(`${options.id}-up`) },
      { index: 1, label: 'Down', instrumentId: unsafeInstrumentId(`${options.id}-down`) },
    ],
    family: 'CRYPTO_UP_DOWN',
    crypto: { asset: options.asset, duration: options.nominal },
  });
  if (!created.ok) throw new Error(`bad market fixture: ${created.error.message}`);
  return { market: created.value, metrics: { liquidity: money(options.liquidity) } };
}

/** Снимок discovery из готовых записей. */
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

describe('universe → policy → filter → scorer', () => {
  const filter = new MarketFilter();
  const scorer = new MarketScorer();

  /** Смешанный universe: два актива, два номинала, разные окна и ликвидность. */
  function mixedUniverse(): MarketUniverse {
    const universe = new MarketUniverse(new FixedClock(BASE_MS));
    universe.replace(
      snapshot([
        entry({ id: 'btc-5m-late', asset: BTC, nominal: FIVE_MIN, startOffsetMin: 10, windowMin: 5, liquidity: 9000 }),
        entry({ id: 'btc-5m-soon', asset: BTC, nominal: FIVE_MIN, startOffsetMin: 5, windowMin: 5, liquidity: 100 }),
        entry({ id: 'btc-15m', asset: BTC, nominal: FIFTEEN_MIN, startOffsetMin: 5, windowMin: 15, liquidity: 8000 }),
        entry({ id: 'eth-5m', asset: ETH, nominal: FIVE_MIN, startOffsetMin: 5, windowMin: 5, liquidity: 9999 }),
        entry({ id: 'btc-5m-thin', asset: BTC, nominal: FIVE_MIN, startOffsetMin: 6, windowMin: 5, liquidity: 10 }),
      ]),
    );
    return universe;
  }

  it('приёмочный сценарий: BTC 5m с порогом ликвидности, упорядоченные по старту', () => {
    const universe = mixedUniverse();
    const policy = createPolymarketPolicy({
      kind: 'POLYMARKET',
      family: 'CRYPTO_UP_DOWN',
      assets: [BTC],
      durations: [FIVE_MIN],
      minLiquidity: money(50),
    });

    const matched = filter.filter(universe.getAll(), policy, ts(BASE_MS));
    const ranked = scorer.rank(matched);

    // eth-5m отсеян активом, btc-15m — номиналом, btc-5m-thin — ликвидностью
    expect(ranked.map((e) => String(e.market.id))).toEqual(['btc-5m-soon', 'btc-5m-late']);
    // Ликвидность 100 против 9000 НЕ перебивает более ранний старт
    expect(String(ranked[0]!.market.id)).toBe('btc-5m-soon');
  });

  it('через контур проходят ТОЛЬКО canonical-записи universe', () => {
    const universe = mixedUniverse();
    const policy = createPolymarketPolicy({ kind: 'POLYMARKET', family: 'CRYPTO_UP_DOWN' });

    const ranked = scorer.rank(filter.filter(universe.getAll(), policy, ts(BASE_MS)));

    for (const item of ranked) {
      expect(Object.keys(item).sort()).toEqual(['market', 'metrics']);
      expect(item.market).toBeInstanceOf(Market);
      // Ни численного score, ни vendor-полей контур не добавляет
      for (const leaked of ['score', 'sdkMarket', 'gammaMarket', 'rawMarket']) {
        expect(item).not.toHaveProperty(leaked);
        expect(item.market).not.toHaveProperty(leaked);
      }
    }
  });

  it('policy без селекторов пропускает весь universe, меняя только порядок', () => {
    const universe = mixedUniverse();
    const policy = createPolymarketPolicy({ kind: 'POLYMARKET', family: 'CRYPTO_UP_DOWN' });

    const ranked = scorer.rank(filter.filter(universe.getAll(), policy, ts(BASE_MS)));

    expect(ranked).toHaveLength(universe.getAll().length);
    expect(new Set(ranked)).toEqual(new Set(universe.getAll()));
  });

  it('контур не мутирует СОДЕРЖИМОЕ universe', () => {
    // Сравнивать `getAll()` по ссылке бессмысленно: universe отдаёт один и
    // тот же замороженный массив, поэтому такая проверка тавтологична и
    // не падает никогда. Регрессию ловит только снимок СОДЕРЖИМОГО: и то,
    // что записи не подменены, и то, что им ничего не дописали (например,
    // численный `score`, от которого контур как раз отказался).
    const universe = mixedUniverse();
    const policy = createPolymarketPolicy({
      kind: 'POLYMARKET',
      family: 'CRYPTO_UP_DOWN',
      assets: [BTC],
    });

    /** Полный слепок записи: identity, расписание, спецификация, метрики, набор ключей. */
    const describe_ = (entries: readonly MarketDiscoveryEntry[]): unknown =>
      entries.map((e) => ({
        entryKeys: Object.keys(e).sort(),
        marketKeys: Object.keys(e.market).sort(),
        metricsKeys: Object.keys(e.metrics).sort(),
        id: String(e.market.id),
        venueId: String(e.market.venueId),
        startsAt: e.market.startsAt.toISO(),
        expiresAt: e.market.expiresAt.toISO(),
        nominal: e.market.crypto?.duration,
        asset: String(e.market.crypto?.asset),
        liquidity: e.metrics.liquidity.value().toString(),
        spread: e.metrics.spread?.toDecimal().toString(),
      }));

    const before = describe_(universe.getAll());

    scorer.rank(filter.filter(universe.getAll(), policy, ts(BASE_MS)));

    expect(describe_(universe.getAll())).toEqual(before);
  });

  it('контур ничего не дописывает записям universe', () => {
    const universe = mixedUniverse();
    const policy = createPolymarketPolicy({ kind: 'POLYMARKET', family: 'CRYPTO_UP_DOWN' });

    scorer.rank(filter.filter(universe.getAll(), policy, ts(BASE_MS)));

    for (const item of universe.getAll()) {
      // `in` покрывает и прототип: дописанное свойство не спрячется
      expect('score' in item).toBe(false);
      expect('score' in item.market).toBe(false);
      expect('score' in item.metrics).toBe(false);
      expect(Object.keys(item).sort()).toEqual(['market', 'metrics']);
    }
  });

  it('будущая оценка: policy проверяется в момент старта КОНКРЕТНОГО рынка', () => {
    // Именно так следующий MR будет отбирать будущие рынки: сама policy
    // начинает действовать позже «сейчас», но к старту рынка уже действует
    const universe = mixedUniverse();
    const policy = createPolymarketPolicy({
      kind: 'POLYMARKET',
      family: 'CRYPTO_UP_DOWN',
      assets: [BTC],
      durations: [FIVE_MIN],
      effectiveFrom: ts(BASE_MS + 8 * 60_000),
    });

    const nowMatched = filter.filter(universe.getAll(), policy, ts(BASE_MS));
    const futureMatched = universe
      .getAll()
      .filter((e) => filter.matches(e, policy, e.market.startsAt));

    expect(nowMatched).toHaveLength(0); // сейчас policy ещё не действует
    expect(futureMatched.map((e) => String(e.market.id))).toEqual(['btc-5m-late']);
  });
});
