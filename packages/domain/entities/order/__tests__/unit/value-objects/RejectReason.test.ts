/**
 * Тесты для RejectReason
 */

import {
  RejectReason,
  REJECT_REASONS,
  isValidRejectReason,
} from '../../../src/value-objects/RejectReason';

describe('RejectReason enum', () => {
  it('содержит 14 причин', () => {
    expect(REJECT_REASONS.length).toBe(14);
  });

  it('REJECT_REASONS содержит все значения enum', () => {
    const enumValues = Object.values(RejectReason);
    expect(REJECT_REASONS).toEqual(expect.arrayContaining(enumValues));
    expect(enumValues.length).toBe(REJECT_REASONS.length);
  });

  describe('значения enum', () => {
    it.each([
      ['INVALID_PRICE', RejectReason.INVALID_PRICE],
      ['BELOW_MIN_SIZE', RejectReason.BELOW_MIN_SIZE],
      ['ABOVE_MAX_SIZE', RejectReason.ABOVE_MAX_SIZE],
      ['MARKET_CLOSED', RejectReason.MARKET_CLOSED],
      ['MARKET_HALTED', RejectReason.MARKET_HALTED],
      ['DUPLICATE_ORDER', RejectReason.DUPLICATE_ORDER],
      ['UNKNOWN_INSTRUMENT', RejectReason.UNKNOWN_INSTRUMENT],
      ['INSUFFICIENT_LIQUIDITY', RejectReason.INSUFFICIENT_LIQUIDITY],
      ['SELF_TRADE_PREVENTION', RejectReason.SELF_TRADE_PREVENTION],
      ['RATE_LIMIT_EXCEEDED', RejectReason.RATE_LIMIT_EXCEEDED],
      ['VENUE_ERROR', RejectReason.VENUE_ERROR],
      ['INVALID_ACCOUNT', RejectReason.INVALID_ACCOUNT],
      ['INSUFFICIENT_PERMISSIONS', RejectReason.INSUFFICIENT_PERMISSIONS],
      ['INVALID_ORDER_TYPE', RejectReason.INVALID_ORDER_TYPE],
    ] as const)(
      '%s имеет строковое значение равное ключу',
      (key, value) => expect(value).toBe(key)
    );
  });
});

describe('isValidRejectReason()', () => {
  it('возвращает true для всех валидных причин', () => {
    REJECT_REASONS.forEach(r => expect(isValidRejectReason(r)).toBe(true));
  });

  it('возвращает false для невалидных строк', () => {
    expect(isValidRejectReason('INVALID')).toBe(false);
    expect(isValidRejectReason('invalid_price')).toBe(false);
    expect(isValidRejectReason('')).toBe(false);
    expect(isValidRejectReason('UNKNOWN')).toBe(false);
  });

  it('возвращает false для нестроковых значений', () => {
    expect(isValidRejectReason(null)).toBe(false);
    expect(isValidRejectReason(undefined)).toBe(false);
    expect(isValidRejectReason(42)).toBe(false);
    expect(isValidRejectReason({})).toBe(false);
    expect(isValidRejectReason([])).toBe(false);
  });
});
