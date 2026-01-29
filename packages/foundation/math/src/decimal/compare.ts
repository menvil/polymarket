import Decimal from 'decimal.js';
import { InvalidOperandError } from '@polymarket/errors';

/**
 * Строгое сравнение двух Decimal на равенство
 *
 * @param a - Первое значение
 * @param b - Второе значение
 * @returns True если a === b (строго равны)
 *
 * @remarks
 * Строгое математическое сравнение без epsilon/tolerance.
 * Использует встроенный метод Decimal.equals() для строгого сравнения
 * численного значения (без допуска).
 *
 * Это согласуется с compareDecimal(), который также строгий:
 * - equalsDecimal(a, b) === true <=> compareDecimal(a, b) === 0
 *
 * Для приблизительного сравнения с погрешностью используйте:
 * ```typescript
 * const diff = a.minus(b).abs();
 * const approxEqual = diff.lessThan(epsilon);
 * ```
 *
 * @example
 * ```typescript
 * equalsDecimal(new Decimal(10), new Decimal(10)); // true
 * equalsDecimal(new Decimal('10.0'), new Decimal('10')); // true
 * equalsDecimal(new Decimal(10), new Decimal(10.0000000001)); // false (строго)
 * equalsDecimal(new Decimal(10), new Decimal(11)); // false
 *
 * // NaN поведение (IEEE 754):
 * equalsDecimal(new Decimal(NaN), new Decimal(NaN)); // false
 *
 * // Для приблизительного сравнения:
 * const diff = a.minus(b).abs();
 * const epsilon = new Decimal('0.01');
 * const approxEqual = diff.lessThan(epsilon);
 * ```
 *
 * @remarks
 * Следует семантике IEEE 754: NaN не равен никакому значению, включая сам себя.
 * Если нужно проверить что оба значения NaN, используйте `!a.isFinite() && !b.isFinite()`.
 */
export function equalsDecimal(a: Decimal, b: Decimal): boolean {
  return a.equals(b);
}

/**
 * Проверяет a < b
 *
 * @param a - Первое значение
 * @param b - Второе значение
 * @returns True если a строго меньше b
 * @throws {InvalidOperandError} При невалидных операндах (NaN, ±Infinity)
 *
 * @example
 * ```typescript
 * lessThanDecimal(new Decimal(5), new Decimal(10)); // true
 * lessThanDecimal(new Decimal(10), new Decimal(10)); // false
 *
 * // Невалидные значения
 * lessThanDecimal(new Decimal(NaN), new Decimal(10)); // throws InvalidOperandError
 * ```
 */
export function lessThanDecimal(a: Decimal, b: Decimal): boolean {
  if (!a.isFinite()) {
    throw new InvalidOperandError(
      (ctx) => `First operand must be finite, got ${ctx.a}`,
      {
        context: {
          a: a.toString(),
          b: b.toString(),
          operation: 'lessThan',
        },
      }
    );
  }

  if (!b.isFinite()) {
    throw new InvalidOperandError(
      (ctx) => `Second operand must be finite, got ${ctx.b}`,
      {
        context: {
          a: a.toString(),
          b: b.toString(),
          operation: 'lessThan',
        },
      }
    );
  }

  return a.lessThan(b);
}

/**
 * Проверяет a <= b
 *
 * @param a - Первое значение
 * @param b - Второе значение
 * @returns True если a меньше или равно b
 * @throws {InvalidOperandError} При невалидных операндах (NaN, ±Infinity)
 *
 * @example
 * ```typescript
 * lessThanOrEqualDecimal(new Decimal(5), new Decimal(10)); // true
 * lessThanOrEqualDecimal(new Decimal(10), new Decimal(10)); // true
 * lessThanOrEqualDecimal(new Decimal(15), new Decimal(10)); // false
 *
 * // Невалидные значения
 * lessThanOrEqualDecimal(new Decimal(Infinity), new Decimal(10)); // throws InvalidOperandError
 * ```
 */
export function lessThanOrEqualDecimal(a: Decimal, b: Decimal): boolean {
  if (!a.isFinite()) {
    throw new InvalidOperandError(
      (ctx) => `First operand must be finite, got ${ctx.a}`,
      {
        context: {
          a: a.toString(),
          b: b.toString(),
          operation: 'lessThanOrEqual',
        },
      }
    );
  }

  if (!b.isFinite()) {
    throw new InvalidOperandError(
      (ctx) => `Second operand must be finite, got ${ctx.b}`,
      {
        context: {
          a: a.toString(),
          b: b.toString(),
          operation: 'lessThanOrEqual',
        },
      }
    );
  }

  return a.lessThanOrEqualTo(b);
}

/**
 * Проверяет a > b
 *
 * @param a - Первое значение
 * @param b - Второе значение
 * @returns True если a строго больше b
 * @throws {InvalidOperandError} При невалидных операндах (NaN, ±Infinity)
 *
 * @example
 * ```typescript
 * greaterThanDecimal(new Decimal(10), new Decimal(5)); // true
 * greaterThanDecimal(new Decimal(10), new Decimal(10)); // false
 *
 * // Невалидные значения
 * greaterThanDecimal(new Decimal(-Infinity), new Decimal(5)); // throws InvalidOperandError
 * ```
 */
export function greaterThanDecimal(a: Decimal, b: Decimal): boolean {
  if (!a.isFinite()) {
    throw new InvalidOperandError(
      (ctx) => `First operand must be finite, got ${ctx.a}`,
      {
        context: {
          a: a.toString(),
          b: b.toString(),
          operation: 'greaterThan',
        },
      }
    );
  }

  if (!b.isFinite()) {
    throw new InvalidOperandError(
      (ctx) => `Second operand must be finite, got ${ctx.b}`,
      {
        context: {
          a: a.toString(),
          b: b.toString(),
          operation: 'greaterThan',
        },
      }
    );
  }

  return a.greaterThan(b);
}

/**
 * Проверяет a >= b
 *
 * @param a - Первое значение
 * @param b - Второе значение
 * @returns True если a больше или равно b
 * @throws {InvalidOperandError} При невалидных операндах (NaN, ±Infinity)
 *
 * @example
 * ```typescript
 * greaterThanOrEqualDecimal(new Decimal(10), new Decimal(5)); // true
 * greaterThanOrEqualDecimal(new Decimal(10), new Decimal(10)); // true
 * greaterThanOrEqualDecimal(new Decimal(5), new Decimal(10)); // false
 *
 * // Невалидные значения
 * greaterThanOrEqualDecimal(new Decimal(10), new Decimal(NaN)); // throws InvalidOperandError
 * ```
 */
export function greaterThanOrEqualDecimal(a: Decimal, b: Decimal): boolean {
  if (!a.isFinite()) {
    throw new InvalidOperandError(
      (ctx) => `First operand must be finite, got ${ctx.a}`,
      {
        context: {
          a: a.toString(),
          b: b.toString(),
          operation: 'greaterThanOrEqual',
        },
      }
    );
  }

  if (!b.isFinite()) {
    throw new InvalidOperandError(
      (ctx) => `Second operand must be finite, got ${ctx.b}`,
      {
        context: {
          a: a.toString(),
          b: b.toString(),
          operation: 'greaterThanOrEqual',
        },
      }
    );
  }

  return a.greaterThanOrEqualTo(b);
}

/**
 * Сравнивает два Decimal
 *
 * @param a - Первое значение
 * @param b - Второе значение
 * @returns -1 если a < b, 0 если a == b, 1 если a > b
 * @throws {InvalidOperandError} При невалидных операндах (NaN, ±Infinity)
 *
 * @remarks
 * Использует канонический метод comparedTo из Decimal.js.
 * Полезно для сортировки и условных ветвлений.
 *
 * Валидация операндов:
 * - Оба операнда должны быть конечными числами
 * - NaN, Infinity, -Infinity выбрасывают InvalidOperandError
 *
 * @example
 * ```typescript
 * compareDecimal(new Decimal(5), new Decimal(10)); // -1
 * compareDecimal(new Decimal(10), new Decimal(10)); // 0
 * compareDecimal(new Decimal(15), new Decimal(10)); // 1
 *
 * // Использование для сортировки
 * const prices = [new Decimal(0.67), new Decimal(0.65), new Decimal(0.66)];
 * prices.sort(compareDecimal);
 * // [0.65, 0.66, 0.67]
 *
 * // Невалидные значения
 * compareDecimal(new Decimal(NaN), new Decimal(10)); // throws InvalidOperandError
 * ```
 */
export function compareDecimal(a: Decimal, b: Decimal): -1 | 0 | 1 {
  // Валидация первого операнда
  if (!a.isFinite()) {
    throw new InvalidOperandError(
      (ctx) => `First operand must be finite, got ${ctx.a}`,
      {
        context: {
          a: a.toString(),
          b: b.toString(),
          operation: 'compare'
        }
      }
    );
  }

  // Валидация второго операнда
  if (!b.isFinite()) {
    throw new InvalidOperandError(
      (ctx) => `Second operand must be finite, got ${ctx.b}`,
      {
        context: {
          a: a.toString(),
          b: b.toString(),
          operation: 'compare'
        }
      }
    );
  }

  const c = a.comparedTo(b);
  if (c < 0) return -1;
  if (c > 0) return 1;
  return 0;
}
