/**
 * Тесты EventBus.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { ILogger } from '@polymarket/logger';
import { EventBus } from '../src/EventBus.js';
import type { ApplicationEvent } from '../src/events/index.js';
import type { BookUpdatedEvent } from '../src/events/market-events.js';

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
function makeBookEvent(sequenceNumber = 1): BookUpdatedEvent {
  return {
    type: 'BOOK_UPDATED',
    topOfBook: {
      bestBid: undefined,
      bestAsk: undefined,
      spread: undefined,
      bestBidSize: undefined,
      bestAskSize: undefined,
    },
    instrumentId: 'token-123' as BookUpdatedEvent['instrumentId'],
    marketId: 'market-abc' as BookUpdatedEvent['marketId'],
    sequenceNumber,
    timestamp: { toISO: () => '' } as BookUpdatedEvent['timestamp'],
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

  it('типобезопасно: BOOK_UPDATED handler получает BookUpdatedEvent', async () => {
    let receivedSeq = -1;
    bus.subscribe('BOOK_UPDATED', async (event) => {
      receivedSeq = event.sequenceNumber;
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

  it('unsubscribe последнего handler удаляет Set из Map', () => {
    const handlers = (bus as unknown as { _handlers: Map<string, Set<unknown>> })._handlers;

    const unsub = bus.subscribe('BOOK_UPDATED', async () => {});
    expect(handlers.has('BOOK_UPDATED')).toBe(true);

    unsub();
    expect(handlers.has('BOOK_UPDATED')).toBe(false);
  });

  it('publishAll доставляет события последовательно (порядок сохранён)', async () => {
    const order: number[] = [];
    bus.subscribe('BOOK_UPDATED', async (event) => {
      order.push(event.sequenceNumber);
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
    await expect(bus.publish(makeBookEvent())).resolves.toBeUndefined();
  });

  it('reentrancy: publishAll([A,B]) → handler(A) публикует C → порядок A→B→C', async () => {
    const order: number[] = [];
    bus.subscribe('BOOK_UPDATED', async (event) => {
      order.push(event.sequenceNumber);
      if (event.sequenceNumber === 1) {
        await bus.publish(makeBookEvent(3));
      }
    });

    await bus.publishAll([makeBookEvent(1), makeBookEvent(2)]);

    expect(order).toEqual([1, 2, 3]);
  });

  it('critical handler: ошибка пробрасывается из publish()', async () => {
    bus.subscribe(
      'BOOK_UPDATED',
      async () => { throw new Error('critical boom'); },
      { critical: true },
    );

    await expect(bus.publish(makeBookEvent())).rejects.toThrow('critical boom');
  });

  it('critical handler: все handlers запускаются до пробрасывания ошибки', async () => {
    let secondCalled = false;
    bus.subscribe(
      'BOOK_UPDATED',
      async () => { throw new Error('critical'); },
      { critical: true },
    );
    bus.subscribe('BOOK_UPDATED', async () => { secondCalled = true; });

    await expect(bus.publish(makeBookEvent())).rejects.toThrow('critical');
    expect(secondCalled).toBe(true);
  });

  it('critical handler: оставшиеся события в очереди дропаются', async () => {
    const processed: number[] = [];
    bus.subscribe('BOOK_UPDATED', async (event) => {
      if (event.sequenceNumber === 1) {
        throw new Error('critical');
      }
      processed.push(event.sequenceNumber);
    }, { critical: true });

    await expect(
      bus.publishAll([makeBookEvent(1), makeBookEvent(2), makeBookEvent(3)])
    ).rejects.toThrow('critical');

    expect(processed).toEqual([]); // seq=2 и seq=3 дропнуты
  });

  it('drain limit: бесконечный event loop останавливается через maxEventsPerDrain', async () => {
    const limitedBus = new EventBus(logger, 5);
    let count = 0;
    limitedBus.subscribe('BOOK_UPDATED', async (event) => {
      count++;
      // Бесконечная петля: каждый handler публикует следующее событие
      await limitedBus.publish(makeBookEvent(event.sequenceNumber + 1));
    });

    await limitedBus.publish(makeBookEvent(1));

    expect(count).toBe(5);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('drain limit exceeded'),
      expect.any(Object),
    );
  });
});
