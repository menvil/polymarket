/**
 * Type-contract тесты `ExternalMessageBus`.
 *
 * @remarks
 * Проверки compile-time (typecheck/ts-jest): typed subscribe сужает handler до
 * КОНКРЕТНОГО члена union (независимо для каждого типа), canonical-конверт
 * обязателен на границе publish, а `IExternalMessageBus` остаётся чистым
 * alias-ом к generic `IMessageBus` (никаких собственных technical types).
 * Runtime-ассерты минимальны.
 */
import { describe, it, expect } from '@jest/globals';
import { unsafeMessageId, unsafeRunId } from '@polymarket/ids';
import { TimestampService } from '@polymarket/timestamp';
import type { MessageMetadata } from '@polymarket/messages';
import type {
  IMessageBus,
  MessageBusDrainError,
  MessageBusPublishError,
  MessageBusStats,
  MessageHandler,
} from '@polymarket/message-bus';
import type { ExternalMessage, AnyExternalMessage } from '@polymarket/external-messages';
import { ExternalMessageBus } from '../src/index.js';
import type { IExternalMessageBus } from '../src/index.js';

/** Детерминированная fixture-metadata для compile-time проверок. */
function fixtureMetadata(): MessageMetadata {
  const createdAt = TimestampService.create(1786668087123);
  if (!createdAt.ok) throw createdAt.error;
  const messageId = unsafeMessageId('testrun1-1786668087-123-000-000-000000001');
  return {
    messageId,
    runId: unsafeRunId('testrun1'),
    sequence: 1,
    createdAt: createdAt.value,
    createdAtUnixSeconds: 1786668087,
    millisecondOfSecond: 123,
    microsecondOfMillisecond: 0,
    nanosecondOfMicrosecond: 0,
    correlationId: messageId,
  };
}

type TestExternalMessage =
  | ExternalMessage<
      'BOOK',
      {
        readonly marketId: string;
        readonly bids: readonly number[];
      }
    >
  | ExternalMessage<
      'TRADE',
      {
        readonly price: number;
      }
    >;

describe('typed subscribe narrowing', () => {
  it('handler BOOK сужен до члена BOOK (compile-time)', () => {
    const bus = new ExternalMessageBus<TestExternalMessage>();

    bus.subscribe('BOOK', (message) => {
      const bids: readonly number[] = message.payload.bids;
      const marketId: string = message.payload.marketId;
      const type: 'BOOK' = message.type;
      void bids;
      void marketId;
      void type;

      // @ts-expect-error — price принадлежит члену TRADE, не BOOK
      void message.payload.price;
    });

    expect(bus.getStats().subscribedTypes).toBe(1);
  });

  it('handler TRADE сужается независимо (compile-time)', () => {
    const bus = new ExternalMessageBus<TestExternalMessage>();

    bus.subscribe('TRADE', (message) => {
      const price: number = message.payload.price;
      const type: 'TRADE' = message.type;
      void price;
      void type;

      // @ts-expect-error — bids принадлежит члену BOOK, не TRADE
      void message.payload.bids;
    });

    expect(bus.getStats().subscribedTypes).toBe(1);
  });

  it('metadata в handler остаётся canonical MessageMetadata (compile-time)', () => {
    const bus = new ExternalMessageBus<TestExternalMessage>();

    bus.subscribe('BOOK', (message) => {
      const metadata: MessageMetadata = message.metadata;
      void metadata;

      // @ts-expect-error — source в canonical metadata не существует (живёт в payload)
      void message.metadata.source;
    });

    expect(bus.getStats().subscribedTypes).toBe(1);
  });

  it('неизвестный discriminator отклоняется (compile-time)', () => {
    const bus = new ExternalMessageBus<TestExternalMessage>();

    // @ts-expect-error — 'UNKNOWN' не входит в union типов контура
    bus.subscribe('UNKNOWN', () => undefined);

    expect(bus.getStats().subscribedTypes).toBe(1);
  });

  it('handler-контракт — canonical MessageHandler суженного члена (compile-time)', () => {
    const bus = new ExternalMessageBus<TestExternalMessage>();
    const handler: MessageHandler<Extract<TestExternalMessage, { type: 'TRADE' }>> = (message) => {
      void message.payload.price;
    };

    const unsubscribe: () => void = bus.subscribe('TRADE', handler);
    unsubscribe();

    expect(bus.getStats().subscribedTypes).toBe(0);
  });
});

describe('publish boundary requires canonical envelope', () => {
  it('canonical-сообщение принимается (compile-time)', async () => {
    const bus = new ExternalMessageBus<TestExternalMessage>();
    const result = await bus.publish({
      type: 'BOOK',
      payload: { marketId: 'market-1', bids: [0.4] },
      metadata: fixtureMetadata(),
    });
    expect(result.ok).toBe(true);
  });

  it('flat-сообщение отклоняется (compile-time)', async () => {
    const bus = new ExternalMessageBus<TestExternalMessage>();
    // @ts-expect-error — flat shape: нет payload/metadata
    await bus.publish({ type: 'BOOK', marketId: 'market-1', bids: [0.4] });
    expect(bus.getStats().publishedTotal).toBe(1);
  });

  it('сообщение без metadata отклоняется — bus её не подставляет (compile-time)', async () => {
    const bus = new ExternalMessageBus<TestExternalMessage>();
    // @ts-expect-error — metadata обязательна: identity существует ДО delivery
    await bus.publish({ type: 'BOOK', payload: { marketId: 'market-1', bids: [0.4] } });
    expect(bus.getStats().publishedTotal).toBe(1);
  });

  it('чужой payload отклоняется (compile-time)', async () => {
    const bus = new ExternalMessageBus<TestExternalMessage>();
    await bus.publish({
      type: 'BOOK',
      // @ts-expect-error — payload TRADE не подходит члену BOOK
      payload: { price: 0.4 },
      metadata: fixtureMetadata(),
    });
    expect(bus.getStats().publishedTotal).toBe(1);
  });

  it('publishAll принимает readonly-массив членов union (compile-time)', async () => {
    const bus = new ExternalMessageBus<TestExternalMessage>();
    const messages: readonly TestExternalMessage[] = [
      { type: 'BOOK', payload: { marketId: 'm', bids: [0.4] }, metadata: fixtureMetadata() },
      { type: 'TRADE', payload: { price: 0.4 }, metadata: fixtureMetadata() },
    ];
    const result = await bus.publishAll(messages);
    expect(result.ok).toBe(true);
  });
});

describe('IExternalMessageBus = alias generic IMessageBus', () => {
  it('порт взаимозаменяем с IMessageBus в обе стороны (compile-time)', () => {
    const bus = new ExternalMessageBus<TestExternalMessage>();

    const asExternalPort: IExternalMessageBus<TestExternalMessage> = bus;
    const asGenericPort: IMessageBus<TestExternalMessage> = asExternalPort;
    const backToExternal: IExternalMessageBus<TestExternalMessage> = asGenericPort;

    expect(backToExternal.getStats().closed).toBe(false);
  });

  it('technical types контура — canonical типы движка (compile-time)', async () => {
    const bus: IExternalMessageBus<TestExternalMessage> = new ExternalMessageBus<TestExternalMessage>();

    const publishResult: { ok: boolean } | { ok: false; error: MessageBusPublishError } = await bus.publish({
      type: 'TRADE',
      payload: { price: 0.4 },
      metadata: fixtureMetadata(),
    });
    const drainResult: { ok: boolean } | { ok: false; error: MessageBusDrainError } = await bus.drain();
    const stats: MessageBusStats = bus.getStats();

    expect(stats.publishedTotal).toBe(1);
    expect(publishResult.ok).toBe(true);
    expect(drainResult.ok).toBe(true);
  });

  it('generic-параметр ограничен AnyExternalMessage (compile-time)', () => {
    // Конкретный external union допустим:
    type Ok = IExternalMessageBus<TestExternalMessage>;
    const widen = (bus: Ok): IExternalMessageBus<AnyExternalMessage> =>
      bus as unknown as IExternalMessageBus<AnyExternalMessage>;
    void widen;

    // @ts-expect-error — flat-сообщение не удовлетворяет bound-у контура
    type _InvalidPort = IExternalMessageBus<{ readonly type: 'FLAT'; readonly x: number }>;

    // @ts-expect-error — тот же bound действует и на реализацию
    type _InvalidBus = ExternalMessageBus<{ readonly type: 'FLAT'; readonly x: number }>;

    expect(true).toBe(true);
  });
});
