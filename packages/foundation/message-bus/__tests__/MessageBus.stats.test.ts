/**
 * Тесты диагностики MessageBus (getStats): флаги состояния и счётчики.
 *
 * @remarks
 * Проверяется только публичный снимок getStats() — приватные поля не инспектируются.
 */
import { describe, it, expect } from '@jest/globals';
import { MessageBus, createMessageBusPolicy } from '@polymarket/message-bus';
import { heartbeat, type TestMessage } from './testMessages.js';

function makeGate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe('MessageBus stats', () => {
  it('idle-снимок: нули, dispatching=false, closed=false', () => {
    const bus = new MessageBus<TestMessage>();
    expect(bus.getStats()).toEqual({
      queueSize: 0,
      subscribedTypes: 0,
      dispatching: false,
      closed: false,
      publishedTotal: 0,
      dispatchedTotal: 0,
      handlerErrorsTotal: 0,
      rejectedPublicationsTotal: 0,
    });
  });

  it('во время активного drain: dispatching=true, queueSize считает только ожидающие', async () => {
    const bus = new MessageBus<TestMessage>();
    const gate = makeGate();
    bus.subscribe('HEARTBEAT', async (message) => {
      if (message.payload.seq === 1) await gate.promise;
    });

    const owner = bus.publish(heartbeat(1)); // in-flight — в queueSize не входит
    await bus.publish(heartbeat(2));
    await bus.publish(heartbeat(3));

    const stats = bus.getStats();
    expect(stats.dispatching).toBe(true);
    expect(stats.queueSize).toBe(2);

    gate.release();
    await owner;
    expect(bus.getStats().dispatching).toBe(false);
    expect(bus.getStats().queueSize).toBe(0);
  });

  it('subscribedTypes отражает жизненный цикл подписок без утечек', () => {
    const bus = new MessageBus<TestMessage>();
    expect(bus.getStats().subscribedTypes).toBe(0);

    const unsubHeartbeatA = bus.subscribe('HEARTBEAT', () => {});
    expect(bus.getStats().subscribedTypes).toBe(1);

    // Второй обработчик того же типа не увеличивает количество типов
    const unsubHeartbeatB = bus.subscribe('HEARTBEAT', () => {});
    expect(bus.getStats().subscribedTypes).toBe(1);

    const unsubItemAdded = bus.subscribe('ITEM_ADDED', () => {});
    expect(bus.getStats().subscribedTypes).toBe(2);

    // Отписка НЕ последнего обработчика типа — тип остаётся
    unsubHeartbeatA();
    expect(bus.getStats().subscribedTypes).toBe(2);

    // Отписка последнего обработчика типа — тип исчезает
    unsubHeartbeatB();
    expect(bus.getStats().subscribedTypes).toBe(1);
    unsubItemAdded();
    expect(bus.getStats().subscribedTypes).toBe(0);
  });

  it('publishedTotal: одиночные публикации и принятый batch; отклонённый batch не считается', async () => {
    const bus = new MessageBus<TestMessage>({
      policy: createMessageBusPolicy({ queuePolicy: { maxQueueSize: 5 } }),
    });

    await bus.publish(heartbeat(1));
    expect(bus.getStats().publishedTotal).toBe(1);

    await bus.publishAll([heartbeat(2), heartbeat(3), heartbeat(4)]);
    expect(bus.getStats().publishedTotal).toBe(4);

    // Batch, не влезающий в лимит, отклоняется целиком и не увеличивает счётчик
    const gate = makeGate();
    bus.subscribe('HEARTBEAT', async () => { await gate.promise; });
    const owner = bus.publish(heartbeat(5)); // publishedTotal 5, in-flight
    expect(bus.getStats().publishedTotal).toBe(5);
    const rejected = await bus.publishAll([heartbeat(6), heartbeat(7), heartbeat(8), heartbeat(9), heartbeat(10), heartbeat(11)]);
    expect(rejected.ok).toBe(false);
    expect(bus.getStats().publishedTotal).toBe(5);

    gate.release();
    await owner;
  });

  it('dispatchedTotal: сообщение без подписчиков и critical-сбойное сообщение считаются dispatched', async () => {
    const bus = new MessageBus<TestMessage>();

    // Без подписчиков — всё равно dispatched после прохождения drain
    await bus.publish(heartbeat(1));
    expect(bus.getStats().dispatchedTotal).toBe(1);

    // Critical-сбой: fan-out завершён → сообщение считается dispatched
    bus.subscribe('HEARTBEAT', () => { throw new Error('critical'); }, { critical: true });
    const failed = await bus.publish(heartbeat(2));
    expect(failed.ok).toBe(false);
    expect(bus.getStats().dispatchedTotal).toBe(2);
  });

  it('handlerErrorsTotal: считает и critical, и non-critical падения', async () => {
    const bus = new MessageBus<TestMessage>();
    bus.subscribe('HEARTBEAT', () => { throw new Error('non-critical'); });
    bus.subscribe('HEARTBEAT', async () => { throw new Error('critical'); }, { critical: true });

    const result = await bus.publish(heartbeat(1));

    expect(result.ok).toBe(false);
    expect(bus.getStats().handlerErrorsTotal).toBe(2);
  });

  it('rejectedPublicationsTotal: одна отклонённая операция = +1, независимо от размера batch', async () => {
    const bus = new MessageBus<TestMessage>({
      policy: createMessageBusPolicy({ queuePolicy: { maxQueueSize: 1 } }),
    });
    const gate = makeGate();
    bus.subscribe('HEARTBEAT', async () => { await gate.promise; });

    const owner = bus.publish(heartbeat(1)); // in-flight
    await bus.publish(heartbeat(2)); // очередь [2] — лимит исчерпан

    const single = await bus.publish(heartbeat(3));
    expect(single.ok).toBe(false);
    expect(bus.getStats().rejectedPublicationsTotal).toBe(1);

    // Отклонённый batch из 100 сообщений — по-прежнему одна операция
    const bigBatch = Array.from({ length: 100 }, (_, i) => heartbeat(10 + i));
    const batchResult = await bus.publishAll(bigBatch);
    expect(batchResult.ok).toBe(false);
    expect(bus.getStats().rejectedPublicationsTotal).toBe(2);

    gate.release();
    await owner;
  });

  it('closed-флаг после close, отклонения после close считаются', async () => {
    const bus = new MessageBus<TestMessage>();
    expect(bus.getStats().closed).toBe(false);

    await bus.close();
    expect(bus.getStats().closed).toBe(true);

    await bus.publish(heartbeat(1));
    expect(bus.getStats().rejectedPublicationsTotal).toBe(1);
  });
});
