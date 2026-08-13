/**
 * Sweep по порогу entryDev для CrowdDeviationStrategy.
 *
 * @remarks
 * Прогоняет simulate-логику для каждого значения entryDevCents из --thresholds
 * и выводит сводную таблицу + ASCII-графики WR и PnL по порогам.
 *
 * Логика входа идентична simulate-crowd-deviation-trades.ts:
 * - Строим baseline (delta, tau) → ожидаемый crowd из training-таблицы
 * - Для каждого рынка ищем ПЕРВЫЙ (наибольший tau) сигнал где |dev| >= порога
 * - Входим по наблюдаемой цене толпы, держим до экспирации
 * - PnL = (1 − entryPrice/100) если UP, иначе −(entryPrice/100)
 *
 * @example
 * ```bash
 * npx tsx scripts/sweep-entry-dev.ts \
 *   --table tables/edge-table-5min-full-mar-apr-up.json \
 *   --snapshots /path/2026-05-01/polymarket,...,/path/2026-05-06/polymarket \
 *   --cex-cache-dir tables/cex-cache \
 *   --thresholds 10,20,30,40,50 \
 *   --min-delta 25 --min-tau 30 --max-tau 300 \
 *   --residual-filter pos
 * ```
 */

/* eslint-disable no-console */
import { readdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  parseSnapshot,
  classifyRegime,
} from './analyze-crowd-calibration';
import { loadCexCache, makeConsensus, type DayCache, type CexConsensus } from './cex-loader';

// ── ANSI ──────────────────────────────────────────────────────────────────────
const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const DIM    = '\x1b[2m';
const CYAN   = '\x1b[36m';
const YELLOW = '\x1b[33m';

// ── Типы таблицы ──────────────────────────────────────────────────────────────
interface EdgeZone {
  key: { delta: number; tau: number; crowd: number; regime: string; residual: number };
  train: { n: number; crowdAvg: number; pHat: number };
}
interface EdgeTable {
  meta: { bucketing: { deltaStep: number; tauStep: number; crowdStep: number; maxDelta: number; maxTau: number; regimeThreshold: number } };
  zones: EdgeZone[];
}

interface CellBaseline {
  expectedCrowd: number;
  totalN: number;
}

interface Trade {
  resolution: 'UP' | 'DOWN';
  delta: number;
  entryTau: number;
  entryPrice: number;
  deviation: number;
  regime: 'up' | 'flat' | 'down';
  residualBps: number | undefined;
  pnl: number;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
interface Args {
  tableFile:      string;
  dirs:           string[];
  asset:          string;
  token:          'up' | 'down';
  cexCacheDir:    string;
  thresholds:     number[];
  minDelta:       number;
  maxDelta:       number;
  minTau:         number;
  maxTau:         number;
  regimeFilter:   'up' | 'flat' | 'down' | 'all';
  residualFilter: 'pos' | 'neg' | 'all';
  tradeSize:      number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = {
    tableFile: '', dirs: [], asset: 'bitcoin', token: 'up',
    cexCacheDir: '',
    thresholds: [10, 20, 30, 40, 50],
    minDelta: 25, maxDelta: 999,
    minTau: 30, maxTau: 300,
    regimeFilter: 'all', residualFilter: 'all',
    tradeSize: 10,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if      (a === '--table')            args.tableFile      = argv[++i]!;
    else if (a === '--snapshots')        args.dirs           = argv[++i]!.split(',');
    else if (a === '--asset')            args.asset          = argv[++i]!.toLowerCase();
    else if (a === '--token')            args.token          = argv[++i] as 'up' | 'down';
    else if (a === '--cex-cache-dir')    args.cexCacheDir    = argv[++i]!;
    else if (a === '--thresholds')       args.thresholds     = argv[++i]!.split(',').map(Number);
    else if (a === '--min-delta')        args.minDelta       = Number(argv[++i]);
    else if (a === '--max-delta')        args.maxDelta       = Number(argv[++i]);
    else if (a === '--min-tau')          args.minTau         = Number(argv[++i]);
    else if (a === '--max-tau')          args.maxTau         = Number(argv[++i]);
    else if (a === '--regime-filter')    args.regimeFilter   = argv[++i] as Args['regimeFilter'];
    else if (a === '--residual-filter')  args.residualFilter = argv[++i] as Args['residualFilter'];
    else if (a === '--trade-size')       args.tradeSize      = Number(argv[++i]);
  }
  if (!args.tableFile || !args.dirs.length) {
    console.error(
      'Usage: npx tsx scripts/sweep-entry-dev.ts \\\n' +
      '  --table tables/edge-table-5min-full-mar-apr-up.json \\\n' +
      '  --snapshots /path/2026-05-01/polymarket,...\\\n' +
      '  [--cex-cache-dir tables/cex-cache]\\\n' +
      '  [--thresholds 10,20,30,40,50]\\\n' +
      '  [--min-delta 25] [--max-delta 999]\\\n' +
      '  [--min-tau 30] [--max-tau 300]\\\n' +
      '  [--regime-filter all|up|flat|down]\\\n' +
      '  [--residual-filter all|pos|neg]\\\n' +
      '  [--trade-size 10]',
    );
    process.exit(1);
  }
  return args;
}

function buildBaseline(table: EdgeTable): Map<string, CellBaseline> {
  const map = new Map<string, CellBaseline>();
  for (const z of table.zones) {
    const key = `${z.key.delta}:${z.key.tau}`;
    if (!map.has(key)) map.set(key, { expectedCrowd: 0, totalN: 0 });
    const b = map.get(key)!;
    b.expectedCrowd += z.train.n * z.train.crowdAvg * 100;
    b.totalN        += z.train.n;
  }
  for (const b of map.values()) {
    if (b.totalN > 0) b.expectedCrowd /= b.totalN;
  }
  return map;
}

function toBucket(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

// ── ASCII bar chart ───────────────────────────────────────────────────────────
function asciiBar(value: number, min: number, max: number, width = 30, color = ''): string {
  const range = max - min || 1;
  const filled = Math.round(((value - min) / range) * width);
  const bar = '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, width - filled));
  return color ? `${color}${bar}${RESET}` : bar;
}

// ── Sweep result ──────────────────────────────────────────────────────────────
interface SweepRow {
  threshold: number;
  nTrades: number;
  nWin: number;
  wr: number;
  totalPnl: number;
  avgEntry: number;
  avgDev: number;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = parseArgs();

  const table: EdgeTable = JSON.parse(readFileSync(args.tableFile, 'utf8'));
  const { meta } = table;
  const buck = meta.bucketing;
  const baseline = buildBaseline(table);

  console.log(`\n${BOLD}Sweep по порогу entryDevCents${RESET}`);
  console.log(`Table: ${args.tableFile}`);
  console.log(`Token: ${args.token}  |  Asset: ${args.asset}`);
  console.log(`Фильтры: delta≥${args.minDelta}\$  tau∈[${args.minTau}s,${args.maxTau}s]  regime=${args.regimeFilter}  residual=${args.residualFilter}`);
  console.log(`Пороги: ${args.thresholds.join(', ')}¢`);
  console.log(`Ставка за сделку: \$${args.tradeSize}`);

  // Загружаем CEX консенсус
  const dirConsensus = new Map<string, CexConsensus | null>();
  for (const dir of args.dirs) {
    if (!args.cexCacheDir) { dirConsensus.set(dir, null); continue; }
    const day = dir.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
    if (!day) { dirConsensus.set(dir, null); continue; }
    const cachePath = join(args.cexCacheDir, `${day}.json`);
    if (!existsSync(cachePath)) { dirConsensus.set(dir, null); continue; }
    const cache: DayCache = loadCexCache(cachePath);
    dirConsensus.set(dir, makeConsensus([cache]));
  }

  // Собираем все файлы
  const files: { path: string; dir: string }[] = [];
  for (const dir of args.dirs) {
    if (!existsSync(dir)) { console.warn(`Dir not found: ${dir}`); continue; }
    for (const f of readdirSync(dir)) {
      if ((f.endsWith('.jsonl') || f.endsWith('.jsonl.gz')) && f.toLowerCase().includes(args.asset)) {
        files.push({ path: join(dir, f), dir });
      }
    }
  }
  console.log(`\nSnapshot files: ${files.length}`);

  // Разбираем снапшоты ОДИН РАЗ — для максимального порога
  // Для каждого рынка запоминаем все кандидатные наблюдения отсортированные по tau убыванию
  type Candidate = {
    delta: number; tau: number; observedCrowd: number; deviation: number;
    regime: 'up' | 'flat' | 'down'; residualBps: number | undefined;
    resolution: 'UP' | 'DOWN';
  };

  const markets: Candidate[][] = [];
  let filesSkipped = 0;

  process.stdout.write('Parsing snapshots... ');
  for (const { path, dir } of files) {
    const consensus = dirConsensus.get(dir) ?? undefined;
    const cexConsensusAt = consensus ? (ts: number) => consensus.consensusAt(ts) : undefined;

    const result = await parseSnapshot(path, buck.maxTau, args.token, true, undefined, cexConsensusAt);
    if (!result.data) { filesSkipped++; continue; }
    const { data } = result;
    const resolution = data.resolution;

    const sorted = [...data.observations].sort((a, b) => b.tauSec - a.tauSec);
    const candidates: Candidate[] = [];

    for (const obs of sorted) {
      const delta = toBucket(obs.delta, buck.deltaStep);
      const tau   = toBucket(obs.tauSec, buck.tauStep);

      if (tau < args.minTau || tau > args.maxTau) continue;
      if (delta < args.minDelta || delta > args.maxDelta) continue;
      if (Math.abs(delta) > buck.maxDelta) continue;

      const b = baseline.get(`${delta}:${tau}`);
      if (!b || b.totalN < 20) continue;

      const observedCrowd = obs.midPriceCents;
      const deviation = observedCrowd - b.expectedCrowd;
      if (deviation >= 0) continue; // только neg (толпа ниже нормы)

      // Фильтр режима
      const regime = classifyRegime(obs.trendSlope, buck.regimeThreshold);
      if (args.regimeFilter !== 'all' && regime !== args.regimeFilter) continue;

      // Фильтр residual
      if (args.residualFilter !== 'all') {
        if (obs.cexResidualBps === undefined) continue;
        if (args.residualFilter === 'pos' && obs.cexResidualBps <= 0) continue;
        if (args.residualFilter === 'neg' && obs.cexResidualBps >= 0) continue;
      }

      candidates.push({ delta, tau, observedCrowd, deviation, regime, residualBps: obs.cexResidualBps, resolution });
    }

    markets.push(candidates);
  }
  console.log(`done (${markets.length} markets, ${filesSkipped} skipped)\n`);

  // ── Sweep ─────────────────────────────────────────────────────────────────
  const results: SweepRow[] = [];

  for (const threshold of args.thresholds) {
    let nTrades = 0, nWin = 0, pnlSum = 0, entrySum = 0, devSum = 0;

    for (const candidates of markets) {
      // Первый кандидат с |dev| >= threshold
      const hit = candidates.find(c => Math.abs(c.deviation) >= threshold);
      if (!hit) continue;

      const pnl = hit.resolution === 'UP'
        ? (1 - hit.observedCrowd / 100)
        : -(hit.observedCrowd / 100);

      nTrades++;
      if (pnl > 0) nWin++;
      pnlSum  += pnl;
      entrySum += hit.observedCrowd;
      devSum   += hit.deviation;
    }

    const wr = nTrades > 0 ? nWin / nTrades : 0;
    const totalPnl = pnlSum * args.tradeSize;
    const avgEntry = nTrades > 0 ? entrySum / nTrades : 0;
    const avgDev   = nTrades > 0 ? devSum / nTrades : 0;
    results.push({ threshold, nTrades, nWin, wr, totalPnl, avgEntry, avgDev });
  }

  // ── Вывод таблицы ─────────────────────────────────────────────────────────
  const W = 90;
  console.log('═'.repeat(W));
  console.log(`${BOLD}СВОДНАЯ ТАБЛИЦА${RESET}  (ставка $${args.tradeSize}/trade)`);
  console.log('═'.repeat(W));
  console.log(
    `${'Порог (¢)'.padEnd(12)}` +
    `${'Trades'.padStart(8)}` +
    `${'Wins'.padStart(7)}` +
    `${'WR%'.padStart(8)}` +
    `${'Total PnL'.padStart(12)}` +
    `${'Avg Entry'.padStart(11)}` +
    `${'Avg Dev'.padStart(10)}`,
  );
  console.log('─'.repeat(W));

  const minPnl = Math.min(...results.map(r => r.totalPnl));
  const maxPnl = Math.max(...results.map(r => r.totalPnl));
  const minWr  = Math.min(...results.map(r => r.wr));
  const maxWr  = Math.max(...results.map(r => r.wr));
  const bestPnl = maxPnl;
  const bestWr  = maxWr;

  for (const r of results) {
    const isBestPnl = Math.abs(r.totalPnl - bestPnl) < 0.01;
    const isBestWr  = Math.abs(r.wr - bestWr) < 0.0001;
    const star = (isBestPnl || isBestWr) ? ` ${YELLOW}★${RESET}` : '  ';
    const pnlColor = r.totalPnl >= 0 ? GREEN : RED;
    const wrColor  = r.wr >= 0.65 ? GREEN : r.wr >= 0.55 ? '' : RED;

    console.log(
      `${String(r.threshold + '¢').padEnd(12)}` +
      `${String(r.nTrades).padStart(8)}` +
      `${String(r.nWin).padStart(7)}` +
      `${wrColor}${(r.wr * 100).toFixed(1).padStart(7)}%${RESET}` +
      `${pnlColor}${(r.totalPnl >= 0 ? '+' : '') + r.totalPnl.toFixed(2).padStart(10)}${RESET}` +
      ` USDC` +
      `${r.avgEntry.toFixed(1).padStart(9)}¢` +
      `${r.avgDev.toFixed(1).padStart(9)}¢` +
      star,
    );
  }
  console.log('═'.repeat(W));

  // ── ASCII chart: WR ───────────────────────────────────────────────────────
  const chartWidth = 40;
  console.log(`\n${BOLD}Win Rate по порогу${RESET}`);
  console.log('─'.repeat(W));
  for (const r of results) {
    const bar = asciiBar(r.wr, minWr, maxWr, chartWidth, r.wr >= bestWr ? GREEN : CYAN);
    const wrStr = `${(r.wr * 100).toFixed(1)}%`;
    console.log(`  ${String(r.threshold + '¢').padEnd(8)} ${bar} ${wrStr.padStart(6)}  (n=${r.nTrades})`);
  }

  // ── ASCII chart: Total PnL ────────────────────────────────────────────────
  console.log(`\n${BOLD}Total PnL @ \$${args.tradeSize}/trade по порогу${RESET}`);
  console.log('─'.repeat(W));
  const pnlMin = Math.min(0, minPnl);
  const pnlMax = Math.max(0, maxPnl);
  for (const r of results) {
    const color = r.totalPnl >= 0
      ? (Math.abs(r.totalPnl - bestPnl) < 0.01 ? GREEN : CYAN)
      : RED;
    const bar = asciiBar(Math.max(0, r.totalPnl), 0, pnlMax, chartWidth, color);
    const pnlStr = `${r.totalPnl >= 0 ? '+' : ''}$${r.totalPnl.toFixed(2)}`;
    console.log(`  ${String(r.threshold + '¢').padEnd(8)} ${bar} ${pnlStr.padStart(10)}`);
  }

  // ── ASCII chart: Trades count ─────────────────────────────────────────────
  const maxTrades = Math.max(...results.map(r => r.nTrades));
  console.log(`\n${BOLD}Количество сделок по порогу${RESET}`);
  console.log('─'.repeat(W));
  for (const r of results) {
    const bar = asciiBar(r.nTrades, 0, maxTrades, chartWidth, DIM);
    console.log(`  ${String(r.threshold + '¢').padEnd(8)} ${bar} ${String(r.nTrades).padStart(5)} trades`);
  }

  // ── Вывод оптимального порога ─────────────────────────────────────────────
  console.log(`\n${'═'.repeat(W)}`);
  const byPnl = [...results].sort((a, b) => b.totalPnl - a.totalPnl)[0]!;
  const byWr  = [...results].sort((a, b) => b.wr - a.wr)[0]!;
  console.log(`${BOLD}Оптимальный порог:${RESET}`);
  console.log(`  По Total PnL: ${GREEN}${byPnl.threshold}¢${RESET}  →  +$${byPnl.totalPnl.toFixed(2)}  (${(byPnl.wr*100).toFixed(1)}% WR, ${byPnl.nTrades} trades)`);
  console.log(`  По Win Rate:  ${GREEN}${byWr.threshold}¢${RESET}   →  ${(byWr.wr*100).toFixed(1)}% WR  (+$${byWr.totalPnl.toFixed(2)}, ${byWr.nTrades} trades)`);
  console.log(`\nДопущения: $${args.tradeSize}/trade, вход по mid в момент сигнала, hold to expiry, без комиссий.`);
  console.log('═'.repeat(W));
}

main().catch(err => { console.error(err); process.exit(1); });
