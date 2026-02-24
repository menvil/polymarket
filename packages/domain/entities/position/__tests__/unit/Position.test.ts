/**
 * Тесты для Position entity
 */

import { describe, it, expect } from '@jest/globals';
import { Position } from '../../src/Position.js';
import type { PositionParams, PositionLot } from '../../src/Position.js';
import { Quantity, Price, Timestamp, Fee } from '@polymarket/value-objects';
import { asPositionId, asAccountId, asInstrumentId, asAssetId } from '@polymarket/ids';
import Decimal from 'decimal.js';

describe('Position Entity', () => {
  // Helper для создания валидных параметров
  const createValidParams = (overrides?: Partial<PositionParams>): PositionParams => ({
    id: asPositionId('pos-123')!,
    accountId: asAccountId('account-456')!,
    instrumentId: asInstrumentId('market-abc-token-yes')!,
    asset: asAssetId('USDC')!,
    side: 'LONG',
    quantity: Quantity.of(new Decimal(100)),
    averageEntryPrice: Price.of(new Decimal(0.65)),
    timestamp: Timestamp.now(),
    lots: [],
    ...overrides,
  });

  describe('create()', () => {
    it('should create valid position', () => {
      const params = createValidParams();
      const result = Position.create(params);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value();
        expect(position.id).toBe(params.id);
        expect(position.accountId).toBe(params.accountId);
        expect(position.instrumentId).toBe(params.instrumentId);
        expect(position.asset).toBe(params.asset);
        expect(position.side).toBe('LONG');
        expect(position.quantity.value().toNumber()).toBe(100);
        expect(position.averageEntryPrice.value().toNumber()).toBe(0.65);
      }
    });

    it('should reject missing id', () => {
      const params = { ...createValidParams(), id: undefined as any };
      const result = Position.create(params);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Position ID is required');
      }
    });

    it('should reject missing accountId', () => {
      const params = { ...createValidParams(), accountId: undefined as any };
      const result = Position.create(params);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Account ID is required');
      }
    });

    it('should reject missing instrumentId', () => {
      const params = { ...createValidParams(), instrumentId: undefined as any };
      const result = Position.create(params);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Instrument ID is required');
      }
    });

    it('should reject missing asset', () => {
      const params = { ...createValidParams(), asset: undefined as any };
      const result = Position.create(params);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Asset ID is required');
      }
    });

    it('should reject missing quantity', () => {
      const params = { ...createValidParams(), quantity: undefined as any };
      const result = Position.create(params);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Quantity is required');
      }
    });

    it('should reject missing averageEntryPrice', () => {
      const params = { ...createValidParams(), averageEntryPrice: undefined as any };
      const result = Position.create(params);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Average entry price is required');
      }
    });

    it('should reject missing timestamp', () => {
      const params = { ...createValidParams(), timestamp: undefined as any };
      const result = Position.create(params);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Timestamp is required');
      }
    });

    it('should use default values for optional fields', () => {
      const params = createValidParams();
      const result = Position.create(params);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value();
        expect(position.realizedPnL.isZero()).toBe(true);
        expect(position.fees.isZero()).toBe(true);
      }
    });

    it('should accept provided optional fields', () => {
      const params = createValidParams({
        realizedPnL: Quantity.of(new Decimal(50)),
        fees: Fee.of(Quantity.of(new Decimal(2)), asAssetId('USDC')!),
      });
      const result = Position.create(params);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value();
        expect(position.realizedPnL.value().toNumber()).toBe(50);
        expect(position.fees.isZero()).toBe(false);
      }
    });
  });

  describe('Status', () => {
    it('should return OPEN for new position', () => {
      const params = createValidParams();
      const result = Position.create(params);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value();
        expect(position.getStatus()).toBe('OPEN');
        expect(position.isOpen()).toBe(true);
        expect(position.isClosed()).toBe(false);
      }
    });

    it('should return CLOSED for zero quantity position', () => {
      const params = createValidParams({
        quantity: Quantity.ZERO,
      });
      const result = Position.create(params);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value();
        expect(position.getStatus()).toBe('CLOSED');
        expect(position.isOpen()).toBe(false);
        expect(position.isClosed()).toBe(true);
      }
    });

    it('should return OPEN for position with matching lots', () => {
      const lot: PositionLot = {
        quantity: Quantity.of(new Decimal(100)),
        entryPrice: Price.of(new Decimal(0.65)),
        timestamp: Timestamp.now(),
      };

      const params = createValidParams({
        lots: [lot],
      });
      const result = Position.create(params);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value();
        expect(position.getStatus()).toBe('OPEN');
      }
    });
  });

  describe('P&L Calculations', () => {
    it('should calculate unrealized PnL for LONG position (profit)', () => {
      const params = createValidParams({
        side: 'LONG',
        quantity: Quantity.of(new Decimal(100)),
        averageEntryPrice: Price.of(new Decimal(0.65)),
      });
      const result = Position.create(params);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value();
        const currentPrice = Price.of(new Decimal(0.75)); // +0.10
        const unrealizedPnL = position.getUnrealizedPnL(currentPrice);

        // (0.75 - 0.65) * 100 = 10
        expect(unrealizedPnL.value().toNumber()).toBe(10);
      }
    });

    it('should calculate unrealized PnL for LONG position (loss)', () => {
      const params = createValidParams({
        side: 'LONG',
        quantity: Quantity.of(new Decimal(100)),
        averageEntryPrice: Price.of(new Decimal(0.65)),
      });
      const result = Position.create(params);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value();
        const currentPrice = Price.of(new Decimal(0.55)); // -0.10
        const unrealizedPnL = position.getUnrealizedPnL(currentPrice);

        // (0.55 - 0.65) * 100 = -10
        expect(unrealizedPnL.value().toNumber()).toBe(-10);
      }
    });

    it('should calculate unrealized PnL for SHORT position (profit)', () => {
      const params = createValidParams({
        side: 'SHORT',
        quantity: Quantity.of(new Decimal(100)),
        averageEntryPrice: Price.of(new Decimal(0.65)),
      });
      const result = Position.create(params);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value();
        const currentPrice = Price.of(new Decimal(0.55)); // -0.10 (profit for SHORT)
        const unrealizedPnL = position.getUnrealizedPnL(currentPrice);

        // -(0.55 - 0.65) * 100 = 10
        expect(unrealizedPnL.value().toNumber()).toBe(10);
      }
    });

    it('should calculate unrealized PnL for SHORT position (loss)', () => {
      const params = createValidParams({
        side: 'SHORT',
        quantity: Quantity.of(new Decimal(100)),
        averageEntryPrice: Price.of(new Decimal(0.65)),
      });
      const result = Position.create(params);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value();
        const currentPrice = Price.of(new Decimal(0.75)); // +0.10 (loss for SHORT)
        const unrealizedPnL = position.getUnrealizedPnL(currentPrice);

        // -(0.75 - 0.65) * 100 = -10
        expect(unrealizedPnL.value().toNumber()).toBe(-10);
      }
    });

    it('should return zero unrealized PnL for closed position', () => {
      const params = createValidParams({
        quantity: Quantity.ZERO,
      });
      const result = Position.create(params);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value();
        const currentPrice = Price.of(new Decimal(0.75));
        const unrealizedPnL = position.getUnrealizedPnL(currentPrice);

        expect(unrealizedPnL.isZero()).toBe(true);
      }
    });

    it('should calculate total PnL (realized + unrealized)', () => {
      const params = createValidParams({
        side: 'LONG',
        quantity: Quantity.of(new Decimal(100)),
        averageEntryPrice: Price.of(new Decimal(0.65)),
        realizedPnL: Quantity.of(new Decimal(15)), // already realized 15
      });
      const result = Position.create(params);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value();
        const currentPrice = Price.of(new Decimal(0.75)); // unrealized = 10
        const totalPnL = position.getTotalPnL(currentPrice);

        // 15 (realized) + 10 (unrealized) = 25
        expect(totalPnL.value().toNumber()).toBe(25);
      }
    });

    it('should calculate total PnL with negative realized', () => {
      const params = createValidParams({
        side: 'LONG',
        quantity: Quantity.of(new Decimal(100)),
        averageEntryPrice: Price.of(new Decimal(0.65)),
        realizedPnL: Quantity.of(new Decimal(-5)), // already lost 5
      });
      const result = Position.create(params);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value();
        const currentPrice = Price.of(new Decimal(0.75)); // unrealized = 10
        const totalPnL = position.getTotalPnL(currentPrice);

        // -5 (realized) + 10 (unrealized) = 5
        expect(totalPnL.value().toNumber()).toBe(5);
      }
    });
  });

  describe('Lots', () => {
    it('should handle empty lots array', () => {
      const params = createValidParams({
        lots: [],
      });
      const result = Position.create(params);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value();
        expect(position.lots.length).toBe(0);
      }
    });

    it('should handle single lot', () => {
      const lot: PositionLot = {
        quantity: Quantity.of(new Decimal(50)),
        entryPrice: Price.of(new Decimal(0.60)),
        timestamp: Timestamp.now(),
      };

      const params = createValidParams({
        lots: [lot],
      });
      const result = Position.create(params);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value();
        expect(position.lots.length).toBe(1);
        expect(position.lots[0].quantity.value().toNumber()).toBe(50);
      }
    });

    it('should handle multiple lots', () => {
      const lot1: PositionLot = {
        quantity: Quantity.of(new Decimal(50)),
        entryPrice: Price.of(new Decimal(0.60)),
        timestamp: Timestamp.now(),
      };

      const lot2: PositionLot = {
        quantity: Quantity.of(new Decimal(50)),
        entryPrice: Price.of(new Decimal(0.70)),
        timestamp: Timestamp.now(),
      };

      const params = createValidParams({
        lots: [lot1, lot2],
      });
      const result = Position.create(params);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value();
        expect(position.lots.length).toBe(2);
      }
    });

    it('should handle lot with fee', () => {
      const lot: PositionLot = {
        quantity: Quantity.of(new Decimal(50)),
        entryPrice: Price.of(new Decimal(0.60)),
        timestamp: Timestamp.now(),
        fee: Fee.of(Quantity.of(new Decimal(1)), asAssetId('USDC')!),
      };

      const params = createValidParams({
        lots: [lot],
      });
      const result = Position.create(params);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value();
        expect(position.lots[0].fee).toBeDefined();
      }
    });
  });

  describe('Serialization', () => {
    it('should serialize to JSON', () => {
      const params = createValidParams({
        side: 'LONG',
        quantity: Quantity.of(new Decimal(100)),
        averageEntryPrice: Price.of(new Decimal(0.65)),
        realizedPnL: Quantity.of(new Decimal(10)),
      });
      const result = Position.create(params);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value();
        const json = position.toJSON();

        expect(json.id).toBe('pos-123');
        expect(json.accountId).toBe('account-456');
        expect(json.side).toBe('LONG');
        expect(json.quantity).toBe(100);
        expect(json.averageEntryPrice).toBe(0.65);
        expect(json.status).toBe('OPEN');
        expect(json.realizedPnL).toBe(10);
        expect(json.lotsCount).toBe(0);
      }
    });

    it('should convert to string', () => {
      const params = createValidParams();
      const result = Position.create(params);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value();
        const str = position.toString();

        expect(str).toContain('Position[pos-123]');
        expect(str).toContain('LONG');
        expect(str).toContain('100');
        expect(str).toContain('0.65');
        expect(str).toContain('OPEN');
      }
    });
  });

  describe('Immutability', () => {
    it('should have readonly properties', () => {
      const params = createValidParams();
      const result = Position.create(params);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value();

        // TypeScript compile-time check - runtime check not needed
        // These should cause compile errors if uncommented:
        // position.id = asPositionId('pos-456')!;
        // position.quantity = Quantity.of(new Decimal(200));

        // Verify that lots array is readonly
        expect(Array.isArray(position.lots)).toBe(true);
        // position.lots.push({...}); // Should cause compile error
      }
    });
  });

  describe('Edge Cases', () => {
    it('should handle zero quantity', () => {
      const params = createValidParams({
        quantity: Quantity.ZERO,
      });
      const result = Position.create(params);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value();
        expect(position.quantity.isZero()).toBe(true);
        expect(position.isClosed()).toBe(true);
      }
    });

    it('should handle very small quantities', () => {
      const params = createValidParams({
        quantity: Quantity.of(new Decimal('0.000001')),
      });
      const result = Position.create(params);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value();
        expect(position.quantity.value().toNumber()).toBe(0.000001);
      }
    });

    it('should handle very large quantities', () => {
      const params = createValidParams({
        quantity: Quantity.of(new Decimal('1000000')),
      });
      const result = Position.create(params);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value();
        expect(position.quantity.value().toNumber()).toBe(1000000);
      }
    });

    it('should handle price at extremes (near 0)', () => {
      const params = createValidParams({
        averageEntryPrice: Price.of(new Decimal('0.01')),
      });
      const result = Position.create(params);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value();
        expect(position.averageEntryPrice.value().toNumber()).toBe(0.01);
      }
    });

    it('should handle price at extremes (near 1)', () => {
      const params = createValidParams({
        averageEntryPrice: Price.of(new Decimal('0.99')),
      });
      const result = Position.create(params);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value();
        expect(position.averageEntryPrice.value().toNumber()).toBe(0.99);
      }
    });
  });
});
