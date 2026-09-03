/**
 * Рантайм сбора после Collector-cutover: порядок запуска/остановки, control-тик
 * (спрос через control-plane), откат и операционный статус.
 *
 * @remarks
 * Компоненты — узкие fakes; проверяется РАНТАЙМ, а не поведение контроллеров.
 */
import { describe, it, expect } from '@jest/globals';
import { DataCollector } from '../src/runtime/DataCollector.js';
import type { ControlRuntimeConfig } from '../src/runtime/DataCollectorConfig.js';
import { CapturingLogger, FakeClock, makeFakeContour } from './helpers/fakes.js';

const CONTROL: ControlRuntimeConfig = { acquireLimit: 20, tickMs: 5_000 };

function makeCollector(options: { readonly cex?: boolean } = {}) {
  const contour = makeFakeContour(options);
  const collector = new DataCollector({
    components: contour.components,
    control: CONTROL,
    clock: new FakeClock(),
    logger: new CapturingLogger(),
  });
  return { contour, collector };
}

describe('DataCollector.start() — порядок запуска (recorder-first)', () => {
  it('cleanup → recorder.start ДО первого control-тика', async () => {
    const { contour, collector } = makeCollector();
    await collector.start();
    // Даём запланированному тику (delay 0) выполниться.
    await collector.tick();

    const order = contour.log.calls;
    expect(order.indexOf('polymarketStorage.cleanup')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('cexStorage.cleanup')).toBeGreaterThanOrEqual(0);
    // recorder.start строго ПОСЛЕ cleanup и строго ДО любого runOnce.
    expect(contour.log.orderOf('recorder.start')).toBeGreaterThan(
      contour.log.orderOf('polymarketStorage.cleanup'),
    );
    expect(contour.log.orderOf('recorder.start')).toBeLessThan(
      contour.log.orderOf('pmControlRuntime.runOnce'),
    );
    expect(collector.state).toBe('running');

    await collector.close();
  });

  it('повторный start() отклоняется', async () => {
    const { collector } = makeCollector();
    await collector.start();
    await expect(collector.start()).rejects.toThrow('already');
    await collector.close();
  });

  it('отказ recorder.start откатывает контур (bus закрыт) и отклоняет start()', async () => {
    const { contour, collector } = makeCollector();
    contour.recorder.startFailure = new Error('recorder boom');

    await expect(collector.start()).rejects.toThrow('recorder boom');

    // Шаг, бросивший ошибку, в rollback не попал (LIFO-откат добавляется ПОСЛЕ
    // успеха шага), но контур не остаётся «поднятым»: bus закрыт, а с ним
    // сняты любые подписки, которые recorder успел оформить до отказа.
    expect(contour.log.calls).toContain('bus.close');
    expect(collector.state).toBe('stopped');
    // Тик не планировался: до control-loop дело не дошло.
    expect(contour.log.calls).not.toContain('pmControlRuntime.runOnce');
  });
});

describe('DataCollector.tick() — спрос через control-plane', () => {
  it('один тик = runOnce(PM demands) + reconcile(CEX demands)', async () => {
    const { contour, collector } = makeCollector({ cex: true });
    await collector.start();
    await collector.tick();

    expect(contour.polymarketControlRuntime.demandsSeen.length).toBeGreaterThanOrEqual(1);
    expect(contour.polymarketControlRuntime.demandsSeen[0]?.[0]?.ownerKey).toBe('collector:raw');
    expect(contour.cexController.demandsSeen.length).toBeGreaterThanOrEqual(1);
    expect(contour.cexController.demandsSeen[0]?.[0]?.ownerKey).toBe('collector:raw:binance');
    // runOnce перед reconcile в одном тике.
    expect(contour.log.orderOf('pmControlRuntime.runOnce')).toBeLessThan(
      contour.log.orderOf('cexController.reconcile'),
    );

    await collector.close();
  });

  it('без CEX-спроса reconcile НЕ вызывается', async () => {
    const { contour, collector } = makeCollector({ cex: false });
    await collector.start();
    await collector.tick();

    expect(contour.polymarketControlRuntime.demandsSeen.length).toBeGreaterThanOrEqual(1);
    expect(contour.cexController.demandsSeen).toHaveLength(0);
    expect(contour.log.calls).not.toContain('cexController.reconcile');

    await collector.close();
  });

  it('CEX-сверка получает `ranAt` PM-прохода, а не момент ДО обхода каталога', async () => {
    const { contour, collector } = makeCollector({ cex: true });
    await collector.start();
    await collector.tick();

    // `runOnce` читает часы уже после discovery.refresh() и возвращает этот
    // момент как `ranAt` — именно он и есть момент решения тика.
    const ranAt = contour.polymarketControlRuntime.ranAt;
    expect(ranAt).toBeDefined();
    expect(contour.cexController.momentsSeen).toContain(ranAt);
    // Момент тика строго ПОЗЖЕ показаний часов рантайма (18:00:00), то есть
    // это не устаревший снимок, взятый до сетевого обхода каталога.
    expect(ranAt?.toNumber()).toBeGreaterThan(Date.parse('2026-09-01T18:00:00.000Z'));

    await collector.close();
  });

  it('если PM-проход отказал, CEX-сверка идёт по свежим часам', async () => {
    const { contour, collector } = makeCollector({ cex: true });
    contour.polymarketControlRuntime.runFailure = new Error('gamma down');
    await collector.start();
    await collector.tick();

    // Единого момента тика нет — CEX-решение не должно зависеть от Gamma.
    expect(contour.cexController.demandsSeen.length).toBeGreaterThanOrEqual(1);
    expect(contour.cexController.momentsSeen[0]?.toNumber()).toBe(
      Date.parse('2026-09-01T18:00:00.000Z'),
    );

    await collector.close();
  });

  it('отказ runOnce не роняет тик (best-effort)', async () => {
    const { contour, collector } = makeCollector();
    contour.polymarketControlRuntime.runFailure = new Error('gamma down');
    await collector.start();

    await expect(collector.tick()).resolves.toBeUndefined();
    expect(collector.state).toBe('running');

    await collector.close();
  });
});

describe('DataCollector.close() — лестница остановки', () => {
  it('порядок: cexController → pmController → source → client → drain → recorder → bus.close', async () => {
    const { contour, collector } = makeCollector({ cex: true });
    await collector.start();
    await collector.close();

    const order = [
      'cexController.close',
      'polymarketController.close',
      'polymarketSource.close',
      'polymarketClient.closeSubscriptions',
      'bus.drain',
      'recorder.close',
      'bus.close',
    ];
    for (let i = 0; i < order.length - 1; i++) {
      expect(contour.log.orderOf(order[i]!)).toBeLessThan(contour.log.orderOf(order[i + 1]!));
    }
    expect(collector.state).toBe('stopped');
  });

  it('идемпотентна: повторный close() возвращает тот же результат', async () => {
    const { contour, collector } = makeCollector();
    await collector.start();
    await collector.close();
    await collector.close();
    // Лестница отработала РОВНО один раз.
    expect(contour.recorder.closeCalls).toBe(1);
    expect(contour.polymarketSource.closeCalls).toBe(1);
  });

  it('best-effort: отказ одного шага не отменяет остальные', async () => {
    const { contour, collector } = makeCollector();
    await collector.start();
    contour.bus.drainFailure = { message: 'drain boom' } as never;

    await collector.close();

    // Несмотря на отказ drain, recorder и bus всё равно закрыты.
    expect(contour.recorder.closeCalls).toBe(1);
    expect(contour.log.calls).toContain('bus.close');
    expect(collector.state).toBe('stopped');
  });

  it('close() до start() — no-op', async () => {
    const { contour, collector } = makeCollector();
    await collector.close();
    expect(contour.log.calls).toHaveLength(0);
    expect(collector.state).toBe('stopped');
  });
});

describe('DataCollector — гонка запуска и остановки', () => {
  it('close(), пришедший во время start(), дожидается подъёма и гасит контур', async () => {
    const { contour, collector } = makeCollector();
    const starting = collector.start();
    const closing = collector.close();
    await Promise.all([starting, closing]);

    expect(collector.state).toBe('stopped');
    expect(contour.recorder.closeCalls).toBe(1);
  });
});

describe('DataCollector.status()', () => {
  it('снимок собран из getStats компонентов', async () => {
    const { collector } = makeCollector({ cex: true });
    await collector.start();

    const status = collector.status();
    expect(status.state).toBe('running');
    expect(status.uptimeMs).not.toBeNull();
    expect(status.polymarket.activeMarkets).toBe(0);
    expect(status.cex.desiredPools).toBe(0);
    expect(status.gate.admitted).toBe(0);
    expect(status.recorder.recordsWritten).toBe(0);
    expect(status.polymarketSource.isClosed).toBe(false);

    await collector.close();
  });
});
