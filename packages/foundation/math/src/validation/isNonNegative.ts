import Decimal from 'decimal.js';

/**
 * Проверяет что Decimal значение неотрицательное (>= 0)
 *
 * @param value - Значение для проверки
 * @returns true если значение больше или равно нулю
 *
 * @remarks
 * Включает ноль: 0 считается неотрицательным.
 * Для строгой проверки положительности (> 0) используйте isPositiveDecimal.
 *
 * @example
 * ```typescript
 * isNonNegativeDecimal(new Decimal(10)); // true
 * isNonNegativeDecimal(new Decimal(0.1)); // true
 * isNonNegativeDecimal(new Decimal(0)); // true - ключевое отличие!
 * isNonNegativeDecimal(new Decimal(-10)); // false
 * isNonNegativeDecimal(new Decimal(-0.1)); // false
 * ```
 */
export function isNonNegativeDecimal(value: Decimal): boolean {
  return value.greaterThanOrEqualTo(0);
}
