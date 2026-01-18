/**
 * EdgeAliveEvaluator - Layer 0 для определения "живости" edge
 *
 * @remarks
 * State machine для определения активности маркета на основе:
 * - **fragilityScore**: Насколько легко двигается цена (из TradeFlowAnalyzer)
 * - **relativeRefillRate**: Процентная скорость восстановления ликвидности (из OrderbookHealthMonitor)
 * - **timeToExpiry**: Время до экспирации маркета
 *
 * **Note**: Использует `refillRates.relative` из OrderbookHealthMonitor (0.3 = 30% рост глубины)
 *
 * States:
 * - **ALIVE**: Edge активен, можно котировать
 * - **WARNING**: Edge под угрозой, но может восстановиться
 * - **DEAD**: Edge мёртв (необратимо после warmup)
 *
 * State Transitions:
 * ```
 * ALIVE ──────▶ WARNING ──────▶ DEAD (irreversible)
 *   ▲                             │
 *   └────────── recovery ─────────┘ (только во время warmup)
 * ```
 *
 * Streak-based transitions с decay:
 * - badStreak накапливается при плохих условиях
 * - goodStreak накапливается при хороших условиях
 * - Оба decay со временем (streakDecayAlpha)
 *
 * @example
 * ```typescript
 * const evaluator = new EdgeAliveEvaluator(config, logger);
 *
 * // При каждом тике
 * const result = evaluator.evaluate(
 *   tradeFlowMetrics,
 *   orderbookHealthMetrics,
 *   timeToExpiryMin
 * );
 *
 * if (!result.alive && result.irreversible) {
 *   console.log('Edge is DEAD:', result.reason);
 * }
 * ```
 */
import { ILogger } from '../../ports/ILogger.js';
import type { TradeFlowMetrics, MarketState, OrderbookHealthMetrics, MarketContext } from '../signals/types.js';
import { getMarketLogInfo } from '../signals/types.js';

/**
 * Edge Alive configuration
 */
export interface EdgeAliveConfig {
  /**
   * Minimum fragility score for alive edge (0-1)
   *
   * @remarks
   * Если fragilityScore < minFragilityScore, edge считается неактивным.
   * Default: 0.1
   */
  minFragilityScore: number;

  /**
   * Minimum relative refill rate [0, 1.5]
   *
   * @remarks
   * Если relativeRefillRate < minRefillRate, ликвидность не восстанавливается.
   * Интерпретация: 0.3 означает минимум 30% средний рост глубины стакана.
   * Default: 0.3
   */
  minRefillRate: number;

  /**
   * Minimum minutes to expiry for market making
   *
   * @remarks
   * Если timeToExpiry < minTimeToExpiryMin, edge считается мёртвым.
   * Default: 4
   */
  minTimeToExpiryMin: number;

  /**
   * Warmup period in milliseconds
   *
   * @remarks
   * В течение warmup периода смерть edge обратима.
   * После warmup смерть становится irreversible.
   * Default: 90000 (90 секунд)
   */
  warmupMs: number;

  /**
   * Bad streak threshold for death
   *
   * @remarks
   * Количество плохих оценок подряд для перехода в DEAD.
   * С учётом decay это эффективное значение.
   * Default: 4
   */
  badStreakToDead: number;

  /**
   * Good streak threshold for revival
   *
   * @remarks
   * Количество хороших оценок подряд для recovery.
   * Default: 2
   */
  goodStreakToRevive: number;

  /**
   * Decay alpha for streaks (0-1)
   *
   * @remarks
   * При каждой оценке: streak = streak × alpha + (isGood ? 1 : 0)
   * Больше = медленнее decay (дольше память)
   * Default: 0.8
   */
  streakDecayAlpha: number;
}

/**
 * Default Edge Alive configuration
 */
export const DEFAULT_EDGE_ALIVE_CONFIG: EdgeAliveConfig = {
  minFragilityScore: 0.1,
  minRefillRate: 0.3,
  minTimeToExpiryMin: 4,
  warmupMs: 90000,
  badStreakToDead: 4,
  goodStreakToRevive: 2,
  streakDecayAlpha: 0.8,
};

/**
 * Internal state of EdgeAliveEvaluator
 */
export interface EdgeState {
  /** Is edge currently alive? */
  alive: boolean;

  /** Is edge in warning state? */
  warning: boolean;

  /** Is death irreversible? */
  irreversible: boolean;

  /** Reason for current state */
  reason: string;

  /** Accumulated bad streak (with decay) */
  badStreak: number;

  /** Accumulated good streak (with decay) */
  goodStreak: number;

  /** Timestamp when market was entered */
  marketEnterTs: number;
}

/**
 * Result of edge evaluation
 */
export interface EdgeEvaluation {
  /** Is edge alive? */
  alive: boolean;

  /** Is edge in warning state? (dead but may recover) */
  warning: boolean;

  /** Is death irreversible? */
  irreversible: boolean;

  /** Reason for current state */
  reason: string;

  /** Current fragility score */
  fragilityScore: number;

  /** Current market state */
  marketState: MarketState;

  /** Detailed metrics */
  metrics: {
    fragilityScore: number;
    refillRate: number;
    timeToExpiryMin: number;
    bookImbalance: number;
    isGoodWindow: boolean;
    badStreak: number;
    goodStreak: number;
    isWarmup: boolean;
  };
}

/**
 * EdgeAliveEvaluator
 *
 * @remarks
 * Stateful evaluator для определения "живости" edge.
 * Использует streak-based transitions с decay для robustness.
 *
 * Алгоритм оценки:
 * 1. Проверяем текущее "окно" (fragilityScore, refillRate, timeToExpiry)
 * 2. Обновляем streaks с decay
 * 3. Выполняем state transitions
 * 4. Возвращаем результат
 *
 * @example
 * ```typescript
 * const evaluator = new EdgeAliveEvaluator(config, logger);
 *
 * // Получить оценку edge
 * const result = evaluator.evaluate(tradeFlowMetrics, orderbookHealth, 30);
 *
 * console.log(`Alive: ${result.alive}, Reason: ${result.reason}`);
 *
 * // При смене маркета
 * evaluator.reset();
 * ```
 */
export class EdgeAliveEvaluator {
  private readonly config: EdgeAliveConfig;
  private readonly logger: ILogger;
  private state: EdgeState;

  /** Предыдущее состояние для логирования transitions */
  private previousAlive: boolean = true;

  /** Market context for multi-market logging */
  private marketContext: MarketContext | null = null;

  /**
   * Creates EdgeAliveEvaluator
   *
   * @param config - Configuration (optional, uses defaults)
   * @param logger - Logger instance
   *
   * @example
   * ```typescript
   * const evaluator = new EdgeAliveEvaluator({
   *   minFragilityScore: 0.15,
   *   warmupMs: 120000,
   * }, logger);
   * ```
   */
  constructor(
    config: Partial<EdgeAliveConfig> = {},
    logger: ILogger
  ) {
    this.config = { ...DEFAULT_EDGE_ALIVE_CONFIG, ...config };
    this.logger = logger.child?.('EdgeAlive') || logger;
    this.state = this.createInitialState();
  }

  /**
   * Устанавливает market context для логирования
   *
   * @param context - Market context с идентификацией рынка
   *
   * @example
   * ```typescript
   * evaluator.setMarketContext({
   *   marketId: '0x123...',
   *   marketSlug: 'btc-up-down',
   *   question: 'Bitcoin Up or Down?',
   *   expirationDate: new Date('2024-12-29T12:00:00Z'),
   * });
   * ```
   */
  public setMarketContext(context: MarketContext): void {
    this.marketContext = context;
    this.logger.debug('[EdgeAlive] Market context set', {
      ...getMarketLogInfo(context),
      marketId: context.marketId,
      marketSlug: context.marketSlug,
    });
  }

  /**
   * Возвращает market info для включения в JSON лога
   */
  private getMarketInfo(): { market: string; marketUrl: string; expiresInSec: number; expiresIn: string } {
    return getMarketLogInfo(this.marketContext);
  }

  /**
   * Evaluates edge alive status
   *
   * @param tradeFlowMetrics - Metrics from TradeFlowAnalyzer
   * @param orderbookHealthMetrics - Metrics from OrderbookHealthMonitor
   * @param timeToExpiryMin - Time to market expiry in minutes
   * @returns Edge evaluation result
   *
   * @remarks
   * Алгоритм:
   *
   * 1. **Check isGoodWindow**:
   *    ```
   *    isGoodWindow = fragilityScore >= minFragilityScore
   *                && refillRate >= minRefillRate
   *                && timeToExpiryMin >= minTimeToExpiryMin
   *    ```
   *
   * 2. **Update Streaks with Decay**:
   *    ```
   *    badStreak = badStreak × streakDecayAlpha + (!isGoodWindow ? 1 : 0)
   *    goodStreak = goodStreak × streakDecayAlpha + (isGoodWindow ? 1 : 0)
   *    ```
   *
   * 3. **State Transitions**:
   *    - ALIVE → WARNING: badStreak > 0
   *    - WARNING → DEAD: badStreak >= badStreakToDead && !isWarmup
   *    - WARNING → ALIVE: goodStreak >= goodStreakToRevive
   *
   * @example
   * ```typescript
   * const result = evaluator.evaluate(
   *   { fragilityScore: 0.3, state: 'FRAGILE', ... },
   *   { refillRate: 0.5, bidDepth: 50, ... },
   *   25 // 25 minutes to expiry
   * );
   *
   * if (!result.alive) {
   *   if (result.warning) {
   *     console.log('Edge warning - may recover');
   *   } else {
   *     console.log('Edge dead - irreversible');
   *   }
   * }
   * ```
   */
  public evaluate(
    tradeFlowMetrics: TradeFlowMetrics,
    orderbookHealthMetrics: OrderbookHealthMetrics,
    timeToExpiryMin: number
  ): EdgeEvaluation {
    const now = Date.now();
    const isWarmup = (now - this.state.marketEnterTs) < this.config.warmupMs;

    const { fragilityScore, state: marketState, bookImbalance } = tradeFlowMetrics;
    const refillRate = orderbookHealthMetrics.refillRates.relative;

    // 1. Check if current window is "good"
    const isGoodWindow = this.isGoodWindow(fragilityScore, refillRate, timeToExpiryMin);

    // 2. Determine reason if not good
    let reason = 'edge_alive';
    if (!isGoodWindow) {
      reason = this.determineReason(fragilityScore, refillRate, timeToExpiryMin);
    }

    // 3. Update streaks with decay
    this.updateStreaks(isGoodWindow);

    // 4. Save previous state for transition logging
    this.previousAlive = this.state.alive;

    // 5. State transitions
    this.updateState(isGoodWindow, isWarmup, reason);

    // 6. Log evaluation
    this.logEvaluation(
      fragilityScore,
      refillRate,
      timeToExpiryMin,
      isWarmup
    );

    // 7. Log state transition if changed
    if (this.previousAlive !== this.state.alive) {
      this.logStateTransition();
    }

    return {
      alive: this.state.alive,
      warning: !this.state.alive && !this.state.irreversible,
      irreversible: this.state.irreversible,
      reason: this.state.reason,
      fragilityScore,
      marketState,
      metrics: {
        fragilityScore,
        refillRate,
        timeToExpiryMin,
        bookImbalance,
        isGoodWindow,
        badStreak: this.state.badStreak,
        goodStreak: this.state.goodStreak,
        isWarmup,
      },
    };
  }

  /**
   * Resets state for new market
   *
   * @remarks
   * Call this when switching to a new market.
   *
   * @example
   * ```typescript
   * evaluator.reset();
   * ```
   */
  public reset(): void {
    this.state = this.createInitialState();
    this.previousAlive = true;
    this.logger.info('[EdgeAlive] State reset for new market', {
      ...this.getMarketInfo(),
    });
  }

  /**
   * Returns current state (read-only)
   *
   * @returns Copy of current state
   */
  public getState(): Readonly<EdgeState> {
    return { ...this.state };
  }

  /**
   * Returns current configuration
   *
   * @returns Copy of configuration
   */
  public getConfig(): Readonly<EdgeAliveConfig> {
    return { ...this.config };
  }

  /**
   * Creates initial state
   */
  private createInitialState(): EdgeState {
    return {
      alive: true,
      warning: false,
      irreversible: false,
      reason: 'initial',
      badStreak: 0,
      goodStreak: 0,
      marketEnterTs: Date.now(),
    };
  }

  /**
   * Checks if current window is "good"
   */
  private isGoodWindow(
    fragilityScore: number,
    refillRate: number,
    timeToExpiryMin: number
  ): boolean {
    return (
      fragilityScore >= this.config.minFragilityScore &&
      refillRate >= this.config.minRefillRate &&
      timeToExpiryMin >= this.config.minTimeToExpiryMin
    );
  }

  /**
   * Determines reason for bad window
   */
  private determineReason(
    fragilityScore: number,
    refillRate: number,
    timeToExpiryMin: number
  ): string {
    if (fragilityScore < this.config.minFragilityScore) {
      return `low_fragility_${(fragilityScore * 100).toFixed(0)}pct`;
    }
    if (refillRate < this.config.minRefillRate) {
      return `low_refill_${(refillRate * 100).toFixed(0)}pct`;
    }
    if (timeToExpiryMin < this.config.minTimeToExpiryMin) {
      return `expiry_close_${timeToExpiryMin.toFixed(1)}min`;
    }
    return 'unknown';
  }

  /**
   * Updates streaks with exponential decay
   */
  private updateStreaks(isGoodWindow: boolean): void {
    // Apply decay to streaks
    this.state.badStreak *= this.config.streakDecayAlpha;
    this.state.goodStreak *= this.config.streakDecayAlpha;

    // Increment appropriate streak
    if (isGoodWindow) {
      this.state.goodStreak += 1;
      // Reset bad streak on good window (not just decay)
      this.state.badStreak = 0;
    } else {
      this.state.badStreak += 1;
      // Reset good streak on bad window (not just decay)
      this.state.goodStreak = 0;
    }
  }

  /**
   * Updates state based on streaks
   * Note: isGoodWindow is already factored into the streaks by updateStreaks()
   */
  private updateState(_isGoodWindow: boolean, isWarmup: boolean, reason: string): void {
    // Already dead and irreversible - no changes
    if (!this.state.alive && this.state.irreversible) {
      return;
    }

    // Death transition: badStreak exceeded threshold
    if (this.state.badStreak >= this.config.badStreakToDead) {
      this.state.alive = false;
      this.state.warning = false;
      this.state.reason = reason;

      // Irreversible only after warmup
      if (!isWarmup) {
        this.state.irreversible = true;
      }
      return;
    }

    // Warning transition: alive but badStreak > 0
    if (this.state.badStreak > 0 && this.state.alive) {
      this.state.alive = false;
      this.state.warning = true;
      this.state.reason = `warning:${reason}`;
      return;
    }

    // Revival transition: not alive, not irreversible, good streak exceeded
    if (!this.state.alive && !this.state.irreversible &&
        this.state.goodStreak >= this.config.goodStreakToRevive) {
      this.state.alive = true;
      this.state.warning = false;
      this.state.reason = 'recovered';
      return;
    }

    // Healthy state
    if (this.state.alive) {
      this.state.warning = false;
      this.state.reason = 'edge_alive';
    }
  }

  /**
   * Logs evaluation details
   */
  private logEvaluation(
    fragilityScore: number,
    refillRate: number,
    timeToExpiryMin: number,
    isWarmup: boolean
  ): void {
    // isGoodWindow is computed from these metrics
    const isGoodWindow = this.isGoodWindow(fragilityScore, refillRate, timeToExpiryMin);

    // TRACE-level: isGoodWindow calculation breakdown
    const fragilityCheck = fragilityScore >= this.config.minFragilityScore;
    const refillCheck = refillRate >= this.config.minRefillRate;
    const timeCheck = timeToExpiryMin >= this.config.minTimeToExpiryMin;

    this.logger.trace('[EdgeAlive] isGoodWindow calculation', {
      ...this.getMarketInfo(),
      fragilityScore: fragilityScore.toFixed(4),
      minFragilityScore: this.config.minFragilityScore,
      fragilityCheck: fragilityCheck ? `PASS (${fragilityScore.toFixed(4)} >= ${this.config.minFragilityScore})` : `FAIL (${fragilityScore.toFixed(4)} < ${this.config.minFragilityScore})`,
      refillRate: refillRate.toFixed(4),
      minRefillRate: this.config.minRefillRate,
      refillCheck: refillCheck ? `PASS (${refillRate.toFixed(4)} >= ${this.config.minRefillRate})` : `FAIL (${refillRate.toFixed(4)} < ${this.config.minRefillRate})`,
      timeToExpiryMin: timeToExpiryMin.toFixed(1),
      minTimeToExpiryMin: this.config.minTimeToExpiryMin,
      timeCheck: timeCheck ? `PASS (${timeToExpiryMin.toFixed(1)} >= ${this.config.minTimeToExpiryMin})` : `FAIL (${timeToExpiryMin.toFixed(1)} < ${this.config.minTimeToExpiryMin})`,
      isGoodWindow: isGoodWindow ? 'YES (all checks PASS)' : 'NO (at least one FAIL)',
      formula: 'isGoodWindow = fragilityCheck AND refillCheck AND timeCheck',
    });

    // TRACE-level: Streak decay calculation
    this.logger.trace('[EdgeAlive] Streak state', {
      ...this.getMarketInfo(),
      streakDecayAlpha: this.config.streakDecayAlpha,
      badStreak: this.state.badStreak.toFixed(4),
      badStreakToDead: this.config.badStreakToDead,
      badStreakStatus: this.state.badStreak >= this.config.badStreakToDead ? `THRESHOLD_EXCEEDED (${this.state.badStreak.toFixed(2)} >= ${this.config.badStreakToDead})` : `OK (${this.state.badStreak.toFixed(2)} < ${this.config.badStreakToDead})`,
      goodStreak: this.state.goodStreak.toFixed(4),
      goodStreakToRevive: this.config.goodStreakToRevive,
      goodStreakStatus: this.state.goodStreak >= this.config.goodStreakToRevive ? `REVIVAL_POSSIBLE (${this.state.goodStreak.toFixed(2)} >= ${this.config.goodStreakToRevive})` : `NOT_ENOUGH (${this.state.goodStreak.toFixed(2)} < ${this.config.goodStreakToRevive})`,
      formula: 'streak = streak × decayAlpha + (isGoodWindow ? 1 : 0)',
    });

    // TRACE-level: Warmup status
    const elapsedMs = Date.now() - this.state.marketEnterTs;
    this.logger.trace('[EdgeAlive] Warmup status', {
      ...this.getMarketInfo(),
      marketEnterTs: new Date(this.state.marketEnterTs).toISOString(),
      elapsedMs,
      warmupMs: this.config.warmupMs,
      isWarmup: isWarmup ? `YES (${elapsedMs}ms < ${this.config.warmupMs}ms)` : `NO (${elapsedMs}ms >= ${this.config.warmupMs}ms)`,
      deathReversibility: isWarmup ? 'REVERSIBLE (in warmup)' : 'IRREVERSIBLE (after warmup)',
    });

    // TRACE-level: State transition logic
    this.logger.trace('[EdgeAlive] State transition logic', {
      ...this.getMarketInfo(),
      currentAlive: this.state.alive,
      currentWarning: this.state.warning,
      currentIrreversible: this.state.irreversible,
      reason: this.state.reason,
      possibleTransitions: this.state.alive
        ? (this.state.badStreak > 0 ? 'ALIVE → WARNING (badStreak > 0)' : 'ALIVE → ALIVE')
        : (this.state.irreversible
            ? 'DEAD (irreversible, no transitions)'
            : (this.state.goodStreak >= this.config.goodStreakToRevive
                ? 'WARNING → ALIVE (revival possible)'
                : (this.state.badStreak >= this.config.badStreakToDead
                    ? (isWarmup ? 'WARNING → DEAD (reversible)' : 'WARNING → DEAD (irreversible)')
                    : 'WARNING → WARNING'))),
    });

    this.logger.debug('[EdgeAlive] Evaluation', {
      ...this.getMarketInfo(),
      isGoodWindow,
      fragilityScore: fragilityScore.toFixed(4),
      refillRate: refillRate.toFixed(4),
      timeToExpiryMin: timeToExpiryMin.toFixed(1),
      badStreak: this.state.badStreak.toFixed(2),
      goodStreak: this.state.goodStreak.toFixed(2),
      isWarmup,
      alive: this.state.alive,
      warning: this.state.warning,
      irreversible: this.state.irreversible,
    });
  }

  /**
   * Logs state transition
   */
  private logStateTransition(): void {
    const newState = this.state.alive
      ? 'ALIVE'
      : (this.state.irreversible ? 'DEAD' : 'WARNING');

    const previousState = this.previousAlive ? 'ALIVE' : 'WARNING/DEAD';

    if (this.state.irreversible) {
      this.logger.error('[EdgeAlive] IRREVERSIBLE DEATH', {
        ...this.getMarketInfo(),
        from: previousState,
        to: newState,
        reason: this.state.reason,
        badStreak: this.state.badStreak.toFixed(2),
        elapsedMs: Date.now() - this.state.marketEnterTs,
      });
    } else if (!this.state.alive) {
      this.logger.warn('[EdgeAlive] State transition', {
        ...this.getMarketInfo(),
        from: previousState,
        to: newState,
        reason: this.state.reason,
        badStreak: this.state.badStreak.toFixed(2),
        goodStreak: this.state.goodStreak.toFixed(2),
      });
    } else {
      // Recovery
      this.logger.info('[EdgeAlive] Edge recovered', {
        ...this.getMarketInfo(),
        from: previousState,
        to: newState,
        reason: this.state.reason,
        goodStreak: this.state.goodStreak.toFixed(2),
      });
    }
  }
}
