// ============================================================================
// POLYMARKET MARKET MAKING BOT
// Senior Quantitative Engineer Implementation
// Focus: Observation, Simulation, Risk Control
// ============================================================================

import { ClobClient } from '@polymarket/clob-client';
import WebSocket from 'ws';

// ============================================================================
// КОНФИГУРАЦИЯ (все параметры в одном месте)
// ============================================================================

const CONFIG = {
    // API endpoints
    CLOB_HOST: 'https://clob.polymarket.com',
    WS_HOST: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
    GAMMA_API: 'https://gamma-api.polymarket.com',
    CHAIN_ID: 137,

    // Market Discovery фильтры
    MARKET_FILTERS: {
        MIN_TIME_TO_EXPIRY_HOURS: 2,
        MIN_SPREAD: 0.02,
        MIN_DAILY_VOLUME: 100,
        MAX_MARKETS_TO_TRACK: 5
    },

    // Fair Value Model веса
    FAIR_VALUE: {
        W_MID: 0.5,
        W_EMA: 0.3,
        W_EXTERNAL: 0.2,
        EMA_ALPHA: 0.1
    },

    // Inventory & Risk
    RISK: {
        // Net exposure limits (YES - NO)
        MAX_NET_POSITION: 50,  // Максимальная net позиция
        MAX_GROSS_POSITION: 100, // Максимум total shares (YES + NO)

        INITIAL_CASH: 10000,

        // Non-linear inventory skew
        BASE_SKEW_FACTOR: 0.05,  // 5% max skew at 100% position
        SKEW_EXPONENT: 2.5,      // Экспонента для non-linear

        // Time-based urgency
        URGENCY_THRESHOLD_HOURS: 2,  // Начинаем беспокоиться < 2 hours
        URGENCY_CRITICAL_HOURS: 0.5, // Критический уровень < 30 min

        // Unwind configuration
        UNWIND_TRIGGER_INVENTORY_PCT: 0.85,  // 85% max position
        UNWIND_TRIGGER_TIME_MIN: 15,         // 15 minutes до expiry
        UNWIND_TRIGGER_LOSS_PCT: 0.10,       // 10% unrealized loss
        UNWIND_SPREAD_REDUCTION: 0.5,        // Сужаем spread на 50%
        UNWIND_SIZE_MULTIPLIER: 2.0,         // Удваиваем размер

        // Kill switch
        MAX_POSITION_SIZE: 10,
        KILL_SWITCH_STREAK: 5,
        KILL_SWITCH_LOSS_PCT: 0.15  // 15% loss = kill
    },

    // Quoting параметры
    QUOTING: {
        BASE_SPREAD: 0.03,
        MIN_EDGE: 0.005,
        QUOTE_SIZE: 5,
        CONFIDENCE_THRESHOLD: 0.8
    },

    // Simulation Mode - controls ORDER PLACEMENT only, data is always REAL
    // true = no real orders (safe testing), false = real orders placed
    SIMULATION_MODE: true,

    // Logging & Updates
    UPDATE_INTERVAL_MS: 2000,
    ORDERBOOK_DEPTH: 3
};

// ============================================================================
// ГЛОБАЛЬНОЕ СОСТОЯНИЕ
// ============================================================================

const STATE = {
    markets: new Map(),
    selectedMarket: null,
    allAvailableMarkets: [], // Список всех доступных рынков
    marketScannerActive: false,
    marketScannerStatus: 'idle', // idle, scanning, completed
    lastScanMarketsFound: 0,
    orderbooks: new Map(),
    trades: [],
    tradeFlow: {
        type: 'NOISE',
        confidence: 0,
        reason: 'No trades yet'
    },
    fairValue: {
        mid: 0.5,
        ema: 0.5,
        external: 0.5,
        final: 0.5
    },
    inventory: {
        // Unified position tracking
        yesShares: 0,   // Количество YES shares
        noShares: 0,    // Количество NO shares
        netPosition: 0, // YES - NO (main exposure)
        grossPosition: 0, // YES + NO (total capital deployed)

        // Financial tracking
        cash: CONFIG.RISK.INITIAL_CASH,
        costBasis: {
            yes: 0,     // Average cost of YES position
            no: 0       // Average cost of NO position
        },

        // PnL
        unrealizedPnL: 0,
        realizedPnL: 0,

        // Position metadata
        avgEntryPrice: 0,
        hedgeRatio: 0,  // How hedged we are (0-1)
        lastUpdateTime: Date.now()
    },

    // Queue tracking for realistic fills
    queueState: {
        ourOrders: new Map(), // order_id -> { price, size, side, timestamp }
        estimatedPosition: new Map() // price level -> estimated queue position
    },
    quotes: {
        bid: null,
        ask: null,
        bidSize: 0,
        askSize: 0,
        reason: 'Not initialized'
    },
    riskStatus: {
        status: 'SAFE',
        fillStreak: 0,           // Количество consecutive fills
        fillStreakSide: null,    // 'YES_BUY', 'YES_SELL', etc
        inventoryUtilization: 0,
        forcedUnwind: false,     // В режиме forced unwind
        lastFillTime: null
    },
    ws: null,
    wsConnected: false,
    stats: {
        totalTrades: 0,
        orderbookUpdates: 0,
        quotesGenerated: 0,
        startTime: Date.now(),
        // Tracking for per-minute rates
        recentOrderbookTimestamps: [],
        recentTradeTimestamps: [],
        orderbookUpdatesPerMinute: 0,
        tradesPerMinute: 0
    }
};

// ============================================================================
// МОДУЛЬ: LOGGING SYSTEM С РАЗДЕЛЕНИЕМ ЭКРАНА
// ============================================================================

const SCREEN_BUFFERS = {
    mainLoop: [],
    systemStatus: [],
    orderbookUpdates: []
};

const MAX_MAIN_LOOP_LINES = 15;
const MAX_ORDERBOOK_LINES = 25;

function log(message, category = 'system') {
    const timestamp = new Date().toISOString().split('T')[1].replace('Z', '');
    const line = `[${timestamp}] ${message}`;

    if (category === 'orderbook' || category === 'trade' || category === 'flow') {
        SCREEN_BUFFERS.orderbookUpdates.push(line);
        if (SCREEN_BUFFERS.orderbookUpdates.length > MAX_ORDERBOOK_LINES) {
            SCREEN_BUFFERS.orderbookUpdates.shift();
        }
    } else {
        SCREEN_BUFFERS.mainLoop.push(line);
        if (SCREEN_BUFFERS.mainLoop.length > MAX_MAIN_LOOP_LINES) {
            SCREEN_BUFFERS.mainLoop.shift();
        }
    }
}

function logSection(title) {
    const separator = '='.repeat(80);
    // Clear the buffer for a fresh start instead of appending
    SCREEN_BUFFERS.mainLoop = [];
    SCREEN_BUFFERS.mainLoop.push(separator);
    SCREEN_BUFFERS.mainLoop.push('  ' + title);
    SCREEN_BUFFERS.mainLoop.push(separator);
}

function updateSystemStatus() {
    const uptime = Math.floor((Date.now() - STATE.stats.startTime) / 1000);
    const market = STATE.markets.get(STATE.selectedMarket);

    let marketInfo = 'Market: None';
    let marketUrl = '';
    let timeToExpiry = '';
    let marketPrices = '';

    if (market) {
        const endDate = new Date(market.endDate);
        const now = new Date();
        const msToExpiry = endDate - now;
        const minutesToExpiry = Math.floor(msToExpiry / 60000);
        const secondsToExpiry = Math.floor((msToExpiry % 60000) / 1000);

        marketUrl = `URL: https://polymarket.com/event/${market.slug}`;

        if (msToExpiry > 0) {
            if (minutesToExpiry > 60) {
                const hours = Math.floor(minutesToExpiry / 60);
                const mins = minutesToExpiry % 60;
                timeToExpiry = `⏰ Expires in: ${hours}h ${mins}m`;
            } else if (minutesToExpiry > 0) {
                timeToExpiry = `⏰ Expires in: ${minutesToExpiry}m ${secondsToExpiry}s`;
            } else {
                timeToExpiry = `⏰ Expires in: ${secondsToExpiry}s`;
            }
        } else {
            timeToExpiry = '⏰ EXPIRED';
        }

        marketInfo = `Market: ${market.question}`;

        // Get current market prices
        const yesBook = STATE.orderbooks.get(market.tokens.YES);
        const noBook = STATE.orderbooks.get(market.tokens.NO);

        if (yesBook && noBook) {
            const yesMid = yesBook.mid;
            const noMid = noBook.mid;
            const yesPrice = (yesBook.bestBid?.price || 0).toFixed(4);
            const yesAsk = (yesBook.bestAsk?.price || 0).toFixed(4);
            const noPrice = (noBook.bestBid?.price || 0).toFixed(4);
            const noAsk = (noBook.bestAsk?.price || 0).toFixed(4);

            // Target price is what we want to happen (fair value)
            const targetPrice = STATE.fairValue.final.toFixed(4);

            marketPrices = `Market Prices: YES ${yesPrice}/${yesAsk} (mid: ${yesMid.toFixed(4)}) | NO ${noPrice}/${noAsk} (mid: ${noMid.toFixed(4)}) | Target: ${targetPrice}`;
        } else {
            marketPrices = `Market Prices: Waiting for data... | Target: ${STATE.fairValue.final.toFixed(4)}`;
        }
    }

    // Calculate per-minute rates
    const now = Date.now();
    STATE.stats.recentOrderbookTimestamps = STATE.stats.recentOrderbookTimestamps.filter(
        ts => now - ts < 60000
    );
    STATE.stats.recentTradeTimestamps = STATE.stats.recentTradeTimestamps.filter(
        ts => now - ts < 60000
    );
    STATE.stats.orderbookUpdatesPerMinute = STATE.stats.recentOrderbookTimestamps.length;
    STATE.stats.tradesPerMinute = STATE.stats.recentTradeTimestamps.length;

    // Trading status - исправлено: всегда SIMULATION когда SIMULATION_MODE = true
    const tradingStatus = CONFIG.SIMULATION_MODE ? 'SIMULATION' : 'LIVE';

    // Market scanner status
    let scannerStatusText = '';
    if (STATE.marketScannerStatus === 'scanning') {
        scannerStatusText = `Market Scanner: 🔍 Scanning... | Found: ${STATE.lastScanMarketsFound} markets`;
    } else if (STATE.marketScannerStatus === 'completed') {
        scannerStatusText = `Market Scanner: ✅ Ready | Available Markets: ${STATE.allAvailableMarkets.length}`;
    } else if (STATE.marketScannerActive) {
        scannerStatusText = `Market Scanner: 🔄 Active | Available Markets: ${STATE.allAvailableMarkets.length}`;
    } else {
        scannerStatusText = `Market Scanner: ⏸️ Inactive | Available Markets: ${STATE.allAvailableMarkets.length}`;
    }

    SCREEN_BUFFERS.systemStatus = [
        '-'.repeat(80),
        'SYSTEM STATUS',
        '-'.repeat(80),
        marketInfo,
        marketUrl,
        marketPrices,
        timeToExpiry,
        `Uptime: ${uptime}s | WebSocket: ${STATE.wsConnected ? '✅' : '❌'} | Mode: ${CONFIG.SIMULATION_MODE ? 'SIMULATION' : 'LIVE'} | Trading: ${tradingStatus}`,
        scannerStatusText,
        `Data Flow: 📊 Orderbooks: ${STATE.stats.orderbookUpdatesPerMinute}/min | 💱 Trades: ${STATE.stats.tradesPerMinute}/min`,
        `Total Stats: ${STATE.stats.orderbookUpdates} orderbook updates, ${STATE.stats.totalTrades} trades, ${STATE.stats.quotesGenerated} quotes`,
        `Inventory: YES=${STATE.inventory.yesShares.toFixed(1)}, NO=${STATE.inventory.noShares.toFixed(1)}, Net=${STATE.inventory.netPosition.toFixed(1)}, Cash=$${STATE.inventory.cash.toFixed(2)}`,
        `PnL: Unrealized=$${STATE.inventory.unrealizedPnL.toFixed(2)}, Realized=$${STATE.inventory.realizedPnL.toFixed(2)}`,
        `Risk: ${STATE.riskStatus.status} (util: ${(STATE.riskStatus.inventoryUtilization * 100).toFixed(0)}%, hedge: ${(STATE.inventory.hedgeRatio * 100).toFixed(0)}%)${STATE.riskStatus.forcedUnwind ? ' 🚨 UNWIND' : ''}`,
        `Fair Value: ${STATE.fairValue.final.toFixed(4)}`,
        `Trade Flow: ${STATE.tradeFlow.type} (confidence: ${(STATE.tradeFlow.confidence * 100).toFixed(0)}%)`,
        STATE.quotes.bid && STATE.quotes.ask
            ? `Active Quotes: ${STATE.quotes.bid.toFixed(4)} / ${STATE.quotes.ask.toFixed(4)}`
            : `Active Quotes: None (${STATE.quotes.reason})`,
        '-'.repeat(80)
    ];
}

function renderScreen() {
    console.clear();

    const terminalWidth = process.stdout.columns || 160;
    const leftWidth = 80;
    const rightWidth = terminalWidth - leftWidth - 2;

    // Always show fixed number of lines for consistent layout
    const displayLines = Math.max(MAX_MAIN_LOOP_LINES, SCREEN_BUFFERS.mainLoop.length, SCREEN_BUFFERS.orderbookUpdates.length);

    for (let i = 0; i < displayLines; i++) {
        const leftLine = SCREEN_BUFFERS.mainLoop[i] || '';
        const rightLine = SCREEN_BUFFERS.orderbookUpdates[i] || '';

        const leftPadded = leftLine.padEnd(leftWidth).substring(0, leftWidth);
        const rightTrimmed = rightLine.substring(0, rightWidth);

        console.log(leftPadded + '│ ' + rightTrimmed);
    }

    console.log('═'.repeat(terminalWidth));

    SCREEN_BUFFERS.systemStatus.forEach(line => {
        console.log(line);
    });
}

function logSystemStatus() {
    updateSystemStatus();
    renderScreen();
}

// ============================================================================
// МОДУЛЬ 1: MARKET DISCOVERY
// ============================================================================

async function findCryptoMarkets() {
    STATE.marketScannerStatus = 'scanning';
    STATE.lastScanMarketsFound = 0;

    const allCryptoMarkets = [];
    let offset = 0;
    const limit = 500;
    const maxPages = 50;

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
                let tokenIds = [];
                if (Array.isArray(market.clobTokenIds)) {
                    tokenIds = market.clobTokenIds;
                } else if (typeof market.clobTokenIds === 'string') {
                    try {
                        tokenIds = JSON.parse(market.clobTokenIds);
                    } catch (e) {
                        // Skip invalid tokens
                    }
                }

                if (tokenIds.length === 2 && market.conditionId) {
                    allCryptoMarkets.push({
                        conditionId: market.conditionId,
                        question: market.question,
                        slug: market.slug,
                        endDate: market.endDate,
                        tokens: {
                            YES: tokenIds[0],
                            NO: tokenIds[1]
                        }
                    });
                }
            }
        }

        // Update scan progress
        STATE.lastScanMarketsFound = allCryptoMarkets.length;

        offset += limit;
    }

    STATE.marketScannerStatus = 'completed';
    return allCryptoMarkets;
}

function filterAndSortMarkets(markets) {
    const now = new Date();
    const futureMarkets = markets.filter(m => {
        const endDate = new Date(m.endDate);
        return endDate > now;
    });

    futureMarkets.sort((a, b) => {
        const dateA = new Date(a.endDate);
        const dateB = new Date(b.endDate);
        return dateA.getTime() - dateB.getTime();
    });

    return futureMarkets;
}

async function discoverMarkets() {
    logSection('MARKET DISCOVERY');
    log('Scanning Polymarket for crypto markets...');
    log(`Mode: ${CONFIG.SIMULATION_MODE ? '🎮 Orders Simulated' : '💰 Real Orders'} | Data: Always Real`);

    try {
        log('Searching for crypto markets with Up/Down outcomes...');
        const allCryptoMarkets = await findCryptoMarkets();

        if (allCryptoMarkets.length === 0) {
            throw new Error('No crypto markets found');
        }

        log(`Found ${allCryptoMarkets.length} crypto markets`);

        const sortedMarkets = filterAndSortMarkets(allCryptoMarkets);

        if (sortedMarkets.length === 0) {
            throw new Error('No active future markets found');
        }

        log(`Filtered to ${sortedMarkets.length} active markets, sorted by expiry`);

        STATE.allAvailableMarkets = sortedMarkets;

        // Take the market expiring soonest
        const selectedMarket = sortedMarkets[0];

        STATE.markets.set(selectedMarket.conditionId, selectedMarket);
        STATE.selectedMarket = selectedMarket.conditionId;

        const endDate = new Date(selectedMarket.endDate);
        const minutesToExpiry = Math.round((endDate - new Date()) / 60000);

        log(`\n✅ Selected market expiring soonest:`);
        log(`   Question: ${selectedMarket.question}`);
        log(`   End Date: ${endDate.toLocaleString()}`);
        log(`   Time until expiry: ${minutesToExpiry} minutes`);
        log(`   URL: https://polymarket.com/event/${selectedMarket.slug}`);
        log(`   Token IDs: YES=${selectedMarket.tokens.YES}, NO=${selectedMarket.tokens.NO}`);

        // Show next 4 markets as well
        if (sortedMarkets.length > 1) {
            log(`\n📋 Next markets expiring:`);
            sortedMarkets.slice(1, 5).forEach((m, i) => {
                const mins = Math.round((new Date(m.endDate) - new Date()) / 60000);
                log(`   ${i + 2}. ${m.question} (in ${mins} min)`);
            });
        }

    } catch (error) {
        log(`❌ Error discovering markets: ${error.message}`);
        throw error; // Don't fall back, fail properly
    }
}

// Непрерывное сканирование рынков
async function continuousMarketScanner() {
    STATE.marketScannerActive = true;

    while (STATE.marketScannerActive) {
        try {
            // Ждем 30 секунд между сканированиями
            await new Promise(resolve => setTimeout(resolve, 30000));

            if (!STATE.marketScannerActive) break;

            // Обновляем список рынков
            const allCryptoMarkets = await findCryptoMarkets();
            const sortedMarkets = filterAndSortMarkets(allCryptoMarkets);

            if (sortedMarkets.length > 0) {
                STATE.allAvailableMarkets = sortedMarkets;

                // Проверяем, не истек ли текущий рынок
                const currentMarket = STATE.markets.get(STATE.selectedMarket);
                if (currentMarket) {
                    const endDate = new Date(currentMarket.endDate);
                    const now = new Date();

                    if (endDate <= now) {
                        // Текущий рынок истек, переключаемся на следующий
                        log('⚠️  Current market expired, switching to next market...', 'system');

                        const nextMarket = sortedMarkets[0];
                        STATE.markets.set(nextMarket.conditionId, nextMarket);
                        STATE.selectedMarket = nextMarket.conditionId;

                        log(`✅ Switched to: ${nextMarket.question}`, 'system');
                        log(`   Expires in: ${Math.round((new Date(nextMarket.endDate) - now) / 60000)} minutes`, 'system');

                        // Переподключаем WebSocket к новому рынку
                        if (STATE.ws) {
                            STATE.ws.close();
                        }

                        // Даем время на закрытие старого соединения
                        await new Promise(resolve => setTimeout(resolve, 1000));

                        // Инициализируем новое соединение
                        initializeOrderbookScanner();
                    }
                }
            }

        } catch (error) {
            // Тихо игнорируем ошибки сканирования
        }
    }
}

function startContinuousMarketScanner() {
    log('🔄 Starting continuous market scanner...');
    continuousMarketScanner().catch(err => {
        log(`❌ Market scanner error: ${err.message}`);
    });
}

// ============================================================================
// МОДУЛЬ 2: ORDERBOOK SCANNER
// ============================================================================

function initializeOrderbookScanner() {
    logSection('ORDERBOOK SCANNER');
    log(`Connecting to real market data (${CONFIG.SIMULATION_MODE ? 'orders simulated' : 'orders real'})...`);

    const market = STATE.markets.get(STATE.selectedMarket);
    if (!market) {
        log('❌ No market selected');
        return;
    }

    const tokenIds = [market.tokens.YES, market.tokens.NO];

    log(`Connecting to WebSocket for market: ${market.question}`);
    log(`Tracking tokens: ${tokenIds.join(', ')}`);

    STATE.ws = new WebSocket(CONFIG.WS_HOST);

    STATE.ws.on('open', () => {
        STATE.wsConnected = true;
        log('✅ WebSocket connected');

        const subscription = {
            assets_ids: tokenIds,
            type: 'market'
        };

        STATE.ws.send(JSON.stringify(subscription));
        log('📡 Subscribed to orderbook updates');
    });

    STATE.ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            const tokenId = message.asset_id || message.market;

            if (!tokenId) return;

            const eventType = message.event_type || message.type;

            if (eventType === 'book') {
                processOrderbookUpdate(tokenId, message);
            } else if (eventType === 'trade' || eventType === 'last_trade_price') {
                // Process trade data from WebSocket
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
            // Тихо игнорируем ошибки парсинга
        }
    });

    STATE.ws.on('error', (error) => {
        log(`⚠️  WebSocket error: ${error.message}`);
        STATE.wsConnected = false;
    });

    STATE.ws.on('close', () => {
        log('WebSocket closed, reconnecting in 3s...');
        STATE.wsConnected = false;
        setTimeout(initializeOrderbookScanner, 3000);
    });
}

function processOrderbookUpdate(tokenId, message) {
    const bids = (message.bids || []).map(b => ({
        price: parseFloat(b.price || b[0]),
        size: parseFloat(b.size || b[1])
    }));

    const asks = (message.asks || []).map(a => ({
        price: parseFloat(a.price || a[0]),
        size: parseFloat(a.size || a[1])
    }));

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

    const prev = STATE.orderbooks.get(tokenId);

    STATE.orderbooks.set(tokenId, {
        bids: bids.slice(0, CONFIG.ORDERBOOK_DEPTH),
        asks: asks.slice(0, CONFIG.ORDERBOOK_DEPTH),
        bestBid,
        bestAsk,
        mid,
        spread,
        bidDepth,
        askDepth,
        timestamp: Date.now()
    });

    STATE.stats.orderbookUpdates++;
    STATE.stats.recentOrderbookTimestamps.push(Date.now());

    if (prev) {
        const priceMoved = Math.abs(mid - prev.mid) > 0.001;
        const spreadChanged = Math.abs(spread - prev.spread) > 0.005;

        if (priceMoved || spreadChanged) {
            logOrderbookChange(tokenId, prev, STATE.orderbooks.get(tokenId));
        }
    }
}

function logOrderbookChange(tokenId, prev, current) {
    const tokenType = getTokenType(tokenId);
    const priceChange = ((current.mid - prev.mid) / prev.mid * 100).toFixed(3);
    const spreadChange = ((current.spread - prev.spread) * 100).toFixed(3);

    log(`📊 ${tokenType} Orderbook Update:`, 'orderbook');
    log(`   Mid: ${prev.mid.toFixed(4)} → ${current.mid.toFixed(4)} (${priceChange > 0 ? '+' : ''}${priceChange}%)`, 'orderbook');
    log(`   Spread: ${(prev.spread * 100).toFixed(2)}% → ${(current.spread * 100).toFixed(2)}% (${spreadChange > 0 ? '+' : ''}${spreadChange}%)`, 'orderbook');
    log(`   Best Bid: ${current.bestBid.price.toFixed(4)} (${current.bestBid.size.toFixed(1)})`, 'orderbook');
    log(`   Best Ask: ${current.bestAsk.price.toFixed(4)} (${current.bestAsk.size.toFixed(1)})`, 'orderbook');
}

function getTokenType(tokenId) {
    const market = STATE.markets.get(STATE.selectedMarket);
    if (!market) return 'UNKNOWN';

    if (tokenId === market.tokens.YES) return 'YES';
    if (tokenId === market.tokens.NO) return 'NO';
    return 'UNKNOWN';
}

// ============================================================================
// МОДУЛЬ 2.5: QUEUE-AWARE FILL SIMULATION
// ============================================================================

function estimateQueuePosition(price, side, tokenId) {
    /**
     * Оценивает нашу позицию в очереди на данном уровне цены
     * Консервативная оценка: предполагаем что мы последние
     */
    const orderbook = STATE.orderbooks.get(tokenId);
    if (!orderbook) return { sizeAhead: 0, ourPosition: 0 };

    const levels = side === 'BUY' ? orderbook.bids : orderbook.asks;

    // Находим уровень с нашей ценой
    const ourLevel = levels.find(l => Math.abs(l.price - price) < 0.0001);

    if (!ourLevel) {
        // Наша цена не в стакане (мы лучше рынка или хуже)
        return { sizeAhead: 0, ourPosition: 0 };
    }

    // Консервативная оценка: весь объем на этом уровне перед нами
    const sizeAhead = ourLevel.size;

    return {
        sizeAhead,
        ourPosition: sizeAhead, // Мы последние
        levelSize: ourLevel.size
    };
}

function calculatePartialFill(trade, ourPrice, ourSize, side) {
    /**
     * Вычисляет realistic fill с учетом очереди
     *
     * Логика:
     * 1. Aggressive order "съедает" книгу level by level
     * 2. Когда доходит до нашего level, сначала исполняются те кто впереди
     * 3. Мы получаем fill только если агрессор дошел до нас И имеет остаток
     */

    const tokenId = trade.tokenId;
    const { sizeAhead } = estimateQueuePosition(ourPrice, side, tokenId);

    // Проверяем достигает ли aggressive order нашей цены
    const reachesOurPrice =
        (side === 'BUY' && trade.aggressor === 'SELL' && trade.price <= ourPrice) ||
        (side === 'SELL' && trade.aggressor === 'BUY' && trade.price >= ourPrice);

    if (!reachesOurPrice) {
        return {
            filled: false,
            fillSize: 0,
            fillRatio: 0,
            reason: 'Price not reached'
        };
    }

    // Агрессор достиг нашей цены, но сколько он съел до нас?
    const sizeReachingUs = Math.max(0, trade.size - sizeAhead);

    if (sizeReachingUs <= 0) {
        return {
            filled: false,
            fillSize: 0,
            fillRatio: 0,
            reason: `Queue: ${sizeAhead.toFixed(1)} ahead`
        };
    }

    // У агрессора остался размер, получаем partial/full fill
    const fillSize = Math.min(sizeReachingUs, ourSize);
    const fillRatio = fillSize / ourSize;

    return {
        filled: true,
        fillSize,
        fillRatio,
        partial: fillSize < ourSize,
        reason: `Filled ${fillSize.toFixed(2)}/${ourSize.toFixed(2)}`
    };
}

function updatePositionMetrics() {
    /**
     * Обновляет net/gross position и hedge ratio
     */
    STATE.inventory.netPosition = STATE.inventory.yesShares - STATE.inventory.noShares;
    STATE.inventory.grossPosition = STATE.inventory.yesShares + STATE.inventory.noShares;

    const totalShares = STATE.inventory.grossPosition;
    if (totalShares > 0) {
        const hedged = Math.min(STATE.inventory.yesShares, STATE.inventory.noShares);
        STATE.inventory.hedgeRatio = (hedged * 2) / totalShares;
    } else {
        STATE.inventory.hedgeRatio = 0;
    }

    STATE.inventory.lastUpdateTime = Date.now();
}

function updateFillStreak(side) {
    /**
     * Отслеживает streak fills в одну сторону
     */
    if (STATE.riskStatus.fillStreakSide === side) {
        STATE.riskStatus.fillStreak++;
    } else {
        STATE.riskStatus.fillStreak = 1;
        STATE.riskStatus.fillStreakSide = side;
    }
    STATE.riskStatus.lastFillTime = Date.now();
}

// ============================================================================
// МОДУЛЬ 3: REAL DATA ONLY - NO MOCK GENERATORS
// ============================================================================
// All mock/simulation data generation removed
// Bot now ALWAYS connects to real Polymarket data
// SIMULATION_MODE only controls whether orders are placed (true = no orders)

// ============================================================================
// МОДУЛЬ 4: TRADE FLOW ANALYSIS
// ============================================================================

function processTrade(trade) {
    STATE.trades.push(trade);

    if (STATE.trades.length > 100) {
        STATE.trades = STATE.trades.slice(-100);
    }

    STATE.stats.totalTrades++;
    STATE.stats.recentTradeTimestamps.push(Date.now());

    const tokenType = getTokenType(trade.tokenId);
    log(`💱 Trade: ${tokenType} ${trade.aggressor} ${trade.size.toFixed(2)} @ ${trade.price.toFixed(4)}`, 'trade');

    analyzeTradeFlow();

    // In simulation mode, check if our theoretical quotes would have been filled
    if (CONFIG.SIMULATION_MODE) {
        checkVirtualFills(trade);
    }
}

function analyzeTradeFlow() {
    /**
     * ENHANCED: Детектирует informed vs noise flow
     *
     * Сигналы informed flow:
     * 1. BURST: много trades за короткое время
     * 2. PRICE IMPACT: цена движется после trades
     * 3. FOLLOW-THROUGH: direction сохраняется
     * 4. SIZE: большие trades
     */

    const window = 30000; // 30 seconds
    const now = Date.now();

    // Фильтруем недавние trades
    const recentTrades = STATE.trades.filter(t => now - t.timestamp < window);

    if (recentTrades.length < 3) {
        STATE.tradeFlow = {
            type: 'INSUFFICIENT_DATA',
            direction: null,
            confidence: 0,
            metrics: {}
        };
        return;
    }

    // ===== METRIC 1: Burst Detection =====
    const avgTimeBetweenTrades = window / recentTrades.length;
    const burstScore = Math.min(1.0, 5000 / avgTimeBetweenTrades); // 5s baseline

    // ===== METRIC 2: Direction Consistency =====
    let buyVolume = 0, sellVolume = 0;

    for (const trade of recentTrades) {
        if (trade.aggressor === 'BUY') {
            buyVolume += trade.size;
        } else {
            sellVolume += trade.size;
        }
    }

    const totalVolume = buyVolume + sellVolume;
    const imbalance = Math.abs(buyVolume - sellVolume) / totalVolume;
    const direction = buyVolume > sellVolume ? 'BUY' : 'SELL';

    // ===== METRIC 3: Price Impact =====
    const firstPrice = recentTrades[0].price;
    const lastPrice = recentTrades[recentTrades.length - 1].price;
    const priceChange = Math.abs(lastPrice - firstPrice);
    const priceImpactScore = Math.min(1.0, priceChange / 0.05); // 5% baseline

    // ===== METRIC 4: Average Trade Size =====
    const avgTradeSize = totalVolume / recentTrades.length;
    const sizeScore = Math.min(1.0, avgTradeSize / 20); // 20 shares baseline

    // ===== METRIC 5: Follow-Through =====
    // Проверяем сохраняется ли direction в последних 5 trades
    const last5 = recentTrades.slice(-5);
    let consistentDirection = 0;

    for (const trade of last5) {
        if (trade.aggressor === direction) consistentDirection++;
    }

    const followThroughScore = consistentDirection / last5.length;

    // ===== FINAL SCORE =====
    const informedScore = (
        burstScore * 0.20 +
        imbalance * 0.30 +
        priceImpactScore * 0.25 +
        sizeScore * 0.10 +
        followThroughScore * 0.15
    );

    const isInformed = informedScore > 0.5; // 50% threshold

    STATE.tradeFlow = {
        type: isInformed ? 'INFORMED' : 'NOISE',
        direction,
        confidence: informedScore,
        metrics: {
            burst: burstScore.toFixed(2),
            imbalance: imbalance.toFixed(2),
            priceImpact: priceImpactScore.toFixed(2),
            avgSize: avgTradeSize.toFixed(1),
            followThrough: followThroughScore.toFixed(2),
            tradeCount: recentTrades.length
        }
    };

    // Log если detected informed flow
    if (isInformed && informedScore > 0.7) {
        log(`⚠️  INFORMED FLOW detected: ${direction} | Confidence: ${(informedScore * 100).toFixed(0)}%`, 'flow');
        log(`   Metrics: burst=${burstScore.toFixed(2)}, imbalance=${imbalance.toFixed(2)}, impact=${priceImpactScore.toFixed(2)}`, 'flow');
    }
}

// ============================================================================
// МОДУЛЬ 5: FAIR VALUE ESTIMATOR
// ============================================================================

function calculateFairValue() {
    const market = STATE.markets.get(STATE.selectedMarket);
    if (!market) return;

    const yesBook = STATE.orderbooks.get(market.tokens.YES);
    const noBook = STATE.orderbooks.get(market.tokens.NO);

    if (!yesBook || !noBook) return;

    const mid = yesBook.mid;

    if (STATE.fairValue.ema === 0.5) {
        STATE.fairValue.ema = mid;
    } else {
        STATE.fairValue.ema =
            CONFIG.FAIR_VALUE.EMA_ALPHA * mid +
            (1 - CONFIG.FAIR_VALUE.EMA_ALPHA) * STATE.fairValue.ema;
    }

    // External signal - in real bot this would come from external data sources
    // For now, we use EMA as proxy for external signal
    STATE.fairValue.external = STATE.fairValue.ema;

    STATE.fairValue.mid = mid;
    STATE.fairValue.final =
        CONFIG.FAIR_VALUE.W_MID * STATE.fairValue.mid +
        CONFIG.FAIR_VALUE.W_EMA * STATE.fairValue.ema +
        CONFIG.FAIR_VALUE.W_EXTERNAL * STATE.fairValue.external;

    log(`🎯 Fair Value: ${STATE.fairValue.final.toFixed(4)} (mid: ${mid.toFixed(4)}, ema: ${STATE.fairValue.ema.toFixed(4)}, ext: ${STATE.fairValue.external.toFixed(4)})`, 'fair');
}

// ============================================================================
// МОДУЛЬ 6: INVENTORY & RISK ENGINE
// ============================================================================

function updateInventoryAndRisk() {
    const market = STATE.markets.get(STATE.selectedMarket);
    if (!market) return;

    const yesBook = STATE.orderbooks.get(market.tokens.YES);
    const noBook = STATE.orderbooks.get(market.tokens.NO);

    if (!yesBook || !noBook) return;

    // Calculate market values using unified position tracking
    const yesValue = STATE.inventory.yesShares * (yesBook.bestBid?.price || 0);
    const noValue = STATE.inventory.noShares * (noBook.bestBid?.price || 0);

    const totalInventoryValue = yesValue + noValue;
    STATE.inventory.unrealizedPnL = totalInventoryValue + STATE.inventory.cash - CONFIG.RISK.INITIAL_CASH;

    // Calculate utilization based on net position and gross position
    const netUtil = Math.abs(STATE.inventory.netPosition) / CONFIG.RISK.MAX_NET_POSITION;
    const grossUtil = STATE.inventory.grossPosition / CONFIG.RISK.MAX_GROSS_POSITION;
    STATE.riskStatus.inventoryUtilization = Math.max(netUtil, grossUtil);

    // Risk status determination
    if (STATE.riskStatus.fillStreak >= CONFIG.RISK.KILL_SWITCH_STREAK) {
        STATE.riskStatus.status = 'KILLED';
    } else if (STATE.riskStatus.inventoryUtilization > 0.9) {
        STATE.riskStatus.status = 'DANGER';
    } else if (STATE.riskStatus.inventoryUtilization > 0.7) {
        STATE.riskStatus.status = 'WARNING';
    } else {
        STATE.riskStatus.status = 'SAFE';
    }

    log(`💼 Inventory: YES=${STATE.inventory.yesShares.toFixed(1)}, NO=${STATE.inventory.noShares.toFixed(1)}, Net=${STATE.inventory.netPosition.toFixed(1)}, Cash=${STATE.inventory.cash.toFixed(2)}`, 'risk');
    log(`📊 PnL: Unrealized=${STATE.inventory.unrealizedPnL.toFixed(2)}, Realized=${STATE.inventory.realizedPnL.toFixed(2)}`, 'risk');
    log(`⚠️  Risk: ${STATE.riskStatus.status} (util: ${(STATE.riskStatus.inventoryUtilization * 100).toFixed(0)}%, hedge: ${(STATE.inventory.hedgeRatio * 100).toFixed(0)}%, streak: ${STATE.riskStatus.fillStreak})`, 'risk');
}

function calculateNonLinearInventorySkew() {
    /**
     * NON-LINEAR inventory skew с учетом:
     * 1. Размера позиции (экспоненциальный)
     * 2. Времени до истечения
     * 3. Направления informed flow
     * 4. Unrealized PnL
     */

    const market = STATE.markets.get(STATE.selectedMarket);
    if (!market) return { skew: 0, components: {} };

    // ===== 1. Base skew (non-linear) =====
    const netPosition = STATE.inventory.netPosition;
    const maxPosition = CONFIG.RISK.MAX_NET_POSITION;
    const normalizedPosition = netPosition / maxPosition; // -1 to 1

    // Exponential skew: larger position = MUCH larger skew
    const baseSkew = Math.sign(normalizedPosition) *
                     Math.pow(Math.abs(normalizedPosition), CONFIG.RISK.SKEW_EXPONENT) *
                     CONFIG.RISK.BASE_SKEW_FACTOR;

    // ===== 2. Time pressure =====
    const endDate = new Date(market.endDate);
    const msToExpiry = Math.max(0, endDate - Date.now());
    const hoursToExpiry = msToExpiry / (1000 * 60 * 60);

    let timePressure = 1.0;
    if (hoursToExpiry < CONFIG.RISK.URGENCY_CRITICAL_HOURS) {
        timePressure = 5.0; // CRITICAL: 5x pressure
    } else if (hoursToExpiry < CONFIG.RISK.URGENCY_THRESHOLD_HOURS) {
        // Linear interpolation 1.0 -> 5.0
        const ratio = 1 - (hoursToExpiry / CONFIG.RISK.URGENCY_THRESHOLD_HOURS);
        timePressure = 1.0 + ratio * 4.0;
    }

    // ===== 3. Flow pressure (adverse selection) =====
    let flowPressure = 1.0;
    if (STATE.tradeFlow.type === 'INFORMED') {
        const positionDirection = netPosition > 0 ? 'BUY' : 'SELL';
        const flowDirection = STATE.tradeFlow.direction;

        if (flowDirection === positionDirection) {
            // Informed flow в направлении нашей позиции = ПРОБЛЕМА
            // Значит умные деньги думают что мы неправы
            flowPressure = 1.0 + STATE.tradeFlow.confidence * 1.5;
        } else {
            // Flow против позиции = хорошо, можем расслабиться немного
            flowPressure = Math.max(0.8, 1.0 - STATE.tradeFlow.confidence * 0.2);
        }
    }

    // ===== 4. Loss pressure =====
    let lossPressure = 1.0;
    if (STATE.inventory.unrealizedPnL < 0) {
        const lossPct = Math.abs(STATE.inventory.unrealizedPnL) / CONFIG.RISK.INITIAL_CASH;
        if (lossPct > 0.05) { // >5% loss
            lossPressure = 1.0 + lossPct * 2.0; // Увеличиваем давление
        }
    }

    // ===== Final skew =====
    const finalSkew = baseSkew * timePressure * flowPressure * lossPressure;

    // Cap skew at reasonable levels
    const cappedSkew = Math.max(-0.20, Math.min(0.20, finalSkew)); // ±20% max

    return {
        skew: cappedSkew,
        components: {
            baseSkew,
            timePressure,
            flowPressure,
            lossPressure,
            normalizedPosition: normalizedPosition.toFixed(2),
            hoursToExpiry: hoursToExpiry.toFixed(2)
        }
    };
}

// ============================================================================
// МОДУЛЬ 6.5: FORCED UNWIND - AGGRESSIVE POSITION CLOSING
// ============================================================================

function shouldForceUnwind() {
    /**
     * Определяет нужно ли СРОЧНО закрывать позицию
     * Возвращает: { unwind: boolean, urgency: 0-1, reasons: [] }
     */

    const market = STATE.markets.get(STATE.selectedMarket);
    if (!market) return { unwind: false, urgency: 0, reasons: [] };

    const reasons = [];
    let urgencyScore = 0;

    // ===== TRIGGER 1: Time to expiry =====
    const endDate = new Date(market.endDate);
    const msToExpiry = Math.max(0, endDate - Date.now());
    const minutesToExpiry = msToExpiry / (1000 * 60);

    if (minutesToExpiry < CONFIG.RISK.UNWIND_TRIGGER_TIME_MIN) {
        const timeUrgency = 1 - (minutesToExpiry / CONFIG.RISK.UNWIND_TRIGGER_TIME_MIN);
        urgencyScore = Math.max(urgencyScore, timeUrgency);
        reasons.push(`TIME: ${minutesToExpiry.toFixed(1)}m left`);
    }

    // ===== TRIGGER 2: Inventory size =====
    const netPosition = Math.abs(STATE.inventory.netPosition);
    const maxPosition = CONFIG.RISK.MAX_NET_POSITION;
    const positionPct = netPosition / maxPosition;

    if (positionPct > CONFIG.RISK.UNWIND_TRIGGER_INVENTORY_PCT) {
        const inventoryUrgency = (positionPct - CONFIG.RISK.UNWIND_TRIGGER_INVENTORY_PCT) /
                                 (1 - CONFIG.RISK.UNWIND_TRIGGER_INVENTORY_PCT);
        urgencyScore = Math.max(urgencyScore, inventoryUrgency);
        reasons.push(`INVENTORY: ${(positionPct * 100).toFixed(0)}% of max`);
    }

    // ===== TRIGGER 3: Unrealized loss =====
    const lossPct = Math.abs(STATE.inventory.unrealizedPnL) / CONFIG.RISK.INITIAL_CASH;

    if (STATE.inventory.unrealizedPnL < 0 && lossPct > CONFIG.RISK.UNWIND_TRIGGER_LOSS_PCT) {
        const lossUrgency = (lossPct - CONFIG.RISK.UNWIND_TRIGGER_LOSS_PCT) /
                           (1 - CONFIG.RISK.UNWIND_TRIGGER_LOSS_PCT);
        urgencyScore = Math.max(urgencyScore, lossUrgency);
        reasons.push(`LOSS: ${(lossPct * 100).toFixed(1)}% unrealized`);
    }

    // ===== TRIGGER 4: Adverse flow + position =====
    if (STATE.tradeFlow.type === 'INFORMED' && netPosition > 0) {
        const positionDirection = STATE.inventory.netPosition > 0 ? 'BUY' : 'SELL';
        const flowDirection = STATE.tradeFlow.direction;

        if (flowDirection === positionDirection) {
            // Informed flow идет против нас
            const flowUrgency = STATE.tradeFlow.confidence * 0.7; // Max 70%
            urgencyScore = Math.max(urgencyScore, flowUrgency);
            reasons.push(`ADVERSE FLOW: ${flowDirection} flow vs our position`);
        }
    }

    // ===== TRIGGER 5: Kill switch =====
    if (STATE.riskStatus.fillStreak >= CONFIG.RISK.KILL_SWITCH_STREAK) {
        urgencyScore = 1.0; // Maximum urgency
        reasons.push(`KILL SWITCH: ${STATE.riskStatus.fillStreak} consecutive fills`);
    }

    const shouldUnwind = urgencyScore > 0.3; // 30% threshold

    return {
        unwind: shouldUnwind,
        urgency: Math.min(1.0, urgencyScore),
        reasons,
        minutesToExpiry: minutesToExpiry.toFixed(1)
    };
}

function calculateUnwindParameters(urgency) {
    /**
     * Вычисляет параметры для unwind quotes
     * Чем выше urgency, тем агрессивнее параметры
     */

    // Spread reduction: от 0% (normal) до 80% (critical)
    const spreadReduction = CONFIG.RISK.UNWIND_SPREAD_REDUCTION * urgency;

    // Size multiplier: от 1x (normal) до 3x (critical)
    const sizeMultiplier = 1.0 + (CONFIG.RISK.UNWIND_SIZE_MULTIPLIER - 1.0) * urgency;

    // Price improvement: насколько агрессивнее мы котируем
    // 0% = normal, 10% = cross spread (buy at ask, sell at bid)
    const priceImprovement = 0.10 * urgency;

    return {
        spreadReduction,
        sizeMultiplier,
        priceImprovement,
        urgency
    };
}

function generateUnwindQuotes(fairValue, unwindParams) {
    /**
     * Генерирует AGGRESSIVE quotes для forced unwind
     *
     * Логика:
     * 1. Узкий spread (или даже crossed spread при critical urgency)
     * 2. Большой размер
     * 3. Котируем ТОЛЬКО в направлении закрытия позиции
     */

    const netPosition = STATE.inventory.netPosition;

    if (Math.abs(netPosition) < 0.1) {
        // Позиции нет, unwind не нужен
        return null;
    }

    const direction = netPosition > 0 ? 'SELL' : 'BUY'; // Закрываем позицию
    const positionSize = Math.abs(netPosition);

    // Base spread (уменьшенный)
    const normalSpread = CONFIG.QUOTING.BASE_SPREAD;
    const unwindSpread = normalSpread * (1 - unwindParams.spreadReduction);

    // Size to quote (увеличенный)
    const unwindSize = Math.min(
        positionSize * unwindParams.sizeMultiplier,
        positionSize // Не можем продать больше чем есть
    );

    let bid = null, ask = null, bidSize = 0, askSize = 0;

    if (direction === 'SELL') {
        // Хотим продать (close long position)
        // Агрессивный ask: ниже fair value с учетом urgency
        ask = fairValue - (unwindSpread / 2) - (fairValue * unwindParams.priceImprovement);
        askSize = unwindSize;

        // Bid не котируем или котируем очень узко (не хотим покупать еще)
        if (unwindParams.urgency < 0.8) {
            bid = fairValue - normalSpread;
            bidSize = CONFIG.RISK.MAX_POSITION_SIZE * 0.1; // 10% normal size
        }
    } else {
        // Хотим купить (close short position)
        // Агрессивный bid: выше fair value
        bid = fairValue + (unwindSpread / 2) + (fairValue * unwindParams.priceImprovement);
        bidSize = unwindSize;

        // Ask не котируем
        if (unwindParams.urgency < 0.8) {
            ask = fairValue + normalSpread;
            askSize = CONFIG.RISK.MAX_POSITION_SIZE * 0.1;
        }
    }

    return {
        bid,
        ask,
        bidSize,
        askSize,
        unwindMode: true,
        direction,
        urgency: unwindParams.urgency
    };
}

// ============================================================================
// МОДУЛЬ 6.7: YES/NO UNIFIED POSITION (YES + NO ≈ 1)
// ============================================================================

function getMidPrice(side) {
    /**
     * Получает mid price для YES или NO
     */
    const market = STATE.markets.get(STATE.selectedMarket);
    if (!market) return 0.5;

    const tokenId = side === 'YES' ? market.tokens.YES : market.tokens.NO;
    if (!tokenId) return 0.5;

    const book = STATE.orderbooks.get(tokenId);
    if (!book) return 0.5;

    return book.mid || 0.5;
}

function calculateNetExposure() {
    /**
     * Вычисляет net exposure с учетом YES + NO = 1 constraint
     */

    const yesValue = STATE.inventory.yesShares * getMidPrice('YES');
    const noValue = STATE.inventory.noShares * getMidPrice('NO');

    const grossValue = yesValue + noValue;
    const netValue = yesValue - noValue;

    // Hedge ratio: сколько нашей позиции захеджировано
    const hedged = Math.min(STATE.inventory.yesShares, STATE.inventory.noShares);
    const totalShares = STATE.inventory.yesShares + STATE.inventory.noShares;
    const hedgeRatio = totalShares > 0 ? (hedged * 2) / totalShares : 0;

    return {
        netValue,       // $ net exposure
        grossValue,     // $ total capital deployed
        hedgeRatio,     // 0-1: how hedged
        netShares: STATE.inventory.netPosition,
        effectivePrice: grossValue > 0 ? netValue / totalShares : 0
    };
}

function checkYesNoArbitrage() {
    /**
     * КРИТИЧЕСКАЯ ПРОВЕРКА: YES + NO должно быть ≈ 1
     * Если YES + NO < 0.98, это FREE MONEY (buy both)
     * Если YES + NO > 1.02, это FREE MONEY (sell both)
     */

    const market = STATE.markets.get(STATE.selectedMarket);
    if (!market) return null;

    const yesToken = market.tokens.YES;
    const noToken = market.tokens.NO;

    if (!yesToken || !noToken) return null;

    const yesBook = STATE.orderbooks.get(yesToken);
    const noBook = STATE.orderbooks.get(noToken);

    if (!yesBook || !noBook) return null;

    // Best prices to buy both
    const yesBestAsk = yesBook.asks[0]?.price;
    const noBestAsk = noBook.asks[0]?.price;

    // Best prices to sell both
    const yesBestBid = yesBook.bids[0]?.price;
    const noBestBid = noBook.bids[0]?.price;

    if (!yesBestAsk || !noBestAsk || !yesBestBid || !noBestBid) return null;

    // ===== ARBITRAGE 1: Buy both (if sum < 1) =====
    const costToBuyBoth = yesBestAsk + noBestAsk;
    const buyBothArb = 1.0 - costToBuyBoth; // Profit if positive

    // ===== ARBITRAGE 2: Sell both (if sum > 1) =====
    const revenueFromSellBoth = yesBestBid + noBestBid;
    const sellBothArb = revenueFromSellBoth - 1.0; // Profit if positive

    const threshold = 0.02; // 2% threshold (fees + slippage)

    let opportunity = null;

    if (buyBothArb > threshold) {
        opportunity = {
            type: 'BUY_BOTH',
            profit: buyBothArb,
            profitPct: (buyBothArb / costToBuyBoth) * 100,
            yesCost: yesBestAsk,
            noCost: noBestAsk,
            totalCost: costToBuyBoth
        };
    } else if (sellBothArb > threshold) {
        opportunity = {
            type: 'SELL_BOTH',
            profit: sellBothArb,
            profitPct: (sellBothArb / revenueFromSellBoth) * 100,
            yesRevenue: yesBestBid,
            noRevenue: noBestBid,
            totalRevenue: revenueFromSellBoth
        };
    }

    return opportunity;
}

function shouldHedgeWithOppositeSide() {
    /**
     * Определяет нужно ли захеджировать позицию противоположной стороной
     */

    const netPosition = STATE.inventory.netPosition;
    const exposure = calculateNetExposure();

    // Если позиция маленькая, hedge не нужен
    if (Math.abs(netPosition) < CONFIG.RISK.MAX_NET_POSITION * 0.3) {
        return { hedge: false, reason: 'Position too small' };
    }

    // Если уже хорошо захеджированы, не нужен
    if (exposure.hedgeRatio > 0.6) {
        return { hedge: false, reason: `Already ${(exposure.hedgeRatio * 100).toFixed(0)}% hedged` };
    }

    // Проверяем time to expiry
    const market = STATE.markets.get(STATE.selectedMarket);
    if (!market) return { hedge: false, reason: 'No market data' };

    const msToExpiry = new Date(market.endDate) - Date.now();
    const hoursToExpiry = msToExpiry / (1000 * 60 * 60);

    // Если < 1 hour до expiry, hedge бесполезен (лучше unwind)
    if (hoursToExpiry < 1.0) {
        return { hedge: false, reason: 'Too close to expiry, unwind instead' };
    }

    // Hedge имеет смысл
    const direction = netPosition > 0 ? 'QUOTE_NO' : 'QUOTE_YES';
    const targetHedgeRatio = 0.5; // Хотим 50% hedge
    const hedgeSize = Math.abs(netPosition) * targetHedgeRatio -
                     Math.min(STATE.inventory.yesShares, STATE.inventory.noShares);

    return {
        hedge: true,
        direction,
        size: hedgeSize,
        currentHedge: exposure.hedgeRatio,
        targetHedge: targetHedgeRatio
    };
}

// ============================================================================
// МОДУЛЬ 7: QUOTING ENGINE
// ============================================================================

function generateQuotes() {
    const market = STATE.markets.get(STATE.selectedMarket);
    if (!market) return;

    if (STATE.riskStatus.status === 'KILLED') {
        STATE.quotes = {
            bid: null,
            ask: null,
            bidSize: 0,
            askSize: 0,
            reason: 'KILL SWITCH: Too many one-sided fills'
        };
        log('🛑 KILL SWITCH ACTIVATED - Not quoting', 'quote');
        return;
    }

    const yesBook = STATE.orderbooks.get(market.tokens.YES);
    if (!yesBook) {
        STATE.quotes = {
            bid: null,
            ask: null,
            bidSize: 0,
            askSize: 0,
            reason: 'Waiting for orderbook data'
        };
        return;
    }

    const fairValue = STATE.fairValue.final;

    // ===== CHECK FOR FORCED UNWIND =====
    const unwindCheck = shouldForceUnwind();

    if (unwindCheck.unwind) {
        log(`🚨 FORCED UNWIND ACTIVE | Urgency: ${(unwindCheck.urgency * 100).toFixed(0)}%`, 'unwind');
        log(`   Reasons: ${unwindCheck.reasons.join(', ')}`, 'unwind');

        const unwindParams = calculateUnwindParameters(unwindCheck.urgency);
        const unwindQuotes = generateUnwindQuotes(fairValue, unwindParams);

        if (unwindQuotes) {
            log(`   Unwind direction: ${unwindQuotes.direction}`, 'unwind');
            log(`   Spread reduction: ${(unwindParams.spreadReduction * 100).toFixed(0)}%`, 'unwind');
            log(`   Size multiplier: ${unwindParams.sizeMultiplier.toFixed(1)}x`, 'unwind');

            // Используем unwind quotes вместо normal quotes
            STATE.quotes = {
                bid: unwindQuotes.bid,
                ask: unwindQuotes.ask,
                bidSize: unwindQuotes.bidSize,
                askSize: unwindQuotes.askSize,
                fairValue: fairValue,
                unwindMode: true,
                unwindUrgency: unwindCheck.urgency
            };

            STATE.riskStatus.forcedUnwind = true;
            return;
        }
    }

    // ===== NORMAL QUOTING (no unwind) =====
    STATE.riskStatus.forcedUnwind = false;

    let fair = fairValue;
    let spread = CONFIG.QUOTING.BASE_SPREAD;
    let size = CONFIG.QUOTING.QUOTE_SIZE;

    if (STATE.tradeFlow.type === 'INFORMED') {
        spread *= (1 + STATE.tradeFlow.confidence * 0.5);
        log(`   Spread widened due to INFORMED flow: ${(spread * 100).toFixed(2)}%`, 'quote');
    }

    const inventorySkewResult = calculateNonLinearInventorySkew();
    const inventorySkew = inventorySkewResult.skew;

    fair += inventorySkew;

    // Log skew components if significant
    if (Math.abs(inventorySkew) > 0.05) {
        log(`   Skew: ${(inventorySkew * 100).toFixed(1)}% | Components: ` +
            `base=${inventorySkewResult.components.baseSkew.toFixed(3)}, ` +
            `time=${inventorySkewResult.components.timePressure.toFixed(2)}x, ` +
            `flow=${inventorySkewResult.components.flowPressure.toFixed(2)}x`, 'skew');
    }

    if (STATE.riskStatus.status === 'DANGER') {
        size *= 0.5;
        log(`   Size reduced due to DANGER status`, 'quote');
    } else if (STATE.riskStatus.status === 'WARNING') {
        size *= 0.7;
        log(`   Size reduced due to WARNING status`, 'quote');
    }

    const halfSpread = spread / 2;
    let bid = fair - halfSpread - CONFIG.QUOTING.MIN_EDGE;
    let ask = fair + halfSpread + CONFIG.QUOTING.MIN_EDGE;

    bid = Math.max(0.01, Math.min(0.99, bid));
    ask = Math.max(0.01, Math.min(0.99, ask));

    if (bid >= ask) {
        STATE.quotes = {
            bid: null,
            ask: null,
            bidSize: 0,
            askSize: 0,
            reason: 'Invalid bid/ask relationship'
        };
        log('⚠️  Quote rejected: bid >= ask', 'quote');
        return;
    }

    const marketBid = yesBook.bestBid?.price || 0;
    const marketAsk = yesBook.bestAsk?.price || 1;

    if (bid > marketBid || ask < marketAsk) {
        if (bid > marketBid) {
            bid = marketBid - 0.001;
            log(`   Bid adjusted to stay outside market: ${bid.toFixed(4)}`, 'quote');
        }
        if (ask < marketAsk) {
            ask = marketAsk + 0.001;
            log(`   Ask adjusted to stay outside market: ${ask.toFixed(4)}`, 'quote');
        }
    }

    STATE.quotes = {
        bid,
        ask,
        bidSize: size,
        askSize: size,
        reason: `Fair=${fair.toFixed(4)}, Spread=${(spread * 100).toFixed(2)}%, Skew=${(inventorySkew * 1000).toFixed(2)}bps`
    };

    STATE.stats.quotesGenerated++;

    log(`💰 Quote: BID ${bid.toFixed(4)} (${size.toFixed(1)}) | ASK ${ask.toFixed(4)} (${size.toFixed(1)})`, 'quote');
    log(`   Reason: ${STATE.quotes.reason}`, 'quote');
    log(`   Market: ${marketBid.toFixed(4)} / ${marketAsk.toFixed(4)} (we are OUTSIDE)`, 'quote');
}

// ============================================================================
// МОДУЛЬ 8: VIRTUAL FILLS
// ============================================================================

function checkVirtualFills(trade) {
    /**
     * REALISTIC fill simulation с учетом queue
     */

    if (!STATE.quotes.bid && !STATE.quotes.ask) return;

    const tokenType = getTokenType(trade.tokenId);
    if (tokenType !== 'YES') return; // Пока только YES

    // ========== CHECK BID FILL (мы покупатели) ==========
    if (STATE.quotes.bid && STATE.quotes.bidSize > 0) {
        const fillResult = calculatePartialFill(
            trade,
            STATE.quotes.bid,
            STATE.quotes.bidSize,
            'BUY'
        );

        if (fillResult.filled) {
            const fillCost = fillResult.fillSize * STATE.quotes.bid;

            if (STATE.inventory.cash >= fillCost) {
                // Обновляем inventory
                const prevYes = STATE.inventory.yesShares;
                STATE.inventory.yesShares += fillResult.fillSize;
                STATE.inventory.cash -= fillCost;

                // Обновляем cost basis
                const totalShares = STATE.inventory.yesShares;
                STATE.inventory.costBasis.yes =
                    (prevYes * STATE.inventory.costBasis.yes + fillResult.fillSize * STATE.quotes.bid) /
                    totalShares;

                // Обновляем net/gross position
                updatePositionMetrics();

                // Обновляем our quote (частичный fill)
                STATE.quotes.bidSize -= fillResult.fillSize;
                if (STATE.quotes.bidSize < 0.01) {
                    STATE.quotes.bid = null;
                    STATE.quotes.bidSize = 0;
                }

                // Risk tracking
                updateFillStreak('YES_BUY');

                log(`✅ REALISTIC FILL: Bought ${fillResult.fillSize.toFixed(2)} YES @ ${STATE.quotes.bid.toFixed(4)}`, 'fill');
                log(`   ${fillResult.reason}`, 'fill');
                log(`   Cost: $${fillCost.toFixed(2)}, New position: ${STATE.inventory.netPosition.toFixed(1)}`, 'fill');

                if (fillResult.partial) {
                    log(`   PARTIAL: ${(fillResult.fillRatio * 100).toFixed(0)}% filled`, 'fill');
                }
            } else {
                log(`⚠️  Fill rejected: insufficient cash (need $${fillCost.toFixed(2)})`, 'fill');
            }
        }
    }

    // ========== CHECK ASK FILL (мы продавцы) ==========
    if (STATE.quotes.ask && STATE.quotes.askSize > 0) {
        const fillResult = calculatePartialFill(
            trade,
            STATE.quotes.ask,
            STATE.quotes.askSize,
            'SELL'
        );

        if (fillResult.filled) {
            // Можем продать только если есть shares
            const availableToSell = Math.min(fillResult.fillSize, STATE.inventory.yesShares);

            if (availableToSell > 0) {
                const fillRevenue = availableToSell * STATE.quotes.ask;

                // Обновляем inventory
                STATE.inventory.yesShares -= availableToSell;
                STATE.inventory.cash += fillRevenue;

                // Realized PnL
                const realizedPnL = availableToSell * (STATE.quotes.ask - STATE.inventory.costBasis.yes);
                STATE.inventory.realizedPnL += realizedPnL;

                // Обновляем net/gross
                updatePositionMetrics();

                // Обновляем quote
                STATE.quotes.askSize -= availableToSell;
                if (STATE.quotes.askSize < 0.01) {
                    STATE.quotes.ask = null;
                    STATE.quotes.askSize = 0;
                }

                // Risk tracking
                updateFillStreak('YES_SELL');

                log(`✅ REALISTIC FILL: Sold ${availableToSell.toFixed(2)} YES @ ${STATE.quotes.ask.toFixed(4)}`, 'fill');
                log(`   ${fillResult.reason}`, 'fill');
                log(`   Revenue: $${fillRevenue.toFixed(2)}, PnL: $${realizedPnL.toFixed(2)}`, 'fill');

                if (fillResult.partial || availableToSell < fillResult.fillSize) {
                    log(`   PARTIAL: Had only ${STATE.inventory.yesShares.toFixed(1)} shares`, 'fill');
                }
            }
        }
    }
}

// ============================================================================
// МОДУЛЬ 9: MAIN LOOP & DECISION ENGINE
// ============================================================================

function mainLoop() {
    // Clear only the main loop buffer for fresh display each cycle
    logSection('MAIN LOOP CYCLE');

    calculateFairValue();
    updateInventoryAndRisk();

    let decision = 'HOLD';
    let decisionReason = '';

    if (STATE.riskStatus.status === 'KILLED') {
        decision = 'EXIT';
        decisionReason = 'Kill switch activated';
    } else if (STATE.tradeFlow.type === 'INFORMED' && STATE.tradeFlow.confidence > CONFIG.QUOTING.CONFIDENCE_THRESHOLD) {
        decision = 'HOLD';
        decisionReason = `High confidence INFORMED flow (${(STATE.tradeFlow.confidence * 100).toFixed(0)}%)`;
    } else if (STATE.riskStatus.status === 'DANGER') {
        decision = 'HOLD';
        decisionReason = 'Inventory at DANGER level';
    } else {
        decision = 'QUOTE';
        decisionReason = 'Conditions suitable for market making';
    }

    log(`🎲 Decision: ${decision} - ${decisionReason}`, 'decision');

    if (decision === 'QUOTE') {
        generateQuotes();
    } else {
        STATE.quotes = {
            bid: null,
            ask: null,
            bidSize: 0,
            askSize: 0,
            reason: decisionReason
        };
        log(`⏸️  Not quoting: ${decisionReason}`, 'quote');
    }

    logSystemStatus();
}

function startMainLoop() {
    logSection('MAIN LOOP');
    log(`Starting main loop (interval: ${CONFIG.UPDATE_INTERVAL_MS}ms)`);

    setInterval(() => {
        mainLoop();
    }, CONFIG.UPDATE_INTERVAL_MS);
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

(async () => {
    console.log('🚀 Polymarket Market Making Bot v2.1');
    console.log('━'.repeat(80));
    console.log('Configuration:');
    console.log(`  Data Source: ALWAYS REAL (Polymarket API)`);
    console.log(`  Order Mode: ${CONFIG.SIMULATION_MODE ? '🎮 SIMULATION (no real orders)' : '💰 LIVE (real orders placed)'}`);
    console.log(`  Max Net Position: ${CONFIG.RISK.MAX_NET_POSITION}, Max Gross: ${CONFIG.RISK.MAX_GROSS_POSITION}`);
    console.log(`  Initial Cash: ${CONFIG.RISK.INITIAL_CASH}`);
    console.log(`  Base Spread: ${(CONFIG.QUOTING.BASE_SPREAD * 100).toFixed(2)}%`);
    console.log(`  Non-linear Skew: Exponent ${CONFIG.RISK.SKEW_EXPONENT}, Base ${(CONFIG.RISK.BASE_SKEW_FACTOR * 100).toFixed(1)}%`);
    console.log(`  Forced Unwind: Triggers at ${(CONFIG.RISK.UNWIND_TRIGGER_INVENTORY_PCT * 100).toFixed(0)}% position or ${CONFIG.RISK.UNWIND_TRIGGER_TIME_MIN}min to expiry`);
    console.log(`  Update Interval: ${CONFIG.UPDATE_INTERVAL_MS}ms`);
    console.log('━'.repeat(80));
    console.log('\nInitializing...\n');

    try {
        await discoverMarkets();
        initializeOrderbookScanner();

        // Запускаем непрерывное сканирование рынков
        startContinuousMarketScanner();

        await new Promise(resolve => setTimeout(resolve, 2000));
        startMainLoop();

        console.log('\n✅ Bot is running. Press Ctrl+C to stop.\n');

    } catch (error) {
        console.error('❌ Fatal error:', error);
        process.exit(1);
    }

    process.on('SIGINT', () => {
        console.log('\n\n👋 Shutting down...');

        STATE.marketScannerActive = false;

        if (STATE.ws) {
            STATE.ws.close();
        }

        logSystemStatus();

        console.log('\n✅ Bot stopped');
        process.exit(0);
    });
})();

// ============================================================================
// КОММЕНТАРИИ К РЕАЛИЗАЦИИ
// ============================================================================

/*

ВАЖНО: DATA vs ORDERS
=====================
SIMULATION_MODE контролирует ТОЛЬКО размещение ордеров:
- true: данные РЕАЛЬНЫЕ, ордера НЕ размещаются (безопасное тестирование)
- false: данные РЕАЛЬНЫЕ, ордера размещаются (реальная торговля)

Бот ВСЕГДА подключается к реальным данным Polymarket через WebSocket.
Mock/simulation данных больше нет - удалены все функции генерации фейковых данных.


ГДЕ В КОДЕ MM EDGE (маркет-мейкинг преимущество):
================================================

MM edge находится в функции generateQuotes():

  let bid = fair - halfSpread - CONFIG.QUOTING.MIN_EDGE;
  let ask = fair + halfSpread + CONFIG.QUOTING.MIN_EDGE;

ИСТОЧНИК ПРИБЫЛИ:
- Мы покупаем по: fair - halfSpread - MIN_EDGE
- Продаем по: fair + halfSpread + MIN_EDGE
- Зарабатываем на: spread + 2*MIN_EDGE
- Стоим ВНЕ текущего спреда (не агрессивны, не платим taker fees)

ПРИМЕР:
Fair = 0.50, Spread = 3%, MIN_EDGE = 0.5%
Bid = 0.50 - 0.015 - 0.005 = 0.48
Ask = 0.50 + 0.015 + 0.005 = 0.52
Потенциальная прибыль = 0.52 - 0.48 = 0.04 (4% на round-trip)


ГДЕ КОНТРОЛЬ INVENTORY (управление позицией):
==============================================

1. UNIFIED POSITION TRACKING:
   - netPosition = yesShares - noShares (main exposure)
   - grossPosition = yesShares + noShares (total deployed)
   - hedgeRatio = how much is hedged (0-1)
   - MAX_NET_POSITION: 50, MAX_GROSS_POSITION: 100

2. NON-LINEAR INVENTORY SKEW (функция calculateNonLinearInventorySkew):
   baseSkew = sign(pos) * |pos|^2.5 * 0.05
   finalSkew = baseSkew * timePressure * flowPressure * lossPressure

   Механизм:
   - EXPONENTIAL: большая позиция = НАМНОГО больший skew
   - TIME PRESSURE: 5x при < 30min до expiry
   - FLOW PRESSURE: adverse selection adjustment
   - LOSS PRESSURE: увеличивается при убытках

3. FORCED UNWIND (функция shouldForceUnwind):
   Триггеры:
   - Time < 15 min до expiry
   - Position > 85% max
   - Loss > 10%
   - Adverse informed flow
   - Kill switch (consecutive fills)

   Действие: агрессивные котировки для закрытия позиции

4. KILL SWITCH (функция updateInventoryAndRisk):
   if (fillStreak >= 5) → status = 'KILLED' → не котируем

   Защита от adverse selection:
   - Если 5 fill подряд в одну сторону → stop quoting
   - Возможно, информированный трейдер нас атакует


ГДЕ МЕСТО ДЛЯ РЕАЛЬНОГО API POLYMARKET:
========================================

Для перехода на LIVE торговлю:

1. MARKET DISCOVERY (функция discoverMarkets):
   Заменить mock на реальный fetch:

   const response = await fetch(
     `${CONFIG.GAMMA_API}/markets?closed=false&...`
   );

2. ORDERBOOK SCANNER (функция initializeOrderbookScanner):
   Уже подключается к реальному WebSocket, просто установить:

   CONFIG.SIMULATION_MODE = false;

3. ORDER PLACEMENT (нужно добавить):

   async function placeOrder(side, price, size, tokenId) {
     const privateKey = process.env.PRIVATE_KEY;
     const client = new ClobClient(
       CONFIG.CLOB_HOST,
       CONFIG.CHAIN_ID,
       privateKey
     );

     const order = client.createOrder({
       tokenID: tokenId,
       price: price.toString(),
       size: size.toString(),
       side: side,
       feeRateBps: '0'
     });

     const signedOrder = await client.signOrder(order);
     const resp = await client.postOrder(signedOrder, {
       feeRateBps: '0'
     });

     return resp;
   }

4. FILL TRACKING (нужно добавить):
   Подписаться на fill events через WebSocket:

   ws.on('message', (data) => {
     const message = JSON.parse(data);
     if (message.event_type === 'fill') {
       handleRealFill(message);
     }
   });

REQUIREMENTS ДЛЯ LIVE:
- npm install @polymarket/clob-client ws dotenv
- .env файл с PRIVATE_KEY
- Установить SIMULATION_MODE = false
- Добавить функции placeOrder() и handleRealFill()

*/