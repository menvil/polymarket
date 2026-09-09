/**
 * Идентичность рядов референсных цен.
 *
 * @remarks
 * Самая дорогая ошибка здесь — тихое склеивание. Если BTC/USD и BTC/USDT
 * попадут в один ряд, стратегия увидит скачки, которых не было; если
 * склеятся SPOT и TWAP — увидит сглаживание, которого не просила. Ни то, ни
 * другое не проявится ошибкой, поэтому проверяется явно.
 */
import { describe, expect, it } from '@jest/globals';
import { EventBus } from '@polymarket/event-bus';
import { PaperClock } from '@polymarket/time';
import { isErr } from '@polymarket/result';
import type { MarketDataSourceId } from '@polymarket/ids';
import { TradingStateProjector } from '../src/index.js';
import type { ReferencePriceSeriesKey } from '../src/index.js';
import { EventFactory, asset, retention, silentLogger } from './helpers/fixtures.js';

const SOURCE_A = 'source-a' as MarketDataSourceId;
const SOURCE_B = 'source-b' as MarketDataSourceId;

describe('J. Идентичность фидов референсных цен', () => {
  it('пять различающихся фидов дают пять отдельных рядов', async () => {
    const bus = new EventBus(silentLogger);
    const created = TradingStateProjector.create(bus, retention(), new PaperClock(new Date(0)));
    if (isErr(created)) throw created.error;
    const projector = created.value;
    projector.start();
    const view = projector.state();
    const events = new EventFactory();

    const BTC = asset('BTC');
    const USD = asset('USD');
    const USDT = asset('USDT');
    const feeds: readonly ReferencePriceSeriesKey[] = [
      { sourceId: SOURCE_A, baseAsset: BTC, quoteAsset: USD, kind: 'SPOT' },
      { sourceId: SOURCE_A, baseAsset: BTC, quoteAsset: USDT, kind: 'SPOT' },
      { sourceId: SOURCE_A, baseAsset: BTC, quoteAsset: USD, kind: 'TWAP', windowSeconds: 30 },
      { sourceId: SOURCE_A, baseAsset: BTC, quoteAsset: USD, kind: 'TWAP', windowSeconds: 60 },
      { sourceId: SOURCE_B, baseAsset: BTC, quoteAsset: USD, kind: 'SPOT' },
    ];

    let observedAt = 1_000;
    for (const [index, feed] of feeds.entries()) {
      events.observeAt(observedAt);
      await bus.publish(
        events.referencePrice({
          sourceId: feed.sourceId,
          baseAsset: feed.baseAsset,
          quoteAsset: feed.quoteAsset,
          feed:
            feed.kind === 'TWAP'
              ? { kind: 'TWAP', windowSeconds: feed.windowSeconds }
              : { kind: 'SPOT' },
          // Вендорское имя специально одинаковое: оно provenance, а не
          // идентичность, и склеивать по нему нельзя.
          nativeSymbol: 'BTCUSD',
          value: 70_000 + index,
          venueTimestampMs: observedAt - 50,
          receivedAtMs: observedAt - 10,
        }),
      );
      observedAt += 100;
    }

    expect(view.referencePriceSeriesKeys()).toHaveLength(5);
    expect(view.referencePriceSourceIds()).toHaveLength(2);
    expect(view.getVersion()).toBe(5);

    // Каждый ряд содержит РОВНО своё наблюдение.
    for (const [index, key] of feeds.entries()) {
      const series = view.getReferencePriceSeries(key);
      expect(series?.size()).toBe(1);
      expect(series?.getLatest()?.value.value().toNumber()).toBeCloseTo(70_000 + index, 6);
    }
  });

  it('наблюдение сохраняет оба времени площадки', async () => {
    const bus = new EventBus(silentLogger);
    const created = TradingStateProjector.create(bus, retention(), new PaperClock(new Date(0)));
    if (isErr(created)) throw created.error;
    const projector = created.value;
    projector.start();
    const events = new EventFactory();

    events.observeAt(5_000);
    await bus.publish(
      events.referencePrice({
        sourceId: SOURCE_A,
        baseAsset: asset('ETH'),
        quoteAsset: asset('USD'),
        nativeSymbol: 'ETHUSD',
        feed: { kind: 'SPOT' },
        value: 3_000,
        venueTimestampMs: 4_800,
        receivedAtMs: 4_900,
      }),
    );

    const observation = projector
      .state()
      .getReferencePriceSeries({
        sourceId: SOURCE_A,
        baseAsset: asset('ETH'),
        quoteAsset: asset('USD'),
        kind: 'SPOT',
      })
      ?.getLatest();
    expect(observation?.venueTimestamp.toNumber()).toBe(4_800);
    expect(observation?.receivedAt.toNumber()).toBe(4_900);
    expect(observation?.observedAt.toNumber()).toBe(5_000);
  });
});

describe('Контракт ReferencePriceSeriesKey (compile-time)', () => {
  it('TWAP без окна усреднения не представим типом', () => {
    const identity = {
      sourceId: SOURCE_A,
      baseAsset: asset('BTC'),
      quoteAsset: asset('USD'),
    };

    // Оба варианта собираются только с обязательными для них полями.
    const spot: ReferencePriceSeriesKey = { ...identity, kind: 'SPOT' };
    const twap: ReferencePriceSeriesKey = { ...identity, kind: 'TWAP', windowSeconds: 30 };

    // @ts-expect-error — у TWAP окно усреднения обязано существовать.
    const broken: ReferencePriceSeriesKey = { ...identity, kind: 'TWAP' };
    void broken;

    // @ts-expect-error — у SPOT окна усреднения не бывает.
    const alsoBroken: ReferencePriceSeriesKey = { ...identity, kind: 'SPOT', windowSeconds: 30 };
    void alsoBroken;

    // Сужение по `kind` даёт доступ к окну только в ветке TWAP.
    expect(spot.kind === 'SPOT').toBe(true);
    expect(twap.kind === 'TWAP' ? twap.windowSeconds : undefined).toBe(30);
  });
});
