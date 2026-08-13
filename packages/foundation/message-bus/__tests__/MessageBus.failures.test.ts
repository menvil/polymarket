/**
 * Тесты семантики ошибок MessageBus: non-critical/critical обработчики, overflow,
 * drain-limit, изоляция observer'а.
 */
import { describe, it, expect } from '@jest/globals';
import {
  MessageBus,
  createMessageBusPolicy,
  MessageBusOverflowError,
  MessageBusCriticalHandlerError,
  MessageBusDrainLimitError,
} from '@polymarket/message-bus';
import type {
  MessageBusObserver,
  HandlerErrorContext,
  QueueOverflowContext,
  DrainLimitContext,
} from '@polymarket/message-bus';

type TestMessage =
  | { readonly type: 'HEARTBEAT'; readonly seq: number }
  | { readonly type: 'ITEM_ADDED'; readonly itemId: string };

function heartbeat(seq: number): TestMessage {
  return { type: 'HEARTBEAT', seq };
}

function makeGate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

/** Observer, накапливающий все уведомления для ассертов. */
function makeCapturingObserver(): {
  observer: MessageBusObserver;
  handlerErrors: HandlerErrorContext[];
  overflows: QueueOverflowContext[];
  drainLimits: DrainLimitContext[];
} {
  const handlerErrors: HandlerErrorContext[] = [];
  const overflows: QueueOverflowContext[] = [];
  const drainLimits: DrainLimitContext[] = [];
  return {
    observer: {
      onHandlerError: (context) => { handlerErrors.push(context); },
      onQueueOverflow: (context) => { overflows.push(context); },
      onDrainLimitExceeded: (context) => { drainLimits.push(context); },
    },
    handlerErrors,
    overflows,
    drainLimits,
  };
}

describe('MessageBus failures', () => {
  describe('non-critical handler', () => {
    it('sync throw: sibling выполняется, publish → Ok, observer уведомлён, счётчик растёт', async () => {
      const captured = makeCapturingObserver();
      const bus = new MessageBus<TestMessage>({ observer: captured.observer });
      let siblingCalled = false;
      bus.subscribe('HEARTBEAT', () => { throw new Error('sync boom'); });
      bus.subscribe('HEARTBEAT', () => { siblingCalled = true; });

      const result = await bus.publish(heartbeat(1));

      expect(result.ok).toBe(true);
      expect(siblingCalled).toBe(true);
      expect(captured.handlerErrors).toHaveLength(1);
      expect(captured.handlerErrors[0]).toMatchObject({
        messageType: 'HEARTBEAT',
        critical: false,
        primaryCritical: false,
      });
      expect((captured.handlerErrors[0].originalError as Error).message).toBe('sync boom');
      expect(bus.getStats().handlerErrorsTotal).toBe(1);
    });

    it('async rejection: sibling выполняется, publish → Ok, observer уведомлён', async () => {
      const captured = makeCapturingObserver();
      const bus = new MessageBus<TestMessage>({ observer: captured.observer });
      let siblingCalled = false;
      bus.subscribe('HEARTBEAT', async () => { throw new Error('async boom'); });
      bus.subscribe('HEARTBEAT', async () => { siblingCalled = true; });

      const result = await bus.publish(heartbeat(1));

      expect(result.ok).toBe(true);
      expect(siblingCalled).toBe(true);
      expect(captured.handlerErrors).toHaveLength(1);
      expect((captured.handlerErrors[0].originalError as Error).message).toBe('async boom');
    });

    it('ошибка на первом сообщении не останавливает drain — следующее доставляется', async () => {
      const bus = new MessageBus<TestMessage>();
      const delivered: number[] = [];
      bus.subscribe('HEARTBEAT', (message) => {
        if (message.seq === 1) throw new Error('boom on first');
        delivered.push(message.seq);
      });

      const result = await bus.publishAll([heartbeat(1), heartbeat(2)]);

      expect(result.ok).toBe(true);
      expect(delivered).toEqual([2]);
    });
  });

  describe('critical handler', () => {
    it('sync throw → Err(MessageBusCriticalHandlerError) с messageType и originalError', async () => {
      const bus = new MessageBus<TestMessage>();
      bus.subscribe('HEARTBEAT', () => { throw new Error('sync critical'); }, { critical: true });

      const result = await bus.publish(heartbeat(1));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(MessageBusCriticalHandlerError);
        const error = result.error as MessageBusCriticalHandlerError;
        expect(error.messageType).toBe('HEARTBEAT');
        expect((error.originalError as Error).message).toBe('sync critical');
      }
    });

    it('async rejection → Err(MessageBusCriticalHandlerError)', async () => {
      const bus = new MessageBus<TestMessage>();
      bus.subscribe('HEARTBEAT', async () => { throw new Error('async critical'); }, { critical: true });

      const result = await bus.publish(heartbeat(1));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(MessageBusCriticalHandlerError);
        expect(((result.error as MessageBusCriticalHandlerError).originalError as Error).message)
          .toBe('async critical');
      }
    });

    it('siblings текущего сообщения завершаются несмотря на critical-ошибку', async () => {
      const bus = new MessageBus<TestMessage>();
      let siblingCalled = false;
      bus.subscribe('HEARTBEAT', () => { throw new Error('critical'); }, { critical: true });
      bus.subscribe('HEARTBEAT', async () => { siblingCalled = true; });

      const result = await bus.publish(heartbeat(1));

      expect(result.ok).toBe(false);
      expect(siblingCalled).toBe(true);
    });

    it('упавшее сообщение не replay-ится, оставшаяся очередь сохраняется и обрабатывается раньше новых', async () => {
      const bus = new MessageBus<TestMessage>();
      let firstDeliveries = 0;
      const delivered: number[] = [];
      bus.subscribe('HEARTBEAT', (message) => {
        if (message.seq === 1) {
          firstDeliveries++;
          throw new Error('critical');
        }
        delivered.push(message.seq);
      }, { critical: true });

      const batch = await bus.publishAll([heartbeat(1), heartbeat(2)]);
      expect(batch.ok).toBe(false);

      // Очередь [2] сохранена; publish(3) возобновляет drain: сначала 2, потом 3
      const next = await bus.publish(heartbeat(3));
      expect(next.ok).toBe(true);
      expect(delivered).toEqual([2, 3]);
      expect(firstDeliveries).toBe(1);
    });

    it('две critical-ошибки: первая каноническая, вторая уходит observer-у, обе в счётчике', async () => {
      const captured = makeCapturingObserver();
      const bus = new MessageBus<TestMessage>({ observer: captured.observer });
      let secondSettled = false;
      bus.subscribe('HEARTBEAT', () => { throw new Error('first critical'); }, { critical: true });
      bus.subscribe('HEARTBEAT', async () => {
        secondSettled = true;
        throw new Error('second critical');
      }, { critical: true });

      const result = await bus.publish(heartbeat(1));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(((result.error as MessageBusCriticalHandlerError).originalError as Error).message)
          .toBe('first critical');
      }
      expect(secondSettled).toBe(true);
      expect(bus.getStats().handlerErrorsTotal).toBe(2);

      const criticals = captured.handlerErrors.filter((context) => context.critical);
      expect(criticals).toHaveLength(2);
      expect(criticals[0]).toMatchObject({ primaryCritical: true });
      expect((criticals[0].originalError as Error).message).toBe('first critical');
      expect(criticals[1]).toMatchObject({ primaryCritical: false });
      expect((criticals[1].originalError as Error).message).toBe('second critical');
    });

    it('MessageBusOverflowError, брошенная critical-обработчиком, не маскируется под overflow bus', async () => {
      const bus = new MessageBus<TestMessage>();
      bus.subscribe('HEARTBEAT', () => {
        throw new MessageBusOverflowError({ maxQueueSize: 1, attemptedCount: 1 });
      }, { critical: true });

      const result = await bus.publish(heartbeat(1));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(MessageBusCriticalHandlerError);
        expect((result.error as MessageBusCriticalHandlerError).originalError)
          .toBeInstanceOf(MessageBusOverflowError);
      }
    });

    it('MessageBusDrainLimitError, брошенная critical-обработчиком, не маскируется под drain-limit bus', async () => {
      const bus = new MessageBus<TestMessage>();
      bus.subscribe('HEARTBEAT', () => {
        throw new MessageBusDrainLimitError({ maxMessagesPerDrain: 1 });
      }, { critical: true });

      const result = await bus.publish(heartbeat(1));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(MessageBusCriticalHandlerError);
        expect((result.error as MessageBusCriticalHandlerError).originalError)
          .toBeInstanceOf(MessageBusDrainLimitError);
      }
    });
  });

  describe('queue overflow', () => {
    it('отклонённое сообщение не enqueue-ится, существующая очередь сохраняется и обрабатывается', async () => {
      const captured = makeCapturingObserver();
      const bus = new MessageBus<TestMessage>({
        policy: createMessageBusPolicy({ queuePolicy: { maxQueueSize: 2 } }),
        observer: captured.observer,
      });
      const gate = makeGate();
      const delivered: number[] = [];
      bus.subscribe('HEARTBEAT', async (message) => {
        delivered.push(message.seq);
        if (message.seq === 1) await gate.promise;
      });

      const first = bus.publish(heartbeat(1)); // in-flight, обработчик заблокирован
      const r2 = await bus.publish(heartbeat(2)); // очередь [2]
      const r3 = await bus.publish(heartbeat(3)); // очередь [2,3] — лимит достигнут
      expect(r2.ok).toBe(true);
      expect(r3.ok).toBe(true);

      const overflow = await bus.publish(heartbeat(4));
      expect(overflow.ok).toBe(false);
      if (!overflow.ok) {
        expect(overflow.error).toBeInstanceOf(MessageBusOverflowError);
        const error = overflow.error as MessageBusOverflowError;
        expect(error.maxQueueSize).toBe(2);
        expect(error.attemptedCount).toBe(1);
        expect(error.messageType).toBe('HEARTBEAT');
      }
      expect(bus.getStats().queueSize).toBe(2);
      expect(captured.overflows).toHaveLength(1);
      expect(captured.overflows[0]).toMatchObject({
        maxQueueSize: 2,
        attemptedCount: 1,
        queueSize: 2,
        messageType: 'HEARTBEAT',
      });

      gate.release();
      const firstResult = await first;
      expect(firstResult.ok).toBe(true);
      expect(delivered).toEqual([1, 2, 3]);
    });

    it('capacity считает только ожидающую очередь — in-flight сообщение не входит', async () => {
      const bus = new MessageBus<TestMessage>({
        policy: createMessageBusPolicy({ queuePolicy: { maxQueueSize: 1 } }),
      });
      const gate = makeGate();
      bus.subscribe('HEARTBEAT', async (message) => {
        if (message.seq === 1) await gate.promise;
      });

      const first = bus.publish(heartbeat(1)); // dequeued, in-flight; очередь пуста
      const r2 = await bus.publish(heartbeat(2)); // очередь [2] — влезает при лимите 1
      expect(r2.ok).toBe(true);
      const r3 = await bus.publish(heartbeat(3)); // 1 ожидающее + 1 → отклонение
      expect(r3.ok).toBe(false);

      gate.release();
      await first;
    });

    it('publishAll: не влезающий batch отклоняется атомарно (all or nothing)', async () => {
      const bus = new MessageBus<TestMessage>({
        policy: createMessageBusPolicy({ queuePolicy: { maxQueueSize: 2 } }),
      });
      const delivered: number[] = [];
      bus.subscribe('HEARTBEAT', (message) => { delivered.push(message.seq); });

      const result = await bus.publishAll([heartbeat(1), heartbeat(2), heartbeat(3)]);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(MessageBusOverflowError);
        expect((result.error as MessageBusOverflowError).attemptedCount).toBe(3);
      }
      expect(bus.getStats().queueSize).toBe(0);
      expect(delivered).toEqual([]);
      expect(bus.getStats().publishedTotal).toBe(0);
      expect(bus.getStats().rejectedPublicationsTotal).toBe(1);

      // Bus работоспособен: следующий publish доставляет ровно своё сообщение
      const next = await bus.publish(heartbeat(9));
      expect(next.ok).toBe(true);
      expect(delivered).toEqual([9]);
    });

    it('publishAll overflow не задевает уже стоящие в очереди сообщения', async () => {
      const bus = new MessageBus<TestMessage>({
        policy: createMessageBusPolicy({ queuePolicy: { maxQueueSize: 2 } }),
      });
      const gate = makeGate();
      const delivered: number[] = [];
      bus.subscribe('HEARTBEAT', async (message) => {
        delivered.push(message.seq);
        if (message.seq === 1) await gate.promise;
      });

      const first = bus.publish(heartbeat(1)); // in-flight
      await bus.publish(heartbeat(2)); // очередь [2]

      const batch = await bus.publishAll([heartbeat(3), heartbeat(4)]); // 1 + 2 > 2
      expect(batch.ok).toBe(false);
      expect(bus.getStats().queueSize).toBe(1);

      gate.release();
      await first;
      expect(delivered).toEqual([1, 2]);
    });
  });

  describe('drain-loop guard', () => {
    it('self-loop: Err(MessageBusDrainLimitError), очередь очищена, bus восстанавливается', async () => {
      const captured = makeCapturingObserver();
      const bus = new MessageBus<TestMessage>({
        policy: createMessageBusPolicy({ queuePolicy: { maxMessagesPerDrain: 3 } }),
        observer: captured.observer,
      });
      const unsubLoop = bus.subscribe('HEARTBEAT', async (message) => {
        await bus.publish(heartbeat(message.seq + 1)); // каждое сообщение порождает следующее
      });

      const result = await bus.publish(heartbeat(1));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(MessageBusDrainLimitError);
        expect((result.error as MessageBusDrainLimitError).maxMessagesPerDrain).toBe(3);
      }
      expect(bus.getStats().queueSize).toBe(0);
      expect(bus.getStats().dispatching).toBe(false);
      expect(captured.drainLimits).toHaveLength(1);
      expect(captured.drainLimits[0].maxMessagesPerDrain).toBe(3);
      expect(captured.drainLimits[0].clearedCount).toBeGreaterThan(0);

      // Убираем петлю — bus снова работает
      unsubLoop();
      const delivered: number[] = [];
      bus.subscribe('HEARTBEAT', (message) => { delivered.push(message.seq); });
      const next = await bus.publish(heartbeat(100));
      expect(next.ok).toBe(true);
      expect(delivered).toEqual([100]);
    });

    it('взаимная петля A↔B (HEARTBEAT↔ITEM_ADDED) детектируется и bus остаётся usable', async () => {
      const bus = new MessageBus<TestMessage>({
        policy: createMessageBusPolicy({ queuePolicy: { maxMessagesPerDrain: 4 } }),
      });
      const unsubHeartbeat = bus.subscribe('HEARTBEAT', async () => {
        await bus.publish({ type: 'ITEM_ADDED', itemId: 'loop' });
      });
      const unsubItemAdded = bus.subscribe('ITEM_ADDED', async () => {
        await bus.publish(heartbeat(0));
      });

      const result = await bus.publish(heartbeat(1));

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeInstanceOf(MessageBusDrainLimitError);
      expect(bus.getStats().queueSize).toBe(0);

      unsubHeartbeat();
      unsubItemAdded();
      const delivered: number[] = [];
      bus.subscribe('HEARTBEAT', (message) => { delivered.push(message.seq); });
      const next = await bus.publish(heartbeat(5));
      expect(next.ok).toBe(true);
      expect(delivered).toEqual([5]);
    });
  });

  describe('observer isolation', () => {
    it('падение observer.onHandlerError не влияет на доставку и Result', async () => {
      const bus = new MessageBus<TestMessage>({
        observer: {
          onHandlerError: () => { throw new Error('observer boom'); },
        },
      });
      let siblingCalled = false;
      bus.subscribe('HEARTBEAT', () => { throw new Error('handler boom'); });
      bus.subscribe('HEARTBEAT', () => { siblingCalled = true; });

      const result = await bus.publish(heartbeat(1));

      expect(result.ok).toBe(true);
      expect(siblingCalled).toBe(true);

      // Следующее сообщение обрабатывается как обычно
      const delivered: number[] = [];
      bus.subscribe('ITEM_ADDED', () => { delivered.push(0); });
      const next = await bus.publish({ type: 'ITEM_ADDED', itemId: 't' });
      expect(next.ok).toBe(true);
      expect(delivered).toEqual([0]);
    });

    it('падение observer.onQueueOverflow не меняет overflow-Result', async () => {
      const bus = new MessageBus<TestMessage>({
        policy: createMessageBusPolicy({ queuePolicy: { maxQueueSize: 1 } }),
        observer: {
          onQueueOverflow: () => { throw new Error('observer boom'); },
        },
      });
      const gate = makeGate();
      bus.subscribe('HEARTBEAT', async () => { await gate.promise; });

      const first = bus.publish(heartbeat(1));
      await bus.publish(heartbeat(2)); // очередь [2]
      const overflow = await bus.publish(heartbeat(3));

      expect(overflow.ok).toBe(false);
      if (!overflow.ok) expect(overflow.error).toBeInstanceOf(MessageBusOverflowError);

      gate.release();
      const firstResult = await first;
      expect(firstResult.ok).toBe(true);
    });

    it('падение observer.onDrainLimitExceeded не меняет drain-limit Result, bus usable', async () => {
      const bus = new MessageBus<TestMessage>({
        policy: createMessageBusPolicy({ queuePolicy: { maxMessagesPerDrain: 2 } }),
        observer: {
          onDrainLimitExceeded: () => { throw new Error('observer boom'); },
        },
      });
      const unsubLoop = bus.subscribe('HEARTBEAT', async (message) => {
        await bus.publish(heartbeat(message.seq + 1));
      });

      const result = await bus.publish(heartbeat(1));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeInstanceOf(MessageBusDrainLimitError);

      unsubLoop();
      const next = await bus.publish(heartbeat(10));
      expect(next.ok).toBe(true);
    });
  });
});
