/**
 * Environment configuration loader
 * 
 * @remarks
 * Loads and validates environment variables from .env files.
 * Provides type-safe access to configuration values with validation.
 * 
 * Algorithm:
 * 1. Load environment variables from .env file
 * 2. Validate required variables are present
 * 3. Parse and type-check values
 * 4. Export typed configuration object
 * 
 * @throws {Error} If required environment variables are missing
 * 
 * @example
 * ```typescript
 * import { EnvConfig } from '@infrastructure/config/EnvConfig';
 * 
 * const privateKey = EnvConfig.PRIVATE_KEY;
 * const nodeEnv = EnvConfig.NODE_ENV;
 * ```
 */
import 'dotenv/config';

/**
 * Environment configuration interface
 */
export interface IEnvConfig {
  NODE_ENV: 'development' | 'test' | 'production';
  PRIVATE_KEY?: string;
  FUNDER_ADDRESS?: string;
  POLYGON_RPC_URL: string;
  LIVE_SAFE_MODE: boolean;
  LIVE_CLEAN_START: boolean;
  LOG_LEVEL: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  POLYMARKET_API_URL?: string;
  POLYMARKET_WS_URL?: string;
  GAMMA_API_URL?: string;
  MARKET_ID?: string;
  INITIAL_BALANCE?: string;

  // ========================================
  // Risk Management Configuration
  // ========================================

  /**
   * Maximum net position (absolute value of YES - NO)
   *
   * @remarks
   * Максимальная нетто-позиция. При превышении включается inventory mode.
   * Default: 1000
   */
  RISK_MAX_NET_POSITION: number;

  /**
   * Maximum gross position (YES + NO)
   *
   * @remarks
   * Максимальная брутто-позиция (сумма всех позиций).
   * Default: 2000
   */
  RISK_MAX_GROSS_POSITION: number;

  /**
   * Panic mode threshold (0-1, triggers emergency exit)
   *
   * @remarks
   * Порог urgency для перехода в PANIC mode.
   * При urgency >= threshold бот прекращает котирование и закрывает позиции.
   * Default: 0.8 (80%)
   */
  RISK_PANIC_THRESHOLD: number;

  /**
   * Inventory mode threshold (0-1, triggers inventory management)
   *
   * @remarks
   * Порог urgency для перехода в INVENTORY mode.
   * При urgency >= threshold бот начинает активно управлять inventory.
   * Default: 0.5 (50%)
   */
  RISK_INVENTORY_THRESHOLD: number;

  /**
   * Time urgency period in seconds
   *
   * @remarks
   * Период до экспирации, в течение которого urgency растёт от 0% до 100%.
   * При secondsToExpiry = timeUrgencySeconds → urgency = 0%
   * При secondsToExpiry = 0 → urgency = 100%
   *
   * Examples:
   *   86400 = 24 hours
   *   43200 = 12 hours
   *   3600 = 1 hour
   *
   * Default: 86400 (24 hours)
   */
  RISK_TIME_URGENCY_SECONDS: number;

  // ========================================
  // Market Rotation Configuration
  // ========================================

  /**
   * Pause between market scans (ms)
   *
   * @remarks
   * После завершения сканирования ждём это время перед следующим.
   * Default: 30000 (30 seconds)
   */
  MARKET_SCAN_PAUSE_MS: number;

  /**
   * Market expiry check interval (ms)
   *
   * @remarks
   * Как часто проверять истечение текущего маркета.
   * Default: 1000 (1 second)
   */
  MARKET_EXPIRY_CHECK_INTERVAL_MS: number;

  // ========================================
  // Market Discovery Configuration
  // ========================================

  /**
   * Minimum hours until market expiry
   *
   * @remarks
   * Маркеты с меньшим временем до экспирации будут отфильтрованы.
   * 0 = любой маркет, включая ближайший к экспирации.
   * Default: 0
   */
  MARKET_DISCOVERY_MIN_TIME_TO_EXPIRY_HOURS: number;

  /**
   * Minimum spread (0-1)
   *
   * @remarks
   * Минимальный спред между bid и ask.
   * Маркеты с меньшим спредом будут отфильтрованы.
   * Default: 0.02 (2%)
   */
  MARKET_DISCOVERY_MIN_SPREAD: number;

  /**
   * Minimum daily volume (USD)
   *
   * @remarks
   * Минимальный дневной объём торгов в USD.
   * Default: 100
   */
  MARKET_DISCOVERY_MIN_DAILY_VOLUME: number;

  // ========================================
  // Multi-Market Trading Configuration
  // ========================================

  /**
   * Maximum concurrent markets to trade
   *
   * @remarks
   * Максимальное количество маркетов для ОДНОВРЕМЕННОЙ торговли.
   * 0 = подписка на ВСЕ маркеты, прошедшие фильтры
   * N > 0 = подписка максимум на N маркетов
   * Если маркетов меньше N - подписка на все доступные
   * Default: 5
   */
  MAX_CONCURRENT_MARKETS: number;

  /**
   * Fraction of total balance available for trading
   *
   * @remarks
   * Какая доля общего баланса доступна для торговли.
   * Значение: (0.0, 1.0]
   * Пример: 0.8 = 80% баланса для торговли, 20% в резерве
   * Default: 1.0 (весь баланс)
   */
  TRADING_BALANCE_RATIO: number;

  /**
   * Minimum capital required per market
   *
   * @remarks
   * Минимальный капитал, необходимый для одного маркета.
   * Если баланс на маркет < этого значения, количество маркетов уменьшается.
   * Default: 10 (USDC)
   */
  MIN_CAPITAL_PER_MARKET: number;

  /**
   * Trading fee percentage for arbitrage calculations
   *
   * @remarks
   * Комиссия биржи в процентах.
   * Используется ArbitrageDetector для расчёта реального профита.
   * Polymarket: ~0.2%
   * Default: 0.2
   */
  TRADING_FEE_PERCENT: number;

  // ========================================
  // Trade Flow / Fragility Configuration
  // ========================================

  /**
   * Number of orderbook levels for book imbalance calculation
   *
   * @remarks
   * Сколько уровней стакана учитывать для bookImbalance.
   * Default: 2
   */
  TRADE_FLOW_BOOK_LEVELS: number;

  /**
   * Minimum book imbalance for directional signal
   *
   * @remarks
   * Минимальный порог bookImbalance для определения направления.
   * Значение: 0-1
   * Default: 0.2
   */
  TRADE_FLOW_BOOK_MIN_THRESHOLD: number;

  /**
   * Minimum aggressive volume for fragility calculation
   *
   * @remarks
   * Минимальный объём сделки для учёта в fragility.
   * Мелкие сделки игнорируются.
   * Default: 5
   */
  TRADE_FLOW_MIN_AGGRESSIVE_VOLUME: number;

  /**
   * Fragility scaling factor
   *
   * @remarks
   * Масштабирующий фактор для fragility score.
   * Больше = более чувствительный fragility.
   * Default: 5
   */
  TRADE_FLOW_FRAGILITY_SCALE: number;

  /**
   * Decay lambda for exponential decay
   *
   * @remarks
   * Lambda для формулы x_new = x_old × exp(-λ × dt)
   * Больше = быстрее decay (короче память)
   * Default: 0.002
   */
  TRADE_FLOW_DECAY_LAMBDA: number;

  /**
   * Fast time-to-fill threshold (ms)
   *
   * @remarks
   * Порог для быстрой реакции рынка.
   * Если fill происходит быстрее - сигнал усиливается.
   * Default: 200
   */
  TRADE_FLOW_TIME_TO_FILL_FAST: number;

  /**
   * Medium time-to-fill threshold (ms)
   *
   * @remarks
   * Порог для средней реакции рынка.
   * Default: 500
   */
  TRADE_FLOW_TIME_TO_FILL_MEDIUM: number;

  /**
   * Slow time-to-fill threshold (ms)
   *
   * @remarks
   * Порог для медленной реакции рынка.
   * Если fill происходит медленнее - сигнал ослабляется.
   * Default: 1000
   */
  TRADE_FLOW_TIME_TO_FILL_SLOW: number;

  // ========================================
  // Orderbook Health Configuration
  // ========================================

  /**
   * Minimum healthy depth for orderbook
   *
   * @remarks
   * Если depth (bid или ask) падает ниже этого значения,
   * orderbook считается "thinning" (истончающимся).
   * Default: 20
   */
  ORDERBOOK_HEALTH_MIN_DEPTH: number;

  /**
   * EMA alpha for refill rates calculation
   *
   * @remarks
   * Alpha для exponential moving average refillRates.
   * Больше = быстрее реакция на изменения.
   * Формула: refillRate = α × normalized + (1-α) × previous
   * Default: 0.1
   */
  ORDERBOOK_HEALTH_EMA_ALPHA: number;

  /**
   * EMA alpha for absolute refill baseline
   *
   * @remarks
   * Alpha для EMA baseline (медленнее чем emaAlpha для стабильности).
   * Формула: baseline = α × absRefillRaw + (1-α) × baseline_prev
   * Default: 0.05
   */
  ORDERBOOK_HEALTH_BASELINE_ALPHA: number;

  /**
   * Maximum bound for absoluteRefillRate (clipping)
   *
   * @remarks
   * absoluteRefillRate клиппируется к [0, absMaxBound].
   * Default: 3
   */
  ORDERBOOK_HEALTH_ABS_MAX_BOUND: number;

  /**
   * Maximum bound for relativeRefillRate (clipping)
   *
   * @remarks
   * relativeRefillRate клиппируется к [0, relMaxBound].
   * Default: 1.5
   */
  ORDERBOOK_HEALTH_REL_MAX_BOUND: number;

  /**
   * Summary logging interval (ms)
   *
   * @remarks
   * Как часто логировать summary orderbook health.
   * Default: 10000 (10 секунд)
   */
  ORDERBOOK_HEALTH_SUMMARY_INTERVAL_MS: number;

  // ========================================
  // Edge Alive Configuration (Layer 0)
  // ========================================

  /**
   * Minimum fragility score for alive edge (0-1)
   *
   * @remarks
   * Если fragilityScore < minFragilityScore, edge считается неактивным.
   * Default: 0.1
   */
  EDGE_ALIVE_MIN_FRAGILITY_SCORE: number;

  /**
   * Minimum orderbook refill rate (0-1)
   *
   * @remarks
   * Если refillRate < minRefillRate, ликвидность не восстанавливается.
   * Default: 0.3
   */
  EDGE_ALIVE_MIN_REFILL_RATE: number;

  /**
   * Minimum minutes to expiry for market making
   *
   * @remarks
   * Если timeToExpiry < minTimeToExpiryMin, edge считается мёртвым.
   * Default: 4
   */
  EDGE_ALIVE_MIN_TIME_TO_EXPIRY_MIN: number;

  /**
   * Warmup period in milliseconds
   *
   * @remarks
   * В течение warmup периода смерть edge обратима.
   * После warmup смерть становится irreversible.
   * Default: 90000 (90 секунд)
   */
  EDGE_ALIVE_WARMUP_MS: number;

  /**
   * Bad streak threshold for death
   *
   * @remarks
   * Количество плохих оценок подряд для перехода в DEAD.
   * С учётом decay это эффективное значение.
   * Default: 4
   */
  EDGE_ALIVE_BAD_STREAK_TO_DEAD: number;

  /**
   * Good streak threshold for revival
   *
   * @remarks
   * Количество хороших оценок подряд для recovery.
   * Default: 2
   */
  EDGE_ALIVE_GOOD_STREAK_TO_REVIVE: number;

  /**
   * Decay alpha for streaks (0-1)
   *
   * @remarks
   * При каждой оценке: streak = streak × alpha + (isGood ? 1 : 0)
   * Больше = медленнее decay (дольше память)
   * Default: 0.8
   */
  EDGE_ALIVE_STREAK_DECAY_ALPHA: number;

  // ========================================
  // Strategy: Quote Generation
  // ========================================

  /**
   * Base spread percentage
   * @default 0.02 (2%)
   */
  STRATEGY_BASE_SPREAD: number;

  /**
   * Quote size in USDC
   * @default 100
   */
  STRATEGY_QUOTE_SIZE: number;

  /**
   * Minimum spread (floor)
   * @default 0.005 (0.5%)
   */
  STRATEGY_MIN_SPREAD: number;

  /**
   * Maximum spread (cap)
   * @default 0.20 (20%)
   */
  STRATEGY_MAX_SPREAD: number;

  /**
   * Minimum spread for quote validation
   * @default 0.01 (1%)
   */
  STRATEGY_VALIDATION_MIN_SPREAD: number;

  /**
   * Price adjustment when crossing orderbook
   * @default 0.001
   */
  STRATEGY_PRICE_CROSS_ADJUSTMENT: number;

  /**
   * Inventory sensitivity (price adjustment per 100% skew)
   * @default 0.01 (1%)
   */
  STRATEGY_INVENTORY_SENSITIVITY: number;

  /**
   * Maximum linear skew
   * @default 0.5 (50%)
   */
  STRATEGY_MAX_SKEW: number;

  /**
   * Spread multiplier in INVENTORY mode
   * @default 1.5
   */
  STRATEGY_INVENTORY_SPREAD_MULTIPLIER: number;

  /**
   * Risk spread coefficient (utilization impact on spread)
   * @default 0.5
   */
  STRATEGY_RISK_SPREAD_COEFFICIENT: number;

  // ========================================
  // Strategy: Non-Linear Skew
  // ========================================

  /**
   * Exponent for non-linear skew
   * @default 2.5
   */
  STRATEGY_SKEW_EXPONENT: number;

  /**
   * Base factor for non-linear skew
   * @default 0.05 (5%)
   */
  STRATEGY_SKEW_BASE_FACTOR: number;

  /**
   * Maximum skew value (cap)
   * @default 0.20 (20%)
   */
  STRATEGY_MAX_SKEW_VALUE: number;

  /**
   * Urgent hours threshold for skew time pressure
   * @default 0.5 (30 min)
   */
  STRATEGY_SKEW_URGENT_HOURS: number;

  /**
   * Moderate hours threshold for skew time pressure
   * @default 2.0 (2 hours)
   */
  STRATEGY_SKEW_MODERATE_HOURS: number;

  /**
   * Maximum time pressure multiplier for skew
   * @default 5.0
   */
  STRATEGY_SKEW_MAX_TIME_MULTIPLIER: number;

  /**
   * Time multiplier range (max - 1)
   * @default 4.0
   */
  STRATEGY_SKEW_TIME_MULTIPLIER_RANGE: number;

  // ========================================
  // Strategy: Recovery Mode
  // ========================================

  /**
   * Base spread crossing in RECOVERY mode
   * @default 0.01 (1%)
   */
  STRATEGY_RECOVERY_BASE_CROSSING: number;

  /**
   * Default recovery urgency
   * @default 0.5
   */
  STRATEGY_RECOVERY_DEFAULT_URGENCY: number;

  /**
   * Urgent hours threshold for recovery
   * @default 0.5 (30 min)
   */
  STRATEGY_RECOVERY_URGENT_HOURS: number;

  /**
   * Moderate hours threshold for recovery
   * @default 2.0 (2 hours)
   */
  STRATEGY_RECOVERY_MODERATE_HOURS: number;

  /**
   * Fragility boost factor for recovery
   * @default 0.01
   */
  STRATEGY_FRAGILITY_BOOST_FACTOR: number;

  /**
   * Urgency crossing factor for recovery
   * @default 0.02
   */
  STRATEGY_URGENCY_CROSSING_FACTOR: number;

  // ========================================
  // Strategy: Panic Mode
  // ========================================

  /**
   * Maximum spread crossing in PANIC mode
   * @default 0.03 (3%)
   */
  STRATEGY_PANIC_MAX_CROSSING: number;

  // ========================================
  // Strategy: Fair Value Calculation
  // ========================================

  /**
   * Weight for mid-price in fair value calculation
   * @default 0.5
   */
  FAIR_VALUE_WEIGHT_MID: number;

  /**
   * Weight for microprice in fair value calculation
   * @default 0.3
   */
  FAIR_VALUE_WEIGHT_MICROPRICE: number;

  /**
   * Weight for EMA in fair value calculation
   * @default 0.2
   */
  FAIR_VALUE_WEIGHT_EMA: number;

  /**
   * EMA alpha (smoothing factor)
   * @default 0.1
   */
  FAIR_VALUE_EMA_ALPHA: number;

  // ========================================
  // Position Management
  // ========================================

  /**
   * Threshold for NEUTRAL position classification
   * @default 0.1
   */
  POSITION_NEUTRAL_THRESHOLD: number;

  /**
   * Threshold for PERFECT hedge quality
   * @default 0.95
   */
  HEDGE_PERFECT_THRESHOLD: number;

  /**
   * Threshold for GOOD hedge quality
   * @default 0.80
   */
  HEDGE_GOOD_THRESHOLD: number;

  /**
   * Threshold for MODERATE hedge quality
   * @default 0.50
   */
  HEDGE_MODERATE_THRESHOLD: number;

  /**
   * Threshold for POOR hedge quality
   * @default 0.20
   */
  HEDGE_POOR_THRESHOLD: number;

  /**
   * Minimum acceptable hedge ratio
   * @default 0.8
   */
  HEDGE_MIN_ACCEPTABLE: number;

  /**
   * Threshold for isHedged check
   * @default 0.9
   */
  HEDGE_IS_HEDGED_THRESHOLD: number;

  // ========================================
  // Execution
  // ========================================

  /**
   * Maximum acceptable slippage percent
   * @default 1.0
   */
  EXECUTION_MAX_SLIPPAGE_PERCENT: number;

  // ========================================
  // Risk Utilization Thresholds
  // ========================================

  /**
   * Critical utilization threshold
   * @default 0.9 (90%)
   */
  RISK_CRITICAL_UTILIZATION: number;

  /**
   * High utilization threshold
   * @default 0.8 (80%)
   */
  RISK_HIGH_UTILIZATION: number;

  /**
   * Required keywords (comma-separated)
   *
   * @remarks
   * Все эти слова должны присутствовать в названии маркета.
   * Пустая строка = без обязательных ключевых слов.
   * Default: "up,down"
   */
  MARKET_DISCOVERY_REQUIRED_KEYWORDS: string[];

  /**
   * Any-of keywords (comma-separated)
   *
   * @remarks
   * Хотя бы одно из этих слов должно присутствовать в названии маркета.
   * Пустая строка = без фильтра по ключевым словам.
   * Default: "bitcoin,ethereum,solana,xrp"
   */
  MARKET_DISCOVERY_ANY_OF_KEYWORDS: string[];

  // ========================================
  // Data Collection Configuration
  // ========================================

  /**
   * Enable/disable data collection
   *
   * @remarks
   * Включает или выключает сбор raw market data.
   * 1 = включено, 0 = выключено
   * Default: 0 (выключено)
   */
  DATA_COLLECTION_ENABLED: boolean;

  /**
   * Output directory for data files
   *
   * @remarks
   * Директория для сохранения файлов данных.
   * Создаётся автоматически если не существует.
   * Default: "./snapshots"
   */
  DATA_COLLECTION_OUTPUT_DIR: string;

  /**
   * Data format
   *
   * @remarks
   * Формат сериализации данных:
   * - ndjson: JSON Lines (одна JSON-строка на событие)
   * - parquet: Apache Parquet (columnar format)
   * - arrow: Apache Arrow (in-memory columnar)
   * Default: "ndjson"
   */
  DATA_COLLECTION_FORMAT: 'ndjson' | 'parquet' | 'arrow';

  /**
   * Compression type
   *
   * @remarks
   * Тип сжатия при финализации файла:
   * - none: без сжатия
   * - gzip: gzip сжатие (создаёт .gz файл)
   * Default: "none"
   */
  DATA_COLLECTION_COMPRESSION: 'none' | 'gzip';

  /**
   * Buffer size (number of events)
   *
   * @remarks
   * Количество событий в буфере перед flush на диск.
   * Больше = меньше I/O, но больше потеря при crash.
   * Default: 100
   */
  DATA_COLLECTION_BUFFER_SIZE: number;

  /**
   * Flush interval (ms)
   *
   * @remarks
   * Максимальное время между flush операциями.
   * Flush происходит по bufferSize ИЛИ по времени.
   * Default: 10000 (10 секунд)
   */
  DATA_COLLECTION_FLUSH_INTERVAL_MS: number;

  // ========================================
  // Bucketizer Configuration
  // ========================================

  /**
   * Input directory for snapshots
   *
   * @remarks
   * Корневая директория со снапшотами.
   * Внутри должны быть папки YYYY-MM-DD/ с *.jsonl(.gz) файлами.
   * Default: "./snapshots"
   */
  BUCKET_INPUT_DIR: string;

  /**
   * Output directory for buckets
   *
   * @remarks
   * Корневая директория для сохранения bucket файлов.
   * Структура: <bucket_type>/tokenName_side_level_volMin_volMax.jsonl
   * Default: "./buckets"
   */
  BUCKET_OUTPUT_DIR: string;

  /**
   * Bucket types to calculate (comma-separated)
   *
   * @remarks
   * Список bucket types для вычисления.
   * Default: "volume_level_probability_fill"
   */
  BUCKET_TYPES: string[];

  /**
   * Maximum orderbook levels to process
   *
   * @remarks
   * Максимальное количество уровней стакана для обработки.
   * Default: 10
   */
  BUCKET_MAX_LEVELS: number;

  /**
   * Volume bin step size
   *
   * @remarks
   * Размер шага для binning cumulative volume.
   * Default: 100
   */
  BUCKET_VOLUME_STEP: number;

  /**
   * Minimum cumulative volume filter
   *
   * @remarks
   * Attempts с cumVolume < этого значения не создаются.
   * Default: 0
   */
  BUCKET_VOLUME_MIN: number;

  /**
   * Maximum cumulative volume filter
   *
   * @remarks
   * Attempts с cumVolume > этого значения не создаются.
   * Default: 10000
   */
  BUCKET_VOLUME_MAX: number;

  /**
   * Remaining quantity for fill tracking
   *
   * @remarks
   * Количество для отслеживания частичных fills.
   * Default: 1
   */
  BUCKET_REMAINING_QTY: number;

  /**
   * Fill horizons in seconds (comma-separated)
   *
   * @remarks
   * Список горизонтов в секундах для отслеживания fills.
   * Default: "5,10,15,30,60,120"
   */
  BUCKET_HORIZONS_SEC: number[];

  /**
   * Replay mode (MAX or SCALED)
   *
   * @remarks
   * MAX = без задержек, максимальная скорость
   * SCALED = пропорциональные задержки (replay * scale)
   * Default: "MAX"
   */
  REPLAY_MODE: 'MAX' | 'SCALED';

  /**
   * Replay scale factor (for SCALED mode)
   *
   * @remarks
   * Фактор масштабирования задержек в SCALED режиме.
   * Пример: 0.01 = события воспроизводятся в 100x ускорении
   * Default: 0.01
   */
  REPLAY_SCALE: number;

  /**
   * Maximum catch-up delay (ms)
   *
   * @remarks
   * Максимальная задержка между событиями в SCALED режиме.
   * Default: 200
   */
  REPLAY_MAX_CATCHUP_DELAY_MS: number;

  /**
   * Start date filter (YYYY-MM-DD, optional)
   *
   * @remarks
   * Обрабатывать snapshots начиная с этой даты (включительно).
   * Если не указано - обрабатывать все доступные.
   * Default: undefined
   */
  BUCKET_FROM_DAY?: string;

  /**
   * End date filter (YYYY-MM-DD, optional)
   *
   * @remarks
   * Обрабатывать snapshots до этой даты (включительно).
   * Если не указано - обрабатывать все доступные.
   * Default: undefined
   */
  BUCKET_TO_DAY?: string;
}

/**
 * Validates and parses environment variables
 * 
 * @returns Validated configuration object
 * @throws {Error} If required variables are missing or invalid
 */
function loadEnvConfig(): IEnvConfig {
  const nodeEnv = (process.env.NODE_ENV || 'development') as IEnvConfig['NODE_ENV'];
  
  // Validate NODE_ENV
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new Error(
      `Invalid NODE_ENV: ${nodeEnv}. Must be 'development', 'test', or 'production'`
    );
  }

  // Parse risk configuration from environment
  const riskMaxNetPosition = parseInt(process.env.RISK_MAX_NET_POSITION || '1000', 10);
  const riskMaxGrossPosition = parseInt(process.env.RISK_MAX_GROSS_POSITION || '2000', 10);
  const riskPanicThreshold = parseFloat(process.env.RISK_PANIC_THRESHOLD || '0.8');
  const riskInventoryThreshold = parseFloat(process.env.RISK_INVENTORY_THRESHOLD || '0.5');
  const riskTimeUrgencySeconds = parseInt(process.env.RISK_TIME_URGENCY_SECONDS || '86400', 10);

  // Parse market rotation configuration
  const marketScanPauseMs = parseInt(process.env.MARKET_SCAN_PAUSE_MS || '30000', 10);
  const marketExpiryCheckIntervalMs = parseInt(process.env.MARKET_EXPIRY_CHECK_INTERVAL_MS || '1000', 10);

  // Parse market discovery configuration
  const marketDiscoveryMinTimeToExpiryHours = parseFloat(
    process.env.MARKET_DISCOVERY_MIN_TIME_TO_EXPIRY_HOURS || '0'
  );
  const marketDiscoveryMinSpread = parseFloat(
    process.env.MARKET_DISCOVERY_MIN_SPREAD || '0.02'
  );
  const marketDiscoveryMinDailyVolume = parseFloat(
    process.env.MARKET_DISCOVERY_MIN_DAILY_VOLUME || '100'
  );

  // Parse multi-market trading configuration
  const maxConcurrentMarkets = parseInt(
    process.env.MAX_CONCURRENT_MARKETS || '5',
    10
  );
  const tradingBalanceRatio = parseFloat(
    process.env.TRADING_BALANCE_RATIO || '1.0'
  );
  const minCapitalPerMarket = parseFloat(
    process.env.MIN_CAPITAL_PER_MARKET || '10'
  );
  const tradingFeePercent = parseFloat(
    process.env.TRADING_FEE_PERCENT || '0.2'
  );

  // Parse trade flow / fragility configuration
  const tradeFlowBookLevels = parseInt(
    process.env.TRADE_FLOW_BOOK_LEVELS || '2',
    10
  );
  const tradeFlowBookMinThreshold = parseFloat(
    process.env.TRADE_FLOW_BOOK_MIN_THRESHOLD || '0.2'
  );
  const tradeFlowMinAggressiveVolume = parseFloat(
    process.env.TRADE_FLOW_MIN_AGGRESSIVE_VOLUME || '5'
  );
  const tradeFlowFragilityScale = parseFloat(
    process.env.TRADE_FLOW_FRAGILITY_SCALE || '5'
  );
  const tradeFlowDecayLambda = parseFloat(
    process.env.TRADE_FLOW_DECAY_LAMBDA || '0.002'
  );
  const tradeFlowTimeToFillFast = parseInt(
    process.env.TRADE_FLOW_TIME_TO_FILL_FAST || '200',
    10
  );
  const tradeFlowTimeToFillMedium = parseInt(
    process.env.TRADE_FLOW_TIME_TO_FILL_MEDIUM || '500',
    10
  );
  const tradeFlowTimeToFillSlow = parseInt(
    process.env.TRADE_FLOW_TIME_TO_FILL_SLOW || '1000',
    10
  );

  // Parse orderbook health configuration
  const orderbookHealthMinDepth = parseFloat(
    process.env.ORDERBOOK_HEALTH_MIN_DEPTH || '20'
  );
  const orderbookHealthEmaAlpha = parseFloat(
    process.env.ORDERBOOK_HEALTH_EMA_ALPHA || '0.1'
  );
  const orderbookHealthBaselineAlpha = parseFloat(
    process.env.ORDERBOOK_HEALTH_BASELINE_ALPHA || '0.05'
  );
  const orderbookHealthAbsMaxBound = parseFloat(
    process.env.ORDERBOOK_HEALTH_ABS_MAX_BOUND || '3'
  );
  const orderbookHealthRelMaxBound = parseFloat(
    process.env.ORDERBOOK_HEALTH_REL_MAX_BOUND || '1.5'
  );
  const orderbookHealthSummaryIntervalMs = parseInt(
    process.env.ORDERBOOK_HEALTH_SUMMARY_INTERVAL_MS || '10000',
    10
  );

  // Parse edge alive configuration
  const edgeAliveMinFragilityScore = parseFloat(
    process.env.EDGE_ALIVE_MIN_FRAGILITY_SCORE || '0.1'
  );
  const edgeAliveMinRefillRate = parseFloat(
    process.env.EDGE_ALIVE_MIN_REFILL_RATE || '0.3'
  );
  const edgeAliveMinTimeToExpiryMin = parseFloat(
    process.env.EDGE_ALIVE_MIN_TIME_TO_EXPIRY_MIN || '4'
  );
  const edgeAliveWarmupMs = parseInt(
    process.env.EDGE_ALIVE_WARMUP_MS || '90000',
    10
  );
  const edgeAliveBadStreakToDead = parseFloat(
    process.env.EDGE_ALIVE_BAD_STREAK_TO_DEAD || '4'
  );
  const edgeAliveGoodStreakToRevive = parseFloat(
    process.env.EDGE_ALIVE_GOOD_STREAK_TO_REVIVE || '2'
  );
  const edgeAliveStreakDecayAlpha = parseFloat(
    process.env.EDGE_ALIVE_STREAK_DECAY_ALPHA || '0.8'
  );

  // ========================================
  // Parse strategy configuration
  // ========================================

  // Quote Generation
  const strategyBaseSpread = parseFloat(process.env.STRATEGY_BASE_SPREAD || '0.02');
  const strategyQuoteSize = parseFloat(process.env.STRATEGY_QUOTE_SIZE || '100');
  const strategyMinSpread = parseFloat(process.env.STRATEGY_MIN_SPREAD || '0.005');
  const strategyMaxSpread = parseFloat(process.env.STRATEGY_MAX_SPREAD || '0.20');
  const strategyValidationMinSpread = parseFloat(process.env.STRATEGY_VALIDATION_MIN_SPREAD || '0.01');
  const strategyPriceCrossAdjustment = parseFloat(process.env.STRATEGY_PRICE_CROSS_ADJUSTMENT || '0.001');
  const strategyInventorySensitivity = parseFloat(process.env.STRATEGY_INVENTORY_SENSITIVITY || '0.01');
  const strategyMaxSkew = parseFloat(process.env.STRATEGY_MAX_SKEW || '0.5');
  const strategyInventorySpreadMultiplier = parseFloat(process.env.STRATEGY_INVENTORY_SPREAD_MULTIPLIER || '1.5');
  const strategyRiskSpreadCoefficient = parseFloat(process.env.STRATEGY_RISK_SPREAD_COEFFICIENT || '0.5');

  // Non-Linear Skew
  const strategySkewExponent = parseFloat(process.env.STRATEGY_SKEW_EXPONENT || '2.5');
  const strategySkewBaseFactor = parseFloat(process.env.STRATEGY_SKEW_BASE_FACTOR || '0.05');
  const strategyMaxSkewValue = parseFloat(process.env.STRATEGY_MAX_SKEW_VALUE || '0.20');
  const strategySkewUrgentHours = parseFloat(process.env.STRATEGY_SKEW_URGENT_HOURS || '0.5');
  const strategySkewModerateHours = parseFloat(process.env.STRATEGY_SKEW_MODERATE_HOURS || '2.0');
  const strategySkewMaxTimeMultiplier = parseFloat(process.env.STRATEGY_SKEW_MAX_TIME_MULTIPLIER || '5.0');
  const strategySkewTimeMultiplierRange = parseFloat(process.env.STRATEGY_SKEW_TIME_MULTIPLIER_RANGE || '4.0');

  // Recovery Mode
  const strategyRecoveryBaseCrossing = parseFloat(process.env.STRATEGY_RECOVERY_BASE_CROSSING || '0.01');
  const strategyRecoveryDefaultUrgency = parseFloat(process.env.STRATEGY_RECOVERY_DEFAULT_URGENCY || '0.5');
  const strategyRecoveryUrgentHours = parseFloat(process.env.STRATEGY_RECOVERY_URGENT_HOURS || '0.5');
  const strategyRecoveryModerateHours = parseFloat(process.env.STRATEGY_RECOVERY_MODERATE_HOURS || '2.0');
  const strategyFragilityBoostFactor = parseFloat(process.env.STRATEGY_FRAGILITY_BOOST_FACTOR || '0.01');
  const strategyUrgencyCrossingFactor = parseFloat(process.env.STRATEGY_URGENCY_CROSSING_FACTOR || '0.02');

  // Panic Mode
  const strategyPanicMaxCrossing = parseFloat(process.env.STRATEGY_PANIC_MAX_CROSSING || '0.03');

  // Fair Value Calculation
  const fairValueWeightMid = parseFloat(process.env.FAIR_VALUE_WEIGHT_MID || '0.5');
  const fairValueWeightMicroprice = parseFloat(process.env.FAIR_VALUE_WEIGHT_MICROPRICE || '0.3');
  const fairValueWeightEma = parseFloat(process.env.FAIR_VALUE_WEIGHT_EMA || '0.2');
  const fairValueEmaAlpha = parseFloat(process.env.FAIR_VALUE_EMA_ALPHA || '0.1');

  // Position Management
  const positionNeutralThreshold = parseFloat(process.env.POSITION_NEUTRAL_THRESHOLD || '0.1');
  const hedgePerfectThreshold = parseFloat(process.env.HEDGE_PERFECT_THRESHOLD || '0.95');
  const hedgeGoodThreshold = parseFloat(process.env.HEDGE_GOOD_THRESHOLD || '0.80');
  const hedgeModerateThreshold = parseFloat(process.env.HEDGE_MODERATE_THRESHOLD || '0.50');
  const hedgePoorThreshold = parseFloat(process.env.HEDGE_POOR_THRESHOLD || '0.20');
  const hedgeMinAcceptable = parseFloat(process.env.HEDGE_MIN_ACCEPTABLE || '0.8');
  const hedgeIsHedgedThreshold = parseFloat(process.env.HEDGE_IS_HEDGED_THRESHOLD || '0.9');

  // Execution
  const executionMaxSlippagePercent = parseFloat(process.env.EXECUTION_MAX_SLIPPAGE_PERCENT || '1.0');

  // Risk Utilization Thresholds
  const riskCriticalUtilization = parseFloat(process.env.RISK_CRITICAL_UTILIZATION || '0.9');
  const riskHighUtilization = parseFloat(process.env.RISK_HIGH_UTILIZATION || '0.8');

  // Parse comma-separated keywords
  const parseKeywords = (value: string | undefined, defaultValue: string): string[] => {
    const raw = value ?? defaultValue;
    if (!raw.trim()) return [];
    return raw.split(',').map((k) => k.trim().toLowerCase()).filter((k) => k.length > 0);
  };

  const marketDiscoveryRequiredKeywords = parseKeywords(
    process.env.MARKET_DISCOVERY_REQUIRED_KEYWORDS,
    'up,down'
  );
  const marketDiscoveryAnyOfKeywords = parseKeywords(
    process.env.MARKET_DISCOVERY_ANY_OF_KEYWORDS,
    'bitcoin,ethereum,solana,xrp'
  );

  // Parse data collection configuration
  const dataCollectionEnabled = process.env.DATA_COLLECTION_ENABLED === '1';
  const dataCollectionOutputDir = process.env.DATA_COLLECTION_OUTPUT_DIR || './snapshots';
  const dataCollectionFormat = (process.env.DATA_COLLECTION_FORMAT || 'ndjson') as 'ndjson' | 'parquet' | 'arrow';
  const dataCollectionCompression = (process.env.DATA_COLLECTION_COMPRESSION || 'none') as 'none' | 'gzip';
  const dataCollectionBufferSize = parseInt(
    process.env.DATA_COLLECTION_BUFFER_SIZE || '100',
    10
  );
  const dataCollectionFlushIntervalMs = parseInt(
    process.env.DATA_COLLECTION_FLUSH_INTERVAL_MS || '10000',
    10
  );

  // Validate data collection format
  if (!['ndjson', 'parquet', 'arrow'].includes(dataCollectionFormat)) {
    throw new Error(
      `Invalid DATA_COLLECTION_FORMAT: ${dataCollectionFormat}. Must be 'ndjson', 'parquet', or 'arrow'`
    );
  }

  // Validate data collection compression
  if (!['none', 'gzip'].includes(dataCollectionCompression)) {
    throw new Error(
      `Invalid DATA_COLLECTION_COMPRESSION: ${dataCollectionCompression}. Must be 'none' or 'gzip'`
    );
  }

  // Parse bucketizer configuration
  const bucketInputDir = process.env.BUCKET_INPUT_DIR || './snapshots';
  const bucketOutputDir = process.env.BUCKET_OUTPUT_DIR || './buckets';
  const bucketTypes = parseKeywords(
    process.env.BUCKET_TYPES,
    'volume_level_probability_fill'
  );
  const bucketMaxLevels = parseInt(
    process.env.BUCKET_MAX_LEVELS || '10',
    10
  );
  const bucketVolumeStep = parseFloat(
    process.env.BUCKET_VOLUME_STEP || '100'
  );
  const bucketVolumeMin = parseFloat(
    process.env.BUCKET_VOLUME_MIN || '0'
  );
  const bucketVolumeMax = parseFloat(
    process.env.BUCKET_VOLUME_MAX || '10000'
  );
  const bucketRemainingQty = parseFloat(
    process.env.BUCKET_REMAINING_QTY || '1'
  );

  // Parse horizons (comma-separated numbers)
  const bucketHorizonsRaw = process.env.BUCKET_HORIZONS_SEC || '5,10,15,30,60,120';
  const bucketHorizonsSec = bucketHorizonsRaw
    .split(',')
    .map(h => parseInt(h.trim(), 10))
    .filter(h => !isNaN(h) && h > 0);

  if (bucketHorizonsSec.length === 0) {
    throw new Error('BUCKET_HORIZONS_SEC must contain at least one valid horizon');
  }

  const replayMode = (process.env.REPLAY_MODE || 'MAX') as 'MAX' | 'SCALED';
  if (!['MAX', 'SCALED'].includes(replayMode)) {
    throw new Error(
      `Invalid REPLAY_MODE: ${replayMode}. Must be 'MAX' or 'SCALED'`
    );
  }

  const replayScale = parseFloat(process.env.REPLAY_SCALE || '0.01');
  const replayMaxCatchupDelayMs = parseInt(
    process.env.REPLAY_MAX_CATCHUP_DELAY_MS || '200',
    10
  );

  const bucketFromDay = process.env.BUCKET_FROM_DAY; // Optional
  const bucketToDay = process.env.BUCKET_TO_DAY; // Optional

  const config: IEnvConfig = {
    NODE_ENV: nodeEnv,
    PRIVATE_KEY: process.env.PRIVATE_KEY,
    FUNDER_ADDRESS: process.env.FUNDER_ADDRESS,
    POLYGON_RPC_URL: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
    LIVE_SAFE_MODE: process.env.LIVE_SAFE_MODE === '1',
    LIVE_CLEAN_START: process.env.LIVE_CLEAN_START === '1',
    LOG_LEVEL: (process.env.LOG_LEVEL || 'INFO') as IEnvConfig['LOG_LEVEL'],

    // Risk configuration
    RISK_MAX_NET_POSITION: riskMaxNetPosition,
    RISK_MAX_GROSS_POSITION: riskMaxGrossPosition,
    RISK_PANIC_THRESHOLD: riskPanicThreshold,
    RISK_INVENTORY_THRESHOLD: riskInventoryThreshold,
    RISK_TIME_URGENCY_SECONDS: riskTimeUrgencySeconds,

    // Market rotation configuration
    MARKET_SCAN_PAUSE_MS: marketScanPauseMs,
    MARKET_EXPIRY_CHECK_INTERVAL_MS: marketExpiryCheckIntervalMs,

    // Market discovery configuration
    MARKET_DISCOVERY_MIN_TIME_TO_EXPIRY_HOURS: marketDiscoveryMinTimeToExpiryHours,
    MARKET_DISCOVERY_MIN_SPREAD: marketDiscoveryMinSpread,
    MARKET_DISCOVERY_MIN_DAILY_VOLUME: marketDiscoveryMinDailyVolume,
    MARKET_DISCOVERY_REQUIRED_KEYWORDS: marketDiscoveryRequiredKeywords,
    MARKET_DISCOVERY_ANY_OF_KEYWORDS: marketDiscoveryAnyOfKeywords,

    // Multi-market trading configuration
    MAX_CONCURRENT_MARKETS: maxConcurrentMarkets,
    TRADING_BALANCE_RATIO: tradingBalanceRatio,
    MIN_CAPITAL_PER_MARKET: minCapitalPerMarket,
    TRADING_FEE_PERCENT: tradingFeePercent,

    // Trade flow / fragility configuration
    TRADE_FLOW_BOOK_LEVELS: tradeFlowBookLevels,
    TRADE_FLOW_BOOK_MIN_THRESHOLD: tradeFlowBookMinThreshold,
    TRADE_FLOW_MIN_AGGRESSIVE_VOLUME: tradeFlowMinAggressiveVolume,
    TRADE_FLOW_FRAGILITY_SCALE: tradeFlowFragilityScale,
    TRADE_FLOW_DECAY_LAMBDA: tradeFlowDecayLambda,
    TRADE_FLOW_TIME_TO_FILL_FAST: tradeFlowTimeToFillFast,
    TRADE_FLOW_TIME_TO_FILL_MEDIUM: tradeFlowTimeToFillMedium,
    TRADE_FLOW_TIME_TO_FILL_SLOW: tradeFlowTimeToFillSlow,

    // Orderbook health configuration
    ORDERBOOK_HEALTH_MIN_DEPTH: orderbookHealthMinDepth,
    ORDERBOOK_HEALTH_EMA_ALPHA: orderbookHealthEmaAlpha,
    ORDERBOOK_HEALTH_BASELINE_ALPHA: orderbookHealthBaselineAlpha,
    ORDERBOOK_HEALTH_ABS_MAX_BOUND: orderbookHealthAbsMaxBound,
    ORDERBOOK_HEALTH_REL_MAX_BOUND: orderbookHealthRelMaxBound,
    ORDERBOOK_HEALTH_SUMMARY_INTERVAL_MS: orderbookHealthSummaryIntervalMs,

    // Edge alive configuration
    EDGE_ALIVE_MIN_FRAGILITY_SCORE: edgeAliveMinFragilityScore,
    EDGE_ALIVE_MIN_REFILL_RATE: edgeAliveMinRefillRate,
    EDGE_ALIVE_MIN_TIME_TO_EXPIRY_MIN: edgeAliveMinTimeToExpiryMin,
    EDGE_ALIVE_WARMUP_MS: edgeAliveWarmupMs,
    EDGE_ALIVE_BAD_STREAK_TO_DEAD: edgeAliveBadStreakToDead,
    EDGE_ALIVE_GOOD_STREAK_TO_REVIVE: edgeAliveGoodStreakToRevive,
    EDGE_ALIVE_STREAK_DECAY_ALPHA: edgeAliveStreakDecayAlpha,

    // Strategy: Quote Generation
    STRATEGY_BASE_SPREAD: strategyBaseSpread,
    STRATEGY_QUOTE_SIZE: strategyQuoteSize,
    STRATEGY_MIN_SPREAD: strategyMinSpread,
    STRATEGY_MAX_SPREAD: strategyMaxSpread,
    STRATEGY_VALIDATION_MIN_SPREAD: strategyValidationMinSpread,
    STRATEGY_PRICE_CROSS_ADJUSTMENT: strategyPriceCrossAdjustment,
    STRATEGY_INVENTORY_SENSITIVITY: strategyInventorySensitivity,
    STRATEGY_MAX_SKEW: strategyMaxSkew,
    STRATEGY_INVENTORY_SPREAD_MULTIPLIER: strategyInventorySpreadMultiplier,
    STRATEGY_RISK_SPREAD_COEFFICIENT: strategyRiskSpreadCoefficient,

    // Strategy: Non-Linear Skew
    STRATEGY_SKEW_EXPONENT: strategySkewExponent,
    STRATEGY_SKEW_BASE_FACTOR: strategySkewBaseFactor,
    STRATEGY_MAX_SKEW_VALUE: strategyMaxSkewValue,
    STRATEGY_SKEW_URGENT_HOURS: strategySkewUrgentHours,
    STRATEGY_SKEW_MODERATE_HOURS: strategySkewModerateHours,
    STRATEGY_SKEW_MAX_TIME_MULTIPLIER: strategySkewMaxTimeMultiplier,
    STRATEGY_SKEW_TIME_MULTIPLIER_RANGE: strategySkewTimeMultiplierRange,

    // Strategy: Recovery Mode
    STRATEGY_RECOVERY_BASE_CROSSING: strategyRecoveryBaseCrossing,
    STRATEGY_RECOVERY_DEFAULT_URGENCY: strategyRecoveryDefaultUrgency,
    STRATEGY_RECOVERY_URGENT_HOURS: strategyRecoveryUrgentHours,
    STRATEGY_RECOVERY_MODERATE_HOURS: strategyRecoveryModerateHours,
    STRATEGY_FRAGILITY_BOOST_FACTOR: strategyFragilityBoostFactor,
    STRATEGY_URGENCY_CROSSING_FACTOR: strategyUrgencyCrossingFactor,

    // Strategy: Panic Mode
    STRATEGY_PANIC_MAX_CROSSING: strategyPanicMaxCrossing,

    // Strategy: Fair Value Calculation
    FAIR_VALUE_WEIGHT_MID: fairValueWeightMid,
    FAIR_VALUE_WEIGHT_MICROPRICE: fairValueWeightMicroprice,
    FAIR_VALUE_WEIGHT_EMA: fairValueWeightEma,
    FAIR_VALUE_EMA_ALPHA: fairValueEmaAlpha,

    // Position Management
    POSITION_NEUTRAL_THRESHOLD: positionNeutralThreshold,
    HEDGE_PERFECT_THRESHOLD: hedgePerfectThreshold,
    HEDGE_GOOD_THRESHOLD: hedgeGoodThreshold,
    HEDGE_MODERATE_THRESHOLD: hedgeModerateThreshold,
    HEDGE_POOR_THRESHOLD: hedgePoorThreshold,
    HEDGE_MIN_ACCEPTABLE: hedgeMinAcceptable,
    HEDGE_IS_HEDGED_THRESHOLD: hedgeIsHedgedThreshold,

    // Execution
    EXECUTION_MAX_SLIPPAGE_PERCENT: executionMaxSlippagePercent,

    // Risk Utilization Thresholds
    RISK_CRITICAL_UTILIZATION: riskCriticalUtilization,
    RISK_HIGH_UTILIZATION: riskHighUtilization,

    // Data Collection
    DATA_COLLECTION_ENABLED: dataCollectionEnabled,
    DATA_COLLECTION_OUTPUT_DIR: dataCollectionOutputDir,
    DATA_COLLECTION_FORMAT: dataCollectionFormat,
    DATA_COLLECTION_COMPRESSION: dataCollectionCompression,
    DATA_COLLECTION_BUFFER_SIZE: dataCollectionBufferSize,
    DATA_COLLECTION_FLUSH_INTERVAL_MS: dataCollectionFlushIntervalMs,

    // Bucketizer
    BUCKET_INPUT_DIR: bucketInputDir,
    BUCKET_OUTPUT_DIR: bucketOutputDir,
    BUCKET_TYPES: bucketTypes,
    BUCKET_MAX_LEVELS: bucketMaxLevels,
    BUCKET_VOLUME_STEP: bucketVolumeStep,
    BUCKET_VOLUME_MIN: bucketVolumeMin,
    BUCKET_VOLUME_MAX: bucketVolumeMax,
    BUCKET_REMAINING_QTY: bucketRemainingQty,
    BUCKET_HORIZONS_SEC: bucketHorizonsSec,
    REPLAY_MODE: replayMode,
    REPLAY_SCALE: replayScale,
    REPLAY_MAX_CATCHUP_DELAY_MS: replayMaxCatchupDelayMs,
    BUCKET_FROM_DAY: bucketFromDay,
    BUCKET_TO_DAY: bucketToDay,
  };

  // Validate PRIVATE_KEY in production
  if (config.NODE_ENV === 'production' && !config.PRIVATE_KEY) {
    throw new Error(
      'PRIVATE_KEY is required in production environment. ' +
      'Set it with: export PRIVATE_KEY=0x...'
    );
  }

  return config;
}

/**
 * Singleton environment configuration instance
 */
export const EnvConfig: IEnvConfig = loadEnvConfig();
