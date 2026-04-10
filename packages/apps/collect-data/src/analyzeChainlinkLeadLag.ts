import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

export const ALL_VENUES = ['binance', 'coinbase', 'cryptocom', 'kraken', 'okx'] as const;
export type Venue = (typeof ALL_VENUES)[number];

const DEFAULT_HORIZONS_MS = [0, 1_000, 2_000, 5_000];
const DEFAULT_VENUE_STALENESS_MS = 2_000;
const DEFAULT_TRADE_LOOKBACK_MS = 1_000;
const DEFAULT_MAX_COMBO_SIZE = 3;
const DEFAULT_TOP_LIMIT = 10;
const DEFAULT_SYMBOL = 'bitcoin';

interface CliOptions {
  readonly snapshotDir: string;
  readonly symbol: 'bitcoin';
  readonly venues: readonly Venue[];
  readonly horizonsMs: readonly number[];
  readonly venueStalenessMs: number;
  readonly tradeLookbackMs: number;
  readonly maxComboSize: number;
  readonly topLimit: number;
  readonly minSamples: number;
  readonly json: boolean;
}

interface SymbolConfig {
  readonly polymarketPrefix: string;
  readonly cexPrefix: string;
}

export interface WindowBundle {
  readonly label: string;
  readonly polymarketFile: string;
  readonly cexFiles: Partial<Record<Venue, string>>;
}

export interface ChainlinkTick {
  readonly ts: number;
  readonly price: number;
}

interface OrderbookEvent {
  readonly kind: 'ob';
  readonly ts: number;
  readonly order: number;
  readonly bid: number;
  readonly ask: number;
  readonly bidSize: number;
  readonly askSize: number;
}

interface TradeEvent {
  readonly kind: 'trade';
  readonly ts: number;
  readonly order: number;
  readonly price: number;
  readonly size: number;
  readonly signedNotional: number;
  readonly notional: number;
}

export type CexEvent = OrderbookEvent | TradeEvent;

interface TradeContribution {
  readonly ts: number;
  readonly signedNotional: number;
  readonly notional: number;
}

export interface VenueState {
  bid: number | null;
  ask: number | null;
  bidSize: number;
  askSize: number;
  lastObTs: number | null;
  recentTrades: TradeContribution[];
  tradeHead: number;
  signedNotionalSum: number;
  notionalSum: number;
}

export interface VenueSignalSnapshot {
  readonly micro: number;
  readonly spreadBps: number;
  readonly ageMs: number;
}

interface ProcessSummary {
  windowCount: number;
  chainlinkTicks: number;
  evalPoints: number;
}

interface SampleAccumulator {
  readonly predictor: string;
  readonly horizonMs: number;
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

interface MetricResult {
  readonly predictor: string;
  readonly predictorType: 'single' | 'aggregate' | 'combo';
  readonly horizonMs: number;
  readonly n: number;
  readonly basis: number;
  readonly mae: number;
  readonly rmse: number;
  readonly baselineMae: number;
  readonly baselineRmse: number;
  readonly improvementPct: number;
  readonly directionHitRate?: number;
  readonly corr?: number;
}

interface RenderRow {
  readonly predictor: string;
  readonly horizon: string;
  readonly samples: string;
  readonly mae: string;
  readonly baseline: string;
  readonly improve: string;
  readonly hit: string;
  readonly corr: string;
  readonly basis: string;
}

function usage(): string {
  return [
    'Usage:',
    '  node src/analyzeChainlinkLeadLag.ts <snapshot-dir> [options]',
    '',
    'Options:',
    '  --symbol bitcoin              Symbol family to analyze (default: bitcoin)',
    '  --venues v1,v2                Venues to include (default: all)',
    '  --horizons 0,1000,2000,5000   Future Chainlink horizons in ms',
    '  --staleness-ms 2000           Max age of a venue book at evaluation time',
    '  --trade-lookback-ms 1000      Lookback for trade-pressure adjustment',
    '  --max-combo-size 3            Max fixed venue subset size',
    '  --min-samples 500             Minimum samples for leaderboard rows',
    '  --top 10                      Number of rows per leaderboard',
    '  --json                        Emit JSON instead of text',
    '',
    'Examples:',
    '  node src/analyzeChainlinkLeadLag.ts snapshots/2026-04-08',
    '  node src/analyzeChainlinkLeadLag.ts snapshots/2026-04-08 --horizons 0,1000,2000,5000 --top 15',
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
  let topLimit = DEFAULT_TOP_LIMIT;
  let minSamples = 500;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (!snapshotDir && !arg.startsWith('--')) {
      snapshotDir = path.resolve(process.cwd(), arg);
      continue;
    }

    if (arg === '--json') {
      json = true;
      continue;
    }

    const value = argv[i + 1];
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
          .filter((item) => Number.isFinite(item) && item >= 0)
          .sort((a, b) => a - b);
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
      case '--top':
        topLimit = parsePositiveInteger(value, arg);
        break;
      case '--min-samples':
        minSamples = parsePositiveInteger(value, arg);
        break;
      default:
        throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }

    i++;
  }

  if (!snapshotDir) {
    throw new Error(usage());
  }

  if (symbol !== 'bitcoin') {
    throw new Error(`Unsupported symbol '${symbol}'. Only 'bitcoin' is supported right now.`);
  }

  if (horizonsMs.length === 0) {
    throw new Error('At least one horizon is required.');
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
    topLimit,
    minSamples,
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

function getSymbolConfig(symbol: CliOptions['symbol']): SymbolConfig {
  if (symbol === 'bitcoin') {
    return {
      polymarketPrefix: 'polymarket_Bitcoin_Up_or_Down_',
      cexPrefix: 'BTC-USD',
    };
  }

  throw new Error(`Unsupported symbol '${symbol}'.`);
}

function extractTimeRangeLabel(fileName: string): string | null {
  const match = fileName.match(/_(\d{1,4}[AP]M-\d{1,4}[AP]M)_ET/);
  return match?.[1] ?? null;
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

  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute < 0 || minute >= 60) {
    throw new Error(`Invalid time token '${token}'`);
  }

  if (suffix === 'AM') {
    if (hour === 12) hour = 0;
  } else if (hour !== 12) {
    hour += 12;
  }

  return hour * 60 + minute;
}

function compareTimeRangeLabels(a: string, b: string): number {
  const [aStart] = a.split('-');
  const [bStart] = b.split('-');
  return parseTimeTokenToMinutes(aStart) - parseTimeTokenToMinutes(bStart);
}

export function discoverWindows(options: Pick<CliOptions, 'snapshotDir' | 'symbol' | 'venues'>): WindowBundle[] {
  const symbol = getSymbolConfig(options.symbol);
  const polymarketDir = path.join(options.snapshotDir, 'polymarket');
  if (!fs.existsSync(polymarketDir)) {
    throw new Error(`Polymarket directory not found: ${polymarketDir}`);
  }

  const polymarketFiles = fs
    .readdirSync(polymarketDir)
    .filter((file) => file.startsWith(symbol.polymarketPrefix) && file.endsWith('.jsonl.gz'));

  const polymarketByLabel = new Map<string, string>();
  for (const file of polymarketFiles) {
    const label = extractTimeRangeLabel(file);
    if (label) {
      polymarketByLabel.set(label, path.join(polymarketDir, file));
    }
  }

  const cexByVenue = new Map<Venue, Map<string, string>>();
  for (const venue of options.venues) {
    const venueDir = path.join(options.snapshotDir, venue);
    const venueFiles = fs.existsSync(venueDir) ? fs.readdirSync(venueDir) : [];
    const byLabel = new Map<string, string>();
    for (const file of venueFiles) {
      if (!file.startsWith(`${venue}_${symbol.cexPrefix}_spot_`) || !file.endsWith('.jsonl.gz')) {
        continue;
      }
      const label = extractTimeRangeLabel(file);
      if (label) {
        byLabel.set(label, path.join(venueDir, file));
      }
    }
    cexByVenue.set(venue, byLabel);
  }

  const bundles: WindowBundle[] = [];
  for (const [label, polymarketFile] of polymarketByLabel.entries()) {
    const cexFiles: Partial<Record<Venue, string>> = {};
    for (const venue of options.venues) {
      const venueFile = cexByVenue.get(venue)?.get(label);
      if (venueFile) {
        cexFiles[venue] = venueFile;
      }
    }

    if (Object.keys(cexFiles).length === 0) {
      continue;
    }

    bundles.push({
      label,
      polymarketFile,
      cexFiles,
    });
  }

  bundles.sort((left, right) => compareTimeRangeLabels(left.label, right.label));
  return bundles;
}

function readJsonLinesGz(filePath: string): unknown[] {
  const raw = zlib.gunzipSync(fs.readFileSync(filePath)).toString('utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function parseChainlinkTicks(filePath: string): ChainlinkTick[] {
  const rows = readJsonLinesGz(filePath);
  const lastByTs = new Map<number, number>();

  for (const row of rows) {
    if (!isObject(row) || row.t !== 'crypto_price' || row.source !== 'chainlink') {
      continue;
    }

    const ts = asFiniteNumber(row.ts);
    const price = asFiniteNumber(row.price);
    if (ts === undefined || price === undefined) {
      continue;
    }

    lastByTs.set(ts, price);
  }

  return [...lastByTs.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([ts, price]) => ({ ts, price }));
}

export function parseCexEvents(filePath: string): CexEvent[] {
  const rows = readJsonLinesGz(filePath);
  const events: CexEvent[] = [];

  rows.forEach((row, order) => {
    if (!isObject(row)) {
      return;
    }

    if (row.t === 'ob') {
      const ts = asFiniteNumber(row.ts);
      const bestBid = parseBookLevel(row.bids, 0);
      const bestAsk = parseBookLevel(row.asks, 0);
      if (
        ts === undefined
        || !bestBid
        || !bestAsk
        || !Number.isFinite(bestBid.price)
        || !Number.isFinite(bestAsk.price)
        || bestAsk.price <= bestBid.price
      ) {
        return;
      }

      events.push({
        kind: 'ob',
        ts,
        order,
        bid: bestBid.price,
        ask: bestAsk.price,
        bidSize: bestBid.size,
        askSize: bestAsk.size,
      });
      return;
    }

    if (row.t === 'trade') {
      const ts = asFiniteNumber(row.ts);
      const price = asFiniteNumber(row.p);
      const size = asFiniteNumber(row.sz);
      if (ts === undefined || price === undefined || size === undefined || size <= 0) {
        return;
      }

      let sign = 0;
      if (row.side === 'buy') sign = 1;
      if (row.side === 'sell') sign = -1;

      events.push({
        kind: 'trade',
        ts,
        order,
        price,
        size,
        signedNotional: sign * price * size,
        notional: price * size,
      });
    }
  });

  events.sort((left, right) => {
    if (left.ts !== right.ts) return left.ts - right.ts;
    if (left.kind !== right.kind) return left.kind === 'ob' ? -1 : 1;
    return left.order - right.order;
  });

  return events;
}

function parseBookLevel(levels: unknown, index: number): { price: number; size: number } | null {
  if (!Array.isArray(levels) || !Array.isArray(levels[index])) {
    return null;
  }

  const level = levels[index] as unknown[];
  const price = asFiniteNumber(level[0]);
  const size = asFiniteNumber(level[1]);
  if (price === undefined || size === undefined) {
    return null;
  }

  return { price, size };
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

export function buildFutureIndices(ticks: readonly ChainlinkTick[], horizonMs: number): number[] {
  const result = new Array<number>(ticks.length).fill(-1);
  if (horizonMs === 0) {
    for (let index = 0; index < ticks.length; index++) {
      result[index] = index;
    }
    return result;
  }

  let futureIndex = 1;
  for (let index = 0; index < ticks.length; index++) {
    if (futureIndex < index + 1) {
      futureIndex = index + 1;
    }

    const targetTs = ticks[index].ts + horizonMs;
    while (futureIndex < ticks.length && ticks[futureIndex].ts < targetTs) {
      futureIndex++;
    }

    result[index] = futureIndex < ticks.length ? futureIndex : -1;
  }

  return result;
}

export function createVenueState(): VenueState {
  return {
    bid: null,
    ask: null,
    bidSize: 0,
    askSize: 0,
    lastObTs: null,
    recentTrades: [],
    tradeHead: 0,
    signedNotionalSum: 0,
    notionalSum: 0,
  };
}

export function applyEvent(state: VenueState, event: CexEvent): void {
  if (event.kind === 'ob') {
    state.bid = event.bid;
    state.ask = event.ask;
    state.bidSize = event.bidSize;
    state.askSize = event.askSize;
    state.lastObTs = event.ts;
    return;
  }

  state.recentTrades.push({
    ts: event.ts,
    signedNotional: event.signedNotional,
    notional: event.notional,
  });
  state.signedNotionalSum += event.signedNotional;
  state.notionalSum += event.notional;
}

export function pruneTrades(state: VenueState, nowTs: number, lookbackMs: number): void {
  const cutoffTs = nowTs - lookbackMs;
  while (state.tradeHead < state.recentTrades.length && state.recentTrades[state.tradeHead].ts < cutoffTs) {
    const trade = state.recentTrades[state.tradeHead];
    state.signedNotionalSum -= trade.signedNotional;
    state.notionalSum -= trade.notional;
    state.tradeHead++;
  }

  if (state.tradeHead > 128 && state.tradeHead * 2 >= state.recentTrades.length) {
    state.recentTrades = state.recentTrades.slice(state.tradeHead);
    state.tradeHead = 0;
  }
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.max(lower, Math.min(upper, value));
}

export function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error('Cannot compute median of an empty array.');
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.floor((sorted.length - 1) * 0.5);
  return sorted[index];
}

export function buildVenuePredictors(
  venue: Venue,
  state: VenueState,
  nowTs: number,
  stalenessMs: number,
): { values: Record<string, number>; snapshot?: VenueSignalSnapshot } {
  if (
    state.lastObTs === null
    || state.bid === null
    || state.ask === null
    || state.ask <= state.bid
  ) {
    return { values: {} };
  }

  const ageMs = nowTs - state.lastObTs;
  if (ageMs < 0 || ageMs > stalenessMs) {
    return { values: {} };
  }

  const mid = (state.bid + state.ask) / 2;
  const spread = state.ask - state.bid;
  const spreadBps = mid === 0 ? 0 : spread / mid * 10_000;
  const sizeSum = Math.max(0, state.bidSize) + Math.max(0, state.askSize);
  const micro = sizeSum > 0
    ? (state.ask * Math.max(0, state.bidSize) + state.bid * Math.max(0, state.askSize)) / sizeSum
    : mid;
  const tradePressure = state.notionalSum > 0 ? state.signedNotionalSum / state.notionalSum : 0;
  const microTrade = clamp(micro + tradePressure * (spread / 2), state.bid, state.ask);

  return {
    values: {
      [`${venue}::mid`]: mid,
      [`${venue}::micro`]: micro,
      [`${venue}::micro_trade`]: microTrade,
    },
    snapshot: {
      micro,
      spreadBps,
      ageMs,
    },
  };
}

function buildVenueCombinations(venues: readonly Venue[], maxSize: number): Venue[][] {
  const combinations: Venue[][] = [];

  function visit(start: number, current: Venue[]): void {
    if (current.length >= 2) {
      combinations.push([...current]);
    }
    if (current.length === maxSize) {
      return;
    }

    for (let index = start; index < venues.length; index++) {
      current.push(venues[index]);
      visit(index + 1, current);
      current.pop();
    }
  }

  visit(0, []);
  return combinations;
}

function processWindows(
  windows: readonly WindowBundle[],
  options: CliOptions,
  onCurrentPredictor: (predictor: string, rawValue: number, chainlinkNow: number) => void,
  onFuturePredictor: (
    predictor: string,
    horizonMs: number,
    rawValue: number,
    chainlinkNow: number,
    chainlinkFuture: number,
  ) => void,
): ProcessSummary {
  const combinations = buildVenueCombinations(options.venues, options.maxComboSize);
  const summary: ProcessSummary = {
    windowCount: 0,
    chainlinkTicks: 0,
    evalPoints: 0,
  };

  for (const bundle of windows) {
    const chainlinkTicks = parseChainlinkTicks(bundle.polymarketFile);
    if (chainlinkTicks.length < 2) {
      continue;
    }

    const futureByHorizon = new Map<number, number[]>();
    for (const horizonMs of options.horizonsMs) {
      futureByHorizon.set(horizonMs, buildFutureIndices(chainlinkTicks, horizonMs));
    }

    const venueEvents = new Map<Venue, CexEvent[]>();
    for (const venue of options.venues) {
      const filePath = bundle.cexFiles[venue];
      venueEvents.set(venue, filePath ? parseCexEvents(filePath) : []);
    }

    const venueStates = new Map<Venue, VenueState>();
    const venuePointers = new Map<Venue, number>();
    for (const venue of options.venues) {
      venueStates.set(venue, createVenueState());
      venuePointers.set(venue, 0);
    }

    summary.windowCount++;
    summary.chainlinkTicks += chainlinkTicks.length;

    for (let tickIndex = 0; tickIndex < chainlinkTicks.length; tickIndex++) {
      const tick = chainlinkTicks[tickIndex];
      const predictorValues = new Map<string, number>();
      const freshSnapshots = new Map<Venue, VenueSignalSnapshot>();

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
        for (const [predictor, rawValue] of Object.entries(built.values)) {
          predictorValues.set(predictor, rawValue);
        }
        if (built.snapshot) {
          freshSnapshots.set(venue, built.snapshot);
        }
      }

      if (freshSnapshots.size >= 2) {
        const microValues = [...freshSnapshots.values()].map((snapshot) => snapshot.micro);
        predictorValues.set('agg::median_micro_all', median(microValues));

        let weightedNumerator = 0;
        let weightedDenominator = 0;
        for (const snapshot of freshSnapshots.values()) {
          const weight = 1 / Math.max(snapshot.spreadBps, 0.05) / (1 + snapshot.ageMs / 1_000);
          weightedNumerator += snapshot.micro * weight;
          weightedDenominator += weight;
        }

        if (weightedDenominator > 0) {
          predictorValues.set('agg::weighted_micro_all', weightedNumerator / weightedDenominator);
        }
      }

      for (const venues of combinations) {
        const snapshots = venues.map((venue) => freshSnapshots.get(venue)).filter(Boolean) as VenueSignalSnapshot[];
        if (snapshots.length !== venues.length) {
          continue;
        }
        const name = `combo::median_micro(${venues.join('+')})`;
        predictorValues.set(name, median(snapshots.map((snapshot) => snapshot.micro)));
      }

      if (predictorValues.size === 0) {
        continue;
      }

      summary.evalPoints++;

      for (const [predictor, rawValue] of predictorValues.entries()) {
        onCurrentPredictor(predictor, rawValue, tick.price);
      }

      for (const horizonMs of options.horizonsMs) {
        const futureIndex = futureByHorizon.get(horizonMs)?.[tickIndex] ?? -1;
        if (futureIndex < 0) {
          continue;
        }

        const futurePrice = chainlinkTicks[futureIndex].price;
        for (const [predictor, rawValue] of predictorValues.entries()) {
          onFuturePredictor(predictor, horizonMs, rawValue, tick.price, futurePrice);
        }
      }
    }
  }

  return summary;
}

function getMetricAccumulator(
  store: Map<string, SampleAccumulator>,
  predictor: string,
  horizonMs: number,
): SampleAccumulator {
  const key = `${predictor}@@${horizonMs}`;
  const existing = store.get(key);
  if (existing) {
    return existing;
  }

  const created: SampleAccumulator = {
    predictor,
    horizonMs,
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
  store.set(key, created);
  return created;
}

function classifyPredictor(predictor: string): MetricResult['predictorType'] {
  if (predictor.startsWith('combo::')) return 'combo';
  if (predictor.startsWith('agg::')) return 'aggregate';
  return 'single';
}

function finalizeMetrics(
  metrics: readonly SampleAccumulator[],
  basisByPredictor: ReadonlyMap<string, number>,
): MetricResult[] {
  return metrics
    .filter((metric) => metric.n > 0)
    .map((metric) => {
      const basis = basisByPredictor.get(metric.predictor) ?? 0;
      const predVar = metric.predDeltaSqSum - metric.predDeltaSum ** 2 / metric.n;
      const trueVar = metric.trueDeltaSqSum - metric.trueDeltaSum ** 2 / metric.n;
      const covariance = metric.crossSum - metric.predDeltaSum * metric.trueDeltaSum / metric.n;

      const corr = predVar > 0 && trueVar > 0
        ? covariance / Math.sqrt(predVar * trueVar)
        : undefined;

      return {
        predictor: metric.predictor,
        predictorType: classifyPredictor(metric.predictor),
        horizonMs: metric.horizonMs,
        n: metric.n,
        basis,
        mae: metric.absErrSum / metric.n,
        rmse: Math.sqrt(metric.sqErrSum / metric.n),
        baselineMae: metric.baselineAbsErrSum / metric.n,
        baselineRmse: Math.sqrt(metric.baselineSqErrSum / metric.n),
        improvementPct: metric.baselineAbsErrSum === 0
          ? 0
          : (1 - metric.absErrSum / metric.baselineAbsErrSum) * 100,
        directionHitRate: metric.signEvaluated > 0 ? metric.signMatches / metric.signEvaluated : undefined,
        corr,
      };
    });
}

function pickBestByPredictor(
  metrics: readonly MetricResult[],
  minSamples: number,
): MetricResult[] {
  const bestByPredictor = new Map<string, MetricResult>();

  for (const metric of metrics) {
    if (metric.n < minSamples || metric.horizonMs === 0) {
      continue;
    }

    const existing = bestByPredictor.get(metric.predictor);
    if (
      !existing
      || metric.improvementPct > existing.improvementPct
      || (metric.improvementPct === existing.improvementPct && metric.mae < existing.mae)
    ) {
      bestByPredictor.set(metric.predictor, metric);
    }
  }

  return [...bestByPredictor.values()].sort((left, right) => {
    if (right.improvementPct !== left.improvementPct) {
      return right.improvementPct - left.improvementPct;
    }
    return left.mae - right.mae;
  });
}

function pickBestByPredictorWithComparator(
  metrics: readonly MetricResult[],
  minSamples: number,
  isBetter: (candidate: MetricResult, incumbent: MetricResult) => boolean,
): MetricResult[] {
  const bestByPredictor = new Map<string, MetricResult>();

  for (const metric of metrics) {
    if (metric.n < minSamples || metric.horizonMs === 0) {
      continue;
    }

    const existing = bestByPredictor.get(metric.predictor);
    if (!existing || isBetter(metric, existing)) {
      bestByPredictor.set(metric.predictor, metric);
    }
  }

  return [...bestByPredictor.values()];
}

function formatMetricRows(metrics: readonly MetricResult[]): RenderRow[] {
  return metrics.map((metric) => ({
    predictor: metric.predictor,
    horizon: `${metric.horizonMs}ms`,
    samples: metric.n.toString(),
    mae: metric.mae.toFixed(3),
    baseline: metric.baselineMae.toFixed(3),
    improve: `${metric.improvementPct.toFixed(2)}%`,
    hit: metric.directionHitRate === undefined ? '-' : `${(metric.directionHitRate * 100).toFixed(1)}%`,
    corr: metric.corr === undefined ? '-' : metric.corr.toFixed(3),
    basis: metric.basis.toFixed(3),
  }));
}

function renderTable(rows: readonly RenderRow[]): string {
  if (rows.length === 0) {
    return '(no rows)';
  }

  const headers: RenderRow = {
    predictor: 'predictor',
    horizon: 'horizon',
    samples: 'samples',
    mae: 'mae',
    baseline: 'baseline',
    improve: 'improve',
    hit: 'hit',
    corr: 'corr',
    basis: 'basis',
  };

  const columns: (keyof RenderRow)[] = ['predictor', 'horizon', 'samples', 'mae', 'baseline', 'improve', 'hit', 'corr', 'basis'];
  const widths = new Map<keyof RenderRow, number>();

  for (const column of columns) {
    const width = Math.max(headers[column].length, ...rows.map((row) => row[column].length));
    widths.set(column, width);
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

function buildJsonResult(
  options: CliOptions,
  summary: ProcessSummary,
  metrics: readonly MetricResult[],
  bestByPredictor: readonly MetricResult[],
): Record<string, unknown> {
  const bestByCorrelation = pickBestByPredictorWithComparator(
    metrics,
    options.minSamples,
    (candidate, incumbent) => {
      const candidateCorr = candidate.corr ?? Number.NEGATIVE_INFINITY;
      const incumbentCorr = incumbent.corr ?? Number.NEGATIVE_INFINITY;
      if (candidateCorr !== incumbentCorr) {
        return candidateCorr > incumbentCorr;
      }
      if ((candidate.directionHitRate ?? Number.NEGATIVE_INFINITY) !== (incumbent.directionHitRate ?? Number.NEGATIVE_INFINITY)) {
        return (candidate.directionHitRate ?? Number.NEGATIVE_INFINITY) > (incumbent.directionHitRate ?? Number.NEGATIVE_INFINITY);
      }
      return candidate.mae < incumbent.mae;
    },
  ).sort((left, right) => {
    const leftCorr = left.corr ?? Number.NEGATIVE_INFINITY;
    const rightCorr = right.corr ?? Number.NEGATIVE_INFINITY;
    if (rightCorr !== leftCorr) {
      return rightCorr - leftCorr;
    }
    return left.mae - right.mae;
  });

  const bestByDirection = pickBestByPredictorWithComparator(
    metrics,
    options.minSamples,
    (candidate, incumbent) => {
      const candidateHit = candidate.directionHitRate ?? Number.NEGATIVE_INFINITY;
      const incumbentHit = incumbent.directionHitRate ?? Number.NEGATIVE_INFINITY;
      if (candidateHit !== incumbentHit) {
        return candidateHit > incumbentHit;
      }
      const candidateCorr = candidate.corr ?? Number.NEGATIVE_INFINITY;
      const incumbentCorr = incumbent.corr ?? Number.NEGATIVE_INFINITY;
      if (candidateCorr !== incumbentCorr) {
        return candidateCorr > incumbentCorr;
      }
      return candidate.mae < incumbent.mae;
    },
  ).sort((left, right) => {
    const leftHit = left.directionHitRate ?? Number.NEGATIVE_INFINITY;
    const rightHit = right.directionHitRate ?? Number.NEGATIVE_INFINITY;
    if (rightHit !== leftHit) {
      return rightHit - leftHit;
    }
    return left.mae - right.mae;
  });

  const topSingles = bestByPredictor.filter((metric) => metric.predictorType === 'single').slice(0, options.topLimit);
  const topAggregates = bestByPredictor.filter((metric) => metric.predictorType === 'aggregate').slice(0, options.topLimit);
  const topCombos = bestByPredictor.filter((metric) => metric.predictorType === 'combo').slice(0, options.topLimit);

  const byHorizon = options.horizonsMs.map((horizonMs) => ({
    horizonMs,
    top: metrics
      .filter((metric) => metric.horizonMs === horizonMs && metric.n >= options.minSamples)
      .sort((left, right) => {
        if (right.improvementPct !== left.improvementPct) {
          return right.improvementPct - left.improvementPct;
        }
        return left.mae - right.mae;
      })
      .slice(0, options.topLimit),
  }));

  return {
    options,
    summary,
    metrics,
    topSingles,
    topAggregates,
    topCombos,
    bestByImprovement: bestByPredictor,
    bestByCorrelation,
    bestByDirection,
    byHorizon,
  };
}

function renderTextResult(
  options: CliOptions,
  summary: ProcessSummary,
  metrics: readonly MetricResult[],
  bestByPredictor: readonly MetricResult[],
): string {
  const bestByCorrelation = pickBestByPredictorWithComparator(
    metrics,
    options.minSamples,
    (candidate, incumbent) => {
      const candidateCorr = candidate.corr ?? Number.NEGATIVE_INFINITY;
      const incumbentCorr = incumbent.corr ?? Number.NEGATIVE_INFINITY;
      if (candidateCorr !== incumbentCorr) {
        return candidateCorr > incumbentCorr;
      }
      if ((candidate.directionHitRate ?? Number.NEGATIVE_INFINITY) !== (incumbent.directionHitRate ?? Number.NEGATIVE_INFINITY)) {
        return (candidate.directionHitRate ?? Number.NEGATIVE_INFINITY) > (incumbent.directionHitRate ?? Number.NEGATIVE_INFINITY);
      }
      return candidate.mae < incumbent.mae;
    },
  ).sort((left, right) => {
    const leftCorr = left.corr ?? Number.NEGATIVE_INFINITY;
    const rightCorr = right.corr ?? Number.NEGATIVE_INFINITY;
    if (rightCorr !== leftCorr) {
      return rightCorr - leftCorr;
    }
    return left.mae - right.mae;
  });

  const bestByDirection = pickBestByPredictorWithComparator(
    metrics,
    options.minSamples,
    (candidate, incumbent) => {
      const candidateHit = candidate.directionHitRate ?? Number.NEGATIVE_INFINITY;
      const incumbentHit = incumbent.directionHitRate ?? Number.NEGATIVE_INFINITY;
      if (candidateHit !== incumbentHit) {
        return candidateHit > incumbentHit;
      }
      const candidateCorr = candidate.corr ?? Number.NEGATIVE_INFINITY;
      const incumbentCorr = incumbent.corr ?? Number.NEGATIVE_INFINITY;
      if (candidateCorr !== incumbentCorr) {
        return candidateCorr > incumbentCorr;
      }
      return candidate.mae < incumbent.mae;
    },
  ).sort((left, right) => {
    const leftHit = left.directionHitRate ?? Number.NEGATIVE_INFINITY;
    const rightHit = right.directionHitRate ?? Number.NEGATIVE_INFINITY;
    if (rightHit !== leftHit) {
      return rightHit - leftHit;
    }
    return left.mae - right.mae;
  });

  const lines: string[] = [];
  lines.push(`Snapshot dir: ${options.snapshotDir}`);
  lines.push(
    `Windows=${summary.windowCount} ChainlinkTicks=${summary.chainlinkTicks} `
    + `EvalPoints=${summary.evalPoints} Venues=${options.venues.join(',')}`,
  );
  lines.push(
    `Horizons=${options.horizonsMs.join(',')}ms Staleness=${options.venueStalenessMs}ms `
    + `TradeLookback=${options.tradeLookbackMs}ms MinSamples=${options.minSamples}`,
  );
  lines.push('');

  const topSingles = bestByPredictor.filter((metric) => metric.predictorType === 'single').slice(0, options.topLimit);
  const topAggregates = bestByPredictor.filter((metric) => metric.predictorType === 'aggregate').slice(0, options.topLimit);
  const topCombos = bestByPredictor.filter((metric) => metric.predictorType === 'combo').slice(0, options.topLimit);

  lines.push('Best Single Predictors (non-zero horizons)');
  lines.push(renderTable(formatMetricRows(topSingles)));
  lines.push('');

  lines.push('Best Aggregate Predictors (non-zero horizons)');
  lines.push(renderTable(formatMetricRows(topAggregates)));
  lines.push('');

  lines.push('Best Fixed Venue Combinations (non-zero horizons)');
  lines.push(renderTable(formatMetricRows(topCombos)));
  lines.push('');

  lines.push('Peak Lead By Correlation');
  lines.push(renderTable(formatMetricRows(bestByCorrelation.slice(0, options.topLimit))));
  lines.push('');

  lines.push('Peak Lead By Direction Hit Rate');
  lines.push(renderTable(formatMetricRows(bestByDirection.slice(0, options.topLimit))));
  lines.push('');

  for (const horizonMs of options.horizonsMs) {
    const topAtHorizon = metrics
      .filter((metric) => metric.horizonMs === horizonMs && metric.n >= options.minSamples)
      .sort((left, right) => {
        if (right.improvementPct !== left.improvementPct) {
          return right.improvementPct - left.improvementPct;
        }
        return left.mae - right.mae;
      })
      .slice(0, options.topLimit);

    lines.push(`Top Predictors At ${horizonMs}ms`);
    lines.push(renderTable(formatMetricRows(topAtHorizon)));
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function main(): void {
  const options = parseCli(process.argv.slice(2));
  const windows = discoverWindows(options);
  if (windows.length === 0) {
    throw new Error(`No matched windows found in ${options.snapshotDir}`);
  }

  const basisSamples = new Map<string, number[]>();
  const summary = processWindows(
    windows,
    options,
    (predictor, rawValue, chainlinkNow) => {
      const samples = basisSamples.get(predictor) ?? [];
      samples.push(rawValue - chainlinkNow);
      basisSamples.set(predictor, samples);
    },
    () => {},
  );

  const basisByPredictor = new Map<string, number>();
  for (const [predictor, samples] of basisSamples.entries()) {
    if (samples.length > 0) {
      basisByPredictor.set(predictor, median(samples));
    }
  }

  const metricStore = new Map<string, SampleAccumulator>();
  processWindows(
    windows,
    options,
    () => {},
    (predictor, horizonMs, rawValue, chainlinkNow, chainlinkFuture) => {
      const basis = basisByPredictor.get(predictor) ?? 0;
      const prediction = rawValue - basis;
      const error = prediction - chainlinkFuture;
      const baselineError = chainlinkNow - chainlinkFuture;
      const predDelta = prediction - chainlinkNow;
      const trueDelta = chainlinkFuture - chainlinkNow;

      const metric = getMetricAccumulator(metricStore, predictor, horizonMs);
      metric.n++;
      metric.absErrSum += Math.abs(error);
      metric.sqErrSum += error * error;
      metric.baselineAbsErrSum += Math.abs(baselineError);
      metric.baselineSqErrSum += baselineError * baselineError;
      metric.predDeltaSum += predDelta;
      metric.trueDeltaSum += trueDelta;
      metric.predDeltaSqSum += predDelta * predDelta;
      metric.trueDeltaSqSum += trueDelta * trueDelta;
      metric.crossSum += predDelta * trueDelta;

      if (predDelta !== 0 && trueDelta !== 0) {
        metric.signEvaluated++;
        if (Math.sign(predDelta) === Math.sign(trueDelta)) {
          metric.signMatches++;
        }
      }
    },
  );

  const metrics = finalizeMetrics([...metricStore.values()], basisByPredictor);
  const bestByPredictor = pickBestByPredictor(metrics, options.minSamples);

  if (options.json) {
    console.log(JSON.stringify(buildJsonResult(options, summary, metrics, bestByPredictor), null, 2));
    return;
  }

  console.log(renderTextResult(options, summary, metrics, bestByPredictor));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
