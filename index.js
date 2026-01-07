import dotenv from 'dotenv';
dotenv.config();

// Поиск Bitcoin рынков с выводом ПОЛНЫХ данных
async function findBitcoinMarkets() {
    console.log('🔍 Поиск через пагинацию открытых рынков...\n');

    const allBtcMarkets = [];
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

        if (!response.ok) {
            console.log(`❌ Ошибка HTTP ${response.status} на странице ${page + 1}`);
            break;
        }

        const markets = await response.json();
        if (markets.length === 0) {
            console.log(`📄 Страница ${page + 1}: рынки закончились`);
            break;
        }

        console.log(`📄 Страница ${page + 1}: получено ${markets.length} рынков`);

        // Ищем Bitcoin рынки
        const btcMatches = markets.filter(m => {
            const question = (m.question || '').toLowerCase();
            return m.active && !m.closed && m.enableOrderBook && (question.includes('bitcoin') && question.includes('up') && question.includes('down') && question.includes('december 22'));
        });

        if (btcMatches.length > 0) {
            console.log(`   ✅ Найдено ${btcMatches.length} "Bitcoin Up or Down" рынков`);

            for (const market of btcMatches) {
                console.log(`\n   📍 ${market.question}`);
                console.log(`      Slug: ${market.slug || market.id || 'N/A'}`);

                // Получаем полные детали рынка
                const fullMarket = market;

                if (fullMarket && fullMarket.clobTokenIds && fullMarket.clobTokenIds.length > 0) {
                    console.log(`      ✅ Получены детали: ${fullMarket.clobTokenIds.length} токенов`);
                    console.log(`      Condition ID: ${fullMarket.conditionId}`);
                    console.log(`      End Date: ${fullMarket.endDate}`);
                    allBtcMarkets.push(fullMarket);
                } else {
                    console.log(`      ❌ Не удалось получить детали или нет токенов`);
                }
            }
        }

        offset += limit;
    }

    return allBtcMarkets;

}
// Получить полные детали рынка
async function getFullMarketDetails(marketSlug) {
    try {
        // Используем другой endpoint для получения полных данных
        const response = await fetch(`https://strapi-matic.poly.market/markets?slug=${marketSlug}`);

        if (!response.ok) {
            return null;
        }

        const market = await response.json();
        return market;
    } catch (error) {
        return null;
    }
}
// ГЛАВНАЯ ФУНКЦИЯ
(async () => {
    console.log('🎯 Анализ структуры данных Bitcoin Up or Down рынков');
    console.log('═'.repeat(80));
    console.log('');

    const btcMarkets = await findBitcoinMarkets();

    if (btcMarkets.length === 0) {
        console.log('❌ Bitcoin Up or Down рынки не найдены');
        return;
    }

    const now = new Date();

    // Фильтруем только рынки, которые ещё не закрылись
    const futureMarkets = btcMarkets.filter(m => {
        const endDate = new Date(m.endDate);
        return endDate > now;
    });

    // Сортируем по времени (ближайшие первыми)
    btcMarkets.sort((a, b) => {
        const dateA = new Date(a.endDate);
        const dateB = new Date(b.endDate);
        return dateA - dateB;
    });

    console.log('');
    console.log('═'.repeat(80));
    console.log(`📊 Найдено ${btcMarkets.length} Bitcoin Up or Down рынков`);
    console.log('═'.repeat(80));
    console.log('');

    // Выводим ПОЛНЫЕ данные первого рынка
    console.log('📋 ПОЛНЫЕ ДАННЫЕ ПЕРВОГО РЫНКА (JSON):');
    console.log('━'.repeat(80));
    console.log(JSON.stringify(btcMarkets[0], null, 2));
    console.log('━'.repeat(80));
    console.log('');

    // Анализ структуры
    console.log('🔍 АНАЛИЗ ПОЛЕЙ ПЕРВОГО РЫНКА:');
    console.log('━'.repeat(80));

    const market = btcMarkets[0];
    const keys = Object.keys(market);

    console.log(`\nВсего полей: ${keys.length}\n`);

    keys.forEach(key => {
        const value = market[key];
        const type = Array.isArray(value) ? 'array' : typeof value;

        let preview = '';
        if (type === 'string') {
            preview = ` = "${value.slice(0, 60)}${value.length > 60 ? '...' : ''}"`;
        } else if (type === 'array') {
            preview = ` [${value.length} элементов]`;
            if (value.length > 0 && value.length <= 3) {
                preview += ` = ${JSON.stringify(value)}`;
            }
        } else if (type === 'object' && value !== null) {
            const objKeys = Object.keys(value);
            preview = ` {${objKeys.length} полей: ${objKeys.slice(0, 3).join(', ')}...}`;
        } else if (type === 'number' || type === 'boolean') {
            preview = ` = ${value}`;
        } else if (value === null) {
            preview = ' = null';
        }

        console.log(`  ${key} (${type})${preview}`);
    });

    console.log('\n');
    console.log('━'.repeat(80));
    console.log('🎯 КЛЮЧЕВЫЕ ПОЛЯ ДЛЯ ТОКЕНОВ:');
    console.log('━'.repeat(80));
    console.log('');

    // Проверяем все возможные поля с токенами
    const tokenFields = [
        'tokens',
        'clobTokenIds',
        'markets',
        'outcomes',
        'tokenIds',
        'clob_token_ids'
    ];

    tokenFields.forEach(field => {
        if (market[field] !== undefined) {
            console.log(`✅ ${field}:`);
            console.log(JSON.stringify(market[field], null, 2));
            console.log('');
        } else {
            console.log(`❌ ${field}: не найдено`);
        }
    });

    console.log('');
    console.log('━'.repeat(80));
    console.log('📝 КРАТКИЙ СПИСОК ВСЕХ НАЙДЕННЫХ РЫНКОВ:');
    console.log('━'.repeat(80));
    console.log('');

    btcMarkets.forEach((m, idx) => {
        console.log(`${idx + 1}. ${m.question}`);
        console.log(`   • id: ${m.id || 'N/A'}`);
        console.log(`   • slug: ${m.slug || 'N/A'}`);
        console.log(`   • condition_id: ${m.conditionId || 'N/A'}`);
        console.log(`   • clobTokenIds: ${m.clobTokenIds || 'N/A'}`);
        console.log(`   • EndDate: ${m.endDate || 'N/A'}`);
        console.log('');
    });

    console.log('━'.repeat(80));
    console.log('\n💡 Следующий шаг:');
    console.log('   Посмотрите на JSON выше и найдите поле с token_id');
    console.log('   Скорее всего это одно из: clobTokenIds, markets, или tokens');
    console.log('');
})();