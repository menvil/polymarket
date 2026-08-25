/**
 * Инварианты raw-контура коллектора (MR-A PART 11/12/29/30/31/42/43).
 *
 * @remarks
 * Главный архитектурный тест этого MR. Он фиксирует, что recorder — ОДИН ИЗ
 * consumer-ов общего bus, а не привилегированная цель прямых вызовов
 * source-ов:
 *
 * ```text
 *            source.publish → ОДИН ExternalMessageBus
 *                                ↙              ↘
 *                          Recorder          Observer
 *                                              (сегодня — checkpoint,
 *                                               завтра — Semantic Adapter)
 * ```
 *
 * Именно эта развилка позволит будущему Semantic Adapter подключиться, не
 * трогая ни source-пакеты, ни recorder, ни API коллектора.
 */
import { afterEach, describe, expect, it } from '@jest/globals';
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import { MessageMetadataGenerator } from '@polymarket/messages';
import { LiveClock } from '@polymarket/time';
import { ExternalMessageRecorder } from '@polymarket/external-message-recorder';
import type { CexOrderbookPayload, CexTradePayload } from '@polymarket/cex-v2';
import type { ContourMessage } from '../src/runtime/createDataCollector.js';
import { CapturingLogger } from './helpers/fakes.js';
import { FakeCexWindowStorage, FakePolymarketRecordingStorage } from './helpers/recordingFakes.js';

/** Все bus, созданные тестом: закрываются в teardown (без утечек между тестами). */
const openBuses: ExternalMessageBus<ContourMessage>[] = [];

afterEach(async () => {
  // Bus держит очередь доставки и подписки; незакрытый экземпляр пережил бы
  // тест и мог бы получить сообщения соседнего.
  await Promise.all(openBuses.splice(0).map(async (bus) => bus.close()));
});

/** Регистрирует bus для гарантированного закрытия. */
function trackBus(bus: ExternalMessageBus<ContourMessage>): ExternalMessageBus<ContourMessage> {
  openBuses.push(bus);
  return bus;
}

/** Собранный «мини-контур»: реальные bus и recorder, fake-хранилища. */
function makeContour(): {
  bus: ExternalMessageBus<ContourMessage>;
  recorder: ExternalMessageRecorder;
  cexStorage: FakeCexWindowStorage;
  polymarketStorage: FakePolymarketRecordingStorage;
  generator: MessageMetadataGenerator;
} {
  const bus = trackBus(new ExternalMessageBus<ContourMessage>());
  const polymarketStorage = new FakePolymarketRecordingStorage();
  const cexStorage = new FakeCexWindowStorage();
  const recorder = new ExternalMessageRecorder({
    bus,
    storage: polymarketStorage,
    logger: new CapturingLogger(),
    cex: { bus, storage: cexStorage },
  });
  return {
    bus,
    recorder,
    cexStorage,
    polymarketStorage,
    generator: new MessageMetadataGenerator({ clock: new LiveClock() }),
  };
}

function orderbookPayload(): CexOrderbookPayload {
  return {
    exchangeId: 'binance',
    marketType: 'spot',
    symbol: 'BTC/USDT',
    orderBook: { symbol: 'BTC/USDT', bids: [[100, 1]], asks: [[101, 1]], timestamp: 1 },
  };
}

function tradePayload(): CexTradePayload {
  return {
    exchangeId: 'okx',
    marketType: 'spot',
    symbol: 'ETH/USDT',
    trade: { id: 't-1', price: 2_500, amount: 0.5, side: 'buy' },
  };
}

describe('общий bus — fan-out (PART 42)', () => {
  it('одно сообщение source-а получают И recorder, И независимый наблюдатель', async () => {
    const { bus, recorder, cexStorage, generator } = makeContour();
    const observed: CexOrderbookPayload[] = [];
    bus.subscribe('CEX_ORDERBOOK', (message) => void observed.push(message.payload));
    recorder.start();

    const payload = orderbookPayload();
    const published = await bus.publish({
      type: 'CEX_ORDERBOOK',
      payload,
      metadata: generator.nextRoot(),
    });

    expect(published.ok).toBe(true);
    expect(cexStorage.writes).toHaveLength(1);
    expect(observed).toHaveLength(1);
    // Обе ветки видят ОДИН И ТОТ ЖЕ source-native payload — без копий и конверсий.
    expect(cexStorage.writes[0]?.payload).toBe(payload);
    expect(observed[0]).toBe(payload);

    await recorder.close();
  });

  it('наблюдатель получает сообщения всех типов контура на ОДНОМ bus', async () => {
    const { bus, recorder, generator } = makeContour();
    const kinds: string[] = [];
    bus.subscribe('CEX_ORDERBOOK', () => void kinds.push('CEX_ORDERBOOK'));
    bus.subscribe('CEX_TRADE', () => void kinds.push('CEX_TRADE'));
    recorder.start();

    await bus.publish({
      type: 'CEX_ORDERBOOK',
      payload: orderbookPayload(),
      metadata: generator.nextRoot(),
    });
    await bus.publish({ type: 'CEX_TRADE', payload: tradePayload(), metadata: generator.nextRoot() });

    expect(kinds).toEqual(['CEX_ORDERBOOK', 'CEX_TRADE']);

    await recorder.close();
  });

  it('падение наблюдателя не лишает recorder его сообщения', async () => {
    const { bus, recorder, cexStorage, generator } = makeContour();
    bus.subscribe('CEX_ORDERBOOK', () => {
      throw new Error('observer exploded');
    });
    recorder.start();

    await bus.publish({
      type: 'CEX_ORDERBOOK',
      payload: orderbookPayload(),
      metadata: generator.nextRoot(),
    });

    expect(cexStorage.writes).toHaveLength(1);
    expect(bus.getStats().handlerErrorsTotal).toBeGreaterThan(0);

    await recorder.close();
  });

  it('наблюдатель, подписавшийся позже recorder, всё равно получает поток', async () => {
    const { bus, recorder, cexStorage, generator } = makeContour();
    recorder.start();
    const observed: unknown[] = [];
    bus.subscribe('CEX_TRADE', (message) => void observed.push(message.payload));

    await bus.publish({ type: 'CEX_TRADE', payload: tradePayload(), metadata: generator.nextRoot() });

    expect(observed).toHaveLength(1);
    expect(cexStorage.writes).toHaveLength(1);

    await recorder.close();
  });
});

describe('recorder — consumer bus, а не прямая цель source (PART 43)', () => {
  it('не получает ничего, пока не подписан на bus', async () => {
    const { bus, recorder, cexStorage, generator } = makeContour();

    // recorder.start() НЕ вызван — подписки нет.
    await bus.publish({
      type: 'CEX_ORDERBOOK',
      payload: orderbookPayload(),
      metadata: generator.nextRoot(),
    });

    expect(cexStorage.writes).toHaveLength(0);

    await recorder.close();
  });

  it('не получает сообщений, опубликованных мимо ЕГО bus', async () => {
    const { recorder, cexStorage, generator } = makeContour();
    recorder.start();
    const foreignBus = trackBus(new ExternalMessageBus<ContourMessage>());

    await foreignBus.publish({
      type: 'CEX_ORDERBOOK',
      payload: orderbookPayload(),
      metadata: generator.nextRoot(),
    });

    expect(cexStorage.writes).toHaveLength(0);

    await recorder.close();
  });

  it('после закрытия recorder поток bus остаётся доступен другим consumer-ам', async () => {
    const { bus, recorder, cexStorage, generator } = makeContour();
    const observed: unknown[] = [];
    bus.subscribe('CEX_TRADE', (message) => void observed.push(message.payload));
    recorder.start();
    await recorder.close();

    await bus.publish({ type: 'CEX_TRADE', payload: tradePayload(), metadata: generator.nextRoot() });

    expect(observed).toHaveLength(1);
    expect(cexStorage.writes).toHaveLength(0);
  });
});
