/**
 * RejectReason - причина отклонения ордера venue
 *
 * @remarks
 * Типизированные причины для статуса REJECTED.
 * Используется в discriminated union OrderStatus.
 *
 * ### Категории причин:
 * - **Validation errors**: некорректные параметры ордера (price, size)
 * - **Market state**: рынок закрыт, торги приостановлены
 * - **System errors**: ошибки venue, timeout, connectivity
 * - **Business rules**: дубликаты, лимиты venue
 *
 * @example
 * ```typescript
 * import { RejectReason, OrderStatus } from './value-objects';
 *
 * // Venue отклонил из-за некорректной цены
 * const status = OrderStatus.rejected(RejectReason.INVALID_PRICE);
 *
 * // Рынок закрыт
 * const status2 = OrderStatus.rejected(RejectReason.MARKET_CLOSED);
 * ```
 */

/**
 * Типизированные причины отклонения ордера venue
 */
export enum RejectReason {
  /**
   * Некорректная цена
   *
   * @remarks
   * Venue отклонил ордер из-за невалидной цены:
   * - Цена вне допустимого диапазона [0, 1] для probability markets
   * - Цена не соответствует tick size
   * - Отрицательная цена
   * - Цена NaN или Infinity
   */
  INVALID_PRICE = 'INVALID_PRICE',

  /**
   * Размер меньше минимального
   *
   * @remarks
   * Ордер отклонен потому что size < min order size venue.
   * Каждый venue имеет минимальный размер ордера (например, $1 или 10 contracts).
   */
  BELOW_MIN_SIZE = 'BELOW_MIN_SIZE',

  /**
   * Размер больше максимального
   *
   * @remarks
   * Ордер отклонен потому что size > max order size venue.
   * Venue может ограничивать максимальный размер для защиты от fat finger errors.
   */
  ABOVE_MAX_SIZE = 'ABOVE_MAX_SIZE',

  /**
   * Рынок закрыт
   *
   * @remarks
   * Venue отклонил ордер потому что:
   * - Рынок еще не открылся (pre-market)
   * - Рынок уже закрылся (post-market)
   * - Рынок resolved (событие произошло)
   */
  MARKET_CLOSED = 'MARKET_CLOSED',

  /**
   * Торги приостановлены
   *
   * @remarks
   * Торги временно приостановлены venue:
   * - Trading halt из-за volatility
   * - Circuit breaker triggered
   * - Investigation pending
   * - Waiting for resolution
   */
  MARKET_HALTED = 'MARKET_HALTED',

  /**
   * Дубликат ордера
   *
   * @remarks
   * Venue отклонил ордер потому что ордер с таким ID уже существует.
   * Может произойти при:
   * - Повторной отправке (retry)
   * - Network issues с дублированием
   * - ID collision
   */
  DUPLICATE_ORDER = 'DUPLICATE_ORDER',

  /**
   * Неизвестный инструмент
   *
   * @remarks
   * Venue не знает указанный instrument/market:
   * - Некорректный instrument ID
   * - Market delisted
   * - Token ID не существует
   */
  UNKNOWN_INSTRUMENT = 'UNKNOWN_INSTRUMENT',

  /**
   * Недостаточная ликвидность
   *
   * @remarks
   * Venue отклонил ордер потому что:
   * - Orderbook пустой (no liquidity)
   * - Requested size превышает available liquidity
   * - IOC/FOK не может быть исполнен
   */
  INSUFFICIENT_LIQUIDITY = 'INSUFFICIENT_LIQUIDITY',

  /**
   * Самопересечение запрещено
   *
   * @remarks
   * Venue отклонил ордер потому что он пересекается с собственными ордерами
   * этого же аккаунта (self-trade prevention).
   */
  SELF_TRADE_PREVENTION = 'SELF_TRADE_PREVENTION',

  /**
   * Превышен rate limit
   *
   * @remarks
   * Venue отклонил ордер из-за rate limiting:
   * - Слишком много requests за короткое время
   * - Превышен orders per second limit
   * - API quota exhausted
   */
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',

  /**
   * Ошибка venue
   *
   * @remarks
   * Внутренняя ошибка venue:
   * - Internal server error (500)
   * - Database error
   * - Service unavailable
   * - Timeout
   */
  VENUE_ERROR = 'VENUE_ERROR',

  /**
   * Невалидный аккаунт
   *
   * @remarks
   * Venue отклонил ордер из-за проблем с аккаунтом:
   * - Аккаунт не существует
   * - Аккаунт suspended
   * - Аккаунт not verified
   * - KYC required
   */
  INVALID_ACCOUNT = 'INVALID_ACCOUNT',

  /**
   * Недостаточные разрешения
   *
   * @remarks
   * Аккаунт не имеет прав для этой операции:
   * - Trading permissions disabled
   * - Market-specific restrictions
   * - Geographic restrictions
   */
  INSUFFICIENT_PERMISSIONS = 'INSUFFICIENT_PERMISSIONS',

  /**
   * Невалидный тип ордера
   *
   * @remarks
   * Venue не поддерживает указанный тип ордера:
   * - Unsupported order type (STOP, TRAILING_STOP)
   * - Unsupported time-in-force (GTD не поддерживается)
   */
  INVALID_ORDER_TYPE = 'INVALID_ORDER_TYPE',
}

/**
 * Список всех возможных причин отклонения
 */
export const REJECT_REASONS: readonly RejectReason[] = [
  RejectReason.INVALID_PRICE,
  RejectReason.BELOW_MIN_SIZE,
  RejectReason.ABOVE_MAX_SIZE,
  RejectReason.MARKET_CLOSED,
  RejectReason.MARKET_HALTED,
  RejectReason.DUPLICATE_ORDER,
  RejectReason.UNKNOWN_INSTRUMENT,
  RejectReason.INSUFFICIENT_LIQUIDITY,
  RejectReason.SELF_TRADE_PREVENTION,
  RejectReason.RATE_LIMIT_EXCEEDED,
  RejectReason.VENUE_ERROR,
  RejectReason.INVALID_ACCOUNT,
  RejectReason.INSUFFICIENT_PERMISSIONS,
  RejectReason.INVALID_ORDER_TYPE,
] as const;

/**
 * Проверяет валидность причины отклонения (runtime валидация)
 *
 * @param value - Значение для проверки
 * @returns True если value является валидным RejectReason
 *
 * @remarks
 * Используется для валидации JSON данных при десериализации.
 *
 * @example
 * ```typescript
 * console.log(isValidRejectReason('INVALID_PRICE'));  // true
 * console.log(isValidRejectReason('INVALID'));        // false
 * ```
 */
export function isValidRejectReason(value: unknown): value is RejectReason {
  return typeof value === 'string' && REJECT_REASONS.includes(value as RejectReason);
}
