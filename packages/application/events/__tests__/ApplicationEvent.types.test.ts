/**
 * Type-contract тесты @polymarket/application-events.
 *
 * @remarks
 * Пакет types-only, поэтому реальные проверки — compile-time (typecheck/ts-jest):
 * состав union (только application-owned события), discriminated narrowing,
 * невхождение Domain `OrderEvent` и публичные exports корня. Runtime-ассерты
 * минимальны.
 */
import { describe, it, expect } from '@jest/globals';
import type {
  ApplicationEvent,
  FillReceivedEvent,
  FillConfirmedEvent,
  FillFailedEvent,
  DirectFillAppliedEvent,
  BookUpdatedEvent,
  BookDepthEvent,
  TradeReceivedEvent,
  TopOfBook,
  SignalDirection,
  StrategySignalEvent,
  MarketCloseReason,
  MarketOpenedEvent,
  MarketClosedEvent,
  VenueOrderUpdate,
  OrderUpdateReceivedEvent,
} from '../src/index.js';

describe('ApplicationEvent union contract', () => {
  it('каждый application-контракт — член union (compile-time)', () => {
    // Присваивания компилируются только если тип входит в union
    const asUnion = (event: ApplicationEvent): ApplicationEvent => event;
    void asUnion;
    const checks: ReadonlyArray<(e: never) => ApplicationEvent> = [
      (e: FillReceivedEvent) => e,
      (e: FillConfirmedEvent) => e,
      (e: FillFailedEvent) => e,
      (e: DirectFillAppliedEvent) => e,
      (e: BookUpdatedEvent) => e,
      (e: BookDepthEvent) => e,
      (e: TradeReceivedEvent) => e,
      (e: StrategySignalEvent) => e,
      (e: MarketOpenedEvent) => e,
      (e: MarketClosedEvent) => e,
      (e: OrderUpdateReceivedEvent) => e,
    ] as ReadonlyArray<(e: never) => ApplicationEvent>;
    expect(checks.length).toBe(11);
  });

  it('Domain-события Order НЕ входят в ApplicationEvent (compile-time)', () => {
    // Литерал с type: 'ORDER_FILLED' не является членом application-union —
    // domain-контур живёт в @polymarket/order-events, объединение только в
    // EventBusEvent (@polymarket/event-bus)
    // @ts-expect-error — ORDER_FILLED не входит в ApplicationEvent
    const invalid: ApplicationEvent = { type: 'ORDER_FILLED' };
    void invalid;
    expect(true).toBe(true);
  });

  it('discriminated narrowing по type сохраняется (compile-time)', () => {
    const narrow = (event: ApplicationEvent): string => {
      switch (event.type) {
        case 'BOOK_UPDATED': {
          const top: TopOfBook = event.topOfBook;
          void top;
          return event.type;
        }
        case 'STRATEGY_SIGNAL': {
          const direction: SignalDirection = event.signal;
          void direction;
          return event.type;
        }
        case 'MARKET_CLOSED': {
          const reason: MarketCloseReason = event.reason;
          void reason;
          return event.type;
        }
        case 'ORDER_UPDATE_RECEIVED': {
          const update: VenueOrderUpdate = event.update;
          void update;
          return event.type;
        }
        default:
          return event.type;
      }
    };
    expect(typeof narrow).toBe('function');
  });
});
