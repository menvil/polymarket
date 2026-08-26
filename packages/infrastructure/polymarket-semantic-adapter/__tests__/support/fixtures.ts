/**
 * Фикстуры и хелперы тестов semantic-адаптера.
 *
 * @remarks
 * Payload собираются в ТОЧНОЙ форме официального SDK (после zod-трансформа):
 * `{ topic, type, payload }` c camelCase-полями. Это принципиально — тесты
 * обязаны проверять контракт, который реально приходит на шину, а не
 * удобную выдуманную форму.
 */
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import { MessageMetadataGenerator } from '@polymarket/messages';
import { EventBus } from '@polymarket/event-bus';
import type { EventBusEvent } from '@polymarket/event-bus';
import { LiveClock } from '@polymarket/time';
import type { ILogger } from '@polymarket/logger';
import type { PolymarketExternalMessage } from '@polymarket/polymarket-v2';
import { PolymarketSemanticAdapter } from '../../src/index.js';

/** Реалистичные Polymarket-идентификаторы (77-значный CTF token id). */
export const MARKET_ID = '0xb9ed6ed97ce9146ef1a01278d5fc0f8bd04050a69f0a5568a66075b3c0c6b2c3';
export const TOKEN_A = '62305814799875783974460176688386847666394972778903073967664089920408777315323';
export const TOKEN_B = '10441275221001593584946124452200155982286783154165571724171962779156760933183';

/** Логгер, который ничего не пишет — тесты не зависят от вывода. */
export function silentLogger(): ILogger {
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

/** Один уровень стакана в source-native виде. */
export interface LevelFixture {
  readonly price: string;
  readonly size: string;
}

/** Одно изменение уровня в source-native виде. */
export interface PriceChangeFixture {
  readonly tokenId: string;
  readonly price: string;
  readonly size: string;
  readonly side: 'BUY' | 'SELL';
  readonly bestBid?: string | null;
  readonly bestAsk?: string | null;
  readonly hash?: string;
}

/** Собранный тестовый контур: raw-шина + Application-шина + адаптер. */
export interface Harness {
  readonly bus: ExternalMessageBus<PolymarketExternalMessage>;
  readonly eventBus: EventBus;
  readonly adapter: PolymarketSemanticAdapter;
  readonly metadataGenerator: MessageMetadataGenerator;
  /** Все события, дошедшие до Application-шины, в порядке доставки. */
  readonly published: EventBusEvent[];
  /** События одного типа. */
  eventsOfType<K extends EventBusEvent['type']>(type: K): Extract<EventBusEvent, { type: K }>[];
}

/**
 * Собирает тестовый контур и запускает адаптер.
 *
 * @param options - Опции сборки
 * @param options.autoStart - Запускать ли адаптер сразу (по умолчанию `true`)
 * @returns Собранный {@link Harness}
 *
 * @remarks
 * Используются НАСТОЯЩИЕ `ExternalMessageBus` и `EventBus`, а не моки:
 * проверяется реальное поведение доставки (веерная раздача, изоляция
 * обработчиков, порядок), ради которого адаптер и построен как независимый
 * потребитель шины.
 *
 * @example
 * ```typescript
 * const h = createHarness();
 * await publishBook(h, { tokenId: TOKEN_A, bids: [], asks: [] });
 * expect(h.eventsOfType('BOOK_DEPTH')).toHaveLength(1);
 * ```
 */
export function createHarness(options: { autoStart?: boolean } = {}): Harness {
  const bus = new ExternalMessageBus<PolymarketExternalMessage>();
  const eventBus = new EventBus(silentLogger());
  const metadataGenerator = new MessageMetadataGenerator({ clock: new LiveClock() });
  const published: EventBusEvent[] = [];

  for (const type of [
    'BOOK_DEPTH',
    'BOOK_UPDATED',
    'TRADE_RECEIVED',
    'TICK_SIZE_CHANGED',
    'REFERENCE_PRICE_UPDATED',
  ] as const) {
    eventBus.subscribe(type, (event) => {
      published.push(event);
    });
  }

  const adapter = new PolymarketSemanticAdapter({
    bus,
    eventBus,
    metadataGenerator,
    logger: silentLogger(),
  });
  if (options.autoStart !== false) {
    adapter.start();
  }

  return {
    bus,
    eventBus,
    adapter,
    metadataGenerator,
    published,
    eventsOfType<K extends EventBusEvent['type']>(type: K) {
      return published.filter((event): event is Extract<EventBusEvent, { type: K }> =>
        event.type === type,
      );
    },
  };
}

/**
 * Публикует наблюдение `book` на raw-шину.
 *
 * @param harness - Тестовый контур
 * @param params - Параметры снапшота
 * @param params.tokenId - Токен снапшота
 * @param params.bids - Уровни bid
 * @param params.asks - Уровни ask
 * @param params.market - Рынок (по умолчанию {@link MARKET_ID})
 * @param params.timestamp - Vendor-время (epoch ms), `null` — не прислано
 * @returns Опубликованное raw-сообщение (для проверок causality/иммутабельности)
 */
export async function publishBook(
  harness: Harness,
  params: {
    tokenId: string;
    bids: readonly LevelFixture[];
    asks: readonly LevelFixture[];
    market?: string;
    timestamp?: number | null;
  },
): Promise<PolymarketExternalMessage> {
  const message = {
    type: 'POLYMARKET_MARKET',
    payload: {
      topic: 'market',
      type: 'book',
      payload: {
        tokenId: params.tokenId,
        market: params.market ?? MARKET_ID,
        bids: params.bids,
        asks: params.asks,
        minOrderSize: '5',
        tickSize: '0.01',
        negRisk: false,
        lastTradePrice: '0.51',
        hash: 'book-hash',
        timestamp: params.timestamp === undefined ? 1_787_751_722_763 : params.timestamp,
      },
    },
    metadata: harness.metadataGenerator.nextRoot(),
  } as unknown as PolymarketExternalMessage;

  await harness.bus.publish(message);
  return message;
}

/**
 * Публикует наблюдение `price_change` на raw-шину.
 *
 * @param harness - Тестовый контур
 * @param params - Параметры события
 * @param params.changes - Изменения уровней (возможно, разных токенов)
 * @param params.market - Рынок (по умолчанию {@link MARKET_ID})
 * @param params.timestamp - Vendor-время (epoch ms)
 * @returns Опубликованное raw-сообщение
 */
export async function publishPriceChange(
  harness: Harness,
  params: {
    changes: readonly PriceChangeFixture[];
    market?: string;
    timestamp?: number | null;
  },
): Promise<PolymarketExternalMessage> {
  const message = {
    type: 'POLYMARKET_MARKET',
    payload: {
      topic: 'market',
      type: 'price_change',
      payload: {
        market: params.market ?? MARKET_ID,
        priceChanges: params.changes.map((change) => ({
          tokenId: change.tokenId,
          price: change.price,
          size: change.size,
          side: change.side,
          bestBid: change.bestBid,
          bestAsk: change.bestAsk,
          hash: change.hash,
        })),
        timestamp: params.timestamp === undefined ? 1_787_751_723_000 : params.timestamp,
      },
    },
    metadata: harness.metadataGenerator.nextRoot(),
  } as unknown as PolymarketExternalMessage;

  await harness.bus.publish(message);
  return message;
}

/**
 * Публикует наблюдение `last_trade_price` на raw-шину.
 *
 * @param harness - Тестовый контур
 * @param params - Параметры трейда
 * @returns Опубликованное raw-сообщение
 */
export async function publishLastTradePrice(
  harness: Harness,
  params: {
    tokenId: string;
    price: string;
    side: 'BUY' | 'SELL';
    size?: string | null;
    timestamp?: number | null;
    transactionHash?: string | null;
    market?: string;
  },
): Promise<PolymarketExternalMessage> {
  const message = {
    type: 'POLYMARKET_MARKET',
    payload: {
      topic: 'market',
      type: 'last_trade_price',
      payload: {
        tokenId: params.tokenId,
        market: params.market ?? MARKET_ID,
        price: params.price,
        side: params.side,
        size: params.size === undefined ? '12.5' : params.size,
        feeRateBps: '0',
        transactionHash: params.transactionHash ?? null,
        timestamp: params.timestamp === undefined ? 1_787_751_724_000 : params.timestamp,
      },
    },
    metadata: harness.metadataGenerator.nextRoot(),
  } as unknown as PolymarketExternalMessage;

  await harness.bus.publish(message);
  return message;
}

/**
 * Публикует наблюдение `tick_size_change` на raw-шину.
 *
 * @param harness - Тестовый контур
 * @param params - Параметры смены шага
 * @returns Опубликованное raw-сообщение
 */
export async function publishTickSizeChange(
  harness: Harness,
  params: {
    tokenId: string;
    newTickSize: string;
    oldTickSize?: string | null;
    timestamp?: number | null;
    market?: string;
  },
): Promise<PolymarketExternalMessage> {
  const message = {
    type: 'POLYMARKET_MARKET',
    payload: {
      topic: 'market',
      type: 'tick_size_change',
      payload: {
        tokenId: params.tokenId,
        market: params.market ?? MARKET_ID,
        oldTickSize: params.oldTickSize === undefined ? '0.01' : params.oldTickSize,
        newTickSize: params.newTickSize,
        timestamp: params.timestamp === undefined ? 1_787_751_725_000 : params.timestamp,
      },
    },
    metadata: harness.metadataGenerator.nextRoot(),
  } as unknown as PolymarketExternalMessage;

  await harness.bus.publish(message);
  return message;
}

/** Канал RTDS-наблюдения референсной цены. */
export type ReferenceChannel =
  | 'POLYMARKET_CRYPTO_BINANCE'
  | 'POLYMARKET_CRYPTO_CHAINLINK'
  | 'POLYMARKET_CRYPTO_CHAINLINK_TWAP';

/**
 * Публикует RTDS-наблюдение референсной цены на raw-шину.
 *
 * @param harness - Тестовый контур
 * @param params - Параметры наблюдения
 * @returns Опубликованное raw-сообщение
 */
export async function publishReferencePrice(
  harness: Harness,
  params: {
    channel: ReferenceChannel;
    symbol: string;
    value: string;
    timestamp?: number;
    windowSeconds?: 30 | 60;
  },
): Promise<PolymarketExternalMessage> {
  const topic =
    params.channel === 'POLYMARKET_CRYPTO_BINANCE'
      ? 'prices.crypto.binance'
      : params.channel === 'POLYMARKET_CRYPTO_CHAINLINK'
        ? 'prices.crypto.chainlink'
        : 'prices.crypto.chainlink.twap';

  const message = {
    type: params.channel,
    payload: {
      topic,
      type: 'update',
      timestamp: params.timestamp ?? 1_787_751_722_763,
      payload: {
        symbol: params.symbol,
        timestamp: params.timestamp ?? 1_787_751_721_000,
        value: params.value,
        ...(params.windowSeconds !== undefined ? { windowSeconds: params.windowSeconds } : {}),
      },
    },
    metadata: harness.metadataGenerator.nextRoot(),
  } as unknown as PolymarketExternalMessage;

  await harness.bus.publish(message);
  return message;
}
