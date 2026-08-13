/**
 * Тесты политики MessageBus: default-значения, helper, валидация в конструкторе.
 */
import { describe, it, expect } from '@jest/globals';
import {
  MessageBus,
  DEFAULT_MESSAGE_BUS_POLICY,
  createMessageBusPolicy,
} from '@polymarket/message-bus';

type TestMessage = { readonly type: 'PRICE'; readonly seq: number };

describe('MessageBus policy', () => {
  it('default-политика содержит доказанные лимиты и поддерживаемые стратегии', () => {
    expect(DEFAULT_MESSAGE_BUS_POLICY).toEqual({
      queuePolicy: { maxQueueSize: 100_000, maxMessagesPerDrain: 10_000 },
      overflowPolicy: { strategy: 'reject-new' },
      handlerPolicy: { fanOut: 'parallel' },
      errorPolicy: {
        nonCriticalHandler: 'continue',
        criticalHandler: 'stop-drain-preserve-queue',
        drainLimit: 'clear-queue',
      },
    });
  });

  it('default-политика иммутабельна (заморожена)', () => {
    expect(Object.isFrozen(DEFAULT_MESSAGE_BUS_POLICY)).toBe(true);
    expect(Object.isFrozen(DEFAULT_MESSAGE_BUS_POLICY.queuePolicy)).toBe(true);
  });

  it('createMessageBusPolicy без аргументов эквивалентен default', () => {
    expect(createMessageBusPolicy()).toEqual(DEFAULT_MESSAGE_BUS_POLICY);
  });

  it('createMessageBusPolicy переопределяет только указанные лимиты', () => {
    const policy = createMessageBusPolicy({ queuePolicy: { maxQueueSize: 42 } });
    expect(policy.queuePolicy.maxQueueSize).toBe(42);
    expect(policy.queuePolicy.maxMessagesPerDrain).toBe(10_000);
    expect(policy.overflowPolicy.strategy).toBe('reject-new');

    const both = createMessageBusPolicy({
      queuePolicy: { maxQueueSize: 5, maxMessagesPerDrain: 3 },
    });
    expect(both.queuePolicy).toEqual({ maxQueueSize: 5, maxMessagesPerDrain: 3 });
  });

  it('конструктор синхронно бросает RangeError на невалидный maxQueueSize', () => {
    for (const invalid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new MessageBus<TestMessage>({
        policy: createMessageBusPolicy({ queuePolicy: { maxQueueSize: invalid } }),
      })).toThrow(RangeError);
    }
  });

  it('конструктор синхронно бросает RangeError на невалидный maxMessagesPerDrain', () => {
    for (const invalid of [0, -10, 2.5, NaN, -Infinity]) {
      expect(() => new MessageBus<TestMessage>({
        policy: createMessageBusPolicy({ queuePolicy: { maxMessagesPerDrain: invalid } }),
      })).toThrow(RangeError);
    }
  });

  it('валидная кастомная политика принимается, bus работает', async () => {
    const bus = new MessageBus<TestMessage>({
      policy: createMessageBusPolicy({ queuePolicy: { maxQueueSize: 1, maxMessagesPerDrain: 1 } }),
    });
    const seen: number[] = [];
    bus.subscribe('PRICE', (message) => { seen.push(message.seq); });

    const result = await bus.publish({ type: 'PRICE', seq: 1 });

    expect(result.ok).toBe(true);
    expect(seen).toEqual([1]);
  });

  it('bus без явной политики использует default', async () => {
    const bus = new MessageBus<TestMessage>();
    const result = await bus.publish({ type: 'PRICE', seq: 1 });
    expect(result.ok).toBe(true);
  });
});
