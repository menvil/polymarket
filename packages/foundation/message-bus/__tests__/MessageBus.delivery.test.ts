/**
 * Тесты базовой доставки MessageBus: routing, fan-out, FIFO между сообщениями.
 *
 * @remarks
 * Проверяется только observable-поведение: результаты publish, порядок и состав
 * доставки, getStats. Внутренние структуры (Map/Set/backing array) не фиксируются.
 */
import { describe, it, expect } from '@jest/globals';
import { MessageBus } from '@polymarket/message-bus';

type TestMessage =
  | { readonly type: 'PRICE'; readonly seq: number }
  | { readonly type: 'TRADE'; readonly tradeId: string };

function price(seq: number): TestMessage {
  return { type: 'PRICE', seq };
}

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
    bus.subscribe('PRICE', (message) => { seen.push(message.seq); });

    const result = await bus.publish(price(1));

    expect(result).toEqual({ ok: true, value: undefined });
    expect(seen).toEqual([1]);
  });

  it('все подписчики типа получают сообщение (fan-out)', async () => {
    const bus = new MessageBus<TestMessage>();
    const calls: string[] = [];
    bus.subscribe('PRICE', () => { calls.push('a'); });
    bus.subscribe('PRICE', () => { calls.push('b'); });
    bus.subscribe('PRICE', () => { calls.push('c'); });

    await bus.publish(price(1));

    expect(calls.sort()).toEqual(['a', 'b', 'c']);
  });

  it('publish без подписчиков → Ok, bus остаётся idle', async () => {
    const bus = new MessageBus<TestMessage>();
    const result = await bus.publish(price(1));
    expect(result.ok).toBe(true);
    expect(bus.getStats().queueSize).toBe(0);
    expect(bus.getStats().dispatching).toBe(false);
  });

  it('exact type routing: подписчик получает только сообщения своего типа', async () => {
    const bus = new MessageBus<TestMessage>();
    const prices: number[] = [];
    const trades: string[] = [];
    bus.subscribe('PRICE', (message) => { prices.push(message.seq); });
    bus.subscribe('TRADE', (message) => { trades.push(message.tradeId); });

    await bus.publish(price(1));
    await bus.publish({ type: 'TRADE', tradeId: 't-1' });

    expect(prices).toEqual([1]);
    expect(trades).toEqual(['t-1']);
  });

  it('sync-обработчик получает сообщение', async () => {
    const bus = new MessageBus<TestMessage>();
    let seen = -1;
    bus.subscribe('PRICE', (message) => { seen = message.seq; });

    const result = await bus.publish(price(7));

    expect(result.ok).toBe(true);
    expect(seen).toBe(7);
  });

  it('async-обработчик получает сообщение, publish ждёт его завершения', async () => {
    const bus = new MessageBus<TestMessage>();
    let finished = false;
    bus.subscribe('PRICE', async () => {
      await tick();
      finished = true;
    });

    const result = await bus.publish(price(1));

    expect(result.ok).toBe(true);
    expect(finished).toBe(true);
  });

  it('publishAll доставляет сообщения в порядке массива (FIFO)', async () => {
    const bus = new MessageBus<TestMessage>();
    const order: number[] = [];
    bus.subscribe('PRICE', (message) => { order.push(message.seq); });

    const result = await bus.publishAll([price(1), price(2), price(3)]);

    expect(result.ok).toBe(true);
    expect(order).toEqual([1, 2, 3]);
  });

  it('publishAll([]) → Ok без dispatch и без изменения состояния', async () => {
    const bus = new MessageBus<TestMessage>();
    let called = false;
    bus.subscribe('PRICE', () => { called = true; });

    const result = await bus.publishAll([]);

    expect(result).toEqual({ ok: true, value: undefined });
    expect(called).toBe(false);
    expect(bus.getStats().dispatching).toBe(false);
    expect(bus.getStats().publishedTotal).toBe(0);
  });

  it('unsubscribe прекращает доставку', async () => {
    const bus = new MessageBus<TestMessage>();
    let count = 0;
    const unsubscribe = bus.subscribe('PRICE', () => { count++; });

    await bus.publish(price(1));
    unsubscribe();
    await bus.publish(price(2));

    expect(count).toBe(1);
  });

  it('двойной unsubscribe безопасен (идемпотентен)', async () => {
    const bus = new MessageBus<TestMessage>();
    const unsubscribe = bus.subscribe('PRICE', () => {});
    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
  });

  it('отписка одного из двух подписчиков типа не задевает второго', async () => {
    const bus = new MessageBus<TestMessage>();
    const seen: string[] = [];
    const unsubA = bus.subscribe('PRICE', () => { seen.push('a'); });
    bus.subscribe('PRICE', () => { seen.push('b'); });

    unsubA();
    await bus.publish(price(1));

    expect(seen).toEqual(['b']);
  });

  it('fan-out параллелен: B стартует до завершения заблокированного A, publish ждёт всех', async () => {
    const bus = new MessageBus<TestMessage>();
    const gate = makeGate();
    let aStarted = false;
    let aFinished = false;
    let bStarted = false;
    bus.subscribe('PRICE', async () => { aStarted = true; await gate.promise; aFinished = true; });
    bus.subscribe('PRICE', async () => { bStarted = true; });

    const publishPromise = bus.publish(price(1));
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
    bus.subscribe('PRICE', async (message) => {
      delivered.push(message.seq);
      if (message.seq === 1) await gate.promise;
    });

    const publishPromise = bus.publishAll([price(1), price(2)]);
    await tick();

    // Сообщение 1 заблокировано — сообщение 2 не должно начать доставляться
    expect(delivered).toEqual([1]);

    gate.release();
    const result = await publishPromise;
    expect(result.ok).toBe(true);
    expect(delivered).toEqual([1, 2]);
  });
});
