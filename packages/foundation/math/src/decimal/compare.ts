import Decimal from 'decimal.js';

/**
 * Сравнивает два Decimal на равенство с точностью epsilon
 *
 * @param a - Первое значение
 * @param b - Второе значение
 * @param epsilon - Точность сравнения (default: 1e-10)
 * @returns True если |a - b| < epsilon
 *
 * @remarks
 * Использует epsilon для сравнения floating-point чисел.
 * По умолчанию epsilon = 1e-10, что достаточно для большинства финансовых расчётов.
 *
 * @example
 * ```typescript
 * equalsDecimal(new Decimal(10), new Decimal(10)); // true
 * equalsDecimal(new Decimal(10.00001), new Decimal(10)); // true (в пределах epsilon)
 * equalsDecimal(new Decimal(10), new Decimal(11)); // false
 * ```
 */
export function equalsDecimal(
  a: Decimal,
  b: Decimal,
  epsilon: Decimal = new Decimal(1e-10)
): boolean {
  return a.minus(b).abs().lessThan(epsilon);
}

/**
 * Проверяет a < b
 *
 * @param a - Первое значение
 * @param b - Второе значение
 * @returns True если a строго меньше b
 *
 * @example
 * ```typescript
 * lessThanDecimal(new Decimal(5), new Decimal(10)); // true
 * lessThanDecimal(new Decimal(10), new Decimal(10)); // false
 * ```
 */
export function lessThanDecimal(a: Decimal, b: Decimal): boolean {
  return a.lessThan(b);
}

/**
 * Проверяет a <= b
 *
 * @param a - Первое значение
 * @param b - Второе значение
 * @returns True если a меньше или равно b
 *
 * @example
 * ```typescript
 * lessThanOrEqualDecimal(new Decimal(5), new Decimal(10)); // true
 * lessThanOrEqualDecimal(new Decimal(10), new Decimal(10)); // true
 * lessThanOrEqualDecimal(new Decimal(15), new Decimal(10)); // false
 * ```
 */
export function lessThanOrEqualDecimal(a: Decimal, b: Decimal): boolean {
  return a.lessThanOrEqualTo(b);
}

/**
 * Проверяет a > b
 *
 * @param a - Первое значение
 * @param b - Второе значение
 * @returns True если a строго больше b
 *
 * @example
 * ```typescript
 * greaterThanDecimal(new Decimal(10), new Decimal(5)); // true
 * greaterThanDecimal(new Decimal(10), new Decimal(10)); // false
 * ```
 */
export function greaterThanDecimal(a: Decimal, b: Decimal): boolean {
  return a.greaterThan(b);
}

/**
 * Проверяет a >= b
 *
 * @param a - Первое значение
 * @param b - Второе значение
 * @returns True если a больше или равно b
 *
 * @example
 * ```typescript
 * greaterThanOrEqualDecimal(new Decimal(10), new Decimal(5)); // true
 * greaterThanOrEqualDecimal(new Decimal(10), new Decimal(10)); // true
 * greaterThanOrEqualDecimal(new Decimal(5), new Decimal(10)); // false
 * ```
 */
export function greaterThanOrEqualDecimal(a: Decimal, b: Decimal): boolean {
  return a.greaterThanOrEqualTo(b);
}

/**
 * Сравнивает два Decimal
 *
 * @param a - Первое значение
 * @param b - Второе значение
 * @returns -1 если a < b, 0 если a == b, 1 если a > b
 *
 * @remarks
 * Полезно для сортировки и условных ветвлений.
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
 * ```
 */
export function compareDecimal(a: Decimal, b: Decimal): -1 | 0 | 1 {
  if (a.lessThan(b)) return -1;
  if (a.greaterThan(b)) return 1;
  return 0;
}
