import Decimal from 'decimal.js';

/**
 * Проверяет что значение близко к нулю в пределах epsilon
 *
 * @param value - Проверяемое значение
 * @param epsilon - Максимальная допустимая разница от нуля
 * @returns True если |value| < epsilon
 *
 * @remarks
 * Приблизительное сравнение с нулем с явным epsilon.
 *
 * Параметр epsilon ОБЯЗАТЕЛЕН - нет значения по умолчанию.
 * Философия: explicit лучше implicit.
 *
 * Для строгого сравнения с нулем используйте value.isZero().
 *
 * @example
 * ```typescript
 * // Приблизительное сравнение
 * const value = new Decimal('0.0001');
 * const epsilon = new Decimal('0.001');
 *
 * isZeroDecimal(value, epsilon); // true (|0.0001| < 0.001)
 *
 * // Строгое сравнение
 * value.isZero(); // false (не строго ноль)
 *
 * // Разные epsilon для разных контекстов
 * const computationalPrecision = new Decimal('1e-10');
 * const businessPrecision = new Decimal('0.01');
 *
 * isZeroDecimal(diff, computationalPrecision); // Числовая точность
 * isZeroDecimal(remaining, businessPrecision);  // Бизнес-логика
 * ```
 */
export function isZeroDecimal(value: Decimal, epsilon: Decimal): boolean {
  return value.abs().lessThan(epsilon);
}
