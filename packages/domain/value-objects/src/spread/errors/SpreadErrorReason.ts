/**
 * Типизированные причины ошибок для Spread
 *
 * @remarks
 * Централизованный enum для всех типов ошибок в Spread module.
 * Используется как в Core (InvariantViolation), так и в Facade (InvalidSpreadError).
 *
 * Аналогично:
 * - MoneyErrorReason (8 значений)
 * - OutcomePriceErrorReason (10 значений)
 * - QuantityErrorReason (8 значений)
 */
export enum SpreadErrorReason {
  // ============================================================================
  // Invariant Violations (Core)
  // ============================================================================

  /**
   * Bid цена превышает ask цену
   *
   * @remarks
   * Основной инвариант spread: bid <= ask.
   * Нарушение означает кросс рынка (арбитражная ситуация).
   */
  BID_GREATER_THAN_ASK = 'BID_GREATER_THAN_ASK',

  /**
   * Bid не является валидным OutcomePrice объектом
   */
  INVALID_BID = 'INVALID_BID',

  /**
   * Ask не является валидным OutcomePrice объектом
   */
  INVALID_ASK = 'INVALID_ASK',

  // ============================================================================
  // Width Constraints (Rules)
  // ============================================================================

  /**
   * Ширина спреда меньше минимальной
   *
   * @remarks
   * Используется в ValidateMinWidth rule.
   */
  WIDTH_TOO_SMALL = 'WIDTH_TOO_SMALL',

  /**
   * Ширина спреда превышает максимальную
   *
   * @remarks
   * Используется в ValidateMaxWidth rule.
   */
  WIDTH_TOO_LARGE = 'WIDTH_TOO_LARGE',

  // ============================================================================
  // Operation Errors (Facade)
  // ============================================================================

  /**
   * Ошибка парсинга значения
   *
   * @remarks
   * Используется при парсинге входных параметров (bid, ask, amount).
   * Например: невалидный строковый формат, NaN, non-finite values.
   */
  INVALID_FORMAT = 'INVALID_FORMAT',

  /**
   * Невалидная величина для операции (tighten/widen/shift)
   *
   * @remarks
   * Amount должен быть:
   * - Finite
   * - Non-negative (для tighten/widen)
   * - Finite (для shift, может быть отрицательным)
   */
  INVALID_AMOUNT = 'INVALID_AMOUNT',

  /**
   * Невалидная ширина spread
   *
   * @remarks
   * Width должна быть:
   * - Finite
   * - Non-negative
   * Используется в fromMidAndWidth
   */
  INVALID_WIDTH = 'INVALID_WIDTH',

  /**
   * Операция приведёт к выходу за границы валидных значений
   *
   * @remarks
   * Например:
   * - tighten/widen выходит за [MIN_PRICE, MAX_PRICE]
   * - shift выходит за границы
   */
  OPERATION_OUT_OF_BOUNDS = 'OPERATION_OUT_OF_BOUNDS',

  // ============================================================================
  // Ratio Operations (Facade)
  // ============================================================================

  /**
   * Операция требует two-sided spread (bid и ask определены)
   *
   * @remarks
   * Используется в Ratio operations (shiftByRatio, widenByRatio, etc.)
   * которые требуют вычисления midpoint.
   */
  NOT_TWO_SIDED = 'NOT_TWO_SIDED',

  /**
   * Midpoint недоступен или равен нулю
   *
   * @remarks
   * Используется в getSpreadRatio когда midpoint = 0
   * (теоретически невозможно для OutcomePrice, но защита).
   */
  MID_UNAVAILABLE = 'MID_UNAVAILABLE',

  /**
   * Невалидный Ratio объект
   *
   * @remarks
   * Ratio не является валидным (NaN, Infinity, etc.)
   */
  INVALID_RATIO = 'INVALID_RATIO',

  /**
   * Отрицательный Ratio не разрешён для операции
   *
   * @remarks
   * Используется в widenByRatio/tightenByRatio где deltaWidthRatio должен быть >= 0.
   */
  NEGATIVE_RATIO_NOT_ALLOWED = 'NEGATIVE_RATIO_NOT_ALLOWED',

  /**
   * Результат Ratio операции выходит за границы валидных значений
   *
   * @remarks
   * После применения Ratio операции результат выходит за границы OutcomePrice [0.0001, 0.9999]
   * или нарушает bid <= ask инвариант.
   */
  RATIO_OUT_OF_BOUNDS = 'RATIO_OUT_OF_BOUNDS',

  // ============================================================================
  // Parse/Serialization Errors (Adapters)
  // ============================================================================

  /**
   * Невалидный JSON при десериализации
   */
  INVALID_JSON = 'INVALID_JSON',

  /**
   * Невалидный DTO объект (отсутствуют поля или неверные типы)
   */
  INVALID_DTO = 'INVALID_DTO'
}
