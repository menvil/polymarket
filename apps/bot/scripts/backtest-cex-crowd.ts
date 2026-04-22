/**
 * Сравнивает crowd-only, crowd+CEX и CEX-only входы на Polymarket snapshots.
 *
 * @remarks
 * Модель намеренно offline/аналитическая:
 * - crowd берётся из готовой market-weighted edge-table;
 * - CEX-модель обучается только на рынках `endDate <= --train-until`;
 * - оценка идёт только на OOS-рынках после `--train-until`;
 * - fill-sim: maker BUY по `bestBid+1`, fill если будущий `bestAsk <= entryBid`;
 * - удержание до settlement, без exit-policy, чтобы сравнить именно entry filters.
 *
 * @example
 * ```bash
 * cd apps/bot
 * S=/Users/menvil/Projects/polymarket/apps/collect-data/snapshots
 * npx tsx scripts/backtest-cex-crowd.ts \
 *   --snapshots "$S/2026-04-19/polymarket,$S/2026-04-20/polymarket,$S/2026-04-21/polymarket" \
 *   --train-until 2026-04-21 \
 *   --table tables/edge-table-5min.json \
 *   --asset bitcoin --token up
 * ```
 */
/* eslint-disable no-console */
import { existsSync, readFileSync, readdirSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { EdgeTable, type EdgeZone, type Regime } from '../src/strategies/calibrated-crowd/EdgeTable.js';
import { classifyRegime, parseSnapshot, type MarketData, type Observation } from './analyze-crowd-calibration.js';
import {
  applyEvent,
  buildVenuePredictors,
  createVenueState,
  median,
  parseCexEvents,
  pruneTrades,
} from '../../collect-data/src/analyzeChainlinkLeadLag.js';
import type { CexEvent, Venue } from '../../collect-data/src/analyzeChainlinkLeadLag.js';

type ModeName = 'crowd_only' | 'crowd_cex_agree' | 'crowd_cex_not_adverse' | 'cex_only';
type CexDirection = 'UP' | 'DOWN' | 'FLAT';
type CrowdGate = 'strict' | 'relaxed';
type EntryMode = 'maker' | 'taker';
type ExitMode = 'expiry' | 'horizon';
type MakerCancelPolicy = 'conditions' | 'gtc' | 'time';

const MODES: readonly ModeName[] = ['crowd_only', 'crowd_cex_agree', 'crowd_cex_not_adverse', 'cex_only'];
const DEFAULT_VENUES: readonly Venue[] = ['binance', 'coinbase', 'okx'];
const MONTHS: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

interface Config {
  readonly snapshotDirs: readonly string[];
  readonly tablePath: string;
  readonly trainUntilMs: number;
  readonly asset: string;
  readonly token: 'up' | 'down';
  readonly venues: readonly Venue[];
  readonly horizonMs: number;
  readonly cexThresholdBps: number;
  readonly cexStalenessMs: number;
  readonly cexWarmupMs: number;
  readonly maxSpreadBps: number;
  readonly minComposite: number;
  readonly crowdGate: CrowdGate;
  readonly relaxedMinN: number;
  readonly relaxedMinEdge: number;
  readonly relaxedMinCiEdge: number;
  readonly relaxedRequireOos: boolean;
  readonly warmupSec: number;
  readonly maxEntryTauSec: number;
  readonly approxResolution: boolean;
  readonly shares: number;
  readonly minOrderValue: number;
  readonly minOrderSize: number;
  readonly ridgeLambda: number;
  readonly entryMode: EntryMode;
  readonly exitMode: ExitMode;
  readonly exitAfterMs: number;
  readonly maxFillWaitMs: number | null;
  readonly makerCancelPolicy: MakerCancelPolicy;
  readonly sweep: boolean;
  readonly sweepMode: ModeName;
  readonly sweepRelaxedMinEdges: readonly number[];
  readonly sweepCexThresholdBps: readonly number[];
  readonly sweepMinComposites: readonly number[];
  readonly sweepTop: number;
  readonly sweepMinFills: number;
  readonly showTrades: number;
  readonly showTradesMode: ModeName;
}

interface SnapshotInputDir {
  readonly polymarketDir: string;
  readonly dayDir: string;
}

interface MarketBundle {
  readonly filePath: string;
  readonly market: MarketData;
  readonly rows: readonly CexRow[];
}

interface CexVenueObservation {
  readonly micro: number;
  readonly spreadBps: number;
  readonly ageMs: number;
}

interface CexRow {
  readonly tsMs: number;
  readonly chainlinkPrice: number;
  readonly venues: Partial<Record<Venue, CexVenueObservation>>;
}

interface CexSidecarFile {
  readonly venue: Venue;
  readonly symbol: string;
  readonly asset: string;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly filePath: string;
}

interface CexLinearModel {
  readonly venues: readonly Venue[];
  readonly basisByVenue: Readonly<Record<Venue, number>>;
  readonly intercept: number;
  readonly weights: readonly number[];
  readonly trainSamples: number;
  readonly trainHitRate: number;
  readonly trainCorr: number;
  readonly trainMae: number;
  readonly trainBaselineMae: number;
}

interface CexPrediction {
  readonly direction: CexDirection;
  readonly predDeltaUsd: number;
  readonly predBps: number;
}

interface EntryAttempt {
  readonly mode: ModeName;
  readonly slug: string;
  readonly day: string;
  readonly attempted: true;
  readonly filled: boolean;
  readonly fillIndex: number | null;
  readonly entryIndex: number;
  readonly entryTsMs: number;
  readonly entryTauSec: number;
  readonly fillTsMs: number | null;
  readonly fillTauSec: number | null;
  readonly entryBidCents: number;
  readonly entryFillPriceCents: number;
  readonly exitPriceCents: number | null;
  readonly exitTsMs: number | null;
  readonly exitReason: string;
  readonly holdSec: number | null;
  readonly shares: number;
  readonly notional: number;
  readonly resolution: 'UP' | 'DOWN';
  readonly pnlPerShare: number;
  readonly pnlDollars: number;
  readonly crowdZone: EdgeZone | null;
  readonly cex: CexPrediction | null;
}

interface ModeStats {
  readonly mode: ModeName;
  readonly attempts: readonly EntryAttempt[];
  readonly attempted: number;
  readonly filled: number;
  readonly wins: number;
  readonly fillRate: number;
  readonly winRate: number;
  readonly pnl: number;
  readonly pnlPerShare: number;
  readonly avgEntryCents: number;
  readonly avgHoldSec: number;
  readonly avgPredBps: number | null;
  readonly cexUp: number;
  readonly cexFlat: number;
  readonly cexDown: number;
  readonly horizonExits: number;
}

interface TrainSample {
  readonly features: readonly number[];
  readonly targetDeltaUsd: number;
}

interface SweepRow {
  readonly mode: ModeName;
  readonly relaxedMinEdge: number;
  readonly cexThresholdBps: number;
  readonly minComposite: number;
  readonly attempted: number;
  readonly filled: number;
  readonly winRate: number;
  readonly fillRate: number;
  readonly pnl: number;
  readonly pnlPerShare: number;
  readonly avgEntryCents: number;
  readonly score: number;
}

interface EntrySignal {
  readonly zone: EdgeZone | null;
  readonly cex: CexPrediction | null;
  readonly quotedEntryCents: number;
  readonly entryBidCents: number;
  readonly allowed: boolean;
}

function usage(): string {
  return [
    'Usage:',
    '  npx tsx scripts/backtest-cex-crowd.ts \\',
    '    --snapshots dir1,dir2,... \\',
    '    --train-until YYYY-MM-DD \\',
    '    --table tables/edge-table-5min.json \\',
    '    [--asset bitcoin] [--token up] [--venues binance,coinbase,okx]',
    '',
    'Useful variants:',
    '  --crowd-gate relaxed --relaxed-min-edge 0.01 --relaxed-min-ci-edge -1 --min-composite 0',
    '  --entry-mode taker --exit-mode horizon --horizon-ms 2000 --exit-after-ms 2000',
    '  --maker-cancel-policy conditions  # keep maker order only while entry conditions hold',
    '  --sweep --sweep-mode crowd_cex_not_adverse',
    '  --show-trades 20 --show-trades-mode crowd_cex_not_adverse',
    '',
    'Notes:',
    '  --snapshots can point to date dirs or date/polymarket dirs.',
    '  CEX sidecars are loaded from sibling date/{binance,coinbase,okx,...} dirs.',
  ].join('\n');
}

function parseCli(): Config {
  const argv = process.argv.slice(2);
  let snapshotDirs: string[] = [];
  let tablePath = 'tables/edge-table-5min.json';
  let trainUntilMs = 0;
  let asset = 'bitcoin';
  let token: 'up' | 'down' = 'up';
  let venues = [...DEFAULT_VENUES];
  let horizonMs = 2_000;
  let cexThresholdBps = 0.5;
  let cexStalenessMs = 2_000;
  let cexWarmupMs = 30_000;
  let maxSpreadBps = 10;
  let minComposite = 0.3;
  let crowdGate: CrowdGate = 'strict';
  let relaxedMinN = 20;
  let relaxedMinEdge = 0.03;
  let relaxedMinCiEdge = 0.02;
  let relaxedRequireOos = false;
  let warmupSec = 15;
  let maxEntryTauSec = 300;
  let approxResolution = true;
  let shares = 5;
  let minOrderValue = 1;
  let minOrderSize = 5;
  let ridgeLambda = 1;
  let entryMode: EntryMode = 'maker';
  let exitMode: ExitMode = 'expiry';
  let exitAfterMs = 2_000;
  let maxFillWaitMs: number | null = null;
  let makerCancelPolicy: MakerCancelPolicy = 'conditions';
  let sweep = false;
  let sweepMode: ModeName = 'crowd_cex_not_adverse';
  let sweepRelaxedMinEdges = [0, 0.005, 0.01, 0.02, 0.03];
  let sweepCexThresholdBps = [0.25, 0.5, 0.75, 1.0, 1.5];
  let sweepMinComposites = [0, 0.05, 0.1, 0.2, 0.3];
  let sweepTop = 20;
  let sweepMinFills = 20;
  let showTrades = 0;
  let showTradesMode: ModeName = 'crowd_cex_not_adverse';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    if (arg === '--snapshots' && next) { snapshotDirs = next.split(',').map((item) => item.trim()).filter(Boolean); i++; }
    else if (arg === '--table' && next) { tablePath = next; i++; }
    else if (arg === '--train-until' && next) { trainUntilMs = new Date(next).getTime(); i++; }
    else if (arg === '--asset' && next) { asset = next.toLowerCase(); i++; }
    else if (arg === '--token' && next) { token = next as 'up' | 'down'; i++; }
    else if (arg === '--venues' && next) { venues = parseVenues(next); i++; }
    else if (arg === '--horizon-ms' && next) { horizonMs = Number(next); i++; }
    else if (arg === '--cex-threshold-bps' && next) { cexThresholdBps = Number(next); i++; }
    else if (arg === '--cex-staleness-ms' && next) { cexStalenessMs = Number(next); i++; }
    else if (arg === '--cex-warmup-ms' && next) { cexWarmupMs = Number(next); i++; }
    else if (arg === '--max-spread-bps' && next) { maxSpreadBps = Number(next); i++; }
    else if (arg === '--min-composite' && next) { minComposite = Number(next); i++; }
    else if (arg === '--crowd-gate' && next) { crowdGate = parseCrowdGate(next); i++; }
    else if (arg === '--relaxed-min-n' && next) { relaxedMinN = Number(next); i++; }
    else if (arg === '--relaxed-min-edge' && next) { relaxedMinEdge = Number(next); i++; }
    else if (arg === '--relaxed-min-ci-edge' && next) { relaxedMinCiEdge = Number(next); i++; }
    else if (arg === '--relaxed-require-oos') { relaxedRequireOos = true; }
    else if (arg === '--warmup-sec' && next) { warmupSec = Number(next); i++; }
    else if (arg === '--max-entry-tau-sec' && next) { maxEntryTauSec = Number(next); i++; }
    else if (arg === '--shares' && next) { shares = Number(next); i++; }
    else if (arg === '--min-order-value' && next) { minOrderValue = Number(next); i++; }
    else if (arg === '--min-order-size' && next) { minOrderSize = Number(next); i++; }
    else if (arg === '--ridge-lambda' && next) { ridgeLambda = Number(next); i++; }
    else if (arg === '--entry-mode' && next) { entryMode = parseEntryMode(next); i++; }
    else if (arg === '--exit-mode' && next) { exitMode = parseExitMode(next); i++; }
    else if (arg === '--exit-after-ms' && next) { exitAfterMs = Number(next); i++; }
    else if (arg === '--max-fill-wait-ms' && next) { maxFillWaitMs = Number(next); i++; }
    else if (arg === '--maker-cancel-policy' && next) { makerCancelPolicy = parseMakerCancelPolicy(next); i++; }
    else if (arg === '--sweep') { sweep = true; }
    else if (arg === '--sweep-mode' && next) { sweepMode = parseModeName(next); i++; }
    else if (arg === '--sweep-relaxed-min-edge' && next) { sweepRelaxedMinEdges = parseNumberList(next); i++; }
    else if (arg === '--sweep-cex-threshold-bps' && next) { sweepCexThresholdBps = parseNumberList(next); i++; }
    else if (arg === '--sweep-min-composite' && next) { sweepMinComposites = parseNumberList(next); i++; }
    else if (arg === '--sweep-top' && next) { sweepTop = Number(next); i++; }
    else if (arg === '--sweep-min-fills' && next) { sweepMinFills = Number(next); i++; }
    else if (arg === '--show-trades' && next) { showTrades = Number(next); i++; }
    else if (arg === '--show-trades-mode' && next) { showTradesMode = parseModeName(next); i++; }
    else if (arg === '--no-approx-resolution') { approxResolution = false; }
    else if (arg === '--help' || arg === '-h') { console.log(usage()); process.exit(0); }
    else {
      throw new Error(`Unknown or incomplete argument: ${arg}\n\n${usage()}`);
    }
  }

  if (snapshotDirs.length === 0 || !Number.isFinite(trainUntilMs) || trainUntilMs <= 0) {
    throw new Error(usage());
  }
  if (token !== 'up' && token !== 'down') throw new Error('--token must be up|down');
  if (venues.length === 0) throw new Error('--venues must be non-empty');
  for (const [name, value] of Object.entries({ horizonMs, cexThresholdBps, cexStalenessMs, maxSpreadBps, shares, exitAfterMs })) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  }
  if (maxFillWaitMs !== null && (!Number.isFinite(maxFillWaitMs) || maxFillWaitMs < 0)) {
    throw new Error('--max-fill-wait-ms must be >= 0');
  }
  if (sweepTop <= 0 || sweepMinFills < 0) throw new Error('--sweep-top must be > 0 and --sweep-min-fills must be >= 0');
  if (!Number.isFinite(showTrades) || showTrades < 0) throw new Error('--show-trades must be >= 0');

  return {
    snapshotDirs,
    tablePath,
    trainUntilMs,
    asset,
    token,
    venues,
    horizonMs,
    cexThresholdBps,
    cexStalenessMs,
    cexWarmupMs,
    maxSpreadBps,
    minComposite,
    crowdGate,
    relaxedMinN,
    relaxedMinEdge,
    relaxedMinCiEdge,
    relaxedRequireOos,
    warmupSec,
    maxEntryTauSec,
    approxResolution,
    shares,
    minOrderValue,
    minOrderSize,
    ridgeLambda,
    entryMode,
    exitMode,
    exitAfterMs,
    maxFillWaitMs: maxFillWaitMs ?? (exitMode === 'horizon' && entryMode === 'maker' ? horizonMs : null),
    makerCancelPolicy,
    sweep,
    sweepMode,
    sweepRelaxedMinEdges,
    sweepCexThresholdBps,
    sweepMinComposites,
    sweepTop,
    sweepMinFills,
    showTrades,
    showTradesMode,
  };
}

function parseCrowdGate(raw: string): CrowdGate {
  if (raw === 'strict' || raw === 'relaxed') return raw;
  throw new Error(`--crowd-gate must be strict|relaxed, got ${raw}`);
}

function parseEntryMode(raw: string): EntryMode {
  if (raw === 'maker' || raw === 'taker') return raw;
  throw new Error(`--entry-mode must be maker|taker, got ${raw}`);
}

function parseExitMode(raw: string): ExitMode {
  if (raw === 'expiry' || raw === 'horizon') return raw;
  throw new Error(`--exit-mode must be expiry|horizon, got ${raw}`);
}

function parseMakerCancelPolicy(raw: string): MakerCancelPolicy {
  if (raw === 'conditions' || raw === 'gtc' || raw === 'time') return raw;
  throw new Error(`--maker-cancel-policy must be conditions|gtc|time, got ${raw}`);
}

function parseModeName(raw: string): ModeName {
  if (raw === 'crowd_only' || raw === 'crowd_cex_agree' || raw === 'crowd_cex_not_adverse' || raw === 'cex_only') {
    return raw;
  }
  throw new Error(`--sweep-mode must be one of ${MODES.join('|')}, got ${raw}`);
}

function parseNumberList(raw: string): number[] {
  const values = raw.split(',').map((item) => Number(item.trim())).filter((value) => Number.isFinite(value));
  if (values.length === 0) throw new Error(`Expected comma-separated numeric list, got "${raw}"`);
  return values;
}

function parseVenues(raw: string): Venue[] {
  const result: Venue[] = [];
  for (const item of raw.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean)) {
    const venue = normalizeVenue(item);
    if (!venue) throw new Error(`Unsupported venue: ${item}`);
    result.push(venue);
  }
  return result;
}

function normalizeVenue(raw: string): Venue | undefined {
  if (raw === 'binance' || raw === 'coinbase' || raw === 'okx' || raw === 'cryptocom' || raw === 'kraken') {
    return raw;
  }
  return undefined;
}

function normalizeSnapshotDir(input: string): SnapshotInputDir {
  const resolved = resolve(input);
  if (basename(resolved) === 'polymarket') {
    return { polymarketDir: resolved, dayDir: dirname(resolved) };
  }
  return { polymarketDir: join(resolved, 'polymarket'), dayDir: resolved };
}

function collectPolymarketFiles(inputDirs: readonly SnapshotInputDir[], asset: string): string[] {
  const files: string[] = [];
  for (const input of inputDirs) {
    if (!existsSync(input.polymarketDir)) continue;
    for (const entry of readdirSync(input.polymarketDir)) {
      const lower = entry.toLowerCase();
      if (!lower.includes(asset.toLowerCase())) continue;
      if (!lower.endsWith('.jsonl') && !lower.endsWith('.jsonl.gz')) continue;
      files.push(join(input.polymarketDir, entry));
    }
  }
  return files.sort();
}

function buildCexIndex(inputDirs: readonly SnapshotInputDir[], venues: readonly Venue[], asset: string): CexSidecarFile[] {
  const wantedAsset = assetToCexBase(asset);
  const wantedVenues = new Set(venues);
  const indexed: CexSidecarFile[] = [];

  for (const input of inputDirs) {
    for (const venue of venues) {
      const venueDir = join(input.dayDir, venue);
      if (!existsSync(venueDir)) continue;
      for (const entry of readdirSync(venueDir)) {
        if (!entry.endsWith('.jsonl') && !entry.endsWith('.jsonl.gz')) continue;
        const meta = parseCexFileName(entry);
        if (!meta || !wantedVenues.has(meta.venue)) continue;
        if (meta.asset !== wantedAsset) continue;
        indexed.push({ ...meta, filePath: join(venueDir, entry) });
      }
    }
  }

  return indexed.sort((left, right) => left.windowStartMs - right.windowStartMs || left.filePath.localeCompare(right.filePath));
}

function parseCexFileName(fileName: string): Omit<CexSidecarFile, 'filePath'> | null {
  const match = fileName.match(/^([a-z0-9]+)_([A-Za-z0-9-]+)_(?:spot|futures|swap)_(\d{4})-([A-Za-z]+)-(\d{1,2})_(\d{1,4}(?:AM|PM))-(\d{1,4}(?:AM|PM))_ET\.jsonl(?:\.gz)?$/);
  if (!match) return null;

  const venue = normalizeVenue(match[1]!);
  const symbol = match[2]!.replace('-', '/');
  const year = Number(match[3]);
  const month = MONTHS[match[4]!.toLowerCase()];
  const day = Number(match[5]);
  const start = parseEtClock(match[6]!);
  const end = parseEtClock(match[7]!);
  if (!venue || month === undefined || !start || !end) return null;

  const windowStartMs = zonedDateTimeToUtcMs(year, month, day, start.hour, start.minute);
  let windowEndMs = zonedDateTimeToUtcMs(year, month, day, end.hour, end.minute);
  if (windowEndMs <= windowStartMs) windowEndMs += 24 * 60 * 60 * 1000;

  return {
    venue,
    symbol,
    asset: assetFromCexSymbol(symbol),
    windowStartMs,
    windowEndMs,
  };
}

function parseEtClock(raw: string): { readonly hour: number; readonly minute: number } | null {
  const suffix = raw.slice(-2);
  const digits = raw.slice(0, -2);
  if ((suffix !== 'AM' && suffix !== 'PM') || !/^\d{1,4}$/.test(digits)) return null;

  const minute = digits.length > 2 ? Number(digits.slice(-2)) : 0;
  let hour = digits.length > 2 ? Number(digits.slice(0, -2)) : Number(digits);
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;

  if (suffix === 'AM') {
    if (hour === 12) hour = 0;
  } else if (hour !== 12) {
    hour += 12;
  }
  return { hour, minute };
}

function zonedDateTimeToUtcMs(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
  timeZone = 'America/New_York',
): number {
  let utcMs = Date.UTC(year, monthIndex, day, hour, minute);
  const targetAsUtc = Date.UTC(year, monthIndex, day, hour, minute);

  for (let iteration = 0; iteration < 4; iteration++) {
    const zoned = getZonedParts(utcMs, timeZone);
    const zonedAsUtc = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute);
    const delta = targetAsUtc - zonedAsUtc;
    if (delta === 0) break;
    utcMs += delta;
  }
  return utcMs;
}

function getZonedParts(utcMs: number, timeZone: string): {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
} {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(utcMs)).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function assetToCexBase(asset: string): string {
  const lower = asset.toLowerCase();
  if (lower === 'bitcoin' || lower === 'btc') return 'btc';
  if (lower === 'ethereum' || lower === 'eth') return 'eth';
  if (lower === 'solana' || lower === 'sol') return 'sol';
  return lower;
}

function assetFromCexSymbol(symbol: string): string {
  const base = symbol.toLowerCase().split(/[/-]/)[0] ?? '';
  return base === 'xbt' ? 'btc' : base;
}

function windowsOverlap(leftStartMs: number, leftEndMs: number, rightStartMs: number, rightEndMs: number): boolean {
  return leftStartMs <= rightEndMs && leftEndMs >= rightStartMs;
}

function marketStartMs(market: MarketData): number {
  return market.endDateMs - market.durationMin * 60_000;
}

function computeEntryBidCents(obs: Observation): number {
  const aggressive = Math.round(obs.bestBidCents) + 1;
  const ask = Math.round(obs.bestAskCents);
  const bid = aggressive < ask ? aggressive : Math.round(obs.bestBidCents);
  return Math.max(1, Math.min(99, bid));
}

function findFillIndex(observations: readonly Observation[], fromIndex: number, entryBidCents: number): number | null {
  for (let index = fromIndex + 1; index < observations.length; index++) {
    if (observations[index]!.bestAskCents <= entryBidCents) return index;
  }
  return null;
}

function findFutureObservationIndex(observations: readonly Observation[], fromIndex: number, afterMs: number): number | null {
  const targetTs = observations[fromIndex]!.tsMs + afterMs;
  for (let index = fromIndex + 1; index < observations.length; index++) {
    if (observations[index]!.tsMs >= targetTs) return index;
  }
  return null;
}

function buildFutureIndex(observations: readonly Observation[], fromIndex: number, horizonMs: number): number | null {
  const targetTs = observations[fromIndex]!.tsMs + horizonMs;
  for (let index = fromIndex + 1; index < observations.length; index++) {
    if (observations[index]!.tsMs >= targetTs) return index;
  }
  return null;
}

function effectiveShares(entryBidCents: number, cfg: Config): number {
  const price = entryBidCents / 100;
  const minByValue = cfg.minOrderValue > 0 ? Math.ceil(cfg.minOrderValue / price) : 0;
  return Math.max(cfg.shares, cfg.minOrderSize, minByValue);
}

function loadCexEventsForMarket(
  market: MarketData,
  cexIndex: readonly CexSidecarFile[],
  cfg: Config,
  cache: Map<string, readonly CexEvent[]>,
): Map<Venue, CexEvent[]> {
  const fromMs = marketStartMs(market) - cfg.cexWarmupMs;
  const toMs = market.endDateMs;
  const out = new Map<Venue, CexEvent[]>();
  for (const venue of cfg.venues) out.set(venue, []);

  const selected = cexIndex.filter((file) =>
    cfg.venues.includes(file.venue) && windowsOverlap(file.windowStartMs, file.windowEndMs, fromMs, toMs),
  );

  for (const file of selected) {
    let parsed = cache.get(file.filePath);
    if (!parsed) {
      try {
        parsed = parseCexEventsLoose(file.filePath);
      } catch (err) {
        console.error(`warn: skip bad CEX sidecar ${file.filePath}: ${err instanceof Error ? err.message : String(err)}`);
        parsed = [];
      }
      cache.set(file.filePath, parsed);
    }
    const bucket = out.get(file.venue);
    if (!bucket) continue;
    for (const event of parsed) {
      if (event.ts >= fromMs && event.ts <= toMs) bucket.push(event);
    }
  }

  for (const events of out.values()) {
    events.sort((left, right) => {
      if (left.ts !== right.ts) return left.ts - right.ts;
      if (left.kind !== right.kind) return left.kind === 'ob' ? -1 : 1;
      return left.order - right.order;
    });
  }
  return out;
}

function parseCexEventsLoose(filePath: string): CexEvent[] {
  try {
    return parseCexEvents(filePath);
  } catch (err) {
    if (filePath.endsWith('.gz')) throw err;
    return parsePlainCexEvents(filePath);
  }
}

function parsePlainCexEvents(filePath: string): CexEvent[] {
  const events: CexEvent[] = [];
  const raw = readFileSync(filePath, 'utf8');
  raw.split('\n').forEach((line, order) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let row: Record<string, unknown>;
    try {
      row = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }

    if (row['t'] === 'ob') {
      const ts = asNumber(row['ts']);
      const bid = parseBookLevel(row['bids'], 0);
      const ask = parseBookLevel(row['asks'], 0);
      if (ts === null || !bid || !ask || ask.price <= bid.price) return;
      events.push({
        kind: 'ob',
        ts,
        order,
        bid: bid.price,
        ask: ask.price,
        bidSize: bid.size,
        askSize: ask.size,
      });
      return;
    }

    if (row['t'] === 'trade') {
      const ts = asNumber(row['ts']);
      const price = asNumber(row['p'] ?? row['price']);
      const size = asNumber(row['sz'] ?? row['size']);
      if (ts === null || price === null || size === null || size <= 0) return;
      const side = row['side'] === 'buy' ? 1 : row['side'] === 'sell' ? -1 : 0;
      events.push({
        kind: 'trade',
        ts,
        order,
        price,
        size,
        signedNotional: side * price * size,
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

function parseBookLevel(levels: unknown, index: number): { readonly price: number; readonly size: number } | null {
  if (!Array.isArray(levels) || !Array.isArray(levels[index])) return null;
  const level = levels[index] as unknown[];
  const price = asNumber(level[0]);
  const size = asNumber(level[1]);
  if (price === null || size === null) return null;
  return { price, size };
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function buildCexRows(
  market: MarketData,
  eventsByVenue: ReadonlyMap<Venue, readonly CexEvent[]>,
  cfg: Config,
): CexRow[] {
  const states = new Map<Venue, ReturnType<typeof createVenueState>>();
  const pointers = new Map<Venue, number>();
  for (const venue of cfg.venues) {
    states.set(venue, createVenueState());
    pointers.set(venue, 0);
  }

  return market.observations.map((obs) => {
    const venues: Partial<Record<Venue, CexVenueObservation>> = {};
    for (const venue of cfg.venues) {
      const state = states.get(venue)!;
      const events = eventsByVenue.get(venue) ?? [];
      let pointer = pointers.get(venue) ?? 0;
      while (pointer < events.length && events[pointer]!.ts <= obs.tsMs) {
        applyEvent(state, events[pointer]!);
        pointer++;
      }
      pointers.set(venue, pointer);
      pruneTrades(state, obs.tsMs, 1_000);

      const built = buildVenuePredictors(venue, state, obs.tsMs, cfg.cexStalenessMs);
      if (!built.snapshot || built.snapshot.spreadBps > cfg.maxSpreadBps) continue;
      venues[venue] = {
        micro: built.snapshot.micro,
        spreadBps: built.snapshot.spreadBps,
        ageMs: built.snapshot.ageMs,
      };
    }

    return {
      tsMs: obs.tsMs,
      chainlinkPrice: market.strikePrice + obs.delta,
      venues,
    };
  });
}

function estimateBasis(markets: readonly MarketBundle[], venues: readonly Venue[]): Readonly<Record<Venue, number>> {
  const basis: Partial<Record<Venue, number>> = {};
  for (const venue of venues) {
    const samples: number[] = [];
    for (const bundle of markets) {
      for (const row of bundle.rows) {
        const obs = row.venues[venue];
        if (!obs) continue;
        samples.push(obs.micro - row.chainlinkPrice);
      }
    }
    basis[venue] = samples.length > 0 ? median(samples) : 0;
  }
  return basis as Record<Venue, number>;
}

function buildTrainSamples(
  markets: readonly MarketBundle[],
  basisByVenue: Readonly<Record<Venue, number>>,
  cfg: Config,
): TrainSample[] {
  const samples: TrainSample[] = [];
  for (const bundle of markets) {
    const observations = bundle.market.observations;
    for (let index = 0; index < observations.length; index++) {
      const futureIndex = buildFutureIndex(observations, index, cfg.horizonMs);
      if (futureIndex === null) continue;
      const features = buildCexFeatures(bundle.rows[index]!, basisByVenue, cfg.venues);
      if (!features) continue;
      const futureChainlink = bundle.market.strikePrice + observations[futureIndex]!.delta;
      samples.push({
        features,
        targetDeltaUsd: futureChainlink - bundle.rows[index]!.chainlinkPrice,
      });
    }
  }
  return samples;
}

function buildCexFeatures(
  row: CexRow,
  basisByVenue: Readonly<Record<Venue, number>>,
  venues: readonly Venue[],
): number[] | null {
  const features: number[] = [];
  for (const venue of venues) {
    const obs = row.venues[venue];
    if (!obs) return null;
    features.push(obs.micro - (basisByVenue[venue] ?? 0) - row.chainlinkPrice);
  }
  return features;
}

function fitCexModel(trainMarkets: readonly MarketBundle[], cfg: Config): CexLinearModel {
  const basisByVenue = estimateBasis(trainMarkets, cfg.venues);
  const samples = buildTrainSamples(trainMarkets, basisByVenue, cfg);
  if (samples.length < cfg.venues.length + 2) {
    throw new Error(`Not enough CEX train samples: ${samples.length}`);
  }

  const coefficients = fitRidge(samples, cfg.venues.length, cfg.ridgeLambda);
  const metrics = evaluateCoefficients(samples, coefficients);
  return {
    venues: cfg.venues,
    basisByVenue,
    intercept: coefficients[0] ?? 0,
    weights: coefficients.slice(1),
    trainSamples: samples.length,
    trainHitRate: metrics.hitRate,
    trainCorr: metrics.corr,
    trainMae: metrics.mae,
    trainBaselineMae: metrics.baselineMae,
  };
}

function fitRidge(samples: readonly TrainSample[], featureCount: number, lambda: number): number[] {
  const size = featureCount + 1;
  const xtx = Array.from({ length: size }, () => Array.from({ length: size }, () => 0));
  const xty = Array.from({ length: size }, () => 0);

  for (const sample of samples) {
    const vector = [1, ...sample.features];
    for (let row = 0; row < size; row++) {
      xty[row] += vector[row]! * sample.targetDeltaUsd;
      for (let col = 0; col < size; col++) {
        xtx[row]![col] += vector[row]! * vector[col]!;
      }
    }
  }

  for (let index = 1; index < size; index++) {
    xtx[index]![index] += lambda;
  }
  return solveLinearSystem(xtx, xty);
}

function solveLinearSystem(matrix: readonly number[][], vector: readonly number[]): number[] {
  const size = vector.length;
  const a = matrix.map((row) => [...row]);
  const b = [...vector];

  for (let pivot = 0; pivot < size; pivot++) {
    let bestRow = pivot;
    let bestValue = Math.abs(a[pivot]![pivot] ?? 0);
    for (let row = pivot + 1; row < size; row++) {
      const candidate = Math.abs(a[row]![pivot] ?? 0);
      if (candidate > bestValue) {
        bestValue = candidate;
        bestRow = row;
      }
    }
    if (bestValue === 0) return Array.from({ length: size }, () => 0);
    if (bestRow !== pivot) {
      [a[pivot], a[bestRow]] = [a[bestRow]!, a[pivot]!];
      [b[pivot], b[bestRow]] = [b[bestRow]!, b[pivot]!];
    }

    const pivotValue = a[pivot]![pivot]!;
    for (let col = pivot; col < size; col++) a[pivot]![col] /= pivotValue;
    b[pivot] /= pivotValue;

    for (let row = 0; row < size; row++) {
      if (row === pivot) continue;
      const factor = a[row]![pivot]!;
      if (factor === 0) continue;
      for (let col = pivot; col < size; col++) a[row]![col] -= factor * a[pivot]![col]!;
      b[row] -= factor * b[pivot]!;
    }
  }
  return b;
}

function evaluateCoefficients(samples: readonly TrainSample[], coefficients: readonly number[]): {
  readonly mae: number;
  readonly baselineMae: number;
  readonly hitRate: number;
  readonly corr: number;
} {
  let absErr = 0;
  let absBase = 0;
  let hit = 0;
  let hitN = 0;
  let predSum = 0;
  let trueSum = 0;
  let predSq = 0;
  let trueSq = 0;
  let cross = 0;

  for (const sample of samples) {
    const pred = coefficients[0]! + dot(coefficients.slice(1), sample.features);
    const truth = sample.targetDeltaUsd;
    absErr += Math.abs(pred - truth);
    absBase += Math.abs(truth);
    predSum += pred;
    trueSum += truth;
    predSq += pred * pred;
    trueSq += truth * truth;
    cross += pred * truth;
    if (pred !== 0 && truth !== 0) {
      hitN++;
      if (Math.sign(pred) === Math.sign(truth)) hit++;
    }
  }

  const n = samples.length;
  const predVar = predSq - predSum ** 2 / n;
  const trueVar = trueSq - trueSum ** 2 / n;
  const covariance = cross - predSum * trueSum / n;
  return {
    mae: absErr / n,
    baselineMae: absBase / n,
    hitRate: hitN > 0 ? hit / hitN : 0,
    corr: predVar > 0 && trueVar > 0 ? covariance / Math.sqrt(predVar * trueVar) : 0,
  };
}

function dot(left: readonly number[], right: readonly number[]): number {
  let sum = 0;
  for (let index = 0; index < left.length; index++) sum += left[index]! * (right[index] ?? 0);
  return sum;
}

function predictCex(row: CexRow, model: CexLinearModel, cfg: Config): CexPrediction | null {
  const features = buildCexFeatures(row, model.basisByVenue, model.venues);
  if (!features) return null;
  const predDeltaUsd = model.intercept + dot(model.weights, features);
  const predBps = row.chainlinkPrice > 0 ? predDeltaUsd / row.chainlinkPrice * 10_000 : 0;
  const direction: CexDirection =
    predBps >= cfg.cexThresholdBps ? 'UP' :
      predBps <= -cfg.cexThresholdBps ? 'DOWN' : 'FLAT';
  return { direction, predDeltaUsd, predBps };
}

function lookupCrowdZone(obs: Observation, table: EdgeTable): { readonly zone: EdgeZone | null; readonly regime: Regime } {
  const regime = classifyRegime(obs.trendSlope, table.meta.bucketing.regimeThreshold);
  const zone = table.lookup({
    deltaDollars: obs.delta,
    tauSec: obs.tauSec,
    midCents: obs.midPriceCents,
    regime,
  }) ?? null;
  return { zone, regime };
}

function crowdAllows(zone: EdgeZone | null, entryPriceCents: number, cfg: Config): boolean {
  if (!zone) return false;

  if (cfg.crowdGate === 'strict') {
    return (
      zone.signal === 'BUY' &&
      zone.kelly.side === 'UP' &&
      zone.kelly.size > 0 &&
      zone.weights.composite >= cfg.minComposite
    );
  }

  if (zone.train.n < cfg.relaxedMinN) return false;
  if (zone.weights.composite < cfg.minComposite) return false;
  if (cfg.relaxedRequireOos && !zone.oos?.passes) return false;

  const entry = entryPriceCents / 100;
  const edgeHat = zone.train.pHat - entry;
  const edgeLow = zone.train.pLow - entry;
  return edgeHat >= cfg.relaxedMinEdge && edgeLow >= cfg.relaxedMinCiEdge;
}

function modeAllows(mode: ModeName, crowdOk: boolean, cex: CexPrediction | null): boolean {
  switch (mode) {
    case 'crowd_only':
      return crowdOk;
    case 'crowd_cex_agree':
      return crowdOk && cex?.direction === 'UP';
    case 'crowd_cex_not_adverse':
      return crowdOk && cex !== null && cex.direction !== 'DOWN';
    case 'cex_only':
      return cex?.direction === 'UP';
  }
}

function evaluateEntrySignal(
  bundle: MarketBundle,
  index: number,
  mode: ModeName,
  table: EdgeTable,
  model: CexLinearModel,
  cfg: Config,
): EntrySignal {
  const obs = bundle.market.observations[index]!;
  const { zone } = lookupCrowdZone(obs, table);
  const quotedEntryCents = cfg.entryMode === 'taker'
    ? Math.max(1, Math.min(99, Math.round(obs.bestAskCents)))
    : computeEntryBidCents(obs);
  const entryBidCents = computeEntryBidCents(obs);
  const crowdOk = crowdAllows(zone, quotedEntryCents, cfg);
  const cex = predictCex(bundle.rows[index]!, model, cfg);
  return {
    zone,
    cex,
    quotedEntryCents,
    entryBidCents,
    allowed: modeAllows(mode, crowdOk, cex),
  };
}

function findConditionFillIndex(
  bundle: MarketBundle,
  fromIndex: number,
  mode: ModeName,
  table: EdgeTable,
  model: CexLinearModel,
  cfg: Config,
): {
  readonly entryIndex: number;
  readonly fillIndex: number | null;
  readonly cancelIndex: number;
  readonly entryBidCents: number;
  readonly zone: EdgeZone | null;
  readonly cex: CexPrediction | null;
} {
  const observations = bundle.market.observations;
  let entryIndex = fromIndex;
  let signal = evaluateEntrySignal(bundle, entryIndex, mode, table, model, cfg);
  let entryBidCents = signal.entryBidCents;
  let zone = signal.zone;
  let cex = signal.cex;

  for (let index = fromIndex + 1; index < observations.length; index++) {
    const obs = observations[index]!;
    if (obs.bestAskCents <= entryBidCents) {
      return { entryIndex, fillIndex: index, cancelIndex: index, entryBidCents, zone, cex };
    }

    const next = evaluateEntrySignal(bundle, index, mode, table, model, cfg);
    if (!next.allowed) {
      return { entryIndex, fillIndex: null, cancelIndex: index, entryBidCents, zone, cex };
    }

    if (next.entryBidCents !== entryBidCents) {
      entryIndex = index;
      entryBidCents = next.entryBidCents;
      zone = next.zone;
      cex = next.cex;
    }
  }

  return { entryIndex, fillIndex: null, cancelIndex: observations.length, entryBidCents, zone, cex };
}

function simulateMode(
  bundle: MarketBundle,
  mode: ModeName,
  table: EdgeTable,
  model: CexLinearModel,
  cfg: Config,
): EntryAttempt | null {
  const observations = bundle.market.observations;
  const startMs = marketStartMs(bundle.market);
  let lastUnfilled: EntryAttempt | null = null;
  for (let index = 0; index < observations.length; index++) {
    const obs = observations[index]!;
    if (obs.tsMs - startMs < cfg.warmupSec * 1_000) continue;
    if (obs.tauSec > cfg.maxEntryTauSec) continue;
    if (obs.tauSec < 0) continue;
    if (cfg.exitMode === 'horizon' && obs.tauSec * 1_000 <= cfg.exitAfterMs + 1_000) continue;

    const signal = evaluateEntrySignal(bundle, index, mode, table, model, cfg);
    if (!signal.allowed) continue;

    let entryIndex = index;
    let entryBidCents = signal.entryBidCents;
    let entryFillPriceCents = cfg.entryMode === 'taker' ? signal.quotedEntryCents : entryBidCents;
    let fillIndex: number | null;
    let zone = signal.zone;
    let cex = signal.cex;

    if (cfg.entryMode === 'taker') {
      fillIndex = index;
    } else if (cfg.makerCancelPolicy === 'conditions') {
      const conditionFill = findConditionFillIndex(bundle, index, mode, table, model, cfg);
      entryIndex = conditionFill.entryIndex;
      entryBidCents = conditionFill.entryBidCents;
      entryFillPriceCents = entryBidCents;
      fillIndex = conditionFill.fillIndex;
      zone = conditionFill.zone;
      cex = conditionFill.cex;
      if (fillIndex === null) {
        index = Math.max(index, conditionFill.cancelIndex);
      }
    } else {
      const rawFillIndex = findFillIndex(observations, index, entryBidCents);
      fillIndex = rawFillIndex !== null && cfg.makerCancelPolicy === 'time' && cfg.maxFillWaitMs !== null
        ? observations[rawFillIndex]!.tsMs - obs.tsMs <= cfg.maxFillWaitMs ? rawFillIndex : null
        : rawFillIndex;
    }

    const entryObs = observations[entryIndex]!;
    const shares = effectiveShares(entryFillPriceCents, cfg);
    const notional = shares * entryFillPriceCents / 100;
    const filled = fillIndex !== null;
    const fillTsMs = fillIndex !== null ? observations[fillIndex]!.tsMs : null;
    const fillTauSec = fillIndex !== null ? observations[fillIndex]!.tauSec : null;
    const exit = fillIndex !== null
      ? resolveExit(observations, bundle.market, fillIndex, entryFillPriceCents, cfg)
      : { priceCents: null, tsMs: null, reason: 'unfilled', pnlPerShare: 0 };
    if (filled && exit.priceCents === null) continue;
    const holdSec = filled && fillTsMs !== null && exit.tsMs !== null
      ? Math.max(0, (exit.tsMs - fillTsMs) / 1_000)
      : null;

    const attempt: EntryAttempt = {
      mode,
      slug: bundle.market.slug,
      day: formatDay(bundle.market.endDateMs),
      attempted: true,
      filled,
      fillIndex,
      entryIndex,
      entryTsMs: entryObs.tsMs,
      entryTauSec: entryObs.tauSec,
      fillTsMs,
      fillTauSec,
      entryBidCents,
      entryFillPriceCents,
      exitPriceCents: exit.priceCents,
      exitTsMs: exit.tsMs,
      exitReason: exit.reason,
      holdSec,
      shares,
      notional,
      resolution: bundle.market.resolution,
      pnlPerShare: filled ? exit.pnlPerShare : 0,
      pnlDollars: filled ? exit.pnlPerShare * shares : 0,
      crowdZone: zone,
      cex,
    };
    if (!filled && cfg.makerCancelPolicy === 'conditions') {
      lastUnfilled = attempt;
      continue;
    }
    return attempt;
  }
  return lastUnfilled;
}

function resolveExit(
  observations: readonly Observation[],
  market: MarketData,
  fillIndex: number,
  entryFillPriceCents: number,
  cfg: Config,
): { readonly priceCents: number | null; readonly tsMs: number | null; readonly reason: string; readonly pnlPerShare: number } {
  if (cfg.exitMode === 'expiry') {
    const exitPriceCents = market.resolution === 'UP' ? 100 : 0;
    return {
      priceCents: exitPriceCents,
      tsMs: market.endDateMs,
      reason: 'expiry',
      pnlPerShare: (exitPriceCents - entryFillPriceCents) / 100,
    };
  }

  const exitIndex = findFutureObservationIndex(observations, fillIndex, cfg.exitAfterMs);
  if (exitIndex === null) return { priceCents: null, tsMs: null, reason: 'no_horizon_exit', pnlPerShare: 0 };
  const exitPriceCents = Math.max(1, Math.min(99, Math.round(observations[exitIndex]!.bestBidCents)));
  return {
    priceCents: exitPriceCents,
    tsMs: observations[exitIndex]!.tsMs,
    reason: `horizon_${cfg.exitAfterMs}ms`,
    pnlPerShare: (exitPriceCents - entryFillPriceCents) / 100,
  };
}

function formatDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function summarize(mode: ModeName, attempts: readonly EntryAttempt[]): ModeStats {
  const filled = attempts.filter((attempt) => attempt.filled);
  const wins = filled.filter((attempt) => attempt.pnlDollars > 0);
  const withCex = attempts.filter((attempt) => attempt.cex !== null);
  const withHold = filled.filter((attempt) => attempt.holdSec !== null);
  return {
    mode,
    attempts,
    attempted: attempts.length,
    filled: filled.length,
    wins: wins.length,
    fillRate: attempts.length > 0 ? filled.length / attempts.length : 0,
    winRate: filled.length > 0 ? wins.length / filled.length : 0,
    pnl: filled.reduce((sum, attempt) => sum + attempt.pnlDollars, 0),
    pnlPerShare: filled.reduce((sum, attempt) => sum + attempt.pnlPerShare, 0),
    avgEntryCents: filled.length > 0 ? filled.reduce((sum, attempt) => sum + attempt.entryFillPriceCents, 0) / filled.length : 0,
    avgHoldSec: withHold.length > 0 ? withHold.reduce((sum, attempt) => sum + (attempt.holdSec ?? 0), 0) / withHold.length : 0,
    avgPredBps: withCex.length > 0 ? withCex.reduce((sum, attempt) => sum + (attempt.cex?.predBps ?? 0), 0) / withCex.length : null,
    cexUp: attempts.filter((attempt) => attempt.cex?.direction === 'UP').length,
    cexFlat: attempts.filter((attempt) => attempt.cex?.direction === 'FLAT').length,
    cexDown: attempts.filter((attempt) => attempt.cex?.direction === 'DOWN').length,
    horizonExits: attempts.filter((attempt) => attempt.exitReason.startsWith('horizon_')).length,
  };
}

function renderStats(stats: readonly ModeStats[]): void {
  console.log('\nMode summary');
  console.log('mode                   attempts  fills  fill%   WR      PnL$     PnL/sh  avgFill  avgHold  avgCexBps  CEX up/flat/down');
  for (const stat of stats) {
    console.log([
      stat.mode.padEnd(22),
      String(stat.attempted).padStart(8),
      String(stat.filled).padStart(6),
      `${(stat.fillRate * 100).toFixed(1)}%`.padStart(7),
      `${(stat.winRate * 100).toFixed(1)}%`.padStart(7),
      money(stat.pnl).padStart(9),
      money(stat.pnlPerShare).padStart(8),
      `${stat.avgEntryCents.toFixed(1)}c`.padStart(7),
      `${stat.avgHoldSec.toFixed(1)}s`.padStart(7),
      (stat.avgPredBps === null ? '-' : stat.avgPredBps.toFixed(3)).padStart(9),
      `${stat.cexUp}/${stat.cexFlat}/${stat.cexDown}`.padStart(16),
    ].join('  '));
  }
}

function renderByDay(stats: readonly ModeStats[]): void {
  const days = [...new Set(stats.flatMap((stat) => stat.attempts.map((attempt) => attempt.day)))].sort();
  if (days.length === 0) return;

  console.log('\nOOS by day');
  for (const day of days) {
    console.log(`\n${day}`);
    console.log('mode                   attempts  fills  WR      PnL$');
    for (const stat of stats) {
      const sub = stat.attempts.filter((attempt) => attempt.day === day);
      const filled = sub.filter((attempt) => attempt.filled);
      const wins = filled.filter((attempt) => attempt.pnlDollars > 0);
      const pnl = filled.reduce((sum, attempt) => sum + attempt.pnlDollars, 0);
      const wr = filled.length > 0 ? wins.length / filled.length : 0;
      console.log([
        stat.mode.padEnd(22),
        String(sub.length).padStart(8),
        String(filled.length).padStart(6),
        `${(wr * 100).toFixed(1)}%`.padStart(7),
        money(pnl).padStart(9),
      ].join('  '));
    }
  }
}

function renderTrades(stats: readonly ModeStats[], cfg: Config): void {
  if (cfg.showTrades <= 0) return;
  const stat = stats.find((item) => item.mode === cfg.showTradesMode);
  if (!stat) return;

  const attempts = stat.attempts
    .filter((attempt) => attempt.filled)
    .slice(0, cfg.showTrades);

  console.log(`\nTrades (${cfg.showTradesMode}, first ${attempts.length}/${stat.filled} filled)`);
  console.log('day         entryUtc              fillDelay  hold     entry  exit  pnl$    tauFill  cex        zone');
  for (const attempt of attempts) {
    const fillDelaySec = attempt.fillTsMs !== null ? (attempt.fillTsMs - attempt.entryTsMs) / 1_000 : null;
    const zone = attempt.crowdZone;
    const entryEdgeCents = zone ? (zone.train.pHat - attempt.entryFillPriceCents / 100) * 100 : null;
    const zoneText = zone
      ? `d=${zone.key.delta} t=${zone.key.tau} c=${zone.key.crowd} r=${zone.key.regime} eEntry=${entryEdgeCents?.toFixed(1)} n=${zone.train.n} comp=${zone.weights.composite.toFixed(2)}`
      : '-';
    const cexText = attempt.cex
      ? `${attempt.cex.direction} ${attempt.cex.predBps.toFixed(2)}bps`
      : '-';
    console.log([
      attempt.day.padEnd(10),
      new Date(attempt.entryTsMs).toISOString().replace('.000Z', 'Z').padEnd(21),
      (fillDelaySec === null ? '-' : `${fillDelaySec.toFixed(1)}s`).padStart(9),
      (attempt.holdSec === null ? '-' : `${attempt.holdSec.toFixed(1)}s`).padStart(7),
      `${attempt.entryFillPriceCents.toFixed(0)}c`.padStart(6),
      (attempt.exitPriceCents === null ? '-' : `${attempt.exitPriceCents.toFixed(0)}c`).padStart(5),
      money(attempt.pnlDollars).padStart(7),
      (attempt.fillTauSec === null ? '-' : `${attempt.fillTauSec.toFixed(1)}s`).padStart(8),
      cexText.padEnd(10),
      zoneText,
    ].join('  '));
  }
}

function renderCexFilterDeltas(stats: readonly ModeStats[]): void {
  const crowd = stats.find((stat) => stat.mode === 'crowd_only');
  if (!crowd) return;

  const crowdFilledBySlug = new Map(crowd.attempts.filter((attempt) => attempt.filled).map((attempt) => [attempt.slug, attempt]));
  console.log('\nCEX filter vs crowd_only');
  console.log('mode                   blocked attempts  blocked fills  blocked PnL$  kept fills  kept PnL$');

  for (const mode of ['crowd_cex_agree', 'crowd_cex_not_adverse'] as const) {
    const stat = stats.find((item) => item.mode === mode);
    if (!stat) continue;
    const modeAttemptSlugs = new Set(stat.attempts.map((attempt) => attempt.slug));
    const modeFilledSlugs = new Set(stat.attempts.filter((attempt) => attempt.filled).map((attempt) => attempt.slug));
    const blockedAttempts = crowd.attempts.filter((attempt) => !modeAttemptSlugs.has(attempt.slug));
    const blockedFilled = [...crowdFilledBySlug.values()].filter((attempt) => !modeFilledSlugs.has(attempt.slug));
    const keptFilled = [...crowdFilledBySlug.values()].filter((attempt) => modeFilledSlugs.has(attempt.slug));
    const blockedPnl = blockedFilled.reduce((sum, attempt) => sum + attempt.pnlDollars, 0);
    const keptPnl = keptFilled.reduce((sum, attempt) => sum + attempt.pnlDollars, 0);

    console.log([
      mode.padEnd(22),
      String(blockedAttempts.length).padStart(16),
      String(blockedFilled.length).padStart(14),
      money(blockedPnl).padStart(12),
      String(keptFilled.length).padStart(10),
      money(keptPnl).padStart(10),
    ].join('  '));
  }
}

function runSweep(
  testBundles: readonly MarketBundle[],
  table: EdgeTable,
  model: CexLinearModel,
  cfg: Config,
): SweepRow[] {
  const rows: SweepRow[] = [];

  for (const relaxedMinEdge of cfg.sweepRelaxedMinEdges) {
    for (const cexThresholdBps of cfg.sweepCexThresholdBps) {
      for (const minComposite of cfg.sweepMinComposites) {
        const trialCfg: Config = {
          ...cfg,
          crowdGate: 'relaxed',
          relaxedMinEdge,
          cexThresholdBps,
          minComposite,
        };
        const attempts: EntryAttempt[] = [];
        for (const bundle of testBundles) {
          const attempt = simulateMode(bundle, cfg.sweepMode, table, model, trialCfg);
          if (attempt) attempts.push(attempt);
        }
        const stats = summarize(cfg.sweepMode, attempts);
        const score = stats.filled >= cfg.sweepMinFills ? stats.pnl : Number.NEGATIVE_INFINITY;
        rows.push({
          mode: cfg.sweepMode,
          relaxedMinEdge,
          cexThresholdBps,
          minComposite,
          attempted: stats.attempted,
          filled: stats.filled,
          winRate: stats.winRate,
          fillRate: stats.fillRate,
          pnl: stats.pnl,
          pnlPerShare: stats.pnlPerShare,
          avgEntryCents: stats.avgEntryCents,
          score,
        });
      }
    }
  }

  return rows.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (right.pnl !== left.pnl) return right.pnl - left.pnl;
    return right.filled - left.filled;
  });
}

function renderSweep(rows: readonly SweepRow[], cfg: Config): void {
  const visible = rows.slice(0, cfg.sweepTop);
  console.log('\nGrid sweep');
  console.log(`mode=${cfg.sweepMode}  rows=${rows.length}  minFills=${cfg.sweepMinFills}`);
  console.log('rank  edge    cexBps  comp   attempts  fills  fill%   WR      PnL$     PnL/sh  avgFill');
  visible.forEach((row, index) => {
    console.log([
      String(index + 1).padStart(4),
      row.relaxedMinEdge.toFixed(3).padStart(6),
      row.cexThresholdBps.toFixed(2).padStart(7),
      row.minComposite.toFixed(2).padStart(5),
      String(row.attempted).padStart(8),
      String(row.filled).padStart(6),
      `${(row.fillRate * 100).toFixed(1)}%`.padStart(7),
      `${(row.winRate * 100).toFixed(1)}%`.padStart(7),
      money(row.pnl).padStart(9),
      money(row.pnlPerShare).padStart(8),
      `${row.avgEntryCents.toFixed(1)}c`.padStart(7),
    ].join('  '));
  });

  const valid = rows.filter((row) => row.filled >= cfg.sweepMinFills);
  const positive = valid.filter((row) => row.pnl > 0);
  console.log(`\nSweep diagnostics: valid=${valid.length}/${rows.length}  positive=${positive.length}/${valid.length}`);
  for (const edge of cfg.sweepRelaxedMinEdges) {
    const sub = valid.filter((row) => row.relaxedMinEdge === edge);
    if (sub.length === 0) continue;
    const avg = sub.reduce((sum, row) => sum + row.pnl, 0) / sub.length;
    const pos = sub.filter((row) => row.pnl > 0).length;
    console.log(`  edge=${edge.toFixed(3)}: avgPnL=${money(avg)}  positive=${pos}/${sub.length}`);
  }
}

function money(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
}

function printModel(model: CexLinearModel): void {
  console.log('\nCEX model');
  console.log(`  venues: ${model.venues.join(',')}`);
  console.log(`  train samples: ${model.trainSamples}`);
  console.log(`  train hit: ${(model.trainHitRate * 100).toFixed(1)}%  corr=${model.trainCorr.toFixed(3)}  mae=${model.trainMae.toFixed(3)}  baseline=${model.trainBaselineMae.toFixed(3)}`);
  console.log(`  intercept: ${model.intercept.toFixed(6)}`);
  console.log(`  weights: ${model.weights.map((weight, index) => `${model.venues[index]}=${weight.toFixed(6)}`).join(', ')}`);
  console.log(`  basis: ${model.venues.map((venue) => `${venue}=${(model.basisByVenue[venue] ?? 0).toFixed(3)}$`).join(', ')}`);
}

async function buildMarketBundles(
  files: readonly string[],
  cexIndex: readonly CexSidecarFile[],
  table: EdgeTable,
  cfg: Config,
): Promise<MarketBundle[]> {
  const cexCache = new Map<string, readonly CexEvent[]>();
  const bundles: MarketBundle[] = [];
  let parsed = 0;
  let skipped = 0;

  for (const file of files) {
    const result = await parseSnapshot(file, table.meta.bucketing.maxTau, cfg.token, cfg.approxResolution);
    parsed++;
    if (!result.data || result.data.duration !== '5min') {
      skipped++;
      continue;
    }
    const observations = [...result.data.observations].sort((left, right) => left.tsMs - right.tsMs);
    if (observations.length === 0) {
      skipped++;
      continue;
    }
    const market: MarketData = { ...result.data, observations };
    const cexEvents = loadCexEventsForMarket(market, cexIndex, cfg, cexCache);
    const rows = buildCexRows(market, cexEvents, cfg);
    bundles.push({ filePath: file, market, rows });
    if (parsed % 100 === 0) console.error(`  parsed ${parsed}/${files.length}...`);
  }

  console.error(`parsed markets: ${bundles.length}  skipped: ${skipped}  cex files cached: ${cexCache.size}`);
  return bundles;
}

async function main(): Promise<void> {
  const cfg = parseCli();
  const table = EdgeTable.fromFile(cfg.tablePath);
  const inputDirs = cfg.snapshotDirs.map(normalizeSnapshotDir);
  const polymarketFiles = collectPolymarketFiles(inputDirs, cfg.asset);
  const cexIndex = buildCexIndex(inputDirs, cfg.venues, cfg.asset);

  console.log(`Edge table: ${cfg.tablePath}  zones=${table.size}`);
  console.log(`Snapshots: ${cfg.snapshotDirs.join(', ')}`);
  console.log(`Polymarket files: ${polymarketFiles.length}  CEX sidecars: ${cexIndex.length}`);
  if (polymarketFiles.length === 0) {
    console.error('\nNo Polymarket snapshot files found. Checked:');
    for (const input of inputDirs) {
      console.error(`  ${input.polymarketDir}${existsSync(input.polymarketDir) ? '' : '  (missing)'}`);
    }
    console.error('\nIf you used "$S/...", make sure S is set in this shell, for example:');
    console.error('  S=/Users/menvil/Projects/polymarket/apps/collect-data/snapshots');
    throw new Error('No snapshot files found for --snapshots.');
  }
  console.log(`Train until: ${new Date(cfg.trainUntilMs).toISOString()}  OOS after that`);
  console.log(`CEX horizon=${cfg.horizonMs}ms threshold=${cfg.cexThresholdBps}bps staleness=${cfg.cexStalenessMs}ms maxSpread=${cfg.maxSpreadBps}bps`);
  console.log(`Crowd gate=${cfg.crowdGate} minComposite=${cfg.minComposite} relaxed(n>=${cfg.relaxedMinN}, edge>=${cfg.relaxedMinEdge}, ciEdge>=${cfg.relaxedMinCiEdge}, requireOos=${cfg.relaxedRequireOos})`);
  console.log(`Execution entry=${cfg.entryMode} exit=${cfg.exitMode}${cfg.exitMode === 'horizon' ? ` after=${cfg.exitAfterMs}ms` : ''} makerCancel=${cfg.makerCancelPolicy}${cfg.maxFillWaitMs !== null ? ` maxFillWait=${cfg.maxFillWaitMs}ms` : ''}`);
  if (cfg.sweep) {
    console.log(`Sweep mode=${cfg.sweepMode} edges=${cfg.sweepRelaxedMinEdges.join(',')} cexBps=${cfg.sweepCexThresholdBps.join(',')} composites=${cfg.sweepMinComposites.join(',')}`);
  }

  const bundles = await buildMarketBundles(polymarketFiles, cexIndex, table, cfg);
  const train = bundles.filter((bundle) => bundle.market.endDateMs <= cfg.trainUntilMs);
  const test = bundles.filter((bundle) => bundle.market.endDateMs > cfg.trainUntilMs);
  console.log(`Train markets: ${train.length}  Test markets: ${test.length}`);
  if (train.length === 0 || test.length === 0) throw new Error('Need non-empty train and test sets.');

  const model = fitCexModel(train, cfg);
  printModel(model);

  const attemptsByMode = new Map<ModeName, EntryAttempt[]>();
  for (const mode of MODES) attemptsByMode.set(mode, []);

  const sortedTest = [...test].sort((left, right) => left.market.endDateMs - right.market.endDateMs);
  for (const bundle of sortedTest) {
    for (const mode of MODES) {
      const attempt = simulateMode(bundle, mode, table, model, cfg);
      if (attempt) attemptsByMode.get(mode)!.push(attempt);
    }
  }

  const stats = MODES.map((mode) => summarize(mode, attemptsByMode.get(mode)!));
  renderStats(stats);
  renderCexFilterDeltas(stats);
  renderByDay(stats);
  renderTrades(stats, cfg);

  if (cfg.sweep) {
    const sweepRows = runSweep(sortedTest, table, model, cfg);
    renderSweep(sweepRows, cfg);
  }
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
