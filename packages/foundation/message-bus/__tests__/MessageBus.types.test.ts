/**
 * Type-level контракт MessageBus — compile-time проверки typed routing (M-001/M-003).
 *
 * @remarks
 * Реальные проверки — на этапе компиляции (`tsc --noEmit` включает `__tests__`,
 * ts-jest компилирует файл перед запуском): сломается narrowing подписки, generic
 * граница `TypedMessage` или публичные exports — упадёт typecheck, а не runtime.
 *
 * Bus-API импортируется через root export `@polymarket/message-bus`; canonical
 * message contract — через своего owner-а `@polymarket/messages` (M-003:
 * message-bus его больше НЕ реэкспортирует).
 *
 * Ключевое доказательство M-003: generic-граница ТРЕБУЕТ canonical envelope
 * `{ type, payload, metadata }` — flat-сообщения больше НЕ проходят compile-time,
 * при этом runtime bus по-прежнему читает только `type`.
 */
import { describe, it, expect } from '@jest/globals';
import { MessageBus } from '@polymarket/message-bus';
import type {
  IMessageBus,
  MessageHandler,
  MessageBusPublishError,
  MessageBusOverflowError,
  MessageBusCriticalHandlerError,
  MessageBusDrainLimitError,
  MessageBusClosedError,
} from '@polymarket/message-bus';
import type { MessageEnvelope, TypedMessage } from '@polymarket/messages';
import { heartbeat, type TestMessage } from './testMessages.js';

// ─── Flat union — БОЛЬШЕ НЕ валидная форма системного сообщения (M-003) ────────
type FlatMessage =
  | { readonly type: 'ITEM_ADDED'; readonly itemId: string }
  | { readonly type: 'HEARTBEAT'; readonly sequence: number };

describe('MessageBus type-level contract', () => {
  it('canonical envelope union: subscribe сужает payload до члена union', async () => {
    const bus = new MessageBus<TestMessage>();
    const seen: number[] = [];

    const unsubHeartbeat = bus.subscribe('HEARTBEAT', (message) => {
      // payload сужен до { seq: number }
      const value: number = message.payload.seq;
      seen.push(value);
      // metadata canonical и обязательна — sequence всегда number
      const metaSeq: number = message.metadata.sequence;
      void metaSeq;
      // @ts-expect-error — в payload HEARTBEAT-сообщения нет поля itemId
      void message.payload.itemId;
    });

    const unsubItemAdded = bus.subscribe('ITEM_ADDED', (message) => {
      const id: string = message.payload.itemId;
      void id;
      // @ts-expect-error — в payload ITEM_ADDED-сообщения нет поля seq
      void message.payload.seq;
    });

    const result = await bus.publish(heartbeat(42));
    expect(result.ok).toBe(true);
    expect(seen).toEqual([42]);

    // @ts-expect-error — сообщение с неизвестным type не входит в union
    await bus.publish({ type: 'UNKNOWN', payload: {}, metadata: heartbeat(1).metadata });

    unsubHeartbeat();
    unsubItemAdded();
  });

  it('M-003: flat union НЕ satisfies generic-границу MessageBus (compile-time)', () => {
    // @ts-expect-error — flat-сообщения не соответствуют canonical TypedMessage
    const bus = new MessageBus<FlatMessage>();
    void bus;

    // Отдельные flat-значения тоже не являются TypedMessage:
    const flat = { type: 'HEARTBEAT', sequence: 1 } as const;
    // @ts-expect-error — нет payload/metadata
    const invalid: TypedMessage = flat;
    void invalid;

    expect(true).toBe(true);
  });

  it('canonical envelope является TypedMessage; поля обязательны (compile-time)', () => {
    const envelope: TypedMessage = heartbeat(1);
    void envelope;

    // Сообщение без type не является TypedMessage
    // @ts-expect-error — поле type обязательно
    const noType: TypedMessage = { payload: {}, metadata: heartbeat(1).metadata };
    void noType;

    // @ts-expect-error — metadata обязательна (canonical envelope)
    const noMetadata: TypedMessage = { type: 'HEARTBEAT', payload: { seq: 1 } };
    void noMetadata;

    expect(true).toBe(true);
  });

  it('bus не интерпретирует payload/metadata: расширенная metadata допустима', async () => {
    // Superset canonical metadata (будущий external-контур M-004)
    interface TransportMetadata extends NonNullable<TestMessage['metadata']> {
      readonly transportSeq: number;
    }
    type ExternalMessage = MessageEnvelope<'EXTERNAL_TICK', { readonly raw: string }, TransportMetadata>;

    const bus = new MessageBus<ExternalMessage>();
    const seen: string[] = [];
    bus.subscribe('EXTERNAL_TICK', (message) => {
      seen.push(message.payload.raw);
      const transportSeq: number = message.metadata.transportSeq;
      void transportSeq;
    });

    const result = await bus.publish({
      type: 'EXTERNAL_TICK',
      payload: { raw: 'x' },
      metadata: { ...heartbeat(1).metadata, transportSeq: 7 },
    });
    expect(result.ok).toBe(true);
    expect(seen).toEqual(['x']);
  });

  it('handler чужого типа не подписывается на другой тип (compile-time)', () => {
    const bus = new MessageBus<TestMessage>();

    const itemAddedHandler: MessageHandler<Extract<TestMessage, { type: 'ITEM_ADDED' }>> = () => {};
    // @ts-expect-error — ITEM_ADDED-handler нельзя подписать на HEARTBEAT
    const unsub = bus.subscribe('HEARTBEAT', itemAddedHandler);
    unsub();

    expect(true).toBe(true);
  });

  it('MessageHandler допускает и sync-, и async-обработчики (compile-time)', () => {
    const bus = new MessageBus<TestMessage>();

    const syncHandler: MessageHandler<Extract<TestMessage, { type: 'HEARTBEAT' }>> = () => {};
    const asyncHandler: MessageHandler<Extract<TestMessage, { type: 'HEARTBEAT' }>> = async () => {};
    const unsubSync = bus.subscribe('HEARTBEAT', syncHandler);
    const unsubAsync = bus.subscribe('HEARTBEAT', asyncHandler);
    unsubSync();
    unsubAsync();

    expect(true).toBe(true);
  });

  it('MessageBus присваивается порту IMessageBus, Result типизирован union ошибок', async () => {
    const bus: IMessageBus<TestMessage> = new MessageBus<TestMessage>();

    const result = await bus.publish(heartbeat(1));
    if (result.ok) {
      const value: void = result.value;
      void value;
    } else {
      // Тип ошибки — ровно публичный union ошибок публикации
      const error: MessageBusPublishError = result.error;
      const isKnown: boolean =
        error instanceof Error &&
        (error.name === 'MessageBusOverflowError' ||
          error.name === 'MessageBusClosedError' ||
          error.name === 'MessageBusCriticalHandlerError' ||
          error.name === 'MessageBusDrainLimitError');
      void isKnown;
    }
    expect(result.ok).toBe(true);

    const drainResult = await bus.drain();
    if (!drainResult.ok) {
      // drain-ошибки — подмножество publish-ошибок: без Overflow/Closed
      const error: MessageBusCriticalHandlerError | MessageBusDrainLimitError = drainResult.error;
      void error;
      // @ts-expect-error — drain не возвращает MessageBusOverflowError
      const wrongOverflow: MessageBusOverflowError = drainResult.error;
      void wrongOverflow;
      // @ts-expect-error — drain не возвращает MessageBusClosedError
      const wrongClosed: MessageBusClosedError = drainResult.error;
      void wrongClosed;
    }
    expect(drainResult.ok).toBe(true);
  });
});
