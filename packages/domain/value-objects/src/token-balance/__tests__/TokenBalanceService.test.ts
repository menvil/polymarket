import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { KnownOnChainProtocols, KnownChainIds, BinaryOutcome } from '@polymarket/ids';
import type { OnChainConditionRef, ConditionId } from '@polymarket/ids';
import { OutcomeToken } from '../../outcome-token/core/OutcomeToken.js';
import { Quantity } from '../../quantity/core/Quantity.js';
import { TokenBalanceService } from '../facade/TokenBalanceService.js';

describe('TokenBalanceService', () => {
  const conditionRef: OnChainConditionRef = {
    kind: 'ONCHAIN',
    protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
    chainId: KnownChainIds.POLYGON,
    conditionId: '0xabc123def4560000000000000000000000000000000000000000000000000000' as ConditionId,
  };

  const token = OutcomeToken.of(conditionRef, BinaryOutcome.UP);
  const qty100 = Quantity.of(new Decimal(100));
  const qty200 = Quantity.of(new Decimal(200));
  const qtyZero = Quantity.ZERO;

  describe('create()', () => {
    it('создаёт TokenBalance с валидными входными данными', () => {
      const result = TokenBalanceService.create(token, qty100);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.token()).toBe(token);
        expect(result.value.amount()).toBe(qty100);
      }
    });

    it('создаёт TokenBalance с нулевым amount', () => {
      const result = TokenBalanceService.create(token, qtyZero);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isZero()).toBe(true);
      }
    });

    it('создаёт TokenBalance для разных outcome keys', () => {
      const upToken = OutcomeToken.of(conditionRef, BinaryOutcome.UP);
      const downToken = OutcomeToken.of(conditionRef, BinaryOutcome.DOWN);

      const upResult = TokenBalanceService.create(upToken, qty100);
      const downResult = TokenBalanceService.create(downToken, qty200);

      expect(upResult.ok).toBe(true);
      expect(downResult.ok).toBe(true);
      if (upResult.ok && downResult.ok) {
        expect(upResult.value.outcomeKey()).toBe(BinaryOutcome.UP);
        expect(downResult.value.outcomeKey()).toBe(BinaryOutcome.DOWN);
        expect(upResult.value.amount().toNumber()).toBe(100);
        expect(downResult.value.amount().toNumber()).toBe(200);
      }
    });

    it('никогда не бросает исключения', () => {
      expect(() => {
        TokenBalanceService.create(token, qty100);
      }).not.toThrow();
    });
  });

  describe('equals()', () => {
    it('возвращает true для равных балансов', () => {
      const balance1 = TokenBalanceService.create(token, qty100);
      const balance2 = TokenBalanceService.create(token, qty100);

      expect(balance1.ok && balance2.ok).toBe(true);
      if (balance1.ok && balance2.ok) {
        const same = TokenBalanceService.equals(balance1.value, balance2.value);
        expect(same).toBe(true);
      }
    });

    it('возвращает false для разных amount', () => {
      const balance1 = TokenBalanceService.create(token, qty100);
      const balance2 = TokenBalanceService.create(token, qty200);

      expect(balance1.ok && balance2.ok).toBe(true);
      if (balance1.ok && balance2.ok) {
        const same = TokenBalanceService.equals(balance1.value, balance2.value);
        expect(same).toBe(false);
      }
    });

    it('возвращает false для разных token', () => {
      const upToken = OutcomeToken.of(conditionRef, BinaryOutcome.UP);
      const downToken = OutcomeToken.of(conditionRef, BinaryOutcome.DOWN);

      const balance1 = TokenBalanceService.create(upToken, qty100);
      const balance2 = TokenBalanceService.create(downToken, qty100);

      expect(balance1.ok && balance2.ok).toBe(true);
      if (balance1.ok && balance2.ok) {
        const same = TokenBalanceService.equals(balance1.value, balance2.value);
        expect(same).toBe(false);
      }
    });

    it('никогда не бросает исключения', () => {
      const balance1 = TokenBalanceService.create(token, qty100);
      const balance2 = TokenBalanceService.create(token, qty200);

      expect(balance1.ok && balance2.ok).toBe(true);
      if (balance1.ok && balance2.ok) {
        expect(() => {
          TokenBalanceService.equals(balance1.value, balance2.value);
        }).not.toThrow();
      }
    });
  });

  describe('isZero()', () => {
    it('возвращает true для нулевого баланса', () => {
      const result = TokenBalanceService.create(token, qtyZero);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const isZero = TokenBalanceService.isZero(result.value);
        expect(isZero).toBe(true);
      }
    });

    it('возвращает false для ненулевого баланса', () => {
      const result = TokenBalanceService.create(token, qty100);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const isZero = TokenBalanceService.isZero(result.value);
        expect(isZero).toBe(false);
      }
    });

    it('никогда не бросает исключения', () => {
      const result = TokenBalanceService.create(token, qty100);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(() => {
          TokenBalanceService.isZero(result.value);
        }).not.toThrow();
      }
    });
  });

  describe('isPositive()', () => {
    it('возвращает false для нулевого баланса', () => {
      const result = TokenBalanceService.create(token, qtyZero);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const isPositive = TokenBalanceService.isPositive(result.value);
        expect(isPositive).toBe(false);
      }
    });

    it('возвращает true для положительного баланса', () => {
      const result = TokenBalanceService.create(token, qty100);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const isPositive = TokenBalanceService.isPositive(result.value);
        expect(isPositive).toBe(true);
      }
    });

    it('никогда не бросает исключения', () => {
      const result = TokenBalanceService.create(token, qty100);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(() => {
          TokenBalanceService.isPositive(result.value);
        }).not.toThrow();
      }
    });
  });
});
