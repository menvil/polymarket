/**
 * CalibrationRulesStrategy — whitelist-входы по ручной калибровочной таблице.
 *
 * @remarks
 * Использует заранее выбранные зоны `(delta, tau, regime[, crowd])` и делает
 * только maker BUY по UP-токену. После fill позиция держится до экспирации.
 */
import { readFileSync } from 'fs';
import Decimal from 'decimal.js';
import { BaseStrategy } from '@polymarket/strategy';
import type { StrategyIntent, StrategySnapshot, TriggerReason } from '@polymarket/strategy';
import { Price, Quantity } from '@polymarket/value-objects';
import type { ILogger } from '@polymarket/logger';
import type { IDecisionJournal } from '@polymarket/ports';
import { RegimeDetector } from './calibrated-crowd/RegimeDetector.js';
import type { Regime } from './calibrated-crowd/EdgeTable.js';

export interface CalibrationRuleRow {
  readonly id: string;
  readonly label: string;
  readonly side: 'UP';
  readonly deltaMin: number;
  readonly deltaMax: number;
  readonly tauMin: number;
  readonly tauMax: number;
  readonly regimes: readonly Regime[];
  readonly crowdMin?: number;
  readonly crowdMax?: number;
  readonly fairCents?: number;
  readonly avgCrowdCents?: number;
  readonly buyP90Cents?: number;
  readonly edgeCents?: number;
  readonly confidence?: 'low' | 'medium' | 'high';
  readonly sourceWindow?: string;
}

interface CalibrationRuleFile {
  readonly name?: string;
  readonly notes?: readonly string[];
  readonly rules: readonly CalibrationRuleRow[];
}

export interface CalibrationRulesConfig {
  readonly rulesTablePath: string;
  readonly orderShares: number;
  readonly maxSpreadCents?: number;
  readonly warmupSec?: number;
  readonly bidOffsetCents?: number;
  readonly useBookAnchoredMakerPricing?: boolean;
  readonly makerRepriceAfterSec?: number;
  readonly regimeMinPoints?: number;
  readonly regimeThresholdPerMin?: number;
  readonly regimeWindowMs?: number;
  readonly logEntries?: boolean;
  readonly postOnly?: boolean;
}

interface RuleData {
  readonly marketId: string;
  readonly nowMs: number;
  readonly tauSec: number;
  readonly deltaDollars: number | undefined;
  readonly deltaBucket: number | undefined;
  readonly regime: Regime | undefined;
  readonly midCents: number;
  readonly crowdBucket: number;
  readonly spreadCents: number;
  readonly bestBidCents: number | null;
  readonly bestAskCents: number | null;
  readonly tickSizeCents: number;
  readonly hasPosition: boolean;
  readonly hasOpenOrder: boolean;
  readonly hasInFlightFill: boolean;
  readonly availableBalance: Decimal;
  readonly openOrderPriceCents: number | null;
  readonly openOrderAgeSec: number | null;
  readonly matchingRule: CalibrationRuleRow | undefined;
}

type RuleAction =
  | { readonly type: 'BUY'; readonly price: number; readonly size: Decimal; readonly rule: CalibrationRuleRow }
  | { readonly type: 'CANCEL' }
  | { readonly type: 'HOLD' };

function toBucket(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

function loadRules(path: string): readonly CalibrationRuleRow[] {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as CalibrationRuleFile;
  if (!raw || !Array.isArray(raw.rules)) {
    throw new Error(`CalibrationRulesStrategy: invalid rules file at ${path}`);
  }
  return raw.rules;
}

export class CalibrationRulesStrategy extends BaseStrategy<RuleData, RuleAction> {
  public readonly id: string;
  public readonly name = 'CalibrationRulesStrategy';

  private readonly _logger: ILogger | undefined;
  private readonly _journal: IDecisionJournal | undefined;
  private readonly _rules: readonly CalibrationRuleRow[];
  private readonly _regimeDetector: RegimeDetector;
  private readonly _orderSize: Decimal;
  private readonly _maxSpreadCents: number;
  private readonly _warmupSec: number;
  private readonly _bidOffsetCents: number;
  private readonly _useBookAnchoredMakerPricing: boolean;
  private readonly _makerRepriceAfterSec: number;
  private readonly _logEntries: boolean;
  private readonly _postOnly: boolean;

  private _currentExpirationMs = 0;
  private _marketEventStartMs = 0;
  private _currentMarketId = '';
  private _hasFilledEntryThisMarket = false;
  private _pendingPlace = false;

  constructor(
    config: CalibrationRulesConfig,
    strategyId = 'calibration-rules-1',
    logger?: ILogger,
    journal?: IDecisionJournal,
  ) {
    super();
    this.id = strategyId;
    this._logger = logger;
    this._journal = journal;
    this._rules = loadRules(config.rulesTablePath);
    this._regimeDetector = new RegimeDetector({
      thresholdPerMin: config.regimeThresholdPerMin ?? 10,
      windowMs: config.regimeWindowMs ?? 60_000,
      minPoints: config.regimeMinPoints ?? 5,
    });
    this._orderSize = new Decimal(config.orderShares);
    this._maxSpreadCents = config.maxSpreadCents ?? 4;
    this._warmupSec = config.warmupSec ?? 15;
    this._bidOffsetCents = config.bidOffsetCents ?? 1;
    this._useBookAnchoredMakerPricing = config.useBookAnchoredMakerPricing ?? true;
    this._makerRepriceAfterSec = config.makerRepriceAfterSec ?? 5;
    this._logEntries = config.logEntries ?? true;
    this._postOnly = config.postOnly ?? true;

    this._logger?.warn('CalibrationRules: loaded', {
      path: config.rulesTablePath,
      rules: this._rules.length,
      orderShares: this._orderSize.toFixed(2),
      maxSpreadCents: this._maxSpreadCents,
      warmupSec: this._warmupSec,
      postOnly: this._postOnly,
    });
  }

  protected gather(snapshot: StrategySnapshot): RuleData | undefined {
    const expiresMs = snapshot.market.expirationMs;
    if (this._currentExpirationMs !== expiresMs) {
      this._currentExpirationMs = expiresMs;
      this._hasFilledEntryThisMarket = false;
      this._pendingPlace = false;
      if (!snapshot.eventStartMs) return undefined;
      this._marketEventStartMs = snapshot.eventStartMs;
      this._currentMarketId = String(snapshot.instrumentId);
    }

    if ((snapshot.nowMs - this._marketEventStartMs) < this._warmupSec * 1000) {
      return undefined;
    }

    const bestBid = snapshot.topOfBook?.bestBid?.value().toNumber();
    const bestAsk = snapshot.topOfBook?.bestAsk?.value().toNumber();
    if (bestBid === undefined || bestAsk === undefined) return undefined;

    const bestBidCents = bestBid * 100;
    const bestAskCents = bestAsk * 100;
    const midCents = Math.round((bestBidCents + bestAskCents) / 2);
    const spreadCents = bestAskCents - bestBidCents;
    const tickSizeCents = (snapshot.constraints?.tickSize.value().toNumber() ?? 0.01) * 100;
    const tauSec = Math.max(0, (expiresMs - snapshot.nowMs) / 1000);

    const cp = snapshot.cryptoPrice;
    const deltaDollars = cp && cp.targetPrice && cp.currentPrice > 0
      ? cp.currentPrice - cp.targetPrice
      : undefined;
    const deltaBucket = deltaDollars !== undefined ? toBucket(deltaDollars, 10) : undefined;
    const crowdBucket = toBucket(midCents, 5);
    const regime = this._regimeDetector.classify(snapshot.cryptoPriceHistory)?.regime;
    const matchingRule = this._matchRule(deltaBucket, tauSec, regime, crowdBucket);

    const portfolio = snapshot.portfolio;
    const positionQty = portfolio?.getPosition(snapshot.instrumentId)?.quantity?.value() ?? new Decimal(0);
    const availableTokenQty = portfolio?.availableTokenQuantity(snapshot.instrumentId) ?? new Decimal(0);
    const hasPosition = positionQty.gt(0) || availableTokenQty.gt(0);
    const hasOpenOrder = snapshot.openOrders.length > 0;
    const hasInFlightFill = snapshot.hasInFlightFills || snapshot.matchedOrders.length > 0;
    const availableBalance = portfolio?.balance.available().value() ?? new Decimal(0);
    const openOrder = snapshot.openOrders[0];
    const openOrderPriceCents = openOrder ? Math.round(openOrder.price.value().toNumber() * 100) : null;
    const openOrderAgeSec = openOrder
      ? Math.max(0, (snapshot.nowMs - openOrder.timestamp.toNumber()) / 1000)
      : null;

    if (hasPosition) {
      this._hasFilledEntryThisMarket = true;
      this._pendingPlace = false;
    } else if (hasOpenOrder) {
      this._pendingPlace = false;
    }

    return {
      marketId: this._currentMarketId,
      nowMs: snapshot.nowMs,
      tauSec,
      deltaDollars,
      deltaBucket,
      regime,
      midCents,
      crowdBucket,
      spreadCents,
      bestBidCents,
      bestAskCents,
      tickSizeCents,
      hasPosition,
      hasOpenOrder,
      hasInFlightFill,
      availableBalance,
      openOrderPriceCents,
      openOrderAgeSec,
      matchingRule,
    };
  }

  protected decide(data: RuleData, _reasons: ReadonlySet<TriggerReason>): RuleAction[] {
    if (data.hasInFlightFill) return [{ type: 'HOLD' }];
    if (data.hasPosition) return [{ type: 'HOLD' }];
    if (this._hasFilledEntryThisMarket) return [{ type: 'HOLD' }];

    if (data.hasOpenOrder) {
      if (!data.matchingRule) return [{ type: 'CANCEL' }];
      if (data.spreadCents > this._maxSpreadCents * 2) return [{ type: 'CANCEL' }];

      const targetBid = this._computeEntryBidPrice(data, data.matchingRule);
      const tick = Math.max(1, Math.round(data.tickSizeCents));
      if (
        targetBid !== null
        && data.openOrderPriceCents !== null
        && data.openOrderAgeSec !== null
        && data.openOrderAgeSec >= this._makerRepriceAfterSec
        && targetBid >= data.openOrderPriceCents + tick
      ) {
        return [{ type: 'CANCEL' }];
      }
      return [{ type: 'HOLD' }];
    }

    if (this._pendingPlace) return [{ type: 'HOLD' }];
    if (!data.matchingRule) return [{ type: 'HOLD' }];
    if (data.spreadCents > this._maxSpreadCents) return [{ type: 'HOLD' }];

    const bidCents = this._computeEntryBidPrice(data, data.matchingRule);
    if (bidCents === null) return [{ type: 'HOLD' }];

    const cost = this._orderSize.mul(bidCents).div(100);
    if (data.availableBalance.lt(cost)) return [{ type: 'HOLD' }];

    this._pendingPlace = true;
    if (this._logEntries) {
      this._logger?.warn('CalibrationRules: BUY', {
        ruleId: data.matchingRule.id,
        label: data.matchingRule.label,
        marketId: data.marketId,
        bidCents,
        midCents: data.midCents,
        crowdBucket: data.crowdBucket,
        deltaBucket: data.deltaBucket,
        regime: data.regime,
        tauSec: roundInt(data.tauSec),
      });
    }
    this._journal?.recordDecision({
      marketId: data.marketId,
      strategyId: this.id,
      ts: data.nowMs,
      action: 'BUY',
      state: {
        tauSec: data.tauSec,
        deltaDollars: data.deltaDollars,
        deltaBucket: data.deltaBucket,
        regime: data.regime,
        midCents: data.midCents,
        crowdBucket: data.crowdBucket,
        spreadCents: data.spreadCents,
      },
      bidPrice: bidCents,
      orderSize: this._orderSize.toString(),
      effectiveSide: 'up',
      rejectReason: `rule:${data.matchingRule.id}`,
    });
    return [{ type: 'BUY', price: bidCents, size: this._orderSize, rule: data.matchingRule }];
  }

  protected toIntents(actions: RuleAction[]): StrategyIntent[] {
    const intents: StrategyIntent[] = [];
    for (const action of actions) {
      if (action.type === 'HOLD') continue;
      if (action.type === 'CANCEL') {
        intents.push({ type: 'CANCEL_ALL' });
        continue;
      }
      intents.push({ type: 'CANCEL_ALL' });
      intents.push({
        type: 'PLACE',
        side: 'BUY',
        price: Price.of(new Decimal(action.price).div(100)),
        size: Quantity.of(action.size),
        postOnly: this._postOnly,
      });
    }
    return intents;
  }

  private _matchRule(
    deltaBucket: number | undefined,
    tauSec: number,
    regime: Regime | undefined,
    crowdBucket: number,
  ): CalibrationRuleRow | undefined {
    if (deltaBucket === undefined || regime === undefined) return undefined;
    return this._rules.find((rule) => {
      if (!rule.regimes.includes(regime)) return false;
      if (deltaBucket < rule.deltaMin || deltaBucket > rule.deltaMax) return false;
      if (tauSec < rule.tauMin || tauSec >= rule.tauMax) return false;
      if (rule.crowdMin !== undefined && crowdBucket < rule.crowdMin) return false;
      if (rule.crowdMax !== undefined && crowdBucket > rule.crowdMax) return false;
      return true;
    });
  }

  private _computeEntryBidPrice(data: RuleData, rule: CalibrationRuleRow): number | null {
    const strategyCap = Math.max(
      1,
      Math.min(
        rule.crowdMax ?? data.midCents,
        rule.fairCents !== undefined ? Math.floor(rule.fairCents) : 99,
      ),
    );

    if (!this._useBookAnchoredMakerPricing) {
      return Math.max(1, strategyCap - this._bidOffsetCents);
    }

    if (data.bestBidCents === null || data.bestAskCents === null) {
      return Math.max(1, strategyCap);
    }

    const tick = Math.max(1, Math.round(data.tickSizeCents));
    const spread = data.bestAskCents - data.bestBidCents;
    if (spread <= 0) return Math.max(1, Math.min(data.bestBidCents, strategyCap));
    if (spread <= tick) return Math.max(1, Math.min(data.bestBidCents, strategyCap));

    const improvedBid = data.bestBidCents + tick;
    const makerSafeBid = data.bestAskCents - tick;
    return Math.max(1, Math.min(improvedBid, makerSafeBid, strategyCap));
  }
}

function roundInt(value: number): number {
  return Math.round(value);
}
