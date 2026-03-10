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
      // TypeScript должен знать, что event: BookUpdatedEvent
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
    // Просто не должен падать
    await expect(bus.publish(makeBookEvent())).resolves.toBeUndefined();
  });

  it('логирует warn при превышении maxConcurrentPublish', async () => {
    const lowThresholdBus = new EventBus(logger, 1);
    // Создаём handler который не завершится сразу
    let resolveFirst!: () => void;
    const firstPromise = new Promise<void>((resolve) => { resolveFirst = resolve; });

    lowThresholdBus.subscribe('BOOK_UPDATED', async () => { await firstPromise; });

    // Начинаем первую публикацию (не await — должна зависнуть)
    const firstPublish = lowThresholdBus.publish(makeBookEvent());
    // Вторая публикация — должна сработать warn
    const secondPublish = lowThresholdBus.publish(makeBookEvent());

    // Разрешаем первый handler
    resolveFirst();
    await Promise.all([firstPublish, secondPublish]);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('high concurrent'),
      expect.any(Object),
    );
  });
});
