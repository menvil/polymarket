/**
 * Тесты EventBus.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { MessageMetadataGenerator } from '@polymarket/messages';
import { unsafeRunId } from '@polymarket/ids';
import type { ILogger } from '@polymarket/logger';
import { QueueOverflowError, CriticalHandlerError } from '@polymarket/errors/event-bus';
import { EventBus } from '../src/EventBus.js';
import type { ApplicationEvent, BookUpdatedEvent } from '@polymarket/application-events';
// Compile-time check: если FillFailedEvent не экспортируется из @polymarket/application-events —
// typecheck падает (canonical источник event contracts после M-002.5).
import type { FillFailedEvent } from '@polymarket/application-events';

// Минимальный mock logger
function makeLogger(): ILogger {
  return {
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn().mockReturnThis(),
  } as unknown as ILogger;
}

// Minimal BookUpdatedEvent fixture

/** Детерминированный canonical-генератор metadata тестовых событий (M-003). */
const METADATA_GENERATOR = new MessageMetadataGenerator({
  clock: { now: () => new Date('2024-01-01T00:00:00.000Z') },
  runId: unsafeRunId('testrun1'),
});

function makeBookEvent(sequenceNumber = 1): BookUpdatedEvent {
  return {
    type: 'BOOK_UPDATED',
    payload: {
      topOfBook: {
        bestBid: undefined,
        bestAsk: undefined,
        spread: undefined,
        bestBidSize: undefined,
        bestAskSize: undefined,
      },
      instrumentId: 'token-123' as BookUpdatedEvent['payload']['instrumentId'],
      marketId: 'market-abc' as BookUpdatedEvent['payload']['marketId'],
      sequenceNumber,
      timestamp: { toISO: () => '' } as BookUpdatedEvent['payload']['timestamp'],
    },
    metadata: METADATA_GENERATOR.nextRoot(),
  };
}

describe('EventBus', () => {
  let logger: ILogger;
  let bus: EventBus;

  beforeEach(() => {
    logger = makeLogger();
    bus = new EventBus(logger);
  });

  it('доставляет событие всем подписчикам (fanout)', async () => {
    const calls: number[] = [];
    bus.subscribe('BOOK_UPDATED', async () => { calls.push(1); });
    bus.subscribe('BOOK_UPDATED', async () => { calls.push(2); });

    await bus.publish(makeBookEvent());

    expect(calls.sort()).toEqual([1, 2]);
  });

  it('доставляет корректные поля события handler-у (runtime delivery)', async () => {
    let receivedSeq = -1;
    bus.subscribe('BOOK_UPDATED', async (event) => {
      receivedSeq = event.payload.sequenceNumber;
    });

    await bus.publish(makeBookEvent(42));

    expect(receivedSeq).toBe(42);
  });

  it('unsubscribe удаляет handler', async () => {
    let callCount = 0;
    const unsub = bus.subscribe('BOOK_UPDATED', async () => { callCount++; });

    await bus.publish(makeBookEvent());
    unsub();
    await bus.publish(makeBookEvent());

    expect(callCount).toBe(1);
  });

  it('unsubscribe последнего handler типа отражается в getStats().subscribedTypes', () => {
    // Observable-контракт вместо проверки приватного хранилища: subscribedTypes считает
    // типы событий с хотя бы одним активным подписчиком.
    expect(bus.getStats().subscribedTypes).toBe(0);

    const unsubA = bus.subscribe('BOOK_UPDATED', async () => {});
    expect(bus.getStats().subscribedTypes).toBe(1);

    // Второй handler того же типа не увеличивает количество типов
    const unsubB = bus.subscribe('BOOK_UPDATED', async () => {});
    expect(bus.getStats().subscribedTypes).toBe(1);

    // Подписка на другой тип — увеличивает
    const unsubC = bus.subscribe('TRADE_RECEIVED', async () => {});
    expect(bus.getStats().subscribedTypes).toBe(2);

    // Отписка НЕ последнего handler типа — тип остаётся подписанным
    unsubA();
    expect(bus.getStats().subscribedTypes).toBe(2);

    // Отписка последнего handler типа — тип исчезает (нет утечки подписок)
    unsubB();
    expect(bus.getStats().subscribedTypes).toBe(1);
    unsubC();
    expect(bus.getStats().subscribedTypes).toBe(0);
  });

  it('publishAll доставляет события последовательно (порядок сохранён)', async () => {
    const order: number[] = [];
    bus.subscribe('BOOK_UPDATED', async (event) => {
      order.push(event.payload.sequenceNumber);
    });

    const events: ApplicationEvent[] = [
      makeBookEvent(1),
      makeBookEvent(2),
      makeBookEvent(3),
    ];
    await bus.publishAll(events);

    expect(order).toEqual([1, 2, 3]);
  });

  it('ошибка одного handler не останавливает других', async () => {
    let secondCalled = false;
    bus.subscribe('BOOK_UPDATED', async () => { throw new Error('handler error'); });
    bus.subscribe('BOOK_UPDATED', async () => { secondCalled = true; });

    await bus.publish(makeBookEvent());

    expect(secondCalled).toBe(true);
  });

  it('логирует error если handler выбросил исключение', async () => {
    bus.subscribe('BOOK_UPDATED', async () => { throw new Error('boom'); });

    await bus.publish(makeBookEvent());

    expect(logger.error).toHaveBeenCalled();
  });

  it('не вызывает handlers если подписчиков нет', async () => {
    const result = await bus.publish(makeBookEvent());
    expect(result).toEqual({ ok: true, value: undefined });
  });

  it('reentrancy: publishAll([A,B]) → handler(A) публикует C → порядок A→B→C', async () => {
    const order: number[] = [];
    bus.subscribe('BOOK_UPDATED', async (event) => {
      order.push(event.payload.sequenceNumber);
      if (event.payload.sequenceNumber === 1) {
        await bus.publish(makeBookEvent(3));
      }
    });

    await bus.publishAll([makeBookEvent(1), makeBookEvent(2)]);

    expect(order).toEqual([1, 2, 3]);
  });

  it('critical handler: ошибка возвращается как Err(CriticalHandlerError) из publish()', async () => {
    bus.subscribe(
      'BOOK_UPDATED',
      async () => { throw new Error('critical boom'); },
      { critical: true },
    );

    const result = await bus.publish(makeBookEvent());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(CriticalHandlerError);
      expect((result.error.context?.originalError as Error).message).toBe('critical boom');
    }
  });

  it('critical handler: все handlers запускаются до возврата ошибки', async () => {
    let secondCalled = false;
    bus.subscribe(
      'BOOK_UPDATED',
      async () => { throw new Error('critical'); },
      { critical: true },
    );
    bus.subscribe('BOOK_UPDATED', async () => { secondCalled = true; });

    const result = await bus.publish(makeBookEvent());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(CriticalHandlerError);
    expect(secondCalled).toBe(true);
  });

  it('critical handler: оставшиеся события в очереди сохраняются для следующего drain', async () => {
    const processed: number[] = [];
    bus.subscribe('BOOK_UPDATED', async (event) => {
      if (event.payload.sequenceNumber === 1) throw new Error('critical');
      processed.push(event.payload.sequenceNumber);
    }, { critical: true });

    // seq=2 остаётся в очереди после critical failure на seq=1
    const result = await bus.publishAll([makeBookEvent(1), makeBookEvent(2)]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(CriticalHandlerError);

    // следующий publish возобновляет drain: обрабатывает seq=2, потом seq=3
    await bus.publish(makeBookEvent(3));
    expect(processed).toEqual([2, 3]);
  });

  it('drain limit: бесконечный event loop возвращает Err(QueueOverflowError) и очищает очередь', async () => {
    const limitedBus = new EventBus(logger, 5);
    let count = 0;
    limitedBus.subscribe('BOOK_UPDATED', async (event) => {
      count++;
      await limitedBus.publish(makeBookEvent(event.payload.sequenceNumber + 1));
    });

    const result = await limitedBus.publish(makeBookEvent(1));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(QueueOverflowError);
      expect(result.error.message).toContain('drain limit exceeded');
    }
    expect(count).toBe(5);
  });

  it('queue overflow: publish возвращает Err(QueueOverflowError) если очередь переполнена', async () => {
    const tinyBus = new EventBus(logger, 10_000, 2);

    // handler зависает, чтобы очередь не опустошалась
    let resolveBlock!: () => void;
    const block = new Promise<void>((resolve) => { resolveBlock = resolve; });
    tinyBus.subscribe('BOOK_UPDATED', async () => { await block; });

    // первый publish — запускает drain, handler завис
    const first = tinyBus.publish(makeBookEvent(1));
    // второй и третий — в очередь (maxQueueSize=2, очередь уже содержит 0 сейчас,
    // но drain запущен поэтому push идёт в очередь)
    await tinyBus.publish(makeBookEvent(2)); // reentrant push, queue=[2]
    await tinyBus.publish(makeBookEvent(3)); // reentrant push, queue=[2,3]

    // четвёртый — переполнение
    const result = await tinyBus.publish(makeBookEvent(4));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(QueueOverflowError);
      expect(result.error.message).toContain('queue overflow');
    }

    resolveBlock();
    await first;
  });

  it('getStats возвращает корректное состояние', async () => {
    expect(bus.getStats()).toMatchObject({ queueSize: 0, subscribedTypes: 0, dispatching: false });

    let resolveBlock!: () => void;
    const block = new Promise<void>((resolve) => { resolveBlock = resolve; });
    bus.subscribe('BOOK_UPDATED', async () => { await block; });

    const inflight = bus.publish(makeBookEvent());
    // drain запущен: dispatching=true, queue пуста (событие уже dequeued в dispatch)
    expect(bus.getStats()).toMatchObject({ queueSize: 0, subscribedTypes: 1, dispatching: true });

    resolveBlock();
    await inflight;
    expect(bus.getStats()).toMatchObject({ queueSize: 0, subscribedTypes: 1, dispatching: false });
  });

  it('двойной unsubscribe не падает (idempotent)', async () => {
    const unsub = bus.subscribe('BOOK_UPDATED', async () => {});
    unsub(); // удаляет Set из Map
    expect(() => unsub()).not.toThrow(); // второй вызов — Set уже нет
  });

  it('reentrancy: publishAll из handler-а ставит события в очередь корректно', async () => {
    const order: number[] = [];
    bus.subscribe('BOOK_UPDATED', async (event) => {
      order.push(event.payload.sequenceNumber);
      if (event.payload.sequenceNumber === 1) {
        // publishAll из handler'а — должно встать в очередь ПОСЛЕ текущего drain
        await bus.publishAll([makeBookEvent(10), makeBookEvent(11)]);
      }
    });

    await bus.publishAll([makeBookEvent(1), makeBookEvent(2)]);

    expect(order).toEqual([1, 2, 10, 11]);
  });

  it('queue overflow: publishAll возвращает Err(QueueOverflowError) если batch превышает лимит', async () => {
    const tinyBus = new EventBus(logger, 10_000, 2);

    const result = await tinyBus.publishAll([makeBookEvent(1), makeBookEvent(2), makeBookEvent(3)]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(QueueOverflowError);
      expect(result.error.message).toContain('queue overflow');
    }
  });

  it('два critical handler-а оба падают: первая ошибка возвращается, вторая логируется', async () => {
    bus.subscribe(
      'BOOK_UPDATED',
      async () => { throw new Error('first critical'); },
      { critical: true },
    );
    bus.subscribe(
      'BOOK_UPDATED',
      async () => { throw new Error('second critical'); },
      { critical: true },
    );

    const result = await bus.publish(makeBookEvent());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(CriticalHandlerError);
      expect((result.error.context?.originalError as Error).message).toBe('first critical');
    }
    expect(logger.error).toHaveBeenCalledWith(
      'EventBus critical handler threw an additional error',
      expect.objectContaining({ eventType: 'BOOK_UPDATED' }),
    );
  });

  it('publishAll([]) резолвится Ok без побочных эффектов', async () => {
    let handlerCalled = false;
    bus.subscribe('BOOK_UPDATED', async () => { handlerCalled = true; });

    const result = await bus.publishAll([]);
    expect(result).toEqual({ ok: true, value: undefined });
    expect(handlerCalled).toBe(false);
    expect(bus.getStats().dispatching).toBe(false);
  });

  it('subscribe с explicit critical:false ведёт себя как non-critical (ошибка логируется)', async () => {
    let secondCalled = false;
    bus.subscribe(
      'BOOK_UPDATED',
      async () => { throw new Error('non-critical explicit'); },
      { critical: false },
    );
    bus.subscribe('BOOK_UPDATED', async () => { secondCalled = true; });

    await bus.publish(makeBookEvent());

    expect(secondCalled).toBe(true);
    expect(logger.error).toHaveBeenCalled();
  });

  it('FillFailedEvent экспортируется из @polymarket/application-events (compile-time)', () => {
    // Реальная проверка — compile-time: import type { FillFailedEvent } вверху файла.
    // Если FillFailedEvent убрать из exports @polymarket/application-events,
    // typecheck упадёт на строке импорта.
    // Здесь фиксируем контракт структуры типа: тип должен иметь поле type.
    const _check: FillFailedEvent['type'] = 'FILL_FAILED';
    expect(_check).toBe('FILL_FAILED');
  });
});
