/**
 * Симуляция торговли на основе crowd-девиации от калибровочного baseline.
 *
 * Логика:
 * 1. Строим baseline: (delta, tau) → ожидаемый crowd из training-таблицы
 * 2. Для каждого рынка в OOS ищем ПЕРВОЕ наблюдение где deviation >= порога
 *    (то есть самый ранний момент когда мы увидели бы сигнал — наибольший tau)
 * 3. Входим по наблюдаемой цене толпы и держим до экспирации
 * 4. P&L = (1 - entryPrice/100) если UP, или -(entryPrice/100) если DOWN
 * 5. Разбивка по regime (up/flat/down) и CEX residual
 *
 * @example
 * ```bash
 * npx tsx scripts/simulate-crowd-deviation-trades.ts \
 *   --table tables/edge-table-5min-full-mar-apr-up.json \
 *   --snapshots /path/2026-05-01/polymarket,...,/path/2026-05-06/polymarket \
 *   --cex-cache-dir tables/cex-cache \
 *   --asset bitcoin --token up \
 *   --entry-dev 20 --min-tau 30 \
 *   --entry-delta-min -50 --entry-delta-max 50
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
const YELLOW = '\x1b[33m';
const DIM    = '\x1b[2m';
const CYAN   = '\x1b[36m';

function pct(v: number): string { return `${(v * 100).toFixed(1)}%`; }
function pctSgn(v: number): string { return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`; }
function c(v: number): string { return `${v.toFixed(1)}¢`; }
function colorPnl(s: string, v: number): string {
  if (v >= 0.08) return `${BOLD}${GREEN}${s}${RESET}`;
  if (v >= 0.02) return `${GREEN}${s}${RESET}`;
  if (v <= -0.08) return `${BOLD}${RED}${s}${RESET}`;
  if (v <= -0.02) return `${RED}${s}${RESET}`;
  return `${DIM}${s}${RESET}`;
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

interface CellBaseline {
  expectedCrowd: number;
  baselinePhat:  number;
  totalN:        number;
}

function buildBaseline(table: EdgeTable): Map<string, CellBaseline> {
  const map = new Map<string, CellBaseline>();
  for (const z of table.zones) {
    const key = `${z.key.delta}:${z.key.tau}`;
    if (!map.has(key)) map.set(key, { expectedCrowd: 0, baselinePhat: 0, totalN: 0 });
    const b = map.get(key)!;
    b.expectedCrowd += z.train.n * z.train.crowdAvg * 100;
    b.baselinePhat  += z.train.n * z.train.pHat;
    b.totalN        += z.train.n;
  }
  for (const b of map.values()) {
    if (b.totalN > 0) { b.expectedCrowd /= b.totalN; b.baselinePhat /= b.totalN; }
  }
  return map;
}

function toBucket(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

// ── Запись о торговой сделке ──────────────────────────────────────────────────
interface Trade {
  slug:         string;
  resolution:   'UP' | 'DOWN';
  delta:        number;
  entryTau:     number;
  entryPrice:   number;   // центы
  deviation:    number;   // центы (obs - expected)
  regime:       'up' | 'flat' | 'down';
  residualBps:  number | undefined;
  pnl:          number;   // (1 - price/100) if UP else -(price/100)
}

// ── Аккумулятор статистики ────────────────────────────────────────────────────
interface Stats {
  nTrades: number;
  nWin:    number;
  pnlSum:  number;
  entrySum: number;
}

function emptyStats(): Stats { return { nTrades: 0, nWin: 0, pnlSum: 0, entrySum: 0 }; }

function addTrade(s: Stats, t: Trade): void {
  s.nTrades++;
  if (t.pnl > 0) s.nWin++;
  s.pnlSum  += t.pnl;
  s.entrySum += t.entryPrice;
}

function printStats(label: string, s: Stats, prefix = ''): void {
  if (s.nTrades === 0) { console.log(`${prefix}${label.padEnd(28)} нет сделок`); return; }
  const wr   = s.nWin / s.nTrades;
  const avgE = s.entrySum / s.nTrades;
  const avgP = s.pnlSum / s.nTrades;
  const tot  = s.pnlSum * 10;  // предположим ставку $10 за сделку → итог в $
  const wrStr  = colorPnl(pct(wr), wr - 0.5);
  const pnlStr = colorPnl(pctSgn(avgP), avgP);
  const totStr = colorPnl(`${tot >= 0 ? '+' : ''}$${tot.toFixed(2)}`, avgP);
  console.log(`${prefix}${label.padEnd(28)}  n=${String(s.nTrades).padStart(4)}  win=${wrStr}  avgEntry=${c(avgE)}  avgPnL=${pnlStr}  total@$10=${totStr}`);
}

// ── CLI ───────────────────────────────────────────────────────────────────────
interface Args {
  tableFile:      string;
  dirs:           string[];
  asset:          string;
  token:          'up' | 'down';
  cexCacheDir:    string;
  entryDev:       number;   // минимальное |dev| для входа (центы)
  entrySign:      'neg' | 'pos' | 'both';  // знак девиации: neg=ниже нормы, pos=выше
  entryDeltaMin:  number;
  entryDeltaMax:  number;
  minTau:         number;
  maxTau:         number;
  regimeFilter:    'up' | 'flat' | 'down' | 'all';
  residualFilter:  'pos' | 'neg' | 'all';  // pos=CEX > Chainlink
  residualMinBps:  number;                 // минимальный |CEX−Chainlink|/Chainlink в bps
  minEntryPrice:   number;                 // минимальная цена входа в центах (фильтр по цене стакана)
  verbose:         boolean;
  csv:             boolean;                // вывести все сделки как CSV для анализа
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = {
    tableFile: '', dirs: [], asset: 'bitcoin', token: 'up',
    cexCacheDir: '',
    entryDev: 20, entrySign: 'neg',
    entryDeltaMin: -999, entryDeltaMax: 999,
    minTau: 30, maxTau: 9999,
    regimeFilter: 'all', residualFilter: 'all',
    residualMinBps: 0,
    minEntryPrice: 0,
    verbose: false,
    csv: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if      (a === '--table')           args.tableFile      = argv[++i];
    else if (a === '--snapshots')       args.dirs           = argv[++i].split(',');
    else if (a === '--asset')           args.asset          = argv[++i].toLowerCase();
    else if (a === '--token')           args.token          = argv[++i] as 'up' | 'down';
    else if (a === '--cex-cache-dir')   args.cexCacheDir    = argv[++i];
    else if (a === '--entry-dev')       args.entryDev       = Number(argv[++i]);
    else if (a === '--entry-sign')      args.entrySign      = argv[++i] as Args['entrySign'];
    else if (a === '--entry-delta-min') args.entryDeltaMin  = Number(argv[++i]);
    else if (a === '--entry-delta-max') args.entryDeltaMax  = Number(argv[++i]);
    else if (a === '--min-tau')         args.minTau         = Number(argv[++i]);
    else if (a === '--max-tau')         args.maxTau         = Number(argv[++i]);
    else if (a === '--regime-filter')   args.regimeFilter   = argv[++i] as Args['regimeFilter'];
    else if (a === '--residual-filter')   args.residualFilter  = argv[++i] as Args['residualFilter'];
    else if (a === '--residual-min-bps') args.residualMinBps  = Number(argv[++i]);
    else if (a === '--min-entry-price')  args.minEntryPrice   = Number(argv[++i]);
    else if (a === '--verbose')           args.verbose         = true;
    else if (a === '--csv')               args.csv             = true;
  }
  if (!args.tableFile || !args.dirs.length) {
    console.error(
      'Usage: npx tsx scripts/simulate-crowd-deviation-trades.ts \\\n' +
      '  --table tables/edge-table-5min-full-mar-apr-up.json \\\n' +
      '  --snapshots /path/2026-05-01/polymarket,...\\\n' +
      '  [--cex-cache-dir tables/cex-cache]\\\n' +
      '  [--entry-dev 20] [--entry-sign neg|pos|both]\\\n' +
      '  [--entry-delta-min -999] [--entry-delta-max 999]\\\n' +
      '  [--min-tau 30] [--max-tau 300]\\\n' +
      '  [--regime-filter up|flat|down|all]\\\n' +
      '  [--residual-filter pos|neg|all]',
    );
    process.exit(1);
  }
  return args;
}

function buildDirConsensusMap(dirs: string[], cexCacheDir: string): Map<string, CexConsensus | null> {
  const map = new Map<string, CexConsensus | null>();
  for (const dir of dirs) {
    if (!cexCacheDir) { map.set(dir, null); continue; }
    const day = dir.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
    if (!day) { map.set(dir, null); continue; }
    const cachePath = join(cexCacheDir, `${day}.json`);
    if (!existsSync(cachePath)) { map.set(dir, null); continue; }
    const cache: DayCache = loadCexCache(cachePath);
    map.set(dir, makeConsensus([cache]));
  }
  return map;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = parseArgs();

  const table: EdgeTable = JSON.parse(readFileSync(args.tableFile, 'utf8'));
  const { meta, zones } = table;
  const buck = meta.bucketing;

  const baseline = buildBaseline(table);

  console.log(`\n${BOLD}Симуляция торговли на crowd-девиации${RESET}`);
  console.log(`Table: ${args.tableFile}  (${zones.length} zones, baseline cells: ${baseline.size})`);
  console.log(`Token: ${args.token}  |  Asset: ${args.asset}`);
  console.log(`\nПравила входа:`);
  console.log(`  |deviation| ≥ ${args.entryDev}¢  (знак: ${args.entrySign})`);
  console.log(`  delta ∈ [${args.entryDeltaMin}, ${args.entryDeltaMax}]`);
  console.log(`  tau ∈ [${args.minTau}s, ${args.maxTau < 9999 ? args.maxTau + 's' : '∞'}]`);
  console.log(`  regime filter: ${args.regimeFilter}`);
  console.log(`  residual filter: ${args.residualFilter}`);
  if (args.residualMinBps > 0) console.log(`  residual min bps: ${args.residualMinBps}`);
  if (args.minEntryPrice > 0) console.log(`  min entry price: ${args.minEntryPrice}¢`);

  // Загружаем CEX консенсус
  const dirConsensus = buildDirConsensusMap(args.dirs, args.cexCacheDir);

  // Собираем файлы
  const files: { path: string; dir: string }[] = [];
  for (const dir of args.dirs) {
    if (!existsSync(dir)) continue;
    const consensus = dirConsensus.get(dir) ?? null;
    for (const f of readdirSync(dir)) {
      if ((f.endsWith('.jsonl') || f.endsWith('.jsonl.gz')) && f.toLowerCase().includes(args.asset)) {
        files.push({ path: join(dir, f), dir });
      }
    }
    void consensus;
  }
  console.log(`\nSnapshot files: ${files.length}`);

  // Симуляция сделок
  const trades: Trade[] = [];
  let filesOk = 0, filesSkipped = 0, noSignal = 0;

  for (const { path, dir } of files) {
    const consensus = dirConsensus.get(dir) ?? undefined;
    const cexConsensusAt = consensus ? (ts: number) => consensus.consensusAt(ts) : undefined;

    const result = await parseSnapshot(path, buck.maxTau, args.token, true, undefined, cexConsensusAt);
    if (!result.data) { filesSkipped++; continue; }
    filesOk++;
    const { data } = result;
    const resolution = data.resolution;

    // Ищем ПЕРВЫЙ (самый ранний = наибольший tau) момент когда сигнал сработал
    // Сортируем по tau убыванию (наибольший tau = самое раннее время в жизни рынка)
    const sorted = [...data.observations].sort((a, b) => b.tauSec - a.tauSec);

    let entered = false;
    for (const obs of sorted) {
      const delta = toBucket(obs.delta, buck.deltaStep);
      const tau   = toBucket(obs.tauSec, buck.tauStep);

      // Проверка tau диапазона
      if (tau < args.minTau || tau > args.maxTau) continue;
      // Проверка delta диапазона
      if (delta < args.entryDeltaMin || delta > args.entryDeltaMax) continue;
      if (Math.abs(delta) > buck.maxDelta) continue;

      // Baseline lookup
      const cellKey = `${delta}:${tau}`;
      const b = baseline.get(cellKey);
      if (!b || b.totalN < 20) continue;

      const observedCrowd = obs.midPriceCents;
      const deviation = observedCrowd - b.expectedCrowd;

      // Проверка знака и порога девиации
      const absDev = Math.abs(deviation);
      if (absDev < args.entryDev) continue;
      if (args.entrySign === 'neg' && deviation >= 0) continue;
      if (args.entrySign === 'pos' && deviation <= 0) continue;

      // Минимальная цена входа (фильтр по цене стакана)
      if (args.minEntryPrice > 0 && observedCrowd < args.minEntryPrice) continue;

      // Режим
      const regime = classifyRegime(obs.trendSlope, buck.regimeThreshold);
      if (args.regimeFilter !== 'all' && regime !== args.regimeFilter) continue;

      // CEX residual знак
      if (args.residualFilter !== 'all') {
        if (obs.cexResidualBps === undefined) continue;
        if (args.residualFilter === 'pos' && obs.cexResidualBps <= 0) continue;
        if (args.residualFilter === 'neg' && obs.cexResidualBps >= 0) continue;
      }

      // CEX residual минимальная величина в bps
      if (args.residualMinBps > 0) {
        if (obs.cexResidualBps === undefined) continue;
        if (obs.cexResidualBps < args.residualMinBps) continue;
      }

      // Входим в сделку
      const pnl = resolution === 'UP'
        ? (1 - observedCrowd / 100)
        : -(observedCrowd / 100);

      trades.push({
        slug: data.slug, resolution, delta, entryTau: tau,
        entryPrice: observedCrowd, deviation, regime,
        residualBps: obs.cexResidualBps,
        pnl,
      });
      entered = true;
      break;  // только первый сигнал на рынок
    }
    if (!entered) noSignal++;
  }

  console.log(`\nParsed: ${filesOk} OK  |  ${filesSkipped} skipped`);
  console.log(`Рынков без сигнала: ${noSignal}  |  Рынков со сделкой: ${trades.length}`);

  if (trades.length === 0) {
    console.log('\nНет сделок — попробуй снизить --entry-dev или расширить фильтры');
    return;
  }

  // ── Общая статистика ──────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(90)}`);
  console.log(`${BOLD}ОБЩИЙ РЕЗУЛЬТАТ${RESET}`);
  console.log(`${'═'.repeat(90)}`);
  const all = emptyStats();
  for (const t of trades) addTrade(all, t);
  printStats('ВСЕ СДЕЛКИ', all);

  // ── По режиму ─────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(90)}`);
  console.log(`${BOLD}ПО РЕЖИМУ BTC (trend slope за 60s)${RESET}`);
  console.log(`${'─'.repeat(90)}`);
  for (const regime of ['up', 'flat', 'down'] as const) {
    const s = emptyStats();
    for (const t of trades) if (t.regime === regime) addTrade(s, t);
    printStats(`regime=${regime}`, s, '  ');
  }

  // ── По знаку CEX residual ─────────────────────────────────────────────────
  const hasResidual = trades.some(t => t.residualBps !== undefined);
  if (hasResidual) {
    console.log(`\n${'─'.repeat(90)}`);
    console.log(`${BOLD}ПО CEX RESIDUAL (cexMid vs Chainlink)${RESET}`);
    console.log(`${'─'.repeat(90)}`);
    const sPos = emptyStats(), sNeg = emptyStats(), sNone = emptyStats();
    for (const t of trades) {
      if (t.residualBps === undefined) addTrade(sNone, t);
      else if (t.residualBps > 0) addTrade(sPos, t);
      else addTrade(sNeg, t);
    }
    printStats('CEX > Chainlink (pos residual)', sPos, '  ');
    printStats('CEX < Chainlink (neg residual)', sNeg, '  ');
    if (sNone.nTrades > 0) printStats('no CEX data', sNone, '  ');

    // Комбо: режим × residual
    console.log(`\n${'─'.repeat(90)}`);
    console.log(`${BOLD}КОМБО: режим × CEX residual${RESET}`);
    console.log(`${'─'.repeat(90)}`);
    for (const regime of ['up', 'flat', 'down'] as const) {
      for (const sign of ['pos', 'neg'] as const) {
        const s = emptyStats();
        for (const t of trades) {
          if (t.regime !== regime) continue;
          if (t.residualBps === undefined) continue;
          if (sign === 'pos' && t.residualBps <= 0) continue;
          if (sign === 'neg' && t.residualBps >= 0) continue;
          addTrade(s, t);
        }
        printStats(`${regime} × ${sign}`, s, '  ');
      }
    }
  }

  // ── По delta ─────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(90)}`);
  console.log(`${BOLD}ПО DELTA${RESET}`);
  console.log(`${'─'.repeat(90)}`);
  const deltaSet = [...new Set(trades.map(t => t.delta))].sort((a, b) => b - a);
  for (const delta of deltaSet) {
    const s = emptyStats();
    for (const t of trades) if (t.delta === delta) addTrade(s, t);
    printStats(`delta=${delta >= 0 ? '+' : ''}${delta}¢`, s, '  ');
  }

  // ── По tau входа ─────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(90)}`);
  console.log(`${BOLD}ПО TAU ВХОДА${RESET}`);
  console.log(`${'─'.repeat(90)}`);
  const tauSet = [...new Set(trades.map(t => t.entryTau))].sort((a, b) => b - a);
  for (const tau of tauSet) {
    const s = emptyStats();
    for (const t of trades) if (t.entryTau === tau) addTrade(s, t);
    printStats(`tau=${tau}s`, s, '  ');
  }

  // ── По размеру девиации ───────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(90)}`);
  console.log(`${BOLD}ПО РАЗМЕРУ ДЕВИАЦИИ (10¢ бакеты)${RESET}`);
  console.log(`${'─'.repeat(90)}`);
  const devBucketMap = new Map<number, Stats>();
  for (const t of trades) {
    const db = Math.round(t.deviation / 10) * 10;
    if (!devBucketMap.has(db)) devBucketMap.set(db, emptyStats());
    addTrade(devBucketMap.get(db)!, t);
  }
  for (const db of [...devBucketMap.keys()].sort((a, b) => a - b)) {
    const s = devBucketMap.get(db)!;
    printStats(`dev=${db >= 0 ? '+' : ''}${db}¢`, s, '  ');
  }

  // ── CSV: все сделки для калибровочного анализа ───────────────────────────
  if (args.csv) {
    console.log('\nCSV:slug,entry,deviation,delta,tau,regime,resolution,pnl');
    for (const t of trades) {
      console.log(`CSV:${t.slug},${t.entryPrice.toFixed(2)},${t.deviation.toFixed(2)},${t.delta},${t.entryTau},${t.regime},${t.resolution},${t.pnl.toFixed(4)}`);
    }
  }

  // ── Verbose: список проигрышных сделок ───────────────────────────────────
  if (args.verbose) {
    console.log(`\n${'─'.repeat(90)}`);
    console.log(`${BOLD}ПРОИГРЫШНЫЕ СДЕЛКИ${RESET}`);
    console.log(`${'─'.repeat(90)}`);
    const losses = trades.filter(t => t.pnl < 0).sort((a, b) => a.pnl - b.pnl);
    for (const t of losses) {
      console.log(
        `  ${RED}✗${RESET} ${t.slug.slice(0, 50).padEnd(52)}` +
        `  delta=${String(t.delta).padStart(4)}  tau=${String(t.entryTau).padStart(3)}s` +
        `  dev=${pctSgn(t.deviation/100)}  entry=${c(t.entryPrice)}` +
        `  regime=${t.regime}  res=${t.resolution}  pnl=${colorPnl(pctSgn(t.pnl), t.pnl)}`,
      );
    }
  }

  console.log(`\n${'═'.repeat(90)}`);
  console.log(`Допущения: ставка $10 на сделку. PnL = (1 - price/100) если UP, -(price/100) если DOWN.`);
  console.log(`Без учёта комиссий и проскальзывания.`);
  console.log(`${'═'.repeat(90)}\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
