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
 * (`{ type, price }`), и с envelope union (`{ type, payload, metadata? }`) —
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
  | { readonly type: 'PRICE'; readonly price: number }
  | { readonly type: 'TRADE'; readonly tradeId: string };

// ─── Envelope union: сообщения в стандартизированном конверте ──────────────────
type PriceEnvelope = MessageEnvelope<'PRICE', { price: number }, { source: string }>;
type TradeEnvelope = MessageEnvelope<'TRADE', { tradeId: string }>;
type EnvelopeMessage = PriceEnvelope | TradeEnvelope;

describe('MessageBus type-level contract', () => {
  it('flat union: subscribe сужает сообщение до конкретного члена union', async () => {
    const bus = new MessageBus<FlatMessage>();

    const unsubPrice = bus.subscribe('PRICE', (message) => {
      // Если бы message был общим FlatMessage — присваивание не скомпилировалось бы
      const narrowed: { readonly type: 'PRICE'; readonly price: number } = message;
      const value: number = message.price;
      void narrowed; void value;
      // @ts-expect-error — у PRICE-сообщения нет поля tradeId
      void message.tradeId;
    });

    const unsubTrade = bus.subscribe('TRADE', (message) => {
      const id: string = message.tradeId;
      void id;
      // @ts-expect-error — у TRADE-сообщения нет поля price
      void message.price;
    });

    const result = await bus.publish({ type: 'PRICE', price: 0.42 });
    expect(result.ok).toBe(true);

    // @ts-expect-error — сообщение с неизвестным type не входит в union
    await bus.publish({ type: 'UNKNOWN', price: 1 });

    unsubPrice();
    unsubTrade();
  });

  it('envelope union: payload и metadata типизированы, bus их не интерпретирует', async () => {
    const bus = new MessageBus<EnvelopeMessage>();
    const seen: number[] = [];

    bus.subscribe('PRICE', (message) => {
      // payload сужен до { price: number }
      const value: number = message.payload.price;
      seen.push(value);
      // metadata сужена до { source: string } | undefined
      const source: string | undefined = message.metadata?.source;
      void source;
      // @ts-expect-error — в payload PRICE-конверта нет поля tradeId
      void message.payload.tradeId;
    });

    bus.subscribe('TRADE', (message) => {
      const id: string = message.payload.tradeId;
      void id;
      // @ts-expect-error — в payload TRADE-конверта нет поля price
      void message.payload.price;
    });

    const result = await bus.publish({
      type: 'PRICE',
      payload: { price: 0.42 },
      metadata: { source: 'test' },
    });
    expect(result.ok).toBe(true);
    expect(seen).toEqual([0.42]);

    // @ts-expect-error — payload неверной структуры не компилируется
    await bus.publish({ type: 'PRICE', payload: { price: 'not-a-number' } });

    // @ts-expect-error — metadata неверной структуры не компилируется
    await bus.publish({ type: 'PRICE', payload: { price: 1 }, metadata: { source: 42 } });
  });

  it('generic граница — только TypedMessage: flat и envelope формы ей соответствуют', () => {
    // Обе формы assignable к TypedMessage — компилируется без cast
    const flat: TypedMessage = { type: 'PRICE', price: 1 } as FlatMessage;
    const envelope: TypedMessage = {
      type: 'TRADE',
      payload: { tradeId: 't' },
    } as TradeEnvelope;
    void flat; void envelope;

    // Сообщение без type не является TypedMessage
    // @ts-expect-error — поле type обязательно
    const invalid: TypedMessage = { price: 1 };
    void invalid;

    expect(true).toBe(true);
  });

  it('handler чужого типа не подписывается на другой тип (compile-time)', () => {
    const bus = new MessageBus<FlatMessage>();

    const tradeHandler: MessageHandler<Extract<FlatMessage, { type: 'TRADE' }>> = () => {};
    // @ts-expect-error — TRADE-handler нельзя подписать на PRICE
    const unsub = bus.subscribe('PRICE', tradeHandler);
    unsub();

    expect(true).toBe(true);
  });

  it('MessageHandler допускает и sync-, и async-обработчики (compile-time)', () => {
    const bus = new MessageBus<FlatMessage>();

    const syncHandler: MessageHandler<Extract<FlatMessage, { type: 'PRICE' }>> = () => {};
    const asyncHandler: MessageHandler<Extract<FlatMessage, { type: 'PRICE' }>> = async () => {};
    const unsubSync = bus.subscribe('PRICE', syncHandler);
    const unsubAsync = bus.subscribe('PRICE', asyncHandler);
    unsubSync();
    unsubAsync();

    expect(true).toBe(true);
  });

  it('MessageBus присваивается порту IMessageBus, Result типизирован union ошибок', async () => {
    const bus: IMessageBus<FlatMessage> = new MessageBus<FlatMessage>();

    const result = await bus.publish({ type: 'PRICE', price: 1 });
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
