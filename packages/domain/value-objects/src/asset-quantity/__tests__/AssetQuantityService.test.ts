import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { KnownOnChainProtocols, KnownChainIds, BinaryOutcome, AssetIdHelpers } from '@polymarket/ids';
import type { OnChainConditionRef, ConditionId } from '@polymarket/ids';
import { Quantity } from '../../quantity/core/Quantity.js';
import { AssetQuantityService } from '../facade/AssetQuantityService.js';

describe('AssetQuantityService', () => {
  const conditionRef: OnChainConditionRef = {
    kind: 'ONCHAIN',
    protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
    chainId: KnownChainIds.POLYGON,
    conditionId: '0x1234567890123456789012345678901234567890123456789012345678901234' as ConditionId,
  };

  const usdcAsset = AssetIdHelpers.USDC;
  const tokenAsset = AssetIdHelpers.fromOutcomeToken(conditionRef, BinaryOutcome.UP);

  const qty100 = Quantity.of(new Decimal(100));

  describe('create()', () => {
    it('создаёт AssetQuantity для Currency', () => {
      const result = AssetQuantityService.create(usdcAsset, qty100);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.asset()).toBe(usdcAsset);
        expect(result.value.amount()).toBe(qty100);
        expect(result.value.isCurrency()).toBe(true);
      }
    });

    it('создаёт AssetQuantity для OutcomeToken', () => {
      const result = AssetQuantityService.create(tokenAsset, qty100);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // After defensive copy, asset() returns a new object with same values
        expect(result.value.asset()).toStrictEqual(tokenAsset);
        expect(result.value.amount()).toBe(qty100);
        expect(result.value.isOutcomeToken()).toBe(true);
      }
    });

    it('никогда не бросает исключения', () => {
      expect(() => {
        AssetQuantityService.create(usdcAsset, qty100);
      }).not.toThrow();
    });
  });

  describe('createUsdc()', () => {
    it('создаёт USDC AssetQuantity из number', () => {
      const result = AssetQuantityService.createUsdc(100.5);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isCurrency()).toBe(true);
        expect(result.value.amount().toNumber()).toBe(100.5);
      }
    });

    it('создаёт USDC AssetQuantity из string', () => {
      const result = AssetQuantityService.createUsdc('100.5');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.amount().toNumber()).toBe(100.5);
      }
    });

    it('создаёт USDC AssetQuantity из Decimal', () => {
      const result = AssetQuantityService.createUsdc(new Decimal('100.5'));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.amount().toNumber()).toBe(100.5);
      }
    });

    it('фэйлится с invalid amount (parse error)', () => {
      const result = AssetQuantityService.createUsdc('invalid' as any);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Failed to parse amount');
      }
    });

    it('фэйлится с negative amount', () => {
      const result = AssetQuantityService.createUsdc(-100);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Failed to create Quantity');
      }
    });

    it('никогда не бросает исключения', () => {
      expect(() => {
        AssetQuantityService.createUsdc(100);
        AssetQuantityService.createUsdc('invalid' as any);
        AssetQuantityService.createUsdc(-100);
      }).not.toThrow();
    });
  });

  describe('createOutcomeToken()', () => {
    it('создаёт outcome token AssetQuantity из number', () => {
      const result = AssetQuantityService.createOutcomeToken(
        conditionRef,
        BinaryOutcome.UP,
        50.25
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isOutcomeToken()).toBe(true);
        expect(result.value.amount().toNumber()).toBe(50.25);
      }
    });

    it('создаёт outcome token AssetQuantity из string', () => {
      const result = AssetQuantityService.createOutcomeToken(
        conditionRef,
        BinaryOutcome.DOWN,
        '75.5'
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.amount().toNumber()).toBe(75.5);
        const asset = result.value.asset();
        if (asset.type === 'OUTCOME_TOKEN') {
          expect(asset.outcomeKey).toBe(BinaryOutcome.DOWN);
        }
      }
    });

    it('фэйлится с invalid amount', () => {
      const result = AssetQuantityService.createOutcomeToken(
        conditionRef,
        BinaryOutcome.UP,
        'invalid' as any
      );

      expect(result.ok).toBe(false);
    });

    it('никогда не бросает исключения', () => {
      expect(() => {
        AssetQuantityService.createOutcomeToken(conditionRef, BinaryOutcome.UP, 50);
        AssetQuantityService.createOutcomeToken(conditionRef, BinaryOutcome.UP, 'invalid' as any);
      }).not.toThrow();
    });
  });

  describe('equals()', () => {
    it('возвращает true для равных USDC quantities', () => {
      const qty1 = AssetQuantityService.createUsdc(100);
      const qty2 = AssetQuantityService.createUsdc(100);

      expect(qty1.ok && qty2.ok).toBe(true);
      if (qty1.ok && qty2.ok) {
        const same = AssetQuantityService.equals(qty1.value, qty2.value);
        expect(same).toBe(true);
      }
    });

    it('возвращает false для разных amounts', () => {
      const qty1 = AssetQuantityService.createUsdc(100);
      const qty2 = AssetQuantityService.createUsdc(200);

      expect(qty1.ok && qty2.ok).toBe(true);
      if (qty1.ok && qty2.ok) {
        const same = AssetQuantityService.equals(qty1.value, qty2.value);
        expect(same).toBe(false);
      }
    });

    it('возвращает false для разных asset types', () => {
      const usdcQty = AssetQuantityService.createUsdc(100);
      const tokenQty = AssetQuantityService.createOutcomeToken(conditionRef, BinaryOutcome.UP, 100);

      expect(usdcQty.ok && tokenQty.ok).toBe(true);
      if (usdcQty.ok && tokenQty.ok) {
        const same = AssetQuantityService.equals(usdcQty.value, tokenQty.value);
        expect(same).toBe(false);
      }
    });
  });

  describe('isZero()', () => {
    it('возвращает true для нулевого USDC', () => {
      const result = AssetQuantityService.createUsdc(0);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const isZero = AssetQuantityService.isZero(result.value);
        expect(isZero).toBe(true);
      }
    });

    it('возвращает false для ненулевого USDC', () => {
      const result = AssetQuantityService.createUsdc(100);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const isZero = AssetQuantityService.isZero(result.value);
        expect(isZero).toBe(false);
      }
    });
  });

  describe('isPositive()', () => {
    it('возвращает false для нулевого USDC', () => {
      const result = AssetQuantityService.createUsdc(0);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const isPositive = AssetQuantityService.isPositive(result.value);
        expect(isPositive).toBe(false);
      }
    });

    it('возвращает true для положительного USDC', () => {
      const result = AssetQuantityService.createUsdc(100);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const isPositive = AssetQuantityService.isPositive(result.value);
        expect(isPositive).toBe(true);
      }
    });
  });
});
