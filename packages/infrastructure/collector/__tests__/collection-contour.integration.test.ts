/**
 * Архитектурные инварианты контура сбора (Collector-cutover, критерии A–H).
 *
 * @remarks
 * НАСТОЯЩИЕ `ExternalMessageBus` + `ExternalMessageRecorder` + `MarketUniverse`
 * + `PolymarketPolicy`; fake — только storage. Провайдер сессий recorder-а —
 * реальный {@link PolymarketCollectionGate}. Так тест доказывает контур:
 *
 * ```text
 * source.publish → ОДИН ExternalMessageBus
 *                     ├── Collector (recorder + gate)   ← пишет интересное
 *                     └── наблюдатель (semantic adapter завтра)  ← sibling
 * ```
 */
import { afterEach, describe, expect, it } from '@jest/globals';
import { LiveClock } from '@polymarket/time';
import { MessageMetadataGenerator } from '@polymarket/messages';
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import { ExternalMessageRecorder } from '@polymarket/external-message-recorder';
import { COLLECTOR_RAW_OWNER_KEY, PolymarketCollectionGate } from '../src/index.js';
import { CapturingLogger } from './helpers/CapturingLogger.js';
import type { ContourMessage, SubscriptionHarness } from './helpers/fixtures.js';
import {
  FakeCexStorage,
  FakePolymarketStorage,
  acquireFor,
  bookEvent,
  makeEntry,
  makePolicy,
  makeSubscriptionHarness,
  makeUniverse,
  orderbookPayload,
  tradePayload,
} from './helpers/fixtures.js';

const openBuses: ExternalMessageBus<ContourMessage>[] = [];

afterEach(async () => {
  await Promise.all(openBuses.splice(0).map(async (bus) => bus.close()));
});

interface Contour {
  readonly bus: ExternalMessageBus<ContourMessage>;
  readonly recorder: ExternalMessageRecorder;
  readonly gate: PolymarketCollectionGate;
  readonly pmStorage: FakePolymarketStorage;
  readonly cexStorage: FakeCexStorage;
  readonly generator: MessageMetadataGenerator;
  readonly subscriptions: SubscriptionHarness;
}

/** Собирает мини-контур с заданным universe и policy коллектора. */
function makeContour(options: {
  readonly entries: ReturnType<typeof makeEntry>[];
  readonly assets?: readonly string[];
  readonly durations?: readonly string[];
  readonly cex?: boolean;
}): Contour {
  const bus = new ExternalMessageBus<ContourMessage>();
  openBuses.push(bus);
  const logger = new CapturingLogger();
  const universe = makeUniverse(options.entries);
  const policy = makePolicy(options.assets ?? ['btc'], options.durations ?? ['5m']);
  const subscriptions = makeSubscriptionHarness();
  const gate = new PolymarketCollectionGate({
    universe,
    policy,
    subscriptions: subscriptions.controller,
    logger,
  });
  const pmStorage = new FakePolymarketStorage();
  const cexStorage = new FakeCexStorage();
  const recorder = new ExternalMessageRecorder({
    bus,
    storage: pmStorage,
    logger,
    sessionProvider: gate.sessionProvider(),
    ...(options.cex === true ? { cex: { bus, storage: cexStorage } } : {}),
  });
  return {
    bus,
    recorder,
    gate,
    pmStorage,
    cexStorage,
    subscriptions,
    generator: new MessageMetadataGenerator({ clock: new LiveClock() }),
  };
}

async function publishMarket(contour: Contour, sourceMarketId: string): Promise<void> {
  const result = await contour.bus.publish({
    type: 'POLYMARKET_MARKET',
    payload: bookEvent(sourceMarketId),
    metadata: contour.generator.nextRoot(),
  });
  expect(result.ok).toBe(true);
}

describe('A. первое Polymarket-сообщение не теряется', () => {
  it('нет сессии + рынок в universe + policy подошла + claim коллектора → сессия создана и это же сообщение записано', async () => {
    const entry = makeEntry({ id: 'btc-5m-1' });
    const contour = makeContour({ entries: [entry] });
    await acquireFor(contour.subscriptions, entry, COLLECTOR_RAW_OWNER_KEY);
    contour.recorder.start();

    await publishMarket(contour, 'btc-5m-1');

    // Ключевой инвариант: РОВНО одна запись, не ноль.
    expect(contour.pmStorage.writes).toHaveLength(1);
    expect(String(contour.pmStorage.writes[0]?.marketId)).toBe('btc-5m-1');
    expect(contour.pmStorage.registered).toHaveLength(1);
    expect(contour.gate.getStats().admitted).toBe(1);
    expect(contour.recorder.getStats().marketSessionsAdmitted).toBe(1);

    await contour.recorder.close();
  });
});

describe('B. неинтересный рынок игнорируется', () => {
  it('рынок есть в universe, но policy не подошла → сессия не создаётся, запись не идёт', async () => {
    // policy btc/5m; рынок eth/15m в universe, но не подходит.
    const entry = makeEntry({ id: 'eth-15m-1', asset: 'eth', nominalMs: 15 * 60_000 });
    const contour = makeContour({ entries: [entry], assets: ['btc'], durations: ['5m'] });
    await acquireFor(contour.subscriptions, entry, COLLECTOR_RAW_OWNER_KEY);
    contour.recorder.start();

    await publishMarket(contour, 'eth-15m-1');

    expect(contour.pmStorage.writes).toHaveLength(0);
    expect(contour.pmStorage.registered).toHaveLength(0);
    expect(contour.recorder.getStats().marketMessagesIgnoredByPolicy).toBe(1);

    await contour.recorder.close();
  });

  it('рынок держит ТОЛЬКО другой владелец → сессия не создаётся, ignoredNotHeldByCollector', async () => {
    const entry = makeEntry({ id: 'btc-5m-1' });
    const contour = makeContour({ entries: [entry] });
    // Physical поток открыт стратегией; policy коллектора совпадает.
    await acquireFor(contour.subscriptions, entry, 'strategy:A');
    contour.recorder.start();

    await publishMarket(contour, 'btc-5m-1');

    expect(contour.pmStorage.registered).toHaveLength(0);
    expect(contour.pmStorage.writes).toHaveLength(0);
    expect(contour.gate.getStats().ignoredNotHeldByCollector).toBe(1);
    expect(contour.gate.getStats().ignoredByPolicy).toBe(0);
    expect(contour.recorder.getStats().marketMessagesIgnoredByPolicy).toBe(1);

    await contour.recorder.close();
  });
});

describe('C. неизвестный рынок игнорируется', () => {
  it('marketId отсутствует в universe → ничего не создаётся и не пишется', async () => {
    const contour = makeContour({ entries: [makeEntry({ id: 'btc-5m-1' })] });
    contour.recorder.start();

    await publishMarket(contour, 'unknown-market-id');

    expect(contour.pmStorage.writes).toHaveLength(0);
    expect(contour.pmStorage.registered).toHaveLength(0);
    expect(contour.gate.getStats().ignoredUnknownMarket).toBe(1);

    await contour.recorder.close();
  });
});

describe('D. active session не пересчитывает policy', () => {
  it('первое сообщение создаёт сессию; после смены policy следующее всё равно пишется', async () => {
    const bus = new ExternalMessageBus<ContourMessage>();
    openBuses.push(bus);
    const logger = new CapturingLogger();
    const entry = makeEntry({ id: 'btc-5m-1' });
    const universe = makeUniverse([entry]);
    const subscriptions = makeSubscriptionHarness();
    await acquireFor(subscriptions, entry, COLLECTOR_RAW_OWNER_KEY);
    // Провайдер, который перестанет допускать после первого допуска —
    // моделирует «policy изменилась / matcher теперь false».
    let admitEnabled = true;
    const gate = new PolymarketCollectionGate({
      universe,
      policy: makePolicy(['btc'], ['5m']),
      subscriptions: subscriptions.controller,
      logger,
    });
    const pmStorage = new FakePolymarketStorage();
    const recorder = new ExternalMessageRecorder({
      bus,
      storage: pmStorage,
      logger,
      sessionProvider: (sourceMarketId) => (admitEnabled ? gate.admit(sourceMarketId) : undefined),
    });
    const generator = new MessageMetadataGenerator({ clock: new LiveClock() });
    recorder.start();

    // Первое сообщение: policy подошла, сессия создана, запись #1.
    await bus.publish({ type: 'POLYMARKET_MARKET', payload: bookEvent('btc-5m-1'), metadata: generator.nextRoot() });

    // Policy «поменялась»: провайдер теперь отклонил бы рынок.
    admitEnabled = false;

    // Следующее сообщение того же рынка: сессия уже активна — провайдер НЕ
    // вызывается, запись #2 идёт.
    await bus.publish({ type: 'POLYMARKET_MARKET', payload: bookEvent('btc-5m-1'), metadata: generator.nextRoot() });

    expect(pmStorage.writes).toHaveLength(2);
    // Провайдер вызван РОВНО один раз (только до появления сессии).
    expect(gate.getStats().admitted).toBe(1);
    expect(recorder.getStats().marketMessagesIgnoredByPolicy).toBe(0);

    await recorder.close();
    await subscriptions.controller.close();
  });
});

describe('F. CEX проходит через ту же шину', () => {
  it('CEX_ORDERBOOK и CEX_TRADE, опубликованные на шину, записываются оконным storage', async () => {
    const contour = makeContour({ entries: [makeEntry({ id: 'btc-5m-1' })], cex: true });
    contour.recorder.start();

    await contour.bus.publish({ type: 'CEX_ORDERBOOK', payload: orderbookPayload(), metadata: contour.generator.nextRoot() });
    await contour.bus.publish({ type: 'CEX_TRADE', payload: tradePayload(), metadata: contour.generator.nextRoot() });

    expect(contour.cexStorage.writes).toHaveLength(2);
    expect(contour.cexStorage.writes.map((write) => write.stream)).toEqual(['orderbook', 'trades']);
    expect(contour.recorder.getCexStats().cexRecordsAccepted).toBe(2);

    await contour.recorder.close();
  });
});

describe('G. Collector и наблюдатель — независимые подписчики', () => {
  it('одно raw-сообщение получают и recorder, и независимый наблюдатель', async () => {
    const contour = makeContour({ entries: [makeEntry({ id: 'btc-5m-1' })], cex: true });
    const observed: string[] = [];
    // Независимый sibling-подписчик (роль будущего semantic adapter).
    contour.bus.subscribe('CEX_ORDERBOOK', () => void observed.push('CEX_ORDERBOOK'));
    contour.recorder.start();

    await contour.bus.publish({ type: 'CEX_ORDERBOOK', payload: orderbookPayload(), metadata: contour.generator.nextRoot() });

    expect(contour.cexStorage.writes).toHaveLength(1);
    expect(observed).toEqual(['CEX_ORDERBOOK']);

    await contour.recorder.close();
  });

  it('наблюдатель получает поток, даже если collector НЕ подписан на шину', async () => {
    const bus = new ExternalMessageBus<ContourMessage>();
    openBuses.push(bus);
    const generator = new MessageMetadataGenerator({ clock: new LiveClock() });
    const observed: string[] = [];
    // Semantic adapter (sibling) подписан; recorder коллектора НЕ создаётся.
    bus.subscribe('POLYMARKET_MARKET', () => void observed.push('POLYMARKET_MARKET'));

    await bus.publish({ type: 'POLYMARKET_MARKET', payload: bookEvent('btc-5m-1'), metadata: generator.nextRoot() });

    // Collector — sibling consumer, не gate: его отсутствие не лишает
    // semantic path сообщений.
    expect(observed).toEqual(['POLYMARKET_MARKET']);
  });

  it('collector ПРИСУТСТВУЕТ и ОТКЛОНЯЕТ рынок — наблюдатель всё равно получает сообщение', async () => {
    // policy btc/5m; рынок eth/15m в universe, но коллектор его отклонит.
    const contour = makeContour({
      entries: [makeEntry({ id: 'eth-15m-1', asset: 'eth', nominalMs: 15 * 60_000 })],
      assets: ['btc'],
      durations: ['5m'],
    });
    const observed: string[] = [];
    // Semantic adapter (sibling) подписан ДО recorder-а коллектора.
    contour.bus.subscribe('POLYMARKET_MARKET', () => void observed.push('POLYMARKET_MARKET'));
    contour.recorder.start();

    await publishMarket(contour, 'eth-15m-1');

    // Коллектор рынок НЕ записал (policy не подошла)…
    expect(contour.pmStorage.writes).toHaveLength(0);
    expect(contour.recorder.getStats().marketMessagesIgnoredByPolicy).toBe(1);
    // …но семантический путь сообщение получил: отказ коллектора — не gate.
    expect(observed).toEqual(['POLYMARKET_MARKET']);

    await contour.recorder.close();
  });
});

describe('H. PM + CEX одновременно на одной шине', () => {
  it('один bus разводит Polymarket- и CEX-сообщения по нужным политикам recorder-а', async () => {
    const entry = makeEntry({ id: 'btc-5m-1' });
    const contour = makeContour({ entries: [entry], cex: true });
    await acquireFor(contour.subscriptions, entry, COLLECTOR_RAW_OWNER_KEY);
    contour.recorder.start();

    await publishMarket(contour, 'btc-5m-1');
    await contour.bus.publish({ type: 'CEX_ORDERBOOK', payload: orderbookPayload(), metadata: contour.generator.nextRoot() });
    await contour.bus.publish({ type: 'CEX_TRADE', payload: tradePayload('okx', 'ETH/USDT'), metadata: contour.generator.nextRoot() });

    expect(contour.pmStorage.writes).toHaveLength(1);
    expect(contour.cexStorage.writes).toHaveLength(2);

    await contour.recorder.close();
  });
});
