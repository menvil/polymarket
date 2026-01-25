/**
 * Общие тесты для value objects
 *
 * @remarks
 * Набор переиспользуемых тестов для проверки основных свойств value objects:
 * - Immutability (неизменяемость)
 * - Value equality (равенство по значению)
 * - Validation (валидация при создании)
 */

import { describe, it, expect } from '@jest/globals';

/**
 * Проверка неизменяемости value object
 *
 * @param createValueObject - Функция создания value object
 * @param mutationAttempt - Функция, пытающаяся изменить объект
 */
export function testImmutability<T>(
  name: string,
  createValueObject: () => T,
  mutationAttempt: (obj: T) => void
): void {
  describe(`${name} - Immutability`, () => {
    it('should be immutable', () => {
      const obj = createValueObject();
      expect(() => mutationAttempt(obj)).toThrow();
    });
  });
}

/**
 * Проверка равенства по значению
 *
 * @param name - Имя value object
 * @param createEqual - Функция создания двух равных объектов
 * @param createDifferent - Функция создания двух разных объектов
 * @param equalsMethod - Метод проверки равенства
 */
export function testValueEquality<T>(
  name: string,
  createEqual: () => [T, T],
  createDifferent: () => [T, T],
  equalsMethod: (a: T, b: T) => boolean
): void {
  describe(`${name} - Value Equality`, () => {
    it('should be equal when values are equal', () => {
      const [obj1, obj2] = createEqual();
      expect(equalsMethod(obj1, obj2)).toBe(true);
    });

    it('should not be equal when values are different', () => {
      const [obj1, obj2] = createDifferent();
      expect(equalsMethod(obj1, obj2)).toBe(false);
    });

    it('should be reflexive (equals itself)', () => {
      const [obj] = createEqual();
      expect(equalsMethod(obj, obj)).toBe(true);
    });
  });
}