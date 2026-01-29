import Decimal from 'decimal.js';

/**
 * Проверяет что Decimal значение неотрицательное (>= 0) и конечное
 *
 * @param value - Значение для проверки
 * @returns true если значение больше или равно нулю и является конечным числом
 *
 * @remarks
 * Включает ноль: 0 считается неотрицательным.
 * Для строгой проверки положительности (> 0) используйте isPositiveDecimal.
 * Возвращает false для NaN и Infinity.
 *
 * @example
 * ```typescript
 * isNonNegativeDecimal(new Decimal(10)); // true
 * isNonNegativeDecimal(new Decimal(0.1)); // true
 * isNonNegativeDecimal(new Decimal(0)); // true - ключевое отличие!
 * isNonNegativeDecimal(new Decimal(-10)); // false
 * isNonNegativeDecimal(new Decimal(-0.1)); // false
 * isNonNegativeDecimal(new Decimal(Infinity)); // false
 * isNonNegativeDecimal(new Decimal(NaN)); // false
 * ```
 */
export function isNonNegativeDecimal(value: Decimal): boolean {
  return value.isFinite() && value.greaterThanOrEqualTo(0);
}
