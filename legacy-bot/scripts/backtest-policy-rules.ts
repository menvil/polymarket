/**
 * Backtest explicit whitelist policy rules on snapshot markets.
 *
 * @remarks
 * Purpose: verify whether a manually curated list of calibration rules
 * performs as a standalone strategy.
 *
 * Model:
 * - one entry max per market
 * - entry on first matching observation after warmup
 * - maker buy at bestBid+1 (capped below ask; fallback bestBid)
 * - hold to expiry
 * - UP-only / DOWN-only supported by rule side, but current BTC rules are UP
 *
 * Example:
 * ```bash
 * cd apps/bot
 * npx tsx scripts/backtest-policy-rules.ts \
 *   --snapshots "$S/2026-04-16/polymarket,$S/2026-04-17/polymarket" \
 *   --rules configs/crowd-policy-rules-btc.json \
 *   --asset bitcoin \
 *   --token both
 * ```
 */
/* eslint-disable no-console */
import { readFileSync } from 'fs';
import { readdir } from 'fs/promises';
import { join, resolve } from 'path';
import { classifyRegime, parseSnapshot, type MarketData, type Observation, type Regime } from './analyze-crowd-calibration.js';

interface RuleFile {
  readonly name?: string;
  readonly notes?: readonly string[];
  readonly rules: readonly PolicyRule[];
}

interface PolicyRule {
  readonly id: string;
  readonly label: string;
  readonly side: 'UP' | 'DOWN';
  readonly deltaMin: number;
  readonly deltaMax: number;
  readonly tauMin: number;
  readonly tauMax: number;
  readonly regimes: readonly Regime[];
  readonly crowdMin?: number;
  readonly crowdMax?: number;
}

interface Config {
  readonly snapshotsDirs: string[];
  readonly rulesPath: string;
  readonly asset: string;
  readonly token: 'up' | 'down' | 'both';
  readonly duration: '5min' | '15min' | 'all';
  readonly warmupSec: number;
  readonly approxResolution: boolean;
  readonly regimeThreshold: number;
  readonly initialCapital: number;
  readonly maxPositionFraction: number;
  readonly maxSharesPerMarket: number | null;
  readonly minOrderSize: number;
  readonly minOrderValue: number;
}

interface Trade {
  readonly ruleId: string;
  readonly ruleLabel: string;
  readonly slug: string;
  readonly side: 'UP' | 'DOWN';
  readonly entryPriceCents: number;
  readonly entryTauSec: number;
  readonly entryDelta: number;
  readonly entryCrowdCents: number;
  readonly entryRegime: Regime;
  readonly size: number;
  readonly notional: number;
  readonly exitPriceCents: number;
  readonly pnlDollars: number;
  readonly resolution: 'UP' | 'DOWN';
}

interface RuleStats {
  readonly rule: PolicyRule;
  attempted: number;
  filled: number;
  wins: number;
  pnl: number;
  notional: number;
}

function parseCli(): Config {
  const args = process.argv.slice(2);
  const cfg: Config = {
    snapshotsDirs: [],
    rulesPath: 'configs/crowd-policy-rules-btc.json',
    asset: 'bitcoin',
    token: 'both',
    duration: '5min',
    warmupSec: 15,
    approxResolution: true,
    regimeThreshold: 10,
    initialCapital: 1000,
    maxPositionFraction: 0.1,
    maxSharesPerMarket: null,
    minOrderSize: 5,
    minOrderValue: 1,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const next = args[i + 1];
    if (a === '--snapshots' && next) { cfg.snapshotsDirs = next.split(',').map((s) => s.trim()); i++; }
    else if (a === '--rules' && next) { cfg.rulesPath = next; i++; }
    else if (a === '--asset' && next) { cfg.asset = next; i++; }
    else if (a === '--token' && next) { cfg.token = next as Config['token']; i++; }
    else if (a === '--duration' && next) { cfg.duration = next as Config['duration']; i++; }
    else if (a === '--warmup-sec' && next) { cfg.warmupSec = Number(next); i++; }
    else if (a === '--no-approx-resolution') { cfg.approxResolution = false; }
    else if (a === '--regime-threshold' && next) { cfg.regimeThreshold = Number(next); i++; }
    else if (a === '--initial-capital' && next) { cfg.initialCapital = Number(next); i++; }
    else if (a === '--max-position-fraction' && next) { cfg.maxPositionFraction = Number(next); i++; }
    else if (a === '--max-shares' && next) { cfg.maxSharesPerMarket = Number(next); i++; }
    else if (a === '--min-order-size' && next) { cfg.minOrderSize = Number(next); i++; }
    else if (a === '--min-order-value' && next) { cfg.minOrderValue = Number(next); i++; }
  }
  if (cfg.snapshotsDirs.length === 0) {
    console.error('Usage: --snapshots <dir1,dir2,...> [--rules configs/crowd-policy-rules-btc.json]');
    process.exit(1);
  }
  return cfg;
}

async function collectFiles(dirs: readonly string[], asset: string): Promise<string[]> {
  const out: string[] = [];
  for (const dir of dirs) {
    const resolved = resolve(dir);
    const entries = await readdir(resolved);
    for (const e of entries) {
      const lower = e.toLowerCase();
      if (!lower.includes(asset)) continue;
      if (!(lower.endsWith('.jsonl') || lower.endsWith('.jsonl.gz'))) continue;
      out.push(join(resolved, e));
    }
  }
  return out;
}

function computeEntryBidCents(obs: Observation, side: 'UP' | 'DOWN'): number {
  if (side === 'UP') {
    const aggressive = Math.round(obs.bestBidCents) + 1;
    const bid = aggressive < Math.round(obs.bestAskCents)
      ? aggressive
      : Math.round(obs.bestBidCents);
    return Math.max(1, Math.min(99, bid));
  }
  const downBid = 100 - Math.round(obs.bestAskCents);
  const downAsk = 100 - Math.round(obs.bestBidCents);
  const aggressive = downBid + 1;
  const bid = aggressive < downAsk ? aggressive : downBid;
  return Math.max(1, Math.min(99, bid));
}

function matchesRule(rule: PolicyRule, obs: Observation, regime: Regime): boolean {
  if (obs.delta < rule.deltaMin || obs.delta > rule.deltaMax) return false;
  if (obs.tauSec < rule.tauMin || obs.tauSec >= rule.tauMax) return false;
  if (!rule.regimes.includes(regime)) return false;
  if (rule.crowdMin !== undefined && obs.midPriceCents < rule.crowdMin) return false;
  if (rule.crowdMax !== undefined && obs.midPriceCents > rule.crowdMax) return false;
  return true;
}

function simulateMarket(
  md: MarketData,
  rules: readonly PolicyRule[],
  cfg: Config,
  capital: number,
): Trade | null {
  if (cfg.duration !== 'all' && md.duration !== cfg.duration) return null;
  if (md.observations.length === 0) return null;

  const marketStartMs = md.endDateMs - md.durationMin * 60_000;
  for (const obs of md.observations) {
    const tsMs = md.endDateMs - obs.tauSec * 1000;
    const elapsedMs = tsMs - marketStartMs;
    if (elapsedMs < cfg.warmupSec * 1000) continue;
    const regime = classifyRegime(obs.trendSlope, cfg.regimeThreshold);
    const rule = rules.find((candidate) => matchesRule(candidate, obs, regime));
    if (!rule) continue;

    const entryPriceCents = computeEntryBidCents(obs, rule.side);
    const fraction = cfg.maxPositionFraction;
    let size = Math.floor((capital * fraction) / (entryPriceCents / 100));
    if (size < cfg.minOrderSize) size = cfg.minOrderSize;
    if (cfg.maxSharesPerMarket !== null) size = Math.min(size, cfg.maxSharesPerMarket);
    if (size * (entryPriceCents / 100) < cfg.minOrderValue) {
      size = Math.ceil(cfg.minOrderValue / (entryPriceCents / 100));
    }
    if (size < cfg.minOrderSize) continue;
    const notional = size * (entryPriceCents / 100);
    if (notional > capital) continue;

    const winnerForSide = rule.side === 'UP' ? 'UP' : 'DOWN';
    const exitPriceCents = md.resolution === winnerForSide ? 100 : 0;
    const pnlDollars = size * ((exitPriceCents - entryPriceCents) / 100);
    return {
      ruleId: rule.id,
      ruleLabel: rule.label,
      slug: md.slug,
      side: rule.side,
      entryPriceCents,
      entryTauSec: obs.tauSec,
      entryDelta: obs.delta,
      entryCrowdCents: obs.midPriceCents,
      entryRegime: regime,
      size,
      notional,
      exitPriceCents,
      pnlDollars,
      resolution: md.resolution,
    };
  }
  return null;
}

async function main(): Promise<void> {
  const cfg = parseCli();
  const ruleFile = JSON.parse(readFileSync(resolve(cfg.rulesPath), 'utf8')) as RuleFile;
  const files = await collectFiles(cfg.snapshotsDirs, cfg.asset);

  console.log(`Rules: ${cfg.rulesPath}  count=${ruleFile.rules.length}`);
  if (ruleFile.name) console.log(`Rule set: ${ruleFile.name}`);
  console.log(`Snapshots: ${cfg.snapshotsDirs.join(', ')}`);
  console.log(`Files: ${files.length}`);

  const markets: MarketData[] = [];
  let parsed = 0;
  let skipped = 0;
  for (const file of files) {
    const parsedResult = await parseSnapshot(file, 900, cfg.token, cfg.approxResolution);
    parsed++;
    if (parsedResult.data) markets.push(parsedResult.data);
    else skipped++;
    if (parsed % 100 === 0) console.log(`  parsed ${parsed}/${files.length}...`);
  }
  console.log(`Parsed: ${markets.length} markets (skipped ${skipped})`);

  const stats = new Map<string, RuleStats>();
  for (const rule of ruleFile.rules) {
    stats.set(rule.id, { rule, attempted: 0, filled: 0, wins: 0, pnl: 0, notional: 0 });
  }

  const trades: Trade[] = [];
  let capital = cfg.initialCapital;
  const sortedMarkets = [...markets].sort((a, b) => a.endDateMs - b.endDateMs);
  for (const md of sortedMarkets) {
    const trade = simulateMarket(md, ruleFile.rules, cfg, capital);
    if (!trade) continue;
    trades.push(trade);
    capital += trade.pnlDollars;
    const row = stats.get(trade.ruleId);
    if (!row) continue;
    row.attempted++;
    row.filled++;
    row.notional += trade.notional;
    row.pnl += trade.pnlDollars;
    if (trade.pnlDollars > 0) row.wins++;
  }

  console.log();
  console.log('rule                          trades   WR      avg$     pnl$      avgEntry  avgTau');
  for (const { rule, filled, wins, notional, pnl } of stats.values()) {
    const ruleTrades = trades.filter((t) => t.ruleId === rule.id);
    const avgEntry = ruleTrades.length > 0
      ? ruleTrades.reduce((sum, trade) => sum + trade.entryPriceCents, 0) / ruleTrades.length
      : 0;
    const avgTau = ruleTrades.length > 0
      ? ruleTrades.reduce((sum, trade) => sum + trade.entryTauSec, 0) / ruleTrades.length
      : 0;
    const avgTrade = ruleTrades.length > 0 ? pnl / ruleTrades.length : 0;
    const wr = filled > 0 ? wins / filled : 0;
    console.log(
      `${rule.id.padEnd(28)} ${String(filled).padStart(5)}  ${(wr * 100).toFixed(1).padStart(5)}%  ${avgTrade.toFixed(2).padStart(7)}  ${pnl.toFixed(2).padStart(9)}  ${avgEntry.toFixed(1).padStart(7)}¢  ${avgTau.toFixed(0).padStart(6)}s`,
    );
  }

  const wins = trades.filter((trade) => trade.pnlDollars > 0).length;
  const totalPnl = trades.reduce((sum, trade) => sum + trade.pnlDollars, 0);
  const totalNotional = trades.reduce((sum, trade) => sum + trade.notional, 0);
  console.log();
  console.log(`Total trades: ${trades.length}`);
  console.log(`Win rate: ${trades.length > 0 ? ((wins / trades.length) * 100).toFixed(1) : '0.0'}%`);
  console.log(`Total notional: $${totalNotional.toFixed(2)}`);
  console.log(`Total PnL: $${totalPnl.toFixed(2)}`);
  console.log(`Final capital: $${capital.toFixed(2)}`);

  if (trades.length > 0) {
    console.log();
    console.log('sample trades');
    console.log('rule                          entry   tau   delta  crowd  regime  exit  pnl$   slug');
    for (const trade of trades.slice(0, 20)) {
      console.log(
        `${trade.ruleId.padEnd(28)} ${String(trade.entryPriceCents).padStart(5)}¢ ${String(Math.round(trade.entryTauSec)).padStart(4)}s ${String(trade.entryDelta).padStart(6)} ${String(trade.entryCrowdCents).padStart(5)}¢ ${trade.entryRegime.padEnd(6)} ${String(trade.exitPriceCents).padStart(4)}¢ ${trade.pnlDollars.toFixed(2).padStart(6)} ${trade.slug}`,
      );
    }
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
