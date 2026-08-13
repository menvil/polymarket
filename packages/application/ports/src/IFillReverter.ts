/**
 * Порт: откат применённого fill к Portfolio.
 *
 * @remarks
 * IFillReverter используется FillOrchestrator при получении FILL_FAILED события
 * (on-chain revert после MATCHED). При early-processing fill уже применён к Portfolio —
 * этот интерфейс позволяет оркестратору откатить его без прямой зависимости от
 * конкретной реализации PortfolioService.
 *
 * Реализуется PortfolioService из @polymarket/use-cases.
 *
 * @example
 * ```typescript
 * const reverter: IFillReverter = portfolioService;
 * const result = reverter.reverseFill(fill);
 * if (!result.ok) {
 *   logger.error('Reversal failed', { error: result.error.message });
 * }
 * ```
 */

import type { Result } from '@polymarket/result';
import type { TradingError } from '@polymarket/errors';
import type { Fill } from '@polymarket/fill';

/** Порт отката применённого fill — см. описание модуля выше. */
export interface IFillReverter {
  /**
   * Откатывает ранее применённый fill из Portfolio.
   *
   * @param fill - Fill для отката
   * @returns Ok если откат успешен, Err с описанием ошибки
   */
  reverseFill(fill: Fill): Result<void, TradingError>;
}
