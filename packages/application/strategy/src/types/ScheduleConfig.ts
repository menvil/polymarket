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

/**
 * Конфигурация того, как часто `StrategyScheduler` вызывает `tick()`.
 *
 * @remarks
 * Подробное описание throttle/priority/heartbeat-механизма — см. TSDoc модуля
 * в начале файла.
 */
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

  /**
   * Watchdog-таймаут final cleanup execution (`ExecutionEngine.execute()`
   * для final batch) в `_attemptStop()` (ms).
   *
   * @remarks
   * Final cleanup — тот же `ExecutionEngine.execute()`, что и обычный tick,
   * но без собственного watchdog (в отличие от ordinary execution, у него нет
   * lifecycle-состояния FAULTED, в которое можно перейти). Без отдельного
   * таймаута зависший final `CANCEL_ALL` (repository/use case/venue adapter)
   * заставил бы `unregister()`/`stopAll()` ждать бесконечно. Timeout НЕ
   * означает отмену Promise — операция остаётся tracked
   * (`entry.finalCleanupExecution`), retry коалесцируется на неё же, пока она
   * не завершится фактически.
   *
   * @defaultValue 30000
   */
  readonly finalCleanupTimeoutMs: number;

  /**
   * Watchdog-таймаут `strategy.dispose()` (ms) — и для отменённой регистрации,
   * и для нормально остановленной ACTIVE стратегии.
   *
   * @defaultValue 30000
   */
  readonly disposeTimeoutMs: number;

  /**
   * Watchdog-таймаут ожидания `strategy.initialize()` при cancellation
   * (`unregister()`/`stopAll()`, вызванные во время pending registration), ms.
   *
   * @remarks
   * Сам `initialize()` не отменяется — таймаут лишь ограничивает, сколько
   * ИМЕННО ЭТОТ вызов `unregister()`/`stopAll()` готов ждать, прежде чем
   * вернуть `INITIALIZATION_CANCELLATION_TIMED_OUT`. `initialize()` продолжает
   * выполняться в фоне; когда он в итоге завершится, cancellation-ветка
   * `_completeRegistration()` создаст `PendingDisposal` и выполнит `dispose()`.
   *
   * @defaultValue 30000
   */
  readonly initializationCancellationTimeoutMs: number;

  /**
   * Watchdog-таймаут `IStrategyCommitmentReader.getActiveCommitments()` (ms).
   *
   * @defaultValue 30000
   */
  readonly commitmentCheckTimeoutMs: number;
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
 * - `finalCleanupTimeoutMs` — конечное целое > 0;
 * - `disposeTimeoutMs` — конечное целое > 0;
 * - `initializationCancellationTimeoutMs` — конечное целое > 0;
 * - `commitmentCheckTimeoutMs` — конечное целое > 0;
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
  if (!Number.isInteger(config.finalCleanupTimeoutMs) || config.finalCleanupTimeoutMs <= 0) {
    return Err(new Error(
      `Invalid ScheduleConfig.finalCleanupTimeoutMs: ${String(config.finalCleanupTimeoutMs)} (must be a finite integer > 0)`,
    ));
  }
  if (!Number.isInteger(config.disposeTimeoutMs) || config.disposeTimeoutMs <= 0) {
    return Err(new Error(
      `Invalid ScheduleConfig.disposeTimeoutMs: ${String(config.disposeTimeoutMs)} (must be a finite integer > 0)`,
    ));
  }
  if (!Number.isInteger(config.initializationCancellationTimeoutMs) || config.initializationCancellationTimeoutMs <= 0) {
    return Err(new Error(
      `Invalid ScheduleConfig.initializationCancellationTimeoutMs: ${String(config.initializationCancellationTimeoutMs)} (must be a finite integer > 0)`,
    ));
  }
  if (!Number.isInteger(config.commitmentCheckTimeoutMs) || config.commitmentCheckTimeoutMs <= 0) {
    return Err(new Error(
      `Invalid ScheduleConfig.commitmentCheckTimeoutMs: ${String(config.commitmentCheckTimeoutMs)} (must be a finite integer > 0)`,
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
 * - finalCleanupTimeoutMs: 30000ms — watchdog-таймаут final cleanup execute()
 * - disposeTimeoutMs: 30000ms — watchdog-таймаут strategy.dispose()
 * - initializationCancellationTimeoutMs: 30000ms — таймаут ожидания cancelled initialize()
 * - commitmentCheckTimeoutMs: 30000ms — watchdog-таймаут commitment reader
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
    finalCleanupTimeoutMs: 30_000,
    disposeTimeoutMs: 30_000,
    initializationCancellationTimeoutMs: 30_000,
    commitmentCheckTimeoutMs: 30_000,
  };
}
