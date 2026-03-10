/**
 * @polymarket/risk — Pre-trade и post-trade риск-контроль.
 *
 * @remarks
 * ### Содержимое пакета:
 * - `OrderRiskChecker` — синхронный пре-трейд риск-чекер (O(1)/O(N))
 * - `DrawdownRiskMonitor` — async пост-трейд мониторинг просадки
 * - `RiskViolationError` — ошибка нарушения риск-лимита
 * - `RiskParams` — параметры риска (все опциональные)
 * - `PreOrderCheckInput` — входные данные для пре-трейд проверки
 * - `IOrderRiskChecker` — интерфейс риск-чекера
 * - `IMarkPricesProvider` — интерфейс провайдера рыночных цен
 *
 * @example
 * ```typescript
 * import { OrderRiskChecker, type RiskParams } from '@polymarket/risk';
 * import Decimal from 'decimal.js';
 *
 * const checker = new OrderRiskChecker(
 *   { maxOpenOrders: 10, maxOrderNotional: new Decimal(5000) },
 *   logger,
 * );
 *
 * const result = checker.checkBeforeOrder(input);
 * if (!result.ok) {
 *   logger.warn('Risk check failed', { code: result.error.riskCode });
 * }
 * ```
 */
export { OrderRiskChecker } from './OrderRiskChecker.js';
export { DrawdownRiskMonitor } from './DrawdownRiskMonitor.js';
export { RiskViolationError } from './RiskViolation.js';
export type { RiskViolationCode } from './RiskViolation.js';
export type { RiskParams } from './RiskParams.js';
export type { PreOrderCheckInput } from './PreOrderCheckInput.js';
export type { IOrderRiskChecker } from './IOrderRiskChecker.js';
export type { IMarkPricesProvider } from './IMarkPricesProvider.js';
