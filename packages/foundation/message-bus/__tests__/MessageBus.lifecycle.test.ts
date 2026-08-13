/**
 * Тесты lifecycle MessageBus: drain() и close().
 */
import { describe, it, expect } from '@jest/globals';
import {
  MessageBus,
  MessageBusClosedError,
  MessageBusCriticalHandlerError,
} from '@polymarket/message-bus';
import type { MessageBusDrainError } from '@polymarket/message-bus';
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

describe('MessageBus lifecycle', () => {
  describe('drain()', () => {
    it('idle bus с пустой очередью → Ok без запуска dispatch', async () => {
      const bus = new MessageBus<TestMessage>();
      const result = await bus.drain();
      expect(result).toEqual({ ok: true, value: undefined });
      expect(bus.getStats().dispatching).toBe(false);
    });

    it('при активном drain дожидается существующего и не запускает второй', async () => {
      const bus = new MessageBus<TestMessage>();
      const gate = makeGate();
      const delivered: number[] = [];
      bus.subscribe('HEARTBEAT', async (message) => {
        delivered.push(message.seq);
        if (message.seq === 1) await gate.promise;
      });

      const ownerPublish = bus.publish(heartbeat(1));
      await bus.publish(heartbeat(2)); // очередь [2]

      const drainPromise = bus.drain();
      let drainSettled = false;
      void drainPromise.then(() => { drainSettled = true; });
      await tick();
      // drain() ждёт существующий drain — не завершился, пока обработчик заблокирован
      expect(drainSettled).toBe(false);
      expect(delivered).toEqual([1]); // второй drain не запущен — 2 не доставлено

      gate.release();
      const drainResult = await drainPromise;
      const ownerResult = await ownerPublish;
      expect(drainResult.ok).toBe(true);
      expect(ownerResult.ok).toBe(true);
      expect(delivered).toEqual([1, 2]);
    });

    it('drain() из самого синхронного начала обработчика присоединяется к активному drain — второй drain не запускается', async () => {
      const bus = new MessageBus<TestMessage>();
      const delivered: number[] = [];
      const captured: {
        drainPromise?: Promise<Result<void, MessageBusDrainError>>;
        deliveredAtCall?: number[];
      } = {};
      // Sync-обработчик: вызов drain() происходит в самом раннем синхронном
      // участке fan-out первого сообщения — до первого await движка.
      bus.subscribe('HEARTBEAT', (message) => {
        delivered.push(message.seq);
        if (message.seq === 1) {
          // НЕ await: await drain() из обработчика — документированный self-deadlock
          captured.drainPromise = bus.drain();
          captured.deliveredAtCall = [...delivered];
        }
      });

      const owner = await bus.publishAll([heartbeat(1), heartbeat(2)]);

      expect(owner.ok).toBe(true);
      // Regression: nested drain доставил бы сообщение 2 синхронно ВНУТРИ
      // обработчика сообщения 1 — deliveredAtCall был бы [1, 2].
      expect(captured.deliveredAtCall).toEqual([1]);
      expect(delivered).toEqual([1, 2]);
      // Присоединившийся drain() получает тот же Result, что и владелец drain
      const joined = await captured.drainPromise!;
      expect(joined.ok).toBe(true);
      expect(bus.getStats().dispatching).toBe(false);
      expect(bus.getStats().queueSize).toBe(0);
    });

    it('после critical-сбоя: возвращает critical-Result при retry и завершается Ok после устранения причины', async () => {
      const bus = new MessageBus<TestMessage>();
      const delivered: number[] = [];
      const unsubFailing = bus.subscribe('HEARTBEAT', (message) => {
        if (message.seq < 3) throw new Error(`critical on ${message.seq}`);
        delivered.push(message.seq);
      }, { critical: true });

      // Сбой на 1 — очередь [2,3] сохранена
      const batch = await bus.publishAll([heartbeat(1), heartbeat(2), heartbeat(3)]);
      expect(batch.ok).toBe(false);
      expect(bus.getStats().queueSize).toBe(2);

      // drain() запускает обработку сохранённой очереди и возвращает critical-исход (сбой на 2)
      const retry = await bus.drain();
      expect(retry.ok).toBe(false);
      if (!retry.ok) {
        expect(retry.error).toBeInstanceOf(MessageBusCriticalHandlerError);
        expect(((retry.error as MessageBusCriticalHandlerError).originalError as Error).message)
          .toBe('critical on 2');
      }
      expect(bus.getStats().queueSize).toBe(1);

      // Устраняем причину — повторный drain() дообрабатывает очередь
      unsubFailing();
      bus.subscribe('HEARTBEAT', (message) => { delivered.push(message.seq); });
      const final = await bus.drain();
      expect(final.ok).toBe(true);
      expect(delivered).toEqual([3]);
      expect(bus.getStats().queueSize).toBe(0);
    });
  });

  describe('close()', () => {
    it('close() из самого синхронного начала обработчика присоединяется к активному drain — второй drain не запускается', async () => {
      const bus = new MessageBus<TestMessage>();
      const delivered: number[] = [];
      const captured: {
        closePromise?: Promise<Result<void, MessageBusDrainError>>;
        deliveredAtCall?: number[];
      } = {};
      bus.subscribe('HEARTBEAT', (message) => {
        delivered.push(message.seq);
        if (message.seq === 1) {
          // НЕ await: await close() из обработчика — документированный self-deadlock
          captured.closePromise = bus.close();
          captured.deliveredAtCall = [...delivered];
        }
      });

      const owner = await bus.publishAll([heartbeat(1), heartbeat(2)]);

      expect(owner.ok).toBe(true);
      // Regression: nested drain доставил бы сообщение 2 внутри обработчика сообщения 1
      expect(captured.deliveredAtCall).toEqual([1]);
      // Уже стоявшая очередь дообработана существующим drain, несмотря на close
      expect(delivered).toEqual([1, 2]);
      const closeResult = await captured.closePromise!;
      expect(closeResult.ok).toBe(true);
      expect(bus.getStats().closed).toBe(true);
      expect(bus.getStats().dispatching).toBe(false);
    });

    it('close на idle-bus с пустой очередью → Ok, stats.closed = true', async () => {
      const bus = new MessageBus<TestMessage>();
      const result = await bus.close();
      expect(result).toEqual({ ok: true, value: undefined });
      expect(bus.getStats().closed).toBe(true);
    });

    it('publish и publishAll после close → Err(MessageBusClosedError), счётчик отклонений растёт', async () => {
      const bus = new MessageBus<TestMessage>();
      await bus.close();

      const single = await bus.publish(heartbeat(1));
      expect(single.ok).toBe(false);
      if (!single.ok) expect(single.error).toBeInstanceOf(MessageBusClosedError);

      const batch = await bus.publishAll([heartbeat(2), heartbeat(3)]);
      expect(batch.ok).toBe(false);
      if (!batch.ok) expect(batch.error).toBeInstanceOf(MessageBusClosedError);

      expect(bus.getStats().rejectedPublicationsTotal).toBe(2);
      expect(bus.getStats().publishedTotal).toBe(0);
    });

    it('close дообрабатывает существующую очередь; новые публикации во время close-drain отклоняются', async () => {
      const bus = new MessageBus<TestMessage>();
      const gate = makeGate();
      const delivered: number[] = [];
      bus.subscribe('HEARTBEAT', async (message) => {
        delivered.push(message.seq);
        if (message.seq === 1) await gate.promise;
      });

      const ownerPublish = bus.publish(heartbeat(1));
      await bus.publish(heartbeat(2)); // очередь [2]

      const closePromise = bus.close();
      // Bus уже закрыт для новых публикаций, но очередь будет дообработана
      const rejected = await bus.publish(heartbeat(3));
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.error).toBeInstanceOf(MessageBusClosedError);

      gate.release();
      const closeResult = await closePromise;
      const ownerResult = await ownerPublish;
      expect(closeResult.ok).toBe(true);
      expect(ownerResult.ok).toBe(true);
      expect(delivered).toEqual([1, 2]); // очередь дообработана, отклонённое 3 не доставлено
      expect(bus.getStats().queueSize).toBe(0);
    });

    it('close() на idle-bus с сохранённой после critical-сбоя очередью сам запускает drain и дообрабатывает её', async () => {
      const bus = new MessageBus<TestMessage>();
      const delivered: number[] = [];
      bus.subscribe('HEARTBEAT', (message) => {
        if (message.seq === 1) throw new Error('critical on 1');
        delivered.push(message.seq);
      }, { critical: true });

      // Critical-сбой на 1: владелец получает Err, очередь [2] сохранена, ownership отпущен
      const batch = await bus.publishAll([heartbeat(1), heartbeat(2)]);
      expect(batch.ok).toBe(false);
      expect(bus.getStats().queueSize).toBe(1);
      expect(bus.getStats().dispatching).toBe(false);

      // close() при отсутствии активного drain обязан САМ запустить drain остатка
      const closeResult = await bus.close();
      expect(closeResult.ok).toBe(true);
      expect(delivered).toEqual([2]);
      expect(bus.getStats().queueSize).toBe(0);
      expect(bus.getStats().closed).toBe(true);

      // Bus закрыт для новых публикаций
      const rejected = await bus.publish(heartbeat(3));
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.error).toBeInstanceOf(MessageBusClosedError);
    });

    it('повторный close безопасен (идемпотентен)', async () => {
      const bus = new MessageBus<TestMessage>();
      const first = await bus.close();
      const second = await bus.close();
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(bus.getStats().closed).toBe(true);
    });

    it('critical-сбой во время close-drain: bus остаётся closed, очередь сохраняется, drain() доступен для recovery', async () => {
      const bus = new MessageBus<TestMessage>();
      const delivered: number[] = [];
      const unsubFailing = bus.subscribe('HEARTBEAT', (message) => {
        if (message.seq === 1) throw new Error('critical during close');
        delivered.push(message.seq);
      }, { critical: true });

      // Заполняем очередь ДО close: сбой на 1, очередь [2] сохранится
      const gate = makeGate();
      const unsubBlocker = bus.subscribe('HEARTBEAT', async (message) => {
        if (message.seq === 1) await gate.promise;
      });
      const ownerPublish = bus.publish(heartbeat(1));
      await bus.publish(heartbeat(2));

      const closePromise = bus.close();
      gate.release();
      const closeResult = await closePromise;
      const ownerResult = await ownerPublish;

      // close вернул critical-исход существующего drain
      expect(closeResult.ok).toBe(false);
      if (!closeResult.ok) expect(closeResult.error).toBeInstanceOf(MessageBusCriticalHandlerError);
      expect(ownerResult.ok).toBe(false);
      expect(bus.getStats().closed).toBe(true);
      expect(bus.getStats().queueSize).toBe(1); // [2] сохранено

      // Подписки можно менять после close — устраняем failing handler и повторяем drain
      unsubFailing();
      unsubBlocker();
      bus.subscribe('HEARTBEAT', (message) => { delivered.push(message.seq); });
      const recovery = await bus.drain();
      expect(recovery.ok).toBe(true);
      expect(delivered).toEqual([2]);
      expect(bus.getStats().queueSize).toBe(0);
      // Bus по-прежнему закрыт для новых публикаций
      const rejected = await bus.publish(heartbeat(9));
      expect(rejected.ok).toBe(false);
    });
  });
});
