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
   * Значение не является валидным Side ('BUY' или 'SELL')
   *
   * @remarks
   * Возникает когда:
   * - Передан неверный string ('buy', 'INVALID', etc)
   * - Передан не-string тип (number, null, object, etc)
   */
  INVALID_VALUE = 'INVALID_VALUE',

  /**
   * Значение имеет неверный тип (не string)
   *
   * @remarks
   * Возникает при fromUnknown() когда значение не является string.
   */
  INVALID_TYPE = 'INVALID_TYPE',
}
