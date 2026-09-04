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

describe('транспорт адресуется тройкой exchangeId + marketType + stream', () => {
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
    expect(index.get(cexTransportKey('binance', 'spot', 'ORDERBOOK'))).toEqual({
      orderbookMethod: 'watch',
      restartIntervalMs: 1_800_000,
    });
    expect(index.get(cexTransportKey('binance', 'future', 'ORDERBOOK'))).toEqual({
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
        const transport = transportIndex.get(
          cexTransportKey(
            config.exchangeId,
            config.marketType,
            config.watchOrderbook ? 'ORDERBOOK' : 'TRADES',
          ),
        );
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

describe('стакан и сделки одной биржи разнесены по разным профилям', () => {
  /** Конфигурация из ревью: два РАЗНЫХ физических потока одной пары. */
  const SPLIT_STREAMS = JSON.stringify({
    'binance-books': {
      exchangeId: 'binance', type: 'spot', symbols: ['BTC/USDT'],
      orderbook: true, trades: false, obMethod: 'fetch', restartIntervalMs: 600_000,
    },
    'binance-trades': {
      exchangeId: 'binance', type: 'spot', symbols: ['BTC/USDT'],
      orderbook: false, trades: true, restartIntervalMs: 900_000,
    },
  });

  it('РАЗНЫЕ restartIntervalMs у стакана и сделок конфликтом НЕ являются', () => {
    // `binance|spot|ORDERBOOK` и `binance|spot|TRADES` — разные ресурсы,
    // ключ-пара объявлял бы эту законную конфигурацию конфликтом.
    const exchanges = parseCexExchangeConfigs(SPLIT_STREAMS);
    expect(exchanges).toHaveLength(2);

    const index = buildCexTransportIndex(exchanges);
    expect(index.get(cexTransportKey('binance', 'spot', 'ORDERBOOK'))).toEqual({
      orderbookMethod: 'fetch',
      restartIntervalMs: 600_000,
    });
    // obMethod к потоку сделок отношения не имеет и туда не переносится.
    expect(index.get(cexTransportKey('binance', 'spot', 'TRADES'))).toEqual({
      restartIntervalMs: 900_000,
    });
  });

  it('каждый физический поток поднимается со СВОИМ транспортом', async () => {
    const exchanges = parseCexExchangeConfigs(SPLIT_STREAMS);
    const transportIndex = buildCexTransportIndex(exchanges);
    const created: RecordingSource[] = [];
    const controller = new CexSubscriptionController({
      sourceFactory: (config) => {
        const transport = transportIndex.get(
          cexTransportKey(
            config.exchangeId,
            config.marketType,
            config.watchOrderbook ? 'ORDERBOOK' : 'TRADES',
          ),
        );
        const source = new RecordingSource({ ...config, ...transport });
        created.push(source);
        return source;
      },
      logger: new CapturingLogger(),
    });

    const result = await controller.reconcile(buildCexDemands(exchanges), now());
    expect(result.failures).toEqual([]);

    const books = created.find((source) => source.config.watchOrderbook);
    const trades = created.find((source) => source.config.watchTrades);
    expect(books?.config.orderbookMethod).toBe('fetch');
    expect(books?.config.restartIntervalMs).toBe(600_000);
    expect(trades?.config.restartIntervalMs).toBe(900_000);
    // У потока сделок способа получения стакана нет вовсе.
    expect(trades?.config.orderbookMethod).toBeUndefined();

    await controller.close();
  });

  it('профиль с обоими потоками даёт транспорт обоим, obMethod только стакану', () => {
    const exchanges = parseCexExchangeConfigs(
      JSON.stringify({
        binance: {
          type: 'spot', symbols: ['BTC/USDT'],
          orderbook: true, trades: true, obMethod: 'watch', restartIntervalMs: 900_000,
        },
      }),
    );
    const index = buildCexTransportIndex(exchanges);
    expect(index.get(cexTransportKey('binance', 'spot', 'ORDERBOOK'))).toEqual({
      orderbookMethod: 'watch',
      restartIntervalMs: 900_000,
    });
    expect(index.get(cexTransportKey('binance', 'spot', 'TRADES'))).toEqual({
      restartIntervalMs: 900_000,
    });
  });
});

describe('конфликт транспорта на один физический пул', () => {
  it('два профиля одного exchangeId+marketType с РАЗНЫМ транспортом → fail-fast', () => {
    expect(() =>
      parseCexExchangeConfigs(
        JSON.stringify({
          'binance-a': {
            exchangeId: 'binance', type: 'spot', symbols: ['BTC/USDT'],
            orderbook: true, trades: false, obMethod: 'watch',
          },
          'binance-b': {
            exchangeId: 'binance', type: 'spot', symbols: ['ETH/USDT'],
            orderbook: true, trades: false, obMethod: 'fetch',
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
            orderbook: true, trades: false, restartIntervalMs: 600_000,
          },
          'binance-b': {
            exchangeId: 'binance', type: 'spot', symbols: ['ETH/USDT'],
            orderbook: true, trades: false, restartIntervalMs: 900_000,
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
    // Два потока (ORDERBOOK + TRADES) при одинаковом транспорте.
    expect(buildCexTransportIndex(exchanges).size).toBe(2);
  });
});
