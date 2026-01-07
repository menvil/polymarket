/**
 * Risk services barrel export
 *
 * @remarks
 * Exports all risk-related domain services:
 * - **RiskAssessmentService**: Risk evaluation and mode determination
 * - **EdgeAliveEvaluator**: Layer 0 edge liveness detection
 * - **PayoffCalculator**: P&L and payoff calculations
 * - **MarginCalculator**: Margin requirements
 */
export { RiskAssessmentService } from './RiskAssessmentService.js';
export type {
  RiskConfig,
  RiskStatus,
  TradingMode,
  RiskAssessment,
  TradeRecord,
} from './RiskAssessmentService.js';

export { EdgeAliveEvaluator, DEFAULT_EDGE_ALIVE_CONFIG } from './EdgeAliveEvaluator.js';
export type {
  EdgeAliveConfig,
  EdgeState,
  EdgeEvaluation,
} from './EdgeAliveEvaluator.js';

export { PayoffCalculator } from './PayoffCalculator.js';
export type { PayoffResult } from './PayoffCalculator.js';

export { MarginCalculator } from './MarginCalculator.js';
export type { MarginRequirement } from './MarginCalculator.js';
