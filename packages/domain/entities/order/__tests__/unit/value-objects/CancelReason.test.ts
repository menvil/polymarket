/**
 * Тесты для CancelReason
 */

import {
  CancelReason,
  CANCEL_REASONS,
  isValidCancelReason,
} from '../../../src/value-objects/CancelReason';

describe('CancelReason enum', () => {
  it('содержит 8 причин', () => {
    expect(CANCEL_REASONS.length).toBe(8);
  });

  it('CANCEL_REASONS содержит все значения enum', () => {
    const enumValues = Object.values(CancelReason);
    expect(CANCEL_REASONS).toEqual(expect.arrayContaining(enumValues));
    expect(enumValues.length).toBe(CANCEL_REASONS.length);
  });

  describe('значения enum', () => {
    it.each([
      ['USER_REQUESTED', CancelReason.USER_REQUESTED],
      ['INSUFFICIENT_BALANCE', CancelReason.INSUFFICIENT_BALANCE],
      ['RISK_LIMIT_EXCEEDED', CancelReason.RISK_LIMIT_EXCEEDED],
      ['POSITION_CLOSED', CancelReason.POSITION_CLOSED],
      ['STRATEGY_STOPPED', CancelReason.STRATEGY_STOPPED],
      ['REPLACED_BY_NEW', CancelReason.REPLACED_BY_NEW],
      ['MARKET_CONDITIONS_CHANGED', CancelReason.MARKET_CONDITIONS_CHANGED],
      ['ADMINISTRATIVE', CancelReason.ADMINISTRATIVE],
    ] as const)(
      '%s имеет строковое значение равное ключу',
      (key, value) => expect(value).toBe(key)
    );
  });
});

describe('isValidCancelReason()', () => {
  it('возвращает true для всех валидных причин', () => {
    CANCEL_REASONS.forEach(r => expect(isValidCancelReason(r)).toBe(true));
  });

  it('возвращает false для невалидных строк', () => {
    expect(isValidCancelReason('INVALID')).toBe(false);
    expect(isValidCancelReason('user_requested')).toBe(false);
    expect(isValidCancelReason('')).toBe(false);
  });

  it('возвращает false для нестроковых значений', () => {
    expect(isValidCancelReason(null)).toBe(false);
    expect(isValidCancelReason(undefined)).toBe(false);
    expect(isValidCancelReason(0)).toBe(false);
    expect(isValidCancelReason({})).toBe(false);
  });
});
