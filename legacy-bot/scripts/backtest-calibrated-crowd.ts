/**
 * Бэктест CalibratedCrowdStrategy на снапшотах.
 *
 * @remarks
 * Упрощённая модель исполнения:
 * - Вход: maker BUY по цене `mid - spreadAvg/2 + 1¢` (наша ставка = bestBid+1).
 *   Считаем fill мгновенным — реалистичная upper bound.
 * - Выход maker: `mid + spreadAvg/2 − 1¢` (bestAsk−1).
 * - Выход panic taker: `mid − spreadAvg/2` (hit bid).
 * - HOLD-to-expiry → реализация 1.0 (если UP wins) или 0.0 (DOWN wins) per токен.
 *
 * Прогоняется несколько конфигов exit-policies, чтобы сравнить.
 *
 * @example
 * ```bash
 * npx tsx scripts/backtest-calibrated-crowd.ts \
 *   --snapshots "$S/2026-04-19/polymarket,$S/2026-04-20/polymarket" \
 *   --table tables/edge-table-5min.json \
 *   --asset bitcoin --token up \
 *   --min-composite 0.3 --max-position-fraction 0.1 --initial-capital 1000
 * ```
 */
import { readFileSync } from 'fs';
import { readdir } from 'fs/promises';
import { join, resolve } from 'path';
import { EdgeTable, type Regime } from '../src/strategies/calibrated-crowd/EdgeTable.js';
import { classifyRegime, parseSnapshot, type MarketData, type Observation } from './analyze-crowd-calibration.js';

// ── CLI ───────────────────────────────────────────────────────────────────────

interface Config {
  snapshotsDirs: string[];
  tablePath: string;
  asset: string;
  token: 'up' | 'down';
  minComposite: number;
  maxPositionFraction: number;
  warmupSec: number;
  initialCapital: number;
  approxResolution: boolean;
  /** Жёсткий cap на число токенов в одной позиции (для малого капитала). */
  maxSharesPerMarket: number | null;
  minOrderSize: number;
  minOrderValue: number;
  /** Если задан — прогоняем hold-policy для каждой доли (sweep). */
  sweepMaxPositionFractions: number[] | null;
}

function parseCli(): Config {
  const args = process.argv.slice(2);
  const cfg: Config = {
    snapshotsDirs: [],
    tablePath: 'tables/edge-table-5min.json',
    asset: 'bitcoin',
    token: 'up',
    minComposite: 0.3,
    maxPositionFraction: 0.1,
    warmupSec: 15,
    initialCapital: 1000,
    approxResolution: true,
    sweepMaxPositionFractions: null,
    maxSharesPerMarket: null,
    minOrderSize: 5,
    minOrderValue: 1,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const next = args[i + 1];
    if (a === '--snapshots' && next) { cfg.snapshotsDirs = next.split(',').map((s) => s.trim()); i++; }
    else if (a === '--table' && next) { cfg.tablePath = next; i++; }
    else if (a === '--asset' && next) { cfg.asset = next; i++; }
    else if (a === '--token' && next) { cfg.token = next as 'up' | 'down'; i++; }
    else if (a === '--min-composite' && next) { cfg.minComposite = Number(next); i++; }
    else if (a === '--max-position-fraction' && next) { cfg.maxPositionFraction = Number(next); i++; }
    else if (a === '--warmup-sec' && next) { cfg.warmupSec = Number(next); i++; }
    else if (a === '--initial-capital' && next) { cfg.initialCapital = Number(next); i++; }
    else if (a === '--no-approx-resolution') { cfg.approxResolution = false; }
    else if (a === '--max-shares' && next) {
      cfg.maxSharesPerMarket = Number(next);
      i++;
    }
    else if (a === '--min-order-size' && next) { cfg.minOrderSize = Number(next); i++; }
    else if (a === '--min-order-value' && next) { cfg.minOrderValue = Number(next); i++; }
    else if (a === '--sweep-max-position-fraction' && next) {
      cfg.sweepMaxPositionFractions = next.split(',').map((s) => Number(s.trim()));
      i++;
    }
  }
  if (cfg.snapshotsDirs.length === 0) {
    console.error('Usage: --snapshots <dir1,dir2,...> --table <path>');
    process.exit(1);
  }
  return cfg;
}

// ── Exit policy definitions ───────────────────────────────────────────────────

interface ExitPolicy {
  readonly name: string;
  readonly onRegimeFlip: boolean;
  readonly onWeightDrop: boolean;
  readonly weightDropThreshold: number;
  readonly onTauTimeout: boolean;
  readonly exitTauSec: number;
  readonly onEdgeClosure: boolean;
  readonly edgeClosureCents: number;
  readonly allowPanicTaker: boolean;
  readonly panicTauSec: number;
}

const POLICIES: ExitPolicy[] = [
  {
    name: 'hold',
    onRegimeFlip: false, onWeightDrop: false, weightDropThreshold: 0.1,
    onTauTimeout: false, exitTauSec: 15,
    onEdgeClosure: false, edgeClosureCents: 1.5,
    allowPanicTaker: false, panicTauSec: 5,
  },
  {
    name: 'tau-only',
    onRegimeFlip: false, onWeightDrop: false, weightDropThreshold: 0.1,
    onTauTimeout: true, exitTauSec: 15,
    onEdgeClosure: false, edgeClosureCents: 1.5,
    allowPanicTaker: true, panicTauSec: 5,
  },
  {
    name: 'regime-flip',
    onRegimeFlip: true, onWeightDrop: false, weightDropThreshold: 0.1,
    onTauTimeout: true, exitTauSec: 15,
    onEdgeClosure: false, edgeClosureCents: 1.5,
    allowPanicTaker: true, panicTauSec: 5,
  },
  {
    name: 'full-risk',
    onRegimeFlip: true, onWeightDrop: true, weightDropThreshold: 0.1,
    onTauTimeout: true, exitTauSec: 15,
    onEdgeClosure: true, edgeClosureCents: 1.5,
    allowPanicTaker: true, panicTauSec: 5,
  },
];

function computeEntryBidCents(obs: Observation): number {
  const aggressive = Math.round(obs.bestBidCents) + 1;
  const bid = aggressive < Math.round(obs.bestAskCents)
    ? aggressive
    : Math.round(obs.bestBidCents);
  return Math.max(1, Math.min(99, bid));
}

/**
 * Вычислить bid/ask в центах для DOWN-токена через инверсию UP-книги.
 *
 * @remarks
 * Для бинарного рынка цена DOWN ≈ 100 − цена UP (бесарбитражное условие).
 * Истинный top-of-book DOWN получается зеркалированием UP:
 *   `DOWN.bestBid = 100 - UP.bestAsk`, `DOWN.bestAsk = 100 - UP.bestBid`.
 * Это upper-bound модель исполнения (на практике ликвидность DOWN может быть тоньше).
 */
function computeDownEntryBidCents(obs: Observation): number {
  const downBid = 100 - Math.round(obs.bestAskCents);
  const downAsk = 100 - Math.round(obs.bestBidCents);
  const aggressive = downBid + 1;
  const bid = aggressive < downAsk ? aggressive : downBid;
  return Math.max(1, Math.min(99, bid));
}

// ── Market → Trade симуляция ──────────────────────────────────────────────────

interface Trade {
  readonly slug: string;
  readonly entryPrice: number;      // центы 0..100
  readonly entryTau: number;
  readonly exitPrice: number;       // центы (100 = UP wins on HOLD)
  readonly exitReason: string;
  readonly size: number;            // токены
  readonly notional: number;        // $ потрачено
  readonly pnlDollars: number;
  readonly kellySize: number;
  readonly composite: number;
  readonly resolution: 'UP' | 'DOWN';
  readonly regime: Regime;
}

interface SimResult {
  readonly policy: string;
  readonly trades: Trade[];
  readonly totalPnL: number;
  readonly wr: number;
  readonly avgPnLPct: number;
  readonly equityCurve: number[];
  readonly maxDD: number;
}

/**
 * Симулирует работу стратегии на одном рынке.
 *
 * @returns Trade если был вход, иначе null.
 */
function simulateMarket(
  md: MarketData,
  table: EdgeTable,
  policy: ExitPolicy,
  cfg: Config,
  capital: number,
  regimeThreshold: number,
): Trade | null {
  if (md.duration !== '5min' || md.observations.length === 0) return null;

  const marketStartMs = md.endDateMs - md.durationMin * 60_000;

  let inPos = false;
  let entryRegime: Regime | undefined;
  let entryPrice = 0, entrySize = 0, entryTau = 0, entryNotional = 0;
  let entryKelly = 0, entryComposite = 0;
  let entrySide: 'UP' | 'DOWN' = 'UP';

  for (const obs of md.observations) {
    const tsMs = md.endDateMs - obs.tauSec * 1000;
    const elapsedMs = tsMs - marketStartMs;
    if (elapsedMs < cfg.warmupSec * 1000) continue;

    const regime = classifyRegime(obs.trendSlope, regimeThreshold);
    const zone = table.lookup({
      deltaDollars: obs.delta,
      tauSec: obs.tauSec,
      midCents: obs.midPriceCents,
      regime,
    });

    if (!inPos) {
      if (!zone) continue;
      const isBuyUp = zone.signal === 'BUY' && zone.kelly.side === 'UP';
      const isSellDown = zone.signal === 'SELL' && zone.kelly.side === 'DOWN';
      if (!isBuyUp && !isSellDown) continue;
      if (zone.weights.composite < cfg.minComposite) continue;
      if (zone.kelly.size <= 0) continue;

      // Размер позиции.
      const fraction = Math.min(zone.kelly.size, cfg.maxPositionFraction);
      const notional = capital * fraction;
      if (notional <= 0) continue;

      const side: 'UP' | 'DOWN' = isSellDown ? 'DOWN' : 'UP';
      const bidCents = side === 'UP' ? computeEntryBidCents(obs) : computeDownEntryBidCents(obs);
      let size = Math.floor((notional / (bidCents / 100)));
      if (size < cfg.minOrderSize) {
        const bumped = cfg.minOrderSize;
        if (cfg.maxSharesPerMarket !== null && bumped > cfg.maxSharesPerMarket) continue;
        if (bumped * (bidCents / 100) > capital) continue;
        size = bumped;
      }
      if (cfg.maxSharesPerMarket !== null) size = Math.min(size, cfg.maxSharesPerMarket);
      if (size * (bidCents / 100) < cfg.minOrderValue) {
        size = Math.ceil(cfg.minOrderValue / (bidCents / 100));
      }
      if (size < cfg.minOrderSize) continue;
      const cost = size * (bidCents / 100);
      if (cost > capital) continue;

      inPos = true;
      entrySide = side;
      entryRegime = regime;
      entryPrice = bidCents;
      entrySize = size;
      entryNotional = cost;
      entryTau = obs.tauSec;
      entryKelly = zone.kelly.size;
      entryComposite = zone.weights.composite;
      continue;
    }

    // ── In position — check exit conditions ─────────────────────────────────
    let exitReason: string | undefined;
    if (policy.onTauTimeout && obs.tauSec < policy.exitTauSec) exitReason = 'tau-timeout';
    if (!exitReason && policy.onRegimeFlip && entryRegime) {
      const flipped = (entryRegime === 'up' && regime === 'down')
        || (entryRegime === 'down' && regime === 'up');
      if (flipped) exitReason = 'regime-flip';
    }
    if (!exitReason && policy.onWeightDrop && zone) {
      if (zone.weights.composite < policy.weightDropThreshold) exitReason = 'weight-drop';
    }
    if (!exitReason && policy.onEdgeClosure && zone) {
      if (Math.abs(zone.train.edge * 100) < policy.edgeClosureCents) exitReason = 'edge-closure';
    }

    if (exitReason) {
      const panic = policy.allowPanicTaker && obs.tauSec < policy.panicTauSec;
      const halfSpread = obs.spreadCents / 2;
      // Для UP: mid±spread/2; для DOWN: зеркальный book → mid_DOWN = 100−mid_UP.
      const midForSide = entrySide === 'UP' ? obs.midPriceCents : 100 - obs.midPriceCents;
      const exitCents = panic
        ? Math.max(1, Math.min(99, midForSide - halfSpread))
        : Math.max(1, Math.min(99, midForSide + halfSpread - 1));
      const pnl = entrySize * ((exitCents - entryPrice) / 100);
      return {
        slug: md.slug,
        entryPrice, entryTau,
        exitPrice: exitCents,
        exitReason,
        size: entrySize,
        notional: entryNotional,
        pnlDollars: pnl,
        kellySize: entryKelly,
        composite: entryComposite,
        resolution: md.resolution,
        regime: entryRegime!,
      };
    }
  }

  if (!inPos) return null;

  // HOLD-to-expiry: UP-token → $1 if UP wins; DOWN-token → $1 if DOWN wins.
  const winnerForSide = entrySide === 'UP' ? 'UP' : 'DOWN';
  const exitCents = md.resolution === winnerForSide ? 100 : 0;
  const pnl = entrySize * ((exitCents - entryPrice) / 100);
  return {
    slug: md.slug,
    entryPrice, entryTau,
    exitPrice: exitCents,
    exitReason: 'hold-expiry',
    size: entrySize,
    notional: entryNotional,
    pnlDollars: pnl,
    kellySize: entryKelly,
    composite: entryComposite,
    resolution: md.resolution,
    regime: entryRegime!,
  };
}

function runPolicy(
  markets: MarketData[],
  table: EdgeTable,
  policy: ExitPolicy,
  cfg: Config,
): SimResult {
  const regimeThreshold = table.meta.bucketing.regimeThreshold;
  const trades: Trade[] = [];
  let capital = cfg.initialCapital;
  const equityCurve: number[] = [capital];
  let peak = capital;
  let maxDD = 0;

  // Сортируем рынки по времени экспирации (для equity curve).
  const sorted = [...markets].sort((a, b) => a.endDateMs - b.endDateMs);

  for (const md of sorted) {
    const t = simulateMarket(md, table, policy, cfg, capital, regimeThreshold);
    if (!t) continue;
    trades.push(t);
    capital += t.pnlDollars;
    equityCurve.push(capital);
    if (capital > peak) peak = capital;
    const dd = peak - capital;
    if (dd > maxDD) maxDD = dd;
  }

  const wins = trades.filter((t) => t.pnlDollars > 0).length;
  const totalPnL = trades.reduce((s, t) => s + t.pnlDollars, 0);
  const avgPct = trades.length > 0
    ? trades.reduce((s, t) => s + (t.pnlDollars / t.notional), 0) / trades.length * 100
    : 0;

  return {
    policy: policy.name,
    trades,
    totalPnL,
    wr: trades.length > 0 ? wins / trades.length : 0,
    avgPnLPct: avgPct,
    equityCurve,
    maxDD,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function collectFiles(dirs: string[], asset: string): Promise<string[]> {
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

async function main() {
  const cfg = parseCli();
  const table = EdgeTable.fromFile(cfg.tablePath);
  console.log(`Edge table: ${cfg.tablePath}  zones=${table.size}`);
  console.log(`Snapshots: ${cfg.snapshotsDirs.join(', ')}`);

  const files = await collectFiles(cfg.snapshotsDirs, cfg.asset);
  console.log(`Files: ${files.length}`);

  const markets: MarketData[] = [];
  let parsed = 0, skipped = 0;
  for (const f of files) {
    const r = await parseSnapshot(f, table.meta.bucketing.maxTau, cfg.token, cfg.approxResolution);
    parsed++;
    if (r.data) markets.push(r.data);
    else skipped++;
    if (parsed % 100 === 0) console.log(`  parsed ${parsed}/${files.length}...`);
  }
  console.log(`Parsed: ${markets.length} markets (skipped ${skipped})`);

  // Фильтр: только 5-min.
  const fiveMin = markets.filter((m) => m.duration === '5min');
  console.log(`5-min markets: ${fiveMin.length}`);

  // Sweep по maxPositionFraction (hold-policy only).
  if (cfg.sweepMaxPositionFractions && cfg.sweepMaxPositionFractions.length > 0) {
    console.log(`\nSweep hold-policy по maxPositionFraction:  minComposite=${cfg.minComposite}  capital=${cfg.initialCapital}\n`);
    console.log('maxPosFrac  trades  WR      avg%    totalPnL    finalCap   maxDD    DD%');
    const holdPolicy = POLICIES.find((p) => p.name === 'hold')!;
    for (const frac of cfg.sweepMaxPositionFractions) {
      const sweepCfg: Config = { ...cfg, maxPositionFraction: frac };
      const r = runPolicy(fiveMin, table, holdPolicy, sweepCfg);
      const finalCap = cfg.initialCapital + r.totalPnL;
      const ddPct = (r.maxDD / cfg.initialCapital) * 100;
      console.log(
        `${String(frac).padEnd(10)}  ${String(r.trades.length).padStart(4)}    ${(r.wr * 100).toFixed(1).padStart(5)}%  ${r.avgPnLPct.toFixed(2).padStart(6)}%  ${r.totalPnL.toFixed(2).padStart(9)}  ${finalCap.toFixed(2).padStart(9)}  ${r.maxDD.toFixed(2).padStart(6)}  ${ddPct.toFixed(1)}%`,
      );
    }
    return;
  }

  // Прогоны по каждой policy.
  console.log(`\nCapital=${cfg.initialCapital}  minComposite=${cfg.minComposite}  maxPosFrac=${cfg.maxPositionFraction}\n`);
  console.log('policy        trades  WR      avg%    totalPnL    finalCap   maxDD');
  const results: SimResult[] = [];
  for (const p of POLICIES) {
    const r = runPolicy(fiveMin, table, p, cfg);
    results.push(r);
    const finalCap = cfg.initialCapital + r.totalPnL;
    console.log(
      `${p.name.padEnd(14)}${String(r.trades.length).padStart(4)}    ${(r.wr * 100).toFixed(1).padStart(5)}%  ${r.avgPnLPct.toFixed(2).padStart(6)}%  ${r.totalPnL.toFixed(2).padStart(9)}  ${finalCap.toFixed(2).padStart(9)}  ${r.maxDD.toFixed(2)}`,
    );
  }

  // Для hold — breakdown по resolution/regime.
  const hold = results.find((r) => r.policy === 'hold')!;
  console.log('\n[hold] breakdown by resolution:');
  for (const res of ['UP', 'DOWN'] as const) {
    const sub = hold.trades.filter((t) => t.resolution === res);
    const wins = sub.filter((t) => t.pnlDollars > 0).length;
    const pnl = sub.reduce((s, t) => s + t.pnlDollars, 0);
    console.log(`  ${res}:  trades=${sub.length}  WR=${sub.length ? ((wins / sub.length) * 100).toFixed(1) : '–'}%  PnL=${pnl.toFixed(2)}`);
  }
  console.log('\n[hold] breakdown by regime at entry:');
  for (const reg of ['up', 'flat', 'down'] as const) {
    const sub = hold.trades.filter((t) => t.regime === reg);
    const wins = sub.filter((t) => t.pnlDollars > 0).length;
    const pnl = sub.reduce((s, t) => s + t.pnlDollars, 0);
    console.log(`  ${reg}:  trades=${sub.length}  WR=${sub.length ? ((wins / sub.length) * 100).toFixed(1) : '–'}%  PnL=${pnl.toFixed(2)}`);
  }
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
