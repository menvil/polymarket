import type { Regime } from '../calibrated-crowd/EdgeTable.js';

export type RiskBudgetDirection = 'favorable' | 'neutral' | 'adverse';

export interface RiskBudgetInput {
  readonly entryCents: number;
  readonly currentBidCents: number;
  readonly fairCents: number;
  readonly tauSec: number;
  readonly deltaForSideDollars: number;
  readonly riskTolerance: number;
  readonly cexDirection: RiskBudgetDirection;
  readonly regime: RiskBudgetDirection;
  readonly ageMs: number;
  readonly edgeTtlMs: number;
  readonly realizedScaleOutPct: number;
  readonly avgRealizedExitCents?: number;
  /** Направление ставки: 'up' | 'down'. Влияет на lotteryRisk и structuralSafety. */
  readonly side?: 'up' | 'down';
}

export interface RiskBudgetDecision {
  readonly holdEdgeCents: number;
  readonly stateRisk: number;
  readonly edgeBonus: number;
  readonly quickProfitValueScore: number;
  readonly quickProfitMonetizationRisk: number;
  readonly targetExposurePct: number;
  readonly currentExposurePct: number;
  readonly sellFromInitialPct: number;
  readonly sellFromCurrentPct: number;
  readonly holdEvCentsPerInitialShare: number;
  readonly riskChargeCentsPerInitialShare: number;
  readonly utilityCentsPerInitialShare: number;
  readonly realizedPnlCentsPerInitialShare: number;
  readonly runnerCushionPct: number;
  readonly action: 'HOLD' | 'REDUCE' | 'EXIT';
  readonly notes: readonly string[];
}

export interface RiskBudgetExecutionGuardConfig {
  readonly minProfitScaleOutCents: number;
  readonly minRebalanceDiffPct: number;
  readonly rebalanceHysteresisPct: number;
  readonly rebalanceCooldownMs: number;
  readonly minRunnerPctAfterProfit: number;
  readonly damageControlBypass: boolean;
  readonly drawdownEmergencyCents: number;
  readonly overFairEmergencyCents: number;
}

export interface RiskBudgetExecutionGuardInput {
  readonly decisionTargetPct: number;
  readonly currentExposurePct: number;
  readonly entryCents: number;
  readonly bidCents: number;
  readonly fairCents: number;
  readonly cex: RiskBudgetDirection;
  readonly regime: RiskBudgetDirection;
  readonly ageMs: number;
  readonly lastRebalanceAtMs: number;
  readonly lastExecutedTargetPct: number;
  readonly realizedPnlCentsPerInitialShare: number;
  readonly config: RiskBudgetExecutionGuardConfig;
}

export interface RiskBudgetExecutionGuardResult {
  readonly executableTargetPct: number;
  readonly reason: string;
  readonly emergency: boolean;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function scoreDirection(direction: RiskBudgetDirection): number {
  if (direction === 'favorable') return -18;
  if (direction === 'neutral') return 8;
  return 28;
}

function scoreRegime(regime: RiskBudgetDirection): number {
  if (regime === 'favorable') return -10;
  if (regime === 'neutral') return 4;
  return 18;
}

export function regimeForSide(regime: Regime, side: 'up' | 'down'): RiskBudgetDirection {
  if (regime === 'flat') return 'neutral';
  if (side === 'up') return regime === 'up' ? 'favorable' : 'adverse';
  return regime === 'down' ? 'favorable' : 'adverse';
}

export function computeRiskBudgetDecision(input: RiskBudgetInput): RiskBudgetDecision {
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

  const overFairRisk = clamp((input.currentBidCents - input.fairCents) * 5, 0, 35);
  const drawdownRisk = clamp(drawdownCents * 1.4, 0, 28);
  const thesisDecayRisk = input.cexDirection === 'favorable'
    ? clamp((entryThesisAge - 1) * 8, 0, 12)
    : clamp(entryThesisAge * 18, 0, 28);
  const lotteryRisk = input.entryCents < 40 ? 18 : input.entryCents < 55 ? 8 : input.entryCents > 75 ? -6 : 0;
  const inMoneyDelta = input.deltaForSideDollars;
  const structuralSafety = inMoneyDelta > 100 && input.tauSec < 45
    ? 20
    : inMoneyDelta > 50 && input.tauSec < 90
      ? 10
      : 0;
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
      monetizedEdgeRisk +
      realizedLossRisk -
      structuralSafety,
    0,
    100,
  );

  const edgeBonus = clamp(holdEdgeCents * 4, -30, 30);
  const freshEdgeBoost =
    input.cexDirection === 'favorable' && entryThesisAge <= 1
      ? clamp((1 - entryThesisAge) * 25, 0, 25)
      : 0;

  let targetExposurePct = clamp(
    input.riskTolerance - stateRisk + edgeBonus + freshEdgeBoost,
    0,
    100,
  );

  if (input.entryCents >= 60 && profitPct > 0 && holdEdgeCents > -5) {
    targetExposurePct = Math.max(targetExposurePct, holdEdgeCents >= 0 ? 55 : 35);
    notes.push('high_entry_runner_floor');
  }

  if (input.entryCents <= 40 && profitPct >= 0.15) {
    targetExposurePct = clamp(targetExposurePct, 15, 35);
    notes.push('low_entry_aggressive_monetization');
  }

  const notAdverse = input.cexDirection !== 'adverse' && input.regime !== 'adverse';
  if (holdEdgeCents > 2 && notAdverse) {
    targetExposurePct = Math.max(targetExposurePct, input.riskTolerance * 0.4);
    notes.push('positive_hold_edge_residual_floor');
  }

  const nearEntry = input.currentBidCents >= input.entryCents - 3;
  const runnerCushionPct = realizedPnlCentsPerInitialShare > 0 && nearEntry && notAdverse
    ? clamp(20 + realizedPnlCentsPerInitialShare * 6, 20, 45)
    : 0;
  if (runnerCushionPct > 0) {
    targetExposurePct = Math.max(targetExposurePct, runnerCushionPct);
    notes.push('realized_profit_runner_cushion');
  }

  const nearEntryNeutral = Math.abs(input.currentBidCents - input.entryCents) <= 3 && notAdverse;
  if (nearEntryNeutral && entryThesisAge >= 1) {
    const neutralRunnerFloor = realizedPnlCentsPerInitialShare > 0 ? 25 : 50;
    targetExposurePct = Math.max(targetExposurePct, neutralRunnerFloor);
    notes.push('neutral_near_entry_runner_floor');
  }

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

export function applyRiskBudgetExecutionGuard(
  input: RiskBudgetExecutionGuardInput,
): RiskBudgetExecutionGuardResult {
  if (input.decisionTargetPct >= input.currentExposurePct) {
    return {
      executableTargetPct: input.currentExposurePct,
      reason: 'target_not_below_current',
      emergency: false,
    };
  }

  const desiredReductionPct = input.currentExposurePct - input.decisionTargetPct;
  const profitCents = input.bidCents - input.entryCents;
  const drawdownCents = input.entryCents - input.bidCents;
  const overFairCents = input.bidCents - input.fairCents;
  const drawdownEmergency =
    input.config.drawdownEmergencyCents > 0 &&
    drawdownCents >= input.config.drawdownEmergencyCents;
  const overFairEmergency =
    input.config.overFairEmergencyCents > 0 &&
    overFairCents >= input.config.overFairEmergencyCents;
  const emergency =
    input.config.damageControlBypass &&
    (
      input.cex === 'adverse' ||
      input.regime === 'adverse' ||
      drawdownEmergency ||
      overFairEmergency
    );

  if (!emergency && input.ageMs - input.lastRebalanceAtMs < input.config.rebalanceCooldownMs) {
    return { executableTargetPct: input.currentExposurePct, reason: 'cooldown', emergency };
  }

  if (!emergency && desiredReductionPct < input.config.minRebalanceDiffPct) {
    return { executableTargetPct: input.currentExposurePct, reason: 'inside_no_trade_band', emergency };
  }

  if (
    !emergency &&
    input.decisionTargetPct > input.lastExecutedTargetPct - input.config.rebalanceHysteresisPct
  ) {
    return { executableTargetPct: input.currentExposurePct, reason: 'hysteresis', emergency };
  }

  const profitTaking =
    profitCents > 0 &&
    input.cex !== 'adverse' &&
    input.regime !== 'adverse';

  if (!emergency && profitTaking && profitCents < input.config.minProfitScaleOutCents) {
    return { executableTargetPct: input.currentExposurePct, reason: 'profit_below_min_scaleout', emergency };
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
    emergency,
  };
}
