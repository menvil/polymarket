/**
 * Inventory services barrel export
 *
 * @remarks
 * Exports all inventory-related domain services.
 */
export { PositionTracker } from './PositionTracker.js';
export type { PositionMetrics } from './PositionTracker.js';

export { LotAccountingService } from './LotAccountingService.js';
export type { FIFORemovalResult, LotSummary } from './LotAccountingService.js';

export { HedgeRatioCalculator } from './HedgeRatioCalculator.js';
export type { HedgeRatioResult } from './HedgeRatioCalculator.js';
