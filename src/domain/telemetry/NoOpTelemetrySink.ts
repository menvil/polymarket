/**
 * NoOpTelemetrySink - telemetry sink который ничего не делает
 *
 * @remarks
 * Используется в backtesting когда telemetry не нужен (zero overhead).
 *
 * Fire-and-forget pattern: emit() просто возвращается сразу.
 *
 * @example
 * ```typescript
 * const sink = new NoOpTelemetrySink();
 * const strategy = new DumbStrategy(config, sink);
 *
 * // Telemetry игнорируется:
 * sink.emit({ type: 'STATE_CHANGED', strategyId: 'test', ... });
 * // ↑ No-op (zero overhead)
 * ```
 */

import type { ITelemetrySink } from './ITelemetrySink.js';
import type { TelemetryEvent } from './TelemetryEvent.js';

export class NoOpTelemetrySink implements ITelemetrySink {
  /**
   * Emit telemetry event (no-op)
   *
   * @remarks
   * Просто игнорирует event. Zero overhead.
   */
  emit(_event: TelemetryEvent): void {
    // Do nothing (no-op)
  }
}
