/**
 * Shared RTDS-фиды: ref-count ПО РЫНКАМ и идентичность фида с окном TWAP.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { PolymarketSubscriptionController } from '../src/index.js';
import {
  AT_1757_MS,
  BTC_BINANCE_FEED,
  BTC_TWAP_30_FEED,
  BTC_TWAP_60_FEED,
  CapturingLogger,
  FakeDiscovery,
  FakeSource,
  MutableClock,
  deferred,
  makeEntry,
} from './helpers/fakes.js';
import type { PolymarketRtdsFeed } from '@polymarket/polymarket-v2';
import type { MarketDiscoveryEntry } from '@polymarket/ports';

describe('shared RTDS-фиды', () => {
  let clock: MutableClock;
  let discovery: FakeDiscovery;
  let source: FakeSource;
  let controller: PolymarketSubscriptionController;

  beforeEach(() => {
    clock = new MutableClock(AT_1757_MS);
    discovery = new FakeDiscovery();
    source = new FakeSource();
    controller = new PolymarketSubscriptionController({
      discovery,
      source,
      clock,
      logger: new CapturingLogger(),
    });
  });

  /** Регистрирует рынок с ТОЧНЫМ набором фидов. */
  function preparedWith(id: string, rtdsFeeds: readonly PolymarketRtdsFeed[]): MarketDiscoveryEntry {
    const entry = makeEntry({ id });
    discovery.register(entry, { rtdsFeeds });
    return entry;
  }

  it('два рынка на одном фиде → ОДНА подписка, refCount = 2', async () => {
    const x = preparedWith('market-x', [BTC_BINANCE_FEED]);
    const y = preparedWith('market-y', [BTC_BINANCE_FEED]);

    await controller.acquire('strategy:A', x);
    await controller.acquire('collector:raw', y);

    expect(source.cryptoCalls).toHaveLength(1);
    expect(controller.getStats().rtdsFeeds).toEqual([
      { topic: 'prices.crypto.binance', symbol: 'btcusdt', refCount: 2 },
    ]);
  });

  it('ref держит РЫНОК, а не владелец: второй владелец не увеличивает счётчик', async () => {
    const x = preparedWith('market-x', [BTC_BINANCE_FEED]);

    await controller.acquire('strategy:A', x);
    await controller.acquire('collector:raw', x);

    expect(controller.getStats().rtdsFeeds[0]?.refCount).toBe(1);
    expect(controller.getStats().claims).toBe(2);
  });

  it('снятие первого рынка оставляет фид живым, снятие второго закрывает', async () => {
    const x = preparedWith('market-x', [BTC_BINANCE_FEED]);
    const y = preparedWith('market-y', [BTC_BINANCE_FEED]);
    await controller.acquire('strategy:A', x);
    await controller.acquire('collector:raw', y);
    const feed = source.issued.find((subscription) => subscription.label.startsWith('prices.'));

    await controller.release('strategy:A', x.market.id);

    expect(feed?.closeCalls).toBe(0);
    expect(controller.getStats().rtdsFeeds[0]?.refCount).toBe(1);

    await controller.release('collector:raw', y.market.id);

    expect(feed?.closeCalls).toBe(1);
    expect(controller.getStats().rtdsFeeds).toEqual([]);
  });

  it('конкурентное приобретение одного фида двумя рынками → одна подписка', async () => {
    const x = preparedWith('market-x', [BTC_BINANCE_FEED]);
    const y = preparedWith('market-y', [BTC_BINANCE_FEED]);
    const hold = deferred();
    source.rtdsHold = hold.promise;

    const first = controller.acquire('strategy:A', x);
    const second = controller.acquire('collector:raw', y);
    await Promise.resolve();
    hold.resolve();

    expect(await first).toMatchObject({ status: 'opened' });
    expect(await second).toMatchObject({ status: 'opened' });
    expect(source.cryptoCalls).toHaveLength(1);
    expect(controller.getStats().rtdsFeeds[0]?.refCount).toBe(2);
  });

  it('TWAP 30 и TWAP 60 — РАЗНЫЕ фиды одного символа', async () => {
    const x = preparedWith('market-x', [BTC_TWAP_30_FEED]);
    const y = preparedWith('market-y', [BTC_TWAP_60_FEED]);

    await controller.acquire('strategy:A', x);
    await controller.acquire('strategy:B', y);

    expect(source.twapCalls).toEqual([
      { windowSeconds: 30, symbols: ['btc/usd'] },
      { windowSeconds: 60, symbols: ['btc/usd'] },
    ]);
    expect(controller.getStats().rtdsFeeds).toEqual([
      {
        topic: 'prices.crypto.chainlink.twap',
        symbol: 'btc/usd',
        windowSeconds: 30,
        refCount: 1,
      },
      {
        topic: 'prices.crypto.chainlink.twap',
        symbol: 'btc/usd',
        windowSeconds: 60,
        refCount: 1,
      },
    ]);
  });

  it('settlement-поток открывается СВОИМ методом источника, а не spot-подпиской', async () => {
    const x = preparedWith('market-x', [BTC_TWAP_60_FEED]);

    await controller.acquire('strategy:A', x);

    expect(source.cryptoCalls).toHaveLength(0);
    expect(source.twapCalls).toHaveLength(1);
  });

  it('отказ одного фида не трогает рынки, держащие остальные', async () => {
    const shared = preparedWith('market-shared', [BTC_BINANCE_FEED]);
    await controller.acquire('collector:raw', shared);
    source.rtdsErrorSymbols.add('btc/usd');
    const failing = preparedWith('market-failing', [BTC_BINANCE_FEED, BTC_TWAP_30_FEED]);

    const failure = await controller.acquire('strategy:A', failing);

    expect(failure).toMatchObject({ status: 'failed', stage: 'rtds-subscription' });
    // Общий фид остался у первого рынка, его подписка не закрывалась
    expect(controller.getStats().rtdsFeeds).toEqual([
      { topic: 'prices.crypto.binance', symbol: 'btcusdt', refCount: 1 },
    ]);
    expect(controller.listSubscriptions().map((item) => String(item.marketId))).toEqual([
      'market-shared',
    ]);
    expect(source.cryptoCalls).toHaveLength(1); // вторая подписка на общий фид не открывалась
  });
});
