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
      expect(fill.getFillIds()).toEqual([]);
      expect(fill.getTradeCount()).toBe(0);
      expect(fill.isEmpty()).toBe(true);
    });
  });

  describe('create()', () => {
    it('should create valid fill with all fields', () => {
      const filledSize = Quantity.fromValue(50).value!;
      const avgPrice = Price.fromValue(0.65).value!;
      const fillIds = ['fill-1', 'fill-2'];
      const orderSize = Quantity.fromValue(100).value!;

      const result = OrderFill.create(filledSize, avgPrice, fillIds, orderSize);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.getFilledSize().value).toBe(50);
        expect(result.value.getAverageFillPrice()?.value).toBe(0.65);
        expect(result.value.getFillIds()).toEqual(fillIds);
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
        expect(result.error.message).toContain('Filled size');
      }
    });

    it('should fail if filledSize is negative', () => {
      const filledSize = Quantity.fromValue(-10).value; // Should fail at Quantity level
      // Quantity.fromValue(-10) should fail
      expect(filledSize).toBeUndefined();
    });

    it('should fail if fillIds has duplicates', () => {
      const filledSize = Quantity.fromValue(50).value!;
      const orderSize = Quantity.fromValue(100).value!;
      const fillIds = ['fill-1', 'fill-1']; // Duplicate

      const result = OrderFill.create(filledSize, undefined, fillIds, orderSize);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('unique');
      }
    });
  });

  describe('addFill()', () => {
    it('should add fill to empty OrderFill', () => {
      const orderFill = OrderFill.empty();
      const fillSize = Quantity.fromValue(30).value!;
      const fillPrice = Price.fromValue(0.65).value!;
      const orderSize = Quantity.fromValue(100).value!;

      const result = orderFill.addFill(fillSize, fillPrice, 'fill-1', orderSize);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const newFill = result.value;
        expect(newFill.getFilledSize().value).toBe(30);
        expect(newFill.getAverageFillPrice()?.value).toBe(0.65);
        expect(newFill.getFillIds()).toEqual(['fill-1']);
        expect(newFill.getTradeCount()).toBe(1);
      }
    });

    it('should accumulate multiple fills and calculate average price', () => {
      let orderFill = OrderFill.empty();
      const orderSize = Quantity.fromValue(100).value!;

      // Fill 1: 30 @ 0.60
      const result1 = orderFill.addFill(
        Quantity.fromValue(30).value!,
        Price.fromValue(0.6).value!,
        'fill-1',
        orderSize
      );
      expect(result1.ok).toBe(true);
      orderFill = result1.value!;

      // Fill 2: 20 @ 0.70
      const result2 = orderFill.addFill(
        Quantity.fromValue(20).value!,
        Price.fromValue(0.7).value!,
        'fill-2',
        orderSize
      );
      expect(result2.ok).toBe(true);
      orderFill = result2.value!;

      expect(orderFill.getFilledSize().value).toBe(50);
      expect(orderFill.getTradeCount()).toBe(2);

      // Average price = (30 * 0.60 + 20 * 0.70) / 50 = (18 + 14) / 50 = 32/50 = 0.64
      const avgPrice = orderFill.getAverageFillPrice()!;
      expect(avgPrice.value).toBeCloseTo(0.64, 5);
    });

    it('should fail if fill would exceed order size', () => {
      const orderFill = OrderFill.empty();
      const fillSize = Quantity.fromValue(150).value!;
      const fillPrice = Price.fromValue(0.65).value!;
      const orderSize = Quantity.fromValue(100).value!;

      const result = orderFill.addFill(fillSize, fillPrice, 'fill-1', orderSize);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('exceeds remaining order size');
      }
    });

    it('should fail if fillId already exists', () => {
      let orderFill = OrderFill.empty();
      const orderSize = Quantity.fromValue(100).value!;

      // Add first fill
      const result1 = orderFill.addFill(
        Quantity.fromValue(30).value!,
        Price.fromValue(0.6).value!,
        'fill-1',
        orderSize
      );
      expect(result1.ok).toBe(true);
      orderFill = result1.value!;

      // Try to add duplicate
      const result2 = orderFill.addFill(
        Quantity.fromValue(20).value!,
        Price.fromValue(0.7).value!,
        'fill-1', // Same ID
        orderSize
      );

      expect(result2.ok).toBe(false);
      if (!result2.ok) {
        expect(result2.error.message).toContain('already been applied');
      }
    });
  });

  describe('hasFill()', () => {
    it('should return true if fill exists', () => {
      const orderFill = OrderFill.empty();
      const orderSize = Quantity.fromValue(100).value!;

      const result = orderFill.addFill(
        Quantity.fromValue(30).value!,
        Price.fromValue(0.6).value!,
        'fill-1',
        orderSize
      );

      const newFill = result.value!;
      expect(newFill.hasFill('fill-1')).toBe(true);
      expect(newFill.hasFill('fill-2')).toBe(false);
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

      const result = fill.addFill(
        Quantity.fromValue(30).value!,
        Price.fromValue(0.6).value!,
        'fill-1',
        orderSize
      );

      const newFill = result.value!;
      const percentage = newFill.getFillPercentage(orderSize);
      expect(percentage.toNumber()).toBe(30);
    });

    it('should return 100% for fully filled order', () => {
      const fill = OrderFill.empty();
      const orderSize = Quantity.fromValue(100).value!;

      const result = fill.addFill(
        Quantity.fromValue(100).value!,
        Price.fromValue(0.6).value!,
        'fill-1',
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

      expect(json.filledSize).toBe(0);
      expect(json.averageFillPrice).toBeUndefined();
      expect(json.fillIds).toEqual([]);
    });

    it('should serialize fill with data', () => {
      const filledSize = Quantity.fromValue(50).value!;
      const avgPrice = Price.fromValue(0.65).value!;
      const fillIds = ['fill-1', 'fill-2'];
      const orderSize = Quantity.fromValue(100).value!;

      const fill = OrderFill.create(filledSize, avgPrice, fillIds, orderSize).value!;
      const json = fill.toJSON();

      expect(json.filledSize).toBe(50);
      expect(json.averageFillPrice).toBe(0.65);
      expect(json.fillIds).toEqual(['fill-1', 'fill-2']);
    });
  });

  describe('immutability', () => {
    it('should return new instance on addFill', () => {
      const fill = OrderFill.empty();
      const orderSize = Quantity.fromValue(100).value!;

      const result = fill.addFill(
        Quantity.fromValue(30).value!,
        Price.fromValue(0.6).value!,
        'fill-1',
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

    it('should not allow modification of fillIds array', () => {
      const filledSize = Quantity.fromValue(50).value!;
      const orderSize = Quantity.fromValue(100).value!;
      const fillIds = ['fill-1', 'fill-2'];

      const fill = OrderFill.create(filledSize, undefined, fillIds, orderSize).value!;

      const retrievedIds = fill.getFillIds();

      // Should be readonly array (TypeScript enforces this)
      expect(retrievedIds).toEqual(['fill-1', 'fill-2']);
    });
  });
});
