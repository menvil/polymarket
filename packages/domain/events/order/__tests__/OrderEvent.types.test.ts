/**
 * Type-contract тесты @polymarket/order-events.
 *
 * @remarks
 * Пакет types-only: реальные проверки — compile-time (состав union, canonical
 * envelope-форма каждого member (M-003), discriminated narrowing, публичные
 * exports корня). Runtime-ассерты минимальны.
 */
import { describe, it, expect } from '@jest/globals';
import type { TypedMessage } from '@polymarket/messages';
import type {
  OrderEvent,
  OrderCreatedEvent,
  OrderAcceptedEvent,
  OrderRejectedEvent,
  OrderCancelledEvent,
  OrderExpiredEvent,
  OrderPartiallyFilledEvent,
  OrderFilledEvent,
} from '../src/index.js';

describe('OrderEvent union contract', () => {
  it('каждое domain-событие Order — член union (compile-time)', () => {
    // Явная аннотация возврата у каждой лямбды — настоящая по-членная проверка
    // (каст `as ReadonlyArray<...>` обходил её целиком)
    const checks = [
      (e: OrderCreatedEvent): OrderEvent => e,
      (e: OrderAcceptedEvent): OrderEvent => e,
      (e: OrderRejectedEvent): OrderEvent => e,
      (e: OrderCancelledEvent): OrderEvent => e,
      (e: OrderExpiredEvent): OrderEvent => e,
      (e: OrderPartiallyFilledEvent): OrderEvent => e,
      (e: OrderFilledEvent): OrderEvent => e,
    ];
    expect(checks.length).toBe(7);
  });

  it('каждый member — canonical MessageEnvelope (compile-time)', () => {
    // OrderEvent обязан satisfies TypedMessage = MessageEnvelope<string, unknown, MessageMetadata>
    const canonical = (e: OrderEvent): TypedMessage => e;
    expect(typeof canonical).toBe('function');
  });

  it('flat-форма domain-события больше не существует (compile-time)', () => {
    // @ts-expect-error — flat ORDER_ACCEPTED (поля на верхнем уровне) не является OrderEvent
    const flat: OrderAcceptedEvent = { type: 'ORDER_ACCEPTED', orderId: 'order-1' };
    void flat;

    // @ts-expect-error — metadata обязательна: envelope без неё не компилируется
    const noMetadata: OrderAcceptedEvent = { type: 'ORDER_ACCEPTED', payload: { orderId: 'order-1' } };
    void noMetadata;
    expect(true).toBe(true);
  });

  it('discriminated narrowing по type сохраняется, payload типизирован (compile-time)', () => {
    const narrow = (event: OrderEvent): string => {
      switch (event.type) {
        case 'ORDER_REJECTED':
          return event.payload.reason; // narrowing: поле есть только у REJECTED/CANCELLED
        case 'ORDER_FILLED': {
          const price = event.payload.averagePrice;
          void price;
          return event.type;
        }
        default:
          return event.type;
      }
    };
    expect(typeof narrow).toBe('function');
  });

  it('metadata доступна на каждом member без narrowing (compile-time)', () => {
    const readMetadata = (event: OrderEvent): number => event.metadata.sequence;
    expect(typeof readMetadata).toBe('function');
  });
});
