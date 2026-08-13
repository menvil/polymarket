/**
 * Type-level контракт EventBus — compile-time проверки typed routing (M-000).
 *
 * @remarks
 * Реальные проверки здесь — на этапе компиляции (`tsc --noEmit` включает `__tests__`,
 * ts-jest компилирует файл перед запуском): если narrowing `subscribe()` сломается или
 * пропадут публичные exports из корня пакета — упадёт typecheck/компиляция, а не
 * runtime-ассерты. Runtime-часть минимальна и лишь фиксирует, что подписки реально
 * регистрируются.
 *
 * Все импорты — из корня пакета (`../src/index.js`): это одновременно фиксирует
 * публичные exports (`EventBus`, `IEventBus`, `EventHandler`, типы событий).
 */
import { describe, it, expect, jest } from '@jest/globals';
import type { ILogger } from '@polymarket/logger';
import { EventBus } from '../src/index.js';
import type {
  IEventBus,
  EventHandler,
  ApplicationEvent,
  BookUpdatedEvent,
  TopOfBook,
  FillReceivedEvent,
  OrderUpdateReceivedEvent,
  VenueOrderUpdate,
} from '../src/index.js';

/** Минимальный mock logger. */
function makeLogger(): ILogger {
  return {
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn().mockReturnThis(),
  } as unknown as ILogger;
}

describe('EventBus type-level contract', () => {
  it('subscribe сужает событие до конкретного члена union (BOOK_UPDATED / FILL_RECEIVED / ORDER_UPDATE_RECEIVED)', () => {
    const bus: IEventBus = new EventBus(makeLogger());

    const unsubBook = bus.subscribe('BOOK_UPDATED', (event) => {
      // Если бы event был общим ApplicationEvent — это присваивание не скомпилировалось бы
      const narrowed: BookUpdatedEvent = event;
      const top: TopOfBook = event.topOfBook;
      const seq: number = event.sequenceNumber;
      void narrowed; void top; void seq;
      // @ts-expect-error — у BookUpdatedEvent нет поля fill (это поле FillReceivedEvent)
      void event.fill;
    });

    const unsubFill = bus.subscribe('FILL_RECEIVED', (event) => {
      const narrowed: FillReceivedEvent = event;
      const fill: FillReceivedEvent['fill'] = event.fill;
      void narrowed; void fill;
      // @ts-expect-error — у FillReceivedEvent нет поля topOfBook
      void event.topOfBook;
    });

    const unsubOrderUpdate = bus.subscribe('ORDER_UPDATE_RECEIVED', (event) => {
      const narrowed: OrderUpdateReceivedEvent = event;
      const update: VenueOrderUpdate = event.update;
      void narrowed; void update;
      // @ts-expect-error — у OrderUpdateReceivedEvent нет поля sequenceNumber
      void event.sequenceNumber;
    });

    expect(typeof unsubBook).toBe('function');
    expect(typeof unsubFill).toBe('function');
    expect(typeof unsubOrderUpdate).toBe('function');
  });

  it('handler чужого типа события не подписывается на другой тип (compile-time)', () => {
    const bus: IEventBus = new EventBus(makeLogger());

    const fillHandler: EventHandler<FillReceivedEvent> = () => {};
    // @ts-expect-error — FILL_RECEIVED-handler нельзя подписать на BOOK_UPDATED
    const unsub = bus.subscribe('BOOK_UPDATED', fillHandler);

    expect(typeof unsub).toBe('function');
  });

  it('EventHandler допускает и sync-, и async-handlers (compile-time)', () => {
    const bus: IEventBus = new EventBus(makeLogger());

    const syncHandler: EventHandler<BookUpdatedEvent> = () => {};
    const asyncHandler: EventHandler<BookUpdatedEvent> = async () => {};
    const unsubSync = bus.subscribe('BOOK_UPDATED', syncHandler);
    const unsubAsync = bus.subscribe('BOOK_UPDATED', asyncHandler);

    expect(typeof unsubSync).toBe('function');
    expect(typeof unsubAsync).toBe('function');
  });

  it('publish/publishAll типизированы Promise<Result<void, QueueOverflowError | CriticalHandlerError>> (compile-time)', async () => {
    const bus: IEventBus = new EventBus(makeLogger());

    const event: ApplicationEvent = {
      type: 'BOOK_UPDATED',
      topOfBook: {
        bestBid: undefined,
        bestAsk: undefined,
        spread: undefined,
        bestBidSize: undefined,
        bestAskSize: undefined,
      },
      instrumentId: 'token-123' as BookUpdatedEvent['instrumentId'],
      marketId: 'market-abc' as BookUpdatedEvent['marketId'],
      sequenceNumber: 1,
      timestamp: { toISO: () => '' } as BookUpdatedEvent['timestamp'],
    };

    const result = await bus.publish(event);
    if (result.ok) {
      const value: void = result.value;
      void value;
    } else {
      // Тип ошибки — ровно union двух typed-ошибок публичного контракта
      const err: import('@polymarket/errors/event-bus').QueueOverflowError
        | import('@polymarket/errors/event-bus').CriticalHandlerError = result.error;
      void err;
    }
    expect(result.ok).toBe(true);

    const batchResult = await bus.publishAll([event]);
    expect(batchResult.ok).toBe(true);
  });
});
