/**
 * Поведенческие тесты PolymarketSource: публикация, identity payload,
 * causality/ordering, lifecycle, policy отказов.
 *
 * @remarks
 * Bus в тестах — РЕАЛЬНЫЙ `ExternalMessageBus<PolymarketExternalMessage>`
 * (интеграция с настоящим контуром доставки), fake-ится только граница SDK.
 */
import { describe, it, expect } from '@jest/globals';
import { LiveClock } from '@polymarket/time';
import { MessageMetadataGenerator } from '@polymarket/messages';
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import { PolymarketSource } from '../src/index.js';
import type { PolymarketExternalMessage } from '../src/index.js';
import {
  CapturingLogger,
  FakePolymarketClient,
  flushAsync,
} from './helpers/fakes.js';
import {
  TOKEN_ID_UP,
  createBinanceEvent,
  createBookEvent,
  createChainlinkEvent,
  createPriceChangeEvent,
} from './helpers/sdkFixtures.js';

/** Собирает полный test harness вокруг реального bus и fake SDK. */
function createHarness(): {
  client: FakePolymarketClient;
  bus: ExternalMessageBus<PolymarketExternalMessage>;
  generator: MessageMetadataGenerator;
  logger: CapturingLogger;
  source: PolymarketSource;
  received: PolymarketExternalMessage[];
} {
  const client = new FakePolymarketClient();
  const bus = new ExternalMessageBus<PolymarketExternalMessage>();
  const generator = new MessageMetadataGenerator({ clock: new LiveClock() });
  const logger = new CapturingLogger();
  const source = new PolymarketSource({ client, bus, metadataGenerator: generator, logger });

  const received: PolymarketExternalMessage[] = [];
  bus.subscribe('POLYMARKET_MARKET', (message) => {
    received.push(message);
  });
  bus.subscribe('POLYMARKET_CRYPTO_BINANCE', (message) => {
    received.push(message);
  });
  bus.subscribe('POLYMARKET_CRYPTO_CHAINLINK', (message) => {
    received.push(message);
  });

  return { client, bus, generator, logger, source, received };
}

describe('market SDK event publication (TEST 1)', () => {
  it('оборачивает market-событие в POLYMARKET_MARKET и публикует ровно один message', async () => {
    const { client, source, received } = createHarness();

    await source.subscribeMarket([TOKEN_ID_UP]);
    expect(client.subscribeCalls).toEqual([[{ topic: 'market', tokenIds: [TOKEN_ID_UP] }]]);

    const event = createBookEvent();
    client.marketHandles[0]?.emit(event);
    await flushAsync();

    expect(received).toHaveLength(1);
    const message = received[0];
    if (message === undefined) throw new Error('bus delivered no message');

    expect(message.type).toBe('POLYMARKET_MARKET');
    // payload — ТОТ ЖЕ объект SDK (identity, не копия)
    expect(message.payload).toBe(event);
    // metadata существует и является root новой causal chain
    expect(message.metadata.correlationId).toBe(message.metadata.messageId);
    expect(message.metadata.causationId).toBeUndefined();

    await source.close();
  });
});

describe('RTDS publication (TEST 2)', () => {
  it('binance-событие уходит как POLYMARKET_CRYPTO_BINANCE с тем же payload', async () => {
    const { client, source, received } = createHarness();

    await source.subscribeCryptoPrices('prices.crypto.binance', ['btcusdt']);
    expect(client.subscribeCalls).toEqual([
      [{ topic: 'prices.crypto.binance', symbols: ['btcusdt'] }],
    ]);

    const event = createBinanceEvent();
    client.cryptoHandles[0]?.emit(event);
    await flushAsync();

    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe('POLYMARKET_CRYPTO_BINANCE');
    expect(received[0]?.payload).toBe(event);

    await source.close();
  });

  it('chainlink-событие маршрутизируется по vendor topic в POLYMARKET_CRYPTO_CHAINLINK', async () => {
    const { client, source, received } = createHarness();

    await source.subscribeCryptoPrices('prices.crypto.chainlink', ['btc/usd']);

    const event = createChainlinkEvent();
    client.cryptoHandles[0]?.emit(event);
    await flushAsync();

    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe('POLYMARKET_CRYPTO_CHAINLINK');
    expect(received[0]?.payload).toBe(event);

    await source.close();
  });
});

describe('no mapping (TEST 3)', () => {
  it('payload глубоко равен исходному SDK-событию и не мутирован', async () => {
    const { client, source, received } = createHarness();
    await source.subscribeMarket([TOKEN_ID_UP]);

    const event = createPriceChangeEvent();
    const snapshotBeforeEmit = structuredClone(event);
    client.marketHandles[0]?.emit(event);
    await flushAsync();

    expect(received[0]?.payload).toEqual(snapshotBeforeEmit);
    // Vendor discriminators сохранены внутри payload
    expect(received[0]?.payload).toMatchObject({ topic: 'market', type: 'price_change' });

    await source.close();
  });
});

describe('serialization (TEST 4)', () => {
  it('payload каждого типа JSON-сериализуем без потерь и сохраняет discriminators', async () => {
    const { client, source, received } = createHarness();
    await source.subscribeMarket([TOKEN_ID_UP]);
    await source.subscribeCryptoPrices('prices.crypto.binance', ['btcusdt']);
    await source.subscribeCryptoPrices('prices.crypto.chainlink', ['btc/usd']);

    client.marketHandles[0]?.emit(createBookEvent());
    client.cryptoHandles[0]?.emit(createBinanceEvent());
    client.cryptoHandles[1]?.emit(createChainlinkEvent());
    await flushAsync();

    expect(received).toHaveLength(3);
    for (const message of received) {
      const roundTripped: unknown = JSON.parse(JSON.stringify(message.payload));
      // Полный roundtrip без потерь — в payload нет несериализуемых полей
      expect(roundTripped).toEqual(message.payload);
    }
    // Discriminators переживают сериализацию
    const serialized = received.map((m) => JSON.parse(JSON.stringify(m.payload)) as {
      topic: string;
      type: string;
    });
    expect(serialized.map((p) => `${p.topic}:${p.type}`)).toEqual([
      'market:book',
      'prices.crypto.binance:update',
      'prices.crypto.chainlink:update',
    ]);

    await source.close();
  });
});

describe('canonical metadata (TEST 5)', () => {
  it('каждое внешнее наблюдение — root: correlationId === messageId, causationId отсутствует', async () => {
    const { client, source, received } = createHarness();
    await source.subscribeMarket([TOKEN_ID_UP]);
    await source.subscribeCryptoPrices('prices.crypto.binance', ['btcusdt']);

    client.marketHandles[0]?.emit(createBookEvent());
    client.cryptoHandles[0]?.emit(createBinanceEvent());
    await flushAsync();

    expect(received).toHaveLength(2);
    for (const message of received) {
      expect(message.metadata.correlationId).toBe(message.metadata.messageId);
      expect(message.metadata.causationId).toBeUndefined();
    }

    await source.close();
  });
});

describe('multiple events without sorting (TEST 6)', () => {
  it('A/B/C доставляются в порядке получения, даже если их timestamps убывают', async () => {
    const { client, source, received } = createHarness();
    await source.subscribeMarket([TOKEN_ID_UP]);

    // Timestamps сознательно в ОБРАТНОМ порядке: source не сортирует
    const a = createBookEvent({ hash: 'A', timestamp: 3000 });
    const b = createBookEvent({ hash: 'B', timestamp: 2000 });
    const c = createBookEvent({ hash: 'C', timestamp: 1000 });
    client.marketHandles[0]?.emit(a);
    client.marketHandles[0]?.emit(b);
    client.marketHandles[0]?.emit(c);
    await flushAsync();

    expect(received.map((m) => m.payload)).toEqual([a, b, c]);

    await source.close();
  });
});

describe('sequence ordering (TEST 7)', () => {
  it('sequence строго растёт в порядке публикаций через общий generator', async () => {
    const { client, source, received } = createHarness();
    await source.subscribeMarket([TOKEN_ID_UP]);
    await source.subscribeCryptoPrices('prices.crypto.binance', ['btcusdt']);

    client.marketHandles[0]?.emit(createBookEvent({ hash: 'first' }));
    await flushAsync();
    client.cryptoHandles[0]?.emit(createBinanceEvent({ value: '64300' }));
    await flushAsync();
    client.marketHandles[0]?.emit(createBookEvent({ hash: 'third' }));
    await flushAsync();

    expect(received).toHaveLength(3);
    const sequences = received.map((m) => m.metadata.sequence);
    for (let i = 1; i < sequences.length; i += 1) {
      expect(sequences[i]).toBeGreaterThan(sequences[i - 1] ?? Number.NaN);
    }

    await source.close();
  });
});

describe('close lifecycle (TEST 8)', () => {
  it('close() закрывает все handles, терминирует итераторы и идемпотентен', async () => {
    const { client, source } = createHarness();
    await source.subscribeMarket([TOKEN_ID_UP]);
    await source.subscribeCryptoPrices('prices.crypto.binance', ['btcusdt']);

    await source.close();

    expect(client.marketHandles[0]?.closeCalls).toBeGreaterThanOrEqual(1);
    expect(client.cryptoHandles[0]?.closeCalls).toBeGreaterThanOrEqual(1);
    expect(source.isClosed).toBe(true);

    // Идемпотентность
    await source.close();

    // Новые подписки запрещены
    await expect(source.subscribeMarket([TOKEN_ID_UP])).rejects.toThrow(
      'PolymarketSource is closed and cannot open new subscriptions',
    );
  });

  it('индивидуальный close подписки останавливает только её', async () => {
    const { client, source, received } = createHarness();
    const marketSubscription = await source.subscribeMarket([TOKEN_ID_UP]);
    await source.subscribeCryptoPrices('prices.crypto.binance', ['btcusdt']);

    await marketSubscription.close();
    expect(client.marketHandles[0]?.closeCalls).toBeGreaterThanOrEqual(1);
    expect(client.cryptoHandles[0]?.closeCalls).toBe(0);

    // Вторая подписка продолжает доставлять
    client.cryptoHandles[0]?.emit(createBinanceEvent());
    await flushAsync();
    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe('POLYMARKET_CRYPTO_BINANCE');

    await source.close();
  });

  it('события после закрытия handle не публикуются (нет висящих итераторов)', async () => {
    const { client, source, received } = createHarness();
    await source.subscribeMarket([TOKEN_ID_UP]);
    await source.close();

    client.marketHandles[0]?.emit(createBookEvent());
    await flushAsync();

    expect(received).toHaveLength(0);
  });
});

describe('publication failure policy (TEST 9)', () => {
  it('Err от bus.publish → source failed, все подписки закрыты, ошибка залогирована', async () => {
    const { client, bus, source, logger } = createHarness();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await source.subscribeMarket([TOKEN_ID_UP]);
      await source.subscribeCryptoPrices('prices.crypto.binance', ['btcusdt']);

      // Закрываем БАС (не source): следующая публикация вернёт Err(MessageBusClosedError)
      const closeResult = await bus.close();
      expect(closeResult.ok).toBe(true);

      client.marketHandles[0]?.emit(createBookEvent());
      await flushAsync();

      expect(source.hasFailed).toBe(true);
      // Отказ детерминированно закрывает ВСЕ подписки source
      expect(client.marketHandles[0]?.closeCalls).toBeGreaterThanOrEqual(1);
      expect(client.cryptoHandles[0]?.closeCalls).toBeGreaterThanOrEqual(1);

      const errors = logger.byLevel('error');
      expect(errors.some((e) => e.message.includes('rejected publication'))).toBe(true);

      // Новые подписки запрещены после отказа
      await expect(source.subscribeMarket([TOKEN_ID_UP])).rejects.toThrow(
        'PolymarketSource has failed and cannot open new subscriptions',
      );

      // close() после отказа остаётся корректным
      await source.close();
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('падение SDK-итератора → source failed без unhandled rejection', async () => {
    const { client, source, logger } = createHarness();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await source.subscribeMarket([TOKEN_ID_UP]);
      await source.subscribeCryptoPrices('prices.crypto.binance', ['btcusdt']);

      client.marketHandles[0]?.fail(new Error('transport connection lost'));
      await flushAsync();

      expect(source.hasFailed).toBe(true);
      expect(client.cryptoHandles[0]?.closeCalls).toBeGreaterThanOrEqual(1);
      const errors = logger.byLevel('error');
      expect(errors.some((e) => e.message.includes('subscription stream failed'))).toBe(true);

      await source.close();
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('ошибка SDK subscribe пробрасывается вызывающему как есть', async () => {
    const { client, source } = createHarness();
    client.subscribeError = new Error('SDK transport error: connection refused');

    await expect(source.subscribeMarket([TOKEN_ID_UP])).rejects.toThrow(
      'SDK transport error: connection refused',
    );
  });
});
