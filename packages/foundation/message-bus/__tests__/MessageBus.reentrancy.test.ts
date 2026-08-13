/**
 * Тесты reentrancy MessageBus: публикации изнутри обработчиков и конкурентные
 * публикации при активном drain. Один drain owner, никаких nested drains.
 */
import { describe, it, expect } from '@jest/globals';
import { MessageBus } from '@polymarket/message-bus';
import type { MessageBusPublishError } from '@polymarket/message-bus';
import type { Result } from '@polymarket/result';

type TestMessage = { readonly type: 'HEARTBEAT'; readonly seq: number };

function heartbeat(seq: number): TestMessage {
  return { type: 'HEARTBEAT', seq };
}

function makeGate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('MessageBus reentrancy', () => {
  it('handler(A) → publish(C) при очереди [A,B]: порядок A → B → C', async () => {
    const bus = new MessageBus<TestMessage>();
    const order: number[] = [];
    bus.subscribe('HEARTBEAT', async (message) => {
      order.push(message.seq);
      if (message.seq === 1) {
        await bus.publish(heartbeat(3));
      }
    });

    const result = await bus.publishAll([heartbeat(1), heartbeat(2)]);

    expect(result.ok).toBe(true);
    expect(order).toEqual([1, 2, 3]);
  });

  it('handler(A) → publishAll([C,D]) при очереди [A,B]: порядок A → B → C → D', async () => {
    const bus = new MessageBus<TestMessage>();
    const order: number[] = [];
    bus.subscribe('HEARTBEAT', async (message) => {
      order.push(message.seq);
      if (message.seq === 1) {
        await bus.publishAll([heartbeat(3), heartbeat(4)]);
      }
    });

    const result = await bus.publishAll([heartbeat(1), heartbeat(2)]);

    expect(result.ok).toBe(true);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('reentrant publish возвращает Ok(enqueued) ДО фактического dispatch child-сообщения', async () => {
    const bus = new MessageBus<TestMessage>();
    const delivered: number[] = [];
    let reentrantResult: Result<void, MessageBusPublishError> | undefined;
    let deliveredAtReentrantReturn: number[] | undefined;

    bus.subscribe('HEARTBEAT', async (message) => {
      delivered.push(message.seq);
      if (message.seq === 1) {
        // await внутри активного drain не может ждать обработки сообщения 2 —
        // иначе self-deadlock. Ok означает успешный enqueue.
        reentrantResult = await bus.publish(heartbeat(2));
        deliveredAtReentrantReturn = [...delivered];
      }
    });

    const result = await bus.publish(heartbeat(1));

    expect(result.ok).toBe(true);
    expect(reentrantResult?.ok).toBe(true);
    expect(deliveredAtReentrantReturn).toEqual([1]); // 2 ещё не доставлено в момент возврата
    expect(delivered).toEqual([1, 2]); // доставлено текущим (outer) drain позже
  });

  it('reentrant publishAll тоже подтверждает enqueue, а не обработку', async () => {
    const bus = new MessageBus<TestMessage>();
    const delivered: number[] = [];
    let deliveredAtReturn: number[] | undefined;

    bus.subscribe('HEARTBEAT', async (message) => {
      delivered.push(message.seq);
      if (message.seq === 1) {
        const batchResult = await bus.publishAll([heartbeat(2), heartbeat(3)]);
        expect(batchResult.ok).toBe(true);
        deliveredAtReturn = [...delivered];
      }
    });

    await bus.publish(heartbeat(1));

    expect(deliveredAtReturn).toEqual([1]);
    expect(delivered).toEqual([1, 2, 3]);
  });

  it('конкурентный publish при активном drain: Ok после enqueue до release, доставка существующим drain', async () => {
    const bus = new MessageBus<TestMessage>();
    const gate = makeGate();
    const delivered: number[] = [];
    bus.subscribe('HEARTBEAT', async (message) => {
      delivered.push(message.seq);
      if (message.seq === 1) await gate.promise;
    });

    const ownerPublish = bus.publish(heartbeat(1)); // владелец drain, обработчик заблокирован
    await tick();
    expect(delivered).toEqual([1]);

    // Внешний вызов при активном drain: должен вернуться Ok ДО release A
    const concurrentResult = await bus.publish(heartbeat(2));
    expect(concurrentResult.ok).toBe(true);
    expect(delivered).toEqual([1]); // сообщение 2 ещё не доставлено — только enqueue

    gate.release();
    const ownerResult = await ownerPublish;
    expect(ownerResult.ok).toBe(true);
    // Сообщение 2 доставлено СУЩЕСТВУЮЩИМ drain (после сообщения 1), не вторым drain
    expect(delivered).toEqual([1, 2]);
    expect(bus.getStats().dispatching).toBe(false);
  });

  it('подписка во время dispatch: новый обработчик не получает текущее сообщение, получает следующее в том же drain', async () => {
    const bus = new MessageBus<TestMessage>();
    const lateCalls: number[] = [];
    bus.subscribe('HEARTBEAT', (message) => {
      if (message.seq === 1) {
        bus.subscribe('HEARTBEAT', (next) => { lateCalls.push(next.seq); });
      }
    });

    await bus.publishAll([heartbeat(1), heartbeat(2)]);

    expect(lateCalls).toEqual([2]);
  });

  it('отписка во время fan-out: обработчик доигрывает текущее сообщение, но не получает следующие', async () => {
    const bus = new MessageBus<TestMessage>();
    const bCalls: number[] = [];
    // A зарегистрирован ДО B и синхронно отписывает его в начале fan-out —
    // строгая проверка: отписка происходит до того, как B был бы вызван.
    const holder: { unsubB?: () => void } = {};
    bus.subscribe('HEARTBEAT', () => { holder.unsubB?.(); });
    holder.unsubB = bus.subscribe('HEARTBEAT', (message) => { bCalls.push(message.seq); });

    await bus.publish(heartbeat(1));
    // Snapshot подписчиков сформирован до запуска — B участвует в текущем fan-out
    expect(bCalls).toEqual([1]);

    await bus.publish(heartbeat(2));
    expect(bCalls).toEqual([1]);
  });
});
