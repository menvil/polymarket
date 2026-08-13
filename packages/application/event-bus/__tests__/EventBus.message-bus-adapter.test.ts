/**
 * Тесты границы M-002: EventBus как фасад над MessageBus<ApplicationEvent>.
 *
 * @remarks
 * Проверяется именно adapter boundary, а не delivery-семантика (её фиксирует
 * M-000 contract-suite, работающий против нового движка без изменений):
 * - generic-ошибки движка НЕ протекают в публичный Result;
 * - публичные ошибки воспроизводят legacy-формат M-000 (message + context);
 * - legacy-параметры конструктора реально управляют policy движка;
 * - logging-адаптер воспроизводит исторические log-вызовы (и только их);
 * - getStats() отдаёт ровно legacy-shape без generic-счётчиков.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { ILogger } from '@polymarket/logger';
import { QueueOverflowError, CriticalHandlerError } from '@polymarket/errors/event-bus';
import {
  MessageBusOverflowError,
  MessageBusCriticalHandlerError,
  MessageBusDrainLimitError,
} from '@polymarket/message-bus';
import { EventBus } from '../src/EventBus.js';
import type { BookUpdatedEvent } from '../src/events/market-events.js';

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

function makeGate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe('EventBus ↔ MessageBus adapter boundary (M-002)', () => {
  let logger: ILogger;

  beforeEach(() => {
    logger = makeLogger();
  });

  describe('generic-ошибки не протекают наружу', () => {
    it('overflow одиночного publish → QueueOverflowError c legacy message/context, не MessageBusOverflowError', async () => {
      const bus = new EventBus(logger, 10_000, 1);
      const gate = makeGate();
      bus.subscribe('BOOK_UPDATED', async (event) => {
        if (event.sequenceNumber === 1) await gate.promise;
      });

      const first = bus.publish(makeBookEvent(1)); // in-flight
      await bus.publish(makeBookEvent(2)); // очередь [2] — лимит 1 исчерпан
      const overflow = await bus.publish(makeBookEvent(3));

      expect(overflow.ok).toBe(false);
      if (!overflow.ok) {
        expect(overflow.error).toBeInstanceOf(QueueOverflowError);
        expect(overflow.error).not.toBeInstanceOf(MessageBusOverflowError);
        // Дословный legacy-формат M-000
        expect(overflow.error.message).toBe('EventBus queue overflow (1): cannot enqueue BOOK_UPDATED');
        expect(overflow.error.context).toEqual({ maxQueueSize: 1, eventType: 'BOOK_UPDATED' });
      }

      gate.release();
      await first;
    });

    it('overflow batch publishAll → QueueOverflowError c legacy batch-context (eventCount)', async () => {
      const bus = new EventBus(logger, 10_000, 2);

      const result = await bus.publishAll([makeBookEvent(1), makeBookEvent(2), makeBookEvent(3)]);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(QueueOverflowError);
        expect(result.error).not.toBeInstanceOf(MessageBusOverflowError);
        expect(result.error.message).toBe('EventBus queue overflow (2): cannot enqueue 3 events');
        expect(result.error.context).toEqual({ maxQueueSize: 2, eventCount: 3 });
      }
    });

    it('drain-limit → QueueOverflowError c legacy message/context, не MessageBusDrainLimitError', async () => {
      const bus = new EventBus(logger, 3);
      bus.subscribe('BOOK_UPDATED', async (event) => {
        await bus.publish(makeBookEvent(event.sequenceNumber + 1)); // петля
      });

      const result = await bus.publish(makeBookEvent(1));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(QueueOverflowError);
        expect(result.error).not.toBeInstanceOf(MessageBusDrainLimitError);
        expect(result.error.message).toBe(
          'EventBus drain limit exceeded (3): possible infinite event loop. Remaining events dropped.',
        );
        expect(result.error.context).toEqual({ maxEventsPerDrain: 3 });
      }
    });

    it('critical-ошибка → CriticalHandlerError c eventType/originalError, не MessageBusCriticalHandlerError', async () => {
      const bus = new EventBus(logger);
      bus.subscribe('BOOK_UPDATED', () => { throw new Error('critical boom'); }, { critical: true });

      const result = await bus.publish(makeBookEvent());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(CriticalHandlerError);
        expect(result.error).not.toBeInstanceOf(MessageBusCriticalHandlerError);
        expect(result.error.message).toBe('EventBus critical handler threw during dispatch of BOOK_UPDATED');
        expect(result.error.context?.eventType).toBe('BOOK_UPDATED');
        expect((result.error.context?.originalError as Error).message).toBe('critical boom');
      }
    });

    it('handler бросает Application QueueOverflowError → это CriticalHandlerError, а не операционный overflow', async () => {
      const bus = new EventBus(logger);
      const thrown = new QueueOverflowError('thrown by handler');
      bus.subscribe('BOOK_UPDATED', () => { throw thrown; }, { critical: true });

      const result = await bus.publish(makeBookEvent());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(CriticalHandlerError);
        // Исходный объект сохранён в context.originalError по ссылке
        expect(result.error.context?.originalError).toBe(thrown);
      }
    });
  });

  describe('legacy-параметры конструктора управляют policy движка', () => {
    it('new EventBus(logger, 2, 3): drain-limit срабатывает на 2, overflow — при 3 ожидающих', async () => {
      const bus = new EventBus(logger, 2, 3);

      // maxEventsPerDrain = 2: петля обрывается после 2 обработанных событий
      let processedInLoop = 0;
      const unsubLoop = bus.subscribe('BOOK_UPDATED', async (event) => {
        processedInLoop++;
        await bus.publish(makeBookEvent(event.sequenceNumber + 1));
      });
      const drainLimited = await bus.publish(makeBookEvent(1));
      expect(drainLimited.ok).toBe(false);
      if (!drainLimited.ok) {
        expect(drainLimited.error.message).toContain('drain limit exceeded (2)');
      }
      expect(processedInLoop).toBe(2);
      unsubLoop();

      // maxQueueSize = 3: при in-flight событии в очередь помещаются 3 ожидающих, 4-е отклоняется
      const gate = makeGate();
      bus.subscribe('BOOK_UPDATED', async (event) => {
        if (event.sequenceNumber === 100) await gate.promise;
      });
      const first = bus.publish(makeBookEvent(100)); // in-flight, не считается
      expect((await bus.publish(makeBookEvent(101))).ok).toBe(true);
      expect((await bus.publish(makeBookEvent(102))).ok).toBe(true);
      expect((await bus.publish(makeBookEvent(103))).ok).toBe(true);
      const overflow = await bus.publish(makeBookEvent(104));
      expect(overflow.ok).toBe(false);
      if (!overflow.ok) {
        expect(overflow.error.message).toContain('queue overflow (3)');
      }

      gate.release();
      await first;
    });
  });

  describe('logging-адаптер', () => {
    it('non-critical падение → ровно legacy-вызов logger.error', async () => {
      const bus = new EventBus(logger);
      const boom = new Error('non-critical boom');
      bus.subscribe('BOOK_UPDATED', () => { throw boom; });

      await bus.publish(makeBookEvent());

      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith('EventBus handler threw an error', {
        err: boom,
        eventType: 'BOOK_UPDATED',
      });
    });

    it('primary critical НЕ логируется (возвращается caller-у, без duplicate-логов)', async () => {
      const bus = new EventBus(logger);
      bus.subscribe('BOOK_UPDATED', () => { throw new Error('critical'); }, { critical: true });

      const result = await bus.publish(makeBookEvent());

      expect(result.ok).toBe(false);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('дополнительная critical-ошибка → ровно legacy-вызов logger.error', async () => {
      const bus = new EventBus(logger);
      const second = new Error('second critical');
      bus.subscribe('BOOK_UPDATED', () => { throw new Error('first critical'); }, { critical: true });
      bus.subscribe('BOOK_UPDATED', () => { throw second; }, { critical: true });

      const result = await bus.publish(makeBookEvent());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect((result.error.context?.originalError as Error).message).toBe('first critical');
      }
      // Единственный лог — additional critical; primary в лог не попадает
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith('EventBus critical handler threw an additional error', {
        err: second,
        eventType: 'BOOK_UPDATED',
      });
    });
  });

  describe('publishAll([]) — legacy «kick» semantics', () => {
    it('пустой publishAll на idle-bus возобновляет обработку очереди, сохранённой после critical-сбоя', async () => {
      const bus = new EventBus(logger);
      const delivered: number[] = [];
      bus.subscribe('BOOK_UPDATED', (event) => { delivered.push(event.sequenceNumber); });
      const unsubFailing = bus.subscribe('BOOK_UPDATED', () => {
        throw new Error('critical');
      }, { critical: true });

      // Critical-сбой на A: очередь [B] сохранена, drain остановлен
      const batch = await bus.publishAll([makeBookEvent(1), makeBookEvent(2)]);
      expect(batch.ok).toBe(false);
      expect(delivered).toEqual([1]); // collector участвовал в fan-out события A
      expect(bus.getStats().queueSize).toBe(1);

      // Устраняем причину сбоя и «пинаем» очередь пустым batch-ем.
      // До M-002 publishAll([]) запускал drain — единственный публичный способ
      // поднять сохранённую очередь без новых событий (drain() у IEventBus нет).
      unsubFailing();
      const kick = await bus.publishAll([]);
      expect(kick.ok).toBe(true);
      expect(delivered).toEqual([1, 2]); // B доставлен
      expect(bus.getStats().queueSize).toBe(0);
    });

    it('пустой publishAll транслирует повторный critical-исход возобновлённого drain-а', async () => {
      const bus = new EventBus(logger);
      bus.subscribe('BOOK_UPDATED', (event) => {
        throw new Error(`critical on ${event.sequenceNumber}`);
      }, { critical: true });

      const batch = await bus.publishAll([makeBookEvent(1), makeBookEvent(2)]);
      expect(batch.ok).toBe(false);
      expect(bus.getStats().queueSize).toBe(1);

      // Kick возобновляет drain; сбой на 2 приходит как Application-ошибка
      const kick = await bus.publishAll([]);
      expect(kick.ok).toBe(false);
      if (!kick.ok) {
        expect(kick.error).toBeInstanceOf(CriticalHandlerError);
        expect(kick.error).not.toBeInstanceOf(MessageBusCriticalHandlerError);
        expect((kick.error.context?.originalError as Error).message).toBe('critical on 2');
      }
      expect(bus.getStats().queueSize).toBe(0);
    });

    it('publishAll([]) при активном drain → Ok сразу, не дожидаясь завершения текущего drain', async () => {
      const bus = new EventBus(logger);
      const delivered: number[] = [];
      let reentrantOk: boolean | undefined;
      let deliveredAtReturn: number[] | undefined;
      bus.subscribe('BOOK_UPDATED', async (event) => {
        delivered.push(event.sequenceNumber);
        if (event.sequenceNumber === 1) {
          // Legacy: при активном drain пустой batch — Ok сразу, без присоединения
          // к чужому drain (иначе reentrant-вызов ждал бы сам себя)
          const result = await bus.publishAll([]);
          reentrantOk = result.ok;
          deliveredAtReturn = [...delivered];
        }
      });

      const result = await bus.publishAll([makeBookEvent(1), makeBookEvent(2)]);

      expect(result.ok).toBe(true);
      expect(reentrantOk).toBe(true);
      // Kick вернулся ДО завершения текущего drain — событие 2 ещё не обработано
      expect(deliveredAtReturn).toEqual([1]);
      expect(delivered).toEqual([1, 2]);
    });
  });

  describe('getStats projection', () => {
    it('отдаёт ровно legacy-shape без generic-счётчиков движка', async () => {
      const bus = new EventBus(logger);
      bus.subscribe('BOOK_UPDATED', () => {});

      await bus.publish(makeBookEvent());
      const stats = bus.getStats();

      // Ровно три исторических поля — publishedTotal/dispatchedTotal/closed и
      // прочие generic-счётчики наружу не проецируются
      expect(Object.keys(stats).sort()).toEqual(['dispatching', 'queueSize', 'subscribedTypes']);
      expect(stats).toEqual({ queueSize: 0, subscribedTypes: 1, dispatching: false });
    });
  });
});
