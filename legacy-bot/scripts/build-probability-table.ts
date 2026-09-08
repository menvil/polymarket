/**
 * Строит эмпирическую таблицу P(UP | price_bucket, tau_bucket) из snapshot данных.
 *
 * @remarks
 * Парсит snapshot файлы (jsonl.gz), извлекает trades UP-токена,
 * группирует по (price_cents_bucket, seconds_remaining_bucket),
 * считает долю UP resolutions в каждом бакете.
 *
 * Использование:
 *   npx tsx scripts/build-probability-table.ts <snapshot-dir> [--bucket-price 5] [--bucket-tau 60] [--out table.json]
 *
 * @example
 * ```bash
 * # 15-мин январские данные
 * npx tsx scripts/build-probability-table.ts /path/to/snapshots/2026-01-03
 *
 * # Несколько директорий
 * npx tsx scripts/build-probability-table.ts /path/to/snapshots/2026-01-03 /path/to/snapshots/2026-01-04
 *
 * # 5-мин мартовские данные
 * npx tsx scripts/build-probability-table.ts /tmp/5min-snapshots-day1 --bucket-tau 30
 * ```
 */

import { createReadStream, readdirSync, writeFileSync } from 'fs';
import { createGunzip } from 'zlib';
import { createInterface } from 'readline';
import { join } from 'path';

// ── Конфигурация ──────────────────────────────────────────────────────────────

interface Config {
  dirs: string[];
  bucketPriceCents: number; // Шаг бакета по цене (центы)
  bucketTauSec: number;     // Шаг бакета по времени (секунды)
  outFile: string;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const config: Config = {
    dirs: [],
    bucketPriceCents: 5,
    bucketTauSec: 60,
    outFile: 'probability-table.json',
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--bucket-price') { config.bucketPriceCents = Number(args[++i]); }
    else if (args[i] === '--bucket-tau') { config.bucketTauSec = Number(args[++i]); }
    else if (args[i] === '--out') { config.outFile = args[++i]; }
    else { config.dirs.push(args[i]); }
  }

  if (config.dirs.length === 0) {
    console.error('Usage: npx tsx scripts/build-probability-table.ts <dir1> [dir2...] [--bucket-price 5] [--bucket-tau 60] [--out table.json]');
    process.exit(1);
  }
  return config;
}

// ── Типы ──────────────────────────────────────────────────────────────────────

interface BucketKey {
  priceBucket: number; // Нижняя граница ценового бакета (0, 5, 10, ..., 95)
  tauBucket: number;   // Нижняя граница временного бакета (0, 60, 120, ...)
}

interface BucketStats {
  upCount: number;
  downCount: number;
  total: number;
}

interface MarketResult {
  slug: string;
  resolution: 'UP' | 'DOWN' | 'UNKNOWN';
  endDateMs: number;
  eventStartMs: number;
  durationSec: number;
  tradeCount: number;
  upTokenId: string;
}

// ── Парсинг snapshot файла ────────────────────────────────────────────────────

async function parseSnapshot(filePath: string): Promise<{
  market: MarketResult | null;
  trades: Array<{ priceCents: number; tauSec: number }>;
}> {
  return new Promise((resolve) => {
    const trades: Array<{ priceCents: number; tauSec: number }> = [];
    let market: MarketResult | null = null;
    let upTokenId: string | null = null;
    let endDateMs = 0;
    let eventStartMs = 0;

    const gunzip = createGunzip();
    const stream = createReadStream(filePath).pipe(gunzip);
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      try {
        const d = JSON.parse(line);

        // Meta event — определяем resolution и endDate
        if (d.t === 'meta' && d.m) {
          const m = d.m;
          const outcomePrices = JSON.parse(m.outcomePrices || '[]');
          const tokenIds = d.tokenIds || JSON.parse(m.clobTokenIds || '[]');

          // outcomePrices = ["1", "0"] означает UP won (outcome 0 = UP = price 1.0)
          // outcomePrices = ["0", "1"] означает DOWN won (outcome 1 = DOWN = price 1.0)
          let resolution: 'UP' | 'DOWN' | 'UNKNOWN' = 'UNKNOWN';
          if (outcomePrices.length >= 2) {
            if (Number(outcomePrices[0]) === 1) resolution = 'UP';
            else if (Number(outcomePrices[1]) === 1) resolution = 'DOWN';
          }

          // UP token = первый token (outcome index 0)
          upTokenId = tokenIds[0] || null;

          endDateMs = new Date(m.endDate).getTime();
          // eventStartTime может быть в разных форматах
          const startField = m.eventStartTime || m.startDate || m.createdAt;
          if (startField) {
            eventStartMs = new Date(startField).getTime();
          }

          const slug = m.slug || m.question || '';
          const durationSec = endDateMs > 0 && eventStartMs > 0
            ? (endDateMs - eventStartMs) / 1000
            : 0;

          market = {
            slug,
            resolution,
            endDateMs,
            eventStartMs,
            durationSec,
            tradeCount: 0,
            upTokenId: upTokenId || '',
          };
        }

        // Trade event — только для UP токена
        if (d.event_type === 'trade' || (d.price && d.size && d.side && d.timestamp && !d.bids)) {
          if (!upTokenId || !endDateMs) return;
          if (d.asset_id !== upTokenId) return;

          const priceCents = Math.round(Number(d.price) * 100);
          const tradeTs = Number(d.timestamp);
          // timestamp может быть в мс или строке мс
          const tradeTsMs = tradeTs > 1e12 ? tradeTs : tradeTs * 1000;
          const tauSec = Math.max(0, (endDateMs - tradeTsMs) / 1000);

          if (priceCents >= 1 && priceCents <= 99 && tauSec >= 0 && tauSec <= 1200) {
            trades.push({ priceCents, tauSec });
          }
        }
      } catch {
        // Skip malformed lines
      }
    });

    rl.on('close', () => {
      if (market) {
        market.tradeCount = trades.length;
      }
      resolve({ market, trades });
    });

    rl.on('error', () => {
      resolve({ market: null, trades: [] });
    });

    gunzip.on('error', () => {
      resolve({ market: null, trades: [] });
    });
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const config = parseArgs();
  const buckets = new Map<string, BucketStats>();

  // Собираем все файлы
  const files: string[] = [];
  for (const dir of config.dirs) {
    const entries = readdirSync(dir).filter(f => f.endsWith('.jsonl.gz'));
    for (const entry of entries) {
      files.push(join(dir, entry));
    }
  }
  console.error(`Found ${files.length} snapshot files in ${config.dirs.length} dirs`);

  let processed = 0;
  let skipped = 0;
  let totalTrades = 0;
  const resolutionCounts = { UP: 0, DOWN: 0, UNKNOWN: 0 };

  for (const file of files) {
    const { market, trades } = await parseSnapshot(file);

    if (!market || market.resolution === 'UNKNOWN' || trades.length === 0) {
      skipped++;
      if (market) resolutionCounts[market.resolution]++;
      continue;
    }

    resolutionCounts[market.resolution]++;
    processed++;
    totalTrades += trades.length;

    // Группируем trades в бакеты
    for (const trade of trades) {
      const priceBucket = Math.floor(trade.priceCents / config.bucketPriceCents) * config.bucketPriceCents;
      const tauBucket = Math.floor(trade.tauSec / config.bucketTauSec) * config.bucketTauSec;
      const key = `${priceBucket}:${tauBucket}`;

      let stats = buckets.get(key);
      if (!stats) {
        stats = { upCount: 0, downCount: 0, total: 0 };
        buckets.set(key, stats);
      }
      stats.total++;
      if (market.resolution === 'UP') stats.upCount++;
      else stats.downCount++;
    }

    if (processed % 100 === 0) {
      console.error(`  Processed ${processed}/${files.length}, trades: ${totalTrades}`);
    }
  }

  console.error(`\nDone: ${processed} markets, ${skipped} skipped, ${totalTrades} trades`);
  console.error(`Resolutions: UP=${resolutionCounts.UP}, DOWN=${resolutionCounts.DOWN}, UNKNOWN=${resolutionCounts.UNKNOWN}`);
  console.error(`Buckets: ${buckets.size} non-empty cells`);

  // Формируем выходную таблицу
  const table: Array<{
    priceBucket: number;
    tauBucket: number;
    upCount: number;
    downCount: number;
    total: number;
    pUp: number;
    fairValueCents: number;
  }> = [];

  for (const [key, stats] of buckets.entries()) {
    const [pb, tb] = key.split(':').map(Number);
    const pUp = stats.total > 0 ? stats.upCount / stats.total : 0.5;
    table.push({
      priceBucket: pb,
      tauBucket: tb,
      upCount: stats.upCount,
      downCount: stats.downCount,
      total: stats.total,
      pUp: Math.round(pUp * 10000) / 10000, // 4 decimal places
      fairValueCents: Math.round(pUp * 100 * 10) / 10, // 1 decimal place
    });
  }

  // Сортируем: по tau (убывание — от начала рынка к концу), потом по price
  table.sort((a, b) => b.tauBucket - a.tauBucket || a.priceBucket - b.priceBucket);

  // Выводим красивую таблицу в stderr
  console.error('\n=== PROBABILITY TABLE ===');
  console.error(`OutcomePrice bucket: ${config.bucketPriceCents}¢, Tau bucket: ${config.bucketTauSec}s\n`);

  // Собираем уникальные tau бакеты для header
  const tauBuckets = [...new Set(table.map(r => r.tauBucket))].sort((a, b) => b - a);
  const priceBuckets = [...new Set(table.map(r => r.priceBucket))].sort((a, b) => a - b);

  // Header
  const header = 'price\\tau |' + tauBuckets.map(t => `${t}-${t + config.bucketTauSec}s`.padStart(10)).join('');
  console.error(header);
  console.error('-'.repeat(header.length));

  // Строки
  const lookup = new Map(table.map(r => [`${r.priceBucket}:${r.tauBucket}`, r]));
  for (const pb of priceBuckets) {
    const row = `${pb}-${pb + config.bucketPriceCents}¢`.padEnd(10) + '|';
    const cells = tauBuckets.map(tb => {
      const r = lookup.get(`${pb}:${tb}`);
      if (!r || r.total < 5) return '    -     ';
      return `${(r.pUp * 100).toFixed(1)}%(${r.total})`.padStart(10);
    }).join('');
    console.error(row + cells);
  }

  // Ключевые инсайты
  console.error('\n=== KEY INSIGHTS ===');
  const significant = table.filter(r => r.total >= 20);
  if (significant.length > 0) {
    // Лучшие бакеты для покупки (fairValue > price + 3¢)
    const buyEdge = significant
      .filter(r => r.fairValueCents > r.priceBucket + config.bucketPriceCents / 2 + 3)
      .sort((a, b) => (b.fairValueCents - b.priceBucket) - (a.fairValueCents - a.priceBucket));

    if (buyEdge.length > 0) {
      console.error('\nBest BUY opportunities (fairValue > midPrice + 3¢):');
      for (const r of buyEdge.slice(0, 10)) {
        const midPrice = r.priceBucket + config.bucketPriceCents / 2;
        console.error(`  price=${r.priceBucket}-${r.priceBucket + config.bucketPriceCents}¢, τ=${r.tauBucket}-${r.tauBucket + config.bucketTauSec}s: P(UP)=${(r.pUp * 100).toFixed(1)}%, fairValue=${r.fairValueCents}¢, edge=${(r.fairValueCents - midPrice).toFixed(1)}¢ (n=${r.total})`);
      }
    }

    // Худшие бакеты (fairValue < price - 3¢ → не покупать)
    const avoidBuy = significant
      .filter(r => r.fairValueCents < r.priceBucket + config.bucketPriceCents / 2 - 3)
      .sort((a, b) => (a.fairValueCents - a.priceBucket) - (b.fairValueCents - b.priceBucket));

    if (avoidBuy.length > 0) {
      console.error('\nAvoid BUY (fairValue < midPrice - 3¢):');
      for (const r of avoidBuy.slice(0, 10)) {
        const midPrice = r.priceBucket + config.bucketPriceCents / 2;
        console.error(`  price=${r.priceBucket}-${r.priceBucket + config.bucketPriceCents}¢, τ=${r.tauBucket}-${r.tauBucket + config.bucketTauSec}s: P(UP)=${(r.pUp * 100).toFixed(1)}%, fairValue=${r.fairValueCents}¢, edge=${(r.fairValueCents - midPrice).toFixed(1)}¢ (n=${r.total})`);
      }
    }
  }

  // JSON output
  const output = {
    config: {
      bucketPriceCents: config.bucketPriceCents,
      bucketTauSec: config.bucketTauSec,
      dirs: config.dirs,
      marketsProcessed: processed,
      marketsSkipped: skipped,
      totalTrades,
      generatedAt: new Date().toISOString(),
    },
    table,
  };

  writeFileSync(config.outFile, JSON.stringify(output, null, 2));
  console.error(`\nTable saved to ${config.outFile}`);
}

main().catch(e => { console.error(e); process.exit(1); });
