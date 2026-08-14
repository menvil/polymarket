/**
 * Type-contract тесты @polymarket/application-events.
 *
 * @remarks
 * Пакет types-only, поэтому реальные проверки — compile-time (typecheck/ts-jest):
 * состав union (только application-owned события), canonical envelope-форма
 * каждого member (M-003: `{ type, payload, metadata }`), discriminated narrowing,
 * невхождение Domain `OrderEvent` и публичные exports корня. Runtime-ассерты
 * минимальны.
 */
import { describe, it, expect } from '@jest/globals';
import type { TypedMessage } from '@polymarket/messages';
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
    // Явная аннотация возврата у КАЖДОЙ лямбды — настоящая по-членная проверка:
    // тело `=> e` компилируется только если тип входит в union. Никаких кастов —
    // `as ReadonlyArray<...>` обходил проверку целиком (ловилось probe-ом с чужим типом).
    const checks = [
      (e: FillReceivedEvent): ApplicationEvent => e,
      (e: FillConfirmedEvent): ApplicationEvent => e,
      (e: FillFailedEvent): ApplicationEvent => e,
      (e: DirectFillAppliedEvent): ApplicationEvent => e,
      (e: BookUpdatedEvent): ApplicationEvent => e,
      (e: BookDepthEvent): ApplicationEvent => e,
      (e: TradeReceivedEvent): ApplicationEvent => e,
      (e: StrategySignalEvent): ApplicationEvent => e,
      (e: MarketOpenedEvent): ApplicationEvent => e,
      (e: MarketClosedEvent): ApplicationEvent => e,
      (e: OrderUpdateReceivedEvent): ApplicationEvent => e,
    ];
    expect(checks.length).toBe(11);
  });

  it('каждый member — canonical MessageEnvelope (compile-time)', () => {
    // ApplicationEvent обязан satisfies TypedMessage = MessageEnvelope<string, unknown, MessageMetadata>:
    // тело `=> e` компилируется только если у КАЖДОГО member есть type+payload+metadata
    const canonical = (e: ApplicationEvent): TypedMessage => e;
    expect(typeof canonical).toBe('function');
  });

  it('flat-форма события больше не существует (compile-time)', () => {
    // @ts-expect-error — flat FILL_RECEIVED (поля на верхнем уровне) не является ApplicationEvent
    const flat: FillReceivedEvent = { type: 'FILL_RECEIVED', fill: {}, receivedAt: {} };
    void flat;

    // metadata обязательна — envelope без неё не компилируется
    // @ts-expect-error — metadata required
    const noMetadata: DirectFillAppliedEvent = { type: 'DIRECT_FILL_APPLIED', payload: { fill: {} } };
    void noMetadata;
    expect(true).toBe(true);
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

  it('discriminated narrowing по type сохраняется, payload типизирован (compile-time)', () => {
    const narrow = (event: ApplicationEvent): string => {
      switch (event.type) {
        case 'BOOK_UPDATED': {
          const top: TopOfBook = event.payload.topOfBook;
          void top;
          return event.type;
        }
        case 'STRATEGY_SIGNAL': {
          const direction: SignalDirection = event.payload.signal;
          void direction;
          return event.type;
        }
        case 'MARKET_CLOSED': {
          const reason: MarketCloseReason = event.payload.reason;
          void reason;
          return event.type;
        }
        case 'ORDER_UPDATE_RECEIVED': {
          const update: VenueOrderUpdate = event.payload.update;
          void update;
          return event.type;
        }
        default:
          return event.type;
      }
    };
    expect(typeof narrow).toBe('function');
  });

  it('metadata доступна на каждом member без narrowing (compile-time)', () => {
    const readMetadata = (event: ApplicationEvent): number => event.metadata.sequence;
    expect(typeof readMetadata).toBe('function');
  });
});
