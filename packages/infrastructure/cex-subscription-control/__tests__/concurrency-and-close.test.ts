/**
 * Сериализация проходов и остановка контроллера.
 *
 * @remarks
 * В отличие от `acquire(market)` у Polymarket, где ключи независимы,
 * `reconcile()` перестраивает ГЛОБАЛЬНЫЙ авторитетный снимок желаемого
 * состояния. Два таких прохода вперемешку дали бы состояние, не
 * соответствующее ни одному из них, — поэтому проходы сериализованы, а
 * итог соответствует ПОСЛЕДНЕМУ по порядку вызова.
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

describe('сериализация проходов', () => {
  it('второй вызов начинается после полного commit первого', async () => {
    const { controller, probe } = makeController();

    await controller.reconcile([{ ownerKey: 'A', policy: policy() }], ts(AT_1800_MS));
    const release = probe.sources[0]?.holdClose() ?? (() => undefined);

    // R1 висит на close() старого поколения.
    const first = controller.reconcile(
      [{ ownerKey: 'A', policy: policy({ symbols: ['ETH/USDT'] }) }],
      ts(AT_1800_MS),
    );
    // R2 подан, пока R1 не завершился.
    const second = controller.reconcile(
      [{ ownerKey: 'A', policy: policy({ symbols: ['SOL/USDT'] }) }],
      ts(AT_1800_MS),
    );
    await Promise.resolve();
    await Promise.resolve();

    // Пока R1 не закончил, R2 не создал ни одного источника.
    expect(probe.sources).toHaveLength(1);

    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.replacedPools).toEqual(['binance|swap|TRADES']);
    expect(secondResult.replacedPools).toEqual(['binance|swap|TRADES']);
  });

  it('итоговое физическое состояние соответствует ПОСЛЕДНЕМУ вызову', async () => {
    const { controller, probe } = makeController();

    const first = controller.reconcile(
      [{ ownerKey: 'A', policy: policy({ symbols: ['BTC/USDT'] }) }],
      ts(AT_1800_MS),
    );
    const second = controller.reconcile(
      [{ ownerKey: 'A', policy: policy({ symbols: ['ETH/USDT'] }) }],
      ts(AT_1800_MS),
    );
    await Promise.all([first, second]);

    expect(controller.listClaims().map((claim) => claim.symbol)).toEqual(['ETH/USDT']);
    expect(controller.listPools()[0]?.symbols).toEqual(['ETH/USDT']);
    expect(probe.configs.at(-1)?.symbols).toEqual(['ETH/USDT']);
    expect(controller.getStats().physicalPools).toBe(1);
  });

  it('отказ переходов одного прохода не блокирует следующий', async () => {
    const { controller, probe } = makeController();
    // Первое поколение не поднимется, второе — поднимется: оба прохода уже
    // стоят в очереди, поэтому решение принимается по индексу создания.
    probe.onCreate = (source, index) => {
      if (index === 0) source.startError = new Error('transport down');
    };

    const first = controller.reconcile([{ ownerKey: 'A', policy: policy() }], ts(AT_1800_MS));
    const second = controller.reconcile([{ ownerKey: 'A', policy: policy() }], ts(AT_1800_MS));

    const firstResult = await first;
    const secondResult = await second;

    expect(firstResult.failures).toHaveLength(1);
    expect(firstResult.openedPools).toEqual([]);
    expect(secondResult.openedPools).toEqual(['binance|swap|TRADES']);
    expect(controller.getStats().physicalPools).toBe(1);
  });
});

describe('остановка контроллера', () => {
  it('close() дожидается идущего прохода и закрывает поднятый им источник', async () => {
    const { controller, probe } = makeController();

    await controller.reconcile([{ ownerKey: 'A', policy: policy() }], ts(AT_1800_MS));
    const release = probe.sources[0]?.holdClose() ?? (() => undefined);

    const pending = controller.reconcile(
      [{ ownerKey: 'A', policy: policy({ symbols: ['ETH/USDT'] }) }],
      ts(AT_1800_MS),
    );
    await Promise.resolve();

    const closing = controller.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    // Проход ещё идёт — close() завершиться не может.
    expect(closed).toBe(false);
    // И владение старым поколением ещё не отдано: teardown не подтверждён.
    expect(controller.getStats().physicalPools).toBe(1);

    release();
    await pending;
    await closing;

    expect(closed).toBe(true);
    expect(controller.getStats().physicalPools).toBe(0);
    expect(controller.getStats().desiredPools).toBe(0);
    expect(controller.listPools()).toEqual([]);
    // Новое поколение, поднятое проходом, тоже закрыто.
    expect(probe.sources).toHaveLength(2);
    expect(probe.sources[1]?.closeCalls).toBe(1);
  });

  it('проход, стоявший в очереди на момент close(), источников не поднимает', async () => {
    const { controller, probe } = makeController();

    await controller.reconcile([{ ownerKey: 'A', policy: policy() }], ts(AT_1800_MS));
    const release = probe.sources[0]?.holdClose() ?? (() => undefined);

    const running = controller.reconcile(
      [{ ownerKey: 'A', policy: policy({ symbols: ['ETH/USDT'] }) }],
      ts(AT_1800_MS),
    );
    const queued = controller.reconcile(
      [{ ownerKey: 'A', policy: policy({ symbols: ['SOL/USDT'] }) }],
      ts(AT_1800_MS),
    );
    await Promise.resolve();

    const closing = controller.close();
    release();

    await running;
    await expect(queued).rejects.toThrow('closed');
    await closing;

    expect(controller.getStats().physicalPools).toBe(0);
    // Поколения: исходное + замена идущего прохода. Очередной проход — ни одного.
    expect(probe.sources).toHaveLength(2);
  });

  it('close() закрывает ВСЕ пулы всех бирж', async () => {
    const { controller, probe } = makeController();

    await controller.reconcile(
      [
        {
          ownerKey: 'A',
          policy: policy({ exchangeIds: ['binance', 'kraken'], orderbook: true, trades: true }),
        },
      ],
      ts(AT_1800_MS),
    );
    expect(probe.sources).toHaveLength(4);

    await controller.close();

    expect(probe.sources.every((source) => source.closeCalls === 1)).toBe(true);
    expect(controller.getStats()).toMatchObject({
      physicalPools: 0,
      desiredPools: 0,
      logicalClaims: 0,
      owners: 0,
      closed: true,
    });
  });
});

describe('close() дожидается подтверждённого teardown источника', () => {
  it('пока close() источника висит, controller.close() не резолвится и владение не отдано', async () => {
    const { controller, probe } = makeController();

    await controller.reconcile([{ ownerKey: 'A', policy: policy() }], ts(AT_1800_MS));
    const source = probe.sources[0];
    const release = source?.holdClose() ?? (() => undefined);

    let closed = false;
    const closing = controller.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    // close() источника вызван, но teardown транспорта ещё идёт.
    expect(source?.closeCalls).toBe(1);
    expect(closed).toBe(false);
    expect(controller.getStats().physicalPools).toBe(1);

    release();
    await closing;

    expect(closed).toBe(true);
    expect(controller.getStats().physicalPools).toBe(0);
  });
});
