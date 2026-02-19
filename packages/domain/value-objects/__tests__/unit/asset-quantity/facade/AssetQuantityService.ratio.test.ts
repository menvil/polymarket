import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { KnownOnChainProtocols, KnownChainIds, BinaryOutcome, AssetIdHelpers } from '@polymarket/ids';
import type { OnChainConditionRef, ConditionId } from '@polymarket/ids';
import { AssetQuantityService } from '../../../../src/asset-quantity/facade/AssetQuantityService.js';
import { Ratio } from '../../../../src/ratio/core/Ratio.js';

describe('AssetQuantityService Ratio Operations', () => {
  const conditionRef: OnChainConditionRef = {
    kind: 'ONCHAIN',
    protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
    chainId: KnownChainIds.POLYGON,
    conditionId: '0x1234567890123456789012345678901234567890123456789012345678901234' as ConditionId,
  };

  describe('portion()', () => {
    describe('USDC (Currency)', () => {
      it('вычисляет 2% fee от 1000 USDC', () => {
        const orderQty = AssetQuantityService.createUsdc(1000);
        expect(orderQty.ok).toBe(true);
        if (!orderQty.ok) return;

        const feeRate = Ratio.of(new Decimal(0.02)); // 2%
        const result = AssetQuantityService.portion(orderQty.value, feeRate);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.amount().toNumber()).toBe(20);
          expect(result.value.isCurrency()).toBe(true);
          const asset = result.value.asset();
          if (asset.type === 'CURRENCY') {
            expect(asset.currency).toBe('USDC');
          }
        }
      });

      it('вычисляет 30% allocation от 5000 USDC', () => {
        const totalQty = AssetQuantityService.createUsdc(5000);
        expect(totalQty.ok).toBe(true);
        if (!totalQty.ok) return;

        const allocRate = Ratio.of(new Decimal(0.3)); // 30%
        const result = AssetQuantityService.portion(totalQty.value, allocRate);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.amount().toNumber()).toBe(1500);
          expect(result.value.isCurrency()).toBe(true);
        }
      });

      it('возвращает zero для rate = 0', () => {
        const qty = AssetQuantityService.createUsdc(100);
        expect(qty.ok).toBe(true);
        if (!qty.ok) return;

        const rate = Ratio.of(new Decimal(0));
        const result = AssetQuantityService.portion(qty.value, rate);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.amount().toNumber()).toBe(0);
          expect(result.value.isZero()).toBe(true);
        }
      });

      it('вычисляет 100% (весь amount)', () => {
        const qty = AssetQuantityService.createUsdc(100);
        expect(qty.ok).toBe(true);
        if (!qty.ok) return;

        const rate = Ratio.of(new Decimal(1)); // 100%
        const result = AssetQuantityService.portion(qty.value, rate);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.amount().toNumber()).toBe(100);
        }
      });

      it('вычисляет 200% (удвоение)', () => {
        const qty = AssetQuantityService.createUsdc(100);
        expect(qty.ok).toBe(true);
        if (!qty.ok) return;

        const rate = Ratio.of(new Decimal(2)); // 200%
        const result = AssetQuantityService.portion(qty.value, rate);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.amount().toNumber()).toBe(200);
        }
      });

      it('работает с очень малыми rates (basis points)', () => {
        const qty = AssetQuantityService.createUsdc(1000);
        expect(qty.ok).toBe(true);
        if (!qty.ok) return;

        const rate = Ratio.of(new Decimal(0.0001)); // 1 basis point
        const result = AssetQuantityService.portion(qty.value, rate);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.amount().toNumber()).toBe(0.1);
        }
      });

      it('фэйлится при отрицательном rate (приводит к negative)', () => {
        const qty = AssetQuantityService.createUsdc(100);
        expect(qty.ok).toBe(true);
        if (!qty.ok) return;

        const rate = Ratio.of(new Decimal(-0.1)); // -10%
        const result = AssetQuantityService.portion(qty.value, rate);

        // Результат отрицательный, Quantity не допускает negative
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('Invalid result amount');
        }
      });

      it('никогда не бросает исключения', () => {
        const qty = AssetQuantityService.createUsdc(100);
        expect(qty.ok).toBe(true);
        if (!qty.ok) return;

        const rate = Ratio.of(new Decimal(0.02));
        expect(() => {
          AssetQuantityService.portion(qty.value, rate);
        }).not.toThrow();
      });
    });

    describe('OutcomeToken', () => {
      it('вычисляет 2% fee от 1000 tokens', () => {
        const orderQty = AssetQuantityService.createOutcomeToken(
          conditionRef,
          BinaryOutcome.UP,
          1000
        );
        expect(orderQty.ok).toBe(true);
        if (!orderQty.ok) return;

        const feeRate = Ratio.of(new Decimal(0.02)); // 2%
        const result = AssetQuantityService.portion(orderQty.value, feeRate);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.amount().toNumber()).toBe(20);
          expect(result.value.isOutcomeToken()).toBe(true);
          const asset = result.value.asset();
          if (asset.type === 'OUTCOME_TOKEN') {
            expect(asset.outcomeKey).toBe(BinaryOutcome.UP);
            expect(asset.conditionRef).toEqual(conditionRef);
          }
        }
      });

      it('вычисляет 50% partial fill от 200 tokens', () => {
        const orderQty = AssetQuantityService.createOutcomeToken(
          conditionRef,
          BinaryOutcome.DOWN,
          200
        );
        expect(orderQty.ok).toBe(true);
        if (!orderQty.ok) return;

        const fillRate = Ratio.of(new Decimal(0.5)); // 50%
        const result = AssetQuantityService.portion(orderQty.value, fillRate);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.amount().toNumber()).toBe(100);
          expect(result.value.isOutcomeToken()).toBe(true);
          const asset = result.value.asset();
          if (asset.type === 'OUTCOME_TOKEN') {
            expect(asset.outcomeKey).toBe(BinaryOutcome.DOWN);
          }
        }
      });

      it('сохраняет тот же asset (conditionRef + outcomeKey)', () => {
        const originalQty = AssetQuantityService.createOutcomeToken(
          conditionRef,
          BinaryOutcome.UP,
          1000
        );
        expect(originalQty.ok).toBe(true);
        if (!originalQty.ok) return;

        const rate = Ratio.of(new Decimal(0.25)); // 25%
        const result = AssetQuantityService.portion(originalQty.value, rate);

        expect(result.ok).toBe(true);
        if (result.ok) {
          // Проверяем что asset точно тот же
          expect(AssetIdHelpers.equals(
            result.value.asset(),
            originalQty.value.asset()
          )).toBe(true);
        }
      });

      it('работает с дробными результатами', () => {
        const qty = AssetQuantityService.createOutcomeToken(
          conditionRef,
          BinaryOutcome.UP,
          100
        );
        expect(qty.ok).toBe(true);
        if (!qty.ok) return;

        const rate = Ratio.of(new Decimal(0.333)); // 33.3%
        const result = AssetQuantityService.portion(qty.value, rate);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.amount().toNumber()).toBe(33.3);
        }
      });
    });

    describe('Edge cases', () => {
      it('работает с очень большими amounts', () => {
        const qty = AssetQuantityService.createUsdc(1e10); // 10 billion
        expect(qty.ok).toBe(true);
        if (!qty.ok) return;

        const rate = Ratio.of(new Decimal(0.001)); // 0.1%
        const result = AssetQuantityService.portion(qty.value, rate);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.amount().toNumber()).toBe(1e7); // 10 million
        }
      });

      it('работает с очень малыми amounts', () => {
        const qty = AssetQuantityService.createUsdc(0.01);
        expect(qty.ok).toBe(true);
        if (!qty.ok) return;

        const rate = Ratio.of(new Decimal(0.5)); // 50%
        const result = AssetQuantityService.portion(qty.value, rate);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.amount().toNumber()).toBe(0.005);
        }
      });

      it('работает с zero amount', () => {
        const qty = AssetQuantityService.createUsdc(0);
        expect(qty.ok).toBe(true);
        if (!qty.ok) return;

        const rate = Ratio.of(new Decimal(0.5)); // 50%
        const result = AssetQuantityService.portion(qty.value, rate);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.amount().toNumber()).toBe(0);
          expect(result.value.isZero()).toBe(true);
        }
      });
    });

    describe('Integration scenarios', () => {
      it('fee calculation workflow: order → fee → net amount', () => {
        // 1. Order: 1000 USDC
        const orderQty = AssetQuantityService.createUsdc(1000);
        expect(orderQty.ok).toBe(true);
        if (!orderQty.ok) return;

        // 2. Calculate 2% fee
        const feeRate = Ratio.of(new Decimal(0.02));
        const feeResult = AssetQuantityService.portion(orderQty.value, feeRate);
        expect(feeResult.ok).toBe(true);
        if (!feeResult.ok) return;

        expect(feeResult.value.amount().toNumber()).toBe(20); // 2% fee

        // 3. Fee должен иметь тот же asset
        expect(AssetIdHelpers.equals(
          feeResult.value.asset(),
          orderQty.value.asset()
        )).toBe(true);
      });

      it('allocation workflow: total → multiple allocations', () => {
        const total = AssetQuantityService.createUsdc(10000);
        expect(total.ok).toBe(true);
        if (!total.ok) return;

        // Allocation 1: 30%
        const alloc1 = AssetQuantityService.portion(total.value, Ratio.of(new Decimal(0.3)));
        expect(alloc1.ok && alloc1.value.amount().toNumber()).toBe(3000);

        // Allocation 2: 50%
        const alloc2 = AssetQuantityService.portion(total.value, Ratio.of(new Decimal(0.5)));
        expect(alloc2.ok && alloc2.value.amount().toNumber()).toBe(5000);

        // Allocation 3: 20%
        const alloc3 = AssetQuantityService.portion(total.value, Ratio.of(new Decimal(0.2)));
        expect(alloc3.ok && alloc3.value.amount().toNumber()).toBe(2000);

        // Sum должен быть 100% = 10000
        // 3000 + 5000 + 2000 = 10000 ✓
      });
    });
  });
});
