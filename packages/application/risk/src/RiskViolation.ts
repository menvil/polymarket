/**
 * Ошибка нарушения риск-лимита.
 *
 * @remarks
 * Расширяет TradingError для типизированных нарушений пре-трейд риска.
 * riskCode идентифицирует конкретный лимит, который был нарушен.
 * Возвращается через Result<void, RiskViolationError> из OrderRiskChecker.
 *
 * @example
 * ```typescript
 * const result = checker.checkBeforeOrder(input);
 * if (!result.ok) {
 *   logger.warn('Risk limit violated', {
 *     code: result.error.riskCode,
 *     message: result.error.message,
 *   });
 * }
 * ```
 */
import { TradingError } from '@polymarket/errors';

/**
 * Коды нарушений пре-трейд риск-проверок.
 *
 * @remarks
 * - TOO_CLOSE_TO_EXPIRY — слишком близко к экспирации рынка (или рынок уже истёк)
 * - RISK_INPUT_INCOMPLETE — обязательные для проверки данные недоступны/повреждены
 *   (expiry-лимит включён, а метаданные/expiry отсутствуют; NaN/отрицательный
 *   pending; невалидный openOrdersCount): fail-closed — BUY блокируется
 * - RISK_STATE_UNAVAILABLE — не удалось ПОЛУЧИТЬ authoritative risk-состояние
 *   (например, submission journal вернул ошибку при расчёте pending BUY-экспозиции):
 *   fail-closed на уровне оркестрации (PlaceOrderUseCase), метрики отличают его
 *   от нарушения лимита
 * - MAX_OPEN_ORDERS_EXCEEDED — слишком много открытых ордеров
 * - ORDER_NOTIONAL_EXCEEDED — notional одного ордера превышает лимит
 * - INSUFFICIENT_AVAILABLE_BALANCE — недостаточно свободного баланса
 * - POSITION_LIMIT_EXCEEDED — позиция превысит максимальный размер
 * - TOTAL_EXPOSURE_EXCEEDED — совокупная экспозиция превысит лимит
 */
export type RiskViolationCode =
  | 'TOO_CLOSE_TO_EXPIRY'
  | 'RISK_INPUT_INCOMPLETE'
  | 'RISK_STATE_UNAVAILABLE'
  | 'MAX_OPEN_ORDERS_EXCEEDED'
  | 'ORDER_NOTIONAL_EXCEEDED'
  | 'INSUFFICIENT_AVAILABLE_BALANCE'
  | 'POSITION_LIMIT_EXCEEDED'
  | 'TOTAL_EXPOSURE_EXCEEDED';

/**
 * Типизированная ошибка нарушения риск-лимита.
 *
 * @remarks
 * Назначение и пример использования — см. докблок модуля выше.
 */
export class RiskViolationError extends TradingError {
  public readonly severity = 'medium' as const;
  /** Код нарушенного лимита */
  public readonly riskCode: RiskViolationCode;

  /**
   * @param riskCode - Код нарушенного лимита
   * @param message - Human-readable описание нарушения
   * @param context - Дополнительный контекст (текущие значения, лимиты)
   */
  constructor(
    riskCode: RiskViolationCode,
    message: string,
    context?: Record<string, unknown>,
  ) {
    super(message, { context });
    this.riskCode = riskCode;
  }
}
