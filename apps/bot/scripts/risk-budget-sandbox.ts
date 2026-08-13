/**
 * Sandbox for position risk-budget sizing.
 *
 * Run:
 *   npx tsx scripts/risk-budget-sandbox.ts
 *
 * This is intentionally standalone: it does not place orders and is not wired
 * into any live strategy. Use it to tune the core exposure formula.
 */

type Direction = 'favorable' | 'neutral' | 'adverse';
type Regime = 'favorable' | 'flat' | 'adverse';

interface RiskInput {
  /** Entry price in cents. */
  entryCents: number;
  /** Current executable bid in cents. */
  currentBidCents: number;
  /** Calibrated fair probability/price in cents. */
  fairCents: number;
  /** Seconds to market expiry. */
  tauSec: number;
  /** Signed delta for this token. For UP: chainlink - strike. For DOWN: strike - chainlink. */
  deltaForSideDollars: number;
  /** 0..100. Higher means the strategy tolerates more exposure in weaker states. */
  riskTolerance: number;
  /** Is the original short-lived entry thesis still supported by CEX/Chainlink lag? */
  cexDirection: Direction;
  /** Is short-term BTC regime helping this token? */
  regime: Regime;
  /** Milliseconds since entry fill. */
  ageMs: number;
  /** Original edge TTL. After this, entry thesis decays aggressively. */
  edgeTtlMs: number;
  /** Fraction of initial position already sold, 0..1. */
  realizedScaleOutPct: number;
  /**
   * Average sell price of the already-realized part. If undefined and
   * realizedScaleOutPct > 0, the sandbox assumes no realized PnL buffer.
   */
  avgRealizedExitCents?: number;
}

interface RiskDecision {
  holdEdgeCents: number;
  stateRisk: number;
  edgeBonus: number;
  quickProfitValueScore: number;
  quickProfitMonetizationRisk: number;
  targetExposurePct: number;
  currentExposurePct: number;
  sellFromInitialPct: number;
  sellFromCurrentPct: number;
  holdEvCentsPerInitialShare: number;
  riskChargeCentsPerInitialShare: number;
  utilityCentsPerInitialShare: number;
  realizedPnlCentsPerInitialShare: number;
  runnerCushionPct: number;
  action: 'HOLD' | 'REDUCE' | 'EXIT';
  notes: string[];
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function scoreDirection(direction: Direction): number {
  if (direction === 'favorable') return -18;
  if (direction === 'neutral') return 8;
  return 28;
}

function scoreRegime(regime: Regime): number {
  if (regime === 'favorable') return -10;
  if (regime === 'flat') return 4;
  return 18;
}

function computeRiskBudgetDecision(input: RiskInput): RiskDecision {
  const notes: string[] = [];

  const holdEdgeCents = input.fairCents - input.currentBidCents;
  const pnlFromEntryCents = input.currentBidCents - input.entryCents;
  const profitCents = Math.max(0, pnlFromEntryCents);
  const profitPct = pnlFromEntryCents / Math.max(1, input.entryCents);
  const drawdownCents = Math.max(0, input.entryCents - input.currentBidCents);
  const entryWinProb = clamp(input.entryCents / 100, 0.01, 0.99);
  const entryLossProb = 1 - entryWinProb;
  const quickProfitValueScore = profitCents * entryLossProb;
  const entryThesisAge = input.edgeTtlMs <= 0 ? 1 : clamp(input.ageMs / input.edgeTtlMs, 0, 2);
  const realizedPnlCentsPerInitialShare =
    input.avgRealizedExitCents === undefined
      ? 0
      : input.realizedScaleOutPct * (input.avgRealizedExitCents - input.entryCents);

  // 1. If market pays above our calibrated fair, selling becomes attractive.
  const overFairRisk = clamp((input.currentBidCents - input.fairCents) * 5, 0, 35);

  // 2. Drawdown is not an automatic exit, but it consumes risk budget.
  const drawdownRisk = clamp(drawdownCents * 1.4, 0, 28);

  // 3. Entry edge is short-lived. After TTL, we no longer justify full size by
  // the original CEX lead-lag thesis.
  const thesisDecayRisk = input.cexDirection === 'favorable'
    ? clamp((entryThesisAge - 1) * 8, 0, 12)
    : clamp(entryThesisAge * 18, 0, 28);

  // 4. Low entry prices are more lottery-like; high entry prices can keep more runner.
  const lotteryRisk = input.entryCents < 40
    ? 18
    : input.entryCents < 55
      ? 8
      : input.entryCents > 75
        ? -6
        : 0;

  // 5. Being close to expiry with a strong delta is safer for the in-the-money token.
  const structuralSafety = input.deltaForSideDollars > 100 && input.tauSec < 45
    ? 20
    : input.deltaForSideDollars > 50 && input.tauSec < 90
      ? 10
      : 0;

  // 6. Already realized profit reduces the need to keep full exposure.
  // This is not "risk" in the bad sense; it lowers target exposure because the
  // short-term edge has already been monetized.
  const monetizedEdgeRisk = realizedPnlCentsPerInitialShare > 0
    ? clamp(input.realizedScaleOutPct * 18, 0, 18)
    : clamp(input.realizedScaleOutPct * 25, 0, 25);
  const realizedLossRisk = clamp(-realizedPnlCentsPerInitialShare * 8, 0, 25);
  const quickProfitMonetizationRisk = profitCents > 0
    ? clamp(quickProfitValueScore * (input.cexDirection === 'favorable' ? 1.5 : 3.5), 0, 25)
    : 0;

  const stateRisk = clamp(
    35 +
      overFairRisk +
      drawdownRisk +
      thesisDecayRisk +
      lotteryRisk +
      quickProfitMonetizationRisk +
      scoreDirection(input.cexDirection) +
      scoreRegime(input.regime) +
      monetizedEdgeRisk -
      0 +
      realizedLossRisk -
      structuralSafety,
    0,
    100,
  );

  // Hold edge gives permission to keep risk, but should not dominate adverse
  // regime/thesis decay. If fair is 54 and bid is 50, this adds exposure.
  // If fair is 54 and bid is 58, this removes exposure.
  const edgeBonus = clamp(holdEdgeCents * 4, -30, 30);

  // Fresh favorable CEX edge permits temporary full size for capture.
  const freshEdgeBoost =
    input.cexDirection === 'favorable' && entryThesisAge <= 1
      ? clamp((1 - entryThesisAge) * 25, 0, 25)
      : 0;

  let targetExposurePct = clamp(
    input.riskTolerance - stateRisk + edgeBonus + freshEdgeBoost,
    0,
    100,
  );

  // If trade is working but current price is still not extremely rich versus
  // fair, keep more runner for high-probability entries.
  if (input.entryCents >= 60 && profitPct > 0 && holdEdgeCents > -5) {
    targetExposurePct = Math.max(targetExposurePct, holdEdgeCents >= 0 ? 55 : 35);
    notes.push('high_entry_runner_floor');
  }

  // Low-price entries should monetize repricing aggressively.
  if (input.entryCents <= 40 && profitPct >= 0.15) {
    targetExposurePct = clamp(targetExposurePct, 15, 35);
    notes.push('low_entry_aggressive_monetization');
  }

  // If current bid is below fair, dumping the whole position is usually wrong
  // unless the CEX/regime state has turned adverse. Keep a reduced residual.
  if (holdEdgeCents > 2 && input.cexDirection !== 'adverse' && input.regime !== 'adverse') {
    targetExposurePct = Math.max(targetExposurePct, input.riskTolerance * 0.4);
    notes.push('positive_hold_edge_residual_floor');
  }

  // If we already monetized part of the edge profitably, give the runner room
  // near entry/fair instead of liquidating it immediately on a normal pullback.
  const nearEntry = input.currentBidCents >= input.entryCents - 3;
  const notAdverse = input.cexDirection !== 'adverse' && input.regime !== 'adverse';
  const runnerCushionPct = realizedPnlCentsPerInitialShare > 0 && nearEntry && notAdverse
    ? clamp(20 + realizedPnlCentsPerInitialShare * 6, 20, 45)
    : 0;
  if (runnerCushionPct > 0) {
    targetExposurePct = Math.max(targetExposurePct, runnerCushionPct);
    notes.push('realized_profit_runner_cushion');
  }

  // If the fast edge has decayed but price is only near entry, do not liquidate
  // the runner just because the formula lost conviction. True adverse/drawdown
  // cases are still handled by risk and the execution guard.
  const nearEntryNeutral = Math.abs(input.currentBidCents - input.entryCents) <= 3 && notAdverse;
  if (nearEntryNeutral && entryThesisAge >= 1) {
    const neutralRunnerFloor = realizedPnlCentsPerInitialShare > 0 ? 25 : 50;
    targetExposurePct = Math.max(targetExposurePct, neutralRunnerFloor);
    notes.push('neutral_near_entry_runner_floor');
  }

  // If we already realized a loss, do not let the remaining runner stay large
  // unless current hold edge is clearly positive and not adverse.
  if (realizedPnlCentsPerInitialShare < 0 && !(holdEdgeCents > 3 && notAdverse)) {
    const lossCap = clamp(35 + realizedPnlCentsPerInitialShare * 8, 10, 35);
    targetExposurePct = Math.min(targetExposurePct, lossCap);
    notes.push('realized_loss_tightens_remaining_risk');
  }

  if (holdEdgeCents < -2) notes.push('market_bid_above_fair_sell_is_attractive');
  if (holdEdgeCents > 2) notes.push('current_bid_below_fair_do_not_dump');
  if (drawdownCents > 0) notes.push('drawdown_consumes_risk_budget');
  if (quickProfitMonetizationRisk >= 8) notes.push('quick_profit_is_more_valuable_from_low_entry');
  if (entryThesisAge >= 1 && input.cexDirection !== 'favorable') notes.push('entry_thesis_decayed');
  if (realizedPnlCentsPerInitialShare > 0) notes.push('realized_profit_buffer');
  if (realizedPnlCentsPerInitialShare < 0) notes.push('realized_loss_budget_damage');

  const action =
    targetExposurePct <= 5
      ? 'EXIT'
      : targetExposurePct < 85
        ? 'REDUCE'
        : 'HOLD';

  const currentExposurePct = clamp((1 - input.realizedScaleOutPct) * 100, 0, 100);
  const sellFromInitialPct = clamp(currentExposurePct - targetExposurePct, 0, currentExposurePct);
  const sellFromCurrentPct = currentExposurePct > 0
    ? sellFromInitialPct / currentExposurePct * 100
    : 0;

  // This is not a proof of optimality. It is a local risk-adjusted score for
  // comparing parameters: keeping exposure has EV = fair - bid, but consumes
  // risk budget while we wait.
  const holdEvCentsPerInitialShare = targetExposurePct / 100 * holdEdgeCents;
  const riskChargeCentsPerInitialShare =
    targetExposurePct / 100 * (stateRisk / 100) * input.currentBidCents * 0.25;
  const utilityCentsPerInitialShare = holdEvCentsPerInitialShare - riskChargeCentsPerInitialShare;

  return {
    holdEdgeCents,
    stateRisk,
    edgeBonus,
    quickProfitValueScore,
    quickProfitMonetizationRisk,
    targetExposurePct,
    currentExposurePct,
    sellFromInitialPct,
    sellFromCurrentPct,
    holdEvCentsPerInitialShare,
    riskChargeCentsPerInitialShare,
    utilityCentsPerInitialShare,
    realizedPnlCentsPerInitialShare,
    runnerCushionPct,
    action,
    notes,
  };
}

function fmtDecision(d: RiskDecision): Record<string, unknown> {
  return {
    ...d,
    holdEdgeCents: Number(d.holdEdgeCents.toFixed(2)),
    stateRisk: Number(d.stateRisk.toFixed(1)),
    edgeBonus: Number(d.edgeBonus.toFixed(1)),
    quickProfitValueScore: Number(d.quickProfitValueScore.toFixed(2)),
    quickProfitMonetizationRisk: Number(d.quickProfitMonetizationRisk.toFixed(1)),
    targetExposurePct: Number(d.targetExposurePct.toFixed(1)),
    currentExposurePct: Number(d.currentExposurePct.toFixed(1)),
    sellFromInitialPct: Number(d.sellFromInitialPct.toFixed(1)),
    sellFromCurrentPct: Number(d.sellFromCurrentPct.toFixed(1)),
    holdEvCentsPerInitialShare: Number(d.holdEvCentsPerInitialShare.toFixed(2)),
    riskChargeCentsPerInitialShare: Number(d.riskChargeCentsPerInitialShare.toFixed(2)),
    utilityCentsPerInitialShare: Number(d.utilityCentsPerInitialShare.toFixed(2)),
    realizedPnlCentsPerInitialShare: Number(d.realizedPnlCentsPerInitialShare.toFixed(2)),
    runnerCushionPct: Number(d.runnerCushionPct.toFixed(1)),
  };
}

function readArg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf(name);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

function hasArg(name: string): boolean {
  return process.argv.slice(2).includes(name);
}

function parseNum(name: string, fallback: number): number {
  const raw = readArg(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name}: expected number, got ${raw}`);
  return n;
}

function parseDirection(name: string, fallback: Direction): Direction {
  const raw = readArg(name);
  if (raw === undefined) return fallback;
  if (raw === 'favorable' || raw === 'neutral' || raw === 'adverse') return raw;
  throw new Error(`${name}: expected favorable|neutral|adverse, got ${raw}`);
}

function parseRegime(name: string, fallback: Regime): Regime {
  const raw = readArg(name);
  if (raw === undefined) return fallback;
  if (raw === 'favorable' || raw === 'flat' || raw === 'adverse') return raw;
  throw new Error(`${name}: expected favorable|flat|adverse, got ${raw}`);
}

function inputFromCli(): RiskInput {
  return {
    entryCents: parseNum('--entry', 65),
    currentBidCents: parseNum('--bid', 72),
    fairCents: parseNum('--fair', 72),
    tauSec: parseNum('--tau', 90),
    deltaForSideDollars: parseNum('--delta', 50),
    riskTolerance: parseNum('--risk', 70),
    cexDirection: parseDirection('--cex', 'favorable'),
    regime: parseRegime('--regime', 'favorable'),
    ageMs: parseNum('--age-ms', 8_000),
    edgeTtlMs: parseNum('--ttl-ms', 20_000),
    realizedScaleOutPct: parseNum('--sold-pct', 0),
    avgRealizedExitCents: readArg('--avg-sell') === undefined ? undefined : parseNum('--avg-sell', 0),
  };
}

const scenarios: Array<{ name: string; input: RiskInput }> = [
  {
    name: 'Entry 65 -> 72, fair 72, edge still favorable',
    input: {
      entryCents: 65,
      currentBidCents: 72,
      fairCents: 72,
      tauSec: 90,
      deltaForSideDollars: 50,
      riskTolerance: 70,
      cexDirection: 'favorable',
      regime: 'favorable',
      ageMs: 8_000,
      edgeTtlMs: 20_000,
      realizedScaleOutPct: 0,
    },
  },
  {
    name: 'Entry 65 -> 78, fair 74, edge monetized',
    input: {
      entryCents: 65,
      currentBidCents: 78,
      fairCents: 74,
      tauSec: 75,
      deltaForSideDollars: 45,
      riskTolerance: 70,
      cexDirection: 'neutral',
      regime: 'flat',
      ageMs: 22_000,
      edgeTtlMs: 20_000,
      realizedScaleOutPct: 0.2,
      avgRealizedExitCents: 72,
    },
  },
  {
    name: 'Entry 65 -> 50, fair 54, CEX neutral',
    input: {
      entryCents: 65,
      currentBidCents: 50,
      fairCents: 54,
      tauSec: 80,
      deltaForSideDollars: 20,
      riskTolerance: 70,
      cexDirection: 'neutral',
      regime: 'flat',
      ageMs: 25_000,
      edgeTtlMs: 20_000,
      realizedScaleOutPct: 0,
    },
  },
  {
    name: 'Entry 65 -> 50, fair 54, CEX adverse',
    input: {
      entryCents: 65,
      currentBidCents: 50,
      fairCents: 54,
      tauSec: 80,
      deltaForSideDollars: 20,
      riskTolerance: 70,
      cexDirection: 'adverse',
      regime: 'adverse',
      ageMs: 25_000,
      edgeTtlMs: 20_000,
      realizedScaleOutPct: 0,
    },
  },
  {
    name: 'Entry 30 -> 38, fair 36, low entry repricing worked',
    input: {
      entryCents: 30,
      currentBidCents: 38,
      fairCents: 36,
      tauSec: 110,
      deltaForSideDollars: -10,
      riskTolerance: 70,
      cexDirection: 'neutral',
      regime: 'flat',
      ageMs: 15_000,
      edgeTtlMs: 20_000,
      realizedScaleOutPct: 0,
    },
  },
];

function printHelp(): void {
  console.log(`Usage:
  npx tsx scripts/risk-budget-sandbox.ts
  npx tsx scripts/risk-budget-sandbox.ts --entry 65 --bid 72 --fair 72 --tau 90 --delta 50 --risk 70 --cex favorable --regime favorable --age-ms 8000 --ttl-ms 20000 --sold-pct 0
  npx tsx scripts/risk-budget-sandbox.ts --entry 65 --bid 50 --fair 54 --cex neutral --regime flat --sweep-risk 30,50,70,90

Options:
  --entry       Entry price, cents
  --bid         Current executable bid, cents
  --fair        Calibrated fair price/probability, cents
  --tau         Seconds to expiry
  --delta       Signed delta for this token, dollars
  --risk        Risk tolerance, 0..100
  --cex         favorable|neutral|adverse
  --regime      favorable|flat|adverse
  --age-ms      Milliseconds since entry
  --ttl-ms      Entry edge TTL in milliseconds
  --sold-pct    Fraction of initial position already sold, 0..1
  --avg-sell    Average sell price for already-sold part, cents
  --sweep-risk  Comma separated risk tolerances
`);
}

function main(): void {
  if (hasArg('--help') || hasArg('-h')) {
    printHelp();
    return;
  }

  const hasCliScenario = process.argv.slice(2).some(arg => arg.startsWith('--'));
  if (!hasCliScenario) {
    for (const s of scenarios) {
      const d = computeRiskBudgetDecision(s.input);
      console.log(`\n${s.name}`);
      console.log({ input: s.input, decision: fmtDecision(d) });
    }
    return;
  }

  const input = inputFromCli();
  const sweep = readArg('--sweep-risk');
  if (sweep) {
    const risks = sweep.split(',').map(Number).filter(Number.isFinite);
    console.table(risks.map((risk) => {
      const decision = computeRiskBudgetDecision({ ...input, riskTolerance: risk });
      return {
        risk,
        action: decision.action,
        target: Number(decision.targetExposurePct.toFixed(1)),
        sellCurrent: Number(decision.sellFromCurrentPct.toFixed(1)),
        stateRisk: Number(decision.stateRisk.toFixed(1)),
        holdEdge: Number(decision.holdEdgeCents.toFixed(1)),
        utility: Number(decision.utilityCentsPerInitialShare.toFixed(2)),
      };
    }));
    return;
  }

  const decision = computeRiskBudgetDecision(input);
  console.log({ input, decision: fmtDecision(decision) });
}

if (process.argv[1]?.endsWith('risk-budget-sandbox.ts')) {
  main();
}

export {
  computeRiskBudgetDecision,
  type Direction,
  type Regime,
  type RiskInput,
  type RiskDecision,
};
