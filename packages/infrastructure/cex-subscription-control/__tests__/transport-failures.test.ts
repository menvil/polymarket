/**
 * Отказы транспорта: значения в отчёте, а не исключения, и намерение
 * владельца, которое отказ не стирает.
 *
 * @remarks
 * Главное разделение пакета:
 *
 * ```text
 * desired logical state   ≠   currently satisfied physical state
 * ```
 *
 * Владелец, чей источник не поднялся, ВСЁ ЕЩЁ хочет свой ресурс: claim
 * существует, пул желаем, физического пула нет — и следующий проход
 * обязан попробовать снова.
 */
import { describe, it, expect } from '@jest/globals';
import { CexSubscriptionController } from '../src/index.js';
import { AT_1800_MS, CapturingLogger, policy, sourceFactoryProbe, ts } from './helpers/fakes.js';

function makeController(): {
  controller: CexSubscriptionController;
  probe: ReturnType<typeof sourceFactoryProbe>;
  logger: CapturingLogger;
} {
  const probe = sourceFactoryProbe();
  const logger = new CapturingLogger();
  const controller = new CexSubscriptionController({ sourceFactory: probe.factory, logger });
  return { controller, probe, logger };
}

describe('отказ при открытии', () => {
  it('start() бросил: пул желаем, физически отсутствует, отказ в отчёте', async () => {
    const { controller, probe } = makeController();
    probe.onCreate = (source) => {
      source.startError = new Error('transport down');
    };

    const result = await controller.reconcile([{ ownerKey: 'A', policy: policy() }], ts(AT_1800_MS));

    expect(result.openedPools).toEqual([]);
    expect(result.failures).toEqual([
      { poolKey: 'binance|swap|TRADES', stage: 'open', reason: 'transport down' },
    ]);
    expect(result.desiredPools).toBe(1);
    expect(result.stats.physicalPools).toBe(0);

    // Намерение владельца отказ не стёр.
    expect(controller.listClaims()).toHaveLength(1);
    const [pool] = controller.listPools();
    expect(pool?.satisfied).toBe(false);
    expect(pool?.generation).toBe(0);
    expect(pool?.ownerKeys).toEqual(['A']);
    // Незакоммиченный источник закрыт: висящих websocket-соединений не остаётся.
    expect(probe.sources[0]?.closeCalls).toBe(1);
  });

  it('следующий идентичный проход пробует поднять пул снова', async () => {
    const { controller, probe } = makeController();
    const demands = [{ ownerKey: 'A', policy: policy() }];
    probe.onCreate = (source) => {
      source.startError = new Error('transport down');
    };

    await controller.reconcile(demands, ts(AT_1800_MS));
    probe.onCreate = null;
    const retry = await controller.reconcile(demands, ts(AT_1800_MS));

    expect(retry.openedPools).toEqual(['binance|swap|TRADES']);
    expect(retry.failures).toEqual([]);
    expect(probe.sources).toHaveLength(2);
    expect(controller.listPools()[0]?.satisfied).toBe(true);
    // Поколения монотонны: цикл «отказал → поднят заново» виден в номере.
    expect(controller.listPools()[0]?.generation).toBe(2);
  });

  it('отказ фабрики тоже становится значением', async () => {
    const { controller, probe } = makeController();
    probe.factoryError = new Error('bad config');

    const result = await controller.reconcile([{ ownerKey: 'A', policy: policy() }], ts(AT_1800_MS));

    expect(result.failures[0]).toMatchObject({ stage: 'open', reason: 'bad config' });
    expect(probe.sources).toHaveLength(0);
  });

  it('источник, родившийся мёртвым, активным пулом не коммитится', async () => {
    const { controller, probe } = makeController();
    probe.onCreate = (source) => {
      source.failTerminally();
    };

    const result = await controller.reconcile([{ ownerKey: 'A', policy: policy() }], ts(AT_1800_MS));

    expect(result.openedPools).toEqual([]);
    expect(result.failures[0]?.reason).toContain('not alive');
    expect(controller.getStats().physicalPools).toBe(0);
  });

  it('отказ одной биржи не мешает другой', async () => {
    const { controller, probe } = makeController();
    probe.onCreate = (source) => {
      if (source.config.exchangeId === 'binance') source.startError = new Error('binance down');
    };

    const result = await controller.reconcile(
      [
        { ownerKey: 'A', policy: policy({ exchangeIds: ['binance'] }) },
        { ownerKey: 'B', policy: policy({ exchangeIds: ['kraken'], marketTypes: ['spot'] }) },
      ],
      ts(AT_1800_MS),
    );

    expect(result.openedPools).toEqual(['kraken|spot|TRADES']);
    expect(result.failures.map((failure) => failure.poolKey)).toEqual(['binance|swap|TRADES']);
    expect(controller.getStats()).toMatchObject({ desiredPools: 2, physicalPools: 1 });
  });
});

describe('отказ при замене поколения', () => {
  it('старое закрыто, новое не поднялось: пул желаем, но недоступен', async () => {
    const { controller, probe } = makeController();

    await controller.reconcile(
      [{ ownerKey: 'A', policy: policy({ symbols: ['BTC/USDT'] }) }],
      ts(AT_1800_MS),
    );
    probe.onCreate = (source) => {
      source.startError = new Error('transport down');
    };

    const result = await controller.reconcile(
      [{ ownerKey: 'A', policy: policy({ symbols: ['BTC/USDT', 'ETH/USDT'] }) }],
      ts(AT_1800_MS),
    );

    expect(result.replacedPools).toEqual([]);
    expect(result.failures[0]).toMatchObject({ stage: 'replace', reason: 'transport down' });
    expect(probe.sources[0]?.closeCalls).toBe(1);
    expect(controller.getStats()).toMatchObject({ desiredPools: 1, physicalPools: 0 });
    // Желаемая спецификация — уже НОВАЯ: следующий проход поднимет именно её.
    expect(controller.listPools()[0]?.symbols).toEqual(['BTC/USDT', 'ETH/USDT']);
  });

  it('следующий идентичный проход поднимает пул с новой спецификацией', async () => {
    const { controller, probe } = makeController();
    const expanded = [{ ownerKey: 'A', policy: policy({ symbols: ['BTC/USDT', 'ETH/USDT'] }) }];

    await controller.reconcile(
      [{ ownerKey: 'A', policy: policy({ symbols: ['BTC/USDT'] }) }],
      ts(AT_1800_MS),
    );
    probe.onCreate = (source) => {
      source.startError = new Error('transport down');
    };
    await controller.reconcile(expanded, ts(AT_1800_MS));

    probe.onCreate = null;
    const retry = await controller.reconcile(expanded, ts(AT_1800_MS));

    expect(retry.openedPools).toEqual(['binance|swap|TRADES']);
    expect(retry.unchangedPools).toEqual([]);
    expect(probe.configs.at(-1)?.symbols).toEqual(['BTC/USDT', 'ETH/USDT']);
  });
});

describe('отказ при закрытии', () => {
  it('close() бросил: identity НЕ освобождена, отказ записан', async () => {
    const { controller, probe } = makeController();

    await controller.reconcile([{ ownerKey: 'A', policy: policy() }], ts(AT_1800_MS));
    const source = probe.sources[0];
    if (source !== undefined) source.closeError = new Error('close hung');

    const result = await controller.reconcile([], ts(AT_1800_MS));

    // Teardown не подтверждён → старый транспорт мог остаться живым.
    // Объявить ключ свободным значило бы разрешить поднять поверх него
    // дубль той же routing identity.
    expect(result.closedPools).toEqual([]);
    expect(result.failures[0]).toMatchObject({ stage: 'close', reason: 'close hung' });
    expect(controller.getStats().physicalPools).toBe(1);
  });

  it('следующий проход повторяет закрытие и освобождает пул после успеха', async () => {
    const { controller, probe } = makeController();

    await controller.reconcile([{ ownerKey: 'A', policy: policy() }], ts(AT_1800_MS));
    const source = probe.sources[0];
    if (source !== undefined) source.closeError = new Error('close hung');
    await controller.reconcile([], ts(AT_1800_MS));

    if (source !== undefined) source.closeError = null;
    const retry = await controller.reconcile([], ts(AT_1800_MS));

    expect(retry.closedPools).toEqual(['binance|swap|TRADES']);
    expect(retry.failures).toEqual([]);
    expect(source?.closeCalls).toBe(2);
    expect(controller.getStats().physicalPools).toBe(0);
  });

  it('отказ закрытия при замене НЕ разрешает поднять новое поколение', async () => {
    const { controller, probe } = makeController();

    await controller.reconcile(
      [{ ownerKey: 'A', policy: policy({ symbols: ['BTC/USDT'] }) }],
      ts(AT_1800_MS),
    );
    const source = probe.sources[0];
    if (source !== undefined) source.closeError = new Error('close hung');

    const result = await controller.reconcile(
      [{ ownerKey: 'A', policy: policy({ symbols: ['BTC/USDT', 'ETH/USDT'] }) }],
      ts(AT_1800_MS),
    );

    expect(result.replacedPools).toEqual([]);
    expect(result.failures[0]).toMatchObject({ stage: 'close', reason: 'close hung' });
    // Ни фабрика, ни start второго поколения не вызывались.
    expect(probe.sources).toHaveLength(1);
    // Старое поколение остаётся за контроллером как барьер identity.
    expect(controller.listPools()[0]).toMatchObject({ satisfied: true, generation: 1 });
    expect(controller.getStats().physicalPools).toBe(1);
  });
});
