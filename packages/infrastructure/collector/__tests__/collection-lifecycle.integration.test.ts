/**
 * Полный жизненный цикл записи рынка на НАСТОЯЩИХ компонентах контура.
 *
 * @remarks
 * Настоящие: `ExternalMessageBus`, `ExternalMessageRecorder`,
 * `PolymarketSubscriptionController`, `PolymarketCollectionGate`,
 * `PolymarketCollectionLifecycle`, `MarketUniverse`, `PolymarketPolicy`.
 * Подделки — только транспорт (source/discovery контроллера) и storage:
 * проверяются ПРАВИЛА контура, а не поведение одной функции.
 *
 * ```text
 * claim collector:raw → первое наблюдение → ACTIVE → expiresAt → FINALIZING
 *   → settlement grace → seal → release claim
 * ```
 */
import { afterEach, describe, expect, it } from '@jest/globals';
import { LiveClock } from '@polymarket/time';
import { MessageMetadataGenerator } from '@polymarket/messages';
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import { ExternalMessageRecorder } from '@polymarket/external-message-recorder';
import type { MarketDiscoveryEntry } from '@polymarket/ports';
import { CHAINLINK_TWAP_TOPIC } from '@polymarket/polymarket-v2';
import type { PolymarketExternalMessage } from '@polymarket/polymarket-v2';
import {
  COLLECTOR_RAW_OWNER_KEY,
  PolymarketCollectionGate,
  PolymarketCollectionLifecycle,
} from '../src/index.js';
import { CapturingLogger } from './helpers/CapturingLogger.js';
import type { ContourMessage, SubscriptionHarness } from './helpers/fixtures.js';
import {
  BASE_START_MS,
  BTC_FULL_FEEDS,
  FakeCexStorage,
  FakePolymarketStorage,
  acquireFor,
  bookEvent,
  deferred,
  makeEntry,
  makePolicy,
  makeSubscriptionHarness,
  makeUniverse,
  orderbookPayload,
} from './helpers/fixtures.js';

const openBuses: ExternalMessageBus<ContourMessage>[] = [];
const openLifecycles: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(openLifecycles.splice(0).map(async (item) => item.close()));
  await Promise.all(openBuses.splice(0).map(async (bus) => bus.close()));
});

/** Пятиминутный рынок фикстур: `[BASE_START_MS, BASE_START_MS + 5m)`. */
const MARKET_WINDOW_MS = 5 * 60_000;
const EXPIRES_AT_MS = BASE_START_MS + MARKET_WINDOW_MS;

/** Полный собранный контур сбора с lifecycle. */
interface LifecycleContour {
  readonly bus: ExternalMessageBus<ContourMessage>;
  readonly recorder: ExternalMessageRecorder;
  readonly gate: PolymarketCollectionGate;
  readonly lifecycle: PolymarketCollectionLifecycle;
  readonly pmStorage: FakePolymarketStorage;
  readonly cexStorage: FakeCexStorage;
  readonly subscriptions: SubscriptionHarness;
  readonly generator: MessageMetadataGenerator;
}

/**
 * Собирает контур: bus + recorder + gate + lifecycle поверх реального контроллера.
 *
 * @param entries - Записи universe
 * @param options - Отклонения (grace, момент часов, CEX-политика)
 * @returns Собранный контур
 */
function makeLifecycleContour(
  entries: readonly MarketDiscoveryEntry[],
  options: { readonly settlementGraceMs?: number; readonly cex?: boolean } = {},
): LifecycleContour {
  const bus = new ExternalMessageBus<ContourMessage>();
  openBuses.push(bus);
  const logger = new CapturingLogger();
  const universe = makeUniverse(entries);
  const subscriptions = makeSubscriptionHarness();
  const gate = new PolymarketCollectionGate({
    universe,
    policy: makePolicy(['btc'], ['5m']),
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
  const lifecycle = new PolymarketCollectionLifecycle(
    {
      recorder,
      subscriptions: subscriptions.controller,
      clock: subscriptions.clock,
      logger,
    },
    { settlementGraceMs: options.settlementGraceMs ?? 0 },
  );
  openLifecycles.push(lifecycle);
  return {
    bus,
    recorder,
    gate,
    lifecycle,
    pmStorage,
    cexStorage,
    subscriptions,
    generator: new MessageMetadataGenerator({ clock: new LiveClock() }),
  };
}

/** Публикует CLOB-наблюдение рынка на общую шину. */
async function publishMarket(contour: LifecycleContour, sourceMarketId: string): Promise<void> {
  const result = await contour.bus.publish({
    type: 'POLYMARKET_MARKET',
    payload: bookEvent(sourceMarketId),
    metadata: contour.generator.nextRoot(),
  });
  expect(result.ok).toBe(true);
}

/** Публикует spot-наблюдение Binance (общий фид всех BTC-рынков). */
async function publishSpot(contour: LifecycleContour): Promise<void> {
  const message: PolymarketExternalMessage = {
    type: 'POLYMARKET_CRYPTO_BINANCE',
    payload: {
      topic: 'prices.crypto.binance',
      type: 'update',
      payload: { symbol: 'btcusdt', value: '65000.5', timestamp: BASE_START_MS },
    },
    metadata: contour.generator.nextRoot(),
  } as unknown as PolymarketExternalMessage;
  const result = await contour.bus.publish(message);
  expect(result.ok).toBe(true);
}

/** Публикует наблюдение официального settlement-потока TWAP 60s. */
async function publishTwap(contour: LifecycleContour, timestampMs: number): Promise<void> {
  const message: PolymarketExternalMessage = {
    type: 'POLYMARKET_CRYPTO_CHAINLINK_TWAP',
    payload: {
      topic: CHAINLINK_TWAP_TOPIC,
      type: 'update',
      payload: {
        symbol: 'btc/usd',
        windowSeconds: 60,
        value: '65100.25',
        timestamp: timestampMs,
      },
    },
    metadata: contour.generator.nextRoot(),
  } as unknown as PolymarketExternalMessage;
  const result = await contour.bus.publish(message);
  expect(result.ok).toBe(true);
}

/** Готовит контур с одним приобретённым рынком и начатой записью. */
async function startRecording(
  contour: LifecycleContour,
  entry: MarketDiscoveryEntry,
  ownerKeys: readonly string[] = [COLLECTOR_RAW_OWNER_KEY],
): Promise<void> {
  for (const ownerKey of ownerKeys) {
    await acquireFor(contour.subscriptions, entry, ownerKey);
  }
  contour.recorder.start();
  await publishMarket(contour, String(entry.market.id));
  contour.subscriptions.clock.set(BASE_START_MS + 60_000);
  contour.lifecycle.syncSessions();
}

describe('B/C. первое наблюдение создаёт сессию и записывается само', () => {
  it('pre-open book-снапшот попадает в датасет, а не отбрасывается активацией', async () => {
    const entry = makeEntry({ id: 'btc-5m-1' });
    const contour = makeLifecycleContour([entry]);
    await acquireFor(contour.subscriptions, entry, COLLECTOR_RAW_OWNER_KEY);
    contour.recorder.start();

    // Часы контура — ДО начала торгов рынка (первый book приходит при подписке).
    expect(contour.subscriptions.clock.now().getTime()).toBeLessThan(BASE_START_MS);
    await publishMarket(contour, 'btc-5m-1');

    expect(contour.pmStorage.registered).toHaveLength(1);
    // startsAt не задан → storage-gate не отбрасывает опорный снапшот.
    expect(contour.pmStorage.registered[0]?.startsAt).toBeUndefined();
    expect(contour.pmStorage.writes).toHaveLength(1);

    contour.lifecycle.syncSessions();
    expect(contour.lifecycle.listSessions()).toHaveLength(1);
    expect(contour.lifecycle.listSessions()[0]?.state).toBe('ACTIVE');
  });
});

describe('D. RTDS/TWAP снова пишутся в датасет рынка', () => {
  it('ACTIVE рынок получает CLOB, spot и settlement TWAP в свой файл', async () => {
    const entry = makeEntry({ id: 'btc-5m-1' });
    const contour = makeLifecycleContour([entry]);
    await startRecording(contour, entry);

    await publishSpot(contour);
    await publishTwap(contour, BASE_START_MS + 60_000);

    // 1 CLOB + 1 spot + 1 TWAP
    expect(contour.pmStorage.writes).toHaveLength(3);
    expect(contour.recorder.getStats().rtdsMessagesRouted).toBe(2);
  });
});

describe('E. общий RTDS-фид размножается по всем подписанным рынкам', () => {
  it('одно наблюдение BTC-фида пишется в ОБА market-файла без второй подписки', async () => {
    const first = makeEntry({ id: 'btc-5m-1' });
    const second = makeEntry({ id: 'btc-5m-2' });
    const contour = makeLifecycleContour([first, second]);
    await acquireFor(contour.subscriptions, first, COLLECTOR_RAW_OWNER_KEY);
    await acquireFor(contour.subscriptions, second, COLLECTOR_RAW_OWNER_KEY);
    contour.recorder.start();
    await publishMarket(contour, 'btc-5m-1');
    await publishMarket(contour, 'btc-5m-2');
    const writesBefore = contour.pmStorage.writes.length;

    await publishSpot(contour);

    const spotWrites = contour.pmStorage.writes.slice(writesBefore);
    expect(spotWrites).toHaveLength(2);
    expect(spotWrites.map((write) => String(write.marketId)).sort()).toEqual([
      'btc-5m-1',
      'btc-5m-2',
    ]);
    // Физическая подписка ОДНА: ref-count ведёт контроллер, а не recorder.
    const binanceCalls = contour.subscriptions.source.cryptoCalls.filter(
      (call) => call.topic === 'prices.crypto.binance',
    );
    expect(binanceCalls).toHaveLength(1);
    expect(contour.subscriptions.controller.getStats().rtdsFeeds).toEqual(
      expect.arrayContaining([expect.objectContaining({ symbol: 'btcusdt', refCount: 2 })]),
    );
  });
});

describe('F. точная граница истечения', () => {
  it('после FINALIZING CLOB и spot не пишутся, settlement TWAP — пишется', async () => {
    const entry = makeEntry({ id: 'btc-5m-1' });
    // Grace открыт: датасет ещё принимает settlement-поток, но уже не CLOB.
    const contour = makeLifecycleContour([entry], { settlementGraceMs: 250 });
    await startRecording(contour, entry);
    await publishMarket(contour, 'btc-5m-1');
    const writesBeforeExpiry = contour.pmStorage.writes.length;
    expect(writesBeforeExpiry).toBe(2);

    // Рынок истёк; физический source ЖИВ (claim ещё не снят).
    contour.subscriptions.clock.set(EXPIRES_AT_MS);
    const finalizing = await contour.lifecycle.beginFinalization(entry.market.id);
    expect(finalizing).toBeDefined();

    await publishMarket(contour, 'btc-5m-1'); // CLOB после границы
    await publishSpot(contour); // обычный RTDS после границы
    await publishTwap(contour, EXPIRES_AT_MS); // граничный settlement

    const afterBoundary = contour.pmStorage.writes.slice(writesBeforeExpiry);
    expect(afterBoundary).toHaveLength(1);
    expect(contour.recorder.getStats().marketMessagesDroppedAfterExpiry).toBe(1);
    expect(contour.lifecycle.listSessions()[0]?.state).toBe('FINALIZING');

    await contour.lifecycle.awaitSettlementCapture(entry.market.id);
  });
});

describe('G. claim снимается ПОСЛЕ settlement capture и seal', () => {
  it('порядок: FINALIZING → граничное наблюдение → seal → release', async () => {
    const entry = makeEntry({ id: 'btc-5m-1' });
    const contour = makeLifecycleContour([entry], { settlementGraceMs: 250 });
    await startRecording(contour, entry);

    contour.subscriptions.clock.set(EXPIRES_AT_MS);
    await contour.lifecycle.beginFinalization(entry.market.id);

    // Граничное наблюдение приходит ВО ВРЕМЯ grace: физический фид ещё жив,
    // потому что claim коллектора ещё не снят.
    expect(
      contour.subscriptions.controller.getHeldMarket(COLLECTOR_RAW_OWNER_KEY, entry.market.id),
    ).toBeDefined();
    await publishTwap(contour, EXPIRES_AT_MS);
    expect(contour.pmStorage.sealed).toHaveLength(0);

    await contour.lifecycle.awaitSettlementCapture(entry.market.id);

    // Граничная строка записана ДО заморозки…
    expect(contour.pmStorage.writes.map((write) => String(write.marketId))).toContain('btc-5m-1');
    expect(contour.pmStorage.sealed).toEqual(['btc-5m-1']);
    // …и только потом снят claim.
    expect(
      contour.subscriptions.controller.getHeldMarket(COLLECTOR_RAW_OWNER_KEY, entry.market.id),
    ).toBeUndefined();
    expect(contour.lifecycle.getStats().claimsReleased).toBe(1);
  });
});

describe('H. shared owner: физический ресурс переживает release коллектора', () => {
  it('claim коллектора снят, подписка живёт для strategy:A, датасет sealed и закрыт', async () => {
    const entry = makeEntry({ id: 'btc-5m-1' });
    const contour = makeLifecycleContour([entry]);
    await startRecording(contour, entry, [COLLECTOR_RAW_OWNER_KEY, 'strategy:A']);
    const writesBefore = contour.pmStorage.writes.length;

    contour.subscriptions.clock.set(EXPIRES_AT_MS);
    await contour.lifecycle.beginFinalization(entry.market.id);
    await contour.lifecycle.awaitSettlementCapture(entry.market.id);

    // Физическая подписка удержана вторым владельцем…
    const stats = contour.subscriptions.controller.getStats();
    expect(stats.activeMarkets).toBe(1);
    expect(stats.claims).toBe(1);
    expect(
      contour.subscriptions.controller.getHeldMarket('strategy:A', entry.market.id),
    ).toBeDefined();
    // …но датасет коллектора заморожен, и поток strategy:A в него не идёт.
    expect(contour.pmStorage.sealed).toEqual(['btc-5m-1']);
    await publishMarket(contour, 'btc-5m-1');
    await publishSpot(contour);
    expect(contour.pmStorage.writes).toHaveLength(writesBefore);
    expect(contour.recorder.getStats().marketMessagesDroppedAfterSeal).toBe(1);
  });
});

describe('I. последний владелец закрывает физический ресурс', () => {
  it('после seal + release подписка рынка и его RTDS-ссылки закрыты, zombie-claim нет', async () => {
    const entry = makeEntry({ id: 'btc-5m-1' });
    const contour = makeLifecycleContour([entry]);
    await startRecording(contour, entry);
    const marketSubscription = contour.subscriptions.source.issued.find((item) =>
      item.label.startsWith('market:'),
    );
    expect(marketSubscription).toBeDefined();

    contour.subscriptions.clock.set(EXPIRES_AT_MS);
    await contour.lifecycle.beginFinalization(entry.market.id);
    await contour.lifecycle.awaitSettlementCapture(entry.market.id);

    const stats = contour.subscriptions.controller.getStats();
    expect(stats.activeMarkets).toBe(0);
    expect(stats.claims).toBe(0);
    expect(stats.rtdsFeeds).toEqual([]);
    expect(marketSubscription?.closeCalls).toBe(1);
    // Все физические RTDS-подписки закрыты вместе с последним claim-ом.
    for (const issued of contour.subscriptions.source.issued) {
      expect(issued.closeCalls).toBe(1);
    }
  });
});

describe('M. после seal в архив не дописывается ни одной строки', () => {
  it('CLOB, spot и TWAP после заморозки не попадают в датасет и не создают новую сессию', async () => {
    const entry = makeEntry({ id: 'btc-5m-1' });
    const contour = makeLifecycleContour([entry]);
    await startRecording(contour, entry, [COLLECTOR_RAW_OWNER_KEY, 'strategy:A']);
    contour.subscriptions.clock.set(EXPIRES_AT_MS);
    await contour.lifecycle.beginFinalization(entry.market.id);
    await contour.lifecycle.awaitSettlementCapture(entry.market.id);
    const writesAfterSeal = contour.pmStorage.writes.length;

    await publishMarket(contour, 'btc-5m-1');
    await publishSpot(contour);
    await publishTwap(contour, EXPIRES_AT_MS + 1_000);

    expect(contour.pmStorage.writes).toHaveLength(writesAfterSeal);
    // Вторая recording-сессия поверх завершённого датасета не создаётся.
    expect(contour.pmStorage.registered).toHaveLength(1);
    expect(contour.recorder.getStats().marketSessionsAdmitted).toBe(1);
  });
});

describe('N. rollover серии: N истёк, N+1 собирается', () => {
  it('данные следующего рынка не попадают в датасет предыдущего, zombie-подписок нет', async () => {
    const current = makeEntry({ id: 'btc-5m-1' });
    const next = makeEntry({ id: 'btc-5m-2', startsAtMs: EXPIRES_AT_MS });
    const contour = makeLifecycleContour([current, next]);
    await startRecording(contour, current);

    // Слот освобождается: рынок N истёк и финализируется…
    contour.subscriptions.clock.set(EXPIRES_AT_MS - 1);
    await acquireFor(contour.subscriptions, next, COLLECTOR_RAW_OWNER_KEY);
    contour.subscriptions.clock.set(EXPIRES_AT_MS);
    await contour.lifecycle.beginFinalization(current.market.id);
    await contour.lifecycle.awaitSettlementCapture(current.market.id);

    // …и рынок N+1 начинает писаться в СВОЙ датасет.
    await publishMarket(contour, 'btc-5m-2');
    contour.lifecycle.syncSessions();

    const writesByMarket = contour.pmStorage.writes.map((write) => String(write.marketId));
    expect(writesByMarket.filter((id) => id === 'btc-5m-2')).toHaveLength(1);
    expect(contour.pmStorage.sealed).toEqual(['btc-5m-1']);
    const sessions = contour.lifecycle.listSessions();
    expect(sessions.map((session) => String(session.marketId))).toEqual(['btc-5m-1', 'btc-5m-2']);
    expect(sessions.find((s) => String(s.marketId) === 'btc-5m-2')?.state).toBe('ACTIVE');
    // Подписка истёкшего рынка закрыта, нового — жива.
    expect(contour.subscriptions.controller.getStats().activeMarkets).toBe(1);
  });
});

describe('O/P. CEX и sibling-подписчики не зависят от PM lifecycle', () => {
  it('после истечения и seal PM-рынка CEX продолжает писаться, а sibling — получать поток', async () => {
    const entry = makeEntry({ id: 'btc-5m-1' });
    const contour = makeLifecycleContour([entry], { cex: true });
    const observed: string[] = [];
    contour.bus.subscribe('POLYMARKET_MARKET', () => void observed.push('PM'));
    contour.bus.subscribe('CEX_ORDERBOOK', () => void observed.push('CEX'));
    await startRecording(contour, entry);

    contour.subscriptions.clock.set(EXPIRES_AT_MS);
    await contour.lifecycle.beginFinalization(entry.market.id);
    await contour.lifecycle.awaitSettlementCapture(entry.market.id);

    await contour.bus.publish({
      type: 'CEX_ORDERBOOK',
      payload: orderbookPayload(),
      metadata: contour.generator.nextRoot(),
    });
    await publishMarket(contour, 'btc-5m-1');

    // CEX-поток независим от жизненного цикла PM-рынка.
    expect(contour.cexStorage.writes).toHaveLength(1);
    // Sibling-подписчик получил ОБА сообщения, включая PM после seal.
    expect(observed).toEqual(['PM', 'CEX', 'PM']);
  });
});

describe('lifecycle: таймер границы и наблюдаемость', () => {
  it('истечение наступает по expiresAt само, без внешнего тика', async () => {
    const entry = makeEntry({ id: 'btc-5m-1' });
    const contour = makeLifecycleContour([entry]);
    await acquireFor(contour.subscriptions, entry, COLLECTOR_RAW_OWNER_KEY);
    contour.recorder.start();
    await publishMarket(contour, 'btc-5m-1');
    // Часы уже ЗА границей рынка: таймер обязан сработать немедленно.
    contour.subscriptions.clock.set(EXPIRES_AT_MS);
    const kinds: string[] = [];
    contour.lifecycle.onLifecycleEvent((event) => void kinds.push(event.kind));

    contour.lifecycle.syncSessions();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    await contour.lifecycle.awaitAllSettlementCaptures();

    expect(kinds).toEqual(['STARTED', 'FINALIZING', 'SEALED']);
    expect(contour.pmStorage.sealed).toEqual(['btc-5m-1']);
  });

  it('close() закрывает ACTIVE-сессию как SHUTDOWN и снимает её claim', async () => {
    const entry = makeEntry({ id: 'btc-5m-1' });
    const contour = makeLifecycleContour([entry]);
    await startRecording(contour, entry);

    await contour.lifecycle.close();

    expect(contour.pmStorage.finalized).toEqual([{ marketId: 'btc-5m-1', reason: 'SHUTDOWN' }]);
    expect(
      contour.subscriptions.controller.getHeldMarket(COLLECTOR_RAW_OWNER_KEY, entry.market.id),
    ).toBeUndefined();
    expect(contour.lifecycle.getStats().shutdownSessions).toBe(1);
  });
});

describe('сирота откаченного приобретения: датасет failed-поколения не склеивается с retry', () => {
  /**
   * Доводит приобретение до момента «market подписан, RTDS в процессе».
   *
   * @param contour - Контур сбора
   * @param entry - Canonical запись рынка
   * @param options - Отказывающие RTDS-символы и удержание RTDS-подписки
   * @returns Обёртка над ещё не завершённым приобретением
   *
   * @remarks
   * Именно это окно делает возможной сироту: `subscribeMarket()` уже открыт и
   * pump публикует первый book, а транзакция ещё может откатиться.
   *
   * Промис приобретения возвращается ЗАВЁРНУТЫМ в объект: голый
   * `Promise<Promise<T>>` вызывающий `await` развернул бы до конца и сразу
   * повис бы на удержанной RTDS-подписке.
   */
  async function acquireUntilRtdsInFlight(
    contour: LifecycleContour,
    entry: MarketDiscoveryEntry,
    options: { readonly hold: Promise<void>; readonly failSymbol?: string },
  ): Promise<{ readonly acquiring: Promise<unknown> }> {
    contour.subscriptions.discovery.register(entry, { rtdsFeeds: BTC_FULL_FEEDS });
    contour.subscriptions.source.rtdsHold = options.hold;
    if (options.failSymbol !== undefined) {
      contour.subscriptions.source.rtdsErrorSymbols.add(options.failSymbol);
    }
    const acquiring = contour.subscriptions.controller.acquire(COLLECTOR_RAW_OWNER_KEY, entry);
    while (contour.subscriptions.source.rtdsCallCount === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return { acquiring };
  }

  it('rollback после первой записанной строки → датасет снесён, retry пишет ЧИСТУЮ новую сессию', async () => {
    const entry = makeEntry({ id: 'btc-5m-1' });
    const contour = makeLifecycleContour([entry]);
    contour.recorder.start();

    // ── Поколение 1: market подписан, RTDS в полёте ───────────────────────
    const gate = deferred();
    const { acquiring } = await acquireUntilRtdsInFlight(contour, entry, {
      hold: gate.promise,
      failSymbol: 'btcusdt',
    });
    // Первый book приходит ВО ВРЕМЯ OPENING и записывается: claim уже есть.
    await publishMarket(contour, 'btc-5m-1');
    expect(contour.pmStorage.registered).toHaveLength(1);
    expect(contour.pmStorage.writes).toHaveLength(1);

    // ── RTDS отказал → контроллер откатывает приобретение ─────────────────
    gate.resolve();
    contour.subscriptions.source.rtdsHold = undefined;
    await expect(acquiring).resolves.toMatchObject({ status: 'failed' });
    expect(
      contour.subscriptions.controller.getHeldMarket(COLLECTOR_RAW_OWNER_KEY, entry.market.id),
    ).toBeUndefined();
    // Recording-сессия пережила откат — это и есть сирота.
    expect(contour.recorder.listMarketSessions()).toHaveLength(1);

    // ── Проход lifecycle сносит её как незавершённый датасет ──────────────
    await contour.lifecycle.runOnce();

    expect(contour.pmStorage.finalized).toEqual([{ marketId: 'btc-5m-1', reason: 'SHUTDOWN' }]);
    expect(contour.recorder.listMarketSessions()).toEqual([]);
    expect(contour.lifecycle.listSessions()).toEqual([]);
    expect(contour.lifecycle.getStats().orphanSessionsDiscarded).toBe(1);

    // ── Поколение 2: приобретение повторяется и УСПЕВАЕТ ──────────────────
    contour.subscriptions.source.rtdsErrorSymbols.clear();
    await acquireFor(contour.subscriptions, entry, COLLECTOR_RAW_OWNER_KEY);
    await publishMarket(contour, 'btc-5m-1');
    contour.lifecycle.syncSessions();

    // Новая регистрация — значит НОВЫЙ датасет, а не дописывание в старый.
    expect(contour.pmStorage.registered).toHaveLength(2);
    expect(contour.recorder.getStats().marketSessionsAdmitted).toBe(2);
    // Порядок доказывает отсутствие склейки: запись → снос → новая запись.
    expect(contour.pmStorage.finalized).toHaveLength(1);
    expect(contour.lifecycle.listSessions()).toHaveLength(1);
    expect(contour.lifecycle.listSessions()[0]?.state).toBe('ACTIVE');
  });

  it('успешное OPENING → ACTIVE снос НЕ трогает, первый pre-open book сохранён', async () => {
    const entry = makeEntry({ id: 'btc-5m-1' });
    const contour = makeLifecycleContour([entry]);
    contour.recorder.start();

    const gate = deferred();
    const { acquiring } = await acquireUntilRtdsInFlight(contour, entry, { hold: gate.promise });
    await publishMarket(contour, 'btc-5m-1');

    // Снос идёт ПОКА приобретение ещё в полёте: claim уже создан (синхронно
    // при резервации), поэтому сессия сиротой не считается.
    await contour.lifecycle.runOnce();
    expect(contour.pmStorage.finalized).toEqual([]);

    gate.resolve();
    contour.subscriptions.source.rtdsHold = undefined;
    await expect(acquiring).resolves.toMatchObject({ status: 'opened' });

    await contour.lifecycle.runOnce();

    expect(contour.pmStorage.finalized).toEqual([]);
    expect(contour.lifecycle.getStats().orphanSessionsDiscarded).toBe(0);
    // Опорный pre-open снапшот на месте.
    expect(contour.pmStorage.writes).toHaveLength(1);
    expect(contour.lifecycle.listSessions()[0]?.state).toBe('ACTIVE');
  });

  it('FINALIZING/SEALED сессия НЕ сносится: там claim снят штатно, архивом владеет финализатор', async () => {
    const entry = makeEntry({ id: 'btc-5m-1' });
    const contour = makeLifecycleContour([entry]);
    await startRecording(contour, entry);
    contour.subscriptions.clock.set(EXPIRES_AT_MS);
    await contour.lifecycle.beginFinalization(entry.market.id);
    await contour.lifecycle.awaitSettlementCapture(entry.market.id);
    // Claim снят ПОСЛЕ заморозки — именно так и должно быть.
    expect(
      contour.subscriptions.controller.getHeldMarket(COLLECTOR_RAW_OWNER_KEY, entry.market.id),
    ).toBeUndefined();

    await contour.lifecycle.runOnce();

    expect(contour.pmStorage.finalized).toEqual([]);
    expect(contour.lifecycle.getStats().orphanSessionsDiscarded).toBe(0);
    expect(contour.lifecycle.listSessions()[0]?.state).toBe('FINALIZING');
  });

  it('рынок ЧУЖОГО владельца сессии не создаёт — сносить нечего', async () => {
    const entry = makeEntry({ id: 'btc-5m-1' });
    const contour = makeLifecycleContour([entry]);
    await acquireFor(contour.subscriptions, entry, 'strategy:A');
    contour.recorder.start();

    await publishMarket(contour, 'btc-5m-1');
    await contour.lifecycle.runOnce();

    expect(contour.pmStorage.registered).toEqual([]);
    expect(contour.pmStorage.finalized).toEqual([]);
    expect(contour.gate.getStats().ignoredNotHeldByCollector).toBe(1);
    expect(contour.lifecycle.getStats().orphanSessionsDiscarded).toBe(0);
  });
});

describe('release claim идемпотентен на сессию', () => {
  it('close() ПОСЛЕ завершённой границы не снимает claim второй раз', async () => {
    const entry = makeEntry({ id: 'btc-5m-1' });
    const contour = makeLifecycleContour([entry]);
    await startRecording(contour, entry);
    contour.subscriptions.clock.set(EXPIRES_AT_MS);
    await contour.lifecycle.beginFinalization(entry.market.id);
    await contour.lifecycle.awaitSettlementCapture(entry.market.id);
    expect(contour.lifecycle.getStats().claimsReleased).toBe(1);

    // Сессия ещё жива: completeFinalization её не снимал (финализатор не
    // отработал) — именно здесь `close()` и дублировал release.
    expect(contour.lifecycle.listSessions()).toHaveLength(1);
    await contour.lifecycle.close();

    expect(contour.lifecycle.getStats().claimsReleased).toBe(1);
    expect(contour.lifecycle.getStats().finalizationFailures).toBe(0);
  });

  it('close() ВО ВРЕМЯ границы дожидается её и не дублирует release', async () => {
    const entry = makeEntry({ id: 'btc-5m-1' });
    const contour = makeLifecycleContour([entry], { settlementGraceMs: 250 });
    await startRecording(contour, entry);
    contour.subscriptions.clock.set(EXPIRES_AT_MS);
    await contour.lifecycle.beginFinalization(entry.market.id);

    // Граница ещё идёт (grace не истёк) — close() обязан её дождаться.
    await contour.lifecycle.close();

    expect(contour.pmStorage.sealed).toEqual(['btc-5m-1']);
    expect(contour.lifecycle.getStats().claimsReleased).toBe(1);
    // FINALIZING-сессия НЕ закрывается как SHUTDOWN: её архивом владеет
    // финализатор, а датасет уже заморожен.
    expect(contour.pmStorage.finalized).toEqual([]);
  });

  it('сессия, принятая уже FINALIZING (без своей задачи границы), освобождается в close()', async () => {
    const entry = makeEntry({ id: 'btc-5m-1' });
    const contour = makeLifecycleContour([entry]);
    await acquireFor(contour.subscriptions, entry, COLLECTOR_RAW_OWNER_KEY);
    contour.recorder.start();
    await publishMarket(contour, 'btc-5m-1');
    // Переход выполнен В ОБХОД lifecycle (например, legacy-путь recorder-а):
    // своей задачи границы у сессии не будет.
    contour.recorder.beginMarketFinalization(entry.market.id, []);
    contour.subscriptions.clock.set(BASE_START_MS + 60_000);
    contour.lifecycle.syncSessions();
    expect(contour.lifecycle.listSessions()[0]?.state).toBe('FINALIZING');
    expect(contour.lifecycle.getStats().claimsReleased).toBe(0);

    await contour.lifecycle.close();

    // Zombie-claim после остановки процесса недопустим.
    expect(contour.lifecycle.getStats().claimsReleased).toBe(1);
    expect(
      contour.subscriptions.controller.getHeldMarket(COLLECTOR_RAW_OWNER_KEY, entry.market.id),
    ).toBeUndefined();
  });
});
