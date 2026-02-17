import { describe, it, expect } from '@jest/globals';

/**
 * Smoke-тесты для проверки exports контракта пакета @polymarket/math.
 *
 * Эти тесты проверяют структуру экспортов - что все функции доступны
 * через правильные entry points (index.ts, decimal/index.ts и т.д.).
 *
 * @remarks
 * Цель: обнаружить проблемы со структурой exports на раннем этапе:
 * - Забыли добавить новую функцию в index.ts
 * - Неправильные re-exports в subpath модулях
 *
 * **Ограничение**: Эти тесты импортируют из src/, поэтому НЕ проверяют:
 * - Корректность package.json exports map
 * - Сборку в dist/
 * - Реальный package contract после публикации
 *
 * **Для проверки реального package exports используйте:**
 * ```bash
 * npm run build
 * node __tests__/integration/verify-package-exports.mjs
 * ```
 */
describe('Package exports contract', () => {
  describe('root exports - decimal функции', () => {
    /**
     * Проверяет, что все decimal функции экспортируются из корневого модуля.
     */
    it('должен экспортировать все decimal функции из root', async () => {
      const math = await import('../../src/index.js');

      // Базовые арифметические операции
      expect(math.addDecimal).toBeDefined();
      expect(math.subtractDecimal).toBeDefined();
      expect(math.multiplyDecimal).toBeDefined();
      expect(math.divideDecimal).toBeDefined();
      expect(math.averageDecimal).toBeDefined();

      // Операции сравнения
      expect(math.compareDecimal).toBeDefined();
      expect(math.equalsDecimal).toBeDefined();
      expect(math.lessThanDecimal).toBeDefined();
      expect(math.lessThanOrEqualDecimal).toBeDefined();
      expect(math.greaterThanDecimal).toBeDefined();
      expect(math.greaterThanOrEqualDecimal).toBeDefined();

      // Операции округления
      expect(math.roundDecimal).toBeDefined();
      expect(math.roundTowardZeroDecimal).toBeDefined();
      expect(math.roundAwayFromZeroDecimal).toBeDefined();
      expect(math.truncDecimal).toBeDefined();

      // Новые методы Math.floor/ceil
      expect(math.mathFloorDecimal).toBeDefined();
      expect(math.mathCeilDecimal).toBeDefined();
    });
  });

  describe('root exports - rounding функции', () => {
    /**
     * Проверяет, что все rounding функции экспортируются из корневого модуля.
     */
    it('должен экспортировать все rounding функции из root', async () => {
      const math = await import('../../src/index.js');

      expect(math.roundToTick).toBeDefined();
      expect(math.floorToTick).toBeDefined();
      expect(math.ceilToTick).toBeDefined();
      expect(math.mathFloorToTick).toBeDefined();
      expect(math.mathCeilToTick).toBeDefined();
      expect(math.roundToPrecision).toBeDefined();
    });
  });

  describe('root exports - validation функции', () => {
    /**
     * Проверяет, что все validation функции экспортируются из корневого модуля.
     */
    it('должен экспортировать все validation функции из root', async () => {
      const math = await import('../../src/index.js');

      expect(math.isFiniteDecimal).toBeDefined();
      expect(math.isPositiveDecimal).toBeDefined();
      expect(math.isNonNegativeDecimal).toBeDefined();

      // Новый метод isZeroDecimal
      expect(math.isZeroDecimal).toBeDefined();
    });
  });

  describe('root exports - константы', () => {
    /**
     * Проверяет, что математические константы экспортируются из корневого модуля.
     */
    it('должен экспортировать константы из root', async () => {
      const math = await import('../../src/index.js');

      expect(math.MATH_CONSTANTS).toBeDefined();
      expect(math.MATH_CONSTANTS.ZERO).toBeDefined();
      expect(math.MATH_CONSTANTS.ONE).toBeDefined();
      expect(math.MATH_CONSTANTS.TWO).toBeDefined();
      expect(math.MATH_CONSTANTS.TEN).toBeDefined();
      expect(math.MATH_CONSTANTS.HUNDRED).toBeDefined();
    });
  });

  describe('subpath exports - ./decimal', () => {
    /**
     * Проверяет, что subpath export './decimal' работает корректно.
     */
    it('должен экспортировать из subpath ./decimal', async () => {
      const decimal = await import('../../src/decimal/index.js');

      expect(decimal.addDecimal).toBeDefined();
      expect(decimal.subtractDecimal).toBeDefined();
      expect(decimal.multiplyDecimal).toBeDefined();
      expect(decimal.divideDecimal).toBeDefined();
      expect(decimal.averageDecimal).toBeDefined();
      expect(decimal.compareDecimal).toBeDefined();
      expect(decimal.equalsDecimal).toBeDefined();
      expect(decimal.roundDecimal).toBeDefined();

      // Новые методы должны быть в decimal subpath
      expect(decimal.mathFloorDecimal).toBeDefined();
      expect(decimal.mathCeilDecimal).toBeDefined();
    });
  });

  describe('subpath exports - ./rounding', () => {
    /**
     * Проверяет, что subpath export './rounding' работает корректно.
     */
    it('должен экспортировать из subpath ./rounding', async () => {
      const rounding = await import('../../src/rounding/index.js');

      expect(rounding.roundToTick).toBeDefined();
      expect(rounding.floorToTick).toBeDefined();
      expect(rounding.ceilToTick).toBeDefined();
      expect(rounding.roundToPrecision).toBeDefined();

      // Новые методы mathFloorToTick/mathCeilToTick
      expect(rounding.mathFloorToTick).toBeDefined();
      expect(rounding.mathCeilToTick).toBeDefined();
    });
  });

  describe('subpath exports - ./validation', () => {
    /**
     * Проверяет, что subpath export './validation' работает корректно.
     */
    it('должен экспортировать из subpath ./validation', async () => {
      const validation = await import('../../src/validation/index.js');

      expect(validation.isFiniteDecimal).toBeDefined();
      expect(validation.isPositiveDecimal).toBeDefined();
      expect(validation.isNonNegativeDecimal).toBeDefined();

      // Новый метод isZeroDecimal
      expect(validation.isZeroDecimal).toBeDefined();
    });
  });

  describe('функции являются функциями', () => {
    /**
     * Проверяет, что все экспорты действительно являются функциями,
     * а не undefined или другими типами.
     */
    it('все decimal функции должны быть typeof function', async () => {
      const math = await import('../../src/index.js');

      expect(typeof math.addDecimal).toBe('function');
      expect(typeof math.divideDecimal).toBe('function');
      expect(typeof math.mathFloorDecimal).toBe('function');
      expect(typeof math.mathCeilDecimal).toBe('function');
    });

    it('все rounding функции должны быть typeof function', async () => {
      const math = await import('../../src/index.js');

      expect(typeof math.roundToTick).toBe('function');
      expect(typeof math.mathFloorToTick).toBe('function');
      expect(typeof math.mathCeilToTick).toBe('function');
    });

    it('все validation функции должны быть typeof function', async () => {
      const math = await import('../../src/index.js');

      expect(typeof math.isFiniteDecimal).toBe('function');
      expect(typeof math.isZeroDecimal).toBe('function');
    });
  });

  describe('константы являются объектами', () => {
    /**
     * Проверяет, что MATH_CONSTANTS является объектом с Decimal значениями.
     */
    it('MATH_CONSTANTS должен быть объектом', async () => {
      const math = await import('../../src/index.js');

      expect(typeof math.MATH_CONSTANTS).toBe('object');
      expect(math.MATH_CONSTANTS).not.toBeNull();
    });

    it('константы должны быть Decimal инстансами', async () => {
      const math = await import('../../src/index.js');

      // Проверяем что константы имеют методы Decimal
      expect(typeof math.MATH_CONSTANTS.ZERO.toString).toBe('function');
      expect(typeof math.MATH_CONSTANTS.ONE.plus).toBe('function');
      expect(typeof math.MATH_CONSTANTS.TWO.isZero).toBe('function');
    });
  });
});
