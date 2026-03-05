/**
 * Liquidity - тип ликвидности исполнения ордера
 *
 * @remarks
 * Определяет роль участника в сделке:
 * - **MAKER** — пассивная сторона: участник разместил ордер в orderbook
 *   и ждал, пока его исполнят. Обычно получает скидку на комиссию.
 * - **TAKER** — агрессивная сторона: участник исполнил ордер из orderbook.
 *   Обычно платит более высокую комиссию.
 *
 * ### Использование:
 * Liquidity используется в Fill entity для:
 * - Классификации комиссии (maker fee vs taker fee)
 * - Аналитики strategy performance (maker ratio)
 * - PnL расчётов с учётом типа ликвидности
 *
 * @example
 * ```typescript
 * import { Liquidity, isValidLiquidity } from './Liquidity';
 *
 * const liq: Liquidity = 'MAKER';
 * console.log(isValidLiquidity(liq)); // true
 * console.log(isValidLiquidity('UNKNOWN')); // false
 *
 * // Проверка ликвидности через ExecutionMetadata
 * if (metadata.liquidity === 'MAKER') {
 *   applyMakerFeeDiscount(fill);
 * }
 * ```
 */

/**
 * Типы ликвидности исполнения ордера
 *
 * @remarks
 * MAKER — участник создал liquidity (разместил пассивный ордер).
 * TAKER — участник взял liquidity (исполнил ордер aggressively).
 */
export type Liquidity = 'MAKER' | 'TAKER';

/**
 * Все допустимые значения Liquidity
 *
 * @example
 * ```typescript
 * for (const liq of ALL_LIQUIDITY) {
 *   console.log(liq); // 'MAKER', 'TAKER'
 * }
 * ```
 */
export const ALL_LIQUIDITY: readonly Liquidity[] = Object.freeze(['MAKER', 'TAKER'] as const);

/**
 * Type guard для Liquidity
 *
 * @param v - Значение для проверки
 * @returns true если v является валидным Liquidity
 *
 * @remarks
 * Используется для runtime валидации при парсинге внешних данных.
 *
 * @example
 * ```typescript
 * const raw = 'MAKER';
 * if (isValidLiquidity(raw)) {
 *   // TypeScript теперь знает что raw: Liquidity
 *   const liq: Liquidity = raw;
 * }
 * ```
 */
export function isValidLiquidity(v: unknown): v is Liquidity {
  return v === 'MAKER' || v === 'TAKER';
}
