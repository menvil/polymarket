/**
 * Типизированные причины ошибок для Side операций
 *
 * @remarks
 * Используется в ValidationError.context.reason для дифференциации ошибок
 * на уровне типов вместо строковых констант.
 *
 * Для Side набор ошибок минимален, так как это простой enum type.
 *
 * @example
 * ```typescript
 * import { SideErrorReason } from '@polymarket/value-objects';
 *
 * const result = SideService.fromString('INVALID');
 * if (!result.ok && result.error.context?.reason === SideErrorReason.INVALID_VALUE) {
 *   console.error('Invalid side value provided');
 * }
 * ```
 */
export enum SideErrorReason {
  /**
   * Значение является строкой, но не валидным Side
   *
   * @remarks
   * Возникает когда передан string, который не является валидным Side:
   * - 'buy' (lowercase)
   * - 'INVALID'
   * - пустая строка
   * - любой другой string кроме тех что в ALL_SIDES
   *
   * Для не-string типов см. INVALID_TYPE.
   */
  INVALID_VALUE = 'INVALID_VALUE',

  /**
   * Значение имеет неверный тип (не string)
   *
   * @remarks
   * Возникает при fromUnknown() когда значение не является string:
   * - number, boolean, symbol
   * - null, undefined
   * - object, array
   */
  INVALID_TYPE = 'INVALID_TYPE',
}
