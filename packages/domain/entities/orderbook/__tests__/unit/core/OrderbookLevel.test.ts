/**
 * @jest-environment node
 */

import { describe, it, expect } from '@jest/globals';
import { OrderbookLevel } from '../../../src/core/OrderbookLevel.js';
import { Price, Quantity } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

describe('OrderbookLevel', () => {
  describe('create()', () => {
    it('создаёт level с валидными price и quantity', () => {
      const price = Price.of(new Decimal(0.52));
      const quantity = Quantity.of(new Decimal(100));

      const level = OrderbookLevel.create(price, quantity);

      expect(level.price).toBe(price);
      expect(level.quantity).toBe(quantity);
    });

    it('возвращает frozen объект', () => {
      const price = Price.of(new Decimal(0.52));
      const quantity = Quantity.of(new Decimal(100));

      const level = OrderbookLevel.create(price, quantity);

      expect(Object.isFrozen(level)).toBe(true);
    });

    it('создаёт level с нулевым quantity', () => {
      const price = Price.of(new Decimal(0.52));
      const quantity = Quantity.zero();

      const level = OrderbookLevel.create(price, quantity);

      expect(level.quantity.isZero()).toBe(true);
    });
  });

  describe('isEmpty()', () => {
    it('возвращает true для нулевого quantity', () => {
      const price = Price.of(new Decimal(0.52));
      const quantity = Quantity.zero();
      const level = OrderbookLevel.create(price, quantity);

      expect(level.isEmpty()).toBe(true);
    });

    it('возвращает false для ненулевого quantity', () => {
      const price = Price.of(new Decimal(0.52));
      const quantity = Quantity.of(new Decimal(100));
      const level = OrderbookLevel.create(price, quantity);

      expect(level.isEmpty()).toBe(false);
    });
  });

  describe('withQuantity()', () => {
    it('возвращает новый level с обновлённым quantity', () => {
      const price = Price.of(new Decimal(0.52));
      const quantity = Quantity.of(new Decimal(100));
      const level = OrderbookLevel.create(price, quantity);

      const newQuantity = Quantity.of(new Decimal(200));
      const updated = level.withQuantity(newQuantity);

      expect(updated.quantity).toBe(newQuantity);
      expect(updated.price).toBe(price);
      expect(level.quantity).toBe(quantity); // оригинал не изменился
    });

    it('сохраняет immutability', () => {
      const price = Price.of(new Decimal(0.52));
      const quantity = Quantity.of(new Decimal(100));
      const level = OrderbookLevel.create(price, quantity);

      const newQuantity = Quantity.of(new Decimal(200));
      const updated = level.withQuantity(newQuantity);

      expect(level).not.toBe(updated);
      expect(Object.isFrozen(updated)).toBe(true);
    });
  });

  describe('equals()', () => {
    it('возвращает true для одинаковых levels', () => {
      const price = Price.of(new Decimal(0.52));
      const quantity = Quantity.of(new Decimal(100));
      const level1 = OrderbookLevel.create(price, quantity);
      const level2 = OrderbookLevel.create(price, quantity);

      expect(level1.equals(level2)).toBe(true);
    });

    it('возвращает false для разных price', () => {
      const price1 = Price.of(new Decimal(0.52));
      const price2 = Price.of(new Decimal(0.53));
      const quantity = Quantity.of(new Decimal(100));
      const level1 = OrderbookLevel.create(price1, quantity);
      const level2 = OrderbookLevel.create(price2, quantity);

      expect(level1.equals(level2)).toBe(false);
    });

    it('возвращает false для разных quantity', () => {
      const price = Price.of(new Decimal(0.52));
      const quantity1 = Quantity.of(new Decimal(100));
      const quantity2 = Quantity.of(new Decimal(200));
      const level1 = OrderbookLevel.create(price, quantity1);
      const level2 = OrderbookLevel.create(price, quantity2);

      expect(level1.equals(level2)).toBe(false);
    });
  });

  describe('toString()', () => {
    it('возвращает строковое представление', () => {
      const price = Price.of(new Decimal(0.52));
      const quantity = Quantity.of(new Decimal(100));
      const level = OrderbookLevel.create(price, quantity);

      const str = level.toString();

      expect(str).toContain('0.5200');
      expect(str).toContain('100.00');
      expect(str).toContain('@');
    });
  });

  describe('toObject()', () => {
    it('возвращает объектное представление', () => {
      const price = Price.of(new Decimal(0.52));
      const quantity = Quantity.of(new Decimal(100));
      const level = OrderbookLevel.create(price, quantity);

      const obj = level.toObject();

      expect(obj.price).toBe(0.52);
      expect(obj.quantity).toBe(100);
    });

    it('возвращает сериализуемый объект', () => {
      const price = Price.of(new Decimal(0.52));
      const quantity = Quantity.of(new Decimal(100));
      const level = OrderbookLevel.create(price, quantity);

      const obj = level.toObject();
      const json = JSON.stringify(obj);
      const parsed = JSON.parse(json);

      expect(parsed.price).toBe(0.52);
      expect(parsed.quantity).toBe(100);
    });
  });
});
