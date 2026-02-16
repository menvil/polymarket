import { describe, it, expect } from '@jest/globals';
import { addDecimal, multiplyDecimal } from '../../../src/decimal/index.js';
import Decimal from 'decimal.js';

/**
 * Тесты для документирования поведения математических свойств
 * при различных уровнях precision.
 *
 * Эти тесты НЕ требуют определённого поведения, а документируют его.
 * Они показывают:
 * - Коммутативность сохраняется всегда
 * - Ассоциативность и дистрибутивность обычно сохраняются при стандартной precision
 * - При очень низкой precision возможны минимальные погрешности
 *
 * Примечание: реальное нарушение этих свойств крайне редко на практике
 * с дефолтной precision = 20. Эти тесты используют искусственно низкую precision
 * для демонстрации теоретических ограничений.
 */
describe('математические свойства при ограниченной precision', () => {
  describe('ассоциативность сложения', () => {
    it('сохраняется при стандартной precision для обычных чисел', () => {
      const a = new Decimal('10.1234567890123456');
      const b = new Decimal('20.9876543210987654');
      const c = new Decimal('30.5555555555555555');

      const left = addDecimal(addDecimal(a, b), c);
      const right = addDecimal(a, addDecimal(b, c));

      expect(left.toString()).toBe(right.toString());
    });

    it('сохраняется даже при низкой precision для этих чисел', () => {
      // Сохраняем оригинальную precision
      const originalPrecision = Decimal.precision;

      try {
        // Устанавливаем очень низкую precision
        Decimal.set({ precision: 5 });

        const a = new Decimal('1.2345');
        const b = new Decimal('2.3456');
        const c = new Decimal('3.4567');

        const left = addDecimal(addDecimal(a, b), c);
        const right = addDecimal(a, addDecimal(b, c));

        // В данном примере ассоциативность сохраняется
        // Примечание: это не гарантия для всех чисел, а конкретный пример
        expect(left.equals(right)).toBe(true);
      } finally {
        // Восстанавливаем оригинальную precision
        Decimal.set({ precision: originalPrecision });
      }
    });
  });

  describe('дистрибутивность умножения относительно сложения', () => {
    it('сохраняется при стандартной precision для обычных чисел', () => {
      const a = new Decimal('2.5');
      const b = new Decimal('3.7');
      const c = new Decimal('4.2');

      // a * (b + c) = a * b + a * c
      const left = multiplyDecimal(a, addDecimal(b, c));
      const right = addDecimal(multiplyDecimal(a, b), multiplyDecimal(a, c));

      expect(left.toString()).toBe(right.toString());
    });

    it('сохраняется при низкой precision для этих чисел', () => {
      const originalPrecision = Decimal.precision;

      try {
        Decimal.set({ precision: 5 });

        const a = new Decimal('1.2345');
        const b = new Decimal('2.3456');
        const c = new Decimal('3.4567');

        const left = multiplyDecimal(a, addDecimal(b, c));
        const right = addDecimal(multiplyDecimal(a, b), multiplyDecimal(a, c));

        // В данном примере дистрибутивность сохраняется
        // Примечание: это не гарантия для всех чисел, а конкретный пример
        expect(left.equals(right)).toBe(true);
      } finally {
        Decimal.set({ precision: originalPrecision });
      }
    });

    it('демонстрирует небольшие различия при ограниченной precision', () => {
      const originalPrecision = Decimal.precision;

      try {
        // Устанавливаем precision = 10
        Decimal.set({ precision: 10 });

        const a = new Decimal('9.999999999');
        const b = new Decimal('1.111111111');
        const c = new Decimal('2.222222222');

        const left = multiplyDecimal(a, addDecimal(b, c));
        const right = addDecimal(multiplyDecimal(a, b), multiplyDecimal(a, c));

        // Разница обычно очень маленькая или нулевая
        const difference = left.minus(right).abs();

        // Документируем, что разница может существовать, но она минимальна
        expect(difference.lessThan(new Decimal('0.0001'))).toBe(true);

        // В большинстве случаев результаты идентичны даже при низкой precision
        // Этот тест показывает верхнюю границу возможной погрешности
      } finally {
        Decimal.set({ precision: originalPrecision });
      }
    });
  });

  describe('коммутативность', () => {
    it('всегда сохраняется для сложения', () => {
      const a = new Decimal('123456789.987654321');
      const b = new Decimal('987654321.123456789');

      const left = addDecimal(a, b);
      const right = addDecimal(b, a);

      expect(left.toString()).toBe(right.toString());
    });

    it('всегда сохраняется для умножения', () => {
      const a = new Decimal('123.456');
      const b = new Decimal('789.012');

      const left = multiplyDecimal(a, b);
      const right = multiplyDecimal(b, a);

      expect(left.toString()).toBe(right.toString());
    });

    it('сохраняется даже при низкой precision', () => {
      const originalPrecision = Decimal.precision;

      try {
        Decimal.set({ precision: 5 });

        const a = new Decimal('1.2345');
        const b = new Decimal('2.3456');

        const left = multiplyDecimal(a, b);
        const right = multiplyDecimal(b, a);

        // Коммутативность ВСЕГДА сохраняется
        expect(left.toString()).toBe(right.toString());
      } finally {
        Decimal.set({ precision: originalPrecision });
      }
    });
  });
});
