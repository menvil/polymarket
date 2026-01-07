/**
 * Configuration loader and provider
 *
 * @remarks
 * Central configuration management that combines:
 * - Trading configuration (TradingConfig)
 * - Environment variables (EnvConfig)
 * - Runtime configuration overrides
 *
 * Provides a single source of truth for all configuration needs.
 *
 * @example
 * ```typescript
 * import { ConfigLoader } from '@infrastructure/config/ConfigLoader';
 *
 * const config = ConfigLoader.getInstance();
 * const maxPosition = config.getTrading().RISK.MAX_NET_POSITION;
 * const privateKey = config.getEnv().PRIVATE_KEY;
 *
 * // Get risk config with logging
 * const riskConfig = config.getRiskConfig(logger);
 * ```
 */
import { TradingConfig, TradingConfigType } from './TradingConfig.js';
import { EnvConfig, IEnvConfig } from './EnvConfig.js';
import type { RiskConfig } from '../../domain/services/risk/RiskAssessmentService.js';
import type { EdgeAliveConfig } from '../../domain/services/risk/EdgeAliveEvaluator.js';
import type { TradeFlowConfig, OrderbookHealthConfig } from '../../domain/services/signals/index.js';
import type { ILogger } from '../../domain/ports/ILogger.js';

/**
 * Configuration loader singleton
 * 
 * @remarks
 * Implements singleton pattern to ensure single configuration instance.
 * Provides methods to access trading and environment configuration.
 */
export class ConfigLoader {
  private static instance: ConfigLoader;
  private tradingConfig: TradingConfigType;
  private envConfig: IEnvConfig;

  /**
   * Private constructor for singleton pattern
   */
  private constructor() {
    this.tradingConfig = TradingConfig;
    this.envConfig = EnvConfig;
  }

  /**
   * Gets the singleton instance
   * 
   * @returns ConfigLoader instance
   * 
   * @example
   * ```typescript
   * const config = ConfigLoader.getInstance();
   * ```
   */
  public static getInstance(): ConfigLoader {
    if (!ConfigLoader.instance) {
      ConfigLoader.instance = new ConfigLoader();
    }
    return ConfigLoader.instance;
  }

  /**
   * Gets trading configuration
   * 
   * @returns Trading configuration object
   * 
   * @example
   * ```typescript
   * const tradingConfig = config.getTrading();
   * console.log(tradingConfig.RISK.MAX_NET_POSITION);
   * ```
   */
  public getTrading(): TradingConfigType {
    return this.tradingConfig;
  }

  /**
   * Gets environment configuration
   * 
   * @returns Environment configuration object
   * 
   * @example
   * ```typescript
   * const envConfig = config.getEnv();
   * console.log(envConfig.NODE_ENV);
   * ```
   */
  public getEnv(): IEnvConfig {
    return this.envConfig;
  }

  /**
   * Checks if running in simulation mode
   * 
   * @returns True if in simulation mode
   * 
   * @example
   * ```typescript
   * if (config.isSimulationMode()) {
   *   console.log('Running in simulation mode');
   * }
   * ```
   */
  public isSimulationMode(): boolean {
    return this.tradingConfig.SIMULATION_MODE;
  }

  /**
   * Checks if running in safe mode
   * 
   * @returns True if safe mode is enabled
   * 
   * @example
   * ```typescript
   * if (config.isSafeMode()) {
   *   console.log('Safe mode enabled');
   * }
   * ```
   */
  public isSafeMode(): boolean {
    return this.tradingConfig.LIVE.SAFE_MODE;
  }

  /**
   * Checks if in development environment
   * 
   * @returns True if in development
   */
  public isDevelopment(): boolean {
    return this.envConfig.NODE_ENV === 'development';
  }

  /**
   * Checks if in production environment
   * 
   * @returns True if in production
   */
  public isProduction(): boolean {
    return this.envConfig.NODE_ENV === 'production';
  }

  /**
   * Checks if in test environment
   *
   * @returns True if in test
   */
  public isTest(): boolean {
    return this.envConfig.NODE_ENV === 'test';
  }

  /**
   * Gets risk configuration with environment overrides
   *
   * @param logger - Logger instance for logging loaded config
   * @returns RiskConfig object with values from env and defaults
   *
   * @remarks
   * Loads risk configuration from environment variables with fallback to defaults.
   * Logs the loaded configuration for debugging.
   *
   * Алгоритм:
   * 1. Читает RISK_TIME_URGENCY_SECONDS из .env (default: 86400)
   * 2. Комбинирует с TradingConfig.RISK для остальных параметров
   * 3. Логирует загруженные значения
   *
   * @example
   * ```typescript
   * const config = ConfigLoader.getInstance();
   * const riskConfig = config.getRiskConfig(logger);
   *
   * // riskConfig.timeUrgencySeconds = 86400 (from .env)
   * // riskConfig.maxNetPosition = 50 (from TradingConfig)
   * ```
   */
  public getRiskConfig(logger?: ILogger): RiskConfig {
    // Загружаем все параметры из .env
    const riskConfig: RiskConfig = {
      maxNetPosition: this.envConfig.RISK_MAX_NET_POSITION,
      maxGrossPosition: this.envConfig.RISK_MAX_GROSS_POSITION,
      panicThreshold: this.envConfig.RISK_PANIC_THRESHOLD,
      inventoryThreshold: this.envConfig.RISK_INVENTORY_THRESHOLD,
      timeUrgencySeconds: this.envConfig.RISK_TIME_URGENCY_SECONDS,
    };

    if (logger) {
      logger.info('Risk config loaded from .env', {
        component: 'ConfigLoader',
        maxNetPosition: riskConfig.maxNetPosition,
        maxGrossPosition: riskConfig.maxGrossPosition,
        panicThreshold: riskConfig.panicThreshold,
        inventoryThreshold: riskConfig.inventoryThreshold,
        timeUrgencySeconds: riskConfig.timeUrgencySeconds,
        timeUrgencyHours: (riskConfig.timeUrgencySeconds / 3600).toFixed(2),
      });
    }

    return riskConfig;
  }

  /**
   * Gets EdgeAlive configuration from environment
   *
   * @returns Partial<EdgeAliveConfig> with values from .env
   *
   * @remarks
   * Maps environment variables to EdgeAliveConfig interface.
   * Returns partial config to be merged with defaults in EdgeAliveEvaluator.
   *
   * @example
   * ```typescript
   * const edgeConfig = config.getEdgeAliveConfig();
   * // edgeConfig.minFragilityScore = 0.1 (from .env)
   * ```
   */
  public getEdgeAliveConfig(): Partial<EdgeAliveConfig> {
    return {
      minFragilityScore: this.envConfig.EDGE_ALIVE_MIN_FRAGILITY_SCORE,
      minRefillRate: this.envConfig.EDGE_ALIVE_MIN_REFILL_RATE,
      minTimeToExpiryMin: this.envConfig.EDGE_ALIVE_MIN_TIME_TO_EXPIRY_MIN,
      warmupMs: this.envConfig.EDGE_ALIVE_WARMUP_MS,
      badStreakToDead: this.envConfig.EDGE_ALIVE_BAD_STREAK_TO_DEAD,
      goodStreakToRevive: this.envConfig.EDGE_ALIVE_GOOD_STREAK_TO_REVIVE,
      streakDecayAlpha: this.envConfig.EDGE_ALIVE_STREAK_DECAY_ALPHA,
    };
  }

  /**
   * Gets TradeFlow configuration from environment
   *
   * @returns Partial<TradeFlowConfig> with values from .env
   *
   * @remarks
   * Maps environment variables to TradeFlowConfig interface.
   * Returns partial config to be merged with defaults in TradeFlowAnalyzer.
   *
   * @example
   * ```typescript
   * const tradeFlowConfig = config.getTradeFlowConfig();
   * // tradeFlowConfig.fragilityScale = 5 (from .env)
   * ```
   */
  public getTradeFlowConfig(): Partial<TradeFlowConfig> {
    return {
      bookLevels: this.envConfig.TRADE_FLOW_BOOK_LEVELS,
      bookMinThreshold: this.envConfig.TRADE_FLOW_BOOK_MIN_THRESHOLD,
      minAggressiveVolume: this.envConfig.TRADE_FLOW_MIN_AGGRESSIVE_VOLUME,
      fragilityScale: this.envConfig.TRADE_FLOW_FRAGILITY_SCALE,
      decayLambda: this.envConfig.TRADE_FLOW_DECAY_LAMBDA,
      timeToFillFast: this.envConfig.TRADE_FLOW_TIME_TO_FILL_FAST,
      timeToFillMedium: this.envConfig.TRADE_FLOW_TIME_TO_FILL_MEDIUM,
      timeToFillSlow: this.envConfig.TRADE_FLOW_TIME_TO_FILL_SLOW,
    };
  }

  /**
   * Gets OrderbookHealth configuration from environment
   *
   * @returns Partial<OrderbookHealthConfig> with values from .env
   *
   * @remarks
   * Maps environment variables to OrderbookHealthConfig interface.
   * Returns partial config to be merged with defaults in OrderbookHealthMonitor.
   *
   * @example
   * ```typescript
   * const orderbookConfig = config.getOrderbookHealthConfig();
   * // orderbookConfig.minHealthyDepth = 20 (from .env)
   * ```
   */
  public getOrderbookHealthConfig(): Partial<OrderbookHealthConfig> {
    return {
      minHealthyDepth: this.envConfig.ORDERBOOK_HEALTH_MIN_DEPTH,
      emaAlpha: this.envConfig.ORDERBOOK_HEALTH_EMA_ALPHA,
      summaryIntervalMs: this.envConfig.ORDERBOOK_HEALTH_SUMMARY_INTERVAL_MS,
    };
  }

  /**
   * Gets full strategy configuration from environment
   *
   * @returns StrategyConfig with all strategy parameters from .env
   *
   * @remarks
   * Provides complete configuration for TwoSidedMarketMaker.
   * All magic numbers are externalized to .env file.
   *
   * @example
   * ```typescript
   * const strategyConfig = config.getStrategyConfig();
   * // strategyConfig.baseSpread = 0.02
   * // strategyConfig.skewExponent = 2.5
   * ```
   */
  public getStrategyConfig(): StrategyConfig {
    return {
      // Quote Generation
      baseSpread: this.envConfig.STRATEGY_BASE_SPREAD,
      quoteSize: this.envConfig.STRATEGY_QUOTE_SIZE,
      minSpread: this.envConfig.STRATEGY_MIN_SPREAD,
      maxSpread: this.envConfig.STRATEGY_MAX_SPREAD,
      validationMinSpread: this.envConfig.STRATEGY_VALIDATION_MIN_SPREAD,
      priceCrossAdjustment: this.envConfig.STRATEGY_PRICE_CROSS_ADJUSTMENT,
      inventorySensitivity: this.envConfig.STRATEGY_INVENTORY_SENSITIVITY,
      maxSkew: this.envConfig.STRATEGY_MAX_SKEW,
      inventorySpreadMultiplier: this.envConfig.STRATEGY_INVENTORY_SPREAD_MULTIPLIER,
      riskSpreadCoefficient: this.envConfig.STRATEGY_RISK_SPREAD_COEFFICIENT,

      // Non-Linear Skew
      skewExponent: this.envConfig.STRATEGY_SKEW_EXPONENT,
      skewBaseFactor: this.envConfig.STRATEGY_SKEW_BASE_FACTOR,
      maxSkewValue: this.envConfig.STRATEGY_MAX_SKEW_VALUE,
      skewUrgentHours: this.envConfig.STRATEGY_SKEW_URGENT_HOURS,
      skewModerateHours: this.envConfig.STRATEGY_SKEW_MODERATE_HOURS,
      skewMaxTimeMultiplier: this.envConfig.STRATEGY_SKEW_MAX_TIME_MULTIPLIER,
      skewTimeMultiplierRange: this.envConfig.STRATEGY_SKEW_TIME_MULTIPLIER_RANGE,

      // Recovery Mode
      recoveryBaseCrossing: this.envConfig.STRATEGY_RECOVERY_BASE_CROSSING,
      recoveryDefaultUrgency: this.envConfig.STRATEGY_RECOVERY_DEFAULT_URGENCY,
      recoveryUrgentHours: this.envConfig.STRATEGY_RECOVERY_URGENT_HOURS,
      recoveryModerateHours: this.envConfig.STRATEGY_RECOVERY_MODERATE_HOURS,
      fragilityBoostFactor: this.envConfig.STRATEGY_FRAGILITY_BOOST_FACTOR,
      urgencyCrossingFactor: this.envConfig.STRATEGY_URGENCY_CROSSING_FACTOR,

      // Panic Mode
      panicMaxCrossing: this.envConfig.STRATEGY_PANIC_MAX_CROSSING,

      // Fair Value Calculation
      fairValueWeightMid: this.envConfig.FAIR_VALUE_WEIGHT_MID,
      fairValueWeightMicroprice: this.envConfig.FAIR_VALUE_WEIGHT_MICROPRICE,
      fairValueWeightEma: this.envConfig.FAIR_VALUE_WEIGHT_EMA,
      fairValueEmaAlpha: this.envConfig.FAIR_VALUE_EMA_ALPHA,
    };
  }

  /**
   * Gets position management configuration from environment
   *
   * @returns PositionConfig with position thresholds from .env
   */
  public getPositionConfig(): PositionConfig {
    return {
      neutralThreshold: this.envConfig.POSITION_NEUTRAL_THRESHOLD,
      hedgePerfectThreshold: this.envConfig.HEDGE_PERFECT_THRESHOLD,
      hedgeGoodThreshold: this.envConfig.HEDGE_GOOD_THRESHOLD,
      hedgeModerateThreshold: this.envConfig.HEDGE_MODERATE_THRESHOLD,
      hedgePoorThreshold: this.envConfig.HEDGE_POOR_THRESHOLD,
      hedgeMinAcceptable: this.envConfig.HEDGE_MIN_ACCEPTABLE,
      hedgeIsHedgedThreshold: this.envConfig.HEDGE_IS_HEDGED_THRESHOLD,
    };
  }

  /**
   * Gets execution configuration from environment
   *
   * @returns ExecutionConfig with execution parameters from .env
   */
  public getExecutionConfig(): ExecutionConfig {
    return {
      maxSlippagePercent: this.envConfig.EXECUTION_MAX_SLIPPAGE_PERCENT,
    };
  }

  /**
   * Gets risk utilization thresholds from environment
   *
   * @returns RiskUtilizationConfig with threshold values from .env
   */
  public getRiskUtilizationConfig(): RiskUtilizationConfig {
    return {
      criticalThreshold: this.envConfig.RISK_CRITICAL_UTILIZATION,
      highThreshold: this.envConfig.RISK_HIGH_UTILIZATION,
    };
  }
}

/**
 * Full strategy configuration interface
 */
export interface StrategyConfig {
  // Quote Generation
  baseSpread: number;
  quoteSize: number;
  minSpread: number;
  maxSpread: number;
  validationMinSpread: number;
  priceCrossAdjustment: number;
  inventorySensitivity: number;
  maxSkew: number;
  inventorySpreadMultiplier: number;
  riskSpreadCoefficient: number;

  // Non-Linear Skew
  skewExponent: number;
  skewBaseFactor: number;
  maxSkewValue: number;
  skewUrgentHours: number;
  skewModerateHours: number;
  skewMaxTimeMultiplier: number;
  skewTimeMultiplierRange: number;

  // Recovery Mode
  recoveryBaseCrossing: number;
  recoveryDefaultUrgency: number;
  recoveryUrgentHours: number;
  recoveryModerateHours: number;
  fragilityBoostFactor: number;
  urgencyCrossingFactor: number;

  // Panic Mode
  panicMaxCrossing: number;

  // Fair Value Calculation
  fairValueWeightMid: number;
  fairValueWeightMicroprice: number;
  fairValueWeightEma: number;
  fairValueEmaAlpha: number;
}

/**
 * Position management configuration interface
 */
export interface PositionConfig {
  neutralThreshold: number;
  hedgePerfectThreshold: number;
  hedgeGoodThreshold: number;
  hedgeModerateThreshold: number;
  hedgePoorThreshold: number;
  hedgeMinAcceptable: number;
  hedgeIsHedgedThreshold: number;
}

/**
 * Execution configuration interface
 */
export interface ExecutionConfig {
  maxSlippagePercent: number;
}

/**
 * Risk utilization configuration interface
 */
export interface RiskUtilizationConfig {
  criticalThreshold: number;
  highThreshold: number;
}
