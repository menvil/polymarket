/**
 * Type-contract тесты Polymarket ExternalMessage union (PART 26).
 *
 * @remarks
 * Compile-time проверки (typecheck/ts-jest): typed subscribe сужает payload
 * до КОНКРЕТНОГО SDK-типа без `any`/`unknown`/broad casts; официальный
 * `PublicClient` присваивается порту `PolymarketSubscribeClient` без
 * адаптеров; канонический конверт отвергает несовпадающие пары
 * type ↔ payload. Runtime-ассерты минимальны.
 */
import { describe, it, expect } from '@jest/globals';
import { unsafeMessageId, unsafeRunId } from '@polymarket/ids';
import { TimestampService } from '@polymarket/timestamp';
import type { MessageMetadata } from '@polymarket/messages';
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import type { createPublicClient } from '@polymarket/client';
import type {
  CryptoPricesBinanceEvent,
  CryptoPricesChainlinkEvent,
  StandardMarketEvent,
} from '@polymarket/bindings/subscriptions';
import type {
  PolymarketExternalMessage,
  PolymarketExternalMessagePublisher,
  PolymarketSubscribeClient,
} from '../src/index.js';
import { createBinanceEvent, createBookEvent } from './helpers/sdkFixtures.js';

/** Compile-time equality: `true` только когда A и B — один и тот же тип. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

/** Детерминированная fixture-metadata для compile-time проверок конверта. */
function fixtureMetadata(): MessageMetadata {
  const createdAt = TimestampService.create(1786668087123);
  if (!createdAt.ok) throw createdAt.error;
  const messageId = unsafeMessageId('testrun1-1786668087-123-000-000-000000001');
  return {
    messageId,
    runId: unsafeRunId('testrun1'),
    sequence: 1,
    createdAt: createdAt.value,
    createdAtUnixSeconds: 1786668087,
    millisecondOfSecond: 123,
    microsecondOfMillisecond: 0,
    nanosecondOfMicrosecond: 0,
    correlationId: messageId,
  };
}

describe('typed subscribe narrowing', () => {
  it('POLYMARKET_MARKET сужает payload до StandardMarketEvent (compile-time)', () => {
    const bus = new ExternalMessageBus<PolymarketExternalMessage>();

    bus.subscribe('POLYMARKET_MARKET', (message) => {
      // payload — РЕАЛЬНЫЙ SDK market-event union, без unknown/casts
      const payloadIsSdkEvent: Equal<typeof message.payload, StandardMarketEvent> = true;
      expect(payloadIsSdkEvent).toBe(true);
      // Narrowing по vendor discriminator работает внутри payload
      if (message.payload.type === 'book') {
        const bids: ReadonlyArray<{ price: string; size: string }> = message.payload.payload.bids;
        expect(Array.isArray(bids)).toBe(true);
      }
    });

    expect(bus.getStats().subscribedTypes).toBe(1);
  });

  it('RTDS-типы сужают payload до конкретного crypto-события (compile-time)', () => {
    const bus = new ExternalMessageBus<PolymarketExternalMessage>();

    bus.subscribe('POLYMARKET_CRYPTO_BINANCE', (message) => {
      const payloadIsBinance: Equal<typeof message.payload, CryptoPricesBinanceEvent> = true;
      expect(payloadIsBinance).toBe(true);
      const topic: 'prices.crypto.binance' = message.payload.topic;
      const value: string = message.payload.payload.value;
      expect(topic).toBe('prices.crypto.binance');
      expect(typeof value).toBe('string');
    });

    bus.subscribe('POLYMARKET_CRYPTO_CHAINLINK', (message) => {
      const payloadIsChainlink: Equal<typeof message.payload, CryptoPricesChainlinkEvent> = true;
      expect(payloadIsChainlink).toBe(true);
      const topic: 'prices.crypto.chainlink' = message.payload.topic;
      expect(topic).toBe('prices.crypto.chainlink');
    });

    expect(bus.getStats().subscribedTypes).toBe(2);
  });

  it('канонический конверт собирается без casts и отвергает несовпадающие пары', () => {
    // Правильные пары type ↔ payload компилируются без приведения типов
    const marketMessage = {
      type: 'POLYMARKET_MARKET',
      payload: createBookEvent(),
      metadata: fixtureMetadata(),
    } satisfies PolymarketExternalMessage;
    const binanceMessage = {
      type: 'POLYMARKET_CRYPTO_BINANCE',
      payload: createBinanceEvent(),
      metadata: fixtureMetadata(),
    } satisfies PolymarketExternalMessage;

    expect(marketMessage.type).toBe('POLYMARKET_MARKET');
    expect(binanceMessage.type).toBe('POLYMARKET_CRYPTO_BINANCE');

    // Неправильная пара отвергается компилятором:
    // @ts-expect-error binance payload не может ехать под POLYMARKET_MARKET
    const invalid: PolymarketExternalMessage = {
      type: 'POLYMARKET_MARKET',
      payload: createBinanceEvent(),
      metadata: fixtureMetadata(),
    };
    expect(invalid).toBeDefined();
  });
});

describe('official client assignability', () => {
  it('PublicClient официального SDK присваивается порту Source без адаптеров (compile-time)', () => {
    // Type-only импорт createPublicClient: проверка выполняется компилятором,
    // runtime SDK в тесте не поднимается.
    type OfficialPublicClient = ReturnType<typeof createPublicClient>;
    const assertAssignable = (client: OfficialPublicClient): PolymarketSubscribeClient => client;

    expect(typeof assertAssignable).toBe('function');
  });

  it('ExternalMessageBus контура удовлетворяет publisher-порту, включая будущий wider union (compile-time)', () => {
    // Точный union контура
    const exactBus = new ExternalMessageBus<PolymarketExternalMessage>();
    const exactPublisher: PolymarketExternalMessagePublisher = exactBus;

    // Будущий общий bus с расширенным union других sources
    type FutureCexMessage = {
      readonly type: 'CEX_TICKER';
      readonly payload: { readonly symbol: string };
      readonly metadata: MessageMetadata;
    };
    const widerBus = new ExternalMessageBus<PolymarketExternalMessage | FutureCexMessage>();
    const widerPublisher: PolymarketExternalMessagePublisher = widerBus;

    expect(exactPublisher).toBe(exactBus);
    expect(widerPublisher).toBe(widerBus);
  });
});
