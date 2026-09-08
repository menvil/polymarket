/**
 * Анализ поведения цены ПЕРЕД входом в бектесте.
 *
 * @remarks
 * Для каждой сделки (entryDev=15¢, residual=pos) берёт entry timestamp
 * из parseSnapshot и читает raw тики за [−10s, 0] до входа:
 * - dwellTimeSec  — как долго deviation < −threshold до входа
 * - maxSpread5s   — максимальный spread в последние 5 секунд
 * - ewmaDropRate  — скорость падения EWMA (¢/сек) за последние 3 секунды
 * - dropFromHigh  — падение mid от максимума за последние 10 секунд
 *
 * @example
 * ```bash
 * SNAPSHOTS=$(echo /path/2026-05-0{1,2,3,4,5,6}/polymarket | tr ' ' ',')
 * npx tsx scripts/analyze-entry-velocity.ts \
 *   --table tables/edge-table-5min-full-mar-apr-up.json \
 *   --snapshots "$SNAPSHOTS" --cex-cache-dir tables/cex-cache \
 *   --entry-dev 15 --min-delta 25 --residual-filter pos
 * ```
 */

/* eslint-disable no-console */
import { readdirSync, existsSync, readFileSync, createReadStream } from 'fs';
import { join } from 'path';
import { createGunzip } from 'zlib';
import * as readline from 'readline';
import { parseSnapshot, classifyRegime } from './analyze-crowd-calibration';
import { loadCexCache, makeConsensus, type DayCache, type CexConsensus } from './cex-loader';

// ── CLI ───────────────────────────────────────────────────────────────────────
interface Args {
  tableFile:      string;
  dirs:           string[];
  asset:          string;
  cexCacheDir:    string;
  entryDev:       number;
  minDelta:       number;
  maxDelta:       number;
  minTau:         number;
  maxTau:         number;
  residualFilter: 'pos' | 'neg' | 'all';
  tradeSize:      number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = {
    tableFile: '', dirs: [], asset: 'bitcoin', cexCacheDir: '',
    entryDev: 15, minDelta: 25, maxDelta: 999, minTau: 30, maxTau: 300,
    residualFilter: 'all', tradeSize: 10,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if      (a === '--table')           args.tableFile      = argv[++i]!;
    else if (a === '--snapshots')       args.dirs           = argv[++i]!.split(',');
    else if (a === '--asset')           args.asset          = argv[++i]!.toLowerCase();
    else if (a === '--cex-cache-dir')   args.cexCacheDir    = argv[++i]!;
    else if (a === '--entry-dev')       args.entryDev       = Number(argv[++i]);
    else if (a === '--min-delta')       args.minDelta       = Number(argv[++i]);
    else if (a === '--max-delta')       args.maxDelta       = Number(argv[++i]);
    else if (a === '--min-tau')         args.minTau         = Number(argv[++i]);
    else if (a === '--max-tau')         args.maxTau         = Number(argv[++i]);
    else if (a === '--residual-filter') args.residualFilter = argv[++i] as Args['residualFilter'];
    else if (a === '--trade-size')      args.tradeSize      = Number(argv[++i]);
  }
  if (!args.tableFile || !args.dirs.length) {
    console.error('Usage: npx tsx scripts/analyze-entry-velocity.ts --table <file> --snapshots <dirs,...> ...');
    process.exit(1);
  }
  return args;
}

// ── Edge table / baseline ─────────────────────────────────────────────────────
interface EdgeTable {
  meta: { bucketing: { deltaStep: number; tauStep: number; maxDelta: number; maxTau: number; regimeThreshold: number } };
  zones: Array<{ key: { delta: number; tau: number }; train: { n: number; crowdAvg: number } }>;
}

function buildBaseline(table: EdgeTable): Map<string, number> {
  const acc = new Map<string, { sw: number; sn: number }>();
  for (const z of table.zones) {
    const k = `${z.key.delta}:${z.key.tau}`;
    const a = acc.get(k) ?? { sw: 0, sn: 0 };
    a.sw += z.train.n * z.train.crowdAvg * 100;
    a.sn += z.train.n;
    acc.set(k, a);
  }
  const map = new Map<string, number>();
  for (const [k, a] of acc) if (a.sn >= 20) map.set(k, a.sw / a.sn);
  return map;
}

function toBucket(v: number, step: number): number { return Math.floor(v / step) * step; }

// ── Raw ticks reader ──────────────────────────────────────────────────────────
interface RawTick {
  ts:     number;
  price:  number;  // cents (UP trade)
  spread: number;  // cents (book)
  isTrade: boolean;
}

async function readRawTicks(filePath: string, upToken: string): Promise<RawTick[]> {
  return new Promise((resolve, reject) => {
    const trades = new Map<number, number>();  // ts → ewma price
    const books:  Array<{ ts: number; spread: number }> = [];
    const rawTrades: Array<{ ts: number; price: number }> = [];

    const stream = filePath.endsWith('.gz')
      ? createReadStream(filePath).pipe(createGunzip())
      : createReadStream(filePath);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', line => {
      try {
        const obj = JSON.parse(line);
        if (obj.event_type === 'last_trade_price' && obj.asset_id === upToken) {
          let ts = Number(obj.timestamp);
          if (ts < 1e12) ts *= 1000;
          rawTrades.push({ ts, price: Number(obj.price) * 100 });
        }
        if (obj.event_type === 'book' && obj.asset_id === upToken) {
          let ts = Number(obj.timestamp);
          if (ts < 1e12) ts *= 1000;
          const bids: Array<{ price: string }> = obj.bids ?? [];
          const asks: Array<{ price: string }> = obj.asks ?? [];
          // Polymarket: bids sorted ASCENDING, best bid = last; asks sorted ASCENDING, best ask = first
          const bestBid = bids.length ? Number(bids[bids.length - 1]!.price) * 100 : null;
          const bestAsk = asks.length ? Number(asks[0]!.price) * 100 : null;
          if (bestBid !== null && bestAsk !== null)
            books.push({ ts, spread: bestAsk - bestBid });
        }
      } catch { /* skip */ }
    });

    rl.on('close', () => {
      // Build EWMA timeline
      rawTrades.sort((a, b) => a.ts - b.ts);
      let ewma: number | null = null;
      const ticks: RawTick[] = [];
      for (const { ts, price } of rawTrades) {
        ewma = ewma === null ? price : 0.3 * price + 0.7 * ewma;
        // Find spread at this ts
        let spread = 99;
        for (let i = books.length - 1; i >= 0; i--) {
          if (books[i]!.ts <= ts) { spread = books[i]!.spread; break; }
        }
        ticks.push({ ts, price: ewma, spread, isTrade: true });
      }
      resolve(ticks);
    });

    rl.on('error', reject);
    stream.on('error', reject);
  });
}

// ── Per-trade record ──────────────────────────────────────────────────────────
interface EntryRecord {
  outcome:      'WIN' | 'LOSS';
  resolution:   'UP' | 'DOWN';
  entryPrice:   number;
  deviation:    number;
  tau:          number;
  delta:        number;
  dwellTimeSec: number;
  maxSpread5s:  number;
  ewmaDropRate: number;
  dropFromHigh: number;
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function med(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}
function avg(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}
function pct(n: number, d: number): string { return d ? `${((n/d)*100).toFixed(1)}%` : 'n/a'; }

function showGroup(label: string, group: EntryRecord[], entryDev: number): void {
  if (!group.length) { console.log(`\n${label}: нет данных`); return; }
  const dwell  = group.map(r => r.dwellTimeSec);
  const spread = group.map(r => r.maxSpread5s);
  const drop   = group.map(r => r.ewmaDropRate);
  const fromH  = group.map(r => r.dropFromHigh);

  console.log(`\n${label} (n=${group.length})`);
  console.log(`  ${'─'.repeat(60)}`);
  console.log(`  Dwell time (dev<-${entryDev}¢ before entry):`);
  console.log(`    mean=${avg(dwell).toFixed(2)}s  median=${med(dwell).toFixed(2)}s  min=${Math.min(...dwell).toFixed(2)}s  max=${Math.max(...dwell).toFixed(2)}s`);
  console.log(`    =0 (1st tick): ${group.filter(r => r.dwellTimeSec === 0).length} (${pct(group.filter(r=>r.dwellTimeSec===0).length, group.length)})`);
  console.log(`    <1s:           ${group.filter(r => r.dwellTimeSec < 1).length} (${pct(group.filter(r=>r.dwellTimeSec<1).length, group.length)})`);
  console.log(`    1s–3s:         ${group.filter(r => r.dwellTimeSec >= 1 && r.dwellTimeSec < 3).length} (${pct(group.filter(r=>r.dwellTimeSec>=1&&r.dwellTimeSec<3).length, group.length)})`);
  console.log(`    ≥3s:           ${group.filter(r => r.dwellTimeSec >= 3).length} (${pct(group.filter(r=>r.dwellTimeSec>=3).length, group.length)})`);
  console.log(`  Max spread in last 5s:  mean=${avg(spread).toFixed(1)}¢  median=${med(spread).toFixed(1)}¢`);
  console.log(`    >5¢: ${group.filter(r=>r.maxSpread5s>5).length} (${pct(group.filter(r=>r.maxSpread5s>5).length, group.length)})   >10¢: ${group.filter(r=>r.maxSpread5s>10).length} (${pct(group.filter(r=>r.maxSpread5s>10).length, group.length)})   >20¢: ${group.filter(r=>r.maxSpread5s>20).length} (${pct(group.filter(r=>r.maxSpread5s>20).length, group.length)})`);
  console.log(`  EWMA velocity (¢/sec, -3s window):  mean=${avg(drop).toFixed(2)}  median=${med(drop).toFixed(2)}`);
  console.log(`    <-10¢/s: ${group.filter(r=>r.ewmaDropRate<-10).length} (${pct(group.filter(r=>r.ewmaDropRate<-10).length, group.length)})   <-5¢/s: ${group.filter(r=>r.ewmaDropRate<-5).length} (${pct(group.filter(r=>r.ewmaDropRate<-5).length, group.length)})   <-2¢/s: ${group.filter(r=>r.ewmaDropRate<-2).length} (${pct(group.filter(r=>r.ewmaDropRate<-2).length, group.length)})`);
  console.log(`  Drop from 10s high:  mean=${avg(fromH).toFixed(1)}¢  median=${med(fromH).toFixed(1)}¢`);
  console.log(`    <-10¢: ${group.filter(r=>r.dropFromHigh<-10).length} (${pct(group.filter(r=>r.dropFromHigh<-10).length, group.length)})   <-5¢: ${group.filter(r=>r.dropFromHigh<-5).length} (${pct(group.filter(r=>r.dropFromHigh<-5).length, group.length)})   >-2¢ (stable): ${group.filter(r=>r.dropFromHigh>=-2).length} (${pct(group.filter(r=>r.dropFromHigh>=-2).length, group.length)})`);
}

function showWRTable(title: string, records: EntryRecord[], buckets: Array<{ label: string; filter: (r: EntryRecord) => boolean }>): void {
  console.log(`\n${title}`);
  console.log(`  ${'bucket'.padEnd(16)}  ${'n'.padStart(5)}  ${'W'.padStart(5)}  ${'WR'.padStart(22)}`);
  console.log(`  ${'─'.repeat(55)}`);
  for (const { label, filter } of buckets) {
    const g = records.filter(filter);
    const w = g.filter(r => r.outcome === 'WIN').length;
    const wr = g.length ? w / g.length : 0;
    const bar = '█'.repeat(Math.round(wr * 20)) + '░'.repeat(20 - Math.round(wr * 20));
    console.log(`  ${label.padEnd(16)}  ${String(g.length).padStart(5)}  ${String(w).padStart(5)}  ${bar} ${(wr*100).toFixed(1).padStart(5)}%`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = parseArgs();
  const table: EdgeTable = JSON.parse(readFileSync(args.tableFile, 'utf8'));
  const buck = table.meta.bucketing;
  const baseline = buildBaseline(table);

  const dirConsensus = new Map<string, CexConsensus | null>();
  for (const dir of args.dirs) {
    if (!args.cexCacheDir) { dirConsensus.set(dir, null); continue; }
    const day = dir.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
    const cachePath = day ? join(args.cexCacheDir, `${day}.json`) : '';
    if (!cachePath || !existsSync(cachePath)) { dirConsensus.set(dir, null); continue; }
    const cache: DayCache = loadCexCache(cachePath);
    dirConsensus.set(dir, makeConsensus([cache]));
  }

  const files: { path: string; dir: string }[] = [];
  for (const dir of args.dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if ((f.endsWith('.jsonl') || f.endsWith('.jsonl.gz')) && f.toLowerCase().includes(args.asset))
        files.push({ path: join(dir, f), dir });
    }
  }
  console.log(`\nEntry velocity analysis  entryDev=${args.entryDev}¢  residual=${args.residualFilter}`);
  console.log(`Files: ${files.length}\n`);

  const records: EntryRecord[] = [];
  let skipped = 0;
  process.stdout.write('Processing... ');

  for (const { path, dir } of files) {
    const consensus = dirConsensus.get(dir) ?? undefined;
    const cexConsensusAt = consensus ? (ts: number) => consensus.consensusAt(ts) : undefined;

    // Step 1: parseSnapshot → get observations + resolution + upTokenId
    const result = await parseSnapshot(path, buck.maxTau, 'up', true, undefined, cexConsensusAt);
    if (!result.data) { skipped++; continue; }
    const { data } = result;

    // Step 2: find first entry candidate (same logic as sweep)
    const sorted = [...data.observations].sort((a, b) => b.tauSec - a.tauSec);
    let entryObs: typeof sorted[0] | null = null;

    for (const obs of sorted) {
      const delta = toBucket(obs.delta, buck.deltaStep);
      const tau   = toBucket(obs.tauSec, buck.tauStep);
      if (tau < args.minTau || tau > args.maxTau) continue;
      if (obs.delta < args.minDelta || obs.delta > args.maxDelta) continue;
      if (Math.abs(obs.delta) > buck.maxDelta) continue;

      const b = baseline.get(`${delta}:${tau}`);
      if (!b) continue;

      const deviation = obs.midPriceCents - b;
      if (deviation >= -args.entryDev) continue;

      const regime = classifyRegime(obs.trendSlope, buck.regimeThreshold);
      if (args.residualFilter !== 'all') {
        if (obs.cexResidualBps === undefined) continue;
        if (args.residualFilter === 'pos' && obs.cexResidualBps <= 0) continue;
        if (args.residualFilter === 'neg' && obs.cexResidualBps >= 0) continue;
      }
      void regime;
      entryObs = obs;
      break;
    }

    if (!entryObs) { skipped++; continue; }

    // Step 3: find UP token ID from raw file
    let upToken: string | null = null;
    try {
      const stream2 = path.endsWith('.gz')
        ? createReadStream(path).pipe(createGunzip())
        : createReadStream(path);
      const rl2 = readline.createInterface({ input: stream2, crlfDelay: Infinity });
      await new Promise<void>(res => {
        rl2.on('line', line => {
          if (upToken) return;
          try {
            const obj = JSON.parse(line);
            if (obj.t === 'meta') {
              const ids: string[] = obj.tokenIds ?? JSON.parse(obj.m?.clobTokenIds ?? '[]');
              upToken = ids[0] ?? null;
            }
          } catch { /* skip */ }
        });
        rl2.on('close', res);
        rl2.on('error', res);
        stream2.on('error', res);
      });
    } catch { skipped++; continue; }

    if (!upToken) { skipped++; continue; }

    // Step 4: read raw EWMA ticks
    let ticks: RawTick[];
    try { ticks = await readRawTicks(path, upToken); } catch { skipped++; continue; }
    if (ticks.length < 3) { skipped++; continue; }

    // entry timestamp = market expiry − tauSec
    const endDateMs = (data as { endDateMs?: number }).endDateMs ?? 0;
    const entryTs = endDateMs ? (endDateMs - entryObs.tauSec * 1000) : 0;

    if (!entryTs) { skipped++; continue; }

    // Find closest tick
    let entryIdx = -1;
    let minDiff = Infinity;
    for (let i = 0; i < ticks.length; i++) {
      const diff = Math.abs(ticks[i]!.ts - entryTs);
      if (diff < minDiff) { minDiff = diff; entryIdx = i; }
    }
    if (entryIdx < 0 || minDiff > 10000) { skipped++; continue; }

    const entryTick = ticks[entryIdx]!;
    const entryMid  = entryTick.price;

    // dwell time: walk backwards while deviation < -entryDev
    let dwellTimeSec = 0;
    for (let i = entryIdx - 1; i >= 0; i--) {
      const t = ticks[i]!;
      if (entryTick.ts - t.ts > 30_000) break; // не дальше 30s назад

      const tauI = (endDateMs - t.ts) / 1000;
      if (tauI < args.minTau || tauI > args.maxTau) break;

      const delta2 = toBucket(entryObs.delta, buck.deltaStep);
      const tau2   = toBucket(tauI, buck.tauStep);
      const b2 = baseline.get(`${delta2}:${tau2}`);
      if (!b2) break;
      if (t.price - b2 >= -args.entryDev) break;

      dwellTimeSec = (entryTick.ts - t.ts) / 1000;
    }

    // max spread in last 5s
    const spread5 = ticks.filter(t => t.ts >= entryTick.ts - 5000 && t.ts <= entryTick.ts).map(t => t.spread);
    const maxSpread5s = spread5.length ? Math.max(...spread5) : 99;

    // EWMA velocity in last 3s
    const prev3 = ticks.filter(t => t.ts >= entryTick.ts - 3000 && t.ts <= entryTick.ts);
    let ewmaDropRate = 0;
    if (prev3.length >= 2) {
      const first3 = prev3[0]!;
      const dt = (entryTick.ts - first3.ts) / 1000;
      if (dt > 0) ewmaDropRate = (entryMid - first3.price) / dt;
    }

    // drop from 10s high
    const prev10 = ticks.filter(t => t.ts >= entryTick.ts - 10000 && t.ts <= entryTick.ts);
    const preEntryHigh = prev10.length ? Math.max(...prev10.map(t => t.price)) : entryMid;
    const dropFromHigh = entryMid - preEntryHigh;

    const delta = toBucket(entryObs.delta, buck.deltaStep);
    const tau   = toBucket(entryObs.tauSec, buck.tauStep);
    const b     = baseline.get(`${delta}:${tau}`)!;
    const deviation = entryMid - b;
    const pnl = (data.resolution === 'UP' ? 1 - entryMid / 100 : -(entryMid / 100)) * args.tradeSize;

    records.push({
      outcome:      pnl > 0 ? 'WIN' : 'LOSS',
      resolution:   data.resolution,
      entryPrice:   entryMid,
      deviation,
      tau:          entryObs.tauSec,
      delta:        entryObs.delta,
      dwellTimeSec,
      maxSpread5s,
      ewmaDropRate,
      dropFromHigh,
    });
  }

  console.log(`done  (${records.length} trades, ${skipped} skipped)\n`);

  const wins   = records.filter(r => r.outcome === 'WIN');
  const losses = records.filter(r => r.outcome === 'LOSS');

  console.log('═'.repeat(70));
  console.log(`ИТОГО: ${records.length} trades  WIN: ${wins.length} (${pct(wins.length, records.length)})  LOSS: ${losses.length} (${pct(losses.length, records.length)})`);
  console.log('═'.repeat(70));

  showGroup('WIN ', wins, args.entryDev);
  showGroup('LOSS', losses, args.entryDev);

  showWRTable('Win rate по dwell time:', records, [
    { label: '=0s (1st tick)', filter: r => r.dwellTimeSec === 0 },
    { label: '<0.5s',          filter: r => r.dwellTimeSec > 0 && r.dwellTimeSec < 0.5 },
    { label: '0.5s–2s',       filter: r => r.dwellTimeSec >= 0.5 && r.dwellTimeSec < 2 },
    { label: '2s–5s',         filter: r => r.dwellTimeSec >= 2 && r.dwellTimeSec < 5 },
    { label: '5s–15s',        filter: r => r.dwellTimeSec >= 5 && r.dwellTimeSec < 15 },
    { label: '≥15s',           filter: r => r.dwellTimeSec >= 15 },
  ]);

  showWRTable('Win rate по max spread в -5s:', records, [
    { label: '≤2¢',    filter: r => r.maxSpread5s <= 2 },
    { label: '2–5¢',   filter: r => r.maxSpread5s > 2  && r.maxSpread5s <= 5 },
    { label: '5–10¢',  filter: r => r.maxSpread5s > 5  && r.maxSpread5s <= 10 },
    { label: '10–20¢', filter: r => r.maxSpread5s > 10 && r.maxSpread5s <= 20 },
    { label: '>20¢',   filter: r => r.maxSpread5s > 20 },
  ]);

  showWRTable('Win rate по EWMA velocity (¢/sec, -3s):', records, [
    { label: '< -10¢/s',    filter: r => r.ewmaDropRate < -10 },
    { label: '-10 – -5¢/s', filter: r => r.ewmaDropRate >= -10 && r.ewmaDropRate < -5 },
    { label: '-5 – -2¢/s',  filter: r => r.ewmaDropRate >= -5  && r.ewmaDropRate < -2 },
    { label: '-2 – 0¢/s',   filter: r => r.ewmaDropRate >= -2  && r.ewmaDropRate < 0 },
    { label: '≥ 0¢/s',      filter: r => r.ewmaDropRate >= 0 },
  ]);

  showWRTable('Win rate по drop from 10s high:', records, [
    { label: '< -15¢',        filter: r => r.dropFromHigh < -15 },
    { label: '-15 – -10¢',    filter: r => r.dropFromHigh >= -15 && r.dropFromHigh < -10 },
    { label: '-10 – -5¢',     filter: r => r.dropFromHigh >= -10 && r.dropFromHigh < -5 },
    { label: '-5 – -2¢',      filter: r => r.dropFromHigh >= -5  && r.dropFromHigh < -2 },
    { label: '≥ -2¢ (stable)',filter: r => r.dropFromHigh >= -2 },
  ]);

  console.log('\n');
}

main().catch(err => { console.error(err); process.exit(1); });
