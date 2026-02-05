import type { VenueId } from '../core/VenueId.js';
import { KnownVenues } from '../core/VenueId.js';

/**
 * ExecutionVenueId - место исполнения (куда отправляются ордера)
 *
 * @remarks
 * Отвечает на вопрос: "КУДА мы ОТПРАВЛЯЕМ ордера?"
 *
 * Используется в:
 * - Order (куда отправлен ордер)
 * - Fill (где исполнился ордер)
 *
 * Разделение Live vs Simulation:
 * - Live venues: Реальное исполнение на бирже
 * - SIMULATOR: Виртуальное исполнение (backtest, paper trading)
 *
 * @example
 * ```typescript
 * // Live trading
 * const order = {
 *   venueId: 'POLYMARKET' as ExecutionVenueId,
 *   side: 'BUY',
 *   price: 0.48
 * };
 *
 * // Backtest
 * const simulatedOrder = {
 *   venueId: 'SIMULATOR' as ExecutionVenueId,
 *   side: 'BUY',
 *   price: 0.48
 * };
 * ```
 */
export type ExecutionVenueId =
  | 'POLYMARKET'
  | 'KALSHI'
  | 'SIMULATOR'
  | (string & { readonly __brand: 'ExecutionVenueId' });

/**
 * Известные execution venues
 */
export const KnownExecutionVenues = {
  POLYMARKET: 'POLYMARKET' as ExecutionVenueId,
  KALSHI: 'KALSHI' as ExecutionVenueId,
  SIMULATOR: 'SIMULATOR' as ExecutionVenueId,
} as const;

/**
 * Mapping: ExecutionVenueId → VenueId
 *
 * @remarks
 * SIMULATOR не мапится в VenueId (это виртуальный venue).
 *
 * @example
 * ```typescript
 * executionToVenue('POLYMARKET')  // → 'POLYMARKET'
 * executionToVenue('KALSHI')      // → 'KALSHI'
 * executionToVenue('SIMULATOR')   // → undefined
 * ```
 */
export function executionToVenue(venueId: ExecutionVenueId): VenueId | undefined {
  if (venueId === 'SIMULATOR') {
    return undefined;
  }

  if (venueId === 'POLYMARKET') {
    return KnownVenues.POLYMARKET;
  }

  if (venueId === 'KALSHI') {
    return KnownVenues.KALSHI;
  }

  return venueId as VenueId;
}

/**
 * Проверка что venue является симуляцией
 */
export function isSimulator(venueId: ExecutionVenueId): boolean {
  return venueId === 'SIMULATOR';
}

/**
 * Проверка что venue является live
 */
export function isLiveVenue(venueId: ExecutionVenueId): boolean {
  return !isSimulator(venueId);
}
