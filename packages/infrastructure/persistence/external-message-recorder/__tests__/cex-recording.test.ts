/**
 * Тесты CEX-политики recorder-а (N-005 PART 15/24 routing-слой).
 *
 * @remarks
 * Fake оконного storage проверяет routing/lifecycle/счётчики; реальная
 * оконная persistence и coexistence с Polymarket — в интеграционном
 * one-bus-one-recorder тесте.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import { MessageMetadataGenerator } from '@polymarket/messages';
import { LiveClock } from '@polymarket/time';
import type { PolymarketExternalMessage } from '@polymarket/polymarket-v2';
import type { CexExternalMessage, CexOrderbookPayload, CexTradePayload } from '@polymarket/cex-v2';
import { ExternalMessageRecorder } from '../src/index.js';
import { CapturingLogger, FakeCexWindowStorage, FakeRecordingStorage } from './helpers/fakes.js';

type ContourMessage = PolymarketExternalMessage | CexExternalMessage;

let bus: ExternalMessageBus<ContourMessage>;
let polymarketStorage: FakeRecordingStorage;
let cexStorage: FakeCexWindowStorage;
let logger: CapturingLogger;
let recorder: ExternalMessageRecorder;
let generator: MessageMetadataGenerator;

beforeEach(() => {
  bus = new ExternalMessageBus<ContourMessage>();
  polymarketStorage = new FakeRecordingStorage();
  cexStorage = new FakeCexWindowStorage();
  logger = new CapturingLogger();
  generator = new MessageMetadataGenerator({ clock: new LiveClock() });
  recorder = new ExternalMessageRecorder({
    bus,
    storage: polymarketStorage,
    logger,
    cex: { bus, storage: cexStorage },
  });
});

afterEach(async () => {
  await recorder.close();
});

function orderbookPayload(overrides: Partial<CexOrderbookPayload> = {}): CexOrderbookPayload {
  return {
    exchangeId: 'binance',
    marketType: 'swap',
    symbol: 'BTC/USDT:USDT',
    orderBook: { symbol: 'BTC/USDT:USDT', bids: [[100, 1]], asks: [[101, 1]], timestamp: 1 },
    ...overrides,
  };
}

function tradePayload(overrides: Partial<CexTradePayload> = {}): CexTradePayload {
  return {
    exchangeId: 'binance',
    marketType: 'swap',
    symbol: 'BTC/USDT:USDT',
    trade: { id: 't-1', price: 100.5, amount: 0.1, side: 'buy' },
    ...overrides,
  };
}

async function publishOb(payload: CexOrderbookPayload): Promise<void> {
  const result = await bus.publish({
    type: 'CEX_ORDERBOOK',
    payload,
    metadata: generator.nextRoot(),
  });
  expect(result.ok).toBe(true);
}

async function publishTrade(payload: CexTradePayload): Promise<void> {
  const result = await bus.publish({ type: 'CEX_TRADE', payload, metadata: generator.nextRoot() });
  expect(result.ok).toBe(true);
}

describe('CEX routing', () => {
  it('CEX_ORDERBOOK → write(..., orderbook) с routing-полями из typed payload', async () => {
    recorder.start();
    const payload = orderbookPayload();
    await publishOb(payload);

    expect(cexStorage.writes).toHaveLength(1);
    const write = cexStorage.writes[0]!;
    expect(write.exchangeId).toBe('binance');
    expect(write.symbol).toBe('BTC/USDT:USDT');
    expect(write.marketType).toBe('swap');
    expect(write.stream).toBe('orderbook');
    // Payload уходит ТОЙ ЖЕ ссылкой — без clone/rename/flatten
    expect(write.payload).toBe(payload);
  });

  it('CEX_TRADE → write(..., trades)', async () => {
    recorder.start();
    const payload = tradePayload();
    await publishTrade(payload);

    expect(cexStorage.writes).toHaveLength(1);
    expect(cexStorage.writes[0]!.stream).toBe('trades');
    expect(cexStorage.writes[0]!.payload).toBe(payload);
  });

  it('разные биржи/типы рынка маршрутизируются raw-полями payload (без эвристик)', async () => {
    recorder.start();
    await publishOb(orderbookPayload({ exchangeId: 'bybit', marketType: 'spot' }));
    await publishTrade(tradePayload({ exchangeId: 'okx', symbol: 'ETH/USDT' }));

    expect(cexStorage.writes.map((w) => [w.exchangeId, w.marketType, w.stream])).toEqual([
      ['bybit', 'spot', 'orderbook'],
      ['okx', 'swap', 'trades'],
    ]);
  });

  it('Polymarket-маршрутизация не затронута CEX-политикой', async () => {
    recorder.start();
    await publishOb(orderbookPayload());
    await publishTrade(tradePayload());

    expect(polymarketStorage.writes).toHaveLength(0);
    expect(recorder.getStats().unroutedMarketMessages).toBe(0);
    expect(recorder.getStats().unroutedRtdsMessages).toBe(0);
  });
});

describe('CEX lifecycle', () => {
  it('start() запускает оконный storage; close() закрывает его', async () => {
    recorder.start();
    expect(cexStorage.startCalls).toBe(1);

    await recorder.close();
    expect(cexStorage.closeCalls).toBe(1);
  });

  it('повторный start() не создаёт вторые подписки/запуски', async () => {
    recorder.start();
    recorder.start();
    expect(cexStorage.startCalls).toBe(1);

    await publishOb(orderbookPayload());
    expect(cexStorage.writes).toHaveLength(1);
  });

  it('сообщения после close() игнорируются', async () => {
    recorder.start();
    await recorder.close();

    await bus.publish({
      type: 'CEX_ORDERBOOK',
      payload: orderbookPayload(),
      metadata: generator.nextRoot(),
    });
    expect(cexStorage.writes).toHaveLength(0);
  });

  it('без CEX-конфигурации CEX-сообщения не обрабатываются, поведение N-002 сохранено', async () => {
    const plain = new ExternalMessageRecorder({ bus, storage: polymarketStorage, logger });
    plain.start();

    await publishOb(orderbookPayload());
    expect(cexStorage.writes).toHaveLength(0);
    expect(plain.getCexStats()).toEqual({
      cexMessagesRouted: 0,
      cexRecordsWritten: 0,
      cexRecordsDroppedInactive: 0,
      cexWriteFailures: 0,
      cexHandlerErrors: 0,
    });
    await plain.close();
  });
});

describe('CEX stats / защитный контур', () => {
  it('исходы записи учитываются в getCexStats()', async () => {
    recorder.start();
    await publishOb(orderbookPayload());
    cexStorage.outcomeOverride = 'inactive';
    await publishTrade(tradePayload());
    cexStorage.outcomeOverride = 'failed';
    await publishOb(orderbookPayload());

    expect(recorder.getCexStats()).toEqual({
      cexMessagesRouted: 3,
      cexRecordsWritten: 1,
      cexRecordsDroppedInactive: 1,
      cexWriteFailures: 1,
      cexHandlerErrors: 0,
    });
    // Polymarket-статистика не тронута
    expect(recorder.getStats().recordsWritten).toBe(0);
  });

  it('исключение storage не пробивает bus-handler (наблюдаемо в счётчике и логе)', async () => {
    recorder.start();
    cexStorage.throwOnWrite = new Error('disk detached');

    await publishOb(orderbookPayload());
    await publishTrade(tradePayload());

    expect(recorder.getCexStats().cexHandlerErrors).toBe(2);
    expect(
      logger.byLevel('error').filter((e) => e.message.includes('recording handler failed')),
    ).toHaveLength(2);

    // Recorder жив: после устранения причины запись продолжается
    cexStorage.throwOnWrite = undefined;
    await publishOb(orderbookPayload());
    expect(cexStorage.writes).toHaveLength(1);
  });
});
