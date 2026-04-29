/**
 * Генератор калибровочной edge-таблицы для CalibratedCrowdStrategy.
 *
 * @remarks
 * Строит JSON со статистикой по ячейкам `(delta, tau, crowd, regime)`:
 *   - `n`, `upCount` — effective sample и доля UP-исходов на экспирации
 *     (по умолчанию market-weighted: один market-zone даёт один голос);
 *   - Wilson 95% CI для истинной вероятности;
 *   - OOS edge по temporal holdout-периоду;
 *   - композитный `weight ∈ [0..1]` для Kelly-сайзинга;
 *   - Kelly-фракция (с нижней границей CI, fractional).
 *
 * Поверх этого — симуляция exit-политик на holdout: baseline hold-to-expiry,
 * + regime-flip, + weight-drop, + edge-closure. Результат PnL записывается
 * в отдельный JSON рядом с таблицей.
 *
 * @example
 * ```bash
 * npx tsx scripts/build-edge-table.ts \
 *   --snapshots /path/to/snapshots/2026-03-21,/path/to/snapshots/2026-03-22,... \
 *   --train-until 2026-04-17 \
 *   --asset bitcoin --token up \
 *   --out tables/edge-table-5min.json
 * ```
 */

/* eslint-disable no-console */
import { readdirSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import {
  parseSnapshot, classifyRegime,
  type Observation, type MarketData, type Regime,
} from './analyze-crowd-calibration';

// ── Параметры бакетизации ─────────────────────────────────────────────────────

/** Шаг бакета delta в $ (delta = Chainlink − strike). */
const DELTA_STEP = 25;
/** Шаг бакета tau в секундах. */
const TAU_STEP = 30;
/** Шаг бакета crowd в центах (10¢). */
const CROWD_STEP = 10;
/** Порог классификации regime ($/min за 60s). */
const REGIME_THRESHOLD = 10;
/** Максимум delta по модулю ($). */
const MAX_DELTA = 200;
/** Максимум tau (сек). За пределами — наблюдение не участвует. */
const MAX_TAU = 300;

// ── Гейты для включения ячейки в таблицу ──────────────────────────────────────

/** Дефолтный минимум effective samples в train-ячейке, чтобы она попала в таблицу. */
const DEFAULT_MIN_N = 20;
/** Минимальный CI-edge (pLow − crowd) для включения в торгуемые зоны, д.ед. */
const MIN_CI_EDGE = 0.02;
/** Минимальный empirical edge (p_hat − crowd) для торговли. */
const MIN_EDGE = 0.03;
/** Размер фракционного Kelly (0.25 = quarter-Kelly). */
const FRAC_KELLY = 0.25;

// ── Типы таблицы ──────────────────────────────────────────────────────────────

interface ZoneKey {
  delta:  number;
  tau:    number;
  crowd:  number;
  regime: Regime;
}

interface ZoneStats {
  /** Effective sample size (число заполненных рынков в зоне при fill-sim, иначе market-zone rows). */
  n:          number;
  /** Кол-во UP в effective sample. */
  upCount:    number;
  /** Уникальные рынки в ячейке (все попытки входа, до фильтра по fills). */
  nMarkets:   number;
  /** Уникальные UP-рынки в ячейке. */
  upMarkets:  number;
  /** Raw observations/ticks в ячейке. */
  nObservations:  number;
  /** Raw UP observations/ticks в ячейке. */
  upObservations: number;
  /** Сколько raw observations в среднем приходится на один effective sample. */
  obsPerSample:   number;
  /** Средняя entry-цена (bestBid+1 на filled / или crowd-avg в legacy), д.ед. (0..1). */
  crowdAvg:   number;
  /** Empirical P(UP | filled), д.ед. */
  pHat:       number;
  /** Wilson 95% нижняя граница. */
  pLow:       number;
  /** Wilson 95% верхняя граница. */
  pHigh:      number;
  /** p_hat − crowdAvg. */
  edge:       number;
  /** Средний spread в центах (для диагностики). */
  spreadAvg:  number;
  /** Доля попыток, закончившихся реальным filled (fills / attempts). */
  fillRate:   number;
  /** Всего попыток (market-weighted). */
  attempts:   number;
}

interface ZoneOos {
  n:      number;
  nMarkets:      number;
  nObservations: number;
  pHat:   number;
  edge:   number;
  passes: boolean;
  /** Доля попыток, закончившихся filled. */
  fillRate: number;
  /** Всего попыток на OOS-периоде. */
  attempts: number;
}

interface ZoneWeights {
  /** min(1, n/200). */
  nWeight:      number;
  /** (pLow − c) / max(ε, edge). */
  ciWeight:     number;
  /** min(1, oosEdge / trainEdge), 0 если !passes. */
  oosWeight:    number;
  /** Согласованность знаков edge между режимами в той же (delta,tau,crowd). */
  regimeWeight: number;
  /** Произведение компонентов, [0..1]. */
  composite:    number;
}

interface ZoneKelly {
  /** Сторона ставки: UP (p>c) или DOWN (c>p). */
  side: 'UP' | 'DOWN' | 'NONE';
  /** Размер ставки как доля банкролла, fractional × max(0, (pLow−c)/(1−c)). */
  size: number;
}

interface Zone {
  key:     ZoneKey;
  train:   ZoneStats;
  oos:     ZoneOos | null;
  weights: ZoneWeights;
  kelly:   ZoneKelly;
  signal:  'BUY' | 'SELL' | 'SKIP';
}

// ── Утилиты статистики ────────────────────────────────────────────────────────

/**
 * Wilson 95% CI для биномиальной пропорции.
 *
 * @remarks
 * Более аккуратный, чем нормальное приближение, особенно при p близко к 0/1
 * или малых `n`. Используется вместо naive stderr.
 */
function wilsonCi(upCount: number, n: number): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 };
  const z = 1.96; // 95%
  const p = upCount / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const margin = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / denom;
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}

/** Округление до шага вниз (`toBucket(47, 10) = 40`). */
function toBucket(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

/** Строковый ключ для Map по ZoneKey. */
function zoneKeyStr(k: ZoneKey): string {
  return `${k.delta}:${k.tau}:${k.crowd}:${k.regime}`;
}

// ── Аккумулятор ───────────────────────────────────────────────────────────────

interface Accum {
  /** В fill-sim режиме — count filled markets; в legacy — market-zone rows (markets) или ticks (observations). */
  n:            number;
  upCount:      number;
  crowdSum:     number;
  spreadSum:    number;
  nMarkets:     number;
  upMarkets:    number;
  nObservations:  number;
  upObservations: number;
  marketIds:      Set<string>;
  /** Fill-sim: число попыток (всех рынков что зашли в зону). */
  attempts:     number;
  /** Fill-sim: сумма entryPrice (в долях, 0..1) по филлам. */
  entrySum:     number;
}

interface MarketZoneSample {
  crowdSum:  number;
  spreadSum: number;
  obsCount:  number;
  /** Самая ранняя попытка входа в зоне: entry-price и filled/no-fill. */
  firstEntryBidCents:  number;
  firstEntryFilled:    boolean;
}

function newAccum(): Accum {
  return {
    n: 0, upCount: 0, crowdSum: 0, spreadSum: 0,
    nMarkets: 0, upMarkets: 0,
    nObservations: 0, upObservations: 0,
    marketIds: new Set(),
    attempts: 0, entrySum: 0,
  };
}

type CountBy = 'markets' | 'observations';
type FillMode = 'fill-sim' | 'legacy';

/** Набор активных фичей бакетизации; выключенная фича схлопывается в константу. */
interface FeatureSet {
  delta:  boolean;
  tau:    boolean;
  crowd:  boolean;
  regime: boolean;
}

function parseFeatures(raw: string): FeatureSet {
  const set: FeatureSet = { delta: false, tau: false, crowd: false, regime: false };
  for (const part of raw.split(',').map(s => s.trim().toLowerCase())) {
    if (part === 'delta' || part === 'tau' || part === 'crowd' || part === 'regime') {
      set[part] = true;
    } else if (part !== '') {
      throw new Error(`--features: unknown dimension "${part}"`);
    }
  }
  return set;
}

function bucketKey(o: Observation, f: FeatureSet, dStep = DELTA_STEP, tStep = TAU_STEP): ZoneKey {
  return {
    delta:  f.delta  ? toBucket(o.delta, dStep)               : 0,
    tau:    f.tau    ? toBucket(o.tauSec, tStep)               : 0,
    crowd:  f.crowd  ? toBucket(o.midPriceCents, CROWD_STEP)   : 0,
    regime: f.regime ? classifyRegime(o.trendSlope, REGIME_THRESHOLD) : 'flat',
  };
}

function observeAccum(
  a: Accum,
  marketId: string,
  sample: MarketZoneSample,
  resolution: 'UP' | 'DOWN',
  countBy: CountBy,
  fillMode: FillMode,
): void {
  a.nObservations += sample.obsCount;
  if (resolution === 'UP') a.upObservations += sample.obsCount;

  const alreadySeenMarket = a.marketIds.has(marketId);
  if (!alreadySeenMarket) {
    a.marketIds.add(marketId);
    a.nMarkets++;
    if (resolution === 'UP') a.upMarkets++;
  }

  if (fillMode === 'fill-sim') {
    // Market-weighted fill-sim: одна попытка на (market, zone).
    if (alreadySeenMarket) return;
    a.attempts++;
    a.crowdSum += sample.crowdSum / sample.obsCount;   // для диагностики (средняя mid)
    a.spreadSum += sample.spreadSum / sample.obsCount;
    if (sample.firstEntryFilled) {
      a.n++;
      a.entrySum += sample.firstEntryBidCents / 100;
      if (resolution === 'UP') a.upCount++;
    }
    return;
  }

  if (countBy === 'observations') {
    a.n += sample.obsCount;
    if (resolution === 'UP') a.upCount += sample.obsCount;
    a.crowdSum += sample.crowdSum;
    a.spreadSum += sample.spreadSum;
    return;
  }

  // Legacy market-weighted: one market contributes at most one vote per zone.
  if (alreadySeenMarket) return;
  a.attempts++;
  a.n++;
  if (resolution === 'UP') a.upCount++;
  a.crowdSum += sample.crowdSum / sample.obsCount;
  a.spreadSum += sample.spreadSum / sample.obsCount;
}

/**
 * Симуляция maker-филла: ордер размещён в obs[i] по цене `entryBid = bestBid+1`
 * (или bestBid если спред=1¢). Филл случается, если в каком-то будущем obs[j>i]
 * (в том же рынке) `bestAskCents ≤ entryBid` — книга пересекла нашу цену вниз.
 *
 * @returns filled: true если нашли пересечение до конца рынка; иначе false.
 */
function simulateFillForward(
  obs: Observation[],
  fromIdx: number,
  entryBid: number,
): boolean {
  for (let j = fromIdx + 1; j < obs.length; j++) {
    if (obs[j].bestAskCents <= entryBid) return true;
  }
  return false;
}

function computeEntryBid(o: Observation): number {
  const aggressive = Math.round(o.bestBidCents) + 1;
  const ask = Math.round(o.bestAskCents);
  const bid = aggressive < ask ? aggressive : Math.round(o.bestBidCents);
  return Math.max(1, Math.min(99, bid));
}

function accumulateMarket(
  m: MarketData,
  map: Map<string, Accum>,
  countBy: CountBy,
  fillMode: FillMode,
  features: FeatureSet,
  deltaStep = DELTA_STEP,
  tauStep = TAU_STEP,
): { observations: number; marketZones: number } {
  const perZone = new Map<string, MarketZoneSample>();
  let observations = 0;

  // Наблюдения отсортированы по времени (в порядке чтения snapshot).
  // Для fill-sim нам нужен доступ по индексу.
  const obs = m.observations;

  for (let i = 0; i < obs.length; i++) {
    const o = obs[i];
    if (Math.abs(o.delta) > MAX_DELTA) continue;
    if (o.tauSec > MAX_TAU) continue;
    observations++;
    const key = bucketKey(o, features, deltaStep, tauStep);
    const ks = zoneKeyStr(key);
    let sample = perZone.get(ks);
    if (!sample) {
      // Это первая встреча с зоной для этого рынка — считаем entry-bid и fill.
      const entryBid = computeEntryBid(o);
      const filled = fillMode === 'fill-sim' ? simulateFillForward(obs, i, entryBid) : false;
      sample = {
        crowdSum: 0, spreadSum: 0, obsCount: 0,
        firstEntryBidCents: entryBid,
        firstEntryFilled:   filled,
      };
      perZone.set(ks, sample);
    }
    sample.crowdSum += o.midPriceCents / 100;
    sample.spreadSum += o.spreadCents;
    sample.obsCount++;
  }

  const marketId = m.slug || String(m.endDateMs);
  for (const [ks, sample] of perZone) {
    if (!map.has(ks)) map.set(ks, newAccum());
    observeAccum(map.get(ks)!, marketId, sample, m.resolution, countBy, fillMode);
  }

  return { observations, marketZones: perZone.size };
}

// ── Парсинг аргументов ────────────────────────────────────────────────────────

interface Args {
  dirs:       string[];
  trainUntil: number;   // epoch ms, наблюдения из рынков c endDateMs <= trainUntil — train
  asset:      string;
  token:      'up' | 'down';
  outFile:    string;
  approxRes:  boolean;
  countBy:    CountBy;
  fillMode:   FillMode;
  minN:       number;
  /** Для fill-sim: требовать прошедший OOS (дропать зоны без oos.passes). */
  strictOos:  boolean;
  looseCi:    boolean;
  features:   FeatureSet;
  deltaStep:  number;
  tauStep:    number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = {
    dirs:       [],
    trainUntil: 0,
    asset:      'bitcoin',
    token:      'up',
    outFile:    '',
    approxRes:  true,
    countBy:    'markets',
    fillMode:   'fill-sim',
    minN:       DEFAULT_MIN_N,
    strictOos:  false,
    looseCi:    false,
    features:   { delta: true, tau: true, crowd: true, regime: true },
    deltaStep:  DELTA_STEP,
    tauStep:    TAU_STEP,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if      (a === '--snapshots')  args.dirs       = argv[++i].split(',');
    else if (a === '--train-until') args.trainUntil = new Date(argv[++i]).getTime();
    else if (a === '--asset')      args.asset      = argv[++i].toLowerCase();
    else if (a === '--token')      args.token      = argv[++i] as 'up' | 'down';
    else if (a === '--out')        args.outFile    = argv[++i];
    else if (a === '--no-approx-resolution') args.approxRes = false;
    else if (a === '--min-n')      args.minN       = Number(argv[++i]);
    else if (a === '--legacy-fill') args.fillMode = 'legacy';
    else if (a === '--strict-oos') args.strictOos = true;
    else if (a === '--loose-ci')   args.looseCi = true;
    else if (a === '--features')   args.features = parseFeatures(argv[++i]);
    else if (a === '--delta-step') args.deltaStep = Number(argv[++i]);
    else if (a === '--tau-step')   args.tauStep   = Number(argv[++i]);
    else if (a === '--count-by') {
      const v = argv[++i];
      if (v !== 'markets' && v !== 'observations') {
        throw new Error(`--count-by: expected markets|observations, got ${v}`);
      }
      args.countBy = v;
    }
  }
  if (!args.dirs.length || !args.trainUntil || !args.outFile) {
    console.error(
      'Usage: npx tsx scripts/build-edge-table.ts \\\n' +
      '  --snapshots dir1,dir2,... \\\n' +
      '  --train-until YYYY-MM-DD \\\n' +
      '  --asset bitcoin --token up \\\n' +
      '  --out tables/edge-table-5min.json \\\n' +
      '  [--min-n 20] \\\n' +
      '  [--count-by markets|observations] \\\n' +
      '  [--no-approx-resolution]',
    );
    process.exit(1);
  }
  if (args.fillMode === 'fill-sim' && args.countBy === 'observations') {
    throw new Error('--count-by observations несовместим с fill-sim: fill-sim всегда считает effective sample по market-zone attempts/fills. Используй --legacy-fill для observation-weighted режима.');
  }
  return args;
}

// ── Симуляция exit-политик ────────────────────────────────────────────────────

/**
 * Политика выхода из позиции для бэктеста.
 *
 * - `hold` — держим до экспирации (baseline, матчит edge в таблице).
 * - `risk` — выходим по regime-flip, weight-drop, tau-timeout (без edge-closure).
 * - `full` — всё вышеперечисленное + edge-closure.
 */
type ExitPolicy = 'hold' | 'risk' | 'full';

interface SimResult {
  policy:           ExitPolicy;
  trades:           number;
  winRate:          number;
  avgPnLPerTrade:   number;   // в долях ставки (относительно stake)
  totalPnL:         number;   // суммарный PnL если ставка = 1
  maxDrawdown:      number;
}

interface TradeLog {
  slug:         string;
  side:         'UP' | 'DOWN';
  entryCrowd:   number;
  exitCrowd:    number | null;   // null если holds-to-expiry
  resolution:   'UP' | 'DOWN';
  stake:        number;           // = weight × kelly_size
  pnl:          number;           // per-unit stake
  exitReason:   string;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  const files: string[] = [];
  for (const dir of args.dirs) {
    for (const f of readdirSync(dir)) {
      if ((f.endsWith('.jsonl') || f.endsWith('.jsonl.gz')) && f.toLowerCase().includes(args.asset)) {
        files.push(join(dir, f));
      }
    }
  }
  const featsStr = (Object.entries(args.features) as [keyof FeatureSet, boolean][]).filter(([,v])=>v).map(([k])=>k).join('+');
  console.error(`Found ${files.length} files  |  train-until ${new Date(args.trainUntil).toISOString()}  |  token ${args.token}  |  count-by ${args.countBy}  |  fill-mode ${args.fillMode}  |  strict-oos ${args.strictOos}  |  features ${featsStr}  |  min-n ${args.minN}`);

  // ── Парсинг всех файлов ────────────────────────────────────────────────────
  const trainMarkets: MarketData[] = [];
  const testMarkets:  MarketData[] = [];
  let parsed = 0, skipped = 0;
  for (const file of files) {
    const r = await parseSnapshot(file, MAX_TAU, args.token, args.approxRes);
    if (!r.data) { skipped++; continue; }
    const m = r.data;
    if (m.duration !== '5min') { skipped++; continue; }
    (m.endDateMs <= args.trainUntil ? trainMarkets : testMarkets).push(m);
    parsed++;
    if (parsed % 100 === 0) console.error(`  parsed ${parsed}/${files.length}...`);
  }
  console.error(`parsed: ${parsed}  skipped: ${skipped}  train: ${trainMarkets.length}  test: ${testMarkets.length}`);

  // ── Аккумуляция train по ячейкам ───────────────────────────────────────────
  const trainMap = new Map<string, Accum>();
  let trainObsUsed = 0, trainMarketZones = 0;
  for (const m of trainMarkets) {
    const r = accumulateMarket(m, trainMap, args.countBy, args.fillMode, args.features, args.deltaStep, args.tauStep);
    trainObsUsed += r.observations;
    trainMarketZones += r.marketZones;
  }

  // ── Аккумуляция test (holdout) ─────────────────────────────────────────────
  const testMap = new Map<string, Accum>();
  let testObsUsed = 0, testMarketZones = 0;
  for (const m of testMarkets) {
    const r = accumulateMarket(m, testMap, args.countBy, args.fillMode, args.features, args.deltaStep, args.tauStep);
    testObsUsed += r.observations;
    testMarketZones += r.marketZones;
  }
  console.error(`samples: train effective=${[...trainMap.values()].reduce((s, a) => s + a.n, 0)} market-zones=${trainMarketZones} obs=${trainObsUsed}`);
  console.error(`         test  effective=${[...testMap.values()].reduce((s, a) => s + a.n, 0)} market-zones=${testMarketZones} obs=${testObsUsed}`);

  // ── Построение зон + веса ──────────────────────────────────────────────────
  const zones: Zone[] = [];
  // Для regime-weight: по каждой (delta,tau,crowd) соберём знаки edge по 3 режимам.
  const signIndex = new Map<string, Map<Regime, number>>();
  // Для fill-sim: crowdAvg = средний entry-bid по филлам (сигнал реальной цены входа).
  // Для legacy: crowdAvg = средняя mid-цена (что было раньше).
  const avgEntryOrMid = (acc: Accum): number =>
    args.fillMode === 'fill-sim'
      ? (acc.n > 0 ? acc.entrySum / acc.n : 0)
      : (acc.attempts > 0 ? acc.crowdSum / acc.attempts : 0);

  for (const [ks, acc] of trainMap) {
    if (acc.n < args.minN) continue;
    const [dS, tS, cS, rS] = ks.split(':');
    const dtcKey = `${dS}:${tS}:${cS}`;
    const regime = rS as Regime;
    const p = acc.upCount / acc.n;
    const c = avgEntryOrMid(acc);
    const edge = p - c;
    if (!signIndex.has(dtcKey)) signIndex.set(dtcKey, new Map());
    signIndex.get(dtcKey)!.set(regime, edge);
  }

  for (const [ks, acc] of trainMap) {
    if (acc.n < args.minN) continue;

    const [dS, tS, cS, rS] = ks.split(':');
    const key: ZoneKey = { delta: Number(dS), tau: Number(tS), crowd: Number(cS), regime: rS as Regime };

    const pHat    = acc.upCount / acc.n;
    const { low: pLow, high: pHigh } = wilsonCi(acc.upCount, acc.n);
    const crowdAvg = avgEntryOrMid(acc);
    const edge = pHat - crowdAvg;
    const fillRate = acc.attempts > 0 ? acc.n / acc.attempts : 0;

    const train: ZoneStats = {
      n: acc.n, upCount: acc.upCount,
      nMarkets: acc.nMarkets, upMarkets: acc.upMarkets,
      nObservations: acc.nObservations, upObservations: acc.upObservations,
      obsPerSample: acc.n > 0 ? acc.nObservations / acc.n : 0,
      crowdAvg,
      pHat, pLow, pHigh, edge,
      spreadAvg: acc.attempts > 0 ? acc.spreadSum / acc.attempts : 0,
      fillRate,
      attempts: acc.attempts,
    };

    // OOS
    const testAcc = testMap.get(ks);
    let oos: ZoneOos | null = null;
    if (testAcc && testAcc.n >= 10) {
      const oosPHat = testAcc.upCount / testAcc.n;
      const oosCrowd = avgEntryOrMid(testAcc);
      const oosEdge = oosPHat - oosCrowd;
      // Проходит, если знак совпал И |oosEdge| >= 50% от train edge.
      const passes = Math.sign(edge) === Math.sign(oosEdge) && Math.abs(oosEdge) >= Math.abs(edge) * 0.5;
      oos = {
        n: testAcc.n,
        nMarkets: testAcc.nMarkets,
        nObservations: testAcc.nObservations,
        pHat: oosPHat,
        edge: oosEdge,
        passes,
        fillRate: testAcc.attempts > 0 ? testAcc.n / testAcc.attempts : 0,
        attempts: testAcc.attempts,
      };
    }

    // Weights
    const nWeight  = Math.min(1, acc.n / 200);
    const ciEdge   = (edge >= 0 ? pLow : pHigh) - crowdAvg; // для UP — нижняя, для SELL — верхняя
    const ciWeight = Math.max(0, Math.min(1,
      Math.abs(ciEdge) / Math.max(1e-6, Math.abs(edge)),
    ));
    // strict-OOS: дропаем зоны без подтверждения (oos=null или !oos.passes) в 0.
    // Иначе — старое поведение (0.5 fallback для отсутствующего OOS).
    const oosWeight = oos
      ? (oos.passes ? Math.min(1, Math.abs(oos.edge) / Math.max(1e-6, Math.abs(edge))) : 0)
      : (args.strictOos ? 0 : 0.5);

    // regimeWeight смысл имеет только если regime активен как фича.
    let regimeWeight = 1;
    if (args.features.regime) {
      const dtcKey = `${key.delta}:${key.tau}:${key.crowd}`;
      const regimes = signIndex.get(dtcKey)!;
      const signs = [...regimes.values()].map(e => Math.sign(e));
      regimeWeight =
        signs.length < 2 ? 0.7 :
        (signs.every(s => s === signs[0]) ? 1 : 0.4);
    }

    const composite = nWeight * ciWeight * oosWeight * regimeWeight;

    const weights: ZoneWeights = { nWeight, ciWeight, oosWeight, regimeWeight, composite };

    // Kelly
    let side: ZoneKelly['side'] = 'NONE';
    let size = 0;
    // CI-gate: в strict-режиме (по умолчанию) требуем pLow>=entry+MIN_CI_EDGE.
    // В --loose-ci — требуем только edge≥MIN_EDGE и (опционально) oos.passes.
    const looseCi = args.looseCi;
    const upOk = edge >= MIN_EDGE && (looseCi || (pLow - crowdAvg) >= MIN_CI_EDGE);
    const downOk = -edge >= MIN_EDGE && (looseCi || (crowdAvg - pHigh) >= MIN_CI_EDGE);
    if (upOk) {
      side = 'UP';
      const kellyEdge = looseCi ? edge : (pLow - crowdAvg);
      size = FRAC_KELLY * Math.max(0, kellyEdge / (1 - crowdAvg));
    } else if (downOk) {
      side = 'DOWN';
      const kellyEdge = looseCi ? -edge : (crowdAvg - pHigh);
      size = FRAC_KELLY * Math.max(0, kellyEdge / crowdAvg);
    }
    const kelly: ZoneKelly = { side, size: size * composite };

    const signal: Zone['signal'] = side === 'NONE' || composite < 0.1 ? 'SKIP' :
      side === 'UP' ? 'BUY' : 'SELL';

    zones.push({ key, train, oos, weights, kelly, signal });
  }

  // ── Симуляция exit-политик на test-периоде ─────────────────────────────────
  // Для каждой политики: идём по test-рынкам в хрон. порядке, для первой «пригодной»
  // точки делаем вход, далее отслеживаем exit по политике. PnL считаем относительно
  // stake=1 (размер = kelly.size × weight.composite заложен в size, но для сравнения
  // политик берём stake=1, т.е. смотрим «per-unit edge»).
  const zoneLookup = new Map<string, Zone>();
  for (const z of zones) zoneLookup.set(zoneKeyStr(z.key), z);

  function simulate(policy: ExitPolicy): { result: SimResult; trades: TradeLog[] } {
    const logs: TradeLog[] = [];
    let equity = 0;
    let peak = 0, mdd = 0;
    let wins = 0;

    for (const m of testMarkets) {
      // Сортируем наблюдения по tau убывающе (т.е. по времени возрастающе).
      const obs = [...m.observations].sort((a, b) => b.tauSec - a.tauSec);

      let entered = false;
      let entryKs = '';
      let entryCrowd = 0;
      let entryZone: Zone | null = null;
      let exitCrowd: number | null = null;
      let exitReason = 'expiry';

      for (let i = 0; i < obs.length; i++) {
        const o = obs[i];
        if (Math.abs(o.delta) > MAX_DELTA) continue;
        if (o.tauSec > MAX_TAU) continue;

        const ks = zoneKeyStr(bucketKey(o, args.features, args.deltaStep, args.tauStep));
        const z = zoneLookup.get(ks);

        if (!entered) {
          if (z && z.signal !== 'SKIP' && z.kelly.side !== 'NONE') {
            // Fill-sim: вход происходит ТОЛЬКО если maker-ордер реально зафилился.
            if (args.fillMode === 'fill-sim') {
              const entryBid = computeEntryBid(o);
              const filled = simulateFillForward(obs, i, entryBid);
              if (!filled) continue;
              entryCrowd = entryBid / 100;
            } else {
              entryCrowd = o.midPriceCents / 100;
            }
            entered = true;
            entryKs = ks;
            entryZone = z;
          }
          continue;
        }

        // В позиции: проверяем exit по политике.
        if (policy === 'hold') continue;

        const cNow = o.midPriceCents / 100;

        // tau-timeout (везде кроме hold).
        if (o.tauSec < 15) {
          exitCrowd = cNow; exitReason = 'tau-timeout'; break;
        }

        // weight-drop: текущая ячейка имеет composite < порог.
        if (z && z.weights.composite < 0.1) {
          exitCrowd = cNow; exitReason = 'weight-drop'; break;
        }

        // regime-flip: знак edge в текущем режиме противоположен входу.
        if (z && entryZone && Math.sign(z.train.edge) !== Math.sign(entryZone.train.edge)) {
          exitCrowd = cNow; exitReason = 'regime-flip'; break;
        }

        if (policy === 'full') {
          // edge-closure: edge на текущей крауд-точке <= 1.5¢.
          if (entryZone && entryZone.kelly.side === 'UP') {
            const curEdge = (z?.train.pHat ?? cNow) - cNow;
            if (curEdge <= 0.015) { exitCrowd = cNow; exitReason = 'edge-close'; break; }
          } else if (entryZone && entryZone.kelly.side === 'DOWN') {
            const curEdge = cNow - (z?.train.pHat ?? cNow);
            if (curEdge <= 0.015) { exitCrowd = cNow; exitReason = 'edge-close'; break; }
          }
        }
      }

      if (!entered || !entryZone) continue;

      // PnL: если exitCrowd задан — реализуем разницу; иначе — держим до resolution.
      const side = entryZone.kelly.side;
      let pnl: number;
      if (exitCrowd !== null) {
        // Продаём по текущей крауд-цене.
        pnl = side === 'UP' ? (exitCrowd - entryCrowd) / entryCrowd
                            : (entryCrowd - exitCrowd) / (1 - entryCrowd);
      } else {
        // Hold до экспирации.
        const payoff = side === 'UP' ? (m.resolution === 'UP' ? 1 : 0) : (m.resolution === 'DOWN' ? 1 : 0);
        const cost   = side === 'UP' ? entryCrowd : (1 - entryCrowd);
        pnl = (payoff - cost) / cost;
      }

      const stake = 1; // для сравнения политик — per-unit
      equity += pnl * stake;
      peak = Math.max(peak, equity);
      mdd  = Math.max(mdd, peak - equity);
      if (pnl > 0) wins++;

      logs.push({
        slug:       m.slug,
        side:       side as 'UP' | 'DOWN',
        entryCrowd, exitCrowd,
        resolution: m.resolution,
        stake,
        pnl,
        exitReason,
      });

      void entryKs; // сохраняем в лог для будущих анализов
    }

    const n = logs.length;
    return {
      result: {
        policy,
        trades:         n,
        winRate:        n > 0 ? wins / n : 0,
        avgPnLPerTrade: n > 0 ? equity / n : 0,
        totalPnL:       equity,
        maxDrawdown:    mdd,
      },
      trades: logs,
    };
  }

  const sim = {
    hold: simulate('hold'),
    risk: simulate('risk'),
    full: simulate('full'),
  };

  // ── Сборка JSON ────────────────────────────────────────────────────────────
  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      duration:    '5min',
      token:       args.token,
      sampleMode:  args.countBy,
      fillMode:    args.fillMode,
      strictOos:   args.strictOos,
      features:    args.features,
      bucketing:   { deltaStep: args.deltaStep, tauStep: args.tauStep, crowdStep: CROWD_STEP, regimeThreshold: REGIME_THRESHOLD, maxDelta: MAX_DELTA, maxTau: MAX_TAU },
      gates:       { minN: args.minN, minEdge: MIN_EDGE, minCiEdge: MIN_CI_EDGE, fracKelly: FRAC_KELLY },
      training:    { marketCount: trainMarkets.length, endDateMaxMs: args.trainUntil, effectiveSamples: [...trainMap.values()].reduce((s, a) => s + a.n, 0), marketZoneSamples: trainMarketZones, observationCount: trainObsUsed },
      validation:  { marketCount: testMarkets.length, method: 'temporal-holdout', effectiveSamples: [...testMap.values()].reduce((s, a) => s + a.n, 0), marketZoneSamples: testMarketZones, observationCount: testObsUsed },
    },
    zones,
    backtest: {
      hold: sim.hold.result,
      risk: sim.risk.result,
      full: sim.full.result,
    },
  };

  const outFile = args.outFile;
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.error(`\nJSON written: ${outFile}`);

  // Пишем trade-logs рядом для глубокой отладки.
  const tradesFile = outFile.replace(/\.json$/, '-trades.json');
  writeFileSync(tradesFile, JSON.stringify({
    hold: sim.hold.trades, risk: sim.risk.trades, full: sim.full.trades,
  }, null, 2));
  console.error(`Trades: ${tradesFile}`);

  // ── Сводка ─────────────────────────────────────────────────────────────────
  console.error('');
  console.error(`Zones:          ${zones.length}`);
  console.error(`  BUY signals:  ${zones.filter(z => z.signal === 'BUY').length}`);
  console.error(`  SELL signals: ${zones.filter(z => z.signal === 'SELL').length}`);
  console.error(`  SKIP:         ${zones.filter(z => z.signal === 'SKIP').length}`);
  console.error('');
  console.error(`Backtest on holdout (${testMarkets.length} markets, stake=1):`);
  for (const p of ['hold', 'risk', 'full'] as const) {
    const r = sim[p].result;
    console.error(
      `  ${p.padEnd(5)} trades=${String(r.trades).padEnd(4)} WR=${(r.winRate * 100).toFixed(1)}%  ` +
      `avgPnL=${(r.avgPnLPerTrade * 100).toFixed(2)}%  totalPnL=${r.totalPnL.toFixed(2)}  maxDD=${r.maxDrawdown.toFixed(2)}`,
    );
  }
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
