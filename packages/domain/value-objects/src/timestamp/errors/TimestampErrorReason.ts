/**
 * Типизированные причины ошибок Timestamp
 *
 * @remarks
 * Используется в ValidationError.context.reason для идентификации типа ошибки.
 */
export enum TimestampErrorReason {
  /**
   * Значение не является конечным числом (NaN, Infinity)
   */
  NOT_FINITE = 'NOT_FINITE',

  /**
   * Значение не положительное (<= 0)
   */
  NOT_POSITIVE = 'NOT_POSITIVE',

  /**
   * Невалидный Date объект
   */
  INVALID_DATE = 'INVALID_DATE',

  /**
   * Невалидная ISO 8601 строка
   */
  INVALID_ISO = 'INVALID_ISO',

  /**
   * Delta не является конечным числом
   */
  INVALID_DELTA = 'INVALID_DELTA',
}
