/**
 * RiskExposure aggregate
 *
 * @remarks
 * Manages risk state and trading modes for the market maker.
 * Tracks risk status, defensive mode, urgency, and trading modes.
 *
 * Algorithm:
 * - Monitors portfolio limits (net position, gross position, cash)
 * - Calculates urgency based on time to expiry and position size
 * - Transitions between risk states: NORMAL → WARNING → DEFENSIVE → PANIC
 * - Controls trading modes: QUOTE → SKEW → UNWIND → PANIC
 * - Enforces risk management rules and limits
 *
 * Risk States:
 * - NORMAL: Operating within all limits, normal trading
 * - WARNING: Approaching one or more limits, begin caution
 * - DEFENSIVE: Exceeded soft limits, reduce exposure
 * - PANIC: Critical limits breached, emergency unwinding
 *
 * Trading Modes:
 * - QUOTE: Normal two-way market making
 * - SKEW: Skew quotes to reduce exposure
 * - UNWIND: Actively close positions
 * - PANIC: Emergency liquidation mode
 *
 * Why an aggregate?
 * - Risk state is the consistency boundary for risk decisions
 * - All risk-related state changes are coordinated
 * - Ensures invariants: urgency in [0,1], valid state transitions
 * - Single source of truth for risk management
 *
 * @example
 * ```typescript
 * // Create normal risk exposure
 * const risk = RiskExposure.create();
 * console.log(risk.status); // 'NORMAL'
 * console.log(risk.mode); // 'QUOTE'
 *
 * // Check limits against portfolio
 * const portfolio = Portfolio.create(Money.fromUSDC(1000));
 * const updated = risk.checkLimits(portfolio, 1000, 2000);
 * console.log(updated.status); // 'NORMAL' (within limits)
 *
 * // Calculate urgency as time runs out
 * const urgency = risk.calculateUrgency(3600000, 800, 1000); // 1 hour left
 * console.log(urgency); // 0.85 (high urgency)
 *
 * // Check if should panic
 * const shouldPanic = risk.shouldPanic(Money.fromUSDC(-500), Money.fromUSDC(100));
 * console.log(shouldPanic); // true (loss exceeds threshold)
 * ```
 */
import { Portfolio } from './Portfolio.js';
import { Money } from '../value-objects/Money.js';
import { TradingError } from '../../shared/errors/TradingError.js';
import { ConfigLoader } from '../../infrastructure/config/ConfigLoader.js';

/**
 * Risk status type
 *
 * @remarks
 * Represents the current risk level of the portfolio
 */
export type RiskStatus = 'NORMAL' | 'WARNING' | 'DEFENSIVE' | 'PANIC';

/**
 * Trading mode type
 *
 * @remarks
 * Determines how the market maker should quote and trade
 */
export type TradingMode = 'QUOTE' | 'SKEW' | 'UNWIND' | 'PANIC';

/**
 * Risk exposure invariant violation error
 *
 * @remarks
 * Thrown when risk state violates business rules
 */
export class RiskExposureInvariantError extends TradingError {
  constructor(message: string) {
    super(`Risk exposure invariant violation: ${message}`, 'RISK_INVARIANT_VIOLATION');
  }
}

/**
 * Risk limits configuration
 *
 * @remarks
 * Defines thresholds for position and loss limits
 */
export interface RiskLimits {
  readonly maxNetPosition: number;
  readonly maxGrossPosition: number;
  readonly maxLossThreshold: Money;
  readonly warningThreshold: number; // % of limit (e.g., 0.8 = 80%)
  readonly defensiveThreshold: number; // % of limit (e.g., 0.9 = 90%)
}

/**
 * Risk exposure aggregate root
 *
 * @remarks
 * Immutable aggregate managing all risk state.
 * All methods return new RiskExposure instances.
 */
export class RiskExposure {
  /**
   * Creates a new RiskExposure
   *
   * @param status - Current risk status
   * @param mode - Current trading mode
   * @param defensiveMode - Whether defensive mode is active
   * @param urgency - Urgency level [0, 1]
   * @param stateReason - Reason for current state
   * @param stateEnterTime - When current state was entered
   *
   * @remarks
   * Private constructor - use static factory methods instead.
   */
  private constructor(
    public readonly status: RiskStatus,
    public readonly mode: TradingMode,
    public readonly defensiveMode: boolean,
    public readonly urgency: number,
    public readonly stateReason: string,
    public readonly stateEnterTime: Date
  ) {}

  /**
   * Creates a new risk exposure with normal state
   *
   * @returns New RiskExposure in NORMAL state
   *
   * @remarks
   * Factory method that creates initial risk state.
   * Starts in NORMAL status with QUOTE mode.
   *
   * @example
   * ```typescript
   * const risk = RiskExposure.create();
   * console.log(risk.status); // 'NORMAL'
   * console.log(risk.mode); // 'QUOTE'
   * console.log(risk.defensiveMode); // false
   * console.log(risk.urgency); // 0
   * ```
   */
  public static create(): RiskExposure {
    const risk = new RiskExposure(
      'NORMAL',
      'QUOTE',
      false,
      0,
      'Initial state',
      new Date()
    );
    risk.validateInvariants();
    return risk;
  }

  /**
   * Checks portfolio against risk limits
   *
   * @param portfolio - Current portfolio state
   * @param maxNet - Maximum net position (absolute value)
   * @param maxGross - Maximum gross position
   * @returns New RiskExposure with updated status
   *
   * @remarks
   * Algorithm:
   * 1. Calculate net position ratio: |net| / maxNet
   * 2. Calculate gross position ratio: gross / maxGross
   * 3. Take maximum of both ratios
   * 4. Determine status based on thresholds:
   *    - < 80%: NORMAL
   *    - 80-90%: WARNING
   *    - 90-100%: DEFENSIVE
   *    - > 100%: PANIC
   * 5. Update trading mode based on status
   * 6. Return new RiskExposure instance
   *
   * @example
   * ```typescript
   * const risk = RiskExposure.create();
   * const portfolio = Portfolio.create(Money.fromUSDC(1000))
   *   .addPosition('token-1', 'YES', lot); // net = 100
   *
   * // Within limits
   * const updated = risk.checkLimits(portfolio, 1000, 2000);
   * console.log(updated.status); // 'NORMAL'
   *
   * // Approaching limits (net = 850 / 1000 = 85%)
   * const warning = risk.checkLimits(portfolioWarning, 1000, 2000);
   * console.log(warning.status); // 'WARNING'
   * ```
   */
  public checkLimits(
    portfolio: Portfolio,
    maxNet: number,
    maxGross: number
  ): RiskExposure {
    const netPosition = Math.abs(portfolio.netPosition);
    const grossPosition = portfolio.grossPosition;

    // Calculate position ratios
    const netRatio = maxNet > 0 ? netPosition / maxNet : 0;
    const grossRatio = maxGross > 0 ? grossPosition / maxGross : 0;
    const maxRatio = Math.max(netRatio, grossRatio);

    let newStatus: RiskStatus = this.status;
    let newMode: TradingMode = this.mode;
    let reason = this.stateReason;
    let enterTime = this.stateEnterTime;

    // Determine status based on thresholds (from config)
    const riskUtilConfig = ConfigLoader.getInstance().getRiskUtilizationConfig();
    if (maxRatio > 1.0) {
      newStatus = 'PANIC';
      newMode = 'PANIC';
      reason = `Critical limit breach: ${(maxRatio * 100).toFixed(1)}% of max`;
    } else if (maxRatio >= riskUtilConfig.criticalThreshold) {
      newStatus = 'DEFENSIVE';
      newMode = 'UNWIND';
      reason = `Defensive limit reached: ${(maxRatio * 100).toFixed(1)}% of max`;
    } else if (maxRatio >= riskUtilConfig.highThreshold) {
      newStatus = 'WARNING';
      newMode = 'SKEW';
      reason = `Warning threshold exceeded: ${(maxRatio * 100).toFixed(1)}% of max`;
    } else {
      newStatus = 'NORMAL';
      newMode = 'QUOTE';
      reason = `Within limits: ${(maxRatio * 100).toFixed(1)}% of max`;
    }

    // Update enter time if status changed
    if (newStatus !== this.status) {
      enterTime = new Date();
    }

    const risk = new RiskExposure(
      newStatus,
      newMode,
      newStatus === 'DEFENSIVE' || newStatus === 'PANIC',
      this.urgency,
      reason,
      enterTime
    );

    risk.validateInvariants();
    return risk;
  }

  /**
   * Calculates urgency based on time and position
   *
   * @param timeToExpiry - Milliseconds until market expires
   * @param netPosition - Current net position (absolute value)
   * @param maxPosition - Maximum allowed position
   * @returns Urgency level [0, 1]
   *
   * @remarks
   * Algorithm:
   * 1. Calculate time urgency: 1 - (timeLeft / totalTime)
   *    - More urgent as time runs out
   * 2. Calculate position urgency: netPosition / maxPosition
   *    - More urgent with larger positions
   * 3. Combine: urgency = (timeUrgency * 0.6) + (positionUrgency * 0.4)
   *    - Time weighted 60%, position weighted 40%
   * 4. Clamp to [0, 1]
   *
   * Why this formula?
   * - Time pressure is primary concern (60% weight)
   * - Position size adds to urgency (40% weight)
   * - Both factors combine for holistic urgency
   * - Non-linear: urgency accelerates as expiry approaches
   *
   * @example
   * ```typescript
   * const risk = RiskExposure.create();
   *
   * // Early in market, small position
   * const u1 = risk.calculateUrgency(86400000, 100, 1000); // 24h left
   * console.log(u1); // ~0.04 (low urgency)
   *
   * // 1 hour left, large position
   * const u2 = risk.calculateUrgency(3600000, 900, 1000); // 1h left
   * console.log(u2); // ~0.85 (high urgency)
   *
   * // 5 minutes left, any position
   * const u3 = risk.calculateUrgency(300000, 500, 1000); // 5min left
   * console.log(u3); // ~0.95 (critical urgency)
   * ```
   */
  public calculateUrgency(
    timeToExpiry: number,
    netPosition: number,
    maxPosition: number
  ): number {
    // Time urgency: increases as expiry approaches
    const totalTime = 24 * 60 * 60 * 1000; // 24 hours in ms
    const timeUrgency = Math.max(0, Math.min(1, 1 - timeToExpiry / totalTime));

    // Position urgency: increases with position size
    const positionUrgency = maxPosition > 0 ? Math.abs(netPosition) / maxPosition : 0;

    // Combined urgency (time weighted more heavily)
    const urgency = timeUrgency * 0.6 + positionUrgency * 0.4;

    return Math.max(0, Math.min(1, urgency));
  }

  /**
   * Updates trading mode with reason
   *
   * @param newMode - New trading mode to set
   * @param reason - Reason for mode change
   * @returns New RiskExposure with updated mode
   *
   * @remarks
   * Updates trading mode and records reason.
   * Automatically adjusts defensive mode flag.
   * Updates state enter time if mode changed.
   *
   * @example
   * ```typescript
   * const risk = RiskExposure.create();
   *
   * // Switch to skew mode
   * const skewed = risk.updateMode('SKEW', 'Large imbalance detected');
   * console.log(skewed.mode); // 'SKEW'
   * console.log(skewed.stateReason); // 'Large imbalance detected'
   *
   * // Emergency unwind
   * const unwinding = skewed.updateMode('UNWIND', 'Approaching position limit');
   * console.log(unwinding.mode); // 'UNWIND'
   * console.log(unwinding.defensiveMode); // true
   * ```
   */
  public updateMode(newMode: TradingMode, reason: string): RiskExposure {
    // Map mode to status
    let newStatus = this.status;
    if (newMode === 'PANIC') {
      newStatus = 'PANIC';
    } else if (newMode === 'UNWIND') {
      newStatus = 'DEFENSIVE';
    } else if (newMode === 'SKEW') {
      newStatus = 'WARNING';
    } else {
      newStatus = 'NORMAL';
    }

    const risk = new RiskExposure(
      newStatus,
      newMode,
      newMode === 'UNWIND' || newMode === 'PANIC',
      this.urgency,
      reason,
      newMode !== this.mode ? new Date() : this.stateEnterTime
    );

    risk.validateInvariants();
    return risk;
  }

  /**
   * Updates urgency level
   *
   * @param urgency - New urgency level [0, 1]
   * @param reason - Reason for urgency change
   * @returns New RiskExposure with updated urgency
   *
   * @throws {RiskExposureInvariantError} If urgency is out of range
   *
   * @example
   * ```typescript
   * const risk = RiskExposure.create();
   *
   * const urgent = risk.updateUrgency(0.85, 'Market closing soon');
   * console.log(urgent.urgency); // 0.85
   * ```
   */
  public updateUrgency(urgency: number, reason: string): RiskExposure {
    if (urgency < 0 || urgency > 1) {
      throw new RiskExposureInvariantError(`Urgency must be in [0, 1], got ${urgency}`);
    }

    const risk = new RiskExposure(
      this.status,
      this.mode,
      this.defensiveMode,
      urgency,
      reason,
      this.stateEnterTime
    );

    risk.validateInvariants();
    return risk;
  }

  /**
   * Checks if should enter panic mode
   *
   * @param unrealizedPnL - Current unrealized profit/loss
   * @param lossThreshold - Maximum acceptable loss
   * @returns True if should panic
   *
   * @remarks
   * Panic conditions:
   * 1. Unrealized loss exceeds threshold
   * 2. Loss is negative (actual loss, not profit)
   *
   * Why panic?
   * - Prevents catastrophic losses
   * - Triggers emergency risk reduction
   * - Overrides normal trading logic
   * - Immediate action required
   *
   * @example
   * ```typescript
   * const risk = RiskExposure.create();
   *
   * // Small loss - no panic
   * const shouldPanic1 = risk.shouldPanic(
   *   Money.fromUSDC(-50),
   *   Money.fromUSDC(100)
   * );
   * console.log(shouldPanic1); // false
   *
   * // Large loss - panic!
   * const shouldPanic2 = risk.shouldPanic(
   *   Money.fromUSDC(-150),
   *   Money.fromUSDC(100)
   * );
   * console.log(shouldPanic2); // true
   * ```
   */
  public shouldPanic(unrealizedPnL: Money, lossThreshold: Money): boolean {
    // Panic if loss exceeds threshold
    return unrealizedPnL.amount < 0 && Math.abs(unrealizedPnL.amount) > lossThreshold.amount;
  }

  /**
   * Checks if in normal state
   *
   * @returns True if status is NORMAL
   *
   * @example
   * ```typescript
   * const risk = RiskExposure.create();
   * console.log(risk.isNormal()); // true
   * ```
   */
  public isNormal(): boolean {
    return this.status === 'NORMAL';
  }

  /**
   * Checks if in warning state
   *
   * @returns True if status is WARNING
   *
   * @example
   * ```typescript
   * const risk = RiskExposure.create()
   *   .updateMode('SKEW', 'Warning');
   * console.log(risk.isWarning()); // true
   * ```
   */
  public isWarning(): boolean {
    return this.status === 'WARNING';
  }

  /**
   * Checks if in defensive state
   *
   * @returns True if status is DEFENSIVE
   *
   * @example
   * ```typescript
   * const risk = RiskExposure.create()
   *   .updateMode('UNWIND', 'Defensive');
   * console.log(risk.isDefensive()); // true
   * console.log(risk.defensiveMode); // true
   * ```
   */
  public isDefensive(): boolean {
    return this.status === 'DEFENSIVE';
  }

  /**
   * Checks if in panic state
   *
   * @returns True if status is PANIC
   *
   * @example
   * ```typescript
   * const risk = RiskExposure.create()
   *   .updateMode('PANIC', 'Emergency');
   * console.log(risk.isPanic()); // true
   * console.log(risk.defensiveMode); // true
   * ```
   */
  public isPanic(): boolean {
    return this.status === 'PANIC';
  }

  /**
   * Gets time in current state
   *
   * @returns Milliseconds in current state
   *
   * @remarks
   * Useful for tracking how long in each state.
   * Can be used to trigger actions after timeout.
   *
   * @example
   * ```typescript
   * const risk = RiskExposure.create();
   * // ... time passes ...
   * const duration = risk.getTimeInState();
   * console.log(`In ${risk.status} for ${duration}ms`);
   * ```
   */
  public getTimeInState(): number {
    return Date.now() - this.stateEnterTime.getTime();
  }

  /**
   * Validates business rules and invariants
   *
   * @throws {RiskExposureInvariantError} If any invariant is violated
   *
   * @remarks
   * Business rules:
   * 1. Urgency must be in [0, 1]
   * 2. Defensive mode must match status (DEFENSIVE or PANIC)
   * 3. Mode must be consistent with status
   * 4. State reason must be non-empty
   * 5. State enter time must be valid
   *
   * Called automatically after every state change.
   */
  public validateInvariants(): void {
    // Rule 1: Urgency must be in [0, 1]
    if (this.urgency < 0 || this.urgency > 1) {
      throw new RiskExposureInvariantError(`Urgency must be in [0, 1], got ${this.urgency}`);
    }

    // Rule 2: Defensive mode must match status
    const shouldBeDefensive = this.status === 'DEFENSIVE' || this.status === 'PANIC';
    if (this.defensiveMode !== shouldBeDefensive) {
      throw new RiskExposureInvariantError(
        `Defensive mode (${this.defensiveMode}) inconsistent with status (${this.status})`
      );
    }

    // Rule 3: Mode must be consistent with status
    if (this.status === 'PANIC' && this.mode !== 'PANIC') {
      throw new RiskExposureInvariantError(`PANIC status requires PANIC mode, got ${this.mode}`);
    }

    // Rule 4: State reason must be non-empty
    if (!this.stateReason || this.stateReason.trim().length === 0) {
      throw new RiskExposureInvariantError('State reason cannot be empty');
    }

    // Rule 5: State enter time must be valid
    if (!(this.stateEnterTime instanceof Date) || isNaN(this.stateEnterTime.getTime())) {
      throw new RiskExposureInvariantError('State enter time must be valid Date');
    }
  }

  /**
   * Creates a string representation of risk exposure
   *
   * @returns Formatted string with risk state summary
   *
   * @example
   * ```typescript
   * const risk = RiskExposure.create()
   *   .updateMode('SKEW', 'Position imbalance');
   * console.log(risk.toString());
   * // "RiskExposure: WARNING/SKEW (defensive: false, urgency: 0.00) - Position imbalance"
   * ```
   */
  public toString(): string {
    return `RiskExposure: ${this.status}/${this.mode} (defensive: ${this.defensiveMode}, urgency: ${this.urgency.toFixed(2)}) - ${this.stateReason}`;
  }
}
