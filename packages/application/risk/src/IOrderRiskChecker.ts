/**
 * Интерфейс синхронного пре-трейд риск-чекера.
 *
 * @remarks
 * Реализация: OrderRiskChecker.
 * Используется: PlaceOrderUseCase (через зависимость) для проверки перед отправкой ордера.
 *
 * @example
 * ```typescript
 * const checker: IOrderRiskChecker = new OrderRiskChecker(params, logger);
 *
 * const result = checker.checkBeforeOrder(input);
 * if (!result.ok) {
 *   return Err(result.error); // пробрасываем RiskViolationError наверх
 * }
 * ```
 */
import type { Result } from '@polymarket/result';
import type { RiskParams } from './RiskParams.js';
import type { RiskViolationError } from './RiskViolation.js';
import type { PreOrderCheckInput } from './PreOrderCheckInput.js';

export interface IOrderRiskChecker {
  /**
   * Выполняет пре-трейд риск-проверку синхронно (O(1) для большинства проверок).
   *
   * @param input - Входные данные (portfolio, openOrdersCount, side, price, size, instrumentId)
   * @returns Ok(undefined) если все проверки пройдены, Err(RiskViolationError) при нарушении
   *
   * @remarks
   * Проверки выполняются в порядке от дешёвых к дорогим:
   * 1. maxOpenOrders — O(1)
   * 2. maxOrderNotional — O(1)
   * 3. minAvailableBalance — O(1)
   * 4. maxPositionSize — O(1), portfolio.getPosition(instrumentId)
   * 5. maxTotalExposure — O(N), итерация позиций по cost basis
   */
  checkBeforeOrder(input: PreOrderCheckInput): Result<void, RiskViolationError>;

  /**
   * Обновляет параметры риска в runtime.
   *
   * @param params - Частичные новые параметры (только изменяемые поля)
   *
   * @remarks
   * Применяется немедленно — следующий вызов checkBeforeOrder использует новые параметры.
   */
  updateParams(params: Partial<RiskParams>): void;
}
