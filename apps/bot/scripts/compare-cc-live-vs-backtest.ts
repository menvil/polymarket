#!/usr/bin/env tsx
/**
 * Compare CalibratedCrowd replay decisions with real live journal results.
 *
 * The replay is an intent-level simulation: it answers "would the strategy have
 * posted an entry, at what price/size, and what hold-to-expiry PnL would that
 * imply if filled?". It does not try to reconstruct queue position on CLOB.
 */
/* eslint-disable no-console */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { EdgeTable, type EdgeZone, type Regime } from '../src/strategies/calibrated-crowd/EdgeTable.js';
import { classifyRegime, parseSnapshot, type MarketData, type Observation } from './analyze-crowd-calibration.js';

interface Config {
  readonly recordingsDir: string;
  readonly journalsDir: string;
  readonly tablePath: string;
  readonly asset: string;
  readonly token: 'up' | 'down';
  readonly minComposite: number;
  readonly maxPositionFraction: number;
  readonly maxSharesPerMarket: number | null;
  readonly warmupSec: number;
  readonly initialCapital: number;
  readonly minOrderSize: number;
  readonly minOrderValue: number;
}

interface JournalOrder {
  readonly ts: number;
  readonly side: 'BUY' | 'SELL';
  readonly price: number;
  readonly size: number;
  readonly orderId?: string;
}

interface JournalFill {
  readonly ts: number;
  readonly side: 'BUY' | 'SELL';
  readonly price: number;
  readonly size: number;
  readonly notional: number;
  readonly orderId?: string;
}

interface JournalSummary {
  readonly path: string;
  readonly shortId: string;
  readonly question: string;
  readonly expiresAtMs: number;
  readonly eventStartMs: number;
  readonly orders: JournalOrder[];
  readonly fills: JournalFill[];
  readonly resolution: 'UP' | 'DOWN' | 'UNKNOWN';
  readonly settlementCredit: number;
}

interface ReplayTrade {
  readonly tsMs: number;
  readonly tauSec: number;
  readonly priceCents: number;
  readonly size: number;
  readonly notional: number;
  readonly pnl: number;
  readonly resolution: 'UP' | 'DOWN';
  readonly regime: Regime;
  readonly zone: EdgeZone;
  readonly observation: Observation;
}

interface Row {
  readonly shortId: string;
  readonly label: string;
  readonly resolution: string;
  readonly replay: ReplayTrade | null;
  readonly live: JournalSummary | null;
  readonly parseError?: string;
}

function parseCli(): Config {
  const args = process.argv.slice(2);
  const cfg: Record<string, unknown> = {
    recordingsDir: 'data/live-recordings/2026-04-21',
    journalsDir: 'data/journals/2026-04-21',
    tablePath: 'tables/edge-table-5min.json',
    asset: 'bitcoin',
    token: 'up',
    minComposite: 0.3,
    maxPositionFraction: 0.05,
    maxSharesPerMarket: 5,
    warmupSec: 15,
    initialCapital: 1000,
    minOrderSize: 5,
    minOrderValue: 1,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const next = args[i + 1];
    if (a === '--recordings' && next) { cfg.recordingsDir = next; i++; }
    else if (a === '--journals' && next) { cfg.journalsDir = next; i++; }
    else if (a === '--table' && next) { cfg.tablePath = next; i++; }
    else if (a === '--asset' && next) { cfg.asset = next; i++; }
    else if (a === '--token' && next) { cfg.token = next; i++; }
    else if (a === '--min-composite' && next) { cfg.minComposite = Number(next); i++; }
    else if (a === '--max-position-fraction' && next) { cfg.maxPositionFraction = Number(next); i++; }
    else if (a === '--max-shares' && next) { cfg.maxSharesPerMarket = Number(next); i++; }
    else if (a === '--no-max-shares') { cfg.maxSharesPerMarket = null; }
    else if (a === '--warmup-sec' && next) { cfg.warmupSec = Number(next); i++; }
    else if (a === '--initial-capital' && next) { cfg.initialCapital = Number(next); i++; }
    else if (a === '--min-order-size' && next) { cfg.minOrderSize = Number(next); i++; }
    else if (a === '--min-order-value' && next) { cfg.minOrderValue = Number(next); i++; }
    else if (a === '--help') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }

  if (cfg.token !== 'up' && cfg.token !== 'down') {
    throw new Error('--token must be up or down');
  }

  return cfg as unknown as Config;
}

function printUsage(): void {
  console.log(`Usage:
  npx tsx scripts/compare-cc-live-vs-backtest.ts \\
    --recordings data/live-recordings/2026-04-21 \\
    --journals data/journals/2026-04-21 \\
    --table tables/edge-table-5min.json \\
    --min-composite 0.3 --max-position-fraction 0.05 --max-shares 5
`);
}

function listFiles(dir: string, predicate: (name: string) => boolean): string[] {
  const resolved = resolve(dir);
  if (!statSync(resolved).isDirectory()) return [];
  return readdirSync(resolved)
    .filter(predicate)
    .map((f) => join(resolved, f))
    .sort();
}

function shortIdFromPath(filePath: string): string {
  const match = filePath.match(/___(0x[0-9a-f]+)/i);
  if (match) return match[1]!.toLowerCase();
  return filePath;
}

function labelFromQuestion(question: string, fallback: string): string {
  const match = question.match(/April 21,\s*([0-9:]+[AP]M-[0-9:]+[AP]M ET)/i);
  if (match) return match[1]!.replace(':', '');
  return fallback.slice(0, 14);
}

function parseJournal(filePath: string): JournalSummary {
  const shortId = shortIdFromPath(filePath);
  const orders: JournalOrder[] = [];
  const fills: JournalFill[] = [];
  let question = '';
  let expiresAtMs = 0;
  let eventStartMs = 0;
  let resolution: JournalSummary['resolution'] = 'UNKNOWN';
  let settlementCredit = 0;

  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try { record = JSON.parse(line) as Record<string, unknown>; } catch { continue; }

    if (record.t === 'session_start') {
      question = String(record.marketQuestion ?? '');
      expiresAtMs = Number(record.expiresAtMs ?? 0);
      eventStartMs = Number(record.eventStartMs ?? 0);
    } else if (record.t === 'order') {
      const side = record.side === 'SELL' ? 'SELL' : 'BUY';
      orders.push({
        ts: Number(record.ts ?? 0),
        side,
        price: Number(record.price ?? 0),
        size: Number(record.size ?? 0),
        orderId: record.orderId !== undefined ? String(record.orderId) : undefined,
      });
    } else if (record.t === 'fill') {
      const side = record.side === 'SELL' ? 'SELL' : 'BUY';
      const price = Number(record.price ?? 0);
      const size = Number(record.size ?? 0);
      const notional = Number(record.notional ?? price * size);
      fills.push({
        ts: Number(record.ts ?? 0),
        side,
        price,
        size,
        notional,
        orderId: record.orderId !== undefined ? String(record.orderId) : undefined,
      });
    } else if (record.t === 'resolution') {
      resolution = record.resolution === 'UP' || record.resolution === 'DOWN'
        ? record.resolution
        : 'UNKNOWN';
      settlementCredit = Number(record.pnl ?? 0);
    }
  }

  return {
    path: filePath,
    shortId,
    question,
    expiresAtMs,
    eventStartMs,
    orders,
    fills,
    resolution,
    settlementCredit,
  };
}

function computeEntryBidCents(obs: Observation): number {
  const aggressive = Math.round(obs.bestBidCents) + 1;
  const bid = aggressive < Math.round(obs.bestAskCents)
    ? aggressive
    : Math.round(obs.bestBidCents);
  return Math.max(1, Math.min(99, bid));
}

function simulateReplayTrade(
  md: MarketData,
  table: EdgeTable,
  cfg: Config,
  capital: number,
): ReplayTrade | null {
  if (md.duration !== '5min' || md.observations.length === 0) return null;
  const marketStartMs = md.endDateMs - md.durationMin * 60_000;
  const regimeThreshold = table.meta.bucketing.regimeThreshold;

  for (const obs of md.observations) {
    if (obs.tsMs - marketStartMs < cfg.warmupSec * 1000) continue;

    const regime = classifyRegime(obs.trendSlope, regimeThreshold);
    const zone = table.lookup({
      deltaDollars: obs.delta,
      tauSec: obs.tauSec,
      midCents: obs.midPriceCents,
      regime,
    });
    if (!zone) continue;
    if (zone.signal !== 'BUY' || zone.kelly.side !== 'UP') continue;
    if (zone.weights.composite < cfg.minComposite) continue;
    if (zone.kelly.size <= 0) continue;

    const fraction = Math.min(zone.kelly.size, cfg.maxPositionFraction);
    const notionalTarget = capital * fraction;
    if (notionalTarget <= 0) continue;

    const bidCents = computeEntryBidCents(obs);
    const priceDollars = bidCents / 100;
    let size = Math.floor(notionalTarget / priceDollars);
    const sharesCap = cfg.maxSharesPerMarket;

    if (size < cfg.minOrderSize) {
      const bumped = cfg.minOrderSize;
      if (sharesCap !== null && bumped > sharesCap) continue;
      if (bumped * priceDollars > capital) continue;
      size = bumped;
    }

    if (sharesCap !== null) size = Math.min(size, sharesCap);

    if (size * priceDollars < cfg.minOrderValue) {
      size = Math.ceil(cfg.minOrderValue / priceDollars);
    }
    if (size < cfg.minOrderSize) continue;

    const notional = size * priceDollars;
    if (notional > capital) continue;

    const exitCents = md.resolution === 'UP' ? 100 : 0;
    return {
      tsMs: obs.tsMs,
      tauSec: obs.tauSec,
      priceCents: bidCents,
      size,
      notional,
      pnl: size * ((exitCents - bidCents) / 100),
      resolution: md.resolution,
      regime,
      zone,
      observation: obs,
    };
  }

  return null;
}

function liveBuyCost(live: JournalSummary): number {
  return live.fills
    .filter((f) => f.side === 'BUY')
    .reduce((sum, f) => sum + f.notional, 0);
}

function liveSellCredit(live: JournalSummary): number {
  return live.fills
    .filter((f) => f.side === 'SELL')
    .reduce((sum, f) => sum + f.notional, 0);
}

function liveNet(live: JournalSummary): number {
  return liveSellCredit(live) + live.settlementCredit - liveBuyCost(live);
}

function liveBuyShares(live: JournalSummary): number {
  return live.fills
    .filter((f) => f.side === 'BUY')
    .reduce((sum, f) => sum + f.size, 0);
}

function liveAvgBuyCents(live: JournalSummary): number | null {
  const shares = liveBuyShares(live);
  if (shares <= 0) return null;
  return liveBuyCost(live) / shares * 100;
}

function firstBuyOrderCents(live: JournalSummary): number | null {
  const order = live.orders.find((o) => o.side === 'BUY');
  return order ? order.price * 100 : null;
}

function formatCents(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '-' : `${v.toFixed(0)}c`;
}

function formatMoney(v: number): string {
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}`;
}

function formatSize(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '-' : v.toFixed(0);
}

function formatPct(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '-' : `${(v * 100).toFixed(0)}%`;
}

function zoneMarketN(zone: EdgeZone): number {
  return zone.train.nMarkets ?? zone.train.n;
}

function zoneObservationN(zone: EdgeZone): number {
  return zone.train.nObservations ?? zone.train.n;
}

function replayExpectedPnl(replay: ReplayTrade, probability: number): number {
  return replay.size * (probability - replay.priceCents / 100);
}

function liveExpectedPnl(row: Row, probability: number): number {
  if (!row.live) return 0;
  const shares = liveBuyShares(row.live);
  const avgCents = liveAvgBuyCents(row.live);
  if (shares <= 0 || avgCents === null) return 0;
  return shares * (probability - avgCents / 100);
}

function flagsFor(row: Row, cfg: Config): string {
  if (row.parseError) return row.parseError;
  const live = row.live;
  const replay = row.replay;
  const flags: string[] = [];
  const liveShares = live ? liveBuyShares(live) : 0;
  const liveOrderCents = live ? firstBuyOrderCents(live) : null;

  if (replay && liveShares <= 0) flags.push('BT_ONLY');
  if (!replay && liveShares > 0) flags.push('LIVE_ONLY');
  if (replay && liveShares > 0) flags.push('BOTH');
  if (cfg.maxSharesPerMarket !== null && liveShares > cfg.maxSharesPerMarket) flags.push('OVERFILL');
  if (replay && liveShares > 0 && Math.abs(liveShares - replay.size) > 0.001) flags.push('SIZE_DIFF');
  if (replay && liveOrderCents !== null && Math.abs(liveOrderCents - replay.priceCents) >= 1) flags.push('ORDER_PRICE_DIFF');
  if (live && live.orders.length > live.fills.length + 1) flags.push('ORDER_CHURN');

  return flags.length > 0 ? flags.join(',') : '-';
}

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length);
}

function printRows(rows: Row[], cfg: Config): void {
  console.log([
    pad('market', 14),
    pad('res', 4),
    pad('bt_px', 6),
    pad('bt_sz', 5),
    pad('pHat', 6),
    pad('pLow', 6),
    pad('n_mkt', 6),
    pad('n_obs', 7),
    pad('bt_ev', 8),
    pad('bt_pnl', 8),
    pad('live_ord', 8),
    pad('live_sh', 7),
    pad('live_avg', 8),
    pad('live_net', 9),
    'flags',
  ].join(' '));

  for (const row of rows) {
    const live = row.live;
    const replay = row.replay;
    const liveShares = live ? liveBuyShares(live) : 0;
    const liveAvg = live ? liveAvgBuyCents(live) : null;
    console.log([
      pad(row.label, 14),
      pad(row.resolution, 4),
      pad(formatCents(replay?.priceCents), 6),
      pad(formatSize(replay?.size), 5),
      pad(formatPct(replay?.zone.train.pHat), 6),
      pad(formatPct(replay?.zone.train.pLow), 6),
      pad(replay ? String(zoneMarketN(replay.zone)) : '-', 6),
      pad(replay ? String(zoneObservationN(replay.zone)) : '-', 7),
      pad(replay ? formatMoney(replayExpectedPnl(replay, replay.zone.train.pHat)) : '-', 8),
      pad(replay ? formatMoney(replay.pnl) : '-', 8),
      pad(String(live?.orders.filter((o) => o.side === 'BUY').length ?? 0), 8),
      pad(formatSize(liveShares), 7),
      pad(formatCents(liveAvg), 8),
      pad(live ? formatMoney(liveNet(live)) : '-', 9),
      flagsFor(row, cfg),
    ].join(' '));
  }
}

function printSummary(rows: Row[], cfg: Config): void {
  const replayTrades = rows.filter((r) => r.replay);
  const liveRows = rows.filter((r) => r.live);
  const liveFilledRows = liveRows.filter((r) => r.live && liveBuyShares(r.live) > 0);
  const replayPnl = replayTrades.reduce((sum, r) => sum + (r.replay?.pnl ?? 0), 0);
  const replayCost = replayTrades.reduce((sum, r) => sum + (r.replay?.notional ?? 0), 0);
  const liveCost = liveRows.reduce((sum, r) => sum + (r.live ? liveBuyCost(r.live) : 0), 0);
  const liveSettlement = liveRows.reduce((sum, r) => sum + (r.live?.settlementCredit ?? 0), 0);
  const liveNetTotal = liveRows.reduce((sum, r) => sum + (r.live ? liveNet(r.live) : 0), 0);
  const btOnly = rows.filter((r) => r.replay && (!r.live || liveBuyShares(r.live) <= 0)).length;
  const liveOnly = rows.filter((r) => !r.replay && r.live && liveBuyShares(r.live) > 0).length;
  const both = rows.filter((r) => r.replay && r.live && liveBuyShares(r.live) > 0).length;
  const overfills = rows.filter((r) => (
    cfg.maxSharesPerMarket !== null && r.live !== null && liveBuyShares(r.live) > cfg.maxSharesPerMarket
  )).length;
  const btOnlyReplayPnl = rows
    .filter((r) => r.replay && (!r.live || liveBuyShares(r.live) <= 0))
    .reduce((sum, r) => sum + (r.replay?.pnl ?? 0), 0);
  const liveFilledReplayPnl = rows
    .filter((r) => r.replay && r.live && liveBuyShares(r.live) > 0)
    .reduce((sum, r) => sum + (r.replay?.pnl ?? 0), 0);
  const sameFilledExecutionDelta = liveNetTotal - liveFilledReplayPnl;
  const overfillExecutionDelta = rows
    .filter((r) => (
      r.replay &&
      r.live &&
      cfg.maxSharesPerMarket !== null &&
      liveBuyShares(r.live) > cfg.maxSharesPerMarket
    ))
    .reduce((sum, r) => sum + (r.live ? liveNet(r.live) : 0) - (r.replay?.pnl ?? 0), 0);
  const nonOverfillExecutionDelta = sameFilledExecutionDelta - overfillExecutionDelta;
  const totalGap = liveNetTotal - replayPnl;
  const expectedWins = replayTrades.reduce((sum, r) => sum + (r.replay?.zone.train.pHat ?? 0), 0);
  const expectedWinVariance = replayTrades.reduce((sum, r) => {
    const p = r.replay?.zone.train.pHat ?? 0;
    return sum + p * (1 - p);
  }, 0);
  const actualReplayWins = replayTrades.filter((r) => r.replay?.resolution === 'UP').length;
  const winSigma = Math.sqrt(expectedWinVariance);
  const winZ = winSigma > 0 ? (actualReplayWins - expectedWins) / winSigma : 0;
  const tableEvReplay = replayTrades.reduce((sum, r) => {
    const replay = r.replay;
    return replay ? sum + replayExpectedPnl(replay, replay.zone.train.pHat) : sum;
  }, 0);
  const tableLowReplay = replayTrades.reduce((sum, r) => {
    const replay = r.replay;
    return replay ? sum + replayExpectedPnl(replay, replay.zone.train.pLow) : sum;
  }, 0);
  const liveFilledWithReplay = rows.filter((r) => r.replay && r.live && liveBuyShares(r.live) > 0);
  const tableEvLiveFilled = liveFilledWithReplay.reduce((sum, r) => {
    const replay = r.replay;
    return replay ? sum + liveExpectedPnl(r, replay.zone.train.pHat) : sum;
  }, 0);
  const tableLowLiveFilled = liveFilledWithReplay.reduce((sum, r) => {
    const replay = r.replay;
    return replay ? sum + liveExpectedPnl(r, replay.zone.train.pLow) : sum;
  }, 0);
  const liveFilledExpectedWins = liveFilledWithReplay.reduce((sum, r) => sum + (r.replay?.zone.train.pHat ?? 0), 0);
  const avgN = replayTrades.length > 0
    ? replayTrades.reduce((sum, r) => sum + (r.replay?.zone.train.n ?? 0), 0) / replayTrades.length
    : 0;
  const avgMarkets = replayTrades.length > 0
    ? replayTrades.reduce((sum, r) => sum + (r.replay ? zoneMarketN(r.replay.zone) : 0), 0) / replayTrades.length
    : 0;
  const avgObservations = replayTrades.length > 0
    ? replayTrades.reduce((sum, r) => sum + (r.replay ? zoneObservationN(r.replay.zone) : 0), 0) / replayTrades.length
    : 0;
  const avgComposite = replayTrades.length > 0
    ? replayTrades.reduce((sum, r) => sum + (r.replay?.zone.weights.composite ?? 0), 0) / replayTrades.length
    : 0;
  const avgKelly = replayTrades.length > 0
    ? replayTrades.reduce((sum, r) => sum + (r.replay?.zone.kelly.size ?? 0), 0) / replayTrades.length
    : 0;

  console.log('\nSummary');
  console.log(`  markets:       ${rows.length}`);
  console.log(`  parsed replay: ${rows.filter((r) => !r.parseError).length}`);
  console.log(`  replay trades: ${replayTrades.length}  cost=${replayCost.toFixed(2)}  pnl=${formatMoney(replayPnl)}`);
  console.log(`  live filled:   ${liveFilledRows.length}  cost=${liveCost.toFixed(2)}  settlement=${liveSettlement.toFixed(2)}  net=${formatMoney(liveNetTotal)}`);
  console.log(`  both/bt/live:  both=${both}  bt_only=${btOnly}  live_only=${liveOnly}  overfills=${overfills}`);
  console.log('\nGap decomposition');
  console.log(`  live - replay(all optimistic):      ${formatMoney(totalGap)}`);
  console.log(`  replay PnL from BT_ONLY orders:     ${formatMoney(btOnlyReplayPnl)}  (optimistic fills that live did not get)`);
  console.log(`  replay PnL on live-filled markets:  ${formatMoney(liveFilledReplayPnl)}`);
  console.log(`  live - replay(live-filled only):    ${formatMoney(sameFilledExecutionDelta)}`);
  console.log(`    overfill rows contribution:       ${formatMoney(overfillExecutionDelta)}`);
  console.log(`    other execution contribution:     ${formatMoney(nonOverfillExecutionDelta)}`);
  console.log('\nCalibration table expectation');
  console.log(`  replay expected WR:                 ${formatPct(replayTrades.length > 0 ? expectedWins / replayTrades.length : 0)}  (${expectedWins.toFixed(2)} wins / ${replayTrades.length})`);
  console.log(`  replay actual WR:                   ${formatPct(replayTrades.length > 0 ? actualReplayWins / replayTrades.length : 0)}  (${actualReplayWins}/${replayTrades.length}, z=${winZ.toFixed(2)}σ)`);
  console.log(`  table EV on replay entries:         ${formatMoney(tableEvReplay)}  conservative(pLow)=${formatMoney(tableLowReplay)}`);
  console.log(`  realized replay PnL:                ${formatMoney(replayPnl)}`);
  console.log(`  table EV on live-filled exposure:   ${formatMoney(tableEvLiveFilled)}  conservative(pLow)=${formatMoney(tableLowLiveFilled)}`);
  console.log(`  live actual net:                    ${formatMoney(liveNetTotal)}  expected wins=${liveFilledExpectedWins.toFixed(2)} / ${liveFilledWithReplay.length}`);
  console.log(`  avg table n/composite/kelly:        nEff=${avgN.toFixed(0)}  nMarkets=${avgMarkets.toFixed(0)}  nObs=${avgObservations.toFixed(0)}  composite=${avgComposite.toFixed(2)}  kelly=${avgKelly.toFixed(3)}`);
}

async function buildRows(cfg: Config): Promise<Row[]> {
  const table = EdgeTable.fromFile(cfg.tablePath);
  const recordings = listFiles(cfg.recordingsDir, (f) => (
    f.toLowerCase().includes(cfg.asset) && (f.endsWith('.jsonl') || f.endsWith('.jsonl.gz'))
  ));
  const journalFiles = listFiles(cfg.journalsDir, (f) => f.endsWith('.journal.jsonl'));
  const journals = new Map<string, JournalSummary>();
  for (const file of journalFiles) {
    const summary = parseJournal(file);
    journals.set(summary.shortId, summary);
  }

  const rows: Row[] = [];
  for (const file of recordings) {
    const shortId = shortIdFromPath(file);
    const live = journals.get(shortId) ?? null;
    const label = live ? labelFromQuestion(live.question, shortId) : shortId.slice(0, 14);

    const parsed = await parseSnapshot(file, table.meta.bucketing.maxTau, cfg.token, true);
    if (!parsed.data) {
      rows.push({
        shortId,
        label,
        resolution: live?.resolution ?? 'UNK',
        replay: null,
        live,
        parseError: parsed.skipReason ?? 'parse_error',
      });
      continue;
    }

    const replay = simulateReplayTrade(parsed.data, table, cfg, cfg.initialCapital);
    rows.push({
      shortId,
      label: labelFromQuestion(live?.question ?? parsed.data.slug, label),
      resolution: parsed.data.resolution,
      replay,
      live,
    });
  }

  rows.sort((a, b) => (a.live?.expiresAtMs ?? 0) - (b.live?.expiresAtMs ?? 0));
  return rows;
}

async function main(): Promise<void> {
  const cfg = parseCli();
  const table = EdgeTable.fromFile(cfg.tablePath);
  console.log(`recordings=${cfg.recordingsDir}`);
  console.log(`journals=${cfg.journalsDir}`);
  console.log(`table=${cfg.tablePath} sampleMode=${table.meta.sampleMode ?? 'legacy-observations'} minComposite=${cfg.minComposite} maxPos=${cfg.maxPositionFraction} maxShares=${cfg.maxSharesPerMarket ?? 'none'}\n`);

  const rows = await buildRows(cfg);
  printRows(rows, cfg);
  printSummary(rows, cfg);
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
