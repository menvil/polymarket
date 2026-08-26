/**
 * Трекер граничных наблюдений settlement-потока (MR-B PART 27/28).
 *
 * @remarks
 * Проверяется ровно то, ради чего трекер существует и чем ограничен:
 * сигнал «граница пересечена» по VENDOR-времени, разделение окон и
 * ограниченность памяти. Никакой конверсии значений здесь быть не должно —
 * они хранятся точной десятичной строкой источника.
 */
import { describe, expect, it, beforeEach } from '@jest/globals';
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import { MessageMetadataGenerator } from '@polymarket/messages';
import { LiveClock } from '@polymarket/time';
import type { ILogger } from '@polymarket/logger';
import { PolymarketTwapObservations } from '../src/index.js';
import type {
  CryptoPricesChainlinkTwapEvent,
  PolymarketExternalMessage,
  PolymarketTwapRtdsFeed,
} from '../src/index.js';

const FEED_60: PolymarketTwapRtdsFeed = {
  topic: 'prices.crypto.chainlink.twap',
  symbol: 'btc/usd',
  windowSeconds: 60,
};
const FEED_30: PolymarketTwapRtdsFeed = {
  topic: 'prices.crypto.chainlink.twap',
  symbol: 'btc/usd',
  windowSeconds: 30,
};
const EXPIRY_MS = Date.parse('2026-08-26T13:50:00.000Z');

let bus: ExternalMessageBus<PolymarketExternalMessage>;
let generator: MessageMetadataGenerator;

/** Молчаливый логгер: трекер не должен ничего требовать от контекста. */
function silentLogger(): ILogger {
  const sink: ILogger = {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
    child: () => sink,
  };
  return sink;
}

function createTracker(
  config?: ConstructorParameters<typeof PolymarketTwapObservations>[1],
): PolymarketTwapObservations {
  const tracker = new PolymarketTwapObservations({ bus, logger: silentLogger() }, config);
  tracker.start();
  return tracker;
}

async function publish(
  overrides: Partial<{
    symbol: string;
    value: string;
    windowSeconds: 30 | 60;
    timestamp: number;
  }> = {},
): Promise<void> {
  const timestamp = overrides.timestamp ?? EXPIRY_MS;
  const event = {
    topic: 'prices.crypto.chainlink.twap',
    type: 'update',
    timestamp: timestamp + 1_895,
    payload: {
      symbol: overrides.symbol ?? 'btc/usd',
      timestamp,
      value: overrides.value ?? '78400.701754893592952832',
      windowSeconds: overrides.windowSeconds ?? 60,
    },
  } as CryptoPricesChainlinkTwapEvent;
  const result = await bus.publish({
    type: 'POLYMARKET_CRYPTO_CHAINLINK_TWAP',
    payload: event,
    metadata: generator.nextRoot(),
  });
  expect(result.ok).toBe(true);
}

beforeEach(() => {
  bus = new ExternalMessageBus<PolymarketExternalMessage>();
  generator = new MessageMetadataGenerator({ clock: new LiveClock() });
});

describe('сигнал границы по VENDOR-времени (PART 23)', () => {
  it('наблюдение ДО границы не считается граничным', async () => {
    const tracker = createTracker();
    await publish({ timestamp: EXPIRY_MS - 1_000 });

    expect(tracker.hasObservationAtOrAfter(FEED_60, EXPIRY_MS)).toBe(false);
  });

  it('наблюдение РОВНО на границе засчитывается', async () => {
    const tracker = createTracker();
    await publish({ timestamp: EXPIRY_MS });

    expect(tracker.hasObservationAtOrAfter(FEED_60, EXPIRY_MS)).toBe(true);
  });

  it('наблюдение ПОСЛЕ границы засчитывается', async () => {
    const tracker = createTracker();
    await publish({ timestamp: EXPIRY_MS + 1_000 });

    expect(tracker.hasObservationAtOrAfter(FEED_60, EXPIRY_MS)).toBe(true);
  });

  it('фид без единого наблюдения границы не пересекал', () => {
    const tracker = createTracker();
    expect(tracker.hasObservationAtOrAfter(FEED_60, EXPIRY_MS)).toBe(false);
  });

  it('наблюдение с меньшим timestamp не «откатывает» уже достигнутую границу', async () => {
    const tracker = createTracker();
    await publish({ timestamp: EXPIRY_MS });
    await publish({ timestamp: EXPIRY_MS - 5_000 }); // out-of-order доставка

    expect(tracker.hasObservationAtOrAfter(FEED_60, EXPIRY_MS)).toBe(true);
  });
});

describe('окна и символы разделены (PART 14/20)', () => {
  it('наблюдение окна 30 не закрывает границу для окна 60', async () => {
    const tracker = createTracker();
    await publish({ windowSeconds: 30, timestamp: EXPIRY_MS });

    expect(tracker.hasObservationAtOrAfter(FEED_30, EXPIRY_MS)).toBe(true);
    expect(tracker.hasObservationAtOrAfter(FEED_60, EXPIRY_MS)).toBe(false);
  });

  it('наблюдение другого символа не закрывает границу', async () => {
    const tracker = createTracker();
    await publish({ symbol: 'eth/usd', timestamp: EXPIRY_MS });

    expect(tracker.hasObservationAtOrAfter(FEED_60, EXPIRY_MS)).toBe(false);
  });

  it('observationAt отдаёт значение ТОЧНОЙ секунды и не подменяет соседней', async () => {
    const tracker = createTracker();
    await publish({ timestamp: EXPIRY_MS - 1_000, value: '1.0' });
    await publish({ timestamp: EXPIRY_MS, value: '2.0' });

    expect(tracker.observationAt(FEED_60, EXPIRY_MS)).toEqual({
      timestampMs: EXPIRY_MS,
      value: '2.0',
    });
    expect(tracker.observationAt(FEED_60, EXPIRY_MS + 1_000)).toBeUndefined();
  });

  it('значение сохраняется ТОЧНОЙ строкой источника (без Number-конверсии)', async () => {
    const tracker = createTracker();
    await publish({ timestamp: EXPIRY_MS, value: '78400.701754893592952832' });

    expect(tracker.observationAt(FEED_60, EXPIRY_MS)?.value).toBe('78400.701754893592952832');
  });
});

describe('память ограничена (PART 28)', () => {
  it('буфер фида не растёт дальше потолка', async () => {
    const tracker = createTracker({ maxObservationsPerFeed: 5 });
    for (let i = 0; i < 50; i++) {
      await publish({ timestamp: EXPIRY_MS + i * 1_000, value: String(i) });
    }

    expect(tracker.getStats()).toMatchObject({ feeds: 1, buffered: 5, accepted: 50 });
    // Вытеснены СТАРЫЕ наблюдения, свежие — на месте
    expect(tracker.observationAt(FEED_60, EXPIRY_MS)).toBeUndefined();
    expect(tracker.observationAt(FEED_60, EXPIRY_MS + 49_000)?.value).toBe('49');
  });

  it('молчащий дольше TTL фид выселяется целиком', async () => {
    const tracker = createTracker({ feedTtlMs: 60_000 });
    await publish({ symbol: 'eth/usd', timestamp: EXPIRY_MS });
    expect(tracker.getStats().feeds).toBe(1);

    // Другой фид уходит далеко вперёд по vendor-времени
    await publish({ symbol: 'btc/usd', timestamp: EXPIRY_MS + 600_000 });

    expect(tracker.getStats().feeds).toBe(1);
    expect(
      tracker.hasObservationAtOrAfter(
        { topic: 'prices.crypto.chainlink.twap', symbol: 'eth/usd', windowSeconds: 60 },
        EXPIRY_MS,
      ),
    ).toBe(false);
  });

  it('единственный фид не выселяет сам себя', async () => {
    const tracker = createTracker({ feedTtlMs: 1 });
    await publish({ timestamp: EXPIRY_MS });
    await publish({ timestamp: EXPIRY_MS + 600_000 });

    expect(tracker.getStats().feeds).toBe(1);
    expect(tracker.hasObservationAtOrAfter(FEED_60, EXPIRY_MS)).toBe(true);
  });

  it('непригодное наблюдение считается rejected и не попадает в буфер', async () => {
    const tracker = createTracker();
    await publish({ timestamp: Number.NaN });
    await publish({ value: '' });

    expect(tracker.getStats()).toMatchObject({ accepted: 0, rejected: 2, buffered: 0 });
  });
});

describe('lifecycle', () => {
  it('start идемпотентен: одно наблюдение учитывается один раз', async () => {
    const tracker = createTracker();
    tracker.start();
    await publish({ timestamp: EXPIRY_MS });

    expect(tracker.getStats().accepted).toBe(1);
  });

  it('close отписывает от bus и освобождает буферы', async () => {
    const tracker = createTracker();
    await publish({ timestamp: EXPIRY_MS });
    tracker.close();

    await publish({ timestamp: EXPIRY_MS + 1_000 });

    expect(tracker.getStats()).toMatchObject({ feeds: 0, buffered: 0, accepted: 1 });
    expect(tracker.hasObservationAtOrAfter(FEED_60, EXPIRY_MS)).toBe(false);
    tracker.close(); // идемпотентен
  });

  it('не подписан до start(): наблюдения проходят мимо', async () => {
    const tracker = new PolymarketTwapObservations({ bus, logger: silentLogger() });
    await publish({ timestamp: EXPIRY_MS });

    expect(tracker.getStats().accepted).toBe(0);
  });
});
