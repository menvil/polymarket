import type { VenueId } from '../core/VenueId.js';
/**
 * SimulatorExecutionVenueId - специальный venue для симуляции
 *
 * @remarks
 * Используется для виртуального исполнения (backtest, paper trading).
 * НЕ является настоящим VenueId, так как не представляет реальную биржу.
 */
export type SimulatorExecutionVenueId = 'SIMULATOR' & {
    readonly __brand: 'SimulatorExecutionVenueId';
};
/**
 * ExecutionVenueId - место исполнения (куда отправляются ордера)
 *
 * @remarks
 * Отвечает на вопрос: "КУДА мы ОТПРАВЛЯЕМ ордера?"
 *
 * **Структура**: `ExecutionVenueId = VenueId | SimulatorExecutionVenueId`
 *
 * Используется в:
 * - Order (куда отправлен ордер)
 * - Fill (где исполнился ордер)
 *
 * Разделение Live vs Simulation:
 * - Live venues (VenueId): Реальное исполнение на бирже
 * - SIMULATOR: Виртуальное исполнение (backtest, paper trading)
 *
 * @example
 * ```typescript
 * import { KnownVenues, SIMULATOR, asExecutionVenueId } from '@polymarket/ids';
 *
 * // Live trading (VenueId)
 * const order = {
 *   venueId: KnownVenues.POLYMARKET as ExecutionVenueId,
 *   side: 'BUY',
 *   price: 0.48
 * };
 *
 * // Backtest (SimulatorExecutionVenueId)
 * const simulatedOrder = {
 *   venueId: SIMULATOR,
 *   side: 'BUY',
 *   price: 0.48
 * };
 *
 * // Валидация
 * const customVenue = asExecutionVenueId('MY_CUSTOM_VENUE');
 * if (customVenue) {
 *   console.log('Valid execution venue');
 * }
 * ```
 */
export type ExecutionVenueId = VenueId | SimulatorExecutionVenueId;
/**
 * Константа SIMULATOR
 */
export declare const SIMULATOR: SimulatorExecutionVenueId;
/**
 * Известные execution venues (для convenience)
 *
 * @remarks
 * Включает все известные VenueId + SIMULATOR.
 */
export declare const KnownExecutionVenues: {
    readonly POLYMARKET: ExecutionVenueId;
    readonly KALSHI: ExecutionVenueId;
    readonly SIMULATOR: ExecutionVenueId;
};
/**
 * Валидация и парсинг ExecutionVenueId
 *
 * @param raw - Строка для парсинга
 * @returns ExecutionVenueId или undefined если формат невалидный
 *
 * @remarks
 * Поддерживает:
 * - VenueId (валидация через asVenueId)
 * - 'SIMULATOR' (специальное значение)
 *
 * @example
 * ```typescript
 * asExecutionVenueId('POLYMARKET'); // → 'POLYMARKET' as ExecutionVenueId (VenueId)
 * asExecutionVenueId('SIMULATOR'); // → SIMULATOR (SimulatorExecutionVenueId)
 * asExecutionVenueId('MY_CUSTOM_VENUE'); // → 'MY_CUSTOM_VENUE' as ExecutionVenueId (VenueId)
 * asExecutionVenueId('invalid-venue'); // → undefined
 * ```
 */
export declare function asExecutionVenueId(raw: string): ExecutionVenueId | undefined;
/**
 * Mapping: ExecutionVenueId → VenueId
 *
 * @remarks
 * SIMULATOR не мапится в VenueId (это виртуальный venue).
 *
 * @example
 * ```typescript
 * executionToVenue(KnownVenues.POLYMARKET as ExecutionVenueId);  // → 'POLYMARKET' as VenueId
 * executionToVenue(SIMULATOR);   // → undefined (виртуальный venue)
 * ```
 */
export declare function executionToVenue(venueId: ExecutionVenueId): VenueId | undefined;
/**
 * Проверка что venue является симуляцией
 *
 * @param venueId - ExecutionVenueId для проверки
 * @returns true если venue является SIMULATOR
 *
 * @example
 * ```typescript
 * isSimulator(SIMULATOR); // → true
 * isSimulator(KnownVenues.POLYMARKET as ExecutionVenueId); // → false
 * ```
 */
export declare function isSimulator(venueId: ExecutionVenueId): venueId is SimulatorExecutionVenueId;
/**
 * Проверка что venue является live (не симуляцией)
 *
 * @param venueId - ExecutionVenueId для проверки
 * @returns true если venue НЕ является SIMULATOR
 *
 * @remarks
 * Live venue означает реальное исполнение ордеров на бирже,
 * в отличие от SIMULATOR (backtest, paper trading).
 *
 * @example
 * ```typescript
 * isLiveVenue(KnownVenues.POLYMARKET as ExecutionVenueId); // → true
 * isLiveVenue(SIMULATOR); // → false
 * ```
 */
export declare function isLiveVenue(venueId: ExecutionVenueId): venueId is VenueId;
//# sourceMappingURL=ExecutionVenueId.d.ts.map