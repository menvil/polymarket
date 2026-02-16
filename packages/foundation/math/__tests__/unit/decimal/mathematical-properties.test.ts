import { describe, it, expect } from '@jest/globals';
import { addDecimal, multiplyDecimal } from '../../../src/decimal/index.js';
import Decimal from 'decimal.js';

/**
 * Детерминированные тесты математических свойств
 *
 * Этот файл содержит строгие, детерминированные тесты математических свойств
 * с ЧЕСТНЫМИ формулировками о том, что Decimal.js РЕАЛЬНО гарантирует.
 *
 * @remarks
 * **ПРАВДА о Decimal.js и математических свойствах:**
 *
 * Decimal.js использует arbitrary precision arithmetic с КОНЕЧНОЙ точностью (precision).
 * Математические свойства сохраняются в зависимости от precision:
 *
 * - **Коммутативность**: ВСЕГДА сохраняется при любой precision
 *   - a + b = b + a (для сложения)
 *   - a × b = b × a (для умножения)
 *
 * - **Ассоциативность и дистрибутивность**: НЕ всегда сохраняются
 *   - При precision >= 20: сохраняются для практических чисел
 *   - При низкой precision (например, 5): МОГУТ нарушаться
 *   - Причина: промежуточное округление после каждой операции
 *
 * **Почему нарушаются свойства при низкой precision:**
 * 1. Decimal.js округляет КАЖДЫЙ промежуточный результат до precision
 * 2. (a + b) + c: сначала округляется (a + b), затем прибавляется c
 * 3. a + (b + c): сначала округляется (b + c), затем прибавляется a
 * 4. Из-за разного порядка округления результаты могут отличаться
 *
 * **Отличие от IEEE 754 float:**
 * - IEEE 754: нарушения происходят из-за бинарного представления десятичных дробей
 *   Пример: 0.1 + 0.2 !== 0.3 в JavaScript (бинарное округление)
 * - Decimal.js: нарушения происходят только при недостаточной precision
 *   Пример: при precision=20 все десятичные операции точны
 *
 * **Гарантии для нашей библиотеки:**
 * - Используем дефолтную precision=20 (достаточно для финансовых расчетов)
 * - При precision=20 свойства сохраняются для всех практических чисел
 * - Наши обёртки (addDecimal, multiplyDecimal) не вносят дополнительных округлений
 * - Для критичных расчетов рекомендуется использовать precision >= 20
 */
describe('математические свойства (честные гарантии)', () => {
  describe('коммутативность (сохраняется всегда при любой precision)', () => {
    it('коммутативность сложения: a + b = b + a', () => {
      const testCases = [
        ['0.1', '0.2'],
        ['0.5', '0.7'],
        ['123456789.987654321', '987654321.123456789'],
        ['0.0000000001', '9999999999'],
        ['1e-15', '1e15'],
        ['-100.5', '100.5'],
        ['-50.25', '-75.75'],
        ['0', '12345'],
        ['1', '1'],
      ];

      testCases.forEach(([aStr, bStr]) => {
        const a = new Decimal(aStr);
        const b = new Decimal(bStr);

        const left = addDecimal(a, b);
        const right = addDecimal(b, a);

        // Коммутативность - математическое свойство операции, всегда выполняется
        expect(left.toString()).toBe(right.toString());
        expect(left.equals(right)).toBe(true);
      });
    });

    it('коммутативность умножения: a × b = b × a', () => {
      const testCases = [
        ['2', '3'],
        ['0.5', '4'],
        ['0.1', '0.2'],
        ['1.5', '2.5'],
        ['123.456', '789.012'],
        ['0.0000001', '10000000'],
        ['-5.5', '2.2'],
        ['-3', '-7'],
        ['1e-5', '1e5'],
        ['2.5e10', '4e-8'],
      ];

      testCases.forEach(([aStr, bStr]) => {
        const a = new Decimal(aStr);
        const b = new Decimal(bStr);

        const left = multiplyDecimal(a, b);
        const right = multiplyDecimal(b, a);

        expect(left.toString()).toBe(right.toString());
        expect(left.equals(right)).toBe(true);
      });
    });
  });

  describe('ассоциативность при стандартной precision=20', () => {
    it('ассоциативность: (a + b) + c = a + (b + c) при precision=20', () => {
      const testCases = [
        ['10.1234567890123456', '20.9876543210987654', '30.5555555555555555'],
        ['1', '2', '3'],
        ['0.1', '0.2', '0.3'],
        ['0.7', '0.1', '0.2'],
        ['1000000', '2000000', '3000000'],
        ['-100.5', '200.7', '-50.3'],
        ['50', '-30', '-20'],
        ['0.0000001', '0.0000002', '0.0000003'],
        ['1e-10', '2e-10', '3e-10'],
        ['1e15', '2e15', '3e15'],
        ['999999999999999', '1', '1'],
      ];

      testCases.forEach(([aStr, bStr, cStr]) => {
        const a = new Decimal(aStr);
        const b = new Decimal(bStr);
        const c = new Decimal(cStr);

        const left = addDecimal(addDecimal(a, b), c);
        const right = addDecimal(a, addDecimal(b, c));

        expect(left.toString()).toBe(right.toString());
        expect(left.equals(right)).toBe(true);
      });
    });
  });

  describe('дистрибутивность при стандартной precision=20', () => {
    it('дистрибутивность: a × (b + c) = a × b + a × c при precision=20', () => {
      const testCases = [
        ['2', '3', '4'],
        ['10', '20', '30'],
        ['2.5', '3.7', '4.2'],
        ['0.5', '0.3', '0.7'],
        ['10', '0.1', '0.2'],
        ['0.01', '100', '200'],
        ['-2', '5', '7'],
        ['3', '-4', '8'],
        ['1.5', '2.5', '3.5'],
        ['0.1', '0.2', '0.3'],
        ['1.11111', '2.22222', '3.33333'],
        ['9.87654321', '1.23456789', '5.55555555'],
      ];

      testCases.forEach(([aStr, bStr, cStr]) => {
        const a = new Decimal(aStr);
        const b = new Decimal(bStr);
        const c = new Decimal(cStr);

        const left = multiplyDecimal(a, addDecimal(b, c));
        const right = addDecimal(multiplyDecimal(a, b), multiplyDecimal(a, c));

        expect(left.toString()).toBe(right.toString());
        expect(left.equals(right)).toBe(true);
      });
    });
  });

  describe('тесты при низкой precision: ДЕМОНСТРАЦИЯ НАРУШЕНИЙ', () => {
    /**
     * ФАКТ: При precision=5 ассоциативность может нарушаться
     *
     * @remarks
     * Это НЕ баг - это математическое следствие конечной точности.
     * Decimal.js округляет каждый промежуточный результат, поэтому
     * порядок операций влияет на итоговый результат.
     */
    it('КОНТРПРИМЕР: ассоциативность НАРУШАЕТСЯ при precision=5', () => {
      const originalPrecision = Decimal.precision;

      try {
        Decimal.set({ precision: 5 });

        // Значения, которые демонстрируют нарушение ассоциативности
        const a = new Decimal('1.23456');
        const b = new Decimal('2.34567');
        const c = new Decimal('3.45678');

        const left = addDecimal(addDecimal(a, b), c);
        const right = addDecimal(a, addDecimal(b, c));

        // При precision=5 результаты ОТЛИЧАЮТСЯ
        expect(left.toString()).toBe('7.037'); // (1.23456 + 2.34567) = 3.5802 -> округление -> 3.5802 + 3.45678 = 7.037
        expect(right.toString()).toBe('7.0371'); // 2.34567 + 3.45678 = 5.8025 -> округление -> 1.23456 + 5.8025 = 7.0371
        expect(left.equals(right)).toBe(false);
      } finally {
        Decimal.set({ precision: originalPrecision });
      }
    });

    /**
     * ФАКТ: При precision=5 дистрибутивность может нарушаться
     */
    it('КОНТРПРИМЕР: дистрибутивность НАРУШАЕТСЯ при precision=5', () => {
      const originalPrecision = Decimal.precision;

      try {
        Decimal.set({ precision: 5 });

        // Значения, которые демонстрируют нарушение дистрибутивности
        const a = new Decimal('100.123');
        const b = new Decimal('200.456');
        const c = new Decimal('300.789');

        const left = multiplyDecimal(a, addDecimal(b, c));
        const right = addDecimal(multiplyDecimal(a, b), multiplyDecimal(a, c));

        // При precision=5 результаты ОТЛИЧАЮТСЯ
        expect(left.toString()).toBe('50187'); // 100.123 × (200.456 + 300.789) = 100.12 × 501.24 = 50187
        expect(right.toString()).toBe('50186'); // 100.123 × 200.456 + 100.123 × 300.789 = различные промежуточные округления
        expect(left.equals(right)).toBe(false);
      } finally {
        Decimal.set({ precision: originalPrecision });
      }
    });

    /**
     * ФАКТ: Коммутативность сохраняется ВСЕГДА, даже при precision=3
     */
    it('коммутативность сохраняется даже при precision=3', () => {
      const originalPrecision = Decimal.precision;

      try {
        Decimal.set({ precision: 3 });

        const testCases = [
          ['1.23', '4.56'],
          ['9.99', '1.11'],
          ['0.1', '0.2'],
          ['100.123', '200.456'],
        ];

        testCases.forEach(([aStr, bStr]) => {
          const a = new Decimal(aStr);
          const b = new Decimal(bStr);

          // Коммутативность ВСЕГДА выполняется
          const leftAdd = addDecimal(a, b);
          const rightAdd = addDecimal(b, a);
          expect(leftAdd.equals(rightAdd)).toBe(true);

          const leftMul = multiplyDecimal(a, b);
          const rightMul = multiplyDecimal(b, a);
          expect(leftMul.equals(rightMul)).toBe(true);
        });
      } finally {
        Decimal.set({ precision: originalPrecision });
      }
    });
  });

  describe('сравнение с IEEE 754 float', () => {
    it('IEEE 754: классический пример (0.1 + 0.2) + 0.3 vs 0.1 + (0.2 + 0.3)', () => {
      // Decimal.js решает проблему IEEE 754
      const a = new Decimal('0.1');
      const b = new Decimal('0.2');
      const c = new Decimal('0.3');

      const left = addDecimal(addDecimal(a, b), c);
      const right = addDecimal(a, addDecimal(b, c));

      expect(left.toString()).toBe('0.6');
      expect(right.toString()).toBe('0.6');
      expect(left.equals(right)).toBe(true);

      // Для сравнения: native JS дает разные результаты
      // (0.1 + 0.2) + 0.3 !== 0.1 + (0.2 + 0.3) в IEEE 754
    });

    it('IEEE 754: дистрибутивность 0.1 × (0.2 + 0.3) vs 0.1 × 0.2 + 0.1 × 0.3', () => {
      const a = new Decimal('0.1');
      const b = new Decimal('0.2');
      const c = new Decimal('0.3');

      const left = multiplyDecimal(a, addDecimal(b, c));
      const right = addDecimal(multiplyDecimal(a, b), multiplyDecimal(a, c));

      expect(left.toString()).toBe('0.05');
      expect(right.toString()).toBe('0.05');
      expect(left.equals(right)).toBe(true);

      // Native JS может дать разные результаты из-за накопления ошибок округления
      // 0.1 * (0.2 + 0.3) vs 0.1 * 0.2 + 0.1 * 0.3 в IEEE 754
    });
  });

  describe('выводы и честные гарантии', () => {
    it('ГАРАНТИЯ: При precision=20 свойства сохраняются для практических чисел', () => {
      expect(Decimal.precision).toBe(20);

      const values = [
        ['0.1', '0.2', '0.3'],
        ['1', '2', '3'],
        ['1000000', '2000000', '3000000'],
        ['1.123456789012345', '2.234567890123456', '3.345678901234567'],
        ['-100.5', '200.7', '-300.9'],
        ['1e-15', '2e-15', '3e-15'],
        ['1e15', '2e15', '3e15'],
        ['0.0000001', '0.0000002', '0.0000003'],
        ['999999999999999', '1', '1'],
      ];

      values.forEach(([aStr, bStr, cStr]) => {
        const a = new Decimal(aStr);
        const b = new Decimal(bStr);
        const c = new Decimal(cStr);

        // Коммутативность всегда сохраняется
        expect(addDecimal(a, b).equals(addDecimal(b, a))).toBe(true);
        expect(multiplyDecimal(a, b).equals(multiplyDecimal(b, a))).toBe(true);

        // Ассоциативность при precision=20
        const assocLeft = addDecimal(addDecimal(a, b), c);
        const assocRight = addDecimal(a, addDecimal(b, c));
        expect(assocLeft.equals(assocRight)).toBe(true);

        // Дистрибутивность при precision=20
        const distLeft = multiplyDecimal(a, addDecimal(b, c));
        const distRight = addDecimal(multiplyDecimal(a, b), multiplyDecimal(a, c));
        expect(distLeft.equals(distRight)).toBe(true);
      });
    });

    it('ПРАВДА: Механизм работы Decimal.js и его ограничения', () => {
      /**
       * Decimal.js использует произвольную точность (arbitrary precision):
       *
       * **Как это работает:**
       * 1. Числа хранятся внутренне с произвольным количеством цифр
       * 2. Операции выполняются точно до заданной precision
       * 3. Округление происходит после КАЖДОЙ операции (не только на финальном шаге!)
       *
       * **КРИТИЧНО: Промежуточное округление!**
       * - Decimal.js округляет КАЖДЫЙ промежуточный результат до precision
       * - Это означает: (a + b) + c МОЖЕТ отличаться от a + (b + c) при низкой precision
       * - Пример: при precision=5:
       *   - (1.23456 + 2.34567) + 3.45678 = 3.5802 (округл.) + 3.45678 = 7.037
       *   - 1.23456 + (2.34567 + 3.45678) = 1.23456 + 5.8025 (округл.) = 7.0371
       * - Это НЕ баг - это математическое следствие конечной точности
       *
       * **Реальные гарантии:**
       * - **Коммутативность**: ВСЕГДА сохраняется (не зависит от precision)
       *   - a + b = b + a
       *   - a × b = b × a
       * - **Ассоциативность**: сохраняется при достаточной precision
       *   - При precision >= 20: сохраняется для практических чисел
       *   - При precision < 10: может нарушаться (см. контрпримеры выше)
       * - **Дистрибутивность**: сохраняется при достаточной precision
       *   - При precision >= 20: сохраняется для практических чисел
       *   - При precision < 10: может нарушаться (см. контрпримеры выше)
       *
       * **Преимущество перед IEEE 754:**
       * - IEEE 754: нарушения из-за БИНАРНОГО представления десятичных дробей
       *   - 0.1 + 0.2 !== 0.3 в JavaScript (фундаментальная проблема)
       * - Decimal.js: нарушения только при НЕДОСТАТОЧНОЙ precision
       *   - При precision=20 (дефолт) все десятичные операции точны
       *   - Можно увеличить precision при необходимости
       *
       * **Для финансовых расчетов:**
       * - precision=20 (наш дефолт) более чем достаточно
       * - Все математические свойства сохраняются для практических чисел
       */

      // Этот тест документирует поведение, а не проверяет код
      expect(Decimal.precision).toBe(20);
    });
  });
});
