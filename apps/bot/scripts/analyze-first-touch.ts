/**
 * First-touch probability analysis для CrowdDeviationStrategy.
 *
 * После входа в сделку трассирует последующие тики и для каждой
 * комбинации (TP, SL) определяет что было достигнуто первым.
 * Показывает P(TP first) и EV для матрицы TP × SL.
 *
 * @remarks
 * Цена после входа отслеживается по mid-price в стакане.
 * При экспирации финальная цена = 100¢ (UP) или 0¢ (DOWN).
 *
 * @example
 * ```bash
 * npx tsx scripts/analyze-first-touch.ts \
 *   --table tables/edge-table-5min-apr-d10-t15-up.json \
 *   --snapshots /path/2026-05-07/polymarket,...,/path/2026-05-13/polymarket \
 *   --cex-cache-dir tables/cex-cache \
 *   --entry-dev 15 --min-entry-price 45 --regime-filter up
 * ```
 */

/* eslint-disable no-console */
import { readdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseSnapshot, classifyRegime } from './analyze-crowd-calibration';
import { loadCexCache, makeConsensus, type DayCache, type CexConsensus } from './cex-loader';

const RESET = '\x1b[0m';
const BOLD  = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED   = '\x1b[31m';
const DIM   = '\x1b[2m';
const CYAN  = '\x1b[36m';

function colorVal(v: number, s: string): string {
  if (v > 0.05) return `${GREEN}${s}${RESET}`;
  if (v < -0.02) return `${RED}${s}${RESET}`;
  return `${DIM}${s}${RESET}`;
}

// ── Edge table ────────────────────────────────────────────────────────────────
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
    b.totalN += z.train.n;
  }
  for (const b of map.values()) {
    if (b.totalN > 0) b.expectedCrowd /= b.totalN;
  }
  return map;
}

function toBucket(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

// ── First-touch result ────────────────────────────────────────────────────────
type TouchResult = 'tp_first' | 'sl_first' | 'expiry_win' | 'expiry_loss';

function firstTouch(
  entryPrice: number,
  subsequentPrices: number[],
  finalPrice: number, // 100 or 0
  tp: number,
  sl: number,
): TouchResult {
  const prices = [...subsequentPrices, finalPrice];
  for (const p of prices) {
    if (p >= entryPrice + tp) return 'tp_first';
    if (p <= entryPrice - sl) return 'sl_first';
  }
  // Ни TP ни SL не достигнуты — считаем по экспирации
  return finalPrice >= 50 ? 'expiry_win' : 'expiry_loss';
}

// ── CLI ───────────────────────────────────────────────────────────────────────
interface Args {
  tableFile:      string;
  dirs:           string[];
  asset:          string;
  token:          'up' | 'down';
  cexCacheDir:    string;
  entryDev:       number;
  entryDeltaMin:  number;
  entryDeltaMax:  number;
  minTau:         number;
  maxTau:         number;
  regimeFilter:   'up' | 'flat' | 'down' | 'all';
  residualFilter: 'pos' | 'neg' | 'all';
  minEntryPrice:  number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = {
    tableFile: '', dirs: [], asset: 'bitcoin', token: 'up',
    cexCacheDir: '',
    entryDev: 15,
    entryDeltaMin: -999, entryDeltaMax: 999,
    minTau: 30, maxTau: 9999,
    regimeFilter: 'all', residualFilter: 'all',
    minEntryPrice: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if      (a === '--table')            args.tableFile      = argv[++i];
    else if (a === '--snapshots')        args.dirs           = argv[++i].split(',');
    else if (a === '--asset')            args.asset          = argv[++i].toLowerCase();
    else if (a === '--token')            args.token          = argv[++i] as 'up' | 'down';
    else if (a === '--cex-cache-dir')    args.cexCacheDir    = argv[++i];
    else if (a === '--entry-dev')        args.entryDev       = Number(argv[++i]);
    else if (a === '--entry-delta-min')  args.entryDeltaMin  = Number(argv[++i]);
    else if (a === '--entry-delta-max')  args.entryDeltaMax  = Number(argv[++i]);
    else if (a === '--min-tau')          args.minTau         = Number(argv[++i]);
    else if (a === '--max-tau')          args.maxTau         = Number(argv[++i]);
    else if (a === '--regime-filter')    args.regimeFilter   = argv[++i] as Args['regimeFilter'];
    else if (a === '--residual-filter')  args.residualFilter = argv[++i] as Args['residualFilter'];
    else if (a === '--min-entry-price')  args.minEntryPrice  = Number(argv[++i]);
  }
  if (!args.tableFile || !args.dirs.length) {
    console.error('Usage: npx tsx scripts/analyze-first-touch.ts --table <file> --snapshots <dirs,...> [options]');
    process.exit(1);
  }
  return args;
}

// ── TP/SL матрица ─────────────────────────────────────────────────────────────
const TP_VALUES = [5, 10, 15, 20, 25, 30];
const SL_VALUES = [5, 10, 15, 20];

interface Cell { tp_first: number; sl_first: number; expiry_win: number; expiry_loss: number; }
function emptyCell(): Cell { return { tp_first: 0, sl_first: 0, expiry_win: 0, expiry_loss: 0 }; }

function cellKey(tp: number, sl: number): string { return `${tp}:${sl}`; }

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = parseArgs();
  const table: EdgeTable = JSON.parse(readFileSync(args.tableFile, 'utf8'));
  const { meta, zones } = table;
  const buck = meta.bucketing;
  const baseline = buildBaseline(table);

  console.log(`\n${BOLD}First-Touch Probability Analysis${RESET}`);
  console.log(`Table: ${args.tableFile}  (${zones.length} zones)`);
  console.log(`Entry: dev≥${args.entryDev}¢  minPrice=${args.minEntryPrice}¢  regime=${args.regimeFilter}`);

  // CEX консенсус
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

  // Файлы снапшотов
  const files: { path: string; dir: string }[] = [];
  for (const dir of args.dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if ((f.endsWith('.jsonl') || f.endsWith('.jsonl.gz')) && f.toLowerCase().includes(args.asset)) {
        files.push({ path: join(dir, f), dir });
      }
    }
  }
  console.log(`Snapshot files: ${files.length}\n`);

  // Матрицы: ключ = `tp:sl`, значение = Cell
  const matrix = new Map<string, Cell>();
  for (const tp of TP_VALUES) for (const sl of SL_VALUES) matrix.set(cellKey(tp, sl), emptyCell());

  // По бинам цены входа
  const priceBins = new Map<number, Map<string, Cell>>();
  for (const bin of [40, 45, 50, 55, 60, 65]) {
    const m = new Map<string, Cell>();
    for (const tp of TP_VALUES) for (const sl of SL_VALUES) m.set(cellKey(tp, sl), emptyCell());
    priceBins.set(bin, m);
  }

  let totalTrades = 0;

  for (const { path, dir } of files) {
    const consensus = dirConsensus.get(dir) ?? undefined;
    const cexConsensusAt = consensus ? (ts: number) => consensus.consensusAt(ts) : undefined;

    const result = await parseSnapshot(path, buck.maxTau, args.token, true, undefined, cexConsensusAt);
    if (!result.data) continue;
    const { data } = result;
    const resolution = data.resolution;
    const finalPrice = resolution === 'UP' ? 100 : 0;

    // Сортируем по tau убыванию (ранний вход)
    const sorted = [...data.observations].sort((a, b) => b.tauSec - a.tauSec);

    for (let entryIdx = 0; entryIdx < sorted.length; entryIdx++) {
      const obs = sorted[entryIdx]!;
      const delta = toBucket(obs.delta, buck.deltaStep);
      const tau   = toBucket(obs.tauSec, buck.tauStep);

      if (tau < args.minTau || tau > args.maxTau) continue;
      if (delta < args.entryDeltaMin || delta > args.entryDeltaMax) continue;
      if (Math.abs(delta) > buck.maxDelta) continue;

      const cellKey_ = `${delta}:${tau}`;
      const b = baseline.get(cellKey_);
      if (!b || b.totalN < 20) continue;

      const observedCrowd = obs.midPriceCents;
      const deviation = observedCrowd - b.expectedCrowd;

      if (Math.abs(deviation) < args.entryDev) continue;
      if (deviation >= 0) continue; // только neg deviation (покупаем недооценку)
      if (args.minEntryPrice > 0 && observedCrowd < args.minEntryPrice) continue;

      const regime = classifyRegime(obs.trendSlope, buck.regimeThreshold);
      if (args.regimeFilter !== 'all' && regime !== args.regimeFilter) continue;

      if (args.residualFilter !== 'all' && obs.cexResidualBps !== undefined) {
        if (args.residualFilter === 'pos' && obs.cexResidualBps <= 0) continue;
        if (args.residualFilter === 'neg' && obs.cexResidualBps >= 0) continue;
      }

      // Нашли вход — собираем последующие цены (меньший tau = позже по времени)
      const subsequentPrices = sorted
        .slice(entryIdx + 1)
        .map(o => o.midPriceCents);

      totalTrades++;

      // Bin по цене входа (с шагом 5¢)
      const priceBin = Math.floor(observedCrowd / 5) * 5;

      // Для каждой TP/SL комбинации
      for (const tp of TP_VALUES) {
        for (const sl of SL_VALUES) {
          const result_ = firstTouch(observedCrowd, subsequentPrices, finalPrice, tp, sl);
          const key = cellKey(tp, sl);

          // Общая матрица
          const cell = matrix.get(key)!;
          cell[result_ as keyof Cell]++;

          // По ценовому бину
          const binMatrix = priceBins.get(priceBin);
          if (binMatrix) {
            const binCell = binMatrix.get(key)!;
            binCell[result_ as keyof Cell]++;
          }
        }
      }

      break; // Только первый вход на рынок
    }
  }

  // ── Вывод общей матрицы ───────────────────────────────────────────────────
  console.log(`${BOLD}Всего сделок: ${totalTrades}${RESET}\n`);

  printMatrix('ОБЩАЯ МАТРИЦА', matrix, totalTrades);

  // ── Вывод по ценовым бинам ────────────────────────────────────────────────
  for (const [bin, m] of priceBins) {
    const n = [...m.values()].reduce((s, c) => s + c.tp_first + c.sl_first + c.expiry_win + c.expiry_loss, 0) / (TP_VALUES.length * SL_VALUES.length);
    if (n < 5) continue;
    printMatrix(`ЦЕНА ВХОДА ${bin}¢–${bin + 5}¢  (n≈${Math.round(n)})`, m, Math.round(n));
  }

  console.log(`\n${DIM}EV рассчитан для позиции $5: (P_tp × TP - P_sl × SL - P_expiry_loss × entry_price × 0 + P_expiry_win × (100-entry)) / 100 × 5${RESET}`);
  console.log(`${DIM}Для простоты: EV = P_tp × tp_cents - (1-P_tp) × sl_cents  [нормализовано на 100]${RESET}`);
}

function printMatrix(title: string, matrix: Map<string, Cell>, n: number): void {
  console.log(`\n${BOLD}${CYAN}${title}${RESET}`);

  // P(TP first) матрица
  console.log(`\n  P(TP достигнут первым):`);
  process.stdout.write(`  ${'TP\\SL'.padStart(6)}`);
  for (const sl of SL_VALUES) process.stdout.write(`  SL=${sl}¢ `.padStart(9));
  console.log();

  for (const tp of TP_VALUES) {
    process.stdout.write(`  TP=${tp}¢`.padStart(7));
    for (const sl of SL_VALUES) {
      const c = matrix.get(cellKey(tp, sl))!;
      const total = c.tp_first + c.sl_first + c.expiry_win + c.expiry_loss;
      if (total === 0) { process.stdout.write('      —   '); continue; }
      const pTp = (c.tp_first + c.expiry_win) / total; // TP или экспирация в плюс
      const s = `${(pTp * 100).toFixed(0)}%`.padStart(5);
      process.stdout.write(`  ${pTp > 0.55 ? `${GREEN}${s}${RESET}` : pTp < 0.45 ? `${RED}${s}${RESET}` : s}   `);
    }
    console.log();
  }

  // EV матрица (центы на $5 позицию)
  console.log(`\n  EV (¢ прибыли на сделку при $5 ставке):`);
  process.stdout.write(`  ${'TP\\SL'.padStart(6)}`);
  for (const sl of SL_VALUES) process.stdout.write(`  SL=${sl}¢ `.padStart(9));
  console.log();

  for (const tp of TP_VALUES) {
    process.stdout.write(`  TP=${tp}¢`.padStart(7));
    for (const sl of SL_VALUES) {
      const c = matrix.get(cellKey(tp, sl))!;
      const total = c.tp_first + c.sl_first + c.expiry_win + c.expiry_loss;
      if (total === 0) { process.stdout.write('      —   '); continue; }
      // P_tp = вышли по TP (в плюс на tp центов)
      // P_expiry_win = дошли до экспирации и выиграли (hold-to-expiry)
      // P_sl = вышли по SL (в минус на sl центов)
      // P_expiry_loss = дошли до экспирации и проиграли
      const pTpHit     = c.tp_first / total;
      const pSlHit     = c.sl_first / total;
      const pExpiryWin = c.expiry_win / total;
      const pExpiryLoss = c.expiry_loss / total;
      // EV в процентах от позиции (для $5 умножим на 5)
      // Упрощение: при expiry_win считаем средний выигрыш +50¢ (грубо), при expiry_loss -50¢
      const ev = pTpHit * tp - pSlHit * sl + pExpiryWin * 30 - pExpiryLoss * 30;
      const evDollars = ev / 100 * 5;
      const s = `${evDollars >= 0 ? '+' : ''}${evDollars.toFixed(2)}$`.padStart(7);
      process.stdout.write(`  ${colorVal(evDollars, s)}  `);
    }
    console.log();
  }
  console.log();
}

main().catch(console.error);
