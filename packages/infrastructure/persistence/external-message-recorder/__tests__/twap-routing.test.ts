/**
 * Маршрутизация settlement-потока Chainlink TWAP и сужение фидов (MR-B).
 *
 * @remarks
 * Bus здесь НАСТОЯЩИЙ: проверяется, что окно участвует в routing НА ВСЁМ
 * пути «событие → файл рынка», а не только в ключе подписки. Ошибка на этом
 * слое не видна в логах — она молча кладёт в датасет рынка наблюдения
 * потока, которым рынок не резолвится.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import { MessageMetadataGenerator } from '@polymarket/messages';
import { LiveClock } from '@polymarket/time';
import { unsafeMarketId } from '@polymarket/ids';
import type { MarketMeta } from '@polymarket/ports';
import type {
  CryptoPricesChainlinkTwapEvent,
  PolymarketExternalMessage,
  PolymarketRtdsFeed,
} from '@polymarket/polymarket-v2';
import { ExternalMessageRecorder } from '../src/index.js';
import { FakeRecordingStorage, CapturingLogger } from './helpers/fakes.js';
import {
  MARKET_CONDITION_ID,
  MARKET_CONDITION_ID_B,
  createBookEvent,
  createChainlinkEvent,
  createChainlinkTwapEvent,
} from './helpers/sdkFixtures.js';

let bus: ExternalMessageBus<PolymarketExternalMessage>;
let storage: FakeRecordingStorage;
let logger: CapturingLogger;
let recorder: ExternalMessageRecorder;
let generator: MessageMetadataGenerator;

const TWAP_60: PolymarketRtdsFeed = {
  topic: 'prices.crypto.chainlink.twap',
  symbol: 'btc/usd',
  windowSeconds: 60,
};
const TWAP_30: PolymarketRtdsFeed = {
  topic: 'prices.crypto.chainlink.twap',
  symbol: 'btc/usd',
  windowSeconds: 30,
};
const CHAINLINK_SPOT: PolymarketRtdsFeed = {
  topic: 'prices.crypto.chainlink',
  symbol: 'btc/usd',
};

beforeEach(() => {
  bus = new ExternalMessageBus<PolymarketExternalMessage>();
  storage = new FakeRecordingStorage();
  logger = new CapturingLogger();
  generator = new MessageMetadataGenerator({ clock: new LiveClock() });
  recorder = new ExternalMessageRecorder({ bus, storage, logger });
});

function makeMeta(marketId: string): MarketMeta {
  return {
    marketId: unsafeMarketId(marketId),
    question: 'Bitcoin Up or Down',
    tokenIds: ['tok-up', 'tok-down'],
    expiresAt: { toNumber: () => 9999999999999 } as never,
  };
}

async function publishTwap(
  event: CryptoPricesChainlinkTwapEvent,
): Promise<PolymarketExternalMessage> {
  const message: PolymarketExternalMessage = {
    type: 'POLYMARKET_CRYPTO_CHAINLINK_TWAP',
    payload: event,
    metadata: generator.nextRoot(),
  };
  const result = await bus.publish(message);
  expect(result.ok).toBe(true);
  return message;
}

/** Записанные payload-ы конкретного рынка. */
function writesFor(marketId: string): unknown[] {
  return storage.writes
    .filter((write) => String(write.marketId) === marketId)
    .map((write) => write.payload);
}

describe('routing settlement-потока учитывает ОКНО (PART 21/59)', () => {
  it('рынок TWAP-60 не получает наблюдений TWAP-30 того же символа', async () => {
    recorder.start();
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID), rtdsFeeds: [TWAP_60] });

    await publishTwap(createChainlinkTwapEvent({ windowSeconds: 30, value: '1.0' }));
    expect(writesFor(MARKET_CONDITION_ID)).toHaveLength(0);

    await publishTwap(createChainlinkTwapEvent({ windowSeconds: 60, value: '2.0' }));
    expect(writesFor(MARKET_CONDITION_ID)).toHaveLength(1);
  });

  it('два рынка разных окон получают КАЖДЫЙ своё наблюдение', async () => {
    recorder.start();
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID), rtdsFeeds: [TWAP_60] });
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID_B), rtdsFeeds: [TWAP_30] });

    await publishTwap(createChainlinkTwapEvent({ windowSeconds: 60, value: '60.0' }));
    await publishTwap(createChainlinkTwapEvent({ windowSeconds: 30, value: '30.0' }));

    expect(writesFor(MARKET_CONDITION_ID)).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ windowSeconds: 60 }) }),
    ]);
    expect(writesFor(MARKET_CONDITION_ID_B)).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ windowSeconds: 30 }) }),
    ]);
  });

  it('рынок другого символа не получает чужих наблюдений', async () => {
    recorder.start();
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID), rtdsFeeds: [TWAP_60] });

    await publishTwap(createChainlinkTwapEvent({ symbol: 'eth/usd', windowSeconds: 60 }));

    expect(writesFor(MARKET_CONDITION_ID)).toHaveLength(0);
    expect(recorder.getStats().unroutedRtdsMessages).toBe(1);
  });

  it('settlement-поток НЕ смешивается со spot-фидом того же символа', async () => {
    recorder.start();
    recorder.registerMarket({
      marketMeta: makeMeta(MARKET_CONDITION_ID),
      rtdsFeeds: [CHAINLINK_SPOT],
    });

    await publishTwap(createChainlinkTwapEvent({ windowSeconds: 60 }));

    expect(writesFor(MARKET_CONDITION_ID)).toHaveLength(0);
  });

  it('один фид → fan-out во ВСЕ подписанные рынки (по строке на файл)', async () => {
    recorder.start();
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID), rtdsFeeds: [TWAP_60] });
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID_B), rtdsFeeds: [TWAP_60] });

    const message = await publishTwap(createChainlinkTwapEvent({ windowSeconds: 60 }));

    expect(writesFor(MARKET_CONDITION_ID)).toEqual([message.payload]);
    expect(writesFor(MARKET_CONDITION_ID_B)).toEqual([message.payload]);
    expect(recorder.getStats().rtdsMessagesRouted).toBe(1); // одно ВХОДНОЕ сообщение
  });
});

describe('payload остаётся source-native (PART 18/22/60)', () => {
  it('в storage уходит ТА ЖЕ ссылка на SDK-событие, без envelope', async () => {
    recorder.start();
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID), rtdsFeeds: [TWAP_60] });

    const message = await publishTwap(createChainlinkTwapEvent({ windowSeconds: 60 }));

    const written = storage.writes[0]!.payload;
    expect(written).toBe(message.payload); // идентичность ссылки
    expect(written).toEqual({
      topic: 'prices.crypto.chainlink.twap',
      type: 'update',
      timestamp: expect.any(Number),
      payload: {
        symbol: 'btc/usd',
        timestamp: expect.any(Number),
        value: '78400.701754893592952832',
        windowSeconds: 60,
      },
    });
    // Наш routing-дискриминатор и runtime-metadata на диск не попадают
    expect(JSON.stringify(written)).not.toContain('POLYMARKET_CRYPTO_CHAINLINK_TWAP');
    expect(JSON.stringify(written)).not.toContain('messageId');
  });

  it('точная десятичная строка значения не превращается в число', async () => {
    recorder.start();
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID), rtdsFeeds: [TWAP_60] });

    await publishTwap(
      createChainlinkTwapEvent({ windowSeconds: 60, value: '78449.05813530705395712' }),
    );

    const line = JSON.stringify(storage.writes[0]!.payload);
    expect(line).toContain('"value":"78449.05813530705395712"');
  });
});

describe('narrowRtdsFeeds: сужение до settlement-потока (PART 25)', () => {
  it('оставляет settlement-фид и снимает spot + market routing', async () => {
    recorder.start();
    recorder.registerMarket({
      marketMeta: makeMeta(MARKET_CONDITION_ID),
      rtdsFeeds: [CHAINLINK_SPOT, TWAP_60],
    });

    expect(recorder.narrowRtdsFeeds(unsafeMarketId(MARKET_CONDITION_ID), [TWAP_60])).toBe(true);

    // Spot больше не пишется
    const spot: PolymarketExternalMessage = {
      type: 'POLYMARKET_CRYPTO_CHAINLINK',
      payload: createChainlinkEvent(),
      metadata: generator.nextRoot(),
    };
    await bus.publish(spot);
    // Market-события тоже прекратились: торговый lifecycle закончен
    await bus.publish({
      type: 'POLYMARKET_MARKET',
      payload: createBookEvent(),
      metadata: generator.nextRoot(),
    });
    expect(writesFor(MARKET_CONDITION_ID)).toHaveLength(0);

    // Settlement-поток продолжает писаться — ради него сужение и делалось
    await publishTwap(createChainlinkTwapEvent({ windowSeconds: 60 }));
    expect(writesFor(MARKET_CONDITION_ID)).toHaveLength(1);
  });

  it('не затрагивает ДРУГИЕ рынки, подписанные на тот же spot-фид', async () => {
    recorder.start();
    recorder.registerMarket({
      marketMeta: makeMeta(MARKET_CONDITION_ID),
      rtdsFeeds: [CHAINLINK_SPOT, TWAP_60],
    });
    recorder.registerMarket({
      marketMeta: makeMeta(MARKET_CONDITION_ID_B),
      rtdsFeeds: [CHAINLINK_SPOT],
    });

    recorder.narrowRtdsFeeds(unsafeMarketId(MARKET_CONDITION_ID), [TWAP_60]);

    await bus.publish({
      type: 'POLYMARKET_CRYPTO_CHAINLINK',
      payload: createChainlinkEvent(),
      metadata: generator.nextRoot(),
    });

    expect(writesFor(MARKET_CONDITION_ID)).toHaveLength(0);
    expect(writesFor(MARKET_CONDITION_ID_B)).toHaveLength(1); // сосед не затронут
  });

  it('seal ПОСЛЕ сужения снимает и оставленный settlement-фид', async () => {
    recorder.start();
    recorder.registerMarket({
      marketMeta: makeMeta(MARKET_CONDITION_ID),
      rtdsFeeds: [CHAINLINK_SPOT, TWAP_60],
    });
    recorder.narrowRtdsFeeds(unsafeMarketId(MARKET_CONDITION_ID), [TWAP_60]);

    await recorder.sealMarket(unsafeMarketId(MARKET_CONDITION_ID));
    await publishTwap(createChainlinkTwapEvent({ windowSeconds: 60 }));

    expect(writesFor(MARKET_CONDITION_ID)).toHaveLength(0);
    expect(recorder.getStats().unroutedRtdsMessages).toBe(1);
  });

  it('идемпотентен; неизвестный рынок и закрытый recorder → false', async () => {
    recorder.start();
    recorder.registerMarket({
      marketMeta: makeMeta(MARKET_CONDITION_ID),
      rtdsFeeds: [CHAINLINK_SPOT, TWAP_60],
    });

    expect(recorder.narrowRtdsFeeds(unsafeMarketId(MARKET_CONDITION_ID), [TWAP_60])).toBe(true);
    expect(recorder.narrowRtdsFeeds(unsafeMarketId(MARKET_CONDITION_ID), [TWAP_60])).toBe(true);
    expect(recorder.narrowRtdsFeeds(unsafeMarketId(MARKET_CONDITION_ID_B), [TWAP_60])).toBe(false);

    await publishTwap(createChainlinkTwapEvent({ windowSeconds: 60 }));
    expect(writesFor(MARKET_CONDITION_ID)).toHaveLength(1); // не задвоилось

    await recorder.close();
    expect(recorder.narrowRtdsFeeds(unsafeMarketId(MARKET_CONDITION_ID), [TWAP_60])).toBe(false);
  });

  it('сужение до фида, которого у сессии не было, оставляет её без RTDS', async () => {
    recorder.start();
    recorder.registerMarket({
      marketMeta: makeMeta(MARKET_CONDITION_ID),
      rtdsFeeds: [CHAINLINK_SPOT],
    });

    expect(recorder.narrowRtdsFeeds(unsafeMarketId(MARKET_CONDITION_ID), [TWAP_60])).toBe(true);

    await publishTwap(createChainlinkTwapEvent({ windowSeconds: 60 }));
    expect(writesFor(MARKET_CONDITION_ID)).toHaveLength(0);
  });
});
