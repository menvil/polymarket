/**
 * Интерфейс синхронного пре-трейд риск-чекера.
 *
 * @remarks
 * Реализация: OrderRiskChecker (иммутабельная — политика фиксируется в
 * конструкторе через {@link RiskPolicy} и не меняется в runtime).
 * Используется: PlaceOrderUseCase (через зависимость) для проверки перед отправкой ордера.
 *
 * @example
 * ```typescript
 * const policy = RiskPolicy.create(params);
 * if (!policy.ok) throw policy.error;
 * const checker: IOrderRiskChecker = new OrderRiskChecker(policy.value, logger);
 *
 * const result = checker.checkBeforeOrder(input);
 * if (!result.ok) {
 *   return Err(result.error); // пробрасываем RiskViolationError наверх
 * }
 * ```
 */
import type { Result } from '@polymarket/result';
import type { RiskViolationError } from './RiskViolation.js';
import type { PreOrderCheckInput } from './PreOrderCheckInput.js';

export interface IOrderRiskChecker {
  /**
   * Выполняет пре-трейд риск-проверку синхронно (O(1) для большинства проверок).
   *
   * @param input - Входные данные (portfolio, openOrdersCount, side, price, size,
   *   instrumentId, pendingBuyQuantityForInstrument, timeToExpiryMs?)
   * @returns Ok(undefined) если все проверки пройдены, Err(RiskViolationError) при нарушении
   *
   * @remarks
   * Проверки выполняются в порядке от дешёвых к дорогим:
   * 0. expiry (minTimeToExpiryMs) — O(1), только BUY (SELL не блокируется)
   * 1. maxOpenOrders — O(1)
   * 2. maxOrderNotional — O(1)
   * 3. minAvailableBalance — O(1), только BUY
   * 4. maxPositionSize — O(1), только BUY; проекция включает pending BUY quantity
   * 5. maxTotalExposure — O(N), только BUY; включает reserved USDC
   */
  checkBeforeOrder(input: PreOrderCheckInput): Result<void, RiskViolationError>;
}
