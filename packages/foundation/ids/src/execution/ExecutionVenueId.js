import { KnownVenues, asVenueId } from '../core/VenueId.js';
/**
 * Константа SIMULATOR
 */
export const SIMULATOR = 'SIMULATOR';
/**
 * Известные execution venues (для convenience)
 *
 * @remarks
 * Включает все известные VenueId + SIMULATOR.
 */
export const KnownExecutionVenues = {
    POLYMARKET: KnownVenues.POLYMARKET,
    KALSHI: KnownVenues.KALSHI,
    SIMULATOR: SIMULATOR,
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
export function asExecutionVenueId(raw) {
    // Специальный случай: SIMULATOR
    if (raw === 'SIMULATOR') {
        return SIMULATOR;
    }
    // Иначе валидируем как VenueId
    return asVenueId(raw);
}
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
export function executionToVenue(venueId) {
    // SIMULATOR это виртуальный venue, не мапится в VenueId
    if (venueId === SIMULATOR) {
        return undefined;
    }
    // ExecutionVenueId (не SIMULATOR) = VenueId
    return venueId;
}
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
export function isSimulator(venueId) {
    return venueId === SIMULATOR;
}
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
export function isLiveVenue(venueId) {
    return !isSimulator(venueId);
}
//# sourceMappingURL=ExecutionVenueId.js.map