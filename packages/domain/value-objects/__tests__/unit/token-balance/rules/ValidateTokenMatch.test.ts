import { describe, it, expect } from '@jest/globals';
import { ValidateTokenMatch } from '../../../../src/token-balance/rules/ValidateTokenMatch.js';
import { OutcomeToken } from '../../../../src/outcome-token/core/OutcomeToken.js';
import { TokenBalanceErrorReason } from '../../../../src/token-balance/errors/TokenBalanceErrorReason.js';
import { BinaryOutcome, KnownOnChainProtocols } from '@polymarket/ids';
import type { OnChainConditionRef, ConditionId, ChainId } from '@polymarket/ids';

describe('ValidateTokenMatch', () => {
  const conditionRef1: OnChainConditionRef = {
    kind: 'ONCHAIN',
    protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
    chainId: 137 as ChainId,
    conditionId: '0x1234567890123456789012345678901234567890123456789012345678901234' as ConditionId,
  };

  const conditionRef2: OnChainConditionRef = {
    kind: 'ONCHAIN',
    protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
    chainId: 137 as ChainId,
    conditionId: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd' as ConditionId,
  };

  describe('успешная валидация', () => {
    it('проходит если токены идентичны (тот же объект)', () => {
      const token = OutcomeToken.of(conditionRef1, BinaryOutcome.UP);

      const result = ValidateTokenMatch.check(token, token);

      expect(result.ok).toBe(true);
    });

    it('проходит если токены равны (разные объекты, одинаковые данные)', () => {
      const token1 = OutcomeToken.of(conditionRef1, BinaryOutcome.UP);
      const token2 = OutcomeToken.of(conditionRef1, BinaryOutcome.UP);

      const result = ValidateTokenMatch.check(token1, token2);

      expect(result.ok).toBe(true);
    });

    it('проходит для DOWN токенов', () => {
      const token1 = OutcomeToken.of(conditionRef1, BinaryOutcome.DOWN);
      const token2 = OutcomeToken.of(conditionRef1, BinaryOutcome.DOWN);

      const result = ValidateTokenMatch.check(token1, token2);

      expect(result.ok).toBe(true);
    });
  });

  describe('ошибка TOKEN_MISMATCH', () => {
    it('возвращает ошибку если outcomeKey разные (UP vs DOWN)', () => {
      const tokenUp = OutcomeToken.of(conditionRef1, BinaryOutcome.UP);
      const tokenDown = OutcomeToken.of(conditionRef1, BinaryOutcome.DOWN);

      const result = ValidateTokenMatch.check(tokenUp, tokenDown);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.TOKEN_MISMATCH);
        expect(result.error.context?.token1OutcomeKey).toBe('UP');
        expect(result.error.context?.token2OutcomeKey).toBe('DOWN');
      }
    });

    it('возвращает ошибку если conditionId разные', () => {
      const token1 = OutcomeToken.of(conditionRef1, BinaryOutcome.UP);
      const token2 = OutcomeToken.of(conditionRef2, BinaryOutcome.UP);

      const result = ValidateTokenMatch.check(token1, token2);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.TOKEN_MISMATCH);
      }
    });

    it('содержит читаемое сообщение об ошибке', () => {
      const tokenUp = OutcomeToken.of(conditionRef1, BinaryOutcome.UP);
      const tokenDown = OutcomeToken.of(conditionRef1, BinaryOutcome.DOWN);

      const result = ValidateTokenMatch.check(tokenUp, tokenDown);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Token mismatch');
      }
    });

    it('возвращает ошибку для разных chainId', () => {
      const conditionRefEthereum: OnChainConditionRef = {
        kind: 'ONCHAIN',
        protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
        chainId: 1 as ChainId,  // Ethereum mainnet
        conditionId: '0x1234567890123456789012345678901234567890123456789012345678901234' as ConditionId,
      };

      const token1 = OutcomeToken.of(conditionRef1, BinaryOutcome.UP);
      const token2 = OutcomeToken.of(conditionRefEthereum, BinaryOutcome.UP);

      const result = ValidateTokenMatch.check(token1, token2);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.TOKEN_MISMATCH);
      }
    });
  });
});
