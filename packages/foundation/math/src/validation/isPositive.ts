import Decimal from 'decimal.js';

/**
 * Проверяет что Decimal значение строго положительное (> 0) и конечное
 *
 * @param value - Значение для проверки
 * @returns true если значение больше нуля и является конечным числом
 *
 * @remarks
 * Строгое сравнение: 0 не считается положительным.
 * Для проверки неотрицательности (>= 0) используйте isNonNegativeDecimal.
 * Возвращает false для NaN и Infinity.
 *
 * @example
 * ```typescript
 * isPositiveDecimal(new Decimal(10)); // true
 * isPositiveDecimal(new Decimal(0.1)); // true
 * isPositiveDecimal(new Decimal('1e-10')); // true
 * isPositiveDecimal(new Decimal(0)); // false
 * isPositiveDecimal(new Decimal(-10)); // false
 * isPositiveDecimal(new Decimal(Infinity)); // false
 * isPositiveDecimal(new Decimal(NaN)); // false
 * ```
 */
export function isPositiveDecimal(value: Decimal): boolean {
  return value.isFinite() && value.greaterThan(0);
}
