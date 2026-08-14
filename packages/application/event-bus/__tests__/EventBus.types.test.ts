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
import { MessageMetadataGenerator } from '@polymarket/messages';
import { unsafeRunId } from '@polymarket/ids';
import type { ILogger } from '@polymarket/logger';
import type { StrategyId } from '@polymarket/ids';
import { asStrategyId } from '@polymarket/ids';
import { EventBus } from '../src/index.js';
import type { IEventBus, EventHandler, EventBusEvent } from '../src/index.js';
// Event contracts — из canonical owner-пакетов: application-события из
// @polymarket/application-events, domain-события Order из @polymarket/order-events;
// пакет доставки владеет только union контура EventBusEvent
import type {
  ApplicationEvent,
  BookUpdatedEvent,
  TopOfBook,
  FillReceivedEvent,
  OrderUpdateReceivedEvent,
  VenueOrderUpdate,
  MarketOpenedEvent,
  StrategySignalEvent,
} from '@polymarket/application-events';
import type { OrderEvent, OrderFilledEvent } from '@polymarket/order-events';

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

/** Детерминированный canonical-генератор metadata тестовых событий (M-003). */
const METADATA_GENERATOR = new MessageMetadataGenerator({
  clock: { now: () => new Date('2024-01-01T00:00:00.000Z') },
  runId: unsafeRunId('testrun1'),
});

describe('EventBus type-level contract', () => {
  it('subscribe сужает событие до конкретного члена union (BOOK_UPDATED / FILL_RECEIVED / ORDER_UPDATE_RECEIVED)', () => {
    const bus: IEventBus = new EventBus(makeLogger());

    const unsubBook = bus.subscribe('BOOK_UPDATED', (event) => {
      // Если бы event был общим ApplicationEvent — это присваивание не скомпилировалось бы
      const narrowed: BookUpdatedEvent = event;
      const top: TopOfBook = event.payload.topOfBook;
      const seq: number = event.payload.sequenceNumber;
      void narrowed; void top; void seq;
      // @ts-expect-error — у payload BookUpdatedEvent нет поля fill (это поле FillReceivedEvent)
      void event.payload.fill;
    });

    const unsubFill = bus.subscribe('FILL_RECEIVED', (event) => {
      const narrowed: FillReceivedEvent = event;
      const fill: FillReceivedEvent['payload']['fill'] = event.payload.fill;
      void narrowed; void fill;
      // @ts-expect-error — у payload FillReceivedEvent нет поля topOfBook
      void event.payload.topOfBook;
    });

    const unsubOrderUpdate = bus.subscribe('ORDER_UPDATE_RECEIVED', (event) => {
      const narrowed: OrderUpdateReceivedEvent = event;
      const update: VenueOrderUpdate = event.payload.update;
      void narrowed; void update;
      // @ts-expect-error — у payload OrderUpdateReceivedEvent нет поля sequenceNumber
      void event.payload.sequenceNumber;
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

  it('EventBusEvent — union двух контуров: Application и Domain Order (compile-time)', () => {
    const bus = new EventBus(makeLogger());

    // Оба union входят в контур доставки
    const asDelivery = (e: ApplicationEvent | OrderEvent): EventBusEvent => e;
    void asDelivery;

    // Typed subscribe narrowing работает для ОБОИХ контуров
    const unsubApp = bus.subscribe('FILL_RECEIVED', (event) => {
      const narrowed: FillReceivedEvent = event;
      void narrowed;
    });
    const unsubOrder = bus.subscribe('ORDER_FILLED', (event) => {
      const narrowed: OrderFilledEvent = event;
      const price = event.payload.averagePrice;
      void narrowed; void price;
      // @ts-expect-error — у payload OrderFilledEvent нет поля topOfBook
      void event.payload.topOfBook;
    });

    // Negative: domain-событие НЕ присваивается application-union
    const check = (orderEvent: OrderFilledEvent): ApplicationEvent =>
      // @ts-expect-error — OrderFilledEvent не входит в ApplicationEvent
      orderEvent;
    void check;

    unsubApp();
    unsubOrder();
    expect(true).toBe(true);
  });

  it('strategyId в событиях — canonical branded StrategyId, plain string не подставляется (compile-time)', () => {
    const strategyId: StrategyId = asStrategyId('strategy-1')!;

    const opened: MarketOpenedEvent = {
      type: 'MARKET_OPENED',
      payload: {
        marketId: 'market-abc' as MarketOpenedEvent['payload']['marketId'],
        strategyId,
        allocatedBalance: {} as unknown as MarketOpenedEvent['payload']['allocatedBalance'],
        timestamp: { toISO: () => '' } as MarketOpenedEvent['payload']['timestamp'],
      },
      metadata: METADATA_GENERATOR.nextRoot(),
    };
    void opened;

    const signal: StrategySignalEvent = {
      type: 'STRATEGY_SIGNAL',
      payload: {
        strategyId,
        signal: 'BUY',
        instrumentId: 'token-123' as StrategySignalEvent['payload']['instrumentId'],
      },
      metadata: METADATA_GENERATOR.nextRoot(),
    };
    void signal;

    const invalidOpened: MarketOpenedEvent = {
      type: 'MARKET_OPENED',
      payload: {
        marketId: 'market-abc' as MarketOpenedEvent['payload']['marketId'],
        // @ts-expect-error — plain string нельзя подставить туда, где ожидается StrategyId
        strategyId: 'raw-string',
        allocatedBalance: {} as unknown as MarketOpenedEvent['payload']['allocatedBalance'],
        timestamp: { toISO: () => '' } as MarketOpenedEvent['payload']['timestamp'],
      },
      metadata: METADATA_GENERATOR.nextRoot(),
    };
    void invalidOpened;

    const invalidSignal: StrategySignalEvent = {
      type: 'STRATEGY_SIGNAL',
      payload: {
        // @ts-expect-error — plain string нельзя подставить туда, где ожидается StrategyId
        strategyId: 'raw-string',
        signal: 'SELL',
        instrumentId: 'token-123' as StrategySignalEvent['payload']['instrumentId'],
      },
      metadata: METADATA_GENERATOR.nextRoot(),
    };
    void invalidSignal;

    expect(true).toBe(true);
  });

  it('publish/publishAll типизированы Promise<Result<void, QueueOverflowError | CriticalHandlerError>> (compile-time)', async () => {
    const bus: IEventBus = new EventBus(makeLogger());

    const event: ApplicationEvent = {
      type: 'BOOK_UPDATED',
      payload: {
        topOfBook: {
          bestBid: undefined,
          bestAsk: undefined,
          spread: undefined,
          bestBidSize: undefined,
          bestAskSize: undefined,
        },
        instrumentId: 'token-123' as BookUpdatedEvent['payload']['instrumentId'],
        marketId: 'market-abc' as BookUpdatedEvent['payload']['marketId'],
        sequenceNumber: 1,
        timestamp: { toISO: () => '' } as BookUpdatedEvent['payload']['timestamp'],
      },
      metadata: METADATA_GENERATOR.nextRoot(),
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
