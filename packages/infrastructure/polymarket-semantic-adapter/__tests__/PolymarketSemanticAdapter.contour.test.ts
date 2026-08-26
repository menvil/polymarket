/**
 * Контурные инварианты адаптера: causality, изоляция, lifecycle, память.
 *
 * @remarks
 * Здесь проверяется НЕ маппинг значений, а то, что адаптер корректно
 * встроен в контур: не ломает запись сырых данных, не мутирует payload
 * источника, не владеет шиной и не течёт по памяти.
 */
import { describe, expect, it, beforeEach, afterEach, jest } from '@jest/globals';
import { asInstrumentId, asMarketId } from '@polymarket/ids';
import { EventBus } from '@polymarket/event-bus';
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import { MessageMetadataGenerator } from '@polymarket/messages';
import { LiveClock } from '@polymarket/time';
import type { PolymarketExternalMessage } from '@polymarket/polymarket-v2';
import { PolymarketSemanticAdapter } from '../src/index.js';
import {
  MARKET_ID,
  TOKEN_A,
  TOKEN_B,
  createHarness,
  publishBook,
  publishPriceChange,
  publishReferencePrice,
  silentLogger,
  type Harness,
} from './support/fixtures.js';

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

afterEach(() => {
  h.adapter.close();
});

describe('causality metadata', () => {
  it('semantic-события — children raw-наблюдения, а не новые корни', async () => {
    const raw = await publishBook(h, {
      tokenId: TOKEN_A,
      bids: [{ price: '0.50', size: '10' }],
      asks: [{ price: '0.52', size: '7' }],
    });

    const events = h.published;
    expect(events.length).toBeGreaterThan(0);

    for (const event of events) {
      // Причина — конкретное raw-сообщение
      expect(event.metadata.causationId).toBe(raw.metadata.messageId);
      // Корень цепочки унаследован от наблюдения
      expect(event.metadata.correlationId).toBe(raw.metadata.correlationId);
      // Это НЕ root: у root correlationId === собственный messageId
      expect(event.metadata.correlationId).not.toBe(event.metadata.messageId);
      // Metadata не скопирована буквально — у события своя identity
      expect(event.metadata.messageId).not.toBe(raw.metadata.messageId);
    }
  });

  it('одно raw-наблюдение → несколько semantic-событий с РАЗНОЙ identity', async () => {
    const raw = await publishBook(h, {
      tokenId: TOKEN_A,
      bids: [{ price: '0.50', size: '10' }],
      asks: [{ price: '0.52', size: '7' }],
    });

    const depth = h.eventsOfType('BOOK_DEPTH')[0]!;
    const updated = h.eventsOfType('BOOK_UPDATED')[0]!;

    expect(depth.metadata.causationId).toBe(raw.metadata.messageId);
    expect(updated.metadata.causationId).toBe(raw.metadata.messageId);
    expect(depth.metadata.messageId).not.toBe(updated.metadata.messageId);
    expect(depth.metadata.sequence).toBeLessThan(updated.metadata.sequence);
  });

  it('мульти-токенное событие даёт children ОДНОГО родителя', async () => {
    await publishBook(h, { tokenId: TOKEN_A, bids: [{ price: '0.50', size: '1' }], asks: [] });
    await publishBook(h, { tokenId: TOKEN_B, bids: [{ price: '0.30', size: '1' }], asks: [] });
    h.published.length = 0;

    const raw = await publishPriceChange(h, {
      changes: [
        { tokenId: TOKEN_A, price: '0.50', size: '2', side: 'BUY' },
        { tokenId: TOKEN_B, price: '0.30', size: '3', side: 'BUY' },
      ],
    });

    expect(h.published.length).toBeGreaterThanOrEqual(2);
    for (const event of h.published) {
      expect(event.metadata.causationId).toBe(raw.metadata.messageId);
    }
  });

  it('reference-price событие тоже сохраняет causality', async () => {
    const raw = await publishReferencePrice(h, {
      channel: 'POLYMARKET_CRYPTO_BINANCE',
      symbol: 'btcusdt',
      value: '79341.36',
    });

    const event = h.eventsOfType('REFERENCE_PRICE_UPDATED')[0]!;
    expect(event.metadata.causationId).toBe(raw.metadata.messageId);
    expect(event.metadata.correlationId).toBe(raw.metadata.correlationId);
  });
});

describe('веерная раздача не мутирует raw payload', () => {
  it('после semantic-обработки payload наблюдения идентичен исходному', async () => {
    const seenByRecorder: unknown[] = [];
    h.bus.subscribe('POLYMARKET_MARKET', (message) => {
      seenByRecorder.push(message.payload);
    });

    const bids = [
      { price: '0.50', size: '10' },
      { price: '0.48', size: '30' },
    ];
    const asks = [{ price: '0.52', size: '7' }];
    const before = JSON.parse(JSON.stringify({ bids, asks })) as unknown;

    const raw = await publishBook(h, { tokenId: TOKEN_A, bids, asks });

    // Тот же объект дошёл до второго потребителя (шина не копирует payload)
    expect(seenByRecorder).toHaveLength(1);
    expect(seenByRecorder[0]).toBe(raw.payload);

    // И адаптер его не тронул: ни порядок, ни значения, ни структура
    const payload = raw.payload as unknown as {
      payload: { bids: unknown; asks: unknown };
    };
    expect({ bids: payload.payload.bids, asks: payload.payload.asks }).toEqual(before);
    // Уровни остались исходными строками, а не превратились в VO/числа
    expect(payload.payload.bids).toBe(bids);
  });
});

describe('изоляция от recorder', () => {
  it('падение semantic-публикации НЕ мешает получению raw-сообщения recorder-ом', async () => {
    const bus = new ExternalMessageBus<PolymarketExternalMessage>();
    const metadataGenerator = new MessageMetadataGenerator({ clock: new LiveClock() });
    const eventBus = new EventBus(silentLogger());
    // Application-подписчик, который стабильно падает
    eventBus.subscribe('BOOK_DEPTH', () => {
      throw new Error('downstream projection exploded');
    });

    const recorded: unknown[] = [];
    bus.subscribe('POLYMARKET_MARKET', (message) => {
      recorded.push(message.payload);
    });

    const adapter = new PolymarketSemanticAdapter({
      bus,
      eventBus,
      metadataGenerator,
      logger: silentLogger(),
    });
    adapter.start();

    const publishResult = await bus.publish({
      type: 'POLYMARKET_MARKET',
      payload: {
        topic: 'market',
        type: 'book',
        payload: {
          tokenId: TOKEN_A,
          market: MARKET_ID,
          bids: [{ price: '0.50', size: '10' }],
          asks: [],
          timestamp: 1_787_751_722_763,
        },
      },
      metadata: metadataGenerator.nextRoot(),
    } as never);

    // Raw-контур цел: сообщение доставлено и опубликовано без ошибки
    expect(publishResult.ok).toBe(true);
    expect(recorded).toHaveLength(1);
    // Адаптер продолжает работать
    expect(adapter.getStats().booksReceived).toBe(1);

    adapter.close();
  });

  it('отказ Application-шины считается счётчиком, а не исключением наружу', async () => {
    const bus = new ExternalMessageBus<PolymarketExternalMessage>();
    const metadataGenerator = new MessageMetadataGenerator({ clock: new LiveClock() });
    const eventBus = new EventBus(silentLogger());
    jest.spyOn(eventBus, 'publish').mockResolvedValue({
      ok: false,
      error: new Error('bus rejected') as never,
    } as never);

    const adapter = new PolymarketSemanticAdapter({
      bus,
      eventBus,
      metadataGenerator,
      logger: silentLogger(),
    });
    adapter.start();

    const result = await bus.publish({
      type: 'POLYMARKET_CRYPTO_BINANCE',
      payload: {
        topic: 'prices.crypto.binance',
        type: 'update',
        timestamp: 1_787_751_722_763,
        payload: { symbol: 'btcusdt', timestamp: 1_787_751_721_000, value: '79341.36' },
      },
      metadata: metadataGenerator.nextRoot(),
    } as never);

    expect(result.ok).toBe(true);
    const stats = adapter.getStats();
    expect(stats.semanticPublishFailures).toBe(1);
    // Неопубликованное событие не засчитывается как опубликованное
    expect(stats.referenceBinance).toBe(0);

    adapter.close();
    jest.restoreAllMocks();
  });
});

describe('lifecycle', () => {
  it('повторный start не создаёт вторую подписку', async () => {
    h.adapter.start(); // второй раз
    await publishBook(h, { tokenId: TOKEN_A, bids: [{ price: '0.50', size: '1' }], asks: [] });

    expect(h.eventsOfType('BOOK_DEPTH')).toHaveLength(1);
    expect(h.adapter.getStats().rawMessagesSeen).toBe(1);
  });

  it('после close semantic-выход прекращается, а другие подписчики живы', async () => {
    const stillDelivered: unknown[] = [];
    h.bus.subscribe('POLYMARKET_MARKET', (message) => {
      stillDelivered.push(message.payload);
    });

    await publishBook(h, { tokenId: TOKEN_A, bids: [{ price: '0.50', size: '1' }], asks: [] });
    expect(h.eventsOfType('BOOK_DEPTH')).toHaveLength(1);

    h.adapter.close();
    h.published.length = 0;

    const result = await publishBook(h, {
      tokenId: TOKEN_A,
      bids: [{ price: '0.51', size: '2' }],
      asks: [],
    });

    // Ни одного semantic-события после close
    expect(h.published).toHaveLength(0);
    // Шина жива и продолжает раздавать сообщения остальным
    expect(stillDelivered).toHaveLength(2);
    expect(stillDelivered[1]).toBe(result.payload);
  });

  it('close идемпотентен', () => {
    expect(() => {
      h.adapter.close();
      h.adapter.close();
    }).not.toThrow();
  });

  it('close освобождает состояние реконструкции', async () => {
    await publishBook(h, { tokenId: TOKEN_A, bids: [{ price: '0.50', size: '1' }], asks: [] });
    expect(h.adapter.getStats().activeBookStates).toBe(1);

    h.adapter.close();
    expect(h.adapter.getStats().activeBookStates).toBe(0);
  });

  it('close НЕ закрывает общий raw bus', async () => {
    h.adapter.close();
    const result = await h.bus.publish({
      type: 'POLYMARKET_MARKET',
      payload: { topic: 'market', type: 'book', payload: { tokenId: TOKEN_A, market: MARKET_ID, bids: [], asks: [] } },
      metadata: h.metadataGenerator.nextRoot(),
    } as never);

    expect(result.ok).toBe(true);
    expect(h.bus.getStats().closed).toBe(false);
  });

  it('адаптер можно перезапустить после close', async () => {
    h.adapter.close();
    h.adapter.start();

    await publishBook(h, { tokenId: TOKEN_A, bids: [{ price: '0.50', size: '1' }], asks: [] });
    expect(h.eventsOfType('BOOK_DEPTH')).toHaveLength(1);
  });
});

describe('границы памяти', () => {
  it('forgetInstrument освобождает состояние одного токена', async () => {
    await publishBook(h, { tokenId: TOKEN_A, bids: [], asks: [] });
    await publishBook(h, { tokenId: TOKEN_B, bids: [], asks: [] });
    expect(h.adapter.getStats().activeBookStates).toBe(2);

    expect(h.adapter.forgetInstrument(asInstrumentId(TOKEN_A)!)).toBe(true);
    expect(h.adapter.getStats().activeBookStates).toBe(1);
  });

  it('forgetMarket освобождает обе стороны рынка', async () => {
    await publishBook(h, { tokenId: TOKEN_A, bids: [], asks: [] });
    await publishBook(h, { tokenId: TOKEN_B, bids: [], asks: [] });

    expect(h.adapter.forgetMarket(asMarketId(MARKET_ID)!)).toBe(2);
    expect(h.adapter.getStats().activeBookStates).toBe(0);
  });

  it('после forget дельта снова считается пришедшей до снапшота', async () => {
    await publishBook(h, { tokenId: TOKEN_A, bids: [{ price: '0.50', size: '1' }], asks: [] });
    h.adapter.forgetInstrument(asInstrumentId(TOKEN_A)!);
    h.published.length = 0;

    await publishPriceChange(h, {
      changes: [{ tokenId: TOKEN_A, price: '0.50', size: '2', side: 'BUY' }],
    });

    expect(h.published).toHaveLength(0);
    expect(h.adapter.getStats().deltaBeforeSnapshot).toBe(1);
  });
});

describe('порядок и vendor-время', () => {
  it('события обрабатываются в порядке доставки шины, без переупорядочивания', async () => {
    await publishBook(h, { tokenId: TOKEN_A, bids: [{ price: '0.50', size: '1' }], asks: [] });
    await publishPriceChange(h, {
      changes: [{ tokenId: TOKEN_A, price: '0.51', size: '2', side: 'BUY' }],
      timestamp: 1_787_751_723_000,
    });
    // Vendor-время «назад» — но поток НЕ перестраивается
    await publishPriceChange(h, {
      changes: [{ tokenId: TOKEN_A, price: '0.52', size: '3', side: 'BUY' }],
      timestamp: 1_787_751_722_000,
    });

    const tops = h
      .eventsOfType('BOOK_UPDATED')
      .map((event) => event.payload.topOfBook.bestBid?.value().toString());
    expect(tops).toEqual(['0.5', '0.51', '0.52']);
  });

  it('vendor-время «назад» учитывается диагностикой', async () => {
    await publishBook(h, {
      tokenId: TOKEN_A,
      bids: [{ price: '0.50', size: '1' }],
      asks: [],
      timestamp: 1_787_751_723_000,
    });
    await publishBook(h, {
      tokenId: TOKEN_A,
      bids: [{ price: '0.51', size: '1' }],
      asks: [],
      timestamp: 1_787_751_722_000,
    });

    expect(h.adapter.getStats().backwardVendorTimestamps).toBe(1);
    // Наблюдение всё равно применено — поток не отбрасывается
    expect(h.eventsOfType('BOOK_DEPTH')).toHaveLength(2);
  });
});

describe('stats', () => {
  it('счётчики отражают фактический поток', async () => {
    await publishBook(h, {
      tokenId: TOKEN_A,
      bids: [{ price: '0.50', size: '10' }],
      asks: [{ price: '0.52', size: '5' }],
    });
    await publishPriceChange(h, {
      changes: [{ tokenId: TOKEN_A, price: '0.50', size: '11', side: 'BUY' }],
    });
    await publishReferencePrice(h, {
      channel: 'POLYMARKET_CRYPTO_CHAINLINK_TWAP',
      symbol: 'btc/usd',
      value: '78376.35',
      windowSeconds: 60,
    });

    const stats = h.adapter.getStats();
    expect(stats.rawMessagesSeen).toBe(3);
    expect(stats.booksReceived).toBe(1);
    expect(stats.booksPublished).toBe(2); // book + применённая дельта
    expect(stats.priceChangesReceived).toBe(1);
    expect(stats.priceChangesApplied).toBe(1);
    expect(stats.referenceTwap).toBe(1);
    expect(stats.activeBookStates).toBe(1);
    expect(stats.desyncs).toBe(0);
    expect(stats.semanticPublishFailures).toBe(0);
  });
});
