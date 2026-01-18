/**
 * ITelemetrySink - контракт для приёма telemetry
 *
 * @remarks
 * Sink = куда стратегия эмитит telemetry.
 *
 * По умолчанию: NoopTelemetrySink (ничего не делает).
 *
 * Sink НЕ должен:
 * - Бросать исключения (fire-and-forget)
 * - Блокировать стратегию (async operations должны быть non-blocking)
 * - Влиять на behaviour стратегии
 *
 * Sink - это паразит (наблюдатель), НЕ субъект (участник).
 *
 * @example
 * ```typescript
 * // NoopTelemetrySink (по умолчанию):
 * class NoopTelemetrySink implements ITelemetrySink {
 *   emit(event: TelemetryEvent): void {
 *     // Do nothing (zero overhead)
 *   }
 * }
 *
 * // ConsoleTelemetrySink (для debugging):
 * class ConsoleTelemetrySink implements ITelemetrySink {
 *   emit(event: TelemetryEvent): void {
 *     console.log('[Telemetry]', event.type, event.payload);
 *   }
 * }
 *
 * // Usage в стратегии:
 * class DumbStrategy implements IStrategy {
 *   constructor(
 *     private readonly config: DumbStrategyConfig,
 *     private readonly telemetrySink: ITelemetrySink // ✅ Dependency injection
 *   ) {}
 *
 *   private emitTelemetry(ctx: StrategyContext, event: Omit<TelemetryEvent, 'timestamp' | 'strategyId'>): void {
 *     this.telemetrySink.emit({
 *       timestamp: ctx.now(), // ✅ deterministic (clock injection)
 *       strategyId: this.id,
 *       ...event,
 *     });
 *   }
 * }
 * ```
 */

import type { TelemetryEvent } from './TelemetryEvent.js';

export interface ITelemetrySink {
  /**
   * Emit telemetry event
   *
   * @param event - Telemetry event
   *
   * @remarks
   * Fire-and-forget pattern.
   *
   * КРИТИЧНО:
   * - Sink НЕ должен бросать исключения
   * - Sink НЕ должен блокировать стратегию
   * - Sink НЕ влияет на behaviour (паразит!)
   *
   * Если sink упал — это НЕ должно ломать стратегию.
   * Telemetry = observability, НЕ execution logic.
   *
   * @example
   * ```typescript
   * // ✅ ПРАВИЛЬНО: fire-and-forget
   * emit(event: TelemetryEvent): void {
   *   try {
   *     this.logger.debug('[Telemetry]', event);
   *   } catch (error) {
   *     // Swallow errors (НЕ должны ломать стратегию)
   *   }
   * }
   *
   * // ❌ НЕПРАВИЛЬНО: блокирует стратегию
   * async emit(event: TelemetryEvent): Promise<void> {
   *   await this.sendToAPI(event); // ❌ async blocking
   * }
   * ```
   */
  emit(event: TelemetryEvent): void;
}
