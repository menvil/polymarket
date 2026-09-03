/**
 * Профили `cex-config.json`: одна биржа может быть описана НЕСКОЛЬКИМИ
 * профилями с разными видами рынка.
 *
 * @remarks
 * Проверяется стык конфигурации и composition root против НАСТОЯЩЕГО
 * `CexSubscriptionController`: он ключует физический пул тройкой
 * `exchangeId + marketType + stream` и запрещает дубликат `ownerKey` в одном
 * проходе. Composition root обязан сохранять обе идентичности — профиль
 * (владелец спроса) и пул (адрес транспорта), — а не схлопывать их в
 * `exchangeId`.
 */
import { describe, it, expect } from '@jest/globals';
import { CexSubscriptionController } from '@polymarket/cex-subscription-control';
import type { CexSubscriptionSource } from '@polymarket/cex-subscription-control';
import type { CexSourceConfig, CexSourceStats } from '@polymarket/cex-v2';
import { TimestampService } from '@polymarket/timestamp';
import type { Timestamp } from '@polymarket/timestamp';
import {
  buildCexDemands,
  buildCexTransportIndex,
  cexTransportKey,
  parseCexExchangeConfigs,
} from '../src/runtime/index.js';
import { CapturingLogger } from './helpers/fakes.js';

/** Конфигурация из задачи: одна биржа, два профиля с разными видами рынка. */
const TWO_PROFILES_ONE_EXCHANGE = JSON.stringify({
  'binance-spot': {
    exchangeId: 'binance',
    type: 'spot',
    symbols: ['BTC/USDT'],
    orderbook: true,
    trades: true,
  },
  'binance-futures': {
    exchangeId: 'binance',
    type: 'future',
    symbols: ['BTC/USDT'],
    orderbook: true,
    trades: true,
  },
});

function now(): Timestamp {
  const created = TimestampService.create(Date.parse('2026-09-01T18:00:00.000Z'));
  if (!created.ok) throw new Error('bad timestamp fixture');
  return created.value;
}

/** Источник-заглушка: только фиксирует конфигурацию, с которой создан. */
class RecordingSource implements CexSubscriptionSource {
  public hasFailed = false;
  public isClosed = false;
  public isRunning = false;

  public constructor(public readonly config: CexSourceConfig) {}

  public start(): void {
    this.isRunning = true;
  }
  public async close(): Promise<void> {
    this.isRunning = false;
    this.isClosed = true;
  }
  public getStats(): CexSourceStats {
    return { orderbookSnapshotFailures: 0, tradeSnapshotFailures: 0 };
  }
}

describe('два профиля одной биржи с разными marketType', () => {
  it('дают РАЗНЫЕ ownerKey, и reconcile не отвергает спрос', async () => {
    const exchanges = parseCexExchangeConfigs(TWO_PROFILES_ONE_EXCHANGE);
    const demands = buildCexDemands(exchanges);

    // Владелец — профиль, а не биржа: иначе оба спроса были бы
    // `collector:raw:binance`, и контроллер отверг бы проход целиком.
    expect(demands.map((demand) => demand.ownerKey)).toEqual([
      'collector:raw:binance-spot',
      'collector:raw:binance-futures',
    ]);
    expect(new Set(demands.map((demand) => demand.ownerKey)).size).toBe(2);

    const created: RecordingSource[] = [];
    const controller = new CexSubscriptionController({
      sourceFactory: (config) => {
        const source = new RecordingSource(config);
        created.push(source);
        return source;
      },
      logger: new CapturingLogger(),
    });

    const result = await controller.reconcile(demands, now());

    // Проход состоялся: spot и future — РАЗНЫЕ физические пулы.
    expect(result.failures).toEqual([]);
    expect(controller.getStats().owners).toBe(2);
    const marketTypes = created.map((source) => source.config.marketType).sort();
    expect(marketTypes).toEqual(['future', 'future', 'spot', 'spot']);

    await controller.close();
  });
});

describe('транспорт адресуется парой exchangeId + marketType', () => {
  it('spot и future одной биржи получают КАЖДЫЙ свой транспорт', async () => {
    const exchanges = parseCexExchangeConfigs(
      JSON.stringify({
        'binance-spot': {
          exchangeId: 'binance', type: 'spot', symbols: ['BTC/USDT'],
          orderbook: true, trades: false, obMethod: 'watch', restartIntervalMs: 1_800_000,
        },
        'binance-futures': {
          exchangeId: 'binance', type: 'future', symbols: ['BTC/USDT'],
          orderbook: true, trades: false, obMethod: 'fetch', restartIntervalMs: 600_000,
        },
      }),
    );

    const index = buildCexTransportIndex(exchanges);

    // Индекс по одной бирже схлопнул бы эти два значения в одно.
    expect(index.get(cexTransportKey('binance', 'spot'))).toEqual({
      orderbookMethod: 'watch',
      restartIntervalMs: 1_800_000,
    });
    expect(index.get(cexTransportKey('binance', 'future'))).toEqual({
      orderbookMethod: 'fetch',
      restartIntervalMs: 600_000,
    });
    expect(index.size).toBe(2);
  });

  it('каждый поднятый CexSource получает транспорт СВОЕГО пула', async () => {
    const exchanges = parseCexExchangeConfigs(
      JSON.stringify({
        'binance-spot': {
          exchangeId: 'binance', type: 'spot', symbols: ['BTC/USDT'],
          orderbook: true, trades: false, obMethod: 'watch', restartIntervalMs: 1_800_000,
        },
        'binance-futures': {
          exchangeId: 'binance', type: 'future', symbols: ['BTC/USDT'],
          orderbook: true, trades: false, obMethod: 'fetch', restartIntervalMs: 600_000,
        },
      }),
    );
    const transportIndex = buildCexTransportIndex(exchanges);
    const created: RecordingSource[] = [];
    const controller = new CexSubscriptionController({
      // Та же логика наложения транспорта, что и в composition root.
      sourceFactory: (config) => {
        const transport = transportIndex.get(cexTransportKey(config.exchangeId, config.marketType));
        const source = new RecordingSource({ ...config, ...transport });
        created.push(source);
        return source;
      },
      logger: new CapturingLogger(),
    });

    await controller.reconcile(buildCexDemands(exchanges), now());

    const spot = created.find((source) => source.config.marketType === 'spot');
    const future = created.find((source) => source.config.marketType === 'future');
    expect(spot?.config.orderbookMethod).toBe('watch');
    expect(spot?.config.restartIntervalMs).toBe(1_800_000);
    expect(future?.config.orderbookMethod).toBe('fetch');
    expect(future?.config.restartIntervalMs).toBe(600_000);

    await controller.close();
  });
});

describe('конфликт транспорта на один физический пул', () => {
  it('два профиля одного exchangeId+marketType с РАЗНЫМ транспортом → fail-fast', () => {
    expect(() =>
      parseCexExchangeConfigs(
        JSON.stringify({
          'binance-a': {
            exchangeId: 'binance', type: 'spot', symbols: ['BTC/USDT'],
            orderbook: true, trades: true, obMethod: 'watch',
          },
          'binance-b': {
            exchangeId: 'binance', type: 'spot', symbols: ['ETH/USDT'],
            orderbook: true, trades: true, obMethod: 'fetch',
          },
        }),
      ),
    ).toThrow('one physical pool cannot have two');
  });

  it('различие только в restartIntervalMs тоже конфликт', () => {
    expect(() =>
      parseCexExchangeConfigs(
        JSON.stringify({
          'binance-a': {
            exchangeId: 'binance', type: 'spot', symbols: ['BTC/USDT'],
            orderbook: true, trades: true, restartIntervalMs: 600_000,
          },
          'binance-b': {
            exchangeId: 'binance', type: 'spot', symbols: ['ETH/USDT'],
            orderbook: true, trades: true, restartIntervalMs: 900_000,
          },
        }),
      ),
    ).toThrow('one physical pool cannot have two');
  });

  it('одинаковый транспорт на один пул конфликтом НЕ является', () => {
    const exchanges = parseCexExchangeConfigs(
      JSON.stringify({
        'binance-a': {
          exchangeId: 'binance', type: 'spot', symbols: ['BTC/USDT'],
          orderbook: true, trades: true, obMethod: 'watch',
        },
        'binance-b': {
          exchangeId: 'binance', type: 'spot', symbols: ['ETH/USDT'],
          orderbook: true, trades: true, obMethod: 'watch',
        },
      }),
    );
    // Контроллер объединит символы этих профилей в один пул — это законно.
    expect(exchanges).toHaveLength(2);
    expect(buildCexTransportIndex(exchanges).size).toBe(1);
  });
});
