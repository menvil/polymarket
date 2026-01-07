import dotenv from 'dotenv';
dotenv.config();

import { ClobClient } from '@polymarket/clob-client';
import WebSocket from 'ws';

const host = 'https://clob.polymarket.com';
const wsHost = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const chainId = 137;

const publicClient = new ClobClient(host, chainId);

// Конфигурация
const CONFIG = {
    conditionId: '0x0ba93cf49eb1d20cf1a600cf98f710b7772014fc8f4b2ec1dbf59119ccfc8e7e',
    tokens: [
        {
            id: '55298208730816027875886112995232369193404239975868526834254785776939589194244',
            name: 'Up'
        },
        {
            id: '40802100857038510979497284567714422155268764242510635404826254607154196773899',
            name: 'Down'
        }
    ]
};

// Хранилище orderbook данных
const orderbookData = {
    Up: { bestBid: null, bestAsk: null, lastUpdate: null, messagesReceived: 0 },
    Down: { bestBid: null, bestAsk: null, lastUpdate: null, messagesReceived: 0 }
};

// Статус подключения
let wsConnected = false;
let wsReconnecting = false;

// Функция для получения начальных данных orderbook
async function getInitialOrderbook(tokenId, tokenName) {
    try {
        console.log(`📊 Получаем начальный orderbook для ${tokenName}...`);
        const orderbook = await publicClient.getOrderBook(tokenId);

        const bestBid = orderbook.bids?.[0];
        const bestAsk = orderbook.asks?.[0];

        orderbookData[tokenName] = {
            bestBid: bestBid ? {
                price: parseFloat(bestBid.price),
                size: parseFloat(bestBid.size)
            } : null,
            bestAsk: bestAsk ? {
                price: parseFloat(bestAsk.price),
                size: parseFloat(bestAsk.size)
            } : null,
            lastUpdate: new Date(),
            messagesReceived: 0
        };

        return true;
    } catch (error) {
        console.error(`❌ Ошибка получения orderbook для ${tokenName}:`, error.message);
        return false;
    }
}

// Отображение orderbook
function displayOrderbook() {
    console.clear();
    console.log('═'.repeat(80));
    console.log('📈 REAL-TIME ORDERBOOK MONITOR');
    console.log('═'.repeat(80));
    console.log(`Condition ID: ${CONFIG.conditionId}`);
    console.log(`WebSocket: ${wsConnected ? '🟢 Connected' : wsReconnecting ? '🟡 Reconnecting' : '🔴 Disconnected'}`);
    console.log(`Время: ${new Date().toLocaleTimeString()}`);
    console.log('');

    CONFIG.tokens.forEach(token => {
        const data = orderbookData[token.name];

        console.log(`🎲 ${token.name}`);
        console.log('━'.repeat(40));

        if (data.lastUpdate) {
            const secondsAgo = Math.floor((Date.now() - data.lastUpdate.getTime()) / 1000);
            console.log(`  Updated: ${secondsAgo}s ago`);
        }

        console.log(`  Messages: ${data.messagesReceived}`);
        console.log('');
    });

    // Арбитражный анализ
    const upAsk = orderbookData.Up?.bestAsk?.price;
    const downAsk = orderbookData.Down?.bestAsk?.price;

    if (upAsk && downAsk) {
        const totalCost = upAsk + downAsk;

        console.log('━'.repeat(40));
        console.log('💰 АРБИТРАЖ АНАЛИЗ');
        console.log('━'.repeat(40));
        console.log(`  Up Ask: $${upAsk.toFixed(4)}`);
        console.log(`  Down Ask: $${downAsk.toFixed(4)}`);
        console.log(`  Total Cost (Up + Down): $${totalCost.toFixed(4)}`);

        if (totalCost < 0.995) { // риск-резерв под комиссии и проскальзывание
            const profit = 1 - totalCost;
            console.log(`  ✅ ВОЗМОЖНОСТЬ АРБИТРАЖА!`);
            console.log(`     Потенциальный профит: $${profit.toFixed(4)} (${(profit*100).toFixed(2)}%)`);
        } else if (totalCost > 1.01) {
            console.log(`  ⚠️  Сумма ask > $1.00 — overpriced`);
        } else {
            console.log(`  ℹ️  Сумма ask ≈ $1.00 — справедливая цена`);
        }

        console.log('═'.repeat(80));
        console.log('Нажмите Ctrl+C для остановки');
    }
}

// Создание единого WebSocket для обоих токенов
function createWebSocket() {
    if (wsReconnecting) return;

    wsReconnecting = true;
    wsConnected = false;
    displayOrderbook();

    console.log('🔌 Подключение к WebSocket...');

    const ws = new WebSocket(wsHost);
    let pingInterval = null;

    ws.on('open', () => {
        console.log('✅ WebSocket соединение установлено');
        wsConnected = true;
        wsReconnecting = false;

        // Подписываемся на оба токена
        const subscription = {
            assets_ids: CONFIG.tokens.map(t => t.id),
            type: 'market'
        };

        console.log('📡 Отправка подписки:', JSON.stringify(subscription));
        ws.send(JSON.stringify(subscription));

        displayOrderbook();

        // Ping каждые 25 секунд
        pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.ping();
            }
        }, 25000);
    });

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());

            // Определяем к какому токену относится сообщение
            const assetId = message.asset_id || message.market;

            if (!assetId) {
                // Игнорируем сообщения без asset_id (например, подтверждения подписки)
                return;
            }

            // Находим токен
            const token = CONFIG.tokens.find(t => t.id === assetId);
            if (!token) return;

            const tokenName = token.name;

            // Увеличиваем счётчик
            orderbookData[tokenName].messagesReceived++;

            // Обработка разных типов сообщений
            const eventType = message.event_type || message.type;

            if (eventType === 'book') {
                // Полное обновление orderbook
                const bids = message.bids || [];
                const asks = message.asks || [];

                if (bids.length > 0) {
                    const bid = bids[0];
                    orderbookData[tokenName].bestBid = {
                        price: parseFloat(bid.price || bid[0]),
                        size: parseFloat(bid.size || bid[1])
                    };
                }

                if (asks.length > 0) {
                    const ask = asks[0];
                    orderbookData[tokenName].bestAsk = {
                        price: parseFloat(ask.price || ask[0]),
                        size: parseFloat(ask.size || ask[1])
                    };
                }

                orderbookData[tokenName].lastUpdate = new Date();
                displayOrderbook();

            }

        } catch (error) {
            console.error('❌ Ошибка обработки сообщения:', error.message);
        }
    });

    ws.on('ping', () => {
        ws.pong();
    });

    ws.on('pong', () => {
        // Получили pong от сервера
    });

    ws.on('error', (error) => {
        console.error('❌ WebSocket ошибка:', error.message);
        wsConnected = false;
        displayOrderbook();
    });

    ws.on('close', (code, reason) => {
        console.log(`⚠️  WebSocket закрыт (код: ${code}, причина: ${reason?.toString() || 'N/A'})`);

        wsConnected = false;
        wsReconnecting = false;

        if (pingInterval) {
            clearInterval(pingInterval);
        }

        displayOrderbook();

        // Переподключаемся через 3 секунды
        console.log('🔄 Переподключение через 3 секунды...');
        setTimeout(() => {
            createWebSocket();
        }, 3000);
    });

    return ws;
}

// ГЛАВНАЯ ФУНКЦИЯ
(async () => {
    console.log('🎯 Polymarket Orderbook Monitor');
    console.log('═'.repeat(80));
    console.log('');
    console.log('⚙️  Конфигурация:');
    console.log(`   Condition ID: ${CONFIG.conditionId.slice(0, 20)}...`);
    CONFIG.tokens.forEach(t => {
        console.log(`   ${t.name}: ${t.id.slice(0, 20)}...`);
    });
    console.log('');

    // Получаем начальные данные
    console.log('📊 Загрузка начальных данных orderbook...\n');

    for (const token of CONFIG.tokens) {
        await getInitialOrderbook(token.id, token.name);
    }

    displayOrderbook();

    console.log('');

    // Создаём WebSocket соединение
    const ws = createWebSocket();

    // Обработка завершения
    process.on('SIGINT', () => {
        console.log('\n\n👋 Остановка мониторинга...');
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.close();
        }
        process.exit(0);
    });
})();