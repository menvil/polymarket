/**
 * CancelReason - причина отмены ордера
 *
 * @remarks
 * Типизированные причины для статуса CANCELED.
 * Используется в discriminated union OrderStatus.
 *
 * ### Категории причин:
 * - **User actions**: пользователь явно отменил
 * - **System constraints**: система отменила (недостаточно средств, лимиты)
 * - **Strategy logic**: стратегия отменила (позиция закрыта, условия изменились)
 *
 * @example
 * ```typescript
 * import { CancelReason, OrderStatus } from './value-objects';
 *
 * // Пользователь отменил ордер
 * const status = OrderStatus.canceled(CancelReason.USER_REQUESTED);
 *
 * // Система отменила из-за баланса
 * const status2 = OrderStatus.canceled(CancelReason.INSUFFICIENT_BALANCE);
 * ```
 */

/**
 * Типизированные причины отмены ордера
 */
export enum CancelReason {
  /**
   * Пользователь явно запросил отмену
   *
   * @remarks
   * Самая распространенная причина отмены.
   * Пользователь нажал "Cancel" в UI или отправил cancel request через API.
   */
  USER_REQUESTED = 'USER_REQUESTED',

  /**
   * Недостаточно средств на балансе
   *
   * @remarks
   * Система отменила ордер потому что:
   * - Баланс стал меньше required margin
   * - Другие ордера заняли доступные средства
   * - Вывод средств уменьшил баланс
   */
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',

  /**
   * Превышен лимит риска
   *
   * @remarks
   * Risk management система отменила ордер:
   * - Превышен max position size
   * - Превышен max exposure по активу
   * - Превышен max leverage
   * - Portfolio risk limits
   */
  RISK_LIMIT_EXCEEDED = 'RISK_LIMIT_EXCEEDED',

  /**
   * Связанная позиция закрыта
   *
   * @remarks
   * Ордер был размещен для управления позицией (stop-loss, take-profit),
   * но позиция была закрыта другим способом.
   */
  POSITION_CLOSED = 'POSITION_CLOSED',

  /**
   * Стратегия остановлена
   *
   * @remarks
   * Trading bot или стратегия остановлена:
   * - Пользователь остановил бота
   * - Система остановила из-за ошибок
   * - Scheduled shutdown
   */
  STRATEGY_STOPPED = 'STRATEGY_STOPPED',

  /**
   * Заменен новым ордером
   *
   * @remarks
   * Ордер отменен потому что был заменен на новый (modify = cancel + new).
   * Replace operation: старый ордер отменяется, новый создается.
   */
  REPLACED_BY_NEW = 'REPLACED_BY_NEW',

  /**
   * Условия рынка изменились
   *
   * @remarks
   * Стратегия отменила ордер потому что:
   * - Market spread слишком широкий
   * - Volatility слишком высокая
   * - Liquidity недостаточна
   */
  MARKET_CONDITIONS_CHANGED = 'MARKET_CONDITIONS_CHANGED',

  /**
   * Административная отмена
   *
   * @remarks
   * Система или администратор отменил ордер:
   * - Maintenance mode
   * - Emergency shutdown
   * - Compliance requirements
   */
  ADMINISTRATIVE = 'ADMINISTRATIVE',
}

/**
 * Список всех возможных причин отмены
 */
export const CANCEL_REASONS: readonly CancelReason[] = [
  CancelReason.USER_REQUESTED,
  CancelReason.INSUFFICIENT_BALANCE,
  CancelReason.RISK_LIMIT_EXCEEDED,
  CancelReason.POSITION_CLOSED,
  CancelReason.STRATEGY_STOPPED,
  CancelReason.REPLACED_BY_NEW,
  CancelReason.MARKET_CONDITIONS_CHANGED,
  CancelReason.ADMINISTRATIVE,
] as const;

/**
 * Проверяет валидность причины отмены (runtime валидация)
 *
 * @param value - Значение для проверки
 * @returns True если value является валидным CancelReason
 *
 * @remarks
 * Используется для валидации JSON данных при десериализации.
 *
 * @example
 * ```typescript
 * console.log(isValidCancelReason('USER_REQUESTED'));  // true
 * console.log(isValidCancelReason('INVALID'));         // false
 * ```
 */
export function isValidCancelReason(value: unknown): value is CancelReason {
  return typeof value === 'string' && CANCEL_REASONS.includes(value as CancelReason);
}
