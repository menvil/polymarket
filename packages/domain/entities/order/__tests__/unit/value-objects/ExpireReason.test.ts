/**
 * Тесты для ExpireReason
 */

import {
  ExpireReason,
  EXPIRE_REASONS,
  isValidExpireReason,
} from '../../../src/value-objects/ExpireReason';

describe('ExpireReason enum', () => {
  it('содержит 6 причин', () => {
    expect(EXPIRE_REASONS.length).toBe(6);
  });

  it('EXPIRE_REASONS содержит все значения enum', () => {
    const enumValues = Object.values(ExpireReason);
    expect(EXPIRE_REASONS).toEqual(expect.arrayContaining(enumValues));
    expect(enumValues.length).toBe(EXPIRE_REASONS.length);
  });

  describe('значения enum', () => {
    it.each([
      ['TIME_IN_FORCE', ExpireReason.TIME_IN_FORCE],
      ['POST_ONLY_FAILED', ExpireReason.POST_ONLY_FAILED],
      ['IOC_NOT_FILLED', ExpireReason.IOC_NOT_FILLED],
      ['FOK_NOT_FILLED', ExpireReason.FOK_NOT_FILLED],
      ['MARKET_SESSION_END', ExpireReason.MARKET_SESSION_END],
      ['CONDITIONAL_NOT_TRIGGERED', ExpireReason.CONDITIONAL_NOT_TRIGGERED],
    ] as const)(
      '%s имеет строковое значение равное ключу',
      (key, value) => expect(value).toBe(key)
    );
  });
});

describe('isValidExpireReason()', () => {
  it('возвращает true для всех валидных причин', () => {
    EXPIRE_REASONS.forEach(r => expect(isValidExpireReason(r)).toBe(true));
  });

  it('возвращает false для невалидных строк', () => {
    expect(isValidExpireReason('INVALID')).toBe(false);
    expect(isValidExpireReason('time_in_force')).toBe(false);
    expect(isValidExpireReason('')).toBe(false);
  });

  it('возвращает false для нестроковых значений', () => {
    expect(isValidExpireReason(null)).toBe(false);
    expect(isValidExpireReason(undefined)).toBe(false);
    expect(isValidExpireReason(true)).toBe(false);
    expect(isValidExpireReason({})).toBe(false);
  });
});
