/**
 * Type-contract тесты @polymarket/order-events.
 *
 * @remarks
 * Пакет types-only: реальные проверки — compile-time (состав union, discriminated
 * narrowing, публичные exports корня). Runtime-ассерты минимальны.
 */
import { describe, it, expect } from '@jest/globals';
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

  it('discriminated narrowing по type сохраняется (compile-time)', () => {
    const narrow = (event: OrderEvent): string => {
      switch (event.type) {
        case 'ORDER_REJECTED':
          return event.reason; // narrowing: поле есть только у REJECTED/CANCELLED
        case 'ORDER_FILLED': {
          const price = event.averagePrice;
          void price;
          return event.type;
        }
        default:
          return event.type;
      }
    };
    expect(typeof narrow).toBe('function');
  });
});
