/**
 * ExpireReason - причина истечения ордера
 *
 * @remarks
 * Типизированные причины для статуса EXPIRED.
 * Используется в discriminated union OrderStatus.
 *
 * ### Категории причин:
 * - **Time-based**: истек срок действия (GTD, session end)
 * - **Execution constraints**: не удалось исполнить в рамках ограничений (IOC, FOK, POST_ONLY)
 *
 * @example
 * ```typescript
 * import { ExpireReason, OrderStatus } from './value-objects';
 *
 * // Истек срок действия GTD ордера
 * const status = OrderStatus.expired(ExpireReason.TIME_IN_FORCE);
 *
 * // Post-only не смог разместиться без опциональной причины
 * const status2 = OrderStatus.expired();
 * ```
 */

/**
 * Типизированные причины истечения ордера
 */
export enum ExpireReason {
  /**
   * Истек срок действия (Time-In-Force)
   *
   * @remarks
   * Ордер истек потому что достигнут указанный срок:
   * - GTD (Good-Till-Date): истек указанный timestamp
   * - GTT (Good-Till-Time): истек таймер
   * - DAY: конец торгового дня
   *
   * Применимо к:
   * - Limit orders с GTD
   * - Conditional orders с expiration
   */
  TIME_IN_FORCE = 'TIME_IN_FORCE',

  /**
   * Post-only не смог разместиться
   *
   * @remarks
   * Ордер с флагом POST_ONLY истек потому что:
   * - Цена пересекает spread (стал бы taker)
   * - Немедленное исполнение невозможно без taking liquidity
   *
   * POST_ONLY гарантирует что ордер будет maker (добавляет ликвидность),
   * а не taker (забирает ликвидность). Если это невозможно, ордер expires.
   */
  POST_ONLY_FAILED = 'POST_ONLY_FAILED',

  /**
   * IOC не исполнен немедленно
   *
   * @remarks
   * Ордер IOC (Immediate-Or-Cancel) истек потому что:
   * - Не удалось исполнить немедленно
   * - Частичное исполнение, остаток отменен
   *
   * IOC требует немедленного исполнения. Если это невозможно,
   * ордер expires (не размещается в orderbook).
   */
  IOC_NOT_FILLED = 'IOC_NOT_FILLED',

  /**
   * FOK не исполнен полностью
   *
   * @remarks
   * Ордер FOK (Fill-Or-Kill) истек потому что:
   * - Невозможно исполнить полностью немедленно
   * - Недостаточно liquidity для полного исполнения
   *
   * FOK требует ПОЛНОГО немедленного исполнения (all-or-nothing).
   * Если это невозможно, ордер expires без частичного исполнения.
   */
  FOK_NOT_FILLED = 'FOK_NOT_FILLED',

  /**
   * Конец торговой сессии
   *
   * @remarks
   * Ордер истек потому что закрылась торговая сессия:
   * - End of trading day
   * - Market session closed
   * - Pre-market/After-hours ended
   *
   * Применимо к ордерам без explicit time-in-force,
   * которые автоматически expires в конце сессии.
   */
  MARKET_SESSION_END = 'MARKET_SESSION_END',

  /**
   * Conditional trigger не произошел
   *
   * @remarks
   * Conditional order (stop-loss, take-profit) истек потому что:
   * - Trigger condition не выполнилось до expiration
   * - Market не достиг trigger price
   * - Позиция закрыта до trigger
   */
  CONDITIONAL_NOT_TRIGGERED = 'CONDITIONAL_NOT_TRIGGERED',
}

/**
 * Список всех возможных причин истечения
 */
export const EXPIRE_REASONS: readonly ExpireReason[] = [
  ExpireReason.TIME_IN_FORCE,
  ExpireReason.POST_ONLY_FAILED,
  ExpireReason.IOC_NOT_FILLED,
  ExpireReason.FOK_NOT_FILLED,
  ExpireReason.MARKET_SESSION_END,
  ExpireReason.CONDITIONAL_NOT_TRIGGERED,
] as const;

/**
 * Проверяет валидность причины истечения (runtime валидация)
 *
 * @param value - Значение для проверки
 * @returns True если value является валидным ExpireReason
 *
 * @remarks
 * Используется для валидации JSON данных при десериализации.
 *
 * @example
 * ```typescript
 * console.log(isValidExpireReason('TIME_IN_FORCE'));  // true
 * console.log(isValidExpireReason('INVALID'));        // false
 * ```
 */
export function isValidExpireReason(value: unknown): value is ExpireReason {
  return typeof value === 'string' && EXPIRE_REASONS.includes(value as ExpireReason);
}
