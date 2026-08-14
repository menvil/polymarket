/**
 * Тесты базовой доставки MessageBus: routing, fan-out, FIFO между сообщениями.
 *
 * @remarks
 * Проверяется только observable-поведение: результаты publish, порядок и состав
 * доставки, getStats. Внутренние структуры (Map/Set/backing array) не фиксируются.
 */
import { describe, it, expect } from '@jest/globals';
import { MessageBus } from '@polymarket/message-bus';
import { heartbeat, itemAdded, type TestMessage } from './testMessages.js';

/** Управляемый барьер: обработчик блокируется до release(). */
function makeGate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

/** Пропускает macrotask — даёт параллельным обработчикам стартовать/осесть. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('MessageBus delivery', () => {
  it('один подписчик получает сообщение, publish → Ok', async () => {
    const bus = new MessageBus<TestMessage>();
    const seen: number[] = [];
    bus.subscribe('HEARTBEAT', (message) => { seen.push(message.payload.seq); });

    const result = await bus.publish(heartbeat(1));

    expect(result).toEqual({ ok: true, value: undefined });
    expect(seen).toEqual([1]);
  });

  it('все подписчики типа получают сообщение (fan-out)', async () => {
    const bus = new MessageBus<TestMessage>();
    const calls: string[] = [];
    bus.subscribe('HEARTBEAT', () => { calls.push('a'); });
    bus.subscribe('HEARTBEAT', () => { calls.push('b'); });
    bus.subscribe('HEARTBEAT', () => { calls.push('c'); });

    await bus.publish(heartbeat(1));

    expect(calls.sort()).toEqual(['a', 'b', 'c']);
  });

  it('publish без подписчиков → Ok, bus остаётся idle', async () => {
    const bus = new MessageBus<TestMessage>();
    const result = await bus.publish(heartbeat(1));
    expect(result.ok).toBe(true);
    expect(bus.getStats().queueSize).toBe(0);
    expect(bus.getStats().dispatching).toBe(false);
  });

  it('exact type routing: подписчик получает только сообщения своего типа', async () => {
    const bus = new MessageBus<TestMessage>();
    const heartbeats: number[] = [];
    const items: string[] = [];
    bus.subscribe('HEARTBEAT', (message) => { heartbeats.push(message.payload.seq); });
    bus.subscribe('ITEM_ADDED', (message) => { items.push(message.payload.itemId); });

    await bus.publish(heartbeat(1));
    await bus.publish(itemAdded('t-1'));

    expect(heartbeats).toEqual([1]);
    expect(items).toEqual(['t-1']);
  });

  it('sync-обработчик получает сообщение', async () => {
    const bus = new MessageBus<TestMessage>();
    let seen = -1;
    bus.subscribe('HEARTBEAT', (message) => { seen = message.payload.seq; });

    const result = await bus.publish(heartbeat(7));

    expect(result.ok).toBe(true);
    expect(seen).toBe(7);
  });

  it('async-обработчик получает сообщение, publish ждёт его завершения', async () => {
    const bus = new MessageBus<TestMessage>();
    let finished = false;
    bus.subscribe('HEARTBEAT', async () => {
      await tick();
      finished = true;
    });

    const result = await bus.publish(heartbeat(1));

    expect(result.ok).toBe(true);
    expect(finished).toBe(true);
  });

  it('publishAll доставляет сообщения в порядке массива (FIFO)', async () => {
    const bus = new MessageBus<TestMessage>();
    const order: number[] = [];
    bus.subscribe('HEARTBEAT', (message) => { order.push(message.payload.seq); });

    const result = await bus.publishAll([heartbeat(1), heartbeat(2), heartbeat(3)]);

    expect(result.ok).toBe(true);
    expect(order).toEqual([1, 2, 3]);
  });

  it('publishAll([]) → Ok без dispatch и без изменения состояния', async () => {
    const bus = new MessageBus<TestMessage>();
    let called = false;
    bus.subscribe('HEARTBEAT', () => { called = true; });

    const result = await bus.publishAll([]);

    expect(result).toEqual({ ok: true, value: undefined });
    expect(called).toBe(false);
    expect(bus.getStats().dispatching).toBe(false);
    expect(bus.getStats().publishedTotal).toBe(0);
  });

  it('unsubscribe прекращает доставку', async () => {
    const bus = new MessageBus<TestMessage>();
    let count = 0;
    const unsubscribe = bus.subscribe('HEARTBEAT', () => { count++; });

    await bus.publish(heartbeat(1));
    unsubscribe();
    await bus.publish(heartbeat(2));

    expect(count).toBe(1);
  });

  it('двойной unsubscribe безопасен (идемпотентен)', async () => {
    const bus = new MessageBus<TestMessage>();
    const unsubscribe = bus.subscribe('HEARTBEAT', () => {});
    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
  });

  it('отписка одного из двух подписчиков типа не задевает второго', async () => {
    const bus = new MessageBus<TestMessage>();
    const seen: string[] = [];
    const unsubA = bus.subscribe('HEARTBEAT', () => { seen.push('a'); });
    bus.subscribe('HEARTBEAT', () => { seen.push('b'); });

    unsubA();
    await bus.publish(heartbeat(1));

    expect(seen).toEqual(['b']);
  });

  it('fan-out параллелен: B стартует до завершения заблокированного A, publish ждёт всех', async () => {
    const bus = new MessageBus<TestMessage>();
    const gate = makeGate();
    let aStarted = false;
    let aFinished = false;
    let bStarted = false;
    bus.subscribe('HEARTBEAT', async () => { aStarted = true; await gate.promise; aFinished = true; });
    bus.subscribe('HEARTBEAT', async () => { bStarted = true; });

    const publishPromise = bus.publish(heartbeat(1));
    let publishSettled = false;
    void publishPromise.then(() => { publishSettled = true; });
    await tick();

    // B стартовал, пока A заблокирован — обработчики одного сообщения параллельны
    expect(aStarted).toBe(true);
    expect(bStarted).toBe(true);
    expect(aFinished).toBe(false);
    // publish не завершается, пока не settle-нулись ВСЕ обработчики сообщения
    expect(publishSettled).toBe(false);

    gate.release();
    const result = await publishPromise;
    expect(result.ok).toBe(true);
    expect(aFinished).toBe(true);
  });

  it('следующее сообщение не диспетчеризуется до завершения fan-out текущего', async () => {
    const bus = new MessageBus<TestMessage>();
    const gate = makeGate();
    const delivered: number[] = [];
    bus.subscribe('HEARTBEAT', async (message) => {
      delivered.push(message.payload.seq);
      if (message.payload.seq === 1) await gate.promise;
    });

    const publishPromise = bus.publishAll([heartbeat(1), heartbeat(2)]);
    await tick();

    // Сообщение 1 заблокировано — сообщение 2 не должно начать доставляться
    expect(delivered).toEqual([1]);

    gate.release();
    const result = await publishPromise;
    expect(result.ok).toBe(true);
    expect(delivered).toEqual([1, 2]);
  });
});
