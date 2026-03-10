/**
 * Параметры риск-менеджмента.
 *
 * @remarks
 * Все поля опциональны — undefined означает «лимит не задан».
 * OrderRiskChecker проверяет только те лимиты, которые заданы.
 * Можно обновлять в runtime через OrderRiskChecker.updateParams().
 *
 * @example
 * ```typescript
 * const params: RiskParams = {
 *   maxOpenOrders: 10,
 *   maxOrderNotional: new Decimal(5000),
 *   maxDrawdown: new Decimal(0.1), // 10%
 * };
 * ```
 */
import type Decimal from 'decimal.js';

export interface RiskParams {
  /** Максимальный размер позиции по одному инструменту (в токенах) */
  readonly maxPositionSize?: Decimal;
  /** Максимальный total notional exposure по всем позициям (в USDC, по cost basis) */
  readonly maxTotalExposure?: Decimal;
  /** Максимальная просадка от пика портфеля (0–1, например 0.1 = 10%) */
  readonly maxDrawdown?: Decimal;
  /** Максимальный notional одного ордера (в USDC) */
  readonly maxOrderNotional?: Decimal;
  /** Максимальное количество одновременно открытых ордеров */
  readonly maxOpenOrders?: number;
  /** Минимальный доступный баланс после резервирования (в USDC) */
  readonly minAvailableBalance?: Decimal;
}
