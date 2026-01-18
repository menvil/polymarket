/**
 * RiskLimitBreachedEvent - событие превышения risk limit
 *
 * @remarks
 * Событие возникает когда метрика риска превышает заданный порог.
 *
 * Когда возникает:
 * - Net position превышает maxNetPosition
 * - Gross position превышает maxGrossPosition
 * - Unrealized loss превышает maxLossThreshold
 * - Time to expiry < критического порога
 *
 * Зачем нужно:
 * - Автоматические действия (stop quoting, reduce position)
 * - Alerts и уведомления
 * - Аудит и compliance
 * - Эскалация по severity
 *
 * @example
 * ```typescript
 * const event = new RiskLimitBreachedEvent(
 *   'netPosition',
 *   1200,           // current value
 *   1000,           // threshold
 *   'WARNING',      // severity
 *   new Date()
 * );
 * ```
 */
import { DomainEvent } from './DomainEvent.js';

/**
 * Risk severity levels
 */
export type RiskSeverity = 'WARNING' | 'DANGER' | 'CRITICAL';

/**
 * RiskLimitBreachedEvent
 *
 * @remarks
 * Иммутабельное событие, фиксирующее превышение risk limit.
 */
export class RiskLimitBreachedEvent extends DomainEvent {
  /**
   * Creates RiskLimitBreachedEvent
   *
   * @param metric - Name of risk metric (e.g., 'netPosition', 'grossPosition')
   * @param value - Current value of metric
   * @param threshold - Configured threshold
   * @param severity - Severity level
   * @param timestamp - When breach occurred (default: now)
   *
   * @remarks
   * Severity levels:
   * - WARNING: 80-90% of limit → increase monitoring
   * - DANGER: 90-100% of limit → defensive actions (skew quotes)
   * - CRITICAL: >100% of limit → aggressive actions (stop quoting, unwind)
   *
   * @example
   * ```typescript
   * // WARNING: approaching limit
   * const event1 = new RiskLimitBreachedEvent(
   *   'netPosition',
   *   850,      // 85% of 1000
   *   1000,
   *   'WARNING'
   * );
   *
   * // DANGER: very close to limit
   * const event2 = new RiskLimitBreachedEvent(
   *   'grossPosition',
   *   1900,     // 95% of 2000
   *   2000,
   *   'DANGER'
   * );
   *
   * // CRITICAL: exceeded limit
   * const event3 = new RiskLimitBreachedEvent(
   *   'unrealizedLoss',
   *   1100,     // exceeded 1000 limit
   *   1000,
   *   'CRITICAL'
   * );
   * ```
   */
  constructor(
    public readonly metric: string,
    public readonly value: number,
    public readonly threshold: number,
    public readonly severity: RiskSeverity,
    timestamp: Date = new Date()
  ) {
    super('RiskLimitBreached', timestamp);
  }

  /**
   * Gets event data for serialization
   *
   * @returns Event data
   */
  protected getData(): Record<string, unknown> {
    return {
      metric: this.metric,
      value: this.value,
      threshold: this.threshold,
      severity: this.severity,
      utilizationPercent: this.getUtilizationPercent(),
      excess: this.getExcess(),
    };
  }

  /**
   * Calculates utilization percentage
   *
   * @returns Utilization as percentage (e.g., 120 = 120%)
   *
   * @remarks
   * utilization = (value / threshold) * 100
   *
   * @example
   * ```typescript
   * const event = new RiskLimitBreachedEvent('netPos', 1200, 1000, 'CRITICAL');
   * console.log(event.getUtilizationPercent()); // 120
   * ```
   */
  public getUtilizationPercent(): number {
    return this.threshold > 0 ? (this.value / this.threshold) * 100 : 0;
  }

  /**
   * Calculates excess over threshold
   *
   * @returns Amount over threshold
   *
   * @remarks
   * excess = value - threshold
   *
   * @example
   * ```typescript
   * const event = new RiskLimitBreachedEvent('netPos', 1200, 1000, 'CRITICAL');
   * console.log(event.getExcess()); // 200
   * ```
   */
  public getExcess(): number {
    return Math.max(0, this.value - this.threshold);
  }

  /**
   * Checks if severity is critical
   *
   * @returns True if severity is CRITICAL
   *
   * @example
   * ```typescript
   * const event = new RiskLimitBreachedEvent(..., 'CRITICAL');
   * if (event.isCritical()) {
   *   console.error('CRITICAL RISK! Take immediate action!');
   * }
   * ```
   */
  public isCritical(): boolean {
    return this.severity === 'CRITICAL';
  }

  /**
   * Checks if severity is danger or higher
   *
   * @returns True if severity is DANGER or CRITICAL
   *
   * @example
   * ```typescript
   * const event = new RiskLimitBreachedEvent(..., 'DANGER');
   * if (event.isDangerOrHigher()) {
   *   console.warn('High risk! Take defensive actions');
   * }
   * ```
   */
  public isDangerOrHigher(): boolean {
    return this.severity === 'DANGER' || this.severity === 'CRITICAL';
  }

  /**
   * String representation
   *
   * @returns Human-readable string
   *
   * @example
   * ```typescript
   * const event = new RiskLimitBreachedEvent(...);
   * console.log(event.toString());
   * // 'RiskLimitBreached[netPosition]: 1200/1000 (120%) - CRITICAL'
   * ```
   */
  public toString(): string {
    return `RiskLimitBreached[${this.metric}]: ${this.value.toFixed(0)}/${this.threshold.toFixed(0)} (${this.getUtilizationPercent().toFixed(0)}%) - ${this.severity}`;
  }
}
