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
export type {
  StrategyIntent,
  PlaceIntent,
  CancelIntent,
  CancelAllIntent,
} from './StrategyIntent.js';
export type { StrategySnapshot } from './StrategySnapshot.js';
export type { ScheduleConfig } from './ScheduleConfig.js';
export { DEFAULT_SCHEDULE_CONFIG } from './ScheduleConfig.js';
