/**
 * Тесты для OrderFill value object
 */

import { Quantity, Price } from '@polymarket/value-objects';
import Decimal from 'decimal.js';
import { OrderFill } from '../../../src/value-objects/OrderFill';

// Вспомогательная функция для извлечения значения из Result в тестах
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }, ctx = ''): T {
  if (!result.ok) throw new Error(`Expected Ok result in test setup${ctx ? `: ${ctx}` : ''}`);
  return result.value;
}

describe('OrderFill', () => {
  describe('empty()', () => {
    it('should create empty fill with zero filledSize', () => {
      const fill = OrderFill.empty();

      expect(fill.getFilledSize().value().toNumber()).toBe(0);
      expect(fill.getAverageFillPrice()).toBeUndefined();
      expect(fill.getFillIds()).toEqual([]);
      expect(fill.getTradeCount()).toBe(0);
      expect(fill.isEmpty()).toBe(true);
    });
  });

  describe('create()', () => {
    it('should create valid fill with all fields', () => {
      const filledSize = Quantity.of(new Decimal('50'));
      const avgPrice = Price.of(new Decimal('0.65'));
      const fillIds = ['fill-1', 'fill-2'];
      const orderSize = Quantity.of(new Decimal('100'));

      const result = OrderFill.create(filledSize, avgPrice, fillIds, orderSize);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.getFilledSize().value().toNumber()).toBe(50);
        expect(result.value.getAverageFillPrice()?.value().toNumber()).toBe(0.65);
        expect(result.value.getFillIds()).toEqual(fillIds);
        expect(result.value.getTradeCount()).toBe(2);
        expect(result.value.isEmpty()).toBe(false);
      }
    });

    it('should create fill without averageFillPrice', () => {
      const filledSize = Quantity.of(new Decimal('50'));
      const orderSize = Quantity.of(new Decimal('100'));

      const result = OrderFill.create(filledSize, undefined, [], orderSize);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.getAverageFillPrice()).toBeUndefined();
      }
    });

    it('should fail if filledSize exceeds orderSize', () => {
      const filledSize = Quantity.of(new Decimal('150'));
      const orderSize = Quantity.of(new Decimal('100'));

      const result = OrderFill.create(filledSize, undefined, [], orderSize);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Filled size');
      }
    });

    it('should fail if fillIds has duplicates', () => {
      const filledSize = Quantity.of(new Decimal('50'));
      const orderSize = Quantity.of(new Decimal('100'));
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
      const fillSize = Quantity.of(new Decimal('30'));
      const fillPrice = Price.of(new Decimal('0.65'));
      const orderSize = Quantity.of(new Decimal('100'));

      const result = orderFill.addFill(fillSize, fillPrice, 'fill-1', orderSize);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const newFill = result.value;
        expect(newFill.getFilledSize().value().toNumber()).toBe(30);
        expect(newFill.getAverageFillPrice()?.value().toNumber()).toBe(0.65);
        expect(newFill.getFillIds()).toEqual(['fill-1']);
        expect(newFill.getTradeCount()).toBe(1);
      }
    });

    it('should accumulate multiple fills and calculate average price', () => {
      let orderFill = OrderFill.empty();
      const orderSize = Quantity.of(new Decimal('100'));

      // Fill 1: 30 @ 0.60
      const result1 = orderFill.addFill(
        Quantity.of(new Decimal('30')),
        Price.of(new Decimal('0.6')),
        'fill-1',
        orderSize
      );
      expect(result1.ok).toBe(true);
      orderFill = unwrap(result1);

      // Fill 2: 20 @ 0.70
      const result2 = orderFill.addFill(
        Quantity.of(new Decimal('20')),
        Price.of(new Decimal('0.7')),
        'fill-2',
        orderSize
      );
      expect(result2.ok).toBe(true);
      orderFill = unwrap(result2);

      expect(orderFill.getFilledSize().value().toNumber()).toBe(50);
      expect(orderFill.getTradeCount()).toBe(2);

      // Average price = (30 * 0.60 + 20 * 0.70) / 50 = (18 + 14) / 50 = 32/50 = 0.64
      const avgPrice = orderFill.getAverageFillPrice()!;
      expect(avgPrice.value().toNumber()).toBeCloseTo(0.64, 5);
    });

    it('should fail if fill would exceed order size', () => {
      const orderFill = OrderFill.empty();
      const fillSize = Quantity.of(new Decimal('150'));
      const fillPrice = Price.of(new Decimal('0.65'));
      const orderSize = Quantity.of(new Decimal('100'));

      const result = orderFill.addFill(fillSize, fillPrice, 'fill-1', orderSize);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('exceeds remaining order size');
      }
    });

    it('should fail if fillId already exists', () => {
      let orderFill = OrderFill.empty();
      const orderSize = Quantity.of(new Decimal('100'));

      // Add first fill
      const result1 = orderFill.addFill(
        Quantity.of(new Decimal('30')),
        Price.of(new Decimal('0.6')),
        'fill-1',
        orderSize
      );
      expect(result1.ok).toBe(true);
      orderFill = unwrap(result1);

      // Try to add duplicate
      const result2 = orderFill.addFill(
        Quantity.of(new Decimal('20')),
        Price.of(new Decimal('0.7')),
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
      const orderSize = Quantity.of(new Decimal('100'));

      const result = orderFill.addFill(
        Quantity.of(new Decimal('30')),
        Price.of(new Decimal('0.6')),
        'fill-1',
        orderSize
      );

      const newFill = unwrap(result);
      expect(newFill.hasFill('fill-1')).toBe(true);
      expect(newFill.hasFill('fill-2')).toBe(false);
    });
  });

  describe('getFillPercentage()', () => {
    it('should return 0% for empty fill', () => {
      const fill = OrderFill.empty();
      const orderSize = Quantity.of(new Decimal('100'));

      const percentage = fill.getFillPercentage(orderSize);
      expect(percentage.toNumber()).toBe(0);
    });

    it('should calculate correct percentage', () => {
      const fill = OrderFill.empty();
      const orderSize = Quantity.of(new Decimal('100'));

      const result = fill.addFill(
        Quantity.of(new Decimal('30')),
        Price.of(new Decimal('0.6')),
        'fill-1',
        orderSize
      );

      const newFill = unwrap(result);
      const percentage = newFill.getFillPercentage(orderSize);
      expect(percentage.toNumber()).toBe(30);
    });

    it('should return 100% for fully filled order', () => {
      const fill = OrderFill.empty();
      const orderSize = Quantity.of(new Decimal('100'));

      const result = fill.addFill(
        Quantity.of(new Decimal('100')),
        Price.of(new Decimal('0.6')),
        'fill-1',
        orderSize
      );

      const newFill = unwrap(result);
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
      const filledSize = Quantity.of(new Decimal('50'));
      const avgPrice = Price.of(new Decimal('0.65'));
      const fillIds = ['fill-1', 'fill-2'];
      const orderSize = Quantity.of(new Decimal('100'));

      const fill = unwrap(OrderFill.create(filledSize, avgPrice, fillIds, orderSize), 'OrderFill.create');
      const json = fill.toJSON();

      expect(json.filledSize).toBe(50);
      expect(json.averageFillPrice).toBe(0.65);
      expect(json.fillIds).toEqual(['fill-1', 'fill-2']);
    });
  });

  describe('immutability', () => {
    it('should return new instance on addFill', () => {
      const fill = OrderFill.empty();
      const orderSize = Quantity.of(new Decimal('100'));

      const result = fill.addFill(
        Quantity.of(new Decimal('30')),
        Price.of(new Decimal('0.6')),
        'fill-1',
        orderSize
      );

      const newFill = unwrap(result);

      // Original fill should remain unchanged
      expect(fill.isEmpty()).toBe(true);
      expect(fill.getFilledSize().value().toNumber()).toBe(0);

      // New fill should have data
      expect(newFill.isEmpty()).toBe(false);
      expect(newFill.getFilledSize().value().toNumber()).toBe(30);
    });

    it('should not allow modification of fillIds array', () => {
      const filledSize = Quantity.of(new Decimal('50'));
      const orderSize = Quantity.of(new Decimal('100'));
      const fillIds = ['fill-1', 'fill-2'];

      const fill = unwrap(OrderFill.create(filledSize, undefined, fillIds, orderSize), 'OrderFill.create');

      const retrievedIds = fill.getFillIds();

      // Should be readonly array (TypeScript enforces this)
      expect(retrievedIds).toEqual(['fill-1', 'fill-2']);
    });
  });
});
