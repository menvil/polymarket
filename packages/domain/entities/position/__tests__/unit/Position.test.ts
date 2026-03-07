/**
 * Тесты для Position entity
 *
 * @remarks
 * После DDD-рефакторинга:
 * - quantity и averageEntryPrice — derived getters из lots
 * - PositionParams не содержит quantity/averageEntryPrice
 * - lots — единственный источник истины
 * - timestamp → openedAt + updatedAt
 * - fees убраны из Position (принадлежат Fill)
 * - close() принимает closedAt: Timestamp
 * - addLots() для роста позиции
 */

import { describe, it, expect } from '@jest/globals';
import { Position } from '../../src/Position.js';
import type { PositionParams } from '../../src/Position.js';
import { PositionLot } from '../../src/core/PositionLot.js';
import { Quantity, Price, Timestamp } from '@polymarket/value-objects';
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

const CLOSE_AT = Timestamp.of(new Decimal(1705318300000));

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
    openedAt: Timestamp.now(),
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

    it('should reject missing openedAt', () => {
      const params = { ...createValidParams(), openedAt: undefined as any };
      const result = Position.create(params);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('openedAt is required');
      }
    });

    it('should use default values for optional fields', () => {
      const params = createValidParams();
      const result = Position.create(params);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value;
        expect(position.realizedPnL.isZero()).toBe(true);
      }
    });

    it('should accept provided realizedPnL', () => {
      const params = createValidParams({
        realizedPnL: SignedQuantity.of(new Decimal(50)),
      });
      const result = Position.create(params);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const position = result.value;
        expect(position.realizedPnL.value().toNumber()).toBe(50);
      }
    });

    it('should sort lots by timestamp ASC in create()', () => {
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

      // Передаём в обратном порядке — create() должен отсортировать
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

  describe('openedAt / updatedAt', () => {
    it('should set openedAt from params', () => {
      const openedAt = Timestamp.of(new Decimal(1000));
      const result = Position.create(createValidParams({ openedAt }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.openedAt.toNumber()).toBe(1000);
      }
    });

    it('should default updatedAt to openedAt when not provided', () => {
      const openedAt = Timestamp.of(new Decimal(1000));
      const result = Position.create(createValidParams({ openedAt }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.updatedAt.toNumber()).toBe(1000);
      }
    });

    it('should set updatedAt from params when provided', () => {
      const openedAt = Timestamp.of(new Decimal(1000));
      const updatedAt = Timestamp.of(new Decimal(2000));
      const result = Position.create(createValidParams({ openedAt, updatedAt }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.openedAt.toNumber()).toBe(1000);
        expect(result.value.updatedAt.toNumber()).toBe(2000);
      }
    });

    it('should update updatedAt after close()', () => {
      const openedAt = Timestamp.of(new Decimal(1000));
      const closedAt = Timestamp.of(new Decimal(5000));
      const posResult = Position.create(createValidParams({ openedAt }));
      expect(posResult.ok).toBe(true);
      if (!posResult.ok) return;

      const closeResult = posResult.value.close(
        Quantity.of(new Decimal(50)),
        Price.of(new Decimal(0.75)),
        'FIFO',
        closedAt,
      );

      expect(closeResult.ok).toBe(true);
      if (closeResult.ok) {
        // openedAt не изменился
        expect(closeResult.value.position.openedAt.toNumber()).toBe(1000);
        // updatedAt = closedAt
        expect(closeResult.value.position.updatedAt.toNumber()).toBe(5000);
      }
    });

    it('should update updatedAt after addLots()', () => {
      const openedAt = Timestamp.of(new Decimal(1000));
      const addedAt = Timestamp.of(new Decimal(3000));
      const posResult = Position.create(createValidParams({ openedAt }));
      expect(posResult.ok).toBe(true);
      if (!posResult.ok) return;

      const newLot = PositionLot.create({
        quantity: Quantity.of(new Decimal(50)),
        entryPrice: Price.of(new Decimal(0.70)),
        timestamp: Timestamp.of(new Decimal(3000)),
      });

      const addResult = posResult.value.addLots([newLot], addedAt);

      expect(addResult.ok).toBe(true);
      if (addResult.ok) {
        expect(addResult.value.openedAt.toNumber()).toBe(1000);
        expect(addResult.value.updatedAt.toNumber()).toBe(3000);
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
        'FIFO',
        CLOSE_AT,
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
        'FIFO',
        Timestamp.of(new Decimal(2000)),
      );
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;

      // Второе частичное закрытие
      const r2 = r1.value.position.close(
        Quantity.of(new Decimal(30)),
        Price.of(new Decimal(0.80)),
        'FIFO',
        Timestamp.of(new Decimal(3000)),
      );
      expect(r2.ok).toBe(true);
      if (r2.ok) {
        const finalPos = r2.value.position;
        expect(finalPos.openedQuantity.value().toNumber()).toBe(100); // неизменно
        expect(finalPos.quantity.value().toNumber()).toBe(40); // 100 - 30 - 30
        expect(finalPos.getStatus()).toBe('PARTIALLY_CLOSED');
      }
    });

    it('should increase openedQuantity after addLots()', () => {
      const posResult = Position.create(createValidParams()); // openedQty = 100
      expect(posResult.ok).toBe(true);
      if (!posResult.ok) return;

      const newLot = PositionLot.create({
        quantity: Quantity.of(new Decimal(50)),
        entryPrice: Price.of(new Decimal(0.70)),
        timestamp: Timestamp.of(new Decimal(2000)),
      });

      const addResult = posResult.value.addLots([newLot], Timestamp.of(new Decimal(2000)));

      expect(addResult.ok).toBe(true);
      if (addResult.ok) {
        const grown = addResult.value;
        expect(grown.openedQuantity.value().toNumber()).toBe(150); // 100 + 50
        expect(grown.quantity.value().toNumber()).toBe(150);
      }
    });
  });

  describe('addLots()', () => {
    it('should add new lots and merge sorted', () => {
      const lot1 = PositionLot.create({
        quantity: Quantity.of(new Decimal(100)),
        entryPrice: Price.of(new Decimal(0.65)),
        timestamp: Timestamp.of(new Decimal(1000)),
      });
      const posResult = Position.create(createValidParams({ lots: [lot1] }));
      expect(posResult.ok).toBe(true);
      if (!posResult.ok) return;

      // Новый лот с timestamp между lot1 и lot3
      const lot2 = PositionLot.create({
        quantity: Quantity.of(new Decimal(50)),
        entryPrice: Price.of(new Decimal(0.70)),
        timestamp: Timestamp.of(new Decimal(500)), // старше lot1
      });

      const addResult = posResult.value.addLots([lot2], Timestamp.now());

      expect(addResult.ok).toBe(true);
      if (addResult.ok) {
        const grown = addResult.value;
        expect(grown.lots.length).toBe(2);
        // После merge + sort: lot2(500) < lot1(1000)
        expect(grown.lots[0].timestamp.toNumber()).toBe(500);
        expect(grown.lots[1].timestamp.toNumber()).toBe(1000);
        expect(grown.quantity.value().toNumber()).toBe(150);
      }
    });

    it('should reject empty newLots array', () => {
      const posResult = Position.create(createValidParams());
      expect(posResult.ok).toBe(true);
      if (!posResult.ok) return;

      const addResult = posResult.value.addLots([], Timestamp.now());

      expect(addResult.ok).toBe(false);
      if (!addResult.ok) {
        expect(addResult.error.message).toContain('must not be empty');
      }
    });

    it('should reject newLots with zero quantity', () => {
      const posResult = Position.create(createValidParams());
      expect(posResult.ok).toBe(true);
      if (!posResult.ok) return;

      const emptyLot = PositionLot.create({
        quantity: Quantity.ZERO,
        entryPrice: Price.of(new Decimal(0.65)),
        timestamp: Timestamp.now(),
      });

      const addResult = posResult.value.addLots([emptyLot], Timestamp.now());

      expect(addResult.ok).toBe(false);
      if (!addResult.ok) {
        expect(addResult.error.message).toContain('empty lots');
      }
    });

    it('should preserve realizedPnL after addLots()', () => {
      const posResult = Position.create(createValidParams({
        realizedPnL: SignedQuantity.of(new Decimal(10)),
      }));
      expect(posResult.ok).toBe(true);
      if (!posResult.ok) return;

      const newLot = PositionLot.create({
        quantity: Quantity.of(new Decimal(50)),
        entryPrice: Price.of(new Decimal(0.70)),
        timestamp: Timestamp.of(new Decimal(2000)),
      });

      const addResult = posResult.value.addLots([newLot], Timestamp.now());

      expect(addResult.ok).toBe(true);
      if (addResult.ok) {
        expect(addResult.value.realizedPnL.value().toNumber()).toBe(10); // неизменно
      }
    });

    it('should add multiple lots at once', () => {
      const posResult = Position.create(createValidParams()); // 100 qty
      expect(posResult.ok).toBe(true);
      if (!posResult.ok) return;

      const newLot1 = PositionLot.create({
        quantity: Quantity.of(new Decimal(30)),
        entryPrice: Price.of(new Decimal(0.70)),
        timestamp: Timestamp.of(new Decimal(2000)),
      });
      const newLot2 = PositionLot.create({
        quantity: Quantity.of(new Decimal(20)),
        entryPrice: Price.of(new Decimal(0.72)),
        timestamp: Timestamp.of(new Decimal(3000)),
      });

      const addResult = posResult.value.addLots([newLot1, newLot2], Timestamp.now());

      expect(addResult.ok).toBe(true);
      if (addResult.ok) {
        expect(addResult.value.quantity.value().toNumber()).toBe(150); // 100+30+20
        expect(addResult.value.openedQuantity.value().toNumber()).toBe(150);
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
        'FIFO',
        CLOSE_AT,
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
        'LIFO',
        CLOSE_AT,
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
        'FIFO',
        CLOSE_AT,
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
        'FIFO',
        CLOSE_AT,
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
        'FIFO',
        CLOSE_AT,
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
        'FIFO',
        CLOSE_AT,
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
        'FIFO',
        CLOSE_AT,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.position.getStatus()).toBe('CLOSED');
        expect(result.value.position.isClosed()).toBe(true);
      }
    });

    it('should maintain sorted lots after LIFO close', () => {
      const lot1 = PositionLot.create({
        quantity: Quantity.of(new Decimal(50)),
        entryPrice: Price.of(new Decimal(0.60)),
        timestamp: Timestamp.of(new Decimal(100)),
      });
      const lot2 = PositionLot.create({
        quantity: Quantity.of(new Decimal(30)),
        entryPrice: Price.of(new Decimal(0.65)),
        timestamp: Timestamp.of(new Decimal(200)),
      });
      const lot3 = PositionLot.create({
        quantity: Quantity.of(new Decimal(20)),
        entryPrice: Price.of(new Decimal(0.70)),
        timestamp: Timestamp.of(new Decimal(300)),
      });

      const posResult = Position.create(createValidParams({ lots: [lot1, lot2, lot3] }));
      expect(posResult.ok).toBe(true);
      if (!posResult.ok) return;

      // LIFO закрывает lot3 (20) полностью + 15 из lot2
      const result = posResult.value.close(
        Quantity.of(new Decimal(35)),
        Price.of(new Decimal(0.75)),
        'LIFO',
        CLOSE_AT,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const { position } = result.value;
        // Оставшиеся лоты: lot1(50, ts=100) и lot2_partial(15, ts=200)
        // Должны быть в ASC-порядке по timestamp
        expect(position.lots.length).toBe(2);
        expect(position.lots[0].timestamp.toNumber()).toBe(100); // lot1 первый
        expect(position.lots[1].timestamp.toNumber()).toBe(200); // lot2_partial второй
      }
    });
  });

  describe('Serialization', () => {
    it('should serialize to JSON with string Decimal fields', () => {
      const openedAt = Timestamp.of(new Decimal(1705318200000));
      const result = Position.create(createValidParams({ side: 'LONG', openedAt }));

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
        expect(json.openedAt).toBe(1705318200000);
        expect(json.updatedAt).toBe(1705318200000); // defaults to openedAt
        // fees нет
        expect(json.fees).toBeUndefined();
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

    it('should serialize updatedAt after close()', () => {
      const openedAt = Timestamp.of(new Decimal(1000));
      const closedAt = Timestamp.of(new Decimal(5000));
      const posResult = Position.create(createValidParams({ openedAt }));
      expect(posResult.ok).toBe(true);
      if (!posResult.ok) return;

      const closeResult = posResult.value.close(
        Quantity.of(new Decimal(50)),
        Price.of(new Decimal(0.75)),
        'FIFO',
        closedAt,
      );

      expect(closeResult.ok).toBe(true);
      if (closeResult.ok) {
        const json = closeResult.value.position.toJSON();
        expect(json.openedAt).toBe(1000);
        expect(json.updatedAt).toBe(5000);
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

      original.close(Quantity.of(new Decimal(50)), Price.of(new Decimal(0.75)), 'FIFO', CLOSE_AT);

      // Оригинальная позиция не изменилась
      expect(original.quantity.value().toNumber()).toBe(originalQty);
      expect(original.lots.length).toBe(originalLots);
    });

    it('addLots() should not mutate original position', () => {
      const posResult = Position.create(createValidParams());
      expect(posResult.ok).toBe(true);
      if (!posResult.ok) return;

      const original = posResult.value;
      const originalQty = original.quantity.value().toNumber();

      const newLot = PositionLot.create({
        quantity: Quantity.of(new Decimal(50)),
        entryPrice: Price.of(new Decimal(0.70)),
        timestamp: Timestamp.now(),
      });

      original.addLots([newLot], Timestamp.now());

      // Оригинальная позиция не изменилась
      expect(original.quantity.value().toNumber()).toBe(originalQty);
      expect(original.lots.length).toBe(1);
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
