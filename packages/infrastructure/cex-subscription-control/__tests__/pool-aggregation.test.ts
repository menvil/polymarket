/**
 * Агрегация логических claim-ов в физические пулы.
 *
 * @remarks
 * Главный принцип пакета формулируется именно здесь: несколько владельцев
 * одного CEX-ресурса ДЕЛЯТ физический поток. Проверяется он числом
 * созданных источников, а не намерением: `probe.sources.length` — тот
 * самый счётчик, который отличает разделение от дублирования.
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

describe('разделение одного ресурса', () => {
  it('два владельца одного BTC/trades → 2 claim-а, ОДИН источник', async () => {
    const { controller, probe } = makeController();

    await controller.reconcile(
      [
        { ownerKey: 'A', policy: policy() },
        { ownerKey: 'B', policy: policy() },
      ],
      ts(AT_1800_MS),
    );

    expect(controller.getStats().logicalClaims).toBe(2);
    expect(controller.getStats().physicalPools).toBe(1);
    expect(probe.sources).toHaveLength(1);

    const [pool] = controller.listPools();
    expect(pool?.poolKey).toBe('binance|swap|TRADES');
    expect(pool?.symbols).toEqual(['BTC/USDT']);
    expect(pool?.ownerKeys).toEqual(['A', 'B']);
  });

  it('разные символы одного потока сливаются в ОДИН пул', async () => {
    const { controller, probe } = makeController();

    await controller.reconcile(
      [
        { ownerKey: 'A', policy: policy({ symbols: ['BTC/USDT'] }) },
        { ownerKey: 'B', policy: policy({ symbols: ['ETH/USDT'] }) },
      ],
      ts(AT_1800_MS),
    );

    expect(probe.sources).toHaveLength(1);
    expect(probe.configs[0]?.symbols).toEqual(['BTC/USDT', 'ETH/USDT']);
  });

  it('стакан и сделки — независимые пулы', async () => {
    const { controller, probe } = makeController();

    await controller.reconcile(
      [
        { ownerKey: 'A', policy: policy({ symbols: ['BTC/USDT'], orderbook: true, trades: false }) },
        { ownerKey: 'B', policy: policy({ symbols: ['ETH/USDT'], orderbook: false, trades: true }) },
      ],
      ts(AT_1800_MS),
    );

    expect(probe.sources).toHaveLength(2);
    expect(controller.listPools().map((pool) => pool.poolKey)).toEqual([
      'binance|swap|ORDERBOOK',
      'binance|swap|TRADES',
    ]);

    const orderbook = probe.configs.find((config) => config.watchOrderbook);
    const trades = probe.configs.find((config) => config.watchTrades);
    expect(orderbook?.symbols).toEqual(['BTC/USDT']);
    expect(orderbook?.watchTrades).toBe(false);
    expect(trades?.symbols).toEqual(['ETH/USDT']);
    expect(trades?.watchOrderbook).toBe(false);
  });

  it('переконфигурация стакана не трогает пул сделок', async () => {
    const { controller, probe } = makeController();
    const tradesOwner = { ownerKey: 'B', policy: policy({ symbols: ['ETH/USDT'] }) };

    await controller.reconcile(
      [
        { ownerKey: 'A', policy: policy({ symbols: ['BTC/USDT'], orderbook: true, trades: false }) },
        tradesOwner,
      ],
      ts(AT_1800_MS),
    );
    const tradesSource = probe.sources.find((source) => source.config.watchTrades);

    const result = await controller.reconcile(
      [
        {
          ownerKey: 'A',
          policy: policy({ symbols: ['BTC/USDT', 'SOL/USDT'], orderbook: true, trades: false }),
        },
        tradesOwner,
      ],
      ts(AT_1800_MS),
    );

    expect(result.replacedPools).toEqual(['binance|swap|ORDERBOOK']);
    expect(result.unchangedPools).toEqual(['binance|swap|TRADES']);
    expect(tradesSource?.closeCalls).toBe(0);
  });
});

describe('агрегация символов', () => {
  it('символы отсортированы ASC независимо от порядка спроса', async () => {
    const first = makeController();
    const second = makeController();

    await first.controller.reconcile(
      [
        { ownerKey: 'B', policy: policy({ symbols: ['ETH/USDT'] }) },
        { ownerKey: 'A', policy: policy({ symbols: ['BTC/USDT'] }) },
      ],
      ts(AT_1800_MS),
    );
    await second.controller.reconcile(
      [
        { ownerKey: 'A', policy: policy({ symbols: ['BTC/USDT'] }) },
        { ownerKey: 'B', policy: policy({ symbols: ['ETH/USDT'] }) },
      ],
      ts(AT_1800_MS),
    );

    expect(first.probe.configs[0]?.symbols).toEqual(second.probe.configs[0]?.symbols);
    expect(first.probe.configs[0]?.symbols).toEqual(['BTC/USDT', 'ETH/USDT']);
  });

  it('перестановка спроса на втором проходе замены не вызывает', async () => {
    const { controller, probe } = makeController();
    const a = { ownerKey: 'A', policy: policy({ symbols: ['BTC/USDT'] }) };
    const b = { ownerKey: 'B', policy: policy({ symbols: ['ETH/USDT'] }) };

    await controller.reconcile([b, a], ts(AT_1800_MS));
    const result = await controller.reconcile([a, b], ts(AT_1800_MS));

    expect(result.replacedPools).toEqual([]);
    expect(result.unchangedPools).toEqual(['binance|swap|TRADES']);
    expect(probe.sources).toHaveLength(1);
  });
});

describe('агрегация глубины стакана', () => {
  const orderbook = (symbols: string[], depth: number) =>
    policy({ symbols, orderbook: true, trades: false, orderbookDepth: depth });

  it('глубина пула — МАКСИМУМ желаемых глубин', async () => {
    const { controller, probe } = makeController();

    await controller.reconcile(
      [
        { ownerKey: 'A', policy: orderbook(['BTC/USDT'], 10) },
        { ownerKey: 'B', policy: orderbook(['ETH/USDT'], 50) },
      ],
      ts(AT_1800_MS),
    );

    expect(probe.sources).toHaveLength(1);
    expect(probe.configs[0]?.symbols).toEqual(['BTC/USDT', 'ETH/USDT']);
    expect(probe.configs[0]?.orderbookDepth).toBe(50);
    expect(controller.listPools()[0]?.orderbookDepth).toBe(50);
  });

  it('уход владельца с МЕНЬШЕЙ глубиной спецификацию не меняет', async () => {
    const { controller, probe } = makeController();
    const b = { ownerKey: 'B', policy: orderbook(['BTC/USDT'], 50) };

    await controller.reconcile([{ ownerKey: 'A', policy: orderbook(['BTC/USDT'], 10) }, b], ts(AT_1800_MS));
    const result = await controller.reconcile([b], ts(AT_1800_MS));

    expect(result.unchangedPools).toEqual(['binance|swap|ORDERBOOK']);
    expect(result.replacedPools).toEqual([]);
    expect(probe.sources).toHaveLength(1);
    expect(probe.sources[0]?.closeCalls).toBe(0);
    expect(controller.listPools()[0]?.orderbookDepth).toBe(50);
  });

  it('уход владельца с БОЛЬШЕЙ глубиной ужимает пул новым поколением', async () => {
    const { controller, probe } = makeController();
    const a = { ownerKey: 'A', policy: orderbook(['BTC/USDT'], 10) };

    await controller.reconcile([a, { ownerKey: 'B', policy: orderbook(['BTC/USDT'], 50) }], ts(AT_1800_MS));
    const result = await controller.reconcile([a], ts(AT_1800_MS));

    expect(result.replacedPools).toEqual(['binance|swap|ORDERBOOK']);
    expect(probe.sources).toHaveLength(2);
    expect(probe.sources[0]?.closeCalls).toBe(1);
    expect(probe.configs[1]?.orderbookDepth).toBe(10);
    expect(controller.listPools()[0]?.generation).toBe(2);
  });

  it('два владельца одного символа с разной глубиной дают ОДИН источник', async () => {
    const { controller, probe } = makeController();

    await controller.reconcile(
      [
        { ownerKey: 'A', policy: orderbook(['BTC/USDT'], 10) },
        { ownerKey: 'B', policy: orderbook(['BTC/USDT'], 50) },
      ],
      ts(AT_1800_MS),
    );

    expect(probe.sources).toHaveLength(1);
    expect(controller.getStats().logicalClaims).toBe(2);
  });
});

describe('детерминированный порядок', () => {
  it('пулы отсортированы по exchangeId → marketType → stream', async () => {
    const { controller } = makeController();

    await controller.reconcile(
      [
        {
          ownerKey: 'A',
          policy: policy({
            exchangeIds: ['kraken', 'binance'],
            marketTypes: ['swap', 'spot'],
            orderbook: true,
            trades: true,
          }),
        },
      ],
      ts(AT_1800_MS),
    );

    expect(controller.listPools().map((pool) => pool.poolKey)).toEqual([
      'binance|spot|ORDERBOOK',
      'binance|spot|TRADES',
      'binance|swap|ORDERBOOK',
      'binance|swap|TRADES',
      'kraken|spot|ORDERBOOK',
      'kraken|spot|TRADES',
      'kraken|swap|ORDERBOOK',
      'kraken|swap|TRADES',
    ]);
  });

  it('владельцы пула отсортированы ASC', async () => {
    const { controller } = makeController();

    await controller.reconcile(
      [
        { ownerKey: 'strategy:z', policy: policy() },
        { ownerKey: 'collector:raw', policy: policy() },
        { ownerKey: 'strategy:a', policy: policy() },
      ],
      ts(AT_1800_MS),
    );

    expect(controller.listPools()[0]?.ownerKeys).toEqual([
      'collector:raw',
      'strategy:a',
      'strategy:z',
    ]);
  });
});
