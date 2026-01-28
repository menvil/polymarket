import Decimal from 'decimal.js';

/**
 * Математические константы
 *
 * @remarks
 * Предопределённые Decimal значения для часто используемых констант.
 * Использование констант вместо создания новых Decimal объектов
 * улучшает производительность и читаемость кода.
 *
 * @example
 * ```typescript
 * import { MATH_CONSTANTS } from '@polymarket/math';
 *
 * // Вместо new Decimal(0)
 * const zero = MATH_CONSTANTS.ZERO;
 *
 * // Вместо new Decimal(1)
 * const one = MATH_CONSTANTS.ONE;
 * ```
 */
export const MATH_CONSTANTS = {
  /** Ноль */
  ZERO: new Decimal(0),

  /** Единица */
  ONE: new Decimal(1),

  /** Два */
  TWO: new Decimal(2),

  /** Десять */
  TEN: new Decimal(10),

  /** Сто */
  HUNDRED: new Decimal(100),

  /** Минимальный тик по умолчанию (1 цент) */
  DEFAULT_TICK: new Decimal(0.01),
} as const;
