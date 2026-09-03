/**
 * Поколения физических источников: переиспользование, замена, запрет
 * перекрытия и авторитетное исчезновение спроса.
 *
 * @remarks
 * Здесь проверяются два инварианта, ради которых пакет и написан:
 *
 * ```text
 * spec не изменилась     → источник переиспользован, close/start НЕ звались
 * spec изменилась        → старое поколение закрыто ПОЛНОСТЬЮ до старта нового
 * ```
 *
 * Второй проверяется через задержанный `close()`: пока он висит, у нового
 * источника не должно быть ни одного вызова `start()` — иначе оба
 * поколения публиковали бы одну routing identity.
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

describe('steady state', () => {
  it('повторный идентичный проход физически идемпотентен', async () => {
    const { controller, probe } = makeController();
    const demands = [{ ownerKey: 'A', policy: policy() }];
    const now = ts(AT_1800_MS);

    const first = await controller.reconcile(demands, now);
    const second = await controller.reconcile(demands, now);

    expect(first.openedPools).toEqual(['binance|swap|TRADES']);
    expect(second.openedPools).toEqual([]);
    expect(second.replacedPools).toEqual([]);
    expect(second.closedPools).toEqual([]);
    expect(second.unchangedPools).toEqual(['binance|swap|TRADES']);
    expect(probe.sources).toHaveLength(1);
    expect(probe.sources[0]?.startCalls).toBe(1);
    expect(probe.sources[0]?.closeCalls).toBe(0);
    expect(controller.listPools()[0]?.generation).toBe(1);
  });

  it('добавление владельца с той же спецификацией источник не трогает', async () => {
    const { controller, probe } = makeController();
    const a = { ownerKey: 'A', policy: policy() };

    await controller.reconcile([a], ts(AT_1800_MS));
    const result = await controller.reconcile([a, { ownerKey: 'B', policy: policy() }], ts(AT_1800_MS));

    expect(result.unchangedPools).toEqual(['binance|swap|TRADES']);
    expect(probe.sources).toHaveLength(1);
    expect(probe.sources[0]?.closeCalls).toBe(0);
    expect(controller.getStats().logicalClaims).toBe(2);
  });

  it('исчезновение одного из двух владельцев физическую спецификацию не меняет', async () => {
    const { controller, probe } = makeController();
    const b = { ownerKey: 'B', policy: policy() };

    await controller.reconcile([{ ownerKey: 'A', policy: policy() }, b], ts(AT_1800_MS));
    const result = await controller.reconcile([b], ts(AT_1800_MS));

    expect(result.replacedPools).toEqual([]);
    expect(result.closedPools).toEqual([]);
    expect(result.unchangedPools).toEqual(['binance|swap|TRADES']);
    expect(probe.sources[0]?.closeCalls).toBe(0);

    // Логическое владение при этом изменилось — в отличие от физического.
    expect(controller.listClaims().map((claim) => claim.ownerKey)).toEqual(['B']);
    expect(controller.listPools()[0]?.ownerKeys).toEqual(['B']);
  });
});

describe('авторитетный спрос', () => {
  it('исчезновение ПОСЛЕДНЕГО владельца закрывает источник ровно один раз', async () => {
    const { controller, probe } = makeController();

    await controller.reconcile([{ ownerKey: 'A', policy: policy() }], ts(AT_1800_MS));
    const result = await controller.reconcile([], ts(AT_1800_MS));

    expect(result.closedPools).toEqual(['binance|swap|TRADES']);
    expect(probe.sources[0]?.closeCalls).toBe(1);
    expect(controller.getStats()).toMatchObject({
      logicalClaims: 0,
      owners: 0,
      desiredPools: 0,
      physicalPools: 0,
    });
    expect(controller.listPools()).toEqual([]);
  });

  it('смена policy владельца заменяет его ресурсы', async () => {
    const { controller, probe } = makeController();

    await controller.reconcile(
      [{ ownerKey: 'A', policy: policy({ symbols: ['BTC/USDT'] }) }],
      ts(AT_1800_MS),
    );
    const result = await controller.reconcile(
      [{ ownerKey: 'A', policy: policy({ symbols: ['ETH/USDT'] }) }],
      ts(AT_1800_MS),
    );

    expect(result.replacedPools).toEqual(['binance|swap|TRADES']);
    expect(controller.listClaims().map((claim) => claim.symbol)).toEqual(['ETH/USDT']);
    expect(probe.configs[1]?.symbols).toEqual(['ETH/USDT']);
  });

  it('смена биржи закрывает старый пул и открывает новый', async () => {
    const { controller } = makeController();

    await controller.reconcile(
      [{ ownerKey: 'A', policy: policy({ exchangeIds: ['binance'] }) }],
      ts(AT_1800_MS),
    );
    const result = await controller.reconcile(
      [{ ownerKey: 'A', policy: policy({ exchangeIds: ['kraken'] }) }],
      ts(AT_1800_MS),
    );

    expect(result.openedPools).toEqual(['kraken|swap|TRADES']);
    expect(result.closedPools).toEqual(['binance|swap|TRADES']);
  });
});

describe('замена поколения без перекрытия', () => {
  it('новое поколение НЕ стартует, пока не завершился close() старого', async () => {
    const { controller, probe } = makeController();

    await controller.reconcile([{ ownerKey: 'A', policy: policy() }], ts(AT_1800_MS));
    const generation1 = probe.sources[0];
    const release = generation1?.holdClose() ?? (() => undefined);

    const pending = controller.reconcile(
      [
        { ownerKey: 'A', policy: policy() },
        { ownerKey: 'B', policy: policy({ symbols: ['ETH/USDT'] }) },
      ],
      ts(AT_1800_MS),
    );
    await Promise.resolve();
    await Promise.resolve();

    // close() старого поколения ещё висит: второго источника нет вовсе.
    expect(generation1?.closeCalls).toBe(1);
    expect(probe.sources).toHaveLength(1);
    expect(generation1?.startCalls).toBe(1);

    // Пока teardown не подтверждён, поколение 1 ОСТАЁТСЯ за контроллером:
    // identity занята, новое поколение не закоммичено.
    expect(controller.getStats().physicalPools).toBe(1);
    expect(controller.listPools()[0]).toMatchObject({
      poolKey: 'binance|swap|TRADES',
      generation: 1,
      satisfied: true,
    });
    // Логический снимок коммитится атомарно в КОНЦЕ прохода, поэтому
    // снаружи виден прежний — незавершённый проход состояния не показывает.
    expect(controller.listPools()[0]?.symbols).toEqual(['BTC/USDT']);

    release();
    const result = await pending;

    expect(result.replacedPools).toEqual(['binance|swap|TRADES']);
    expect(probe.sources).toHaveLength(2);
    expect(probe.sources[1]?.startCalls).toBe(1);
    expect(probe.configs[1]?.symbols).toEqual(['BTC/USDT', 'ETH/USDT']);
    expect(controller.listPools()[0]?.generation).toBe(2);
  });
});

describe('терминальное состояние источника', () => {
  it('hasFailed при том же спросе вызывает замену поколения', async () => {
    const { controller, probe } = makeController();
    const demands = [{ ownerKey: 'A', policy: policy() }];

    await controller.reconcile(demands, ts(AT_1800_MS));
    probe.sources[0]?.failTerminally();

    const result = await controller.reconcile(demands, ts(AT_1800_MS));

    expect(result.replacedPools).toEqual(['binance|swap|TRADES']);
    expect(result.unchangedPools).toEqual([]);
    expect(probe.sources).toHaveLength(2);
    expect(probe.sources[0]?.closeCalls).toBe(1);
    expect(controller.listPools()[0]?.generation).toBe(2);
    expect(controller.getStats().failedPools).toBe(0);
  });

  it('isClosed при том же спросе вызывает замену поколения', async () => {
    const { controller, probe } = makeController();
    const demands = [{ ownerKey: 'A', policy: policy() }];

    await controller.reconcile(demands, ts(AT_1800_MS));
    probe.sources[0]?.markClosed();

    const result = await controller.reconcile(demands, ts(AT_1800_MS));

    expect(result.replacedPools).toEqual(['binance|swap|TRADES']);
    expect(probe.sources).toHaveLength(2);
    expect(probe.sources[1]?.isRunning).toBe(true);
  });

  it('ровно одна попытка на проход: внутреннего retry-цикла нет', async () => {
    const { controller, probe } = makeController();
    const demands = [{ ownerKey: 'A', policy: policy() }];
    probe.onCreate = (source) => {
      source.startError = new Error('transport down');
    };

    await controller.reconcile(demands, ts(AT_1800_MS));

    expect(probe.sources).toHaveLength(1);
  });
});
