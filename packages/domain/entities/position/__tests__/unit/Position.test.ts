/**
 * Тесты для Position entity
 *
 * @remarks
 * После DDD-рефакторинга:
 * - quantity и averageEntryPrice — derived getters из lots
 * - PositionParams не содержит quantity/averageEntryPrice
 * - lots — единственный источник истины
 */

import { describe, it, expect } from '@jest/globals';
import { Position } from '../../src/Position.js';
import type { PositionParams } from '../../src/Position.js';
import { PositionLot } from '../../src/core/PositionLot.js';
import { Quantity, Price, Timestamp, Fee, AssetQuantity } from '@polymarket/value-objects';
import { SignedQuantity } from '@polymarket/value-objects/signed-quantity';
import { asPositionId, asInstrumentId, parseAccountId, AssetIdHelpers } from '@polymarket/ids';
import Decimal from 'decimal.js';

const TEST_ACCOUNT_ID = parseAccountId('venue:POLYMARKET:account-456')!;
const TEST_ASSET_ID = AssetIdHelpers.USDC;

// Лот по умолчанию: 100 @ 0.65
const DEFAULT_LOT = PositionLot.create({
  quantity: Quantity.of(new Decimal(100)),
  entryPrice: Price.of(new Decimal(0.65)),
  timestamp: Timestamp.of(new Decimal(1705318200000)),
});

describe('Position Entity', () => {
  /**
   * Helper для создания валидных параметров.
   * Включает DEFAULT_LOT для ненулевого quantity/averageEntryPrice по умолчанию.
   * Используйте overrides.lots: [] для тестирования закрытой позиции.
   */
  const createValidParams = (overrides?: Partial<PositionParams>): PositionParams => ({
    id: asPositionId('pos-123')!,
    accountId: TEST_ACCOUNT_ID,
    instrumentId: asInstrumentId('market-abc-token-yes')!,
    asset: TEST_ASSET_ID,
    side: 'LONG',
    timestamp: Timestamp.now(),
    lots: [DEFAULT_LOT],
    ...overrides,
  });

  describe('create()', () => {
    it('should create valid position', () => {
      const params = createValidParams();
      const result = Position.create(params);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value;
        expect(position.id).toBe(params.id);
        expect(position.accountId).toBe(params.accountId);
        expect(position.instrumentId).toBe(params.instrumentId);
        expect(position.asset).toBe(params.asset);
        expect(position.side).toBe('LONG');
        // quantity и averageEntryPrice — derived из DEFAULT_LOT
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
        const position = result.value;
        expect(position.realizedPnL.isZero()).toBe(true);
        expect(position.fees.isZero()).toBe(true);
      }
    });

    it('should accept provided optional fields', () => {
      const params = createValidParams({
        realizedPnL: SignedQuantity.of(new Decimal(50)),
        fees: Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal(2)))),
      });
      const result = Position.create(params);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value;
        expect(position.realizedPnL.value().toNumber()).toBe(50);
        expect(position.fees.isZero()).toBe(false);
      }
    });

    it('should sort lots by timestamp ASC in constructor', () => {
      const lot1 = PositionLot.create({
        quantity: Quantity.of(new Decimal(50)),
        entryPrice: Price.of(new Decimal(0.60)),
        timestamp: Timestamp.of(new Decimal(200)),
      });
      const lot2 = PositionLot.create({
        quantity: Quantity.of(new Decimal(50)),
        entryPrice: Price.of(new Decimal(0.70)),
        timestamp: Timestamp.of(new Decimal(100)), // старше, но передан вторым
      });

      // Передаём в обратном порядке — конструктор должен отсортировать
      const result = Position.create(createValidParams({ lots: [lot1, lot2] }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value;
        // Лоты должны быть отсортированы ASC по timestamp
        expect(position.lots[0].timestamp.toNumber()).toBe(100);
        expect(position.lots[1].timestamp.toNumber()).toBe(200);
      }
    });
  });

  describe('Derived getters', () => {
    it('quantity derived from lots sum', () => {
      const lot1 = PositionLot.create({
        quantity: Quantity.of(new Decimal(60)),
        entryPrice: Price.of(new Decimal(0.60)),
        timestamp: Timestamp.now(),
      });
      const lot2 = PositionLot.create({
        quantity: Quantity.of(new Decimal(40)),
        entryPrice: Price.of(new Decimal(0.70)),
        timestamp: Timestamp.now(),
      });

      const result = Position.create(createValidParams({ lots: [lot1, lot2] }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.quantity.value().toNumber()).toBe(100); // 60 + 40
      }
    });

    it('quantity is ZERO for empty lots', () => {
      const result = Position.create(createValidParams({ lots: [] }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.quantity.isZero()).toBe(true);
      }
    });

    it('averageEntryPrice derived as weighted average', () => {
      const lot1 = PositionLot.create({
        quantity: Quantity.of(new Decimal(50)),
        entryPrice: Price.of(new Decimal(0.60)),
        timestamp: Timestamp.now(),
      });
      const lot2 = PositionLot.create({
        quantity: Quantity.of(new Decimal(50)),
        entryPrice: Price.of(new Decimal(0.70)),
        timestamp: Timestamp.now(),
      });

      const result = Position.create(createValidParams({ lots: [lot1, lot2] }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        // (0.60*50 + 0.70*50) / 100 = 0.65
        expect(result.value.averageEntryPrice.value().toNumber()).toBe(0.65);
      }
    });

    it('averageEntryPrice is Price.MIN for empty lots', () => {
      const result = Position.create(createValidParams({ lots: [] }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.averageEntryPrice).toBe(Price.MIN);
      }
    });
  });

  describe('Status', () => {
    it('should return OPEN for position with lots and no closures', () => {
      const result = Position.create(createValidParams());

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value;
        expect(position.getStatus()).toBe('OPEN');
        expect(position.isOpen()).toBe(true);
        expect(position.isClosed()).toBe(false);
      }
    });

    it('should return CLOSED for position with empty lots', () => {
      const result = Position.create(createValidParams({ lots: [] }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value;
        expect(position.getStatus()).toBe('CLOSED');
        expect(position.isOpen()).toBe(false);
        expect(position.isClosed()).toBe(true);
      }
    });

    it('should return PARTIALLY_CLOSED when quantity < openedQuantity (via explicit openedQuantity)', () => {
      // Позиция с 50 лотами, но изначально было 100 → PARTIALLY_CLOSED
      const halfLot = PositionLot.create({
        quantity: Quantity.of(new Decimal(50)),
        entryPrice: Price.of(new Decimal(0.65)),
        timestamp: Timestamp.of(new Decimal(1705318200000)),
      });

      const result = Position.create({
        ...createValidParams({ lots: [halfLot] }),
        openedQuantity: Quantity.of(new Decimal(100)), // исходный размер
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.getStatus()).toBe('PARTIALLY_CLOSED');
      }
    });

    it('should return PARTIALLY_CLOSED even when realizedPnL is zero (close at entry price)', () => {
      // Контрпример из ревью: закрытие по цене входа → realizedPnL=0, но PARTIALLY_CLOSED
      const halfLot = PositionLot.create({
        quantity: Quantity.of(new Decimal(50)),
        entryPrice: Price.of(new Decimal(0.60)),
        timestamp: Timestamp.of(new Decimal(1705318200000)),
      });

      const result = Position.create({
        ...createValidParams({ lots: [halfLot] }),
        openedQuantity: Quantity.of(new Decimal(100)),
        realizedPnL: SignedQuantity.ZERO, // P&L = 0 (закрытие по цене входа)
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Статус должен быть PARTIALLY_CLOSED, НЕ OPEN!
        // realizedPnL == 0 не является надёжным индикатором PARTIALLY_CLOSED
        expect(result.value.getStatus()).toBe('PARTIALLY_CLOSED');
        expect(result.value.realizedPnL.isZero()).toBe(true); // P&L действительно 0
      }
    });

    it('should return OPEN even with non-zero realizedPnL if no lots were closed', () => {
      // Position создана с realizedPnL (rehydration из storage) но openedQuantity не изменилась
      const result = Position.create(createValidParams({
        realizedPnL: SignedQuantity.of(new Decimal(5)),
        // openedQuantity по умолчанию = quantity = 100 → OPEN
      }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        // quantity == openedQuantity → OPEN (несмотря на realizedPnL)
        expect(result.value.getStatus()).toBe('OPEN');
      }
    });

    it('should return OPEN for position with lots', () => {
      const lot = PositionLot.create({
        quantity: Quantity.of(new Decimal(100)),
        entryPrice: Price.of(new Decimal(0.65)),
        timestamp: Timestamp.now(),
      });

      const result = Position.create(createValidParams({ lots: [lot] }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.getStatus()).toBe('OPEN');
      }
    });
  });

  describe('Lot validation', () => {
    it('should reject lots with zero quantity', () => {
      const emptyLot = PositionLot.create({
        quantity: Quantity.ZERO,
        entryPrice: Price.of(new Decimal(0.65)),
        timestamp: Timestamp.now(),
      });

      const result = Position.create(createValidParams({ lots: [emptyLot] }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('empty lots');
      }
    });

    it('should accept lots with positive quantity', () => {
      const validLot = PositionLot.create({
        quantity: Quantity.of(new Decimal(0.000001)),
        entryPrice: Price.of(new Decimal(0.65)),
        timestamp: Timestamp.now(),
      });

      const result = Position.create(createValidParams({ lots: [validLot] }));

      expect(result.ok).toBe(true);
    });

    it('should reject mix of valid and empty lots', () => {
      const validLot = PositionLot.create({
        quantity: Quantity.of(new Decimal(100)),
        entryPrice: Price.of(new Decimal(0.65)),
        timestamp: Timestamp.of(new Decimal(100)),
      });
      const emptyLot = PositionLot.create({
        quantity: Quantity.ZERO,
        entryPrice: Price.of(new Decimal(0.65)),
        timestamp: Timestamp.of(new Decimal(200)),
      });

      const result = Position.create(createValidParams({ lots: [validLot, emptyLot] }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('empty lots');
      }
    });
  });

  describe('openedQuantity', () => {
    it('should default openedQuantity to current quantity', () => {
      const result = Position.create(createValidParams()); // DEFAULT_LOT qty=100

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.openedQuantity.value().toNumber()).toBe(100);
      }
    });

    it('should accept explicit openedQuantity', () => {
      const halfLot = PositionLot.create({
        quantity: Quantity.of(new Decimal(50)),
        entryPrice: Price.of(new Decimal(0.65)),
        timestamp: Timestamp.of(new Decimal(1705318200000)),
      });

      const result = Position.create({
        ...createValidParams({ lots: [halfLot] }),
        openedQuantity: Quantity.of(new Decimal(100)),
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.openedQuantity.value().toNumber()).toBe(100);
        expect(result.value.quantity.value().toNumber()).toBe(50);
      }
    });

    it('should preserve openedQuantity across close() calls', () => {
      const posResult = Position.create(createValidParams()); // openedQty = 100
      expect(posResult.ok).toBe(true);
      if (!posResult.ok) return;

      const closeResult = posResult.value.close(
        Quantity.of(new Decimal(50)),
        Price.of(new Decimal(0.75)),
        'FIFO'
      );

      expect(closeResult.ok).toBe(true);
      if (closeResult.ok) {
        const newPos = closeResult.value.position;
        // openedQuantity не изменился после close
        expect(newPos.openedQuantity.value().toNumber()).toBe(100);
        expect(newPos.quantity.value().toNumber()).toBe(50);
      }
    });

    it('should preserve openedQuantity after multiple close() calls', () => {
      const lot = PositionLot.create({
        quantity: Quantity.of(new Decimal(100)),
        entryPrice: Price.of(new Decimal(0.65)),
        timestamp: Timestamp.of(new Decimal(1705318200000)),
      });
      const posResult = Position.create(createValidParams({ lots: [lot] }));
      expect(posResult.ok).toBe(true);
      if (!posResult.ok) return;

      // Первое частичное закрытие
      const r1 = posResult.value.close(
        Quantity.of(new Decimal(30)),
        Price.of(new Decimal(0.75)),
        'FIFO'
      );
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;

      // Второе частичное закрытие
      const r2 = r1.value.position.close(
        Quantity.of(new Decimal(30)),
        Price.of(new Decimal(0.80)),
        'FIFO'
      );
      expect(r2.ok).toBe(true);
      if (r2.ok) {
        const finalPos = r2.value.position;
        expect(finalPos.openedQuantity.value().toNumber()).toBe(100); // неизменно
        expect(finalPos.quantity.value().toNumber()).toBe(40); // 100 - 30 - 30
        expect(finalPos.getStatus()).toBe('PARTIALLY_CLOSED');
      }
    });
  });

  describe('P&L Calculations', () => {
    it('should calculate unrealized PnL for LONG position (profit)', () => {
      const result = Position.create(createValidParams({ side: 'LONG' }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value;
        // DEFAULT_LOT: 100 @ 0.65
        const currentPrice = Price.of(new Decimal(0.75)); // +0.10
        const unrealizedPnL = position.getUnrealizedPnL(currentPrice);

        // (0.75 - 0.65) * 100 = 10
        expect(unrealizedPnL.value().toNumber()).toBe(10);
      }
    });

    it('should calculate unrealized PnL for LONG position (loss)', () => {
      const result = Position.create(createValidParams({ side: 'LONG' }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value;
        const currentPrice = Price.of(new Decimal(0.55)); // -0.10
        const unrealizedPnL = position.getUnrealizedPnL(currentPrice);

        // (0.55 - 0.65) * 100 = -10
        expect(unrealizedPnL.value().toNumber()).toBe(-10);
      }
    });

    it('should calculate unrealized PnL for SHORT position (profit)', () => {
      const result = Position.create(createValidParams({ side: 'SHORT' }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value;
        const currentPrice = Price.of(new Decimal(0.55)); // -0.10 (profit for SHORT)
        const unrealizedPnL = position.getUnrealizedPnL(currentPrice);

        // -(0.55 - 0.65) * 100 = 10
        expect(unrealizedPnL.value().toNumber()).toBe(10);
      }
    });

    it('should calculate unrealized PnL for SHORT position (loss)', () => {
      const result = Position.create(createValidParams({ side: 'SHORT' }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value;
        const currentPrice = Price.of(new Decimal(0.75)); // +0.10 (loss for SHORT)
        const unrealizedPnL = position.getUnrealizedPnL(currentPrice);

        // -(0.75 - 0.65) * 100 = -10
        expect(unrealizedPnL.value().toNumber()).toBe(-10);
      }
    });

    it('should return zero unrealized PnL for closed position (empty lots)', () => {
      const result = Position.create(createValidParams({ lots: [] }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value;
        const currentPrice = Price.of(new Decimal(0.75));
        const unrealizedPnL = position.getUnrealizedPnL(currentPrice);

        expect(unrealizedPnL.isZero()).toBe(true);
      }
    });

    it('should calculate total PnL (realized + unrealized)', () => {
      const result = Position.create(createValidParams({
        side: 'LONG',
        realizedPnL: SignedQuantity.of(new Decimal(15)),
      }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value;
        const currentPrice = Price.of(new Decimal(0.75)); // unrealized = 10
        const totalPnL = position.getTotalPnL(currentPrice);

        // 15 (realized) + 10 (unrealized) = 25
        expect(totalPnL.value().toNumber()).toBe(25);
      }
    });

    it('should calculate total PnL with negative realized', () => {
      const result = Position.create(createValidParams({
        side: 'LONG',
        realizedPnL: SignedQuantity.of(new Decimal(-5)),
      }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value;
        const currentPrice = Price.of(new Decimal(0.75)); // unrealized = 10
        const totalPnL = position.getTotalPnL(currentPrice);

        // -5 (realized) + 10 (unrealized) = 5
        expect(totalPnL.value().toNumber()).toBe(5);
      }
    });
  });

  describe('Lots', () => {
    it('should handle empty lots array', () => {
      const result = Position.create(createValidParams({ lots: [] }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value;
        expect(position.lots.length).toBe(0);
        expect(position.quantity.isZero()).toBe(true);
      }
    });

    it('should handle single lot', () => {
      const lot = PositionLot.create({
        quantity: Quantity.of(new Decimal(50)),
        entryPrice: Price.of(new Decimal(0.60)),
        timestamp: Timestamp.now(),
      });

      const result = Position.create(createValidParams({ lots: [lot] }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value;
        expect(position.lots.length).toBe(1);
        expect(position.lots[0].quantity.value().toNumber()).toBe(50);
      }
    });

    it('should handle multiple lots', () => {
      const lot1 = PositionLot.create({
        quantity: Quantity.of(new Decimal(50)),
        entryPrice: Price.of(new Decimal(0.60)),
        timestamp: Timestamp.of(new Decimal(100)),
      });

      const lot2 = PositionLot.create({
        quantity: Quantity.of(new Decimal(50)),
        entryPrice: Price.of(new Decimal(0.70)),
        timestamp: Timestamp.of(new Decimal(200)),
      });

      const result = Position.create(createValidParams({ lots: [lot1, lot2] }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value;
        expect(position.lots.length).toBe(2);
      }
    });

    it('should handle lot with fee', () => {
      const lot = PositionLot.create({
        quantity: Quantity.of(new Decimal(50)),
        entryPrice: Price.of(new Decimal(0.60)),
        timestamp: Timestamp.now(),
        fee: Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal(1)))),
      });

      const result = Position.create(createValidParams({ lots: [lot] }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value;
        expect(position.lots[0].fee).toBeDefined();
      }
    });
  });

  describe('close()', () => {
    it('should close position using FIFO strategy', () => {
      const lot1 = PositionLot.create({
        quantity: Quantity.of(new Decimal(50)),
        entryPrice: Price.of(new Decimal(0.60)),
        timestamp: Timestamp.of(new Decimal(100)),
      });
      const lot2 = PositionLot.create({
        quantity: Quantity.of(new Decimal(50)),
        entryPrice: Price.of(new Decimal(0.70)),
        timestamp: Timestamp.of(new Decimal(200)),
      });

      const posResult = Position.create(createValidParams({ lots: [lot1, lot2] }));
      expect(posResult.ok).toBe(true);
      if (!posResult.ok) return;

      const result = posResult.value.close(
        Quantity.of(new Decimal(50)),
        Price.of(new Decimal(0.75)),
        'FIFO'
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const { position, realizedPnL } = result.value;
        // FIFO закрыл lot1 (50), остался lot2 (50)
        expect(position.quantity.value().toNumber()).toBe(50);
        expect(position.lots.length).toBe(1);
        // (0.75 - 0.60) * 50 = 7.5
        expect(realizedPnL.value().toNumber()).toBe(7.5);
      }
    });

    it('should close position using LIFO strategy', () => {
      const lot1 = PositionLot.create({
        quantity: Quantity.of(new Decimal(50)),
        entryPrice: Price.of(new Decimal(0.60)),
        timestamp: Timestamp.of(new Decimal(100)),
      });
      const lot2 = PositionLot.create({
        quantity: Quantity.of(new Decimal(50)),
        entryPrice: Price.of(new Decimal(0.70)),
        timestamp: Timestamp.of(new Decimal(200)),
      });

      const posResult = Position.create(createValidParams({ lots: [lot1, lot2] }));
      expect(posResult.ok).toBe(true);
      if (!posResult.ok) return;

      const result = posResult.value.close(
        Quantity.of(new Decimal(50)),
        Price.of(new Decimal(0.75)),
        'LIFO'
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const { position, realizedPnL } = result.value;
        // LIFO закрыл lot2 (50), остался lot1 (50)
        expect(position.quantity.value().toNumber()).toBe(50);
        // (0.75 - 0.70) * 50 = 2.5
        expect(realizedPnL.value().toNumber()).toBe(2.5);
      }
    });

    it('should accumulate realizedPnL on new position', () => {
      const posResult = Position.create(createValidParams({
        realizedPnL: SignedQuantity.of(new Decimal(10)),
      }));
      expect(posResult.ok).toBe(true);
      if (!posResult.ok) return;

      const result = posResult.value.close(
        Quantity.of(new Decimal(50)),
        Price.of(new Decimal(0.75)),
        'FIFO'
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        // старый realized (10) + новый (5) = 15
        expect(result.value.position.realizedPnL.value().toNumber()).toBe(15);
      }
    });

    it('should reject zero close quantity', () => {
      const posResult = Position.create(createValidParams());
      expect(posResult.ok).toBe(true);
      if (!posResult.ok) return;

      const result = posResult.value.close(
        Quantity.ZERO,
        Price.of(new Decimal(0.75)),
        'FIFO'
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('must be positive');
      }
    });

    it('should reject close quantity exceeding position quantity', () => {
      const posResult = Position.create(createValidParams()); // quantity = 100
      expect(posResult.ok).toBe(true);
      if (!posResult.ok) return;

      const result = posResult.value.close(
        Quantity.of(new Decimal(150)),
        Price.of(new Decimal(0.75)),
        'FIFO'
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('exceeds position quantity');
      }
    });

    it('should set PARTIALLY_CLOSED status after partial close', () => {
      const posResult = Position.create(createValidParams());
      expect(posResult.ok).toBe(true);
      if (!posResult.ok) return;

      const result = posResult.value.close(
        Quantity.of(new Decimal(50)),
        Price.of(new Decimal(0.75)),
        'FIFO'
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.position.getStatus()).toBe('PARTIALLY_CLOSED');
      }
    });

    it('should set CLOSED status after full close', () => {
      const posResult = Position.create(createValidParams()); // 100 lots
      expect(posResult.ok).toBe(true);
      if (!posResult.ok) return;

      const result = posResult.value.close(
        Quantity.of(new Decimal(100)),
        Price.of(new Decimal(0.75)),
        'FIFO'
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.position.getStatus()).toBe('CLOSED');
        expect(result.value.position.isClosed()).toBe(true);
      }
    });
  });

  describe('Serialization', () => {
    it('should serialize to JSON with string Decimal fields', () => {
      const result = Position.create(createValidParams({ side: 'LONG' }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value;
        const json = position.toJSON();

        expect(json.id).toBe('pos-123');
        expect(json.accountId).toBe(TEST_ACCOUNT_ID);
        expect(json.side).toBe('LONG');
        // Decimal-поля — строки для сохранения точности
        expect(json.quantity).toBe('100');
        expect(json.openedQuantity).toBe('100');
        expect(json.averageEntryPrice).toBe('0.65');
        expect(json.status).toBe('OPEN');
        expect(json.realizedPnL).toBe('0');
        expect(json.lotsCount).toBe(1);
      }
    });

    it('should serialize PARTIALLY_CLOSED status when quantity < openedQuantity', () => {
      const halfLot = PositionLot.create({
        quantity: Quantity.of(new Decimal(50)),
        entryPrice: Price.of(new Decimal(0.65)),
        timestamp: Timestamp.of(new Decimal(1705318200000)),
      });

      const result = Position.create({
        ...createValidParams({ lots: [halfLot] }),
        openedQuantity: Quantity.of(new Decimal(100)),
        realizedPnL: SignedQuantity.of(new Decimal(5)),
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const json = result.value.toJSON();
        expect(json.quantity).toBe('50');
        expect(json.openedQuantity).toBe('100');
        expect(json.status).toBe('PARTIALLY_CLOSED');
        expect(json.realizedPnL).toBe('5');
      }
    });

    it('should convert to string with qty/openedQty format', () => {
      const result = Position.create(createValidParams());

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value;
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
    it('should have readonly lots array', () => {
      const result = Position.create(createValidParams());

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value;
        expect(Array.isArray(position.lots)).toBe(true);
      }
    });

    it('close() should not mutate original position', () => {
      const posResult = Position.create(createValidParams());
      expect(posResult.ok).toBe(true);
      if (!posResult.ok) return;

      const original = posResult.value;
      const originalQty = original.quantity.value().toNumber();
      const originalLots = original.lots.length;

      original.close(Quantity.of(new Decimal(50)), Price.of(new Decimal(0.75)), 'FIFO');

      // Оригинальная позиция не изменилась
      expect(original.quantity.value().toNumber()).toBe(originalQty);
      expect(original.lots.length).toBe(originalLots);
    });
  });

  describe('Edge Cases', () => {
    it('should handle very small quantities', () => {
      const lot = PositionLot.create({
        quantity: Quantity.of(new Decimal('0.000001')),
        entryPrice: Price.of(new Decimal(0.65)),
        timestamp: Timestamp.now(),
      });
      const result = Position.create(createValidParams({ lots: [lot] }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value;
        expect(position.quantity.value().toNumber()).toBe(0.000001);
      }
    });

    it('should handle very large quantities', () => {
      const lot = PositionLot.create({
        quantity: Quantity.of(new Decimal('1000000')),
        entryPrice: Price.of(new Decimal(0.65)),
        timestamp: Timestamp.now(),
      });
      const result = Position.create(createValidParams({ lots: [lot] }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value;
        expect(position.quantity.value().toNumber()).toBe(1000000);
      }
    });

    it('should handle price at extremes (near 0)', () => {
      const lot = PositionLot.create({
        quantity: Quantity.of(new Decimal(100)),
        entryPrice: Price.of(new Decimal('0.01')),
        timestamp: Timestamp.now(),
      });
      const result = Position.create(createValidParams({ lots: [lot] }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value;
        expect(position.averageEntryPrice.value().toNumber()).toBe(0.01);
      }
    });

    it('should handle price at extremes (near 1)', () => {
      const lot = PositionLot.create({
        quantity: Quantity.of(new Decimal(100)),
        entryPrice: Price.of(new Decimal('0.99')),
        timestamp: Timestamp.now(),
      });
      const result = Position.create(createValidParams({ lots: [lot] }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value;
        expect(position.averageEntryPrice.value().toNumber()).toBe(0.99);
      }
    });
  });
});
