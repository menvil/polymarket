/**
 * Read-only проекция удерживаемого рынка: кто держит, что видит и когда.
 *
 * @remarks
 * Ключевой инвариант — снимок доступен уже на стадии `OPENING`: первое
 * (опорное) наблюдение рынка приходит на шину сразу после `subscribeMarket()`,
 * то есть ДО открытия RTDS-фидов и commit-а `ACTIVE`. Требование
 * `state === 'ACTIVE'` потеряло бы этот book-снапшот.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { ValidationError } from '@polymarket/errors';
import { PolymarketSubscriptionController } from '../src/index.js';
import {
  AT_1757_MS,
  BTC_BINANCE_FEED,
  BTC_TWAP_60_FEED,
  CapturingLogger,
  FakeDiscovery,
  FakeSource,
  MutableClock,
  deferred,
  makeEntry,
} from './helpers/fakes.js';

describe('getHeldMarket', () => {
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

  it('владелец видит canonical запись и immutable vendor-подготовку', async () => {
    const entry = makeEntry();
    const selected = discovery.register(entry, {
      rtdsFeeds: [BTC_BINANCE_FEED, BTC_TWAP_60_FEED],
    });
    await controller.acquire('collector:raw', entry);

    const held = controller.getHeldMarket('collector:raw', entry.market.id);

    expect(held).toBeDefined();
    expect(held?.state).toBe('ACTIVE');
    expect(held?.entry).toBe(entry);
    // Та же самая подготовка, по которой открыт транспорт: второго
    // prepareMarket контур не делает.
    expect(held?.selected).toBe(selected);
    expect(held?.selected.rtdsFeeds).toEqual([BTC_BINANCE_FEED, BTC_TWAP_60_FEED]);
  });

  it('ЧУЖОЙ владелец рынка не виден: физический поток ещё не значит «наш»', async () => {
    const entry = makeEntry();
    discovery.register(entry);
    await controller.acquire('strategy:A', entry);

    expect(controller.getHeldMarket('collector:raw', entry.market.id)).toBeUndefined();
    expect(controller.getHeldMarket('strategy:A', entry.market.id)).toBeDefined();
  });

  it('снимок доступен уже в OPENING — первый book-снапшот не теряется', async () => {
    const entry = makeEntry();
    discovery.register(entry);
    // RTDS-подписки зависают: транзакция открытия не дошла до commit ACTIVE.
    const gate = deferred();
    source.rtdsHold = gate.promise;

    const acquiring = controller.acquire('collector:raw', entry);
    // Дожидаемся, пока транзакция дойдёт до открытия фидов (market-подписка
    // уже открыта — именно тогда и приходит первое наблюдение).
    while (source.rtdsCallCount === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const held = controller.getHeldMarket('collector:raw', entry.market.id);
    expect(held).toBeDefined();
    expect(held?.state).toBe('OPENING');
    expect(held?.selected.rtdsFeeds.length).toBeGreaterThan(0);

    gate.resolve();
    await acquiring;
    expect(controller.getHeldMarket('collector:raw', entry.market.id)?.state).toBe('ACTIVE');
  });

  it('после release claim-а снимка больше нет', async () => {
    const entry = makeEntry();
    discovery.register(entry);
    await controller.acquire('collector:raw', entry);

    await controller.release('collector:raw', entry.market.id);

    expect(controller.getHeldMarket('collector:raw', entry.market.id)).toBeUndefined();
  });

  it('снимок заморожен и не отдаёт mutable-состояние наружу', async () => {
    const entry = makeEntry();
    discovery.register(entry);
    await controller.acquire('collector:raw', entry);

    const held = controller.getHeldMarket('collector:raw', entry.market.id)!;

    expect(Object.isFrozen(held)).toBe(true);
    // Ни handle подписки, ни множества владельцев в снимке нет.
    expect(Object.keys(held).sort()).toEqual(['entry', 'marketId', 'selected', 'state']);
  });

  it('пустой ключ владельца — дефект вызывающего, а не «нет claim-а»', () => {
    expect(() => controller.getHeldMarket('  ', makeEntry().market.id)).toThrow(ValidationError);
  });
});
