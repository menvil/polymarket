import Decimal from 'decimal.js';

/**
 * Математические константы
 *
 * @remarks
 * Предопределённые Decimal значения для часто используемых констант.
 * Использование констант вместо создания новых Decimal объектов
 * повышает читаемость и снижает количество повторов.
 *
 * Объект защищён от runtime-перезаписи через Object.freeze():
 * - Контейнер MATH_CONSTANTS заморожен (нельзя добавить/удалить/изменить ключи)
 * - Каждый Decimal инстанс заморожен (нельзя мутировать .s, .e, .d поля)
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
 * // Защита от перезаписи контейнера
 * MATH_CONSTANTS.ZERO = new Decimal(999); // Не изменит значение (frozen)
 *
 * // Защита от мутации внутренних полей Decimal
 * MATH_CONSTANTS.ONE.s = -1; // Не изменит знак (frozen)
 * MATH_CONSTANTS.ONE.e = 100; // Не изменит экспоненту (frozen)
 *
 * // Математические операции продолжают работать (создают новые Decimal)
 * const two = MATH_CONSTANTS.ONE.plus(MATH_CONSTANTS.ONE); // ✅ Работает
 * ```
 */
export const MATH_CONSTANTS = Object.freeze({
  /** Ноль */
  ZERO: Object.freeze(new Decimal(0)),

  /** Единица */
  ONE: Object.freeze(new Decimal(1)),

  /** Два */
  TWO: Object.freeze(new Decimal(2)),

  /** Десять */
  TEN: Object.freeze(new Decimal(10)),

  /** Сто */
  HUNDRED: Object.freeze(new Decimal(100)),
} as const);
