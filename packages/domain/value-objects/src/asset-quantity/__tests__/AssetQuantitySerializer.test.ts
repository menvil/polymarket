import { describe, it, expect } from '@jest/globals';
import { KnownOnChainProtocols, KnownChainIds, BinaryOutcome } from '@polymarket/ids';
import type { OnChainConditionRef, ConditionId } from '@polymarket/ids';
import { AssetQuantityService } from '../facade/AssetQuantityService.js';
import { AssetQuantitySerializer } from '../adapters/AssetQuantitySerializer.js';
import { AssetQuantityErrorReason } from '../errors/AssetQuantityErrorReason.js';

describe('AssetQuantitySerializer', () => {
  const conditionRef: OnChainConditionRef = {
    kind: 'ONCHAIN',
    protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
    chainId: KnownChainIds.POLYGON,
    conditionId: '0xabc123def456' as ConditionId,
  };

  describe('toJSON() - Currency', () => {
    it('сериализует USDC AssetQuantity в JSON', () => {
      const assetQty = AssetQuantityService.createUsdc(100.5);
      expect(assetQty.ok).toBe(true);
      if (!assetQty.ok) return;

      const json = AssetQuantitySerializer.toJSON(assetQty.value);

      expect(json).toEqual({
        asset: 'CURRENCY:USDC',
        amount: '100.5',
      });
    });

    it('сохраняет точность amount в строке', () => {
      const assetQty = AssetQuantityService.createUsdc('123.45678901234567890123456789');
      expect(assetQty.ok).toBe(true);
      if (!assetQty.ok) return;

      const json = AssetQuantitySerializer.toJSON(assetQty.value);

      expect(json.amount).toBe('123.45678901234567890123456789');
    });

    it('сериализует нулевой USDC', () => {
      const assetQty = AssetQuantityService.createUsdc(0);
      expect(assetQty.ok).toBe(true);
      if (!assetQty.ok) return;

      const json = AssetQuantitySerializer.toJSON(assetQty.value);

      expect(json.amount).toBe('0');
    });
  });

  describe('toJSON() - OutcomeToken', () => {
    it('сериализует outcome token AssetQuantity в JSON', () => {
      const assetQty = AssetQuantityService.createOutcomeToken(
        conditionRef,
        BinaryOutcome.UP,
        50.25
      );
      expect(assetQty.ok).toBe(true);
      if (!assetQty.ok) return;

      const json = AssetQuantitySerializer.toJSON(assetQty.value);

      expect(json.asset).toContain('OUTCOME_TOKEN');
      expect(json.asset).toContain('ONCHAIN');
      expect(json.asset).toContain(KnownOnChainProtocols.POLYMARKET_CTF);
      expect(json.asset).toContain('137');
      expect(json.asset).toContain('0xabc123def456');
      expect(json.asset).toContain('UP');
      expect(json.amount).toBe('50.25');
    });
  });

  describe('fromJSON() - Currency', () => {
    it('десериализует валидный USDC JSON', () => {
      const json = {
        asset: 'CURRENCY:USDC',
        amount: '100.5',
      };

      const result = AssetQuantitySerializer.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isCurrency()).toBe(true);
        expect(result.value.amount().toNumber()).toBe(100.5);
      }
    });

    it('сохраняет точность при round-trip (USDC)', () => {
      const originalQty = AssetQuantityService.createUsdc('123.45678901234567890123456789');
      expect(originalQty.ok).toBe(true);
      if (!originalQty.ok) return;

      const json = AssetQuantitySerializer.toJSON(originalQty.value);
      const result = AssetQuantitySerializer.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.amount().value().toString()).toBe('123.45678901234567890123456789');
      }
    });
  });

  describe('fromJSON() - OutcomeToken', () => {
    it('десериализует валидный outcome token JSON', () => {
      const json = {
        asset: `OUTCOME_TOKEN:ONCHAIN:${KnownOnChainProtocols.POLYMARKET_CTF}:137:0xabc123def456:UP`,
        amount: '50.25',
      };

      const result = AssetQuantitySerializer.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isOutcomeToken()).toBe(true);
        expect(result.value.amount().toNumber()).toBe(50.25);
      }
    });

    it('сохраняет точность при round-trip (OutcomeToken)', () => {
      const originalQty = AssetQuantityService.createOutcomeToken(
        conditionRef,
        BinaryOutcome.UP,
        '123.45678901234567890123456789'
      );
      expect(originalQty.ok).toBe(true);
      if (!originalQty.ok) return;

      const json = AssetQuantitySerializer.toJSON(originalQty.value);
      const result = AssetQuantitySerializer.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.amount().value().toString()).toBe('123.45678901234567890123456789');
      }
    });
  });

  describe('fromJSON() - Validation Errors', () => {
    it('фэйлится если json не объект', () => {
      const result = AssetQuantitySerializer.fromJSON(null);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(AssetQuantityErrorReason.INVALID_FORMAT);
      }
    });

    it('фэйлится если json массив', () => {
      const result = AssetQuantitySerializer.fromJSON([]);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(AssetQuantityErrorReason.INVALID_FORMAT);
      }
    });

    it('фэйлится если отсутствует asset', () => {
      const json = {
        amount: '100.5',
      };

      const result = AssetQuantitySerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(AssetQuantityErrorReason.INVALID_FORMAT);
        expect(result.error.message).toContain("Missing required field 'asset'");
      }
    });

    it('фэйлится если отсутствует amount', () => {
      const json = {
        asset: 'CURRENCY:USDC',
      };

      const result = AssetQuantitySerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(AssetQuantityErrorReason.INVALID_FORMAT);
        expect(result.error.message).toContain("Missing required field 'amount'");
      }
    });

    it('фэйлится если asset не строка', () => {
      const json = {
        asset: 123, // number вместо string
        amount: '100.5',
      };

      const result = AssetQuantitySerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(AssetQuantityErrorReason.INVALID_ASSET);
        expect(result.error.message).toContain("Field 'asset' must be string");
      }
    });

    it('фэйлится если asset некорректен', () => {
      const json = {
        asset: 'INVALID_ASSET_FORMAT',
        amount: '100.5',
      };

      const result = AssetQuantitySerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(AssetQuantityErrorReason.INVALID_ASSET);
      }
    });

    it('фэйлится если amount не строка', () => {
      const json = {
        asset: 'CURRENCY:USDC',
        amount: 100.5, // number вместо string
      };

      const result = AssetQuantitySerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(AssetQuantityErrorReason.INVALID_AMOUNT);
        expect(result.error.message).toContain("Field 'amount' must be string");
      }
    });

    it('фэйлится если amount не парсится как Decimal', () => {
      const json = {
        asset: 'CURRENCY:USDC',
        amount: 'invalid',
      };

      const result = AssetQuantitySerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(AssetQuantityErrorReason.INVALID_AMOUNT);
        expect(result.error.message).toContain('Failed to parse amount as Decimal');
      }
    });

    it('фэйлится если amount отрицательное', () => {
      const json = {
        asset: 'CURRENCY:USDC',
        amount: '-100.5',
      };

      const result = AssetQuantitySerializer.fromJSON(json);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(AssetQuantityErrorReason.INVALID_AMOUNT);
        expect(result.error.message).toContain('Failed to create Quantity');
      }
    });
  });
});
