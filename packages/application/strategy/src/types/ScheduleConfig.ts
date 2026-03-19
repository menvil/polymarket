/**
 * Конфигурация расписания стратегии.
 *
 * @remarks
 * Определяет как часто StrategyScheduler вызывает tick():
 * - `minIntervalMs` — throttle: минимальный интервал между тиками
 * - `priorityTriggers` — reasons которые игнорируют throttle (немедленный tick)
 * - `maxIdleMs` — heartbeat: force tick даже если не dirty
 *
 * @example
 * ```typescript
 * // Агрессивная стратегия: tick каждые 20ms, heartbeat каждую секунду
 * const config: ScheduleConfig = {
 *   minIntervalMs: 20,
 *   priorityTriggers: new Set(['FILL']),
 *   maxIdleMs: 1000,
 * };
 *
 * // Пассивная стратегия: tick каждые 500ms, heartbeat каждые 30 секунд
 * const config: ScheduleConfig = {
 *   minIntervalMs: 500,
 *   priorityTriggers: new Set(['FILL', 'ORDER_UPDATE']),
 *   maxIdleMs: 30_000,
 * };
 * ```
 */
import type { TriggerReason } from './TriggerReason.js';

export interface ScheduleConfig {
  /**
   * Минимальный интервал между tick (throttle).
   *
   * @remarks
   * Если стратегия dirty и прошло меньше minIntervalMs — tick откладывается.
   * Priority triggers (FILL) игнорируют этот лимит.
   *
   * @defaultValue 50
   */
  readonly minIntervalMs: number;

  /**
   * Reasons которые игнорируют minInterval — tick вызывается немедленно.
   *
   * @remarks
   * Типичный приоритетный trigger: FILL — исполнение ордера требует
   * немедленной реакции (обновить котировки, учесть позицию).
   *
   * @defaultValue Set(['FILL'])
   */
  readonly priorityTriggers: ReadonlySet<TriggerReason>;

  /**
   * Максимальное время без tick — force tick даже если данные не dirty.
   *
   * @remarks
   * Heartbeat: гарантирует что стратегия периодически пересчитывает
   * даже при отсутствии новых событий (например, для timeToExpiry).
   *
   * @defaultValue 5000
   */
  readonly maxIdleMs: number;
}

/**
 * Default конфигурация расписания.
 *
 * @remarks
 * - minIntervalMs: 50ms — баланс между latency и CPU
 * - priorityTriggers: FILL — немедленная реакция на исполнение
 * - maxIdleMs: 5000ms — heartbeat каждые 5 секунд
 */
export const DEFAULT_SCHEDULE_CONFIG: ScheduleConfig = {
  minIntervalMs: 50,
  priorityTriggers: new Set<TriggerReason>(['FILL']),
  maxIdleMs: 5000,
};
