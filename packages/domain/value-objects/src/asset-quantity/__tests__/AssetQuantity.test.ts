import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { KnownOnChainProtocols, KnownChainIds, BinaryOutcome, AssetIdHelpers } from '@polymarket/ids';
import type { OnChainConditionRef, ConditionId } from '@polymarket/ids';
import { Quantity } from '../../quantity/core/Quantity.js';
import { AssetQuantity } from '../core/AssetQuantity.js';

describe('AssetQuantity Core', () => {
  const conditionRef: OnChainConditionRef = {
    kind: 'ONCHAIN',
    protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
    chainId: KnownChainIds.POLYGON,
    conditionId: '0x1234567890123456789012345678901234567890123456789012345678901234' as ConditionId,
  };

  const usdcAsset = AssetIdHelpers.USDC;
  const tokenAsset = AssetIdHelpers.fromOutcomeToken(conditionRef, BinaryOutcome.UP);

  const qty100 = Quantity.of(new Decimal(100));
  const qty200 = Quantity.of(new Decimal(200));
  const qtyZero = Quantity.ZERO;

  describe('of()', () => {
    it('создаёт AssetQuantity для Currency', () => {
      const assetQty = AssetQuantity.of(usdcAsset, qty100);

      expect(assetQty).toBeInstanceOf(AssetQuantity);
      expect(assetQty.asset()).toBe(usdcAsset);
      expect(assetQty.amount()).toBe(qty100);
      expect(assetQty.isCurrency()).toBe(true);
      expect(assetQty.isOutcomeToken()).toBe(false);
    });

    it('создаёт AssetQuantity для OutcomeToken', () => {
      const assetQty = AssetQuantity.of(tokenAsset, qty100);

      expect(assetQty).toBeInstanceOf(AssetQuantity);
      expect(assetQty.asset()).toBe(tokenAsset);
      expect(assetQty.amount()).toBe(qty100);
      expect(assetQty.isCurrency()).toBe(false);
      expect(assetQty.isOutcomeToken()).toBe(true);
    });

    it('создаёт AssetQuantity с нулевым amount', () => {
      const assetQty = AssetQuantity.of(usdcAsset, qtyZero);

      expect(assetQty.amount().isZero()).toBe(true);
    });
  });

  describe('usdc() factory', () => {
    it('создаёт AssetQuantity для USDC', () => {
      const assetQty = AssetQuantity.usdc(qty100);

      expect(assetQty.isCurrency()).toBe(true);
      expect(assetQty.asset().type).toBe('CURRENCY');
      const asset = assetQty.asset();
      if (asset.type === 'CURRENCY') {
        expect(asset.currency).toBe('USDC');
      }
      expect(assetQty.amount()).toBe(qty100);
    });
  });

  describe('outcomeToken() factory', () => {
    it('создаёт AssetQuantity для outcome token', () => {
      const assetQty = AssetQuantity.outcomeToken(conditionRef, BinaryOutcome.UP, qty100);

      expect(assetQty.isOutcomeToken()).toBe(true);
      expect(assetQty.asset().type).toBe('OUTCOME_TOKEN');
      const asset = assetQty.asset();
      if (asset.type === 'OUTCOME_TOKEN') {
        expect(asset.outcomeKey).toBe(BinaryOutcome.UP);
        expect(asset.conditionRef).toEqual(conditionRef);
      }
      expect(assetQty.amount()).toBe(qty100);
    });
  });

  describe('Accessors', () => {
    const usdcQty = AssetQuantity.usdc(qty100);

    it('asset() возвращает AssetId', () => {
      expect(usdcQty.asset()).toBeDefined();
      expect(usdcQty.asset().type).toBe('CURRENCY');
    });

    it('amount() возвращает Quantity', () => {
      expect(usdcQty.amount()).toBe(qty100);
      expect(usdcQty.amount()).toBeInstanceOf(Quantity);
    });
  });

  describe('Type guards', () => {
    const usdcQty = AssetQuantity.usdc(qty100);
    const tokenQty = AssetQuantity.outcomeToken(conditionRef, BinaryOutcome.UP, qty100);

    it('isCurrency() возвращает true для Currency', () => {
      expect(usdcQty.isCurrency()).toBe(true);
    });

    it('isCurrency() возвращает false для OutcomeToken', () => {
      expect(tokenQty.isCurrency()).toBe(false);
    });

    it('isOutcomeToken() возвращает false для Currency', () => {
      expect(usdcQty.isOutcomeToken()).toBe(false);
    });

    it('isOutcomeToken() возвращает true для OutcomeToken', () => {
      expect(tokenQty.isOutcomeToken()).toBe(true);
    });
  });

  describe('equals()', () => {
    it('возвращает true для одинаковых USDC quantities', () => {
      const qty1 = AssetQuantity.usdc(qty100);
      const qty2 = AssetQuantity.usdc(qty100);

      expect(qty1.equals(qty2)).toBe(true);
    });

    it('возвращает false для разных amounts (USDC)', () => {
      const qty1 = AssetQuantity.usdc(qty100);
      const qty2 = AssetQuantity.usdc(qty200);

      expect(qty1.equals(qty2)).toBe(false);
    });

    it('возвращает true для одинаковых outcome token quantities', () => {
      const qty1 = AssetQuantity.outcomeToken(conditionRef, BinaryOutcome.UP, qty100);
      const qty2 = AssetQuantity.outcomeToken(conditionRef, BinaryOutcome.UP, qty100);

      expect(qty1.equals(qty2)).toBe(true);
    });

    it('возвращает false для разных outcome keys', () => {
      const qty1 = AssetQuantity.outcomeToken(conditionRef, BinaryOutcome.UP, qty100);
      const qty2 = AssetQuantity.outcomeToken(conditionRef, BinaryOutcome.DOWN, qty100);

      expect(qty1.equals(qty2)).toBe(false);
    });

    it('возвращает false для разных conditionRef', () => {
      const conditionRef2: OnChainConditionRef = {
        kind: 'ONCHAIN',
        protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
        chainId: KnownChainIds.POLYGON,
        conditionId: '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' as ConditionId,
      };

      const qty1 = AssetQuantity.outcomeToken(conditionRef, BinaryOutcome.UP, qty100);
      const qty2 = AssetQuantity.outcomeToken(conditionRef2, BinaryOutcome.UP, qty100);

      expect(qty1.equals(qty2)).toBe(false);
    });

    it('возвращает false для разных asset types (Currency vs OutcomeToken)', () => {
      const usdcQty = AssetQuantity.usdc(qty100);
      const tokenQty = AssetQuantity.outcomeToken(conditionRef, BinaryOutcome.UP, qty100);

      expect(usdcQty.equals(tokenQty)).toBe(false);
    });
  });

  describe('isZero()', () => {
    it('возвращает true для нулевого USDC', () => {
      const assetQty = AssetQuantity.usdc(qtyZero);

      expect(assetQty.isZero()).toBe(true);
    });

    it('возвращает false для ненулевого USDC', () => {
      const assetQty = AssetQuantity.usdc(qty100);

      expect(assetQty.isZero()).toBe(false);
    });

    it('возвращает true для нулевого outcome token', () => {
      const assetQty = AssetQuantity.outcomeToken(conditionRef, BinaryOutcome.UP, qtyZero);

      expect(assetQty.isZero()).toBe(true);
    });
  });

  describe('isPositive()', () => {
    it('возвращает false для нулевого USDC', () => {
      const assetQty = AssetQuantity.usdc(qtyZero);

      expect(assetQty.isPositive()).toBe(false);
    });

    it('возвращает true для положительного USDC', () => {
      const assetQty = AssetQuantity.usdc(qty100);

      expect(assetQty.isPositive()).toBe(true);
    });

    it('возвращает true для положительного outcome token', () => {
      const assetQty = AssetQuantity.outcomeToken(conditionRef, BinaryOutcome.UP, qty100);

      expect(assetQty.isPositive()).toBe(true);
    });
  });

  describe('Immutability', () => {
    it('созданный AssetQuantity иммутабелен', () => {
      const assetQty = AssetQuantity.usdc(qty100);

      // Оригинал не изменился
      expect(assetQty.amount()).toBe(qty100);
      expect(assetQty.asset()).toBe(usdcAsset);
    });
  });
});
