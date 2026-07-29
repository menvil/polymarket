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
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import type { TriggerReason } from './TriggerReason.js';
import { KNOWN_TRIGGER_REASONS } from './TriggerReason.js';

/** Приватный Set для O(1)-проверки — построен один раз из readonly tuple. */
const KNOWN_TRIGGER_REASON_SET: ReadonlySet<TriggerReason> = new Set<TriggerReason>(KNOWN_TRIGGER_REASONS);

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

  /**
   * Watchdog-таймаут одного `ExecutionEngine.execute()` (ms).
   *
   * @remarks
   * Если execution не завершился за это время, стратегия помечается
   * `faulted`: новые тики блокируются до `unregister()` (controlled
   * recovery), параллельный execution НЕ запускается. Это state-machine
   * защита от «зависшей навсегда running-стратегии», а НЕ отмена Promise —
   * JavaScript не может отменить неотменяемую операцию.
   *
   * @defaultValue 30000
   */
  readonly executionTimeoutMs: number;
}

/**
 * Валидирует ScheduleConfig перед регистрацией стратегии.
 *
 * @param config - Полная (уже слитая с default) конфигурация
 * @returns Ok при валидной конфигурации; Err с причиной — при невалидной
 *
 * @remarks
 * Fail-closed на границе register(): невалидный config не должен дожить до
 * запуска heartbeat. Проверки:
 * - `minIntervalMs` — конечное целое >= 0;
 * - `maxIdleMs` — конечное целое > 0;
 * - `executionTimeoutMs` — конечное целое > 0;
 * - `priorityTriggers` — только известные {@link TriggerReason}.
 *
 * @example
 * ```typescript
 * const r = validateScheduleConfig(config);
 * if (!r.ok) return Err(r.error);
 * ```
 */
export function validateScheduleConfig(config: ScheduleConfig): Result<void, Error> {
  if (!Number.isInteger(config.minIntervalMs) || config.minIntervalMs < 0) {
    return Err(new Error(
      `Invalid ScheduleConfig.minIntervalMs: ${String(config.minIntervalMs)} (must be a finite integer >= 0)`,
    ));
  }
  if (!Number.isInteger(config.maxIdleMs) || config.maxIdleMs <= 0) {
    return Err(new Error(
      `Invalid ScheduleConfig.maxIdleMs: ${String(config.maxIdleMs)} (must be a finite integer > 0)`,
    ));
  }
  if (!Number.isInteger(config.executionTimeoutMs) || config.executionTimeoutMs <= 0) {
    return Err(new Error(
      `Invalid ScheduleConfig.executionTimeoutMs: ${String(config.executionTimeoutMs)} (must be a finite integer > 0)`,
    ));
  }
  for (const trigger of config.priorityTriggers) {
    if (!KNOWN_TRIGGER_REASON_SET.has(trigger)) {
      return Err(new Error(
        `Invalid ScheduleConfig.priorityTriggers: unknown TriggerReason "${String(trigger)}"`,
      ));
    }
  }
  return Ok(undefined);
}

/**
 * Строит default конфигурацию расписания.
 *
 * @returns Свежий `ScheduleConfig` с новым `priorityTriggers` Set
 *
 * @remarks
 * Фабрика, а НЕ экспортированная константа — экспортированный объект с
 * `Set`-полем был бы разделяемым mutable singleton-ом: один caller,
 * мутировавший `.priorityTriggers` (например, через `as Set<any>`), незаметно
 * менял бы default для всех остальных регистраций. Каждый вызов
 * `createDefaultScheduleConfig()` возвращает независимый экземпляр.
 *
 * - minIntervalMs: 50ms — баланс между latency и CPU
 * - priorityTriggers: FILL — немедленная реакция на исполнение
 * - maxIdleMs: 5000ms — heartbeat каждые 5 секунд
 * - executionTimeoutMs: 30000ms — watchdog-таймаут execute()
 *
 * @example
 * ```typescript
 * const config = createDefaultScheduleConfig();
 * ```
 */
export function createDefaultScheduleConfig(): ScheduleConfig {
  return {
    minIntervalMs: 50,
    priorityTriggers: new Set<TriggerReason>(['FILL']),
    maxIdleMs: 5000,
    executionTimeoutMs: 30_000,
  };
}
