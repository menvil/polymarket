/**
 * Risk-события — нарушения лимитов.
 *
 * @remarks
 * RiskLimitBreachedEvent публикуется OrderRiskChecker или DrawdownRiskMonitor.
 * StrategyRunner подписывается и останавливает стратегию при нарушении.
 */
import type { AccountId } from '@polymarket/ids';
import type { Timestamp } from '@polymarket/value-objects';

/**
 * Тип нарушения риск-лимита.
 *
 * @remarks
 * - DRAWDOWN — превышен лимит просадки (по realizedPnL)
 * - POSITION_LIMIT — превышен лимит размера позиции
 * - TOTAL_EXPOSURE — превышен лимит общей экспозиции
 * - OPEN_ORDERS — превышен лимит количества открытых ордеров
 */
export type RiskViolationType = 'DRAWDOWN' | 'POSITION_LIMIT' | 'TOTAL_EXPOSURE' | 'OPEN_ORDERS';

/**
 * Нарушение риск-лимита.
 *
 * @remarks
 * Если strategyId undefined — системное нарушение (остановить всё).
 * Если strategyId указан — нарушение конкретной стратегии.
 * accountId идентифицирует аккаунт для мульти-аккаунтных сценариев.
 */
export interface RiskLimitBreachedEvent {
  readonly type: 'RISK_LIMIT_BREACHED';
  /** Тип нарушения */
  readonly violationType: RiskViolationType;
  /** Human-readable описание нарушения */
  readonly violation: string;
  /** Timestamp момента обнаружения */
  readonly triggeredAt: Timestamp;
  /** ID стратегии (если undefined — системное нарушение, остановить всё) */
  readonly strategyId?: string;
  /** ID аккаунта, для которого обнаружено нарушение (для мульти-аккаунтной торговли) */
  readonly accountId?: AccountId;
}
