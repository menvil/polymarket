/**
 * Наблюдаемость collection lifecycle (MR-A PART 18/19/44).
 *
 * @remarks
 * Проверяется наблюдаемое поведение проекции — какие переходы видит внешний
 * наблюдатель, а не как именно они вычисляются.
 */
import { describe, expect, it } from '@jest/globals';
import { asMarketId } from '@polymarket/ids';
import { DataCollector } from '../src/runtime/DataCollector.js';
import type { CollectionRuntimeConfig } from '../src/runtime/DataCollectorConfig.js';
import type { CollectionLifecycleEvent } from '../src/runtime/collectionLifecycle.js';
import { candidate, makeFakeContour, timestampOf } from './helpers/fakes.js';

const COLLECTION: CollectionRuntimeConfig = {
  maxMarkets: 3,
  discoveryRefreshMs: 30_000,
  runtimeTickMs: 5_000,
};

const MARKET_A = asMarketId('0xaaa1')!;
const MARKET_B = asMarketId('0xbbb2')!;

/** Рантайм + собранные события наблюдателя. */
function makeObservedCollector(contour = makeFakeContour([])): {
  collector: DataCollector;
  contour: ReturnType<typeof makeFakeContour>;
  events: CollectionLifecycleEvent[];
} {
  const collector = new DataCollector({
    components: contour.components,
    collection: COLLECTION,
    clock: contour.clock,
    logger: contour.logger,
  });
  const events: CollectionLifecycleEvent[] = [];
  collector.onMarketLifecycle((event) => events.push(event));
  return { collector, contour, events };
}

/** Виды событий по рынку. */
function kindsFor(events: readonly CollectionLifecycleEvent[], marketId: string): string[] {
  return events.filter((event) => String(event.marketId) === marketId).map((event) => event.kind);
}

describe('lifecycle — обнаружение кандидатов', () => {
  it('объявляет DISCOVERED впервые увиденные рынки', async () => {
    const { collector, contour, events } = makeObservedCollector();
    contour.discovery.candidates = [candidate('0xaaa1'), candidate('0xbbb2')];

    await collector.tick();

    expect(kindsFor(events, '0xaaa1')).toEqual(['DISCOVERED']);
    expect(kindsFor(events, '0xbbb2')).toEqual(['DISCOVERED']);
    expect(events[0]?.question).toBe('Question 0xaaa1');
  });

  it('не повторяет DISCOVERED для того же рынка', async () => {
    const { collector, contour, events } = makeObservedCollector();
    contour.discovery.candidates = [candidate('0xaaa1')];

    await collector.tick();
    contour.clock.advance(COLLECTION.discoveryRefreshMs);
    await collector.tick();

    expect(kindsFor(events, '0xaaa1')).toEqual(['DISCOVERED']);
  });
});

describe('lifecycle — сессии сбора', () => {
  it('объявляет COLLECTION_STARTED, когда сессия стала ACTIVE', async () => {
    const { collector, contour, events } = makeObservedCollector();
    contour.coordinator.sessions = [
      { marketId: MARKET_A, state: 'ACTIVE', question: 'BTC up?', expiresAt: timestampOf(5_000) },
    ];

    await collector.tick();

    const started = events.find((event) => event.kind === 'COLLECTION_STARTED');
    expect(started?.question).toBe('BTC up?');
    expect(started?.expiresAtMs).toBe(5_000);
  });

  it('не объявляет отдельного события для промежуточного OPENING', async () => {
    const { collector, contour, events } = makeObservedCollector();
    contour.coordinator.sessions = [{ marketId: MARKET_A, state: 'OPENING' }];

    await collector.tick();
    expect(events).toHaveLength(0);

    contour.coordinator.sessions = [{ marketId: MARKET_A, state: 'ACTIVE' }];
    await collector.tick();

    expect(kindsFor(events, '0xaaa1')).toEqual(['COLLECTION_STARTED']);
  });

  it('объявляет FINALIZING на переходе ACTIVE → FINALIZING', async () => {
    const { collector, contour, events } = makeObservedCollector();
    contour.coordinator.sessions = [{ marketId: MARKET_A, state: 'ACTIVE' }];
    await collector.tick();

    contour.coordinator.sessions = [{ marketId: MARKET_A, state: 'FINALIZING' }];
    await collector.tick();

    expect(kindsFor(events, '0xaaa1')).toEqual(['COLLECTION_STARTED', 'FINALIZING']);
  });

  it('объявляет FINALIZED с исходом archived, когда финализация завершилась', async () => {
    const { collector, contour, events } = makeObservedCollector();
    contour.coordinator.sessions = [{ marketId: MARKET_A, state: 'FINALIZING' }];
    await collector.tick();

    contour.coordinator.sessions = [];
    contour.finalizer.archivedTotal = 1;
    await collector.tick();

    const finalized = events.find((event) => event.kind === 'FINALIZED');
    expect(finalized?.outcome).toBe('archived');
    expect(String(finalized?.marketId)).toBe('0xaaa1');
  });

  it('объявляет FINALIZED с исходом failed, когда архив не удался', async () => {
    const { collector, contour, events } = makeObservedCollector();
    contour.coordinator.sessions = [{ marketId: MARKET_A, state: 'FINALIZING' }];
    await collector.tick();

    contour.coordinator.sessions = [];
    contour.finalizer.archiveFailures = 1;
    await collector.tick();

    expect(events.find((event) => event.kind === 'FINALIZED')?.outcome).toBe('failed');
  });

  it('не выдумывает исход, когда финализацию покинули сразу несколько рынков', async () => {
    const { collector, contour, events } = makeObservedCollector();
    contour.coordinator.sessions = [
      { marketId: MARKET_A, state: 'FINALIZING' },
      { marketId: MARKET_B, state: 'FINALIZING' },
    ];
    await collector.tick();

    contour.coordinator.sessions = [];
    contour.finalizer.archivedTotal = 2;
    await collector.tick();

    const finalized = events.filter((event) => event.kind === 'FINALIZED');
    expect(finalized).toHaveLength(2);
    expect(finalized.every((event) => event.outcome === undefined)).toBe(true);
  });

  it('объявляет DROPPED, когда активная сессия исчезла без финализации', async () => {
    const { collector, contour, events } = makeObservedCollector();
    contour.coordinator.sessions = [{ marketId: MARKET_A, state: 'ACTIVE' }];
    await collector.tick();

    contour.coordinator.sessions = [];
    await collector.tick();

    const dropped = events.find((event) => event.kind === 'DROPPED');
    expect(dropped?.reason).toBe('source-failure');
  });

  it('сессии, снятые остановкой, наблюдаемы как DROPPED c причиной shutdown', async () => {
    const { collector, contour, events } = makeObservedCollector();
    await collector.start();
    contour.coordinator.sessions = [{ marketId: MARKET_A, state: 'ACTIVE' }];
    await collector.tick();

    await collector.close();

    expect(events.find((event) => event.kind === 'DROPPED')?.reason).toBe('shutdown');
  });
});

describe('lifecycle — контракт наблюдателя', () => {
  it('отписка прекращает доставку событий', async () => {
    const { collector, contour, events } = makeObservedCollector();
    const seen: string[] = [];
    const off = collector.onMarketLifecycle((event) => seen.push(event.kind));
    contour.coordinator.sessions = [{ marketId: MARKET_A, state: 'ACTIVE' }];
    await collector.tick();

    off();
    contour.coordinator.sessions = [{ marketId: MARKET_A, state: 'FINALIZING' }];
    await collector.tick();

    expect(seen).toEqual(['COLLECTION_STARTED']);
    expect(events.map((event) => event.kind)).toEqual(['COLLECTION_STARTED', 'FINALIZING']);
  });

  it('исключение наблюдателя не срывает тик и не теряет остальных', async () => {
    const { collector, contour, events } = makeObservedCollector();
    collector.onMarketLifecycle(() => {
      throw new Error('observer exploded');
    });
    contour.coordinator.sessions = [{ marketId: MARKET_A, state: 'ACTIVE' }];

    await expect(collector.tick()).resolves.toBeUndefined();

    expect(events.map((event) => event.kind)).toEqual(['COLLECTION_STARTED']);
    expect(contour.logger.byLevel('warn').some((line) => line.message.includes('listener'))).toBe(
      true,
    );
  });

  it('накопительные счётчики отражают наблюдённые переходы', async () => {
    const { collector, contour } = makeObservedCollector();
    contour.discovery.candidates = [candidate('0xaaa1')];
    contour.coordinator.sessions = [{ marketId: MARKET_A, state: 'ACTIVE' }];
    await collector.tick();

    contour.coordinator.sessions = [{ marketId: MARKET_A, state: 'FINALIZING' }];
    await collector.tick();
    contour.coordinator.sessions = [];
    contour.finalizer.archivedTotal = 1;
    await collector.tick();

    expect(collector.status().lifecycle).toEqual({
      discovered: 1,
      collectionStarted: 1,
      finalizing: 1,
      finalized: 1,
      archived: 1,
      dropped: 0,
    });
  });

  it('отказ чтения кэша кандидатов не срывает тик', async () => {
    const { collector, contour } = makeObservedCollector();
    contour.discovery.findRejection = new Error('gamma unavailable');

    await expect(collector.tick()).resolves.toBeUndefined();

    expect(contour.coordinator.fillCalls).toBe(1);
  });
});
