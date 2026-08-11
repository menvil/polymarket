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
/** Реэкспорт причины пересчёта тика (см. TriggerReason.ts). */
export type { TriggerReason } from './TriggerReason.js';
export { KNOWN_TRIGGER_REASONS } from './TriggerReason.js';
/** Реэкспорт декларативных намерений стратегии (см. StrategyIntent.ts). */
export type {
  StrategyIntent,
  BasePlaceIntent,
  PlaceIntent,
  CancelIntent,
  CancelAllIntent,
  StrategyStopIntent,
} from './StrategyIntent.js';
export { placeTarget } from './StrategyIntent.js';
/** Реэкспорт кода ошибки остановки стратегии (см. StopStrategyError.ts). */
export type { StopStrategyErrorCode } from './StopStrategyError.js';
export { StopStrategyError } from './StopStrategyError.js';
/** Реэкспорт типов снапшота/crypto market data (см. StrategySnapshot.ts). */
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
/** Реэкспорт ограничений инструмента (см. InstrumentConstraints.ts). */
export type { InstrumentConstraints } from './InstrumentConstraints.js';
/** Реэкспорт конфигурации расписания (см. ScheduleConfig.ts). */
export type { ScheduleConfig } from './ScheduleConfig.js';
export { createDefaultScheduleConfig, validateScheduleConfig } from './ScheduleConfig.js';
