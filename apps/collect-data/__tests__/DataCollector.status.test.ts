/**
 * Операционный статус рантайма (MR-A PART 20/45).
 *
 * @remarks
 * Статус обязан быть read-only проекцией уже существующих `getStats()`
 * компонентов: собственных метрик рантайм не заводит.
 */
import { describe, expect, it } from '@jest/globals';
import { asMarketId } from '@polymarket/ids';
import { DataCollector } from '../src/runtime/DataCollector.js';
import type { CollectionRuntimeConfig } from '../src/runtime/DataCollectorConfig.js';
import { makeFakeContour, timestampOf } from './helpers/fakes.js';

const COLLECTION: CollectionRuntimeConfig = {
  maxMarkets: 3,
  discoveryRefreshMs: 30_000,
  runtimeTickMs: 5_000,
};

const MARKET_A = asMarketId('0xaaa1')!;

/** Рантайм поверх fake-контура. */
function makeCollector(contour = makeFakeContour(['binance', 'okx'])): {
  collector: DataCollector;
  contour: ReturnType<typeof makeFakeContour>;
} {
  const collector = new DataCollector({
    components: contour.components,
    collection: COLLECTION,
    clock: contour.clock,
    logger: contour.logger,
  });
  return { collector, contour };
}

describe('DataCollector.status()', () => {
  it('до старта: idle без времени работы', () => {
    const { collector } = makeCollector();

    const status = collector.status();

    expect(status.state).toBe('idle');
    expect(status.startedAtMs).toBeNull();
    expect(status.uptimeMs).toBeNull();
    expect(status.collection.activeSessions).toBe(0);
    expect(status.lifecycle.collectionStarted).toBe(0);
  });

  it('после старта: running, время работы растёт по часам', async () => {
    const { collector, contour } = makeCollector();

    await collector.start();
    contour.clock.advance(120_000);
    const status = collector.status();

    expect(status.state).toBe('running');
    expect(status.startedAtMs).not.toBeNull();
    expect(status.uptimeMs).toBe(120_000);

    await collector.close();
  });

  it('отражает начатый сбор рынка', async () => {
    const { collector, contour } = makeCollector();
    await collector.start();
    contour.coordinator.sessions = [
      { marketId: MARKET_A, state: 'ACTIVE', expiresAt: timestampOf(9_000) },
    ];

    await collector.tick();
    const status = collector.status();

    expect(status.collection.activeSessions).toBe(1);
    expect(status.lifecycle.collectionStarted).toBe(1);

    await collector.close();
  });

  it('отражает финализацию через счётчики финализатора', async () => {
    const { collector, contour } = makeCollector();
    await collector.start();
    contour.finalizer.pendingFinalizations = 2;
    contour.finalizer.archivedTotal = 5;
    contour.finalizer.archiveFailures = 1;

    const status = collector.status();

    expect(status.finalization).toEqual({
      pendingFinalizations: 2,
      archivedTotal: 5,
      archiveFailures: 1,
    });

    await collector.close();
  });

  it('переиспользует статистику recorder, окон и bus без дублирования метрик', async () => {
    const { collector } = makeCollector();
    await collector.start();

    const status = collector.status();

    expect(status.recorder.recordsWritten).toBe(7);
    expect(status.recorderCex.cexRecordsAccepted).toBe(3);
    expect(status.cexWindows.partitionsCompleted).toBe(4);
    expect(status.bus.subscribedTypes).toBe(2);

    await collector.close();
  });

  it('сообщает здоровье источников поимённо', async () => {
    const { collector, contour } = makeCollector();
    await collector.start();
    contour.cexSources[1]!.hasFailed = true;

    const status = collector.status();

    expect(status.sources.cex.map((source) => source.exchangeId)).toEqual(['binance', 'okx']);
    expect(status.sources.cex[0]?.isRunning).toBe(true);
    expect(status.sources.cex[1]?.hasFailed).toBe(true);
    expect(status.sources.polymarket.isClosed).toBe(false);

    await collector.close();
  });

  it('после остановки: stopped, источники закрыты', async () => {
    const { collector } = makeCollector();
    await collector.start();

    await collector.close();
    const status = collector.status();

    expect(status.state).toBe('stopped');
    expect(status.sources.polymarket.isClosed).toBe(true);
    expect(status.sources.cex.every((source) => !source.isRunning)).toBe(true);
  });
});

describe('DataCollector.drain()', () => {
  it('дренирует незавершённые финализации по явному запросу', async () => {
    const { collector, contour } = makeCollector();
    await collector.start();

    await collector.drain();

    expect(contour.finalizer.drainCalls).toBe(1);
    await collector.close();
  });

  it('НЕ вызывается штатной остановкой (сигнал не ждёт официальной резолюции)', async () => {
    const { collector, contour } = makeCollector();
    await collector.start();

    await collector.close();

    expect(contour.finalizer.drainCalls).toBe(0);
  });

  it('на неработающем рантайме — no-op', async () => {
    const { collector, contour } = makeCollector();

    await collector.drain();

    expect(contour.finalizer.drainCalls).toBe(0);
  });
});
