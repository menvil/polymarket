/**
 * Подписка Source на официальный settlement-поток Chainlink TWAP (MR-B).
 *
 * @remarks
 * Проверяется контракт vendor-границы: spec подписки собирается ровно так,
 * как его описывает официальный SDK 0.6.0
 * (`{topic: 'prices.crypto.chainlink.twap', windowSeconds, symbols}`), а
 * событие уходит в bus СВОИМ routing-типом с нетронутым payload. Bus —
 * настоящий, fake-ится только граница SDK (тот же приём, что в остальных
 * тестах Source).
 */
import { describe, it, expect } from '@jest/globals';
import { LiveClock } from '@polymarket/time';
import { MessageMetadataGenerator } from '@polymarket/messages';
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import { PolymarketSource } from '../src/index.js';
import type { CryptoPricesChainlinkTwapEvent, PolymarketExternalMessage } from '../src/index.js';
import { CapturingLogger, FakePolymarketClient, flushAsync } from './helpers/fakes.js';

function createHarness(): {
  client: FakePolymarketClient;
  logger: CapturingLogger;
  source: PolymarketSource;
  received: PolymarketExternalMessage[];
} {
  const client = new FakePolymarketClient();
  const bus = new ExternalMessageBus<PolymarketExternalMessage>();
  const logger = new CapturingLogger();
  const source = new PolymarketSource({
    client,
    bus,
    metadataGenerator: new MessageMetadataGenerator({ clock: new LiveClock() }),
    logger,
  });

  const received: PolymarketExternalMessage[] = [];
  bus.subscribe('POLYMARKET_CRYPTO_CHAINLINK_TWAP', (message) => {
    received.push(message);
  });
  bus.subscribe('POLYMARKET_CRYPTO_CHAINLINK', (message) => {
    received.push(message);
  });

  return { client, logger, source, received };
}

/** Событие settlement-потока в форме, характеризованной live 2026-08-26. */
function twapEvent(
  overrides: Partial<{ symbol: string; value: string; windowSeconds: 30 | 60 }> = {},
): CryptoPricesChainlinkTwapEvent {
  return {
    topic: 'prices.crypto.chainlink.twap',
    type: 'update',
    timestamp: 1787752201895,
    payload: {
      symbol: overrides.symbol ?? 'btc/usd',
      timestamp: 1787752200000,
      value: overrides.value ?? '78400.701754893592952832',
      windowSeconds: overrides.windowSeconds ?? 60,
    },
  } as CryptoPricesChainlinkTwapEvent;
}

describe('spec подписки повторяет контракт официального SDK (PART 12/16)', () => {
  it('окно уходит ОТДЕЛЬНЫМ полем spec-а, а не частью символа', async () => {
    const { client, source } = createHarness();

    await source.subscribeChainlinkTwap(60, ['btc/usd']);

    expect(client.subscribeCalls).toEqual([
      [{ topic: 'prices.crypto.chainlink.twap', windowSeconds: 60, symbols: ['btc/usd'] }],
    ]);

    await source.close();
  });

  it('окно 30 и окно 60 дают ДВА разных spec-а и два handle', async () => {
    const { client, source } = createHarness();

    await source.subscribeChainlinkTwap(30, ['btc/usd']);
    await source.subscribeChainlinkTwap(60, ['btc/usd']);

    expect(client.subscribeCalls).toEqual([
      [{ topic: 'prices.crypto.chainlink.twap', windowSeconds: 30, symbols: ['btc/usd'] }],
      [{ topic: 'prices.crypto.chainlink.twap', windowSeconds: 60, symbols: ['btc/usd'] }],
    ]);
    expect(client.twapHandles).toHaveLength(2);

    await source.close();
  });

  it('spot-подписка НЕ получает поля окна (у неё другой spec)', async () => {
    const { client, source } = createHarness();

    await source.subscribeCryptoPrices('prices.crypto.chainlink', ['btc/usd']);

    expect(client.subscribeCalls[0]?.[0]).toEqual({
      topic: 'prices.crypto.chainlink',
      symbols: ['btc/usd'],
    });

    await source.close();
  });
});

describe('payload остаётся source-native (PART 18/60)', () => {
  it('SDK-событие уходит в bus ТОЙ ЖЕ ссылкой под своим routing-типом', async () => {
    const { client, source, received } = createHarness();

    await source.subscribeChainlinkTwap(60, ['btc/usd']);
    const event = twapEvent();
    client.twapHandles[0]?.emit(event);
    await flushAsync();

    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe('POLYMARKET_CRYPTO_CHAINLINK_TWAP');
    expect(received[0]?.payload).toBe(event); // identity, не копия
    // Новая причинная цепь на каждое внешнее наблюдение
    expect(received[0]?.metadata.correlationId).toBe(received[0]?.metadata.messageId);
    expect(received[0]?.metadata.causationId).toBeUndefined();

    await source.close();
  });

  it('окно приходит обратно ВНУТРИ payload — replay различит потоки без контекста', async () => {
    const { client, source, received } = createHarness();

    await source.subscribeChainlinkTwap(30, ['btc/usd']);
    client.twapHandles[0]?.emit(twapEvent({ windowSeconds: 30 }));
    await flushAsync();

    expect(received[0]?.payload).toMatchObject({
      topic: 'prices.crypto.chainlink.twap',
      payload: { windowSeconds: 30, symbol: 'btc/usd' },
    });

    await source.close();
  });

  it('settlement-событие НЕ публикуется как spot-наблюдение', async () => {
    const { client, source, received } = createHarness();

    await source.subscribeChainlinkTwap(60, ['btc/usd']);
    client.twapHandles[0]?.emit(twapEvent());
    await flushAsync();

    expect(received.map((message) => message.type)).toEqual([
      'POLYMARKET_CRYPTO_CHAINLINK_TWAP',
    ]);

    await source.close();
  });
});

describe('lifecycle settlement-подписки', () => {
  it('close() подписки закрывает её SDK-handle', async () => {
    const { client, source } = createHarness();

    const subscription = await source.subscribeChainlinkTwap(60, ['btc/usd']);
    await subscription.close();

    expect(client.twapHandles[0]?.closeCalls).toBe(1);

    await source.close();
  });

  it('close() source закрывает settlement-подписку вместе со spot', async () => {
    const { client, source } = createHarness();

    await source.subscribeChainlinkTwap(60, ['btc/usd']);
    await source.subscribeCryptoPrices('prices.crypto.chainlink', ['btc/usd']);

    await source.close();

    expect(client.twapHandles[0]?.closeCalls).toBe(1);
    expect(client.cryptoHandles[0]?.closeCalls).toBe(1);
    expect(source.isClosed).toBe(true);
  });

  it('после close() новая settlement-подписка отклоняется', async () => {
    const { source } = createHarness();
    await source.close();

    await expect(source.subscribeChainlinkTwap(60, ['btc/usd'])).rejects.toThrow(
      'PolymarketSource is closed',
    );
  });

  it('открытие логируется с окном (диагностика различает потоки)', async () => {
    const { logger, source } = createHarness();

    await source.subscribeChainlinkTwap(30, ['btc/usd']);

    const opened = logger
      .byLevel('info')
      .find((entry) => entry.message.includes('Chainlink TWAP subscription opened'));
    expect(opened?.context).toMatchObject({
      topic: 'prices.crypto.chainlink.twap',
      windowSeconds: 30,
      symbolCount: 1,
    });

    await source.close();
  });
});
