/**
 * @polymarket/risk — Pre-trade риск-контроль.
 *
 * @remarks
 * ### Содержимое пакета:
 * - `OrderRiskChecker` — синхронный пре-трейд риск-чекер (O(1)/O(N)), иммутабельный
 * - `RiskPolicy` — валидированная иммутабельная политика (`create` → Result)
 * - `RiskConfigError` — ошибка невалидной риск-конфигурации
 * - `RiskViolationError` — ошибка нарушения риск-лимита
 * - `RiskParams` — «сырые» параметры риска (все опциональные)
 * - `PreOrderCheckInput` — входные данные для пре-трейд проверки
 * - `IOrderRiskChecker` — интерфейс риск-чекера
 *
 * @example
 * ```typescript
 * import { OrderRiskChecker, RiskPolicy } from '@polymarket/risk';
 * import { Money } from '@polymarket/value-objects';
 * import Decimal from 'decimal.js';
 *
 * const policy = RiskPolicy.create({ maxOpenOrders: 10, maxOrderNotional: Money.of(new Decimal(5000), 'USDC') });
 * if (!policy.ok) throw policy.error;
 * const checker = new OrderRiskChecker(policy.value, logger);
 *
 * const result = checker.checkBeforeOrder(input);
 * if (!result.ok) {
 *   logger.warn('Risk check failed', { code: result.error.riskCode });
 * }
 * ```
 */
export { OrderRiskChecker } from './OrderRiskChecker.js';
export { RiskPolicy, RiskConfigError } from './RiskPolicy.js';
export { RiskViolationError } from './RiskViolation.js';
/** Реэкспорт кодов нарушений риск-лимита (см. RiskViolation.ts). */
export type { RiskViolationCode } from './RiskViolation.js';
/** Реэкспорт «сырых» параметров риска (см. RiskParams.ts). */
export type { RiskParams } from './RiskParams.js';
/** Реэкспорт входных данных пре-трейд проверки (см. PreOrderCheckInput.ts). */
export type { PreOrderCheckInput } from './PreOrderCheckInput.js';
/** Реэкспорт порта риск-чекера (см. IOrderRiskChecker.ts). */
export type { IOrderRiskChecker } from './IOrderRiskChecker.js';
