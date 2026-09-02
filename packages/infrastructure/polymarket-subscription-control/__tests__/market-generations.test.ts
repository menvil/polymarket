/**
 * Одно физическое поколение на рынок: приобретение НЕ начинается, пока
 * предыдущий физический ресурс того же рынка ещё разбирается.
 *
 * @remarks
 * Ссылки на shared RTDS-фиды адресуются ключом рынка (`String(marketId)`),
 * а не экземпляром подписки. Если освободить ключ рынка ДО фактического
 * закрытия его ресурсов, новое поколение того же рынка добавит СВОЮ ссылку
 * в тот же `Set` — где ключ уже лежит, — и добавление окажется no-op. Затем
 * старый teardown удалит эту единственную ссылку, счётчик упадёт до нуля, и
 * физический фид закроется ПОД живым новым рынком:
 *
 * ```text
 * Controller: Market X ACTIVE, rtdsFeedKeys = [btc]
 * _rtdsFeeds: btc отсутствует
 * physical:   btc closed
 * ```
 *
 * Поэтому ключ рынка обязан оставаться занятым до конца разбора.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { PolymarketSubscriptionController } from '../src/index.js';
import {
  AT_1757_MS,
  BTC_BINANCE_FEED,
  CapturingLogger,
  FakeDiscovery,
  FakeOpenSubscription,
  FakeSource,
  MutableClock,
  deferred,
  makeEntry,
} from './helpers/fakes.js';

/**
 * Прокручивает ВСЮ очередь микрозадач, не разрешая ни одного hold.
 *
 * @returns Promise, разрешающийся после опустошения очереди
 *
 * @remarks
 * Через `setImmediate`, а не фиксированным числом `Promise.resolve()`:
 * «сколько-то тиков» превращает проверку «работа НЕ началась» в гонку с
 * длиной цепочки await внутри контроллера — она прошла бы и на сломанном
 * коде, просто не успев увидеть последствия.
 */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe('поколения физического ресурса рынка', () => {
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

  /** Регистрирует рынок с одним spot-фидом. */
  function prepared(id = 'market-x') {
    const entry = makeEntry({ id });
    discovery.register(entry, { rtdsFeeds: [BTC_BINANCE_FEED] });
    return entry;
  }

  /** Найденная по метке выданная подписка. */
  function issued(prefix: string): FakeOpenSubscription[] {
    return source.issued.filter((subscription) => subscription.label.startsWith(prefix));
  }

  it('новый владелец не открывает подписку, пока старая ещё закрывается', async () => {
    const entry = prepared();
    await controller.acquire('strategy:A', entry);
    const oldMarket = issued('market:')[0]!;
    const oldFeed = issued('prices.')[0]!;
    const closeHold = deferred();
    oldMarket.closeHold = closeHold.promise;

    const releasing = controller.release('strategy:A', entry.market.id);
    await flush();

    let acquired = false;
    const acquiring = controller.acquire('strategy:B', entry).then((result) => {
      acquired = true;
      return result;
    });
    await flush();

    // Пока старый bundle разбирается, новая транзакция не начата
    expect(acquired).toBe(false);
    expect(source.subscribeMarketCalls).toHaveLength(1);
    expect(source.cryptoCalls).toHaveLength(1);

    closeHold.resolve();
    expect(await releasing).toBe('closed');
    expect(await acquiring).toMatchObject({ status: 'opened' });

    // Старое поколение разобрано полностью, новое — целое
    expect(oldMarket.closeCalls).toBe(1);
    expect(oldFeed.closeCalls).toBe(1);
    expect(source.subscribeMarketCalls).toHaveLength(2);
    expect(source.cryptoCalls).toHaveLength(2);
    expect(controller.getStats().rtdsFeeds).toEqual([
      { topic: 'prices.crypto.binance', symbol: 'btcusdt', refCount: 1 },
    ]);
    const newFeed = issued('prices.')[1]!;
    expect(newFeed.closeCalls).toBe(0); // фид нового рынка НЕ закрыт чужим teardown
  });

  it('повторная попытка ждёт разбора откатившейся транзакции', async () => {
    const entry = prepared();
    // Транзакция останавливается НА открытии фида: только так подписка рынка
    // уже существует, а откат ещё не начался — момент, когда можно задержать
    // её закрытие.
    const rtdsHold = deferred();
    source.rtdsHold = rtdsHold.promise;
    source.rtdsErrorSymbols.add('btcusdt');

    const failing = controller.acquire('strategy:A', entry);
    await flush();

    const oldMarket = issued('market:')[0]!;
    const closeHold = deferred();
    oldMarket.closeHold = closeHold.promise;

    rtdsHold.resolve();
    await flush();
    expect(oldMarket.closeCalls).toBe(1); // откат идёт, закрытие зависло
    source.rtdsErrorSymbols.clear(); // повтору фид уже откроется

    let retried = false;
    const retrying = controller.acquire('strategy:A', entry).then((result) => {
      retried = true;
      return result;
    });
    await flush();

    expect(retried).toBe(false);
    expect(source.subscribeMarketCalls).toHaveLength(1);

    closeHold.resolve();
    expect(await failing).toMatchObject({ status: 'failed', stage: 'rtds-subscription' });
    expect(await retrying).toMatchObject({ status: 'opened' });

    expect(source.subscribeMarketCalls).toHaveLength(2);
    expect(controller.getStats()).toMatchObject({
      activeMarkets: 1,
      claims: 1,
      rtdsFeeds: [{ topic: 'prices.crypto.binance', symbol: 'btcusdt', refCount: 1 }],
    });
  });

  it('close() дожидается идущего разбора последнего claim-а', async () => {
    const entry = prepared();
    await controller.acquire('strategy:A', entry);
    const oldMarket = issued('market:')[0]!;
    const oldFeed = issued('prices.')[0]!;
    const closeHold = deferred();
    oldMarket.closeHold = closeHold.promise;

    const releasing = controller.release('strategy:A', entry.market.id);
    await flush();

    let controllerClosed = false;
    const closing = controller.close().then(() => {
      controllerClosed = true;
    });
    await flush();

    expect(controllerClosed).toBe(false); // close не завершается поверх живого teardown

    closeHold.resolve();
    await releasing;
    await closing;

    expect(oldMarket.closeCalls).toBe(1);
    expect(oldFeed.closeCalls).toBe(1);
    expect(controller.getStats()).toMatchObject({
      openingMarkets: 0,
      activeMarkets: 0,
      claims: 0,
      rtdsFeeds: [],
      closed: true,
    });
  });
});
