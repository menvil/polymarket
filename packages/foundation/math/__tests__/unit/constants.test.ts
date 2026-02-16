/**
 * Тесты для Math Constants
 */

import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { MATH_CONSTANTS } from '../../src/constants.js';

describe('MATH_CONSTANTS', () => {
  describe('values', () => {
    it('ZERO должен быть Decimal(0)', () => {
      expect(MATH_CONSTANTS.ZERO).toBeInstanceOf(Decimal);
      expect(MATH_CONSTANTS.ZERO.toString()).toBe('0');
    });

    it('ONE должен быть Decimal(1)', () => {
      expect(MATH_CONSTANTS.ONE).toBeInstanceOf(Decimal);
      expect(MATH_CONSTANTS.ONE.toString()).toBe('1');
    });

    it('TWO должен быть Decimal(2)', () => {
      expect(MATH_CONSTANTS.TWO).toBeInstanceOf(Decimal);
      expect(MATH_CONSTANTS.TWO.toString()).toBe('2');
    });

    it('TEN должен быть Decimal(10)', () => {
      expect(MATH_CONSTANTS.TEN).toBeInstanceOf(Decimal);
      expect(MATH_CONSTANTS.TEN.toString()).toBe('10');
    });

    it('HUNDRED должен быть Decimal(100)', () => {
      expect(MATH_CONSTANTS.HUNDRED).toBeInstanceOf(Decimal);
      expect(MATH_CONSTANTS.HUNDRED.toString()).toBe('100');
    });
  });

  describe('immutability', () => {
    it('объект должен быть frozen', () => {
      expect(Object.isFrozen(MATH_CONSTANTS)).toBe(true);
    });

    it('должен защищать от runtime-перезаписи свойств (strict mode throws)', () => {
      const originalZero = MATH_CONSTANTS.ZERO;

      // В strict mode попытка перезаписи frozen объекта бросает TypeError
      expect(() => {
        // @ts-expect-error - intentionally testing runtime protection
        MATH_CONSTANTS.ZERO = new Decimal(999);
      }).toThrow(TypeError);

      // Значение не изменилось
      expect(MATH_CONSTANTS.ZERO).toBe(originalZero);
      expect(MATH_CONSTANTS.ZERO.toString()).toBe('0');
    });

    it('должен защищать от добавления новых свойств (strict mode throws)', () => {
      const keys = Object.keys(MATH_CONSTANTS);

      // В strict mode попытка добавить свойство к frozen объекту бросает TypeError
      expect(() => {
        // @ts-expect-error - intentionally testing runtime protection
        MATH_CONSTANTS.NEW_PROP = new Decimal(42);
      }).toThrow(TypeError);

      // Свойство не было добавлено
      expect(Object.keys(MATH_CONSTANTS)).toEqual(keys);
    });

    it('должен защищать от удаления свойств (strict mode throws)', () => {
      const keys = Object.keys(MATH_CONSTANTS);

      // В strict mode попытка удалить свойство frozen объекта бросает TypeError
      expect(() => {
        // @ts-expect-error - intentionally testing runtime protection
        delete MATH_CONSTANTS.ZERO;
      }).toThrow(TypeError);

      // Свойство осталось
      expect(Object.keys(MATH_CONSTANTS)).toEqual(keys);
      expect(MATH_CONSTANTS.ZERO).toBeDefined();
      expect(MATH_CONSTANTS.ZERO.toString()).toBe('0');
    });
  });
});
