/**
 * Builds an exit-policy calibration table for already-open 5 minute positions.
 *
 * The table is side-aware and entry-aware. It compares the empirical final
 * payout probability against the executable current bid, so runtime can answer:
 * "Given I bought at X and can sell at Y now, should I keep holding?"
 *
 * Example:
 *   npx tsx scripts/build-exit-policy-table.ts \
 *     --snapshots ./data/live-recordings-cll \
 *     --asset bitcoin \
 *     --out tables/exit-policy-5min.json \
 *     --entry-min 40 --entry-max 85 --entry-step 5 \
 *     --current-step 5 --tau-step 20 --delta-step 10
 */

/* eslint-disable no-console */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  classifyRegime,
  parseSnapshot,
  type MarketData,
  type Observation,
  type Regime,
} from './analyze-crowd-calibration';

type Side = 'up' | 'down';
type Recommendation = 'HOLD' | 'EXIT' | 'SKIP';

interface Args {
  dirs: string[];
  outFile: string;
  asset: string;
  entryMin: number;
  entryMax: number;
  entryStep: number;
  currentStep: number;
  tauStep: number;
  deltaStep: number;
  maxTau: number;
  maxDelta: number;
  regimeThreshold: number;
  minN: number;
  minHoldEdgeCents: number;
  exitEdgeCents: number;
  approxResolution: boolean;
}

interface Key {
  side: Side;
  entry: number;
  current: number;
  tau: number;
  delta: number;
  regime: Regime;
}

interface Accum {
  n: number;
  markets: Set<string>;
  wins: number;
  entrySum: number;
  currentBidSum: number;
  holdPnlSum: number;
  exitNowPnlSum: number;
  hitPlus5: number;
  hitPlus8: number;
  hitPlus12: number;
  hitStop5: number;
  hitStop8: number;
  hitStop12: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = {
    dirs: [],
    outFile: '',
    asset: 'bitcoin',
    entryMin: 40,
    entryMax: 85,
    entryStep: 5,
    currentStep: 5,
    tauStep: 20,
    deltaStep: 10,
    maxTau: 300,
    maxDelta: 250,
    regimeThreshold: 10,
    minN: 20,
    minHoldEdgeCents: 3,
    exitEdgeCents: 1,
    approxResolution: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--snapshots') args.dirs = argv[++i].split(',');
    else if (a === '--out') args.outFile = argv[++i];
    else if (a === '--asset') args.asset = argv[++i].toLowerCase();
    else if (a === '--entry-min') args.entryMin = Number(argv[++i]);
    else if (a === '--entry-max') args.entryMax = Number(argv[++i]);
    else if (a === '--entry-step') args.entryStep = Number(argv[++i]);
    else if (a === '--current-step') args.currentStep = Number(argv[++i]);
    else if (a === '--tau-step') args.tauStep = Number(argv[++i]);
    else if (a === '--delta-step') args.deltaStep = Number(argv[++i]);
    else if (a === '--max-tau') args.maxTau = Number(argv[++i]);
    else if (a === '--max-delta') args.maxDelta = Number(argv[++i]);
    else if (a === '--regime-threshold') args.regimeThreshold = Number(argv[++i]);
    else if (a === '--min-n') args.minN = Number(argv[++i]);
    else if (a === '--min-hold-edge-cents') args.minHoldEdgeCents = Number(argv[++i]);
    else if (a === '--exit-edge-cents') args.exitEdgeCents = Number(argv[++i]);
    else if (a === '--no-approx-resolution') args.approxResolution = false;
  }

  if (!args.dirs.length || !args.outFile) {
    console.error('Usage: npx tsx scripts/build-exit-policy-table.ts --snapshots dir[,dir2] --out tables/exit-policy-5min.json');
    process.exit(1);
  }
  return args;
}

function listSnapshotFiles(path: string): string[] {
  const out: string[] = [];
  function walk(p: string): void {
    for (const name of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, name.name);
      if (name.isDirectory()) walk(full);
      else if (name.isFile() && (full.endsWith('.jsonl') || full.endsWith('.jsonl.gz'))) out.push(full);
    }
  }
  walk(path);
  return out.sort();
}

function toBucket(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

function keyStr(k: Key): string {
  return `${k.side}:${k.entry}:${k.current}:${k.tau}:${k.delta}:${k.regime}`;
}

function newAccum(): Accum {
  return {
    n: 0,
    markets: new Set(),
    wins: 0,
    entrySum: 0,
    currentBidSum: 0,
    holdPnlSum: 0,
    exitNowPnlSum: 0,
    hitPlus5: 0,
    hitPlus8: 0,
    hitPlus12: 0,
    hitStop5: 0,
    hitStop8: 0,
    hitStop12: 0,
  };
}

function wilsonCi(successes: number, n: number): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 };
  const z = 1.96;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const margin = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / denom;
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}

function sideBid(o: Observation, side: Side): number {
  return side === 'up' ? o.bestBidCents : 100 - o.bestAskCents;
}

function finalPayout(m: MarketData, side: Side): number {
  return (side === 'up' && m.resolution === 'UP') || (side === 'down' && m.resolution === 'DOWN')
    ? 100
    : 0;
}

function matchesAsset(slug: string, asset: string): boolean {
  if (!asset) return true;
  const s = slug.toLowerCase();
  const a = asset.toLowerCase();
  if (s.includes(a)) return true;
  if (a === 'bitcoin' && s.includes('btc')) return true;
  if (a === 'ethereum' && s.includes('eth')) return true;
  return false;
}

function observeMarket(m: MarketData, args: Args, map: Map<string, Accum>): number {
  const obs = m.observations;
  const seen = new Set<string>();
  let used = 0;

  const futureBySide = new Map<Side, Array<{ maxBid: number; minBid: number }>>();
  for (const side of ['up', 'down'] as const) {
    const arr = new Array<{ maxBid: number; minBid: number }>(obs.length);
    let maxBid = -Infinity;
    let minBid = Infinity;
    for (let i = obs.length - 1; i >= 0; i--) {
      const bid = sideBid(obs[i], side);
      maxBid = Math.max(maxBid, bid);
      minBid = Math.min(minBid, bid);
      arr[i] = { maxBid, minBid };
    }
    futureBySide.set(side, arr);
  }

  for (let i = 0; i < obs.length; i++) {
    const o = obs[i];
    if (o.tauSec < 0 || o.tauSec > args.maxTau) continue;
    if (Math.abs(o.delta) > args.maxDelta) continue;

    for (const side of ['up', 'down'] as const) {
      const currentBid = sideBid(o, side);
      if (!Number.isFinite(currentBid) || currentBid < 1 || currentBid > 99) continue;

      const payout = finalPayout(m, side);
      const won = payout === 100;
      const future = futureBySide.get(side)![i];

      for (let entry = args.entryMin; entry <= args.entryMax; entry += args.entryStep) {
        const key: Key = {
          side,
          entry: toBucket(entry, args.entryStep),
          current: toBucket(currentBid, args.currentStep),
          tau: toBucket(o.tauSec, args.tauStep),
          delta: toBucket(o.delta, args.deltaStep),
          regime: classifyRegime(o.trendSlope, args.regimeThreshold),
        };
        const ks = keyStr(key);
        const dedupeKey = `${m.slug}:${ks}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        let a = map.get(ks);
        if (!a) {
          a = newAccum();
          map.set(ks, a);
        }
        a.n++;
        a.markets.add(m.slug);
        if (won) a.wins++;
        a.entrySum += entry;
        a.currentBidSum += currentBid;
        a.holdPnlSum += payout - entry;
        a.exitNowPnlSum += currentBid - entry;
        if (future.maxBid >= entry + 5) a.hitPlus5++;
        if (future.maxBid >= entry + 8) a.hitPlus8++;
        if (future.maxBid >= entry + 12) a.hitPlus12++;
        if (future.minBid <= entry - 5) a.hitStop5++;
        if (future.minBid <= entry - 8) a.hitStop8++;
        if (future.minBid <= entry - 12) a.hitStop12++;
        used++;
      }
    }
  }

  return used;
}

function recommendation(
  a: Accum,
  minN: number,
  minHoldEdgeCents: number,
  exitEdgeCents: number,
): { recommendation: Recommendation; reason: string } {
  if (a.n < minN) return { recommendation: 'SKIP', reason: 'low_n' };
  const { low, high } = wilsonCi(a.wins, a.n);
  const avgCurrent = a.currentBidSum / a.n;
  const pHatCents = (a.wins / a.n) * 100;
  const pLowCents = low * 100;
  const pHighCents = high * 100;

  if (pLowCents >= avgCurrent + minHoldEdgeCents) {
    return { recommendation: 'HOLD', reason: 'p_low_above_current_bid' };
  }
  if (pHighCents <= avgCurrent - exitEdgeCents) {
    return { recommendation: 'EXIT', reason: 'p_high_below_current_bid' };
  }
  if (pHatCents <= avgCurrent - exitEdgeCents) {
    return { recommendation: 'EXIT', reason: 'p_hat_below_current_bid' };
  }
  return { recommendation: 'SKIP', reason: 'uncertain' };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const files = args.dirs.flatMap(listSnapshotFiles);
  const map = new Map<string, Accum>();
  let markets = 0;
  let observations = 0;

  for (const file of files) {
    const parsed = await parseSnapshot(file, args.maxTau, 'up', args.approxResolution);
    if (!parsed.data) continue;
    if (!matchesAsset(parsed.data.slug, args.asset)) continue;
    if (parsed.data.duration !== '5min') continue;
    markets++;
    observations += observeMarket(parsed.data, args, map);
  }

  const zones = [];
  for (const [ks, a] of map) {
    if (a.n < args.minN) continue;
    const [side, entry, current, tau, delta, regime] = ks.split(':');
    const ci = wilsonCi(a.wins, a.n);
    const rec = recommendation(a, args.minN, args.minHoldEdgeCents, args.exitEdgeCents);
    zones.push({
      key: {
        side,
        entry: Number(entry),
        current: Number(current),
        tau: Number(tau),
        delta: Number(delta),
        regime,
      },
      stats: {
        n: a.n,
        nMarkets: a.markets.size,
        winRate: a.wins / a.n,
        pLow: ci.low,
        pHigh: ci.high,
        avgEntryCents: a.entrySum / a.n,
        avgCurrentBidCents: a.currentBidSum / a.n,
        avgHoldPnlCents: a.holdPnlSum / a.n,
        avgExitNowPnlCents: a.exitNowPnlSum / a.n,
        holdEdgeVsExitCents: a.holdPnlSum / a.n - a.exitNowPnlSum / a.n,
        hitPlus5Rate: a.hitPlus5 / a.n,
        hitPlus8Rate: a.hitPlus8 / a.n,
        hitPlus12Rate: a.hitPlus12 / a.n,
        hitStop5Rate: a.hitStop5 / a.n,
        hitStop8Rate: a.hitStop8 / a.n,
        hitStop12Rate: a.hitStop12 / a.n,
      },
      recommendation: rec.recommendation,
      reason: rec.reason,
    });
  }

  zones.sort((a, b) =>
    String(a.key.side).localeCompare(String(b.key.side)) ||
    Number(a.key.tau) - Number(b.key.tau) ||
    Number(a.key.delta) - Number(b.key.delta) ||
    Number(a.key.entry) - Number(b.key.entry) ||
    Number(a.key.current) - Number(b.key.current),
  );

  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      duration: '5min',
      asset: args.asset,
      bucketing: {
        entryStep: args.entryStep,
        currentStep: args.currentStep,
        tauStep: args.tauStep,
        deltaStep: args.deltaStep,
        maxTau: args.maxTau,
        maxDelta: args.maxDelta,
        regimeThreshold: args.regimeThreshold,
      },
      gates: {
        minN: args.minN,
        minHoldEdgeCents: args.minHoldEdgeCents,
        exitEdgeCents: args.exitEdgeCents,
      },
      training: {
        marketCount: markets,
        observationCount: observations,
      },
    },
    zones,
  };

  if (!existsSync(dirname(args.outFile))) mkdirSync(dirname(args.outFile), { recursive: true });
  writeFileSync(args.outFile, JSON.stringify(out, null, 2));
  console.log(`Wrote ${zones.length} zones from ${markets} markets to ${args.outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
