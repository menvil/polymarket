/**
 * Claim-ы владельцев поверх одной физической подписки рынка.
 *
 * @remarks
 * Здесь проверяется контракт владения: `opened`/`joined`/`already-held`,
 * снятие claim-ов и — главное — что удержание НЕ зависит от планировщика:
 * после старта торгов рынок остаётся приобретённым, хотя план его уже не
 * вернул бы.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { KnownVenues } from '@polymarket/ids';
import { PolymarketSubscriptionController } from '../src/index.js';
import {
  AT_1757_MS,
  AT_1801_MS,
  CapturingLogger,
  FakeDiscovery,
  FakeSource,
  MutableClock,
  makeEntry,
} from './helpers/fakes.js';

describe('claim-ы владельцев', () => {
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
  function prepared(id: string) {
    const entry = makeEntry({ id });
    discovery.register(entry);
    return entry;
  }

  describe('opened / joined / already-held', () => {
    it('первый владелец открывает физическую подписку', async () => {
      const entry = prepared('market-x');

      const result = await controller.acquire('strategy:A', entry);

      expect(result).toEqual({ status: 'opened', marketId: entry.market.id });
      expect(source.subscribeMarketCalls).toHaveLength(1);
      expect(controller.getStats().activeMarkets).toBe(1);
    });

    it('второй владелец присоединяется без второй подписки', async () => {
      const entry = prepared('market-x');
      await controller.acquire('strategy:A', entry);

      const result = await controller.acquire('collector:raw', entry);

      expect(result).toEqual({ status: 'joined', marketId: entry.market.id });
      expect(source.subscribeMarketCalls).toHaveLength(1);
      expect(controller.getStats().claims).toBe(2);
    });

    it('повторный acquire того же владельца идемпотентен', async () => {
      const entry = prepared('market-x');
      await controller.acquire('strategy:A', entry);

      const result = await controller.acquire('strategy:A', entry);

      expect(result).toEqual({ status: 'already-held', marketId: entry.market.id });
      expect(controller.getStats().claims).toBe(1);
      expect(source.subscribeMarketCalls).toHaveLength(1);
    });

    it('подписка рынка открывается по инструментам ПОДГОТОВКИ', async () => {
      const entry = prepared('market-x');

      await controller.acquire('strategy:A', entry);

      expect(source.subscribeMarketCalls[0]).toEqual(['market-x-up', 'market-x-down']);
    });
  });

  describe('гейты приобретения', () => {
    it('рынок другой площадки отклоняется', async () => {
      const entry = makeEntry({ id: 'kalshi-x', venueId: KnownVenues.KALSHI });
      discovery.register(entry);

      const result = await controller.acquire('strategy:A', entry);

      expect(result).toEqual({
        status: 'rejected',
        marketId: entry.market.id,
        reason: 'wrong-venue',
      });
      expect(source.subscribeMarketCalls).toHaveLength(0);
    });

    it.each(['CLOSED', 'RESOLVED'] as const)('состояние %s отклоняется', async (state) => {
      const entry = makeEntry({ id: 'market-x', state });
      discovery.register(entry);

      const result = await controller.acquire('strategy:A', entry);

      expect(result).toEqual({ status: 'rejected', marketId: entry.market.id, reason: 'inactive' });
      expect(source.subscribeMarketCalls).toHaveLength(0);
    });

    it('пустой ключ владельца — дефект вызывающего, а не исход', async () => {
      const entry = prepared('market-x');

      await expect(controller.acquire('   ', entry)).rejects.toThrow(/owner key/);
    });
  });

  describe('удержание после старта торгов (ACQUISITION ≠ RETENTION)', () => {
    it('приобретённый рынок живёт после старта без единого release', async () => {
      const entry = prepared('market-x');
      await controller.acquire('strategy:A', entry);

      clock.set(AT_1801_MS); // торги идут — планировщик такой рынок уже не вернёт

      const stats = controller.getStats();
      expect(stats.activeMarkets).toBe(1);
      expect(stats.claims).toBe(1);
      expect(controller.listSubscriptions()[0]?.ownerKeys).toEqual(['strategy:A']);
      // Физический ресурс НЕ закрыт: подписка рынка + её RTDS-фиды живы
      expect(source.issued.every((subscription) => subscription.closeCalls === 0)).toBe(true);
    });

    it('НОВЫЙ владелец после старта не присоединяется к чужому ресурсу', async () => {
      const entry = prepared('market-x');
      await controller.acquire('collector:raw', entry);

      clock.set(AT_1801_MS);
      const result = await controller.acquire('strategy:A', entry);

      expect(result).toEqual({
        status: 'rejected',
        marketId: entry.market.id,
        reason: 'already-started',
      });
      expect(controller.listSubscriptions()[0]?.ownerKeys).toEqual(['collector:raw']);
      expect(source.subscribeMarketCalls).toHaveLength(1);
    });

    it('СУЩЕСТВУЮЩИЙ владелец после старта остаётся владельцем', async () => {
      const entry = prepared('market-x');
      await controller.acquire('strategy:A', entry);

      clock.set(AT_1801_MS);
      const result = await controller.acquire('strategy:A', entry);

      expect(result).toEqual({ status: 'already-held', marketId: entry.market.id });
      expect(controller.getStats().claims).toBe(1);
    });

    it('новый рынок после старта не приобретается вовсе', async () => {
      const entry = prepared('market-x');
      clock.set(AT_1801_MS);

      const result = await controller.acquire('strategy:A', entry);

      expect(result).toEqual({
        status: 'rejected',
        marketId: entry.market.id,
        reason: 'already-started',
      });
      expect(controller.getStats().activeMarkets).toBe(0);
    });
  });

  describe('release', () => {
    it('claim чужого владельца → not-held', async () => {
      const entry = prepared('market-x');
      await controller.acquire('strategy:A', entry);

      const result = await controller.release('collector:raw', entry.market.id);

      expect(result).toBe('not-held');
      expect(controller.getStats().activeMarkets).toBe(1);
    });

    it('release неизвестного рынка → not-held', async () => {
      const entry = makeEntry({ id: 'unknown' });

      expect(await controller.release('strategy:A', entry.market.id)).toBe('not-held');
    });

    it('не последний claim → retained, подписка живёт', async () => {
      const entry = prepared('market-x');
      await controller.acquire('strategy:A', entry);
      await controller.acquire('collector:raw', entry);

      const result = await controller.release('strategy:A', entry.market.id);

      expect(result).toBe('retained');
      expect(source.issued[0]?.closeCalls).toBe(0);
      expect(controller.listSubscriptions()[0]?.ownerKeys).toEqual(['collector:raw']);
    });

    it('последний claim → closed, физические ресурсы освобождены', async () => {
      const entry = prepared('market-x');
      await controller.acquire('strategy:A', entry);
      await controller.acquire('collector:raw', entry);
      await controller.release('strategy:A', entry.market.id);

      const result = await controller.release('collector:raw', entry.market.id);

      expect(result).toBe('closed');
      expect(source.issued[0]?.closeCalls).toBe(1);
      const stats = controller.getStats();
      expect(stats.activeMarkets).toBe(0);
      expect(stats.claims).toBe(0);
      expect(stats.rtdsFeeds).toEqual([]);
    });

    it('повторный release того же владельца → not-held', async () => {
      const entry = prepared('market-x');
      await controller.acquire('strategy:A', entry);
      await controller.release('strategy:A', entry.market.id);

      expect(await controller.release('strategy:A', entry.market.id)).toBe('not-held');
      expect(source.issued[0]?.closeCalls).toBe(1);
    });
  });

  describe('releaseOwner', () => {
    it('снимает все claim-ы владельца и закрывает осиротевшие рынки', async () => {
      const x = prepared('market-x');
      const y = prepared('market-y');
      await controller.acquire('strategy:A', x);
      await controller.acquire('strategy:A', y);
      await controller.acquire('collector:raw', y);

      const released = await controller.releaseOwner('strategy:A');

      expect(released).toBe(2);
      const remaining = controller.listSubscriptions();
      expect(remaining).toHaveLength(1);
      expect(String(remaining[0]?.marketId)).toBe('market-y');
      expect(remaining[0]?.ownerKeys).toEqual(['collector:raw']);
    });

    it('владелец без claim-ов → 0', async () => {
      const entry = prepared('market-x');
      await controller.acquire('strategy:A', entry);

      expect(await controller.releaseOwner('strategy:B')).toBe(0);
      expect(controller.getStats().claims).toBe(1);
    });
  });

  describe('приёмочный сценарий: стратегия + коллектор', () => {
    it('два владельца одного рынка → одна подписка, снятие по одному', async () => {
      const entry = prepared('market-x');

      expect((await controller.acquire('strategy:A', entry)).status).toBe('opened');
      expect((await controller.acquire('collector:raw', entry)).status).toBe('joined');
      expect(source.subscribeMarketCalls).toHaveLength(1);
      expect(controller.listSubscriptions()[0]?.ownerKeys).toEqual([
        'collector:raw',
        'strategy:A',
      ]);

      expect(await controller.release('strategy:A', entry.market.id)).toBe('retained');
      expect(source.issued[0]?.closeCalls).toBe(0);

      expect(await controller.release('collector:raw', entry.market.id)).toBe('closed');
      expect(source.issued[0]?.closeCalls).toBe(1);
      expect(controller.getStats()).toMatchObject({ activeMarkets: 0, claims: 0, rtdsFeeds: [] });
    });
  });
});
