import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { KnownOnChainProtocols, KnownChainIds, BinaryOutcome } from '@polymarket/ids';
import type { OnChainConditionRef, ConditionId } from '@polymarket/ids';
import { OutcomeToken } from '../../outcome-token/core/OutcomeToken.js';
import { Quantity } from '../../quantity/core/Quantity.js';
import { TokenBalanceService } from '../facade/TokenBalanceService.js';
import { TokenBalanceFormatter } from '../adapters/TokenBalanceFormatter.js';

describe('TokenBalanceFormatter', () => {
  const conditionRef: OnChainConditionRef = {
    kind: 'ONCHAIN',
    protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
    chainId: KnownChainIds.POLYGON,
    conditionId: '0xabc123def4567890000000000000000000000000000000000000000000000000' as ConditionId,
  };

  const token = OutcomeToken.of(conditionRef, BinaryOutcome.UP);
  const qty = Quantity.of(new Decimal('100.5'));

  const balance = TokenBalanceService.create(token, qty);
  if (!balance.ok) throw new Error('Failed to create balance');
  const testBalance = balance.value;

  describe('toString()', () => {
    it('форматирует TokenBalance как полную строку', () => {
      const str = TokenBalanceFormatter.toString(testBalance);

      expect(str).toContain('TokenBalance[');
      expect(str).toContain('amount=100.5');
      expect(str).toContain('token=OUTCOME_TOKEN');
      expect(str).toContain('ONCHAIN');
      expect(str).toContain(KnownOnChainProtocols.POLYMARKET_CTF);
      expect(str).toContain('137');
      expect(str).toContain('0xabc123def456789');
      expect(str).toContain('UP');
    });

    it('никогда не бросает исключения', () => {
      expect(() => {
        TokenBalanceFormatter.toString(testBalance);
      }).not.toThrow();
    });
  });

  describe('toDisplayString()', () => {
    it('форматирует TokenBalance для UI', () => {
      const display = TokenBalanceFormatter.toDisplayString(testBalance);

      expect(display).toContain('100.5');
      expect(display).toContain('UP');
      expect(display).toContain(KnownOnChainProtocols.POLYMARKET_CTF);
      expect(display).toContain('137');
      // Должен содержать сокращенный conditionId
      expect(display).toContain('0xabc1');
    });

    it('никогда не бросает исключения', () => {
      expect(() => {
        TokenBalanceFormatter.toDisplayString(testBalance);
      }).not.toThrow();
    });
  });

  describe('toShortString()', () => {
    it('форматирует TokenBalance в краткую строку', () => {
      const short = TokenBalanceFormatter.toShortString(testBalance);

      expect(short).toBe('100.5 UP');
    });

    it('никогда не бросает исключения', () => {
      expect(() => {
        TokenBalanceFormatter.toShortString(testBalance);
      }).not.toThrow();
    });
  });

  describe('toVerboseString()', () => {
    it('форматирует TokenBalance с полной информацией', () => {
      const verbose = TokenBalanceFormatter.toVerboseString(testBalance);

      expect(verbose).toContain('TokenBalance[');
      expect(verbose).toContain('amount=100.5');
      expect(verbose).toContain('token=OutcomeToken[');
      expect(verbose).toContain('outcomeKey=UP');
      expect(verbose).toContain('condition=ONCHAIN:');
      expect(verbose).toContain(KnownOnChainProtocols.POLYMARKET_CTF);
    });

    it('никогда не бросает исключения', () => {
      expect(() => {
        TokenBalanceFormatter.toVerboseString(testBalance);
      }).not.toThrow();
    });
  });

  describe('toFixedString()', () => {
    it('форматирует amount с 2 десятичными знаками по умолчанию', () => {
      const fixed = TokenBalanceFormatter.toFixedString(testBalance);

      expect(fixed).toBe('100.50 UP');
    });

    it('форматирует amount с заданным числом десятичных знаков', () => {
      const fixed4 = TokenBalanceFormatter.toFixedString(testBalance, 4);

      expect(fixed4).toBe('100.5000 UP');
    });

    it('округляет amount при необходимости', () => {
      const preciseQty = Quantity.of(new Decimal('100.12345'));
      const preciseBalance = TokenBalanceService.create(token, preciseQty);
      expect(preciseBalance.ok).toBe(true);
      if (!preciseBalance.ok) return;

      const fixed2 = TokenBalanceFormatter.toFixedString(preciseBalance.value, 2);

      expect(fixed2).toBe('100.12 UP');
    });

    it('форматирует нулевой баланс', () => {
      const zeroQty = Quantity.ZERO;
      const zeroBalance = TokenBalanceService.create(token, zeroQty);
      expect(zeroBalance.ok).toBe(true);
      if (!zeroBalance.ok) return;

      const fixed = TokenBalanceFormatter.toFixedString(zeroBalance.value, 2);

      expect(fixed).toBe('0.00 UP');
    });

    it('никогда не бросает исключения', () => {
      expect(() => {
        TokenBalanceFormatter.toFixedString(testBalance);
        TokenBalanceFormatter.toFixedString(testBalance, 4);
        TokenBalanceFormatter.toFixedString(testBalance, 0);
      }).not.toThrow();
    });
  });
});
