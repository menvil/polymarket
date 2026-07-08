import { describe, it, expect } from '@jest/globals';
import { VersionConflictError, ExchangeError } from '../src/index.js';

describe('@polymarket/ports index', () => {
  it('экспортирует value-классы (не только types)', () => {
    expect(VersionConflictError).toBeDefined();
    expect(ExchangeError).toBeDefined();
  });

  it('ExchangeError и VersionConflictError создаются без исключений', () => {
    expect(() => new ExchangeError('boom')).not.toThrow();
    expect(() => new VersionConflictError('acc-1', 0, 1)).not.toThrow();
  });
});
