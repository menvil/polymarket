/**
 * Debug-скрипт для проверки что возвращает Gamma API для наших рынков.
 * Запуск: npx tsx --env-file=../bot/.env src/debug-market.ts
 */
import { PolymarketRestClient, SignatureType } from '@polymarket/exchange/rest';
import { ColorConsoleLogger, LogLevel } from '@polymarket/logger';
import { LiveClock } from '@polymarket/time';

async function main() {
  const logger = new ColorConsoleLogger(new LiveClock(), LogLevel.ERROR);
  const funderAddress = process.env['FUNDER_ADDRESS'];
  const restClient = new PolymarketRestClient({
    baseUrl: 'https://clob.polymarket.com',
    privateKey: process.env['PRIVATE_KEY']!,
    chainId: 137,
    signatureType: funderAddress ? SignatureType.POLY_PROXY : SignatureType.EOA,
    funderAddress,
    l2Credentials: {
      apiKey: process.env['POLYMARKET_API_KEY']!,
      secret: process.env['POLYMARKET_API_SECRET']!,
      passphrase: process.env['POLYMARKET_API_PASSPHRASE']!,
    },
  }, logger);

  const resp = await restClient.get<{ data: Array<{ market: string; asset_id: string; side: string; size: string; price: string }> } | Array<{ market: string; asset_id: string; side: string; size: string; price: string }>>(
    '/data/trades',
    {
      maker_address: funderAddress || '',
      after: '1775520000',
      before: '1775606399',
    }
  );

  const trades = Array.isArray(resp) ? resp : (resp as { data: typeof resp }).data;
  const conditionIds = [...new Set(trades.map(t => t.market))];

  console.log(`Total trades: ${trades.length}, unique markets: ${conditionIds.length}`);
  console.log('Sample conditionId:', conditionIds[0]);

  // Проверяем первые 3 через Gamma API
  for (const cid of conditionIds.slice(0, 3)) {
    const r = await fetch(`https://gamma-api.polymarket.com/markets?conditionId=${cid}`);
    const data = await r.json() as Array<Record<string, unknown>>;
    const m = data[0];
    if (m) {
      console.log(`\nMarket: ${String(m['question']).slice(0, 60)}`);
      console.log(`  conditionId: ${m['conditionId']}`);
      console.log(`  closed: ${m['closed']}, active: ${m['active']}`);
      console.log(`  outcomePrices: ${m['outcomePrices']}`);
      console.log(`  outcomes: ${m['outcomes']}`);
      console.log(`  clobTokenIds: ${String(m['clobTokenIds']).slice(0, 80)}`);
    } else {
      console.log(`\nMarket ${cid}: NOT FOUND in Gamma API`);
    }
  }
}

main().catch(console.error);
