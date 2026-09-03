/**
 * Диагностика: `getStats()`, `listPools()`, `listClaims()` и неизменяемость
 * отчёта.
 *
 * @remarks
 * Диагностика различает ДВА уровня — намерение владельцев и его
 * материализацию. Слить их в один счётчик нельзя: расхождение
 * `desiredPools` и `physicalPools` — единственный честный признак
 * деградации транспорта.
 */
import { describe, it, expect } from '@jest/globals';
import { CexSubscriptionController } from '../src/index.js';
import { AT_1800_MS, CapturingLogger, policy, sourceFactoryProbe, ts } from './helpers/fakes.js';

function makeController(): {
  controller: CexSubscriptionController;
  probe: ReturnType<typeof sourceFactoryProbe>;
} {
  const probe = sourceFactoryProbe();
  const controller = new CexSubscriptionController({
    sourceFactory: probe.factory,
    logger: new CapturingLogger(),
  });
  return { controller, probe };
}

describe('getStats', () => {
  it('считает владельцев, claim-ы и оба уровня пулов', async () => {
    const { controller } = makeController();

    await controller.reconcile(
      [
        { ownerKey: 'A', policy: policy({ orderbook: true, trades: true }) },
        { ownerKey: 'B', policy: policy({ symbols: ['ETH/USDT'] }) },
      ],
      ts(AT_1800_MS),
    );

    expect(controller.getStats()).toEqual({
      owners: 2,
      logicalClaims: 3,
      desiredPools: 2,
      physicalPools: 2,
      orderbookPools: 1,
      tradePools: 1,
      runningPools: 2,
      failedPools: 0,
      closed: false,
    });
  });

  it('расхождение desiredPools и physicalPools видно после отказа', async () => {
    const { controller, probe } = makeController();
    probe.onCreate = (source) => {
      source.startError = new Error('down');
    };

    await controller.reconcile([{ ownerKey: 'A', policy: policy() }], ts(AT_1800_MS));

    expect(controller.getStats()).toMatchObject({ desiredPools: 1, physicalPools: 0 });
  });

  it('терминальный отказ живого пула виден в failedPools', async () => {
    const { controller, probe } = makeController();

    await controller.reconcile([{ ownerKey: 'A', policy: policy() }], ts(AT_1800_MS));
    probe.sources[0]?.failTerminally();

    expect(controller.getStats()).toMatchObject({ failedPools: 1, runningPools: 0 });
    expect(controller.listPools()[0]).toMatchObject({ failed: true, running: false });
  });
});

describe('неизменяемость наружных структур', () => {
  it('отчёт прохода и его массивы заморожены', async () => {
    const { controller } = makeController();

    const result = await controller.reconcile([{ ownerKey: 'A', policy: policy() }], ts(AT_1800_MS));

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.openedPools)).toBe(true);
    expect(Object.isFrozen(result.failures)).toBe(true);
    expect(Object.isFrozen(result.stats)).toBe(true);
  });

  it('снимки пулов и claim-ов заморожены', async () => {
    const { controller } = makeController();

    await controller.reconcile([{ ownerKey: 'A', policy: policy() }], ts(AT_1800_MS));

    expect(Object.isFrozen(controller.listPools())).toBe(true);
    expect(Object.isFrozen(controller.listPools()[0])).toBe(true);
    expect(Object.isFrozen(controller.listClaims())).toBe(true);
  });

  it('reconciledAt — ровно тот момент, что передал вызывающий', async () => {
    const { controller } = makeController();
    const now = ts(AT_1800_MS);

    const result = await controller.reconcile([], now);

    expect(result.reconciledAt.equals(now)).toBe(true);
  });
});

describe('listClaims', () => {
  it('порядок детерминирован: владелец → биржа → тип рынка → поток → символ', async () => {
    const { controller } = makeController();

    await controller.reconcile(
      [
        {
          ownerKey: 'strategy:b',
          policy: policy({ symbols: ['ETH/USDT', 'BTC/USDT'], orderbook: true, trades: true }),
        },
        { ownerKey: 'collector:raw', policy: policy({ symbols: ['SOL/USDT'] }) },
      ],
      ts(AT_1800_MS),
    );

    expect(
      controller.listClaims().map((claim) => `${claim.ownerKey}/${claim.stream}/${claim.symbol}`),
    ).toEqual([
      'collector:raw/TRADES/SOL/USDT',
      'strategy:b/ORDERBOOK/BTC/USDT',
      'strategy:b/ORDERBOOK/ETH/USDT',
      'strategy:b/TRADES/BTC/USDT',
      'strategy:b/TRADES/ETH/USDT',
    ]);
  });

  it('claim — намерение, а не подписка: он есть и при неподнявшемся пуле', async () => {
    const { controller, probe } = makeController();
    probe.onCreate = (source) => {
      source.startError = new Error('down');
    };

    await controller.reconcile([{ ownerKey: 'A', policy: policy() }], ts(AT_1800_MS));

    expect(controller.listClaims()).toHaveLength(1);
    expect(controller.getStats().physicalPools).toBe(0);
  });
});
