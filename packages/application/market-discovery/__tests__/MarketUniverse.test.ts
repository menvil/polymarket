/**
 * Поведенческие тесты `MarketUniverse`: замена снимка целиком, lookup по
 * ПАРЕ `venueId + marketId`, иммутабельность отдаваемых структур.
 *
 * @remarks
 * Universe — source of truth Application: если его можно тихо мутировать
 * снаружи или если lookup игнорирует площадку, всё, что построено сверху
 * (policy, подписки, риск), опирается на состояние, которого площадка
 * никогда не наблюдала. Поэтому оба свойства проверяются явно.
 */
import { describe, it, expect } from '@jest/globals';
import type { IClock } from '@polymarket/time';
import { Market, MarketState, asMarketDuration } from '@polymarket/market';
import { KnownVenues, asVenueId, unsafeCryptoAssetId, unsafeInstrumentId, unsafeMarketId } from '@polymarket/ids';
import { TimestampService } from '@polymarket/timestamp';
import { Money } from '@polymarket/value-objects';
import type {
  MarketDiscoveryEntry,
  MarketDiscoverySnapshot,
} from '@polymarket/ports';
import Decimal from 'decimal.js';
import { MarketUniverse } from '../src/index.js';

/** Фиксированное «сейчас» тестов (2026-08-19T12:00:00Z). */
const FIXED_NOW_MS = Date.parse('2026-08-19T12:00:00.000Z');

/** Управляемые часы. */
class FixedClock implements IClock {
  constructor(private _nowMs: number = FIXED_NOW_MS) {}
  public now(): Date {
    return new Date(this._nowMs);
  }
  public advance(deltaMs: number): void {
    this._nowMs += deltaMs;
  }
}

/** Собирает canonical crypto Up/Down рынок для снимка. */
function createMarket(id: string, startOffsetMin = 10, venueId = KnownVenues.POLYMARKET): Market {
  const startsAt = TimestampService.create(FIXED_NOW_MS + startOffsetMin * 60_000);
  const expiresAt = TimestampService.create(FIXED_NOW_MS + (startOffsetMin + 5) * 60_000);
  if (!startsAt.ok || !expiresAt.ok) throw new Error('bad schedule fixture');
  const created = Market.create({
    id: unsafeMarketId(id),
    venueId,
    question: `Bitcoin Up or Down — ${id}`,
    startsAt: startsAt.value,
    expiresAt: expiresAt.value,
    state: MarketState.active(),
    outcomes: [
      { index: 0, label: 'Up', instrumentId: unsafeInstrumentId(`${id}-up`) },
      { index: 1, label: 'Down', instrumentId: unsafeInstrumentId(`${id}-down`) },
    ],
    family: 'CRYPTO_UP_DOWN',
    crypto: { asset: unsafeCryptoAssetId('btc'), duration: asMarketDuration(5 * 60_000)! },
  });
  if (!created.ok) throw new Error(`bad market fixture: ${created.error.message}`);
  return created.value;
}

/** Собирает снимок из готовых рынков. */
function createSnapshot(markets: readonly Market[], observedAtMs = FIXED_NOW_MS): MarketDiscoverySnapshot {
  const observedAt = TimestampService.create(observedAtMs);
  if (!observedAt.ok) throw new Error('bad observedAt fixture');
  const entries: MarketDiscoveryEntry[] = markets.map((market) => ({
    market,
    metrics: { liquidity: Money.of(new Decimal(1000), 'USDC') },
  }));
  return {
    observedAt: observedAt.value,
    entries,
    diagnostics: {
      pagesFetched: 1,
      marketsScanned: markets.length,
      tradeableMarkets: markets.length,
      unsupportedMarkets: 0,
      supportedCryptoUpDown: markets.length,
      invalidMarkets: {
        total: 0,
        classification: 0,
        eventUnavailable: 0,
        schedule: 0,
        seriesDuration: 0,
        canonicalMapping: 0,
      },
      duplicateMarkets: 0,
      eventFetches: markets.length,
      eventFetchFailures: 0,
      eventCacheHits: 0,
    },
  };
}

describe('стартовое состояние', () => {
  it('пуст и датирован моментом создания', () => {
    const universe = new MarketUniverse(new FixedClock());
    const snapshot = universe.getSnapshot();

    expect(universe.getAll()).toEqual([]);
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.observedAt.toNumber()).toBe(FIXED_NOW_MS);
    expect(snapshot.diagnostics.supportedCryptoUpDown).toBe(0);
  });

  it('lookup по неизвестному рынку возвращает undefined', () => {
    const universe = new MarketUniverse(new FixedClock());

    expect(universe.get(KnownVenues.POLYMARKET, unsafeMarketId('missing'))).toBeUndefined();
  });
});

describe('replace: снимок заменяется целиком', () => {
  it('после replace доступны записи снимка через get/getAll/getSnapshot', () => {
    const universe = new MarketUniverse(new FixedClock());
    const btc = createMarket('btc-1200');
    const eth = createMarket('eth-1200', 20);

    universe.replace(createSnapshot([btc, eth]));

    expect(universe.getAll().map((entry) => String(entry.market.id))).toEqual([
      'btc-1200',
      'eth-1200',
    ]);
    expect(universe.get(KnownVenues.POLYMARKET, btc.id)?.market).toBe(btc);
    expect(universe.getSnapshot().entries).toHaveLength(2);
    expect(universe.getSnapshot().diagnostics.supportedCryptoUpDown).toBe(2);
  });

  it('старые записи исчезают, новые появляются', () => {
    const universe = new MarketUniverse(new FixedClock());
    const oldMarket = createMarket('btc-1200');
    const newMarket = createMarket('btc-1205', 15);

    universe.replace(createSnapshot([oldMarket]));
    universe.replace(createSnapshot([newMarket], FIXED_NOW_MS + 60_000));

    expect(universe.get(KnownVenues.POLYMARKET, oldMarket.id)).toBeUndefined();
    expect(universe.get(KnownVenues.POLYMARKET, newMarket.id)?.market).toBe(newMarket);
    expect(universe.getAll()).toHaveLength(1);
    expect(universe.getSnapshot().observedAt.toNumber()).toBe(FIXED_NOW_MS + 60_000);
  });

  it('пустой снимок очищает universe', () => {
    const universe = new MarketUniverse(new FixedClock());
    universe.replace(createSnapshot([createMarket('btc-1200')]));

    universe.replace(createSnapshot([]));

    expect(universe.getAll()).toEqual([]);
  });
});

describe('идентичность рынка — ПАРА venueId + marketId', () => {
  it('одинаковый marketId на разных площадках — разные рынки', () => {
    const universe = new MarketUniverse(new FixedClock());
    const kalshi = asVenueId('KALSHI')!;
    const onPolymarket = createMarket('btc-1200');
    const onKalshi = createMarket('btc-1200', 10, kalshi);

    universe.replace(createSnapshot([onPolymarket, onKalshi]));

    expect(universe.get(KnownVenues.POLYMARKET, onPolymarket.id)?.market).toBe(onPolymarket);
    expect(universe.get(kalshi, onKalshi.id)?.market).toBe(onKalshi);
    expect(universe.getAll()).toHaveLength(2);
  });

  it('lookup чужой площадкой не находит рынок', () => {
    const universe = new MarketUniverse(new FixedClock());
    const market = createMarket('btc-1200');
    universe.replace(createSnapshot([market]));

    expect(universe.get(asVenueId('KALSHI')!, market.id)).toBeUndefined();
  });

  it('дубликат схлопывается во ВСЕХ представлениях: побеждает первая запись', () => {
    const universe = new MarketUniverse(new FixedClock());
    const first = createMarket('btc-1200');
    const second = createMarket('btc-1200', 25);

    universe.replace(createSnapshot([first, second]));

    expect(universe.get(KnownVenues.POLYMARKET, first.id)?.market).toBe(first);
    expect(universe.getAll()).toHaveLength(1);
    expect(universe.getAll()[0]!.market).toBe(first);
    expect(universe.getSnapshot().entries).toHaveLength(1);
  });

  it('lookup и getAll отдают ОДИН объект записи — представления не могут разойтись', () => {
    const universe = new MarketUniverse(new FixedClock());
    const first = createMarket('btc-1200');
    const second = createMarket('btc-1200', 25);

    universe.replace(createSnapshot([first, second]));

    expect(universe.get(KnownVenues.POLYMARKET, first.id)).toBe(universe.getAll()[0]);
  });

  it('дедупликация сохраняет технический порядок остальных записей', () => {
    const universe = new MarketUniverse(new FixedClock());
    const btc = createMarket('btc-1200');
    const eth = createMarket('eth-1200', 20);
    const btcDuplicate = createMarket('btc-1200', 25);

    universe.replace(createSnapshot([btc, eth, btcDuplicate]));

    expect(universe.getAll().map((entry) => String(entry.market.id))).toEqual([
      'btc-1200',
      'eth-1200',
    ]);
  });

  it('от дубликата побеждает первая запись целиком — вместе с её metrics', () => {
    const universe = new MarketUniverse(new FixedClock());
    const snapshot = createSnapshot([createMarket('btc-1200'), createMarket('btc-1200', 25)]);
    (snapshot.entries[1]!.metrics as { liquidity: Money }).liquidity = Money.of(
      new Decimal(777),
      'USDC',
    );

    universe.replace(snapshot);

    expect(universe.getAll()[0]!.metrics.liquidity.value().toNumber()).toBe(1000);
  });

  it('diagnostics НЕ пересчитываются: они описывают обход discovery, а не содержимое universe', () => {
    const universe = new MarketUniverse(new FixedClock());
    const first = createMarket('btc-1200');
    const second = createMarket('btc-1200', 25);

    // createSnapshot проставляет supportedCryptoUpDown = числу поданных рынков (2),
    // хотя после дедупликации в universe остаётся одна запись.
    universe.replace(createSnapshot([first, second]));

    expect(universe.getSnapshot().diagnostics.supportedCryptoUpDown).toBe(2);
    expect(universe.getAll()).toHaveLength(1);
  });
});

describe('иммутабельность source of truth', () => {
  it('мутация исходного массива снимка не меняет universe', () => {
    const universe = new MarketUniverse(new FixedClock());
    const snapshot = createSnapshot([createMarket('btc-1200')]);
    universe.replace(snapshot);

    (snapshot.entries as MarketDiscoveryEntry[]).push({
      market: createMarket('sneaked-in', 40),
      metrics: { liquidity: Money.of(new Decimal(0), 'USDC') },
    });

    expect(universe.getAll()).toHaveLength(1);
  });

  it('getAll возвращает замороженный массив — caller не мутирует universe', () => {
    const universe = new MarketUniverse(new FixedClock());
    universe.replace(createSnapshot([createMarket('btc-1200')]));

    const all = universe.getAll();

    expect(Object.isFrozen(all)).toBe(true);
    expect(() => (all as MarketDiscoveryEntry[]).pop()).toThrow(TypeError);
    expect(universe.getAll()).toHaveLength(1);
  });

  it('getSnapshot возвращает замороженный снимок и замороженную диагностику', () => {
    const universe = new MarketUniverse(new FixedClock());
    universe.replace(createSnapshot([createMarket('btc-1200')]));

    const snapshot = universe.getSnapshot();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.diagnostics)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
  });

  it('вложенный разбор причин диагностики тоже копируется и заморожен', () => {
    const universe = new MarketUniverse(new FixedClock());
    const snapshot = createSnapshot([createMarket('btc-1200')]);
    universe.replace(snapshot);

    (snapshot.diagnostics.invalidMarkets as { total: number }).total = 42;

    const stored = universe.getSnapshot().diagnostics.invalidMarkets;
    expect(stored.total).toBe(0);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(() => {
      (stored as { total: number }).total = 7;
    }).toThrow(TypeError);
  });

  it('мутация диагностики исходного снимка не отражается на universe', () => {
    const universe = new MarketUniverse(new FixedClock());
    const snapshot = createSnapshot([createMarket('btc-1200')]);
    universe.replace(snapshot);

    (snapshot.diagnostics as { supportedCryptoUpDown: number }).supportedCryptoUpDown = 99;

    expect(universe.getSnapshot().diagnostics.supportedCryptoUpDown).toBe(1);
  });

  it('мутация metrics исходной записи ПОСЛЕ replace не меняет universe', () => {
    const universe = new MarketUniverse(new FixedClock());
    const snapshot = createSnapshot([createMarket('btc-1200')]);
    universe.replace(snapshot);

    (snapshot.entries[0]!.metrics as { liquidity: Money }).liquidity = Money.of(
      new Decimal(999),
      'USDC',
    );

    expect(universe.getAll()[0]!.metrics.liquidity.value().toNumber()).toBe(1000);
  });

  it('replace не замораживает данные вызывающего — снимок остаётся его собственностью', () => {
    const universe = new MarketUniverse(new FixedClock());
    const snapshot = createSnapshot([createMarket('btc-1200')]);
    const callerEntry = snapshot.entries[0]!;

    universe.replace(snapshot);

    expect(Object.isFrozen(callerEntry)).toBe(false);
    expect(Object.isFrozen(callerEntry.metrics)).toBe(false);
    expect(Object.isFrozen(snapshot.entries)).toBe(false);
  });

  it('запись из getAll заморожена вместе с metrics — мутация бросает TypeError', () => {
    const universe = new MarketUniverse(new FixedClock());
    universe.replace(createSnapshot([createMarket('btc-1200')]));

    const entry = universe.getAll()[0]!;

    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.metrics)).toBe(true);
    expect(() => {
      (entry.metrics as { liquidity: Money }).liquidity = Money.of(new Decimal(0), 'USDC');
    }).toThrow(TypeError);
    expect(universe.getAll()[0]!.metrics.liquidity.value().toNumber()).toBe(1000);
  });

  it('запись из get заморожена вместе с metrics — мутация бросает TypeError', () => {
    const universe = new MarketUniverse(new FixedClock());
    const market = createMarket('btc-1200');
    universe.replace(createSnapshot([market]));

    const entry = universe.get(KnownVenues.POLYMARKET, market.id)!;

    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.metrics)).toBe(true);
    expect(() => {
      (entry as { market: Market }).market = createMarket('other', 30);
    }).toThrow(TypeError);
    expect(universe.get(KnownVenues.POLYMARKET, market.id)?.market).toBe(market);
  });

  it('Market остаётся той же ссылкой — копируется запись, не доменная сущность', () => {
    const universe = new MarketUniverse(new FixedClock());
    const market = createMarket('btc-1200');
    const snapshot = createSnapshot([market]);

    universe.replace(snapshot);

    expect(universe.getAll()[0]!.market).toBe(market);
    expect(universe.getAll()[0]).not.toBe(snapshot.entries[0]);
    expect(universe.getAll()[0]!.metrics).not.toBe(snapshot.entries[0]!.metrics);
  });
});
