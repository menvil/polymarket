/**
 * Contract-тесты EventBus — фиксация observable behavior перед заменой движка (M-000).
 *
 * @remarks
 * Этот suite — compatibility gate для будущей generic-реализации (M-001): любая
 * следующая реализация Application EventBus считается drop-in replacement только
 * если проходит эти тесты без изменений.
 *
 * Проверяется ТОЛЬКО observable behavior: результаты `publish()`/`publishAll()`,
 * порядок и состав доставки, `getStats()`, логирование ошибок. Никаких обращений
 * к приватным полям и структурам хранения (Map/Set/Array) — внутренности реализации
 * не являются контрактом.
 *
 * Полное словесное описание контракта: `packages/application/event-bus/README.md`.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { MessageMetadataGenerator } from '@polymarket/messages';
import { unsafeRunId } from '@polymarket/ids';
import type { ILogger } from '@polymarket/logger';
import type { Result } from '@polymarket/result';
import { QueueOverflowError, CriticalHandlerError } from '@polymarket/errors/event-bus';
import { EventBus } from '../src/EventBus.js';
import type { BookUpdatedEvent, TradeReceivedEvent } from '@polymarket/application-events';

/** Минимальный mock logger (child возвращает себя же — как в EventBus.test.ts). */
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

/** Минимальная фикстура BookUpdatedEvent (handlers тестов не читают VO-поля). */

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

/** Минимальная фикстура TradeReceivedEvent — второй тип для проверки routing. */
function makeTradeEvent(): TradeReceivedEvent {
  return {
    type: 'TRADE_RECEIVED',
    payload: {
      instrumentId: 'token-123' as TradeReceivedEvent['payload']['instrumentId'],
      price: {} as unknown as TradeReceivedEvent['payload']['price'],
      size: {} as unknown as TradeReceivedEvent['payload']['size'],
      side: 'BUY' as unknown as TradeReceivedEvent['payload']['side'],
      timestamp: { toISO: () => '' } as TradeReceivedEvent['payload']['timestamp'],
    },
    metadata: METADATA_GENERATOR.nextRoot(),
  };
}

/** Управляемый барьер: handler блокируется на promise до вызова release(). */
function makeGate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

/** Пропускает macrotask — даёт параллельным handlers стартовать/осесть. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('EventBus contract', () => {
  let logger: ILogger;
  let bus: EventBus;

  beforeEach(() => {
    logger = makeLogger();
    bus = new EventBus(logger);
  });

  describe('delivery / routing', () => {
    it('handler получает только события своего типа (exact type routing)', async () => {
      const bookSeen: string[] = [];
      const tradeSeen: string[] = [];
      bus.subscribe('BOOK_UPDATED', (event) => { bookSeen.push(event.type); });
      bus.subscribe('TRADE_RECEIVED', (event) => { tradeSeen.push(event.type); });

      await bus.publish(makeBookEvent());
      await bus.publish(makeTradeEvent());

      expect(bookSeen).toEqual(['BOOK_UPDATED']);
      expect(tradeSeen).toEqual(['TRADE_RECEIVED']);
    });

    it('sync handler получает событие, publish → Ok', async () => {
      let seenSeq = -1;
      bus.subscribe('BOOK_UPDATED', (event) => { seenSeq = event.payload.sequenceNumber; });

      const result = await bus.publish(makeBookEvent(7));

      expect(result.ok).toBe(true);
      expect(seenSeq).toBe(7);
    });

    it('publish без подписчиков → Ok, bus остаётся idle', async () => {
      const result = await bus.publish(makeBookEvent());
      expect(result).toEqual({ ok: true, value: undefined });
      expect(bus.getStats()).toMatchObject({ queueSize: 0, subscribedTypes: 0, dispatching: false });
    });
  });

  describe('fan-out', () => {
    it('handlers одного события запускаются параллельно: B стартует до завершения заблокированного A', async () => {
      const gate = makeGate();
      let aStarted = false;
      let aFinished = false;
      let bStarted = false;
      bus.subscribe('BOOK_UPDATED', async () => { aStarted = true; await gate.promise; aFinished = true; });
      bus.subscribe('BOOK_UPDATED', async () => { bStarted = true; });

      const publishPromise = bus.publish(makeBookEvent());
      let publishSettled = false;
      void publishPromise.then(() => { publishSettled = true; });
      await tick();

      // B стартовал, пока A ещё заблокирован — это доказательство параллельного fan-out,
      // а не последовательного вызова handlers.
      expect(aStarted).toBe(true);
      expect(bStarted).toBe(true);
      expect(aFinished).toBe(false);
      // publish не завершается, пока не завершены ВСЕ handlers события
      expect(publishSettled).toBe(false);

      gate.release();
      const result = await publishPromise;
      expect(result.ok).toBe(true);
      expect(aFinished).toBe(true);
    });

    it('следующее событие не диспетчеризуется до завершения fan-out текущего (FIFO между событиями)', async () => {
      const gate = makeGate();
      const delivered: number[] = [];
      bus.subscribe('BOOK_UPDATED', async (event) => {
        delivered.push(event.payload.sequenceNumber);
        if (event.payload.sequenceNumber === 1) await gate.promise;
      });

      const publishPromise = bus.publishAll([makeBookEvent(1), makeBookEvent(2)]);
      await tick();

      // Событие 1 в обработке и заблокировано — событие 2 не должно начать доставляться
      expect(delivered).toEqual([1]);

      gate.release();
      const result = await publishPromise;
      expect(result.ok).toBe(true);
      expect(delivered).toEqual([1, 2]);
    });
  });

  describe('reentrancy', () => {
    it('reentrant publish подтверждает enqueue (Ok), а не завершение обработки события', async () => {
      const delivered: number[] = [];
      let reentrantResult: Result<void, QueueOverflowError | CriticalHandlerError> | undefined;
      let deliveredAtReentrantReturn: number[] | undefined;

      bus.subscribe('BOOK_UPDATED', async (event) => {
        delivered.push(event.payload.sequenceNumber);
        if (event.payload.sequenceNumber === 1) {
          // await внутри активного drain НЕ дожидается обработки события 2 —
          // иначе был бы self-deadlock (drain ждал бы сам себя).
          reentrantResult = await bus.publish(makeBookEvent(2));
          deliveredAtReentrantReturn = [...delivered];
        }
      });

      const result = await bus.publish(makeBookEvent(1));

      expect(result.ok).toBe(true);
      // Ok reentrant-вызова означает успешную постановку в очередь...
      expect(reentrantResult?.ok).toBe(true);
      // ...в момент возврата событие 2 ещё НЕ обработано...
      expect(deliveredAtReentrantReturn).toEqual([1]);
      // ...оно обработано текущим (outer) drain до завершения outer publish.
      expect(delivered).toEqual([1, 2]);
    });
  });

  describe('non-critical failures', () => {
    it('sync throw non-critical handler-а: sibling выполняется, ошибка логируется, publish → Ok', async () => {
      let siblingCalled = false;
      bus.subscribe('BOOK_UPDATED', () => { throw new Error('sync boom'); });
      bus.subscribe('BOOK_UPDATED', async () => { siblingCalled = true; });

      const result = await bus.publish(makeBookEvent());

      expect(result.ok).toBe(true);
      expect(siblingCalled).toBe(true);
      expect(logger.error).toHaveBeenCalledWith(
        'EventBus handler threw an error',
        expect.objectContaining({ eventType: 'BOOK_UPDATED' }),
      );
    });

    it('non-critical ошибка не останавливает drain: следующее событие обрабатывается, результат Ok', async () => {
      const delivered: number[] = [];
      bus.subscribe('BOOK_UPDATED', async (event) => {
        if (event.payload.sequenceNumber === 1) throw new Error('boom on first');
        delivered.push(event.payload.sequenceNumber);
      });

      const result = await bus.publishAll([makeBookEvent(1), makeBookEvent(2)]);

      expect(result.ok).toBe(true);
      expect(delivered).toEqual([2]);
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('critical failures', () => {
    it('sync throw critical handler-а → Err(CriticalHandlerError)', async () => {
      bus.subscribe(
        'BOOK_UPDATED',
        () => { throw new Error('sync critical'); },
        { critical: true },
      );

      const result = await bus.publish(makeBookEvent());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(CriticalHandlerError);
        expect((result.error.context?.originalError as Error).message).toBe('sync critical');
      }
    });

    it('CriticalHandlerError несёт eventType и originalError в context', async () => {
      bus.subscribe(
        'BOOK_UPDATED',
        async () => { throw new Error('critical with context'); },
        { critical: true },
      );

      const result = await bus.publish(makeBookEvent());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.eventType).toBe('BOOK_UPDATED');
        expect((result.error.context?.originalError as Error).message).toBe('critical with context');
      }
    });

    it('событие с critical failure считается завершённым — не возвращается в очередь и не replay-ится', async () => {
      let firstEventDeliveries = 0;
      const delivered: number[] = [];
      bus.subscribe('BOOK_UPDATED', async (event) => {
        if (event.payload.sequenceNumber === 1) {
          firstEventDeliveries++;
          throw new Error('critical');
        }
        delivered.push(event.payload.sequenceNumber);
      }, { critical: true });

      const first = await bus.publish(makeBookEvent(1));
      expect(first.ok).toBe(false);

      // Если бы событие 1 переигрывалось — этот publish снова вернул бы Err
      const second = await bus.publish(makeBookEvent(2));
      expect(second.ok).toBe(true);
      expect(firstEventDeliveries).toBe(1);
      expect(delivered).toEqual([2]);
    });

    it('QueueOverflowError, брошенная critical handler-ом, классифицируется как CriticalHandlerError', async () => {
      // Ошибка ЧУЖОГО кода (подписчика) не должна маскироваться под операционное
      // состояние самого bus-а, даже если подписчик бросил QueueOverflowError.
      bus.subscribe(
        'BOOK_UPDATED',
        () => { throw new QueueOverflowError('thrown by handler'); },
        { critical: true },
      );

      const result = await bus.publish(makeBookEvent());

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(CriticalHandlerError);
        expect(result.error.context?.originalError).toBeInstanceOf(QueueOverflowError);
      }
    });
  });

  describe('queue overflow', () => {
    it('отклонённое событие не попадает в очередь, существующая очередь сохраняется и обрабатывается', async () => {
      const tinyBus = new EventBus(logger, 10_000, 2);
      const gate = makeGate();
      const delivered: number[] = [];
      tinyBus.subscribe('BOOK_UPDATED', async (event) => {
        delivered.push(event.payload.sequenceNumber);
        if (event.payload.sequenceNumber === 1) await gate.promise;
      });

      const first = tinyBus.publish(makeBookEvent(1)); // событие 1 in-flight, handler заблокирован
      const r2 = await tinyBus.publish(makeBookEvent(2)); // очередь [2]
      const r3 = await tinyBus.publish(makeBookEvent(3)); // очередь [2,3] — лимит достигнут
      expect(r2.ok).toBe(true);
      expect(r3.ok).toBe(true);
      expect(tinyBus.getStats().queueSize).toBe(2);

      const overflow = await tinyBus.publish(makeBookEvent(4));
      expect(overflow.ok).toBe(false);
      if (!overflow.ok) expect(overflow.error).toBeInstanceOf(QueueOverflowError);
      // Отклонённый publish не тронул уже стоящие в очереди события
      expect(tinyBus.getStats().queueSize).toBe(2);

      gate.release();
      const firstResult = await first;
      expect(firstResult.ok).toBe(true);
      // 1..3 доставлены, отклонённое 4 — нет
      expect(delivered).toEqual([1, 2, 3]);
    });

    it('maxQueueSize считает ожидающую очередь, а не in-flight событие', async () => {
      const tinyBus = new EventBus(logger, 10_000, 1);
      const gate = makeGate();
      tinyBus.subscribe('BOOK_UPDATED', async (event) => {
        if (event.payload.sequenceNumber === 1) await gate.promise;
      });

      const first = tinyBus.publish(makeBookEvent(1)); // dequeued, in-flight; очередь пуста
      // Если бы in-flight событие считалось — этот publish уже переполнил бы лимит 1
      const r2 = await tinyBus.publish(makeBookEvent(2)); // очередь [2]
      expect(r2.ok).toBe(true);

      const r3 = await tinyBus.publish(makeBookEvent(3)); // 1 ожидающее + 1 новое > 1
      expect(r3.ok).toBe(false);

      gate.release();
      await first;
    });

    it('publishAll: batch, превышающий лимит, отклоняется атомарно — all or nothing', async () => {
      const tinyBus = new EventBus(logger, 10_000, 2);
      const delivered: number[] = [];
      tinyBus.subscribe('BOOK_UPDATED', async (event) => { delivered.push(event.payload.sequenceNumber); });

      const result = await tinyBus.publishAll([makeBookEvent(1), makeBookEvent(2), makeBookEvent(3)]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeInstanceOf(QueueOverflowError);

      // Ни одно событие batch-а не enqueue-нулось и не доставлено
      expect(tinyBus.getStats().queueSize).toBe(0);
      expect(delivered).toEqual([]);

      // Bus работоспособен: следующий publish доставляет ровно своё событие
      const next = await tinyBus.publish(makeBookEvent(9));
      expect(next.ok).toBe(true);
      expect(delivered).toEqual([9]);
    });

    it('publishAll overflow не задевает уже стоящие в очереди события', async () => {
      const tinyBus = new EventBus(logger, 10_000, 2);
      const gate = makeGate();
      const delivered: number[] = [];
      tinyBus.subscribe('BOOK_UPDATED', async (event) => {
        delivered.push(event.payload.sequenceNumber);
        if (event.payload.sequenceNumber === 1) await gate.promise;
      });

      const first = tinyBus.publish(makeBookEvent(1)); // in-flight
      await tinyBus.publish(makeBookEvent(2)); // очередь [2]

      const batch = await tinyBus.publishAll([makeBookEvent(3), makeBookEvent(4)]); // 1+2 > 2
      expect(batch.ok).toBe(false);
      // Очередь [2] сохранена, события batch-а не добавлены даже частично
      expect(tinyBus.getStats().queueSize).toBe(1);

      gate.release();
      await first;
      expect(delivered).toEqual([1, 2]);
    });
  });

  describe('drain-loop guard', () => {
    it('drain limit: Err(QueueOverflowError), очередь петли очищена, bus снова работоспособен', async () => {
      const limitedBus = new EventBus(logger, 3);
      const unsubLoop = limitedBus.subscribe('BOOK_UPDATED', async (event) => {
        // Бесконечная петля: каждое событие порождает следующее
        await limitedBus.publish(makeBookEvent(event.payload.sequenceNumber + 1));
      });

      const result = await limitedBus.publish(makeBookEvent(1));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(QueueOverflowError);
        expect(result.error.message).toContain('drain limit exceeded');
      }
      // События петли — артефакт бага, а не легитимный backlog: очередь очищена
      expect(limitedBus.getStats().queueSize).toBe(0);
      expect(limitedBus.getStats().dispatching).toBe(false);

      // Убираем зациклившийся handler — bus продолжает работать
      unsubLoop();
      const delivered: number[] = [];
      limitedBus.subscribe('BOOK_UPDATED', async (event) => { delivered.push(event.payload.sequenceNumber); });
      const next = await limitedBus.publish(makeBookEvent(100));
      expect(next.ok).toBe(true);
      expect(delivered).toEqual([100]);
      expect(limitedBus.getStats()).toMatchObject({ queueSize: 0, subscribedTypes: 1, dispatching: false });
    });
  });

  describe('subscription mutation during dispatch', () => {
    it('unsubscribe во время fan-out: handler доигрывает текущее событие, но не получает следующие', async () => {
      const bCalls: number[] = [];
      let unsubB!: () => void;
      // A синхронно отписывает B в начале fan-out текущего события
      bus.subscribe('BOOK_UPDATED', () => { unsubB(); });
      unsubB = bus.subscribe('BOOK_UPDATED', async (event) => { bCalls.push(event.payload.sequenceNumber); });

      await bus.publish(makeBookEvent(1));
      // Snapshot подписчиков сформирован до запуска handlers — B участвует в текущем fan-out
      expect(bCalls).toEqual([1]);

      await bus.publish(makeBookEvent(2));
      // Следующие события отписанный B уже не получает
      expect(bCalls).toEqual([1]);
    });

    it('subscribe во время dispatch: новый handler не получает текущее событие, получает следующее (в том же drain)', async () => {
      const lateCalls: number[] = [];
      bus.subscribe('BOOK_UPDATED', (event) => {
        if (event.payload.sequenceNumber === 1) {
          bus.subscribe('BOOK_UPDATED', async (nextEvent) => { lateCalls.push(nextEvent.payload.sequenceNumber); });
        }
      });

      await bus.publishAll([makeBookEvent(1), makeBookEvent(2)]);

      // Событие 1 (dispatch которого уже начался) новому подписчику не доставлено,
      // событие 2 из того же drain — доставлено.
      expect(lateCalls).toEqual([2]);
    });
  });

  describe('diagnostics (getStats)', () => {
    it('queueSize считает только ожидающие события; in-flight событие не входит', async () => {
      const gate = makeGate();
      bus.subscribe('BOOK_UPDATED', async (event) => {
        if (event.payload.sequenceNumber === 1) await gate.promise;
      });

      const first = bus.publish(makeBookEvent(1)); // in-flight
      await bus.publish(makeBookEvent(2));
      await bus.publish(makeBookEvent(3));

      expect(bus.getStats()).toMatchObject({ queueSize: 2, subscribedTypes: 1, dispatching: true });

      gate.release();
      const result = await first;
      expect(result.ok).toBe(true);
      expect(bus.getStats()).toMatchObject({ queueSize: 0, subscribedTypes: 1, dispatching: false });
    });
  });
});
