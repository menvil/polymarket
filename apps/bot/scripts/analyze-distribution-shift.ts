/**
 * Анализ distributional shift между training-таблицей и новым (OOS) периодом.
 *
 * @remarks
 * Загружает готовую edge-таблицу, прогоняет OOS-снапшоты через тот же pipeline
 * (режим, residual-бакетизация) и сравнивает:
 *   1. Частоту попадания в каждую зону (freq shift) — структурный сдвиг рынка.
 *   2. Win-rate (pHat) в каждой зоне — деградация сигнала.
 *   3. crowdAvg — смещение цен толпы.
 *   4. Summary health score: % зон с отклонением freq > порога.
 *
 * Для зон с фичей `residual` требует CEX-кэш (--cex-cache-dir).
 * Для дней без CEX-кэша — residual-зоны не заполнятся; считается только режим.
 *
 * @example
 * ```bash
 * # Полный OOS-анализ (апр 22-27, есть CEX):
 * npx tsx scripts/analyze-distribution-shift.ts \
 *   --table tables/sweep-residual/edge-5min-up-relaxed.json \
 *   --snapshots /path/snapshots/2026-04-22,/path/snapshots/2026-04-23,... \
 *   --cex-cache-dir tables/cex-cache \
 *   --asset bitcoin --token up \
 *   --threshold 0.20
 *
 * # Только regime-анализ (без CEX):
 * npx tsx scripts/analyze-distribution-shift.ts \
 *   --table tables/sweep-residual/edge-5min-up-relaxed.json \
 *   --snapshots /path/snapshots/2026-04-28,... \
 *   --asset bitcoin --token up \
 *   --regime-only
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
import { loadCexCache, makeConsensus, type DayCache, type CexConsensus } from './cex-loader';

// ── ANSI ──────────────────────────────────────────────────────────────────────

const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const DIM    = '\x1b[2m';

function colorDev(text: string, dev: number): string {
  const abs = Math.abs(dev);
  if (abs >= 0.50) return `${BOLD}${RED}${text}${RESET}`;
  if (abs >= 0.20) return `${RED}${text}${RESET}`;
  if (abs >= 0.10) return `${YELLOW}${text}${RESET}`;
  if (abs < 0.05)  return `${DIM}${text}${RESET}`;
  return text;
}

function colorPhat(text: string, diff: number): string {
  if (diff <= -0.10) return `${BOLD}${RED}${text}${RESET}`;
  if (diff <= -0.05) return `${RED}${text}${RESET}`;
  if (diff >= +0.05) return `${GREEN}${text}${RESET}`;
  return text;
}

function pct(v: number): string { return `${(v * 100).toFixed(1)}%`; }
function pctSgn(v: number): string { return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`; }

// ── Типы edge-таблицы (только то, что нам нужно) ─────────────────────────────

interface ZoneKey {
  delta:    number;
  tau:      number;
  crowd:    number;
  regime:   'up' | 'flat' | 'down';
  residual: number;
}

interface ZoneTrain {
  n:             number;
  upCount:       number;
  nObservations: number;
  crowdAvg:      number;
  pHat:          number;
  edge:          number;
  fillRate?:     number;
  attempts?:     number;
}

interface ZoneOos {
  n:      number;
  pHat:   number;
  edge:   number;
  passes: boolean;
}

interface ZoneWeights {
  composite: number;
}

interface EdgeZone {
  key:     ZoneKey;
  train:   ZoneTrain;
  oos?:    ZoneOos;
  weights: ZoneWeights;
  signal:  'BUY' | 'SELL' | 'SKIP';
}

interface EdgeTableMeta {
  generatedAt: string;
  features: {
    delta:    boolean;
    tau:      boolean;
    crowd:    boolean;
    regime:   boolean;
    residual: boolean;
  };
  bucketing: {
    deltaStep:    number;
    tauStep:      number;
    crowdStep:    number;
    regimeThreshold: number;
    maxDelta:     number;
    maxTau:       number;
    residualStep: number;
    maxResidual:  number;
  };
  training: {
    marketCount:       number;
    effectiveSamples:  number;
    observationCount:  number;
  };
}

interface EdgeTable {
  meta:  EdgeTableMeta;
  zones: EdgeZone[];
}

// ── Бакетизация (зеркало build-edge-table.ts) ─────────────────────────────────

function toBucket(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

function residualBucket(bps: number | undefined, step: number, maxResidual: number): number | null {
  if (bps === undefined || !Number.isFinite(bps)) return null;
  if (Math.abs(bps) > maxResidual) return null;
  return Math.round(bps / step) * step;
}

interface FeatureSet {
  delta:    boolean;
  tau:      boolean;
  crowd:    boolean;
  regime:   boolean;
  residual: boolean;
}

function bucketKey(
  o: Observation,
  f: FeatureSet,
  bucketing: EdgeTableMeta['bucketing'],
): string | null {
  let residual = 0;
  if (f.residual) {
    const r = residualBucket(o.cexResidualBps, bucketing.residualStep, bucketing.maxResidual);
    if (r === null) return null;
    residual = r;
  }
  const key: ZoneKey = {
    delta:    f.delta    ? toBucket(o.delta,          bucketing.deltaStep)  : 0,
    tau:      f.tau      ? toBucket(o.tauSec,         bucketing.tauStep)    : 0,
    crowd:    f.crowd    ? toBucket(o.midPriceCents,   bucketing.crowdStep)  : 0,
    regime:   f.regime   ? classifyRegime(o.trendSlope, bucketing.regimeThreshold) : 'flat',
    residual,
  };
  return JSON.stringify([key.delta, key.tau, key.crowd, key.regime, key.residual]);
}

function zoneKeyStr(k: ZoneKey): string {
  return JSON.stringify([k.delta, k.tau, k.crowd, k.regime, k.residual]);
}

// ── CEX helpers ───────────────────────────────────────────────────────────────

function dirToDay(dir: string): string | null {
  const segs = dir.split('/').filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(segs[i])) return segs[i];
  }
  return null;
}

function buildDirConsensusMap(dirs: string[], cexCacheDir: string): Map<string, CexConsensus | null> {
  const map = new Map<string, CexConsensus | null>();
  const CEX_STALE_MS = 2000;
  for (const dir of dirs) {
    const day = dirToDay(dir);
    if (!day) { map.set(dir, null); continue; }
    if (!cexCacheDir) { map.set(dir, null); continue; }
    const cachePath = join(cexCacheDir, `${day}.json`);
    if (!existsSync(cachePath)) { map.set(dir, null); continue; }
    const cache: DayCache = loadCexCache(cachePath);
    map.set(dir, makeConsensus([cache], CEX_STALE_MS));
  }
  return map;
}

// ── OOS-аккумулятор ───────────────────────────────────────────────────────────

/**
 * Накопленная статистика по одной зоне за OOS-период.
 */
interface OosAccum {
  nObs:       number;   // raw observations
  upObs:      number;   // UP observations (resolved markets only)
  downObs:    number;   // DOWN observations
  resolvedObs: number;  // наблюдения из рынков с известным исходом
  crowdSum:   number;
  nMarkets:   number;
  nMarketsUp: number;
}

function newOosAccum(): OosAccum {
  return { nObs: 0, upObs: 0, downObs: 0, resolvedObs: 0, crowdSum: 0, nMarkets: 0, nMarketsUp: 0 };
}

// ── CLI args ──────────────────────────────────────────────────────────────────

interface Args {
  tableFile:   string;
  dirs:        string[];
  cexCacheDir: string;
  asset:       string;
  token:       'up' | 'down';
  threshold:   number;
  regimeOnly:  boolean;
  verbose:     boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = {
    tableFile:   '',
    dirs:        [],
    cexCacheDir: '',
    asset:       'bitcoin',
    token:       'up',
    threshold:   0.10,
    regimeOnly:  false,
    verbose:     false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if      (a === '--table')         args.tableFile   = argv[++i];
    else if (a === '--snapshots')     args.dirs        = argv[++i].split(',');
    else if (a === '--cex-cache-dir') args.cexCacheDir = argv[++i];
    else if (a === '--asset')         args.asset       = argv[++i].toLowerCase();
    else if (a === '--token')         args.token       = argv[++i] as 'up' | 'down';
    else if (a === '--threshold')     args.threshold   = Number(argv[++i]);
    else if (a === '--regime-only')   args.regimeOnly  = true;
    else if (a === '--verbose')       args.verbose     = true;
  }
  if (!args.tableFile || !args.dirs.length) {
    console.error(
      'Usage: npx tsx scripts/analyze-distribution-shift.ts \\\n' +
      '  --table tables/sweep-residual/edge-5min-up-relaxed.json \\\n' +
      '  --snapshots /path/2026-04-22,/path/2026-04-23 \\\n' +
      '  [--cex-cache-dir tables/cex-cache] [--asset bitcoin] [--token up] \\\n' +
      '  [--threshold 0.10] [--regime-only] [--verbose]',
    );
    process.exit(1);
  }
  return args;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();

  // Загрузка таблицы
  const table: EdgeTable = JSON.parse(readFileSync(args.tableFile, 'utf8'));
  const { meta, zones } = table;
  const features = args.regimeOnly
    ? { ...meta.features, residual: false }
    : meta.features;

  console.log(`\n${BOLD}Edge table:${RESET} ${args.tableFile}`);
  console.log(`Generated: ${meta.generatedAt}`);
  console.log(`Features : ${Object.entries(features).filter(([,v])=>v).map(([k])=>k).join(', ')}`);
  console.log(`Zones    : ${zones.length}  (training obs: ${meta.training.observationCount.toLocaleString()})`);
  if (args.regimeOnly) console.log(`${YELLOW}Mode: --regime-only (residual feature disabled)${RESET}`);

  // Индекс зон из таблицы
  const zoneIndex = new Map<string, EdgeZone>();
  for (const z of zones) zoneIndex.set(zoneKeyStr(z.key), z);

  // Суммарные наблюдения training по зонам
  let totalTrainObs = 0;
  for (const z of zones) totalTrainObs += z.train.nObservations;

  // Поиск снапшот-файлов
  const files: { path: string; dir: string }[] = [];
  for (const dir of args.dirs) {
    if (!existsSync(dir)) { console.error(`  WARNING: dir not found: ${dir}`); continue; }
    for (const f of readdirSync(dir)) {
      if ((f.endsWith('.jsonl') || f.endsWith('.jsonl.gz')) && f.toLowerCase().includes(args.asset)) {
        files.push({ path: join(dir, f), dir });
      }
    }
  }
  console.log(`\nSnapshot files: ${files.length}  |  dirs: ${args.dirs.length}`);

  // CEX-консенсус
  const dirConsensus = features.residual
    ? buildDirConsensusMap(args.dirs, args.cexCacheDir)
    : new Map<string, CexConsensus | null>();

  // Подсчёт дней с/без CEX
  if (features.residual) {
    let withCex = 0, withoutCex = 0;
    for (const dir of args.dirs) {
      if (dirConsensus.get(dir)) withCex++; else withoutCex++;
    }
    console.log(`CEX cache: ${withCex} days with, ${withoutCex} days without (residual obs dropped for no-CEX days)`);
  }

  // Аккумуляторы OOS
  const oosMap = new Map<string, OosAccum>();
  let totalOosObs = 0;
  let totalOosObsUnmapped = 0;  // наблюдения, не попавшие ни в одну зону таблицы
  let totalOosObsNoCex = 0;     // дропнуты из-за отсутствия CEX
  let filesOk = 0, filesSkipped = 0;

  // Статистика по режимам (для --regime-only и сводки)
  const regimeCounts: Record<string, number> = { up: 0, flat: 0, down: 0 };

  for (const { path, dir } of files) {
    const consensus = dirConsensus.get(dir) ?? null;
    const cexConsensusAt = consensus ? (ts: number) => consensus.consensusAt(ts) : undefined;

    const result = await parseSnapshot(path, meta.bucketing.maxTau ?? 300, args.token, true, undefined, cexConsensusAt);
    if (!result.data) { filesSkipped++; continue; }
    filesOk++;

    const { data } = result;
    const resolution = data.resolution;

    const seenInZone = new Set<string>();  // для подсчёта nMarkets per zone

    for (const obs of data.observations) {
      // Статистика по режиму (всегда)
      const regime = classifyRegime(obs.trendSlope, meta.bucketing.regimeThreshold);
      regimeCounts[regime] = (regimeCounts[regime] ?? 0) + 1;

      const key = bucketKey(obs, features, meta.bucketing);
      if (key === null) {
        // residual out-of-range или нет CEX
        if (features.residual && (obs.cexResidualBps === undefined || !Number.isFinite(obs.cexResidualBps))) {
          totalOosObsNoCex++;
        }
        totalOosObsUnmapped++;
        continue;
      }

      if (!oosMap.has(key)) oosMap.set(key, newOosAccum());
      const acc = oosMap.get(key)!;
      acc.nObs++;
      acc.crowdSum += obs.midPriceCents;
      totalOosObs++;

      const marketKey = `${key}::${data.slug}`;
      if (!seenInZone.has(marketKey)) {
        seenInZone.add(marketKey);
        acc.nMarkets++;
        if (resolution === 'UP') acc.nMarketsUp++;
      }

      if (resolution === 'UP') {
        acc.upObs++;
        acc.resolvedObs++;
      } else if (resolution === 'DOWN') {
        acc.downObs++;
        acc.resolvedObs++;
      }
    }
  }

  console.log(`\nParsed: ${filesOk} OK  |  ${filesSkipped} skipped`);
  console.log(`OOS observations total: ${totalOosObs.toLocaleString()}`);
  if (features.residual) {
    console.log(`  Dropped (no CEX or outlier): ${totalOosObsNoCex.toLocaleString()}`);
    console.log(`  Unmapped (out-of-range):     ${totalOosObsUnmapped.toLocaleString()}`);
  }

  // ── Режим-распределение ────────────────────────────────────────────────────

  const totalRegimeObs = regimeCounts.up + regimeCounts.flat + regimeCounts.down;

  // Считаем training regime-распределение из таблицы (суммируем nObs по режимам)
  const trainRegimeCounts: Record<string, number> = { up: 0, flat: 0, down: 0 };
  for (const z of zones) {
    const r = z.key.regime;
    trainRegimeCounts[r] = (trainRegimeCounts[r] ?? 0) + z.train.nObservations;
  }
  const totalTrainRegimeObs = Object.values(trainRegimeCounts).reduce((s, v) => s + v, 0);

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`${BOLD}REGIME DISTRIBUTION (all OOS dates)${RESET}`);
  console.log(`${'─'.repeat(70)}`);
  console.log(`${'Regime'.padEnd(8)} ${'Train freq'.padStart(12)} ${'OOS freq'.padStart(12)} ${'Deviation'.padStart(12)}`);
  console.log(`${'─'.repeat(8)} ${'─'.repeat(12)} ${'─'.repeat(12)} ${'─'.repeat(12)}`);

  for (const regime of ['up', 'flat', 'down'] as const) {
    const trainFreq = totalTrainRegimeObs > 0 ? (trainRegimeCounts[regime] ?? 0) / totalTrainRegimeObs : 0;
    const oosFreq   = totalRegimeObs > 0      ? (regimeCounts[regime] ?? 0) / totalRegimeObs           : 0;
    const dev       = trainFreq > 0 ? (oosFreq - trainFreq) / trainFreq : 0;
    const devStr    = colorDev(`${pctSgn(dev)}`, dev);
    console.log(`${regime.padEnd(8)} ${pct(trainFreq).padStart(12)} ${pct(oosFreq).padStart(12)} ${devStr.padStart(22)}`);
  }

  if (args.regimeOnly) {
    printSummary(zones, oosMap, zoneIndex, totalTrainObs, totalOosObs, args);
    return;
  }

  // ── Зонный анализ ─────────────────────────────────────────────────────────

  console.log(`\n${'─'.repeat(90)}`);
  console.log(`${BOLD}ZONE DISTRIBUTION & WIN-RATE SHIFT${RESET}`);
  console.log(`${'─'.repeat(90)}`);

  // ── Таблица 1: Crowd смещение (главный вопрос) ────────────────────────────
  console.log(`\n${BOLD}CROWD PRICE SHIFT (толпа переоценивает/недооценивает?)${RESET}`);
  console.log(`${'─'.repeat(80)}`);
  const cw = [20, 8, 14, 14, 12, 14, 14, 10];
  const ch = ['Zone', 'Signal', 'Train crowd¢', 'OOS crowd¢', 'Diff¢', 'Train pHat', 'OOS pHat', 'pHat dev'];
  console.log(ch.map((h, i) => h.padStart(cw[i])).join(' '));
  console.log(ch.map((_, i) => '─'.repeat(cw[i])).join(' '));

  for (const zone of zones) {
    const keyStr = zoneKeyStr(zone.key);
    const oos    = oosMap.get(keyStr);

    const trainCrowd = zone.train.crowdAvg * 100;  // в центах
    const oosCrowd   = oos && oos.nObs > 0 ? (oos.crowdSum / oos.nObs) : null;  // в центах (midPriceCents)
    const crowdDiff  = oosCrowd !== null ? oosCrowd - trainCrowd : null;

    const trainPhat = zone.train.pHat;
    const oosPhat   = oos && oos.resolvedObs > 0 ? oos.upObs / oos.resolvedObs : null;
    const phatDiff  = oosPhat !== null ? oosPhat - trainPhat : null;

    const zoneLabel = `${zone.key.regime} r${zone.key.residual >= 0 ? '+' : ''}${zone.key.residual}`;

    const crowdDiffStr = crowdDiff !== null
      ? colorDev(`${crowdDiff >= 0 ? '+' : ''}${crowdDiff.toFixed(1)}¢`, crowdDiff / 10)
      : '—';
    const phatStr     = oosPhat !== null ? pct(oosPhat) : '—';
    const phatDiffStr = phatDiff !== null ? colorPhat(pctSgn(phatDiff), phatDiff) : '—';

    console.log([
      zoneLabel.padStart(cw[0]),
      zone.signal.padStart(cw[1]),
      `${trainCrowd.toFixed(1)}¢`.padStart(cw[2]),
      oosCrowd !== null ? `${oosCrowd.toFixed(1)}¢`.padStart(cw[3]) : '—'.padStart(cw[3]),
      crowdDiffStr.padStart(cw[4] + (crowdDiff !== null ? 10 : 0)),
      pct(trainPhat).padStart(cw[5]),
      phatStr.padStart(cw[6]),
      phatDiffStr.padStart(cw[7] + (phatDiff !== null ? 10 : 0)),
    ].join(' '));
  }

  // ── Сводка по crowd смещению ───────────────────────────────────────────────
  {
    let crowdBias = 0, nBias = 0;
    for (const zone of zones) {
      const keyStr = zoneKeyStr(zone.key);
      const oos    = oosMap.get(keyStr);
      if (!oos || oos.nObs === 0) continue;
      crowdBias += (oos.crowdSum / oos.nObs) - zone.train.crowdAvg * 100;
      nBias++;
    }
    const avgBias = nBias > 0 ? crowdBias / nBias : 0;
    const biasDir = avgBias > 0 ? 'ПЕРЕОЦЕНИВАЕТ' : 'НЕДООЦЕНИВАЕТ';
    const biasColor = Math.abs(avgBias) >= 3 ? RED : Math.abs(avgBias) >= 1 ? YELLOW : GREEN;
    console.log(`\nСредний crowd-bias по зонам: ${biasColor}${BOLD}${avgBias >= 0 ? '+' : ''}${avgBias.toFixed(2)}¢ (${biasDir})${RESET}`);
  }

  // ── Таблица 2: Частота зон (структурный анализ) ────────────────────────────
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`${BOLD}ZONE FREQUENCY SHIFT (структурный сдвиг рынка)${RESET}`);
  console.log(`${'─'.repeat(80)}`);
  const colW = [20, 10, 12, 12, 14];
  const headers = ['Zone', 'Signal', 'Train freq', 'OOS freq', 'Freq dev'];
  console.log(headers.map((h, i) => h.padStart(colW[i])).join(' '));
  console.log(headers.map((_, i) => '─'.repeat(colW[i])).join(' '));

  let nDeviating = 0;
  let nZonesWithOosData = 0;

  for (const zone of zones) {
    const keyStr = zoneKeyStr(zone.key);
    const oos    = oosMap.get(keyStr);
    const trainFreq = totalTrainObs > 0 ? zone.train.nObservations / totalTrainObs : 0;
    const oosFreq   = totalOosObs > 0 && oos ? oos.nObs / totalOosObs : 0;
    const freqDev   = trainFreq > 0 ? (oosFreq - trainFreq) / trainFreq : 0;

    const zoneLabel   = `${zone.key.regime} r${zone.key.residual >= 0 ? '+' : ''}${zone.key.residual}`;
    const freqDevStr  = colorDev(pctSgn(freqDev).padStart(8), freqDev);

    if (Math.abs(freqDev) >= args.threshold) nDeviating++;
    if (oos && oos.nObs > 0) nZonesWithOosData++;

    console.log([
      zoneLabel.padStart(colW[0]),
      zone.signal.padStart(colW[1]),
      pct(trainFreq).padStart(colW[2]),
      oosFreq > 0 ? pct(oosFreq).padStart(colW[3]) : '—'.padStart(colW[3]),
      freqDevStr,
    ].join(' '));

    if (args.verbose && oos) {
      console.log(`  ${DIM}nObs=${oos.nObs} resolvedObs=${oos.resolvedObs}${RESET}`);
    }
  }

  // Зоны в OOS, которых НЕТ в таблице (новые структурные паттерны)
  const unknownZones: Array<{ keyStr: string; oos: OosAccum }> = [];
  for (const [keyStr, oos] of oosMap) {
    if (!zoneIndex.has(keyStr)) unknownZones.push({ keyStr, oos });
  }

  if (unknownZones.length > 0) {
    console.log(`\n${YELLOW}UNKNOWN ZONES (in OOS but not in training table):${RESET}`);
    for (const { keyStr, oos } of unknownZones.sort((a, b) => b.oos.nObs - a.oos.nObs).slice(0, 10)) {
      const parsed = JSON.parse(keyStr);
      const label  = `regime=${parsed[3]} resid=${parsed[4] >= 0 ? '+' : ''}${parsed[4]}`;
      const share  = totalOosObs > 0 ? oos.nObs / totalOosObs : 0;
      console.log(`  ${label.padEnd(24)} nObs=${oos.nObs.toLocaleString().padStart(8)}  freq=${pct(share)}`);
    }
    const unknownObs = unknownZones.reduce((s, z) => s + z.oos.nObs, 0);
    const unknownShare = totalOosObs > 0 ? unknownObs / totalOosObs : 0;
    console.log(`  Total unknown obs: ${unknownObs.toLocaleString()}  (${pct(unknownShare)} of OOS)`);
  }

  printSummary(zones, oosMap, zoneIndex, totalTrainObs, totalOosObs, args);
}

/**
 * Выводит итоговый Health Score.
 */
function printSummary(
  zones: EdgeZone[],
  oosMap: Map<string, OosAccum>,
  zoneIndex: Map<string, EdgeZone>,
  totalTrainObs: number,
  totalOosObs: number,
  args: Args,
): void {
  let nDeviating = 0;
  let nWithData  = 0;
  let totalFreqDev = 0;
  let totalPhatDiff = 0;
  let nWithPhat = 0;

  for (const zone of zones) {
    const keyStr  = JSON.stringify([zone.key.delta, zone.key.tau, zone.key.crowd, zone.key.regime, zone.key.residual]);
    const oos     = oosMap.get(keyStr);
    const trainFreq = totalTrainObs > 0 ? zone.train.nObservations / totalTrainObs : 0;
    const oosFreq   = totalOosObs > 0 && oos ? oos.nObs / totalOosObs : 0;
    const freqDev   = trainFreq > 0 ? (oosFreq - trainFreq) / trainFreq : 0;

    if (oos && oos.nObs > 0) {
      nWithData++;
      totalFreqDev += Math.abs(freqDev);
      if (Math.abs(freqDev) >= args.threshold) nDeviating++;
      if (oos.resolvedObs > 0) {
        const oosPhat = oos.upObs / oos.resolvedObs;
        totalPhatDiff += oosPhat - zone.train.pHat;
        nWithPhat++;
      }
    }
  }

  const avgFreqDev  = nWithData > 0 ? totalFreqDev / nWithData : 0;
  const avgPhatDiff = nWithPhat > 0 ? totalPhatDiff / nWithPhat : null;
  const healthScore = 1 - Math.min(1, avgFreqDev);

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`${BOLD}HEALTH SUMMARY${RESET}`);
  console.log(`${'═'.repeat(70)}`);
  console.log(`Zones in table      : ${zones.length}`);
  console.log(`Zones with OOS data : ${nWithData}`);
  console.log(`Zones deviating >${(args.threshold * 100).toFixed(0)}% : ${nDeviating}  (${nWithData > 0 ? ((nDeviating / nWithData) * 100).toFixed(0) : 0}% of those with data)`);
  console.log(`Avg freq deviation  : ${pct(avgFreqDev)}`);
  if (avgPhatDiff !== null) {
    console.log(`Avg pHat drift      : ${colorPhat(pctSgn(avgPhatDiff), avgPhatDiff)}`);
  }

  const healthColor = healthScore >= 0.9 ? GREEN : healthScore >= 0.7 ? YELLOW : RED;
  console.log(`Health score        : ${healthColor}${BOLD}${(healthScore * 100).toFixed(1)}%${RESET}  (100% = no freq shift)`);
  console.log(`${'═'.repeat(70)}\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
