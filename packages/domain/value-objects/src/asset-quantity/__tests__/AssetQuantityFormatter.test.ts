import { describe, it, expect } from '@jest/globals';
import { KnownOnChainProtocols, KnownChainIds, BinaryOutcome } from '@polymarket/ids';
import type { OnChainConditionRef, ConditionId } from '@polymarket/ids';
import { AssetQuantityService } from '../facade/AssetQuantityService.js';
import { AssetQuantityFormatter } from '../adapters/AssetQuantityFormatter.js';

describe('AssetQuantityFormatter', () => {
  const conditionRef: OnChainConditionRef = {
    kind: 'ONCHAIN',
    protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
    chainId: KnownChainIds.POLYGON,
    conditionId: '0xabc123def456789' as ConditionId,
  };

  describe('toString() - Currency', () => {
    it('форматирует USDC AssetQuantity как полную строку', () => {
      const assetQty = AssetQuantityService.createUsdc(100.5);
      expect(assetQty.ok).toBe(true);
      if (!assetQty.ok) return;

      const str = AssetQuantityFormatter.toString(assetQty.value);

      expect(str).toContain('AssetQuantity[');
      expect(str).toContain('amount=100.5');
      expect(str).toContain('asset=CURRENCY:USDC');
    });
  });

  describe('toString() - OutcomeToken', () => {
    it('форматирует outcome token AssetQuantity как полную строку', () => {
      const assetQty = AssetQuantityService.createOutcomeToken(conditionRef, BinaryOutcome.UP, 50);
      expect(assetQty.ok).toBe(true);
      if (!assetQty.ok) return;

      const str = AssetQuantityFormatter.toString(assetQty.value);

      expect(str).toContain('AssetQuantity[');
      expect(str).toContain('amount=50');
      expect(str).toContain('OUTCOME_TOKEN');
      expect(str).toContain('ONCHAIN');
      expect(str).toContain('UP');
    });
  });

  describe('toDisplayString() - Currency', () => {
    it('форматирует USDC для UI', () => {
      const assetQty = AssetQuantityService.createUsdc(100.5);
      expect(assetQty.ok).toBe(true);
      if (!assetQty.ok) return;

      const display = AssetQuantityFormatter.toDisplayString(assetQty.value);

      expect(display).toBe('100.5 USDC');
    });
  });

  describe('toDisplayString() - OutcomeToken', () => {
    it('форматирует outcome token для UI', () => {
      const assetQty = AssetQuantityService.createOutcomeToken(conditionRef, BinaryOutcome.UP, 50);
      expect(assetQty.ok).toBe(true);
      if (!assetQty.ok) return;

      const display = AssetQuantityFormatter.toDisplayString(assetQty.value);

      expect(display).toContain('50');
      expect(display).toContain('UP');
      expect(display).toContain(KnownOnChainProtocols.POLYMARKET_CTF);
      expect(display).toContain('137');
      expect(display).toContain('0xabc1'); // сокращенный conditionId
    });
  });

  describe('toShortString()', () => {
    it('форматирует USDC в краткую строку', () => {
      const assetQty = AssetQuantityService.createUsdc(100.5);
      expect(assetQty.ok).toBe(true);
      if (!assetQty.ok) return;

      const short = AssetQuantityFormatter.toShortString(assetQty.value);

      expect(short).toBe('100.5 USDC');
    });

    it('форматирует outcome token в краткую строку', () => {
      const assetQty = AssetQuantityService.createOutcomeToken(conditionRef, BinaryOutcome.UP, 50);
      expect(assetQty.ok).toBe(true);
      if (!assetQty.ok) return;

      const short = AssetQuantityFormatter.toShortString(assetQty.value);

      expect(short).toBe('50 UP');
    });
  });

  describe('toVerboseString()', () => {
    it('форматирует USDC с полной информацией', () => {
      const assetQty = AssetQuantityService.createUsdc(100.5);
      expect(assetQty.ok).toBe(true);
      if (!assetQty.ok) return;

      const verbose = AssetQuantityFormatter.toVerboseString(assetQty.value);

      expect(verbose).toContain('AssetQuantity[');
      expect(verbose).toContain('amount=100.5');
      expect(verbose).toContain('asset=Currency[USDC]');
    });

    it('форматирует outcome token с полной информацией', () => {
      const assetQty = AssetQuantityService.createOutcomeToken(conditionRef, BinaryOutcome.UP, 50);
      expect(assetQty.ok).toBe(true);
      if (!assetQty.ok) return;

      const verbose = AssetQuantityFormatter.toVerboseString(assetQty.value);

      expect(verbose).toContain('AssetQuantity[');
      expect(verbose).toContain('amount=50');
      expect(verbose).toContain('asset=OutcomeToken[');
      expect(verbose).toContain('outcomeKey=UP');
      expect(verbose).toContain('condition=ONCHAIN:');
    });
  });

  describe('toFixedString()', () => {
    it('форматирует USDC с 2 десятичными знаками по умолчанию', () => {
      const assetQty = AssetQuantityService.createUsdc(100.5);
      expect(assetQty.ok).toBe(true);
      if (!assetQty.ok) return;

      const fixed = AssetQuantityFormatter.toFixedString(assetQty.value);

      expect(fixed).toBe('100.50 USDC');
    });

    it('форматирует outcome token с заданным числом десятичных знаков', () => {
      const assetQty = AssetQuantityService.createOutcomeToken(conditionRef, BinaryOutcome.UP, 50.12345);
      expect(assetQty.ok).toBe(true);
      if (!assetQty.ok) return;

      const fixed3 = AssetQuantityFormatter.toFixedString(assetQty.value, 3);

      expect(fixed3).toBe('50.123 UP');
    });

    it('округляет USDC при необходимости', () => {
      const assetQty = AssetQuantityService.createUsdc('100.12345');
      expect(assetQty.ok).toBe(true);
      if (!assetQty.ok) return;

      const fixed2 = AssetQuantityFormatter.toFixedString(assetQty.value, 2);

      expect(fixed2).toBe('100.12 USDC');
    });

    it('форматирует нулевой USDC', () => {
      const assetQty = AssetQuantityService.createUsdc(0);
      expect(assetQty.ok).toBe(true);
      if (!assetQty.ok) return;

      const fixed = AssetQuantityFormatter.toFixedString(assetQty.value, 2);

      expect(fixed).toBe('0.00 USDC');
    });

    it('никогда не бросает исключения', () => {
      const assetQty = AssetQuantityService.createUsdc(100);
      expect(assetQty.ok).toBe(true);
      if (!assetQty.ok) return;

      expect(() => {
        AssetQuantityFormatter.toFixedString(assetQty.value);
        AssetQuantityFormatter.toFixedString(assetQty.value, 4);
        AssetQuantityFormatter.toFixedString(assetQty.value, 0);
      }).not.toThrow();
    });
  });
});
