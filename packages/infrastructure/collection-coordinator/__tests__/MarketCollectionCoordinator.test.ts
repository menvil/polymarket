/**
 * Поведенческие тесты MarketCollectionCoordinator: точный порядок открытия,
 * timing-семантика записи, rollback, идемпотентность/конкурентность,
 * shared RTDS ref-count, graceful shutdown, fillSlots.
 *
 * @remarks
 * Все границы (discovery/source/recorder) — узкие структурные fakes с общим
 * журналом вызовов; end-to-end проверка «первое сообщение не потеряно» с
 * РЕАЛЬНЫМИ bus/recorder живёт в `first-message-not-lost.test.ts`.
 */
import { describe, it, expect } from '@jest/globals';
import { MarketCollectionCoordinator } from '../src/index.js';
import type { MarketCollectionCoordinatorConfig } from '../src/index.js';
import {
  BTC_FEEDS,
  CID_A,
  CID_B,
  CallLog,
  CapturingLogger,
  FakeCollectionRecorder,
  FakeCollectionSource,
  FakeDiscovery,
  FixedClock,
  NOW_MS,
  TOKEN_DOWN,
  TOKEN_UP,
  createCandidate,
  deferred,
  mid,
  waitFor,
} from './helpers/fakes.js';

/** Собирает полный harness координатора вокруг journaled fakes. */
function createHarness(configOverrides: Partial<MarketCollectionCoordinatorConfig> = {}): {
  log: CallLog;
  discovery: FakeDiscovery;
  source: FakeCollectionSource;
  recorder: FakeCollectionRecorder;
  clock: FixedClock;
  logger: CapturingLogger;
  coordinator: MarketCollectionCoordinator;
} {
  const log = new CallLog();
  const discovery = new FakeDiscovery(log);
  const source = new FakeCollectionSource(log);
  const recorder = new FakeCollectionRecorder(log);
  const clock = new FixedClock();
  const logger = new CapturingLogger();
  const coordinator = new MarketCollectionCoordinator(
    { discovery, source, recorder, clock, logger },
    { maxMarkets: 5, ...configOverrides },
  );
  return { log, discovery, source, recorder, clock, logger, coordinator };
}

describe('точный порядок открытия: recorder FIRST (PART 35)', () => {
  it('registerMarket выполняется ДО subscribeMarket, RTDS — после, сессия ACTIVE', async () => {
    const { log, discovery, recorder, coordinator } = createHarness();
    const candidate = discovery.addMarket();

    const outcome = await coordinator.openMarket(candidate);

    expect(outcome).toBe('opened');
    // Точная последовательность вызовов
    expect(log.entries).toEqual([
      `discovery.prepareSelected:${CID_A}`,
      `recorder.registerMarket:${CID_A}`,
      `source.subscribeMarket:${TOKEN_UP},${TOKEN_DOWN}`,
      'source.subscribeCryptoPrices:prices.crypto.chainlink:btc/usd',
      'source.subscribeCryptoPrices:prices.crypto.binance:btcusdt',
    ]);
    // Recorder строго раньше source
    expect(log.indexOf('recorder.registerMarket')).toBeLessThan(
      log.indexOf('source.subscribeMarket'),
    );

    // Регистрация несёт ВСЕ токены рынка и готовые RTDS-фиды (routing recorder-а)
    const registration = recorder.registrations[0]!;
    expect(registration.marketMeta.tokenIds).toEqual([TOKEN_UP, TOKEN_DOWN]);
    expect(registration.rtdsFeeds).toEqual(BTC_FEEDS);

    const stats = coordinator.getStats();
    expect(stats.activeSessions).toBe(1);
    expect(stats.openingSessions).toBe(0);
    expect(stats.rtdsFeeds).toEqual([
      { topic: 'prices.crypto.chainlink', symbol: 'btc/usd', refCount: 1 },
      { topic: 'prices.crypto.binance', symbol: 'btcusdt', refCount: 1 },
    ]);
  });

  it('timing-семантика PART 9: recording startsAt = момент открытия сессии, НЕ vendor event start', async () => {
    const { discovery, recorder, coordinator } = createHarness();
    // Событие начинается через 10 минут — recording обязан начаться СЕЙЧАС
    const candidate = discovery.addMarket({ eventStartsAtMs: NOW_MS + 10 * 60_000 });

    await coordinator.openMarket(candidate);

    const meta = recorder.registrations[0]!.marketMeta;
    expect(meta.startsAt?.toNumber()).toBe(NOW_MS);
    expect(meta.expiresAt.toNumber()).toBe(NOW_MS + 70 * 60_000);

    // Header различает обе временные точки
    const header = meta.rawMarket as Record<string, unknown>;
    const timing = header['timing'] as Record<string, unknown>;
    expect(timing['recordingStartsAt']).toBe(NOW_MS);
    expect(timing['eventStartsAt']).toBe(NOW_MS + 10 * 60_000);
    expect(timing['expiresAt']).toBe(NOW_MS + 70 * 60_000);
  });

  it('header (PART 8): identity, outcomes, event, crypto, RTDS и typed Gamma state', async () => {
    const { discovery, recorder, coordinator } = createHarness();
    await coordinator.openMarket(discovery.addMarket());

    const header = recorder.registrations[0]!.marketMeta.rawMarket as Record<string, unknown>;
    expect(header['headerVersion']).toBe(1);
    expect(header['source']).toBe('polymarket-v2');
    expect(header['conditionId']).toBe(CID_A);
    expect(header['gammaMarketId']).toBe('516789');
    expect(header['question']).toBe('Bitcoin Up or Down - fixture');
    expect(header['outcomes']).toEqual([
      { label: 'Up', instrumentId: TOKEN_UP },
      { label: 'Down', instrumentId: TOKEN_DOWN },
    ]);
    expect(header['event']).toEqual({ id: '99001', slug: 'fixture-event', title: 'Fixture Event' });
    expect(header['crypto']).toEqual({ source: 'chainlink', asset: 'btc', binanceSymbol: 'BTCUSDT' });
    expect(header['rtdsFeeds']).toEqual(BTC_FEEDS);
    expect(header['gammaMarket']).toMatchObject({ conditionId: CID_A });
  });
});

describe('eligibility и lead time (PART 22/23)', () => {
  it('истёкший кандидат пропускается синхронно, без prepareSelected', async () => {
    const { discovery, coordinator } = createHarness();
    const candidate = createCandidate({ expiresAtMs: NOW_MS - 1 });

    expect(await coordinator.openMarket(candidate)).toBe('skipped');
    expect(discovery.prepareCalls).toHaveLength(0);
  });

  it('точное eventStartsAt ближе minTimeToStart → skip НАВСЕГДА (без повторного fetchEvent)', async () => {
    const { discovery, recorder, coordinator } = createHarness({ minTimeToStartMs: 2 * 60_000 });
    const candidate = discovery.addMarket({ eventStartsAtMs: NOW_MS + 60_000 }); // старт через 1 мин

    expect(await coordinator.openMarket(candidate)).toBe('skipped');
    expect(recorder.registrations).toHaveLength(0);
    expect(discovery.prepareCalls).toHaveLength(1);

    // Повторная попытка: память lead-time — prepareSelected НЕ вызывается снова
    expect(await coordinator.openMarket(candidate)).toBe('skipped');
    expect(discovery.prepareCalls).toHaveLength(1);
  });

  it('fallback-оценка старта (нет eventStartsAt): estimatedStart = expiresAt - 15 мин (parity)', async () => {
    const { discovery, coordinator } = createHarness({
      minTimeToStartMs: 2 * 60_000,
      fallbackMarketDurationMs: 15 * 60_000,
    });
    // Истекает через 16 мин → оценка старта через 1 мин → слишком поздно
    const late = discovery.addMarket({
      conditionId: CID_A,
      eventStartsAtMs: null,
      expiresAtMs: NOW_MS + 16 * 60_000,
    });
    // Истекает через 30 мин → оценка старта через 15 мин → открывается
    const fine = discovery.addMarket({
      conditionId: CID_B,
      eventStartsAtMs: null,
      expiresAtMs: NOW_MS + 30 * 60_000,
    });

    expect(await coordinator.openMarket(late)).toBe('skipped');
    expect(await coordinator.openMarket(fine)).toBe('opened');
  });

  it('выбранный рынок, истёкший МЕЖДУ резервацией и prepareSelected, пропускается re-check-ом', async () => {
    const { discovery, clock, recorder, coordinator } = createHarness();
    const candidate = discovery.addMarket({ expiresAtMs: NOW_MS + 60_000 });
    // Часы сдвигаются ВНУТРИ prepareSelected: первый sync-guard рынок
    // пропускает, отбрасывает именно post-prepare eligibility re-check
    discovery.onPrepareSelected = () => {
      clock.advance(2 * 60_000);
    };

    expect(await coordinator.openMarket(candidate)).toBe('skipped');
    expect(discovery.prepareCalls).toHaveLength(1);
    expect(recorder.registrations).toHaveLength(0);
    expect(coordinator.getStats()).toMatchObject({ activeSessions: 0, openingSessions: 0 });
  });
});

describe('rollback открытия (PART 37)', () => {
  it('TEST A: отказ recorder-регистрации → ни одной подписки, ни одной сессии; retry успешен', async () => {
    const { discovery, source, recorder, coordinator } = createHarness();
    const candidate = discovery.addMarket();
    recorder.registerResult = false;

    expect(await coordinator.openMarket(candidate)).toBe('failed');
    expect(source.subscribeMarketCalls).toHaveLength(0);
    expect(source.subscribeCryptoCalls).toHaveLength(0);
    expect(coordinator.getStats()).toMatchObject({ activeSessions: 0, openingSessions: 0 });

    // TEST D: повторная попытка после восстановления — успех
    recorder.registerResult = true;
    expect(await coordinator.openMarket(candidate)).toBe('opened');
  });

  it('TEST B: отказ market-подписки → recording снят как SHUTDOWN, retry возможен', async () => {
    const { discovery, source, recorder, coordinator } = createHarness();
    const candidate = discovery.addMarket();
    source.subscribeMarketError = new Error('ws down');

    expect(await coordinator.openMarket(candidate)).toBe('failed');
    expect(recorder.finalizations).toEqual([`${CID_A}:SHUTDOWN`]);
    expect(source.subscribeCryptoCalls).toHaveLength(0);
    expect(coordinator.getStats()).toMatchObject({ activeSessions: 0, openingSessions: 0 });

    source.subscribeMarketError = undefined;
    expect(await coordinator.openMarket(candidate)).toBe('opened');
  });

  it('TEST C: отказ RTDS после market-подписки → подписка закрыта, refs освобождены, recording снят', async () => {
    const { log, discovery, source, recorder, coordinator } = createHarness();
    const candidate = discovery.addMarket();
    // Первый фид открывается, второй падает
    source.cryptoErrors.set('prices.crypto.binance:btcusdt', new Error('rtds down'));

    expect(await coordinator.openMarket(candidate)).toBe('failed');

    // Market-подписка закрыта
    expect(source.marketSubscriptions[0]!.closeCalls).toBe(1);
    // Успевший открыться chainlink-фид закрыт (refcount упал до 0)
    expect(
      source.rtdsSubscriptions.get('prices.crypto.chainlink:btc/usd')!.closeCalls,
    ).toBe(1);
    // Recording снят
    expect(recorder.finalizations).toEqual([`${CID_A}:SHUTDOWN`]);
    // Никаких повисших refs
    expect(coordinator.getStats().rtdsFeeds).toEqual([]);
    expect(log.indexOf('recorder.finalizeMarket')).toBeGreaterThan(log.indexOf('close:market'));

    // TEST D: retry успешен
    source.cryptoErrors.clear();
    expect(await coordinator.openMarket(candidate)).toBe('opened');
    expect(coordinator.getStats().activeSessions).toBe(1);
  });

  it('отказ prepareSelected освобождает резервацию (retry возможен)', async () => {
    const { discovery, coordinator } = createHarness();
    const candidate = discovery.addMarket();
    discovery.prepareError = new Error('gamma 500');

    expect(await coordinator.openMarket(candidate)).toBe('failed');
    expect(coordinator.getStats()).toMatchObject({ activeSessions: 0, openingSessions: 0 });

    discovery.prepareError = undefined;
    expect(await coordinator.openMarket(candidate)).toBe('opened');
  });
});

describe('идемпотентность и конкурентность (PART 14/38)', () => {
  it('два конкурентных открытия одного рынка → ровно одна регистрация/подписка/сессия', async () => {
    const { discovery, source, recorder, coordinator } = createHarness();
    const candidate = discovery.addMarket();
    const hold = deferred();
    source.subscribeMarketHold = hold.promise;

    const [first, second] = [coordinator.openMarket(candidate), coordinator.openMarket(candidate)];
    hold.resolve();
    const outcomes = await Promise.all([first, second]);

    expect(outcomes.sort()).toEqual(['opened', 'skipped']);
    expect(recorder.registrations).toHaveLength(1);
    expect(source.subscribeMarketCalls).toHaveLength(1);
    expect(coordinator.getStats().activeSessions).toBe(1);
  });

  it('maxMarkets учитывает OPENING: конкурентные открытия не превышают лимит', async () => {
    const { discovery, source, recorder, coordinator } = createHarness({ maxMarkets: 1 });
    const candidateA = discovery.addMarket({ conditionId: CID_A });
    const candidateB = discovery.addMarket({ conditionId: CID_B });
    const hold = deferred();
    source.subscribeMarketHold = hold.promise;

    const attempts = [coordinator.openMarket(candidateA), coordinator.openMarket(candidateB)];
    hold.resolve();
    const outcomes = await Promise.all(attempts);

    expect(outcomes.sort()).toEqual(['opened', 'skipped']);
    expect(recorder.registrations).toHaveLength(1);
    expect(coordinator.getStats().activeSessions).toBe(1);
  });
});

describe('shared RTDS-фиды (PART 18/39)', () => {
  it('два рынка на одних фидах → одна source-подписка на topic; закрытия по ref-count', async () => {
    const { discovery, source, coordinator } = createHarness();
    const candidateA = discovery.addMarket({ conditionId: CID_A });
    const candidateB = discovery.addMarket({ conditionId: CID_B });

    await coordinator.openMarket(candidateA);
    await coordinator.openMarket(candidateB);

    // Нижележащих подписок ровно две (Binance + Chainlink), не четыре
    expect(source.subscribeCryptoCalls).toEqual([
      'prices.crypto.chainlink:btc/usd',
      'prices.crypto.binance:btcusdt',
    ]);
    expect(coordinator.getStats().rtdsFeeds).toEqual([
      { topic: 'prices.crypto.chainlink', symbol: 'btc/usd', refCount: 2 },
      { topic: 'prices.crypto.binance', symbol: 'btcusdt', refCount: 2 },
    ]);

    // Обе регистрации несут оба фида — независимый fan-out recorder-а
    // проверяется в first-message-not-lost.test.ts с реальным recorder-ом

    // Закрытие A: нижележащие фиды живут (нужны B)
    await coordinator.closeSession(mid(CID_A), 'SHUTDOWN');
    expect(source.rtdsSubscriptions.get('prices.crypto.chainlink:btc/usd')!.closeCalls).toBe(0);
    expect(source.rtdsSubscriptions.get('prices.crypto.binance:btcusdt')!.closeCalls).toBe(0);
    expect(coordinator.getStats().rtdsFeeds).toEqual([
      { topic: 'prices.crypto.chainlink', symbol: 'btc/usd', refCount: 1 },
      { topic: 'prices.crypto.binance', symbol: 'btcusdt', refCount: 1 },
    ]);

    // Закрытие B: последний ref — нижележащие подписки закрываются
    await coordinator.closeSession(mid(CID_B), 'SHUTDOWN');
    expect(source.rtdsSubscriptions.get('prices.crypto.chainlink:btc/usd')!.closeCalls).toBe(1);
    expect(source.rtdsSubscriptions.get('prices.crypto.binance:btcusdt')!.closeCalls).toBe(1);
    expect(coordinator.getStats().rtdsFeeds).toEqual([]);
  });

  it('конкурентная инициализация одного НОВОГО фида не создаёт дублирующую подписку', async () => {
    const { discovery, source, coordinator } = createHarness();
    const candidateA = discovery.addMarket({ conditionId: CID_A });
    const candidateB = discovery.addMarket({ conditionId: CID_B });
    const hold = deferred();
    source.subscribeCryptoHold = hold.promise;

    const attempts = [coordinator.openMarket(candidateA), coordinator.openMarket(candidateB)];
    // Обе транзакции прошли market-подписку и заблокированы на RTDS-hold
    await waitFor(
      () => source.subscribeMarketCalls.length === 2 && source.subscribeCryptoCalls.length >= 1,
    );
    hold.resolve();
    const outcomes = await Promise.all(attempts);

    expect(outcomes).toEqual(['opened', 'opened']);
    // По одной подписке на фид, несмотря на конкурентное приобретение
    expect(source.subscribeCryptoCalls.filter((c) => c.includes('btc/usd'))).toHaveLength(1);
    expect(source.subscribeCryptoCalls.filter((c) => c.includes('btcusdt'))).toHaveLength(1);
    expect(coordinator.getStats().rtdsFeeds).toEqual([
      { topic: 'prices.crypto.chainlink', symbol: 'btc/usd', refCount: 2 },
      { topic: 'prices.crypto.binance', symbol: 'btcusdt', refCount: 2 },
    ]);
  });
});

describe('closeSession (PART 25)', () => {
  it('teardown в порядке: market subscription → RTDS → finalize; идемпотентен', async () => {
    const { log, discovery, source, recorder, coordinator } = createHarness();
    await coordinator.openMarket(discovery.addMarket());
    log.entries.length = 0;

    await coordinator.closeSession(mid(CID_A), 'SHUTDOWN');

    expect(source.marketSubscriptions[0]!.closeCalls).toBe(1);
    expect(recorder.finalizations).toEqual([`${CID_A}:SHUTDOWN`]);
    expect(log.indexOf('close:market')).toBeLessThan(log.indexOf('close:rtds'));
    expect(log.indexOf('close:rtds')).toBeLessThan(log.indexOf('recorder.finalizeMarket'));
    expect(coordinator.getStats()).toMatchObject({ activeSessions: 0, openingSessions: 0 });

    // Повторный вызов — no-op
    await coordinator.closeSession(mid(CID_A), 'SHUTDOWN');
    expect(recorder.finalizations).toHaveLength(1);
    expect(source.marketSubscriptions[0]!.closeCalls).toBe(1);
  });

  it('closeSession без сессии — безопасный no-op', async () => {
    const { coordinator, recorder } = createHarness();
    await coordinator.closeSession(mid(CID_A), 'SHUTDOWN');
    expect(recorder.finalizations).toHaveLength(0);
  });

  it('конкурентные closeSession → ровно один teardown', async () => {
    const { discovery, source, recorder, coordinator } = createHarness();
    await coordinator.openMarket(discovery.addMarket());

    await Promise.all([
      coordinator.closeSession(mid(CID_A), 'SHUTDOWN'),
      coordinator.closeSession(mid(CID_A), 'SHUTDOWN'),
    ]);

    expect(recorder.finalizations).toEqual([`${CID_A}:SHUTDOWN`]);
    expect(source.marketSubscriptions[0]!.closeCalls).toBe(1);
  });
});

describe('graceful shutdown (PART 26/40)', () => {
  it('закрывает все сессии: handles закрыты, RTDS освобождены ровно один раз, recordings SHUTDOWN, maps пусты', async () => {
    const { discovery, source, recorder, coordinator } = createHarness();
    await coordinator.openMarket(discovery.addMarket({ conditionId: CID_A }));
    await coordinator.openMarket(discovery.addMarket({ conditionId: CID_B }));
    expect(coordinator.getStats().activeSessions).toBe(2);

    await coordinator.close();

    // Все market-handles закрыты
    expect(source.marketSubscriptions.map((s) => s.closeCalls)).toEqual([1, 1]);
    // Shared RTDS-подписки закрыты РОВНО один раз
    expect(source.rtdsSubscriptions.get('prices.crypto.chainlink:btc/usd')!.closeCalls).toBe(1);
    expect(source.rtdsSubscriptions.get('prices.crypto.binance:btcusdt')!.closeCalls).toBe(1);
    // Обе записи сняты как SHUTDOWN (incomplete)
    expect(recorder.finalizations.sort()).toEqual([`${CID_A}:SHUTDOWN`, `${CID_B}:SHUTDOWN`]);
    // Runtime-состояние пусто
    expect(coordinator.getStats()).toEqual({
      activeSessions: 0,
      openingSessions: 0,
      finalizingSessions: 0,
      rtdsFeeds: [],
    });
    expect(coordinator.listSessions()).toEqual([]);
    expect(coordinator.isClosed).toBe(true);
  });

  it('close идемпотентен; новые открытия/fillSlots после close запрещены', async () => {
    const { discovery, recorder, coordinator } = createHarness();
    const candidate = discovery.addMarket();
    await coordinator.close();
    await coordinator.close(); // второй вызов ждёт тот же promise

    expect(await coordinator.openMarket(candidate)).toBe('skipped');
    expect(await coordinator.fillSlots()).toBe(0);
    await coordinator.refreshCandidates();
    expect(discovery.refreshCalls).toBe(0);
    expect(recorder.registrations).toHaveLength(0);
  });

  it('close во время OPENING: транзакция откатывается, ничего не остаётся открытым', async () => {
    const { discovery, source, recorder, coordinator } = createHarness();
    const candidate = discovery.addMarket();
    const hold = deferred();
    source.subscribeMarketHold = hold.promise;

    const openAttempt = coordinator.openMarket(candidate);
    // Транзакция реально дошла до subscribeMarket и заблокирована hold-ом
    await waitFor(() => source.subscribeMarketCalls.length === 1);
    const closePromise = coordinator.close();
    hold.resolve();

    const [outcome] = await Promise.all([openAttempt, closePromise]);

    expect(outcome).toBe('skipped');
    // Подписка, разрешившаяся после close, закрыта транзакцией
    expect(source.marketSubscriptions[0]!.closeCalls).toBe(1);
    // Recording откачен
    expect(recorder.finalizations).toEqual([`${CID_A}:SHUTDOWN`]);
    expect(coordinator.getStats()).toEqual({
      activeSessions: 0,
      openingSessions: 0,
      finalizingSessions: 0,
      rtdsFeeds: [],
    });
  });
});

describe('refreshCandidates / fillSlots (PART 20/21/29)', () => {
  it('refreshCandidates делегирует discovery.refresh', async () => {
    const { discovery, coordinator } = createHarness();
    await coordinator.refreshCandidates();
    expect(discovery.refreshCalls).toBe(1);
  });

  it('fillSlots открывает лучших кандидатов до maxMarkets (ACTIVE + OPENING)', async () => {
    const { discovery, coordinator } = createHarness({ maxMarkets: 2 });
    discovery.addMarket({ conditionId: CID_A });
    discovery.addMarket({ conditionId: CID_B });
    discovery.addMarket({ conditionId: `0x${'c'.repeat(64)}` });

    const opened = await coordinator.fillSlots();

    expect(opened).toBe(2);
    const stats = coordinator.getStats();
    expect(stats.activeSessions).toBe(2);
    // Открыты первые два кандидата (порядок кэша = приоритет скорера)
    expect(coordinator.listSessions().map((s) => s.marketId).sort()).toEqual(
      [CID_A, CID_B].sort(),
    );
  });

  it('отказ одного кандидата не прерывает заполнение остальных (PART 29)', async () => {
    const { discovery, source, coordinator } = createHarness({ maxMarkets: 2 });
    discovery.addMarket({ conditionId: CID_A });
    discovery.addMarket({ conditionId: CID_B });
    // Первый рынок падает на market-подписке один раз
    let calls = 0;
    source.onSubscribeMarket = () => {
      calls++;
      if (calls === 1) {
        throw new Error('transient ws failure');
      }
    };

    const opened = await coordinator.fillSlots();

    expect(opened).toBe(1);
    expect(coordinator.listSessions().map((s) => s.marketId)).toEqual([CID_B]);

    // Следующий проход добирает упавший рынок (retry)
    source.onSubscribeMarket = undefined;
    expect(await coordinator.fillSlots()).toBe(1);
    expect(coordinator.getStats().activeSessions).toBe(2);
  });

  it('fillSlots не открывает уже открытые рынки повторно', async () => {
    const { discovery, recorder, coordinator } = createHarness();
    discovery.addMarket({ conditionId: CID_A });

    expect(await coordinator.fillSlots()).toBe(1);
    expect(await coordinator.fillSlots()).toBe(0);
    expect(recorder.registrations).toHaveLength(1);
  });

  it('терминальный отказ source: fillSlots сносит сессии, capacity/routing освобождены', async () => {
    const { discovery, source, recorder, coordinator, logger } = createHarness({ maxMarkets: 2 });
    await coordinator.openMarket(discovery.addMarket({ conditionId: CID_A }));
    await coordinator.openMarket(discovery.addMarket({ conditionId: CID_B }));
    expect(coordinator.getStats().activeSessions).toBe(2);

    // Source отказал терминально (его handles уже закрыты им самим)
    source.hasFailed = true;

    expect(await coordinator.fillSlots()).toBe(0);

    // Все сессии снесены: recording снят SHUTDOWN-ом, состояние пусто
    expect(recorder.finalizations.sort()).toEqual([`${CID_A}:SHUTDOWN`, `${CID_B}:SHUTDOWN`]);
    expect(coordinator.getStats()).toEqual({
      activeSessions: 0,
      openingSessions: 0,
      finalizingSessions: 0,
      rtdsFeeds: [],
    });
    expect(logger.byLevel('error').some((e) => e.message.includes('terminal failure'))).toBe(true);

    // Новые открытия на отказавшем source невозможны
    const another = createCandidate({ conditionId: `0x${'c'.repeat(64)}` });
    expect(await coordinator.openMarket(another)).toBe('skipped');
    expect(recorder.registrations).toHaveLength(2); // новых регистраций нет

    // Reconciliation идемпотентен
    expect(await coordinator.fillSlots()).toBe(0);
    expect(recorder.finalizations).toHaveLength(2);
  });

  it('память lead-time чистится, когда рынок покидает candidate cache', async () => {
    const { discovery, coordinator } = createHarness({ minTimeToStartMs: 2 * 60_000 });
    const rejected = discovery.addMarket({ eventStartsAtMs: NOW_MS + 60_000 });

    expect(await coordinator.openMarket(rejected)).toBe('skipped');
    expect(discovery.prepareCalls).toHaveLength(1);

    // Рынок исчез из кэша (истёк/ушёл из окна) → память освобождается
    discovery.candidates = [];
    await coordinator.fillSlots();

    // Вернулся в кэш (теоретический случай) → проверка выполняется заново
    discovery.candidates = [rejected];
    expect(await coordinator.openMarket(rejected)).toBe('skipped');
    expect(discovery.prepareCalls).toHaveLength(2);
  });
});

describe('identity-guard closeSession и устойчивость teardown', () => {
  it('closeSession не сносит НОВУЮ сессию, установленную retry-ем после отката исходной', async () => {
    const { discovery, source, recorder, coordinator } = createHarness();
    const candidate = discovery.addMarket();
    const hold = deferred();
    source.subscribeMarketHold = hold.promise;
    source.subscribeMarketError = new Error('transient ws failure');

    // Транзакция 1 повисла на subscribeMarket (OPENING)
    const firstAttempt = coordinator.openMarket(candidate);
    await waitFor(() => source.subscribeMarketCalls.length === 1);
    // closeSession адресует ИСХОДНУЮ (OPENING) сессию и ждёт её settled
    const closing = coordinator.closeSession(mid(CID_A), 'SHUTDOWN');
    hold.resolve();
    expect(await firstAttempt).toBe('failed'); // транзакция 1 откатилась

    // Retry устанавливает НОВУЮ сессию под тем же ключом
    source.subscribeMarketHold = undefined;
    source.subscribeMarketError = undefined;
    expect(await coordinator.openMarket(candidate)).toBe('opened');

    await closing; // обязан быть no-op для чужой сессии (identity-guard)

    expect(coordinator.getStats().activeSessions).toBe(1);
    // Единственная финализация — rollback транзакции 1, а не teardown retry-сессии
    expect(recorder.finalizations).toEqual([`${CID_A}:SHUTDOWN`]);
    expect(source.marketSubscriptions.filter((s) => s.closeCalls > 0)).toHaveLength(0);
  });

  it('отказ finalizeMarket при закрытии сессии логируется warn-ом, состояние очищается', async () => {
    const { discovery, source, recorder, coordinator, logger } = createHarness();
    await coordinator.openMarket(discovery.addMarket());
    recorder.finalizeError = new Error('storage io failure');

    await coordinator.closeSession(mid(CID_A), 'SHUTDOWN');

    expect(
      logger.byLevel('warn').some((e) => e.message.includes('Recorder finalization failed')),
    ).toBe(true);
    expect(coordinator.getStats()).toMatchObject({ activeSessions: 0, openingSessions: 0 });
    expect(source.marketSubscriptions[0]!.closeCalls).toBe(1);
  });
});

describe('бюджет header meta-блока (PART 8)', () => {
  it('невместимый даже в усечённом виде header → явный отказ ДО регистрации и подписок', async () => {
    const { discovery, source, recorder, coordinator, logger } = createHarness();
    // Question дублируется внешней meta-строкой storage — ядро не помещается
    const candidate = discovery.addMarket({ question: `Bitcoin ${'q'.repeat(17_000)}` });

    expect(await coordinator.openMarket(candidate)).toBe('failed');

    expect(recorder.registrations).toHaveLength(0);
    expect(source.subscribeMarketCalls).toHaveLength(0);
    expect(source.subscribeCryptoCalls).toHaveLength(0);
    expect(coordinator.getStats()).toMatchObject({ activeSessions: 0, openingSessions: 0 });
    expect(logger.byLevel('error').some((e) => e.message.includes('meta budget'))).toBe(true);
  });

  it('крупный gammaEvent усечён, рынок открывается с header-ом без него', async () => {
    const { discovery, recorder, coordinator } = createHarness();
    const candidate = discovery.addMarket({ gammaEventPadding: 16 * 1024 });

    expect(await coordinator.openMarket(candidate)).toBe('opened');

    const header = recorder.registrations[0]!.marketMeta.rawMarket as Record<string, unknown>;
    expect(header['truncated']).toEqual(['gammaEvent']);
    expect(header['gammaMarket']).toBeDefined();
    expect(header['gammaEvent']).toBeUndefined();
  });
});

describe('FINALIZING lifecycle (N-004 PART 2/3/8/36/49/52)', () => {
  it('beginFinalization: seal ПЕРВЫМ, затем закрытие подписки и release RTDS; снимок immutable', async () => {
    const { log, discovery, source, recorder, coordinator } = createHarness();
    await coordinator.openMarket(discovery.addMarket());
    log.entries.length = 0;

    const snapshot = await coordinator.beginFinalization(mid(CID_A));

    expect(snapshot).toBeDefined();
    expect(String(snapshot!.marketId)).toBe(CID_A);
    expect(snapshot!.recordingStartedAt.toNumber()).toBe(NOW_MS);
    expect(snapshot!.selected.question).toBe('Bitcoin Up or Down - fixture');
    expect(snapshot!.selected.outcomes).toHaveLength(2);

    // Порядок cutoff (PART 9): seal → close market subscription → release RTDS
    expect(log.indexOf('recorder.sealMarket')).toBeLessThan(log.indexOf('close:market'));
    expect(log.indexOf('close:market')).toBeLessThan(log.indexOf('close:rtds'));
    expect(recorder.seals).toEqual([CID_A]);
    // Архив на этом шаге НЕ выполняется
    expect(recorder.finalizations).toEqual([]);

    // Подписка закрыта, RTDS-refs освобождены, сессия удержана как FINALIZING
    expect(source.marketSubscriptions[0]!.closeCalls).toBe(1);
    expect(coordinator.getStats()).toEqual({
      activeSessions: 0,
      openingSessions: 0,
      finalizingSessions: 1,
      rtdsFeeds: [],
    });
    expect(coordinator.listSessions()).toEqual([
      expect.objectContaining({ marketId: mid(CID_A), state: 'FINALIZING' }),
    ]);
  });

  it('beginFinalization не-ACTIVE сессии → undefined; повторный вызов → undefined (at most once)', async () => {
    const { discovery, recorder, coordinator } = createHarness();
    expect(await coordinator.beginFinalization(mid(CID_A))).toBeUndefined();

    await coordinator.openMarket(discovery.addMarket());
    expect(await coordinator.beginFinalization(mid(CID_A))).toBeDefined();
    expect(await coordinator.beginFinalization(mid(CID_A))).toBeUndefined();
    expect(recorder.seals).toEqual([CID_A]); // seal ровно один раз
  });

  it('FINALIZING не занимает capacity, но блокирует повторное открытие (PART 3)', async () => {
    const { discovery, coordinator } = createHarness({ maxMarkets: 1 });
    const candidateA = discovery.addMarket({ conditionId: CID_A });
    const candidateB = discovery.addMarket({ conditionId: CID_B });

    expect(await coordinator.openMarket(candidateA)).toBe('opened');
    // Слот занят — B не открывается
    expect(await coordinator.openMarket(candidateB)).toBe('skipped');

    await coordinator.beginFinalization(mid(CID_A));

    // Слот освобождён expiry-переходом — B открывается при maxMarkets=1
    expect(await coordinator.openMarket(candidateB)).toBe('opened');
    // Повторное открытие A заблокировано удержанной FINALIZING-сессией
    expect(await coordinator.openMarket(candidateA)).toBe('skipped');
    expect(coordinator.getStats()).toMatchObject({ activeSessions: 1, finalizingSessions: 1 });
  });

  it('closeSession(SHUTDOWN) не трогает FINALIZING-сессию (архивом владеет finalizer)', async () => {
    const { discovery, recorder, coordinator } = createHarness();
    await coordinator.openMarket(discovery.addMarket());
    await coordinator.beginFinalization(mid(CID_A));

    await coordinator.closeSession(mid(CID_A), 'SHUTDOWN');

    expect(recorder.finalizations).toEqual([]);
    expect(coordinator.getStats().finalizingSessions).toBe(1);
  });

  it('completeFinalization удаляет ТОЛЬКО FINALIZING-сессию (identity-guard)', async () => {
    const { discovery, coordinator } = createHarness();
    const candidate = discovery.addMarket();
    expect(coordinator.completeFinalization(mid(CID_A))).toBe(false); // нет сессии

    await coordinator.openMarket(candidate);
    expect(coordinator.completeFinalization(mid(CID_A))).toBe(false); // ACTIVE не удаляется
    expect(coordinator.getStats().activeSessions).toBe(1);

    await coordinator.beginFinalization(mid(CID_A));
    expect(coordinator.completeFinalization(mid(CID_A))).toBe(true);
    expect(coordinator.listSessions()).toEqual([]);
    expect(coordinator.completeFinalization(mid(CID_A))).toBe(false); // идемпотентно
  });

  it('shared RTDS: expiry рынка A освобождает только его ref — фид рынка B живёт (PART 52)', async () => {
    const { discovery, source, coordinator } = createHarness();
    await coordinator.openMarket(discovery.addMarket({ conditionId: CID_A }));
    await coordinator.openMarket(discovery.addMarket({ conditionId: CID_B }));

    await coordinator.beginFinalization(mid(CID_A));

    // Нижележащие подписки НЕ закрыты (B держит refs)
    expect(source.rtdsSubscriptions.get('prices.crypto.chainlink:btc/usd')!.closeCalls).toBe(0);
    expect(source.rtdsSubscriptions.get('prices.crypto.binance:btcusdt')!.closeCalls).toBe(0);
    expect(coordinator.getStats().rtdsFeeds).toEqual([
      { topic: 'prices.crypto.chainlink', symbol: 'btc/usd', refCount: 1 },
      { topic: 'prices.crypto.binance', symbol: 'btcusdt', refCount: 1 },
    ]);
  });

  it('coordinator.close(): ACTIVE → SHUTDOWN, оставшаяся FINALIZING дропается с warn без архива', async () => {
    const { discovery, recorder, coordinator, logger } = createHarness();
    await coordinator.openMarket(discovery.addMarket({ conditionId: CID_A }));
    await coordinator.openMarket(discovery.addMarket({ conditionId: CID_B }));
    await coordinator.beginFinalization(mid(CID_B));

    await coordinator.close();

    // A закрыт как SHUTDOWN; B (FINALIZING) НЕ архивирован координатором
    expect(recorder.finalizations).toEqual([`${CID_A}:SHUTDOWN`]);
    expect(coordinator.listSessions()).toEqual([]);
    expect(
      logger.byLevel('warn').some((e) => e.message.includes('Finalizing session dropped')),
    ).toBe(true);
  });
});
