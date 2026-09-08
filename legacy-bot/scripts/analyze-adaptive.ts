#!/usr/bin/env tsx
/**
 * Adaptive анализ: для каждого рынка смотрим ОБА токена,
 * покупаем тот который сильнее (EWMA выше и растёт больше).
 * Один вход на рынок, hold до settlement.
 */
import * as fs from 'fs';
import * as zlib from 'zlib';
import * as readline from 'readline';
import * as path from 'path';

interface TokenData {
  ewmaAt25: number | null;
  ewmaAt50: number | null;
  ewmaCurrent: number;
  tradeCount: number;
  lastPrice: number;
}

interface MarketResult {
  file: string;
  resolution: 'UP' | 'DOWN' | '?';
  upEwma50: number;
  downEwma50: number;
  upRise: number;    // ewma@50 - ewma@25
  downRise: number;
  decision: 'BUY_UP' | 'BUY_DOWN' | 'SKIP';
  entryPrice: number;
  pnl: number;
  correct: boolean;
}

async function analyzeMarket(filePath: string): Promise<MarketResult | null> {
  const input = fs.createReadStream(filePath);
  const gunzip = zlib.createGunzip();
  const rl = readline.createInterface({ input: input.pipe(gunzip) });

  let tokenIds: string[] = [];
  let strike = 0;
  let eventStartMs = 0;
  let expiresMs = 0;
  let lastCryptoPrice = 0;

  // Per-token EWMA tracking
  const tokens: Record<string, { ewma: number | null; count: number; lastTs: number; ewmaAt25: number | null; ewmaAt50: number | null; at25Captured: boolean; at50Captured: boolean }> = {};

  for await (const line of rl) {
    try {
      const event = JSON.parse(line);

      if (event.t === 'meta') {
        tokenIds = event.tokenIds || [];
        const events = event.m?.events;
        if (Array.isArray(events) && events[0]?.eventMetadata?.priceToBeat) {
          strike = parseFloat(events[0].eventMetadata.priceToBeat);
        }
        if (event.m?.endDate) {
          expiresMs = new Date(event.m.endDate).getTime();
        }
        if (events?.[0]?.startTime) {
          eventStartMs = new Date(events[0].startTime).getTime();
        } else if (event.m?.eventStartTime) {
          eventStartMs = new Date(event.m.eventStartTime).getTime();
        }
        for (const tid of tokenIds) {
          tokens[tid] = { ewma: null, count: 0, lastTs: 0, ewmaAt25: null, ewmaAt50: null, at25Captured: false, at50Captured: false };
        }
        continue;
      }

      if (event.event_type === 'last_trade_price' && tokens[event.asset_id]) {
        const tid = event.asset_id;
        const ts = parseInt(event.timestamp);
        const tok = tokens[tid];
        if (ts <= tok.lastTs) continue;

        const price = parseFloat(event.price) * 100;
        tok.ewma = tok.ewma === null ? price : 0.3 * price + 0.7 * tok.ewma;
        tok.count++;
        tok.lastTs = ts;

        // Capture at time milestones
        if (eventStartMs > 0 && expiresMs > eventStartMs) {
          const pct = (ts - eventStartMs) / (expiresMs - eventStartMs);
          if (!tok.at25Captured && pct >= 0.25) {
            tok.ewmaAt25 = tok.ewma;
            tok.at25Captured = true;
          }
          if (!tok.at50Captured && pct >= 0.50) {
            tok.ewmaAt50 = tok.ewma;
            tok.at50Captured = true;
          }
        }
        continue;
      }

      if (event.t === 'crypto_price' && event.symbol === 'btc/usd') {
        lastCryptoPrice = event.price;
        continue;
      }
    } catch (e) { continue; }
  }

  if (tokenIds.length < 2 || strike === 0 || lastCryptoPrice === 0) return null;

  const resolution = lastCryptoPrice > strike ? 'UP' : 'DOWN';
  const upToken = tokens[tokenIds[0]];  // outcomes[0] = "Up"
  const downToken = tokens[tokenIds[1]]; // outcomes[1] = "Down"

  if (!upToken || !downToken) return null;
  if (upToken.ewmaAt50 === null || downToken.ewmaAt50 === null) return null;
  if (upToken.ewmaAt25 === null || downToken.ewmaAt25 === null) return null;

  const upRise = upToken.ewmaAt50 - upToken.ewmaAt25;
  const downRise = downToken.ewmaAt50 - downToken.ewmaAt25;

  // Decision logic: buy the token that's rising MORE and above threshold
  const MIN_EWMA = 55;
  const MIN_RISE = 3;

  const upQualifies = upToken.ewmaAt50 >= MIN_EWMA && upRise >= MIN_RISE;
  const downQualifies = downToken.ewmaAt50 >= MIN_EWMA && downRise >= MIN_RISE;

  let decision: 'BUY_UP' | 'BUY_DOWN' | 'SKIP';
  let entryPrice = 0;

  if (upQualifies && downQualifies) {
    // Both qualify — buy the one rising more
    if (upRise >= downRise) {
      decision = 'BUY_UP';
      entryPrice = Math.round(upToken.ewmaAt50) - 1;
    } else {
      decision = 'BUY_DOWN';
      entryPrice = Math.round(downToken.ewmaAt50) - 1;
    }
  } else if (upQualifies) {
    decision = 'BUY_UP';
    entryPrice = Math.round(upToken.ewmaAt50) - 1;
  } else if (downQualifies) {
    decision = 'BUY_DOWN';
    entryPrice = Math.round(downToken.ewmaAt50) - 1;
  } else {
    decision = 'SKIP';
  }

  // PnL calculation: 5 tokens
  const orderSize = 5;
  let pnl = 0;
  if (decision === 'BUY_UP') {
    if (resolution === 'UP') {
      pnl = orderSize * (100 - entryPrice) / 100;  // token → $1
    } else {
      pnl = -orderSize * entryPrice / 100;          // token → $0
    }
  } else if (decision === 'BUY_DOWN') {
    if (resolution === 'DOWN') {
      pnl = orderSize * (100 - entryPrice) / 100;
    } else {
      pnl = -orderSize * entryPrice / 100;
    }
  }

  const correct = (decision === 'BUY_UP' && resolution === 'UP') ||
                  (decision === 'BUY_DOWN' && resolution === 'DOWN') ||
                  decision === 'SKIP';

  return {
    file: path.basename(filePath).replace('.jsonl.gz', ''),
    resolution: resolution as 'UP' | 'DOWN',
    upEwma50: upToken.ewmaAt50,
    downEwma50: downToken.ewmaAt50,
    upRise,
    downRise,
    decision,
    entryPrice,
    pnl,
    correct,
  };
}

async function main() {
  const dirs = [
    { name: 'btc1', path: '/tmp/15min-btc-day1' },
    { name: 'btc2', path: '/tmp/15min-btc-day2' },
    { name: 'btc4', path: '/tmp/15min-btc-day4' },
    { name: 'btc5', path: '/tmp/15min-btc-day5' },
  ];

  let grandTotalPnl = 0;
  let grandEntries = 0;
  let grandCorrect = 0;
  let grandBuyUp = 0;
  let grandBuyDown = 0;
  let grandSkip = 0;

  for (const dir of dirs) {
    if (!fs.existsSync(dir.path)) { console.log(`SKIP ${dir.path}`); continue; }
    const files = fs.readdirSync(dir.path).filter(f => f.endsWith('.jsonl.gz'));

    const results: MarketResult[] = [];
    for (const file of files) {
      const r = await analyzeMarket(path.join(dir.path, file));
      if (r) results.push(r);
    }

    const entries = results.filter(r => r.decision !== 'SKIP');
    const correct = entries.filter(r => r.correct);
    const totalPnl = results.reduce((s, r) => s + r.pnl, 0);
    const buyUp = results.filter(r => r.decision === 'BUY_UP');
    const buyDown = results.filter(r => r.decision === 'BUY_DOWN');
    const skipped = results.filter(r => r.decision === 'SKIP');

    console.log(`\n=== ${dir.name} (${results.length} markets) ===`);
    console.log(`Entries: ${entries.length} (BUY_UP: ${buyUp.length}, BUY_DOWN: ${buyDown.length}, SKIP: ${skipped.length})`);
    console.log(`WR: ${entries.length > 0 ? (correct.length / entries.length * 100).toFixed(1) : 'n/a'}% (${correct.length}/${entries.length})`);
    console.log(`PnL: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} USDC`);

    // BUY_UP breakdown
    const buyUpCorrect = buyUp.filter(r => r.resolution === 'UP');
    const buyDownCorrect = buyDown.filter(r => r.resolution === 'DOWN');
    console.log(`  BUY_UP WR: ${buyUp.length > 0 ? (buyUpCorrect.length / buyUp.length * 100).toFixed(1) : 'n/a'}% (${buyUpCorrect.length}/${buyUp.length}), PnL: ${buyUp.reduce((s, r) => s + r.pnl, 0).toFixed(2)}`);
    console.log(`  BUY_DOWN WR: ${buyDown.length > 0 ? (buyDownCorrect.length / buyDown.length * 100).toFixed(1) : 'n/a'}% (${buyDownCorrect.length}/${buyDown.length}), PnL: ${buyDown.reduce((s, r) => s + r.pnl, 0).toFixed(2)}`);

    // Show worst losses
    const losses = entries.filter(r => r.pnl < 0).sort((a, b) => a.pnl - b.pnl);
    if (losses.length > 0) {
      console.log(`  Top losses:`);
      for (const l of losses.slice(0, 5)) {
        console.log(`    ${l.pnl.toFixed(2)} | ${l.decision} but ${l.resolution} | up50=${l.upEwma50.toFixed(1)} dn50=${l.downEwma50.toFixed(1)} upR=${l.upRise.toFixed(1)} dnR=${l.downRise.toFixed(1)} | ${l.file.substring(0, 50)}`);
      }
    }

    grandTotalPnl += totalPnl;
    grandEntries += entries.length;
    grandCorrect += correct.length;
    grandBuyUp += buyUp.length;
    grandBuyDown += buyDown.length;
    grandSkip += skipped.length;
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`GRAND TOTAL`);
  console.log(`Entries: ${grandEntries} (BUY_UP: ${grandBuyUp}, BUY_DOWN: ${grandBuyDown}, SKIP: ${grandSkip})`);
  console.log(`WR: ${(grandCorrect / grandEntries * 100).toFixed(1)}% (${grandCorrect}/${grandEntries})`);
  console.log(`PnL: ${grandTotalPnl >= 0 ? '+' : ''}${grandTotalPnl.toFixed(2)} USDC`);
  console.log(`Avg PnL per entry: ${(grandTotalPnl / grandEntries).toFixed(2)} USDC`);

  // Now try different thresholds
  console.log(`\n${'='.repeat(60)}`);
  console.log(`THRESHOLD SWEEP`);

  for (const minEwma of [50, 55, 60, 65]) {
    for (const minRise of [2, 3, 5, 8]) {
      // Re-run with different params
      let totalPnl = 0;
      let entries = 0;
      let correct = 0;

      for (const dir of dirs) {
        if (!fs.existsSync(dir.path)) continue;
        const files = fs.readdirSync(dir.path).filter(f => f.endsWith('.jsonl.gz'));

        for (const file of files) {
          const r = await analyzeMarket(path.join(dir.path, file));
          if (!r) continue;

          // Re-apply thresholds
          const upQ = r.upEwma50 >= minEwma && r.upRise >= minRise;
          const dnQ = r.downEwma50 >= minEwma && r.downRise >= minRise;

          let dec: 'BUY_UP' | 'BUY_DOWN' | 'SKIP' = 'SKIP';
          let ep = 0;
          if (upQ && dnQ) {
            dec = r.upRise >= r.downRise ? 'BUY_UP' : 'BUY_DOWN';
            ep = dec === 'BUY_UP' ? Math.round(r.upEwma50) - 1 : Math.round(r.downEwma50) - 1;
          } else if (upQ) {
            dec = 'BUY_UP'; ep = Math.round(r.upEwma50) - 1;
          } else if (dnQ) {
            dec = 'BUY_DOWN'; ep = Math.round(r.downEwma50) - 1;
          }

          if (dec === 'SKIP') continue;

          entries++;
          let pnl = 0;
          if (dec === 'BUY_UP') {
            pnl = r.resolution === 'UP' ? 5 * (100 - ep) / 100 : -5 * ep / 100;
            if (r.resolution === 'UP') correct++;
          } else {
            pnl = r.resolution === 'DOWN' ? 5 * (100 - ep) / 100 : -5 * ep / 100;
            if (r.resolution === 'DOWN') correct++;
          }
          totalPnl += pnl;
        }
      }

      if (entries >= 10) {
        const wr = (correct / entries * 100).toFixed(1);
        const pnlStr = totalPnl >= 0 ? `+${totalPnl.toFixed(2)}` : totalPnl.toFixed(2);
        console.log(`  ewma>=${minEwma} rise>=${minRise}: ${entries} entries, WR ${wr}%, PnL ${pnlStr} USDC, avg ${(totalPnl / entries).toFixed(2)}/entry`);
      }
    }
  }
}

main().catch(console.error);
