/**
 * Runtime-тесты `ExternalMessageBus` — ТОЛЬКО facade/integration behavior.
 *
 * @remarks
 * Поведенческий контракт доставки (FIFO, fan-out, reentrancy, critical/
 * non-critical, overflow, drain-limit, идемпотентность close и т.д.) —
 * ответственность `@polymarket/message-bus` и покрыт его exhaustive
 * contract-suite (M-001). Здесь доказывается ровно одно: фасад корректно
 * ДЕЛЕГИРУЕТ движку и ничего не добавляет от себя — не трогает payload/
 * metadata и не переводит ошибки.
 */
import { describe, it, expect } from '@jest/globals';
import { LiveClock } from '@polymarket/time';
import { MessageMetadataGenerator } from '@polymarket/messages';
import type { MessageMetadata } from '@polymarket/messages';
import {
  MessageBus,
  createMessageBusPolicy,
  MessageBusClosedError,
  MessageBusOverflowError,
  MessageBusCriticalHandlerError,
} from '@polymarket/message-bus';
import type { ExternalMessage } from '@polymarket/external-messages';
import { ExternalMessageBus } from '../src/index.js';

/** Тестовый union внешних сообщений — source-native payload у каждого члена. */
type TestExternalMessage =
  | ExternalMessage<
      'TEST_BOOK',
      {
        readonly market: string;
        readonly bids: readonly number[];
      }
    >
  | ExternalMessage<
      'TEST_TRADE',
      {
        readonly price: number;
      }
    >;

type BookMessage = Extract<TestExternalMessage, { type: 'TEST_BOOK' }>;

/** Генератор metadata с детерминированным runId — как в composition root транспорта. */
function createGenerator(): MessageMetadataGenerator {
  return new MessageMetadataGenerator({ clock: new LiveClock(), runId: undefined });
}

/** Создаёт root-сообщение BOOK (внешнее наблюдение начинает causal chain). */
function bookMessage(generator: MessageMetadataGenerator, market: string, bids: readonly number[]): BookMessage {
  return {
    type: 'TEST_BOOK',
    payload: { market, bids },
    metadata: generator.nextRoot(),
  };
}

describe('ExternalMessageBus — delegation to MessageBus', () => {
  it('TEST 1: publish доставляет сообщение подписчику типа', async () => {
    const generator = createGenerator();
    const bus = new ExternalMessageBus<TestExternalMessage>();
    const received: BookMessage[] = [];

    bus.subscribe('TEST_BOOK', (message) => {
      received.push(message);
    });

    const message = bookMessage(generator, 'market-1', [0.41, 0.4]);
    const result = await bus.publish(message);

    expect(result.ok).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe('TEST_BOOK');
  });

  it('TEST 1b: сообщение не доставляется подписчикам ЧУЖОГО типа', async () => {
    const generator = createGenerator();
    const bus = new ExternalMessageBus<TestExternalMessage>();
    let trades = 0;

    bus.subscribe('TEST_TRADE', () => {
      trades++;
    });

    await bus.publish(bookMessage(generator, 'market-1', [0.4]));

    expect(trades).toBe(0);
  });

  it('TEST 2: payload и metadata доходят неизменными — тот же объект', async () => {
    const generator = createGenerator();
    const bus = new ExternalMessageBus<TestExternalMessage>();
    let handled: BookMessage | undefined;

    bus.subscribe('TEST_BOOK', (message) => {
      handled = message;
    });

    const message = bookMessage(generator, 'market-1', [0.41, 0.4]);
    await bus.publish(message);

    // Identity, а не структурное равенство: bus не клонирует и не сериализует
    expect(handled).toBe(message);
    expect(handled?.payload).toBe(message.payload);
    expect(handled?.metadata).toBe(message.metadata);
    expect(handled?.payload.bids).toEqual([0.41, 0.4]);
    expect(handled?.metadata.messageId).toBe(message.metadata.messageId);
  });

  it('TEST 2b: bus не генерирует и не добавляет metadata', async () => {
    const generator = createGenerator();
    const bus = new ExternalMessageBus<TestExternalMessage>();
    let handled: BookMessage | undefined;

    bus.subscribe('TEST_BOOK', (message) => {
      handled = message;
    });

    const message = bookMessage(generator, 'market-1', [0.4]);
    const metadataBefore: MessageMetadata = { ...message.metadata };
    await bus.publish(message);

    // Ни одно поле metadata не изменено; sequence остался тем, что выдал producer
    expect(handled?.metadata).toEqual(metadataBefore);
    expect(Object.keys(handled?.metadata ?? {}).sort()).toEqual(Object.keys(metadataBefore).sort());
    // Публикация не дёргает генератор: следующий sequence — ровно +1 к выданному
    expect(generator.nextRoot().sequence).toBe(metadataBefore.sequence + 1);
  });

  it('TEST 3: publishAll сохраняет порядок A → B → C', async () => {
    const generator = createGenerator();
    const bus = new ExternalMessageBus<TestExternalMessage>();
    const order: string[] = [];

    bus.subscribe('TEST_BOOK', (message) => {
      order.push(message.payload.market);
    });

    const result = await bus.publishAll([
      bookMessage(generator, 'A', [0.1]),
      bookMessage(generator, 'B', [0.2]),
      bookMessage(generator, 'C', [0.3]),
    ]);

    expect(result.ok).toBe(true);
    expect(order).toEqual(['A', 'B', 'C']);
  });

  it('TEST 4: getStats возвращает снимок underlying MessageBus', async () => {
    const generator = createGenerator();
    const bus = new ExternalMessageBus<TestExternalMessage>();

    const initial = bus.getStats();
    expect(initial).toEqual({
      queueSize: 0,
      subscribedTypes: 0,
      dispatching: false,
      closed: false,
      publishedTotal: 0,
      dispatchedTotal: 0,
      handlerErrorsTotal: 0,
      rejectedPublicationsTotal: 0,
    });

    bus.subscribe('TEST_BOOK', () => undefined);
    bus.subscribe('TEST_TRADE', () => undefined);
    await bus.publishAll([bookMessage(generator, 'A', [0.1]), bookMessage(generator, 'B', [0.2])]);

    const stats = bus.getStats();
    expect(stats.subscribedTypes).toBe(2);
    expect(stats.publishedTotal).toBe(2);
    expect(stats.dispatchedTotal).toBe(2);
    expect(stats.queueSize).toBe(0);
    expect(stats.dispatching).toBe(false);
    expect(stats.closed).toBe(false);
  });

  it('TEST 4b: stats фасада идентичны stats того же сценария на голом MessageBus', async () => {
    const facadeGenerator = createGenerator();
    const engineGenerator = createGenerator();
    const facade = new ExternalMessageBus<TestExternalMessage>();
    const engine = new MessageBus<TestExternalMessage>();

    facade.subscribe('TEST_BOOK', () => undefined);
    engine.subscribe('TEST_BOOK', () => undefined);
    await facade.publish(bookMessage(facadeGenerator, 'A', [0.1]));
    await engine.publish(bookMessage(engineGenerator, 'A', [0.1]));

    expect(facade.getStats()).toEqual(engine.getStats());
  });

  it('TEST 5: close закрывает bus — последующий publish возвращает MessageBusClosedError', async () => {
    const generator = createGenerator();
    const bus = new ExternalMessageBus<TestExternalMessage>();
    const received: string[] = [];

    bus.subscribe('TEST_BOOK', (message) => {
      received.push(message.payload.market);
    });

    await bus.publish(bookMessage(generator, 'A', [0.1]));
    const closeResult = await bus.close();
    expect(closeResult.ok).toBe(true);
    expect(bus.getStats().closed).toBe(true);

    const afterClose = await bus.publish(bookMessage(generator, 'B', [0.2]));
    expect(afterClose.ok).toBe(false);
    if (afterClose.ok) throw new Error('expected Err after close');
    expect(afterClose.error).toBeInstanceOf(MessageBusClosedError);

    const batchAfterClose = await bus.publishAll([bookMessage(generator, 'C', [0.3])]);
    expect(batchAfterClose.ok).toBe(false);
    expect(received).toEqual(['A']);
  });

  it('TEST 6: drain дообрабатывает очередь, накопленную во время dispatch', async () => {
    const generator = createGenerator();
    const bus = new ExternalMessageBus<TestExternalMessage>();
    const order: string[] = [];

    // Reentrant-публикация из handler-а ставит сообщение в очередь текущего drain
    bus.subscribe('TEST_BOOK', async (message) => {
      order.push(message.payload.market);
      if (message.payload.market === 'A') {
        await bus.publish(bookMessage(generator, 'A-reentrant', [0.9]));
      }
    });

    const result = await bus.publish(bookMessage(generator, 'A', [0.1]));
    expect(result.ok).toBe(true);
    expect(order).toEqual(['A', 'A-reentrant']);

    // Очередь пуста → drain на idle-bus возвращает Ok без работы
    const drainResult = await bus.drain();
    expect(drainResult.ok).toBe(true);
    expect(bus.getStats().queueSize).toBe(0);
  });

  it('TEST 7: disposer подписки отписывает и идемпотентен', async () => {
    const generator = createGenerator();
    const bus = new ExternalMessageBus<TestExternalMessage>();
    let count = 0;

    const unsubscribe = bus.subscribe('TEST_BOOK', () => {
      count++;
    });

    await bus.publish(bookMessage(generator, 'A', [0.1]));
    expect(count).toBe(1);

    unsubscribe();
    unsubscribe(); // идемпотентность
    expect(bus.getStats().subscribedTypes).toBe(0);

    await bus.publish(bookMessage(generator, 'B', [0.2]));
    expect(count).toBe(1);
  });
});

describe('ExternalMessageBus — canonical errors pass through without translation', () => {
  it('TEST 8a: overflow возвращается как canonical MessageBusOverflowError', async () => {
    const generator = createGenerator();
    // Очередь на 1 сообщение: во время dispatch первого второе уже не влезает
    const bus = new ExternalMessageBus<TestExternalMessage>({
      policy: createMessageBusPolicy({ queuePolicy: { maxQueueSize: 1 } }),
    });
    const rejections: unknown[] = [];

    bus.subscribe('TEST_BOOK', async (message) => {
      if (message.payload.market !== 'A') return;
      // Первая reentrant-публикация занимает единственный слот, вторая — отклоняется
      await bus.publish(bookMessage(generator, 'B', [0.2]));
      const overflow = await bus.publish(bookMessage(generator, 'C', [0.3]));
      if (!overflow.ok) rejections.push(overflow.error);
    });

    await bus.publish(bookMessage(generator, 'A', [0.1]));

    expect(rejections).toHaveLength(1);
    const error = rejections[0];
    expect(error).toBeInstanceOf(MessageBusOverflowError);
    // Никакой обёртки/переименования: наружу идёт ровно класс движка
    expect((error as MessageBusOverflowError).code).toBe('MESSAGE_BUS_OVERFLOW');
    expect((error as MessageBusOverflowError).maxQueueSize).toBe(1);
    expect((error as MessageBusOverflowError).messageType).toBe('TEST_BOOK');
  });

  it('TEST 8b: падение critical-подписчика возвращается как MessageBusCriticalHandlerError', async () => {
    const generator = createGenerator();
    const bus = new ExternalMessageBus<TestExternalMessage>();
    const handlerFailure = new Error('decoder invariant violated');

    bus.subscribe(
      'TEST_BOOK',
      () => {
        throw handlerFailure;
      },
      { critical: true },
    );

    const result = await bus.publish(bookMessage(generator, 'A', [0.1]));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected Err from critical handler');
    expect(result.error).toBeInstanceOf(MessageBusCriticalHandlerError);
    const error = result.error as MessageBusCriticalHandlerError;
    expect(error.messageType).toBe('TEST_BOOK');
    expect(error.originalError).toBe(handlerFailure);
  });
});

describe('ExternalMessageBus — composition, not inheritance', () => {
  it('фасад НЕ является MessageBus и не наследует его прототип', () => {
    const bus = new ExternalMessageBus<TestExternalMessage>();
    expect(bus).not.toBeInstanceOf(MessageBus);
    expect(Object.getPrototypeOf(ExternalMessageBus)).not.toBe(MessageBus);
  });

  it('публичная поверхность фасада — ровно шесть делегирующих методов', () => {
    const surface = Object.getOwnPropertyNames(ExternalMessageBus.prototype)
      .filter((name) => name !== 'constructor')
      .sort();
    expect(surface).toEqual(['close', 'drain', 'getStats', 'publish', 'publishAll', 'subscribe']);
  });

  it('конструктор принимает canonical MessageBusOptions без своих alias-типов', async () => {
    const generator = createGenerator();
    const overflows: number[] = [];
    const bus = new ExternalMessageBus<TestExternalMessage>({
      policy: createMessageBusPolicy({ queuePolicy: { maxQueueSize: 1 } }),
      observer: {
        onQueueOverflow: (context) => {
          overflows.push(context.attemptedCount);
        },
      },
    });

    bus.subscribe('TEST_BOOK', async (message) => {
      if (message.payload.market !== 'A') return;
      await bus.publish(bookMessage(generator, 'B', [0.2]));
      await bus.publish(bookMessage(generator, 'C', [0.3]));
    });

    await bus.publish(bookMessage(generator, 'A', [0.1]));

    // Policy и observer применены движком — фасад их не перехватывает
    expect(overflows).toEqual([1]);
  });
});
