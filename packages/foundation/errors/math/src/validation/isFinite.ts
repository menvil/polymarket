import Decimal from 'decimal.js';

/**
 * Проверяет что Decimal значение конечное (не NaN, не Infinity)
 *
 * @param value - Значение для проверки
 * @returns true если значение конечное (не NaN и не ±Infinity)
 *
 * @remarks
 * Обёртка над Decimal.isFinite() для единообразного API.
 * Используется для валидации входных данных.
 *
 * @example
 * ```typescript
 * isFiniteDecimal(new Decimal(10)); // true
 * isFiniteDecimal(new Decimal(-10)); // true
 * isFiniteDecimal(new Decimal(0)); // true
 * isFiniteDecimal(new Decimal(NaN)); // false
 * isFiniteDecimal(new Decimal(Infinity)); // false
 * isFiniteDecimal(new Decimal(-Infinity)); // false
 * ```
 */
export function isFiniteDecimal(value: Decimal): boolean {
  return value.isFinite();
}
