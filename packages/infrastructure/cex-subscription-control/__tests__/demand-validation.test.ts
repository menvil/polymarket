/**
 * Валидация входа: дефекты вызывающего обнаруживаются ДО побочных эффектов.
 *
 * @remarks
 * Граница здесь ровно одна: дефект ВЫЗЫВАЮЩЕГО — исключение, отказ
 * ТРАНСПОРТА — значение в отчёте. Проверяется не только факт исключения,
 * но и то, что до него не создано ни одного источника: иначе «проход
 * упал» означало бы «часть переходов всё-таки выполнилась».
 */
import { describe, it, expect } from '@jest/globals';
import { ValidationError } from '@polymarket/errors';
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

describe('валидация спроса', () => {
  it('пустой ключ владельца — ValidationError, ни одного источника не создано', async () => {
    const { controller, probe } = makeController();

    await expect(controller.reconcile([{ ownerKey: '   ', policy: policy() }], ts(AT_1800_MS)))
      .rejects.toBeInstanceOf(ValidationError);

    expect(probe.sources).toHaveLength(0);
  });

  it('дубликат ownerKey в одном проходе запрещён', async () => {
    const { controller, probe } = makeController();

    await expect(
      controller.reconcile(
        [
          { ownerKey: 'A', policy: policy({ symbols: ['BTC/USDT'] }) },
          { ownerKey: 'A', policy: policy({ symbols: ['ETH/USDT'] }) },
        ],
        ts(AT_1800_MS),
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(probe.sources).toHaveLength(0);
  });

  it('валидация ВСЕГО входа завершается до первого физического перехода', async () => {
    const { controller, probe } = makeController();

    // Первый спрос корректен и сам по себе поднял бы источник; второй — нет.
    await expect(
      controller.reconcile(
        [
          { ownerKey: 'A', policy: policy() },
          { ownerKey: '', policy: policy() },
        ],
        ts(AT_1800_MS),
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(probe.sources).toHaveLength(0);
    expect(controller.getStats().desiredPools).toBe(0);
  });

  it('policy не CEX-вида отвергается', async () => {
    const { controller } = makeController();

    await expect(
      controller.reconcile(
        [{ ownerKey: 'A', policy: { ...policy(), kind: 'POLYMARKET' } as never }],
        ts(AT_1800_MS),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('пустой символ внутри списка — дефект, а не пустой набор', async () => {
    const { controller, probe } = makeController();

    await expect(
      controller.reconcile([{ ownerKey: 'A', policy: policy({ symbols: ['BTC/USDT', ' '] }) }], ts(AT_1800_MS)),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(probe.sources).toHaveLength(0);
  });

  it('неизвестный тип рынка отвергается', async () => {
    const { controller } = makeController();

    await expect(
      controller.reconcile(
        [{ ownerKey: 'A', policy: policy({ marketTypes: ['SPOT' as never] }) }],
        ts(AT_1800_MS),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('недопустимая глубина стакана отвергается', async () => {
    const { controller } = makeController();

    await expect(
      controller.reconcile(
        [{ ownerKey: 'A', policy: policy({ orderbook: true, orderbookDepth: 0 }) }],
        ts(AT_1800_MS),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('пустая policy (ни одного потока) claim-ов не даёт и ошибкой не является', async () => {
    const { controller, probe } = makeController();

    const result = await controller.reconcile(
      [{ ownerKey: 'A', policy: policy({ orderbook: false, trades: false }) }],
      ts(AT_1800_MS),
    );

    expect(result.activeDemands).toBe(1);
    expect(result.desiredPools).toBe(0);
    expect(probe.sources).toHaveLength(0);
    expect(controller.listClaims()).toEqual([]);
  });

  it('входной массив спроса не мутируется', async () => {
    const { controller } = makeController();
    const demands = [
      { ownerKey: 'B', policy: policy() },
      { ownerKey: 'A', policy: policy() },
    ];
    const order = demands.map((demand) => demand.ownerKey);

    await controller.reconcile(demands, ts(AT_1800_MS));

    expect(demands.map((demand) => demand.ownerKey)).toEqual(order);
  });
});

describe('закрытый контроллер', () => {
  it('reconcile после close() — ValidationError, а не пустой «успешный» отчёт', async () => {
    const { controller } = makeController();
    await controller.close();

    await expect(controller.reconcile([], ts(AT_1800_MS))).rejects.toBeInstanceOf(ValidationError);
    expect(controller.isClosed).toBe(true);
  });

  it('close() идемпотентен', async () => {
    const { controller, probe } = makeController();
    await controller.reconcile([{ ownerKey: 'A', policy: policy() }], ts(AT_1800_MS));

    await controller.close();
    await controller.close();

    expect(probe.sources[0]?.closeCalls).toBe(1);
    expect(controller.getStats().physicalPools).toBe(0);
  });
});
