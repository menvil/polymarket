import Decimal from 'decimal.js';

/**
 * Проверяет что Decimal значение равно нулю (с учётом точности)
 *
 * @param value - Значение для проверки
 * @param epsilon - Точность сравнения (default: 1e-10)
 * @returns true если абсолютное значение меньше или равно epsilon
 *
 * @remarks
 * Использует epsilon для учёта погрешности вычислений.
 * Значение считается нулевым если |value| <= epsilon.
 * Default epsilon (1e-10) подходит для большинства случаев.
 *
 * @example
 * ```typescript
 * // Default epsilon = 1e-10
 * isZeroDecimal(new Decimal(0)); // true
 * isZeroDecimal(new Decimal('1e-11')); // true (в пределах точности)
 * isZeroDecimal(new Decimal('-1e-11')); // true
 * isZeroDecimal(new Decimal('1e-9')); // false (вне точности)
 * isZeroDecimal(new Decimal(10)); // false
 *
 * // Кастомный epsilon
 * isZeroDecimal(new Decimal(0.5), new Decimal(1)); // true
 * isZeroDecimal(new Decimal(1.5), new Decimal(1)); // false
 * ```
 */
export function isZeroDecimal(
  value: Decimal,
  epsilon: Decimal = new Decimal(1e-10)
): boolean {
  return value.abs().lessThanOrEqualTo(epsilon);
}
