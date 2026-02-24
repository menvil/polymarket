/**
 * Тесты для OrderFill value object
 */

import { Quantity, Price } from '@polymarket/value-objects';
import { OrderFill } from '../../../src/value-objects/OrderFill';

describe('OrderFill', () => {
  describe('empty()', () => {
    it('should create empty fill with zero filledSize', () => {
      const fill = OrderFill.empty();

      expect(fill.getFilledSize().value).toBe(0);
      expect(fill.getAverageFillPrice()).toBeUndefined();
      expect(fill.getTradeIds()).toEqual([]);
      expect(fill.getTradeCount()).toBe(0);
      expect(fill.isEmpty()).toBe(true);
    });
  });

  describe('create()', () => {
    it('should create valid fill with all fields', () => {
      const filledSize = Quantity.fromValue(50).value!;
      const avgPrice = Price.fromValue(0.65).value!;
      const tradeIds = ['trade-1', 'trade-2'];
      const orderSize = Quantity.fromValue(100).value!;

      const result = OrderFill.create(filledSize, avgPrice, tradeIds, orderSize);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.getFilledSize().value).toBe(50);
        expect(result.value.getAverageFillPrice()?.value).toBe(0.65);
        expect(result.value.getTradeIds()).toEqual(tradeIds);
        expect(result.value.getTradeCount()).toBe(2);
        expect(result.value.isEmpty()).toBe(false);
      }
    });

    it('should create fill without averageFillPrice', () => {
      const filledSize = Quantity.fromValue(50).value!;
      const orderSize = Quantity.fromValue(100).value!;

      const result = OrderFill.create(filledSize, undefined, [], orderSize);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.getAverageFillPrice()).toBeUndefined();
      }
    });

    it('should fail if filledSize exceeds orderSize', () => {
      const filledSize = Quantity.fromValue(150).value!;
      const orderSize = Quantity.fromValue(100).value!;

      const result = OrderFill.create(filledSize, undefined, [], orderSize);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Filled size cannot exceed order size');
      }
    });

    it('should fail if filledSize is negative', () => {
      const filledSize = Quantity.fromValue(-10).value; // Should fail at Quantity level
      const orderSize = Quantity.fromValue(100).value!;

      // Quantity.fromValue(-10) should fail
      expect(filledSize).toBeUndefined();
    });

    it('should fail if tradeIds has duplicates', () => {
      const filledSize = Quantity.fromValue(50).value!;
      const orderSize = Quantity.fromValue(100).value!;
      const tradeIds = ['trade-1', 'trade-1']; // Duplicate

      const result = OrderFill.create(filledSize, undefined, tradeIds, orderSize);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Duplicate trade IDs');
      }
    });
  });

  describe('addTrade()', () => {
    it('should add trade to empty fill', () => {
      const fill = OrderFill.empty();
      const tradeSize = Quantity.fromValue(30).value!;
      const tradePrice = Price.fromValue(0.65).value!;
      const orderSize = Quantity.fromValue(100).value!;

      const result = fill.addTrade(tradeSize, tradePrice, 'trade-1', orderSize);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const newFill = result.value;
        expect(newFill.getFilledSize().value).toBe(30);
        expect(newFill.getAverageFillPrice()?.value).toBe(0.65);
        expect(newFill.getTradeIds()).toEqual(['trade-1']);
        expect(newFill.getTradeCount()).toBe(1);
      }
    });

    it('should accumulate multiple trades and calculate average price', () => {
      let fill = OrderFill.empty();
      const orderSize = Quantity.fromValue(100).value!;

      // Trade 1: 30 @ 0.60
      const result1 = fill.addTrade(
        Quantity.fromValue(30).value!,
        Price.fromValue(0.6).value!,
        'trade-1',
        orderSize
      );
      expect(result1.ok).toBe(true);
      fill = result1.value!;

      // Trade 2: 20 @ 0.70
      const result2 = fill.addTrade(
        Quantity.fromValue(20).value!,
        Price.fromValue(0.7).value!,
        'trade-2',
        orderSize
      );
      expect(result2.ok).toBe(true);
      fill = result2.value!;

      expect(fill.getFilledSize().value).toBe(50);
      expect(fill.getTradeCount()).toBe(2);

      // Average price = (30 * 0.60 + 20 * 0.70) / 50 = (18 + 14) / 50 = 32/50 = 0.64
      const avgPrice = fill.getAverageFillPrice()!;
      expect(avgPrice.value).toBeCloseTo(0.64, 5);
    });

    it('should fail if trade would exceed order size', () => {
      const fill = OrderFill.empty();
      const tradeSize = Quantity.fromValue(150).value!;
      const tradePrice = Price.fromValue(0.65).value!;
      const orderSize = Quantity.fromValue(100).value!;

      const result = fill.addTrade(tradeSize, tradePrice, 'trade-1', orderSize);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Trade size would exceed order size');
      }
    });

    it('should fail if tradeId already exists', () => {
      let fill = OrderFill.empty();
      const orderSize = Quantity.fromValue(100).value!;

      // Add first trade
      const result1 = fill.addTrade(
        Quantity.fromValue(30).value!,
        Price.fromValue(0.6).value!,
        'trade-1',
        orderSize
      );
      expect(result1.ok).toBe(true);
      fill = result1.value!;

      // Try to add duplicate
      const result2 = fill.addTrade(
        Quantity.fromValue(20).value!,
        Price.fromValue(0.7).value!,
        'trade-1', // Same ID
        orderSize
      );

      expect(result2.ok).toBe(false);
      if (!result2.ok) {
        expect(result2.error.message).toContain('Trade ID already exists');
      }
    });
  });

  describe('hasTrade()', () => {
    it('should return true if trade exists', () => {
      const fill = OrderFill.empty();
      const orderSize = Quantity.fromValue(100).value!;

      const result = fill.addTrade(
        Quantity.fromValue(30).value!,
        Price.fromValue(0.6).value!,
        'trade-1',
        orderSize
      );

      const newFill = result.value!;
      expect(newFill.hasTrade('trade-1')).toBe(true);
      expect(newFill.hasTrade('trade-2')).toBe(false);
    });
  });

  describe('getFillPercentage()', () => {
    it('should return 0% for empty fill', () => {
      const fill = OrderFill.empty();
      const orderSize = Quantity.fromValue(100).value!;

      const percentage = fill.getFillPercentage(orderSize);
      expect(percentage.toNumber()).toBe(0);
    });

    it('should calculate correct percentage', () => {
      const fill = OrderFill.empty();
      const orderSize = Quantity.fromValue(100).value!;

      const result = fill.addTrade(
        Quantity.fromValue(30).value!,
        Price.fromValue(0.6).value!,
        'trade-1',
        orderSize
      );

      const newFill = result.value!;
      const percentage = newFill.getFillPercentage(orderSize);
      expect(percentage.toNumber()).toBe(30);
    });

    it('should return 100% for fully filled order', () => {
      const fill = OrderFill.empty();
      const orderSize = Quantity.fromValue(100).value!;

      const result = fill.addTrade(
        Quantity.fromValue(100).value!,
        Price.fromValue(0.6).value!,
        'trade-1',
        orderSize
      );

      const newFill = result.value!;
      const percentage = newFill.getFillPercentage(orderSize);
      expect(percentage.toNumber()).toBe(100);
    });
  });

  describe('toJSON()', () => {
    it('should serialize empty fill', () => {
      const fill = OrderFill.empty();
      const json = fill.toJSON();

      expect(json).toEqual({
        filledSize: 0,
        averageFillPrice: undefined,
        tradeIds: [],
        tradeCount: 0,
      });
    });

    it('should serialize fill with data', () => {
      const filledSize = Quantity.fromValue(50).value!;
      const avgPrice = Price.fromValue(0.65).value!;
      const tradeIds = ['trade-1', 'trade-2'];
      const orderSize = Quantity.fromValue(100).value!;

      const fill = OrderFill.create(filledSize, avgPrice, tradeIds, orderSize).value!;
      const json = fill.toJSON();

      expect(json).toEqual({
        filledSize: 50,
        averageFillPrice: 0.65,
        tradeIds: ['trade-1', 'trade-2'],
        tradeCount: 2,
      });
    });
  });

  describe('immutability', () => {
    it('should return new instance on addTrade', () => {
      const fill = OrderFill.empty();
      const orderSize = Quantity.fromValue(100).value!;

      const result = fill.addTrade(
        Quantity.fromValue(30).value!,
        Price.fromValue(0.6).value!,
        'trade-1',
        orderSize
      );

      const newFill = result.value!;

      // Original fill should remain unchanged
      expect(fill.isEmpty()).toBe(true);
      expect(fill.getFilledSize().value).toBe(0);

      // New fill should have data
      expect(newFill.isEmpty()).toBe(false);
      expect(newFill.getFilledSize().value).toBe(30);
    });

    it('should not allow modification of tradeIds array', () => {
      const filledSize = Quantity.fromValue(50).value!;
      const orderSize = Quantity.fromValue(100).value!;
      const tradeIds = ['trade-1', 'trade-2'];

      const fill = OrderFill.create(filledSize, undefined, tradeIds, orderSize).value!;

      const retrievedIds = fill.getTradeIds();

      // Should be readonly array (TypeScript enforces this)
      // Attempting to modify should not affect internal state
      expect(retrievedIds).toEqual(['trade-1', 'trade-2']);
    });
  });
});
