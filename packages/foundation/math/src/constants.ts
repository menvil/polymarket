import Decimal from 'decimal.js';

/**
 * Математические константы
 *
 * @remarks
 * Предопределённые Decimal значения для часто используемых констант.
 * Использование констант вместо создания новых Decimal объектов
 * повышает читаемость и снижает количество повторов.
 *
 * Объект защищён от runtime-перезаписи через Object.freeze().
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
 *
 * // Защита от перезаписи
 * MATH_CONSTANTS.ZERO = new Decimal(999); // Не изменит значение
 * ```
 */
export const MATH_CONSTANTS = Object.freeze({
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
} as const);
