/**
 * CLI-инструмент для подбора линейных регрессионных моделей (Ridge) предсказания
 * будущей Chainlink-цены BTC по microprice CEX-бирж.
 *
 * @remarks
 * ### Назначение
 * Дополняет `analyzeChainlinkLeadLag.ts`: вместо простой корреляции строит
 * линейные модели (одно-venue, комбо-venue, aggregate) с Ridge-регуляризацией.
 * Используется для:
 * - Получения весов бирж для weighted microprice.
 * - Оценки стабильности коэффициентов по временны́м окнам (out-of-sample).
 * - Выбора оптимального горизонта предсказания.
 *
 * ### Входные данные
 * Те же снапшоты что и в `analyzeChainlinkLeadLag.ts` (через `discoverWindows`).
 *
 * ### Запуск
 * ```bash
 * node src/fitChainlinkLinearModels.ts snapshots/2026-04-08 --horizons 1000,5000
 * ```
 *
 * ### Алгоритм
 * Для каждого временного окна:
 * 1. Строит матрицу признаков (microprice бирж) и вектор таргетов (будущий Chainlink).
 * 2. Вычитает basis (медиана residual) для каждой биржи.
 * 3. Решает Ridge regression: `(X'X + λI)w = X'y`.
 * 4. Оценивает MAE, RMSE, hit-rate на out-of-sample окнах.
 *
 * ### Константа регуляризации
 * `RIDGE_LAMBDA = 1` — умеренная регуляризация предотвращает переобучение на малых выборках.
 */
import {
  ALL_VENUES,
  applyEvent,
  buildFutureIndices,
  buildVenuePredictors,
  createVenueState,
  discoverWindows,
  median,
  parseCexEvents,
  parseChainlinkTicks,
  pruneTrades,
} from './analyzeChainlinkLeadLag.js';
import type { Venue, WindowBundle } from './analyzeChainlinkLeadLag.js';

const DEFAULT_HORIZONS_MS = [1_000, 5_000];
const DEFAULT_VENUE_STALENESS_MS = 2_000;
const DEFAULT_TRADE_LOOKBACK_MS = 1_000;
const DEFAULT_MAX_COMBO_SIZE = 3;
const DEFAULT_MIN_SAMPLES = 1_000;
const DEFAULT_TOP_LIMIT = 10;
const DEFAULT_SYMBOL = 'bitcoin';
const RIDGE_LAMBDA = 1;

interface CliOptions {
  readonly snapshotDir: string;
  readonly symbol: 'bitcoin';
  readonly venues: readonly Venue[];
  readonly horizonsMs: readonly number[];
  readonly venueStalenessMs: number;
  readonly tradeLookbackMs: number;
  readonly maxComboSize: number;
  readonly minSamples: number;
  readonly topLimit: number;
  readonly json: boolean;
}

interface EvaluationRow {
  readonly windowLabel: string;
  readonly ts: number;
  readonly chainlinkNow: number;
  readonly futures: ReadonlyMap<number, number>;
  readonly venues: Partial<Record<Venue, VenueObservation>>;
}

interface VenueObservation {
  readonly micro: number;
  readonly spreadBps: number;
  readonly ageMs: number;
}

interface ModelSpec {
  readonly name: string;
  readonly type: 'single' | 'combo' | 'aggregate';
  readonly featureNames: readonly string[];
  buildFeatures(row: EvaluationRow, basisByVenue: ReadonlyMap<Venue, number>): number[] | null;
}

interface ModelSample {
  readonly windowLabel: string;
  readonly chainlinkNow: number;
  readonly chainlinkFuture: number;
  readonly features: readonly number[];
}

interface ModelCoefficients {
  readonly intercept: number;
  readonly weights: readonly number[];
}

interface WindowMetrics {
  readonly windowLabel: string;
  readonly n: number;
  readonly mae: number;
  readonly rmse: number;
  readonly baselineMae: number;
  readonly baselineRmse: number;
  readonly improvementPct: number;
  readonly hitRate?: number;
  readonly corr?: number;
}

interface SignalCalibrationBucket {
  readonly score: number;
  readonly n: number;
  readonly minAbsPred: number;
  readonly maxAbsPred: number;
  readonly avgAbsPred: number;
  readonly avgAbsTrue: number;
  readonly hitRate?: number;
}

interface FittedModelResult {
  readonly model: string;
  readonly modelType: ModelSpec['type'];
  readonly horizonMs: number;
  readonly featureNames: readonly string[];
  readonly coefficients: ModelCoefficients;
  readonly n: number;
  readonly mae: number;
  readonly rmse: number;
  readonly baselineMae: number;
  readonly baselineRmse: number;
  readonly improvementPct: number;
  readonly hitRate?: number;
  readonly corr?: number;
  readonly windowMetrics: readonly WindowMetrics[];
  readonly signalCalibration: readonly SignalCalibrationBucket[];
}

interface RenderRow {
  readonly model: string;
  readonly horizon: string;
  readonly samples: string;
  readonly mae: string;
  readonly baseline: string;
  readonly improve: string;
  readonly hit: string;
  readonly corr: string;
}

function usage(): string {
  return [
    'Usage:',
    '  node src/fitChainlinkLinearModels.ts <snapshot-dir> [options]',
    '',
    'Options:',
    '  --symbol bitcoin                Symbol family to analyze (default: bitcoin)',
    '  --venues v1,v2                  Venues to include (default: all)',
    '  --horizons 1000,5000            Future Chainlink horizons in ms',
    '  --staleness-ms 2000             Max age of a venue book at evaluation time',
    '  --trade-lookback-ms 1000        Lookback for trade-pressure bookkeeping',
    '  --max-combo-size 3              Max venue subset size for linear combo models',
    '  --min-samples 1000              Minimum samples for leaderboard rows',
    '  --top 10                        Number of leaderboard rows',
    '  --json                          Emit JSON instead of text',
    '',
    'Examples:',
    '  node src/fitChainlinkLinearModels.ts snapshots/2026-04-08',
    '  node src/fitChainlinkLinearModels.ts snapshots/2026-04-08 --horizons 1000,5000 --json',
  ].join('\n');
}

function parseCli(argv: readonly string[]): CliOptions {
  let snapshotDir = '';
  let symbol = DEFAULT_SYMBOL;
  let venues = [...ALL_VENUES] as Venue[];
  let horizonsMs = [...DEFAULT_HORIZONS_MS];
  let venueStalenessMs = DEFAULT_VENUE_STALENESS_MS;
  let tradeLookbackMs = DEFAULT_TRADE_LOOKBACK_MS;
  let maxComboSize = DEFAULT_MAX_COMBO_SIZE;
  let minSamples = DEFAULT_MIN_SAMPLES;
  let topLimit = DEFAULT_TOP_LIMIT;
  let json = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];

    if (!snapshotDir && !arg.startsWith('--')) {
      snapshotDir = arg;
      continue;
    }

    if (arg === '--json') {
      json = true;
      continue;
    }

    const value = argv[index + 1];
    if (!value) {
      throw new Error(`Missing value for ${arg}\n\n${usage()}`);
    }

    switch (arg) {
      case '--symbol':
        symbol = value.trim().toLowerCase();
        break;
      case '--venues':
        venues = value
          .split(',')
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean)
          .map(assertVenue);
        break;
      case '--horizons':
        horizonsMs = value
          .split(',')
          .map((item) => Number(item.trim()))
          .filter((item) => Number.isFinite(item) && item > 0)
          .sort((left, right) => left - right);
        break;
      case '--staleness-ms':
        venueStalenessMs = parsePositiveInteger(value, arg);
        break;
      case '--trade-lookback-ms':
        tradeLookbackMs = parsePositiveInteger(value, arg);
        break;
      case '--max-combo-size':
        maxComboSize = parsePositiveInteger(value, arg);
        break;
      case '--min-samples':
        minSamples = parsePositiveInteger(value, arg);
        break;
      case '--top':
        topLimit = parsePositiveInteger(value, arg);
        break;
      default:
        throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }

    index++;
  }

  if (!snapshotDir) {
    throw new Error(usage());
  }

  if (symbol !== 'bitcoin') {
    throw new Error(`Unsupported symbol '${symbol}'. Only 'bitcoin' is supported right now.`);
  }

  if (horizonsMs.length === 0) {
    throw new Error('At least one positive horizon is required.');
  }

  if (venues.length === 0) {
    throw new Error('At least one venue is required.');
  }

  return {
    snapshotDir,
    symbol: 'bitcoin',
    venues,
    horizonsMs,
    venueStalenessMs,
    tradeLookbackMs,
    maxComboSize: Math.max(2, maxComboSize),
    minSamples,
    topLimit,
    json,
  };
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for ${label}: ${value}`);
  }
  return parsed;
}

function assertVenue(value: string): Venue {
  if ((ALL_VENUES as readonly string[]).includes(value)) {
    return value as Venue;
  }
  throw new Error(`Unsupported venue '${value}'. Supported: ${ALL_VENUES.join(', ')}`);
}

function combinations<T>(items: readonly T[], minSize: number, maxSize: number): T[][] {
  const result: T[][] = [];

  function visit(start: number, current: T[]): void {
    if (current.length >= minSize) {
      result.push([...current]);
    }
    if (current.length === maxSize) {
      return;
    }

    for (let index = start; index < items.length; index++) {
      current.push(items[index]);
      visit(index + 1, current);
      current.pop();
    }
  }

  visit(0, []);
  return result;
}

function buildEvaluationRows(options: CliOptions): EvaluationRow[] {
  const windows = discoverWindows({
    snapshotDir: options.snapshotDir,
    symbol: options.symbol,
    venues: options.venues,
  });

  const rows: EvaluationRow[] = [];

  for (const window of windows) {
    rows.push(...buildWindowRows(window, options));
  }

  return rows;
}

function buildWindowRows(window: WindowBundle, options: CliOptions): EvaluationRow[] {
  const chainlinkTicks = parseChainlinkTicks(window.polymarketFile);
  if (chainlinkTicks.length < 2) {
    return [];
  }

  const futureIndicesByHorizon = new Map<number, number[]>();
  for (const horizonMs of options.horizonsMs) {
    futureIndicesByHorizon.set(horizonMs, buildFutureIndices(chainlinkTicks, horizonMs));
  }

  const venueEvents = new Map<Venue, ReturnType<typeof parseCexEvents>>();
  const venuePointers = new Map<Venue, number>();
  const venueStates = new Map<Venue, ReturnType<typeof createVenueState>>();

  for (const venue of options.venues) {
    const filePath = window.cexFiles[venue];
    venueEvents.set(venue, filePath ? parseCexEvents(filePath) : []);
    venuePointers.set(venue, 0);
    venueStates.set(venue, createVenueState());
  }

  const rows: EvaluationRow[] = [];

  for (let tickIndex = 0; tickIndex < chainlinkTicks.length; tickIndex++) {
    const tick = chainlinkTicks[tickIndex];
    const venues: Partial<Record<Venue, VenueObservation>> = {};

    for (const venue of options.venues) {
      const events = venueEvents.get(venue) ?? [];
      const state = venueStates.get(venue)!;
      let pointer = venuePointers.get(venue) ?? 0;

      while (pointer < events.length && events[pointer].ts <= tick.ts) {
        applyEvent(state, events[pointer]);
        pointer++;
      }
      venuePointers.set(venue, pointer);

      pruneTrades(state, tick.ts, options.tradeLookbackMs);

      const built = buildVenuePredictors(venue, state, tick.ts, options.venueStalenessMs);
      if (!built.snapshot) {
        continue;
      }

      venues[venue] = {
        micro: built.snapshot.micro,
        spreadBps: built.snapshot.spreadBps,
        ageMs: built.snapshot.ageMs,
      };
    }

    if (Object.keys(venues).length === 0) {
      continue;
    }

    const futures = new Map<number, number>();
    for (const horizonMs of options.horizonsMs) {
      const futureIndex = futureIndicesByHorizon.get(horizonMs)?.[tickIndex] ?? -1;
      if (futureIndex >= 0) {
        futures.set(horizonMs, chainlinkTicks[futureIndex].price);
      }
    }

    rows.push({
      windowLabel: window.label,
      ts: tick.ts,
      chainlinkNow: tick.price,
      futures,
      venues,
    });
  }

  return rows;
}

function estimateVenueBasis(rows: readonly EvaluationRow[], venues: readonly Venue[]): ReadonlyMap<Venue, number> {
  const basisByVenue = new Map<Venue, number>();

  for (const venue of venues) {
    const samples: number[] = [];
    for (const row of rows) {
      const observation = row.venues[venue];
      if (!observation) {
        continue;
      }
      samples.push(observation.micro - row.chainlinkNow);
    }

    if (samples.length > 0) {
      basisByVenue.set(venue, median(samples));
    }
  }

  return basisByVenue;
}

function createModelSpecs(venues: readonly Venue[], maxComboSize: number): ModelSpec[] {
  const specs: ModelSpec[] = [];

  for (const venue of venues) {
    specs.push(createVenueLinearSpec([venue], 'single'));
  }

  for (const group of combinations(venues, 2, Math.min(maxComboSize, venues.length))) {
    specs.push(createVenueLinearSpec(group, 'combo'));
  }

  specs.push({
    name: 'linear(weighted_all)',
    type: 'aggregate',
    featureNames: ['weighted_residual_all'],
    buildFeatures: (row, basisByVenue) => {
      const weightedResidual = computeWeightedResidual(row, basisByVenue, venues);
      return weightedResidual === null ? null : [weightedResidual];
    },
  });

  specs.push({
    name: 'linear(median_all)',
    type: 'aggregate',
    featureNames: ['median_residual_all'],
    buildFeatures: (row, basisByVenue) => {
      const residuals = venues
        .map((venue) => getVenueResidual(row, venue, basisByVenue))
        .filter((value): value is number => value !== null);
      return residuals.length >= 2 ? [median(residuals)] : null;
    },
  });

  return specs;
}

function createVenueLinearSpec(venues: readonly Venue[], type: 'single' | 'combo'): ModelSpec {
  return {
    name: `linear(${venues.join('+')})`,
    type,
    featureNames: venues.map((venue) => `residual_${venue}`),
    buildFeatures: (row, basisByVenue) => {
      const residuals: number[] = [];
      for (const venue of venues) {
        const residual = getVenueResidual(row, venue, basisByVenue);
        if (residual === null) {
          return null;
        }
        residuals.push(residual);
      }
      return residuals;
    },
  };
}

function getVenueResidual(
  row: EvaluationRow,
  venue: Venue,
  basisByVenue: ReadonlyMap<Venue, number>,
): number | null {
  const observation = row.venues[venue];
  if (!observation) {
    return null;
  }

  const basis = basisByVenue.get(venue);
  if (basis === undefined) {
    return null;
  }

  return observation.micro - basis - row.chainlinkNow;
}

function computeWeightedResidual(
  row: EvaluationRow,
  basisByVenue: ReadonlyMap<Venue, number>,
  venues: readonly Venue[],
): number | null {
  let numerator = 0;
  let denominator = 0;

  for (const venue of venues) {
    const observation = row.venues[venue];
    const basis = basisByVenue.get(venue);
    if (!observation || basis === undefined) {
      continue;
    }

    const residual = observation.micro - basis - row.chainlinkNow;
    const weight = 1 / Math.max(observation.spreadBps, 0.05) / (1 + observation.ageMs / 1_000);
    numerator += residual * weight;
    denominator += weight;
  }

  return denominator > 0 ? numerator / denominator : null;
}

function buildModelSamples(
  rows: readonly EvaluationRow[],
  spec: ModelSpec,
  horizonMs: number,
  basisByVenue: ReadonlyMap<Venue, number>,
): ModelSample[] {
  const samples: ModelSample[] = [];

  for (const row of rows) {
    const future = row.futures.get(horizonMs);
    if (future === undefined) {
      continue;
    }

    const features = spec.buildFeatures(row, basisByVenue);
    if (!features) {
      continue;
    }

    samples.push({
      windowLabel: row.windowLabel,
      chainlinkNow: row.chainlinkNow,
      chainlinkFuture: future,
      features,
    });
  }

  return samples;
}

function fitLinearModel(samples: readonly ModelSample[], featureCount: number): ModelCoefficients {
  const size = featureCount + 1;
  const xtx = Array.from({ length: size }, () => Array.from({ length: size }, () => 0));
  const xty = Array.from({ length: size }, () => 0);

  for (const sample of samples) {
    const target = sample.chainlinkFuture - sample.chainlinkNow;
    const vector = [1, ...sample.features];

    for (let row = 0; row < size; row++) {
      xty[row] += vector[row] * target;
      for (let col = 0; col < size; col++) {
        xtx[row][col] += vector[row] * vector[col];
      }
    }
  }

  for (let index = 1; index < size; index++) {
    xtx[index][index] += RIDGE_LAMBDA;
  }

  const solution = solveLinearSystem(xtx, xty);
  return {
    intercept: solution[0] ?? 0,
    weights: solution.slice(1),
  };
}

function solveLinearSystem(matrix: readonly number[][], vector: readonly number[]): number[] {
  const size = vector.length;
  const a = matrix.map((row) => [...row]);
  const b = [...vector];

  for (let pivot = 0; pivot < size; pivot++) {
    let bestRow = pivot;
    let bestValue = Math.abs(a[pivot][pivot] ?? 0);

    for (let row = pivot + 1; row < size; row++) {
      const candidate = Math.abs(a[row][pivot] ?? 0);
      if (candidate > bestValue) {
        bestValue = candidate;
        bestRow = row;
      }
    }

    if (bestValue === 0) {
      return Array.from({ length: size }, () => 0);
    }

    if (bestRow !== pivot) {
      [a[pivot], a[bestRow]] = [a[bestRow], a[pivot]];
      [b[pivot], b[bestRow]] = [b[bestRow], b[pivot]];
    }

    const pivotValue = a[pivot][pivot];
    for (let col = pivot; col < size; col++) {
      a[pivot][col] /= pivotValue;
    }
    b[pivot] /= pivotValue;

    for (let row = 0; row < size; row++) {
      if (row === pivot) {
        continue;
      }

      const factor = a[row][pivot];
      if (factor === 0) {
        continue;
      }

      for (let col = pivot; col < size; col++) {
        a[row][col] -= factor * a[pivot][col];
      }
      b[row] -= factor * b[pivot];
    }
  }

  return b;
}

function evaluateModel(
  spec: ModelSpec,
  horizonMs: number,
  coefficients: ModelCoefficients,
  samples: readonly ModelSample[],
): FittedModelResult {
  let absErrSum = 0;
  let sqErrSum = 0;
  let baselineAbsErrSum = 0;
  let baselineSqErrSum = 0;
  let signEvaluated = 0;
  let signMatches = 0;
  let predDeltaSum = 0;
  let trueDeltaSum = 0;
  let predDeltaSqSum = 0;
  let trueDeltaSqSum = 0;
  let crossSum = 0;

  const perWindow = new Map<string, SampleAccumulator>();

  for (const sample of samples) {
    const predDelta = coefficients.intercept + dot(coefficients.weights, sample.features);
    const trueDelta = sample.chainlinkFuture - sample.chainlinkNow;
    const error = predDelta - trueDelta;
    const baselineError = -trueDelta;

    absErrSum += Math.abs(error);
    sqErrSum += error * error;
    baselineAbsErrSum += Math.abs(baselineError);
    baselineSqErrSum += baselineError * baselineError;
    predDeltaSum += predDelta;
    trueDeltaSum += trueDelta;
    predDeltaSqSum += predDelta * predDelta;
    trueDeltaSqSum += trueDelta * trueDelta;
    crossSum += predDelta * trueDelta;

    if (predDelta !== 0 && trueDelta !== 0) {
      signEvaluated++;
      if (Math.sign(predDelta) === Math.sign(trueDelta)) {
        signMatches++;
      }
    }

    const bucket = getWindowAccumulator(perWindow, sample.windowLabel);
    bucket.n++;
    bucket.absErrSum += Math.abs(error);
    bucket.sqErrSum += error * error;
    bucket.baselineAbsErrSum += Math.abs(baselineError);
    bucket.baselineSqErrSum += baselineError * baselineError;
    bucket.predDeltaSum += predDelta;
    bucket.trueDeltaSum += trueDelta;
    bucket.predDeltaSqSum += predDelta * predDelta;
    bucket.trueDeltaSqSum += trueDelta * trueDelta;
    bucket.crossSum += predDelta * trueDelta;
    if (predDelta !== 0 && trueDelta !== 0) {
      bucket.signEvaluated++;
      if (Math.sign(predDelta) === Math.sign(trueDelta)) {
        bucket.signMatches++;
      }
    }
  }

  const predVar = predDeltaSqSum - predDeltaSum ** 2 / samples.length;
  const trueVar = trueDeltaSqSum - trueDeltaSum ** 2 / samples.length;
  const covariance = crossSum - predDeltaSum * trueDeltaSum / samples.length;

  const windowMetrics = [...perWindow.values()]
    .map(finalizeWindowMetrics)
    .sort((left, right) => compareTimeRangeLabels(left.windowLabel, right.windowLabel));

  return {
    model: spec.name,
    modelType: spec.type,
    horizonMs,
    featureNames: spec.featureNames,
    coefficients,
    n: samples.length,
    mae: absErrSum / samples.length,
    rmse: Math.sqrt(sqErrSum / samples.length),
    baselineMae: baselineAbsErrSum / samples.length,
    baselineRmse: Math.sqrt(baselineSqErrSum / samples.length),
    improvementPct: baselineAbsErrSum === 0 ? 0 : (1 - absErrSum / baselineAbsErrSum) * 100,
    hitRate: signEvaluated > 0 ? signMatches / signEvaluated : undefined,
    corr: predVar > 0 && trueVar > 0 ? covariance / Math.sqrt(predVar * trueVar) : undefined,
    windowMetrics,
    signalCalibration: buildSignalCalibrationBuckets(coefficients, samples),
  };
}

function buildSignalCalibrationBuckets(
  coefficients: ModelCoefficients,
  samples: readonly ModelSample[],
  bucketCount = 10,
): SignalCalibrationBucket[] {
  if (samples.length === 0) {
    return [];
  }

  const predictions = samples
    .map((sample) => {
      const predDelta = coefficients.intercept + dot(coefficients.weights, sample.features);
      const trueDelta = sample.chainlinkFuture - sample.chainlinkNow;
      return {
        predDelta,
        trueDelta,
        absPred: Math.abs(predDelta),
      };
    })
    .sort((left, right) => left.absPred - right.absPred);

  const buckets: SignalCalibrationBucket[] = [];

  for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex++) {
    const start = Math.floor(bucketIndex * predictions.length / bucketCount);
    const end = Math.floor((bucketIndex + 1) * predictions.length / bucketCount);
    const slice = predictions.slice(start, end);
    if (slice.length === 0) {
      continue;
    }

    let predAbsSum = 0;
    let trueAbsSum = 0;
    let signEvaluated = 0;
    let signMatches = 0;

    for (const prediction of slice) {
      predAbsSum += prediction.absPred;
      trueAbsSum += Math.abs(prediction.trueDelta);
      if (prediction.predDelta !== 0 && prediction.trueDelta !== 0) {
        signEvaluated++;
        if (Math.sign(prediction.predDelta) === Math.sign(prediction.trueDelta)) {
          signMatches++;
        }
      }
    }

    buckets.push({
      score: bucketIndex + 1,
      n: slice.length,
      minAbsPred: slice[0].absPred,
      maxAbsPred: slice[slice.length - 1].absPred,
      avgAbsPred: predAbsSum / slice.length,
      avgAbsTrue: trueAbsSum / slice.length,
      hitRate: signEvaluated > 0 ? signMatches / signEvaluated : undefined,
    });
  }

  return buckets;
}

interface SampleAccumulator {
  readonly windowLabel: string;
  n: number;
  absErrSum: number;
  sqErrSum: number;
  baselineAbsErrSum: number;
  baselineSqErrSum: number;
  signEvaluated: number;
  signMatches: number;
  predDeltaSum: number;
  trueDeltaSum: number;
  predDeltaSqSum: number;
  trueDeltaSqSum: number;
  crossSum: number;
}

function getWindowAccumulator(store: Map<string, SampleAccumulator>, windowLabel: string): SampleAccumulator {
  const existing = store.get(windowLabel);
  if (existing) {
    return existing;
  }

  const created: SampleAccumulator = {
    windowLabel,
    n: 0,
    absErrSum: 0,
    sqErrSum: 0,
    baselineAbsErrSum: 0,
    baselineSqErrSum: 0,
    signEvaluated: 0,
    signMatches: 0,
    predDeltaSum: 0,
    trueDeltaSum: 0,
    predDeltaSqSum: 0,
    trueDeltaSqSum: 0,
    crossSum: 0,
  };
  store.set(windowLabel, created);
  return created;
}

function finalizeWindowMetrics(bucket: SampleAccumulator): WindowMetrics {
  const predVar = bucket.predDeltaSqSum - bucket.predDeltaSum ** 2 / bucket.n;
  const trueVar = bucket.trueDeltaSqSum - bucket.trueDeltaSum ** 2 / bucket.n;
  const covariance = bucket.crossSum - bucket.predDeltaSum * bucket.trueDeltaSum / bucket.n;

  return {
    windowLabel: bucket.windowLabel,
    n: bucket.n,
    mae: bucket.absErrSum / bucket.n,
    rmse: Math.sqrt(bucket.sqErrSum / bucket.n),
    baselineMae: bucket.baselineAbsErrSum / bucket.n,
    baselineRmse: Math.sqrt(bucket.baselineSqErrSum / bucket.n),
    improvementPct: bucket.baselineAbsErrSum === 0 ? 0 : (1 - bucket.absErrSum / bucket.baselineAbsErrSum) * 100,
    hitRate: bucket.signEvaluated > 0 ? bucket.signMatches / bucket.signEvaluated : undefined,
    corr: predVar > 0 && trueVar > 0 ? covariance / Math.sqrt(predVar * trueVar) : undefined,
  };
}

function dot(left: readonly number[], right: readonly number[]): number {
  let sum = 0;
  for (let index = 0; index < left.length; index++) {
    sum += left[index] * (right[index] ?? 0);
  }
  return sum;
}

function compareTimeRangeLabels(left: string, right: string): number {
  return parseRangeLabelStart(left) - parseRangeLabelStart(right);
}

function parseRangeLabelStart(label: string): number {
  const [start] = label.split('-');
  return parseTimeTokenToMinutes(start);
}

function parseTimeTokenToMinutes(token: string): number {
  const upper = token.toUpperCase();
  const suffix = upper.endsWith('PM') ? 'PM' : upper.endsWith('AM') ? 'AM' : '';
  if (!suffix) {
    throw new Error(`Invalid time token '${token}'`);
  }

  const raw = upper.slice(0, -2).padStart(4, '0');
  let hour = Number.parseInt(raw.slice(0, 2), 10);
  const minute = Number.parseInt(raw.slice(2), 10);

  if (suffix === 'AM') {
    if (hour === 12) hour = 0;
  } else if (hour !== 12) {
    hour += 12;
  }

  return hour * 60 + minute;
}

function sortByDirection(results: readonly FittedModelResult[], horizonMs: number, minSamples: number): FittedModelResult[] {
  return results
    .filter((result) => result.horizonMs === horizonMs && result.n >= minSamples)
    .sort((left, right) => {
      const leftHit = left.hitRate ?? Number.NEGATIVE_INFINITY;
      const rightHit = right.hitRate ?? Number.NEGATIVE_INFINITY;
      if (rightHit !== leftHit) {
        return rightHit - leftHit;
      }
      const leftCorr = left.corr ?? Number.NEGATIVE_INFINITY;
      const rightCorr = right.corr ?? Number.NEGATIVE_INFINITY;
      if (rightCorr !== leftCorr) {
        return rightCorr - leftCorr;
      }
      return left.mae - right.mae;
    });
}

function sortByLevel(results: readonly FittedModelResult[], horizonMs: number, minSamples: number): FittedModelResult[] {
  return results
    .filter((result) => result.horizonMs === horizonMs && result.n >= minSamples)
    .sort((left, right) => {
      if (right.improvementPct !== left.improvementPct) {
        return right.improvementPct - left.improvementPct;
      }
      return left.mae - right.mae;
    });
}

function pickBcoResults(results: readonly FittedModelResult[]): Record<number, FittedModelResult | undefined> {
  const wanted = 'linear(binance+coinbase+okx)';
  const map: Record<number, FittedModelResult | undefined> = {};
  for (const result of results) {
    if (result.model === wanted) {
      map[result.horizonMs] = result;
    }
  }
  return map;
}

function findBestSingleFallback(results: readonly FittedModelResult[], horizonMs: number, minSamples: number): FittedModelResult | undefined {
  return sortByDirection(results.filter((result) => result.modelType === 'single'), horizonMs, minSamples)[0];
}

function pickWorstSingles(results: readonly FittedModelResult[], horizonMs: number, minSamples: number): readonly FittedModelResult[] {
  return results
    .filter((result) => result.modelType === 'single' && result.horizonMs === horizonMs && result.n >= minSamples)
    .sort((left, right) => {
      const leftHit = left.hitRate ?? Number.POSITIVE_INFINITY;
      const rightHit = right.hitRate ?? Number.POSITIVE_INFINITY;
      if (leftHit !== rightHit) {
        return leftHit - rightHit;
      }
      const leftCorr = left.corr ?? Number.POSITIVE_INFINITY;
      const rightCorr = right.corr ?? Number.POSITIVE_INFINITY;
      if (leftCorr !== rightCorr) {
        return leftCorr - rightCorr;
      }
      return right.mae - left.mae;
    })
    .slice(0, 3);
}

function formatRows(results: readonly FittedModelResult[]): RenderRow[] {
  return results.map((result) => ({
    model: result.model,
    horizon: `${result.horizonMs}ms`,
    samples: result.n.toString(),
    mae: result.mae.toFixed(3),
    baseline: result.baselineMae.toFixed(3),
    improve: `${result.improvementPct.toFixed(2)}%`,
    hit: result.hitRate === undefined ? '-' : `${(result.hitRate * 100).toFixed(1)}%`,
    corr: result.corr === undefined ? '-' : result.corr.toFixed(3),
  }));
}

function renderTable(rows: readonly RenderRow[]): string {
  if (rows.length === 0) {
    return '(no rows)';
  }

  const headers: RenderRow = {
    model: 'model',
    horizon: 'horizon',
    samples: 'samples',
    mae: 'mae',
    baseline: 'baseline',
    improve: 'improve',
    hit: 'hit',
    corr: 'corr',
  };

  const columns: (keyof RenderRow)[] = ['model', 'horizon', 'samples', 'mae', 'baseline', 'improve', 'hit', 'corr'];
  const widths = new Map<keyof RenderRow, number>();

  for (const column of columns) {
    widths.set(column, Math.max(headers[column].length, ...rows.map((row) => row[column].length)));
  }

  const renderLine = (row: RenderRow): string =>
    columns
      .map((column) => row[column].padEnd(widths.get(column)!))
      .join('  ');

  return [
    renderLine(headers),
    columns.map((column) => '-'.repeat(widths.get(column)!)).join('  '),
    ...rows.map(renderLine),
  ].join('\n');
}

function coefficientObject(result: FittedModelResult): Record<string, number> {
  const pairs: Record<string, number> = { intercept: result.coefficients.intercept };
  result.featureNames.forEach((featureName, index) => {
    pairs[featureName] = result.coefficients.weights[index] ?? 0;
  });
  return pairs;
}

function renderText(
  options: CliOptions,
  rows: readonly EvaluationRow[],
  basisByVenue: ReadonlyMap<Venue, number>,
  results: readonly FittedModelResult[],
): string {
  const nextMoveHorizon = options.horizonsMs[0];
  const futureLevelHorizon = options.horizonsMs[options.horizonsMs.length - 1];
  const directionLeaders = sortByDirection(results, nextMoveHorizon, options.minSamples);
  const levelLeaders = sortByLevel(results, futureLevelHorizon, options.minSamples);
  const bestSingleFallback = findBestSingleFallback(results, nextMoveHorizon, options.minSamples);
  const worstSinglesNextMove = pickWorstSingles(results, nextMoveHorizon, options.minSamples);
  const worstSinglesFutureLevel = pickWorstSingles(results, futureLevelHorizon, options.minSamples);
  const bcoByHorizon = pickBcoResults(results);

  const lines: string[] = [];
  lines.push(`Snapshot dir: ${options.snapshotDir}`);
  lines.push(
    `Rows=${rows.length} Horizons=${options.horizonsMs.join(',')}ms `
    + `Venues=${options.venues.join(',')} Staleness=${options.venueStalenessMs}ms`,
  );
  lines.push('');

  lines.push('Signal Summary');
  if (directionLeaders[0]) {
    lines.push(
      `Best signal for next Chainlink move (${nextMoveHorizon}ms): `
      + `${directionLeaders[0].model} hit=${((directionLeaders[0].hitRate ?? 0) * 100).toFixed(1)}% `
      + `corr=${(directionLeaders[0].corr ?? 0).toFixed(3)}`,
    );
  }
  if (levelLeaders[0]) {
    lines.push(
      `Best signal for future Chainlink level (${futureLevelHorizon}ms): `
      + `${levelLeaders[0].model} improve=${levelLeaders[0].improvementPct.toFixed(2)}% `
      + `mae=${levelLeaders[0].mae.toFixed(3)} baseline=${levelLeaders[0].baselineMae.toFixed(3)}`,
    );
  }
  if (bestSingleFallback) {
    lines.push(
      `Best single fallback: ${bestSingleFallback.model} `
      + `hit=${((bestSingleFallback.hitRate ?? 0) * 100).toFixed(1)}% `
      + `corr=${(bestSingleFallback.corr ?? 0).toFixed(3)}`,
    );
  }
  if (worstSinglesNextMove.length > 0) {
    lines.push(
      `Worst / lowest-signal singles for next move: `
      + `${worstSinglesNextMove.map((result) => result.model).join(', ')}`,
    );
  }
  if (worstSinglesFutureLevel.length > 0) {
    lines.push(
      `Worst / lowest-signal singles for future level: `
      + `${worstSinglesFutureLevel.map((result) => result.model).join(', ')}`,
    );
  }
  lines.push('');

  lines.push('Venue Basis');
  for (const venue of options.venues) {
    const basis = basisByVenue.get(venue);
    if (basis !== undefined) {
      lines.push(`  ${venue}: ${basis.toFixed(3)} USD`);
    }
  }
  lines.push('');

  for (const horizonMs of options.horizonsMs) {
    const result = bcoByHorizon[horizonMs];
    if (!result) {
      continue;
    }

    lines.push(`BCO Model ${horizonMs}ms`);
    lines.push(`  coefficients: ${JSON.stringify(coefficientObject(result))}`);
    lines.push(
      `  quality: n=${result.n} mae=${result.mae.toFixed(3)} baseline=${result.baselineMae.toFixed(3)} `
      + `improve=${result.improvementPct.toFixed(2)}% hit=${result.hitRate === undefined ? '-' : `${(result.hitRate * 100).toFixed(1)}%`} `
      + `corr=${result.corr === undefined ? '-' : result.corr.toFixed(3)}`,
    );
    lines.push(
      `  worst windows: ${result.windowMetrics
        .slice()
        .sort((left, right) => left.improvementPct - right.improvementPct)
        .slice(0, 3)
        .map((metric) => `${metric.windowLabel}:${metric.improvementPct.toFixed(1)}%`)
        .join(', ')}`,
    );
    lines.push(
      `  best windows: ${result.windowMetrics
        .slice()
        .sort((left, right) => right.improvementPct - left.improvementPct)
        .slice(0, 3)
        .map((metric) => `${metric.windowLabel}:${metric.improvementPct.toFixed(1)}%`)
        .join(', ')}`,
    );
    lines.push('');
  }

  lines.push(`Top Direction Models At ${nextMoveHorizon}ms`);
  lines.push(renderTable(formatRows(directionLeaders.slice(0, options.topLimit))));
  lines.push('');

  lines.push(`Top Level Models At ${futureLevelHorizon}ms`);
  lines.push(renderTable(formatRows(levelLeaders.slice(0, options.topLimit))));
  lines.push('');

  return lines.join('\n').trimEnd();
}

function main(): void {
  const options = parseCli(process.argv.slice(2));
  const rows = buildEvaluationRows(options);
  if (rows.length === 0) {
    throw new Error(`No evaluation rows found in ${options.snapshotDir}`);
  }

  const basisByVenue = estimateVenueBasis(rows, options.venues);
  const modelSpecs = createModelSpecs(options.venues, options.maxComboSize);
  const results: FittedModelResult[] = [];

  for (const horizonMs of options.horizonsMs) {
    for (const spec of modelSpecs) {
      const samples = buildModelSamples(rows, spec, horizonMs, basisByVenue);
      if (samples.length < options.minSamples) {
        continue;
      }

      const coefficients = fitLinearModel(samples, spec.featureNames.length);
      results.push(evaluateModel(spec, horizonMs, coefficients, samples));
    }
  }

  if (options.json) {
    console.log(JSON.stringify({
      options,
      rowCount: rows.length,
      basisByVenue: Object.fromEntries([...basisByVenue.entries()]),
      results,
    }, null, 2));
    return;
  }

  console.log(renderText(options, rows, basisByVenue, results));
}

main();
