/**
 * Path simulator for risk-budget exposure decisions.
 *
 * It uses computeRiskBudgetDecision() and turns target exposure into partial
 * SELL executions. This is not a market simulator; it is a sandbox for checking
 * whether the exposure policy behaves sensibly across stylized paths.
 *
 * Run:
 *   npx tsx scripts/risk-budget-path-sim.ts
 */

/* eslint-disable no-console */
import {
  computeRiskBudgetDecision,
  type Direction,
  type Regime,
} from './risk-budget-sandbox';

interface Step {
  label: string;
  bid: number;
  fair: number;
  tau: number;
  delta: number;
  cex: Direction;
  regime: Regime;
  ageMs: number;
}

interface Scenario {
  name: string;
  stakeUsd: number;
  entry: number;
  risk: number;
  ttlMs: number;
  finalPayout: 0 | 100;
  steps: Step[];
}

interface ExecutionGuardConfig {
  minProfitScaleOutCents: number;
  minRebalanceDiffPct: number;
  rebalanceHysteresisPct: number;
  rebalanceCooldownMs: number;
  minRunnerPctAfterProfit: number;
  damageControlBypass: boolean;
}

const EXECUTION_GUARD: ExecutionGuardConfig = {
  minProfitScaleOutCents: 5,
  minRebalanceDiffPct: 20,
  rebalanceHysteresisPct: 15,
  rebalanceCooldownMs: 15_000,
  minRunnerPctAfterProfit: 25,
  damageControlBypass: true,
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function simulate(s: Scenario): void {
  const initialShares = s.stakeUsd / (s.entry / 100);
  let remainingShares = initialShares;
  let cash = 0;
  let soldShares = 0;
  let sellValue = 0;
  let lastRebalanceAtMs = -Infinity;
  let lastExecutedTargetPct = 100;

  console.log(`\n=== ${s.name} ===`);
  console.log({
    stakeUsd: s.stakeUsd,
    entryCents: s.entry,
    initialShares: round2(initialShares),
    riskTolerance: s.risk,
  });

  for (const step of s.steps) {
    const soldPct = soldShares / initialShares;
    const avgSell = soldShares > 0 ? (sellValue / soldShares) * 100 : undefined;
    const decision = computeRiskBudgetDecision({
      entryCents: s.entry,
      currentBidCents: step.bid,
      fairCents: step.fair,
      tauSec: step.tau,
      deltaForSideDollars: step.delta,
      riskTolerance: s.risk,
      cexDirection: step.cex,
      regime: step.regime,
      ageMs: step.ageMs,
      edgeTtlMs: s.ttlMs,
      realizedScaleOutPct: soldPct,
      avgRealizedExitCents: avgSell,
    });

    const currentExposurePct = remainingShares / initialShares * 100;
    const guarded = applyExecutionGuard({
      decisionTargetPct: decision.targetExposurePct,
      currentExposurePct,
      entryCents: s.entry,
      bidCents: step.bid,
      fairCents: step.fair,
      cex: step.cex,
      regime: step.regime,
      ageMs: step.ageMs,
      lastRebalanceAtMs,
      lastExecutedTargetPct,
      soldPct,
      realizedPnlCentsPerInitialShare: decision.realizedPnlCentsPerInitialShare,
      config: EXECUTION_GUARD,
    });

    const targetShares = initialShares * (guarded.executableTargetPct / 100);
    const sellShares = Math.max(0, remainingShares - targetShares);
    if (sellShares > 0.000001) {
      const proceeds = sellShares * (step.bid / 100);
      cash += proceeds;
      remainingShares -= sellShares;
      soldShares += sellShares;
      sellValue += proceeds;
      lastRebalanceAtMs = step.ageMs;
      lastExecutedTargetPct = guarded.executableTargetPct;
    }

    const markValue = remainingShares * (step.bid / 100);
    console.log({
      step: step.label,
      bid: step.bid,
      fair: step.fair,
      holdEdge: round2(decision.holdEdgeCents),
      stateRisk: round2(decision.stateRisk),
      targetPct: round2(decision.targetExposurePct),
      executableTargetPct: round2(guarded.executableTargetPct),
      guard: guarded.reason,
      soldNowShares: round2(sellShares),
      remainingPct: round2((remainingShares / initialShares) * 100),
      cash: round2(cash),
      markValue: round2(markValue),
      totalMarked: round2(cash + markValue),
      notes: decision.notes.join(','),
    });
  }

  const finalValue = cash + remainingShares * (s.finalPayout / 100);
  const finalPnl = finalValue - s.stakeUsd;
  console.log({
    finalPayoutCents: s.finalPayout,
    cashFromSells: round2(cash),
    remainingShares: round2(remainingShares),
    finalValue: round2(finalValue),
    finalPnl: round2(finalPnl),
    finalReturnPct: round2((finalPnl / s.stakeUsd) * 100),
  });
}

interface GuardInput {
  decisionTargetPct: number;
  currentExposurePct: number;
  entryCents: number;
  bidCents: number;
  fairCents: number;
  cex: Direction;
  regime: Regime;
  ageMs: number;
  lastRebalanceAtMs: number;
  lastExecutedTargetPct: number;
  soldPct: number;
  realizedPnlCentsPerInitialShare: number;
  config: ExecutionGuardConfig;
}

function applyExecutionGuard(input: GuardInput): { executableTargetPct: number; reason: string } {
  if (input.decisionTargetPct >= input.currentExposurePct) {
    return { executableTargetPct: input.currentExposurePct, reason: 'target_not_below_current' };
  }

  const desiredReductionPct = input.currentExposurePct - input.decisionTargetPct;
  const profitCents = input.bidCents - input.entryCents;
  const drawdownCents = input.entryCents - input.bidCents;
  const overFairCents = input.bidCents - input.fairCents;
  const emergency =
    input.config.damageControlBypass &&
    (
      input.cex === 'adverse' ||
      input.regime === 'adverse' ||
      drawdownCents >= 8 ||
      overFairCents >= 3
    );

  if (!emergency && input.ageMs - input.lastRebalanceAtMs < input.config.rebalanceCooldownMs) {
    return { executableTargetPct: input.currentExposurePct, reason: 'cooldown' };
  }

  if (!emergency && desiredReductionPct < input.config.minRebalanceDiffPct) {
    return { executableTargetPct: input.currentExposurePct, reason: 'inside_no_trade_band' };
  }

  if (
    !emergency &&
    input.decisionTargetPct > input.lastExecutedTargetPct - input.config.rebalanceHysteresisPct
  ) {
    return { executableTargetPct: input.currentExposurePct, reason: 'hysteresis' };
  }

  const profitTaking =
    profitCents > 0 &&
    input.cex !== 'adverse' &&
    input.regime !== 'adverse';

  if (!emergency && profitTaking && profitCents < input.config.minProfitScaleOutCents) {
    return { executableTargetPct: input.currentExposurePct, reason: 'profit_below_min_scaleout' };
  }

  let executableTargetPct = input.decisionTargetPct;

  if (
    !emergency &&
    input.realizedPnlCentsPerInitialShare > 0 &&
    input.currentExposurePct > input.config.minRunnerPctAfterProfit
  ) {
    executableTargetPct = Math.max(executableTargetPct, input.config.minRunnerPctAfterProfit);
  }

  return {
    executableTargetPct: Math.min(executableTargetPct, input.currentExposurePct),
    reason: emergency ? 'emergency_bypass' : 'allowed',
  };
}

const scenarios: Scenario[] = [
  {
    name: 'Super favorable: 65 -> 72 -> 82 -> expires WIN',
    stakeUsd: 100,
    entry: 65,
    risk: 70,
    ttlMs: 20_000,
    finalPayout: 100,
    steps: [
      { label: '+8s reprices', bid: 72, fair: 75, tau: 92, delta: 55, cex: 'favorable', regime: 'favorable', ageMs: 8_000 },
      { label: '+20s rich', bid: 82, fair: 78, tau: 80, delta: 70, cex: 'neutral', regime: 'favorable', ageMs: 20_000 },
      { label: 'near expiry strong', bid: 92, fair: 91, tau: 35, delta: 130, cex: 'neutral', regime: 'flat', ageMs: 65_000 },
    ],
  },
  {
    name: 'Favorable then pullback: 65 -> 72 sell some -> 63 -> expires WIN',
    stakeUsd: 100,
    entry: 65,
    risk: 70,
    ttlMs: 20_000,
    finalPayout: 100,
    steps: [
      { label: '+8s reprices', bid: 72, fair: 72, tau: 92, delta: 50, cex: 'favorable', regime: 'favorable', ageMs: 8_000 },
      { label: 'pullback near entry', bid: 63, fair: 62, tau: 70, delta: 10, cex: 'neutral', regime: 'flat', ageMs: 30_000 },
    ],
  },
  {
    name: 'Same pullback but expires LOSE',
    stakeUsd: 100,
    entry: 65,
    risk: 70,
    ttlMs: 20_000,
    finalPayout: 0,
    steps: [
      { label: '+8s reprices', bid: 72, fair: 72, tau: 92, delta: 50, cex: 'favorable', regime: 'favorable', ageMs: 8_000 },
      { label: 'pullback near entry', bid: 63, fair: 62, tau: 70, delta: 10, cex: 'neutral', regime: 'flat', ageMs: 30_000 },
    ],
  },
  {
    name: 'Bad: 65 -> 55 neutral -> 48 adverse -> expires LOSE',
    stakeUsd: 100,
    entry: 65,
    risk: 70,
    ttlMs: 20_000,
    finalPayout: 0,
    steps: [
      { label: 'edge decays', bid: 55, fair: 56, tau: 72, delta: 5, cex: 'neutral', regime: 'flat', ageMs: 25_000 },
      { label: 'adverse break', bid: 48, fair: 50, tau: 55, delta: -15, cex: 'adverse', regime: 'adverse', ageMs: 42_000 },
    ],
  },
  {
    name: 'Low entry scalp: 30 -> 38 -> expires LOSE',
    stakeUsd: 100,
    entry: 30,
    risk: 70,
    ttlMs: 20_000,
    finalPayout: 0,
    steps: [
      { label: 'cheap token reprices', bid: 38, fair: 36, tau: 110, delta: -10, cex: 'neutral', regime: 'flat', ageMs: 15_000 },
      { label: 'fades', bid: 25, fair: 28, tau: 60, delta: -50, cex: 'adverse', regime: 'adverse', ageMs: 55_000 },
    ],
  },
  {
    name: 'No quick edge: 65 -> 67 noise -> 64 neutral -> expires WIN',
    stakeUsd: 100,
    entry: 65,
    risk: 70,
    ttlMs: 20_000,
    finalPayout: 100,
    steps: [
      { label: 'small noise up', bid: 67, fair: 66, tau: 95, delta: 35, cex: 'favorable', regime: 'flat', ageMs: 6_000 },
      { label: 'back near entry', bid: 64, fair: 64, tau: 78, delta: 20, cex: 'neutral', regime: 'flat', ageMs: 24_000 },
    ],
  },
];

for (const scenario of scenarios) simulate(scenario);
