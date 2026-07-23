/**
 * Параметры риск-менеджмента.
 *
 * @remarks
 * Все поля опциональны — undefined означает «лимит не задан».
 * OrderRiskChecker проверяет только те лимиты, которые заданы.
 *
 * ### Иммутабельность:
 * `RiskParams` — это «сырой» вход. Перед использованием он ОБЯЗАН быть
 * провалидирован через {@link RiskPolicy.create} — только валидная `RiskPolicy`
 * передаётся в `OrderRiskChecker`. Runtime-обновление параметров намеренно
 * убрано: checker иммутабелен на всё время жизни (см. `RiskPolicy`).
 *
 * @example
 * ```typescript
 * const policy = RiskPolicy.create({
 *   maxOpenOrders: 10,
 *   maxOrderNotional: new Decimal(5000),
 * });
 * if (!policy.ok) throw policy.error;
 * const checker = new OrderRiskChecker(policy.value, logger);
 * ```
 */
import type Decimal from 'decimal.js';

export interface RiskParams {
  /** Максимальный размер позиции по одному инструменту (в токенах) */
  readonly maxPositionSize?: Decimal;
  /** Максимальный total notional exposure по всем позициям (в USDC, по cost basis) */
  readonly maxTotalExposure?: Decimal;
  /** Максимальный notional одного ордера (в USDC) */
  readonly maxOrderNotional?: Decimal;
  /**
   * Максимальное количество одновременно открытых ордеров.
   *
   * @remarks
   * Сравнивается с `PreOrderCheckInput.openOrdersCount` — сейчас это per-strategy
   * счётчик (`countByStrategyId`), НЕ account-wide: `UNKNOWN`/`VENUE_ACCEPTED`
   * submissions без локального Order и ордера других стратегий не учитываются.
   * Account-wide active-commitment политика — отдельная будущая задача.
   */
  readonly maxOpenOrders?: number;
  /** Минимальный доступный баланс после резервирования (в USDC) */
  readonly minAvailableBalance?: Decimal;
  /** Минимальное время до экспирации рынка (ms) — не размещать BUY-ордера если осталось меньше. SELL разрешён. */
  readonly minTimeToExpiryMs?: number;
}
