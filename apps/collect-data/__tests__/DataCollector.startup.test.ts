/**
 * Порядок и детерминизм запуска рантайма (MR-A PART 32/33/46).
 *
 * @remarks
 * Проверяется наблюдаемое поведение, а не внутренности: recorder подписан
 * ДО ingress, повторный старт явно отклоняется, а частичный отказ не
 * оставляет за собой поднятых ресурсов.
 */
import { describe, expect, it } from '@jest/globals';
import { DataCollector } from '../src/runtime/DataCollector.js';
import type { CollectionRuntimeConfig } from '../src/runtime/DataCollectorConfig.js';
import { makeFakeContour } from './helpers/fakes.js';

const COLLECTION: CollectionRuntimeConfig = {
  maxMarkets: 3,
  discoveryRefreshMs: 30_000,
  runtimeTickMs: 5_000,
};

/** Рантайм поверх fake-контура. */
function makeCollector(contour = makeFakeContour()): {
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

describe('DataCollector.start() — порядок запуска', () => {
  it('поднимает recorder ДО любого ingress', async () => {
    const { collector, contour } = makeCollector();

    await collector.start();

    const recorderStart = contour.log.indexOf('recorder.start');
    expect(recorderStart).toBeGreaterThanOrEqual(0);
    for (const source of contour.cexSources) {
      expect(recorderStart).toBeLessThan(contour.log.indexOf(`cexSource.start(${source.exchangeId})`));
    }

    await collector.close();
  });

  it('чистит незавершённые артефакты обеих политик ДО подписки recorder', async () => {
    const { collector, contour } = makeCollector();

    await collector.start();

    expect(contour.log.indexOf('polymarketStorage.cleanup')).toBeLessThan(
      contour.log.indexOf('recorder.start'),
    );
    expect(contour.log.indexOf('cexStorage.cleanup')).toBeLessThan(
      contour.log.indexOf('recorder.start'),
    );

    await collector.close();
  });

  it('переводит рантайм в running и запускает все CEX-source-ы', async () => {
    const { collector, contour } = makeCollector();

    expect(collector.state).toBe('idle');
    await collector.start();

    expect(collector.state).toBe('running');
    expect(contour.cexSources.every((source) => source.isRunning)).toBe(true);
    expect(collector.status().startedAtMs).not.toBeNull();

    await collector.close();
  });
});

describe('DataCollector.start() — повторный вызов', () => {
  it('отклоняет второй старт и не перезапускает компоненты', async () => {
    const { collector, contour } = makeCollector();
    await collector.start();
    const callsAfterFirst = contour.log.calls.length;

    await expect(collector.start()).rejects.toThrow('already running');

    expect(contour.log.calls.length).toBe(callsAfterFirst);
    expect(contour.log.countOf('recorder.start')).toBe(1);

    await collector.close();
  });

  it('отклоняет старт после остановки', async () => {
    const { collector } = makeCollector();
    await collector.start();
    await collector.close();

    await expect(collector.start()).rejects.toThrow('already stopped');
  });
});

describe('DataCollector.start() — откат частичного запуска', () => {
  it('закрывает уже поднятые ресурсы, если падает второй CEX-source', async () => {
    const contour = makeFakeContour(['binance', 'okx', 'kraken']);
    contour.cexSources[1]!.startError = new Error('okx transport unavailable');
    const { collector } = makeCollector(contour);

    await expect(collector.start()).rejects.toThrow('okx transport unavailable');

    // Успевший подняться source закрыт, упавший и последующие — не запускались.
    expect(contour.log.countOf('cexSource.close(binance)')).toBe(1);
    expect(contour.log.countOf('cexSource.start(kraken)')).toBe(0);
    expect(contour.log.countOf('cexSource.close(okx)')).toBe(0);
    // Recorder и bus закрыты — контур не остался наполовину живым.
    expect(contour.log.countOf('recorder.close')).toBe(1);
    expect(contour.log.countOf('bus.close')).toBe(1);
    expect(collector.state).toBe('stopped');
  });

  it('откатывает в порядке, обратном подъёму (LIFO)', async () => {
    const contour = makeFakeContour(['binance', 'okx']);
    contour.cexSources[1]!.startError = new Error('okx down');
    const { collector } = makeCollector(contour);

    await expect(collector.start()).rejects.toThrow('okx down');

    expect(contour.log.indexOf('cexSource.close(binance)')).toBeLessThan(
      contour.log.indexOf('recorder.close'),
    );
    expect(contour.log.indexOf('recorder.close')).toBeLessThan(contour.log.indexOf('bus.close'));
  });

  it('отказ startup cleanup не оставляет подписанного recorder', async () => {
    const contour = makeFakeContour();
    contour.polymarketStorage.cleanupRejection = new Error('cleanup failed');
    const { collector } = makeCollector(contour);

    await expect(collector.start()).rejects.toThrow('cleanup failed');

    expect(contour.log.countOf('recorder.start')).toBe(0);
    expect(contour.log.countOf('cexSource.start(binance)')).toBe(0);
    expect(collector.state).toBe('stopped');
  });

  it('отказ recorder.start() закрывает bus и не запускает ingress', async () => {
    const contour = makeFakeContour();
    contour.recorder.startError = new Error('recorder subscribe failed');
    const { collector } = makeCollector(contour);

    await expect(collector.start()).rejects.toThrow('recorder subscribe failed');

    expect(contour.log.countOf('cexSource.start(binance)')).toBe(0);
    expect(contour.log.countOf('bus.close')).toBe(1);
  });

  it('работает без единого CEX-source (CEX выключен конфигурацией)', async () => {
    const contour = makeFakeContour([]);
    const { collector } = makeCollector(contour);

    await collector.start();

    expect(collector.state).toBe('running');
    expect(collector.status().sources.cex).toHaveLength(0);

    await collector.close();
  });
});
