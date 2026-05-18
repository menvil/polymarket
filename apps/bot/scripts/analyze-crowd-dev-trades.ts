/**
 * Детальный per-trade анализ CrowdDeviationStrategy.
 *
 * @remarks
 * Прогоняет ту же логику что и sweep-entry-dev.ts при фиксированном entryDev,
 * но вместо сводной таблицы выводит каждую сделку с её параметрами
 * и сравнительную статистику WIN vs LOSS паттернов.
 *
 * @example
 * ```bash
 * SNAPSHOTS=$(echo /path/2026-05-0{1,2,3,4,5,6}/polymarket | tr ' ' ',')
 * npx tsx scripts/analyze-crowd-dev-trades.ts \
 *   --table tables/edge-table-5min-full-mar-apr-up.json \
 *   --snapshots "$SNAPSHOTS" \
 *   --cex-cache-dir tables/cex-cache \
 *   --entry-dev 15 --min-delta 25 --min-tau 30 --max-tau 300 \
 *   --residual-filter pos --trade-size 10
 * ```
 */

/* eslint-disable no-console */
import { readdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseSnapshot, classifyRegime } from './analyze-crowd-calibration';
import { loadCexCache, makeConsensus, type DayCache, type CexConsensus } from './cex-loader';

// ── CLI ───────────────────────────────────────────────────────────────────────
interface Args {
  tableFile:      string;
  dirs:           string[];
  asset:          string;
  token:          'up' | 'down';
  cexCacheDir:    string;
  entryDev:       number;
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
    entryDev: 15,
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
    else if (a === '--entry-dev')        args.entryDev       = Number(argv[++i]);
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
      'Usage: npx tsx scripts/analyze-crowd-dev-trades.ts \\\n' +
      '  --table tables/edge-table-5min-full-mar-apr-up.json \\\n' +
      '  --snapshots /path/2026-05-01/polymarket,...\\\n' +
      '  [--cex-cache-dir tables/cex-cache]\\\n' +
      '  [--entry-dev 15]\\\n' +
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

// ── Типы таблицы ──────────────────────────────────────────────────────────────
interface EdgeZone {
  key: { delta: number; tau: number; crowd: number; regime: string; residual: number };
  train: { n: number; crowdAvg: number; pHat: number };
}
interface EdgeTable {
  meta: { bucketing: { deltaStep: number; tauStep: number; crowdStep: number; maxDelta: number; maxTau: number; regimeThreshold: number } };
  zones: EdgeZone[];
}
interface CellBaseline { expectedCrowd: number; totalN: number; }

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

// ── Trade record ──────────────────────────────────────────────────────────────
interface TradeRecord {
  outcome:      'WIN' | 'LOSS';
  resolution:   'UP' | 'DOWN';
  delta:        number;    // $ delta bucket
  tau:          number;    // секунды до экспирации (bucket)
  tauRaw:       number;    // точное значение
  entryPrice:   number;    // цента
  baseline:     number;    // цента
  deviation:    number;    // цента (отрицательное)
  regime:       string;
  residualBps:  number | undefined;
  pnl:          number;    // в единицах tradeSize
  baselineN:    number;    // сколько наблюдений в ячейке
}

// ── Stats helper ──────────────────────────────────────────────────────────────
function stats(values: number[]): { mean: number; median: number; p25: number; p75: number; min: number; max: number } {
  if (!values.length) return { mean: 0, median: 0, p25: 0, p75: 0, min: 0, max: 0 };
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  return {
    mean:   s.reduce((a, b) => a + b, 0) / n,
    median: s[Math.floor(n / 2)]!,
    p25:    s[Math.floor(n * 0.25)]!,
    p75:    s[Math.floor(n * 0.75)]!,
    min:    s[0]!,
    max:    s[n - 1]!,
  };
}

function pct(n: number, total: number): string {
  return total === 0 ? 'n/a' : `${((n / total) * 100).toFixed(1)}%`;
}

function fmt(n: number, decimals = 1): string {
  return n.toFixed(decimals);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = parseArgs();

  const table: EdgeTable = JSON.parse(readFileSync(args.tableFile, 'utf8'));
  const { meta } = table;
  const buck = meta.bucketing;
  const baseline = buildBaseline(table);

  console.log(`\nPer-trade analysis: CrowdDeviationStrategy`);
  console.log(`Table: ${args.tableFile}`);
  console.log(`Params: entryDev=${args.entryDev}¢  delta≥${args.minDelta}$  tau∈[${args.minTau}s,${args.maxTau}s]  regime=${args.regimeFilter}  residual=${args.residualFilter}`);

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
  console.log(`Snapshot files: ${files.length}\n`);

  const trades: TradeRecord[] = [];
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
      if (deviation >= -args.entryDev) continue;

      const regime = classifyRegime(obs.trendSlope, buck.regimeThreshold);
      if (args.regimeFilter !== 'all' && regime !== args.regimeFilter) continue;

      if (args.residualFilter !== 'all') {
        if (obs.cexResidualBps === undefined) continue;
        if (args.residualFilter === 'pos' && obs.cexResidualBps <= 0) continue;
        if (args.residualFilter === 'neg' && obs.cexResidualBps >= 0) continue;
      }

      // Первый сигнал (наибольший tau) — вход
      const pnl = (resolution === 'UP'
        ? (1 - observedCrowd / 100)
        : -(observedCrowd / 100)) * args.tradeSize;

      trades.push({
        outcome:     pnl > 0 ? 'WIN' : 'LOSS',
        resolution,
        delta,
        tau,
        tauRaw:      obs.tauSec,
        entryPrice:  observedCrowd,
        baseline:    b.expectedCrowd,
        deviation,
        regime,
        residualBps: obs.cexResidualBps,
        pnl,
        baselineN:   b.totalN,
      });
      break; // только первый сигнал на рынок
    }
  }
  console.log(`done (${trades.length} trades, ${filesSkipped} skipped)\n`);

  const wins  = trades.filter(t => t.outcome === 'WIN');
  const losses = trades.filter(t => t.outcome === 'LOSS');

  // ── Сводка ────────────────────────────────────────────────────────────────
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  console.log('═'.repeat(80));
  console.log(`ИТОГО: ${trades.length} сделок  |  WIN: ${wins.length} (${pct(wins.length, trades.length)})  |  LOSS: ${losses.length} (${pct(losses.length, trades.length)})`);
  console.log(`Total PnL: ${totalPnl >= 0 ? '+' : ''}${fmt(totalPnl, 2)} USDC  (avg/trade: ${fmt(totalPnl / trades.length, 2)})`);
  console.log('═'.repeat(80));

  // ── Сравнение WIN vs LOSS ─────────────────────────────────────────────────
  function compareGroup(label: string, group: TradeRecord[]): void {
    if (!group.length) { console.log(`  ${label}: нет данных`); return; }
    const devSt    = stats(group.map(t => t.deviation));
    const tauSt    = stats(group.map(t => t.tauRaw));
    const deltaSt  = stats(group.map(t => t.delta));
    const entrySt  = stats(group.map(t => t.entryPrice));
    const baseSt   = stats(group.map(t => t.baseline));
    const residuals = group.filter(t => t.residualBps !== undefined).map(t => t.residualBps!);
    const residSt  = residuals.length ? stats(residuals) : null;

    console.log(`\n  ${label} (n=${group.length})`);
    console.log(`  ${''.padEnd(60, '─')}`);
    console.log(`  Entry price : mean=${fmt(entrySt.mean)}¢  median=${fmt(entrySt.median)}¢  range=[${fmt(entrySt.min)}¢, ${fmt(entrySt.max)}¢]`);
    console.log(`  Baseline    : mean=${fmt(baseSt.mean)}¢  median=${fmt(baseSt.median)}¢`);
    console.log(`  Deviation   : mean=${fmt(devSt.mean)}¢  median=${fmt(devSt.median)}¢  p25=${fmt(devSt.p25)}¢  p75=${fmt(devSt.p75)}¢`);
    console.log(`  Tau (raw)   : mean=${fmt(tauSt.mean)}s  median=${fmt(tauSt.median)}s  range=[${fmt(tauSt.min)}s, ${fmt(tauSt.max)}s]`);
    console.log(`  Delta bucket: mean=${fmt(deltaSt.mean, 0)}$  median=${fmt(deltaSt.median, 0)}$  range=[${deltaSt.min}$, ${deltaSt.max}$]`);
    if (residSt) {
      console.log(`  CEX residual: mean=${fmt(residSt.mean, 1)}bps  median=${fmt(residSt.median, 1)}bps  range=[${fmt(residSt.min, 1)}, ${fmt(residSt.max, 1)}]`);
    }

    // Режимы
    const byRegime: Record<string, number> = {};
    for (const t of group) byRegime[t.regime] = (byRegime[t.regime] ?? 0) + 1;
    const regStr = Object.entries(byRegime).map(([k, v]) => `${k}:${v}(${pct(v, group.length)})`).join('  ');
    console.log(`  Regime dist : ${regStr}`);

    // Разрешение UP/DOWN
    const ups = group.filter(t => t.resolution === 'UP').length;
    console.log(`  Resolution  : UP=${ups}(${pct(ups, group.length)})  DOWN=${group.length - ups}(${pct(group.length - ups, group.length)})`);
  }

  console.log('\nСравнение WIN vs LOSS:');
  compareGroup('WIN ', wins);
  compareGroup('LOSS', losses);

  // ── Разбивка WR по бакетам tau ────────────────────────────────────────────
  console.log('\n\nWin rate по tau-бакету:');
  console.log(`  ${'tau'.padEnd(8)} ${'n'.padStart(5)} ${'W'.padStart(5)} ${'WR%'.padStart(7)} ${'avgEntry'.padStart(10)} ${'avgDev'.padStart(9)}`);
  console.log(`  ${''.padEnd(45, '─')}`);
  const tauGroups = new Map<number, TradeRecord[]>();
  for (const t of trades) {
    if (!tauGroups.has(t.tau)) tauGroups.set(t.tau, []);
    tauGroups.get(t.tau)!.push(t);
  }
  for (const [tau, group] of [...tauGroups.entries()].sort((a, b) => b[0] - a[0])) {
    const w = group.filter(t => t.outcome === 'WIN').length;
    const wr = w / group.length;
    const avgEntry = group.reduce((s, t) => s + t.entryPrice, 0) / group.length;
    const avgDev   = group.reduce((s, t) => s + t.deviation, 0) / group.length;
    const bar = '█'.repeat(Math.round(wr * 20)) + '░'.repeat(20 - Math.round(wr * 20));
    console.log(`  ${String(tau + 's').padEnd(8)} ${String(group.length).padStart(5)} ${String(w).padStart(5)} ${bar} ${(wr * 100).toFixed(1).padStart(5)}%  entry=${fmt(avgEntry)}¢  dev=${fmt(avgDev)}¢`);
  }

  // ── Разбивка WR по delta-бакету ───────────────────────────────────────────
  console.log('\n\nWin rate по delta-бакету:');
  console.log(`  ${'delta'.padEnd(8)} ${'n'.padStart(5)} ${'W'.padStart(5)} ${'WR%'.padStart(7)} ${'avgEntry'.padStart(10)} ${'avgDev'.padStart(9)}`);
  console.log(`  ${''.padEnd(45, '─')}`);
  const deltaGroups = new Map<number, TradeRecord[]>();
  for (const t of trades) {
    if (!deltaGroups.has(t.delta)) deltaGroups.set(t.delta, []);
    deltaGroups.get(t.delta)!.push(t);
  }
  for (const [delta, group] of [...deltaGroups.entries()].sort((a, b) => a[0] - b[0])) {
    const w = group.filter(t => t.outcome === 'WIN').length;
    const wr = w / group.length;
    const avgEntry = group.reduce((s, t) => s + t.entryPrice, 0) / group.length;
    const avgDev   = group.reduce((s, t) => s + t.deviation, 0) / group.length;
    const bar = '█'.repeat(Math.round(wr * 20)) + '░'.repeat(20 - Math.round(wr * 20));
    console.log(`  ${String(delta + '$').padEnd(8)} ${String(group.length).padStart(5)} ${String(w).padStart(5)} ${bar} ${(wr * 100).toFixed(1).padStart(5)}%  entry=${fmt(avgEntry)}¢  dev=${fmt(avgDev)}¢`);
  }

  // ── Разбивка WR по entry price bucket ─────────────────────────────────────
  console.log('\n\nWin rate по entry price (10¢ бакеты):');
  console.log(`  ${'price'.padEnd(12)} ${'n'.padStart(5)} ${'W'.padStart(5)} ${'WR%'.padStart(7)}`);
  console.log(`  ${''.padEnd(35, '─')}`);
  const priceGroups = new Map<number, TradeRecord[]>();
  for (const t of trades) {
    const bucket = Math.floor(t.entryPrice / 10) * 10;
    if (!priceGroups.has(bucket)) priceGroups.set(bucket, []);
    priceGroups.get(bucket)!.push(t);
  }
  for (const [bucket, group] of [...priceGroups.entries()].sort((a, b) => a[0] - b[0])) {
    const w = group.filter(t => t.outcome === 'WIN').length;
    const wr = w / group.length;
    const bar = '█'.repeat(Math.round(wr * 20)) + '░'.repeat(20 - Math.round(wr * 20));
    console.log(`  ${`${bucket}-${bucket + 10}¢`.padEnd(12)} ${String(group.length).padStart(5)} ${String(w).padStart(5)} ${bar} ${(wr * 100).toFixed(1).padStart(5)}%`);
  }

  // ── Топ потерь ────────────────────────────────────────────────────────────
  console.log('\n\nТоп-10 крупнейших потерь:');
  console.log(`  ${'pnl'.padStart(7)} ${'entry'.padStart(7)} ${'base'.padStart(7)} ${'dev'.padStart(7)} ${'tau'.padStart(6)} ${'delta'.padStart(6)} ${'regime'.padStart(8)} ${'resid'.padStart(7)} res`);
  console.log(`  ${''.padEnd(70, '─')}`);
  const topLoss = [...losses].sort((a, b) => a.pnl - b.pnl).slice(0, 10);
  for (const t of topLoss) {
    console.log(
      `  ${(t.pnl >= 0 ? '+' : '') + fmt(t.pnl, 2).padStart(6)}$` +
      `  ${fmt(t.entryPrice).padStart(5)}¢` +
      `  ${fmt(t.baseline).padStart(5)}¢` +
      `  ${fmt(t.deviation).padStart(5)}¢` +
      `  ${fmt(t.tauRaw, 0).padStart(5)}s` +
      `  ${String(t.delta + '$').padStart(6)}` +
      `  ${t.regime.padStart(8)}` +
      `  ${t.residualBps !== undefined ? fmt(t.residualBps, 1) : 'n/a'.padStart(5)}` +
      `  ${t.resolution}`,
    );
  }

  // ── Топ побед ─────────────────────────────────────────────────────────────
  console.log('\n\nТоп-10 крупнейших побед:');
  console.log(`  ${'pnl'.padStart(7)} ${'entry'.padStart(7)} ${'base'.padStart(7)} ${'dev'.padStart(7)} ${'tau'.padStart(6)} ${'delta'.padStart(6)} ${'regime'.padStart(8)} ${'resid'.padStart(7)} res`);
  console.log(`  ${''.padEnd(70, '─')}`);
  const topWin = [...wins].sort((a, b) => b.pnl - a.pnl).slice(0, 10);
  for (const t of topWin) {
    console.log(
      `  ${(t.pnl >= 0 ? '+' : '') + fmt(t.pnl, 2).padStart(6)}$` +
      `  ${fmt(t.entryPrice).padStart(5)}¢` +
      `  ${fmt(t.baseline).padStart(5)}¢` +
      `  ${fmt(t.deviation).padStart(5)}¢` +
      `  ${fmt(t.tauRaw, 0).padStart(5)}s` +
      `  ${String(t.delta + '$').padStart(6)}` +
      `  ${t.regime.padStart(8)}` +
      `  ${t.residualBps !== undefined ? fmt(t.residualBps, 1) : 'n/a'.padStart(5)}` +
      `  ${t.resolution}`,
    );
  }

  console.log('\n');
}

main().catch(err => { console.error(err); process.exit(1); });
