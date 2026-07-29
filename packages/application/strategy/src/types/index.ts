/**
 * Типы Strategy Engine.
 *
 * @remarks
 * Экспортирует все типы необходимые для работы стратегий:
 * - `TriggerReason` — причина пересчёта
 * - `StrategyIntent` (+ PlaceIntent, CancelIntent, CancelAllIntent) — намерения
 * - `StrategySnapshot` — readonly snapshot состояния
 * - `ScheduleConfig` + DEFAULT_SCHEDULE_CONFIG — конфигурация расписания
 */
export type { TriggerReason } from './TriggerReason.js';
export { KNOWN_TRIGGER_REASONS } from './TriggerReason.js';
export type {
  StrategyIntent,
  BasePlaceIntent,
  PlaceIntent,
  CancelIntent,
  CancelAllIntent,
  StrategyStopIntent,
} from './StrategyIntent.js';
export { placeTarget } from './StrategyIntent.js';
export type { StopStrategyErrorCode } from './StopStrategyError.js';
export { StopStrategyError } from './StopStrategyError.js';
export type {
  CexBookTick,
  CexTradeTick,
  CexVenue,
  CexVenueState,
  CryptoSignalDirection,
  CryptoSignalRegistryView,
  CryptoSignalRequest,
  CryptoSignalResult,
  CryptoPriceHistoryView,
  CryptoPricePoint,
  CryptoPriceSource,
  CryptoVenueHistoryView,
  CryptoVenueStateView,
  StrategySnapshot,
} from './StrategySnapshot.js';
export type { InstrumentConstraints } from './InstrumentConstraints.js';
export type { ScheduleConfig } from './ScheduleConfig.js';
export { createDefaultScheduleConfig, validateScheduleConfig } from './ScheduleConfig.js';
