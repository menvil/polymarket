/**
 * Type-level контракт MessageBus — compile-time проверки typed routing (M-001).
 *
 * @remarks
 * Реальные проверки — на этапе компиляции (`tsc --noEmit` включает `__tests__`,
 * ts-jest компилирует файл перед запуском): сломается narrowing подписки, generic
 * граница `TypedMessage` или публичные exports — упадёт typecheck, а не runtime.
 *
 * Все импорты — через root export `@polymarket/message-bus` (не приватные
 * relative-пути): это одновременно фиксирует публичный API пакета.
 *
 * Ключевое доказательство: MessageBus работает и с flat union
 * (`{ type, itemId }`), и с envelope union (`{ type, payload, metadata? }`) —
 * generic граница требует только `{ readonly type: string }` и не зависит от
 * структуры payload.
 */
import { describe, it, expect } from '@jest/globals';
import { MessageBus } from '@polymarket/message-bus';
import type {
  IMessageBus,
  TypedMessage,
  MessageEnvelope,
  MessageHandler,
  MessageBusPublishError,
  MessageBusOverflowError,
  MessageBusCriticalHandlerError,
  MessageBusDrainLimitError,
  MessageBusClosedError,
} from '@polymarket/message-bus';

// ─── Flat union: сообщения без payload-структуры ────────────────────────────────
type FlatMessage =
  | { readonly type: 'ITEM_ADDED'; readonly itemId: string }
  | { readonly type: 'HEARTBEAT'; readonly sequence: number };

// ─── Envelope union: сообщения в стандартизированном конверте ──────────────────
type HeartbeatEnvelope = MessageEnvelope<'HEARTBEAT', { sequence: number }, { source: string }>;
type ItemAddedEnvelope = MessageEnvelope<'ITEM_ADDED', { itemId: string }>;
type EnvelopeMessage = HeartbeatEnvelope | ItemAddedEnvelope;

describe('MessageBus type-level contract', () => {
  it('flat union: subscribe сужает сообщение до конкретного члена union', async () => {
    const bus = new MessageBus<FlatMessage>();

    const unsubHeartbeat = bus.subscribe('HEARTBEAT', (message) => {
      // Если бы message был общим FlatMessage — присваивание не скомпилировалось бы
      const narrowed: { readonly type: 'HEARTBEAT'; readonly sequence: number } = message;
      const value: number = message.sequence;
      void narrowed; void value;
      // @ts-expect-error — у HEARTBEAT-сообщения нет поля itemId
      void message.itemId;
    });

    const unsubItemAdded = bus.subscribe('ITEM_ADDED', (message) => {
      const id: string = message.itemId;
      void id;
      // @ts-expect-error — у ITEM_ADDED-сообщения нет поля sequence
      void message.sequence;
    });

    const result = await bus.publish({ type: 'HEARTBEAT', sequence: 42 });
    expect(result.ok).toBe(true);

    // @ts-expect-error — сообщение с неизвестным type не входит в union
    await bus.publish({ type: 'UNKNOWN', sequence: 1 });

    unsubHeartbeat();
    unsubItemAdded();
  });

  it('envelope union: payload и metadata типизированы, bus их не интерпретирует', async () => {
    const bus = new MessageBus<EnvelopeMessage>();
    const seen: number[] = [];

    bus.subscribe('HEARTBEAT', (message) => {
      // payload сужен до { sequence: number }
      const value: number = message.payload.sequence;
      seen.push(value);
      // metadata сужена до { source: string } | undefined
      const source: string | undefined = message.metadata?.source;
      void source;
      // @ts-expect-error — в payload HEARTBEAT-конверта нет поля itemId
      void message.payload.itemId;
    });

    bus.subscribe('ITEM_ADDED', (message) => {
      const id: string = message.payload.itemId;
      void id;
      // @ts-expect-error — в payload ITEM_ADDED-конверта нет поля sequence
      void message.payload.sequence;
    });

    const result = await bus.publish({
      type: 'HEARTBEAT',
      payload: { sequence: 42 },
      metadata: { source: 'test' },
    });
    expect(result.ok).toBe(true);
    expect(seen).toEqual([42]);

    // @ts-expect-error — payload неверной структуры не компилируется
    await bus.publish({ type: 'HEARTBEAT', payload: { sequence: 'not-a-number' } });

    // @ts-expect-error — metadata неверной структуры не компилируется
    await bus.publish({ type: 'HEARTBEAT', payload: { sequence: 1 }, metadata: { source: 42 } });
  });

  it('generic граница — только TypedMessage: flat и envelope формы ей соответствуют', () => {
    // Обе формы assignable к TypedMessage — компилируется без cast
    const flat: TypedMessage = { type: 'HEARTBEAT', sequence: 1 } as FlatMessage;
    const envelope: TypedMessage = {
      type: 'ITEM_ADDED',
      payload: { itemId: 'item-1' },
    } as ItemAddedEnvelope;
    void flat; void envelope;

    // Сообщение без type не является TypedMessage
    // @ts-expect-error — поле type обязательно
    const invalid: TypedMessage = { sequence: 1 };
    void invalid;

    expect(true).toBe(true);
  });

  it('handler чужого типа не подписывается на другой тип (compile-time)', () => {
    const bus = new MessageBus<FlatMessage>();

    const itemAddedHandler: MessageHandler<Extract<FlatMessage, { type: 'ITEM_ADDED' }>> = () => {};
    // @ts-expect-error — ITEM_ADDED-handler нельзя подписать на HEARTBEAT
    const unsub = bus.subscribe('HEARTBEAT', itemAddedHandler);
    unsub();

    expect(true).toBe(true);
  });

  it('MessageHandler допускает и sync-, и async-обработчики (compile-time)', () => {
    const bus = new MessageBus<FlatMessage>();

    const syncHandler: MessageHandler<Extract<FlatMessage, { type: 'HEARTBEAT' }>> = () => {};
    const asyncHandler: MessageHandler<Extract<FlatMessage, { type: 'HEARTBEAT' }>> = async () => {};
    const unsubSync = bus.subscribe('HEARTBEAT', syncHandler);
    const unsubAsync = bus.subscribe('HEARTBEAT', asyncHandler);
    unsubSync();
    unsubAsync();

    expect(true).toBe(true);
  });

  it('MessageBus присваивается порту IMessageBus, Result типизирован union ошибок', async () => {
    const bus: IMessageBus<FlatMessage> = new MessageBus<FlatMessage>();

    const result = await bus.publish({ type: 'HEARTBEAT', sequence: 1 });
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
