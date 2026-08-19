/**
 * Тесты ExternalMessageRecorder: маршрутизация, payload identity, lifecycle,
 * policy отказов (PART 4/6/13/17/21/22/23/24 N-002).
 *
 * @remarks
 * Bus — НАСТОЯЩИЙ `ExternalMessageBus` (доставка/подписки/close — реальные),
 * storage — узкий fake: эти тесты проверяют ingestion/routing-слой. Настоящая
 * дисковая persistence (parity/header/gzip) — в
 * `recording-persistence.integration.test.ts`.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import { MessageMetadataGenerator } from '@polymarket/messages';
import { LiveClock } from '@polymarket/time';
import { unsafeMarketId } from '@polymarket/ids';
import type { MarketMeta } from '@polymarket/ports';
import type {
  PolymarketExternalMessage,
  StandardMarketEvent,
  CryptoPricesBinanceEvent,
  CryptoPricesChainlinkEvent,
} from '@polymarket/polymarket-v2';
import { ExternalMessageRecorder } from '../src/index.js';
import { FakeRecordingStorage, CapturingLogger } from './helpers/fakes.js';
import {
  MARKET_CONDITION_ID,
  MARKET_CONDITION_ID_B,
  createBookEvent,
  createPriceChangeEvent,
  createLastTradePriceEvent,
  createTickSizeChangeEvent,
  createBinanceEvent,
  createChainlinkEvent,
} from './helpers/sdkFixtures.js';

// ── Setup ────────────────────────────────────────────────────────────────────

let bus: ExternalMessageBus<PolymarketExternalMessage>;
let storage: FakeRecordingStorage;
let logger: CapturingLogger;
let recorder: ExternalMessageRecorder;
let generator: MessageMetadataGenerator;

beforeEach(() => {
  bus = new ExternalMessageBus<PolymarketExternalMessage>();
  storage = new FakeRecordingStorage();
  logger = new CapturingLogger();
  generator = new MessageMetadataGenerator({ clock: new LiveClock() });
  recorder = new ExternalMessageRecorder({ bus, storage, logger });
});

function makeMeta(marketId: string, question = 'Will BTC go up?'): MarketMeta {
  return {
    marketId: unsafeMarketId(marketId),
    question,
    tokenIds: ['tok-up', 'tok-down'],
    expiresAt: { toNumber: () => 9999999999999 } as never,
  };
}

async function publishMarket(event: StandardMarketEvent): Promise<PolymarketExternalMessage> {
  const message: PolymarketExternalMessage = {
    type: 'POLYMARKET_MARKET',
    payload: event,
    metadata: generator.nextRoot(),
  };
  const result = await bus.publish(message);
  expect(result.ok).toBe(true);
  return message;
}

async function publishRtds(
  event: CryptoPricesBinanceEvent | CryptoPricesChainlinkEvent,
): Promise<void> {
  const message: PolymarketExternalMessage =
    event.topic === 'prices.crypto.binance'
      ? { type: 'POLYMARKET_CRYPTO_BINANCE', payload: event, metadata: generator.nextRoot() }
      : { type: 'POLYMARKET_CRYPTO_CHAINLINK', payload: event, metadata: generator.nextRoot() };
  const result = await bus.publish(message);
  expect(result.ok).toBe(true);
}

// ── Market routing (PART 4/13/23) ───────────────────────────────────────────

describe('market routing', () => {
  it('маршрутизирует book по payload.market и передаёт payload ТОЙ ЖЕ ссылкой', async () => {
    recorder.start();
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID) });

    const message = await publishMarket(createBookEvent());

    expect(storage.writes).toHaveLength(1);
    expect(String(storage.writes[0]!.marketId)).toBe(MARKET_CONDITION_ID);
    // PART 13: payloadReference === message.payload — без clone/rename/normalize
    expect(storage.writes[0]!.payload).toBe(message.payload);
  });

  it('price_change с несколькими tokenIds записывается ОДИН раз (по market, без разбиения)', async () => {
    recorder.start();
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID) });

    const message = await publishMarket(createPriceChangeEvent());

    expect(storage.writes).toHaveLength(1);
    expect(storage.writes[0]!.payload).toBe(message.payload);
  });

  it('обрабатывает все варианты StandardMarketEvent', async () => {
    recorder.start();
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID) });

    await publishMarket(createBookEvent());
    await publishMarket(createPriceChangeEvent());
    await publishMarket(createLastTradePriceEvent());
    await publishMarket(createTickSizeChangeEvent());

    expect(storage.writes).toHaveLength(4);
    expect(recorder.getStats().marketMessagesRouted).toBe(4);
    expect(recorder.getStats().recordsWritten).toBe(4);
  });

  it('событие незарегистрированного рынка не пишется и учитывается как unrouted (TEST A)', async () => {
    recorder.start();

    await publishMarket(createBookEvent());

    expect(storage.writes).toHaveLength(0);
    expect(recorder.getStats().unroutedMarketMessages).toBe(1);
  });

  it('события разных рынков маршрутизируются в свои сессии', async () => {
    recorder.start();
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID) });
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID_B, 'Will ETH go up?') });

    await publishMarket(createBookEvent({ market: MARKET_CONDITION_ID }));
    await publishMarket(createBookEvent({ market: MARKET_CONDITION_ID_B }));

    expect(storage.writes.map((w) => String(w.marketId))).toEqual([
      MARKET_CONDITION_ID,
      MARKET_CONDITION_ID_B,
    ]);
  });
});

// ── RTDS routing (PART 6/24) ────────────────────────────────────────────────

describe('RTDS routing', () => {
  it('маршрутизирует по точному (topic, symbol) — не по формату символа', async () => {
    recorder.start();
    // Рынок подписан ТОЛЬКО на chainlink btc/usd
    recorder.registerMarket({
      marketMeta: makeMeta(MARKET_CONDITION_ID),
      rtdsFeeds: [{ topic: 'prices.crypto.chainlink', symbol: 'btc/usd' }],
    });

    // Тот же символ на ДРУГОМ topic не должен матчиться
    await publishRtds(createBinanceEvent({ symbol: 'btc/usd' }));
    expect(storage.writes).toHaveLength(0);
    expect(recorder.getStats().unroutedRtdsMessages).toBe(1);

    await publishRtds(createChainlinkEvent({ symbol: 'btc/usd' }));
    expect(storage.writes).toHaveLength(1);
    expect(recorder.getStats().rtdsMessagesRouted).toBe(1);
  });

  it('одно RTDS-событие дублируется в файлы ВСЕХ подписанных рынков (PART 24)', async () => {
    recorder.start();
    recorder.registerMarket({
      marketMeta: makeMeta(MARKET_CONDITION_ID),
      rtdsFeeds: [{ topic: 'prices.crypto.binance', symbol: 'btcusdt' }],
    });
    recorder.registerMarket({
      marketMeta: makeMeta(MARKET_CONDITION_ID_B, 'Will BTC go up (later window)?'),
      rtdsFeeds: [{ topic: 'prices.crypto.binance', symbol: 'btcusdt' }],
    });

    await publishRtds(createBinanceEvent());

    // Ровно одна запись на каждый файл рынка
    expect(storage.writes.map((w) => String(w.marketId)).sort()).toEqual(
      [MARKET_CONDITION_ID, MARKET_CONDITION_ID_B].sort(),
    );
    // Одно сообщение → rtdsMessagesRouted 1, recordsWritten 2 (fan-out по файлам)
    expect(recorder.getStats().rtdsMessagesRouted).toBe(1);
    expect(recorder.getStats().recordsWritten).toBe(2);
  });

  it('после finalize рынка A событие уходит только рынку B', async () => {
    recorder.start();
    recorder.registerMarket({
      marketMeta: makeMeta(MARKET_CONDITION_ID),
      rtdsFeeds: [{ topic: 'prices.crypto.binance', symbol: 'btcusdt' }],
    });
    recorder.registerMarket({
      marketMeta: makeMeta(MARKET_CONDITION_ID_B, 'Will BTC go up (later window)?'),
      rtdsFeeds: [{ topic: 'prices.crypto.binance', symbol: 'btcusdt' }],
    });

    await recorder.finalizeMarket(unsafeMarketId(MARKET_CONDITION_ID), 'EXPIRED');
    await publishRtds(createBinanceEvent());

    expect(storage.writes.map((w) => String(w.marketId))).toEqual([MARKET_CONDITION_ID_B]);
    expect(storage.finalized).toEqual([
      { marketId: unsafeMarketId(MARKET_CONDITION_ID), reason: 'EXPIRED' },
    ]);
  });

  it('RTDS без единой подписки — unrouted, файл не создаётся (TEST B)', async () => {
    recorder.start();

    await publishRtds(createBinanceEvent({ symbol: 'ethusdt' }));

    expect(storage.writes).toHaveLength(0);
    expect(recorder.getStats().unroutedRtdsMessages).toBe(1);
  });
});

// ── Registration / stats ────────────────────────────────────────────────────

describe('registration and stats', () => {
  it('registerMarket регистрирует storage writer и идемпотентен', () => {
    recorder.start();
    const registration = { marketMeta: makeMeta(MARKET_CONDITION_ID) };
    recorder.registerMarket(registration);
    recorder.registerMarket(registration);

    expect(storage.registered).toHaveLength(1);
    expect(storage.registered[0]).toBe(registration.marketMeta);
  });

  it('updateMarketMeta — passthrough в storage', async () => {
    recorder.start();
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID) });

    await recorder.updateMarketMeta(unsafeMarketId(MARKET_CONDITION_ID), { finalPrice: 64000 });

    expect(storage.metaUpdates).toEqual([
      { marketId: unsafeMarketId(MARKET_CONDITION_ID), raw: { finalPrice: 64000 } },
    ]);
  });

  it("исход 'inactive' учитывается как recordsSkippedInactive (activation policy)", async () => {
    recorder.start();
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID) });
    storage.outcomeOverride = 'inactive';

    await publishMarket(createBookEvent());

    const stats = recorder.getStats();
    expect(stats.recordsSkippedInactive).toBe(1);
    expect(stats.recordsWritten).toBe(0);
  });

  it("исход 'failed' учитывается как serializationFailures, bus остаётся живым (TEST C)", async () => {
    recorder.start();
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID) });
    storage.outcomeOverride = 'failed';

    await publishMarket(createBookEvent());
    expect(recorder.getStats().serializationFailures).toBe(1);

    // Recording failure не убивает доставку: следующее сообщение записывается
    storage.outcomeOverride = undefined;
    await publishMarket(createBookEvent());
    expect(recorder.getStats().recordsWritten).toBe(1);
  });

  it('исключение storage не выходит из handler-а: handlerErrors + лог, доставка живёт', async () => {
    recorder.start();
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID) });
    storage.throwOnRecord = new Error('disk exploded');

    await publishMarket(createBookEvent());

    expect(recorder.getStats().handlerErrors).toBe(1);
    expect(
      logger.byLevel('error').some((e) => e.message === 'Market message recording handler failed'),
    ).toBe(true);

    storage.throwOnRecord = undefined;
    await publishMarket(createBookEvent());
    expect(recorder.getStats().recordsWritten).toBe(1);
  });
});

// ── Lifecycle (PART 20/21, TEST F/G) ────────────────────────────────────────

describe('lifecycle', () => {
  it('start идемпотентен: повторный вызов не дублирует подписки', async () => {
    recorder.start();
    recorder.start();
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID) });

    await publishMarket(createBookEvent());

    expect(storage.writes).toHaveLength(1);
  });

  it('close отписывается от bus: сообщения после close игнорируются (TEST G)', async () => {
    recorder.start();
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID) });
    await recorder.close();

    await publishMarket(createBookEvent());

    expect(storage.writes).toHaveLength(0);
    expect(recorder.getStats().marketMessagesRouted).toBe(0);
    expect(recorder.getStats().unroutedMarketMessages).toBe(0);
  });

  it('close идемпотентен и закрывает storage ровно один раз (TEST F)', async () => {
    recorder.start();

    await recorder.close();
    await recorder.close();

    expect(storage.closeCalls).toBe(1);
    expect(recorder.isClosed).toBe(true);
  });

  it('close НЕ закрывает общий bus (им владеет composition root)', async () => {
    recorder.start();
    await recorder.close();

    // Bus остаётся рабочим для других consumers
    const result = await bus.publish({
      type: 'POLYMARKET_MARKET',
      payload: createBookEvent(),
      metadata: generator.nextRoot(),
    });
    expect(result.ok).toBe(true);
    expect(bus.getStats().closed).toBe(false);
  });

  it('start после close бросает', async () => {
    recorder.start();
    await recorder.close();

    expect(() => recorder.start()).toThrow(
      'ExternalMessageRecorder is closed and cannot start',
    );
  });

  it('registerMarket после close игнорируется — новые файлы не создаются', async () => {
    recorder.start();
    await recorder.close();

    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID) });

    expect(storage.registered).toHaveLength(0);
    expect(logger.byLevel('warn').some((e) => e.message.includes('recorder is closed'))).toBe(true);
  });
});
