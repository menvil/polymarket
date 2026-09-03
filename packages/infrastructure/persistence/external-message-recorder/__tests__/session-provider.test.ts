/**
 * Ленивый допуск рынка к записи по первому наблюдению (Collector-cutover).
 *
 * @remarks
 * Bus — НАСТОЯЩИЙ `ExternalMessageBus`, storage — узкий fake. Тесты
 * фиксируют главный инвариант cutover: первое `POLYMARKET_MARKET`, которое
 * инициировало сессию через провайдера, ЗАПИСЫВАЕТСЯ, а не теряется; а также
 * что провайдер спрашивается только при отсутствии активной сессии.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import { MessageMetadataGenerator } from '@polymarket/messages';
import { LiveClock } from '@polymarket/time';
import { unsafeMarketId } from '@polymarket/ids';
import type { MarketMeta } from '@polymarket/ports';
import type { PolymarketExternalMessage, StandardMarketEvent } from '@polymarket/polymarket-v2';
import { ExternalMessageRecorder } from '../src/index.js';
import type { PolymarketRecordingSessionProvider } from '../src/index.js';
import { FakeRecordingStorage, CapturingLogger } from './helpers/fakes.js';
import { MARKET_CONDITION_ID, MARKET_CONDITION_ID_B, createBookEvent } from './helpers/sdkFixtures.js';

let bus: ExternalMessageBus<PolymarketExternalMessage>;
let storage: FakeRecordingStorage;
let logger: CapturingLogger;
let generator: MessageMetadataGenerator;

beforeEach(() => {
  bus = new ExternalMessageBus<PolymarketExternalMessage>();
  storage = new FakeRecordingStorage();
  logger = new CapturingLogger();
  generator = new MessageMetadataGenerator({ clock: new LiveClock() });
});

function meta(sourceMarketId: string): MarketMeta {
  return {
    marketId: unsafeMarketId(sourceMarketId),
    question: 'Will BTC go up?',
    tokenIds: ['tok-up', 'tok-down'],
    expiresAt: { toNumber: () => 9999999999999 } as never,
  };
}

async function publishMarket(event: StandardMarketEvent): Promise<void> {
  const result = await bus.publish({
    type: 'POLYMARKET_MARKET',
    payload: event,
    metadata: generator.nextRoot(),
  });
  expect(result.ok).toBe(true);
}

/** Провайдер, допускающий ровно перечисленные source market id. */
function providerFor(...allowed: string[]): PolymarketRecordingSessionProvider {
  const set = new Set(allowed);
  return (sourceMarketId) =>
    set.has(sourceMarketId) ? { marketMeta: meta(sourceMarketId) } : undefined;
}

describe('ленивый допуск: первое наблюдение не теряется', () => {
  it('первое сообщение допущенного рынка создаёт сессию И записывается (count 1)', async () => {
    const recorder = new ExternalMessageRecorder({
      bus,
      storage,
      logger,
      sessionProvider: providerFor(MARKET_CONDITION_ID),
    });
    recorder.start();

    await publishMarket(createBookEvent());

    // Ключевой инвариант cutover: РОВНО одна запись, не ноль.
    expect(storage.writes).toHaveLength(1);
    expect(storage.registered).toHaveLength(1);
    expect(String(storage.registered[0]?.marketId)).toBe(MARKET_CONDITION_ID);
    expect(recorder.getStats().marketSessionsAdmitted).toBe(1);
    expect(recorder.getStats().marketMessagesRouted).toBe(1);

    await recorder.close();
  });

  it('второе и последующие сообщения пишутся без повторного допуска', async () => {
    let admitCalls = 0;
    const provider: PolymarketRecordingSessionProvider = (sourceMarketId) => {
      admitCalls++;
      return { marketMeta: meta(sourceMarketId) };
    };
    const recorder = new ExternalMessageRecorder({ bus, storage, logger, sessionProvider: provider });
    recorder.start();

    await publishMarket(createBookEvent());
    await publishMarket(createBookEvent());
    await publishMarket(createBookEvent());

    expect(storage.writes).toHaveLength(3);
    // Провайдер вызван РОВНО один раз: активная сессия его не пересчитывает.
    expect(admitCalls).toBe(1);
    expect(recorder.getStats().marketSessionsAdmitted).toBe(1);

    await recorder.close();
  });
});

describe('ленивый допуск: политика отклоняет', () => {
  it('рынок, отклонённый провайдером, не создаёт сессию и не пишется', async () => {
    const recorder = new ExternalMessageRecorder({
      bus,
      storage,
      logger,
      sessionProvider: providerFor(MARKET_CONDITION_ID),
    });
    recorder.start();

    // Публикуем событие ДРУГОГО рынка, которого нет в allow-list провайдера.
    await publishMarket(createBookEvent({ market: MARKET_CONDITION_ID_B }));

    expect(storage.writes).toHaveLength(0);
    expect(storage.registered).toHaveLength(0);
    expect(recorder.getStats().marketMessagesIgnoredByPolicy).toBe(1);
    // Игнор политикой — это НЕ «потеря» (unrouted): счётчик потерь чист.
    expect(recorder.getStats().unroutedMarketMessages).toBe(0);

    await recorder.close();
  });

  it('без провайдера незарегистрированный рынок остаётся unrouted (прежнее поведение)', async () => {
    const recorder = new ExternalMessageRecorder({ bus, storage, logger });
    recorder.start();

    await publishMarket(createBookEvent());

    expect(storage.writes).toHaveLength(0);
    expect(recorder.getStats().unroutedMarketMessages).toBe(1);
    expect(recorder.getStats().marketMessagesIgnoredByPolicy).toBe(0);
    expect(recorder.getStats().marketSessionsAdmitted).toBe(0);

    await recorder.close();
  });

  it('провайдер, вернувший регистрацию ДРУГОГО рынка, отклоняется', async () => {
    const provider: PolymarketRecordingSessionProvider = () => ({
      marketMeta: meta(MARKET_CONDITION_ID_B), // не тот, что спросили
    });
    const recorder = new ExternalMessageRecorder({ bus, storage, logger, sessionProvider: provider });
    recorder.start();

    await publishMarket(createBookEvent({ market: MARKET_CONDITION_ID }));

    expect(storage.writes).toHaveLength(0);
    expect(storage.registered).toHaveLength(0);
    expect(recorder.getStats().marketMessagesIgnoredByPolicy).toBe(1);

    await recorder.close();
  });

  it('explicit registerMarket по-прежнему работает и провайдер для него не нужен', async () => {
    const recorder = new ExternalMessageRecorder({
      bus,
      storage,
      logger,
      sessionProvider: providerFor(), // ничего не допускает
    });
    recorder.start();
    recorder.registerMarket({ marketMeta: meta(MARKET_CONDITION_ID) });

    await publishMarket(createBookEvent());

    expect(storage.writes).toHaveLength(1);
    // Сессия была создана явно — ленивый допуск не участвовал.
    expect(recorder.getStats().marketSessionsAdmitted).toBe(0);
    expect(recorder.getStats().marketMessagesIgnoredByPolicy).toBe(0);

    await recorder.close();
  });
});
