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

  it('отказ storage для одного рынка не лишает события остальные направления fan-out', async () => {
    recorder.start();
    recorder.registerMarket({
      marketMeta: makeMeta(MARKET_CONDITION_ID),
      rtdsFeeds: [{ topic: 'prices.crypto.binance', symbol: 'btcusdt' }],
    });
    recorder.registerMarket({
      marketMeta: makeMeta(MARKET_CONDITION_ID_B, 'Will BTC go up (later window)?'),
      rtdsFeeds: [{ topic: 'prices.crypto.binance', symbol: 'btcusdt' }],
    });
    // Storage бросает ТОЛЬКО для рынка A (первое направление fan-out)
    storage.throwOnRecordForMarketId = MARKET_CONDITION_ID;

    await publishRtds(createBinanceEvent());

    // Рынок B получил свою строку несмотря на отказ по рынку A
    expect(storage.writes.map((w) => String(w.marketId))).toEqual([MARKET_CONDITION_ID_B]);
    expect(recorder.getStats().handlerErrors).toBe(1);
    expect(
      logger
        .byLevel('error')
        .some((e) => e.message === 'RTDS recording failed for market, continuing fan-out'),
    ).toBe(true);

    // Отказ не терминален: после устранения оба рынка снова пишутся
    storage.throwOnRecordForMarketId = undefined;
    await publishRtds(createBinanceEvent());
    expect(storage.writes).toHaveLength(3);
  });
});

// ── Registration / stats ────────────────────────────────────────────────────

describe('registration and stats', () => {
  it('registerMarket регистрирует storage writer и идемпотентен по market identity', () => {
    recorder.start();
    // Два РАЗНЫХ объекта meta с одним marketId: дедупликация по identity, не по ссылке
    const metaFirst = makeMeta(MARKET_CONDITION_ID);
    const metaSecond = makeMeta(MARKET_CONDITION_ID, 'Same market, refreshed question');

    expect(recorder.registerMarket({ marketMeta: metaFirst })).toBe(true);
    expect(recorder.registerMarket({ marketMeta: metaSecond })).toBe(true);

    expect(storage.registered).toHaveLength(1);
    expect(storage.registered[0]).toBe(metaFirst);
  });

  it('отказ storage при регистрации: routing не создаётся, отказ наблюдаем и retryable', async () => {
    recorder.start();
    storage.registerOutcome = false;

    const registered = recorder.registerMarket({
      marketMeta: makeMeta(MARKET_CONDITION_ID),
      rtdsFeeds: [{ topic: 'prices.crypto.binance', symbol: 'btcusdt' }],
    });

    expect(registered).toBe(false);
    expect(recorder.getStats().registrationFailures).toBe(1);
    expect(
      logger
        .byLevel('error')
        .some((e) => e.message === 'Recording session rejected: storage failed to install market writer'),
    ).toBe(true);

    // Routing-состояния нет: market и RTDS события — unrouted, storage не вызывается
    await publishMarket(createBookEvent());
    await publishRtds(createBinanceEvent());
    expect(storage.writes).toHaveLength(0);
    expect(recorder.getStats().unroutedMarketMessages).toBe(1);
    expect(recorder.getStats().unroutedRtdsMessages).toBe(1);

    // Причина устранена → повторная регистрация успешна (retryable)
    storage.registerOutcome = true;
    expect(
      recorder.registerMarket({
        marketMeta: makeMeta(MARKET_CONDITION_ID),
        rtdsFeeds: [{ topic: 'prices.crypto.binance', symbol: 'btcusdt' }],
      }),
    ).toBe(true);
    await publishMarket(createBookEvent());
    expect(storage.writes).toHaveLength(1);
  });

  it('отказ отложенной активации storage инвалидирует сессию; retry регистрирует заново (TEST 3)', async () => {
    recorder.start();
    const registration = {
      marketMeta: makeMeta(MARKET_CONDITION_ID),
      rtdsFeeds: [{ topic: 'prices.crypto.binance' as const, symbol: 'btcusdt' }],
    };
    expect(recorder.registerMarket(registration)).toBe(true);
    expect(storage.registered).toHaveLength(1);

    // Storage сообщает: таймерная активация упала, регистрация освобождена
    storage.failDelayedActivation(unsafeMarketId(MARKET_CONDITION_ID));

    expect(recorder.getStats().registrationFailures).toBe(1);
    expect(
      logger
        .byLevel('error')
        .some((e) => e.message === 'Recording session invalidated: delayed storage activation failed'),
    ).toBe(true);
    // Stale-сессии нет: market и RTDS события — unrouted, storage не вызывается
    await publishMarket(createBookEvent());
    await publishRtds(createBinanceEvent());
    expect(storage.writes).toHaveLength(0);
    expect(recorder.getStats().unroutedMarketMessages).toBe(1);
    expect(recorder.getStats().unroutedRtdsMessages).toBe(1);

    // Retry той же регистрации РЕАЛЬНО вызывает storage.registerMarket снова
    expect(recorder.registerMarket(registration)).toBe(true);
    expect(storage.registered).toHaveLength(2);
    await publishMarket(createBookEvent());
    await publishRtds(createBinanceEvent());
    expect(storage.writes).toHaveLength(2);
  });

  it('отказ активации A убирает из shared RTDS routing только A — B продолжает писаться (TEST 4)', async () => {
    recorder.start();
    recorder.registerMarket({
      marketMeta: makeMeta(MARKET_CONDITION_ID),
      rtdsFeeds: [{ topic: 'prices.crypto.binance', symbol: 'btcusdt' }],
    });
    recorder.registerMarket({
      marketMeta: makeMeta(MARKET_CONDITION_ID_B, 'Will BTC go up (later window)?'),
      rtdsFeeds: [{ topic: 'prices.crypto.binance', symbol: 'btcusdt' }],
    });

    storage.failDelayedActivation(unsafeMarketId(MARKET_CONDITION_ID));
    await publishRtds(createBinanceEvent());

    // Пишется только B; A из общего фида удалён
    expect(storage.writes.map((w) => String(w.marketId))).toEqual([MARKET_CONDITION_ID_B]);
  });

  it('hook отказа активации после close — no-op без исключений (TEST 6)', async () => {
    recorder.start();
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID) });
    await recorder.close();

    expect(() => {
      storage.failDelayedActivation(unsafeMarketId(MARKET_CONDITION_ID));
    }).not.toThrow();
    expect(recorder.getStats().registrationFailures).toBe(0);
  });

  it("исход 'unregistered' при живой сессии — warn о рассинхроне session↔storage", async () => {
    recorder.start();
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID) });
    storage.outcomeOverride = 'unregistered';

    await publishMarket(createBookEvent());

    expect(
      logger
        .byLevel('warn')
        .some((e) => e.message === 'Recording session exists but storage writer is missing'),
    ).toBe(true);
    const stats = recorder.getStats();
    // Сообщение сматчено с сессией, но НЕ записано и не является serialization failure
    expect(stats.marketMessagesRouted).toBe(1);
    expect(stats.recordsWritten).toBe(0);
    expect(stats.serializationFailures).toBe(0);
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

  it('close дожидается in-flight finalizeMarket ДО закрытия storage (нет гонки cleanup↔finalize)', async () => {
    recorder.start();
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID) });

    // Затягиваем финализацию управляемым gate
    let releaseFinalize!: () => void;
    storage.finalizeGate = new Promise<void>((resolve) => {
      releaseFinalize = resolve;
    });

    const finalization = recorder.finalizeMarket(unsafeMarketId(MARKET_CONDITION_ID), 'EXPIRED');
    const closing = recorder.close(); // close стартует, пока финализация в полёте

    // Даём close шанс поторопиться — storage.close не должен случиться до finalize
    await new Promise((r) => setTimeout(r, 20));
    expect(storage.callOrder).not.toContain('storage:close');

    releaseFinalize();
    await finalization;
    await closing;

    expect(storage.callOrder).toEqual([
      `finalize:start:${MARKET_CONDITION_ID}`,
      `finalize:end:${MARKET_CONDITION_ID}`,
      'storage:close',
    ]);
  });

  it('finalizeMarket после close отклоняется (warn), storage не вызывается', async () => {
    recorder.start();
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID) });
    await recorder.close();

    await recorder.finalizeMarket(unsafeMarketId(MARKET_CONDITION_ID), 'EXPIRED');

    expect(storage.finalized).toHaveLength(0);
    expect(
      logger.byLevel('warn').some((e) => e.message === 'Market finalization ignored: recorder is closed'),
    ).toBe(true);
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

  it('registerMarket после close отклоняется (false) — новые файлы не создаются', async () => {
    recorder.start();
    await recorder.close();

    expect(recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID) })).toBe(false);

    expect(storage.registered).toHaveLength(0);
    expect(logger.byLevel('warn').some((e) => e.message.includes('recorder is closed'))).toBe(true);
  });
});

// ── Seal (N-004 PART 7/50/52) ────────────────────────────────────────────────

describe('sealMarket', () => {
  it('снимает market/RTDS routing немедленно, storage замораживается, header/finalize доступны', async () => {
    recorder.start();
    recorder.registerMarket({
      marketMeta: makeMeta(MARKET_CONDITION_ID),
      rtdsFeeds: [{ topic: 'prices.crypto.binance', symbol: 'btcusdt' }],
    });
    await publishMarket(createBookEvent());
    expect(storage.writes).toHaveLength(1);

    expect(await recorder.sealMarket(unsafeMarketId(MARKET_CONDITION_ID))).toBe(true);
    expect(storage.sealed).toEqual([MARKET_CONDITION_ID]);

    // Новые market/RTDS наблюдения в payload НЕ попадают
    await publishMarket(createBookEvent());
    await publishRtds(createBinanceEvent());
    expect(storage.writes).toHaveLength(1);
    // Сессия остаётся SEALED-надгробием: market-события истёкшего рынка это
    // ШТАТНЫЙ игнор (физический claim снимается ПОСЛЕ заморозки), а не потеря
    // при отсутствующей сессии — их нельзя смешивать в одном счётчике.
    expect(recorder.getStats().marketMessagesDroppedAfterSeal).toBe(1);
    expect(recorder.getStats().unroutedMarketMessages).toBe(0);
    expect(recorder.getStats().unroutedRtdsMessages).toBe(1);

    // Header остаётся writable, финализация EXPIRED доступна
    expect(
      await recorder.updateMarketMeta(unsafeMarketId(MARKET_CONDITION_ID), { enriched: true }),
    ).toBe(true);
    await recorder.finalizeMarket(unsafeMarketId(MARKET_CONDITION_ID), 'EXPIRED');
    expect(storage.finalized).toEqual([
      { marketId: unsafeMarketId(MARKET_CONDITION_ID), reason: 'EXPIRED' },
    ]);
  });

  it('не трогает общий RTDS-фид другого активного рынка (PART 52)', async () => {
    recorder.start();
    const shared = [{ topic: 'prices.crypto.binance' as const, symbol: 'btcusdt' }];
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID), rtdsFeeds: shared });
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID_B), rtdsFeeds: shared });

    await recorder.sealMarket(unsafeMarketId(MARKET_CONDITION_ID));
    await publishRtds(createBinanceEvent());

    // Наблюдение записано ТОЛЬКО в файл второго (активного) рынка
    expect(storage.writes).toHaveLength(1);
    expect(String(storage.writes[0]!.marketId)).toBe(MARKET_CONDITION_ID_B);
  });

  it('после close: seal и updateMarketMeta отклоняются с false', async () => {
    recorder.start();
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID) });
    await recorder.close();

    expect(await recorder.sealMarket(unsafeMarketId(MARKET_CONDITION_ID))).toBe(false);
    expect(
      await recorder.updateMarketMeta(unsafeMarketId(MARKET_CONDITION_ID), { late: true }),
    ).toBe(false);
    expect(storage.sealed).toEqual([]);
  });

  it('пробрасывает наблюдаемый исход sealMarket из storage (writer не найден → false)', async () => {
    recorder.start();
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID) });

    storage.sealOutcome = false;
    expect(await recorder.sealMarket(unsafeMarketId(MARKET_CONDITION_ID))).toBe(false);
    storage.sealOutcome = true;
    expect(await recorder.sealMarket(unsafeMarketId(MARKET_CONDITION_ID))).toBe(true);
  });

  it('пробрасывает наблюдаемый исход updateMarketMeta из storage (PART 26)', async () => {
    recorder.start();
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID) });

    storage.metaUpdateOutcome = false;
    expect(
      await recorder.updateMarketMeta(unsafeMarketId(MARKET_CONDITION_ID), { tooBig: true }),
    ).toBe(false);
    storage.metaUpdateOutcome = true;
    expect(
      await recorder.updateMarketMeta(unsafeMarketId(MARKET_CONDITION_ID), { ok: true }),
    ).toBe(true);
  });
});

// ── Наблюдаемость сессий и граница финализации ──────────────────────────────

describe('listMarketSessions', () => {
  it('снимок несёт стадию, регистрацию, фиды и момент ПЕРВОЙ записанной строки', async () => {
    recorder.start();
    recorder.registerMarket({
      marketMeta: makeMeta(MARKET_CONDITION_ID),
      rtdsFeeds: [{ topic: 'prices.crypto.binance', symbol: 'btcusdt' }],
    });

    // До первой строки момент начала записи неизвестен: датасет не начался.
    expect(recorder.listMarketSessions()).toHaveLength(1);
    expect(recorder.listMarketSessions()[0]?.state).toBe('ACTIVE');
    expect(recorder.listMarketSessions()[0]?.firstObservedAtMs).toBeUndefined();

    await publishMarket(createBookEvent());

    const [session] = recorder.listMarketSessions();
    expect(String(session?.marketId)).toBe(MARKET_CONDITION_ID);
    expect(session?.state).toBe('ACTIVE');
    expect(session?.marketMeta.question).toBe('Will BTC go up?');
    expect(session?.rtdsFeeds).toEqual([{ topic: 'prices.crypto.binance', symbol: 'btcusdt' }]);
    expect(typeof session?.firstObservedAtMs).toBe('number');
  });

  it('снимки детерминированно упорядочены по id рынка', async () => {
    recorder.start();
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID_B) });
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID) });

    const ids = recorder.listMarketSessions().map((session) => String(session.marketId));
    expect(ids).toEqual([...ids].sort());
  });
});

describe('beginMarketFinalization', () => {
  it('СИНХРОННО отсекает CLOB и обычные RTDS, оставляя settlement-поток', async () => {
    recorder.start();
    recorder.registerMarket({
      marketMeta: makeMeta(MARKET_CONDITION_ID),
      rtdsFeeds: [
        { topic: 'prices.crypto.binance', symbol: 'btcusdt' },
        { topic: 'prices.crypto.chainlink', symbol: 'btc/usd' },
      ],
    });
    await publishMarket(createBookEvent());
    expect(storage.writes).toHaveLength(1);

    // Оставляем ТОЛЬКО chainlink-поток (в этой фикстуре он играет роль
    // settlement-фида: точная identity, а не эвристика формата символа).
    const applied = recorder.beginMarketFinalization(unsafeMarketId(MARKET_CONDITION_ID), [
      { topic: 'prices.crypto.chainlink', symbol: 'btc/usd' },
    ]);

    expect(applied).toBe(true);
    expect(recorder.listMarketSessions()[0]?.state).toBe('FINALIZING');

    await publishMarket(createBookEvent()); // CLOB после границы
    await publishRtds(createBinanceEvent()); // обычный RTDS после границы
    expect(storage.writes).toHaveLength(1);
    expect(recorder.getStats().marketMessagesDroppedAfterExpiry).toBe(1);

    await publishRtds(createChainlinkEvent()); // граничный settlement-поток
    expect(storage.writes).toHaveLength(2);
  });

  it('идемпотентен; после заморозки датасета переход больше не выполняется', async () => {
    recorder.start();
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID) });

    expect(recorder.beginMarketFinalization(unsafeMarketId(MARKET_CONDITION_ID), [])).toBe(true);
    expect(recorder.beginMarketFinalization(unsafeMarketId(MARKET_CONDITION_ID), [])).toBe(true);

    await recorder.sealMarket(unsafeMarketId(MARKET_CONDITION_ID));

    expect(recorder.beginMarketFinalization(unsafeMarketId(MARKET_CONDITION_ID), [])).toBe(false);
    expect(recorder.listMarketSessions()[0]?.state).toBe('SEALED');
  });

  it('нет сессии → false (сужать нечего)', () => {
    recorder.start();
    expect(recorder.beginMarketFinalization(unsafeMarketId(MARKET_CONDITION_ID), [])).toBe(false);
  });
});

describe('SEALED-надгробие сессии', () => {
  it('ленивый допуск НЕ создаёт вторую сессию поверх замороженного датасета', async () => {
    // Провайдер согласен на рынок ВСЕГДА: единственная защита — стадия сессии.
    const admitting = new ExternalMessageRecorder({
      bus,
      storage,
      logger,
      sessionProvider: (sourceMarketId) => ({ marketMeta: makeMeta(sourceMarketId) }),
    });
    admitting.start();
    await publishMarket(createBookEvent());
    expect(storage.registered).toHaveLength(1);

    await admitting.sealMarket(unsafeMarketId(MARKET_CONDITION_ID));
    await publishMarket(createBookEvent());

    expect(storage.registered).toHaveLength(1);
    expect(admitting.getStats().marketSessionsAdmitted).toBe(1);
    expect(admitting.getStats().marketMessagesDroppedAfterSeal).toBe(1);

    await admitting.close();
  });

  it('finalizeMarket снимает надгробие', async () => {
    recorder.start();
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID) });
    await recorder.sealMarket(unsafeMarketId(MARKET_CONDITION_ID));
    expect(recorder.listMarketSessions()).toHaveLength(1);

    await recorder.finalizeMarket(unsafeMarketId(MARKET_CONDITION_ID), 'EXPIRED');

    expect(recorder.listMarketSessions()).toEqual([]);
  });
});
