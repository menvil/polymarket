/**
 * Ищет моменты edge в day4/day5 данных, сравнивая рыночную цену с эмпирической таблицей P(UP).
 *
 * @remarks
 * Два режима определения цены входа:
 * - `trade` (default): цена = цена совершённой сделки на ленте (мы — контрагент)
 * - `book`: цена = best ask из последнего ордербука UP-токена (мы — taker, покупаем по ask)
 *
 * Для каждого события в каждом рынке:
 * 1. Определяем бакет (price, tau) и актив
 * 2. Смотрим в per-asset таблицу: fairValue = P(UP) * 100
 * 3. Если fairValue > entry_price + minEdge → это BUY opportunity
 * 4. Проверяем resolution: если UP → profit = 100 - price, если DOWN → loss = -price
 *
 * Использование:
 *   npx tsx scripts/find-edge-opportunities.ts --train <dir1> <dir2> --test <dir3> [--min-edge 5] [--min-n 100] [--mode trade|book|both]
 */

import { createReadStream, readdirSync, writeFileSync } from 'fs';
import { createGunzip } from 'zlib';
import { createInterface } from 'readline';
import { join } from 'path';

// ── Типы ──────────────────────────────────────────────────────────────────────

interface BucketStats { up: number; down: number; total: number; }

type AssetTable = Map<string, BucketStats>; // key = "priceBucket:tauBucket"

interface Trade { priceCents: number; tauSec: number; timestamp: number; bestAskCents: number | null; }

interface MarketInfo {
  slug: string;
  asset: string;
  resolution: 'UP' | 'DOWN' | 'UNKNOWN';
  endDateMs: number;
  upTokenId: string;
}

interface Opportunity {
  market: string;
  asset: string;
  priceCents: number;       // цена входа (trade price или best ask)
  tradePriceCents: number;  // оригинальная цена сделки на ленте
  bestAskCents: number | null; // best ask из ордербука в момент сделки
  tauSec: number;
  fairValueCents: number;
  edgeCents: number;
  resolution: 'UP' | 'DOWN';
  profitCents: number; // +profit или -loss
  bucketN: number;
  source: 'trade' | 'book'; // откуда взята цена входа
}

// ── Config ────────────────────────────────────────────────────────────────────

const BUCKET_PRICE = 10;
const BUCKET_TAU = 60;

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    trainDirs: [] as string[], testDirs: [] as string[],
    minEdge: 5, minN: 100, out: '/tmp/edge-opportunities.json',
    priceMode: 'both' as 'trade' | 'book' | 'both',
  };
  let mode = '';
  for (const arg of args) {
    if (arg === '--train') { mode = 'train'; continue; }
    if (arg === '--test') { mode = 'test'; continue; }
    if (arg === '--min-edge') { mode = 'minedge'; continue; }
    if (arg === '--min-n') { mode = 'minn'; continue; }
    if (arg === '--out') { mode = 'out'; continue; }
    if (arg === '--mode') { mode = 'pricemode'; continue; }
    if (mode === 'train') config.trainDirs.push(arg);
    else if (mode === 'test') config.testDirs.push(arg);
    else if (mode === 'minedge') { config.minEdge = Number(arg); mode = ''; }
    else if (mode === 'minn') { config.minN = Number(arg); mode = ''; }
    else if (mode === 'out') { config.out = arg; mode = ''; }
    else if (mode === 'pricemode') { config.priceMode = arg as 'trade' | 'book' | 'both'; mode = ''; }
  }
  if (!config.trainDirs.length || !config.testDirs.length) {
    console.error('Usage: npx tsx scripts/find-edge-opportunities.ts --train <dir1> [dir2] --test <dir3> [dir4] [--min-edge 5] [--min-n 100]');
    process.exit(1);
  }
  return config;
}

// ── Парсинг snapshot ──────────────────────────────────────────────────────────

function detectAsset(filename: string): string {
  const fn = filename.toLowerCase();
  if (fn.includes('bitcoin') || fn.includes('btc')) return 'BTC';
  if (fn.includes('ethereum') || fn.includes('eth')) return 'ETH';
  if (fn.includes('solana') || fn.includes('sol')) return 'SOL';
  if (fn.includes('xrp')) return 'XRP';
  return 'UNKNOWN';
}

async function parseSnapshot(filePath: string): Promise<{ market: MarketInfo | null; trades: Trade[] }> {
  return new Promise((resolve) => {
    const trades: Trade[] = [];
    let market: MarketInfo | null = null;
    let upTokenId: string | null = null;
    let endDateMs = 0;
    /** Последний best ask UP-токена из ордербука (центы) */
    let lastBestAskCents: number | null = null;

    const gunzip = createGunzip();
    const stream = createReadStream(filePath).pipe(gunzip);
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      try {
        const d = JSON.parse(line);
        if (d.t === 'meta' && d.m) {
          const m = d.m;
          const prices = JSON.parse(m.outcomePrices || '[]');
          const tokens = d.tokenIds || JSON.parse(m.clobTokenIds || '[]');
          let resolution: 'UP' | 'DOWN' | 'UNKNOWN' = 'UNKNOWN';
          if (prices.length >= 2) {
            if (Number(prices[0]) === 1) resolution = 'UP';
            else if (Number(prices[1]) === 1) resolution = 'DOWN';
          }
          upTokenId = tokens[0] || null;
          endDateMs = new Date(m.endDate).getTime();
          market = {
            slug: m.slug || m.question || '',
            asset: detectAsset(filePath),
            resolution,
            endDateMs,
            upTokenId: upTokenId || '',
          };
        }

        // Ордербук UP-токена — обновляем best ask
        // asks отсортированы по убыванию цены: [0.99, 0.98, ..., 0.01]
        // best ask = минимальная цена с ненулевым size
        if (d.asks && d.asset_id && upTokenId && d.asset_id === upTokenId) {
          const asks = d.asks as Array<{ price: string; size: string }>;
          lastBestAskCents = null;
          for (let i = asks.length - 1; i >= 0; i--) {
            const sz = Number(asks[i].size);
            if (sz > 0) {
              lastBestAskCents = Math.round(Number(asks[i].price) * 100);
              break;
            }
          }
        }

        // Trade UP-токена
        if (d.price && d.size && d.side && d.timestamp && !d.bids && upTokenId && endDateMs) {
          if (d.asset_id !== upTokenId) return;
          const priceCents = Math.round(Number(d.price) * 100);
          const ts = Number(d.timestamp);
          const tsMs = ts > 1e12 ? ts : ts * 1000;
          const tauSec = Math.max(0, (endDateMs - tsMs) / 1000);
          if (priceCents >= 1 && priceCents <= 99) {
            trades.push({ priceCents, tauSec, timestamp: tsMs, bestAskCents: lastBestAskCents });
          }
        }
      } catch { /* skip */ }
    });

    rl.on('close', () => resolve({ market, trades }));
    rl.on('error', () => resolve({ market: null, trades: [] }));
    gunzip.on('error', () => resolve({ market: null, trades: [] }));
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const config = parseArgs();

  // ── Phase 1: Build per-asset tables from training data ──────────────────
  console.error('=== PHASE 1: Building per-asset probability tables ===');
  const assetTables = new Map<string, AssetTable>();
  for (const asset of ['BTC', 'ETH', 'SOL', 'XRP']) {
    assetTables.set(asset, new Map());
  }

  const trainFiles: Array<{ path: string; asset: string }> = [];
  for (const dir of config.trainDirs) {
    for (const f of readdirSync(dir).filter(f => f.endsWith('.jsonl.gz'))) {
      trainFiles.push({ path: join(dir, f), asset: detectAsset(f) });
    }
  }
  console.error(`Training files: ${trainFiles.length}`);

  let trainProcessed = 0;
  for (const { path, asset } of trainFiles) {
    const { market, trades } = await parseSnapshot(path);
    if (!market || market.resolution === 'UNKNOWN' || !trades.length) continue;
    trainProcessed++;

    const table = assetTables.get(asset);
    if (!table) continue;

    for (const trade of trades) {
      const pb = Math.floor(trade.priceCents / BUCKET_PRICE) * BUCKET_PRICE;
      const tb = Math.floor(trade.tauSec / BUCKET_TAU) * BUCKET_TAU;
      const key = `${pb}:${tb}`;
      let s = table.get(key);
      if (!s) { s = { up: 0, down: 0, total: 0 }; table.set(key, s); }
      s.total++;
      if (market.resolution === 'UP') s.up++;
      else s.down++;
    }
  }

  for (const [asset, table] of assetTables) {
    const totalObs = [...table.values()].reduce((s, v) => s + v.total, 0);
    const sigCells = [...table.values()].filter(v => v.total >= config.minN).length;
    console.error(`  ${asset}: ${table.size} buckets, ${totalObs} observations, ${sigCells} significant (n>=${config.minN})`);
  }

  // ── Phase 2: Scan test data for edge opportunities ──────────────────────
  console.error('\n=== PHASE 2: Scanning test data for edge ===');
  console.error(`OutcomePrice mode: ${config.priceMode}`);
  const testFiles: string[] = [];
  for (const dir of config.testDirs) {
    for (const f of readdirSync(dir).filter(f => f.endsWith('.jsonl.gz'))) {
      testFiles.push(join(dir, f));
    }
  }
  console.error(`Test files: ${testFiles.length}`);

  const modes: Array<'trade' | 'book'> = config.priceMode === 'both'
    ? ['trade', 'book']
    : [config.priceMode];

  /** Кэш распарсенных файлов (чтобы не парсить дважды в режиме both) */
  const parsedCache = new Map<string, { market: MarketInfo | null; trades: Trade[] }>();

  for (const priceMode of modes) {
    console.error(`\n--- Mode: ${priceMode.toUpperCase()} (цена входа = ${priceMode === 'trade' ? 'цена сделки на ленте' : 'best ask из ордербука'}) ---`);

    const opportunities: Opportunity[] = [];
    const assetStats = new Map<string, {
      markets: number; edgeFound: number;
      totalProfit: number; wins: number; losses: number;
      opportunities: number; noBookData: number;
    }>();
    for (const a of ['BTC', 'ETH', 'SOL', 'XRP']) {
      assetStats.set(a, { markets: 0, edgeFound: 0, totalProfit: 0, wins: 0, losses: 0, opportunities: 0, noBookData: 0 });
    }

    let testProcessed = 0;
    for (const filePath of testFiles) {
      let parsed = parsedCache.get(filePath);
      if (!parsed) {
        parsed = await parseSnapshot(filePath);
        parsedCache.set(filePath, parsed);
      }
      const { market, trades } = parsed;
      if (!market || market.resolution === 'UNKNOWN' || !trades.length) continue;
      testProcessed++;

      const stats = assetStats.get(market.asset);
      if (stats) stats.markets++;

      const table = assetTables.get(market.asset);
      if (!table) continue;

      // Для каждого рынка: ищем момент с максимальным edge (одна сделка на рынок)
      let bestEdge: Opportunity | null = null;

      for (const trade of trades) {
        // Определяем цену входа в зависимости от режима
        let entryPriceCents: number;
        if (priceMode === 'book') {
          if (trade.bestAskCents === null) continue; // нет ордербука — пропускаем
          entryPriceCents = trade.bestAskCents;
        } else {
          entryPriceCents = trade.priceCents;
        }

        if (entryPriceCents < 1 || entryPriceCents > 99) continue;

        const pb = Math.floor(entryPriceCents / BUCKET_PRICE) * BUCKET_PRICE;
        const tb = Math.floor(trade.tauSec / BUCKET_TAU) * BUCKET_TAU;
        const key = `${pb}:${tb}`;
        const bucket = table.get(key);
        if (!bucket || bucket.total < config.minN) continue;

        const fairValue = (bucket.up / bucket.total) * 100;
        const edgeCents = fairValue - entryPriceCents;

        if (edgeCents >= config.minEdge) {
          const profitCents = market.resolution === 'UP'
            ? (100 - entryPriceCents)
            : -entryPriceCents;

          const opp: Opportunity = {
            market: market.slug,
            asset: market.asset,
            priceCents: entryPriceCents,
            tradePriceCents: trade.priceCents,
            bestAskCents: trade.bestAskCents,
            tauSec: Math.round(trade.tauSec),
            fairValueCents: Math.round(fairValue * 10) / 10,
            edgeCents: Math.round(edgeCents * 10) / 10,
            resolution: market.resolution,
            profitCents,
            bucketN: bucket.total,
            source: priceMode,
          };

          if (!bestEdge || edgeCents > bestEdge.edgeCents) {
            bestEdge = opp;
          }
        }
      }

      if (bestEdge && stats) {
        stats.edgeFound++;
        stats.totalProfit += bestEdge.profitCents;
        if (bestEdge.profitCents > 0) stats.wins++;
        else stats.losses++;
        stats.opportunities++;
        opportunities.push(bestEdge);
      }

      // Считаем рынки где вообще не было book данных
      if (priceMode === 'book' && stats) {
        const hasBook = trades.some(t => t.bestAskCents !== null);
        if (!hasBook) stats.noBookData++;
      }

      if (testProcessed % 100 === 0) {
        console.error(`  Processed ${testProcessed}/${testFiles.length}, opportunities: ${opportunities.length}`);
      }
    }

    // ── Results для текущего режима ────────────────────────────────────────
    console.error(`\n${'='.repeat(70)}`);
    console.error(`RESULTS [${priceMode.toUpperCase()}]: ${testProcessed} markets, ${opportunities.length} edge opportunities`);
    console.error(`Min edge: ${config.minEdge}¢, Min bucket N: ${config.minN}`);
    console.error(`${'='.repeat(70)}\n`);

    let grandProfit = 0;
    let grandWins = 0;
    let grandLosses = 0;

    for (const [asset, stats] of assetStats) {
      if (stats.markets === 0) continue;
      const avgProfit = stats.opportunities > 0 ? stats.totalProfit / stats.opportunities : 0;
      const winRate = stats.opportunities > 0 ? stats.wins / stats.opportunities * 100 : 0;
      const edgePct = (stats.edgeFound / stats.markets * 100).toFixed(1);
      const noBook = priceMode === 'book' ? `, noBook: ${stats.noBookData}` : '';
      console.error(`${asset}: ${stats.markets} mkts, ${stats.edgeFound} edge (${edgePct}%)${noBook}`);
      console.error(`  ${stats.wins}W/${stats.losses}L (${winRate.toFixed(1)}%), P&L: ${(stats.totalProfit / 100).toFixed(2)}, avg: ${(avgProfit / 100).toFixed(2)}/trade`);
      grandProfit += stats.totalProfit;
      grandWins += stats.wins;
      grandLosses += stats.losses;
    }

    const totalOpps = grandWins + grandLosses;
    console.error(`\nTOTAL [${priceMode.toUpperCase()}]: ${totalOpps} trades, ${grandWins}W/${grandLosses}L (${totalOpps > 0 ? (grandWins / totalOpps * 100).toFixed(1) : 0}%)`);
    console.error(`P&L: ${(grandProfit / 100).toFixed(2)} USDC, avg: ${totalOpps > 0 ? (grandProfit / totalOpps / 100).toFixed(2) : 0}/trade`);

    // Top wins and losses
    const sorted = [...opportunities].sort((a, b) => b.profitCents - a.profitCents);
    console.error('\nTop 3 wins:');
    for (const o of sorted.slice(0, 3)) {
      const bookInfo = o.bestAskCents !== null ? ` ask=${o.bestAskCents}¢` : '';
      console.error(`  ${o.asset}: buy@${o.priceCents}¢${bookInfo} τ=${o.tauSec}s, fv=${o.fairValueCents}¢, edge=${o.edgeCents}¢ → ${o.resolution} → ${(o.profitCents / 100).toFixed(2)}`);
    }
    console.error('Top 3 losses:');
    for (const o of sorted.slice(-3).reverse()) {
      const bookInfo = o.bestAskCents !== null ? ` ask=${o.bestAskCents}¢` : '';
      console.error(`  ${o.asset}: buy@${o.priceCents}¢${bookInfo} τ=${o.tauSec}s, fv=${o.fairValueCents}¢, edge=${o.edgeCents}¢ → ${o.resolution} → ${(o.profitCents / 100).toFixed(2)}`);
    }

    const outFile = priceMode === 'trade' ? config.out : config.out.replace('.json', `-${priceMode}.json`);
    writeFileSync(outFile, JSON.stringify({ config: { ...config, BUCKET_PRICE, BUCKET_TAU, priceMode }, opportunities }, null, 2));
    console.error(`\nSaved to ${outFile}`);
  }

  // ── Comparison summary (режим both) ─────────────────────────────────────
  if (config.priceMode === 'both') {
    console.error(`\n${'='.repeat(70)}`);
    console.error('COMPARISON: TRADE vs BOOK pricing');
    console.error(`${'='.repeat(70)}`);
    console.error('See per-mode results above. Key question: does best ask differ from trade price?');
    console.error('If BOOK P&L < TRADE P&L → real execution cost is higher than tape suggests.');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
