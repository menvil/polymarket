// ============================================================================
// POLYMARKET MARKET MAKING BOT V3
// Production-Ready with Full OMS, YES/NO Pair Trading
// ============================================================================

import 'dotenv/config';
import { ClobClient, AssetType } from '@polymarket/clob-client';
import { SignatureType } from '@polymarket/order-utils';
import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider } from '@ethersproject/providers';
import WebSocket from 'ws';
import blessed from 'neo-blessed';
import fs from 'fs';
import path from 'path';

// Suppress blessed terminal capability warnings
// These are cosmetic errors from xterm-256color not supporting certain escape sequences
const originalStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, encoding, callback) => {
    const str = chunk.toString();
    // Filter out blessed terminal warnings
    if (str.includes('Error on xterm-256color') ||
        str.includes('Setulc') ||
        str.includes('\\u001b[58::')) {
        return true;
    }
    return originalStderrWrite(chunk, encoding, callback);
};


// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
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
        BAD_STREAK_TO_DEAD: 4,              // Need 3 consecutive bad windows for irreversible death
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
        MIN_PRICE: 0.01,
        MAX_PRICE: 0.99,
        PRICE_TICK: 0.0001,  // 1 basis point
        MIN_SIZE: 0.1,
        SIZE_TICK: 0.1,

        // Ultra-conservative mode (edge warning) - HARD CAPS
        WARNING_SIZE_MULT: 0.1,         // 10% of base size
        WARNING_SPREAD_MULT: 4.0,       // 4x base spread

        // Anti-flicker
        MIN_REPLACE_INTERVAL_MS: 2000,  // 1 second
        MIN_PRICE_CHANGE_FOR_REPLACE: 0.0025  // 10 bps
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
    SIMULATION_MODE: false,  // true = dry-run, false = LIVE with real orders

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

    // Console filtering
    CONSOLE: {
        SUPPRESS_BALANCE_ERRORS: true,  // Подавлять balance/allowance ошибки
        SUPPRESS_CLOB_ERRORS: false,    // Подавлять ВСЕ CLOB ошибки
        LOG_SUPPRESSED: true            // Логировать подавленные в файл
    },

    // Logging
    UPDATE_INTERVAL_MS: 2000,
    ORDERBOOK_DEPTH: 3,

    // File Logging (persisted data for post-analysis)
    LOGGING: {
        ENABLE_FILE_LOGGING: true,       // Master switch
        LOG_DIR: './logs',
        SNAPSHOT_INTERVAL_MS: 1000,      // Orderbook snapshots
        MAX_FILE_SIZE_MB: 50,            // Rotation threshold
        WRITE_ASYNC: true,               // Non-blocking writes

        // Log levels (what to write to console.log file)
        LOG_LEVEL: 'DEBUG',              // DEBUG | INFO | WARN | ERROR
        // DEBUG = all messages, INFO = info+warn+error, WARN = warn+error, ERROR = error only

        // Category filters (disable specific categories to reduce log volume)
        LOG_CATEGORIES: {
            system: true,     // Startup, shutdown, market switch
            oms: true,        // Order management
            trade: true,      // Trade detection
            flow: true,       // Trade flow analysis
            quote: true,      // Quote generation
            arb: true,        // Arbitrage opportunities
            unwind: true,     // Unwind/recovery operations
            error: true,      // Errors
            risk: true,       // Risk management
            mode: true,       // Mode transitions
            edge: true,       // Edge alive
            panic: true,      // Panic mode
            debug: true       // Debug messages
        },

        // Smart snapshot triggers
        MIN_SPREAD_CHANGE_FOR_SNAPSHOT: 0.005,  // 0.5% spread change
        MIN_MID_CHANGE_FOR_SNAPSHOT: 0.002,     // 0.2% mid price change
        MIN_DEPTH_CHANGE_FOR_SNAPSHOT: 0.2      // 20% depth change
    }
};

const originalConsoleError = console.error;
console.error = function(...args) {
    const message = args.join(' ');

    // Проверка balance/allowance
    if (CONFIG.CONSOLE.SUPPRESS_BALANCE_ERRORS) {
        const isBalanceError =
            message.includes('not enough balance') ||
            message.includes('not enough') ||
            message.includes('allowance');

        if (isBalanceError) {
            if (CONFIG.CONSOLE.LOG_SUPPRESSED) {
                FILE_LOGGER.logConsole(`[suppressed] ${message}`, 'oms', 'DEBUG');
            }
            return;
        }
    }

    // Проверка CLOB Client
    if (CONFIG.CONSOLE.SUPPRESS_CLOB_ERRORS && message.includes('[CLOB Client]')) {
        if (CONFIG.CONSOLE.LOG_SUPPRESSED) {
            FILE_LOGGER.logConsole(`[suppressed] ${message}`, 'oms', 'DEBUG');
        }
        return;
    }

    // Остальные ошибки показываем
    originalConsoleError.apply(console, args);
};

// ============================================================================
// UI ICON SYSTEM (ASCII vs EMOJI)
// ============================================================================

const ICON_MAP = {
    // Category icons
    system: { emoji: '⚙️', ascii: 'SYS' },
    oms: { emoji: '📝', ascii: 'OMS' },
    trade: { emoji: '💱', ascii: 'TRD' },
    flow: { emoji: '🌊', ascii: 'FLW' },
    quote: { emoji: '💰', ascii: 'QTE' },
    arb: { emoji: '🔥', ascii: 'ARB' },
    unwind: { emoji: '🚨', ascii: 'UWD' },
    error: { emoji: '❌', ascii: 'ERR' },

    // Status/level icons
    ok: { emoji: '✅', ascii: '[OK]' },
    warn: { emoji: '⚠️', ascii: '[WARN]' },
    alert: { emoji: '🚨', ascii: '[ALERT]' },
    err: { emoji: '❌', ascii: '[ERR]' },
    info: { emoji: 'ℹ️', ascii: '[INFO]' },

    // Generic symbols
    money: { emoji: '💰', ascii: '$' },
    fire: { emoji: '🔥', ascii: '!!' },
    wave: { emoji: '🌊', ascii: '~' },
    gear: { emoji: '⚙️', ascii: '*' },
    note: { emoji: '📝', ascii: '+' },
    exchange: { emoji: '💱', ascii: '<>' },
    target: { emoji: '🎯', ascii: 'o' },
    check: { emoji: '✅', ascii: '[+]' },
    cross: { emoji: '❌', ascii: '[X]' },
    warning: { emoji: '⚠️', ascii: '!' },
    critical: { emoji: '🚨', ascii: '!!!' }
};

function icon(name) {
    const iconData = ICON_MAP[name];
    if (!iconData) return name;
    return CONFIG.UI.ASCII_ONLY ? iconData.ascii : iconData.emoji;
}

function levelTag(level) {
    const tags = {
        ok: icon('ok'),
        warn: icon('warn'),
        alert: icon('alert'),
        err: icon('err'),
        info: icon('info')
    };
    return tags[level] || level;
}

function stripEmojiForAscii(message) {
    if (!CONFIG.UI.ASCII_ONLY) return message;

    // Replace common emoji with ASCII equivalents
    return message
        .replace(/✅/g, '[+]')
        .replace(/❌/g, '[X]')
        .replace(/⚠️/g, '!')
        .replace(/🚨/g, '!!!')
        .replace(/💰/g, '$')
        .replace(/🔥/g, '!!')
        .replace(/🌊/g, '~')
        .replace(/⚙️/g, '*')
        .replace(/📝/g, '+')
        .replace(/💱/g, '<>')
        .replace(/🎯/g, 'o')
        .replace(/ℹ️/g, '[i]')
        .replace(/📊/g, '|')
        .replace(/💼/g, '[#]')
        .replace(/🎲/g, '?')
        .replace(/🛑/g, '[STOP]')
        .replace(/⏸️/g, '[PAUSE]')
        .replace(/🔄/g, '[REFRESH]')
        .replace(/📡/g, '[SIGNAL]')
        .replace(/⏰/g, '[TIME]')
        .replace(/📋/g, '[LIST]')
        .replace(/🔍/g, '[SEARCH]')
        .replace(/📈/g, '[UP]')
        .replace(/📉/g, '[DOWN]');
}

// ============================================================================
// FILE LOGGER (persisted data for post-analysis)
// ============================================================================

class FileLogger {
    constructor() {
        this.enabled = CONFIG.LOGGING.ENABLE_FILE_LOGGING;
        if (!this.enabled) return;

        this.logDir = CONFIG.LOGGING.LOG_DIR;
        this.maxFileSizeMB = CONFIG.LOGGING.MAX_FILE_SIZE_MB;
        this.maxFileSizeBytes = this.maxFileSizeMB * 1024 * 1024;

        // Write queues (async writes)
        this.queues = {
            events: [],
            fills: [],
            snapshots: [],
            console: []  // NEW: All console messages
        };

        // File streams
        this.streams = {};

        // File sizes
        this.fileSizes = {
            events: 0,
            fills: 0,
            snapshots: 0,
            console: 0  // NEW
        };

        // Log level priority
        this.levelPriority = {
            'DEBUG': 0,
            'INFO': 1,
            'WARN': 2,
            'ERROR': 3
        };

        // Snapshot state (for smart triggers)
        this.lastSnapshot = {
            YES: { timestamp: 0, spread: 0, mid: 0, depth: 0 },
            NO: { timestamp: 0, spread: 0, mid: 0, depth: 0 }
        };

        this.init();
    }

    init() {
        if (!this.enabled) return;

        try {
            // Create log directory
            if (!fs.existsSync(this.logDir)) {
                fs.mkdirSync(this.logDir, { recursive: true });
            }

            // Create file streams
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);

            this.streams.events = fs.createWriteStream(
                path.join(this.logDir, `events_${timestamp}.log`),
                { flags: 'a' }
            );

            this.streams.fills = fs.createWriteStream(
                path.join(this.logDir, `fills_${timestamp}.log`),
                { flags: 'a' }
            );

            this.streams.snapshots = fs.createWriteStream(
                path.join(this.logDir, `orderbook_snapshots_${timestamp}.jsonl`),
                { flags: 'a' }
            );

            this.streams.console = fs.createWriteStream(
                path.join(this.logDir, `console_${timestamp}.log`),
                { flags: 'a' }
            );

            // Start write worker
            if (CONFIG.LOGGING.WRITE_ASYNC) {
                this.startWriteWorker();
            }

            console.log(`📁 File logging initialized: ${this.logDir}`);
        } catch (err) {
            console.error(`[FileLogger] Init failed: ${err.message}`);
            this.enabled = false;
        }
    }

    startWriteWorker() {
        // Flush queues every 500ms
        setInterval(() => {
            this.flushQueues();
        }, 500);
    }

    flushQueues() {
        if (!this.enabled) return;

        try {
            // Flush events
            if (this.queues.events.length > 0) {
                const batch = this.queues.events.splice(0);
                for (const line of batch) {
                    this.streams.events.write(line + '\n');
                    this.fileSizes.events += Buffer.byteLength(line) + 1;
                }
            }

            // Flush fills
            if (this.queues.fills.length > 0) {
                const batch = this.queues.fills.splice(0);
                for (const line of batch) {
                    this.streams.fills.write(line + '\n');
                    this.fileSizes.fills += Buffer.byteLength(line) + 1;
                }
            }

            // Flush snapshots
            if (this.queues.snapshots.length > 0) {
                const batch = this.queues.snapshots.splice(0);
                for (const line of batch) {
                    this.streams.snapshots.write(line + '\n');
                    this.fileSizes.snapshots += Buffer.byteLength(line) + 1;
                }
            }

            // Flush console logs
            if (this.queues.console.length > 0) {
                const batch = this.queues.console.splice(0);
                for (const line of batch) {
                    this.streams.console.write(line + '\n');
                    this.fileSizes.console += Buffer.byteLength(line) + 1;
                }
            }

            // Check rotation
            this.checkRotation();
        } catch (err) {
            console.error(`[FileLogger] Flush failed: ${err.message}`);
        }
    }

    checkRotation() {
        for (const [name, size] of Object.entries(this.fileSizes)) {
            if (size >= this.maxFileSizeBytes) {
                this.rotateFile(name);
            }
        }
    }

    rotateFile(name) {
        try {
            // Close old stream
            this.streams[name].end();

            // Create new stream
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
            const extension = name === 'snapshots' ? 'jsonl' : 'log';
            const filename = `${name}_${timestamp}.${extension}`;

            this.streams[name] = fs.createWriteStream(
                path.join(this.logDir, filename),
                { flags: 'a' }
            );

            this.fileSizes[name] = 0;

            console.log(`[FileLogger] Rotated ${name} → ${filename}`);
        } catch (err) {
            console.error(`[FileLogger] Rotation failed for ${name}: ${err.message}`);
        }
    }

    logEvent(eventType, data) {
        if (!this.enabled) return;

        const timestamp = new Date().toISOString();
        const line = `[${timestamp}] [${eventType}] ${JSON.stringify(data)}`;

        if (CONFIG.LOGGING.WRITE_ASYNC) {
            this.queues.events.push(line);
        } else {
            try {
                this.streams.events.write(line + '\n');
                this.fileSizes.events += Buffer.byteLength(line) + 1;
            } catch (err) {
                console.error(`[FileLogger] Event write failed: ${err.message}`);
            }
        }
    }

    logFill(fillData) {
        if (!this.enabled) return;

        const timestamp = new Date().toISOString();
        const line = `[${timestamp}] ${JSON.stringify(fillData)}`;

        if (CONFIG.LOGGING.WRITE_ASYNC) {
            this.queues.fills.push(line);
        } else {
            try {
                this.streams.fills.write(line + '\n');
                this.fileSizes.fills += Buffer.byteLength(line) + 1;
            } catch (err) {
                console.error(`[FileLogger] Fill write failed: ${err.message}`);
            }
        }
    }

    logSnapshot(token, orderbookData, marketInfo) {
        if (!this.enabled) return;

        const timestamp = Date.now();
        const isoTimestamp = new Date(timestamp).toISOString();

        // Build snapshot
        const snapshot = {
            timestamp: isoTimestamp,
            timestampMs: timestamp,
            market: marketInfo?.question || 'unknown',
            conditionId: marketInfo?.conditionId || 'unknown',
            token: token,
            bestBid: orderbookData.bestBid || null,
            bestAsk: orderbookData.bestAsk || null,
            mid: orderbookData.mid || null,
            spread: orderbookData.spread || null,
            bidDepth: orderbookData.bidDepth || 0,
            askDepth: orderbookData.askDepth || 0,
            levels: {
                bids: orderbookData.bids ? orderbookData.bids.slice(0, 5).map(b => [b.price, b.size]) : [],
                asks: orderbookData.asks ? orderbookData.asks.slice(0, 5).map(a => [a.price, a.size]) : []
            }
        };

        const line = JSON.stringify(snapshot);

        if (CONFIG.LOGGING.WRITE_ASYNC) {
            this.queues.snapshots.push(line);
        } else {
            try {
                this.streams.snapshots.write(line + '\n');
                this.fileSizes.snapshots += Buffer.byteLength(line) + 1;
            } catch (err) {
                console.error(`[FileLogger] Snapshot write failed: ${err.message}`);
            }
        }
    }

    shouldTakeSnapshot(token, orderbookData) {
        if (!this.enabled) return false;

        const now = Date.now();
        const last = this.lastSnapshot[token];

        // Always snapshot after interval
        if (now - last.timestamp >= CONFIG.LOGGING.SNAPSHOT_INTERVAL_MS) {
            this.updateLastSnapshot(token, orderbookData);
            return true;
        }

        // Smart triggers: spread change
        const spreadChange = Math.abs((orderbookData.spread || 0) - last.spread);
        if (spreadChange >= CONFIG.LOGGING.MIN_SPREAD_CHANGE_FOR_SNAPSHOT) {
            this.updateLastSnapshot(token, orderbookData);
            return true;
        }

        // Smart triggers: mid price change
        const midChange = Math.abs((orderbookData.mid || 0) - last.mid);
        if (midChange >= CONFIG.LOGGING.MIN_MID_CHANGE_FOR_SNAPSHOT) {
            this.updateLastSnapshot(token, orderbookData);
            return true;
        }

        // Smart triggers: depth change
        const depth = orderbookData.bidDepth + orderbookData.askDepth;
        const lastDepth = last.depth;
        if (lastDepth > 0) {
            const depthChangeRatio = Math.abs(depth - lastDepth) / lastDepth;
            if (depthChangeRatio >= CONFIG.LOGGING.MIN_DEPTH_CHANGE_FOR_SNAPSHOT) {
                this.updateLastSnapshot(token, orderbookData);
                return true;
            }
        }

        return false;
    }

    updateLastSnapshot(token, orderbookData) {
        this.lastSnapshot[token] = {
            timestamp: Date.now(),
            spread: orderbookData.spread || 0,
            mid: orderbookData.mid || 0,
            depth: (orderbookData.bidDepth || 0) + (orderbookData.askDepth || 0)
        };
    }

    logConsole(message, category, level = 'DEBUG') {
        if (!this.enabled) return;

        // Check if category is enabled
        if (CONFIG.LOGGING.LOG_CATEGORIES[category] === false) {
            return;  // Category disabled, skip
        }

        // Check log level
        const configLevel = CONFIG.LOGGING.LOG_LEVEL || 'DEBUG';
        const configPriority = this.levelPriority[configLevel] || 0;
        const messagePriority = this.levelPriority[level] || 0;

        if (messagePriority < configPriority) {
            return;  // Message level too low, skip
        }

        // Format: [timestamp] [LEVEL] [category] message
        const timestamp = new Date().toISOString();
        const line = `[${timestamp}] [${level}] [${category}] ${message}`;

        if (CONFIG.LOGGING.WRITE_ASYNC) {
            this.queues.console.push(line);
        } else {
            try {
                this.streams.console.write(line + '\n');
                this.fileSizes.console += Buffer.byteLength(line) + 1;
            } catch (err) {
                console.error(`[FileLogger] Console write failed: ${err.message}`);
            }
        }
    }

    close() {
        if (!this.enabled) return;

        try {
            // Flush remaining data
            this.flushQueues();

            // Close streams
            for (const stream of Object.values(this.streams)) {
                stream.end();
            }

            console.log('[FileLogger] Closed');
        } catch (err) {
            console.error(`[FileLogger] Close failed: ${err.message}`);
        }
    }
}

// Global file logger instance
const FILE_LOGGER = new FileLogger();

// Wrapper functions
function logEvent(eventType, data) {
    FILE_LOGGER.logEvent(eventType, data);
}

function logFill(fillData) {
    FILE_LOGGER.logFill(fillData);
}

function logSnapshot(token, orderbookData, marketInfo) {
    FILE_LOGGER.logSnapshot(token, orderbookData, marketInfo);
}

// ============================================================================
// GLOBAL STATE
// ============================================================================

const STATE = {
    // Markets
    markets: new Map(),
    selectedMarket: null,
    allAvailableMarkets: [],
    marketScannerActive: false,
    marketScannerStatus: 'idle',  // idle, scanning, completed
    lastScanMarketsFound: 0,

    // Market data
    orderbooks: new Map(),  // tokenId -> {bids, asks, mid, ...}
    orderbookHealth: {
        YES: { depth: 0, spread: 0, lastCheck: 0, thinning: false },
        NO: { depth: 0, spread: 0, lastCheck: 0, thinning: false }
    },
    trades: [],
    tradeFlow: {
        type: 'NOISE',
        direction: null,
        confidence: 0,
        metrics: {}
    },

    // Fair value
    fairValue: {
        yes: { mid: 0.5, ema: 0.5, final: 0.5 },
        no: { mid: 0.5, ema: 0.5, final: 0.5 },
        yesNoMismatch: 0
    },

    // Inventory (unified YES/NO)
    inventory: {
        yesShares: 0,
        noShares: 0,
        netPosition: 0,      // YES - NO
        grossPosition: 0,    // YES + NO
        cash: CONFIG.RISK.INITIAL_CASH,
        reservedCash: 0,     // Cash reserved by open BUY orders
        costBasis: { yes: 0, no: 0 },
        unrealizedPnL: 0,
        realizedPnL: 0,
        hedgeRatio: 0,
        lastUpdateTime: Date.now()
    },

    // LOT-BASED ACCOUNTING: Track individual position lots with entry prices
    // This fixes the critical accounting bug where price is conflated with probability
    lots: {
        yes: [],  // Array of PositionLot for YES token
        no: []    // Array of PositionLot for NO token
        // Each PositionLot:
        // {
        //   lotId: string,
        //   side: 'YES' | 'NO',
        //   shares: number,
        //   probabilityEntry: number,  // 0-1 probability at entry
        //   usdPricePerShare: number,  // USD price per share (= probabilityEntry)
        //   costUsd: number,           // Total USD cost (shares * usdPricePerShare)
        //   expectedPayoutUsd: number, // shares * 1.0 (if outcome wins)
        //   expectedPnlUsd: number,    // expectedPayoutUsd - costUsd
        //   timestamp: number,
        //   fillId: string
        // }
    },

    // PAYOFF ENGINE: Outcome-based PnL (not mark-to-market)
    payoff: {
        // Average entry prices (updated on every fill)
        avgEntryPrice: { yes: 0, no: 0 },

        // Payoff in each outcome scenario
        pnlIfYes: 0,     // If market resolves YES
        pnlIfNo: 0,      // If market resolves NO

        // CRITICAL RISK METRIC
        worstCasePnl: 0, // min(pnlIfYes, pnlIfNo)

        // Payoff imbalance (absolute difference)
        payoffImbalance: 0,  // abs(pnlIfYes - pnlIfNo)

        // Flags
        isLockedInLoss: false,  // worstCasePnl < 0 AND both legs held
        isPayoffNeutral: false  // worstCasePnl >= 0 (safe)
    },

    // OMS: Order Management System
    orders: {
        active: new Map(),      // orderId -> { tokenId, side, price, size, timestamp, ... }
        byToken: new Map(),     // tokenId -> Set(orderId)
        lastSyncTs: 0,
        lastReplaceTs: new Map(),  // tokenId -> timestamp (anti-flicker)
        pendingCancels: new Set()  // orderIds being canceled
    },

    // Target quotes (what we WANT to quote)
    targetQuotes: {
        YES: { bid: null, ask: null, bidSize: 0, askSize: 0 },
        NO: { bid: null, ask: null, bidSize: 0, askSize: 0 }
    },

    // Edge / Market Quality (IRREVERSIBLE per market)
    edge: {
        edgeAlive: true,              // Can we profitably MM?
        edgeAliveReason: 'initial',   // Why edge is alive/dead
        edgeAliveSince: Date.now(),   // When edge status last changed
        irreversible: false,          // Once false, stays false until market switch

        // Staged transitions (warm-up + streaks)
        marketEnterTs: Date.now(),    // When current market was entered (for warm-up)
        badStreak: 0,                 // Consecutive bad evaluation windows
        goodStreak: 0,                // Consecutive good evaluation windows
        lastBadReason: null,          // Last reason for bad window
        lastGoodReason: null,         // Last reason for good window
        lastEdgeEvalWindowStartTs: null, // Last window boundary when streak was updated

        metrics: {
            tradeFlowSymmetry: 1.0,   // 1-imbalance (1=balanced, 0=one-sided)
            orderbookRefillRate: 1.0, // Depth recovery rate
            timeToExpiry: 999,         // Minutes remaining
            tradesInWindow: 0,        // Trades counted in current window
            updatesInWindow: 0        // Orderbook updates in current window
        }
    },

    // Risk & State Machine
    riskStatus: {
        status: 'SAFE',  // SAFE, WARNING, DANGER, KILLED
        mode: 'FLAT',    // FLAT, QUOTE, UNWIND, PANIC, PAUSED (strict state machine)

        // State machine controls
        stateEnterTime: Date.now(),      // When we entered current state
        stateReason: 'initial',          // Why we're in current state
        inventoryDebtStartTime: null,    // When inventory first became != 0
        maxTimeInInventory: 300000,      // 5 minutes max in inventory (debt)

        fillStreak: 0,
        fillStreakSide: null,
        // Per-token+side fill streaks (YES_BUY, YES_SELL, NO_BUY, NO_SELL)
        fillStreaks: {
            YES_BUY: 0,
            YES_SELL: 0,
            NO_BUY: 0,
            NO_SELL: 0
        },
        forcedUnwind: false,
        defensiveMode: false,
        defensiveCooldownUntil: 0,
        defensiveCanceledOnce: false,  // Track if we already canceled in this defensive period
        inventoryUtilization: 0,
        lastFillTime: null,

        // Urgency calculation
        urgency: 0,  // 0..1, drives unwind aggression
        urgencyFactors: {
            inventoryMagnitude: 0,
            timeInPosition: 0,
            timeToExpiry: 0,
            priceMomentum: 0,
            orderbookImbalance: 0
        },

        // Unwind escalation tracking
        unwindEscalation: {
            level: 0,                    // 0-5 escalation level
            lastEscalationTime: 0,       // When we last escalated
            lastFillInUnwind: 0,         // When we last got filled in unwind
            attemptsSinceLastFill: 0     // How many cycles without fill
        },

        // Loss acceptance
        maxLossPerUnwind: 0.05,          // Accept 5% loss to close position
        totalLossesAccepted: 0           // Track cumulative losses accepted
    },

    // LIVE trading state
    live: {
        apiErrorStreak: 0,
        lastApiError: null,
        lastApiErrorTime: 0,
        usdcBalance: 0,
        lastBalanceCheck: 0,
        initialCashSet: false,  // Track if INITIAL_CASH has been calibrated from real balance
        lastAPIReconcile: 0,    // Last time we ran reconcileWithAPI()
        lastReconcileTime: 0,   // Last time we ran reconcileAccounting()
        lastFillReconcileTime: 0,  // Last time we ran reconcileActualFillsWithApi()
        paused: false,
        pauseReason: null,
        // Track constraint errors per token
        constraintErrors: new Map(),  // tokenId -> [{timestamp, error}, ...]
        disabledTokens: new Map(),    // tokenId -> disabledUntil timestamp
        lastConstraintLog: new Map(),  // tokenId -> last log timestamp (rate limiting)
        // Track outcome balances for synthetic fill detection
        lastOutcomeBalances: { yes: 0, no: 0 }  // Previous YES/NO outcome token balances
    },

    // Market warm-up period after switching
    marketWarmup: {
        active: false,
        startTime: 0,
        minOrderbookUpdates: 2,  // Need both YES and NO orderbooks
        minTrades: 0             // Don't require trades - orderbooks are enough
    },

    // WebSocket
    ws: null,
    wsConnected: false,

    // Stats
    stats: {
        totalTrades: 0,
        orderbookUpdates: 0,
        quotesGenerated: 0,
        ordersPlaced: 0,
        ordersCanceled: 0,
        fills: 0,
        startTime: Date.now(),
        recentOrderbookTimestamps: [],
        recentTradeTimestamps: [],
        orderbookUpdatesPerMinute: 0,
        tradesPerMinute: 0
    }
};

// ============================================================================
// CLOB CLIENT (SINGLETON)
// ============================================================================

let clobClient = null;

async function ensureClient() {
    if (clobClient) return clobClient;

    if (CONFIG.SIMULATION_MODE) {
        // In simulation, create client without key (won't place orders)
        log('⚠️  SIMULATION MODE: Creating read-only client', 'oms');
        clobClient = new ClobClient(
            CONFIG.CLOB_HOST,
            CONFIG.CHAIN_ID
        );
        return clobClient;
    }

    // LIVE mode requires PRIVATE_KEY
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) {
        throw new Error(
            '❌ LIVE MODE requires PRIVATE_KEY environment variable!\n' +
            'Set it with: export PRIVATE_KEY=0x...\n' +
            'Or run in SIMULATION_MODE by setting CONFIG.SIMULATION_MODE = true'
        );
    }

    log('💰 LIVE MODE: Creating authenticated client', 'oms');

    const funderAddress = process.env.FUNDER_ADDRESS;

    try {
        // Create Polygon provider using ethers v5 (required by clob-client)
        const provider = new JsonRpcProvider('https://polygon-rpc.com');

        // Create ethers v5 Wallet from private key with provider
        const wallet = new Wallet(privateKey, provider);
        log(`📍 Wallet address (signer): ${wallet.address}`, 'oms', 'INFO');

        if (funderAddress) {
            log(`📍 Funder address (proxy wallet): ${funderAddress}`, 'oms', 'INFO');
            log(`ℹ️  Trading will use funder address balance`, 'oms', 'INFO');
            log(`🔐 Using SignatureType.POLY_PROXY (1) for proxy wallet`, 'oms', 'INFO');
        }

        // STEP 1: Create client with just wallet (no API creds yet)
        // CRITICAL: When using proxy wallet (funder), MUST use SignatureType.POLY_PROXY
        // SignatureType.EOA (0) = EOA directly signs and is maker
        // SignatureType.POLY_PROXY (1) = EOA signs on behalf of proxy wallet (proxy is maker)
        const signatureType = funderAddress ? SignatureType.POLY_PROXY : SignatureType.EOA;

        clobClient = new ClobClient(
            CONFIG.CLOB_HOST,
            CONFIG.CHAIN_ID,
            wallet,  // ethers v5 Wallet (EOA owner) with getAddress() method
            undefined,  // No creds yet
            signatureType,  // SignatureType.POLY_PROXY for proxy wallet
            funderAddress || wallet.address  // Proxy address (maker/funder)
        );

        log('✅ CLOB Client initialized with ethers v5 Wallet', 'oms', 'INFO');

        // STEP 2: Derive API key programmatically
        // This retrieves/derives the L2 auth credentials deterministically from the wallet
        log('🔑 Deriving API credentials from wallet...', 'oms', 'INFO');
        let apiCreds;
        try {
            // Try deriving first (for existing keys)
            apiCreds = await clobClient.deriveApiKey();
            log('✅ API credentials derived (existing key)', 'oms', 'INFO');
        } catch (err) {
            // If derive fails, try creating new key
            log('⚠️  Derive failed, attempting to create new API key...', 'oms', 'WARN');
            apiCreds = await clobClient.createApiKey();
            log('✅ New API key created', 'oms', 'INFO');
        }
        log(`   Key: ${apiCreds.key}`, 'oms', 'DEBUG');

        // STEP 3: Create new client WITH API credentials
        // MUST use same signatureType as STEP 1
        clobClient = new ClobClient(
            CONFIG.CLOB_HOST,
            CONFIG.CHAIN_ID,
            wallet,
            apiCreds,  // Now we have valid API credentials
            signatureType,  // SignatureType.POLY_PROXY for proxy wallet
            funderAddress || wallet.address
        );

        log('✅ CLOB Client re-initialized with API credentials', 'oms', 'INFO');
        log(`   SignatureType: ${signatureType === SignatureType.POLY_PROXY ? 'POLY_PROXY (1)' : 'EOA (0)'}`, 'oms', 'DEBUG');
    } catch (err) {
        log(`❌ Failed to create CLOB client: ${err.message}`, 'oms', 'ERROR');
        log(`   Stack: ${err.stack}`, 'oms', 'DEBUG');
        throw err;
    }

    return clobClient;
}

// ============================================================================
// EXCHANGE ADAPTER - REAL API INTEGRATION
// ============================================================================

class ExchangeAdapter {
    constructor() {
        this.client = null;
        this.userWs = null;
        this.onFillCallback = null;
        this.onOrderUpdateCallback = null;
        this.pollingInterval = null;
        // Market constraints cache: tokenID -> { minOrderSize, sizeTick, cachedAt }
        this.marketConstraintsCache = new Map();
        this.CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
    }

    async init() {
        log('🔌 ExchangeAdapter: Initializing...', 'oms', 'INFO');

        // Use the global authenticated client (already initialized with credentials)
        this.client = await ensureClient();

        if (!this.client) {
            throw new Error('Failed to initialize CLOB client');
        }

        log('✅ ExchangeAdapter: CLOB client ready', 'oms', 'INFO');

        // Try to subscribe to user events (real-time fills/order updates)
        try {
            await this.subscribeUserEvents();
        } catch (err) {
            log(`⚠️  ExchangeAdapter: User WS failed, will use polling: ${err.message}`, 'oms', 'WARN');
            this.startPollingFallback();
        }

        return this;
    }

    async subscribeUserEvents() {
        // UserMarketWebSocket is not exported by @polymarket/clob-client
        // Use polling fallback instead
        log('ℹ️  Using polling for user events (WebSocket not available)', 'oms', 'INFO');
        this.startPollingFallback();
    }

    startPollingFallback() {
        log('🔄 Starting polling fallback for fills/orders', 'oms', 'INFO');

        // Track last known order sizes to detect fills
        this.lastKnownOrders = new Map();

        // Poll every 5 seconds for order state changes
        this.pollingInterval = setInterval(async () => {
            try {
                const orders = await this.getOpenOrders();

                // Detect fills by comparing sizeRemaining changes
                for (const order of orders) {
                    const lastKnown = this.lastKnownOrders.get(order.orderId);

                    if (lastKnown && lastKnown.sizeRemaining > order.sizeRemaining) {
                        // Fill detected!
                        const fillSize = lastKnown.sizeRemaining - order.sizeRemaining;

                        if (this.onFillCallback && fillSize > 0) {
                            this.onFillCallback({
                                orderID: order.orderId,
                                tokenID: order.tokenId,
                                side: order.side,
                                price: order.price,
                                size: fillSize
                            });
                        }
                    }

                    // Update last known state
                    this.lastKnownOrders.set(order.orderId, {
                        orderId: order.orderId,
                        sizeRemaining: order.sizeRemaining
                    });

                    // Process order updates via callback
                    if (this.onOrderUpdateCallback) {
                        this.onOrderUpdateCallback(order);
                    }
                }

                // Clean up orders that no longer exist
                const currentOrderIds = new Set(orders.map(o => o.orderId));
                for (const orderId of this.lastKnownOrders.keys()) {
                    if (!currentOrderIds.has(orderId)) {
                        this.lastKnownOrders.delete(orderId);
                    }
                }

            } catch (err) {
                log(`⚠️  Polling error: ${err.message}`, 'oms', 'WARN');
            }
        }, 5000);
    }

    setOnFill(callback) {
        this.onFillCallback = callback;
    }

    setOnOrderUpdate(callback) {
        this.onOrderUpdateCallback = callback;
    }

    async getMarketConstraints(tokenId) {
        // Check cache first
        const cached = this.marketConstraintsCache.get(tokenId);
        if (cached && (Date.now() - cached.cachedAt < this.CACHE_TTL_MS)) {
            return cached;
        }

        try {
            // Get market constraints from CLOB API
            // The market object contains min_order_size and other constraints
            log(`🔍 Fetching market constraints for token ${tokenId.slice(0, 8)}...`, 'oms', 'DEBUG');

            // Try to get from getMarket endpoint (requires conditionID)
            // Since we have tokenID, we need to find the market first
            // For now, use a default minOrderSize and fetch from error messages

            // CLOB doesn't have direct tokenID->minOrderSize endpoint
            // But we can infer from getSamplingMarkets or handle errors gracefully

            // Default constraints (will be updated from REST/WS or error messages)
            // Use conservative defaults to minimize 400 errors
            const constraints = {
                minOrderSize: 10.0,  // Conservative default (Polymarket often requires 5-10)
                sizeTick: 1.0,       // Conservative default
                cachedAt: Date.now()
            };

            log(`⚠️  Using default constraints for token ${tokenId.slice(0, 8)}: min=${constraints.minOrderSize}, tick=${constraints.sizeTick}`, 'oms', 'WARN');
            log(`   Constraints will be learned from REST/WS book or error messages`, 'oms', 'DEBUG');

            this.marketConstraintsCache.set(tokenId, constraints);
            return constraints;

        } catch (err) {
            log(`⚠️  Failed to fetch market constraints: ${err.message}`, 'oms', 'WARN');
            // Return safe defaults (same as above)
            return {
                minOrderSize: 10.0,  // Conservative default
                sizeTick: 1.0,       // Conservative default
                cachedAt: Date.now()
            };
        }
    }

    updateMarketConstraintsFromError(tokenId, errorMsg) {
        // Parse error message like "Size (4) lower than the minimum: 5" or "lower than the minimum: 5.0"
        const match = errorMsg.match(/minimum:\s*([0-9]+(?:\.[0-9]+)?)/i);
        if (match) {
            const minOrderSize = parseFloat(match[1]);
            log(`📝 Learned from error: minOrderSize=${fmt(minOrderSize, 2)} for token ${tokenId.slice(0, 8)}`, 'oms', 'INFO');
            log(`   Error message: ${errorMsg}`, 'oms', 'DEBUG');

            // Get existing constraints to preserve sizeTick if available
            const existing = this.marketConstraintsCache.get(tokenId);

            this.marketConstraintsCache.set(tokenId, {
                minOrderSize,
                sizeTick: existing?.sizeTick || 0.1,  // Preserve existing tick, or use default
                cachedAt: Date.now()
            });
        } else {
            log(`⚠️  Could not parse minOrderSize from error: ${errorMsg}`, 'oms', 'WARN');
        }
    }

    async postOrder(tokenId, side, price, size) {
        if (!this.client) throw new Error('Client not initialized');

        try {
            // Get market constraints to validate size
            const constraints = await this.getMarketConstraints(tokenId);
            const { minOrderSize, sizeTick } = constraints;

            // Normalize size using unified utility (fail-safe layer)
            let roundedSize = normalizeSizeWithConstraints(size, { minOrderSize, sizeTick });

            // Final validation: if still below minimum (shouldn't happen), throw non-fatal error
            if (roundedSize < minOrderSize) {
                log(`⚠️  FAIL-SAFE: Size ${fmt(roundedSize, 2)} still < minOrderSize ${fmt(minOrderSize, 2)} after normalization`, 'oms', 'ERROR');
                const error = new Error(`Order size ${fmt(size, 2)} below minimum ${fmt(minOrderSize, 2)} for this market`);
                error.code = 'SIZE_TOO_SMALL';
                error.minOrderSize = minOrderSize;
                error.isFatal = false;
                throw error;
            }

            // Correct API: createAndPostOrder creates, signs and posts in one call
            // UserOrder interface requires price and size as numbers, not strings
            const userOrder = {
                tokenID: tokenId,
                price: price,  // Number, not string
                size: roundedSize,    // Number, rounded to tick
                side: side.toUpperCase(), // Side enum: 'BUY' or 'SELL'
                feeRateBps: 0,  // Number: 0 = market maker rebate (no fee)
            };

            log(`📤 POST ORDER: ${side.toUpperCase()} ${fmt(roundedSize, 2)}@${fmt(price, 4)} token=${tokenId.slice(0, 8)}`, 'oms', 'DEBUG');
            log(`   Constraints: minSize=${fmt(minOrderSize, 2)}, tick=${fmt(sizeTick, 2)}`, 'oms', 'DEBUG');
            log(`   Decision: originalSize=${fmt(size, 2)} → roundedSize=${fmt(roundedSize, 2)}`, 'oms', 'DEBUG');

            // Diagnostic: Log signature type info (without exposing private keys)
            if (this.client.orderBuilder) {
                const sigType = this.client.orderBuilder.signatureType;
                log(`   SignatureType: ${sigType} (${sigType === 1 ? 'POLY_PROXY' : sigType === 0 ? 'EOA' : 'OTHER'})`, 'oms', 'DEBUG');
            }

            // createAndPostOrder returns OrderResponse
            const response = await this.client.createAndPostOrder(userOrder);

            log(`✅ ORDER POSTED: ${JSON.stringify(response)}`, 'oms', 'DEBUG');

            // Response structure: { success: bool, errorMsg?: string, orderID: string, ... }
            if (!response.success) {
                throw new Error(response.errorMsg || 'Unknown error');
            }

            return {
                success: true,
                orderId: response.orderID,
                raw: response
            };

        } catch (err) {
            // Check if error is about minimum size - learn from it
            const errMsg = err.message || err.toString();
            if (errMsg.includes('lower than') && errMsg.includes('minimum')) {
                log(`📝 Constraint error detected: ${errMsg}`, 'oms', 'INFO');

                // Try to learn minOrderSize from error message
                const oldConstraints = this.marketConstraintsCache.get(tokenId);
                this.updateMarketConstraintsFromError(tokenId, errMsg);
                const newConstraints = this.marketConstraintsCache.get(tokenId);

                // Check if we learned something new
                const learnedNewValue = !oldConstraints || (newConstraints.minOrderSize > oldConstraints.minOrderSize);

                if (learnedNewValue) {
                    log(`✅ Learned new constraint, will use ${newConstraints.minOrderSize} for next order`, 'oms', 'INFO');
                } else {
                    log(`⚠️  Already knew this constraint, but order still failed - possible logic error`, 'oms', 'WARN');
                }

                // Mark as non-fatal constraint error
                err.code = 'MARKET_CONSTRAINT';
                err.isFatal = false;
                err.canRetry = learnedNewValue;  // Only retry if we learned something new

                // Track constraint errors for this token (but don't disable unless repeated failures)
                if (!STATE.live.constraintErrors.has(tokenId)) {
                    STATE.live.constraintErrors.set(tokenId, []);
                }

                const errors = STATE.live.constraintErrors.get(tokenId);
                errors.push({ timestamp: Date.now(), error: errMsg, learned: learnedNewValue });

                // Clean up old errors (older than 60 seconds)
                const cutoff = Date.now() - 60000;
                STATE.live.constraintErrors.set(
                    tokenId,
                    errors.filter(e => e.timestamp > cutoff)
                );

                // Only disable if we have 5+ errors in 60s AND we're not learning new values
                // (This prevents disabling during legitimate constraint discovery)
                const recentErrors = STATE.live.constraintErrors.get(tokenId);
                const recentFailuresWithoutLearning = recentErrors.filter(e => !e.learned);

                if (recentFailuresWithoutLearning.length >= 5) {
                    const disableUntil = Date.now() + (5 * 60 * 1000);  // 5 minutes
                    STATE.live.disabledTokens.set(tokenId, disableUntil);
                    log(`🚫 Token ${tokenId.slice(0, 8)} disabled for 5 minutes (5+ repeated constraint failures)`, 'oms', 'ERROR');
                    // Clear errors for this token
                    STATE.live.constraintErrors.set(tokenId, []);
                }
            }

            // Check if error is about insufficient balance/allowance
            if (errMsg.includes('not enough balance') ||
                errMsg.includes('not enough') ||
                errMsg.includes('insufficient') ||
                errMsg.includes('allowance')) {
                err.code = 'INSUFFICIENT_BALANCE';
                err.isFatal = false;
                log(`💡 Balance/allowance issue detected - this is expected, not an API error`, 'oms', 'INFO');
            }

            // Check if error is about marketable order min notional
            if (errMsg.includes('invalid amount for a marketable') ||
                errMsg.includes('min size: $')) {
                err.code = 'MARKETABLE_MIN_NOTIONAL';
                err.isFatal = false;
                log(`💡 Marketable order min notional issue - this is a constraint, not an API error`, 'oms', 'INFO');
            }

            log(`❌ POST ORDER FAILED: ${errMsg}`, 'oms', 'ERROR');
            log(`   Error code: ${err.code || 'UNKNOWN'}, isFatal: ${err.isFatal !== false}`, 'oms', 'DEBUG');
            throw err;
        }
    }

    async cancelOrder(orderId) {
        if (!this.client) throw new Error('Client not initialized');

        try {
            log(`🗑️  CANCEL ORDER: ${orderId}`, 'oms', 'DEBUG');

            // cancelOrder requires OrderPayload object: { orderID: string }
            const response = await this.client.cancelOrder({ orderID: orderId });

            log(`✅ ORDER CANCELED: ${JSON.stringify(response)}`, 'oms', 'DEBUG');

            return {
                success: true,
                raw: response
            };

        } catch (err) {
            log(`❌ CANCEL ORDER FAILED: ${err.message}`, 'oms', 'ERROR');
            throw err;
        }
    }

    async getOpenOrders() {
        if (!this.client) throw new Error('Client not initialized');

        try {
            const orders = await this.client.getOpenOrders();

            // Parse and normalize order structure
            // Expected fields: orderID, tokenID, side, price, size, originalSize, status
            return orders.map(o => ({
                orderId: o.orderID || o.id,
                tokenId: o.tokenID || o.asset_id,
                side: o.side?.toUpperCase(), // Normalize to uppercase for consistency
                price: parseFloat(o.price),
                size: parseFloat(o.size),
                sizeRemaining: parseFloat(o.size || o.originalSize),
                status: o.status || 'open',
                timestamp: o.timestamp || Date.now(),
                raw: o
            }));

        } catch (err) {
            log(`❌ GET OPEN ORDERS FAILED: ${err.message}`, 'oms', 'ERROR');
            throw err;
        }
    }

    async approveUSDC() {
        try {
            const walletAddress = await this.client.signer.getAddress();
            const funderAddress = process.env.FUNDER_ADDRESS || walletAddress;

            log('🔓 Setting USDC allowance for CTF Exchange...', 'oms', 'INFO');
            log(`   Address: ${funderAddress}`, 'oms', 'INFO');

            // Используем метод клиента если есть
            if (typeof this.client.setAllowance === 'function') {
                // Max approval (unlimited)
                const maxApproval = '115792089237316195423570985008687907853269984665640564039457584007913129639935';

                const result = await this.client.setAllowance(maxApproval);
                log(`✅ Approval transaction sent: ${JSON.stringify(result)}`, 'oms', 'INFO');

                // Подождать подтверждения
                log('⏳ Waiting 30s for confirmation...', 'oms', 'INFO');
                await new Promise(resolve => setTimeout(resolve, 30000));

                // Перепроверить баланс
                const balance = await this.getBalance();
                log(`💰 Balance after approval: ${balance.toFixed(2)} USDC`, 'oms', 'INFO');

                return true;
            } else {
                log('⚠️  setAllowance method not available on client', 'oms', 'WARN');
                log('   You may need to approve manually on Polymarket website', 'oms', 'WARN');
                return false;
            }

        } catch (err) {
            log(`❌ Approve failed: ${err.message}`, 'oms', 'ERROR');
            return false;
        }
    }

    async getBalance() {
        if (!this.client) throw new Error('Client not initialized');

        try {
            // Получить адрес для проверки
            const walletAddress = await this.client.signer.getAddress();
            const funderAddress = process.env.FUNDER_ADDRESS || walletAddress;
            const addressToCheck = funderAddress; // Используем funder address

            log(`🔍 Checking on-chain USDC balance for ${addressToCheck.slice(0, 8)}...`, 'oms', 'DEBUG');

            // USDC contract address on Polygon
            const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

            // ERC20 ABI для balanceOf
            const ERC20_ABI = [
                'function balanceOf(address owner) view returns (uint256)',
                'function decimals() view returns (uint8)'
            ];

            // Создать контракт для чтения баланса
            const provider = this.client.signer.provider;
            const {Contract} = await import('@ethersproject/contracts');
            const usdcContract = new Contract(USDC_ADDRESS, ERC20_ABI, provider);

            // Получить баланс
            const balanceRaw = await usdcContract.balanceOf(addressToCheck);
            const decimals = await usdcContract.decimals();

            // Конвертировать из wei в USDC (обычно 6 decimals)
            const balance = (parseFloat(balanceRaw.toString()) * 0.85) / Math.pow(10, decimals);

            log(`💰 On-chain USDC Balance: ${balance.toFixed(2)} USDC`, 'oms', 'INFO');

            // Также проверить allowance для CTF Exchange
            const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
            const allowanceAbi = ['function allowance(address owner, address spender) view returns (uint256)'];
            const usdcWithAllowance = new Contract(USDC_ADDRESS, allowanceAbi, provider);
            const allowance = await usdcWithAllowance.allowance(addressToCheck, CTF_EXCHANGE);

            const hasAllowance = allowance.gt(0);
            log(`🔓 CTF Exchange allowance: ${hasAllowance ? 'SET ✅' : 'NOT SET ❌'}`, 'oms', 'INFO');

            if (balance > 0 && !hasAllowance) {
                log(`⚠️  You have ${balance.toFixed(2)} USDC but allowance not set!`, 'oms', 'WARN');
                log(`   Run: await bot.approveUSDC() to enable trading`, 'oms', 'WARN');
            }

            return balance;

        } catch (err) {
            log(`❌ getBalance failed: ${err.message}`, 'oms', 'ERROR');
            log(`   Stack: ${err.stack}`, 'oms', 'DEBUG');
            return 0;
        }
    }

    async getCollateralBalance() {
        // Get USDC collateral balance (same as getBalance but more explicit)
        return await this.getBalance();
    }

    async getOutcomeBalance(tokenId) {
        if (!this.client) throw new Error('Client not initialized');

        try {
            // Get CONDITIONAL token balance for specific outcome token
            const response = await this.client.getBalanceAllowance({
                asset_type: AssetType.CONDITIONAL,
                token_id: tokenId
            });

            if (!response || !response.balance) {
                return 0;
            }

            // Polymarket returns balance in raw units (with 6 decimals)
            // 1 share = 1_000_000 raw units
            const rawBalance = parseFloat(response.balance);
            const balance = rawBalance / 1_000_000;

            log(`🎯 Outcome token balance for ${tokenId.slice(0, 8)}: ${balance.toFixed(2)} shares (raw: ${rawBalance})`, 'oms', 'DEBUG');

            return balance;

        } catch (err) {
            const errorMsg = err.message || err.toString() || 'Unknown error';
            log(`⚠️  GET OUTCOME BALANCE FAILED for ${tokenId.slice(0, 8)}: ${errorMsg}`, 'oms', 'DEBUG');
            return 0;
        }
    }

    async canPlaceOrder(tokenId, side, size, price) {
        /**
         * Check if order can be placed based on balance and allowance
         * Returns: { ok: boolean, reason: string }
         */
        try {
            if (side.toUpperCase() === 'BUY') {
                // For BUY: need collateral (USDC)
                const collateralBalance = await this.getCollateralBalance();
                const requiredCollateral = size * price;
                const availableCollateral = collateralBalance - STATE.inventory.reservedCash;

                if (availableCollateral < requiredCollateral) {
                    return {
                        ok: false,
                        reason: `Insufficient collateral: need ${requiredCollateral.toFixed(2)}, have ${availableCollateral.toFixed(2)} available (${collateralBalance.toFixed(2)} total - ${STATE.inventory.reservedCash.toFixed(2)} reserved)`
                    };
                }

                // Check allowance
                const response = await this.client.getBalanceAllowance({
                    asset_type: AssetType.COLLATERAL
                });

                if (response && response.allowance !== undefined) {
                    const allowance = parseFloat(response.allowance);
                    if (allowance < requiredCollateral && allowance !== 0) {
                        return {
                            ok: false,
                            reason: `Insufficient allowance: need ${requiredCollateral.toFixed(2)}, allowance ${allowance.toFixed(2)}`
                        };
                    }
                }

                return { ok: true, reason: 'Sufficient collateral and allowance' };

            } else {
                // For SELL: need outcome tokens
                const outcomeBalance = await this.getOutcomeBalance(tokenId);

                if (outcomeBalance < size) {
                    return {
                        ok: false,
                        reason: `Insufficient outcome tokens: need ${size.toFixed(2)}, have ${outcomeBalance.toFixed(2)}`
                    };
                }

                return { ok: true, reason: 'Sufficient outcome tokens' };
            }

        } catch (err) {
            const errorMsg = err.message || err.toString() || 'Unknown error';
            log(`⚠️  canPlaceOrder check failed: ${errorMsg}`, 'oms', 'WARN');

            if (!CONFIG.SIMULATION_MODE) {
                return { ok: false, reason: "Balance/allowance check failed (temporary). Skipping order." };
            }

            // В SIM можешь оставить fail-open, чтобы сим не стопорился
            return { ok: true, reason: "SIM: allowing order despite check failure" };
        }
    }

    destroy() {
        if (this.userWs) {
            this.userWs.close();
            this.userWs = null;
        }
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
    }

    async getFillHistory(tokenId = null, limit = 100) {
        /**
         * CRITICAL: Get actual fill history from CLOB API
         * Returns EXECUTED prices, not limit order prices!
         *
         * This fixes the accounting bug where bot tracks limit prices
         * but CLOB executes at best available prices in the book.
         */
        if (!this.client) throw new Error('Client not initialized');

        try {
            log(`🔍 Fetching fill history for ${tokenId ? tokenId.slice(0,8) : 'all'}...`, 'oms', 'DEBUG');

            // Get filled orders from CLOB API
            const params = {
                status: 'MATCHED',  // Only filled orders
                limit: limit
            };

            // If tokenId specified, filter by asset_id
            if (tokenId) {
                params.asset_id = tokenId;
            }

            const allOrders = await this.client.getOrders(params);

            if (!allOrders || allOrders.length === 0) {
                log(`   No filled orders found`, 'oms', 'DEBUG');
                return [];
            }

            // Transform to unified format
            const normalizedFills = allOrders.map(order => {
                // CRITICAL: CLOB API may return different fields for executed price
                // Check multiple possible fields
                let executedPrice = parseFloat(order.price); // Default to limit price

                // Try to find actual executed price
                if (order.executed_price) {
                    executedPrice = parseFloat(order.executed_price);
                } else if (order.avgPrice) {
                    executedPrice = parseFloat(order.avgPrice);
                } else if (order.avg_price) {
                    executedPrice = parseFloat(order.avg_price);
                }

                const limitPrice = parseFloat(order.price);
                const sizeFilled = parseFloat(order.size_matched || order.size || 0);

                return {
                    orderId: order.id || order.orderID,
                    tokenId: order.asset_id || order.tokenID,
                    side: (order.side || '').toLowerCase(),
                    limitPrice: limitPrice,
                    executedPrice: executedPrice,
                    size: sizeFilled,
                    timestamp: order.created_at ? new Date(order.created_at).getTime() : Date.now(),
                    fee: parseFloat(order.maker_fees || order.taker_fees || 0),
                    feeToken: 'USDC',
                    raw: order
                };
            });

            log(`📊 Found ${normalizedFills.length} actual fills from CLOB API`, 'oms', 'DEBUG');

            // Log price differences if any
            let priceDiscrepancies = 0;
            for (const fill of normalizedFills) {
                const priceDiff = Math.abs(fill.executedPrice - fill.limitPrice);
                if (priceDiff > 0.0001) {
                    priceDiscrepancies++;
                    if (priceDiscrepancies <= 3) { // Log first 3
                        log(`   💰 Price difference: ${fill.orderId.slice(0,8)} limit=${fill.limitPrice.toFixed(4)} exec=${fill.executedPrice.toFixed(4)} diff=${priceDiff.toFixed(4)}`, 'oms', 'DEBUG');
                    }
                }
            }

            if (priceDiscrepancies > 0) {
                log(`   ⚠️  Found ${priceDiscrepancies} fills with price improvements`, 'oms', 'INFO');
            }

            return normalizedFills;

        } catch (err) {
            log(`⚠️  Failed to fetch fill history: ${err.message}`, 'oms', 'WARN');
            log(`   Stack: ${err.stack}`, 'oms', 'DEBUG');
            return [];
        }
    }
}

// Global adapter instance
let exchangeAdapter = null;

// ============================================================================
// BLESSED UI SYSTEM - TWO COLUMN LAYOUT
// ============================================================================

let screen = null;
let statusBox = null;
let logsBox = null;
let ordersBox = null;
let mainLoopBox = null;

const SCREEN_BUFFERS = {
    logs: [],           // Right panel: recent logs
    mainLoopLogs: [],   // Bottom: main loop section
    fillHistory: []     // Fill history for orders panel
};

const MAX_LOGS = 100;           // Right panel height (will auto-scroll)
const MAX_MAIN_LOOP_LOGS = 100;  // Bottom section height (will auto-scroll)
const MAX_FILL_HISTORY = 50;    // Order fills history

function initializeUI() {
    // Create screen
    screen = blessed.screen({
        smartCSR: true,
        title: 'Polymarket MM Bot V3',
        fullUnicode: true,
        dockBorders: true,
        ignoreLocked: ['C-c'],
        // Suppress terminal capability warnings
        warnings: false,
        // Force standard terminal handling to avoid xterm-256color issues
        terminal: process.env.TERM || 'xterm-256color',
        forceUnicode: false
    });

    // Status box (left panel) - fixed width 70 chars
    statusBox = blessed.box({
        top: 0,
        left: 0,
        width: 72, // 70 + 2 for borders
        height: '60%',
        label: ' STATUS ',
        border: {
            type: 'line'
        },
        style: {
            border: {
                fg: 'cyan'
            }
        },
        tags: true,
        scrollable: true,
        alwaysScroll: true,
        scrollbar: {
            ch: '█',
            style: {
                fg: 'cyan'
            }
        }
    });

    // Logs box (right top panel)
    logsBox = blessed.box({
        top: 0,
        left: 72,
        width: 'shrink',
        height: '60%',
        label: ' ACTIVITY ',
        border: {
            type: 'line'
        },
        style: {
            border: {
                fg: 'green'
            }
        },
        tags: true,
        scrollable: true,
        alwaysScroll: true,
        scrollbar: {
            ch: '█',
            style: {
                fg: 'green'
            }
        }
    });

    // Orders box (middle left)
    ordersBox = blessed.box({
        top: '60%',
        left: 0,
        width: 72,
        height: '40%',
        label: ' ORDERS & FILLS ',
        border: {
            type: 'line'
        },
        style: {
            border: {
                fg: 'magenta'
            }
        },
        tags: true,
        scrollable: true,
        alwaysScroll: true,
        scrollbar: {
            ch: '█',
            style: {
                fg: 'magenta'
            }
        }
    });

    // Main loop box (middle right)
    mainLoopBox = blessed.box({
        top: '60%',
        left: 72,
        width: 'shrink',
        height: '40%',
        label: ' MAIN LOOP ',
        border: {
            type: 'line'
        },
        style: {
            border: {
                fg: 'yellow'
            }
        },
        tags: true,
        scrollable: true,
        alwaysScroll: true,
        scrollbar: {
            ch: '█',
            style: {
                fg: 'yellow'
            }
        }
    });

    screen.append(statusBox);
    screen.append(logsBox);
    screen.append(ordersBox);
    screen.append(mainLoopBox);

    // Quit on Escape, q, or Control-C
    screen.key(['escape', 'q', 'C-c'], function() {
        return process.emit('SIGINT');
    });

    screen.render();
}

function log(message, category = 'system', level = 'INFO') {
    // Ensure message is a string
    if (typeof message !== 'string') {
        message = String(message);
    }

    // Infer log level from message keywords if not explicitly provided
    if (level === 'INFO') {
        if (message.includes('ERROR') || message.includes('❌') || message.includes('[ERR]')) {
            level = 'ERROR';
        } else if (message.includes('WARN') || message.includes('⚠️') || message.includes('[WARN]') ||
                   message.includes('CRITICAL') || message.includes('🚨')) {
            level = 'WARN';
        } else if (message.includes('DEBUG') || category === 'debug') {
            level = 'DEBUG';
        }
    }

    // FILE LOG: Write to console.log file (with level + category filtering)
    FILE_LOGGER.logConsole(message, category, level);

    // Continue with screen rendering as before
    if (!screen) return;

    // Strip emoji if ASCII_ONLY mode
    message = stripEmojiForAscii(message);

    const timestamp = new Date().toISOString().split('T')[1].substring(0, 12);
    const line = { time: timestamp, msg: message, cat: category };

    if (category === 'mainloop') {
        // Check if last message is the same (avoid duplicates)
        const lastLog = SCREEN_BUFFERS.mainLoopLogs[SCREEN_BUFFERS.mainLoopLogs.length - 1];
        if (lastLog && lastLog.msg === message) {
            // Don't add duplicate, just update screen without new log
            return;
        }

        SCREEN_BUFFERS.mainLoopLogs.push(line);
        if (SCREEN_BUFFERS.mainLoopLogs.length > MAX_MAIN_LOOP_LOGS) {
            SCREEN_BUFFERS.mainLoopLogs.shift();
        }
    } else {
        // Check if last message is the same (avoid duplicates)
        const lastLog = SCREEN_BUFFERS.logs[SCREEN_BUFFERS.logs.length - 1];
        if (lastLog && lastLog.msg === message) {
            // Don't add duplicate, just update screen without new log
            return;
        }

        SCREEN_BUFFERS.logs.push(line);
        if (SCREEN_BUFFERS.logs.length > MAX_LOGS) {
            SCREEN_BUFFERS.logs.shift();
        }
    }

    renderScreen();
}

function logSection(title) {
    // Simplified for cleaner output
}

function logSystemStatus() {
    renderScreen();
}

function logPnLBreakdown() {
    /**
     * Detailed PnL logging for debugging
     * Shows different calculation methods for SIMULATION vs LIVE
     */
    const snapshot = computeExposureSnapshot();
    if (!snapshot) return;
    
    if (CONFIG.SIMULATION_MODE) {
        log(`PnL SIMULATION: Unrealized=$${STATE.inventory.unrealizedPnL.toFixed(2)}, Realized=$${STATE.inventory.realizedPnL.toFixed(2)}`, 'debug');
        log(`  YES: ${STATE.inventory.yesShares.toFixed(1)} @ ${STATE.inventory.costBasis.yes.toFixed(4)} (mid=${snapshot.pYesMid.toFixed(4)})`, 'debug');
        log(`  NO: ${STATE.inventory.noShares.toFixed(1)} @ ${STATE.inventory.costBasis.no.toFixed(4)} (mid=${snapshot.pNoMid.toFixed(4)})`, 'debug');
        log(`  Cash: $${STATE.inventory.cash.toFixed(2)} (reserved: $${STATE.inventory.reservedCash.toFixed(2)})`, 'debug');
    } else {
        const totalPnL = STATE.inventory.unrealizedPnL + STATE.inventory.realizedPnL;
        const yesValue = STATE.inventory.yesShares * snapshot.pYesMid;
        const noValue = STATE.inventory.noShares * snapshot.pNoMid;
        const portfolioValue = STATE.inventory.cash + yesValue + noValue;
        
        log(`PnL LIVE: Total=$${totalPnL.toFixed(2)} (Unrealized=$${STATE.inventory.unrealizedPnL.toFixed(2)}, Realized=$${STATE.inventory.realizedPnL.toFixed(2)})`, 'debug');
        log(`  Cash: $${STATE.inventory.cash.toFixed(2)}, INITIAL_CASH: $${CONFIG.RISK.INITIAL_CASH.toFixed(2)}`, 'debug');
        log(`  Shares value: YES=$${yesValue.toFixed(2)} + NO=$${noValue.toFixed(2)} = $${(yesValue + noValue).toFixed(2)}`, 'debug');
        log(`  Portfolio Value: $${portfolioValue.toFixed(2)}`, 'debug');
    }
}

function pad(str, len) {
    const stripped = blessed.stripTags(str);
    if (stripped.length >= len) return str.substring(0, len);
    return str + ' '.repeat(len - stripped.length);
}

function renderScreen() {
    if (!screen) return;

    // Build content
    const statusLines = buildStatusPanel();
    const logsLines = buildLogsPanel();
    const ordersLines = buildOrdersPanel();
    const mainLoopLines = buildMainLoopPanel();

    // Update boxes
    statusBox.setContent(statusLines.join('\n'));
    logsBox.setContent(logsLines.join('\n'));
    ordersBox.setContent(ordersLines.join('\n'));
    mainLoopBox.setContent(mainLoopLines.join('\n'));

    // Auto-scroll to bottom
    statusBox.setScrollPerc(100);
    logsBox.setScrollPerc(100);
    ordersBox.setScrollPerc(100);
    mainLoopBox.setScrollPerc(100);

    screen.render();
}

function buildStatusPanel() {
    const market = STATE.markets.get(STATE.selectedMarket);
    const lines = [];

    // Market info
    if (market) {
        // Market name (может быть длинным, разбиваем если нужно)
        const question = market.question;
        if (question.length > 68) {
            // Разбиваем на две строки
            const line1 = question.substring(0, 68);
            const line2 = question.substring(68);
            lines.push(`{cyan-fg}{bold}${line1}{/bold}{/cyan-fg}`);
            lines.push(`{cyan-fg}{bold}${line2}{/bold}{/cyan-fg}`);
        } else {
            lines.push(`{cyan-fg}{bold}${question}{/bold}{/cyan-fg}`);
        }

        // End date formatted
        const endDate = new Date(market.endDate);
        const endDateStr = endDate.toLocaleString('en-US', {
            month: '2-digit',
            day: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });
        lines.push(`End Date: ${endDateStr}`);

        // Time until expiry
        const msToExpiry = Math.max(0, endDate - Date.now());
        const hours = Math.floor(msToExpiry / (1000 * 60 * 60));
        const mins = Math.floor((msToExpiry % (1000 * 60 * 60)) / (1000 * 60));
        const secs = Math.floor((msToExpiry % (1000 * 60)) / 1000);

        let expiryStr = '';
        if (hours > 0) {
            expiryStr = `${hours}h ${mins}m`;
        } else if (mins > 0) {
            expiryStr = `${mins}m ${secs}s`;
        } else {
            expiryStr = `${secs}s`;
        }

        const expiryColor = msToExpiry < 300000 ? 'red' : msToExpiry < 900000 ? 'yellow' : 'green';
        lines.push(`Time until expiry: {${expiryColor}-fg}${expiryStr}{/${expiryColor}-fg}`);

        // URL (может быть длинным, разбиваем если нужно)
        const url = `https://polymarket.com/event/${market.slug}`;
        if (url.length > 68) {
            // Разбиваем URL на строки по 68 символов
            for (let i = 0; i < url.length; i += 68) {
                const urlPart = url.substring(i, i + 68);
                lines.push(`{blue-fg}${urlPart}{/blue-fg}`);
            }
        } else {
            lines.push(`{blue-fg}${url}{/blue-fg}`);
        }
    } else {
        lines.push('{red-fg}No market selected{/red-fg}');
    }

    lines.push('');
    lines.push('{gray-fg}' + '─'.repeat(68) + '{/gray-fg}');
    lines.push('');

    // Connection & Mode
    const uptime = Math.floor((Date.now() - STATE.stats.startTime) / 1000);
    lines.push(`WS: ${STATE.wsConnected ? '{green-fg}CONNECTED{/green-fg}' : '{red-fg}DISCONNECTED{/red-fg}'} | Up: ${uptime}s`);

    // Mode with SAFE indicator
    let modeStr = '';
    if (CONFIG.SIMULATION_MODE) {
        modeStr = '{yellow-fg}SIMULATION{/yellow-fg}';
    } else {
        modeStr = '{green-fg}LIVE{/green-fg}';
        if (CONFIG.LIVE.SAFE_MODE) {
            modeStr += ' {cyan-fg}+ SAFE{/cyan-fg}';
        }
    }
    lines.push(`Mode: ${modeStr}`);

    // LIVE: Balance and paused status
    if (!CONFIG.SIMULATION_MODE) {
        const balanceStr = STATE.live.usdcBalance > 0 ? STATE.live.usdcBalance.toFixed(2) : 'Unknown';
        const balanceColor = STATE.live.usdcBalance < CONFIG.LIVE.MIN_USDC_BALANCE ? 'red' : 'green';
        lines.push(`Balance: {${balanceColor}-fg}${balanceStr} USDC{/${balanceColor}-fg}`);

        if (STATE.live.paused) {
            lines.push(`{red-fg}PAUSED: ${STATE.live.pauseReason || 'Unknown'}{/red-fg}`);
        }

        if (STATE.live.apiErrorStreak > 0) {
            lines.push(`{yellow-fg}API Errors: ${STATE.live.apiErrorStreak}/${CONFIG.LIVE.MAX_API_ERROR_STREAK}{/yellow-fg}`);
        }
    }

    // Warm-up status
    if (STATE.marketWarmup.active) {
        const warmupTime = ((Date.now() - STATE.marketWarmup.startTime) / 1000).toFixed(1);
        lines.push(`{yellow-fg}WARM-UP: ${warmupTime}s (waiting for data){/yellow-fg}`);
    }

    // Market scanner status
    const scannerStatus = STATE.marketScannerStatus === 'scanning' ? '{yellow-fg}Scanning...{/yellow-fg}' :
                         STATE.marketScannerStatus === 'completed' ? `{green-fg}${STATE.lastScanMarketsFound} markets{/green-fg}` :
                         '{gray-fg}Idle{/gray-fg}';
    lines.push(`Markets: ${scannerStatus}`);
    lines.push(`Updates: ${STATE.stats.orderbookUpdatesPerMinute}/min | Trades: ${STATE.stats.tradesPerMinute}/min`);
    lines.push('');

    // Inventory
    lines.push('{bold}INVENTORY:{/bold}');
    lines.push(`  YES: ${STATE.inventory.yesShares.toFixed(1)} shares`);
    lines.push(`  NO:  ${STATE.inventory.noShares.toFixed(1)} shares`);
    lines.push(`  Net: ${STATE.inventory.netPosition.toFixed(1)} (${((STATE.inventory.netPosition / CONFIG.RISK.MAX_NET_POSITION) * 100).toFixed(0)}%)`);

    // Cash: show USDC in LIVE, $ in SIM
    if (CONFIG.SIMULATION_MODE) {
        lines.push(`  Cash: $${STATE.inventory.cash.toFixed(2)}`);
    } else {
        const cashColor = STATE.inventory.cash < CONFIG.LIVE.MIN_USDC_BALANCE ? 'red' : 'white';
        lines.push(`  Cash: {${cashColor}-fg}${STATE.inventory.cash.toFixed(2)} USDC{/${cashColor}-fg}`);
    }

    lines.push(`  Hedge: ${(STATE.inventory.hedgeRatio * 100).toFixed(0)}%`);
    lines.push('');

    // PnL
    const totalPnL = STATE.inventory.unrealizedPnL + STATE.inventory.realizedPnL;
    const pnlColor = totalPnL >= 0 ? 'green' : 'red';
    lines.push('{bold}PNL:{/bold}');
    lines.push(`  Unrealized: $${STATE.inventory.unrealizedPnL.toFixed(2)}`);
    lines.push(`  Realized:   $${STATE.inventory.realizedPnL.toFixed(2)}`);
    lines.push(`  Total: {${pnlColor}-fg}$${totalPnL.toFixed(2)}{/${pnlColor}-fg}`);
    lines.push('');
    
    // PAYOFF (outcome-based risk)
    const worstColor = STATE.payoff.worstCasePnl < -0.01 ? 'red' : 'green';
    lines.push('{bold}PAYOFF (Worst-Case):{/bold}');
    lines.push(`  If YES: $${STATE.payoff.pnlIfYes.toFixed(2)}`);
    lines.push(`  If NO:  $${STATE.payoff.pnlIfNo.toFixed(2)}`);
    lines.push(`  Worst: {${worstColor}-fg}$${STATE.payoff.worstCasePnl.toFixed(2)}{/${worstColor}-fg}`);
    if (STATE.payoff.isLockedInLoss) {
        lines.push(`  {red-fg}⚠ LOCKED-IN LOSS{/red-fg}`);
    }
    lines.push('');

    // State Machine & Risk
    const modeColor = {
        'FLAT': 'green',
        'QUOTE': 'cyan',
        'UNWIND': 'yellow',
        'PANIC': 'red',
        'PAUSED': 'gray'
    };
    const currentModeColor = modeColor[STATE.riskStatus.mode] || 'white';
    lines.push(`{bold}STATE:{/bold} {${currentModeColor}-fg}${STATE.riskStatus.mode}{/${currentModeColor}-fg} (${STATE.riskStatus.stateReason})`);

    // Time in state
    const timeInState = ((Date.now() - STATE.riskStatus.stateEnterTime) / 1000).toFixed(0);
    lines.push(`  Time in state: ${timeInState}s`);

    // Urgency (if in UNWIND/PANIC)
    if (STATE.riskStatus.mode === 'UNWIND' || STATE.riskStatus.mode === 'PANIC') {
        const urgency = STATE.riskStatus.urgency * 100;
        const urgencyColor = urgency < 30 ? 'green' : urgency < 60 ? 'yellow' : 'red';
        lines.push(`  Urgency: {${urgencyColor}-fg}${urgency.toFixed(0)}%{/${urgencyColor}-fg}`);

        // Time in inventory debt
        if (STATE.riskStatus.inventoryDebtStartTime) {
            const debtTime = ((Date.now() - STATE.riskStatus.inventoryDebtStartTime) / 1000).toFixed(0);
            const maxTime = (STATE.riskStatus.maxTimeInInventory / 1000).toFixed(0);
            lines.push(`  Inventory debt: ${debtTime}s / ${maxTime}s`);
        }

        // Losses accepted
        if (STATE.riskStatus.totalLossesAccepted > 0) {
            lines.push(`  Losses accepted: $${STATE.riskStatus.totalLossesAccepted.toFixed(2)}`);
        }
    }

    // Risk status
    let riskIcon;
    if (STATE.riskStatus.status === 'SAFE') {
        riskIcon = icon('ok');
    } else if (STATE.riskStatus.status === 'WARNING') {
        riskIcon = icon('warn');
    } else {
        riskIcon = icon('alert');
    }
    const riskColor = STATE.riskStatus.status === 'SAFE' ? 'green' : STATE.riskStatus.status === 'WARNING' ? 'yellow' : 'red';
    lines.push(`{bold}RISK:{/bold} {${riskColor}-fg}${riskIcon} ${STATE.riskStatus.status}{/${riskColor}-fg}`);
    if (STATE.riskStatus.defensiveMode) lines.push(`  {yellow-fg}${icon('warn')} DEFENSIVE MODE{/yellow-fg}`);
    lines.push('');

    // Orders
    lines.push(`{bold}ORDERS:{/bold} ${STATE.orders.active.size} active`);
    lines.push(`  Placed: ${STATE.stats.ordersPlaced} | Canceled: ${STATE.stats.ordersCanceled}`);
    lines.push(`  Fills: ${STATE.stats.fills}`);
    lines.push('');

    // Fair Value
    lines.push('{bold}FAIR VALUE:{/bold}');
    lines.push(`  YES: ${STATE.fairValue.yes.final.toFixed(4)}`);
    lines.push(`  NO:  ${STATE.fairValue.no.final.toFixed(4)}`);
    lines.push(`  Sum mismatch: ${(STATE.fairValue.yesNoMismatch * 100).toFixed(2)}%`);
    lines.push('');

    // Trade Flow
    const flowColor = STATE.tradeFlow.type === 'INFORMED' ? 'yellow' : 'gray';
    lines.push(`{bold}FLOW:{/bold} {${flowColor}-fg}${STATE.tradeFlow.type}{/${flowColor}-fg} (${(STATE.tradeFlow.confidence * 100).toFixed(0)}%)`);

    return lines;
}

function buildLogsPanel() {
    const lines = [];

    SCREEN_BUFFERS.logs.forEach(entry => {
        const categoryColor = {
            'system': 'cyan',
            'oms': 'blue',
            'trade': 'green',
            'flow': 'magenta',
            'quote': 'yellow',
            'arb': 'red',
            'unwind': 'red',
            'error': 'red'
        };

        // Use icon() function for category display
        const categoryIcon = icon(entry.cat);
        const color = categoryColor[entry.cat] || 'white';

        // Format: [time] [ICON] message
        const line = `{gray-fg}[${entry.time}]{/gray-fg} {${color}-fg}[${categoryIcon}] ${entry.msg}{/${color}-fg}`;
        lines.push(line);
    });

    return lines;
}

function buildOrdersPanel() {
    const lines = [];

    // Active Orders Section
    lines.push('{bold}{green-fg}ACTIVE ORDERS:{/green-fg}{/bold}');

    const activeOrders = Array.from(STATE.orders.active.values());
    if (activeOrders.length === 0) {
        lines.push('{gray-fg}No active orders{/gray-fg}');
    } else {
        // Group by token
        const market = STATE.markets.get(STATE.selectedMarket);
        if (market) {
            const yesOrders = activeOrders.filter(o => o.tokenId === market.tokens.YES);
            const noOrders = activeOrders.filter(o => o.tokenId === market.tokens.NO);

            if (yesOrders.length > 0) {
                lines.push('{cyan-fg}YES:{/cyan-fg}');
                yesOrders.forEach(order => {
                    const sideColor = order.side === 'BUY' ? 'green' : 'red';
                    const priceStr = order.price.toFixed(4);
                    const sizeStr = order.size.toFixed(2);
                    const remaining = order.sizeRemaining ? order.sizeRemaining.toFixed(2) : sizeStr;
                    lines.push(`  {${sideColor}-fg}${order.side}{/${sideColor}-fg} ${remaining}@${priceStr}`);
                });
            }

            if (noOrders.length > 0) {
                lines.push('{magenta-fg}NO:{/magenta-fg}');
                noOrders.forEach(order => {
                    const sideColor = order.side === 'BUY' ? 'green' : 'red';
                    const priceStr = order.price.toFixed(4);
                    const sizeStr = order.size.toFixed(2);
                    const remaining = order.sizeRemaining ? order.sizeRemaining.toFixed(2) : sizeStr;
                    lines.push(`  {${sideColor}-fg}${order.side}{/${sideColor}-fg} ${remaining}@${priceStr}`);
                });
            }
        }
    }

    lines.push('');
    lines.push('{gray-fg}' + '─'.repeat(68) + '{/gray-fg}');
    lines.push('');

    // Fill History Section
    lines.push('{bold}{yellow-fg}FILL HISTORY:{/yellow-fg}{/bold}');

    if (SCREEN_BUFFERS.fillHistory.length === 0) {
        lines.push('{gray-fg}No fills yet{/gray-fg}');
    } else {
        // Show recent fills (NEWEST FIRST - already in correct order due to unshift)
        const recentFills = SCREEN_BUFFERS.fillHistory.slice(0, 20);
        recentFills.forEach(fill => {
            const timestamp = new Date(fill.timestamp).toISOString().split('T')[1].substring(0, 12);
            const sideColor = fill.side === 'BUY' ? 'green' : 'red';
            const tokenColor = fill.token === 'YES' ? 'cyan' : 'magenta';

            // CRITICAL: Price must ALWAYS be present
            const priceStr = fmt(fill.price, 4);
            const sizeStr = fmt(fill.size, 2);

            // Cash flow: BUY = spending money (negative, red), SELL = receiving money (positive, green)
            let cashFlowStr = '';
            if (fill.notional) {
                const cashFlow = fill.side === 'BUY' ? -fill.notional : fill.notional;
                const cashFlowColor = cashFlow >= 0 ? 'green' : 'red';
                cashFlowStr = `{${cashFlowColor}-fg}${cashFlow >= 0 ? '+' : ''}${fmt(cashFlow, 2)}{/${cashFlowColor}-fg}`;
            }

            // Inventory after fill
            const invStr = fill.inventoryAfter
                ? `${fill.token}=${fmt(fill.token === 'YES' ? fill.inventoryAfter.yes : fill.inventoryAfter.no, 1)}`
                : '';

            // PnL (only for SELL fills or if explicitly provided)
            let pnlStr = '';
            if (fill.pnl !== undefined && fill.pnl !== null && Number.isFinite(fill.pnl)) {
                const pnlColor = fill.pnl >= 0 ? 'green' : 'red';
                pnlStr = `{${pnlColor}-fg}pnl=${fill.pnl >= 0 ? '+' : ''}${fmt(fill.pnl, 2)}{/${pnlColor}-fg}`;
            }
            
            // Source indicator
            const sourceStr = fill.source === 'SYNTHETIC_FILL' ? '{yellow-fg}[SYN]{/yellow-fg}' :
                              fill.source === 'REAL_FILL' ? '{green-fg}[REAL]{/green-fg}' :
                              fill.source === 'SIMULATION_FILL' ? '{blue-fg}[SIM]{/blue-fg}' : '';

            lines.push(
                `{gray-fg}[${timestamp}]{/gray-fg} ${sourceStr} ` +
                `{${tokenColor}-fg}${fill.token}{/${tokenColor}-fg} ` +
                `{${sideColor}-fg}${fill.side}{/${sideColor}-fg} ` +
                `${sizeStr}@${priceStr} ` +
                `${cashFlowStr} ` +
                `{gray-fg}${invStr}{/gray-fg} ` +
                pnlStr
            );
        });
    }

    return lines;
}

function buildMainLoopPanel() {
    const lines = [];

    SCREEN_BUFFERS.mainLoopLogs.forEach(entry => {
        const line = `{gray-fg}[${entry.time}]{/gray-fg} ${entry.msg}`;
        lines.push(line);
    });

    return lines;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function fmt(x, d = 2) {
    /**
     * Safe number formatter - never crashes on undefined/NaN/Infinity
     * Returns 'N/A' for invalid numbers
     */
    return (typeof x === 'number' && Number.isFinite(x)) ? x.toFixed(d) : 'N/A';
}

function roundToTick(price) {
    return Math.round(price / CONFIG.QUOTING.PRICE_TICK) * CONFIG.QUOTING.PRICE_TICK;
}

function roundToLot(size) {
    return Math.round(size / CONFIG.QUOTING.SIZE_TICK) * CONFIG.QUOTING.SIZE_TICK;
}

function clampPrice(price) {
    return Math.max(CONFIG.QUOTING.MIN_PRICE, Math.min(CONFIG.QUOTING.MAX_PRICE, price));
}

function clampSize(size) {
    return Math.max(CONFIG.QUOTING.MIN_SIZE, size);
}

function ceilToSizeTick(size) {
    // Round up to nearest size tick
    return Math.ceil(size / CONFIG.QUOTING.SIZE_TICK) * CONFIG.QUOTING.SIZE_TICK;
}

function normalizeSizeWithConstraints(size, { minOrderSize, sizeTick }) {
    /**
     * Normalize size with market constraints
     * 1. Round to tick size
     * 2. If below minimum, bump up to minimum (respecting tick)
     * 3. Fix float precision issues
     */
    if (!Number.isFinite(size) || size <= 0) {
        return 0;
    }

    if (!Number.isFinite(minOrderSize) || !Number.isFinite(sizeTick)) {
        return size;
    }

    // Step 1: Round to tick
    let normalized = Math.round(size / sizeTick) * sizeTick;

    // Step 2: Bump up to minimum if needed
    if (normalized < minOrderSize) {
        normalized = Math.ceil(minOrderSize / sizeTick) * sizeTick;

        // Handle float precision: if still below, force to exact minimum
        if (normalized < minOrderSize) {
            normalized = minOrderSize;
        }
    }

    // Step 3: Fix float precision (round to 8 decimals)
    normalized = Math.round(normalized * 1e8) / 1e8;

    return normalized;
}

function isMarketableBuy(tokenId, price) {
    /**
     * Check if BUY order at given price is marketable (crosses spread)
     * Marketable BUY: price >= bestAsk (current offer)
     */
    if (!Number.isFinite(price) || price <= 0) {
        return false; // Invalid price
    }

    const orderbook = STATE.orderbooks.get(tokenId);
    if (!orderbook || !orderbook.asks || orderbook.asks.length === 0) {
        return false; // No orderbook data, assume not marketable
    }

    // Handle both array format [price, size] and object format {price, size}
    const bestAskLevel = orderbook.asks[0];
    const bestAsk = Array.isArray(bestAskLevel) ? bestAskLevel[0] : bestAskLevel?.price;

    if (!Number.isFinite(bestAsk)) {
        return false;
    }

    return price >= bestAsk;
}

function isMarketableSell(tokenId, price) {
    /**
     * Check if SELL order at given price is marketable (crosses spread)
     * Marketable SELL: price <= bestBid (current bid)
     */
    if (!Number.isFinite(price) || price <= 0) {
        return false;
    }

    const orderbook = STATE.orderbooks.get(tokenId);
    if (!orderbook || !orderbook.bids || orderbook.bids.length === 0) {
        return false;
    }

    // Handle both array format [price, size] and object format {price, size}
    const bestBidLevel = orderbook.bids[0];
    const bestBid = Array.isArray(bestBidLevel) ? bestBidLevel[0] : bestBidLevel?.price;

    if (!Number.isFinite(bestBid)) {
        return false;
    }

    return price <= bestBid;
}

function getTokenType(tokenId) {
    const market = STATE.markets.get(STATE.selectedMarket);
    if (!market) return 'UNKNOWN';
    if (tokenId === market.tokens.YES) return 'YES';
    if (tokenId === market.tokens.NO) return 'NO';
    return 'UNKNOWN';
}

// ============================================================================
// OMS (ORDER MANAGEMENT SYSTEM)
// ============================================================================

async function placeLimitOrder({ tokenId, side, price, size }) {
    /**
     * Place limit order with LIVE_SAFE enforcement
     * SIMULATION: log only
     * LIVE: real API call with safety limits
     */

    // Strict parameter validation
    if (!tokenId) {
        log(`⚠️  Invalid params: tokenId is missing`, 'oms', 'WARN');
        return { success: false, orderId: null, error: 'Invalid params: tokenId missing', isFatal: false };
    }

    const normalizedSide = (side || '').toUpperCase();
    if (normalizedSide !== 'BUY' && normalizedSide !== 'SELL') {
        log(`⚠️  Invalid params: side must be BUY or SELL, got ${side}`, 'oms', 'WARN');
        return { success: false, orderId: null, error: 'Invalid params: invalid side', isFatal: false };
    }

    if (!Number.isFinite(price) || price <= 0) {
        log(`⚠️  Invalid params: price must be finite positive number, got ${price}`, 'oms', 'WARN');
        return { success: false, orderId: null, error: 'Invalid params: invalid price', isFatal: false };
    }

    if (!Number.isFinite(size) || size <= 0) {
        log(`⚠️  Invalid params: size must be finite positive number, got ${size}`, 'oms', 'WARN');
        return { success: false, orderId: null, error: 'Invalid params: invalid size', isFatal: false };
    }

    const roundedPrice = clampPrice(roundToTick(price));
    let roundedSize = clampSize(roundToLot(size));

    // ========================================================================
    // UNIFIED SIZE NORMALIZATION with constraints
    // ========================================================================

    // Check if token is disabled due to repeated constraint errors
    if (!CONFIG.SIMULATION_MODE) {
        const disabledUntil = STATE.live.disabledTokens.get(tokenId);
        if (disabledUntil && Date.now() < disabledUntil) {
            const remainingMs = disabledUntil - Date.now();
            const remainingSec = Math.ceil(remainingMs / 1000);

            // Rate-limited logging (once per 30 seconds)
            const lastLog = STATE.live.lastConstraintLog.get(tokenId) || 0;
            if (Date.now() - lastLog > 30000) {
                log(`⏭️  Token disabled due to minSize constraints (${remainingSec}s remaining)`, 'oms', 'WARN');
                STATE.live.lastConstraintLog.set(tokenId, Date.now());
            }

            return { success: false, orderId: null, error: 'Token disabled due to constraint errors', isFatal: false };
        }
    }

    // Get market constraints (source of truth from orderbook updates or cache)
    const constraints = !CONFIG.SIMULATION_MODE
        ? await exchangeAdapter.getMarketConstraints(tokenId)
        : { minOrderSize: 5, sizeTick: 0.1 };

    const { minOrderSize, sizeTick } = constraints;

    // Step 1: SAFE_MODE pre-check (BEFORE any normalization)
    // Exit early if minOrderSize is incompatible with SAFE_MODE
    if (!CONFIG.SIMULATION_MODE && CONFIG.LIVE.SAFE_MODE) {
        if (minOrderSize > CONFIG.LIVE.MAX_SIZE_PER_ORDER) {
            // Rate-limited logging
            const lastLog = STATE.live.lastConstraintLog.get(tokenId) || 0;
            if (Date.now() - lastLog > 60000) {
                log(`⚠️  SAFE_MODE incompatible: minOrderSize=${fmt(minOrderSize, 2)} > MAX_SIZE_PER_ORDER=${CONFIG.LIVE.MAX_SIZE_PER_ORDER}`, 'oms', 'WARN');
                log(`   → Cannot trade this market in SAFE_MODE`, 'oms', 'WARN');
                STATE.live.lastConstraintLog.set(tokenId, Date.now());
            }
            return { success: false, orderId: null, error: 'Min size exceeds SAFE max', isFatal: false };
        }
    }

    // Step 2: Normalize size using unified utility
    roundedSize = normalizeSizeWithConstraints(roundedSize, { minOrderSize, sizeTick });

    let decision = (roundedSize > clampSize(roundToLot(size))) ? 'bumped' : 'ok';

    // Step 3: SAFE_MODE check after normalization
    if (!CONFIG.SIMULATION_MODE && CONFIG.LIVE.SAFE_MODE) {
        // Check if normalized size exceeds SAFE_MODE limit
        if (roundedSize > CONFIG.LIVE.MAX_SIZE_PER_ORDER) {
            // Rate-limited logging
            const lastLog = STATE.live.lastConstraintLog.get(tokenId) || 0;
            if (Date.now() - lastLog > 60000) {
                log(`⚠️  SAFE_MODE: Normalized size ${fmt(roundedSize, 2)} > MAX_SIZE_PER_ORDER=${CONFIG.LIVE.MAX_SIZE_PER_ORDER}`, 'oms', 'WARN');
                log(`   → Skipping order`, 'oms', 'WARN');
                STATE.live.lastConstraintLog.set(tokenId, Date.now());
            }
            return { success: false, orderId: null, error: 'Normalized size exceeds SAFE max', isFatal: false };
        }
    }

    // Step 4: Marketable BUY $1 minimum notional
    if (normalizedSide === 'BUY') {
        const marketable = isMarketableBuy(tokenId, roundedPrice);
        const notional = roundedPrice * roundedSize;
        const MIN_MARKETABLE_NOTIONAL = 1.0;

        if (marketable && notional < MIN_MARKETABLE_NOTIONAL) {
            const requiredSize = ceilToSizeTick(MIN_MARKETABLE_NOTIONAL / roundedPrice);

            // Check if required size is within limits
            if (!CONFIG.SIMULATION_MODE && CONFIG.LIVE.SAFE_MODE && requiredSize > CONFIG.LIVE.MAX_SIZE_PER_ORDER) {
                log(`⚠️  Marketable BUY requires ${fmt(requiredSize, 2)} for $1 min, exceeds SAFE_MODE limit`, 'oms', 'WARN');
                return { success: false, orderId: null, error: 'Marketable BUY min notional violation', isFatal: false };
            }

            roundedSize = requiredSize;
            decision = 'marketable_bumped';
        }
    }

    // Diagnostic log: Final decision (single consolidated log)
    log(`   📊 Size validation: token=${tokenId.slice(0, 8)} side=${normalizedSide} price=${fmt(roundedPrice, 4)}`, 'oms', 'DEBUG');
    log(`      requested=${fmt(size, 2)} → rounded=${fmt(roundedSize, 2)}`, 'oms', 'DEBUG');
    log(`      minOrderSize=${fmt(minOrderSize, 2)} sizeTick=${fmt(sizeTick, 2)} decision=${decision}`, 'oms', 'DEBUG');

    // ========================================================================
    // SAFE_MODE: Additional order and position limits
    // ========================================================================

    if (!CONFIG.SIMULATION_MODE && CONFIG.LIVE.SAFE_MODE) {
        // Check total active orders limit
        if (STATE.orders.active.size >= CONFIG.LIVE.MAX_ACTIVE_ORDERS_TOTAL) {
            log(`❌ SAFE_MODE: MAX_ACTIVE_ORDERS_TOTAL reached (${STATE.orders.active.size})`, 'oms', 'ERROR');
            return { success: false, orderId: null, error: 'Max active orders reached' };
        }

        // Check per-token-side limit
        const tokenOrders = STATE.orders.byToken.get(tokenId) || new Set();
        const sameSideCount = Array.from(tokenOrders).filter(oid => {
            const o = STATE.orders.active.get(oid);
            return o && o.side === normalizedSide;
        }).length;

        if (sameSideCount >= CONFIG.LIVE.MAX_ACTIVE_ORDERS_PER_TOKEN_SIDE) {
            log(`❌ SAFE_MODE: MAX per token+side reached (${sameSideCount})`, 'oms', 'ERROR');
            return { success: false, orderId: null, error: 'Max orders per side reached' };
        }

        // Check position limits
        const absNet = Math.abs(STATE.inventory.netPosition);
        const gross = STATE.inventory.grossPosition;

        if (absNet > CONFIG.LIVE.MAX_NET_SHARES || gross > CONFIG.LIVE.MAX_GROSS_SHARES) {
            log(`❌ SAFE_MODE: Position limits exceeded (net=${fmt(absNet, 2)}, gross=${fmt(gross, 2)})`, 'oms', 'ERROR');
            return { success: false, orderId: null, error: 'Position limits exceeded' };
        }
    }

    if (CONFIG.SIMULATION_MODE) {
        // Simulation: log but don't actually place
        const orderId = `SIM_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        log(`[SIM] Place order: ${getTokenType(tokenId)} ${normalizedSide} ${fmt(roundedSize, 2)} @ ${fmt(roundedPrice, 4)}`, 'oms');

        // Check available cash for BUY orders
        if (normalizedSide === 'BUY') {
            const orderCost = roundedPrice * roundedSize;
            const availableCash = STATE.inventory.cash - STATE.inventory.reservedCash;
            if (orderCost > availableCash) {
                log(`WARNING: Insufficient cash: need $${fmt(orderCost, 2)}, have $${fmt(availableCash, 2)}`, 'oms');
                return { success: false, orderId: null, error: 'Insufficient cash' };
            }
            // Reserve cash
            STATE.inventory.reservedCash += orderCost;
        }

        // Add to active orders (simulation tracking)
        STATE.orders.active.set(orderId, {
            orderId,
            tokenId,
            side: normalizedSide,
            price: roundedPrice,
            size: roundedSize,
            sizeRemaining: roundedSize,
            timestamp: Date.now(),
            status: 'active'
        });

        if (!STATE.orders.byToken.has(tokenId)) {
            STATE.orders.byToken.set(tokenId, new Set());
        }
        STATE.orders.byToken.get(tokenId).add(orderId);

        STATE.stats.ordersPlaced++;

        return { success: true, orderId, error: null };
    }

    // LIVE mode: use ExchangeAdapter
    try {
        if (!exchangeAdapter) {
            throw new Error('ExchangeAdapter not initialized');
        }

        // Check available cash for BUY orders BEFORE placing
        if (normalizedSide === 'BUY') {
            const orderCost = roundedPrice * roundedSize;
            const availableCash = STATE.inventory.cash - STATE.inventory.reservedCash;
            if (orderCost > availableCash) {
                log(`❌ Insufficient cash: need $${fmt(orderCost, 2)}, have $${fmt(availableCash, 2)}`, 'oms', 'ERROR');
                return { success: false, orderId: null, error: 'Insufficient cash' };
            }
        }

        // Check if order can be placed (balance/allowance)
        const canPlace = await exchangeAdapter.canPlaceOrder(tokenId, normalizedSide, roundedSize, roundedPrice);

        if (!canPlace.ok) {
            log(`⏭️  Skipping order: ${canPlace.reason}`, 'oms', 'WARN');
            return { success: false, orderId: null, error: canPlace.reason, isFatal: false };
        }

        log(`   ✓ Balance check passed: ${canPlace.reason}`, 'oms', 'DEBUG');

        const result = await exchangeAdapter.postOrder(tokenId, normalizedSide, roundedPrice, roundedSize);

        log(`✅ [LIVE] Order placed: ${getTokenType(tokenId)} ${normalizedSide} ${fmt(roundedSize, 2)} @ ${fmt(roundedPrice, 4)} | ID: ${result.orderId}`, 'oms', 'INFO');

        // Reserve cash for BUY orders
        if (normalizedSide === 'BUY') {
            const orderCost = roundedPrice * roundedSize;
            STATE.inventory.reservedCash += orderCost;
        }

        // Track in state
        STATE.orders.active.set(result.orderId, {
            orderId: result.orderId,
            tokenId,
            side: normalizedSide,
            price: roundedPrice,
            size: roundedSize,
            sizeRemaining: roundedSize,
            timestamp: Date.now(),
            status: 'active'
        });

        if (!STATE.orders.byToken.has(tokenId)) {
            STATE.orders.byToken.set(tokenId, new Set());
        }
        STATE.orders.byToken.get(tokenId).add(result.orderId);

        STATE.stats.ordersPlaced++;
        STATE.live.apiErrorStreak = 0;  // Reset error streak on success

        return { success: true, orderId: result.orderId, error: null };

    } catch (error) {
        log(`❌ [LIVE] Failed to place order: ${error.message}`, 'oms', 'ERROR');

        // Check if this is a non-fatal constraint error
        const errorMsg = error.message || error.toString();
        const isBalanceError = errorMsg.includes('not enough balance') ||
                              errorMsg.includes('not enough') ||
                              errorMsg.includes('allowance') ||
                              errorMsg.includes('Insufficient');

        const isMarketableError = errorMsg.includes('invalid amount for a marketable') ||
                                 errorMsg.includes('min size: $');

        const isNonFatal = error.isFatal === false ||
                          error.code === 'SIZE_TOO_SMALL' ||
                          error.code === 'MARKET_CONSTRAINT' ||
                          error.code === 'INSUFFICIENT_BALANCE' ||
                          error.code === 'MARKETABLE_MIN_NOTIONAL' ||
                          isBalanceError ||
                          isMarketableError;

        if (!isNonFatal) {
            // Only increment error streak for real API/system errors
            STATE.live.apiErrorStreak++;
            STATE.live.lastApiError = error.message;
            STATE.live.lastApiErrorTime = Date.now();

            // Check error streak threshold
            if (STATE.live.apiErrorStreak >= CONFIG.LIVE.MAX_API_ERROR_STREAK) {
                log(`🚨 API ERROR STREAK = ${STATE.live.apiErrorStreak}, PAUSING BOT`, 'oms', 'ERROR');
                STATE.live.paused = true;
                STATE.live.pauseReason = `API errors: ${STATE.live.apiErrorStreak}`;
                STATE.riskStatus.mode = 'PAUSED';

                // Cancel all orders
                await cancelAll();
            }
        } else {
            log(`ℹ️  Non-fatal constraint error, not counting toward error streak`, 'oms', 'INFO');
        }

        return { success: false, orderId: null, error: error.message };
    }
}

async function cancelOrder(orderId) {
    /**
     * Cancel single order
     */

    if (STATE.orders.pendingCancels.has(orderId)) {
        return { success: false, error: 'Already canceling' };
    }

    STATE.orders.pendingCancels.add(orderId);

    try {
        if (CONFIG.SIMULATION_MODE) {
            // Simulation: immediate removal
            log(`NOTE: [SIM] Cancel order: ${orderId}`, 'oms');

            removeOrderFromState(orderId);
            STATE.stats.ordersCanceled++;

            return { success: true, error: null };
        }

        // LIVE mode: use ExchangeAdapter
        if (!exchangeAdapter) {
            throw new Error('ExchangeAdapter not initialized');
        }

        await exchangeAdapter.cancelOrder(orderId);

        log(`✅ [LIVE] Order canceled: ${orderId}`, 'oms', 'INFO');

        removeOrderFromState(orderId);
        STATE.stats.ordersCanceled++;
        STATE.live.apiErrorStreak = 0;  // Reset on success

        return { success: true, error: null };

    } catch (error) {
        log(`❌ [LIVE] Failed to cancel order ${orderId}: ${error.message}`, 'oms', 'ERROR');

        STATE.live.apiErrorStreak++;
        STATE.live.lastApiError = error.message;
        STATE.live.lastApiErrorTime = Date.now();

        return { success: false, error: error.message };
    } finally {
        STATE.orders.pendingCancels.delete(orderId);
    }
}

function removeOrderFromState(orderId) {
    const order = STATE.orders.active.get(orderId);
    if (order) {
        // Release reserved cash for BUY orders
        if (order.side === 'BUY' && order.sizeRemaining > 0) {
            const reservedAmount = order.price * order.sizeRemaining;
            STATE.inventory.reservedCash = Math.max(0, STATE.inventory.reservedCash - reservedAmount);
        }

        STATE.orders.active.delete(orderId);

        const tokenSet = STATE.orders.byToken.get(order.tokenId);
        if (tokenSet) {
            tokenSet.delete(orderId);
        }
    }

    // Remove from pending cancels
    STATE.orders.pendingCancels.delete(orderId);
}


async function cancelAllForToken(tokenId) {
    /**
     * Cancel all orders for a specific token
     */

    const orderIds = Array.from(STATE.orders.byToken.get(tokenId) || []);

    if (orderIds.length === 0) return;

    log(`DELETE: Canceling ${orderIds.length} orders for ${getTokenType(tokenId)}`, 'oms');

    const results = await Promise.all(
        orderIds.map(orderId => cancelOrder(orderId))
    );

    const successCount = results.filter(r => r.success).length;
    log(`SUCCESS: Canceled ${successCount}/${orderIds.length} orders`, 'oms');
}

// Cancel only one side (BUY or SELL) for a given tokenId
async function cancelSideForToken(tokenId, side) {
    const orderIds = Array.from(STATE.orders.byToken.get(tokenId) || []);
    if (orderIds.length === 0) return;
    const toCancel = orderIds.map((id) => STATE.orders.active.get(id)).filter((o) => o && o.side === side).map((o) => o.orderId);
    if (toCancel.length === 0) return;
    log(`DELETE Canceling ${toCancel.length} ${side} orders for ${getTokenType(tokenId)}`, "oms");
    const results = await Promise.all(toCancel.map((orderId) => cancelOrder(orderId)));
    const successCount = results.filter((r) => r.success).length;
    log(`SUCCESS Canceled ${successCount}/${toCancel.length} ${side} orders`, "oms");
}

async function cancelAll() {
    /**
     * Cancel all active orders
     */

    const orderIds = Array.from(STATE.orders.active.keys());

    if (orderIds.length === 0) return;

    log(`DELETE: Canceling ALL ${orderIds.length} orders`, 'oms');

    const results = await Promise.all(
        orderIds.map(orderId => cancelOrder(orderId))
    );

    const successCount = results.filter(r => r.success).length;
    log(`SUCCESS: Canceled ${successCount}/${orderIds.length} orders`, 'oms');
}

async function replaceQuotesForToken(tokenId, desiredBid, desiredAsk, bidSize, askSize) {
    /**
     * Replace quotes for token with anti-flicker logic
     */
    log(`DEBUG: replaceQuotesForToken called - token=${getTokenType(tokenId)}, bid=${desiredBid}, ask=${desiredAsk}, bidSize=${bidSize}, askSize=${askSize}`, 'oms');

    // Check if token is disabled due to constraint errors
    if (!CONFIG.SIMULATION_MODE) {
        const disabledUntil = STATE.live.disabledTokens.get(tokenId);
        if (disabledUntil && Date.now() < disabledUntil) {
            const remainingMs = disabledUntil - Date.now();
            const remainingSec = Math.ceil(remainingMs / 1000);
            log(`⏭️  Token ${getTokenType(tokenId)} disabled due to minSize constraint (${remainingSec}s remaining)`, 'oms', 'DEBUG');
            return { success: false, reason: 'token_disabled' };
        }
    }

    // Anti-flicker check
    const lastTs = STATE.orders.lastReplaceTs.get(tokenId) || 0;
    const now = Date.now();

    if (now - lastTs < CONFIG.QUOTING.MIN_REPLACE_INTERVAL_MS) {
        // Too soon, skip
        return { success: false, reason: 'anti-flicker: too soon' };
    }

    // Get current active orders for this token
    const currentOrderIds = Array.from(STATE.orders.byToken.get(tokenId) || []);
    const currentOrders = currentOrderIds
        .map(id => STATE.orders.active.get(id))
        .filter(o => o); // filter out undefined

    // Separate bids and asks
    const currentBids = currentOrders.filter(o => o.side === 'BUY');
    const currentAsks = currentOrders.filter(o => o.side === 'SELL');

    // Check if we need to replace
    let needsReplace = false;

    // Check bid
    if (desiredBid !== null) {
        const existingBid = currentBids.find(o =>
            Math.abs(o.price - desiredBid) < CONFIG.QUOTING.MIN_PRICE_CHANGE_FOR_REPLACE &&
            Math.abs(o.size - bidSize) < CONFIG.QUOTING.SIZE_TICK
        );
        if (!existingBid) needsReplace = true;
    } else {
        if (currentBids.length > 0) needsReplace = true;
    }

    // Check ask
    if (desiredAsk !== null) {
        const existingAsk = currentAsks.find(o =>
            Math.abs(o.price - desiredAsk) < CONFIG.QUOTING.MIN_PRICE_CHANGE_FOR_REPLACE &&
            Math.abs(o.size - askSize) < CONFIG.QUOTING.SIZE_TICK
        );
        if (!existingAsk) needsReplace = true;
    } else {
        if (currentAsks.length > 0) needsReplace = true;
    }

    if (!needsReplace) {
        return { success: true, reason: 'quotes already match' };
    }

    // Cancel existing orders
    await cancelAllForToken(tokenId);

    // Place new orders
    const actions = [];

    if (desiredBid !== null && bidSize > 0) {
        const result = await placeLimitOrder({
            tokenId,
            side: 'BUY',
            price: desiredBid,
            size: bidSize
        });
        log(`DEBUG: BID order result - success=${result.success}, orderId=${result.orderId}`, 'oms');
        actions.push({ type: 'bid', result });
    }

    if (desiredAsk !== null && askSize > 0) {
        const result = await placeLimitOrder({
            tokenId,
            side: 'SELL',
            price: desiredAsk,
            size: askSize
        });
        log(`DEBUG: ASK order result - success=${result.success}, orderId=${result.orderId}`, 'oms');
        actions.push({ type: 'ask', result });
    }

    // Update last replace timestamp
    STATE.orders.lastReplaceTs.set(tokenId, now);

    return { success: true, actions };
}

async function reconcileOpenOrders() {
    /**
     * REAL reconciliation: fetch actual orders from exchange
     * Compare with local state, fix any desync
     */

    if (CONFIG.SIMULATION_MODE) {
        // Simulation: no real exchange orders to reconcile
        STATE.orders.lastSyncTs = Date.now();
        return;
    }

    if (!exchangeAdapter) {
        log('⚠️  reconcileOpenOrders: ExchangeAdapter not initialized', 'oms', 'WARN');
        return;
    }

    try {
        STATE.orders.lastSyncTs = Date.now();

        const exchangeOrders = await exchangeAdapter.getOpenOrders();
        const exchangeOrderIds = new Set(exchangeOrders.map(o => o.orderId));
        const localOrderIds = new Set(STATE.orders.active.keys());

        // Find missing orders (in local but not on exchange)
        const missingOrders = [];
        for (const localId of localOrderIds) {
            if (!exchangeOrderIds.has(localId)) {
                missingOrders.push(localId);
            }
        }

        // Find extra orders (on exchange but not in local)
        const extraOrders = exchangeOrders.filter(o => !localOrderIds.has(o.orderId));

        // Log desync
        if (missingOrders.length > 0 || extraOrders.length > 0) {
            log(`⚠️  DESYNC FOUND: ${missingOrders.length} missing, ${extraOrders.length} extra`, 'oms', 'WARN');

            logEvent('DESYNC_FOUND', {
                missing: missingOrders.length,
                extra: extraOrders.length,
                missingIds: missingOrders,
                extraIds: extraOrders.map(o => o.orderId)
            });
        }

        // Remove missing orders from local state
        for (const orderId of missingOrders) {
            log(`🔄 Reconcile: Removing stale order ${orderId}`, 'oms', 'INFO');
            removeOrderFromState(orderId);
        }

        // Add extra orders to local state
        for (const order of extraOrders) {
            log(`🔄 Reconcile: Adding unknown order ${order.orderId}`, 'oms', 'INFO');

            STATE.orders.active.set(order.orderId, {
                orderId: order.orderId,
                tokenId: order.tokenId,
                side: order.side,
                price: order.price,
                size: order.size,
                sizeRemaining: order.sizeRemaining,
                timestamp: order.timestamp,
                status: order.status
            });

            if (!STATE.orders.byToken.has(order.tokenId)) {
                STATE.orders.byToken.set(order.tokenId, new Set());
            }
            STATE.orders.byToken.get(order.tokenId).add(order.orderId);

            // Reserve cash for BUY orders
            if (order.side === 'BUY' && order.sizeRemaining > 0) {
                STATE.inventory.reservedCash += order.price * order.sizeRemaining;
            }
        }

        // Update sizes for existing orders
        for (const exchangeOrder of exchangeOrders) {
            if (localOrderIds.has(exchangeOrder.orderId)) {
                const localOrder = STATE.orders.active.get(exchangeOrder.orderId);
                const oldRemaining = localOrder.sizeRemaining;
                const newRemaining = exchangeOrder.sizeRemaining;

                if (Math.abs(oldRemaining - newRemaining) > 0.01) {
                    log(`🔄 Reconcile: Order ${exchangeOrder.orderId} size ${oldRemaining} → ${newRemaining}`, 'oms', 'DEBUG');

                    localOrder.sizeRemaining = newRemaining;

                    // Adjust reserved cash for BUY orders
                    if (localOrder.side === 'BUY') {
                        const oldReserved = localOrder.price * oldRemaining;
                        const newReserved = localOrder.price * newRemaining;
                        STATE.inventory.reservedCash += (newReserved - oldReserved);
                    }
                }
            }
        }

        // Recalculate total reserved cash from scratch (safety check)
        let totalReserved = 0;
        for (const order of STATE.orders.active.values()) {
            if (order.side === 'BUY' && order.sizeRemaining > 0) {
                totalReserved += order.price * order.sizeRemaining;
            }
        }

        if (Math.abs(STATE.inventory.reservedCash - totalReserved) > 0.1) {
            log(`⚠️  reservedCash desync: ${STATE.inventory.reservedCash.toFixed(2)} → ${totalReserved.toFixed(2)}`, 'oms', 'WARN');
            STATE.inventory.reservedCash = totalReserved;
        }

        if (missingOrders.length > 0 || extraOrders.length > 0) {
            logEvent('DESYNC_FIXED', {
                removedCount: missingOrders.length,
                addedCount: extraOrders.length,
                reservedCash: STATE.inventory.reservedCash
            });
        }

    } catch (err) {
        log(`❌ reconcileOpenOrders failed: ${err.message}`, 'oms', 'ERROR');

        STATE.live.apiErrorStreak++;
        STATE.live.lastApiError = err.message;
        STATE.live.lastApiErrorTime = Date.now();
    }
}

// ============================================================================
// LOT-BASED ACCOUNTING HELPERS
// ============================================================================

/**
 * Create a position lot when buying shares
 * @param {string} side - 'YES' or 'NO'
 * @param {number} shares - Number of shares
 * @param {number} probabilityEntry - Entry probability (0-1)
 * @param {string} fillId - Fill identifier
 * @returns {Object} PositionLot
 */
function createPositionLot(side, shares, probabilityEntry, fillId) {
    const usdPricePerShare = probabilityEntry;  // In Polymarket, USD price = probability
    const costUsd = shares * usdPricePerShare;
    const expectedPayoutUsd = shares * 1.0;  // Each share pays $1 if outcome wins
    const expectedPnlUsd = expectedPayoutUsd - costUsd;

    return {
        lotId: `${side}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        side,
        shares,
        probabilityEntry,
        usdPricePerShare,
        costUsd,
        expectedPayoutUsd,
        expectedPnlUsd,
        timestamp: Date.now(),
        fillId
    };
}

/**
 * Add a lot to position tracking (on BUY)
 * @param {string} side - 'YES' or 'NO'
 * @param {number} shares - Number of shares
 * @param {number} probabilityEntry - Entry probability (0-1)
 * @param {string} fillId - Fill identifier
 */
function addLot(side, shares, probabilityEntry, fillId) {
    const lot = createPositionLot(side, shares, probabilityEntry, fillId);
    const lotsArray = side === 'YES' ? STATE.lots.yes : STATE.lots.no;
    lotsArray.push(lot);

    log(
        `📊 LOT CREATED: ${side} | shares=${shares.toFixed(2)} | ` +
        `prob=${probabilityEntry.toFixed(4)} | usd=${lot.usdPricePerShare.toFixed(4)} | ` +
        `cost=$${lot.costUsd.toFixed(2)} | expected_payout=$${lot.expectedPayoutUsd.toFixed(2)} | ` +
        `expected_pnl=${lot.expectedPnlUsd >= 0 ? '+' : ''}$${lot.expectedPnlUsd.toFixed(2)}`,
        'accounting',
        'DEBUG'
    );
}

/**
 * Remove lots FIFO when selling shares
 * @param {string} side - 'YES' or 'NO'
 * @param {number} sharesToSell - Number of shares to sell
 * @param {number} sellProbability - Sell probability (0-1)
 * @returns {Object} { realizedPnl, lots: [...removed lots] }
 */
function removeLotsFIFO(side, sharesToSell, sellProbability) {
    const lotsArray = side === 'YES' ? STATE.lots.yes : STATE.lots.no;
    const usdPricePerShare = sellProbability;
    let remainingShares = sharesToSell;
    let totalRealizedPnl = 0;
    const removedLots = [];

    while (remainingShares > 0.001 && lotsArray.length > 0) {
        const lot = lotsArray[0];  // FIFO: take oldest lot

        if (lot.shares <= remainingShares) {
            // Consume entire lot
            const proceeds = lot.shares * usdPricePerShare;
            const realizedPnl = proceeds - lot.costUsd;
            totalRealizedPnl += realizedPnl;
            remainingShares -= lot.shares;
            removedLots.push(lotsArray.shift());

            log(
                `📊 LOT CLOSED (full): ${side} | shares=${lot.shares.toFixed(2)} | ` +
                `entry_prob=${lot.probabilityEntry.toFixed(4)} | exit_prob=${sellProbability.toFixed(4)} | ` +
                `cost=$${lot.costUsd.toFixed(2)} | proceeds=$${proceeds.toFixed(2)} | ` +
                `realized_pnl=${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)}`,
                'accounting',
                'DEBUG'
            );
        } else {
            // Partial lot consumption
            const sharesToTake = remainingShares;
            const fraction = sharesToTake / lot.shares;
            const partialCost = lot.costUsd * fraction;
            const proceeds = sharesToTake * usdPricePerShare;
            const realizedPnl = proceeds - partialCost;
            totalRealizedPnl += realizedPnl;

            // Update lot with remaining shares
            lot.shares -= sharesToTake;
            lot.costUsd -= partialCost;
            lot.expectedPayoutUsd = lot.shares * 1.0;
            lot.expectedPnlUsd = lot.expectedPayoutUsd - lot.costUsd;

            log(
                `📊 LOT CLOSED (partial): ${side} | shares_sold=${sharesToTake.toFixed(2)} | ` +
                `shares_remaining=${lot.shares.toFixed(2)} | ` +
                `entry_prob=${lot.probabilityEntry.toFixed(4)} | exit_prob=${sellProbability.toFixed(4)} | ` +
                `cost=$${partialCost.toFixed(2)} | proceeds=$${proceeds.toFixed(2)} | ` +
                `realized_pnl=${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(2)}`,
                'accounting',
                'DEBUG'
            );

            remainingShares = 0;
        }
    }

    return {
        realizedPnl: totalRealizedPnl,
        lots: removedLots
    };
}

/**
 * Get summary of all lots for a side
 * @param {string} side - 'YES' or 'NO'
 * @returns {Object} { totalShares, totalCostUsd, avgEntryProbability }
 */
function getLotsSummary(side) {
    const lotsArray = side === 'YES' ? STATE.lots.yes : STATE.lots.no;

    if (lotsArray.length === 0) {
        return { totalShares: 0, totalCostUsd: 0, avgEntryProbability: 0 };
    }

    const totalShares = lotsArray.reduce((sum, lot) => sum + lot.shares, 0);
    const totalCostUsd = lotsArray.reduce((sum, lot) => sum + lot.costUsd, 0);
    const avgEntryProbability = totalShares > 0 ? totalCostUsd / totalShares : 0;

    return { totalShares, totalCostUsd, avgEntryProbability };
}

/**
 * CRITICAL: Validate accounting consistency
 * Ensures lot-based accounting matches inventory shares and cost basis
 */
function assertAccountingConsistency() {
    const yesSummary = getLotsSummary('YES');
    const noSummary = getLotsSummary('NO');

    const errors = [];

    // Check YES shares match
    const yesSharesDiff = Math.abs(STATE.inventory.yesShares - yesSummary.totalShares);
    if (yesSharesDiff > 0.01) {
        errors.push(`🚨 YES shares mismatch: inventory=${STATE.inventory.yesShares.toFixed(2)} vs lots=${yesSummary.totalShares.toFixed(2)}`);
    }

    // Check NO shares match
    const noSharesDiff = Math.abs(STATE.inventory.noShares - noSummary.totalShares);
    if (noSharesDiff > 0.01) {
        errors.push(`🚨 NO shares mismatch: inventory=${STATE.inventory.noShares.toFixed(2)} vs lots=${noSummary.totalShares.toFixed(2)}`);
    }

    // Check cost basis match
    const yesCostBasisDiff = Math.abs(STATE.inventory.costBasis.yes - yesSummary.avgEntryProbability);
    if (STATE.inventory.yesShares > 0.01 && yesCostBasisDiff > 0.001) {
        errors.push(`🚨 YES cost basis mismatch: inventory=${STATE.inventory.costBasis.yes.toFixed(4)} vs lots=${yesSummary.avgEntryProbability.toFixed(4)}`);
    }

    const noCostBasisDiff = Math.abs(STATE.inventory.costBasis.no - noSummary.avgEntryProbability);
    if (STATE.inventory.noShares > 0.01 && noCostBasisDiff > 0.001) {
        errors.push(`🚨 NO cost basis mismatch: inventory=${STATE.inventory.costBasis.no.toFixed(4)} vs lots=${noSummary.avgEntryProbability.toFixed(4)}`);
    }

    // Check for zero shares but non-zero cost
    if (STATE.inventory.yesShares <= 0.01 && STATE.inventory.costBasis.yes > 0.001) {
        errors.push(`🚨 YES has zero shares but non-zero cost basis: ${STATE.inventory.costBasis.yes.toFixed(4)}`);
    }

    if (STATE.inventory.noShares <= 0.01 && STATE.inventory.costBasis.no > 0.001) {
        errors.push(`🚨 NO has zero shares but non-zero cost basis: ${STATE.inventory.costBasis.no.toFixed(4)}`);
    }

    if (errors.length > 0) {
        log('🚨 ACCOUNTING DESYNC DETECTED:', 'accounting', 'ERROR');
        errors.forEach(err => log(`   ${err}`, 'accounting', 'ERROR'));
        log(`   YES lots: ${STATE.lots.yes.length} | NO lots: ${STATE.lots.no.length}`, 'accounting', 'ERROR');
        return false;
    }

    return true;
}

// ============================================================================
// USER EVENT HANDLERS (FILLS AND ORDER UPDATES)
// ============================================================================

function handleFill(fill) {
    /**
     * Process fill event from exchange
     * Update position, cost basis, realized PnL, reserved cash
     */

    try {
        log(`💰 FILL: ${JSON.stringify(fill)}`, 'oms', 'INFO');

        // Parse fill data (structure depends on API)
        const orderId = fill.orderID || fill.orderId || fill.id;
        const side = (fill.side || '').toLowerCase();
        const price = parseFloat(fill.price);
        const size = parseFloat(fill.size || fill.amount);
        const tokenId = fill.tokenID || fill.asset_id;

        if (!orderId || !side || !price || !size) {
            log(`⚠️  Invalid fill data: ${JSON.stringify(fill)}`, 'oms', 'WARN');
            return;
        }

        // Update position using LOT-BASED ACCOUNTING
        const tokenType = getTokenType(tokenId);
        const probabilityPrice = price;  // In Polymarket, price IS the probability (0-1)
        const usdPricePerShare = probabilityPrice;
        const costUsd = size * usdPricePerShare;
        const expectedPayoutUsd = size * 1.0;  // Each share pays $1 if outcome wins

        if (side === 'buy') {
            // BUY: Create new position lot, increase shares, update cost basis
            addLot(tokenType, size, probabilityPrice, orderId);

            if (tokenType === 'YES') {
                STATE.inventory.yesShares += size;
                STATE.inventory.costBasis.yes =
                    ((STATE.inventory.costBasis.yes * (STATE.inventory.yesShares - size)) + (price * size)) / STATE.inventory.yesShares;
            } else {
                STATE.inventory.noShares += size;
                STATE.inventory.costBasis.no =
                    ((STATE.inventory.costBasis.no * (STATE.inventory.noShares - size)) + (price * size)) / STATE.inventory.noShares;
            }

            // CRITICAL FIX: Update cash in BOTH simulation AND live modes
            // We track local cash for PnL calculations; API reconciliation happens separately
            STATE.inventory.cash -= costUsd;

            log(`   💸 Cash: $${(STATE.inventory.cash + costUsd).toFixed(2)} → $${STATE.inventory.cash.toFixed(2)} (-$${costUsd.toFixed(2)})`, 'accounting', 'DEBUG');

        } else if (side === 'sell') {
            // SELL: Remove lots FIFO, decrease shares, realize PnL
            const { realizedPnl } = removeLotsFIFO(tokenType, size, probabilityPrice);
            STATE.inventory.realizedPnL += realizedPnl;

            if (tokenType === 'YES') {
                STATE.inventory.yesShares -= size;
                if (STATE.inventory.yesShares <= 0.01) {
                    STATE.inventory.yesShares = 0;
                    STATE.inventory.costBasis.yes = 0;
                    STATE.lots.yes = [];  // Clear any remaining lots
                }
            } else {
                STATE.inventory.noShares -= size;
                if (STATE.inventory.noShares <= 0.01) {
                    STATE.inventory.noShares = 0;
                    STATE.inventory.costBasis.no = 0;
                    STATE.lots.no = [];  // Clear any remaining lots
                }
            }

            // CRITICAL FIX: Update cash in BOTH simulation AND live modes
            const proceeds = probabilityPrice * size;
            STATE.inventory.cash += proceeds;

            log(`   💸 Cash: $${(STATE.inventory.cash - proceeds).toFixed(2)} → $${STATE.inventory.cash.toFixed(2)} (+$${proceeds.toFixed(2)})`, 'accounting', 'DEBUG');
        }

        // Update sizeRemaining in order state
        const order = STATE.orders.active.get(orderId);
        if (order) {
            order.sizeRemaining = Math.max(0, order.sizeRemaining - size);

            // Release reserved cash for filled portion of BUY order
            if (order.side === 'BUY') {
                const releasedAmount = order.price * size;
                STATE.inventory.reservedCash = Math.max(0, STATE.inventory.reservedCash - releasedAmount);
            }

            // Remove order if fully filled
            if (order.sizeRemaining < 0.01) {
                removeOrderFromState(orderId);
            }
        }

        // Update position metrics
        updatePositionMetrics();

        // Update payoff engine (CRITICAL: must run after every position change)
        updatePayoffEngine();

        // CRITICAL: Validate accounting consistency after fill
        assertAccountingConsistency();

        // Add to fill history (NEWEST FIRST)
        const notional = price * size;
        const inventoryAfter = {
            yes: STATE.inventory.yesShares,
            no: STATE.inventory.noShares
        };
        
        // Calculate realized PnL if SELL
        let fillPnL = null;
        if (side === 'sell') {
            const costBasis = tokenType === 'YES' ? STATE.inventory.costBasis.yes : STATE.inventory.costBasis.no;
            fillPnL = (price - costBasis) * size;
        }
        
        const fillRecord = {
            timestamp: Date.now(),
            token: tokenType,
            side: side.toUpperCase(),
            size: size,
            price: price,
            notional: notional,
            pnl: fillPnL,
            inventoryAfter: inventoryAfter,
            source: 'REAL_FILL',
            synthetic: false,
            orderId: orderId
        };
        
        SCREEN_BUFFERS.fillHistory.unshift(fillRecord);
        if (SCREEN_BUFFERS.fillHistory.length > MAX_FILL_HISTORY) {
            SCREEN_BUFFERS.fillHistory.pop();
        }
        
        // Enhanced logging with 4 PRICE LEVELS (CRITICAL FORMAT)
        const invStr = `inv.${tokenType}=${(tokenType === 'YES' ? inventoryAfter.yes : inventoryAfter.no).toFixed(1)}`;

        if (side === 'buy') {
            // BUY: Show cost breakdown
            log(
                `${icon('money')} REAL_FILL: ${tokenType} BUY ${size.toFixed(2)}`,
                'oms'
            );
            log(
                `   prob=${probabilityPrice.toFixed(4)} | ` +
                `usd=${usdPricePerShare.toFixed(4)} | ` +
                `cost=$${costUsd.toFixed(2)} | ` +
                `payout_if_win=$${expectedPayoutUsd.toFixed(2)} | ` +
                `expected_pnl=+$${(expectedPayoutUsd - costUsd).toFixed(2)} | ` +
                `${invStr}`,
                'oms'
            );
        } else {
            // SELL: Show proceeds and realized PnL
            const proceeds = probabilityPrice * size;
            const pnlStr = fillPnL ? `${fillPnL >= 0 ? '+' : ''}$${fillPnL.toFixed(2)}` : 'N/A';
            log(
                `${icon('money')} REAL_FILL: ${tokenType} SELL ${size.toFixed(2)}`,
                'oms'
            );
            log(
                `   prob=${probabilityPrice.toFixed(4)} | ` +
                `usd=${usdPricePerShare.toFixed(4)} | ` +
                `proceeds=$${proceeds.toFixed(2)} | ` +
                `realized_pnl=${pnlStr} | ` +
                `${invStr}`,
                'oms'
            );
        }

        // Log to file
        logFill({
            timestamp: new Date().toISOString(),
            orderId,
            tokenId,
            tokenType,
            side,
            price,
            size,
            cash: STATE.inventory.cash,
            position: {
                yes: STATE.inventory.yesShares,
                no: STATE.inventory.noShares,
                net: STATE.inventory.netPosition
            },
            realizedPnL: STATE.inventory.realizedPnL
        });

        STATE.stats.fills++;

    } catch (err) {
        log(`❌ handleFill error: ${err.message}`, 'oms', 'ERROR');
    }
}

function handleOrderUpdate(update) {
    /**
     * Process order update event from exchange
     * Handle: CANCELED, FILLED, REJECTED, etc.
     */

    try {
        log(`📝 ORDER UPDATE: ${JSON.stringify(update)}`, 'oms', 'DEBUG');

        const orderId = update.orderID || update.orderId || update.id;
        const status = (update.status || '').toLowerCase();
        const sizeRemaining = parseFloat(update.size || update.sizeRemaining || 0);

        if (!orderId) {
            return;
        }

        const order = STATE.orders.active.get(orderId);
        if (!order) {
            // Unknown order, might be from previous session
            log(`⚠️  Order update for unknown order: ${orderId}`, 'oms', 'WARN');
            return;
        }

        // Update size remaining
        if (sizeRemaining !== order.sizeRemaining && !isNaN(sizeRemaining)) {
            const oldRemaining = order.sizeRemaining;
            order.sizeRemaining = sizeRemaining;

            // Adjust reserved cash for BUY orders
            if (order.side === 'BUY') {
                const oldReserved = order.price * oldRemaining;
                const newReserved = order.price * sizeRemaining;
                STATE.inventory.reservedCash += (newReserved - oldReserved);
            }
        }

        // Handle terminal statuses
        if (status === 'canceled' || status === 'cancelled' || status === 'filled' || status === 'rejected') {
            log(`📌 Order ${orderId} ${status}`, 'oms', 'INFO');

            // Release remaining reserved cash for BUY orders
            if (order.side === 'BUY' && order.sizeRemaining > 0) {
                const remainingReserved = order.price * order.sizeRemaining;
                STATE.inventory.reservedCash = Math.max(0, STATE.inventory.reservedCash - remainingReserved);
            }

            removeOrderFromState(orderId);
        }

    } catch (err) {
        log(`❌ handleOrderUpdate error: ${err.message}`, 'oms', 'ERROR');
    }
}

// ============================================================================
// SAFETY CHECKS AND INVARIANTS
// ============================================================================

function assertInvariants() {
    /**
     * Safety checks for LIVE mode
     * Run periodically in main loop to catch violations
     */

    if (CONFIG.SIMULATION_MODE) return;
    if (!CONFIG.LIVE.SAFE_MODE) return;

    let violations = [];

    // Check 1: Max active orders
    if (STATE.orders.active.size > CONFIG.LIVE.MAX_ACTIVE_ORDERS_TOTAL) {
        violations.push(`Active orders (${STATE.orders.active.size}) > MAX_ACTIVE_ORDERS_TOTAL (${CONFIG.LIVE.MAX_ACTIVE_ORDERS_TOTAL})`);
    }

    // Check 2: Per-token-side limits
    for (const [tokenId, orderIds] of STATE.orders.byToken) {
        let buys = 0, sells = 0;
        for (const orderId of orderIds) {
            const order = STATE.orders.active.get(orderId);
            if (!order) continue;
            if (order.side === 'BUY') buys++;
            else if (order.side === 'SELL') sells++;
        }

        if (buys > CONFIG.LIVE.MAX_ACTIVE_ORDERS_PER_TOKEN_SIDE) {
            violations.push(`Token ${getTokenType(tokenId)} has ${buys} BUY orders > limit (${CONFIG.LIVE.MAX_ACTIVE_ORDERS_PER_TOKEN_SIDE})`);
        }
        if (sells > CONFIG.LIVE.MAX_ACTIVE_ORDERS_PER_TOKEN_SIDE) {
            violations.push(`Token ${getTokenType(tokenId)} has ${sells} SELL orders > limit (${CONFIG.LIVE.MAX_ACTIVE_ORDERS_PER_TOKEN_SIDE})`);
        }
    }

    // Check 3: Reserved cash non-negative
    if (STATE.inventory.reservedCash < 0) {
        violations.push(`reservedCash is negative: ${STATE.inventory.reservedCash.toFixed(2)}`);
    }

    // Check 4: Position limits
    const absNet = Math.abs(STATE.inventory.netPosition);
    const gross = STATE.inventory.grossPosition;

    if (absNet > CONFIG.LIVE.MAX_NET_SHARES) {
        violations.push(`Net position (${absNet.toFixed(2)}) > MAX_NET_SHARES (${CONFIG.LIVE.MAX_NET_SHARES})`);
    }

    if (gross > CONFIG.LIVE.MAX_GROSS_SHARES) {
        violations.push(`Gross position (${gross.toFixed(2)}) > MAX_GROSS_SHARES (${CONFIG.LIVE.MAX_GROSS_SHARES})`);
    }

    // Check 5: UNWIND/PANIC mode should not have risk-increasing orders
    const mode = STATE.riskStatus.mode;
    if (mode === 'UNWIND' || mode === 'PANIC') {
        const netPos = STATE.inventory.netPosition;
        for (const order of STATE.orders.active.values()) {
            // If net > 0 (long YES), should only have SELL YES or BUY NO
            // If net < 0 (short YES/long NO), should only have BUY YES or SELL NO
            const tokenType = getTokenType(order.tokenId);
            const increasesRisk = (netPos > 0 && order.side === 'BUY' && tokenType === 'YES') ||
                                   (netPos > 0 && order.side === 'SELL' && tokenType === 'NO') ||
                                   (netPos < 0 && order.side === 'SELL' && tokenType === 'YES') ||
                                   (netPos < 0 && order.side === 'BUY' && tokenType === 'NO');

            if (increasesRisk) {
                violations.push(`${mode} mode but order ${order.orderId} increases risk (net=${netPos.toFixed(2)}, ${tokenType} ${order.side})`);
            }
        }
    }

    // If violations found: LOG ERROR + PAUSE + CANCEL ALL
    if (violations.length > 0) {
        log(`🚨 INVARIANT VIOLATIONS DETECTED:`, 'oms', 'ERROR');
        for (const v of violations) {
            log(`   - ${v}`, 'oms', 'ERROR');
        }

        logEvent('INVARIANT_VIOLATION', {
            violations,
            activeOrders: STATE.orders.active.size,
            position: {
                net: STATE.inventory.netPosition,
                gross: STATE.inventory.grossPosition
            },
            mode: STATE.riskStatus.mode
        });

        STATE.live.paused = true;
        STATE.live.pauseReason = `Invariant violations: ${violations.length}`;
        STATE.riskStatus.mode = 'PAUSED';

        cancelAll();
    }
}

async function checkBalance() {
    /**
     * Periodic balance check for LIVE mode
     * Pause if balance too low
     */

    if (CONFIG.SIMULATION_MODE) return;
    if (!exchangeAdapter) return;

    const now = Date.now();
    if (now - STATE.live.lastBalanceCheck < CONFIG.LIVE.BALANCE_CHECK_INTERVAL_MS) {
        return;
    }

    STATE.live.lastBalanceCheck = now;

    try {
        const balance = await exchangeAdapter.getBalance();
        STATE.live.usdcBalance = balance;

        // CRITICAL FIX: Calculate INITIAL_CASH as total portfolio value
        // INITIAL_CASH = USDC balance + value of existing shares
        if (!STATE.live.initialCashSet) {
            const market = STATE.markets.get(STATE.selectedMarket);
            let yesSharesValue = 0;
            let noSharesValue = 0;

            if (market) {
                const yesOrderbook = STATE.orderbooks.get(market.tokens.YES);
                const noOrderbook = STATE.orderbooks.get(market.tokens.NO);

                // Calculate current market value of existing shares
                if (STATE.inventory.yesShares > 0.1 && yesOrderbook?.mid) {
                    yesSharesValue = STATE.inventory.yesShares * yesOrderbook.mid;
                    // If no cost basis set, use current mid as entry price
                    if (STATE.inventory.costBasis.yes === 0) {
                        STATE.inventory.costBasis.yes = yesOrderbook.mid;
                        log(`   Set YES cost basis to current mid: ${yesOrderbook.mid.toFixed(4)}`, 'oms', 'INFO');
                        // Create initial lots for existing shares
                        addLot('YES', STATE.inventory.yesShares, yesOrderbook.mid, 'INITIAL_POSITION');
                    }
                }

                if (STATE.inventory.noShares > 0.1 && noOrderbook?.mid) {
                    noSharesValue = STATE.inventory.noShares * noOrderbook.mid;
                    // If no cost basis set, use current mid as entry price
                    if (STATE.inventory.costBasis.no === 0) {
                        STATE.inventory.costBasis.no = noOrderbook.mid;
                        log(`   Set NO cost basis to current mid: ${noOrderbook.mid.toFixed(4)}`, 'oms', 'INFO');
                        // Create initial lots for existing shares
                        addLot('NO', STATE.inventory.noShares, noOrderbook.mid, 'INITIAL_POSITION');
                    }
                }
            }

            const totalSharesValue = yesSharesValue + noSharesValue;

            // CRITICAL: INITIAL_CASH = total portfolio value (cash + shares)
            const totalPortfolioValue = balance + totalSharesValue;
            CONFIG.RISK.INITIAL_CASH = totalPortfolioValue;

            // Set local cash to actual USDC balance
            STATE.inventory.cash = balance;

            log(`🔧 First balance check: INITIAL_CASH calibrated`, 'oms', 'INFO');
            log(`   USDC balance: $${balance.toFixed(2)}`, 'oms', 'INFO');
            log(`   YES shares: ${STATE.inventory.yesShares.toFixed(1)} × $${(yesSharesValue / Math.max(STATE.inventory.yesShares, 0.1)).toFixed(4)} = $${yesSharesValue.toFixed(2)}`, 'oms', 'INFO');
            log(`   NO shares: ${STATE.inventory.noShares.toFixed(1)} × $${(noSharesValue / Math.max(STATE.inventory.noShares, 0.1)).toFixed(4)} = $${noSharesValue.toFixed(2)}`, 'oms', 'INFO');
            log(`   Total shares value: $${totalSharesValue.toFixed(2)}`, 'oms', 'INFO');
            log(`   📊 INITIAL_CASH (total portfolio): $${CONFIG.RISK.INITIAL_CASH.toFixed(2)}`, 'oms', 'INFO');

            STATE.live.initialCashSet = true;
        }

        // CRITICAL FIX: DO NOT overwrite STATE.inventory.cash in subsequent checks
        // Local cash tracking is used for PnL; only reconcile if major discrepancy
        const cashDiscrepancy = Math.abs(STATE.inventory.cash - balance);
        if (cashDiscrepancy > 1.0) {
            log(`⚠️  Cash discrepancy detected: local=$${STATE.inventory.cash.toFixed(2)} vs API=$${balance.toFixed(2)} (diff=$${cashDiscrepancy.toFixed(2)})`, 'accounting', 'WARN');
            // Only log warning, don't overwrite - reconciliation will handle this
        }

        log(`💵 Balance: ${balance.toFixed(2)} USDC`, 'oms', 'INFO');

        if (balance < CONFIG.LIVE.MIN_USDC_BALANCE) {
            log(`🚨 Balance too low: ${balance.toFixed(2)} < ${CONFIG.LIVE.MIN_USDC_BALANCE}`, 'oms', 'ERROR');

            STATE.live.paused = true;
            STATE.live.pauseReason = `Low balance: ${balance.toFixed(2)} USDC`;
            STATE.riskStatus.mode = 'PAUSED';

            await cancelAll();
        }

    } catch (err) {
        log(`⚠️  checkBalance failed: ${err.message}`, 'oms', 'WARN');
    }
}

async function reconcileAccounting() {
    /**
     * CRITICAL: Periodic reconciliation between bot's accounting and actual API balances
     *
     * Purpose:
     * - Detect discrepancies between local STATE and exchange reality
     * - Correct cash tracking errors from missed fills or API issues
     * - Validate lot-based accounting consistency
     * - Log any synthetic fills or corrections
     *
     * Called every 5-10 minutes in main loop
     */

    if (CONFIG.SIMULATION_MODE) return; // Only for LIVE mode
    if (!exchangeAdapter) return;

    const now = Date.now();
    const RECONCILE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

    // Check if enough time has passed
    if (!STATE.live.lastReconcileTime) {
        STATE.live.lastReconcileTime = now;
        return;
    }

    if (now - STATE.live.lastReconcileTime < RECONCILE_INTERVAL_MS) {
        return;
    }

    STATE.live.lastReconcileTime = now;

    const market = STATE.markets.get(STATE.selectedMarket);
    if (!market) return;

    try {
        log(`🔄 RECONCILE: Starting accounting reconciliation...`, 'accounting', 'INFO');

        // Fetch real balances from API
        const realUSDC = await exchangeAdapter.getBalance();
        const realYesShares = await exchangeAdapter.getOutcomeBalance(market.tokens.YES);
        const realNoShares = await exchangeAdapter.getOutcomeBalance(market.tokens.NO);

        // Compare with local state
        const TOLERANCE = 0.05; // 5 cents or 0.05 shares
        const cashDiff = Math.abs(STATE.inventory.cash - realUSDC);
        const yesDiff = Math.abs(STATE.inventory.yesShares - realYesShares);
        const noDiff = Math.abs(STATE.inventory.noShares - realNoShares);

        const hasDiscrepancy = cashDiff > TOLERANCE || yesDiff > TOLERANCE || noDiff > TOLERANCE;

        if (hasDiscrepancy) {
            log(`🚨 RECONCILE: Discrepancies detected!`, 'accounting', 'ERROR');
            log(`   USDC: local=$${STATE.inventory.cash.toFixed(2)} api=$${realUSDC.toFixed(2)} diff=$${cashDiff.toFixed(2)}`, 'accounting', 'ERROR');
            log(`   YES: local=${STATE.inventory.yesShares.toFixed(2)} api=${realYesShares.toFixed(2)} diff=${yesDiff.toFixed(2)}`, 'accounting', 'ERROR');
            log(`   NO: local=${STATE.inventory.noShares.toFixed(2)} api=${realNoShares.toFixed(2)} diff=${noDiff.toFixed(2)}`, 'accounting', 'ERROR');

            // Log current lot-based accounting state
            const yesSummary = getLotsSummary('YES');
            const noSummary = getLotsSummary('NO');
            log(`   Lot accounting: YES ${yesSummary.totalShares.toFixed(2)} shares ($${yesSummary.totalCostUsd.toFixed(2)} cost)`, 'accounting', 'ERROR');
            log(`   Lot accounting: NO ${noSummary.totalShares.toFixed(2)} shares ($${noSummary.totalCostUsd.toFixed(2)} cost)`, 'accounting', 'ERROR');

            // Correct cash (critical for PnL)
            if (cashDiff > TOLERANCE) {
                const oldCash = STATE.inventory.cash;
                STATE.inventory.cash = realUSDC;
                log(`   ✅ Corrected cash: $${oldCash.toFixed(2)} → $${realUSDC.toFixed(2)}`, 'accounting', 'INFO');
            }

            // Correct shares and trigger synthetic fills via existing reconciliation
            if (yesDiff > TOLERANCE || noDiff > TOLERANCE) {
                log(`   🔄 Triggering position reconciliation for shares...`, 'accounting', 'INFO');
                // This will create synthetic fills and update lots
                await reconcilePositionsFromChainOrApi();
            }

            // Re-validate accounting consistency
            log(`   🔍 Validating accounting consistency after corrections...`, 'accounting', 'INFO');
            const isConsistent = assertAccountingConsistency();
            if (!isConsistent) {
                log(`   🚨 CRITICAL: Accounting still inconsistent after reconciliation!`, 'accounting', 'ERROR');
            } else {
                log(`   ✅ Accounting consistency validated`, 'accounting', 'INFO');
            }

        } else {
            log(`✅ RECONCILE: All balances match (within ${TOLERANCE.toFixed(2)} tolerance)`, 'accounting', 'DEBUG');
            log(`   USDC: $${realUSDC.toFixed(2)} | YES: ${realYesShares.toFixed(2)} | NO: ${realNoShares.toFixed(2)}`, 'accounting', 'DEBUG');

            // Still validate lot consistency even if balances match
            assertAccountingConsistency();
        }

        // Log portfolio summary
        const yesOrderbook = STATE.orderbooks.get(market.tokens.YES);
        const noOrderbook = STATE.orderbooks.get(market.tokens.NO);
        const yesValue = realYesShares * (yesOrderbook?.mid || 0);
        const noValue = realNoShares * (noOrderbook?.mid || 0);
        const totalPortfolioValue = realUSDC + yesValue + noValue;
        const totalPnL = totalPortfolioValue - CONFIG.RISK.INITIAL_CASH;

        log(`📊 RECONCILE: Portfolio Summary`, 'accounting', 'INFO');
        log(`   Cash: $${realUSDC.toFixed(2)}`, 'accounting', 'INFO');
        log(`   YES: ${realYesShares.toFixed(2)} shares × $${(yesOrderbook?.mid || 0).toFixed(4)} = $${yesValue.toFixed(2)}`, 'accounting', 'INFO');
        log(`   NO: ${realNoShares.toFixed(2)} shares × $${(noOrderbook?.mid || 0).toFixed(4)} = $${noValue.toFixed(2)}`, 'accounting', 'INFO');
        log(`   Total: $${totalPortfolioValue.toFixed(2)} | PnL: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}`, 'accounting', 'INFO');
        log(`   Initial: $${CONFIG.RISK.INITIAL_CASH.toFixed(2)} | Realized: $${STATE.inventory.realizedPnL.toFixed(2)}`, 'accounting', 'INFO');

    } catch (err) {
        log(`⚠️  RECONCILE failed: ${err.message}`, 'accounting', 'ERROR');
        log(`   Stack: ${err.stack}`, 'accounting', 'DEBUG');
    }
}

// ============================================================================
// PRICE CORRECTION ENGINE (ACTUAL VS LIMIT PRICES)
// ============================================================================

async function reconcileActualFillsWithApi() {
    /**
     * CRITICAL: Reconcile actual execution prices with limit order prices
     *
     * Problem:
     * - Bot tracks limit order prices (order.price)
     * - CLOB executes at BEST AVAILABLE prices in the book
     * - Result: PnL miscalculation (often 5-10% off)
     *
     * Example:
     * - Limit: BUY 10 @ 0.12 = expect to pay $1.20
     * - Actual: Executed @ 0.11 = actually paid $1.10
     * - Error: $0.10 (9%) untracked savings!
     *
     * Solution:
     * 1. Fetch actual fills from CLOB API
     * 2. Compare executed vs limit prices
     * 3. Create correction fills to adjust accounting
     */

    if (CONFIG.SIMULATION_MODE) return;
    if (!exchangeAdapter) return;

    const market = STATE.markets.get(STATE.selectedMarket);
    if (!market) return;

    try {
        log(`🔄 PRICE RECONCILE: Starting actual vs limit price check...`, 'accounting', 'INFO');

        // Step 1: Get actual fills from CLOB API
        const yesActualFills = await exchangeAdapter.getFillHistory(market.tokens.YES, 50);
        const noActualFills = await exchangeAdapter.getFillHistory(market.tokens.NO, 50);
        const allActualFills = [...yesActualFills, ...noActualFills];

        if (allActualFills.length === 0) {
            log(`   No actual fills found in CLOB history`, 'accounting', 'DEBUG');
            return;
        }

        // Step 2: Map local fills by orderId
        const localFillsByOrderId = new Map();
        SCREEN_BUFFERS.fillHistory.forEach(fill => {
            if (fill.orderId && fill.source !== 'PRICE_CORRECTION') {
                localFillsByOrderId.set(fill.orderId, fill);
            }
        });

        // Step 3: Find price discrepancies
        let correctionsMade = 0;
        for (const actualFill of allActualFills) {
            const localFill = localFillsByOrderId.get(actualFill.orderId);

            if (!localFill) {
                // Missing fill - may be from previous session, skip
                continue;
            }

            // Compare prices
            const priceDiff = actualFill.executedPrice - localFill.price;
            const absPriceDiff = Math.abs(priceDiff);

            // Threshold: >0.01% price difference AND >$0.01 notional difference
            if (absPriceDiff > 0.0001) {
                const size = actualFill.size;
                const localNotional = localFill.price * size;
                const actualNotional = actualFill.executedPrice * size;
                const notionalDiff = actualNotional - localNotional;

                if (Math.abs(notionalDiff) > 0.01) {
                    const diffPercent = (absPriceDiff / localFill.price) * 100;

                    log(`💰 PRICE MISMATCH DETECTED:`, 'accounting', 'WARN');
                    log(`   Order: ${actualFill.orderId} (${actualFill.side.toUpperCase()})`, 'accounting', 'WARN');
                    log(`   Limit: ${localFill.price.toFixed(4)} × ${size.toFixed(2)} = $${localNotional.toFixed(2)}`, 'accounting', 'WARN');
                    log(`   Actual: ${actualFill.executedPrice.toFixed(4)} × ${size.toFixed(2)} = $${actualNotional.toFixed(2)}`, 'accounting', 'WARN');
                    log(`   Diff: $${notionalDiff.toFixed(2)} (${diffPercent.toFixed(2)}%)`, 'accounting', 'WARN');

                    // Step 4: Create correction fill
                    createPriceCorrectionFill({
                        orderId: actualFill.orderId,
                        tokenId: actualFill.tokenId,
                        side: actualFill.side,
                        limitPrice: localFill.price,
                        executedPrice: actualFill.executedPrice,
                        size: size,
                        notionalDiff: notionalDiff,
                        timestamp: actualFill.timestamp
                    });

                    correctionsMade++;
                }
            }
        }

        if (correctionsMade > 0) {
            log(`✅ PRICE RECONCILE: Applied ${correctionsMade} price corrections`, 'accounting', 'INFO');

            // Recalculate metrics
            updatePositionMetrics();
            updatePayoffEngine();
            assertAccountingConsistency();
        } else {
            log(`✅ PRICE RECONCILE: All fill prices match (within tolerance)`, 'accounting', 'DEBUG');
        }

    } catch (err) {
        log(`⚠️  PRICE RECONCILE failed: ${err.message}`, 'accounting', 'ERROR');
        log(`   Stack: ${err.stack}`, 'accounting', 'DEBUG');
    }
}

function createPriceCorrectionFill(correctionData) {
    /**
     * Create corrective synthetic fill to adjust for price difference
     *
     * For BUY:  Actual < Limit → saved money → adjust cost basis down
     * For SELL: Actual > Limit → made more money → adjust realized PnL up
     */

    const {
        orderId,
        tokenId,
        side,
        limitPrice,
        executedPrice,
        size,
        notionalDiff,
        timestamp
    } = correctionData;

    const tokenType = getTokenType(tokenId);

    // Determine correction type
    let correctionType;
    if (side === 'buy' && executedPrice < limitPrice) {
        correctionType = 'BETTER_BUY';  // Got better price on buy
    } else if (side === 'sell' && executedPrice > limitPrice) {
        correctionType = 'BETTER_SELL'; // Got better price on sell
    } else {
        correctionType = 'WORSE_EXECUTION'; // Executed worse than limit
    }

    // Create correction fill record
    const correctionFill = {
        timestamp: timestamp || Date.now(),
        token: tokenType,
        side: side.toUpperCase(),
        size: size,
        price: executedPrice,  // Show actual executed price
        notional: executedPrice * size,
        pnl: side === 'sell' ? notionalDiff : 0,
        inventoryAfter: {
            yes: STATE.inventory.yesShares,
            no: STATE.inventory.noShares
        },
        source: 'PRICE_CORRECTION',
        synthetic: true,
        orderId: orderId,
        correctionType: correctionType,
        limitPrice: limitPrice,
        priceDiff: executedPrice - limitPrice,
        notionalDiff: notionalDiff
    };

    // Add to fill history
    SCREEN_BUFFERS.fillHistory.unshift(correctionFill);
    if (SCREEN_BUFFERS.fillHistory.length > MAX_FILL_HISTORY) {
        SCREEN_BUFFERS.fillHistory.pop();
    }

    // Apply correction to accounting
    if (Math.abs(notionalDiff) > 0.001) {
        if (side === 'buy') {
            // BUY correction: Adjust cost basis and cash
            // If we paid LESS than expected, we have MORE cash
            STATE.inventory.cash -= notionalDiff; // Negative diff = add cash

            if (tokenType === 'YES' && STATE.inventory.yesShares > 0.001) {
                const oldTotalCost = STATE.inventory.costBasis.yes * STATE.inventory.yesShares;
                const correctedTotalCost = oldTotalCost + notionalDiff;
                STATE.inventory.costBasis.yes = correctedTotalCost / STATE.inventory.yesShares;
            } else if (tokenType === 'NO' && STATE.inventory.noShares > 0.001) {
                const oldTotalCost = STATE.inventory.costBasis.no * STATE.inventory.noShares;
                const correctedTotalCost = oldTotalCost + notionalDiff;
                STATE.inventory.costBasis.no = correctedTotalCost / STATE.inventory.noShares;
            }

            log(`📊 PRICE CORRECTION: ${correctionType}`, 'accounting', 'INFO');
            log(`   ${tokenType} BUY: limit=${limitPrice.toFixed(4)} → actual=${executedPrice.toFixed(4)}`, 'accounting', 'INFO');
            log(`   Saved: $${Math.abs(notionalDiff).toFixed(2)} | Action: Adjusted cost basis`, 'accounting', 'INFO');

        } else if (side === 'sell') {
            // SELL correction: Adjust realized PnL and cash
            STATE.inventory.realizedPnL += notionalDiff;
            STATE.inventory.cash += notionalDiff;

            log(`📊 PRICE CORRECTION: ${correctionType}`, 'accounting', 'INFO');
            log(`   ${tokenType} SELL: limit=${limitPrice.toFixed(4)} → actual=${executedPrice.toFixed(4)}`, 'accounting', 'INFO');
            log(`   Extra PnL: ${notionalDiff >= 0 ? '+' : ''}$${notionalDiff.toFixed(2)} | Action: Adjusted realized PnL`, 'accounting', 'INFO');
        }
    }
}

// ============================================================================
// INVENTORY SNAPSHOT (UNIFIED ENTRY POINT)
// ============================================================================

function computeExposureSnapshot() {
    /**
     * Single source of truth for inventory/exposure
     * Returns unified snapshot object
     */

    const market = STATE.markets.get(STATE.selectedMarket);
    if (!market) {
        if (CONFIG.SIMULATION_MODE) {
            log('DEBUG: computeExposureSnapshot: No market selected', 'system');
        }
        return null;
    }

    const yesBook = STATE.orderbooks.get(market.tokens.YES);
    const noBook = STATE.orderbooks.get(market.tokens.NO);

    if (!yesBook || !noBook) {
        if (CONFIG.SIMULATION_MODE) {
            log(`DEBUG: computeExposureSnapshot: Missing orderbooks (YES=${!!yesBook}, NO=${!!noBook})`, 'system');
        }
        return null;
    }

    const yesShares = STATE.inventory.yesShares;
    const noShares = STATE.inventory.noShares;
    const netShares = yesShares - noShares;
    const grossShares = yesShares + noShares;

    const pYesMid = yesBook.mid;
    const pNoMid = noBook.mid;

    // Calculate microprice (volume-weighted bid/ask)
    // microprice = (bid*askSize + ask*bidSize) / (bidSize + askSize)
    const yesBid = yesBook.bids[0]?.price || pYesMid;
    const yesAsk = yesBook.asks[0]?.price || pYesMid;
    const yesBidSize = yesBook.bids[0]?.size || 0;
    const yesAskSize = yesBook.asks[0]?.size || 0;
    const yesTotalSize = yesBidSize + yesAskSize;
    const pYesMicro = yesTotalSize > 0
        ? (yesBid * yesAskSize + yesAsk * yesBidSize) / yesTotalSize
        : pYesMid;

    const noBid = noBook.bids[0]?.price || pNoMid;
    const noAsk = noBook.asks[0]?.price || pNoMid;
    const noBidSize = noBook.bids[0]?.size || 0;
    const noAskSize = noBook.asks[0]?.size || 0;
    const noTotalSize = noBidSize + noAskSize;
    const pNoMicro = noTotalSize > 0
        ? (noBid * noAskSize + noAsk * noBidSize) / noTotalSize
        : pNoMid;

    const netNotional = yesShares * pYesMid - noShares * pNoMid;

    const inventoryUtilizationNet = Math.abs(netShares) / CONFIG.RISK.MAX_NET_POSITION;
    const inventoryUtilizationGross = grossShares / CONFIG.RISK.MAX_GROSS_POSITION;

    const msToExpiry = Math.max(0, new Date(market.endDate) - Date.now());
    const timeToExpiryMinutes = msToExpiry / (1000 * 60);
    const hoursToExpiry = timeToExpiryMinutes / 60;

    // Calculate urgency (0 = no urgency, 1 = critical urgency)
    let urgency = 0;
    if (timeToExpiryMinutes <= CONFIG.RISK.UNWIND_TRIGGER_TIME_MIN) {
        urgency = 1.0;
    } else if (hoursToExpiry < CONFIG.RISK.URGENCY_THRESHOLD_HOURS) {
        // Linear interpolation from threshold to unwind time
        const hoursRange = CONFIG.RISK.URGENCY_THRESHOLD_HOURS - (CONFIG.RISK.UNWIND_TRIGGER_TIME_MIN / 60);
        urgency = Math.min(1.0, (CONFIG.RISK.URGENCY_THRESHOLD_HOURS - hoursToExpiry) / hoursRange);
    }

    return {
        yesShares,
        noShares,
        netShares,
        grossShares,
        pYesMid,
        pYesMicro,
        pNoMid,
        pNoMicro,
        netNotional,
        inventoryUtilizationNet,
        inventoryUtilizationGross,
        timeToExpiryMinutes,
        hoursToExpiry,
        msToExpiry,
        urgency  // 0..1, increases as expiry approaches
    };
}

// ============================================================================
// FAIR VALUE CALCULATION (YES/NO PAIR)
// ============================================================================

function calculateFairValue(snapshot) {
    if (!snapshot) return;

    const pYesMid = snapshot.pYesMid;
    const pYesMicro = snapshot.pYesMicro;
    const pNoMid = snapshot.pNoMid;
    const pNoMicro = snapshot.pNoMicro;

    // ========================================================================
    // INDEPENDENT YES FAIR VALUE
    // ========================================================================
    // YES fair = weighted average of mid, microprice, EMA
    const fairYesRaw =
        CONFIG.FAIR_VALUE.W_MID * pYesMid +
        CONFIG.FAIR_VALUE.W_MICROPRICE * pYesMicro +
        CONFIG.FAIR_VALUE.W_EMA * STATE.fairValue.yes.ema;

    // EMA smoothing for YES
    if (STATE.fairValue.yes.ema === 0.5) {
        STATE.fairValue.yes.ema = fairYesRaw;
    } else {
        STATE.fairValue.yes.ema =
            CONFIG.FAIR_VALUE.EMA_ALPHA * fairYesRaw +
            (1 - CONFIG.FAIR_VALUE.EMA_ALPHA) * STATE.fairValue.yes.ema;
    }

    STATE.fairValue.yes.mid = pYesMid;
    STATE.fairValue.yes.final = fairYesRaw;

    // ========================================================================
    // INDEPENDENT NO FAIR VALUE
    // ========================================================================
    // NO fair = weighted average of mid, microprice, EMA
    const fairNoRaw =
        CONFIG.FAIR_VALUE.W_MID * pNoMid +
        CONFIG.FAIR_VALUE.W_MICROPRICE * pNoMicro +
        CONFIG.FAIR_VALUE.W_EMA * STATE.fairValue.no.ema;

    // EMA smoothing for NO
    if (STATE.fairValue.no.ema === 0.5) {
        STATE.fairValue.no.ema = fairNoRaw;
    } else {
        STATE.fairValue.no.ema =
            CONFIG.FAIR_VALUE.EMA_ALPHA * fairNoRaw +
            (1 - CONFIG.FAIR_VALUE.EMA_ALPHA) * STATE.fairValue.no.ema;
    }

    STATE.fairValue.no.mid = pNoMid;
    STATE.fairValue.no.final = fairNoRaw;

    // ========================================================================
    // MISMATCH CHECK (YES + NO should ≈ 1, but NOT enforced)
    // ========================================================================
    // Mismatch is a PENALTY, not an equality constraint
    // YES and NO can be BOTH overvalued or undervalued simultaneously
    const yesNoSum = STATE.fairValue.yes.final + STATE.fairValue.no.final;
    const mismatch = Math.abs(yesNoSum - 1.0);
    STATE.fairValue.yesNoMismatch = mismatch;

    // Log warnings at different severity levels
    if (mismatch > CONFIG.FAIR_VALUE.MISMATCH_KILL) {
        log(`${icon('critical')} CRITICAL: YES+NO mismatch = ${(mismatch * 100).toFixed(2)}% (>${CONFIG.FAIR_VALUE.MISMATCH_KILL * 100}%) - STOP QUOTING`, 'fair');
    } else if (mismatch > CONFIG.FAIR_VALUE.MISMATCH_DANGER) {
        log(`${icon('warn')} DANGER: YES+NO mismatch = ${(mismatch * 100).toFixed(2)}% (>${CONFIG.FAIR_VALUE.MISMATCH_DANGER * 100}%) - penalties applied`, 'fair');
    } else if (mismatch > CONFIG.FAIR_VALUE.MISMATCH_WARN) {
        log(`${icon('warn')} Warning: YES+NO mismatch = ${(mismatch * 100).toFixed(2)}%`, 'fair');
    }
}

// ============================================================================
// YES/NO ARBITRAGE DETECTION
// ============================================================================

function checkYesNoArbitrage(snapshot) {
    if (!snapshot) return { hasArb: false, type: null, edge: 0 };

    const market = STATE.markets.get(STATE.selectedMarket);
    if (!market) return { hasArb: false, type: null, edge: 0 };

    const yesBook = STATE.orderbooks.get(market.tokens.YES);
    const noBook = STATE.orderbooks.get(market.tokens.NO);

    if (!yesBook || !noBook || !yesBook.bids[0] || !noBook.bids[0]) {
        return { hasArb: false, type: null, edge: 0 };
    }

    const yesBestBid = yesBook.bids[0].price;
    const yesBestAsk = yesBook.asks[0]?.price || 1;
    const noBestBid = noBook.bids[0].price;
    const noBestAsk = noBook.asks[0]?.price || 1;

    // Edge calculations
    const edgeSellBoth = (yesBestBid + noBestBid) - 1.0 - CONFIG.ARBITRAGE.FEE_ESTIMATE;
    const edgeBuyBoth = 1.0 - (yesBestAsk + noBestAsk) - CONFIG.ARBITRAGE.FEE_ESTIMATE;

    STATE.fairValue.pairEdge = { buyBoth: edgeBuyBoth, sellBoth: edgeSellBoth };

    // Check for arbitrage opportunities
    if (edgeBuyBoth > CONFIG.ARBITRAGE.MIN_EDGE_BUY_BOTH) {
        log(`ARB: ARB: Buy both YES+NO for ${(edgeBuyBoth * 100).toFixed(2)}% edge`, 'arb');
        return { hasArb: true, type: 'BUY_BOTH', edge: edgeBuyBoth };
    }
    if (edgeSellBoth > CONFIG.ARBITRAGE.MIN_EDGE_SELL_BOTH) {
        log(`ARB: ARB: Sell both YES+NO for ${(edgeSellBoth * 100).toFixed(2)}% edge`, 'arb');
        return { hasArb: true, type: 'SELL_BOTH', edge: edgeSellBoth };
    }

    return { hasArb: false, type: null, edge: 0 };
}

// ============================================================================
// NON-LINEAR INVENTORY SKEW
// ============================================================================

function calculateNonLinearInventorySkew(snapshot) {
    /**
     * PURE INVENTORY RISK CONTROL (no alpha/directional signal)
     * Goal: Reduce position risk by making it easier to exit
     */
    const netPosition = snapshot.netShares;
    const normalizedPosition = netPosition / CONFIG.RISK.MAX_NET_POSITION;

    // Base skew (exponential) - pure position risk
    const baseSkew = Math.sign(normalizedPosition) *
                     Math.pow(Math.abs(normalizedPosition), CONFIG.RISK.SKEW_EXPONENT) *
                     CONFIG.RISK.BASE_SKEW_FACTOR;

    // Time pressure - increase urgency to close as expiry approaches
    const hoursToExpiry = snapshot.hoursToExpiry;
    let timePressure = 1.0;
    if (hoursToExpiry < CONFIG.RISK.URGENCY_CRITICAL_HOURS) {
        timePressure = 5.0;
    } else if (hoursToExpiry < CONFIG.RISK.URGENCY_THRESHOLD_HOURS) {
        const ratio = 1 - (hoursToExpiry / CONFIG.RISK.URGENCY_THRESHOLD_HOURS);
        timePressure = 1.0 + ratio * 4.0;
    }

    // Loss pressure - increase urgency if losing money
    let lossPressure = 1.0;
    if (STATE.inventory.unrealizedPnL < 0) {
        const lossPct = Math.abs(STATE.inventory.unrealizedPnL) / CONFIG.RISK.INITIAL_CASH;
        if (lossPct > 0.05) lossPressure = 1.0 + lossPct * 2.0;
    }

    const finalSkew = baseSkew * timePressure * lossPressure;
    const cappedSkew = Math.max(-0.20, Math.min(0.20, finalSkew));

    return {
        skew: cappedSkew,
        components: { baseSkew, timePressure, lossPressure }
    };
}

function calculateAlphaSignal(snapshot) {
    /**
     * DIRECTIONAL ALPHA from trade flow
     * Separate from inventory skew - this is a PREDICTIVE signal
     */
    if (STATE.tradeFlow.type !== 'INFORMED') {
        return { alpha: 0, reason: 'no_signal' };
    }

    if (STATE.tradeFlow.confidence < CONFIG.ALPHA.CONFIDENCE_THRESHOLD) {
        return { alpha: 0, reason: 'low_confidence' };
    }

    // Alpha direction: if informed flow is BUY, we want to lean long (positive alpha)
    // This skews our quotes to accumulate position in flow direction
    const flowDirection = STATE.tradeFlow.direction;
    const baseAlpha = CONFIG.ALPHA.MAX_ALPHA_SKEW * STATE.tradeFlow.confidence;

    let alpha = 0;
    if (flowDirection === 'BUY') {
        alpha = baseAlpha;  // Positive: want to buy (lower bid/ask)
    } else if (flowDirection === 'SELL') {
        alpha = -baseAlpha; // Negative: want to sell (raise bid/ask)
    }

    return {
        alpha,
        reason: 'informed_flow',
        direction: flowDirection,
        confidence: STATE.tradeFlow.confidence
    };
}

// ============================================================================
// MODE STATE MACHINE
// ============================================================================

function determineMode(snapshot) {
    /**
     * STRICT STATE MACHINE: FLAT → QUOTE → UNWIND → PANIC
     *
     * FLAT: No inventory, can place two-way quotes freely
     * QUOTE: Small inventory, passive MM with inventory bias
     * UNWIND: Inventory is DEBT - must actively close (escalating aggression)
     * PANIC: Critical - take liquidity at any price
     * PAUSED: Market switch, warming up, or defensive mode
     *
     * CRITICAL PHILOSOPHY:
     * - Inventory ≠ 0 is a DEBT that grows over time
     * - Time in position increases urgency exponentially
     * - Losses must be ACCEPTED as cost of business, not avoided
     */

    const netUtil = snapshot.inventoryUtilizationNet;
    const lossPct = Math.abs(STATE.inventory.unrealizedPnL) / CONFIG.RISK.INITIAL_CASH;
    const timeToExpiry = snapshot.timeToExpiryMinutes;
    const absInventory = Math.abs(snapshot.netShares);
    const hasInventory = absInventory > 0.5;

    let newMode = 'FLAT';
    let reason = 'no_inventory';

    // Calculate time in position (debt accumulation timer)
    let timeInPosition = 0;
    if (hasInventory) {
        if (!STATE.riskStatus.inventoryDebtStartTime) {
            STATE.riskStatus.inventoryDebtStartTime = Date.now();
        }
        timeInPosition = Date.now() - STATE.riskStatus.inventoryDebtStartTime;
    } else {
        STATE.riskStatus.inventoryDebtStartTime = null;
    }

    // Priority 1: PANIC (highest priority - must exit NOW)
    if (STATE.riskStatus.status === 'KILLED') {
        newMode = 'PANIC';
        reason = 'kill_switch_triggered';
    } else if (timeToExpiry < CONFIG.MODE.UNWIND_TO_PANIC_TIME_MIN) {
        newMode = 'PANIC';
        reason = `expiry_critical_${timeToExpiry.toFixed(1)}m`;
    } else if (lossPct > CONFIG.MODE.PANIC_LOSS_PCT) {
        newMode = 'PANIC';
        reason = `loss_critical_${(lossPct * 100).toFixed(1)}%`;
    } else if (timeInPosition > STATE.riskStatus.maxTimeInInventory) {
        newMode = 'PANIC';
        reason = `inventory_timeout_${(timeInPosition / 1000).toFixed(0)}s`;
    }
    // Priority 2: UNWIND (MANDATORY when inventory exists beyond threshold)
    else if (hasInventory && netUtil > CONFIG.MODE.SKEW_TO_UNWIND_INVENTORY) {
        newMode = 'UNWIND';
        reason = `inventory_high_${(netUtil * 100).toFixed(0)}%`;
    } else if (hasInventory && timeToExpiry < CONFIG.RISK.UNWIND_TRIGGER_TIME_MIN) {
        newMode = 'UNWIND';
        reason = `expiry_approaching_${timeToExpiry.toFixed(1)}m`;
    } else if (hasInventory && lossPct > CONFIG.RISK.UNWIND_TRIGGER_LOSS_PCT) {
        newMode = 'UNWIND';
        reason = `loss_high_${(lossPct * 100).toFixed(1)}%`;
    } else if (hasInventory && timeInPosition > STATE.riskStatus.maxTimeInInventory * 0.5) {
        // Half of max time → enter UNWIND early
        newMode = 'UNWIND';
        reason = `inventory_aging_${(timeInPosition / 1000).toFixed(0)}s`;
    }
    // Priority 3: QUOTE (small inventory, still passive MM)
    else if (hasInventory && absInventory > 0.5) {
        newMode = 'QUOTE';
        reason = `inventory_small_${snapshot.netShares.toFixed(1)}`;
    }
    // Priority 4: FLAT (no inventory, full two-way quoting)
    else {
        newMode = 'FLAT';
        reason = 'no_inventory';
    }

    // Log mode transition
    if (newMode !== STATE.riskStatus.mode) {
        const oldMode = STATE.riskStatus.mode;
        log(`${icon('target')} MODE: ${oldMode} → ${newMode} (${reason})`, 'mode');
        STATE.riskStatus.mode = newMode;
        STATE.riskStatus.stateReason = reason;
        STATE.riskStatus.stateEnterTime = Date.now();

        // FILE LOG: Mode transition
        logEvent('MODE_TRANSITION', {
            from: oldMode,
            to: newMode,
            reason: reason,
            inventory: {
                netPosition: STATE.inventory.netPosition,
                yesShares: STATE.inventory.yesShares,
                noShares: STATE.inventory.noShares
            },
            urgency: STATE.riskStatus.urgency,
            timeToExpiry: snapshot?.msToExpiry ? (snapshot.msToExpiry / 60000).toFixed(1) : 'unknown'
        });

        // Reset escalation when exiting UNWIND/PANIC
        if ((oldMode === 'UNWIND' || oldMode === 'PANIC') &&
            (newMode === 'QUOTE' || newMode === 'FLAT')) {
            STATE.riskStatus.unwindEscalation.level = 0;
            STATE.riskStatus.unwindEscalation.attemptsSinceLastFill = 0;
            log(`${icon('ok')} Exited ${oldMode} mode - reset escalation`, 'mode');
        }

        // Log inventory debt acceptance when entering UNWIND
        if (newMode === 'UNWIND' && oldMode !== 'PANIC') {
            const maxLoss = STATE.riskStatus.maxLossPerUnwind * CONFIG.RISK.INITIAL_CASH;
            log(`${icon('warn')} ENTERING UNWIND: Willing to accept up to $${maxLoss.toFixed(2)} loss to close position`, 'unwind');
        }

        // Log loss acceptance when entering PANIC
        if (newMode === 'PANIC') {
            log(`${icon('critical')} ENTERING PANIC: LOSS ACCEPTED AS COST OF BUSINESS - closing at ANY price`, 'panic');
        }
    }

    return {
        mode: newMode,
        reason,
        netUtil,
        lossPct,
        timeToExpiry
    };
}

// ============================================================================
// URGENCY CALCULATION (drives unwind aggression)
// ============================================================================

function calculateUrgency(snapshot) {
    /**
     * Urgency function: 0..1 score that drives unwind aggression
     *
     * Factors:
     * 1. Inventory magnitude (larger position = higher urgency)
     * 2. Time in position (debt accumulation timer)
     * 3. Time to expiry (approaching deadline)
     * 4. Price momentum (moving against us)
     * 5. Orderbook imbalance (liquidity drying up)
     *
     * Urgency → Price aggression:
     * 0.0-0.2: Passive (join best bid/ask)
     * 0.2-0.5: Cross spread slightly
     * 0.5-0.8: Cross spread significantly
     * 0.8-1.0: Take any liquidity available
     */

    const market = STATE.markets.get(STATE.selectedMarket);
    if (!market) return 0;

    const absInventory = Math.abs(snapshot.netShares);
    if (absInventory < 0.5) return 0;  // No inventory = no urgency

    let factors = {
        inventoryMagnitude: 0,
        timeInPosition: 0,
        timeToExpiry: 0,
        priceMomentum: 0,
        orderbookImbalance: 0
    };

    // Factor 1: Inventory magnitude (0..1)
    // Linear from 0 shares to MAX_NET_POSITION
    factors.inventoryMagnitude = Math.min(1.0, absInventory / CONFIG.RISK.MAX_NET_POSITION);

    // Factor 2: Time in position (0..1)
    // Exponential growth: 0 at start, 1.0 at maxTimeInInventory
    if (STATE.riskStatus.inventoryDebtStartTime) {
        const timeInPosition = Date.now() - STATE.riskStatus.inventoryDebtStartTime;
        const ratio = timeInPosition / STATE.riskStatus.maxTimeInInventory;
        // Exponential: grows slowly at first, then rapidly
        factors.timeInPosition = Math.min(1.0, Math.pow(ratio, 1.5));
    }

    // Factor 3: Time to expiry (0..1)
    // Exponential urgency as expiry approaches
    const minutesToExpiry = snapshot.timeToExpiryMinutes;
    if (minutesToExpiry < CONFIG.RISK.UNWIND_TRIGGER_TIME_MIN) {
        const ratio = 1 - (minutesToExpiry / CONFIG.RISK.UNWIND_TRIGGER_TIME_MIN);
        factors.timeToExpiry = Math.pow(ratio, 2);  // Quadratic: accelerates near expiry
    }

    // Factor 4: Price momentum (0..1)
    // Moving against our position = higher urgency
    const recentTrades = STATE.trades.slice(-10);
    if (recentTrades.length >= 3) {
        const firstPrice = recentTrades[0].price;
        const lastPrice = recentTrades[recentTrades.length - 1].price;
        const priceChange = lastPrice - firstPrice;

        // If long (positive inventory) and price falling → urgency
        // If short (negative inventory) and price rising → urgency
        const adverseMovement = snapshot.netShares > 0
            ? -priceChange  // Long: price falling is adverse
            : priceChange;  // Short: price rising is adverse

        factors.priceMomentum = Math.max(0, Math.min(1.0, adverseMovement / 0.05));  // 5% move = full urgency
    }

    // Factor 5: Orderbook imbalance (0..1)
    // Liquidity on our exit side drying up = higher urgency
    const yesBook = STATE.orderbooks.get(market.tokens.YES);
    if (yesBook) {
        const topBidDepth = yesBook.bids.slice(0, 3).reduce((sum, b) => sum + b.size, 0);
        const topAskDepth = yesBook.asks.slice(0, 3).reduce((sum, a) => sum + a.size, 0);
        const totalDepth = topBidDepth + topAskDepth;

        if (totalDepth > 0) {
            // If long (need to sell) and ask depth is thin → urgency
            // If short (need to buy) and bid depth is thin → urgency
            const exitSideDepth = snapshot.netShares > 0 ? topAskDepth : topBidDepth;
            const exitSideRatio = exitSideDepth / totalDepth;

            // Low exit depth = high urgency
            factors.orderbookImbalance = Math.max(0, 1.0 - exitSideRatio * 2);  // <50% depth = urgency
        }
    }

    // Weighted combination
    // Prioritize time in position and inventory magnitude
    const weights = {
        inventoryMagnitude: 0.30,
        timeInPosition: 0.35,
        timeToExpiry: 0.20,
        priceMomentum: 0.10,
        orderbookImbalance: 0.05
    };

    const urgency =
        factors.inventoryMagnitude * weights.inventoryMagnitude +
        factors.timeInPosition * weights.timeInPosition +
        factors.timeToExpiry * weights.timeToExpiry +
        factors.priceMomentum * weights.priceMomentum +
        factors.orderbookImbalance * weights.orderbookImbalance;

    // Store in state for monitoring
    STATE.riskStatus.urgency = urgency;
    STATE.riskStatus.urgencyFactors = factors;

    return urgency;
}

// ============================================================================
// FORCED UNWIND
// ============================================================================

function shouldForceUnwind(snapshot) {
    const reasons = [];
    let urgencyScore = 0;

    // Time trigger
    if (snapshot.timeToExpiryMinutes < CONFIG.RISK.UNWIND_TRIGGER_TIME_MIN) {
        const timeUrgency = 1 - (snapshot.timeToExpiryMinutes / CONFIG.RISK.UNWIND_TRIGGER_TIME_MIN);
        urgencyScore = Math.max(urgencyScore, timeUrgency);
        reasons.push(`TIME: ${snapshot.timeToExpiryMinutes.toFixed(1)}m`);
    }

    // Inventory trigger
    if (snapshot.inventoryUtilizationNet > CONFIG.RISK.UNWIND_TRIGGER_INVENTORY_PCT) {
        const invUrg = (snapshot.inventoryUtilizationNet - CONFIG.RISK.UNWIND_TRIGGER_INVENTORY_PCT) /
                       (1 - CONFIG.RISK.UNWIND_TRIGGER_INVENTORY_PCT);
        urgencyScore = Math.max(urgencyScore, invUrg);
        reasons.push(`INVENTORY: ${(snapshot.inventoryUtilizationNet * 100).toFixed(0)}%`);
    }

    // Loss trigger
    const lossPct = Math.abs(STATE.inventory.unrealizedPnL) / CONFIG.RISK.INITIAL_CASH;
    if (STATE.inventory.unrealizedPnL < 0 && lossPct > CONFIG.RISK.UNWIND_TRIGGER_LOSS_PCT) {
        const lossUrg = (lossPct - CONFIG.RISK.UNWIND_TRIGGER_LOSS_PCT) /
                        (1 - CONFIG.RISK.UNWIND_TRIGGER_LOSS_PCT);
        urgencyScore = Math.max(urgencyScore, lossUrg);
        reasons.push(`LOSS: ${(lossPct * 100).toFixed(1)}%`);
    }

    // Kill switch
    if (STATE.riskStatus.fillStreak >= CONFIG.RISK.KILL_SWITCH_STREAK) {
        urgencyScore = 1.0;
        reasons.push(`KILL: ${STATE.riskStatus.fillStreak} fills`);
    }

    return { unwind: urgencyScore > 0.3, urgency: Math.min(1.0, urgencyScore), reasons };
}

function generateUnwindQuotes(snapshot, unwindCheck) {
    log(`ALERT: UNWIND: ${(unwindCheck.urgency * 100).toFixed(0)}% | ${unwindCheck.reasons.join(', ')}`, 'unwind');

    const netPosition = snapshot.netShares;
    const spreadReduction = CONFIG.RISK.UNWIND_SPREAD_REDUCTION * unwindCheck.urgency;
    const sizeMultiplier = 1.0 + (CONFIG.RISK.UNWIND_SIZE_MULTIPLIER - 1.0) * unwindCheck.urgency;

    const fairYes = STATE.fairValue.yes.final;
    const unwindSpread = CONFIG.QUOTING.BASE_SPREAD * (1 - spreadReduction);
    const unwindSize = Math.min(Math.abs(netPosition) * sizeMultiplier, Math.abs(netPosition));

    if (netPosition > 0) {
        // Sell YES aggressively
        const aggressiveAsk = fairYes - (unwindSpread / 2) - (fairYes * 0.10 * unwindCheck.urgency);
        STATE.targetQuotes.YES = { bid: null, ask: clampPrice(roundToTick(aggressiveAsk)), bidSize: 0, askSize: clampSize(roundToLot(unwindSize)) };
        STATE.targetQuotes.NO = { bid: null, ask: null, bidSize: 0, askSize: 0 };
    } else {
        // Buy YES aggressively
        const aggressiveBid = fairYes + (unwindSpread / 2) + (fairYes * 0.10 * unwindCheck.urgency);
        STATE.targetQuotes.YES = { bid: clampPrice(roundToTick(aggressiveBid)), ask: null, bidSize: clampSize(roundToLot(unwindSize)), askSize: 0 };
        STATE.targetQuotes.NO = { bid: null, ask: null, bidSize: 0, askSize: 0 };
    }

    STATE.riskStatus.forcedUnwind = true;
}

// ============================================================================
// KELLY-LITE SIZING
// ============================================================================

function calculateKellySize(edge, price, bankroll) {
    /**
     * Kelly Criterion sizing adapted for market making
     *
     * CORRECTED: For MM, size should be based on edge/variance ratio
     * NOT divided by price (we're not buying shares, we're providing liquidity)
     *
     * Formula: size = (edge / variance) * bankroll * kelly_fraction
     *
     * where:
     *   edge = expected profit per round-trip (spread capture)
     *   variance = estimated variance of PnL per trade
     *   bankroll = available capital
     */

    if (!CONFIG.KELLY.ENABLED) {
        return CONFIG.QUOTING.BASE_SIZE;
    }

    // Only apply Kelly if we have sufficient edge
    if (edge < CONFIG.KELLY.MIN_EDGE_FOR_KELLY) {
        return CONFIG.QUOTING.BASE_SIZE;
    }

    // Estimate variance for binary market making
    // variance ≈ price * (1 - price) for binary outcomes
    const variance = price * (1 - price);

    // Edge-to-variance ratio (Sharpe-like)
    const edgeToVariance = edge / variance;

    // Kelly fraction as dollar allocation
    const fullKelly = edgeToVariance * bankroll;

    // Apply Kelly fraction (use only 10% of full Kelly for safety)
    const kellyDollars = fullKelly * CONFIG.KELLY.KELLY_FRACTION;

    // Convert to size: how many shares can we quote?
    // CORRECTED: size in shares = kelly_dollars / (price * volatility_adjustment)
    // For simplicity: size ≈ kelly_dollars / price
    let kellySize = kellyDollars / price;

    // Cap at maximum fraction of bankroll
    const maxSizeDollars = CONFIG.KELLY.MAX_BANKROLL_FRACTION * bankroll;
    const maxSize = maxSizeDollars / price;
    kellySize = Math.min(kellySize, maxSize);

    // Floor at base size, ceiling at reasonable maximum
    kellySize = Math.max(CONFIG.QUOTING.BASE_SIZE, kellySize);
    kellySize = Math.min(kellySize, CONFIG.QUOTING.BASE_SIZE * 10);

    return kellySize;
}

function applyKellySizing(baseSize, fairPrice, edgeSize, snapshot) {
    /**
     * Apply Kelly-lite sizing based on:
     * - Available bankroll (cash + position value)
     * - Current edge
     * - Risk utilization
     *
     * CRITICAL: Disabled in ultra-conservative mode (edge warning)
     */

    // HARD OVERRIDE: Ultra-conservative mode disables Kelly
    if (snapshot.ultraConservativeMode) {
        return baseSize;  // Return base size WITHOUT Kelly inflation
    }

    if (!CONFIG.KELLY.ENABLED) {
        return baseSize;
    }

    // Calculate available bankroll
    const availableCash = STATE.inventory.cash - STATE.inventory.reservedCash;
    const positionValue = Math.abs(STATE.inventory.netPosition) * fairPrice;
    const totalBankroll = availableCash + positionValue;

    // Effective edge (spread / 2)
    const effectiveEdge = CONFIG.QUOTING.MIN_EDGE;

    // Calculate Kelly size
    const kellySize = calculateKellySize(effectiveEdge, fairPrice, totalBankroll);

    // Adjust based on inventory utilization
    // Reduce size as we approach limits
    const utilizationPenalty = 1.0 - snapshot.inventoryUtilizationNet;
    const adjustedSize = kellySize * utilizationPenalty;

    log(`KELLY: base=${baseSize.toFixed(1)}, kelly=${kellySize.toFixed(1)}, adjusted=${adjustedSize.toFixed(1)} (bankroll=$${totalBankroll.toFixed(0)})`, 'sizing');

    return adjustedSize;
}

// ============================================================================
// ARCHITECTURE: THREE-LAYER DECISION SYSTEM
// ============================================================================
//
// Priority hierarchy (highest to lowest):
// 1. RiskSupervisor - safety limits, kill switches
// 2. InventoryRecoveryEngine - mandatory position closure
// 3. MarketMakingEngine - profit-seeking quotes
//
// CRITICAL: Layers 1 and 2 OVERRIDE layer 3
// Market making is FORBIDDEN when inventory or risk requires intervention
//
// ============================================================================

// ============================================================================
// LAYER 0: EDGE ALIVE GATE (IRREVERSIBLE)
// ============================================================================

function evaluateEdgeAlive(snapshot) {
    /**
     * LAYER 0: Determine if profitable MM is possible
     *
     * TWO-STAGE DEATH with warm-up period:
     * - Warm-up period (90s): Cannot become irreversible
     * - Staged transitions: Bad streak → WARNING → DEAD (irreversible)
     * - Revival possible from WARNING state
     *
     * Criteria:
     * 1. Trade flow symmetry (balanced buying/selling) - ONLY if enough trades
     * 2. Orderbook refill rate (liquidity returns after trades)
     * 3. Time to expiry (enough time to capture spreads)
     *
     * Returns: { alive: boolean, reason: string, metrics: object, warning: boolean }
     */

    const now = Date.now();
    const isWarmup = (now - STATE.edge.marketEnterTs) < CONFIG.EDGE_ALIVE.WARMUP_MS;

    // IRON-CLAD RULE: If already marked dead and irreversible, stay dead
    // BUT: If in warmup, this should never be true (safeguard)
    if (!STATE.edge.edgeAlive && STATE.edge.irreversible) {
        if (isWarmup) {
            // This should never happen - clear irreversible flag if in warmup
            log(`${icon('warn')} Warmup safeguard: clearing irreversible flag`, 'edge', 'WARN');
            STATE.edge.irreversible = false;
        } else {
            return {
                alive: false,
                reason: STATE.edge.edgeAliveReason,
                metrics: STATE.edge.metrics,
                warning: false
            };
        }
    }

    // Count trades and updates in window
    const windowMs = CONFIG.EDGE_ALIVE.MEASUREMENT_WINDOW_MS;
    const recentTrades = STATE.stats.recentTradeTimestamps?.filter(t => now - t < windowMs) || [];
    const tradesInWindow = recentTrades.length;

    const recentUpdates = STATE.stats.recentOrderbookTimestamps?.filter(t => now - t < windowMs) || [];
    const updatesInWindow = recentUpdates.length;

    const metrics = {
        tradeFlowSymmetry: 1.0,
        orderbookRefillRate: 1.0,
        timeToExpiry: snapshot.timeToExpiryMinutes,
        tradesInWindow: tradesInWindow,
        updatesInWindow: updatesInWindow
    };

    // Metric 1: Trade Flow Symmetry (ONLY if enough trades to be meaningful)
    let symmetryOK = true;  // Default to OK if not enough data
    if (STATE.tradeFlow && STATE.tradeFlow.metrics) {
        const imbalance = STATE.tradeFlow.metrics.imbalance || 0;
        metrics.tradeFlowSymmetry = 1.0 - imbalance;

        // CRITICAL: Only fail on tradeflow if we have enough trades AND not in warmup
        if (tradesInWindow >= CONFIG.EDGE_ALIVE.MIN_TRADES_IN_WINDOW && !isWarmup) {
            symmetryOK = metrics.tradeFlowSymmetry >= CONFIG.EDGE_ALIVE.MIN_TRADE_FLOW_SYMMETRY;
        }
    }

    // Metric 2: Orderbook Refill Rate (ONLY if enough updates)
    let refillOK = true;  // Default to OK if not enough data
    const yesHealth = STATE.orderbookHealth.YES;

    if (updatesInWindow >= CONFIG.EDGE_ALIVE.MIN_UPDATES_IN_WINDOW &&
        yesHealth && yesHealth.depthHistory && yesHealth.depthHistory.length > 1) {
        const recentHistory = yesHealth.depthHistory.slice(-10);
        let increases = 0;
        for (let i = 1; i < recentHistory.length; i++) {
            if (recentHistory[i] > recentHistory[i - 1]) increases++;
        }
        metrics.orderbookRefillRate = increases / (recentHistory.length - 1);
        refillOK = metrics.orderbookRefillRate >= CONFIG.EDGE_ALIVE.MIN_ORDERBOOK_REFILL_RATE;
    }

    // Metric 3: Time to Expiry (always checked)
    const timeOK = metrics.timeToExpiry >= CONFIG.EDGE_ALIVE.MIN_TIME_TO_EXPIRY_MIN;

    // Evaluate window: is it GOOD or BAD?
    const isGoodWindow = symmetryOK && refillOK && timeOK;

    // Determine reason
    let reason = 'edge_alive';
    if (!isGoodWindow) {
        if (!symmetryOK) {
            reason = `tradeflow_onesided_${(metrics.tradeFlowSymmetry * 100).toFixed(0)}pct`;
        } else if (!refillOK) {
            reason = `orderbook_refill_poor_${(metrics.orderbookRefillRate * 100).toFixed(0)}pct`;
        } else if (!timeOK) {
            reason = `expiry_close_${metrics.timeToExpiry.toFixed(1)}min`;
        }
    }

    // Update streaks ONLY once per window (prevent accumulation every cycle)
    const currentWindowStartTs = Math.floor(now / windowMs) * windowMs;
    const shouldUpdateStreak = (STATE.edge.lastEdgeEvalWindowStartTs !== currentWindowStartTs);

    if (shouldUpdateStreak) {
        STATE.edge.lastEdgeEvalWindowStartTs = currentWindowStartTs;

        if (!isGoodWindow) {
            STATE.edge.badStreak++;
            STATE.edge.goodStreak = 0;
            STATE.edge.lastBadReason = reason;
        } else {
            STATE.edge.goodStreak++;
            STATE.edge.badStreak = 0;
            STATE.edge.lastGoodReason = 'metrics_healthy';
        }
    }

    // STATE TRANSITIONS based on streaks

    // Case 1: Already dead irreversible → stay dead
    if (!STATE.edge.edgeAlive && STATE.edge.irreversible) {
        // Already handled at top
    }

    // Case 2: Bad streak reached death threshold
    else if (STATE.edge.badStreak >= CONFIG.EDGE_ALIVE.BAD_STREAK_TO_DEAD) {
        if (isWarmup) {
            // Warm-up: warning only (reversible)
            if (STATE.edge.edgeAlive) {
                STATE.edge.edgeAlive = false;
                STATE.edge.edgeAliveReason = `warning:${reason}`;
                STATE.edge.edgeAliveSince = now;
                STATE.edge.irreversible = false;
                STATE.edge.metrics = metrics;

                log(`${icon('warn')} EDGE WARNING (warmup, reversible): ${reason}`, 'edge', 'WARN');
                log(`${icon('warn')} BadStreak=${STATE.edge.badStreak}, trades=${tradesInWindow}, updates=${updatesInWindow}`, 'edge', 'WARN');

                logEvent('EDGE_WARNING', {
                    reason: reason,
                    metrics: metrics,
                    badStreak: STATE.edge.badStreak,
                    goodStreak: STATE.edge.goodStreak,
                    isWarmup: true,
                    irreversible: false,
                    edgeAliveSince: STATE.edge.edgeAliveSince,
                    marketEnterTs: STATE.edge.marketEnterTs,
                    now: now,
                    windowStartTs: STATE.edge.lastEdgeEvalWindowStartTs,
                    absInventory: snapshot.absInventory,
                    ultraConservativeMode: false,
                    market: STATE.selectedMarket
                });
            }
        } else {
            // Not warmup: IRREVERSIBLE DEATH
            // IRON-CLAD SAFEGUARD: Double-check warmup before setting irreversible
            if (STATE.edge.edgeAlive || !STATE.edge.irreversible) {
                STATE.edge.edgeAlive = false;
                STATE.edge.edgeAliveReason = reason;
                STATE.edge.edgeAliveSince = now;
                STATE.edge.irreversible = !isWarmup;  // NEVER set true during warmup
                STATE.edge.metrics = metrics;

                log(`${icon('critical')} EDGE DIED (IRREVERSIBLE): ${reason}`, 'edge', 'ERROR');
                log(`${icon('warn')} BadStreak=${STATE.edge.badStreak}, trades=${tradesInWindow}, updates=${updatesInWindow}`, 'edge', 'WARN');
                log(`${icon('critical')} MARKET MAKING FORBIDDEN - reduce-only mode`, 'edge', 'ERROR');

                logEvent('EDGE_DIED', {
                    reason: reason,
                    metrics: metrics,
                    badStreak: STATE.edge.badStreak,
                    goodStreak: STATE.edge.goodStreak,
                    tradesInWindow: tradesInWindow,
                    updatesInWindow: updatesInWindow,
                    isWarmup: false,
                    irreversible: true,
                    edgeAliveSince: STATE.edge.edgeAliveSince,
                    marketEnterTs: STATE.edge.marketEnterTs,
                    now: now,
                    windowStartTs: STATE.edge.lastEdgeEvalWindowStartTs,
                    absInventory: snapshot.absInventory,
                    market: STATE.selectedMarket
                });
            }
        }
    }

    // Case 3: Bad streak started (< death threshold) → warning
    else if (STATE.edge.badStreak > 0 && STATE.edge.edgeAlive) {
        STATE.edge.edgeAlive = false;
        STATE.edge.edgeAliveReason = `warning:${reason}`;
        STATE.edge.edgeAliveSince = now;
        STATE.edge.irreversible = false;
        STATE.edge.metrics = metrics;

        log(`${icon('warn')} EDGE WARNING: ${reason} (badStreak=${STATE.edge.badStreak}/${CONFIG.EDGE_ALIVE.BAD_STREAK_TO_DEAD})`, 'edge', 'WARN');

        logEvent('EDGE_WARNING', {
            reason: reason,
            metrics: metrics,
            badStreak: STATE.edge.badStreak,
            goodStreak: STATE.edge.goodStreak,
            isWarmup: isWarmup,
            irreversible: false,
            edgeAliveSince: STATE.edge.edgeAliveSince,
            marketEnterTs: STATE.edge.marketEnterTs,
            now: now,
            windowStartTs: STATE.edge.lastEdgeEvalWindowStartTs,
            absInventory: snapshot.absInventory,
            market: STATE.selectedMarket
        });
    }

    // Case 4: Good streak from warning → REVIVAL
    else if (!STATE.edge.edgeAlive && !STATE.edge.irreversible &&
             STATE.edge.goodStreak >= CONFIG.EDGE_ALIVE.GOOD_STREAK_TO_REVIVE) {
        STATE.edge.edgeAlive = true;
        STATE.edge.edgeAliveReason = 'recovered';
        STATE.edge.edgeAliveSince = now;
        STATE.edge.metrics = metrics;

        log(`${icon('ok')} EDGE REVIVED: goodStreak=${STATE.edge.goodStreak}`, 'edge', 'INFO');

        logEvent('EDGE_REVIVED', {
            reason: 'recovered',
            metrics: metrics,
            badStreak: STATE.edge.badStreak,
            goodStreak: STATE.edge.goodStreak,
            edgeAliveSince: STATE.edge.edgeAliveSince,
            marketEnterTs: STATE.edge.marketEnterTs,
            now: now,
            windowStartTs: STATE.edge.lastEdgeEvalWindowStartTs,
            absInventory: snapshot.absInventory,
            market: STATE.selectedMarket
        });
    }

    // Case 5: Continuing good → stay alive
    else if (STATE.edge.goodStreak > 0 && !STATE.edge.edgeAlive && !STATE.edge.irreversible) {
        // Still in warning but improving
        STATE.edge.metrics = metrics;
    }

    // Case 6: Healthy → stay alive
    else if (STATE.edge.edgeAlive) {
        STATE.edge.metrics = metrics;
        STATE.edge.edgeAliveReason = 'edge_alive';
    }

    return {
        alive: STATE.edge.edgeAlive,
        reason: STATE.edge.edgeAliveReason,
        metrics: STATE.edge.metrics,
        warning: !STATE.edge.edgeAlive && !STATE.edge.irreversible
    };
}

// ============================================================================
// LAYER 1: RISK SUPERVISOR
// ============================================================================

function checkRiskLimits(snapshot) {
    /**
     * LAYER 1: Safety limits and kill switches
     * 
     * CRITICAL CHANGE: Now uses WORST-CASE PAYOFF as PRIMARY RISK METRIC
     * 
     * Returns: { allowed: boolean, reason: string, action: string }
     */

    const absInventory = Math.abs(snapshot.netShares);
    const hasInventory = absInventory > 0.5;
    const timeToExpiryMin = snapshot.timeToExpiryMinutes;
    
    // NEW: PAYOFF-BASED KILL SWITCH
    // If worst-case loss exceeds 20% of capital, PANIC EXIT
    const worstCaseLossRatio = Math.abs(STATE.payoff.worstCasePnl) / CONFIG.RISK.INITIAL_CASH;
    if (STATE.payoff.worstCasePnl < -0.01 && worstCaseLossRatio > 0.20) {
        log(
            `${icon('critical')} WORST-CASE LOSS CRITICAL: ${(worstCaseLossRatio * 100).toFixed(1)}% ` +
            `($${STATE.payoff.worstCasePnl.toFixed(2)}) → PANIC EXIT`,
            'risk'
        );
        return { allowed: false, reason: 'worst_case_loss_critical', action: 'PANIC_EXIT' };
    }
    
    // NEW: Block market making if locked-in loss exists
    // (but allow REDUCE_ONLY to fix it)
    if (STATE.payoff.isLockedInLoss) {
        return { allowed: false, reason: 'locked_in_loss_detected', action: 'REDUCE_ONLY' };
    }

    // SUPERPANIC: <30 seconds to expiry with inventory
    // HIGHEST PRIORITY - exit at ANY price
    const secondsToExpiry = snapshot.msToExpiry / 1000;
    if (secondsToExpiry <= CONFIG.RISK.SUPERPANIC_SECONDS && hasInventory) {
        return { allowed: false, reason: 'superpanic_30s_to_expiry', action: 'SUPERPANIC_EXIT' };
    }

    // Kill switch triggered
    if (STATE.riskStatus.status === 'KILLED') {
        return { allowed: false, reason: 'kill_switch_active', action: 'PANIC_EXIT' };
    }

    // Approaching expiry - mandatory inventory recovery
    // IMPORTANT: only force exit if we actually have inventory
    // (if flat, keep market making all the way and rely on market switch)
    if (hasInventory && timeToExpiryMin < 10) {
        return { allowed: false, reason: 'expiry_critical', action: 'FORCED_EXIT' };
    }

    // Gross position limit
    if (snapshot.grossShares > CONFIG.RISK.MAX_GROSS_POSITION) {
        return { allowed: false, reason: 'gross_position_exceeded', action: 'REDUCE_ONLY' };
    }

    // Net position limit
    if (Math.abs(snapshot.netShares) > CONFIG.RISK.MAX_NET_POSITION) {
        return { allowed: false, reason: 'net_position_exceeded', action: 'REDUCE_ONLY' };
    }

    // All safety checks passed
    return { allowed: true, reason: 'safe', action: 'NORMAL' };
}

// ============================================================================
// PAYOFF ENGINE: Outcome-Based Risk (NOT Mark-to-Market)
// ============================================================================

/**
 * CRITICAL: In prediction markets, equal YES/NO quantity ≠ neutral position
 * 
 * Neutrality is determined by PAYOFF, not share count.
 * 
 * Example of LOCKED-IN LOSS:
 * - YES: 20 shares bought @ 0.29, now @ 0.07
 * - NO:  20 shares bought @ 0.80, now @ 0.85
 * 
 * Share count balanced (20 = 20) BUT:
 * - If YES wins: +20*(1-0.29) - 20*0.80 = +14.2 - 16 = -1.8
 * - If NO wins:  -20*0.29 + 20*(1-0.80) = -5.8 + 4 = -1.8
 * 
 * WORST CASE: -1.8 USDC guaranteed loss regardless of outcome
 */

function updatePayoffEngine() {
    /**
     * Update payoff metrics based on current position and entry prices.
     * 
     * This is the SINGLE SOURCE OF TRUTH for position risk.
     * ALL decision layers MUST consult worstCasePnl, not just netPosition.
     */
    
    const yesQty = STATE.inventory.yesShares;
    const noQty = STATE.inventory.noShares;
    const yesAvgPrice = STATE.inventory.costBasis.yes;
    const noAvgPrice = STATE.inventory.costBasis.no;
    
    // Update average entry prices (already tracked via costBasis)
    STATE.payoff.avgEntryPrice.yes = yesAvgPrice;
    STATE.payoff.avgEntryPrice.no = noAvgPrice;
    
    // Scenario 1: Market resolves YES
    // - YES shares pay out (1 - entry_price) per share
    // - NO shares lose entry_price per share
    const pnlIfYes = yesQty * (1 - yesAvgPrice) - noQty * noAvgPrice;
    
    // Scenario 2: Market resolves NO
    // - YES shares lose entry_price per share
    // - NO shares pay out (1 - entry_price) per share
    const pnlIfNo = -yesQty * yesAvgPrice + noQty * (1 - noAvgPrice);
    
    STATE.payoff.pnlIfYes = pnlIfYes;
    STATE.payoff.pnlIfNo = pnlIfNo;
    
    // CRITICAL RISK METRIC: Worst-case outcome
    STATE.payoff.worstCasePnl = Math.min(pnlIfYes, pnlIfNo);
    
    // Payoff imbalance (directional exposure)
    STATE.payoff.payoffImbalance = Math.abs(pnlIfYes - pnlIfNo);
    
    // Flags
    const hasBothLegs = yesQty > 0.1 && noQty > 0.1;
    STATE.payoff.isLockedInLoss = hasBothLegs && STATE.payoff.worstCasePnl < -0.01;
    STATE.payoff.isPayoffNeutral = STATE.payoff.worstCasePnl >= -0.01;
    
    // Log when locked-in loss is detected
    if (STATE.payoff.isLockedInLoss) {
        const lossPct = (STATE.payoff.worstCasePnl / CONFIG.RISK.INITIAL_CASH) * 100;
        log(
            `${icon('critical')} LOCKED-IN LOSS: worst=$${STATE.payoff.worstCasePnl.toFixed(2)} ` +
            `(${lossPct.toFixed(1)}% of capital) | YES=${yesQty.toFixed(1)}@${yesAvgPrice.toFixed(3)} ` +
            `NO=${noQty.toFixed(1)}@${noAvgPrice.toFixed(3)}`,
            'risk'
        );
    }
}

// ============================================================================
// LAYER 2: INVENTORY RECOVERY ENGINE
// ============================================================================

function shouldActivateInventoryRecovery(snapshot) {
    /**
     * LAYER 2: Determine if inventory recovery mode should activate
     *
     * CRITICAL CHANGE: Now uses PAYOFF-BASED LOGIC, not just share count.
     *
     * Inventory recovery is MANDATORY when:
     * - Worst-case payoff is negative (LOCKED-IN LOSS)
     * - Position exceeds threshold
     * - Time in position exceeds limit
     * - Approaching expiry with position
     *
     * Returns: { active: boolean, reason: string, urgency: number }
     */

    const absInventory = Math.abs(snapshot.netShares);
    const inventoryThreshold = CONFIG.RISK.MAX_NET_POSITION * 0.3;  // 30% = 15 shares
    
    // PRIORITY 0: LOCKED-IN LOSS (NEW - HIGHEST PRIORITY)
    // This overrides everything else. If we have a guaranteed loss regardless
    // of outcome, we MUST exit immediately.
    if (STATE.payoff.isLockedInLoss) {
        const lossRatio = Math.abs(STATE.payoff.worstCasePnl) / CONFIG.RISK.INITIAL_CASH;
        const urgency = Math.min(1.0, lossRatio * 5); // 20% loss → 100% urgency
        
        log(
            `${icon('critical')} LOCKED-IN LOSS DETECTED: worst=$${STATE.payoff.worstCasePnl.toFixed(2)} ` +
            `(urgency=${(urgency * 100).toFixed(0)}%)`,
            'recovery'
        );
        
        return { active: true, reason: 'locked_in_loss', urgency };
    }
    
    // PRIORITY 0.5: PAYOFF IMBALANCE (NEW)
    // Even if worst-case is slightly positive, large payoff imbalance means
    // we're exposed to directional risk we shouldn't have as MM
    const payoffImbalanceRatio = STATE.payoff.payoffImbalance / CONFIG.RISK.INITIAL_CASH;
    if (payoffImbalanceRatio > 0.15) {  // 15% of capital
        const urgency = Math.min(1.0, payoffImbalanceRatio / 0.3); // 30% → 100% urgency
        
        log(
            `${icon('warn')} PAYOFF IMBALANCE: diff=$${STATE.payoff.payoffImbalance.toFixed(2)} ` +
            `(${(payoffImbalanceRatio * 100).toFixed(1)}% of capital)`,
            'recovery'
        );
        
        return { active: true, reason: 'payoff_imbalance', urgency };
    }

    // No significant inventory
    if (absInventory < 0.5) {
        return { active: false, reason: 'no_inventory', urgency: 0 };
    }

    // Calculate time in position
    let timeInPosition = 0;
    if (STATE.riskStatus.inventoryDebtStartTime) {
        timeInPosition = Date.now() - STATE.riskStatus.inventoryDebtStartTime;
    }

    // Priority 1: Inventory size exceeded
    if (absInventory > inventoryThreshold) {
        const urgency = Math.min(1.0, absInventory / CONFIG.RISK.MAX_NET_POSITION);
        return { active: true, reason: 'inventory_size_exceeded', urgency };
    }

    // Priority 2: Time in position exceeded
    const maxTimeMs = STATE.riskStatus.maxTimeInInventory;
    if (timeInPosition > maxTimeMs * 0.5) {  // 50% of max time
        const urgency = Math.min(1.0, timeInPosition / maxTimeMs);
        return { active: true, reason: 'time_in_position_exceeded', urgency };
    }

    // Priority 3: Approaching expiry with any inventory
    if (snapshot.timeToExpiryMinutes < 30) {
        const urgency = 1.0 - (snapshot.timeToExpiryMinutes / 30);
        return { active: true, reason: 'expiry_approaching', urgency };
    }

    // Small inventory, no triggers
    return { active: false, reason: 'below_threshold', urgency: 0 };
}

function generateInventoryRecoveryQuotes(snapshot) {
    /**
     * LAYER 2: INVENTORY RECOVERY ENGINE
     *
     * CRITICAL PRINCIPLES:
     * 1. Exit is OBLIGATION, not opportunity
     * 2. Price aggression driven by TIME, not fair value
     * 3. Accept losses as cost of business
     * 4. One-sided quoting ONLY (reduce inventory)
     *
     * TIME-BASED ESCALATION:
     * 0-60s:   Passive exit (join best)
     * 60-120s: Inside spread
     * 120-180s: Cross spread 25%
     * 180-240s: Cross spread 50%
     * 240-300s: Cross spread 75%
     * >300s:    PANIC (cross spread 100%)
     */

    const market = STATE.markets.get(STATE.selectedMarket);
    if (!market) {
        clearTargetQuotes();
        return;
    }

    const yesBook = STATE.orderbooks.get(market.tokens.YES);
    const noBook = STATE.orderbooks.get(market.tokens.NO);

    if (!yesBook || !noBook) {
        log(`${icon('warn')} RECOVERY BLOCKED: orderbook missing`, 'recovery');
        clearTargetQuotes();
        return;
    }

    const yesBestBid = yesBook.bids[0]?.price;
    const yesBestAsk = yesBook.asks[0]?.price;

    if (!yesBestBid || !yesBestAsk) {
        log(`${icon('warn')} RECOVERY BLOCKED: orderbook incomplete`, 'recovery');
        clearTargetQuotes();
        return;
    }

    // Calculate time in position
    let timeInPosition = 0;
    if (STATE.riskStatus.inventoryDebtStartTime) {
        timeInPosition = Date.now() - STATE.riskStatus.inventoryDebtStartTime;
    }
    const timeInPositionSec = timeInPosition / 1000;

    // TIME-BASED PENALTY (monotonic growth)
    let spreadCrossing = 0;
    if (timeInPositionSec < 60) {
        spreadCrossing = 0;  // Passive: join best
    } else if (timeInPositionSec < 120) {
        // 60-120s: Linear from 0 to 0.15 (inside spread)
        spreadCrossing = -0.15 * ((timeInPositionSec - 60) / 60);  // Negative = inside
    } else if (timeInPositionSec < 180) {
        // 120-180s: 0 to 0.25
        spreadCrossing = 0.25 * ((timeInPositionSec - 120) / 60);
    } else if (timeInPositionSec < 240) {
        // 180-240s: 0.25 to 0.50
        spreadCrossing = 0.25 + 0.25 * ((timeInPositionSec - 180) / 60);
    } else if (timeInPositionSec < 300) {
        // 240-300s: 0.50 to 0.75
        spreadCrossing = 0.50 + 0.25 * ((timeInPositionSec - 240) / 60);
    } else {
        // >300s: PANIC - cross spread 100%
        spreadCrossing = 1.0;
    }

    const netShares = snapshot.netShares;
    const exitSize = Math.abs(netShares);
    const spread = yesBestAsk - yesBestBid;

    clearTargetQuotes();
    
    // ========================================================================
    // PAYOFF-AWARE EXIT LOGIC
    // ========================================================================
    // NOTE: Current logic uses netShares to determine exit direction.
    // 
    // FUTURE ENHANCEMENT: Use payoff imbalance to determine which leg is MORE TOXIC:
    // - If pnlIfYes < pnlIfNo: YES leg is toxic → prioritize closing YES first
    // - If pnlIfNo < pnlIfYes: NO leg is toxic → prioritize closing NO first
    // 
    // This would allow INTELLIGENT recovery that targets the worse leg first,
    // rather than always closing based on share count.
    // 
    // For now, we rely on the PRIORITY 0 trigger in shouldActivateInventoryRecovery()
    // which activates recovery when locked-in loss is detected.
    // ========================================================================

    if (netShares > 0) {
        // LONG YES → MUST SELL
        // Exit price calculation (INDEPENDENT of fair value)
        let exitPrice;
        if (spreadCrossing <= 0) {
            // Inside spread: between best bid and mid
            exitPrice = yesBestBid + spread * (0.5 + spreadCrossing);  // spreadCrossing negative
        } else {
            // Cross spread: below best bid
            exitPrice = yesBestBid - spread * spreadCrossing;
        }
        exitPrice = clampPrice(roundToTick(exitPrice));

        STATE.targetQuotes.YES.ask = exitPrice;
        STATE.targetQuotes.YES.askSize = clampSize(roundToLot(exitSize));

        // Calculate expected loss
        const costBasis = STATE.inventory.costBasis.yes;
        const lossPct = costBasis > 0 ? ((costBasis - exitPrice) / costBasis) * 100 : 0;

        const stageName = timeInPositionSec < 60 ? 'PASSIVE' :
                         timeInPositionSec < 120 ? 'INSIDE' :
                         timeInPositionSec < 180 ? 'CROSS_25%' :
                         timeInPositionSec < 240 ? 'CROSS_50%' :
                         timeInPositionSec < 300 ? 'CROSS_75%' : 'PANIC_100%';

        log(`${icon('fire')} RECOVERY [${stageName}]: SELL YES ${exitSize.toFixed(1)} @ ${exitPrice.toFixed(4)} (t=${timeInPositionSec.toFixed(0)}s, loss=${lossPct.toFixed(1)}%)`, 'recovery');

        // Log explicit loss acceptance for PANIC
        if (timeInPositionSec >= 300) {
            log(`${icon('critical')} PANIC EXIT: Position held >5min - EXIT IS OBLIGATION, NOT OPPORTUNITY`, 'recovery');
        }

    } else if (netShares < 0) {
        // SHORT YES → MUST BUY
        let exitPrice;
        if (spreadCrossing <= 0) {
            // Inside spread: between mid and best ask
            exitPrice = yesBestAsk + spread * (spreadCrossing - 0.5);  // spreadCrossing negative
        } else {
            // Cross spread: above best ask
            exitPrice = yesBestAsk + spread * spreadCrossing;
        }
        exitPrice = clampPrice(roundToTick(exitPrice));

        STATE.targetQuotes.YES.bid = exitPrice;
        STATE.targetQuotes.YES.bidSize = clampSize(roundToLot(exitSize));

        const costBasis = STATE.inventory.costBasis.yes;
        const lossPct = costBasis > 0 ? ((exitPrice - costBasis) / costBasis) * 100 : 0;

        const stageName = timeInPositionSec < 60 ? 'PASSIVE' :
                         timeInPositionSec < 120 ? 'INSIDE' :
                         timeInPositionSec < 180 ? 'CROSS_25%' :
                         timeInPositionSec < 240 ? 'CROSS_50%' :
                         timeInPositionSec < 300 ? 'CROSS_75%' : 'PANIC_100%';

        log(`${icon('fire')} RECOVERY [${stageName}]: BUY YES ${exitSize.toFixed(1)} @ ${exitPrice.toFixed(4)} (t=${timeInPositionSec.toFixed(0)}s, loss=${lossPct.toFixed(1)}%)`, 'recovery');

        if (timeInPositionSec >= 300) {
            log(`${icon('critical')} PANIC EXIT: Position held >5min - EXIT IS OBLIGATION, NOT OPPORTUNITY`, 'recovery');
        }
    }

    // Mark as forced unwind
    STATE.riskStatus.forcedUnwind = true;
}

// ============================================================================
// LAYER 3: MARKET MAKING ENGINE
// ============================================================================

function generateMarketMakingQuotes(snapshot) {
    /**
     * LAYER 3: MARKET MAKING ENGINE
     *
     * This layer is ONLY active when:
     * - No inventory recovery needed
     * - No risk limits exceeded
     * - Inventory is small or zero
     *
     * Purpose: Profit-seeking two-way quoting
     *
     * NOTE: Ultra-conservative mode penalties applied inside generateNormalQuotes
     */

    // Pass through penalties (already set in generateTargetQuotes)
    generateNormalQuotes(snapshot, { mode: 'QUOTE', reason: 'normal_mm' }, 1.0, 1.0);
}

// ============================================================================
// MASTER DECISION ROUTER
// ============================================================================

function generateTargetQuotes(snapshot) {
    /**
     * MASTER DECISION ROUTER
     *
     * FOUR-LAYER ARCHITECTURE with strict priority:
     *
     * Priority 0: EdgeAlive Gate (can we profitably MM?)
     * Priority 1: RiskSupervisor (safety checks)
     * Priority 2: InventoryRecoveryEngine (mandatory position closure)
     * Priority 3: MarketMakingEngine (profit-seeking quotes)
     *
     * Each layer can VETO lower layers.
     */

    if (!snapshot) {
        clearTargetQuotes();
        return;
    }

    // ========================================================================
    // LAYER 0: EDGE ALIVE GATE (TWO-STAGE: WARNING → DEAD)
    // ========================================================================
    const edgeCheck = evaluateEdgeAlive(snapshot);

    if (!edgeCheck.alive) {
        const absInventory = Math.abs(snapshot.netShares);

        // IRREVERSIBLE DEATH: MM forbidden, reduce-only mode
        if (STATE.edge.irreversible) {
            log(`${icon('critical')} EDGE DEAD (IRREVERSIBLE): ${edgeCheck.reason}`, 'edge');

            if (absInventory > 0.5) {
                log(`${icon('fire')} EDGE DEAD + INVENTORY: Forced inventory recovery (no MM allowed)`, 'edge');
                generateInventoryRecoveryQuotes(snapshot);
                return;
            } else {
                log(`${icon('warn')} EDGE DEAD + NO INVENTORY: Stopping all quoting`, 'edge');
                clearTargetQuotes();
                return;
            }
        }

        // REVERSIBLE WARNING: Ultra-conservative quoting allowed
        else {
            log(`${icon('warn')} EDGE WARNING (reversible): ${edgeCheck.reason}`, 'edge');

            if (absInventory > 0.5) {
                // Have inventory: prefer recovery but allow ultra-conservative 2-sided
                log(`${icon('warn')} EDGE WARNING + INVENTORY: Using inventory recovery`, 'edge');
                generateInventoryRecoveryQuotes(snapshot);
                return;
            } else {
                // No inventory: MUST continue 2-sided ultra-conservative quoting
                log(`${icon('warn')} EDGE WARNING + NO INVENTORY: Ultra-conservative 2-sided quoting (wide spread, small size)`, 'edge');
                // Continue to Layer 1-3 but with ultra-conservative mode flag
                snapshot.ultraConservativeMode = true;
            }
        }
    }

    // ========================================================================
    // LAYER 1: RISK SUPERVISOR
    // ========================================================================
    const riskCheck = checkRiskLimits(snapshot);

    if (!riskCheck.allowed) {
        log(`${icon('critical')} RISK SUPERVISOR VETO: ${riskCheck.reason} → action=${riskCheck.action}`, 'risk');

        if (riskCheck.action === 'SUPERPANIC_EXIT') {
            // <30s to expiry - IMMEDIATE exit at any price
            log(`${icon('critical')} SUPERPANIC: <30s to expiry - EXIT AT ANY PRICE`, 'risk');
            generatePanicQuotes(snapshot, { mode: 'SUPERPANIC', reason: riskCheck.reason });
            return;
        } else if (riskCheck.action === 'PANIC_EXIT') {
            // Kill switch - forced exit at any price
            generatePanicQuotes(snapshot, { mode: 'PANIC', reason: riskCheck.reason });
            return;
        } else if (riskCheck.action === 'FORCED_EXIT') {
            // Approaching expiry - mandatory inventory recovery
            generateInventoryRecoveryQuotes(snapshot);
            return;
        } else if (riskCheck.action === 'REDUCE_ONLY') {
            // Position limits exceeded - reduce only mode
            generateInventoryRecoveryQuotes(snapshot);
            return;
        }

        // Unknown action - stop quoting
        clearTargetQuotes();
        return;
    }

    // ========================================================================
    // LAYER 2: INVENTORY RECOVERY ENGINE
    // ========================================================================
    const recoveryCheck = shouldActivateInventoryRecovery(snapshot);

    if (recoveryCheck.active) {
        log(`${icon('fire')} INVENTORY RECOVERY ACTIVE: ${recoveryCheck.reason} (urgency=${(recoveryCheck.urgency * 100).toFixed(0)}%)`, 'recovery');

        // CRITICAL: Inventory recovery OVERRIDES market making
        // This is MANDATORY position closure, not optional
        generateInventoryRecoveryQuotes(snapshot);
        return;
    }

    // ========================================================================
    // LAYER 3: MARKET MAKING ENGINE
    // ========================================================================
    // Only reached if:
    // - Risk limits OK
    // - No inventory recovery needed
    // - Can pursue profit

    // Check mismatch (market making only)
    if (STATE.fairValue.yesNoMismatch > CONFIG.FAIR_VALUE.MISMATCH_KILL) {
        log(`${icon('critical')} MISMATCH KILL: ${(STATE.fairValue.yesNoMismatch * 100).toFixed(2)}% - STOP MM`, 'quote');
        clearTargetQuotes();
        return;
    }

    // Check defensive mode (market making only)
    // if (STATE.riskStatus.defensiveMode) {
    //     if (Date.now() < STATE.riskStatus.defensiveCooldownUntil) {
    //         clearTargetQuotes();
    //         log(`${icon('warn')} DEFENSIVE: Not quoting (MM layer)`, 'quote');
    //         return;
    //     } else {
    //         STATE.riskStatus.defensiveMode = false;
    //     }
    // }

    // Apply penalties for mismatch and ultra-conservative mode
    let sizePenalty = 1.0;
    let spreadMultiplier = 1.0;
    let alphaDisabled = false;

    if (STATE.riskStatus.defensiveMode) {
        if (Date.now() < STATE.riskStatus.defensiveCooldownUntil) {
            spreadMultiplier *= 2.5;
            sizePenalty *= 0.25;
            alphaDisabled = true;
            log("DEFENSIVE ultra-wide quoting (B profile, alpha=0)", "quote", "WARN");
        } else {
            STATE.riskStatus.defensiveMode = false;
        }
    }

    // Ultra-conservative mode (edge warning)
    if (snapshot.ultraConservativeMode) {
        spreadMultiplier = 3.0;  // 3x wider spread
        sizePenalty = 0.2;       // 1/5 size
        alphaDisabled = true;    // No directional bets
        log(`${icon('warn')} Ultra-conservative: spread×3, size×0.2, alpha=0`, 'quote');
    }

    if (STATE.fairValue.yesNoMismatch > CONFIG.FAIR_VALUE.MISMATCH_DANGER) {
        const excessMismatch = STATE.fairValue.yesNoMismatch - CONFIG.FAIR_VALUE.MISMATCH_DANGER;
        sizePenalty = Math.min(sizePenalty, Math.max(0.1, 1.0 - (excessMismatch * CONFIG.FAIR_VALUE.SIZE_PENALTY_PER_PCT * 100)));
        spreadMultiplier = 1.0 + (excessMismatch * CONFIG.FAIR_VALUE.SPREAD_MULTIPLIER_PER_PCT * 100);
    }

    // Generate market making quotes
    log(`${icon('money')} MARKET MAKING ACTIVE: inventory=${snapshot.netShares.toFixed(1)}`, 'quote');
    snapshot.alphaDisabled = alphaDisabled;
    generateMarketMakingQuotes(snapshot);
}

function generateNormalQuotes(snapshot, modeInfo, sizePenalty = 1.0, spreadMultiplier = 1.0) {
    /**
     * QUOTE MODE: Normal market making
     * - Balanced risk
     * - Quote both sides
     * - Apply inventory skew and alpha
     *
     * INVENTORY ACCUMULATION PROTECTION:
     * - Don't quote side that would increase inventory in direction we're already leaning
     * - If long YES: don't bid for more YES, only offer to sell
     * - If short YES: don't offer more YES, only bid to buy back
     */

    const fairYes = STATE.fairValue.yes.final;
    const fairNo = STATE.fairValue.no.final;

    if (!fairYes || !fairNo || isNaN(fairYes) || isNaN(fairNo)) {
        if (CONFIG.SIMULATION_MODE) {
            log(`DEBUG: generateNormalQuotes: Invalid fair values (YES=${fairYes}, NO=${fairNo})`, 'quote');
        }
        clearTargetQuotes();
        return;
    }

    // CRITICAL: Inventory accumulation protection
    // If inventory > threshold, stop quoting side that increases risk
    const netPosition = snapshot.netShares;
    const inventoryThreshold = CONFIG.RISK.MAX_NET_POSITION * 0.3;  // 30% of max
    const blockBuyingSide = netPosition > inventoryThreshold;
    const blockSelllingSide = netPosition < -inventoryThreshold;

    if (blockBuyingSide) {
        log(`${icon('warn')} ACCUMULATION BLOCK: Long ${netPosition.toFixed(1)} - blocking BUY side quotes`, 'quote');
    }
    if (blockSelllingSide) {
        log(`${icon('warn')} ACCUMULATION BLOCK: Short ${netPosition.toFixed(1)} - blocking SELL side quotes`, 'quote');
    }

    let spread = CONFIG.QUOTING.BASE_SPREAD;
    let size = CONFIG.QUOTING.BASE_SIZE;

    // ✅ ДОБАВИТЬ: применяем penalties сразу
    spread *= spreadMultiplier;
    size *= sizePenalty;

    log(`DEBUG: After penalties - spread=${spread.toFixed(4)}, size=${size.toFixed(2)}`, 'quote');

    // Apply time-decay urgency: widen spread and reduce size as expiry approaches
    if (snapshot.urgency > 0) {
        spread *= (1 + snapshot.urgency * 0.5);
        size *= (1 - snapshot.urgency * 0.5);
        log(`⏱ Time urgency: ${(snapshot.urgency * 100).toFixed(0)}% | spread=${(spread * 100).toFixed(2)}%, size=${size.toFixed(1)}`, 'quote');
    }

    // Widen spread if informed (defensive)
    if (STATE.tradeFlow.type === 'INFORMED') {
        spread *= (1 + STATE.tradeFlow.confidence * 0.5);
    }

    // Calculate PURE inventory skew (risk control)
    const skewResult = calculateNonLinearInventorySkew(snapshot);
    const inventorySkew = skewResult.skew;

    // Calculate ALPHA signal (directional, separate from risk)
    // DISABLE alpha in ultra-conservative mode (edge warning)
    //const alphaResult = snapshot.ultraConservativeMode ? { alpha: 0, reason: 'ultra_conservative' } : calculateAlphaSignal(snapshot);
    const alphaResult = (snapshot.ultraConservativeMode || snapshot.alphaDisabled) ? { alpha: 0, reason: "disabled" } : calculateAlphaSignal(snapshot);
    const alphaSkew = alphaResult.alpha;

    // Reduce size if high utilization
    if (snapshot.inventoryUtilizationNet > 0.7 || snapshot.inventoryUtilizationGross > 0.7) {
        size *= 0.5;
    }

    // Apply Kelly-lite sizing (bankroll-aware)
    const avgFairPrice = (fairYes + fairNo) / 2;
    size = applyKellySizing(size, avgFairPrice, CONFIG.QUOTING.MIN_EDGE, snapshot);

    const halfSpread = spread / 2;
    const edge = CONFIG.QUOTING.MIN_EDGE;

    // ========================================================================
    // QUOTE GENERATION: SEPARATE inventory risk from alpha
    // ========================================================================
    // CRITICAL FIX: Inventory skew affects SPREAD and SIZE, NOT fair value
    // Only alphaSkew (directional signal) shifts prices
    //
    // inventorySkew > 0 = long YES → WIDEN spread on BUY side, TIGHTEN on SELL side
    // alphaSkew > 0 = bullish signal → shift BOTH sides down (want to buy)

    // Apply ONLY alpha to fair value (not inventory)
    const fairYesAlphaAdjusted = fairYes - alphaSkew;
    const fairNoAlphaAdjusted = fairNo - alphaSkew;

    // Spread adjustment from inventory (asymmetric)
    // Long position: make selling easier (tighter ask), buying harder (wider bid)
    const inventorySpreadBidAdj = inventorySkew > 0 ? inventorySkew : 0;
    const inventorySpreadAskAdj = inventorySkew < 0 ? -inventorySkew : 0;

    // YES quotes with alpha + inventory spread adjustments
    let bidYes = fairYesAlphaAdjusted - halfSpread - edge - inventorySpreadBidAdj;
    let askYes = fairYesAlphaAdjusted + halfSpread + edge - inventorySpreadAskAdj;
    bidYes = clampPrice(roundToTick(bidYes));
    askYes = clampPrice(roundToTick(askYes));

    // NO quotes with alpha + inventory spread adjustments
    // NO inventory skew is OPPOSITE (when long YES, want to buy NO for hedge)
    const inventorySpreadBidAdjNo = inventorySkew < 0 ? -inventorySkew : 0;
    const inventorySpreadAskAdjNo = inventorySkew > 0 ? inventorySkew : 0;

    let bidNo = fairNoAlphaAdjusted - halfSpread - edge - inventorySpreadBidAdjNo;
    let askNo = fairNoAlphaAdjusted + halfSpread + edge - inventorySpreadAskAdjNo;
    bidNo = clampPrice(roundToTick(bidNo));
    askNo = clampPrice(roundToTick(askNo));

    let sizeLots = clampSize(roundToLot(size));

    // HARD CAP: Ultra-conservative mode (edge warning)
    if (snapshot.ultraConservativeMode) {
        const warningMaxSize = CONFIG.QUOTING.BASE_SIZE * CONFIG.QUOTING.WARNING_SIZE_MULT;
        sizeLots = Math.min(sizeLots, clampSize(roundToLot(warningMaxSize)));
        log(`${icon('warn')} Ultra-conservative CAP: size=${sizeLots.toFixed(2)} (max=${warningMaxSize.toFixed(2)})`, 'quote');
    }

    // Apply accumulation blocks
    STATE.targetQuotes.YES = {
        bid: blockBuyingSide ? null : bidYes,
        ask: blockSelllingSide ? null : askYes,
        bidSize: blockBuyingSide ? 0 : sizeLots,
        askSize: blockSelllingSide ? 0 : sizeLots
    };
    STATE.targetQuotes.NO = {
        bid: blockSelllingSide ? null : bidNo,  // NO is opposite of YES
        ask: blockBuyingSide ? null : askNo,
        bidSize: blockSelllingSide ? 0 : sizeLots,
        askSize: blockBuyingSide ? 0 : sizeLots
    };

    // Log with skew direction
    const skewDir = inventorySkew > 0 ? '(long YES)' : inventorySkew < 0 ? '(short YES)' : '(neutral)';
    log(`QUOTE MODE ${skewDir}: YES [${bidYes.toFixed(4)}/${askYes.toFixed(4)}] NO [${bidNo.toFixed(4)}/${askNo.toFixed(4)}]`, 'quote');
    log(`DEBUG: Final targetQuotes - YES bid=${STATE.targetQuotes.YES.bid}, ask=${STATE.targetQuotes.YES.ask}, bidSize=${STATE.targetQuotes.YES.bidSize}, askSize=${STATE.targetQuotes.YES.askSize}`, 'quote');
    log(`DEBUG: Final targetQuotes - NO bid=${STATE.targetQuotes.NO.bid}, ask=${STATE.targetQuotes.NO.ask}, bidSize=${STATE.targetQuotes.NO.bidSize}, askSize=${STATE.targetQuotes.NO.askSize}`, 'quote');
    if (CONFIG.SIMULATION_MODE) {
        log(`DEBUG: Generated quotes - size=${sizeLots.toFixed(2)}, spread=${(spread * 100).toFixed(2)}%`, 'quote');
    }
}

function generateSkewQuotes(snapshot, modeInfo, sizePenalty = 1.0, spreadMultiplier = 1.0) {
    /**
     * SKEW MODE: Moderate inventory position
     * - Quote both sides but more defensive
     * - Wider spread
     * - Smaller size
     */
    const fairYes = STATE.fairValue.yes.final;
    const fairNo = STATE.fairValue.no.final;

    let spread = CONFIG.QUOTING.BASE_SPREAD * CONFIG.MODE.SKEW_SPREAD_MULTIPLIER;
    let size = CONFIG.QUOTING.BASE_SIZE * 0.7;

    // ✅ ДОБАВИТЬ: применяем penalties
    spread *= spreadMultiplier;
    size *= sizePenalty;

    // Calculate skew and alpha
    const skewResult = calculateNonLinearInventorySkew(snapshot);
    const inventorySkew = skewResult.skew;
    const alphaResult = calculateAlphaSignal(snapshot);
    const alphaSkew = alphaResult.alpha;

    // Apply Kelly-lite sizing
    const avgFairPrice = (fairYes + fairNo) / 2;
    size = applyKellySizing(size, avgFairPrice, CONFIG.QUOTING.MIN_EDGE, snapshot);

    const halfSpread = spread / 2;
    const edge = CONFIG.QUOTING.MIN_EDGE;

    // Apply ONLY alpha to fair value (not inventory)
    const fairYesAlphaAdjusted = fairYes - alphaSkew;
    const fairNoAlphaAdjusted = fairNo - alphaSkew;

    // Spread adjustment from inventory (asymmetric)
    const inventorySpreadBidAdj = inventorySkew > 0 ? inventorySkew : 0;
    const inventorySpreadAskAdj = inventorySkew < 0 ? -inventorySkew : 0;
    const inventorySpreadBidAdjNo = inventorySkew < 0 ? -inventorySkew : 0;
    const inventorySpreadAskAdjNo = inventorySkew > 0 ? inventorySkew : 0;

    let bidYes = fairYesAlphaAdjusted - halfSpread - edge - inventorySpreadBidAdj;
    let askYes = fairYesAlphaAdjusted + halfSpread + edge - inventorySpreadAskAdj;
    let bidNo = fairNoAlphaAdjusted - halfSpread - edge - inventorySpreadBidAdjNo;
    let askNo = fairNoAlphaAdjusted + halfSpread + edge - inventorySpreadAskAdjNo;

    let sizeLots = clampSize(roundToLot(size));

    // HARD CAP: Ultra-conservative mode (edge warning)
    if (snapshot.ultraConservativeMode) {
        const warningMaxSize = CONFIG.QUOTING.BASE_SIZE * CONFIG.QUOTING.WARNING_SIZE_MULT;
        sizeLots = Math.min(sizeLots, clampSize(roundToLot(warningMaxSize)));
        log(`${icon('warn')} Ultra-conservative CAP (skew): size=${sizeLots.toFixed(2)} (max=${warningMaxSize.toFixed(2)})`, 'quote');
    }

    STATE.targetQuotes.YES = {
        bid: clampPrice(roundToTick(bidYes)),
        ask: clampPrice(roundToTick(askYes)),
        bidSize: sizeLots,
        askSize: sizeLots
    };
    STATE.targetQuotes.NO = {
        bid: clampPrice(roundToTick(bidNo)),
        ask: clampPrice(roundToTick(askNo)),
        bidSize: sizeLots,
        askSize: sizeLots
    };

    log(`SKEW MODE (${modeInfo.reason}): wider spread=${(spread * 100).toFixed(2)}%`, 'quote');
}

function generateUnwindQuotesV2(snapshot, modeInfo) {
    /**
     * UNWIND MODE: High inventory or approaching expiry
     * - Book-aware pricing (use bestBid/bestAsk, NOT fair value)
     * - Only quote closing side
     * - Aggression driven by URGENCY function
     * - ESCALATION: if not filling, become more aggressive over time
     *
     * CRITICAL: This is MANDATORY closure, not optional
     * - Accept losses up to maxLossPerUnwind
     * - Time in position drives urgency exponentially
     * - Price momentum against us increases urgency
     */
    const market = STATE.markets.get(STATE.selectedMarket);
    if (!market) {
        clearTargetQuotes();
        return;
    }

    const yesBook = STATE.orderbooks.get(market.tokens.YES);
    const noBook = STATE.orderbooks.get(market.tokens.NO);

    if (!yesBook || !noBook) {
        clearTargetQuotes();
        return;
    }

    const netShares = snapshot.netShares;
    const now = Date.now();

    // Calculate urgency (drives price aggression)
    const urgency = calculateUrgency(snapshot);

    // Ensure unwindEscalation is initialized
    if (!STATE.riskStatus.unwindEscalation) {
        STATE.riskStatus.unwindEscalation = {
            level: 0,
            lastEscalationTime: 0,
            lastFillInUnwind: 0,
            attemptsSinceLastFill: 0
        };
    }

    const esc = STATE.riskStatus.unwindEscalation;

    // Check if we should escalate
    esc.attemptsSinceLastFill++;
    if (esc.attemptsSinceLastFill >= CONFIG.MODE.ESCALATION_ATTEMPTS_THRESHOLD &&
        now - esc.lastEscalationTime > CONFIG.MODE.ESCALATION_INTERVAL_MS) {

        if (esc.level < CONFIG.MODE.MAX_ESCALATION_LEVEL) {
            esc.level++;
            esc.lastEscalationTime = now;
            log(`📈 ESCALATION: Level ${esc.level}/${CONFIG.MODE.MAX_ESCALATION_LEVEL} (${esc.attemptsSinceLastFill} attempts without fill)`, 'unwind');
        }
    }

    // URGENCY-DRIVEN AGGRESSION
    // urgency 0.0-0.2: passive (join best)
    // urgency 0.2-0.5: cross spread 10-30%
    // urgency 0.5-0.8: cross spread 30-70%
    // urgency 0.8-1.0: cross spread 70-100% (take any liquidity)
    const baseSpreadCrossing = urgency < 0.2 ? 0 :
                               urgency < 0.5 ? (urgency - 0.2) / 0.3 * 0.30 :
                               urgency < 0.8 ? 0.30 + (urgency - 0.5) / 0.3 * 0.40 :
                               0.70 + (urgency - 0.8) / 0.2 * 0.30;

    // Escalation ADDS to urgency-driven aggression
    const escalationAggression = CONFIG.MODE.ESCALATION_PRICE_STEP * esc.level;
    const totalSpreadCrossing = Math.min(1.0, baseSpreadCrossing + escalationAggression);

    const sizeMultiplier = Math.pow(CONFIG.MODE.ESCALATION_SIZE_MULTIPLIER, esc.level);
    let size = Math.abs(netShares) * sizeMultiplier;  // Size = inventory, not base size

    log(`${icon('fire')} UNWIND: urgency=${(urgency * 100).toFixed(0)}%, crossing=${(totalSpreadCrossing * 100).toFixed(0)}%, esc_level=${esc.level}`, 'unwind');

    // Book-aware pricing: use actual orderbook, NOT fair value
    // CRITICAL: If book is missing, we CANNOT unwind - refuse to quote
    const yesBestBid = yesBook.bids[0]?.price;
    const yesBestAsk = yesBook.asks[0]?.price;
    const noBestBid = noBook.bids[0]?.price;
    const noBestAsk = noBook.asks[0]?.price;

    if (!yesBestBid || !yesBestAsk || !noBestBid || !noBestAsk) {
        log(`${icon('warn')} UNWIND BLOCKED: Orderbook missing (YES bid=${!!yesBestBid} ask=${!!yesBestAsk}, NO bid=${!!noBestBid} ask=${!!noBestAsk})`, 'unwind');
        clearTargetQuotes();
        return;
    }

    // Clear all quotes first
    clearTargetQuotes();

    if (netShares > 0) {
        // Long YES → need to SELL YES
        // Price aggression based on urgency + escalation
        const spread = yesBestAsk - yesBestBid;
        const targetPrice = yesBestBid - (spread * totalSpreadCrossing);
        const sellYesPrice = clampPrice(roundToTick(targetPrice));

        STATE.targetQuotes.YES.ask = sellYesPrice;
        STATE.targetQuotes.YES.askSize = clampSize(roundToLot(size));

        // Log loss acceptance if price is below cost basis
        const costBasis = STATE.inventory.costBasis.yes;
        if (sellYesPrice < costBasis) {
            const lossPerShare = costBasis - sellYesPrice;
            const totalLoss = lossPerShare * size;
            const lossPct = (totalLoss / CONFIG.RISK.INITIAL_CASH) * 100;
            log(`${icon('warn')} ACCEPTING LOSS: $${totalLoss.toFixed(2)} (${lossPct.toFixed(1)}%) to close position`, 'unwind');
            STATE.riskStatus.totalLossesAccepted += totalLoss;
        }

        log(`${icon('fire')} UNWIND: SELL YES ${size.toFixed(1)} @ ${sellYesPrice.toFixed(4)} (bestBid=${yesBestBid.toFixed(4)})`, 'unwind');

    } else if (netShares < 0) {
        // Short YES → need to BUY YES
        const spread = yesBestAsk - yesBestBid;
        const targetPrice = yesBestAsk + (spread * totalSpreadCrossing);
        const buyYesPrice = clampPrice(roundToTick(targetPrice));

        STATE.targetQuotes.YES.bid = buyYesPrice;
        STATE.targetQuotes.YES.bidSize = clampSize(roundToLot(size));

        // Log loss acceptance if price is above cost basis
        const costBasis = STATE.inventory.costBasis.yes;
        if (buyYesPrice > costBasis) {
            const lossPerShare = buyYesPrice - costBasis;
            const totalLoss = lossPerShare * size;
            const lossPct = (totalLoss / CONFIG.RISK.INITIAL_CASH) * 100;
            log(`${icon('warn')} ACCEPTING LOSS: $${totalLoss.toFixed(2)} (${lossPct.toFixed(1)}%) to close position`, 'unwind');
            STATE.riskStatus.totalLossesAccepted += totalLoss;
        }

        log(`${icon('fire')} UNWIND: BUY YES ${size.toFixed(1)} @ ${buyYesPrice.toFixed(4)} (bestAsk=${yesBestAsk.toFixed(4)})`, 'unwind');
    }

    STATE.riskStatus.forcedUnwind = true;
}

function generatePanicQuotes(snapshot, modeInfo) {
    /**
     * PANIC MODE: Critical situation
     * - Cross spread completely (take liquidity)
     * - Market orders (if possible)
     * - Aggressive exit
     */
    const market = STATE.markets.get(STATE.selectedMarket);
    if (!market) {
        clearTargetQuotes();
        return;
    }

    const yesBook = STATE.orderbooks.get(market.tokens.YES);
    const noBook = STATE.orderbooks.get(market.tokens.NO);

    if (!yesBook || !noBook) {
        clearTargetQuotes();
        return;
    }

    const netShares = snapshot.netShares;
    clearTargetQuotes();

    if (netShares > 0) {
        // PANIC SELL YES - hit the bid aggressively
        const panicSellPrice = yesBook.bids[0]?.price || 0.01;
        STATE.targetQuotes.YES.ask = clampPrice(roundToTick(panicSellPrice * 0.99));  // Below best bid
        STATE.targetQuotes.YES.askSize = clampSize(roundToLot(Math.abs(netShares)));

        log(`PANIC MODE: DUMP YES @ ${panicSellPrice.toFixed(4)} (${modeInfo.reason})`, 'panic');
    } else if (netShares < 0) {
        // PANIC BUY YES - lift the offer
        const panicBuyPrice = yesBook.asks[0]?.price || 0.99;
        STATE.targetQuotes.YES.bid = clampPrice(roundToTick(panicBuyPrice * 1.01));  // Above best ask
        STATE.targetQuotes.YES.bidSize = clampSize(roundToLot(Math.abs(netShares)));

        log(`PANIC MODE: BUY YES @ ${panicBuyPrice.toFixed(4)} (${modeInfo.reason})`, 'panic');
    }

    STATE.riskStatus.forcedUnwind = true;
}

function clearTargetQuotes() {
    STATE.targetQuotes.YES = { bid: null, ask: null, bidSize: 0, askSize: 0 };
    STATE.targetQuotes.NO = { bid: null, ask: null, bidSize: 0, askSize: 0 };
}

async function closePositionsWithoutSnapshot(market, yesBook, noBook) {
    /**
     * Emergency close logic when snapshot is not available
     * Uses basic orderbook data to place closing orders
     */
    const netYes = STATE.inventory.yesShares;
    const netNo = STATE.inventory.noShares;

    log(`📉 Close-only mode: YES=${netYes.toFixed(1)}, NO=${netNo.toFixed(1)}`, 'unwind', 'INFO');

    // Close YES position if we have any
    if (netYes > 0.5) {
        const bestBid = yesBook.bids[0];
        if (bestBid) {
            // Sell at slightly below best bid to ensure execution
            const closePrice = clampPrice(roundToTick(bestBid.price * 0.999));
            const closeSize = Math.min(netYes, CONFIG.LIVE.MAX_SIZE_PER_ORDER || 50);

            log(`🔻 Closing YES: SELL ${closeSize.toFixed(1)} @ ${closePrice.toFixed(4)}`, 'unwind', 'INFO');

            await placeLimitOrder({
                tokenId: market.tokens.YES,
                side: 'SELL',
                price: closePrice,
                size: closeSize
            });
        }
    }

    // Close NO position if we have any
    if (netNo > 0.5) {
        const bestBid = noBook.bids[0];
        if (bestBid) {
            // Sell at slightly below best bid to ensure execution
            const closePrice = clampPrice(roundToTick(bestBid.price * 0.999));
            const closeSize = Math.min(netNo, CONFIG.LIVE.MAX_SIZE_PER_ORDER || 50);

            log(`🔻 Closing NO: SELL ${closeSize.toFixed(1)} @ ${closePrice.toFixed(4)}`, 'unwind', 'INFO');

            await placeLimitOrder({
                tokenId: market.tokens.NO,
                side: 'SELL',
                price: closePrice,
                size: closeSize
            });
        }
    }
}

// ============================================================================
// FILL SIMULATION (for SIMULATION_MODE)
// ============================================================================

function applyFill({ orderId, tokenId, side, price, fillSize }) {
    /**
     * Apply a fill to an order and update inventory
     */
    const order = STATE.orders.active.get(orderId);
    if (!order) return;

    const tokenType = getTokenType(tokenId);
    const notional = price * fillSize;
    const source = CONFIG.SIMULATION_MODE ? 'SIMULATION_FILL' : 'REAL_FILL';
    
    // Calculate inventory BEFORE this fill (for logging)
    let inventoryBefore = { yes: STATE.inventory.yesShares, no: STATE.inventory.noShares };
    if (side === 'BUY') {
        if (tokenType === 'YES') inventoryBefore.yes -= fillSize;
        else inventoryBefore.no -= fillSize;
    } else {
        if (tokenType === 'YES') inventoryBefore.yes += fillSize;
        else inventoryBefore.no += fillSize;
    }

    // Update order
    order.sizeRemaining -= fillSize;
    if (order.sizeRemaining <= 0) {
        // Fully filled - remove order
        removeOrderFromState(orderId);
    } else {
        // Partial fill - update reserved cash
        if (side === 'BUY') {
            const releasedCash = price * fillSize;
            STATE.inventory.reservedCash = Math.max(0, STATE.inventory.reservedCash - releasedCash);
        }
    }

    // Update inventory using LOT-BASED ACCOUNTING
    const probabilityPrice = price;  // In Polymarket, price IS the probability (0-1)
    const usdPricePerShare = probabilityPrice;
    const costUsd = fillSize * usdPricePerShare;
    const expectedPayoutUsd = fillSize * 1.0;
    let fillPnL = 0;
    let oldCostBasis = 0;

    if (side === 'BUY') {
        // BUY: Create position lot, decrease cash
        addLot(tokenType, fillSize, probabilityPrice, orderId);
        const oldCash = STATE.inventory.cash;
        STATE.inventory.cash -= costUsd;

        log(`   💸 Cash: $${oldCash.toFixed(2)} → $${STATE.inventory.cash.toFixed(2)} (-$${costUsd.toFixed(2)})`, 'accounting', 'DEBUG');

        if (tokenType === 'YES') {
            oldCostBasis = STATE.inventory.costBasis.yes;
            // Update cost basis (weighted average)
            const totalShares = STATE.inventory.yesShares + fillSize;
            const totalCost = STATE.inventory.costBasis.yes * STATE.inventory.yesShares + costUsd;
            STATE.inventory.costBasis.yes = totalCost / totalShares;
            STATE.inventory.yesShares += fillSize;
        } else if (tokenType === 'NO') {
            oldCostBasis = STATE.inventory.costBasis.no;
            const totalShares = STATE.inventory.noShares + fillSize;
            const totalCost = STATE.inventory.costBasis.no * STATE.inventory.noShares + costUsd;
            STATE.inventory.costBasis.no = totalCost / totalShares;
            STATE.inventory.noShares += fillSize;
        }
    } else if (side === 'SELL') {
        // SELL: Remove lots FIFO, increase cash, realize PnL
        const { realizedPnl } = removeLotsFIFO(tokenType, fillSize, probabilityPrice);
        fillPnL = realizedPnl;
        const proceeds = probabilityPrice * fillSize;
        const oldCash = STATE.inventory.cash;
        STATE.inventory.cash += proceeds;
        STATE.inventory.realizedPnL += realizedPnl;

        log(`   💸 Cash: $${oldCash.toFixed(2)} → $${STATE.inventory.cash.toFixed(2)} (+$${proceeds.toFixed(2)})`, 'accounting', 'DEBUG');

        if (tokenType === 'YES') {
            oldCostBasis = STATE.inventory.costBasis.yes;
            STATE.inventory.yesShares -= fillSize;
            if (STATE.inventory.yesShares <= 0.01) {
                STATE.inventory.yesShares = 0;
                STATE.inventory.costBasis.yes = 0;
                STATE.lots.yes = [];
            }
        } else if (tokenType === 'NO') {
            oldCostBasis = STATE.inventory.costBasis.no;
            STATE.inventory.noShares -= fillSize;
            if (STATE.inventory.noShares <= 0.01) {
                STATE.inventory.noShares = 0;
                STATE.inventory.costBasis.no = 0;
                STATE.lots.no = [];
            }
        }
    }
    
    // ENHANCED LOGGING with 4 PRICE LEVELS (CRITICAL FORMAT)
    const inventoryAfterFill = `inv.${tokenType}=${(tokenType === 'YES' ? STATE.inventory.yesShares : STATE.inventory.noShares).toFixed(1)}`;

    if (side === 'BUY') {
        // BUY: Show cost breakdown
        log(
            `${icon('money')} ${source}: ${tokenType} BUY ${fillSize.toFixed(2)}`,
            'oms'
        );
        log(
            `   prob=${probabilityPrice.toFixed(4)} | ` +
            `usd=${usdPricePerShare.toFixed(4)} | ` +
            `cost=$${costUsd.toFixed(2)} | ` +
            `payout_if_win=$${expectedPayoutUsd.toFixed(2)} | ` +
            `expected_pnl=+$${(expectedPayoutUsd - costUsd).toFixed(2)} | ` +
            `${inventoryAfterFill}`,
            'oms'
        );
    } else {
        // SELL: Show proceeds and realized PnL
        const proceeds = probabilityPrice * fillSize;
        const pnlStr = fillPnL !== 0 ? `${fillPnL >= 0 ? '+' : ''}$${fillPnL.toFixed(2)}` : '$0.00';
        log(
            `${icon('money')} ${source}: ${tokenType} SELL ${fillSize.toFixed(2)}`,
            'oms'
        );
        log(
            `   prob=${probabilityPrice.toFixed(4)} | ` +
            `usd=${usdPricePerShare.toFixed(4)} | ` +
            `proceeds=$${proceeds.toFixed(2)} | ` +
            `realized_pnl=${pnlStr} | ` +
            `${inventoryAfterFill}`,
            'oms'
        );
    }

    // Add to fill history (NEWEST FIRST)
    // notional already calculated above
    const inventoryAfter = {
        yes: STATE.inventory.yesShares,
        no: STATE.inventory.noShares
    };
    
    const fillRecord = {
        timestamp: Date.now(),
        token: tokenType,
        side: side,
        size: fillSize,
        price: price,
        notional: notional,
        pnl: fillPnL,
        inventoryAfter: inventoryAfter,
        source: CONFIG.SIMULATION_MODE ? 'SIMULATION_FILL' : 'REAL_FILL',
        synthetic: false,
        orderId: orderId
    };

    // Use UNSHIFT (newest first)
    SCREEN_BUFFERS.fillHistory.unshift(fillRecord);
    if (SCREEN_BUFFERS.fillHistory.length > MAX_FILL_HISTORY) {
        SCREEN_BUFFERS.fillHistory.pop();  // Remove oldest
    }

    // FILE LOG: Fill event
    logFill({
        timestamp: new Date(fillRecord.timestamp).toISOString(),
        orderId: orderId,
        token: tokenType,
        side: side,
        size: fillSize,
        price: price,
        pnl: fillPnL,
        simulationMode: CONFIG.SIMULATION_MODE,
        inventoryBefore: {
            yesShares: tokenType === 'YES' && side === 'BUY' ? STATE.inventory.yesShares - fillSize :
                       tokenType === 'YES' && side === 'SELL' ? STATE.inventory.yesShares + fillSize : STATE.inventory.yesShares,
            noShares: tokenType === 'NO' && side === 'BUY' ? STATE.inventory.noShares - fillSize :
                      tokenType === 'NO' && side === 'SELL' ? STATE.inventory.noShares + fillSize : STATE.inventory.noShares
        },
        inventoryAfter: {
            yesShares: STATE.inventory.yesShares,
            noShares: STATE.inventory.noShares,
            netPosition: STATE.inventory.netPosition,
            cash: STATE.inventory.cash,
            realizedPnL: STATE.inventory.realizedPnL
        },
        mode: STATE.riskStatus.mode,
        market: STATE.selectedMarket
    });

    // Update position metrics
    updatePositionMetrics();

    // CRITICAL: Validate accounting consistency after fill
    assertAccountingConsistency();

    // Update fill streak (per token+side)
    // tokenType already declared above at line 1957
    const streakKey = `${tokenType}_${side}`;  // e.g., "YES_BUY", "NO_SELL"
    const oppositeKey = `${tokenType}_${side === 'BUY' ? 'SELL' : 'BUY'}`;

    // Increment streak for this specific token+side
    if (STATE.riskStatus.fillStreaks[streakKey] !== undefined) {
        STATE.riskStatus.fillStreaks[streakKey]++;

        // Reset opposite side streak (getting filled on both sides = healthy MM)
        if (STATE.riskStatus.fillStreaks[oppositeKey] > 0) {
            log(`✅ Two-way market: ${oppositeKey} streak reset from ${STATE.riskStatus.fillStreaks[oppositeKey]} → 0`, 'risk');
            STATE.riskStatus.fillStreaks[oppositeKey] = 0;
        }
    }

    // Legacy global streak (for backwards compatibility)
    if (STATE.riskStatus.fillStreakSide === side) {
        STATE.riskStatus.fillStreak++;
    } else {
        STATE.riskStatus.fillStreakSide = side;
        STATE.riskStatus.fillStreak = 1;
    }

    // Check if any specific token+side has hit kill-switch
    const maxStreakKey = Object.keys(STATE.riskStatus.fillStreaks)
        .reduce((max, key) =>
            STATE.riskStatus.fillStreaks[key] > STATE.riskStatus.fillStreaks[max] ? key : max
        );
    const maxStreak = STATE.riskStatus.fillStreaks[maxStreakKey];

    if (maxStreak >= CONFIG.RISK.KILL_SWITCH_STREAK) {
        log(`🚨 KILL SWITCH: ${maxStreakKey} streak=${maxStreak} (one-sided flow detected)`, 'risk');
        STATE.riskStatus.status = 'KILLED';

        // FILE LOG: Kill switch activated
        logEvent('KILL_SWITCH_ACTIVATED', {
            streakKey: maxStreakKey,
            streakCount: maxStreak,
            threshold: CONFIG.RISK.KILL_SWITCH_STREAK,
            inventory: {
                yesShares: STATE.inventory.yesShares,
                noShares: STATE.inventory.noShares,
                netPosition: STATE.inventory.netPosition
            },
            fillStreaks: STATE.riskStatus.fillStreaks
        });
    }

    STATE.riskStatus.lastFillTime = Date.now();
    STATE.stats.fills++;

    // Reset escalation if we got filled in UNWIND mode
    if (STATE.riskStatus.mode === 'UNWIND' || STATE.riskStatus.mode === 'PANIC') {
        STATE.riskStatus.unwindEscalation.lastFillInUnwind = Date.now();
        STATE.riskStatus.unwindEscalation.attemptsSinceLastFill = 0;
        if (STATE.riskStatus.unwindEscalation.level > 0) {
            log(`${icon('ok')} Fill received - reset escalation from L${STATE.riskStatus.unwindEscalation.level} → L0`, 'unwind');
            STATE.riskStatus.unwindEscalation.level = 0;
        }
    }

    log(`Inventory: YES=${STATE.inventory.yesShares.toFixed(1)}, NO=${STATE.inventory.noShares.toFixed(1)}, Net=${STATE.inventory.netPosition.toFixed(1)}, Cash=$${STATE.inventory.cash.toFixed(2)}`, 'oms');

    // CRITICAL: Immediate reaction to fill - place hedge/unwind order
    // Don't wait for next market tick
    immediateReactionToFill({ tokenId, side, fillSize, price });
}

async function immediateReactionToFill({ tokenId, side, fillSize, price }) {
    /**
     * CRITICAL: Immediate hedge/unwind response to fill
     *
     * Goals:
     * 1. If inventory now exceeds threshold → place unwind order IMMEDIATELY
     * 2. If in UNWIND/PANIC mode → increase urgency, place more aggressive order
     * 3. Don't wait for next main loop cycle (could be seconds away)
     *
     * This prevents inventory accumulation from fills
     */

    const market = STATE.markets.get(STATE.selectedMarket);
    if (!market) return;

    // Recalculate snapshot with new inventory
    const snapshot = computeExposureSnapshot();
    if (!snapshot) return;

    const absInventory = Math.abs(snapshot.netShares);
    if (absInventory < 0.5) {
        // No significant inventory, no action needed
        return;
    }

    // Calculate urgency based on new inventory
    const urgency = calculateUrgency(snapshot);

    // Determine if we should place immediate unwind order
    const shouldUnwind =
        STATE.riskStatus.mode === 'UNWIND' ||
        STATE.riskStatus.mode === 'PANIC' ||
        urgency > 0.3;

    if (!shouldUnwind) {
        log(`${icon('info')} Fill reaction: inventory=${snapshot.netShares.toFixed(1)}, urgency=${(urgency * 100).toFixed(0)}% - no immediate action`, 'oms');
        return;
    }

    log(`${icon('fire')} IMMEDIATE UNWIND: inventory=${snapshot.netShares.toFixed(1)}, urgency=${(urgency * 100).toFixed(0)}%`, 'unwind');

    // Get orderbooks
    const yesBook = STATE.orderbooks.get(market.tokens.YES);
    const noBook = STATE.orderbooks.get(market.tokens.NO);

    if (!yesBook || !noBook) {
        log(`${icon('warn')} Cannot place immediate unwind: orderbook missing`, 'unwind');
        return;
    }

    const yesBestBid = yesBook.bids[0]?.price;
    const yesBestAsk = yesBook.asks[0]?.price;
    const noBestBid = noBook.bids[0]?.price;
    const noBestAsk = noBook.asks[0]?.price;

    if (!yesBestBid || !yesBestAsk || !noBestBid || !noBestAsk) {
        log(`${icon('warn')} Cannot place immediate unwind: orderbook incomplete`, 'unwind');
        return;
    }

    // Calculate price aggression based on urgency
    // urgency 0.0-0.3: join best
    // urgency 0.3-0.6: cross spread 10%
    // urgency 0.6-0.8: cross spread 50%
    // urgency 0.8-1.0: cross spread 100% (take any liquidity)
    const spreadCrossing = urgency < 0.3 ? 0 :
                          urgency < 0.6 ? 0.10 :
                          urgency < 0.8 ? 0.50 :
                          1.0;

    const netShares = snapshot.netShares;
    const unwindSize = Math.min(Math.abs(netShares), CONFIG.QUOTING.BASE_SIZE * 2);

    if (netShares > 0) {
        // Long YES → SELL YES aggressively
        const spread = yesBestAsk - yesBestBid;
        const targetPrice = yesBestBid - (spread * spreadCrossing);
        const sellPrice = clampPrice(roundToTick(targetPrice));

        log(`${icon('fire')} IMMEDIATE SELL YES: ${unwindSize.toFixed(1)} @ ${sellPrice.toFixed(4)} (crossing ${(spreadCrossing * 100).toFixed(0)}%)`, 'unwind');

        await placeLimitOrder({
            tokenId: market.tokens.YES,
            side: 'SELL',
            price: sellPrice,
            size: unwindSize
        });

    } else if (netShares < 0) {
        // Short YES → BUY YES aggressively
        const spread = yesBestAsk - yesBestBid;
        const targetPrice = yesBestAsk + (spread * spreadCrossing);
        const buyPrice = clampPrice(roundToTick(targetPrice));

        log(`${icon('fire')} IMMEDIATE BUY YES: ${unwindSize.toFixed(1)} @ ${buyPrice.toFixed(4)} (crossing ${(spreadCrossing * 100).toFixed(0)}%)`, 'unwind');

        await placeLimitOrder({
            tokenId: market.tokens.YES,
            side: 'BUY',
            price: buyPrice,
            size: unwindSize
        });
    }
}

function simulateFillsFromTrades(trade) {
    /**
     * ENHANCED fill simulation with:
     * - Queue position proxy
     * - Latency/timing penalties
     * - Adverse selection (toxic flow avoidance)
     */
    if (!CONFIG.SIMULATION_MODE) return;

    const market = STATE.markets.get(STATE.selectedMarket);
    if (!market) return;

    const orderbook = STATE.orderbooks.get(trade.tokenId);
    if (!orderbook) return;

    const ordersForToken = Array.from(STATE.orders.byToken.get(trade.tokenId) || []);

    for (const orderId of ordersForToken) {
        const order = STATE.orders.active.get(orderId);
        if (!order || order.sizeRemaining <= 0) continue;

        let shouldFill = false;
        let fillProbability = 1.0;

        // Aggressive BUY trade crosses our SELL orders
        if (trade.aggressor === 'BUY' && order.side === 'SELL') {
            if (trade.price >= order.price) {
                shouldFill = true;
            }
        }

        // Aggressive SELL trade crosses our BUY orders
        if (trade.aggressor === 'SELL' && order.side === 'BUY') {
            if (trade.price <= order.price) {
                shouldFill = true;
            }
        }

        if (shouldFill) {
            // ================================================================
            // QUEUE POSITION PROXY
            // ================================================================
            // Estimate our position in queue based on order timestamp
            // Older orders = better queue position
            const orderAge = Date.now() - order.timestamp;
            const orderAgeSeconds = orderAge / 1000;

            // Fresh orders have worse queue position
            let queuePriority = Math.min(1.0, orderAgeSeconds / 5.0);  // Full priority after 5s

            // ================================================================
            // DEPTH-BASED PARTICIPATION
            // ================================================================
            // How much depth is at our price level?
            const topLevel = order.side === 'BUY'
                ? orderbook.bids[0]
                : orderbook.asks[0];

            let depthAtOurPrice = 0;
            if (order.side === 'BUY') {
                // Sum all bids at or above our price
                depthAtOurPrice = orderbook.bids
                    .filter(l => l.price >= order.price)
                    .reduce((sum, l) => sum + l.size, 0);
            } else {
                // Sum all asks at or below our price
                depthAtOurPrice = orderbook.asks
                    .filter(l => l.price <= order.price)
                    .reduce((sum, l) => sum + l.size, 0);
            }

            // Our share of total depth at this level
            const ourShareOfDepth = depthAtOurPrice > 0
                ? order.sizeRemaining / depthAtOurPrice
                : 0.1;

            // ================================================================
            // ADVERSE SELECTION (toxic flow) - CONSERVATIVE
            // ================================================================
            // Large aggressive trades are more likely to be informed
            // Reduce fill probability for toxic flow
            let adverseSelectionPenalty = 1.0;
            if (trade.size > 20) {  // Large trade
                adverseSelectionPenalty = 0.6;  // 40% less likely (more conservative)
            }
            if (STATE.tradeFlow.type === 'INFORMED') {
                adverseSelectionPenalty *= 0.7;  // Additional 30% penalty (more conservative)
            }

            // ================================================================
            // LATENCY PENALTY - CONSERVATIVE
            // ================================================================
            // In real markets, there's latency between trade and fill
            // Fast traders (HFT) cancel before getting hit
            // We simulate "slow" market maker with higher latency
            const latencyPenalty = 0.85;  // 15% of fills lost to latency (more realistic)

            // ================================================================
            // QUEUE PENALTY (not at top of book)
            // ================================================================
            // If our order is NOT at top of book, reduce fill probability
            let queuePenalty = 1.0;
            const atTop = (order.side === 'BUY' && order.price === topLevel?.price) ||
                         (order.side === 'SELL' && order.price === topLevel?.price);
            if (!atTop) {
                queuePenalty = 0.5;  // 50% reduction if not at top
            }

            // ================================================================
            // FORCEDUNWIND BOOST (higher fill probability when unwinding)
            // ================================================================
            // When in forced unwind, simulation should favor closing fills
            let unwindBoost = 1.0;
            if (STATE.riskStatus.forcedUnwind) {
                const isClosingSide =
                    (STATE.inventory.netPosition > 0 && order.side === 'SELL') ||
                    (STATE.inventory.netPosition < 0 && order.side === 'BUY');

                if (isClosingSide) {
                    unwindBoost = 1.3;  // 30% boost for closing-side fills in unwind
                } else {
                    unwindBoost = 0.5;  // Reduce non-closing fills in unwind
                }
            }

            // ================================================================
            // CALCULATE FINAL FILL - CONSERVATIVE
            // ================================================================
            fillProbability = queuePriority * adverseSelectionPenalty * latencyPenalty * queuePenalty * unwindBoost;

            // Participation rate: what fraction of trade size we get - CONSERVATIVE
            const participationRate = Math.min(0.5, ourShareOfDepth * 1.5) * fillProbability;  // Reduced from 0.6 and 2.0

            // CRITICAL: Cannot fill more than remaining trade size
            const remainingTradeSize = trade.size;  // In real scenario, this would track partial fills
            const fillSize = Math.min(
                order.sizeRemaining,
                remainingTradeSize * participationRate  // Respect remaining trade size
            );

            if (fillSize >= CONFIG.QUOTING.MIN_SIZE) {
                // Additional check: slippage on large fills
                let fillPrice = order.price;
                if (fillSize > 10) {
                    // Large fill = might get worse price due to slippage
                    const slippage = 0.0001 * (fillSize / 10);
                    fillPrice = order.side === 'BUY'
                        ? order.price + slippage
                        : order.price - slippage;
                    fillPrice = clampPrice(roundToTick(fillPrice));
                }

                applyFill({
                    orderId,
                    tokenId: trade.tokenId,
                    side: order.side,
                    price: fillPrice,
                    fillSize
                });

                log(`FILL_SIM: Queue=${(queuePriority * 100).toFixed(0)}%, AdverseSel=${(adverseSelectionPenalty * 100).toFixed(0)}%, Part=${(participationRate * 100).toFixed(0)}%`, 'oms');
            }
        }
    }
}

// ============================================================================
// TRADE DETECTION & ANALYSIS
// ============================================================================

function processTrade(trade) {
    // CRITICAL: Validate tokenId belongs to current market
    const market = STATE.markets.get(STATE.selectedMarket);
    if (!market) return;

    if (trade.tokenId !== market.tokens.YES && trade.tokenId !== market.tokens.NO) {
        // Trade from old market, ignore
        return;
    }

    STATE.trades.push(trade);
    if (STATE.trades.length > 100) STATE.trades = STATE.trades.slice(-100);

    STATE.stats.totalTrades++;
    STATE.stats.recentTradeTimestamps.push(Date.now());

    log(`Trade: ${getTokenType(trade.tokenId)} ${trade.aggressor} ${trade.size.toFixed(2)} @ ${trade.price.toFixed(4)}`, 'trade');

    // Simulate fills in SIMULATION mode
    if (CONFIG.SIMULATION_MODE) {
        simulateFillsFromTrades(trade);
    }

    // Detect aggressive
    const orderbook = STATE.orderbooks.get(trade.tokenId);
    if (orderbook) {
        const isAggressive = detectAggressiveTrade(trade, orderbook);
        if (isAggressive) handleAggressiveTrade(trade);
    }

    analyzeTradeFlow();
}

function detectAggressiveTrade(trade, orderbook) {
    const isLarge = trade.size >= CONFIG.TRADE_DETECTION.AGGRESSIVE_SIZE_THRESHOLD;
    let removesDepth = false;
    let touchesTopOfBook = false;

    const bestBid = orderbook.bids[0]?.price || 0;
    const bestAsk = orderbook.asks[0]?.price || 1;

    if (trade.aggressor === 'BUY') {
        // Aggressive BUY: price at or above bestAsk
        touchesTopOfBook = trade.price >= bestAsk * 0.999;  // Within 0.1% of bestAsk

        const askDepth = orderbook.asks.slice(0, 3).reduce((s, l) => s + l.size, 0);
        const ratio = trade.size / Math.max(askDepth, 0.1);
        removesDepth = ratio >= CONFIG.TRADE_DETECTION.DEPTH_REMOVAL_RATIO_THRESHOLD;
    } else if (trade.aggressor === 'SELL') {
        // Aggressive SELL: price at or below bestBid
        touchesTopOfBook = trade.price <= bestBid * 1.001;  // Within 0.1% of bestBid

        const bidDepth = orderbook.bids.slice(0, 3).reduce((s, l) => s + l.size, 0);
        const ratio = trade.size / Math.max(bidDepth, 0.1);
        removesDepth = ratio >= CONFIG.TRADE_DETECTION.DEPTH_REMOVAL_RATIO_THRESHOLD;
    }

    // Trade is aggressive if: large + removes depth + touches top of book
    return isLarge && removesDepth && touchesTopOfBook;
}

function handleAggressiveTrade(trade) {
    log(`${icon('warn')} AGGRESSIVE TRADE: ${trade.size.toFixed(1)} ${trade.aggressor}`, 'flow');

    // Don't enter defensive mode if we're already in forced unwind
    // Unwind takes priority - we need to close position aggressively
    if (STATE.riskStatus.forcedUnwind) {
        log(`${icon('alert')} Already in UNWIND mode, ignoring defensive trigger`, 'flow');
        return;
    }

    // REACTIVE: This triggers AFTER trade occurred
    STATE.riskStatus.defensiveMode = true;
    STATE.riskStatus.defensiveCooldownUntil = Date.now() + CONFIG.TRADE_DETECTION.INFORMED_COOLDOWN_MS;
    STATE.riskStatus.defensiveCanceledOnce = false;  // Reset flag for new defensive period

    cancelAll().catch(err => log(`${icon('err')} ${err.message}`, 'oms'));

    log(`${icon('warn')} DEFENSIVE MODE for ${CONFIG.TRADE_DETECTION.INFORMED_COOLDOWN_MS / 1000}s`, 'flow');
}

function analyzeTradeFlow() {
    const window = 30000;
    const now = Date.now();
    const recentTrades = STATE.trades.filter(t => now - t.timestamp < window);

    if (recentTrades.length < 3) {
        STATE.tradeFlow = { type: 'INSUFFICIENT_DATA', direction: null, confidence: 0, metrics: {} };
        return;
    }

    // Metrics
    const avgTime = window / recentTrades.length;
    const burstScore = Math.min(1.0, 5000 / avgTime);

    let buyVol = 0, sellVol = 0;
    recentTrades.forEach(t => {
        if (t.aggressor === 'BUY') buyVol += t.size;
        else sellVol += t.size;
    });

    const totalVol = buyVol + sellVol;
    const imbalance = Math.abs(buyVol - sellVol) / totalVol;
    const direction = buyVol > sellVol ? 'BUY' : 'SELL';

    const firstPrice = recentTrades[0].price;
    const lastPrice = recentTrades[recentTrades.length - 1].price;
    const priceImpact = Math.min(1.0, Math.abs(lastPrice - firstPrice) / 0.05);

    const avgSize = totalVol / recentTrades.length;
    const sizeScore = Math.min(1.0, avgSize / 20);

    const last5 = recentTrades.slice(-5);
    const followThrough = last5.filter(t => t.aggressor === direction).length / last5.length;

    const informedScore = burstScore * 0.20 + imbalance * 0.30 + priceImpact * 0.25 + sizeScore * 0.10 + followThrough * 0.15;
    const isInformed = informedScore > 0.5;

    STATE.tradeFlow = {
        type: isInformed ? 'INFORMED' : 'NOISE',
        direction,
        confidence: informedScore,
        metrics: { burst: burstScore, imbalance, priceImpact, avgSize, followThrough, count: recentTrades.length }
    };

    if (isInformed && informedScore > 0.7) {
        log(`WARNING: INFORMED: ${direction} ${(informedScore * 100).toFixed(0)}%`, 'flow');
    }
}

// ============================================================================
// INVENTORY & RISK UPDATES
// ============================================================================

function updateInventoryAndRisk(snapshot) {
    // Update payoff engine FIRST (critical for risk assessment)
    updatePayoffEngine();
    
    // Update position metrics (including unrealized PnL)
    // This handles both SIMULATION and LIVE modes correctly
    updatePositionMetrics();
    
    // Debug logging for PnL calculation (only if significant change)
    const pnlChanged = Math.abs(STATE.inventory.unrealizedPnL) > 0.01;
    if (pnlChanged) {
        log(`   MTM PnL: $${STATE.inventory.unrealizedPnL.toFixed(2)} | PAYOFF: worst=$${STATE.payoff.worstCasePnl.toFixed(2)} if_yes=$${STATE.payoff.pnlIfYes.toFixed(2)} if_no=$${STATE.payoff.pnlIfNo.toFixed(2)}`, 'risk', 'DEBUG');
    }

    // Update utilization
    STATE.riskStatus.inventoryUtilization = {
        net: snapshot.inventoryUtilizationNet,
        gross: snapshot.inventoryUtilizationGross
    };

    // Determine risk status
    if (STATE.riskStatus.fillStreak >= CONFIG.RISK.KILL_SWITCH_STREAK) {
        STATE.riskStatus.status = 'KILLED';
    } else if (snapshot.inventoryUtilizationNet > 0.9 || snapshot.inventoryUtilizationGross > 0.9) {
        STATE.riskStatus.status = 'DANGER';
    } else if (snapshot.inventoryUtilizationNet > 0.7 || snapshot.inventoryUtilizationGross > 0.7) {
        STATE.riskStatus.status = 'WARNING';
    } else {
        STATE.riskStatus.status = 'SAFE';
    }
}

function updatePositionMetrics() {
    /**
     * Update position metrics and unrealized PnL
     * 
     * CRITICAL DISTINCTION:
     * - SIMULATION: PnL calculated from cost basis (mark-to-market)
     * - LIVE: PnL calculated from actual cash balance changes
     */
    
    const snapshot = computeExposureSnapshot();
    if (!snapshot) {
        // Fallback: just update basic metrics
        STATE.inventory.netPosition = STATE.inventory.yesShares - STATE.inventory.noShares;
        STATE.inventory.grossPosition = STATE.inventory.yesShares + STATE.inventory.noShares;
        STATE.inventory.lastUpdateTime = Date.now();
        return;
    }
    
    // UNIFIED: Use lot-based accounting for both SIMULATION and LIVE
    // This ensures consistent PnL calculation across modes

    // Method 1: LOT-BASED unrealized PnL (most accurate)
    const yesSummary = getLotsSummary('YES');
    const noSummary = getLotsSummary('NO');

    const yesCurrentValue = STATE.inventory.yesShares * snapshot.pYesMid;
    const noCurrentValue = STATE.inventory.noShares * snapshot.pNoMid;

    const yesUnrealized = yesCurrentValue - yesSummary.totalCostUsd;
    const noUnrealized = noCurrentValue - noSummary.totalCostUsd;
    const lotBasedUnrealizedPnL = yesUnrealized + noUnrealized;

    // Method 2: Portfolio-based total PnL (for validation in LIVE mode)
    const totalPortfolioValue = STATE.inventory.cash + yesCurrentValue + noCurrentValue;
    const portfolioTotalPnL = totalPortfolioValue - CONFIG.RISK.INITIAL_CASH;
    const portfolioUnrealizedPnL = portfolioTotalPnL - STATE.inventory.realizedPnL;

    // Use lot-based as primary, portfolio-based as fallback
    STATE.inventory.unrealizedPnL = lotBasedUnrealizedPnL;

    // Log discrepancy if methods disagree significantly (in LIVE mode)
    if (!CONFIG.SIMULATION_MODE) {
        const pnlDiscrepancy = Math.abs(lotBasedUnrealizedPnL - portfolioUnrealizedPnL);
        if (pnlDiscrepancy > 0.10) {
            log(`⚠️  PnL calculation discrepancy: lot-based=$${lotBasedUnrealizedPnL.toFixed(2)} vs portfolio=$${portfolioUnrealizedPnL.toFixed(2)} (diff=$${pnlDiscrepancy.toFixed(2)})`, 'accounting', 'WARN');
            log(`   Portfolio: cash=$${STATE.inventory.cash.toFixed(2)} + shares=$${(yesCurrentValue + noCurrentValue).toFixed(2)} = $${totalPortfolioValue.toFixed(2)}`, 'accounting', 'WARN');
            log(`   Initial: $${CONFIG.RISK.INITIAL_CASH.toFixed(2)} | Realized: $${STATE.inventory.realizedPnL.toFixed(2)}`, 'accounting', 'WARN');
            log(`   Lots: YES cost=$${yesSummary.totalCostUsd.toFixed(2)} value=$${yesCurrentValue.toFixed(2)} | NO cost=$${noSummary.totalCostUsd.toFixed(2)} value=$${noCurrentValue.toFixed(2)}`, 'accounting', 'WARN');
        }
    }
    
    // Update remaining metrics (same for both modes)
    STATE.inventory.netPosition = STATE.inventory.yesShares - STATE.inventory.noShares;
    STATE.inventory.grossPosition = STATE.inventory.yesShares + STATE.inventory.noShares;
    
    // Hedge ratio calculation
    const totalShares = STATE.inventory.grossPosition;
    if (totalShares > 0) {
        const hedged = Math.min(STATE.inventory.yesShares, STATE.inventory.noShares);
        STATE.inventory.hedgeRatio = (hedged * 2) / totalShares;
    } else {
        STATE.inventory.hedgeRatio = 0;
    }
    
    STATE.inventory.lastUpdateTime = Date.now();
}

async function reconcileWithAPI() {
    /**
     * LIVE ONLY: Periodic reconciliation with API balances
     * Detects discrepancies and auto-corrects STATE.inventory
     * Should be called periodically (e.g., every 60 seconds)
     */
    if (CONFIG.SIMULATION_MODE) return;
    if (!exchangeAdapter) return;
    
    try {
        const market = STATE.markets.get(STATE.selectedMarket);
        if (!market) return;
        
        // Get real balances from API
        const realUSDC = await exchangeAdapter.getBalance();
        const realYesShares = await exchangeAdapter.getOutcomeBalance(market.tokens.YES);
        const realNoShares = await exchangeAdapter.getOutcomeBalance(market.tokens.NO);
        
        // Check for discrepancies
        const cashDiff = Math.abs(realUSDC - STATE.inventory.cash);
        const yesDiff = Math.abs(realYesShares - STATE.inventory.yesShares);
        const noDiff = Math.abs(realNoShares - STATE.inventory.noShares);
        
        const threshold = 0.1; // 0.1 USDC or shares
        
        if (cashDiff > threshold || yesDiff > threshold || noDiff > threshold) {
            log(`⚠️ API RECONCILE: Discrepancy detected`, 'oms', 'WARN');
            log(`  USDC: API=${realUSDC.toFixed(2)} vs State=${STATE.inventory.cash.toFixed(2)} (diff=${cashDiff.toFixed(2)})`, 'oms', 'WARN');
            log(`  YES: API=${realYesShares.toFixed(2)} vs State=${STATE.inventory.yesShares.toFixed(2)} (diff=${yesDiff.toFixed(2)})`, 'oms', 'WARN');
            log(`  NO: API=${realNoShares.toFixed(2)} vs State=${STATE.inventory.noShares.toFixed(2)} (diff=${noDiff.toFixed(2)})`, 'oms', 'WARN');
            
            // Auto-correction with logging
            log(`  Correcting state to match API...`, 'oms', 'WARN');
            
            STATE.inventory.cash = realUSDC;
            STATE.inventory.yesShares = realYesShares;
            STATE.inventory.noShares = realNoShares;
            
            // If we have shares but no entry price, set to current mid
            const snapshot = computeExposureSnapshot();
            if (snapshot) {
                if (STATE.inventory.yesShares > 0.1 && STATE.inventory.costBasis.yes === 0) {
                    STATE.inventory.costBasis.yes = snapshot.pYesMid;
                    log(`  Set YES cost basis to current price: ${snapshot.pYesMid.toFixed(4)}`, 'oms', 'WARN');
                }
                if (STATE.inventory.noShares > 0.1 && STATE.inventory.costBasis.no === 0) {
                    STATE.inventory.costBasis.no = snapshot.pNoMid;
                    log(`  Set NO cost basis to current price: ${snapshot.pNoMid.toFixed(4)}`, 'oms', 'WARN');
                }
            }
            
            // Recalculate PnL
            updatePositionMetrics();
            
            log(`✅ API RECONCILE: State corrected`, 'oms', 'INFO');
        }
        
    } catch (err) {
        log(`⚠️ reconcileWithAPI failed: ${err.message}`, 'oms', 'WARN');
    }
}

async function reconcilePositionsFromChainOrApi() {
    /**
     * LIVE ONLY: Reconcile STATE.inventory positions with real on-chain balances
     * In LIVE mode, fills may come from UI/web or other bots, so we need to sync from source of truth
     */

    if (CONFIG.SIMULATION_MODE) {
        // In simulation, STATE.inventory is the source of truth
        return;
    }

    if (!exchangeAdapter) {
        log(`⚠️  Cannot reconcile: ExchangeAdapter not initialized`, 'oms', 'WARN');
        return;
    }

    const market = STATE.markets.get(STATE.selectedMarket);
    if (!market) {
        log(`⚠️  Cannot reconcile: No market selected`, 'oms', 'WARN');
        return;
    }

    try {
        // Get real on-chain balances for outcome tokens
        const realYesBalance = await exchangeAdapter.getOutcomeBalance(market.tokens.YES);
        const realNoBalance = await exchangeAdapter.getOutcomeBalance(market.tokens.NO);

        const oldYes = STATE.inventory.yesShares;
        const oldNo = STATE.inventory.noShares;

        // Get previous balances for synthetic fill detection
        const lastYes = STATE.live.lastOutcomeBalances.yes;
        const lastNo = STATE.live.lastOutcomeBalances.no;

        const TOLERANCE = 0.01;  // Consider differences < 0.01 as rounding errors

        const yesDiff = Math.abs(realYesBalance - oldYes);
        const noDiff = Math.abs(realNoBalance - oldNo);

        if (yesDiff > TOLERANCE || noDiff > TOLERANCE) {
            log(`🔄 POSITION RECONCILE:`, 'oms', 'INFO');
            log(`   YES: ${fmt(oldYes, 2)} → ${fmt(realYesBalance, 2)} (diff: ${fmt(yesDiff, 2)})`, 'oms', 'INFO');
            log(`   NO:  ${fmt(oldNo, 2)} → ${fmt(realNoBalance, 2)} (diff: ${fmt(noDiff, 2)})`, 'oms', 'INFO');

            // SYNTHETIC FILLS: Detect balance changes for fill history
            // Compare with last known balances, not STATE.inventory (which might be stale)
            const deltaYes = realYesBalance - lastYes;
            const deltaNo = realNoBalance - lastNo;

            const MIN_FILL_SIZE = 0.05;  // Minimum size to consider as a fill (avoid noise)

            if (Math.abs(deltaYes) >= MIN_FILL_SIZE) {
                // CRITICAL: Estimate execution price from recent orderbook
                // Use best bid/ask depending on side (conservative estimate)
                const yesOrderbook = STATE.orderbooks.get(market?.tokens?.YES);
                const side = deltaYes > 0 ? 'BUY' : 'SELL';
                let estimatedPrice = null;
                
                if (yesOrderbook) {
                    if (side === 'BUY') {
                        // BUY fill → likely executed at best ask (we paid ask)
                        estimatedPrice = yesOrderbook.asks[0]?.price || yesOrderbook.mid || null;
                    } else {
                        // SELL fill → likely executed at best bid (we received bid)
                        estimatedPrice = yesOrderbook.bids[0]?.price || yesOrderbook.mid || null;
                    }
                }
                
                // CRITICAL: If price still unknown, this is a BUG
                const priceSource = estimatedPrice ? (side === 'BUY' ? 'best_ask' : 'best_bid') : 'FALLBACK_0.5';
                if (!estimatedPrice) {
                    log(`${icon('critical')} SYNTHETIC FILL WITHOUT PRICE: YES ${side} ${Math.abs(deltaYes).toFixed(2)} - CANNOT DETERMINE EXECUTION PRICE`, 'oms', 'ERROR');
                    estimatedPrice = 0.5;  // Fallback to 0.5 (but log as ERROR)
                }

                // Calculate proper accounting values
                const probabilityPrice = estimatedPrice;
                const usdPricePerShare = probabilityPrice;
                const costUsd = Math.abs(deltaYes) * usdPricePerShare;
                const expectedPayoutUsd = Math.abs(deltaYes) * 1.0;
                const notional = Math.abs(deltaYes) * estimatedPrice;
                const newYesQty = STATE.inventory.yesShares + deltaYes;

                // Update lots for synthetic fill
                if (side === 'BUY') {
                    addLot('YES', Math.abs(deltaYes), probabilityPrice, 'SYNTHETIC');
                } else {
                    removeLotsFIFO('YES', Math.abs(deltaYes), probabilityPrice);
                }

                const syntheticFill = {
                    timestamp: Date.now(),
                    token: 'YES',
                    side: side,
                    size: Math.abs(deltaYes),
                    price: estimatedPrice,
                    notional: notional,
                    synthetic: true,
                    source: 'SYNTHETIC_FILL',
                    orderId: null,
                    inventoryAfter: { yes: newYesQty, no: STATE.inventory.noShares },
                    pnl: null,  // Cannot calculate realized PnL accurately from balance delta
                    priceSource: priceSource,  // Track where price came from
                    reason: 'balance_reconciliation'
                };

                // Use UNSHIFT (newest first)
                SCREEN_BUFFERS.fillHistory.unshift(syntheticFill);
                if (SCREEN_BUFFERS.fillHistory.length > MAX_FILL_HISTORY) {
                    SCREEN_BUFFERS.fillHistory.pop();  // Remove oldest
                }

                STATE.stats.fills++;

                // ENHANCED LOGGING with 4 PRICE LEVELS
                log(`${icon('money')} [SYN] YES ${side} ${Math.abs(deltaYes).toFixed(2)}`, 'oms', 'INFO');
                log(`   reason=balance_reconciliation | price_source=${priceSource}`, 'oms', 'INFO');
                if (side === 'BUY') {
                    log(
                        `   prob_ref=${probabilityPrice.toFixed(4)} | usd_ref=${usdPricePerShare.toFixed(4)} | ` +
                        `cost=$${costUsd.toFixed(2)} | payout_if_win=$${expectedPayoutUsd.toFixed(2)} | ` +
                        `expected_pnl=+$${(expectedPayoutUsd - costUsd).toFixed(2)} | inv.YES=${newYesQty.toFixed(1)}`,
                        'oms', 'INFO'
                    );
                } else {
                    const proceeds = probabilityPrice * Math.abs(deltaYes);
                    log(
                        `   prob_ref=${probabilityPrice.toFixed(4)} | usd_ref=${usdPricePerShare.toFixed(4)} | ` +
                        `proceeds=$${proceeds.toFixed(2)} | inv.YES=${newYesQty.toFixed(1)}`,
                        'oms', 'INFO'
                    );
                }
            }

            if (Math.abs(deltaNo) >= MIN_FILL_SIZE) {
                // CRITICAL: Estimate execution price from recent orderbook
                const noOrderbook = STATE.orderbooks.get(market?.tokens?.NO);
                const side = deltaNo > 0 ? 'BUY' : 'SELL';
                let estimatedPrice = null;

                if (noOrderbook) {
                    if (side === 'BUY') {
                        estimatedPrice = noOrderbook.asks[0]?.price || noOrderbook.mid || null;
                    } else {
                        estimatedPrice = noOrderbook.bids[0]?.price || noOrderbook.mid || null;
                    }
                }

                const priceSource = estimatedPrice ? (side === 'BUY' ? 'best_ask' : 'best_bid') : 'FALLBACK_0.5';
                if (!estimatedPrice) {
                    log(`${icon('critical')} SYNTHETIC FILL WITHOUT PRICE: NO ${side} ${Math.abs(deltaNo).toFixed(2)} - CANNOT DETERMINE EXECUTION PRICE`, 'oms', 'ERROR');
                    estimatedPrice = 0.5;
                }

                // Calculate proper accounting values
                const probabilityPrice = estimatedPrice;
                const usdPricePerShare = probabilityPrice;
                const costUsd = Math.abs(deltaNo) * usdPricePerShare;
                const expectedPayoutUsd = Math.abs(deltaNo) * 1.0;
                const notional = Math.abs(deltaNo) * estimatedPrice;
                const newNoQty = STATE.inventory.noShares + deltaNo;

                // Update lots for synthetic fill
                if (side === 'BUY') {
                    addLot('NO', Math.abs(deltaNo), probabilityPrice, 'SYNTHETIC');
                } else {
                    removeLotsFIFO('NO', Math.abs(deltaNo), probabilityPrice);
                }

                const syntheticFill = {
                    timestamp: Date.now(),
                    token: 'NO',
                    side: side,
                    size: Math.abs(deltaNo),
                    price: estimatedPrice,
                    notional: notional,
                    synthetic: true,
                    source: 'SYNTHETIC_FILL',
                    orderId: null,
                    inventoryAfter: { yes: STATE.inventory.yesShares, no: newNoQty },
                    pnl: null,
                    priceSource: priceSource,
                    reason: 'balance_reconciliation'
                };

                SCREEN_BUFFERS.fillHistory.unshift(syntheticFill);
                if (SCREEN_BUFFERS.fillHistory.length > MAX_FILL_HISTORY) {
                    SCREEN_BUFFERS.fillHistory.pop();
                }

                STATE.stats.fills++;

                // ENHANCED LOGGING with 4 PRICE LEVELS
                log(`${icon('money')} [SYN] NO ${side} ${Math.abs(deltaNo).toFixed(2)}`, 'oms', 'INFO');
                log(`   reason=balance_reconciliation | price_source=${priceSource}`, 'oms', 'INFO');
                if (side === 'BUY') {
                    log(
                        `   prob_ref=${probabilityPrice.toFixed(4)} | usd_ref=${usdPricePerShare.toFixed(4)} | ` +
                        `cost=$${costUsd.toFixed(2)} | payout_if_win=$${expectedPayoutUsd.toFixed(2)} | ` +
                        `expected_pnl=+$${(expectedPayoutUsd - costUsd).toFixed(2)} | inv.NO=${newNoQty.toFixed(1)}`,
                        'oms', 'INFO'
                    );
                } else {
                    const proceeds = probabilityPrice * Math.abs(deltaNo);
                    log(
                        `   prob_ref=${probabilityPrice.toFixed(4)} | usd_ref=${usdPricePerShare.toFixed(4)} | ` +
                        `proceeds=$${proceeds.toFixed(2)} | inv.NO=${newNoQty.toFixed(1)}`,
                        'oms', 'INFO'
                    );
                }
            }

            // Update last known balances for next comparison
            STATE.live.lastOutcomeBalances.yes = realYesBalance;
            STATE.live.lastOutcomeBalances.no = realNoBalance;

            // Update STATE.inventory to match reality
            STATE.inventory.yesShares = realYesBalance;
            STATE.inventory.noShares = realNoBalance;

            // Recalculate position metrics
            updatePositionMetrics();

            log(`   Updated: Net=${fmt(STATE.inventory.netPosition, 2)}, Gross=${fmt(STATE.inventory.grossPosition, 2)}`, 'oms', 'INFO');

            // Check if position exists and force UNWIND mode
            const absNet = Math.abs(STATE.inventory.netPosition);
            const gross = STATE.inventory.grossPosition;

            if (absNet > 0.5 || gross > 0.5) {
                log(`⚠️  Position detected after reconcile: absNet=${fmt(absNet, 2)}, gross=${fmt(gross, 2)}`, 'mainloop', 'WARN');

                // ALWAYS force UNWIND when position exists
                // This ensures bot will close positions even if below risk limits
                STATE.riskStatus.forcedUnwind = true;
                STATE.riskStatus.mode = 'UNWIND';
                log(`🔄 Forcing UNWIND mode due to open position`, 'oms', 'INFO');

                // Check against risk limits for severity
                const netUtilization = absNet / CONFIG.RISK.MAX_NET_SHARES;
                const grossUtilization = gross / CONFIG.RISK.MAX_GROSS_SHARES;

                if (netUtilization > 0.7 || grossUtilization > 0.7) {
                    log(`🚨 Position exceeds 70% of limits - URGENT UNWIND`, 'oms', 'WARN');
                    log(`   Net util: ${fmt(netUtilization * 100, 1)}%, Gross util: ${fmt(grossUtilization * 100, 1)}%`, 'oms', 'WARN');
                } else {
                    log(`   Position within limits (Net: ${fmt(netUtilization * 100, 1)}%, Gross: ${fmt(grossUtilization * 100, 1)}%)`, 'oms', 'INFO');
                }
            }
        } else {
            // No significant change, but still update last known balances
            STATE.live.lastOutcomeBalances.yes = realYesBalance;
            STATE.live.lastOutcomeBalances.no = realNoBalance;

            // Rate-limit "no change" logs to once per 60 seconds
            if (!STATE.live.lastPositionReconcileLog) {
                STATE.live.lastPositionReconcileLog = 0;
            }

            const now = Date.now();
            if (now - STATE.live.lastPositionReconcileLog > 60000) {
                log(`✓ Position reconcile: positions match (YES=${fmt(realYesBalance, 2)}, NO=${fmt(realNoBalance, 2)})`, 'oms', 'DEBUG');
                STATE.live.lastPositionReconcileLog = now;
            }
        }

    } catch (err) {
        log(`❌ Position reconcile failed: ${err.message}`, 'oms', 'ERROR');
    }
}

// ============================================================================
// MARKET SWITCHING
// ============================================================================

function resetMarketState(reason = 'manual') {
    /**
     * Reset market state when switching markets
     *
     * @param {string} reason - 'expiry' (market expired) or 'manual' (user switched)
     *
     * CRITICAL DISTINCTION:
     * - expiry: Keep cash, realizedPnL, fillHistory (continuous session)
     * - manual: Full reset (start fresh)
     */

    // Clear market data
    STATE.orderbooks.clear();
    STATE.trades = [];

    // Reset trade flow detection
    STATE.tradeFlow = {
        type: 'NOISE',
        direction: null,
        confidence: 0,
        metrics: {}
    };

    // Reset fair value
    STATE.fairValue = {
        yes: { mid: 0.5, ema: 0.5, final: 0.5 },
        no: { mid: 0.5, ema: 0.5, final: 0.5 },
        yesNoMismatch: 0
    };

    // Preserve cash & PnL on expiry, reset on manual switch
    const preservedCash = (reason === 'expiry') ? STATE.inventory.cash : CONFIG.RISK.INITIAL_CASH;
    const preservedPnL = (reason === 'expiry') ? STATE.inventory.realizedPnL : 0;

    // CRITICAL: Reset inventory completely
    // Cannot transfer position from one market to another
    STATE.inventory = {
        yesShares: 0,
        noShares: 0,
        netPosition: 0,
        grossPosition: 0,
        cash: preservedCash,
        reservedCash: 0,
        costBasis: { yes: 0, no: 0 },
        unrealizedPnL: 0,
        realizedPnL: preservedPnL,
        hedgeRatio: 0,
        lastUpdateTime: Date.now()
    };

    // CRITICAL: Clear lot-based accounting
    STATE.lots = {
        yes: [],
        no: []
    };

    // Clear target quotes
    STATE.targetQuotes = {
        YES: { bid: null, ask: null, bidSize: 0, askSize: 0 },
        NO: { bid: null, ask: null, bidSize: 0, askSize: 0 }
    };

    // CRITICAL: Reset risk status completely
    // Old fill streaks, defensive modes, urgency must not carry over
    STATE.riskStatus = {
        status: 'SAFE',
        mode: 'FLAT',

        stateEnterTime: Date.now(),
        stateReason: 'market_switch',
        inventoryDebtStartTime: null,
        maxTimeInInventory: 300000,

        fillStreak: 0,
        fillStreakSide: null,
        fillStreaks: {
            YES_BUY: 0,
            YES_SELL: 0,
            NO_BUY: 0,
            NO_SELL: 0
        },
        forcedUnwind: false,
        defensiveMode: false,
        defensiveCooldownUntil: 0,
        defensiveCanceledOnce: false,
        inventoryUtilization: 0,
        lastFillTime: null,

        urgency: 0,
        urgencyFactors: {
            inventoryMagnitude: 0,
            timeInPosition: 0,
            timeToExpiry: 0,
            priceMomentum: 0,
            orderbookImbalance: 0
        },

        unwindEscalation: {
            level: 0,
            lastEscalationTime: 0,
            lastFillInUnwind: 0,
            attemptsSinceLastFill: 0
        },

        maxLossPerUnwind: 0.05,
        totalLossesAccepted: 0
    };

    // Clear orders (should already be canceled, but ensure clean state)
    STATE.orders.active.clear();
    STATE.orders.byToken.clear();
    STATE.orders.lastReplaceTs.clear();
    STATE.orders.pendingCancels.clear();

    // Preserve fill history on expiry (shows continuous trading session)
    if (reason === 'manual') {
        SCREEN_BUFFERS.fillHistory = [];
    }
    // On expiry: keep fillHistory intact to show full session history

    // CRITICAL: Reset edge alive state (irreversibility is per-market)
    const now = Date.now();
    STATE.edge = {
        edgeAlive: true,
        edgeAliveReason: reason === 'expiry' ? 'market_expired' : 'manual_switch',
        edgeAliveSince: now,
        irreversible: false,  // Reset irreversibility for new market

        // Reset streaks for new market
        marketEnterTs: now,
        badStreak: 0,
        goodStreak: 0,
        lastBadReason: null,
        lastGoodReason: null,
        lastEdgeEvalWindowStartTs: null,

        metrics: {
            tradeFlowSymmetry: 1.0,
            orderbookRefillRate: 1.0,
            timeToExpiry: 999,
            tradesInWindow: 0,
            updatesInWindow: 0
        }
    };

    // Activate warm-up period
    STATE.marketWarmup.active = true;
    STATE.marketWarmup.startTime = Date.now();

    const resetType = reason === 'expiry' ? 'CONTINUOUS (cash+PnL preserved)' : 'FULL (fresh start)';
    log(`🔄 Market state RESET [${resetType}] - entering warm-up period`, 'system');
}

async function checkAndSwitchExpiredMarket() {
    /**
     * Check if current market has expired and switch to next available market
     */
    const currentMarket = STATE.markets.get(STATE.selectedMarket);
    if (!currentMarket) return;

    const now = Date.now();
    const endDate = new Date(currentMarket.endDate).getTime();

    // Check if current market has expired
    if (now >= endDate) {
        log('⚠️  Current market has EXPIRED', 'system');

        // 1. Cancel all orders first
        await cancelAll();

        // 2. Find next market expiring SOONEST from sorted list
        // allAvailableMarkets is already sorted by expiry time (soonest first)
        const nextMarket = STATE.allAvailableMarkets.find(m => {
            const marketEndDate = new Date(m.endDate).getTime();
            return marketEndDate > now;  // First non-expired market = soonest
        });

        if (nextMarket) {
            const minutesToExpiry = Math.round((new Date(nextMarket.endDate) - now) / 60000);

            // Save current session state before reset
            const sessionCash = STATE.inventory.cash;
            const sessionPnL = STATE.inventory.realizedPnL;
            const sessionFills = SCREEN_BUFFERS.fillHistory.length;

            log(`\n🔄 Switching to NEXT SOONEST market:`, 'system');
            log(`   [${minutesToExpiry}min / ${(minutesToExpiry / 60).toFixed(1)}h] ${nextMarket.question}`, 'system');
            log(`   💰 Session continues: Cash=$${sessionCash.toFixed(2)} PnL=$${sessionPnL.toFixed(2)} Fills=${sessionFills}`, 'system');

            // FILE LOG: Market switch (expiry)
            logEvent('MARKET_SWITCH', {
                reason: 'expiry',
                from: {
                    conditionId: currentMarket.conditionId,
                    question: currentMarket.question
                },
                to: {
                    conditionId: nextMarket.conditionId,
                    question: nextMarket.question,
                    minutesToExpiry: minutesToExpiry
                },
                sessionState: {
                    cash: sessionCash,
                    realizedPnL: sessionPnL,
                    fillCount: sessionFills
                }
            });

            // Check if next market has orderbook (but don't skip if it doesn't)
            const hasOrderbook = await validateMarketTokens(nextMarket);
            if (hasOrderbook) {
                log(`   ✅ Orderbook available - ready to trade`, 'system');
            } else {
                log(`   ⏳ Orderbook not ready - will wait for it`, 'system');
            }

            // 3. CRITICAL: Reset state (CONTINUOUS - preserve cash/PnL)
            resetMarketState('expiry');

            // 4. Update market selection
            STATE.markets.set(nextMarket.conditionId, nextMarket);
            STATE.selectedMarket = nextMarket.conditionId;

            // 5. Reconnect WebSocket to new market
            if (STATE.ws) {
                STATE.ws.close();
            }

            // Wait briefly then reconnect
            await new Promise(resolve => setTimeout(resolve, 1000));
            initializeOrderbookScanner();

            // Reconcile positions after market switch
            // This is critical to not "lose" positions when switching markets
            await reconcilePositionsFromChainOrApi();

            log(`SUCCESS: Switched to: ${nextMarket.question}`, 'system');
            log(`   URL: https://polymarket.com/event/${nextMarket.slug}`, 'system');
        } else {
            log('❌ No available markets to switch to', 'system');
            STATE.riskStatus.status = 'KILLED';
        }
    }
}

// ============================================================================
// MAIN LOOP & RECONCILIATION
// ============================================================================

async function mainLoop() {
    try {
        // LIVE: Check if paused
        if (!CONFIG.SIMULATION_MODE && STATE.live.paused) {
            log(`⏸️  Bot paused: ${STATE.live.pauseReason}`, 'mainloop');
            clearTargetQuotes();
            return;
        }

        // Check if current market has expired
        await checkAndSwitchExpiredMarket();

        // CRITICAL: Reconcile positions BEFORE any early returns
        // This ensures STATE.inventory is up-to-date even if orderbook/snapshot not ready
        if (!CONFIG.SIMULATION_MODE) {
            await reconcilePositionsFromChainOrApi();

            // Periodic API reconciliation (every 60 seconds)
            const now = Date.now();
            if (!STATE.live.lastAPIReconcile || (now - STATE.live.lastAPIReconcile) > 60000) {
                await reconcileWithAPI();
                STATE.live.lastAPIReconcile = now;
            }

            // CRITICAL: Full accounting reconciliation (every 5 minutes)
            await reconcileAccounting();

            // CRITICAL: Price correction reconciliation (every 5 minutes)
            // This fixes the limit vs executed price discrepancy
            const now2 = Date.now();
            if (!STATE.live.lastFillReconcileTime || (now2 - STATE.live.lastFillReconcileTime) > 5 * 60 * 1000) {
                await reconcileActualFillsWithApi();
                STATE.live.lastFillReconcileTime = now2;
            }
        }

        // Check warm-up period
        if (STATE.marketWarmup.active) {
            const market = STATE.markets.get(STATE.selectedMarket);
            if (!market) return;

            const yesBook = STATE.orderbooks.get(market.tokens.YES);
            const noBook = STATE.orderbooks.get(market.tokens.NO);

            // Check if we have valid orderbooks with liquidity
            const hasValidOrderbooks = yesBook && noBook &&
                                      yesBook.bids.length > 0 &&
                                      yesBook.asks.length > 0 &&
                                      noBook.bids.length > 0 &&
                                      noBook.asks.length > 0;

            if (hasValidOrderbooks) {
                STATE.marketWarmup.active = false;
                const warmupDuration = ((Date.now() - STATE.marketWarmup.startTime) / 1000).toFixed(1);
                log(`SUCCESS: Warm-up complete (${warmupDuration}s) - orderbooks ready`, 'system');
            } else {
                if (CONFIG.SIMULATION_MODE) {
                    const yesValid = yesBook && yesBook.bids.length > 0 && yesBook.asks.length > 0;
                    const noValid = noBook && noBook.bids.length > 0 && noBook.asks.length > 0;
                    log(`DEBUG: Warm-up: waiting for valid orderbooks (YES=${yesValid ? 'OK' : 'NO'}, NO=${noValid ? 'OK' : 'NO'})`, 'mainloop');
                } else {
                    log(`WAIT: Warm-up: waiting for orderbooks (YES=${!!yesBook}, NO=${!!noBook})`, 'mainloop');
                }
                clearTargetQuotes();
                return;
            }
        }

        // 1. Compute snapshot
        const snapshot = computeExposureSnapshot();
        if (!snapshot) {
            // No snapshot available, but check if we have positions to close
            const hasPosition = STATE.inventory.grossPosition > 0.01;

            if (hasPosition) {
                log(`⚠️  Have position (net=${STATE.inventory.netPosition.toFixed(1)}, gross=${STATE.inventory.grossPosition.toFixed(1)}) but no snapshot - forcing UNWIND mode`, 'mainloop', 'WARN');
                STATE.riskStatus.forcedUnwind = true;
                STATE.riskStatus.mode = 'UNWIND';

                // Try to close positions even without snapshot
                const market = STATE.markets.get(STATE.selectedMarket);
                if (market) {
                    const yesBook = STATE.orderbooks.get(market.tokens.YES);
                    const noBook = STATE.orderbooks.get(market.tokens.NO);

                    if (yesBook && noBook) {
                        log(`📊 Attempting close-only orders without snapshot`, 'mainloop', 'INFO');
                        // Use simplified close logic
                        await closePositionsWithoutSnapshot(market, yesBook, noBook);
                    } else {
                        log(`⏳ Have position but no orderbook yet - waiting to unwind`, 'mainloop', 'WARN');
                    }
                }

                return;
            }

            if (CONFIG.SIMULATION_MODE) {
                log('DEBUG: mainLoop: No snapshot - waiting for market data...', 'mainloop');
            } else {
                log('Waiting for market data...', 'mainloop');
            }
            clearTargetQuotes();
            return;
        }

        log('Starting main loop cycle', 'mainloop');

        // 2. Calculate fair value
        calculateFairValue(snapshot);
        log(`DATA: Fair Value: YES=${STATE.fairValue.yes.final.toFixed(4)}, NO=${STATE.fairValue.no.final.toFixed(4)}`, 'mainloop');

        // 3. Check arbitrage
        const arbSignal = checkYesNoArbitrage(snapshot);

        // If significant arbitrage detected and YES+NO mismatch is large, enter defensive mode
        if (arbSignal.hasArb && STATE.fairValue.yesNoMismatch > 0.02) {
            log(`WARNING: Large YES+NO mismatch (${(STATE.fairValue.yesNoMismatch * 100).toFixed(2)}%) + arb detected, entering defensive mode`, 'arb');
            STATE.riskStatus.defensiveMode = true;
            STATE.riskStatus.defensiveCooldownUntil = Date.now() + 5000;  // 5s cooldown
        }

        // 4. Update risk
        updateInventoryAndRisk(snapshot);
        log(`BALANCE: Inventory: Net=${snapshot.netShares.toFixed(1)}, Gross=${snapshot.grossShares.toFixed(1)}`, 'mainloop');

        // 5. Generate target quotes
        generateTargetQuotes(snapshot);

        // 6. Reconcile orders with targets
        await reconcileQuotes();
        log(`SUCCESS: Reconciled orders`, 'mainloop');

        // 7. Update display
        logSystemStatus();

    } catch (error) {
        log(`ERROR: Main loop error: ${error.message}`, 'error');
        console.error(error);
    }
}

async function reconcileQuotes() {
    /**
     * CRITICAL FIX: KILLED state should NOT prevent unwind
     *
     * Bug: if KILLED → cancelAll + return → target quotes never placed
     * Fix: KILLED activates forcedUnwind, continues to place closing orders
     */

    const market = STATE.markets.get(STATE.selectedMarket);
    if (!market) return;

    // KILLED mode: set forcedUnwind and continue (don't return!)
    if (STATE.riskStatus.status === 'KILLED') {
        log(`${icon('critical')} KILLED: Activating forced unwind (closing positions)`, 'oms');
        STATE.riskStatus.forcedUnwind = true;
        // DO NOT return - continue to place closing orders below
    }

    // Defensive mode (not expired): cancel ONCE then skip placing
    if (STATE.riskStatus.defensiveMode &&
        Date.now() < STATE.riskStatus.defensiveCooldownUntil &&
        !STATE.riskStatus.forcedUnwind) {

        // Cancel once at start of defensive period, then just skip
        // if (!STATE.riskStatus.defensiveCanceledOnce) {
        //     await cancelAll();
        //     STATE.riskStatus.defensiveCanceledOnce = true;
        //     log(`${icon('warn')} DEFENSIVE: Orders canceled (once), waiting for cooldown`, 'oms');
        // }
        // // Skip placing new orders during cooldown
        // return;

        if (!STATE.riskStatus.defensiveCanceledOnce) {
            const market = STATE.markets.get(STATE.selectedMarket);
            if (market) {
                const dangerSide = (STATE.tradeFlow.direction === "BUY") ? "SELL" : "BUY";
                await cancelSideForToken(market.tokens.YES, dangerSide);
                await cancelSideForToken(market.tokens.NO, dangerSide);
            }
            STATE.riskStatus.defensiveCanceledOnce = true;
        }

    }

    // Forced unwind mode: cancel all FIRST, then place ONLY closing-side orders
    // This includes KILLED state (which sets forcedUnwind above)
    if (STATE.riskStatus.forcedUnwind) {
        await cancelAll();
        log('🚨 UNWIND: Placing closing-side orders only', 'oms');

        // Place only non-null quotes (closing side)
        if (STATE.targetQuotes.YES.bid !== null && STATE.targetQuotes.YES.bidSize > 0) {
            await replaceQuotesForToken(
                market.tokens.YES,
                STATE.targetQuotes.YES.bid,
                null,  // No ask side
                STATE.targetQuotes.YES.bidSize,
                0
            );
        }
        if (STATE.targetQuotes.YES.ask !== null && STATE.targetQuotes.YES.askSize > 0) {
            await replaceQuotesForToken(
                market.tokens.YES,
                null,  // No bid side
                STATE.targetQuotes.YES.ask,
                0,
                STATE.targetQuotes.YES.askSize
            );
        }
        if (STATE.targetQuotes.NO.bid !== null && STATE.targetQuotes.NO.bidSize > 0) {
            await replaceQuotesForToken(
                market.tokens.NO,
                STATE.targetQuotes.NO.bid,
                null,
                STATE.targetQuotes.NO.bidSize,
                0
            );
        }
        if (STATE.targetQuotes.NO.ask !== null && STATE.targetQuotes.NO.askSize > 0) {
            await replaceQuotesForToken(
                market.tokens.NO,
                null,
                STATE.targetQuotes.NO.ask,
                0,
                STATE.targetQuotes.NO.askSize
            );
        }
        return;
    }

    // Normal mode: reconcile both YES and NO
    await replaceQuotesForToken(
        market.tokens.YES,
        STATE.targetQuotes.YES.bid,
        STATE.targetQuotes.YES.ask,
        STATE.targetQuotes.YES.bidSize,
        STATE.targetQuotes.YES.askSize
    );

    await replaceQuotesForToken(
        market.tokens.NO,
        STATE.targetQuotes.NO.bid,
        STATE.targetQuotes.NO.ask,
        STATE.targetQuotes.NO.bidSize,
        STATE.targetQuotes.NO.askSize
    );
}

function startMainLoop() {
    setInterval(mainLoop, CONFIG.UPDATE_INTERVAL_MS);
}

// ============================================================================
// MARKET DISCOVERY
// ============================================================================

async function findCryptoMarkets() {
    STATE.marketScannerStatus = 'scanning';
    STATE.lastScanMarketsFound = 0;

    const allCryptoMarkets = [];
    let offset = 0;
    const limit = 500;
    const maxPages = 50;

    log('🔍 Scanning for crypto markets...', 'system');

    for (let page = 0; page < maxPages; page++) {
        const response = await fetch(
            'https://gamma-api.polymarket.com/markets?' +
            `closed=false&` +
            `limit=${limit}&` +
            `offset=${offset}&` +
            `order=volume&` +
            `ascending=false`
        );

        if (!response.ok) break;

        const markets = await response.json();
        if (markets.length === 0) break;

        const cryptoMatches = markets.filter(m => {
            const question = (m.question || '').toLowerCase();
            return m.active && !m.closed && m.enableOrderBook &&
                (question.includes('bitcoin') || question.includes('ethereum') || question.includes('solana') || question.includes('xrp')) &&
                question.includes('up') &&
                question.includes('down');
        });

        if (cryptoMatches.length > 0) {
            for (const market of cryptoMatches) {
                // ============================================================
                // STRUCTURE-BASED VALIDATION (not just text matching)
                // ============================================================

                // Step 1: Parse token IDs
                let tokenIds = [];
                if (Array.isArray(market.clobTokenIds)) {
                    tokenIds = market.clobTokenIds;
                } else if (typeof market.clobTokenIds === 'string') {
                    try {
                        tokenIds = JSON.parse(market.clobTokenIds);
                    } catch (e) {
                        continue; // Skip invalid JSON
                    }
                }

                // Step 2: Verify binary market structure
                if (tokenIds.length !== 2) {
                    continue; // Not a binary market
                }

                // Step 3: Verify token IDs are valid (non-empty strings)
                if (!tokenIds[0] || !tokenIds[1] ||
                    typeof tokenIds[0] !== 'string' ||
                    typeof tokenIds[1] !== 'string') {
                    continue; // Invalid token IDs
                }

                // Step 4: Verify required fields exist
                if (!market.conditionId || !market.question || !market.endDate) {
                    continue; // Missing critical fields
                }

                // Step 5: Verify market is actually tradeable
                // Check that end date is in the future and meets minimum time requirement
                const endDate = new Date(market.endDate);
                const now = new Date();
                const hoursToExpiry = (endDate - now) / (1000 * 60 * 60);

                if (isNaN(endDate.getTime()) || hoursToExpiry < CONFIG.MARKET_FILTERS.MIN_TIME_TO_EXPIRY_HOURS) {
                    continue; // Invalid or doesn't meet minimum time requirement
                }

                // Step 6: Verify outcomes field (if available) indicates binary
                if (market.outcomes && Array.isArray(market.outcomes)) {
                    if (market.outcomes.length !== 2) {
                        continue; // Not binary
                    }
                    // Could also check outcome names contain "Yes"/"No" or "Up"/"Down"
                }

                // Step 7: All checks passed - this is a valid binary market
                allCryptoMarkets.push({
                    conditionId: market.conditionId,
                    question: market.question,
                    slug: market.slug,
                    endDate: market.endDate,
                    tokens: {
                        YES: tokenIds[0],
                        NO: tokenIds[1]
                    },
                    // Store validation metadata
                    validated: true,
                    validationTime: Date.now()
                });
            }
        }

        // Update progress
        STATE.lastScanMarketsFound = allCryptoMarkets.length;
        if (page % 5 === 0) {
            log(`DATA: Scanned ${page + 1} pages, found ${allCryptoMarkets.length} crypto markets`, 'system');
        }

        offset += limit;
    }

    STATE.marketScannerStatus = 'completed';
    log(`SUCCESS: Scan complete: ${allCryptoMarkets.length} crypto markets found`, 'system');
    return allCryptoMarkets;
}

function filterAndSortMarkets(markets) {
    const now = new Date();

    // Filter out expired markets
    const futureMarkets = markets.filter(m => {
        const endDate = new Date(m.endDate);
        return endDate > now;
    });

    // Sort by expiry time: EARLIEST first (ascending order)
    // If expiry time is the same, sort alphabetically by question
    futureMarkets.sort((a, b) => {
        const dateA = new Date(a.endDate);
        const dateB = new Date(b.endDate);
        const timeDiff = dateA.getTime() - dateB.getTime();

        // If times are equal, sort alphabetically by question
        if (timeDiff === 0) {
            return a.question.localeCompare(b.question);
        }

        return timeDiff;  // Ascending: soonest first
    });

    // Log first few to verify sorting
    if (futureMarkets.length > 0) {
        log(`Sorted ${futureMarkets.length} markets by expiry (soonest first):`, 'system');
        futureMarkets.slice(0, 3).forEach((m, i) => {
            const mins = Math.round((new Date(m.endDate) - now) / 60000);
            log(`  ${i + 1}. [${mins}min] ${m.question.substring(0, 50)}...`, 'system');
        });
    }

    return futureMarkets;
}

async function validateMarketTokens(market) {
    /**
     * Final validation: verify tokens actually have orderbooks
     * This catches edge cases where market exists but tokens don't work
     */
    try {
        const yesResponse = await fetch(
            `${CONFIG.CLOB_HOST}/book?token_id=${market.tokens.YES}`,
            { timeout: 5000 }
        );

        const noResponse = await fetch(
            `${CONFIG.CLOB_HOST}/book?token_id=${market.tokens.NO}`,
            { timeout: 5000 }
        );

        if (!yesResponse.ok || !noResponse.ok) {
            return false;
        }

        const yesBook = await yesResponse.json();
        const noBook = await noResponse.json();

        // Verify books have minimal structure
        if (!yesBook.bids || !yesBook.asks || !noBook.bids || !noBook.asks) {
            return false;
        }

        // Verify books have some liquidity
        if (yesBook.bids.length === 0 || yesBook.asks.length === 0 ||
            noBook.bids.length === 0 || noBook.asks.length === 0) {
            return false;
        }

        // Extract and cache market constraints from REST book response (LIVE only)
        if (!CONFIG.SIMULATION_MODE && exchangeAdapter) {
            // Debug: log book structure to understand what fields are available
            log(`📖 REST book response keys: YES=${Object.keys(yesBook).join(',')}, NO=${Object.keys(noBook).join(',')}`, 'oms', 'DEBUG');

            // YES token constraints
            const yesMinSize = parseFloat(yesBook.min_order_size || yesBook.minimum_size || yesBook.minSize || yesBook.min_size);
            const yesTickSize = parseFloat(yesBook.tick_size || yesBook.size_tick || yesBook.tickSize);

            if (Number.isFinite(yesMinSize) && yesMinSize > 0) {
                exchangeAdapter.marketConstraintsCache.set(market.tokens.YES, {
                    minOrderSize: yesMinSize,
                    sizeTick: Number.isFinite(yesTickSize) && yesTickSize > 0 ? yesTickSize : 0.1,
                    cachedAt: Date.now()
                });
                log(`📚 Learned constraints from REST book: token=YES(${market.tokens.YES.slice(0, 8)}) min=${fmt(yesMinSize, 2)} tick=${fmt(yesTickSize || 0.1, 2)}`, 'oms', 'INFO');
            } else {
                log(`⚠️  REST book for YES token missing min_order_size field`, 'oms', 'WARN');
            }

            // NO token constraints
            const noMinSize = parseFloat(noBook.min_order_size || noBook.minimum_size || noBook.minSize || noBook.min_size);
            const noTickSize = parseFloat(noBook.tick_size || noBook.size_tick || noBook.tickSize);

            if (Number.isFinite(noMinSize) && noMinSize > 0) {
                exchangeAdapter.marketConstraintsCache.set(market.tokens.NO, {
                    minOrderSize: noMinSize,
                    sizeTick: Number.isFinite(noTickSize) && noTickSize > 0 ? noTickSize : 0.1,
                    cachedAt: Date.now()
                });
                log(`📚 Learned constraints from REST book: token=NO(${market.tokens.NO.slice(0, 8)}) min=${fmt(noMinSize, 2)} tick=${fmt(noTickSize || 0.1, 2)}`, 'oms', 'INFO');
            } else {
                log(`⚠️  REST book for NO token missing min_order_size field`, 'oms', 'WARN');
            }
        }

        return true;
    } catch (error) {
        return false;
    }
}

async function discoverMarkets() {
    log('Scanning Polymarket for crypto markets...', 'system');
    log(`Mode: ${CONFIG.SIMULATION_MODE ? '🎮 SIMULATION' : '💰 LIVE'}`, 'system');

    try {
        const allCryptoMarkets = await findCryptoMarkets();

        if (allCryptoMarkets.length === 0) {
            throw new Error('No crypto markets found');
        }

        const sortedMarkets = filterAndSortMarkets(allCryptoMarkets);

        if (sortedMarkets.length === 0) {
            throw new Error('No active future markets found');
        }

        log(`Filtered to ${sortedMarkets.length} active markets, sorted by expiry`, 'system');

        STATE.allAvailableMarkets = sortedMarkets;

        // Take the market expiring soonest (same logic as polymarket-mm-bot.js)
        const selectedMarket = sortedMarkets[0];

        STATE.markets.set(selectedMarket.conditionId, selectedMarket);
        STATE.selectedMarket = selectedMarket.conditionId;

        const endDate = new Date(selectedMarket.endDate);
        const minutesToExpiry = Math.round((endDate - new Date()) / 60000);

        log(`\n✅ Selected market expiring soonest:`, 'system');
        log(`   Question: ${selectedMarket.question}`, 'system');
        log(`   End Date: ${endDate.toLocaleString()}`, 'system');
        log(`   Time until expiry: ${minutesToExpiry} minutes`, 'system');
        log(`   URL: https://polymarket.com/event/${selectedMarket.slug}`, 'system');
        log(`   Token IDs: YES=${selectedMarket.tokens.YES}, NO=${selectedMarket.tokens.NO}`, 'system');

        // Show next 4 markets as well
        if (sortedMarkets.length > 1) {
            log(`\n📋 Next markets expiring:`, 'system');
            sortedMarkets.slice(1, 5).forEach((m, i) => {
                const mins = Math.round((new Date(m.endDate) - new Date()) / 60000);
                log(`   ${i + 2}. ${m.question} (in ${mins} min)`, 'system');
            });
        }

    } catch (error) {
        log(`ERROR: Error discovering markets: ${error.message}`, 'system');
        throw error;
    }
}

// Continuous market scanner (runs in background)
async function continuousMarketScanner() {
    STATE.marketScannerActive = true;

    while (STATE.marketScannerActive) {
        try {
            // Wait 30 seconds between scans
            await new Promise(resolve => setTimeout(resolve, 30000));

            log('🔄 Refreshing market list...', 'system');
            const allCryptoMarkets = await findCryptoMarkets();

            if (allCryptoMarkets.length > 0) {
                const sortedMarkets = filterAndSortMarkets(allCryptoMarkets);
                STATE.allAvailableMarkets = sortedMarkets;

                log(`DATA: Market refresh: ${sortedMarkets.length} active markets available`, 'system');

                // Show top 3 expiring soonest
                sortedMarkets.slice(0, 3).forEach((m, i) => {
                    const mins = Math.round((new Date(m.endDate) - new Date()) / 60000);
                    log(`   ${i + 1}. ${m.question.substring(0, 50)}... (${mins}m)`, 'system');
                });
            }
        } catch (error) {
            log(`WARNING: Market scanner error: ${error.message}`, 'system');
        }
    }
}

// ============================================================================
// WEBSOCKET & ORDERBOOK PROCESSING
// ============================================================================

function initializeOrderbookScanner() {
    log(`${icon('wave')} Connecting to real market data...`, 'system');

    const market = STATE.markets.get(STATE.selectedMarket);
    if (!market) {
        log(`${icon('err')} No market selected`, 'system');
        return;
    }

    // CRITICAL: Close existing WebSocket before creating new one
    // Prevents race condition with old subscriptions
    if (STATE.ws) {
        try {
            log(`${icon('warn')} Closing existing WebSocket connection...`, 'system');
            STATE.ws.removeAllListeners();  // Remove all event handlers
            if (STATE.ws.readyState === WebSocket.OPEN || STATE.ws.readyState === WebSocket.CONNECTING) {
                STATE.ws.close();
            }
            STATE.ws = null;
            STATE.wsConnected = false;
        } catch (error) {
            log(`${icon('warn')} Error closing old WebSocket: ${error.message}`, 'system');
        }

        // Wait a bit for cleanup
        return new Promise(resolve => {
            setTimeout(() => {
                initializeOrderbookScanner();
                resolve();
            }, 500);
        });
    }

    const tokenIds = [market.tokens.YES, market.tokens.NO];

    log(`${icon('wave')} Connecting to WebSocket for market: ${market.question}`, 'system');
    log(`${icon('info')} Tracking tokens: ${tokenIds.join(', ')}`, 'system');

    STATE.ws = new WebSocket(CONFIG.WS_HOST);

    STATE.ws.on('open', () => {
        STATE.wsConnected = true;
        log(`${icon('ok')} WebSocket connected`, 'system');

        // Wait for connection to be fully established before sending
        // readyState should be OPEN (1) not CONNECTING (0)
        if (STATE.ws.readyState === WebSocket.OPEN) {
            const subscription = {
                assets_ids: tokenIds,ns
                type: 'market'
            };

            try {
                STATE.ws.send(JSON.stringify(subscription));
                log(`${icon('wave')} Subscribed to orderbook updates`, 'system');
            } catch (error) {
                log(`${icon('err')} Failed to send subscription: ${error.message}`, 'system');
            }
        } else {
            log(`${icon('warn')} WebSocket not ready (readyState=${STATE.ws.readyState}), retrying subscription...`, 'system');

            // Retry after a short delay
            setTimeout(() => {
                if (STATE.ws && STATE.ws.readyState === WebSocket.OPEN) {
                    const subscription = {
                        assets_ids: tokenIds,
                        type: 'market'
                    };
                    try {
                        STATE.ws.send(JSON.stringify(subscription));
                        log(`${icon('wave')} Subscribed to orderbook updates (retry)`, 'system');
                    } catch (error) {
                        log(`${icon('err')} Retry failed: ${error.message}`, 'system');
                    }
                }
            }, 500);
        }
    });

    STATE.ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            const tokenId = message.asset_id || message.market;

            if (!tokenId) {
                if (CONFIG.SIMULATION_MODE) {
                    //log(`DEBUG: WS message without tokenId: ${JSON.stringify(message).substring(0, 100)}`, 'system');
                }
                return;
            }

            const eventType = message.event_type || message.type;

            if (CONFIG.SIMULATION_MODE) {
                //log(`DEBUG: WS message: type=${eventType}, tokenId=${tokenId.substring(0, 8)}...`, 'system');
            }

            if (eventType === 'book') {
                processOrderbookUpdate(tokenId, message);
            } else if (eventType === 'trade' || eventType === 'last_trade_price') {
                if (message.price && message.size) {
                    const trade = {
                        tokenId,
                        price: parseFloat(message.price),
                        size: parseFloat(message.size),
                        aggressor: message.side || 'UNKNOWN',
                        timestamp: Date.now()
                    };
                    processTrade(trade);
                }
            }

        } catch (error) {
            // Ignore parse errors
        }
    });

    STATE.ws.on('error', (error) => {
        log(`${icon('err')} WebSocket error: ${error.message}`, 'system');
        STATE.wsConnected = false;

        // Attempt to close and clean up
        try {
            if (STATE.ws && STATE.ws.readyState !== WebSocket.CLOSED) {
                STATE.ws.close();
            }
        } catch (closeError) {
            // Ignore close errors
        }
    });

    STATE.ws.on('close', (code, reason) => {
        log(`${icon('warn')} WebSocket closed (code=${code}, reason=${reason || 'none'}), reconnecting in 3s...`, 'system');
        STATE.wsConnected = false;

        // Clean up
        STATE.ws = null;

        // Reconnect after delay
        setTimeout(() => {
            try {
                initializeOrderbookScanner();
            } catch (error) {
                log(`${icon('err')} Reconnection failed: ${error.message}`, 'system');
            }
        }, 3000);
    });
}

function processOrderbookUpdate(tokenId, message) {
    // CRITICAL: Validate tokenId belongs to current market
    // Prevents race condition where old market messages arrive after switch
    const market = STATE.markets.get(STATE.selectedMarket);
    if (!market) {
        if (CONFIG.SIMULATION_MODE) {
            log(`DEBUG: processOrderbookUpdate: No market selected`, 'system');
        }
        return;
    }

    if (tokenId !== market.tokens.YES && tokenId !== market.tokens.NO) {
        // Message from old market, ignore
        if (CONFIG.SIMULATION_MODE) {
            log(`DEBUG: processOrderbookUpdate: Token ${tokenId.substring(0, 8)}... not in current market`, 'system');
        }
        return;
    }

    const bids = (message.bids || []).map(b => ({
        price: parseFloat(b.price || b[0]),
        size: parseFloat(b.size || b[1])
    }));

    const asks = (message.asks || []).map(a => ({
        price: parseFloat(a.price || a[0]),
        size: parseFloat(a.size || a[1])
    }));

    // Update stats counter BEFORE early return (count all updates, even empty ones)
    STATE.stats.orderbookUpdates++;
    STATE.stats.recentOrderbookTimestamps.push(Date.now());

    if (bids.length === 0 || asks.length === 0) return;

    bids.sort((a, b) => b.price - a.price);
    asks.sort((a, b) => a.price - b.price);

    const bestBid = bids[0];
    const bestAsk = asks[0];
    const mid = (bestBid.price + bestAsk.price) / 2;
    const spread = bestAsk.price - bestBid.price;

    const bidDepth = bids
        .slice(0, CONFIG.ORDERBOOK_DEPTH)
        .reduce((sum, b) => sum + b.size, 0);

    const askDepth = asks
        .slice(0, CONFIG.ORDERBOOK_DEPTH)
        .reduce((sum, a) => sum + a.size, 0);

    const orderbookData = {
        bids,
        asks,
        bestBid: bestBid.price,
        bestAsk: bestAsk.price,
        mid,
        spread,
        bidDepth,
        askDepth,
        timestamp: Date.now()
    };

    STATE.orderbooks.set(tokenId, orderbookData);

    // Extract market constraints from orderbook message (if present)
    // Polymarket CLOB often includes min_order_size and tick_size in book updates
    if (!CONFIG.SIMULATION_MODE && exchangeAdapter) {
        const minOrderSizeFromMsg = parseFloat(message.min_order_size || message.minimum_size || message.minSize);
        const tickSizeFromMsg = parseFloat(message.tick_size || message.size_tick || message.tickSize);

        if (Number.isFinite(minOrderSizeFromMsg) && minOrderSizeFromMsg > 0) {
            const existing = exchangeAdapter.marketConstraintsCache.get(tokenId);

            // Only update if:
            // - we don't have constraints yet, OR
            // - new minOrderSize is larger (don't degrade constraints on noisy data)
            const shouldUpdate = !existing || (minOrderSizeFromMsg >= existing.minOrderSize);

            if (shouldUpdate && (!existing || existing.minOrderSize !== minOrderSizeFromMsg)) {
                const constraints = {
                    minOrderSize: minOrderSizeFromMsg,
                    sizeTick: Number.isFinite(tickSizeFromMsg) && tickSizeFromMsg > 0 ? tickSizeFromMsg : (existing?.sizeTick || 0.1),
                    cachedAt: Date.now()
                };

                exchangeAdapter.marketConstraintsCache.set(tokenId, constraints);

                // Rate-limited logging (once per 60 seconds)
                const lastLog = STATE.live.lastConstraintLog?.get(`ws_${tokenId}`) || 0;
                if (Date.now() - lastLog > 60000) {
                    log(`📚 Learned constraints from WS book: token=${tokenId.slice(0, 8)} min=${fmt(minOrderSizeFromMsg, 2)} tick=${fmt(constraints.sizeTick, 2)}`, 'oms', 'INFO');
                    if (!STATE.live.lastConstraintLog) STATE.live.lastConstraintLog = new Map();
                    STATE.live.lastConstraintLog.set(`ws_${tokenId}`, Date.now());
                }
            }
        }
    }

    if (CONFIG.SIMULATION_MODE && STATE.stats.orderbookUpdates <= 5) {
        log(`DEBUG: Orderbook updated for ${getTokenType(tokenId)}: mid=${mid.toFixed(4)}, spread=${(spread * 100).toFixed(2)}%`, 'system');
    }

    // FILE LOG: Orderbook snapshot (smart triggers)
    const tokenType = getTokenType(tokenId);
    if (FILE_LOGGER.shouldTakeSnapshot(tokenType, orderbookData)) {
        logSnapshot(tokenType, orderbookData, market);
    }

    // Check orderbook health (pre-trade signals)
    checkOrderbookHealth(tokenId);
}

// ============================================================================
// PRE-TRADE SIGNALS (Orderbook Health Monitoring)
// ============================================================================

function checkOrderbookHealth(tokenId) {
    /**
     * Monitor orderbook for warning signs BEFORE getting hit:
     * - Depth thinning (liquidity evaporating)
     * - Spread widening (market stress)
     * - Imbalance (one-sided pressure)
     */
    const market = STATE.markets.get(STATE.selectedMarket);
    if (!market) return;

    const orderbook = STATE.orderbooks.get(tokenId);
    if (!orderbook) return;

    const tokenType = getTokenType(tokenId);
    const health = STATE.orderbookHealth[tokenType];
    const now = Date.now();

    // Rate limit checks
    if (now - health.lastCheck < CONFIG.PRETRADE_SIGNALS.SIGNAL_COOLDOWN_MS) {
        return;
    }

    // Calculate current depth (top N levels)
    const topBidDepth = orderbook.bids
        .slice(0, CONFIG.PRETRADE_SIGNALS.DEPTH_CHECK_LEVELS)
        .reduce((sum, b) => sum + b.size, 0);

    const topAskDepth = orderbook.asks
        .slice(0, CONFIG.PRETRADE_SIGNALS.DEPTH_CHECK_LEVELS)
        .reduce((sum, a) => sum + a.size, 0);

    const totalDepth = topBidDepth + topAskDepth;
    const currentSpread = orderbook.spread;

    // Initialize baseline if first check
    if (health.depth === 0) {
        health.depth = totalDepth;
        health.spread = currentSpread;
        health.lastCheck = now;
        return;
    }

    // ========================================================================
    // SIGNAL 1: DEPTH THINNING
    // ========================================================================
    // Depth dropped significantly = liquidity providers pulling quotes
    const depthRatio = totalDepth / health.depth;
    const wasThinning = health.thinning;

    if (depthRatio < CONFIG.PRETRADE_SIGNALS.DEPTH_THINNING_THRESHOLD) {
        if (!wasThinning) {
            health.thinning = true;
            log(`${icon('warn')} PRETRADE: ${tokenType} depth thinning: ${totalDepth.toFixed(1)} (${(depthRatio * 100).toFixed(0)}% of baseline)`, 'pretrade');

            // PROACTIVE defense: Enter defensive BEFORE getting hit
            // Don't enter defensive if in UNWIND (closing position is priority)
            if (!STATE.riskStatus.forcedUnwind && STATE.riskStatus.mode !== 'UNWIND' && STATE.riskStatus.mode !== 'PANIC') {
                STATE.riskStatus.defensiveMode = true;
                STATE.riskStatus.defensiveCooldownUntil = now + CONFIG.TRADE_DETECTION.INFORMED_COOLDOWN_MS;
                log(`${icon('warn')} PROACTIVE DEFENSE: Reducing size due to depth thinning`, 'pretrade');
            }
        }
    } else if (depthRatio > 0.8 && wasThinning) {
        // Depth recovered
        health.thinning = false;
        log(`${icon('ok')} PRETRADE: ${tokenType} depth recovered: ${totalDepth.toFixed(1)}`, 'pretrade');
    }

    // ========================================================================
    // SIGNAL 2: SPREAD WIDENING
    // ========================================================================
    // Spread widened significantly = market stress
    const spreadRatio = currentSpread / health.spread;
    if (spreadRatio > CONFIG.PRETRADE_SIGNALS.SPREAD_WIDENING_THRESHOLD) {
        log(`⚠️  PRETRADE: ${tokenType} spread widening: ${(currentSpread * 100).toFixed(2)}% (${spreadRatio.toFixed(1)}x baseline)`, 'pretrade');
    }

    // ========================================================================
    // SIGNAL 3: DEPTH IMBALANCE
    // ========================================================================
    // Heavily imbalanced book = directional pressure building
    const imbalance = (topBidDepth - topAskDepth) / (topBidDepth + topAskDepth);
    if (Math.abs(imbalance) > 0.7) {
        const direction = imbalance > 0 ? 'BUY' : 'SELL';
        log(`⚠️  PRETRADE: ${tokenType} imbalance: ${direction} pressure ${(Math.abs(imbalance) * 100).toFixed(0)}%`, 'pretrade');
    }

    // ========================================================================
    // SIGNAL 4: ABSOLUTE LOW DEPTH
    // ========================================================================
    // Total depth below minimum healthy level
    if (totalDepth < CONFIG.PRETRADE_SIGNALS.MIN_HEALTHY_DEPTH) {
        log(`⚠️  PRETRADE: ${tokenType} low depth: ${totalDepth.toFixed(1)} < ${CONFIG.PRETRADE_SIGNALS.MIN_HEALTHY_DEPTH}`, 'pretrade');

        // Reduce quote size in low liquidity
        if (STATE.riskStatus.mode === 'QUOTE') {
            log(`ACTION: Reducing quote size due to low depth`, 'pretrade');
        }
    }

    // Update baseline (EMA-style)
    health.depth = 0.9 * health.depth + 0.1 * totalDepth;
    health.spread = 0.9 * health.spread + 0.1 * currentSpread;
    health.lastCheck = now;
}

// ============================================================================
// MAIN INITIALIZATION
// ============================================================================

async function main() {
    console.log('🚀 Polymarket Market Making Bot V3');
    console.log('━'.repeat(80));
    console.log('Configuration:');
    console.log(`  Mode: ${CONFIG.SIMULATION_MODE ? '🎮 SIMULATION' : '💰 LIVE'}`)
    if (!CONFIG.SIMULATION_MODE && CONFIG.LIVE.SAFE_MODE) {
        console.log(`  🛡️  SAFE MODE: Enabled`);
        console.log(`     - Max size per order: ${CONFIG.LIVE.MAX_SIZE_PER_ORDER}`);
        console.log(`     - Max active orders: ${CONFIG.LIVE.MAX_ACTIVE_ORDERS_TOTAL}`);
        console.log(`     - Max net shares: ${CONFIG.LIVE.MAX_NET_SHARES}`);
        console.log(`     - Max gross shares: ${CONFIG.LIVE.MAX_GROSS_SHARES}`);
    }
    console.log(`  Max Net: ${CONFIG.RISK.MAX_NET_POSITION}, Max Gross: ${CONFIG.RISK.MAX_GROSS_POSITION}`);
    console.log(`  Base Spread: ${(CONFIG.QUOTING.BASE_SPREAD * 100).toFixed(2)}%`);
    console.log(`  Non-linear Skew: exp=${CONFIG.RISK.SKEW_EXPONENT}, base=${(CONFIG.RISK.BASE_SKEW_FACTOR * 100).toFixed(1)}%`);
    console.log(`  Forced Unwind: ${CONFIG.RISK.UNWIND_TRIGGER_INVENTORY_PCT * 100}% pos or ${CONFIG.RISK.UNWIND_TRIGGER_TIME_MIN}min`);
    console.log('━'.repeat(80));

    // Validate LIVE mode
    if (!CONFIG.SIMULATION_MODE && !process.env.PRIVATE_KEY) {
        console.error('❌ LIVE MODE requires PRIVATE_KEY!');
        console.error('Set with: export PRIVATE_KEY=0x...');
        process.exit(1);
    }

    try {
        // Initialize UI
        initializeUI();
        log('🚀 Bot starting...', 'system');

        // LIVE mode: Initialize ExchangeAdapter and user events
        if (!CONFIG.SIMULATION_MODE) {
            log('🔌 Initializing LIVE mode...', 'system', 'INFO');

            // Initialize ExchangeAdapter (uses ensureClient internally)
            exchangeAdapter = new ExchangeAdapter();
            await exchangeAdapter.init();

            // Setup fill and order update handlers
            exchangeAdapter.setOnFill(handleFill);
            exchangeAdapter.setOnOrderUpdate(handleOrderUpdate);

            log('✅ ExchangeAdapter ready', 'system', 'INFO');

            // CLEAN_START: Cancel all existing orders
            if (CONFIG.LIVE.CLEAN_START) {
                log('🧹 CLEAN_START: Canceling all existing orders...', 'system', 'WARN');

                try {
                    const existingOrders = await exchangeAdapter.getOpenOrders();
                    log(`   Found ${existingOrders.length} existing orders`, 'system', 'INFO');

                    for (const order of existingOrders) {
                        await exchangeAdapter.cancelOrder(order.orderId);
                    }

                    log('✅ All existing orders canceled', 'system', 'INFO');
                } catch (err) {
                    log(`⚠️  CLEAN_START failed: ${err.message}`, 'system', 'WARN');
                }
            }

            // Initial reconcile
            await reconcileOpenOrders();

            // CRITICAL: Initial balance check to get real USDC balance
            // This sets STATE.inventory.cash = real balance (source of truth)
            STATE.live.lastBalanceCheck = 0;  // Force immediate check
            await checkBalance();

            // CRITICAL: Initial position reconcile to get real outcome token balances
            // This initializes lastOutcomeBalances and detects any pre-existing positions
            log('🔄 Initial position reconciliation...', 'system', 'INFO');
            await reconcilePositionsFromChainOrApi();

            if (CONFIG.LIVE.SAFE_MODE) {
                log('🛡️  SAFE_MODE enabled', 'system', 'WARN');
                log(`   MAX_SIZE_PER_ORDER: ${CONFIG.LIVE.MAX_SIZE_PER_ORDER}`, 'system', 'INFO');
                log(`   MAX_ACTIVE_ORDERS_TOTAL: ${CONFIG.LIVE.MAX_ACTIVE_ORDERS_TOTAL}`, 'system', 'INFO');
                log(`   MAX_NET_SHARES: ${CONFIG.LIVE.MAX_NET_SHARES}`, 'system', 'INFO');
            }
        }

        // 1. Discover markets
        await discoverMarkets();

        // 2. Start continuous market scanner
        continuousMarketScanner().catch(err => log(`Market scanner stopped: ${err.message}`, 'system'));

        // 3. Initialize WebSocket
        initializeOrderbookScanner();

        // 4. Wait for data
        await new Promise(resolve => setTimeout(resolve, 3000));

        // 5. Start main loop
        startMainLoop();

        // 6. Start periodic reconciliation
        setInterval(reconcileOpenOrders, CONFIG.OMS.ORDER_SYNC_INTERVAL_MS);

        // 7. LIVE: Periodic safety checks
        if (!CONFIG.SIMULATION_MODE) {
            setInterval(assertInvariants, 10000);  // Every 10s
            setInterval(checkBalance, CONFIG.LIVE.BALANCE_CHECK_INTERVAL_MS);

            // CRITICAL: Periodic position reconciliation (every 5 seconds)
            // This ensures positions are always up-to-date even if mainLoop is slow/blocked
            setInterval(async () => {
                try {
                    await reconcilePositionsFromChainOrApi();
                } catch (err) {
                    log(`⚠️  Periodic position reconcile failed: ${err.message}`, 'oms', 'WARN');
                }
            }, 5000);
        }

        // 8. Calculate per-minute rates
        setInterval(() => {
            const now = Date.now();
            const oneMinuteAgo = now - 60000;

            STATE.stats.orderbookUpdatesPerMinute = STATE.stats.recentOrderbookTimestamps
                .filter(t => t > oneMinuteAgo).length;

            STATE.stats.tradesPerMinute = STATE.stats.recentTradeTimestamps
                .filter(t => t > oneMinuteAgo).length;

            // Cleanup old timestamps
            STATE.stats.recentOrderbookTimestamps = STATE.stats.recentOrderbookTimestamps
                .filter(t => t > oneMinuteAgo);
            STATE.stats.recentTradeTimestamps = STATE.stats.recentTradeTimestamps
                .filter(t => t > oneMinuteAgo);
        }, 10000);

        log('✅ Bot initialized successfully!', 'system');

    } catch (error) {
        console.error('❌ Initialization failed:', error);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGINT', async () => {
    if (screen) {
        screen.destroy();
    }
    console.log('\n⚠️  Shutting down...');

    try {
        // Cancel all orders
        await cancelAll();

        // Close WebSocket
        if (STATE.ws) {
            STATE.ws.close();
        }

        // Close ExchangeAdapter
        if (exchangeAdapter) {
            exchangeAdapter.destroy();
        }

        // Close file logger
        FILE_LOGGER.close();

        console.log('✅ Shutdown complete');
        process.exit(0);
    } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
    }
});

main().catch(console.error);
