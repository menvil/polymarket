import { describe, it, expect } from '@jest/globals';
import {
  equalsDecimal,
  lessThanDecimal,
  lessThanOrEqualDecimal,
  greaterThanDecimal,
  greaterThanOrEqualDecimal,
  compareDecimal,
} from '../../../src/decimal/compare.js';
import { InvalidOperandError } from '@polymarket/errors';
import Decimal from 'decimal.js';

describe('compare', () => {
  describe('equalsDecimal', () => {
    it('должен возвращать true для строго одинаковых чисел', () => {
      expect(equalsDecimal(new Decimal(10), new Decimal(10))).toBe(true);
    });

    it('должен возвращать true для одинаковых чисел с разным форматом', () => {
      expect(equalsDecimal(new Decimal('10.0'), new Decimal('10'))).toBe(true);
      expect(equalsDecimal(new Decimal('10'), new Decimal('10.00'))).toBe(true);
    });

    it('должен возвращать false для чисел с минимальной разницей (strict)', () => {
      const a = new Decimal(10);
      const b = new Decimal('10.0000000001');
      expect(equalsDecimal(a, b)).toBe(false); // Строго неравны!
    });

    it('должен возвращать false для разных чисел', () => {
      expect(equalsDecimal(new Decimal(10), new Decimal(11))).toBe(false);
    });

    it('должен работать с отрицательными числами', () => {
      expect(equalsDecimal(new Decimal(-10), new Decimal(-10))).toBe(true);
      expect(equalsDecimal(new Decimal(-10), new Decimal(-10.01))).toBe(false);
    });

    it('должен возвращать true для нуля', () => {
      expect(equalsDecimal(new Decimal(0), new Decimal(0))).toBe(true);
      expect(equalsDecimal(new Decimal('0'), new Decimal('0.0'))).toBe(true);
    });

    it('должен быть согласован с compareDecimal', () => {
      const a = new Decimal('10.5');
      const b = new Decimal('10.5');
      const c = new Decimal('10.50000001');

      // equals true => compare === 0
      expect(equalsDecimal(a, b)).toBe(true);
      expect(compareDecimal(a, b)).toBe(0);

      // equals false => compare должен быть -1 или 1
      expect(equalsDecimal(a, c)).toBe(false);
      expect(compareDecimal(a, c)).toBe(-1); // a < c
      expect(compareDecimal(c, a)).toBe(1); // c > a (симметрия)
    });

    // Валидация операндов
    // Примечание: Все comparison функции (equals, lessThan, greaterThan и т.д.)
    // используют одинаковую валидацию InvalidOperandError. Проверяем на примере
    // equalsDecimal - остальные функции имеют идентичное поведение.
    describe('валидация операндов', () => {
      it('должен throw InvalidOperandError на NaN в первом операнде', () => {
        expect(() =>
          equalsDecimal(new Decimal(NaN), new Decimal(10))
        ).toThrow(InvalidOperandError);
      });

      it('должен throw InvalidOperandError на NaN во втором операнде', () => {
        expect(() =>
          equalsDecimal(new Decimal(10), new Decimal(NaN))
        ).toThrow(InvalidOperandError);
      });

      it('должен throw InvalidOperandError на Infinity в первом операнде', () => {
        expect(() =>
          equalsDecimal(new Decimal(Infinity), new Decimal(10))
        ).toThrow(InvalidOperandError);
      });

      it('должен throw InvalidOperandError на -Infinity во втором операнде', () => {
        expect(() =>
          equalsDecimal(new Decimal(10), new Decimal(-Infinity))
        ).toThrow(InvalidOperandError);
      });

      it('должен содержать контекст в InvalidOperandError', () => {
        expect.assertions(4);
        try {
          equalsDecimal(new Decimal(NaN), new Decimal(10));
        } catch (error) {
          if (error instanceof InvalidOperandError) {
            expect(error.context).toBeDefined();
            expect(error.context?.a).toBe('NaN');
            expect(error.context?.b).toBe('10');
            expect(error.context?.operation).toBe('equals');
          }
        }
      });
    });
  });

  describe('lessThanDecimal', () => {
    it('должен возвращать true когда a < b', () => {
      expect(lessThanDecimal(new Decimal(5), new Decimal(10))).toBe(true);
    });

    it('должен возвращать false когда a >= b', () => {
      expect(lessThanDecimal(new Decimal(10), new Decimal(10))).toBe(false);
      expect(lessThanDecimal(new Decimal(15), new Decimal(10))).toBe(false);
    });

    it('должен работать с отрицательными числами', () => {
      expect(lessThanDecimal(new Decimal(-10), new Decimal(-5))).toBe(true);
    });

    it('должен работать с дробными числами', () => {
      expect(lessThanDecimal(new Decimal(1.5), new Decimal(1.6))).toBe(true);
    });
  });

  describe('lessThanOrEqualDecimal', () => {
    it('должен возвращать true когда a < b', () => {
      expect(lessThanOrEqualDecimal(new Decimal(5), new Decimal(10))).toBe(
        true
      );
    });

    it('должен возвращать true когда a == b', () => {
      expect(lessThanOrEqualDecimal(new Decimal(10), new Decimal(10))).toBe(
        true
      );
    });

    it('должен возвращать false когда a > b', () => {
      expect(lessThanOrEqualDecimal(new Decimal(15), new Decimal(10))).toBe(
        false
      );
    });
  });

  describe('greaterThanDecimal', () => {
    it('должен возвращать true когда a > b', () => {
      expect(greaterThanDecimal(new Decimal(10), new Decimal(5))).toBe(true);
    });

    it('должен возвращать false когда a <= b', () => {
      expect(greaterThanDecimal(new Decimal(10), new Decimal(10))).toBe(false);
      expect(greaterThanDecimal(new Decimal(5), new Decimal(10))).toBe(false);
    });

    it('должен работать с отрицательными числами', () => {
      expect(greaterThanDecimal(new Decimal(-5), new Decimal(-10))).toBe(true);
    });
  });

  describe('greaterThanOrEqualDecimal', () => {
    it('должен возвращать true когда a > b', () => {
      expect(greaterThanOrEqualDecimal(new Decimal(10), new Decimal(5))).toBe(
        true
      );
    });

    it('должен возвращать true когда a == b', () => {
      expect(greaterThanOrEqualDecimal(new Decimal(10), new Decimal(10))).toBe(
        true
      );
    });

    it('должен возвращать false когда a < b', () => {
      expect(greaterThanOrEqualDecimal(new Decimal(5), new Decimal(10))).toBe(
        false
      );
    });
  });

  describe('compareDecimal', () => {
    it('должен возвращать -1 когда a < b', () => {
      expect(compareDecimal(new Decimal(5), new Decimal(10))).toBe(-1);
    });

    it('должен возвращать 0 когда a == b', () => {
      expect(compareDecimal(new Decimal(10), new Decimal(10))).toBe(0);
    });

    it('должен возвращать 1 когда a > b', () => {
      expect(compareDecimal(new Decimal(15), new Decimal(10))).toBe(1);
    });

    it('должен работать с отрицательными числами', () => {
      expect(compareDecimal(new Decimal(-10), new Decimal(-5))).toBe(-1);
      expect(compareDecimal(new Decimal(-5), new Decimal(-10))).toBe(1);
    });

    it('должен работать с нулём', () => {
      expect(compareDecimal(new Decimal(0), new Decimal(0))).toBe(0);
      expect(compareDecimal(new Decimal(5), new Decimal(0))).toBe(1);
      expect(compareDecimal(new Decimal(-5), new Decimal(0))).toBe(-1);
    });

    it('должен соблюдать антисимметрию: compare(a,b) === -compare(b,a)', () => {
      const a = new Decimal('5.5');
      const b = new Decimal('10.7');
      const c = new Decimal('-3.2');

      expect(compareDecimal(a, b)).toBe(-compareDecimal(b, a));
      expect(compareDecimal(b, c)).toBe(-compareDecimal(c, b));
      expect(compareDecimal(a, c)).toBe(-compareDecimal(c, a));
    });

    it('должен соблюдать транзитивность: если a<b и b<c то a<c', () => {
      const a = new Decimal('1.5');
      const b = new Decimal('5.7');
      const c = new Decimal('10.3');

      expect(compareDecimal(a, b)).toBe(-1); // a < b
      expect(compareDecimal(b, c)).toBe(-1); // b < c
      expect(compareDecimal(a, c)).toBe(-1); // a < c (транзитивность)
    });

    it('должен работать с разными форматами: compare("10.0", "10") === 0', () => {
      expect(compareDecimal(new Decimal('10.0'), new Decimal('10'))).toBe(0);
      expect(compareDecimal(new Decimal('0.1000'), new Decimal('0.10'))).toBe(0);
      expect(compareDecimal(new Decimal('1e2'), new Decimal('100'))).toBe(0);
    });

    it('должен быть симметричным для разных форматов', () => {
      // Прямое направление
      expect(compareDecimal(new Decimal('10'), new Decimal('10.0'))).toBe(0);
      // Обратное направление
      expect(compareDecimal(new Decimal('10.0'), new Decimal('10'))).toBe(0);
      // Экспоненциальная форма
      expect(compareDecimal(new Decimal('100'), new Decimal('1e2'))).toBe(0);
    });

    // Примечание: валидация операндов для compareDecimal идентична валидации
    // в equalsDecimal (см. выше) - все comparison функции используют одинаковую
    // проверку InvalidOperandError, поэтому избыточные тесты удалены.
  });

  // Дополнительные тесты транзитивности и консистентности
  describe('Транзитивность на отрицательных и дробных', () => {
    it('должен соблюдать транзитивность: если a<b и b<c то a<c (отрицательные + дробные)', () => {
      const a = new Decimal('-1.2');
      const b = new Decimal('-1.1');
      const c = new Decimal('0');

      expect(compareDecimal(a, b)).toBe(-1); // a < b
      expect(compareDecimal(b, c)).toBe(-1); // b < c
      expect(compareDecimal(a, c)).toBe(-1); // a < c (транзитивность)
    });
  });

  describe('Консистентность операций сравнения', () => {
    it('lessThanOrEqualDecimal(a,b) === !greaterThanDecimal(a,b)', () => {
      const pairs = [
        [new Decimal('5'), new Decimal('10')],
        [new Decimal('10'), new Decimal('10')],
        [new Decimal('15'), new Decimal('10')],
        [new Decimal('-1.5'), new Decimal('0.5')],
      ];

      pairs.forEach(([a, b]) => {
        expect(lessThanOrEqualDecimal(a, b)).toBe(!greaterThanDecimal(a, b));
      });
    });

    it('greaterThanOrEqualDecimal(a,b) === !lessThanDecimal(a,b)', () => {
      const pairs = [
        [new Decimal('10'), new Decimal('5')],
        [new Decimal('10'), new Decimal('10')],
        [new Decimal('5'), new Decimal('10')],
        [new Decimal('0.5'), new Decimal('-1.5')],
      ];

      pairs.forEach(([a, b]) => {
        expect(greaterThanOrEqualDecimal(a, b)).toBe(!lessThanDecimal(a, b));
      });
    });
  });
});
