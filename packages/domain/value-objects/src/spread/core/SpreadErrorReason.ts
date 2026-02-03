/**
 * Типизированные причины ошибок для Spread
 *
 * @remarks
 * Централизованный enum для всех типов ошибок в Spread module.
 * Используется как в Core (InvariantViolation), так и в Facade (InvalidSpreadError).
 *
 * Аналогично:
 * - MoneyErrorReason (8 значений)
 * - PriceErrorReason (10 значений)
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
   * Bid не является валидным Price объектом
   */
  INVALID_BID = 'INVALID_BID',

  /**
   * Ask не является валидным Price объектом
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
   * Операция приведёт к выходу за границы валидных значений
   *
   * @remarks
   * Например:
   * - tighten/widen выходит за [MIN_PRICE, MAX_PRICE]
   * - shift выходит за границы
   */
  OPERATION_OUT_OF_BOUNDS = 'OPERATION_OUT_OF_BOUNDS',

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
