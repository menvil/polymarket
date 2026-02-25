/**
 * @jest-environment node
 */

import { describe, it, expect } from '@jest/globals';
import { PositionLot } from '../../../src/core/PositionLot.js';
import { Quantity, Price, Timestamp, Fee } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

describe('PositionLot', () => {
  const createTestLot = () => {
    return PositionLot.create({
      quantity: Quantity.of(new Decimal(100)),
      entryPrice: Price.of(new Decimal(0.65)),
      timestamp: Timestamp.fromEpochMs(1705318200000),
      fee: Fee.of(new Decimal(0.5)),
    });
  };

  describe('create()', () => {
    it('создает PositionLot с валидными параметрами', () => {
      const lot = createTestLot();

      expect(lot.quantity.value).toBe(100);
      expect(lot.entryPrice.value).toBe(0.65);
      expect(lot.timestamp.toEpochMs()).toBe(1705318200000);
      expect(lot.fee?.value).toBe(0.5);
    });

    it('создает PositionLot без fee', () => {
      const lot = PositionLot.create({
        quantity: Quantity.of(new Decimal(100)),
        entryPrice: Price.of(new Decimal(0.65)),
        timestamp: Timestamp.fromEpochMs(1705318200000),
      });

      expect(lot.quantity.value).toBe(100);
      expect(lot.entryPrice.value).toBe(0.65);
      expect(lot.fee).toBeUndefined();
    });

    it('создает immutable объект', () => {
      const lot = createTestLot();

      expect(Object.isFrozen(lot)).toBe(true);
    });
  });

  describe('isEmpty()', () => {
    it('возвращает true для нулевого quantity', () => {
      const lot = PositionLot.create({
        quantity: Quantity.zero(),
        entryPrice: Price.of(new Decimal(0.65)),
        timestamp: Timestamp.now(),
      });

      expect(lot.isEmpty()).toBe(true);
    });

    it('возвращает false для ненулевого quantity', () => {
      const lot = createTestLot();

      expect(lot.isEmpty()).toBe(false);
    });
  });

  describe('withQuantity()', () => {
    it('создает новый лот с обновленным quantity', () => {
      const lot = createTestLot();
      const newQuantity = Quantity.of(new Decimal(60));

      const updatedLot = lot.withQuantity(newQuantity);

      expect(updatedLot.quantity.value).toBe(60);
      expect(updatedLot.entryPrice.value).toBe(0.65);
      expect(updatedLot.timestamp.toEpochMs()).toBe(lot.timestamp.toEpochMs());
      expect(updatedLot.fee?.value).toBe(0.5);
    });

    it('оставляет оригинал неизменным', () => {
      const lot = createTestLot();
      const originalQuantity = lot.quantity.value;

      lot.withQuantity(Quantity.of(new Decimal(60)));

      expect(lot.quantity.value).toBe(originalQuantity);
    });

    it('возвращает новый объект', () => {
      const lot = createTestLot();
      const updatedLot = lot.withQuantity(Quantity.of(new Decimal(60)));

      expect(updatedLot).not.toBe(lot);
    });
  });

  describe('withFee()', () => {
    it('создает новый лот с обновленным fee', () => {
      const lot = createTestLot();
      const newFee = Fee.of(new Decimal(1.0));

      const updatedLot = lot.withFee(newFee);

      expect(updatedLot.fee?.value).toBe(1.0);
      expect(updatedLot.quantity.value).toBe(100);
      expect(updatedLot.entryPrice.value).toBe(0.65);
    });

    it('оставляет оригинал неизменным', () => {
      const lot = createTestLot();
      const originalFee = lot.fee?.value;

      lot.withFee(Fee.of(new Decimal(1.0)));

      expect(lot.fee?.value).toBe(originalFee);
    });

    it('возвращает новый объект', () => {
      const lot = createTestLot();
      const updatedLot = lot.withFee(Fee.of(new Decimal(1.0)));

      expect(updatedLot).not.toBe(lot);
    });
  });

  describe('equals()', () => {
    it('возвращает true для лотов с одинаковыми параметрами', () => {
      const lot1 = PositionLot.create({
        quantity: Quantity.of(new Decimal(100)),
        entryPrice: Price.of(new Decimal(0.65)),
        timestamp: Timestamp.fromEpochMs(1705318200000),
      });

      const lot2 = PositionLot.create({
        quantity: Quantity.of(new Decimal(100)),
        entryPrice: Price.of(new Decimal(0.65)),
        timestamp: Timestamp.fromEpochMs(1705318200000),
      });

      expect(lot1.equals(lot2)).toBe(true);
    });

    it('возвращает false для лотов с разным quantity', () => {
      const lot1 = createTestLot();
      const lot2 = lot1.withQuantity(Quantity.of(new Decimal(50)));

      expect(lot1.equals(lot2)).toBe(false);
    });

    it('возвращает false для лотов с разным entryPrice', () => {
      const lot1 = createTestLot();
      const lot2 = PositionLot.create({
        quantity: lot1.quantity,
        entryPrice: Price.of(new Decimal(0.70)),
        timestamp: lot1.timestamp,
      });

      expect(lot1.equals(lot2)).toBe(false);
    });

    it('возвращает false для лотов с разным timestamp', () => {
      const lot1 = createTestLot();
      const lot2 = PositionLot.create({
        quantity: lot1.quantity,
        entryPrice: lot1.entryPrice,
        timestamp: Timestamp.fromEpochMs(1705318300000),
      });

      expect(lot1.equals(lot2)).toBe(false);
    });

    it('не учитывает fee при сравнении', () => {
      const lot1 = PositionLot.create({
        quantity: Quantity.of(new Decimal(100)),
        entryPrice: Price.of(new Decimal(0.65)),
        timestamp: Timestamp.fromEpochMs(1705318200000),
        fee: Fee.of(new Decimal(0.5)),
      });

      const lot2 = PositionLot.create({
        quantity: Quantity.of(new Decimal(100)),
        entryPrice: Price.of(new Decimal(0.65)),
        timestamp: Timestamp.fromEpochMs(1705318200000),
        fee: Fee.of(new Decimal(1.0)),
      });

      expect(lot1.equals(lot2)).toBe(true);
    });
  });

  describe('getNotional()', () => {
    it('вычисляет notional value (quantity * entryPrice)', () => {
      const lot = PositionLot.create({
        quantity: Quantity.of(new Decimal(100)),
        entryPrice: Price.of(new Decimal(0.65)),
        timestamp: Timestamp.now(),
      });

      const notional = lot.getNotional();

      expect(notional).toBe(65.0); // 100 * 0.65
    });

    it('вычисляет notional для дробных значений', () => {
      const lot = PositionLot.create({
        quantity: Quantity.of(new Decimal(75.5)),
        entryPrice: Price.of(new Decimal(0.48)),
        timestamp: Timestamp.now(),
      });

      const notional = lot.getNotional();

      expect(notional).toBeCloseTo(36.24, 2); // 75.5 * 0.48
    });

    it('возвращает 0 для пустого лота', () => {
      const lot = PositionLot.create({
        quantity: Quantity.zero(),
        entryPrice: Price.of(new Decimal(0.65)),
        timestamp: Timestamp.now(),
      });

      const notional = lot.getNotional();

      expect(notional).toBe(0);
    });
  });

  describe('toString()', () => {
    it('возвращает строковое представление', () => {
      const lot = PositionLot.create({
        quantity: Quantity.of(new Decimal(100)),
        entryPrice: Price.of(new Decimal(0.65)),
        timestamp: Timestamp.fromEpochMs(1705318200000),
      });

      const str = lot.toString();

      expect(str).toContain('100.00');
      expect(str).toContain('0.6500');
      expect(str).toContain('2024-01-15');
    });

    it('форматирует quantity с 2 знаками', () => {
      const lot = PositionLot.create({
        quantity: Quantity.of(new Decimal(123.456)),
        entryPrice: Price.of(new Decimal(0.65)),
        timestamp: Timestamp.now(),
      });

      const str = lot.toString();

      expect(str).toContain('123.46');
    });

    it('форматирует price с 4 знаками', () => {
      const lot = PositionLot.create({
        quantity: Quantity.of(new Decimal(100)),
        entryPrice: Price.of(new Decimal(0.654321)),
        timestamp: Timestamp.now(),
      });

      const str = lot.toString();

      expect(str).toContain('0.6543');
    });
  });

  describe('toObject()', () => {
    it('конвертирует в plain object', () => {
      const lot = createTestLot();

      const obj = lot.toObject();

      expect(obj).toEqual({
        quantity: 100,
        entryPrice: 0.65,
        timestamp: 1705318200000,
        fee: 0.5,
      });
    });

    it('работает без fee', () => {
      const lot = PositionLot.create({
        quantity: Quantity.of(new Decimal(100)),
        entryPrice: Price.of(new Decimal(0.65)),
        timestamp: Timestamp.fromEpochMs(1705318200000),
      });

      const obj = lot.toObject();

      expect(obj).toEqual({
        quantity: 100,
        entryPrice: 0.65,
        timestamp: 1705318200000,
        fee: undefined,
      });
    });

    it('возвращает primitive типы', () => {
      const lot = createTestLot();

      const obj = lot.toObject();

      expect(typeof obj.quantity).toBe('number');
      expect(typeof obj.entryPrice).toBe('number');
      expect(typeof obj.timestamp).toBe('number');
      expect(typeof obj.fee).toBe('number');
    });
  });

  describe('immutability', () => {
    it('не позволяет модифицировать свойства напрямую', () => {
      const lot = createTestLot();

      expect(() => {
        // @ts-expect-error - testing immutability
        lot.quantity = Quantity.of(new Decimal(50));
      }).toThrow();
    });

    it('объект заморожен', () => {
      const lot = createTestLot();

      expect(Object.isFrozen(lot)).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('работает с очень маленьким quantity', () => {
      const lot = PositionLot.create({
        quantity: Quantity.of(new Decimal(0.00001)),
        entryPrice: Price.of(new Decimal(0.65)),
        timestamp: Timestamp.now(),
      });

      expect(lot.quantity.value).toBe(0.00001);
      expect(lot.isEmpty()).toBe(false);
    });

    it('работает с очень большим quantity', () => {
      const lot = PositionLot.create({
        quantity: Quantity.of(new Decimal(1000000)),
        entryPrice: Price.of(new Decimal(0.65)),
        timestamp: Timestamp.now(),
      });

      expect(lot.quantity.value).toBe(1000000);
      expect(lot.getNotional()).toBe(650000);
    });

    it('работает с price = 0', () => {
      const lot = PositionLot.create({
        quantity: Quantity.of(new Decimal(100)),
        entryPrice: Price.of(new Decimal(0)),
        timestamp: Timestamp.now(),
      });

      expect(lot.entryPrice.value).toBe(0);
      expect(lot.getNotional()).toBe(0);
    });
  });
});
