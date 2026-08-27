/**
 * Тесты для FIFO/LIFO алгоритмов
 *
 * @remarks
 * После DDD-рефакторинга:
 * - CloseResult.position вместо CloseResult.newPosition
 * - PositionParams не содержит quantity/averageEntryPrice
 * - validateLotsConsistency удалена (lots = единственный источник истины)
 * - timestamp → openedAt; close() принимает closedAt: Timestamp
 * - fees убраны из Position
 */

import { describe, it, expect } from '@jest/globals';
import {
  closeFIFO,
  closeLIFO,
  calculateWeightedAveragePrice,
} from '../../../src/algorithms/fifo-lifo.js';
import { Position } from '../../../src/Position.js';
import type { PositionParams } from '../../../src/Position.js';
import { PositionLot } from '../../../src/core/PositionLot.js';
import { Quantity, OutcomePrice } from '@polymarket/value-objects';
import { Timestamp } from '@polymarket/timestamp';
import { SignedQuantity } from '@polymarket/value-objects/signed-quantity';
import { asPositionId, asInstrumentId, parseAccountId, AssetIdHelpers } from '@polymarket/ids';
import Decimal from 'decimal.js';

const TEST_ACCOUNT_ID = parseAccountId('venue:POLYMARKET:account-456')!;
const TEST_ASSET_ID = AssetIdHelpers.USDC;
const CLOSE_AT = Timestamp.of(new Decimal(9999999));

/** Разворачивает Result или бросает ошибку — только для тестов */
function unwrapOk<T>(result: { ok: true; value: T } | { ok: false; error: unknown }, msg?: string): T {
  if (!result.ok) throw new Error(msg ?? 'Expected ok result');
  return result.value;
}

describe('FIFO/LIFO Algorithms', () => {
  // Helper для создания лота
  const createLot = (
    quantity: number,
    price: number,
    timestampMs: number
  ): PositionLot => PositionLot.create({
    quantity: Quantity.of(new Decimal(quantity)),
    entryPrice: OutcomePrice.of(new Decimal(price)),
    timestamp: Timestamp.of(new Decimal(timestampMs)),
  });

  // Helper для создания позиции с лотами
  const createPositionWithLots = (
    lots: PositionLot[],
    side: 'LONG' | 'SHORT' = 'LONG'
  ): Position => {
    const params: PositionParams = {
      id: asPositionId('pos-123')!,
      accountId: TEST_ACCOUNT_ID,
      instrumentId: asInstrumentId('market-abc')!,
      asset: TEST_ASSET_ID,
      side,
      openedAt: Timestamp.of(new Decimal(1)),
      lots,
    };

    return unwrapOk(Position.create(params), 'createPositionWithLots: Position.create failed');
  };

  describe('closeFIFO', () => {
    it('should close oldest lot first', () => {
      // Создаем 3 лота
      const lot1 = createLot(50, 0.60, 100);
      const lot2 = createLot(30, 0.65, 200);
      const lot3 = createLot(20, 0.70, 300);

      const position = createPositionWithLots([lot1, lot2, lot3]);

      // Закрываем 60 @ 0.75
      const closeQty = Quantity.of(new Decimal(60));
      const closePrice = OutcomePrice.of(new Decimal(0.75));

      const result = closeFIFO(position, closeQty, closePrice, CLOSE_AT);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const { position: newPosition, realizedPnL, closedLots } = result.value;

        // Проверяем новую позицию
        expect(newPosition.quantity.value().toNumber()).toBe(40); // 100 - 60
        expect(newPosition.lots.length).toBe(2); // Lot 2 (частично) + Lot 3

        // Проверяем realized P&L
        // Lot 1: (0.75 - 0.60) * 50 = 7.5
        // Lot 2 (partial): (0.75 - 0.65) * 10 = 1.0
        // Total: 8.5
        expect(realizedPnL.value().toNumber()).toBe(8.5);

        // Проверяем закрытые лоты
        expect(closedLots.length).toBe(2);
        expect(closedLots[0].closedQuantity.value().toNumber()).toBe(50); // Lot 1 полностью
        expect(closedLots[1].closedQuantity.value().toNumber()).toBe(10); // Lot 2 частично
      }
    });

    it('should close entire position', () => {
      const lot1 = createLot(50, 0.60, 100);
      const lot2 = createLot(50, 0.70, 200);

      const position = createPositionWithLots([lot1, lot2]);

      // Закрываем полностью
      const closeQty = Quantity.of(new Decimal(100));
      const closePrice = OutcomePrice.of(new Decimal(0.75));

      const result = closeFIFO(position, closeQty, closePrice, CLOSE_AT);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const { position: newPosition, realizedPnL } = result.value;

        // Позиция полностью закрыта
        expect(newPosition.quantity.isZero()).toBe(true);
        expect(newPosition.lots.length).toBe(0);
        expect(newPosition.isClosed()).toBe(true);

        // P&L: (0.75 - 0.60) * 50 + (0.75 - 0.70) * 50 = 10
        expect(realizedPnL.value().toNumber()).toBe(10);
      }
    });

    it('should handle SHORT position', () => {
      const lot1 = createLot(50, 0.70, 100);
      const lot2 = createLot(50, 0.65, 200);

      const position = createPositionWithLots([lot1, lot2], 'SHORT');

      // Закрываем 60 @ 0.60
      const closeQty = Quantity.of(new Decimal(60));
      const closePrice = OutcomePrice.of(new Decimal(0.60));

      const result = closeFIFO(position, closeQty, closePrice, CLOSE_AT);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const { realizedPnL } = result.value;

        // SHORT P&L: -(closePrice - entryPrice) * quantity
        // Lot 1: -(0.60 - 0.70) * 50 = 5.0
        // Lot 2: -(0.60 - 0.65) * 10 = 0.5
        // Total: 5.5
        expect(realizedPnL.value().toNumber()).toBe(5.5);
      }
    });

    it('should reject zero close quantity', () => {
      const lot = createLot(100, 0.65, 100);
      const position = createPositionWithLots([lot]);

      const closeQty = Quantity.ZERO;
      const closePrice = OutcomePrice.of(new Decimal(0.75));

      const result = closeFIFO(position, closeQty, closePrice, CLOSE_AT);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('must be positive');
      }
    });

    it('should reject close quantity exceeding position quantity', () => {
      const lot = createLot(100, 0.65, 100);
      const position = createPositionWithLots([lot]);

      const closeQty = Quantity.of(new Decimal(150)); // > 100
      const closePrice = OutcomePrice.of(new Decimal(0.75));

      const result = closeFIFO(position, closeQty, closePrice, CLOSE_AT);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('exceeds position quantity');
      }
    });

    it('should reject position with no lots', () => {
      // Позиция без лотов (закрытая)
      const position = unwrapOk(Position.create({
        id: asPositionId('pos-123')!,
        accountId: TEST_ACCOUNT_ID,
        instrumentId: asInstrumentId('market-abc')!,
        asset: TEST_ASSET_ID,
        side: 'LONG',
        openedAt: Timestamp.of(new Decimal(1)),
        lots: [],
      }));

      const closeQty = Quantity.of(new Decimal(10));
      const closePrice = OutcomePrice.of(new Decimal(0.75));

      const result = closeFIFO(position, closeQty, closePrice, CLOSE_AT);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('no lots');
      }
    });

    it('should accumulate realized P&L', () => {
      const lot = createLot(100, 0.65, 100);
      const positionBase = createPositionWithLots([lot]);

      // Позиция уже имеет realized P&L
      const positionWithPnL = unwrapOk(Position.create({
        id: positionBase.id,
        accountId: positionBase.accountId,
        instrumentId: positionBase.instrumentId,
        asset: positionBase.asset,
        side: positionBase.side,
        openedAt: positionBase.openedAt,
        lots: positionBase.lots,
        realizedPnL: SignedQuantity.of(new Decimal(10)),
      }));

      const closeQty = Quantity.of(new Decimal(50));
      const closePrice = OutcomePrice.of(new Decimal(0.75));

      const result = closeFIFO(positionWithPnL, closeQty, closePrice, CLOSE_AT);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const { position: newPosition } = result.value;

        // Новый realized = старый (10) + новый (5) = 15
        expect(newPosition.realizedPnL.value().toNumber()).toBe(15);
      }
    });

    it('should close single lot partially', () => {
      const lot = createLot(100, 0.65, 100);
      const position = createPositionWithLots([lot]);

      const closeQty = Quantity.of(new Decimal(30));
      const closePrice = OutcomePrice.of(new Decimal(0.75));

      const result = closeFIFO(position, closeQty, closePrice, CLOSE_AT);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const { position: newPosition, closedLots } = result.value;

        // Остается 70
        expect(newPosition.quantity.value().toNumber()).toBe(70);
        expect(newPosition.lots.length).toBe(1);
        expect(newPosition.lots[0].quantity.value().toNumber()).toBe(70);

        // Закрыто частично
        expect(closedLots.length).toBe(1);
        expect(closedLots[0].closedQuantity.value().toNumber()).toBe(30);
      }
    });

    it('should set closedAt as updatedAt on new position', () => {
      const closedAt = Timestamp.of(new Decimal(9000));
      const position = createPositionWithLots([createLot(100, 0.65, 100)]);

      const result = closeFIFO(
        position,
        Quantity.of(new Decimal(50)),
        OutcomePrice.of(new Decimal(0.75)),
        closedAt,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.position.updatedAt.toNumber()).toBe(9000);
      }
    });
  });

  describe('closeLIFO', () => {
    it('should close newest lot first', () => {
      // Создаем 3 лота
      const lot1 = createLot(50, 0.60, 100);
      const lot2 = createLot(30, 0.65, 200);
      const lot3 = createLot(20, 0.70, 300);

      const position = createPositionWithLots([lot1, lot2, lot3]);

      // Закрываем 60 @ 0.75
      const closeQty = Quantity.of(new Decimal(60));
      const closePrice = OutcomePrice.of(new Decimal(0.75));

      const result = closeLIFO(position, closeQty, closePrice, CLOSE_AT);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const { position: newPosition, realizedPnL, closedLots } = result.value;

        // Проверяем новую позицию
        expect(newPosition.quantity.value().toNumber()).toBe(40); // 100 - 60
        expect(newPosition.lots.length).toBe(1); // Только Lot 1 (частично)

        // Проверяем realized P&L
        // Lot 3: (0.75 - 0.70) * 20 = 1.0
        // Lot 2: (0.75 - 0.65) * 30 = 3.0
        // Lot 1 (partial): (0.75 - 0.60) * 10 = 1.5
        // Total: 5.5
        expect(realizedPnL.value().toNumber()).toBe(5.5);

        // Проверяем закрытые лоты (в порядке закрытия)
        expect(closedLots.length).toBe(3);
        expect(closedLots[0].closedQuantity.value().toNumber()).toBe(20); // Lot 3 полностью
        expect(closedLots[1].closedQuantity.value().toNumber()).toBe(30); // Lot 2 полностью
        expect(closedLots[2].closedQuantity.value().toNumber()).toBe(10); // Lot 1 частично
      }
    });

    it('should return remaining lots sorted ASC after LIFO close', () => {
      const lot1 = createLot(50, 0.60, 100);
      const lot2 = createLot(30, 0.65, 200);
      const lot3 = createLot(20, 0.70, 300);

      const position = createPositionWithLots([lot1, lot2, lot3]);

      // Закрываем только lot3 (20) и 5 из lot2 — остаётся lot2_partial(25) + lot1(50)
      const result = closeLIFO(
        position,
        Quantity.of(new Decimal(25)),
        OutcomePrice.of(new Decimal(0.75)),
        CLOSE_AT,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const { position: newPosition } = result.value;
        // Оставшиеся лоты должны быть в ASC-порядке по timestamp
        expect(newPosition.lots.length).toBe(2);
        expect(newPosition.lots[0].timestamp.toNumber()).toBe(100); // lot1 первый
        expect(newPosition.lots[1].timestamp.toNumber()).toBe(200); // lot2_partial второй
      }
    });

    it('should close entire position', () => {
      const lot1 = createLot(50, 0.60, 100);
      const lot2 = createLot(50, 0.70, 200);

      const position = createPositionWithLots([lot1, lot2]);

      // Закрываем полностью
      const closeQty = Quantity.of(new Decimal(100));
      const closePrice = OutcomePrice.of(new Decimal(0.75));

      const result = closeLIFO(position, closeQty, closePrice, CLOSE_AT);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const { position: newPosition, realizedPnL } = result.value;

        // Позиция полностью закрыта
        expect(newPosition.quantity.isZero()).toBe(true);
        expect(newPosition.lots.length).toBe(0);

        // P&L: (0.75 - 0.70) * 50 + (0.75 - 0.60) * 50 = 10
        expect(realizedPnL.value().toNumber()).toBe(10);
      }
    });

    it('should handle SHORT position', () => {
      const lot1 = createLot(50, 0.65, 100);
      const lot2 = createLot(50, 0.70, 200);

      const position = createPositionWithLots([lot1, lot2], 'SHORT');

      // Закрываем 60 @ 0.60
      const closeQty = Quantity.of(new Decimal(60));
      const closePrice = OutcomePrice.of(new Decimal(0.60));

      const result = closeLIFO(position, closeQty, closePrice, CLOSE_AT);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const { realizedPnL } = result.value;

        // SHORT P&L: -(closePrice - entryPrice) * quantity
        // Lot 2: -(0.60 - 0.70) * 50 = 5.0
        // Lot 1: -(0.60 - 0.65) * 10 = 0.5
        // Total: 5.5
        expect(realizedPnL.value().toNumber()).toBe(5.5);
      }
    });

    it('should differ from FIFO in P&L calculation', () => {
      // Создаем позицию с разными entry prices
      const lot1 = createLot(50, 0.60, 100); // cheap
      const lot2 = createLot(50, 0.70, 200); // expensive

      const position = createPositionWithLots([lot1, lot2]);

      const closeQty = Quantity.of(new Decimal(50));
      const closePrice = OutcomePrice.of(new Decimal(0.75));

      // FIFO закроет дешевый лот первым
      const fifoResult = closeFIFO(position, closeQty, closePrice, CLOSE_AT);
      // LIFO закроет дорогой лот первым
      const lifoResult = closeLIFO(position, closeQty, closePrice, CLOSE_AT);

      expect(fifoResult.ok && lifoResult.ok).toBe(true);
      if (fifoResult.ok && lifoResult.ok) {
        const fifoPnL = fifoResult.value.realizedPnL.value().toNumber();
        const lifoPnL = lifoResult.value.realizedPnL.value().toNumber();

        // FIFO: (0.75 - 0.60) * 50 = 7.5
        expect(fifoPnL).toBe(7.5);

        // LIFO: (0.75 - 0.70) * 50 = 2.5
        expect(lifoPnL).toBe(2.5);

        // FIFO дает больший P&L в этом случае
        expect(fifoPnL).toBeGreaterThan(lifoPnL);
      }
    });
  });

  describe('calculateWeightedAveragePrice', () => {
    it('should calculate weighted average for equal quantities', () => {
      const lot1 = createLot(50, 0.60, 100);
      const lot2 = createLot(50, 0.70, 200);

      const avgPrice = calculateWeightedAveragePrice([lot1, lot2]);

      // (0.60 * 50 + 0.70 * 50) / 100 = 0.65
      expect(avgPrice.value().toNumber()).toBe(0.65);
    });

    it('should calculate weighted average for different quantities', () => {
      const lot1 = createLot(75, 0.60, 100);
      const lot2 = createLot(25, 0.80, 200);

      const avgPrice = calculateWeightedAveragePrice([lot1, lot2]);

      // (0.60 * 75 + 0.80 * 25) / 100 = 0.65
      expect(avgPrice.value().toNumber()).toBe(0.65);
    });

    it('should return minimum price for empty lots', () => {
      const avgPrice = calculateWeightedAveragePrice([]);
      expect(avgPrice).toBe(OutcomePrice.MIN);
    });

    it('should return minimum price when all lots have zero quantity (defensive guard)', () => {
      // PositionLot.create не валидирует quantity > 0 (это делает Position.create).
      // calculateWeightedAveragePrice имеет defensive guard для этого случая.
      const zeroLot = PositionLot.create({
        quantity: Quantity.ZERO,
        entryPrice: OutcomePrice.of(new Decimal(0.65)),
        timestamp: Timestamp.of(new Decimal(100)),
      });
      const avgPrice = calculateWeightedAveragePrice([zeroLot]);
      expect(avgPrice).toBe(OutcomePrice.MIN);
    });

    it('should return single lot price', () => {
      const lot = createLot(100, 0.65, 100);
      const avgPrice = calculateWeightedAveragePrice([lot]);

      expect(avgPrice.value().toNumber()).toBe(0.65);
    });

    it('should handle three lots', () => {
      const lot1 = createLot(50, 0.60, 100);
      const lot2 = createLot(30, 0.65, 200);
      const lot3 = createLot(20, 0.70, 300);

      const avgPrice = calculateWeightedAveragePrice([lot1, lot2, lot3]);

      // (0.60 * 50 + 0.65 * 30 + 0.70 * 20) / 100 = 0.635
      expect(avgPrice.value().toNumber()).toBeCloseTo(0.635, 4);
    });
  });

  describe('Edge Cases', () => {
    it('should handle very small quantities', () => {
      const lot = createLot(0.000001, 0.65, 100);
      const position = createPositionWithLots([lot]);

      const closeQty = Quantity.of(new Decimal(0.0000005));
      const closePrice = OutcomePrice.of(new Decimal(0.75));

      const result = closeFIFO(position, closeQty, closePrice, CLOSE_AT);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const { position: newPosition } = result.value;
        expect(newPosition.quantity.value().toNumber()).toBeCloseTo(0.0000005, 10);
      }
    });

    it('should handle negative P&L', () => {
      const lot = createLot(100, 0.75, 100);
      const position = createPositionWithLots([lot]);

      // Закрываем с убытком
      const closeQty = Quantity.of(new Decimal(50));
      const closePrice = OutcomePrice.of(new Decimal(0.65));

      const result = closeFIFO(position, closeQty, closePrice, CLOSE_AT);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const { realizedPnL } = result.value;
        // (0.65 - 0.75) * 50 = -5
        expect(realizedPnL.value().toNumber()).toBe(-5);
      }
    });

    it('should maintain immutability of original position', () => {
      const lot = createLot(100, 0.65, 100);
      const originalPosition = createPositionWithLots([lot]);
      const originalQuantity = originalPosition.quantity.value().toNumber();

      const closeQty = Quantity.of(new Decimal(50));
      const closePrice = OutcomePrice.of(new Decimal(0.75));

      closeFIFO(originalPosition, closeQty, closePrice, CLOSE_AT);

      // Оригинальная позиция не изменилась
      expect(originalPosition.quantity.value().toNumber()).toBe(originalQuantity);
      expect(originalPosition.lots.length).toBe(1);
    });
  });
});
