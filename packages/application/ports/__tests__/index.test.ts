import { describe, it, expect } from '@jest/globals';
import { VersionConflictError, ExchangeError, OrderStateConflictError } from '../src/index.js';
import type { DeleteOrderResult } from '../src/index.js';
import type { OrderId } from '@polymarket/ids';

describe('@polymarket/ports index', () => {
  it('экспортирует value-классы (не только types)', () => {
    expect(VersionConflictError).toBeDefined();
    expect(ExchangeError).toBeDefined();
    expect(OrderStateConflictError).toBeDefined();
  });

  it('ExchangeError и VersionConflictError создаются без исключений', () => {
    expect(() => new ExchangeError('boom')).not.toThrow();
    expect(() => new VersionConflictError('acc-1', 0, 1)).not.toThrow();
  });

  it('OrderStateConflictError хранит orderId/expectedStates/actualState и name', () => {
    const orderId = 'order-1' as unknown as OrderId;
    const err = new OrderStateConflictError(orderId, ['FILLED', 'CANCELED'], 'OPEN');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('OrderStateConflictError');
    expect(err.orderId).toBe(orderId);
    expect(err.expectedStates).toEqual(['FILLED', 'CANCELED']);
    expect(err.actualState).toBe('OPEN');
    expect(err.message).toBe(
      'Order order-1 state conflict: expected one of [FILLED, CANCELED], got OPEN',
    );
  });

  it('DeleteOrderResult экспортируется как тип (compile-time проверка)', () => {
    const deleted: DeleteOrderResult = { status: 'DELETED' };
    const notFound: DeleteOrderResult = { status: 'NOT_FOUND' };
    expect(deleted.status).toBe('DELETED');
    expect(notFound.status).toBe('NOT_FOUND');
  });
});
