/**
 * Анализ crowd-девиации: когда толпа оценивает ситуацию значительно
 * выше или ниже исторической нормы для той же (delta, tau) ячейки.
 *
 * @remarks
 * Из training-таблицы строим baseline: для каждой (delta, tau) пары —
 * взвешенное среднее crowd-цены по всем режимам и crowd-бакетам.
 * Затем в OOS-снапшотах для каждого наблюдения вычисляем:
 *
 *   deviation = observed_crowd − expected_crowd  (в центах)
 *
 * Группируем наблюдения по девиационным бакетам (шаг 10¢) и смотрим:
 * - pHat в каждом бакете (UP токен: % рынков разрешившихся UP)
 * - Сравниваем с baseline pHat для той же (delta, tau)
 * - Edge = pHat − observed_crowd → торгуемое преимущество
 *
 * Отрицательная девиация (crowd ниже нормы) → потенциальный BUY.
 * Положительная (crowd выше нормы) → потенциальный SELL.
 *
 * @example
 * ```bash
 * npx tsx scripts/analyze-crowd-deviation.ts \
 *   --table tables/edge-table-5min-full-mar-apr-up.json \
 *   --snapshots /path/2026-05-01/polymarket,...,/path/2026-05-06/polymarket \
 *   --asset bitcoin --token up \
 *   --min-n 20 --dev-threshold 10
 * ```
 */

/* eslint-disable no-console */
import { readdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  parseSnapshot,
  classifyRegime,
  type Observation,
} from './analyze-crowd-calibration';

// ── ANSI ──────────────────────────────────────────────────────────────────────
const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const DIM    = '\x1b[2m';
const CYAN   = '\x1b[36m';

function colorEdge(text: string, edge: number): string {
  if (edge >= 0.08) return `${BOLD}${GREEN}${text}${RESET}`;
  if (edge >= 0.04) return `${GREEN}${text}${RESET}`;
  if (edge <= -0.08) return `${BOLD}${RED}${text}${RESET}`;
  if (edge <= -0.04) return `${RED}${text}${RESET}`;
  if (Math.abs(edge) < 0.02) return `${DIM}${text}${RESET}`;
  return text;
}

function pct(v: number): string { return `${(v * 100).toFixed(1)}%`; }
function pctSgn(v: number): string { return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`; }
function c(v: number): string { return `${v.toFixed(1)}¢`; }
function cSgn(v: number): string { return `${v >= 0 ? '+' : ''}${v.toFixed(1)}¢`; }

// ── Типы таблицы ──────────────────────────────────────────────────────────────

interface EdgeTableMeta {
  bucketing: {
    deltaStep: number;
    tauStep:   number;
    crowdStep: number;
    regimeThreshold: number;
    maxDelta:  number;
    maxTau:    number;
  };
}

interface EdgeZone {
  key:   { delta: number; tau: number; crowd: number; regime: string; residual: number };
  train: { n: number; crowdAvg: number; pHat: number; nObservations: number };
  oos?:  { n: number; pHat: number };
}

interface EdgeTable {
  meta:  EdgeTableMeta;
  zones: EdgeZone[];
}

// ── Baseline: (delta, tau) → ожидаемый crowd и pHat ─────────────────────────

interface CellBaseline {
  expectedCrowd: number;   // взвешенный средний crowd в центах
  baselinePhat:  number;   // взвешенный средний pHat
  totalN:        number;
  nZones:        number;
}

function buildBaseline(table: EdgeTable): Map<string, CellBaseline> {
  const map = new Map<string, CellBaseline>();
  for (const z of table.zones) {
    const key = `${z.key.delta}:${z.key.tau}`;
    if (!map.has(key)) map.set(key, { expectedCrowd: 0, baselinePhat: 0, totalN: 0, nZones: 0 });
    const b = map.get(key)!;
    b.expectedCrowd += z.train.n * z.train.crowdAvg * 100;
    b.baselinePhat  += z.train.n * z.train.pHat;
    b.totalN        += z.train.n;
    b.nZones++;
  }
  for (const b of map.values()) {
    if (b.totalN > 0) {
      b.expectedCrowd /= b.totalN;
      b.baselinePhat  /= b.totalN;
    }
  }
  return map;
}

// ── Bucketing (зеркало build-edge-table) ─────────────────────────────────────

function toBucket(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

// ── OOS аккумулятор по девиационным бакетам ──────────────────────────────────

interface DevBucket {
  devCenter:    number;   // центр бакета в центах
  nObs:         number;   // raw observations
  upObs:        number;
  resolvedObs:  number;
  nMarkets:     number;
  nMarketsUp:   number;
  crowdSum:     number;   // для среднего наблюдаемого crowd
  expectedCrowd: number;  // baseline crowd (одинаковый для всего бакета — усредним)
  baselinePhat:  number;
}

// ── CLI args ──────────────────────────────────────────────────────────────────

interface Args {
  tableFile:    string;
  dirs:         string[];
  asset:        string;
  token:        'up' | 'down';
  minN:         number;
  devThreshold: number;   // минимальная |девиация| для показа в сводке
  devStep:      number;   // шаг девиационного бакета в центах
  minTau:       number;   // фильтр: только наблюдения с tau >= minTau
  maxTau:       number;   // фильтр: только наблюдения с tau <= maxTau
  verbose:      boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = {
    tableFile:    '',
    dirs:         [],
    asset:        'bitcoin',
    token:        'up',
    minN:         15,
    devThreshold: 5,
    devStep:      10,
    minTau:       0,
    maxTau:       9999,
    verbose:      false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if      (a === '--table')         args.tableFile    = argv[++i];
    else if (a === '--snapshots')     args.dirs         = argv[++i].split(',');
    else if (a === '--asset')         args.asset        = argv[++i].toLowerCase();
    else if (a === '--token')         args.token        = argv[++i] as 'up' | 'down';
    else if (a === '--min-n')         args.minN         = Number(argv[++i]);
    else if (a === '--dev-threshold') args.devThreshold = Number(argv[++i]);
    else if (a === '--dev-step')      args.devStep      = Number(argv[++i]);
    else if (a === '--min-tau')       args.minTau       = Number(argv[++i]);
    else if (a === '--max-tau')       args.maxTau       = Number(argv[++i]);
    else if (a === '--verbose')       args.verbose      = true;
  }
  if (!args.tableFile || !args.dirs.length) {
    console.error(
      'Usage: npx tsx scripts/analyze-crowd-deviation.ts \\\n' +
      '  --table tables/edge-table-5min-full-mar-apr-up.json \\\n' +
      '  --snapshots /path/2026-05-01/polymarket,...\\\n' +
      '  [--asset bitcoin] [--token up] [--min-n 15] [--dev-threshold 5] [--dev-step 10]',
    );
    process.exit(1);
  }
  return args;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();

  const table: EdgeTable = JSON.parse(readFileSync(args.tableFile, 'utf8'));
  const { meta, zones } = table;
  const buck = meta.bucketing;

  console.log(`\n${BOLD}Table:${RESET} ${args.tableFile}  (${zones.length} zones)`);
  console.log(`Token: ${args.token}  |  Asset: ${args.asset}`);
  console.log(`Bucketing: deltaStep=${buck.deltaStep} tauStep=${buck.tauStep} crowdStep=${buck.crowdStep}`);
  if (args.minTau > 0 || args.maxTau < 9999) {
    console.log(`Tau filter: ${args.minTau}s – ${args.maxTau < 9999 ? args.maxTau + 's' : '∞'}`);
  }

  // Строим baseline: (delta, tau) → expected crowd + baseline pHat
  const baseline = buildBaseline(table);
  console.log(`\nBaseline cells (delta×tau): ${baseline.size}`);

  // Несколько примеров baseline
  if (args.verbose) {
    console.log('\nПримеры baseline:');
    for (const [key, b] of [...baseline].sort(([,a],[,bb]) => bb.totalN - a.totalN).slice(0, 10)) {
      const [delta, tau] = key.split(':').map(Number);
      console.log(`  delta=${String(delta).padStart(5)} tau=${String(tau).padStart(3)}s | expectedCrowd=${c(b.expectedCrowd)} baselinePhat=${pct(b.baselinePhat)} n=${b.totalN}`);
    }
  }

  // Сканируем OOS снапшоты
  const files: { path: string; dir: string }[] = [];
  for (const dir of args.dirs) {
    if (!existsSync(dir)) { console.error(`  WARNING: dir not found: ${dir}`); continue; }
    for (const f of readdirSync(dir)) {
      if ((f.endsWith('.jsonl') || f.endsWith('.jsonl.gz')) && f.toLowerCase().includes(args.asset)) {
        files.push({ path: join(dir, f), dir });
      }
    }
  }
  console.log(`\nSnapshot files: ${files.length}`);

  // Аккумулируем по девиационным бакетам
  const devMap = new Map<number, DevBucket>();
  // И по (delta, tau, devBucket) для детального анализа
  const cellDevMap = new Map<string, DevBucket>();

  let filesOk = 0, filesSkipped = 0;
  let totalObs = 0, unmapped = 0;

  for (const { path } of files) {
    const result = await parseSnapshot(path, buck.maxTau, args.token, true);
    if (!result.data) { filesSkipped++; continue; }
    filesOk++;
    const { data } = result;
    const resolution = data.resolution;

    const seenCellMarket = new Set<string>();

    for (const obs of data.observations) {
      const delta = toBucket(obs.delta, buck.deltaStep);
      const tau   = toBucket(obs.tauSec, buck.tauStep);

      if (Math.abs(delta) > buck.maxDelta || tau > buck.maxTau) { unmapped++; continue; }
      if (tau < args.minTau || tau > args.maxTau) { unmapped++; continue; }

      const cellKey  = `${delta}:${tau}`;
      const b        = baseline.get(cellKey);
      if (!b || b.totalN < 20) { unmapped++; continue; }  // нет надёжного baseline

      const observedCrowd = obs.midPriceCents;
      const deviation     = observedCrowd - b.expectedCrowd;   // в центах
      const devBucket     = Math.round(deviation / args.devStep) * args.devStep;

      totalObs++;

      // Глобальный девиационный бакет
      if (!devMap.has(devBucket)) {
        devMap.set(devBucket, {
          devCenter: devBucket, nObs: 0, upObs: 0, resolvedObs: 0,
          nMarkets: 0, nMarketsUp: 0, crowdSum: 0, expectedCrowd: 0, baselinePhat: 0,
        });
      }
      const db = devMap.get(devBucket)!;
      db.nObs++;
      db.crowdSum      += observedCrowd;
      db.expectedCrowd += b.expectedCrowd;
      db.baselinePhat  += b.baselinePhat;
      if (resolution === 'UP') { db.upObs++; db.resolvedObs++; }
      else if (resolution === 'DOWN') { db.resolvedObs++; }

      const marketBucketKey = `${devBucket}::${data.slug}`;
      if (!seenCellMarket.has(marketBucketKey)) {
        seenCellMarket.add(marketBucketKey);
        db.nMarkets++;
        if (resolution === 'UP') db.nMarketsUp++;
      }

      // Детальный бакет по (delta, tau, devBucket)
      const cdKey = `${delta}:${tau}:${devBucket}`;
      if (!cellDevMap.has(cdKey)) {
        cellDevMap.set(cdKey, {
          devCenter: devBucket, nObs: 0, upObs: 0, resolvedObs: 0,
          nMarkets: 0, nMarketsUp: 0, crowdSum: 0, expectedCrowd: b.expectedCrowd, baselinePhat: b.baselinePhat,
        });
      }
      const cdb = cellDevMap.get(cdKey)!;
      cdb.nObs++;
      cdb.crowdSum += observedCrowd;
      if (resolution === 'UP') { cdb.upObs++; cdb.resolvedObs++; }
      else if (resolution === 'DOWN') { cdb.resolvedObs++; }
      const mk2 = `${cdKey}::${data.slug}`;
      if (!seenCellMarket.has(mk2)) {
        seenCellMarket.add(mk2);
        cdb.nMarkets++;
        if (resolution === 'UP') cdb.nMarketsUp++;
      }
    }
  }

  console.log(`Parsed: ${filesOk} OK  |  ${filesSkipped} skipped`);
  console.log(`OBS: ${totalObs.toLocaleString()} mapped  |  ${unmapped.toLocaleString()} unmapped (no baseline)`);

  // ── Глобальная таблица девиаций ───────────────────────────────────────────

  console.log(`\n${'═'.repeat(90)}`);
  console.log(`${BOLD}CROWD DEVIATION → WIN RATE  (token=${args.token})${RESET}`);
  console.log(`Deviation = observed_crowd − expected_crowd для той же (delta, tau)`);
  console.log(`${'═'.repeat(90)}`);

  const colW = [12, 10, 10, 10, 12, 12, 12, 12];
  const headers = ['Dev bucket', 'nObs', 'nMarkets', 'Obs crowd', 'Exp crowd', 'Baseline%', 'OOS pHat', 'Edge vs obs'];
  console.log(headers.map((h, i) => h.padStart(colW[i])).join(' '));
  console.log(headers.map((_, i) => '─'.repeat(colW[i])).join(' '));

  const sorted = [...devMap.values()].sort((a, b) => a.devCenter - b.devCenter);

  for (const db of sorted) {
    if (db.nMarkets < args.minN) continue;
    const avgObsCrowd  = db.crowdSum / db.nObs;
    const avgExpCrowd  = db.expectedCrowd / db.nObs;
    const avgBasePhat  = db.baselinePhat / db.nObs;
    const oosPhat      = db.resolvedObs > 0 ? db.upObs / db.resolvedObs : null;
    const edgeVsObs    = oosPhat !== null ? oosPhat - avgObsCrowd / 100 : null;

    const devLabel = `${db.devCenter >= 0 ? '+' : ''}${db.devCenter}¢`;
    const phatStr  = oosPhat !== null ? pct(oosPhat) : '—';
    const edgeStr  = edgeVsObs !== null ? colorEdge(pctSgn(edgeVsObs), edgeVsObs) : '—';
    const devColor = db.devCenter <= -args.devThreshold ? CYAN
                   : db.devCenter >= args.devThreshold  ? YELLOW : '';

    console.log([
      `${devColor}${devLabel}${RESET}`.padStart(colW[0] + (devColor ? 10 : 0)),
      db.nObs.toLocaleString().padStart(colW[1]),
      db.nMarkets.toLocaleString().padStart(colW[2]),
      c(avgObsCrowd).padStart(colW[3]),
      c(avgExpCrowd).padStart(colW[4]),
      pct(avgBasePhat).padStart(colW[5]),
      phatStr.padStart(colW[6]),
      edgeStr.padStart(colW[7] + (edgeVsObs !== null ? 10 : 0)),
    ].join(' '));
  }

  // ── Сводка по знаку девиации ──────────────────────────────────────────────

  let negObs = 0, negUp = 0, negRes = 0, negCrowd = 0;
  let posObs = 0, posUp = 0, posRes = 0, posCrowd = 0;
  let zeroObs = 0, zeroUp = 0, zeroRes = 0;

  for (const db of sorted) {
    if (db.nMarkets < args.minN) continue;
    if (db.devCenter < -args.devThreshold) {
      negObs += db.nObs; negUp += db.upObs; negRes += db.resolvedObs;
      negCrowd += db.crowdSum;
    } else if (db.devCenter > args.devThreshold) {
      posObs += db.nObs; posUp += db.upObs; posRes += db.resolvedObs;
      posCrowd += db.crowdSum;
    } else {
      zeroObs += db.nObs; zeroUp += db.upObs; zeroRes += db.resolvedObs;
    }
  }

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`${BOLD}СВОДКА по знаку девиации (threshold ±${args.devThreshold}¢)${RESET}`);
  console.log(`${'─'.repeat(70)}`);

  const printSummaryRow = (label: string, nObs: number, nUp: number, nRes: number, crowdSum: number, hint: string) => {
    if (nRes === 0) return;
    const phat      = nUp / nRes;
    const avgCrowd  = nObs > 0 ? crowdSum / nObs / 100 : 0;
    const edge      = phat - avgCrowd;
    const edgeStr   = colorEdge(pctSgn(edge), edge);
    console.log(`  ${label.padEnd(30)} nObs=${nObs.toLocaleString().padStart(8)}  pHat=${pct(phat)}  avgCrowd=${c(avgCrowd*100)}  edge=${edgeStr}  ${hint}`);
  };

  printSummaryRow(`Crowd НИЖЕ нормы (< -${args.devThreshold}¢)`, negObs, negUp, negRes, negCrowd, '← потенц. BUY');
  printSummaryRow(`Crowd близко к норме`, zeroObs, zeroUp, zeroRes, zeroObs > 0 ? zeroObs * 50 : 0, '');
  printSummaryRow(`Crowd ВЫШЕ нормы (> +${args.devThreshold}¢)`, posObs, posUp, posRes, posCrowd, '← потенц. SELL');

  // ── Детально по ячейкам с большой девиацией ───────────────────────────────

  console.log(`\n${'─'.repeat(90)}`);
  console.log(`${BOLD}ДЕТАЛЬНО: ячейки с |deviation| > ${args.devThreshold}¢ и nMarkets >= ${args.minN}${RESET}`);
  console.log(`${'─'.repeat(90)}`);

  interface CellRow {
    delta: number; tau: number; dev: number;
    nMarkets: number; avgObs: number; expCrowd: number; basePhat: number;
    oosPhat: number | null; edgeVsObs: number | null;
  }
  const cellRows: CellRow[] = [];

  for (const [key, db] of cellDevMap) {
    if (db.nMarkets < args.minN) continue;
    if (Math.abs(db.devCenter) < args.devThreshold) continue;
    const [delta, tau] = key.split(':').map(Number);
    const avgObs   = db.crowdSum / db.nObs;
    const oosPhat  = db.resolvedObs > 0 ? db.upObs / db.resolvedObs : null;
    const edgeVsObs = oosPhat !== null ? oosPhat - avgObs / 100 : null;
    cellRows.push({ delta, tau, dev: db.devCenter, nMarkets: db.nMarkets, avgObs, expCrowd: db.expectedCrowd, basePhat: db.baselinePhat, oosPhat, edgeVsObs });
  }

  cellRows.sort((a, b) => (b.edgeVsObs ?? -99) - (a.edgeVsObs ?? -99));

  const ch2 = ['delta', 'tau', 'deviation', 'nMkt', 'Obs crowd', 'Exp crowd', 'Base%', 'OOS pHat', 'Edge'];
  const cw2 = [8, 6, 12, 6, 10, 10, 8, 10, 10];
  console.log(ch2.map((h, i) => h.padStart(cw2[i])).join(' '));
  console.log(ch2.map((_, i) => '─'.repeat(cw2[i])).join(' '));

  for (const r of cellRows) {
    const phatStr = r.oosPhat !== null ? pct(r.oosPhat) : '—';
    const edgeStr = r.edgeVsObs !== null ? colorEdge(pctSgn(r.edgeVsObs), r.edgeVsObs) : '—';
    console.log([
      String(r.delta).padStart(cw2[0]),
      String(r.tau).padStart(cw2[1]),
      cSgn(r.dev).padStart(cw2[2]),
      String(r.nMarkets).padStart(cw2[3]),
      c(r.avgObs).padStart(cw2[4]),
      c(r.expCrowd).padStart(cw2[5]),
      pct(r.basePhat).padStart(cw2[6]),
      phatStr.padStart(cw2[7]),
      edgeStr.padStart(cw2[8] + (r.edgeVsObs !== null ? 10 : 0)),
    ].join(' '));
  }

  console.log(`\nВсего ячеек с девиацией: ${cellRows.length}`);
}

main().catch(err => { console.error(err); process.exit(1); });
