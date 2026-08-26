/**
 * Lifecycle settlement-фида: shared ref-count по ОКНУ и boundary grace (MR-B).
 *
 * @remarks
 * Два инварианта, которые проверяются здесь, нельзя проверить по отдельности
 * в юнитах ключа фида:
 *
 * 1. один физический поток на все рынки, которым он нужен, и ОТДЕЛЬНЫЙ поток
 *    на каждое окно — иначе рынок получал бы наблюдения чужого расчёта;
 * 2. датасет истёкшего рынка не замораживается, пока не получено граничное
 *    наблюдение (или не истёк измеренный grace) — иначе теряется ровно то
 *    наблюдение, по которому рынок и резолвится.
 */
import { describe, expect, it, jest } from '@jest/globals';
import type { PolymarketRtdsFeed, PolymarketTwapRtdsFeed } from '@polymarket/polymarket-v2';
import { MarketCollectionCoordinator } from '../src/index.js';
import type { CollectionSettlementObserver } from '../src/index.js';
import {
  BTC_TWAP_FEEDS,
  BTC_TWAP_SETTLEMENT,
  CID_A,
  CID_B,
  CapturingLogger,
  FakeCollectionRecorder,
  FakeCollectionSource,
  FakeDiscovery,
  FixedClock,
  NOW_MS,
  CallLog,
  mid,
} from './helpers/fakes.js';

const TWAP_60: PolymarketTwapRtdsFeed = {
  topic: 'prices.crypto.chainlink.twap',
  symbol: 'btc/usd',
  windowSeconds: 60,
};
const TWAP_30: PolymarketTwapRtdsFeed = {
  topic: 'prices.crypto.chainlink.twap',
  symbol: 'btc/usd',
  windowSeconds: 30,
};

/** Наблюдатель, отвечающий по программируемому флагу. */
class FakeSettlementObserver implements CollectionSettlementObserver {
  public boundaryReached = false;
  public readonly queries: string[] = [];

  public hasObservationAtOrAfter(feed: PolymarketTwapRtdsFeed, atMs: number): boolean {
    this.queries.push(`${feed.symbol}@${String(feed.windowSeconds)}:${String(atMs)}`);
    return this.boundaryReached;
  }
}

interface HarnessOptions {
  readonly settlementGraceMs?: number;
  readonly observer?: CollectionSettlementObserver;
}

function createHarness(options: HarnessOptions = {}) {
  const log = new CallLog();
  const discovery = new FakeDiscovery(log);
  const source = new FakeCollectionSource(log);
  const recorder = new FakeCollectionRecorder(log);
  const clock = new FixedClock();
  const logger = new CapturingLogger();
  const coordinator = new MarketCollectionCoordinator(
    {
      discovery,
      source,
      recorder,
      clock,
      logger,
      ...(options.observer !== undefined ? { settlementObserver: options.observer } : {}),
    },
    {
      maxMarkets: 5,
      ...(options.settlementGraceMs !== undefined
        ? { settlementGraceMs: options.settlementGraceMs }
        : {}),
    },
  );
  return { log, discovery, source, recorder, clock, logger, coordinator };
}

/** Фиды BTC TWAP-рынка с указанным окном settlement-потока. */
function twapFeeds(window: PolymarketTwapRtdsFeed): readonly PolymarketRtdsFeed[] {
  return [{ topic: 'prices.crypto.binance', symbol: 'btcusdt' }, window];
}

describe('shared settlement-подписка: один поток на все рынки (PART 19/62)', () => {
  it('два рынка одного окна делят ОДНУ физическую подписку', async () => {
    const { discovery, source, coordinator } = createHarness();
    await coordinator.openMarket(
      discovery.addMarket({
        conditionId: CID_A,
        rtdsFeeds: twapFeeds(TWAP_60),
        settlement: BTC_TWAP_SETTLEMENT,
      }),
    );
    await coordinator.openMarket(
      discovery.addMarket({
        conditionId: CID_B,
        rtdsFeeds: twapFeeds(TWAP_60),
        settlement: BTC_TWAP_SETTLEMENT,
      }),
    );

    // Подписка открыта РОВНО один раз, ref-count = 2
    expect(source.subscribeTwapCalls).toEqual(['prices.crypto.chainlink.twap:btc/usd@60']);
    expect(coordinator.getStats().rtdsFeeds).toContainEqual({
      topic: 'prices.crypto.chainlink.twap',
      symbol: 'btc/usd',
      windowSeconds: 60,
      refCount: 2,
    });
  });

  it('release первого рынка НЕ закрывает поток; release последнего — закрывает', async () => {
    const { discovery, source, coordinator } = createHarness({ settlementGraceMs: 0 });
    await coordinator.openMarket(
      discovery.addMarket({
        conditionId: CID_A,
        rtdsFeeds: twapFeeds(TWAP_60),
        settlement: BTC_TWAP_SETTLEMENT,
      }),
    );
    await coordinator.openMarket(
      discovery.addMarket({
        conditionId: CID_B,
        rtdsFeeds: twapFeeds(TWAP_60),
        settlement: BTC_TWAP_SETTLEMENT,
      }),
    );
    const subscription = source.rtdsSubscriptions.get('prices.crypto.chainlink.twap:btc/usd@60')!;

    await coordinator.beginFinalization(mid(CID_A));
    await coordinator.awaitSettlementCapture(mid(CID_A));

    expect(subscription.closeCalls).toBe(0); // поток нужен рынку B
    expect(coordinator.getStats().rtdsFeeds).toContainEqual(
      expect.objectContaining({ windowSeconds: 60, refCount: 1 }),
    );

    await coordinator.beginFinalization(mid(CID_B));
    await coordinator.awaitSettlementCapture(mid(CID_B));

    expect(subscription.closeCalls).toBe(1); // последний ref освобождён
    expect(coordinator.getStats().rtdsFeeds).toEqual([]);
  });
});

describe('окна НЕ объединяются (PART 20/63)', () => {
  it('btc/usd TWAP 30 и btc/usd TWAP 60 → ДВЕ физические подписки', async () => {
    const { discovery, source, coordinator } = createHarness();
    await coordinator.openMarket(
      discovery.addMarket({
        conditionId: CID_A,
        rtdsFeeds: twapFeeds(TWAP_60),
        settlement: BTC_TWAP_SETTLEMENT,
      }),
    );
    await coordinator.openMarket(
      discovery.addMarket({
        conditionId: CID_B,
        rtdsFeeds: twapFeeds(TWAP_30),
        settlement: { ...BTC_TWAP_SETTLEMENT, windowSeconds: 30 },
      }),
    );

    expect(source.subscribeTwapCalls).toEqual([
      'prices.crypto.chainlink.twap:btc/usd@60',
      'prices.crypto.chainlink.twap:btc/usd@30',
    ]);
    const feeds = coordinator.getStats().rtdsFeeds.filter((feed) => feed.windowSeconds !== undefined);
    expect(feeds).toEqual([
      expect.objectContaining({ symbol: 'btc/usd', windowSeconds: 60, refCount: 1 }),
      expect.objectContaining({ symbol: 'btc/usd', windowSeconds: 30, refCount: 1 }),
    ]);
  });

  it('окно передаётся в SDK-подписку из дескриптора рынка', async () => {
    const { discovery, source, coordinator } = createHarness();
    const subscribeSpy = jest.spyOn(source, 'subscribeChainlinkTwap');

    await coordinator.openMarket(
      discovery.addMarket({
        rtdsFeeds: twapFeeds(TWAP_30),
        settlement: { ...BTC_TWAP_SETTLEMENT, windowSeconds: 30 },
      }),
    );

    expect(subscribeSpy).toHaveBeenCalledWith(30, ['btc/usd']);
  });
});

describe('boundary grace: граничное наблюдение не теряется (PART 24/25)', () => {
  it('CLOB и spot закрываются на истечении, settlement — ПОСЛЕ наблюдения', async () => {
    const observer = new FakeSettlementObserver();
    const { log, discovery, source, recorder, coordinator } = createHarness({
      settlementGraceMs: 5_000,
      observer,
    });
    await coordinator.openMarket(
      discovery.addMarket({ rtdsFeeds: BTC_TWAP_FEEDS, settlement: BTC_TWAP_SETTLEMENT }),
    );
    log.entries.length = 0;

    const snapshot = await coordinator.beginFinalization(mid(CID_A));
    expect(snapshot).toBeDefined();

    // Метод вернулся немедленно, НЕ дожидаясь grace: проход finalizer-а
    // не блокируется на секунды ради одного рынка
    expect(recorder.seals).toEqual([]);
    // Торговый lifecycle уже закончен, spot-фиды освобождены
    expect(source.marketSubscriptions[0]!.closeCalls).toBe(1);
    expect(source.rtdsSubscriptions.get('prices.crypto.chainlink:btc/usd')!.closeCalls).toBe(1);
    expect(source.rtdsSubscriptions.get('prices.crypto.binance:btcusdt')!.closeCalls).toBe(1);
    // Routing сужен до settlement-потока — «хвост» spot в датасет не идёт
    expect(recorder.narrowings).toEqual([
      `${CID_A}:prices.crypto.chainlink.twap\nbtc/usd\n60`,
    ]);
    // Settlement-поток ЖИВ и продолжает писаться
    expect(
      source.rtdsSubscriptions.get('prices.crypto.chainlink.twap:btc/usd@60')!.closeCalls,
    ).toBe(0);

    // Приходит граничное наблюдение → grace завершается досрочно
    observer.boundaryReached = true;
    await coordinator.awaitSettlementCapture(mid(CID_A));

    expect(recorder.seals).toEqual([CID_A]);
    expect(
      source.rtdsSubscriptions.get('prices.crypto.chainlink.twap:btc/usd@60')!.closeCalls,
    ).toBe(1);
    expect(coordinator.getStats().rtdsFeeds).toEqual([]);
  });

  it('наблюдатель спрашивается о ГРАНИЦЕ рынка и о нужном окне', async () => {
    const observer = new FakeSettlementObserver();
    const { discovery, coordinator } = createHarness({ settlementGraceMs: 5_000, observer });
    const expiresAtMs = NOW_MS + 70 * 60_000;
    await coordinator.openMarket(
      discovery.addMarket({ rtdsFeeds: BTC_TWAP_FEEDS, settlement: BTC_TWAP_SETTLEMENT }),
    );

    await coordinator.beginFinalization(mid(CID_A));
    observer.boundaryReached = true;
    await coordinator.awaitSettlementCapture(mid(CID_A));

    expect(observer.queries[0]).toBe(`btc/usd@60:${String(expiresAtMs)}`);
  });

  it('grace истекает без наблюдения → датасет всё равно замораживается', async () => {
    const observer = new FakeSettlementObserver(); // boundaryReached остаётся false
    const { discovery, recorder, coordinator } = createHarness({
      settlementGraceMs: 1,
      observer,
    });
    await coordinator.openMarket(
      discovery.addMarket({ rtdsFeeds: BTC_TWAP_FEEDS, settlement: BTC_TWAP_SETTLEMENT }),
    );

    await coordinator.beginFinalization(mid(CID_A));
    await coordinator.awaitSettlementCapture(mid(CID_A));

    expect(recorder.seals).toEqual([CID_A]); // вечного FINALIZING не бывает
  });

  it('рынок БЕЗ settlement-фида замораживается сразу, без grace и сужения', async () => {
    const observer = new FakeSettlementObserver();
    const { log, recorder, discovery, coordinator } = createHarness({
      settlementGraceMs: 60_000,
      observer,
    });
    await coordinator.openMarket(discovery.addMarket()); // spot-only фикстура
    log.entries.length = 0;

    await coordinator.beginFinalization(mid(CID_A));

    expect(recorder.seals).toEqual([CID_A]);
    expect(recorder.narrowings).toEqual([]);
    expect(observer.queries).toEqual([]);
  });

  it('сужение routing отказало → grace не ждёт вслепую, seal происходит', async () => {
    const observer = new FakeSettlementObserver();
    const { discovery, recorder, coordinator } = createHarness({
      settlementGraceMs: 60_000,
      observer,
    });
    await coordinator.openMarket(
      discovery.addMarket({ rtdsFeeds: BTC_TWAP_FEEDS, settlement: BTC_TWAP_SETTLEMENT }),
    );
    recorder.narrowResult = false; // writer уже неизвестен recorder-у

    await coordinator.beginFinalization(mid(CID_A));
    await coordinator.awaitSettlementCapture(mid(CID_A));

    expect(recorder.seals).toEqual([CID_A]);
  });

  it('close() координатора дожидается идущего grace и не бросает датасет', async () => {
    const observer = new FakeSettlementObserver();
    const { discovery, recorder, coordinator } = createHarness({
      settlementGraceMs: 60_000,
      observer,
    });
    await coordinator.openMarket(
      discovery.addMarket({ rtdsFeeds: BTC_TWAP_FEEDS, settlement: BTC_TWAP_SETTLEMENT }),
    );

    await coordinator.beginFinalization(mid(CID_A));
    await coordinator.close(); // прерывает ожидание флагом закрытия

    expect(recorder.seals).toEqual([CID_A]);
    expect(coordinator.getStats().rtdsFeeds).toEqual([]);
  });

  it('awaitSettlementCapture идемпотентен и безопасен для неизвестного рынка', async () => {
    const { discovery, coordinator } = createHarness({ settlementGraceMs: 0 });
    await expect(coordinator.awaitSettlementCapture(mid(CID_B))).resolves.toBeUndefined();

    await coordinator.openMarket(
      discovery.addMarket({ rtdsFeeds: BTC_TWAP_FEEDS, settlement: BTC_TWAP_SETTLEMENT }),
    );
    await coordinator.beginFinalization(mid(CID_A));

    await coordinator.awaitSettlementCapture(mid(CID_A));
    await expect(coordinator.awaitSettlementCapture(mid(CID_A))).resolves.toBeUndefined();
  });
});
