/**
 * Транзакция открытия физического ресурса: резервация, конкурентность,
 * откаты и повторные проверки старта после каждой асинхронной границы.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { PolymarketSubscriptionController } from '../src/index.js';
import {
  AT_1757_MS,
  AT_1759_59_500_MS,
  AT_1800_100_MS,
  AT_1800_MS,
  AT_1805_MS,
  CapturingLogger,
  FakeDiscovery,
  FakeSource,
  MutableClock,
  deferred,
  makeEntry,
} from './helpers/fakes.js';

describe('транзакция открытия', () => {
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

  /** Регистрирует запись и её vendor-подготовку. */
  function prepared(id = 'market-x') {
    const entry = makeEntry({ id });
    discovery.register(entry);
    return entry;
  }

  describe('подготовка рынка', () => {
    it('подготовки нет → not-prepared, подписок не открыто', async () => {
      const entry = makeEntry({ id: 'market-x' }); // discovery.register НЕ вызван

      const result = await controller.acquire('strategy:A', entry);

      expect(result).toEqual({
        status: 'rejected',
        marketId: entry.market.id,
        reason: 'not-prepared',
      });
      expect(source.subscribeMarketCalls).toHaveLength(0);
      expect(controller.getStats()).toMatchObject({ openingMarkets: 0, activeMarkets: 0, claims: 0 });
    });

    it.each([
      ['начало события', { eventStartsAtMs: AT_1805_MS }],
      ['истечение', { expiresAtMs: AT_1805_MS + 60_000 }],
      ['identity рынка', { marketId: 'other-market' }],
    ])('подготовка от другой версии записи (%s) → stale-preparation', async (_label, override) => {
      const entry = makeEntry({ id: 'market-x' });
      discovery.register(entry, override);

      const result = await controller.acquire('strategy:A', entry);

      expect(result).toEqual({
        status: 'rejected',
        marketId: entry.market.id,
        reason: 'stale-preparation',
      });
      expect(source.subscribeMarketCalls).toHaveLength(0);
      expect(controller.getStats().claims).toBe(0);
    });
  });

  describe('конкурентное приобретение одного рынка', () => {
    it('двое владельцев делят ОДНУ транзакцию открытия', async () => {
      const entry = prepared();
      const hold = deferred();
      source.subscribeMarketHold = hold.promise;

      const first = controller.acquire('strategy:A', entry);
      const second = controller.acquire('collector:raw', entry);

      // До разрешения транспорта: одна подписка, состояние OPENING, два claim-а
      expect(source.subscribeMarketCalls).toHaveLength(1);
      const opening = controller.getStats();
      expect(opening.openingMarkets).toBe(1);
      expect(opening.activeMarkets).toBe(0);
      expect(opening.claims).toBe(2);

      hold.resolve();
      expect(await first).toEqual({ status: 'opened', marketId: entry.market.id });
      expect(await second).toEqual({ status: 'joined', marketId: entry.market.id });
      expect(source.subscribeMarketCalls).toHaveLength(1);
      expect(controller.getStats().activeMarkets).toBe(1);
    });

    it('тот же владелец во время OPENING ждёт ТУ ЖЕ транзакцию', async () => {
      const entry = prepared();
      const hold = deferred();
      source.subscribeMarketHold = hold.promise;

      const first = controller.acquire('strategy:A', entry);
      let secondSettled = false;
      const second = controller.acquire('strategy:A', entry).then((result) => {
        secondSettled = true;
        return result;
      });

      await Promise.resolve();
      await Promise.resolve();
      expect(secondSettled).toBe(false); // ответ не даётся до конца приобретения

      hold.resolve();
      expect(await first).toMatchObject({ status: 'opened' });
      expect(await second).toMatchObject({ status: 'already-held' });
      expect(source.subscribeMarketCalls).toHaveLength(1);
      expect(controller.getStats().claims).toBe(1);
    });

    it('отказ транзакции получают ОБА ожидающих, claim-ов не остаётся', async () => {
      const entry = prepared();
      const hold = deferred();
      source.subscribeMarketHold = hold.promise;
      source.subscribeMarketError = new Error('transport down');

      const first = controller.acquire('strategy:A', entry);
      const second = controller.acquire('collector:raw', entry);
      hold.resolve();

      expect(await first).toEqual({
        status: 'failed',
        marketId: entry.market.id,
        stage: 'market-subscription',
      });
      expect(await second).toEqual({
        status: 'failed',
        marketId: entry.market.id,
        stage: 'market-subscription',
      });
      expect(controller.getStats()).toMatchObject({ openingMarkets: 0, activeMarkets: 0, claims: 0 });
    });
  });

  describe('откат отказов транспорта', () => {
    it('отказ подписки рынка → failed, RTDS не трогается, retry возможен', async () => {
      const entry = prepared();
      source.subscribeMarketError = new Error('subscribe failed');

      const failure = await controller.acquire('strategy:A', entry);

      expect(failure).toEqual({
        status: 'failed',
        marketId: entry.market.id,
        stage: 'market-subscription',
      });
      expect(source.rtdsCallCount).toBe(0);
      expect(controller.listSubscriptions()).toEqual([]);

      source.subscribeMarketError = undefined;
      expect(await controller.acquire('strategy:A', entry)).toMatchObject({ status: 'opened' });
      expect(source.subscribeMarketCalls).toHaveLength(2);
    });

    it('отказ RTDS → закрыты подписка рынка и уже приобретённые фиды', async () => {
      const entry = prepared();
      source.rtdsErrorSymbols.add('btc/usd'); // второй фид рынка

      const failure = await controller.acquire('strategy:A', entry);

      expect(failure).toEqual({
        status: 'failed',
        marketId: entry.market.id,
        stage: 'rtds-subscription',
      });
      // Подписка рынка и успевший открыться spot-фид закрыты
      expect(source.issued.map((subscription) => subscription.closeCalls)).toEqual([1, 1]);
      expect(controller.getStats()).toMatchObject({ activeMarkets: 0, claims: 0, rtdsFeeds: [] });

      source.rtdsErrorSymbols.clear();
      expect(await controller.acquire('strategy:A', entry)).toMatchObject({ status: 'opened' });
    });
  });

  describe('пересечение старта во время открытия', () => {
    it('рынок стартовал, пока открывалась его подписка → полный откат', async () => {
      clock.set(AT_1759_59_500_MS);
      const entry = prepared();
      const hold = deferred();
      source.subscribeMarketHold = hold.promise;

      const acquiring = controller.acquire('strategy:A', entry);
      clock.set(AT_1800_100_MS); // торги начались, пока SDK отвечал
      hold.resolve();

      expect(await acquiring).toEqual({
        status: 'rejected',
        marketId: entry.market.id,
        reason: 'already-started',
      });
      expect(source.issued[0]?.closeCalls).toBe(1); // вернувшийся handle закрыт
      expect(source.rtdsCallCount).toBe(0); // до RTDS дело не дошло
      expect(controller.getStats()).toMatchObject({ openingMarkets: 0, activeMarkets: 0, claims: 0 });
    });

    it('рынок стартовал, пока открывались RTDS-фиды → полный откат', async () => {
      clock.set(AT_1759_59_500_MS);
      const entry = prepared();
      const hold = deferred();
      source.rtdsHold = hold.promise;

      const acquiring = controller.acquire('strategy:A', entry);
      await Promise.resolve();
      clock.set(AT_1800_100_MS);
      hold.resolve();

      expect(await acquiring).toEqual({
        status: 'rejected',
        marketId: entry.market.id,
        reason: 'already-started',
      });
      // Фиды успели открыться — и закрыты вместе с подпиской рынка
      expect(source.rtdsCallCount).toBeGreaterThan(0);
      expect(source.issued).toHaveLength(1 + source.rtdsCallCount);
      expect(source.issued.every((subscription) => subscription.closeCalls === 1)).toBe(true);
      expect(controller.getStats()).toMatchObject({
        openingMarkets: 0,
        activeMarkets: 0,
        claims: 0,
        rtdsFeeds: [],
      });
    });

    it('старт РОВНО в момент готовности bundle тоже откатывает', async () => {
      clock.set(AT_1759_59_500_MS);
      const entry = prepared();
      const hold = deferred();
      source.subscribeMarketHold = hold.promise;

      const acquiring = controller.acquire('strategy:A', entry);
      clock.set(AT_1800_MS); // граница включительно: `now === startsAt` — уже поздно
      hold.resolve();

      expect(await acquiring).toMatchObject({ status: 'rejected', reason: 'already-started' });
      expect(source.issued[0]?.closeCalls).toBe(1);
    });
  });

  describe('release во время OPENING', () => {
    it('дожидается исхода транзакции и снимает claim без зомби-состояния', async () => {
      const entry = prepared();
      const hold = deferred();
      source.subscribeMarketHold = hold.promise;

      const acquiring = controller.acquire('strategy:A', entry);
      const releasing = controller.release('strategy:A', entry.market.id);
      hold.resolve();

      expect(await acquiring).toMatchObject({ status: 'opened' });
      expect(await releasing).toBe('closed');
      expect(source.issued[0]?.closeCalls).toBe(1);
      expect(controller.getStats()).toMatchObject({
        openingMarkets: 0,
        activeMarkets: 0,
        claims: 0,
        rtdsFeeds: [],
      });
    });

    it('транзакция откатилась → release отвечает not-held', async () => {
      const entry = prepared();
      const hold = deferred();
      source.subscribeMarketHold = hold.promise;
      source.subscribeMarketError = new Error('transport down');

      const acquiring = controller.acquire('strategy:A', entry);
      const releasing = controller.release('strategy:A', entry.market.id);
      hold.resolve();

      expect(await acquiring).toMatchObject({ status: 'failed' });
      expect(await releasing).toBe('not-held');
    });
  });
});
