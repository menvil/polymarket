/**
 * MarketStatus — тип статуса рынка
 *
 * @remarks
 * Статус рынка определяет его текущее состояние в жизненном цикле.
 * Используется как дискриминатор в MarketState.
 *
 * ### Жизненный цикл:
 * ```
 * ACTIVE → CLOSED → RESOLVED
 * ```
 *
 * @example
 * ```typescript
 * const status: MarketStatus = 'ACTIVE';
 * if (isValidMarketStatus(someString)) {
 *   // someString типизирован как MarketStatus
 * }
 * ```
 */

/**
 * MarketStatus — возможные статусы рынка
 */
export type MarketStatus = 'ACTIVE' | 'CLOSED' | 'RESOLVED';

/**
 * Список всех допустимых значений MarketStatus
 */
export const MARKET_STATUS_VALUES: readonly MarketStatus[] = [
  'ACTIVE',
  'CLOSED',
  'RESOLVED',
] as const;

/**
 * Type guard для проверки что значение является MarketStatus
 *
 * @param v - Значение для проверки
 * @returns true если v является допустимым MarketStatus
 *
 * @example
 * ```typescript
 * isValidMarketStatus('ACTIVE');   // → true
 * isValidMarketStatus('CLOSED');   // → true
 * isValidMarketStatus('RESOLVED'); // → true
 * isValidMarketStatus('PENDING');  // → false
 * isValidMarketStatus(null);       // → false
 * ```
 */
export function isValidMarketStatus(v: unknown): v is MarketStatus {
  return typeof v === 'string' && (MARKET_STATUS_VALUES as readonly string[]).includes(v);
}
