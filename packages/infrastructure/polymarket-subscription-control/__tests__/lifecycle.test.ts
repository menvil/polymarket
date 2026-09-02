/**
 * Жизненный цикл контроллера: остановка, терминальный отказ источника и
 * наблюдаемость.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { PolymarketSubscriptionController } from '../src/index.js';
import {
  AT_1757_MS,
  BTC_BINANCE_FEED,
  CapturingLogger,
  FakeDiscovery,
  FakeSource,
  MutableClock,
  deferred,
  makeEntry,
} from './helpers/fakes.js';

describe('жизненный цикл контроллера', () => {
  let clock: MutableClock;
  let discovery: FakeDiscovery;
  let source: FakeSource;
  let logger: CapturingLogger;
  let controller: PolymarketSubscriptionController;

  beforeEach(() => {
    clock = new MutableClock(AT_1757_MS);
    discovery = new FakeDiscovery();
    source = new FakeSource();
    logger = new CapturingLogger();
    controller = new PolymarketSubscriptionController({ discovery, source, clock, logger });
  });

  /** Регистрирует запись и её vendor-подготовку. */
  function prepared(id = 'market-x') {
    const entry = makeEntry({ id });
    discovery.register(entry, { rtdsFeeds: [BTC_BINANCE_FEED] });
    return entry;
  }

  describe('close', () => {
    it('закрывает все подписки и снимает claim-ы', async () => {
      const x = prepared('market-x');
      const y = prepared('market-y');
      await controller.acquire('strategy:A', x);
      await controller.acquire('collector:raw', y);

      await controller.close();

      expect(controller.isClosed).toBe(true);
      expect(source.issued.every((subscription) => subscription.closeCalls === 1)).toBe(true);
      expect(controller.getStats()).toMatchObject({
        openingMarkets: 0,
        activeMarkets: 0,
        claims: 0,
        rtdsFeeds: [],
        closed: true,
      });
      expect(controller.listSubscriptions()).toEqual([]);
    });

    it('идемпотентен', async () => {
      const entry = prepared();
      await controller.acquire('strategy:A', entry);

      await Promise.all([controller.close(), controller.close()]);
      await controller.close();

      expect(source.issued.every((subscription) => subscription.closeCalls === 1)).toBe(true);
    });

    it('новые приобретения после close отклоняются', async () => {
      const entry = prepared();
      await controller.close();

      const result = await controller.acquire('strategy:A', entry);

      expect(result).toMatchObject({ status: 'rejected', reason: 'controller-closed' });
      expect(source.subscribeMarketCalls).toHaveLength(0);
    });

    it('close во время OPENING не оставляет ни ACTIVE-состояния, ни утёкших ресурсов', async () => {
      const entry = prepared();
      const hold = deferred();
      source.subscribeMarketHold = hold.promise;

      const acquiring = controller.acquire('strategy:A', entry);
      const closing = controller.close();
      hold.resolve();

      expect(await acquiring).toMatchObject({ status: 'rejected', reason: 'controller-closed' });
      await closing;

      expect(source.issued[0]?.closeCalls).toBe(1); // вернувшийся handle закрыт
      expect(source.rtdsCallCount).toBe(0); // до RTDS транзакция не дошла
      expect(controller.getStats()).toMatchObject({
        openingMarkets: 0,
        activeMarkets: 0,
        claims: 0,
        rtdsFeeds: [],
      });
    });

    it('источник НЕ закрывается контроллером', async () => {
      const entry = prepared();
      await controller.acquire('strategy:A', entry);

      await controller.close();

      // Единственный признак, доступный контроллеру: он не умеет закрывать
      // источник вовсе — тот остаётся открытым для других потребителей.
      expect(source.isClosed).toBe(false);
      expect(source.hasFailed).toBe(false);
    });
  });

  describe('терминальный отказ источника', () => {
    it('живой источник → no-op', async () => {
      const entry = prepared();
      await controller.acquire('strategy:A', entry);

      expect(await controller.reconcileSourceFailure()).toBe(false);
      expect(controller.getStats().activeMarkets).toBe(1);
    });

    it('отказавший источник → состояния и claim-ы сняты', async () => {
      const entry = prepared();
      await controller.acquire('strategy:A', entry);
      source.hasFailed = true;

      expect(await controller.reconcileSourceFailure()).toBe(true);

      expect(controller.getStats()).toMatchObject({
        openingMarkets: 0,
        activeMarkets: 0,
        claims: 0,
        rtdsFeeds: [],
        sourceFailed: true,
      });
      expect(controller.listSubscriptions()).toEqual([]);
    });

    it('acquire на отказавшем источнике отклоняется и снимает устаревшее состояние', async () => {
      const held = prepared('market-x');
      await controller.acquire('strategy:A', held);
      source.hasFailed = true;
      const next = prepared('market-y');

      const result = await controller.acquire('collector:raw', next);

      expect(result).toMatchObject({ status: 'rejected', reason: 'source-unavailable' });
      expect(controller.getStats()).toMatchObject({ activeMarkets: 0, claims: 0 });
      expect(source.subscribeMarketCalls).toHaveLength(1); // вторая подписка не открывалась
    });

    it('acquire на закрытом источнике отклоняется', async () => {
      const entry = prepared();
      source.isClosed = true;

      const result = await controller.acquire('strategy:A', entry);

      expect(result).toMatchObject({ status: 'rejected', reason: 'source-unavailable' });
      expect(source.subscribeMarketCalls).toHaveLength(0);
    });

    it('присоединение к живому рынку на отказавшем источнике отклоняется', async () => {
      const entry = prepared();
      await controller.acquire('collector:raw', entry);
      source.hasFailed = true;

      const result = await controller.acquire('strategy:A', entry);

      // Ответ «joined» означал бы обещание потока, которого больше нет
      expect(result).toMatchObject({ status: 'rejected', reason: 'source-unavailable' });
      expect(controller.getStats()).toMatchObject({ activeMarkets: 0, claims: 0 });
    });

    it('удержание на остановленном контроллере не выдаётся за живое', async () => {
      const entry = prepared();
      await controller.acquire('strategy:A', entry);
      const hold = deferred();
      source.subscribeMarketHold = hold.promise; // close ничего не ждёт, но флаг уже стоит
      const closing = controller.close();

      const result = await controller.acquire('strategy:A', entry);

      expect(result).toMatchObject({ status: 'rejected', reason: 'controller-closed' });
      hold.resolve();
      await closing;
    });

    it('отказ источника во время OPENING откатывает транзакцию', async () => {
      const entry = prepared();
      const hold = deferred();
      source.subscribeMarketHold = hold.promise;

      const acquiring = controller.acquire('strategy:A', entry);
      source.hasFailed = true;
      hold.resolve();

      expect(await acquiring).toMatchObject({ status: 'rejected', reason: 'source-unavailable' });
      expect(controller.getStats()).toMatchObject({ activeMarkets: 0, claims: 0, rtdsFeeds: [] });
    });
  });

  describe('наблюдаемость', () => {
    it('снимки детерминированы: рынки по id, владельцы лексикографически', async () => {
      const y = prepared('market-y');
      const x = prepared('market-x');
      await controller.acquire('strategy:zeta', y);
      await controller.acquire('collector:alpha', y);
      await controller.acquire('strategy:beta', x);

      const snapshots = controller.listSubscriptions();

      expect(snapshots.map((item) => String(item.marketId))).toEqual(['market-x', 'market-y']);
      expect(snapshots[1]?.ownerKeys).toEqual(['collector:alpha', 'strategy:zeta']);
    });

    it('снимок несёт только canonical-поля, без vendor-моделей', async () => {
      const entry = prepared();
      await controller.acquire('strategy:A', entry);

      const [snapshot] = controller.listSubscriptions();

      expect(Object.keys(snapshot ?? {}).sort()).toEqual([
        'marketId',
        'ownerKeys',
        'rtdsFeedCount',
        'startsAt',
        'state',
      ]);
      expect(snapshot?.startsAt.toNumber()).toBe(entry.market.startsAt.toNumber());
      expect(snapshot?.rtdsFeedCount).toBe(1);
      for (const leaked of ['gammaMarket', 'gammaEvent', 'selected', 'entry']) {
        expect(snapshot).not.toHaveProperty(leaked);
      }
    });

    it('статистика различает OPENING и ACTIVE', async () => {
      const entry = prepared();
      const hold = deferred();
      source.subscribeMarketHold = hold.promise;

      const acquiring = controller.acquire('strategy:A', entry);
      expect(controller.getStats()).toMatchObject({ openingMarkets: 1, activeMarkets: 0 });

      hold.resolve();
      await acquiring;
      expect(controller.getStats()).toMatchObject({ openingMarkets: 0, activeMarkets: 1 });
    });

    it('открытие и закрытие рынка попадают в логи', async () => {
      const entry = prepared();
      await controller.acquire('strategy:A', entry);
      await controller.release('strategy:A', entry.market.id);

      const messages = logger.entries.map((item) => item.message);
      expect(messages).toContain('Market subscription opening');
      expect(messages).toContain('Market subscription active');
      expect(messages).toContain('Last owner released claim, closing market subscription');
    });
  });
});
