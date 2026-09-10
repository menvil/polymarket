/**
 * Совпадение инструментов у двух `TokenBalance`.
 *
 * @remarks
 * Правило раньше сравнивало `OutcomeToken`, и его случаи были названы в
 * терминах on-chain полей: `outcomeKey`, `conditionId`, `chainId`. `TokenBalance`
 * переведён на `InstrumentId` — идентичность, которой адресует исход весь
 * остальной контур, — поэтому сравнивать теперь нечего, кроме самого
 * идентификатора. Off-chain площадка `conditionRef` не имеет вовсе, и различать
 * инструменты по нему было бы неверно.
 *
 * Осталось ровно два случая: инструменты совпадают или нет.
 */
import { describe, it, expect } from '@jest/globals';
import { unsafeInstrumentId } from '@polymarket/ids';
import { ValidateTokenMatch } from '../../../../src/token-balance/rules/ValidateTokenMatch.js';
import { TokenBalanceErrorReason } from '../../../../src/token-balance/errors/TokenBalanceErrorReason.js';

const UP = unsafeInstrumentId('instrument-up');
const DOWN = unsafeInstrumentId('instrument-down');

describe('ValidateTokenMatch', () => {
  describe('успешная валидация', () => {
    it('проходит для одного и того же значения', () => {
      expect(ValidateTokenMatch.check(UP, UP).ok).toBe(true);
    });

    it('проходит для равных значений, полученных по отдельности', () => {
      // `InstrumentId` — branded-строка: равенство значений, а не ссылок.
      const first = unsafeInstrumentId('instrument-up');
      const second = unsafeInstrumentId('instrument-up');

      expect(first).not.toBe(UP === first ? DOWN : UP);
      expect(ValidateTokenMatch.check(first, second).ok).toBe(true);
    });
  });

  describe('ошибка TOKEN_MISMATCH', () => {
    it('возвращает ошибку для разных инструментов', () => {
      const result = ValidateTokenMatch.check(UP, DOWN);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.TOKEN_MISMATCH);
      }
    });

    it('сообщение об ошибке называет оба инструмента', () => {
      const result = ValidateTokenMatch.check(UP, DOWN);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('instrument-up');
        expect(result.error.message).toContain('instrument-down');
      }
    });
  });
});
