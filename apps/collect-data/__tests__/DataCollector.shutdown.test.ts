/**
 * Лестница остановки рантайма (MR-A PART 35/47).
 *
 * @remarks
 * Порядок закрытия — доказанный контур CHECKPOINT #1: ingress глохнет
 * раньше, чем дренируется bus, а recorder закрывается ПОСЛЕ дренажа —
 * иначе последние сообщения были бы потеряны.
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
function makeCollector(contour = makeFakeContour(['binance'])): {
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

/** Шаги остановки в порядке их появления в журнале. */
function shutdownOrder(calls: readonly string[]): string[] {
  const shutdownSteps = new Set([
    'finalizer.close',
    'coordinator.close',
    'polymarketSource.close',
    'polymarketClient.closeSubscriptions',
    'cexSource.close(binance)',
    'bus.drain',
    'recorder.close',
    'bus.close',
  ]);
  return calls.filter((call) => shutdownSteps.has(call));
}

describe('DataCollector.close() — штатная остановка', () => {
  it('закрывает контур в доказанном порядке', async () => {
    const { collector, contour } = makeCollector();
    await collector.start();

    await collector.close();

    expect(shutdownOrder(contour.log.calls)).toEqual([
      'finalizer.close',
      'coordinator.close',
      'polymarketSource.close',
      'polymarketClient.closeSubscriptions',
      'cexSource.close(binance)',
      'bus.drain',
      'recorder.close',
      'bus.close',
    ]);
    expect(collector.state).toBe('stopped');
  });

  it('дренирует bus СТРОГО до закрытия recorder', async () => {
    const { collector, contour } = makeCollector();
    await collector.start();

    await collector.close();

    expect(contour.log.orderOf('bus.drain')).toBeLessThan(contour.log.orderOf('recorder.close'));
    expect(contour.log.orderOf('recorder.close')).toBeLessThan(contour.log.orderOf('bus.close'));
  });

  it('глушит ingress до дренажа очереди', async () => {
    const { collector, contour } = makeCollector();
    await collector.start();

    await collector.close();

    expect(contour.log.orderOf('polymarketSource.close')).toBeLessThan(
      contour.log.orderOf('bus.drain'),
    );
    expect(contour.log.orderOf('cexSource.close(binance)')).toBeLessThan(
      contour.log.orderOf('bus.drain'),
    );
  });
});

describe('DataCollector.close() — идемпотентность', () => {
  it('повторный close() не запускает вторую лестницу', async () => {
    const { collector, contour } = makeCollector();
    await collector.start();

    await collector.close();
    await collector.close();
    await collector.close();

    expect(contour.log.countOf('recorder.close')).toBe(1);
    expect(contour.log.countOf('bus.close')).toBe(1);
    expect(contour.log.countOf('finalizer.close')).toBe(1);
  });

  it('параллельные close() дожидаются одной и той же остановки', async () => {
    const { collector, contour } = makeCollector();
    await collector.start();

    await Promise.all([collector.close(), collector.close()]);

    expect(contour.log.countOf('bus.close')).toBe(1);
  });

  it('close() до старта — no-op, ресурсы не трогаются', async () => {
    const { collector, contour } = makeCollector();

    await collector.close();

    expect(contour.log.calls).toEqual([]);
    expect(collector.state).toBe('stopped');
  });

  it('close() после неудавшегося старта не закрывает ресурсы повторно', async () => {
    const contour = makeFakeContour(['binance']);
    contour.cexSources[0]!.startError = new Error('binance down');
    const { collector } = makeCollector(contour);
    await expect(collector.start()).rejects.toThrow('binance down');
    const callsAfterRollback = contour.log.calls.length;

    await collector.close();

    expect(contour.log.calls.length).toBe(callsAfterRollback);
  });
});

describe('DataCollector.close() — ресурсы SDK-клиента', () => {
  it('закрывает shared realtime клиента после снятия подписок source', async () => {
    const { collector, contour } = makeCollector();
    await collector.start();

    await collector.close();

    // Порядок принципиален: сначала source снимает СВОИ подписки, и только
    // потом закрывается общий транспорт, которым владеет клиент.
    expect(contour.log.orderOf('polymarketSource.close')).toBeLessThan(
      contour.log.orderOf('polymarketClient.closeSubscriptions'),
    );
    expect(contour.log.countOf('polymarketClient.closeSubscriptions')).toBe(1);
  });

  it('отказ client-level cleanup не срывает остальную лестницу', async () => {
    const { collector, contour } = makeCollector();
    contour.polymarketClient.closeRejection = new Error('closeSubscriptions failed');
    await collector.start();

    await collector.close();

    expect(contour.log.countOf('bus.drain')).toBe(1);
    expect(contour.log.countOf('recorder.close')).toBe(1);
    expect(contour.log.countOf('bus.close')).toBe(1);
  });
});

describe('DataCollector — гонка запуска и остановки', () => {
  it('остановка во время запуска не гасит контур на подъёме', async () => {
    const contour = makeFakeContour(['binance']);
    let releaseCleanup: (() => void) | undefined;
    contour.polymarketStorage.cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const { collector } = makeCollector(contour);

    const starting = collector.start();
    await Promise.resolve();
    // Сигнал пришёл, пока startup cleanup ещё не завершился.
    const closing = collector.close();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Лестница остановки НЕ начата: запуск ещё идёт.
    expect(contour.log.indexOf('bus.close')).toBe(-1);

    releaseCleanup?.();
    await Promise.all([starting, closing]);

    // Контур поднялся целиком и погашен целиком — без «повисшего» ingress.
    expect(contour.log.orderOf('cexSource.start(binance)')).toBeLessThan(
      contour.log.orderOf('cexSource.close(binance)'),
    );
    expect(contour.log.countOf('bus.close')).toBe(1);
    expect(collector.state).toBe('stopped');
  });

  it('остановка после провалившегося запуска не закрывает ресурсы повторно', async () => {
    const contour = makeFakeContour(['binance']);
    contour.recorder.startError = new Error('recorder subscribe failed');
    const { collector } = makeCollector(contour);

    const starting = collector.start();
    const closing = collector.close();
    await expect(starting).rejects.toThrow('recorder subscribe failed');
    await closing;

    // Recorder не поднялся — закрывать его нечего; bus закрыт РОВНО один раз,
    // хотя остановку запросили параллельно откату запуска.
    expect(contour.log.countOf('recorder.close')).toBe(0);
    expect(contour.log.countOf('bus.close')).toBe(1);
    expect(collector.state).toBe('stopped');
  });
});

describe('DataCollector.close() — best-effort', () => {
  it('отказ одного шага не отменяет остальные', async () => {
    const { collector, contour } = makeCollector();
    contour.finalizer.closeRejection = new Error('finalizer close failed');
    contour.polymarketSource.closeRejection = new Error('pm source close failed');
    await collector.start();

    await expect(collector.close()).resolves.toBeUndefined();

    // Все последующие шаги всё равно выполнены.
    expect(contour.log.countOf('coordinator.close')).toBe(1);
    expect(contour.log.countOf('cexSource.close(binance)')).toBe(1);
    expect(contour.log.countOf('bus.drain')).toBe(1);
    expect(contour.log.countOf('recorder.close')).toBe(1);
    expect(contour.log.countOf('bus.close')).toBe(1);
  });

  it('отказы шагов наблюдаемы в логе', async () => {
    const { collector, contour } = makeCollector();
    contour.recorder.closeRejection = new Error('recorder close failed');
    await collector.start();

    await collector.close();

    const failures = contour.logger
      .byLevel('error')
      .filter((line) => line.message.includes('Shutdown step failed'));
    expect(failures).toHaveLength(1);
    expect(failures[0]?.context?.['step']).toBe('recorder.close');
  });

  it('отклонённый bus.drain не срывает закрытие recorder и bus', async () => {
    const { collector, contour } = makeCollector();
    contour.bus.drainRejection = { message: 'drain timed out' } as never;
    await collector.start();

    await collector.close();

    expect(contour.log.countOf('recorder.close')).toBe(1);
    expect(contour.log.countOf('bus.close')).toBe(1);
  });

  it('отказ закрытия одной биржи не мешает закрыть остальные', async () => {
    const contour = makeFakeContour(['binance', 'okx']);
    contour.cexSources[0]!.closeRejection = new Error('binance close hung');
    const { collector } = makeCollector(contour);
    await collector.start();

    await collector.close();

    expect(contour.log.countOf('cexSource.close(binance)')).toBe(1);
    expect(contour.log.countOf('cexSource.close(okx)')).toBe(1);
    expect(contour.log.countOf('bus.close')).toBe(1);
  });
});

describe('DataCollector.close() — таймеры и тики', () => {
  it('останавливает runtime-цикл: после close() новых тиков нет', async () => {
    const { collector, contour } = makeCollector();
    await collector.start();
    await collector.close();
    const fillCallsAfterClose = contour.coordinator.fillCalls;

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(contour.coordinator.fillCalls).toBe(fillCallsAfterClose);
  });

  it('не закрывает контур, пока тик в полёте не завершился', async () => {
    const { collector, contour } = makeCollector();
    await collector.start();
    contour.coordinator.block();
    const slowTick = collector.tick();
    // Ждём, пока тик реально войдёт в fillSlots и подвиснет там.
    await Promise.resolve();
    await Promise.resolve();
    expect(contour.log.indexOf('coordinator.fillSlots.start')).toBeGreaterThanOrEqual(0);

    const closing = collector.close();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Тик держит остановку: контур ещё цел.
    expect(contour.log.indexOf('coordinator.fillSlots')).toBe(-1);
    expect(contour.log.indexOf('bus.close')).toBe(-1);

    contour.coordinator.release();
    await Promise.all([closing, slowTick]);

    // Завершившийся тик предшествует закрытию контура.
    expect(contour.log.orderOf('coordinator.fillSlots')).toBeLessThan(
      contour.log.orderOf('bus.close'),
    );
    expect(contour.log.countOf('bus.close')).toBe(1);
  });

  it('дожидается ВСЕХ перекрывающихся тиков, а не только последнего', async () => {
    const { collector, contour } = makeCollector();
    await collector.start();

    // Первый тик подвисает в fillSlots.
    contour.coordinator.block();
    const firstTick = collector.tick();
    await Promise.resolve();
    await Promise.resolve();
    expect(contour.log.indexOf('coordinator.fillSlots.start')).toBeGreaterThanOrEqual(0);

    // Второй тик перекрывает первый и УСПЕВАЕТ завершиться раньше него.
    contour.coordinator.unblockFuture();
    await collector.tick();

    const closing = collector.close();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Первый тик всё ещё работает с координатором/финализатором — закрывать их
    // нельзя. Хранение одной ссылки на «текущий тик» здесь давало bus.close.
    expect(contour.log.indexOf('bus.close')).toBe(-1);

    contour.coordinator.release();
    await Promise.all([closing, firstTick]);

    expect(contour.log.countOf('coordinator.fillSlots')).toBe(2);
    // Оба тика завершились до закрытия контура.
    expect(contour.log.calls.lastIndexOf('coordinator.fillSlots')).toBeLessThan(
      contour.log.orderOf('bus.close'),
    );
  });
});
