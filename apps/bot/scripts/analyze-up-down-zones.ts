#!/usr/bin/env tsx
/**
 * Анализ: как часто mid (по трейдам) был в UP-зоне и рынок резолвнулся DOWN?
 * Какие признаки отличают UP от DOWN рынки?
 */
import * as fs from 'fs';
import * as zlib from 'zlib';
import * as readline from 'readline';
import * as path from 'path';

interface MarketAnalysis {
  file: string;
  resolution: 'UP' | 'DOWN' | '?';
  strike: number;
  finalCryptoPrice: number;
  // Price stats (from trade EWMA)
  firstPrice: number;
  avgPrice: number;
  maxPrice: number;
  minPrice: number;
  lastPrice: number;
  // Time in zones
  totalTrades: number;
  timeInUpZone: number;      // price 55-73
  timeInHighZone: number;    // price > 73
  timeInMidZone: number;     // price 40-55
  timeInLowZone: number;     // price < 40
  // Trajectory
  priceAt25pct: number;
  priceAt50pct: number;
  priceAt75pct: number;
  priceAtEnd: number;
  // Trade stats
  buyTrades: number;
  sellTrades: number;
  avgTradeSize: number;
  // Price movement
  maxDrawdownFromPeak: number;
  maxRallyFromBottom: number;
  // Crypto price
  deltaAtStart: number;
  deltaAtEnd: number;
  // EWMA prices at key points
  ewmaAt25: number;
  ewmaAt50: number;
  ewmaAt75: number;
  ewmaAtEnd: number;
}

async function analyzeMarket(filePath: string): Promise<MarketAnalysis | null> {
  const input = fs.createReadStream(filePath);
  const gunzip = zlib.createGunzip();
  const rl = readline.createInterface({ input: input.pipe(gunzip) });

  let meta: any = null;
  const prices: number[] = [];    // trade prices in cents
  const ewmaPrices: number[] = []; // EWMA smoothed
  let totalTrades = 0;
  let buyTrades = 0;
  let sellTrades = 0;
  let totalTradeSize = 0;
  let lastCryptoPrice = 0;
  let firstCryptoPrice = 0;
  let strike = 0;
  let tokenId = '';
  let ewma = 0;
  const ALPHA = 0.3;

  for await (const line of rl) {
    try {
      const event = JSON.parse(line);

      if (event.t === 'meta') {
        meta = event;
        tokenId = event.tokenIds?.[0] || '';
        const events = event.m?.events;
        if (Array.isArray(events) && events[0]?.eventMetadata?.priceToBeat) {
          strike = parseFloat(events[0].eventMetadata.priceToBeat);
        }
        continue;
      }

      if (event.event_type === 'last_trade_price' && event.asset_id === tokenId) {
        const price = parseFloat(event.price) * 100; // cents
        totalTrades++;
        if (event.side === 'BUY') buyTrades++;
        else sellTrades++;
        totalTradeSize += parseFloat(event.size || '0');
        prices.push(price);

        // EWMA
        if (ewma === 0) ewma = price;
        else ewma = ALPHA * price + (1 - ALPHA) * ewma;
        ewmaPrices.push(ewma);
        continue;
      }

      if (event.t === 'crypto_price' && event.symbol === 'btc/usd') {
        const price = event.price;
        if (!firstCryptoPrice) firstCryptoPrice = price;
        lastCryptoPrice = price;
        continue;
      }
    } catch (e) {
      continue;
    }
  }

  if (!meta || prices.length < 5 || strike === 0) return null;

  const resolution = lastCryptoPrice > strike ? 'UP' : lastCryptoPrice < strike ? 'DOWN' : '?';

  const n = prices.length;

  // Calculate zones using EWMA prices
  let timeInUpZone = 0, timeInHighZone = 0, timeInMidZone = 0, timeInLowZone = 0;
  for (const p of ewmaPrices) {
    if (p >= 55 && p <= 73) timeInUpZone++;
    else if (p > 73) timeInHighZone++;
    else if (p >= 40 && p < 55) timeInMidZone++;
    else timeInLowZone++; // < 40
  }

  // Max drawdown from peak / rally from bottom (EWMA)
  let peak = ewmaPrices[0], maxDD = 0;
  for (const p of ewmaPrices) {
    if (p > peak) peak = p;
    const dd = peak - p;
    if (dd > maxDD) maxDD = dd;
  }

  let bottom = ewmaPrices[0], maxRally = 0;
  for (const p of ewmaPrices) {
    if (p < bottom) bottom = p;
    const rally = p - bottom;
    if (rally > maxRally) maxRally = rally;
  }

  return {
    file: path.basename(filePath).replace('.jsonl.gz', ''),
    resolution: resolution as 'UP' | 'DOWN' | '?',
    strike,
    finalCryptoPrice: lastCryptoPrice,
    firstPrice: prices[0],
    avgPrice: prices.reduce((a, b) => a + b, 0) / n,
    maxPrice: Math.max(...prices),
    minPrice: Math.min(...prices),
    lastPrice: prices[n - 1],
    totalTrades: n,
    timeInUpZone,
    timeInHighZone,
    timeInMidZone,
    timeInLowZone,
    priceAt25pct: prices[Math.floor(n * 0.25)],
    priceAt50pct: prices[Math.floor(n * 0.50)],
    priceAt75pct: prices[Math.floor(n * 0.75)],
    priceAtEnd: prices[n - 1],
    buyTrades,
    sellTrades,
    avgTradeSize: totalTrades > 0 ? totalTradeSize / totalTrades : 0,
    maxDrawdownFromPeak: maxDD,
    maxRallyFromBottom: maxRally,
    deltaAtStart: firstCryptoPrice ? (firstCryptoPrice - strike) / strike * 100 : 0,
    deltaAtEnd: lastCryptoPrice ? (lastCryptoPrice - strike) / strike * 100 : 0,
    ewmaAt25: ewmaPrices[Math.floor(n * 0.25)],
    ewmaAt50: ewmaPrices[Math.floor(n * 0.50)],
    ewmaAt75: ewmaPrices[Math.floor(n * 0.75)],
    ewmaAtEnd: ewmaPrices[n - 1],
  };
}

function avg(arr: number[]): number {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function median(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b);
  return s.length > 0 ? s[Math.floor(s.length / 2)] : 0;
}

async function main() {
  const dirs = [
    '/tmp/15min-btc-day1',
    '/tmp/15min-btc-day2',
    '/tmp/15min-btc-day4',
    '/tmp/15min-btc-day5',
  ];

  const allResults: MarketAnalysis[] = [];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) { console.log(`SKIP ${dir}`); continue; }
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl.gz'));
    console.log(`Processing ${dir}: ${files.length} files`);

    for (const file of files) {
      const result = await analyzeMarket(path.join(dir, file));
      if (result) allResults.push(result);
    }
  }

  const up = allResults.filter(r => r.resolution === 'UP');
  const down = allResults.filter(r => r.resolution === 'DOWN');

  console.log(`\n${'='.repeat(60)}`);
  console.log(`OVERALL: ${allResults.length} markets (UP: ${up.length}, DOWN: ${down.length})`);
  console.log(`${'='.repeat(60)}`);

  // ─── KEY QUESTION: DOWN markets in UP zone ───
  console.log(`\n=== КАК ЧАСТО DOWN РЫНОК ПРОВОДИЛ ВРЕМЯ В "UP ЗОНЕ" (55-73¢)? ===`);
  for (const threshold of [0.1, 0.2, 0.3, 0.5]) {
    const downInZone = down.filter(r => r.timeInUpZone / r.totalTrades > threshold);
    const upInZone = up.filter(r => r.timeInUpZone / r.totalTrades > threshold);
    const total = downInZone.length + upInZone.length;
    console.log(`>${(threshold * 100).toFixed(0)}% time in 55-73¢: ${downInZone.length} DOWN, ${upInZone.length} UP → P(DOWN|zone) = ${total > 0 ? (downInZone.length / total * 100).toFixed(1) : 'n/a'}% (n=${total})`);
  }

  // ─── Zone time distribution ───
  console.log(`\n=== РАСПРЕДЕЛЕНИЕ ВРЕМЕНИ ПО ЗОНАМ (% трейдов) ===`);
  console.log(`Zone            | UP markets | DOWN markets`);
  console.log(`Low <40¢        | ${avg(up.map(r => r.timeInLowZone / r.totalTrades * 100)).toFixed(1)}%      | ${avg(down.map(r => r.timeInLowZone / r.totalTrades * 100)).toFixed(1)}%`);
  console.log(`Mid 40-55¢      | ${avg(up.map(r => r.timeInMidZone / r.totalTrades * 100)).toFixed(1)}%      | ${avg(down.map(r => r.timeInMidZone / r.totalTrades * 100)).toFixed(1)}%`);
  console.log(`UP zone 55-73¢  | ${avg(up.map(r => r.timeInUpZone / r.totalTrades * 100)).toFixed(1)}%      | ${avg(down.map(r => r.timeInUpZone / r.totalTrades * 100)).toFixed(1)}%`);
  console.log(`High >73¢       | ${avg(up.map(r => r.timeInHighZone / r.totalTrades * 100)).toFixed(1)}%      | ${avg(down.map(r => r.timeInHighZone / r.totalTrades * 100)).toFixed(1)}%`);

  // ─── EWMA trajectory ───
  console.log(`\n=== EWMA TRAJECTORY (avg across markets) ===`);
  console.log(`Percentile | UP markets | DOWN markets`);
  console.log(`25%        | ${avg(up.map(r => r.ewmaAt25)).toFixed(1)}¢     | ${avg(down.map(r => r.ewmaAt25)).toFixed(1)}¢`);
  console.log(`50%        | ${avg(up.map(r => r.ewmaAt50)).toFixed(1)}¢     | ${avg(down.map(r => r.ewmaAt50)).toFixed(1)}¢`);
  console.log(`75%        | ${avg(up.map(r => r.ewmaAt75)).toFixed(1)}¢     | ${avg(down.map(r => r.ewmaAt75)).toFixed(1)}¢`);
  console.log(`End        | ${avg(up.map(r => r.ewmaAtEnd)).toFixed(1)}¢     | ${avg(down.map(r => r.ewmaAtEnd)).toFixed(1)}¢`);

  // ─── Avg price ───
  console.log(`\n=== СРЕДНИЕ ЦЕНЫ ===`);
  console.log(`UP avg price: ${avg(up.map(r => r.avgPrice)).toFixed(1)}¢ (median: ${median(up.map(r => r.avgPrice)).toFixed(1)}¢)`);
  console.log(`DOWN avg price: ${avg(down.map(r => r.avgPrice)).toFixed(1)}¢ (median: ${median(down.map(r => r.avgPrice)).toFixed(1)}¢)`);

  // ─── Delta ───
  console.log(`\n=== CRYPTO DELTA (% от strike) ===`);
  console.log(`UP avg delta at start: ${avg(up.map(r => r.deltaAtStart)).toFixed(4)}%`);
  console.log(`DOWN avg delta at start: ${avg(down.map(r => r.deltaAtStart)).toFixed(4)}%`);
  console.log(`UP avg delta at end: ${avg(up.map(r => r.deltaAtEnd)).toFixed(4)}%`);
  console.log(`DOWN avg delta at end: ${avg(down.map(r => r.deltaAtEnd)).toFixed(4)}%`);

  // ─── Drawdown/Rally ───
  console.log(`\n=== MAX DRAWDOWN / RALLY (EWMA, cents) ===`);
  console.log(`UP max drawdown avg: ${avg(up.map(r => r.maxDrawdownFromPeak)).toFixed(1)}¢`);
  console.log(`DOWN max drawdown avg: ${avg(down.map(r => r.maxDrawdownFromPeak)).toFixed(1)}¢`);
  console.log(`UP max rally avg: ${avg(up.map(r => r.maxRallyFromBottom)).toFixed(1)}¢`);
  console.log(`DOWN max rally avg: ${avg(down.map(r => r.maxRallyFromBottom)).toFixed(1)}¢`);

  // ─── Trade imbalance ───
  console.log(`\n=== TRADE SIDE IMBALANCE ===`);
  const buyRatioUp = avg(up.map(r => r.totalTrades > 0 ? r.buyTrades / r.totalTrades : 0.5));
  const buyRatioDown = avg(down.map(r => r.totalTrades > 0 ? r.buyTrades / r.totalTrades : 0.5));
  console.log(`UP buy ratio: ${(buyRatioUp * 100).toFixed(1)}%`);
  console.log(`DOWN buy ratio: ${(buyRatioDown * 100).toFixed(1)}%`);

  // ─── Conditional win rates ───
  console.log(`\n=== WIN RATE ПО EWMA В РАЗНЫЕ МОМЕНТЫ ===`);

  // At 50% of time
  console.log(`\nIf EWMA@50% >= threshold:`);
  for (const t of [30, 40, 45, 50, 55, 60, 65, 70, 75, 80]) {
    const upAbove = up.filter(r => r.ewmaAt50 >= t).length;
    const downAbove = down.filter(r => r.ewmaAt50 >= t).length;
    const total = upAbove + downAbove;
    if (total >= 5) {
      console.log(`  EWMA@50% >= ${t}¢: ${upAbove} UP, ${downAbove} DOWN → WR ${(upAbove / total * 100).toFixed(1)}% (n=${total})`);
    }
  }

  // At 75% of time
  console.log(`\nIf EWMA@75% >= threshold:`);
  for (const t of [30, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90]) {
    const upAbove = up.filter(r => r.ewmaAt75 >= t).length;
    const downAbove = down.filter(r => r.ewmaAt75 >= t).length;
    const total = upAbove + downAbove;
    if (total >= 5) {
      console.log(`  EWMA@75% >= ${t}¢: ${upAbove} UP, ${downAbove} DOWN → WR ${(upAbove / total * 100).toFixed(1)}% (n=${total})`);
    }
  }

  // ─── Trajectory: rising vs falling ───
  console.log(`\n=== TRAJECTORY: EWMA 50% vs 25% ===`);
  const risingUp = up.filter(r => r.ewmaAt50 > r.ewmaAt25 + 3).length;
  const risingDown = down.filter(r => r.ewmaAt50 > r.ewmaAt25 + 3).length;
  const fallingUp = up.filter(r => r.ewmaAt50 < r.ewmaAt25 - 3).length;
  const fallingDown = down.filter(r => r.ewmaAt50 < r.ewmaAt25 - 3).length;
  const flatUp = up.length - risingUp - fallingUp;
  const flatDown = down.length - risingDown - fallingDown;
  console.log(`Rising (>3¢): ${risingUp} UP, ${risingDown} DOWN → WR ${(risingUp / (risingUp + risingDown) * 100).toFixed(1)}%`);
  console.log(`Flat (±3¢):   ${flatUp} UP, ${flatDown} DOWN → WR ${(flatUp / (flatUp + flatDown) * 100).toFixed(1)}%`);
  console.log(`Falling (<-3¢): ${fallingUp} UP, ${fallingDown} DOWN → WR ${(fallingUp / (fallingUp + fallingDown) * 100).toFixed(1)}%`);

  // ─── Best discriminators ───
  console.log(`\n=== КОНКРЕТНЫЕ DOWN РЫНКИ С ВЫСОКИМ EWMA@75% ===`);
  const downHighEwma = down.filter(r => r.ewmaAt75 >= 55).sort((a, b) => b.ewmaAt75 - a.ewmaAt75);
  console.log(`DOWN markets with EWMA@75% >= 55¢: ${downHighEwma.length}`);
  for (const m of downHighEwma.slice(0, 20)) {
    console.log(`  ewma75=${m.ewmaAt75.toFixed(1)}¢ ewmaEnd=${m.ewmaAtEnd.toFixed(1)}¢ delta=${m.deltaAtEnd.toFixed(4)}% trades=${m.totalTrades} | ${m.file.substring(0, 55)}`);
  }

  // ─── Combined filter ───
  console.log(`\n=== COMBINED FILTER: EWMA@75% + deltaAtStart ===`);
  for (const ewmaThresh of [55, 60, 65]) {
    for (const deltaThresh of [0.01, 0.02, 0.03, 0.05]) {
      const upMatch = up.filter(r => r.ewmaAt75 >= ewmaThresh && r.deltaAtStart >= deltaThresh).length;
      const downMatch = down.filter(r => r.ewmaAt75 >= ewmaThresh && r.deltaAtStart >= deltaThresh).length;
      const total = upMatch + downMatch;
      if (total >= 5) {
        console.log(`  EWMA@75%>=${ewmaThresh}¢ + delta>=${deltaThresh}%: ${upMatch} UP, ${downMatch} DOWN → WR ${(upMatch / total * 100).toFixed(1)}% (n=${total})`);
      }
    }
  }

  // ─── Delta start distribution ───
  console.log(`\n=== DELTA AT START DISTRIBUTION ===`);
  const deltaStartUp = up.map(r => r.deltaAtStart).sort((a, b) => a - b);
  const deltaStartDown = down.map(r => r.deltaAtStart).sort((a, b) => a - b);
  for (const p of [10, 25, 50, 75, 90]) {
    const uv = deltaStartUp[Math.floor(deltaStartUp.length * p / 100)] || 0;
    const dv = deltaStartDown[Math.floor(deltaStartDown.length * p / 100)] || 0;
    console.log(`P${p.toString().padStart(2)}: UP delta=${uv.toFixed(4)}%  DOWN delta=${dv.toFixed(4)}%`);
  }

  // ─── Win rate by delta at start ───
  console.log(`\n=== WIN RATE BY DELTA AT START ===`);
  for (const d of [-0.1, -0.05, -0.02, 0, 0.02, 0.05, 0.1]) {
    const upAbove = up.filter(r => r.deltaAtStart >= d).length;
    const downAbove = down.filter(r => r.deltaAtStart >= d).length;
    const total = upAbove + downAbove;
    if (total >= 5) {
      console.log(`  delta >= ${d.toFixed(2)}%: ${upAbove} UP, ${downAbove} DOWN → WR ${(upAbove / total * 100).toFixed(1)}% (n=${total})`);
    }
  }
}

main().catch(console.error);
