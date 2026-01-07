import dotenv from 'dotenv';
dotenv.config();

import { ClobClient } from '@polymarket/clob-client';
import WebSocket from 'ws';

const host = 'https://clob.polymarket.com';
const wsHost = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const chainId = 137;

const publicClient = new ClobClient(host, chainId);

// ============================================================================
// ХРАНИЛИЩЕ ДАННЫХ (shared state между контурами)
// ============================================================================
const orderbookStorage = {
    data: {},

    update(tokenId, bids, asks) {
        const now = Date.now();

        if (!this.data[tokenId]) {
            this.data[tokenId] = {
                bids: [],
                asks: [],
                lastUpdate: null,
                messagesCount: 0,
                messagesPerSecond: 0,
                recentMessages: []
            };
        }

        this.data[tokenId].bids = bids;
        this.data[tokenId].asks = asks;
        this.data[tokenId].lastUpdate = new Date();
        this.data[tokenId].messagesCount++;

        this.data[tokenId].recentMessages.push(now);
        this.data[tokenId].recentMessages = this.data[tokenId].recentMessages.filter(
            ts => now - ts < 1000
        );

        this.data[tokenId].messagesPerSecond = this.data[tokenId].recentMessages.length;
    },

    get(tokenId) {
        return this.data[tokenId] || null;
    },

    getAll() {
        return this.data;
    }
};

// Метаданные рынков
const marketsMetadata = {};

// Текущие активные арбитражные ситуации (conditionId -> opportunity)
const activeArbitrages = new Map();

// История арбитражных ситуаций (макс 100)
const arbitrageHistory = [];
const MAX_HISTORY = 100;

// Статус системы
const systemStatus = {
    wsConnected: false,
    wsReconnecting: false,
    scannerActive: false,
    marketRefreshStatus: 'idle',
    totalMessagesReceived: 0,
    messagesPerSecond: 0,
    recentMessageTimestamps: [],
    arbitrageChecksPerformed: 0,
    arbitrageChecksPerSecond: 0,
    recentArbitrageChecks: [],
    startTime: Date.now(),
    lastDisplayUpdate: Date.now()
};

// Активные рынки и WebSocket
let activeMarkets = [];
let currentWebSocket = null;

// ============================================================================
// ПОИСК РЫНКОВ (БЕЗ ЛОГИРОВАНИЯ)
// ============================================================================
async function findCryptoMarkets() {
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
                        // Пропускаем
                    }
                }

                if (tokenIds.length === 2 && market.conditionId) {
                    allCryptoMarkets.push({
                        question: market.question,
                        conditionId: market.conditionId,
                        slug: market.slug,
                        endDate: market.endDate,
                        tokens: [
                            { id: tokenIds[0], name: 'Up' },
                            { id: tokenIds[1], name: 'Down' }
                        ]
                    });
                }
            }
        }

        offset += limit;
    }

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

// ============================================================================
// УПРАВЛЕНИЕ ЖИЗНЕННЫМ ЦИКЛОМ РЫНКОВ
// ============================================================================
function cleanupExpiredMarkets() {
    const now = new Date();
    let cleanedCount = 0;

    for (const [conditionId, metadata] of Object.entries(marketsMetadata)) {
        const endDate = new Date(metadata.endDate);
        if (endDate < now) {
            delete orderbookStorage.data[metadata.tokens.Up];
            delete orderbookStorage.data[metadata.tokens.Down];
            delete marketsMetadata[conditionId];

            // Удаляем арбитражи для истекших рынков
            if (activeArbitrages.has(conditionId)) {
                activeArbitrages.delete(conditionId);
            }

            cleanedCount++;
        }
    }

    return cleanedCount;
}

async function scanAndUpdateMarkets() {
    systemStatus.marketRefreshStatus = 'scanning';

    try {
        const cleaned = cleanupExpiredMarkets();
        const allMarkets = await findCryptoMarkets();
        const futureMarkets = filterAndSortMarkets(allMarkets);

        const newMarkets = futureMarkets.filter(market =>
            !marketsMetadata[market.conditionId]
        );

        let needsReconnect = false;

        if (newMarkets.length > 0) {
            for (const market of newMarkets) {
                marketsMetadata[market.conditionId] = {
                    question: market.question,
                    slug: market.slug,
                    endDate: market.endDate,
                    tokens: {
                        Up: market.tokens[0].id,
                        Down: market.tokens[1].id
                    }
                };
            }

            activeMarkets = futureMarkets;
            needsReconnect = true;
        }

        systemStatus.marketRefreshStatus = 'waiting';

        return { cleaned, newMarkets: newMarkets.length, needsReconnect };
    } catch (error) {
        systemStatus.marketRefreshStatus = 'waiting';
        return { cleaned: 0, newMarkets: 0, needsReconnect: false };
    }
}

function startContinuousMarketScanning() {
    async function scan() {
        const result = await scanAndUpdateMarkets();

        if (result.needsReconnect && currentWebSocket) {
            currentWebSocket.close();
            setTimeout(() => {
                currentWebSocket = createWebSocketScanner(activeMarkets);
            }, 1000);
        }

        setTimeout(scan, 100);
    }

    scan();
}

// ============================================================================
// ПРОВЕРКА АРБИТРАЖА ДЛЯ КОНКРЕТНОГО РЫНКА
// ============================================================================
function checkArbitrageForMarket(conditionId) {
    const metadata = marketsMetadata[conditionId];
    if (!metadata) return;

    const upTokenId = metadata.tokens.Up;
    const downTokenId = metadata.tokens.Down;

    const upOrderbook = orderbookStorage.get(upTokenId);
    const downOrderbook = orderbookStorage.get(downTokenId);

    // Если нет данных - не проверяем
    if (!upOrderbook || !downOrderbook) return;
    if (!upOrderbook.asks.length || !downOrderbook.asks.length) return;

    const upAsk = upOrderbook.asks[upOrderbook.asks.length - 1].price;
    const downAsk = downOrderbook.asks[downOrderbook.asks.length - 1].price;
    const upAskSize = upOrderbook.asks[upOrderbook.asks.length - 1].size;
    const downAskSize = downOrderbook.asks[downOrderbook.asks.length - 1].size;

    const totalCost = upAsk + downAsk;
    const profit = 1 - totalCost;
    const now = Date.now();
    const preciseNow = performance.now();

    const isArbitrage = totalCost < 1;
    const existingArb = activeArbitrages.get(conditionId);

    if (isArbitrage) {
        // Арбитражная ситуация существует
        const arbVolume = Math.min(upAskSize, downAskSize);
        const dollarProfit = profit * arbVolume;

        if (!existingArb) {
            // Новая арбитражная ситуация - создаем
            activeArbitrages.set(conditionId, {
                conditionId,
                question: metadata.question,
                slug: metadata.slug,
                endDate: metadata.endDate,
                upAsk,
                downAsk,
                totalCost,
                profit,
                profitPercent: profit * 100,
                upSize: upAskSize,
                downSize: downAskSize,
                arbVolume,
                dollarProfit,
                firstSeen: now,
                firstSeenPrecise: preciseNow,
                lastSeen: now,
                // Фиксируем начальные значения
                initialUpAsk: upAsk,
                initialDownAsk: downAsk,
                initialTotalCost: totalCost,
                initialProfit: profit,
                initialProfitPercent: profit * 100,
                initialUpSize: upAskSize,
                initialDownSize: downAskSize,
                initialArbVolume: arbVolume,
                initialDollarProfit: dollarProfit
            });
        } else {
            // Обновляем существующую арбитражную ситуацию
            existingArb.lastSeen = now;
            existingArb.upAsk = upAsk;
            existingArb.downAsk = downAsk;
            existingArb.totalCost = totalCost;
            existingArb.profit = profit;
            existingArb.profitPercent = profit * 100;
            existingArb.upSize = upAskSize;
            existingArb.downSize = downAskSize;
            existingArb.arbVolume = arbVolume;
            existingArb.dollarProfit = dollarProfit;
        }
    } else {
        // Арбитражной ситуации нет
        if (existingArb) {
            // Арбитраж только что исчез - переносим в историю
            const durationMs = now - existingArb.firstSeen;
            const durationPrecise = preciseNow - existingArb.firstSeenPrecise;

            // Проверяем, что длительность разумная (> 0)
            if (durationMs >= 0) {
                arbitrageHistory.unshift({
                    ...existingArb,
                    active: false,
                    endedAt: now,
                    endedAtPrecise: preciseNow,
                    durationMs,
                    durationPrecise
                });

                // Ограничиваем историю
                if (arbitrageHistory.length > MAX_HISTORY) {
                    arbitrageHistory.length = MAX_HISTORY;
                }
            }

            // Удаляем из активных
            activeArbitrages.delete(conditionId);
        }
        // Если арбитража не было и нет - ничего не делаем
    }
}

// Находим conditionId по tokenId
function findConditionIdByToken(tokenId) {
    for (const [conditionId, metadata] of Object.entries(marketsMetadata)) {
        if (metadata.tokens.Up === tokenId || metadata.tokens.Down === tokenId) {
            return conditionId;
        }
    }
    return null;
}

// ============================================================================
// КОНТУР 1: СКАНИРОВАНИЕ И ОБНОВЛЕНИЕ ДАННЫХ + ПРОВЕРКА АРБИТРАЖА
// ============================================================================
async function initializeMarkets(markets) {
    for (const market of markets) {
        marketsMetadata[market.conditionId] = {
            question: market.question,
            slug: market.slug,
            endDate: market.endDate,
            tokens: {
                Up: market.tokens[0].id,
                Down: market.tokens[1].id
            }
        };
    }
}

function createWebSocketScanner(markets) {
    if (systemStatus.wsReconnecting) return;

    systemStatus.wsReconnecting = true;
    systemStatus.wsConnected = false;
    systemStatus.scannerActive = false;

    const allTokenIds = [];
    markets.forEach(market => {
        market.tokens.forEach(token => {
            allTokenIds.push(token.id);
        });
    });

    const ws = new WebSocket(wsHost);
    let pingInterval = null;

    ws.on('open', () => {
        systemStatus.wsConnected = true;
        systemStatus.wsReconnecting = false;
        systemStatus.scannerActive = true;

        const subscription = {
            assets_ids: allTokenIds,
            type: 'market'
        };

        ws.send(JSON.stringify(subscription));

        pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.ping();
            }
        }, 25000);
    });

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            const assetId = message.asset_id || message.market;

            if (!assetId) return;

            const eventType = message.event_type || message.type;

            if (eventType === 'book') {
                const rawBids = message.bids || [];
                const rawAsks = message.asks || [];

                const bids = rawBids.map(bid => ({
                    price: parseFloat(bid.price || bid[0]),
                    size: parseFloat(bid.size || bid[1])
                }));

                const asks = rawAsks.map(ask => ({
                    price: parseFloat(ask.price || ask[0]),
                    size: parseFloat(ask.size || ask[1])
                }));

                // Обновляем orderbook
                orderbookStorage.update(assetId, bids, asks);

                // Обновляем статистику сообщений
                const now = Date.now();
                systemStatus.totalMessagesReceived++;
                systemStatus.recentMessageTimestamps.push(now);
                systemStatus.recentMessageTimestamps = systemStatus.recentMessageTimestamps.filter(
                    ts => now - ts < 1000
                );
                systemStatus.messagesPerSecond = systemStatus.recentMessageTimestamps.length;

                // СРАЗУ проверяем арбитраж для этого рынка
                const conditionId = findConditionIdByToken(assetId);
                if (conditionId) {
                    checkArbitrageForMarket(conditionId);

                    // Учитываем проверку арбитража
                    systemStatus.arbitrageChecksPerformed++;
                    systemStatus.recentArbitrageChecks.push(now);
                    systemStatus.recentArbitrageChecks = systemStatus.recentArbitrageChecks.filter(
                        ts => now - ts < 1000
                    );
                    systemStatus.arbitrageChecksPerSecond = systemStatus.recentArbitrageChecks.length;
                }
            }
        } catch (error) {
            // Тихо игнорируем ошибки
        }
    });

    ws.on('ping', () => ws.pong());

    ws.on('error', (error) => {
        systemStatus.wsConnected = false;
        systemStatus.scannerActive = false;
    });

    ws.on('close', (code, reason) => {
        systemStatus.wsConnected = false;
        systemStatus.wsReconnecting = false;
        systemStatus.scannerActive = false;

        if (pingInterval) clearInterval(pingInterval);

        setTimeout(() => {
            currentWebSocket = createWebSocketScanner(markets);
        }, 3000);
    });

    return ws;
}

// ============================================================================
// ОТОБРАЖЕНИЕ РЕЗУЛЬТАТОВ
// ============================================================================
function getMarketRefreshStatusText() {
    if (systemStatus.marketRefreshStatus === 'scanning') {
        return '🔄 Scanning';
    }
    return '🔄 Continuous';
}

function getMemoryUsage() {
    const usage = process.memoryUsage();
    return {
        heapUsed: (usage.heapUsed / 1024 / 1024).toFixed(1),
        heapTotal: (usage.heapTotal / 1024 / 1024).toFixed(1),
        rss: (usage.rss / 1024 / 1024).toFixed(1),
        external: (usage.external / 1024 / 1024).toFixed(1)
    };
}

function getUptime() {
    const uptimeMs = Date.now() - systemStatus.startTime;
    const seconds = Math.floor(uptimeMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
        return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`;
    } else {
        return `${seconds}s`;
    }
}

function getDisplayFPS() {
    const now = Date.now();
    const timeSinceLastUpdate = now - systemStatus.lastDisplayUpdate;
    systemStatus.lastDisplayUpdate = now;

    if (timeSinceLastUpdate > 0) {
        return (1000 / timeSinceLastUpdate).toFixed(1);
    }
    return '0';
}

function formatTimeWithMs(timestamp) {
    const date = new Date(timestamp);
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');
    const ms = date.getMilliseconds().toString().padStart(3, '0');
    return `${hours}:${minutes}:${seconds}.${ms}`;
}

function displayArbitrageResults() {
    const memory = getMemoryUsage();
    const uptime = getUptime();
    const fps = getDisplayFPS();

    console.clear();
    console.log('═'.repeat(140));
    console.log('📈 MULTI-MARKET ARBITRAGE MONITOR');
    console.log('═'.repeat(140));

    // Первая строка статуса
    console.log(`Scanner: ${systemStatus.scannerActive ? '🟢 Active' : '🔴 Inactive'} | ` +
        `WebSocket: ${systemStatus.wsConnected ? '🟢 Connected' : systemStatus.wsReconnecting ? '🟡 Reconnecting' : '🔴 Disconnected'} | ` +
        `Market Refresh: ${getMarketRefreshStatusText()} | ` +
        `Uptime: ${uptime}`);

    // Вторая строка - основные метрики
    console.log(`Time: ${new Date().toLocaleTimeString()} | Markets: ${Object.keys(marketsMetadata).length} | ` +
        `Active Arbitrages: ${activeArbitrages.size} | History: ${arbitrageHistory.length} | ` +
        `Messages: ${systemStatus.totalMessagesReceived} (${systemStatus.messagesPerSecond.toFixed(1)}/s)`);

    // Третья строка - производительность и ресурсы
    console.log(`Arb Checks: ${systemStatus.arbitrageChecksPerformed} (${systemStatus.arbitrageChecksPerSecond.toFixed(1)}/s) | ` +
        `Display: ${fps} FPS | ` +
        `Memory: ${memory.heapUsed}MB / ${memory.heapTotal}MB (RSS: ${memory.rss}MB) | ` +
        `Orderbooks: ${Object.keys(orderbookStorage.data).length}`);

    console.log('');

    // Конвертируем Map в массив и сортируем
    const opportunities = Array.from(activeArbitrages.values()).sort((a, b) => b.profit - a.profit);

    if (opportunities.length > 0) {
        console.log('🎯 ТЕКУЩИЕ АРБИТРАЖНЫЕ ВОЗМОЖНОСТИ:');
        console.log('━'.repeat(140));

        opportunities.forEach((opp, idx) => {
            const endDate = new Date(opp.endDate);
            const minutesLeft = Math.round((endDate - new Date()) / 60000);
            const url = `https://polymarket.com/event/${opp.slug}`;

            const durationMs = Date.now() - opp.firstSeen;

            const metadata = marketsMetadata[opp.conditionId];
            if (!metadata) return;

            const upData = orderbookStorage.get(metadata.tokens.Up);
            const downData = orderbookStorage.get(metadata.tokens.Down);
            const upMsgPerSec = upData?.messagesPerSecond || 0;
            const downMsgPerSec = downData?.messagesPerSecond || 0;
            const totalMsgPerSec = upMsgPerSec + downMsgPerSec;

            console.log(`\n${idx + 1}. ${opp.question} | 🔗 ${url}`);
            console.log(`   ⏰ Closes in: ${minutesLeft} min (${endDate.toLocaleTimeString()})`);
            console.log(`   ⏱️  Detected: ${formatTimeWithMs(opp.firstSeen)} (${durationMs}ms ago)`);
            console.log(`   💰 Best Up Ask: ${(opp.upAsk || 0).toFixed(4)} (size: ${(opp.upSize || 0).toFixed(2)}) | Best Down Ask: ${(opp.downAsk || 0).toFixed(4)} (size: ${(opp.downSize || 0).toFixed(2)}) | Messages: ${totalMsgPerSec.toFixed(1)}/s`);
            console.log(`   💵 Total Cost: ${(opp.totalCost || 0).toFixed(4)} | Volume: ${opp.arbVolume.toFixed(2)}`);
            console.log(`   ✅ PROFIT: ${(opp.profit || 0).toFixed(4)} (${(opp.profitPercent || 0).toFixed(2)}%) | Dollar Profit: ${opp.dollarProfit.toFixed(2)}`);
        });

        console.log('');
    } else {
        console.log('ℹ️  No arbitrage opportunities found');
        console.log('');
    }

    // Показываем последние 10 из истории
    const recentHistory = arbitrageHistory.slice(0, 10);

    if (recentHistory.length > 0) {
        console.log('📜 ARBITRAGE HISTORY (last 10 of ' + arbitrageHistory.length + '):');
        console.log('━'.repeat(140));

        recentHistory.forEach((h, idx) => {
            const durationMs = h.durationMs || 0;
            const durationPrecise = h.durationPrecise || 0;
            const url = `https://polymarket.com/event/${h.slug}`;

            console.log(`\n${idx + 1}. 🔴 Closed | ${h.question} | 🔗 ${url}`);
            console.log(`   ⏱️  ${formatTimeWithMs(h.firstSeen)} → ${formatTimeWithMs(h.endedAt)} (${durationMs}ms / ${durationPrecise.toFixed(2)}ms precise) | ${h.initialProfitPercent.toFixed(2)}% | Volume: ${h.initialArbVolume.toFixed(2)} | Dollar Profit: ${h.initialDollarProfit.toFixed(2)}`);
        });

        console.log('');
    }

    if (opportunities.length === 0) {
        const sortedMarkets = Object.entries(marketsMetadata)
            .map(([id, m]) => ({ id, ...m }))
            .sort((a, b) => new Date(a.endDate) - new Date(b.endDate))
            .slice(0, 5);

        console.log('📊 UPCOMING MARKETS (next 5):');
        console.log('━'.repeat(140));

        sortedMarkets.forEach((m, idx) => {
            const upData = orderbookStorage.get(m.tokens.Up);
            const downData = orderbookStorage.get(m.tokens.Down);

            const upAsk = upData?.asks?.length > 0 ? upData.asks[upData.asks.length - 1].price : 0;
            const downAsk = downData?.asks?.length > 0 ? downData.asks[downData.asks.length - 1].price : 0;
            const totalCost = upAsk + downAsk;
            const endDate = new Date(m.endDate);
            const minutesLeft = Math.round((endDate - new Date()) / 60000);
            const url = `https://polymarket.com/event/${m.slug}`;

            const upMsgPerSec = upData?.messagesPerSecond || 0;
            const downMsgPerSec = downData?.messagesPerSecond || 0;
            const totalMsgPerSec = upMsgPerSec + downMsgPerSec;

            console.log(`\n${idx + 1}. ${m.question} | 🔗 ${url}`);
            console.log(`   ⏰ In ${minutesLeft} min | Total: ${totalCost.toFixed(4)} | Best Up Ask: ${upAsk.toFixed(4)} | Best Down Ask: ${downAsk.toFixed(4)} | Messages: ${totalMsgPerSec.toFixed(1)}/s`);
        });

        console.log('');
    }

    console.log('═'.repeat(140));
    console.log('Press Ctrl+C to stop');
}

function startDisplayUpdater(intervalMs = 100) {
    const displayInterval = setInterval(() => {
        displayArbitrageResults();
    }, intervalMs);

    return displayInterval;
}

// ============================================================================
// ГЛАВНАЯ ФУНКЦИЯ
// ============================================================================
(async () => {
    console.log('🎯 Multi-Market Arbitrage Monitor');
    console.log('═'.repeat(120));
    console.log('Initializing...\n');

    const allMarkets = await findCryptoMarkets();

    if (allMarkets.length === 0) {
        console.log('❌ No markets found');
        process.exit(1);
    }

    activeMarkets = filterAndSortMarkets(allMarkets);

    console.log(`✅ Found ${activeMarkets.length} active markets\n`);

    await initializeMarkets(activeMarkets);

    console.log('✅ Markets initialized (orderbooks will fill on first update)\n');

    // Запускаем WebSocket сканер (проверка арбитража происходит при каждом обновлении)
    currentWebSocket = createWebSocketScanner(activeMarkets);

    // Запускаем только обновление дисплея
    const displayInterval = startDisplayUpdater(100);

    // Запускаем непрерывное сканирование рынков
    startContinuousMarketScanning();

    // Обработка завершения
    process.on('SIGINT', () => {
        console.log('\n\n👋 Stopping monitor...');

        systemStatus.scannerActive = false;

        if (displayInterval) clearInterval(displayInterval);

        if (currentWebSocket && currentWebSocket.readyState === WebSocket.OPEN) {
            currentWebSocket.close();
        }

        process.exit(0);
    });
})();