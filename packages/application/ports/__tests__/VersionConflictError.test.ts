import { describe, it, expect } from '@jest/globals';
import { VersionConflictError } from '../src/VersionConflictError.js';
import { TradingError } from '@polymarket/errors';

describe('VersionConflictError', () => {
  it('является TradingError с severity=low', () => {
    const err = new VersionConflictError('acc-1', 3, 4);
    expect(err).toBeInstanceOf(TradingError);
    expect(err.severity).toBe('low');
  });

  it('хранит resourceId/expected/actual как типизированные поля, а не только в message', () => {
    const err = new VersionConflictError('acc-1', 3, 4);
    expect(err.resourceId).toBe('acc-1');
    expect(err.expected).toBe(3);
    expect(err.actual).toBe(4);
  });

  it('передаёт resourceId/expected/actual в context для structured logging', () => {
    const err = new VersionConflictError('acc-1', 3, 4);
    expect(err.context).toEqual({ resourceId: 'acc-1', expected: 3, actual: 4 });
  });

  it('формирует читаемое message', () => {
    const err = new VersionConflictError('acc-1', 3, 4);
    expect(err.message).toBe('Version conflict for acc-1: expected 3, got 4');
  });

  it('работает и для orderId как resourceId (переиспользуется IOrderRepository)', () => {
    const err = new VersionConflictError('0xorder-1', 0, 2);
    expect(err.resourceId).toBe('0xorder-1');
    expect(err.message).toBe('Version conflict for 0xorder-1: expected 0, got 2');
  });
});
