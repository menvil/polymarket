import Decimal from 'decimal.js';

/**
 * Проверяет что значение строго равно нулю
 *
 * @param value - Проверяемое значение
 * @returns True если значение строго равно 0
 *
 * @remarks
 * Выполняет строгое сравнение с нулем через Decimal.isZero().
 *
 * Для приблизительного сравнения используйте напрямую:
 * value.abs().lessThan(epsilon)
 *
 * @example
 * ```typescript
 * isZeroDecimal(new Decimal(0));        // true
 * isZeroDecimal(new Decimal('0.0'));    // true
 * isZeroDecimal(new Decimal('0.0001')); // false
 *
 * // Для приблизительного сравнения:
 * const value = new Decimal('0.0001');
 * const epsilon = new Decimal('0.001');
 * value.abs().lessThan(epsilon); // true
 * ```
 */
export function isZeroDecimal(value: Decimal): boolean {
  return value.isZero();
}
