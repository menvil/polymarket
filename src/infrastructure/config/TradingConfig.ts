/**
 * Trading configuration for Polymarket Market Making Bot
 *
 * @remarks
 * Contains all trading parameters, risk limits, and strategy settings.
 *
 * IMPORTANT: dotenv must be imported before accessing process.env
 */
import 'dotenv/config';

/**
 * @remarks
 * Configuration is structured by domain concern:
 * - API endpoints and blockchain settings
 * - Market discovery and selection criteria
 * - Fair value calculation parameters
 * - Risk management and position limits
 * - Quote generation settings
 * - Order management system parameters
 * 
 * @example
 * ```typescript
 * import { TradingConfig } from '@infrastructure/config/TradingConfig';
 * 
 * const maxPosition = TradingConfig.RISK.MAX_NET_POSITION;
 * console.log(`Max position: ${maxPosition}`);
 * ```
 */
export const TradingConfig = {
  // API endpoints
  CLOB_HOST: 'https://clob.polymarket.com',
  WS_HOST: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
  GAMMA_API: 'https://gamma-api.polymarket.com',
  CHAIN_ID: 137,

  // Market Discovery
  MARKET_FILTERS: {
    MIN_TIME_TO_EXPIRY_HOURS: 0,  // 0 = take any market including closest to expiry
    MIN_SPREAD: 0.02,
    MIN_DAILY_VOLUME: 100,
    MAX_MARKETS_TO_TRACK: 5
  },

  // Fair Value Model (INDEPENDENT YES and NO)
  FAIR_VALUE: {
    W_MID: 0.5,          // Weight of mid price
    W_MICROPRICE: 0.3,   // Weight of microprice (bid/ask weighted)
    W_EMA: 0.2,          // Weight of EMA
    EMA_ALPHA: 0.1,      // EMA smoothing factor

    // Mismatch handling (YES + NO should ≈ 1)
    MISMATCH_WARN: 0.01,     // 1% mismatch - log warning
    MISMATCH_DANGER: 0.02,   // 2% mismatch - reduce size, widen spread
    MISMATCH_KILL: 0.04,     // 4% mismatch - stop quoting

    // Mismatch penalties
    SIZE_PENALTY_PER_PCT: 0.5,    // Reduce size by 50% per 1% mismatch
    SPREAD_MULTIPLIER_PER_PCT: 2.0 // Multiply spread by 2x per 1% mismatch
  },

  // Risk & Inventory
  RISK: {
    MAX_NET_POSITION: 50,
    MAX_GROSS_POSITION: 100,
    INITIAL_CASH: 10000,

    // Non-linear skew (PURE INVENTORY RISK CONTROL)
    BASE_SKEW_FACTOR: 0.05,
    SKEW_EXPONENT: 2.5,

    // Time urgency
    URGENCY_THRESHOLD_HOURS: 2,
    URGENCY_CRITICAL_HOURS: 0.5,

    // Unwind
    UNWIND_TRIGGER_INVENTORY_PCT: 0.85,
    UNWIND_TRIGGER_TIME_MIN: 2,
    UNWIND_TRIGGER_LOSS_PCT: 0.10,
    UNWIND_SPREAD_REDUCTION: 0.5,
    UNWIND_SIZE_MULTIPLIER: 2.0,
    SUPERPANIC_SECONDS: 20,  // Force exit <20s to expiry

    // Kill switch
    KILL_SWITCH_STREAK: 8,
    KILL_SWITCH_LOSS_PCT: 0.18
  },

  // Alpha Signal (DIRECTIONAL from flow/trades)
  ALPHA: {
    MAX_ALPHA_SKEW: 0.01,        // Max 1% directional skew from flow
    INFORMED_MULTIPLIER: 1.5,    // Boost when informed flow detected
    CONFIDENCE_THRESHOLD: 0.6    // Min confidence to apply alpha
  },

  // MODE state machine
  MODE: {
    // Mode transition thresholds
    QUOTE_TO_SKEW_INVENTORY: 0.5,     // 50% net inventory → enter SKEW mode
    SKEW_TO_UNWIND_INVENTORY: 0.85,   // 85% net inventory → enter UNWIND mode
    UNWIND_TO_PANIC_TIME_MIN: 3,      // 3 minutes to expiry → enter PANIC mode
    PANIC_LOSS_PCT: 0.15,              // 15% loss → enter PANIC mode

    // Mode-specific parameters
    SKEW_SPREAD_MULTIPLIER: 1.2,       // 20% wider spread in SKEW mode
    UNWIND_SPREAD_REDUCTION: 0.5,      // 50% tighter spread in UNWIND mode
    UNWIND_SIZE_MULTIPLIER: 2.0,       // 2x size in UNWIND mode
    PANIC_CROSS_SPREAD: true,          // Cross spread in PANIC (take liquidity)

    // Escalation (if unwind orders don't fill)
    ESCALATION_INTERVAL_MS: 10000,     // Escalate every 10 seconds
    ESCALATION_ATTEMPTS_THRESHOLD: 3,  // After 3 attempts without fill, escalate
    MAX_ESCALATION_LEVEL: 5,           // Max escalation level
    ESCALATION_PRICE_STEP: 0.001,      // Cross spread by 0.1% per level
    ESCALATION_SIZE_MULTIPLIER: 1.2    // Increase size by 20% per level
  },

  // Edge Alive Thresholds (TWO-STAGE DEATH with warm-up)
  EDGE_ALIVE: {
    MIN_TRADE_FLOW_SYMMETRY: 0.35,      // 1-imbalance (0.35 = 65/35 split max)
    MIN_ORDERBOOK_REFILL_RATE: 0.3,    // 30% of updates show depth recovery
    MIN_TIME_TO_EXPIRY_MIN: 4,          // 4 minutes minimum
    MEASUREMENT_WINDOW_MS: 60000,       // Measure over 60 seconds

    // Warm-up and staged transitions (prevent instant irreversible death)
    WARMUP_MS: 90000,                   // 90s warm-up after market switch (no irreversible death)
    BAD_STREAK_TO_DEAD: 4,              // Need 4 consecutive bad windows for irreversible death
    GOOD_STREAK_TO_REVIVE: 2,           // 2 consecutive good windows to revive from warning
    MIN_TRADES_IN_WINDOW: 10,           // Ignore tradeflow if < 10 trades (noisy data)
    MIN_UPDATES_IN_WINDOW: 30           // Ignore orderbook metrics if < 30 updates
  },

  // Quoting
  QUOTING: {
    BASE_SPREAD: 0.03,
    MIN_EDGE: 0.005,
    BASE_SIZE: 4,

    // Price/Size constraints
    MIN_PRICE: 0.0001,
    MAX_PRICE: 0.9999,
    PRICE_TICK: 0.0001,  // 1 basis point
    MIN_SIZE: 0.1,
    SIZE_TICK: 0.1,

    // Ultra-conservative mode (edge warning) - HARD CAPS
    WARNING_SIZE_MULT: 0.1,         // 10% of base size
    WARNING_SPREAD_MULT: 4.0,       // 4x base spread

    // Anti-flicker
    MIN_REPLACE_INTERVAL_MS: 2000,  // 2 seconds
    MIN_PRICE_CHANGE_FOR_REPLACE: 0.0025  // 25 bps (10 bps in original)
  },

  // Kelly-lite sizing (bankroll-aware)
  KELLY: {
    ENABLED: true,
    KELLY_FRACTION: 0.07,           // Use 7% of full Kelly (conservative)
    MIN_EDGE_FOR_KELLY: 0.005,     // 0.5% minimum edge to apply Kelly
    MAX_BANKROLL_FRACTION: 0.03,   // Never bet more than 3% of bankroll per trade
    WIN_PROB_ESTIMATE: 0.52        // Assume 52% win rate for MM (slight edge)
  },

  // OMS
  OMS: {
    MAX_ORDERS_PER_TOKEN: 4,  // bid/ask for each side
    ORDER_SYNC_INTERVAL_MS: 10000,  // reconcile every 10s
    CANCEL_TIMEOUT_MS: 5000
  },

  // Trade detection
  TRADE_DETECTION: {
    AGGRESSIVE_SIZE_THRESHOLD: 15,
    DEPTH_REMOVAL_RATIO_THRESHOLD: 0.3,
    INFORMED_COOLDOWN_MS: 8000
  },

  // Pre-trade signals (orderbook health monitoring)
  PRETRADE_SIGNALS: {
    DEPTH_THINNING_THRESHOLD: 0.5,    // 50% drop in depth = thinning
    MIN_HEALTHY_DEPTH: 20,             // Minimum healthy depth at top of book
    SPREAD_WIDENING_THRESHOLD: 2.0,   // 2x normal spread = warning
    DEPTH_CHECK_LEVELS: 3,             // Check top 3 levels
    SIGNAL_COOLDOWN_MS: 5000          // Don't spam signals
  },

  // Arbitrage
  ARBITRAGE: {
    MIN_EDGE_BUY_BOTH: 0.01,   // 1% edge to buy both YES+NO
    MIN_EDGE_SELL_BOTH: 0.01,  // 1% edge to sell both YES+NO
    FEE_ESTIMATE: 0.002        // 0.2% estimated fees
  },

  // Mode
  // SIMULATION_MODE читается из .env (SIMULATION_MODE=1 или SIMULATION_MODE=true)
  // true = dry-run (no real orders), false = LIVE with real orders
  SIMULATION_MODE: process.env.SIMULATION_MODE === '1' || process.env.SIMULATION_MODE === 'true',

  // LIVE Trading Safety Limits
  LIVE: {
    SAFE_MODE: process.env.LIVE_SAFE_MODE === '1',
    CLEAN_START: process.env.LIVE_CLEAN_START === '1',

    MAX_MARKETS: 1,                      // Trade only 1 market at a time
    MAX_SIZE_PER_ORDER: 0.1,             // 0.1 shares max per order
    MAX_ACTIVE_ORDERS_TOTAL: 4,          // Max 4 orders total
    MAX_ACTIVE_ORDERS_PER_TOKEN_SIDE: 1, // Max 1 bid + 1 ask per token
    MAX_NET_SHARES: 1,                   // Max 1 share net position
    MAX_GROSS_SHARES: 2,                 // Max 2 shares gross
    MAX_API_ERROR_STREAK: 5,             // Stop after 5 consecutive API errors

    // Balance monitoring
    BALANCE_CHECK_INTERVAL_MS: 30000,    // Check balance every 30s
    MIN_USDC_BALANCE: 1,                 // Pause if balance < 1 USDC
  },

  // UI Display
  UI: {
    ASCII_ONLY: true  // true = use ASCII symbols, false = use emoji
  },
} as const;

export type TradingConfigType = typeof TradingConfig;
