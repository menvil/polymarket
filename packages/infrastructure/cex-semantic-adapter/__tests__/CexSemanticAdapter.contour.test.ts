/**
 * Контурные свойства адаптера: причинность, веерная раздача, владение,
 * неприкосновенность raw-payload и изоляция отказов.
 *
 * @remarks
 * Это ровно те свойства, ради которых адаптер сделан ВТОРЫМ независимым
 * потребителем общего bus, а не частью recorder-а или source-а. Без них
 * semantic-слой мог бы уронить сбор сырых данных — а сырые данные ценны
 * даже когда их семантика отвергнута.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import { EventBus } from '@polymarket/event-bus';
import type { EventBusEvent } from '@polymarket/event-bus';
import { MessageMetadataGenerator } from '@polymarket/messages';
import { LiveClock } from '@polymarket/time';
import type { CexExternalMessage } from '@polymarket/cex-v2';
import { CexSemanticAdapter } from '../src/index.js';
import { createHarness, orderbookPayload, silentLogger, tradePayload } from './support/fixtures.js';

describe('причинность metadata', () => {
  it('каждое semantic-событие — причинный ребёнок raw-наблюдения', async () => {
    const h = createHarness();
    const root = h.metadataGenerator.nextRoot();
    await h.bus.publish({
      type: 'CEX_ORDERBOOK',
      payload: orderbookPayload({ bids: [[100, 1]], asks: [[101, 1]] }),
      metadata: root,
    });

    expect(h.published).toHaveLength(2); // BOOK_DEPTH + BOOK_UPDATED
    for (const event of h.published) {
      expect(event.metadata.causationId).toBe(root.messageId);
      expect(event.metadata.correlationId).toBe(root.correlationId);
      // Собственная идентичность у каждого ребёнка своя
      expect(event.metadata.messageId).not.toBe(root.messageId);
    }
    // Два ребёнка одного наблюдения различимы между собой
    expect(h.published[0]!.metadata.messageId).not.toBe(h.published[1]!.metadata.messageId);
  });

  it('semantic-сделка — причинный ребёнок своего наблюдения', async () => {
    const h = createHarness();
    const root = h.metadataGenerator.nextRoot();
    await h.bus.publish({
      type: 'CEX_TRADE',
      payload: tradePayload(),
      metadata: root,
    });

    expect(h.published).toHaveLength(1);
    expect(h.published[0]!.metadata.causationId).toBe(root.messageId);
    expect(h.published[0]!.metadata.correlationId).toBe(root.correlationId);
  });

  it('события разных наблюдений не смешивают причинные цепочки', async () => {
    const h = createHarness();
    const first = h.metadataGenerator.nextRoot();
    const second = h.metadataGenerator.nextRoot();

    await h.bus.publish({
      type: 'CEX_TRADE',
      payload: tradePayload({ id: 'a' }),
      metadata: first,
    });
    await h.bus.publish({
      type: 'CEX_TRADE',
      payload: tradePayload({ id: 'b' }),
      metadata: second,
    });

    expect(h.published[0]!.metadata.causationId).toBe(first.messageId);
    expect(h.published[1]!.metadata.causationId).toBe(second.messageId);
    expect(h.published[0]!.metadata.correlationId).not.toBe(
      h.published[1]!.metadata.correlationId,
    );
  });
});

describe('веерная раздача одного raw-потока', () => {
  it('recorder-подобный наблюдатель и адаптер получают одно и то же сообщение', async () => {
    const h = createHarness();
    const recorded: CexExternalMessage[] = [];
    h.bus.subscribe('CEX_ORDERBOOK', (message) => {
      recorded.push(message);
    });

    const payload = orderbookPayload({ bids: [[100, 1]], asks: [[101, 1]] });
    await h.bus.publish({
      type: 'CEX_ORDERBOOK',
      payload,
      metadata: h.metadataGenerator.nextRoot(),
    });

    // Оба потребителя отработали независимо
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.payload).toBe(payload);
    expect(h.eventsOfType('BOOK_DEPTH')).toHaveLength(1);
  });

  it('адаптер НЕ мутирует raw-payload наблюдения', async () => {
    const h = createHarness();
    const payload = orderbookPayload({
      bids: [
        [100, 1],
        [99, 2],
      ],
      asks: [[101, 1]],
      nonce: 42,
    });
    const before = JSON.parse(JSON.stringify(payload)) as unknown;

    await h.bus.publish({
      type: 'CEX_ORDERBOOK',
      payload,
      metadata: h.metadataGenerator.nextRoot(),
    });

    // Recorder видит тот же объект, что и адаптер: любая правка «на месте»
    // (сортировка, нормализация, удаление уровня) испортила бы запись
    expect(JSON.parse(JSON.stringify(payload))).toEqual(before);
  });

  it('адаптер НЕ мутирует raw-payload сделки', async () => {
    const h = createHarness();
    const payload = tradePayload();
    const before = JSON.parse(JSON.stringify(payload)) as unknown;

    await h.bus.publish({
      type: 'CEX_TRADE',
      payload,
      metadata: h.metadataGenerator.nextRoot(),
    });

    expect(JSON.parse(JSON.stringify(payload))).toEqual(before);
  });

  it('порядок уровней в raw-payload сохраняется, хотя книга отсортирована', async () => {
    const h = createHarness();
    const payload = orderbookPayload({
      bids: [
        [99, 1],
        [100, 2],
      ],
      asks: [[101, 1]],
    });

    await h.bus.publish({
      type: 'CEX_ORDERBOOK',
      payload,
      metadata: h.metadataGenerator.nextRoot(),
    });

    // Сортировка живёт в canonical-книге, а не в vendor-объекте
    expect(payload.orderBook.bids).toEqual([
      [99, 1],
      [100, 2],
    ]);
    const book = h.eventsOfType('BOOK_DEPTH')[0]!.payload.snapshot;
    expect(book.getBestBid()!.value().toString()).toBe('100');
  });
});

describe('владение шиной и жизненный цикл', () => {
  it('close() снимает только свои подписки и не трогает шину', async () => {
    const h = createHarness();
    const recorded: CexExternalMessage[] = [];
    h.bus.subscribe('CEX_ORDERBOOK', (message) => {
      recorded.push(message);
    });

    await h.publishBook();
    expect(h.eventsOfType('BOOK_DEPTH')).toHaveLength(1);
    expect(recorded).toHaveLength(1);

    h.adapter.close();

    await h.publishBook();
    // Semantic-выхода больше нет...
    expect(h.eventsOfType('BOOK_DEPTH')).toHaveLength(1);
    // ...но шина жива и другие потребители продолжают получать сообщения
    expect(recorded).toHaveLength(2);
  });

  it('close() освобождает semantic-состояние', async () => {
    const h = createHarness();
    await h.publishBook({ exchangeId: 'binance' });
    await h.publishBook({ exchangeId: 'okx' });
    expect(h.adapter.getStats().activeInstrumentStates).toBe(2);

    h.adapter.close();
    expect(h.adapter.getStats().activeInstrumentStates).toBe(0);
  });

  it('close() идемпотентен', async () => {
    const h = createHarness();
    h.adapter.close();
    expect(() => h.adapter.close()).not.toThrow();
    await h.publishBook();
    expect(h.published).toHaveLength(0);
  });

  it('повторный start() не создаёт вторых подписок', async () => {
    const h = createHarness();
    h.adapter.start();
    await h.publishBook();

    // Двойная подписка означала бы двойную публикацию каждого события
    expect(h.eventsOfType('BOOK_DEPTH')).toHaveLength(1);
  });

  it('до start() адаптер ничего не публикует', async () => {
    const h = createHarness({ autoStart: false });
    await h.publishBook();
    expect(h.published).toHaveLength(0);

    h.adapter.start();
    await h.publishBook();
    expect(h.eventsOfType('BOOK_DEPTH')).toHaveLength(1);
  });

  it('close() → start() возобновляет работу', async () => {
    const h = createHarness();
    h.adapter.close();
    h.adapter.start();
    await h.publishBook();
    expect(h.eventsOfType('BOOK_DEPTH')).toHaveLength(1);
  });
});

describe('изоляция отказов semantic-слоя', () => {
  it('отказ Application-шины не мешает записи сырых данных', async () => {
    const bus = new ExternalMessageBus<CexExternalMessage>();
    const eventBus = new EventBus(silentLogger());
    const metadataGenerator = new MessageMetadataGenerator({ clock: new LiveClock() });
    const recorded: CexExternalMessage[] = [];
    bus.subscribe('CEX_ORDERBOOK', (message) => {
      recorded.push(message);
    });

    const failure = new Error('event bus rejected publication');
    const publish = jest
      .spyOn(eventBus, 'publish')
      .mockResolvedValue({ ok: false, error: failure } as Awaited<
        ReturnType<EventBus['publish']>
      >);

    const adapter = new CexSemanticAdapter({
      bus,
      eventBus,
      metadataGenerator,
      logger: silentLogger(),
    });
    adapter.start();

    const result = await bus.publish({
      type: 'CEX_ORDERBOOK',
      payload: orderbookPayload(),
      metadata: metadataGenerator.nextRoot(),
    });

    // Публикация в raw-шину успешна, наблюдатель сырых данных её получил
    expect(result.ok).toBe(true);
    expect(recorded).toHaveLength(1);
    // Отказ semantic-публикации только посчитан
    expect(adapter.getStats().semanticPublishFailures).toBeGreaterThan(0);
    expect(adapter.getStats().orderBooksPublished).toBe(0);

    publish.mockRestore();
    adapter.close();
  });

  it('отвергнутая верхушка не запоминается как опубликованная', async () => {
    const bus = new ExternalMessageBus<CexExternalMessage>();
    const eventBus = new EventBus(silentLogger());
    const metadataGenerator = new MessageMetadataGenerator({ clock: new LiveClock() });
    const published: EventBusEvent[] = [];
    eventBus.subscribe('BOOK_UPDATED', (event) => {
      published.push(event);
    });

    const adapter = new CexSemanticAdapter({
      bus,
      eventBus,
      metadataGenerator,
      logger: silentLogger(),
    });
    adapter.start();

    const failure = new Error('rejected');
    const publish = jest
      .spyOn(eventBus, 'publish')
      .mockResolvedValue({ ok: false, error: failure } as Awaited<
        ReturnType<EventBus['publish']>
      >);
    await bus.publish({
      type: 'CEX_ORDERBOOK',
      payload: orderbookPayload({ bids: [[100, 1]], asks: [[101, 1]] }),
      metadata: metadataGenerator.nextRoot(),
    });
    publish.mockRestore();

    // Та же верхушка после снятия отказа обязана дойти: иначе гашение
    // дубликатов превратилось бы в потерю данных
    await bus.publish({
      type: 'CEX_ORDERBOOK',
      payload: orderbookPayload({ bids: [[100, 1]], asks: [[101, 1]] }),
      metadata: metadataGenerator.nextRoot(),
    });

    expect(published).toHaveLength(1);
    adapter.close();
  });

  it('битое наблюдение не мешает следующим и не роняет шину', async () => {
    const h = createHarness();
    const recorded: CexExternalMessage[] = [];
    h.bus.subscribe('CEX_ORDERBOOK', (message) => {
      recorded.push(message);
    });

    const first = await h.bus.publish({
      type: 'CEX_ORDERBOOK',
      payload: orderbookPayload({ bids: [[0, 1]], asks: [[101, 1]] }),
      metadata: h.metadataGenerator.nextRoot(),
    });
    const second = await h.bus.publish({
      type: 'CEX_ORDERBOOK',
      payload: orderbookPayload({ bids: [[100, 1]], asks: [[101, 1]] }),
      metadata: h.metadataGenerator.nextRoot(),
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(recorded).toHaveLength(2);
    expect(h.eventsOfType('BOOK_DEPTH')).toHaveLength(1);
    expect(h.adapter.getStats().invalidOrderBooks).toBe(1);
  });
});

describe('диагностика', () => {
  it('считает все наблюдения, включая отвергнутые', async () => {
    const h = createHarness();
    await h.publishBook({ bids: [[100, 1]], asks: [[101, 1]] });
    await h.publishBook({ bids: [[0, 1]], asks: [[101, 1]] });
    await h.publishTrade({ id: 't1' });
    await h.publishTrade({ id: 't2', amount: undefined });

    const stats = h.adapter.getStats();
    expect(stats.rawMessagesSeen).toBe(4);
    expect(stats.orderBooksReceived).toBe(2);
    expect(stats.orderBooksPublished).toBe(1);
    expect(stats.invalidOrderBooks).toBe(1);
    expect(stats.bookUpdatedPublished).toBe(1);
    expect(stats.tradesReceived).toBe(2);
    expect(stats.tradesPublished).toBe(1);
    expect(stats.tradesMissingAmount).toBe(1);
    expect(stats.semanticPublishFailures).toBe(0);
    expect(stats.activeInstrumentStates).toBe(1);
  });
});
