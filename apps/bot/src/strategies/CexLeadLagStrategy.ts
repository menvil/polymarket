import { BaseStrategy } from '@polymarket/strategy';
import type {
  CexVenue,
  CryptoSignalDirection,
  CryptoSignalResult,
  StrategyIntent,
  StrategySnapshot,
  TriggerReason,
} from '@polymarket/strategy';
import { Price, Quantity } from '@polymarket/value-objects';
import type { ILogger } from '@polymarket/logger';
import Decimal from 'decimal.js';

const SECONDS_PER_YEAR = 365.25 * 24 * 3600;

export type CexLeadLagMode = 'defensive' | 'skewed' | 'hybrid';
export type CexLeadLagSide = 'up' | 'down';

export interface CexLeadLagConfig {
  readonly orderSize: Decimal;
  readonly qMax: number;
  readonly side?: CexLeadLagSide;
  readonly mode?: CexLeadLagMode;
  readonly signalId?: string;
  readonly venues?: readonly CexVenue[];
  readonly weights?: Readonly<Record<string, number>>;
  readonly basisByVenue?: Readonly<Record<string, number>>;
  readonly confidenceByScore?: Readonly<Record<string, number>>;
  readonly signalThresholdBps?: number;
  readonly signalLookbackMs?: number;
  readonly signalStaleMs?: number;
  readonly minVenueCount?: number;
  readonly maxSpreadBps?: number;
  readonly minSignalStrength?: number;
  readonly minSignalConfidence?: number;
  readonly signalImpactCents?: number;
  readonly maxSignalImpactCents?: number;
  readonly makerRepriceThresholdCents?: number;
  readonly requireSignalForEntry?: boolean;
  readonly allowTaker?: boolean;
  readonly sigmaAnnual?: number;
  readonly minEdgeCents?: number;
  readonly exitEdgeCents?: number;
  readonly baseSpreadCents?: number;
  readonly exitDiscountCents?: number;
  readonly warmupSec?: number;
  readonly ewmaAlpha?: number;
  readonly minTradesForMid?: number;
  readonly exitTauSec?: number;
  readonly maxEntryTauSec?: number;
  readonly minFairCents?: number;
  readonly maxFairCents?: number;
}

interface CexLeadLagData {
  readonly side: CexLeadLagSide;
  readonly mode: CexLeadLagMode;
  readonly signal: CryptoSignalResult | undefined;
  readonly signalDirectionForToken: CryptoSignalDirection;
  readonly signalStrong: boolean;
  readonly signalFavorable: boolean;
  readonly signalAdverse: boolean;
  readonly signalImpactCents: number;
  readonly baseFairCents: number;
  readonly adjustedFairCents: number;
  readonly midCents: number;
  readonly bestBidCents: number | undefined;
  readonly bestAskCents: number | undefined;
  readonly openBuyPriceCents: number | undefined;
  readonly tauSec: number;
  readonly positionQty: Decimal;
  readonly availableTokenQty: Decimal;
  readonly availableBalance: Decimal;
  readonly minOrderSize: Decimal;
  readonly minOrderValue: Decimal;
  readonly inventoryUnits: number;
  readonly hasInFlightFills: boolean;
  readonly nowMs: number;
  readonly currentPrice: number;
  readonly targetPrice: number;
}

type CexLeadLagAction =
  | { readonly type: 'BUY'; readonly price: number; readonly size: Decimal }
  | { readonly type: 'SELL'; readonly price: number; readonly size: Decimal }
  | { readonly type: 'CANCEL' };

function normalCdf(x: number): number {
  if (x < -8) return 0;
  if (x > 8) return 1;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
  return 0.5 * (1 + sign * y);
}

function binaryUpFairCents(price: number, strike: number, sigmaAnnual: number, tauSec: number): number {
  if (tauSec <= 0) return price >= strike ? 99 : 1;
  if (price <= 0 || strike <= 0 || sigmaAnnual <= 0) return 50;
  const tauYears = tauSec / SECONDS_PER_YEAR;
  const d = Math.log(price / strike) / (sigmaAnnual * Math.sqrt(tauYears));
  return clamp(normalCdf(d) * 100, 1, 99);
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.max(lower, Math.min(upper, value));
}

function toNumber(value: number | Decimal | undefined, fallback: number): number {
  if (value instanceof Decimal) return value.toNumber();
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isUpDirection(direction: CryptoSignalDirection): boolean {
  return direction === 'up';
}

function invertDirection(direction: CryptoSignalDirection): CryptoSignalDirection {
  if (direction === 'up') return 'down';
  if (direction === 'down') return 'up';
  return 'flat';
}

export class CexLeadLagStrategy extends BaseStrategy<CexLeadLagData, CexLeadLagAction> {
  public readonly id: string;
  public readonly name = 'CexLeadLagStrategy';

  private readonly _logger: ILogger | undefined;
  private readonly _orderSize: Decimal;
  private readonly _qMax: number;
  private readonly _side: CexLeadLagSide;
  private readonly _mode: CexLeadLagMode;
  private readonly _signalId: string;
  private readonly _venues: readonly CexVenue[];
  private readonly _weights: Readonly<Record<string, number>> | undefined;
  private readonly _basisByVenue: Readonly<Record<string, number>> | undefined;
  private readonly _confidenceByScore: Readonly<Record<string, number>> | undefined;
  private readonly _signalThresholdBps: number;
  private readonly _signalLookbackMs: number;
  private readonly _signalStaleMs: number;
  private readonly _minVenueCount: number | undefined;
  private readonly _maxSpreadBps: number | undefined;
  private readonly _minSignalStrength: number;
  private readonly _minSignalConfidence: number;
  private readonly _signalImpactCents: number;
  private readonly _maxSignalImpactCents: number;
  private readonly _makerRepriceThresholdCents: number;
  private readonly _requireSignalForEntry: boolean;
  private readonly _allowTaker: boolean;
  private readonly _sigmaAnnual: number;
  private readonly _minEdgeCents: number;
  private readonly _exitEdgeCents: number;
  private readonly _baseSpreadCents: number;
  private readonly _exitDiscountCents: number;
  private readonly _warmupSec: number;
  private readonly _ewmaAlpha: number;
  private readonly _minTradesForMid: number;
  private readonly _exitTauSec: number;
  private readonly _maxEntryTauSec: number;
  private readonly _minFairCents: number;
  private readonly _maxFairCents: number;

  private _ewma: number | null = null;
  private _tradeCount = 0;
  private _lastTradeTimestampMs = 0;
  private _currentExpirationMs = 0;
  private _marketEventStartMs = 0;
  private _lastDiagMs = 0;

  constructor(config: CexLeadLagConfig, strategyId = 'cex-lead-lag-1', logger?: ILogger) {
    super();
    this.id = strategyId;
    this._logger = logger;
    this._orderSize = config.orderSize;
    this._qMax = config.qMax;
    this._side = config.side ?? 'up';
    this._mode = config.mode ?? 'skewed';
    this._signalId = config.signalId ?? 'cex_chainlink_lead_lag';
    this._venues = config.venues ?? ['binance', 'coinbase', 'okx'];
    this._weights = config.weights;
    this._basisByVenue = config.basisByVenue;
    this._confidenceByScore = config.confidenceByScore;
    this._signalThresholdBps = toNumber(config.signalThresholdBps, 0.5);
    this._signalLookbackMs = toNumber(config.signalLookbackMs, 1_000);
    this._signalStaleMs = toNumber(config.signalStaleMs, 2_000);
    this._minVenueCount = config.minVenueCount;
    this._maxSpreadBps = config.maxSpreadBps;
    this._minSignalStrength = toNumber(config.minSignalStrength, 6);
    this._minSignalConfidence = toNumber(config.minSignalConfidence, 0.55);
    this._signalImpactCents = toNumber(config.signalImpactCents, 5);
    this._maxSignalImpactCents = toNumber(config.maxSignalImpactCents, 10);
    this._makerRepriceThresholdCents = toNumber(config.makerRepriceThresholdCents, 1);
    this._requireSignalForEntry = config.requireSignalForEntry ?? true;
    this._allowTaker = config.allowTaker ?? false;
    this._sigmaAnnual = toNumber(config.sigmaAnnual, 0.60);
    this._minEdgeCents = toNumber(config.minEdgeCents, 2);
    this._exitEdgeCents = toNumber(config.exitEdgeCents, 1);
    this._baseSpreadCents = toNumber(config.baseSpreadCents, 1);
    this._exitDiscountCents = toNumber(config.exitDiscountCents, 1);
    this._warmupSec = toNumber(config.warmupSec, 10);
    this._ewmaAlpha = toNumber(config.ewmaAlpha, 0.3);
    this._minTradesForMid = toNumber(config.minTradesForMid, 3);
    this._exitTauSec = toNumber(config.exitTauSec, 20);
    this._maxEntryTauSec = toNumber(config.maxEntryTauSec, 300);
    this._minFairCents = toNumber(config.minFairCents, 1);
    this._maxFairCents = toNumber(config.maxFairCents, 99);

    this._logger?.warn('CexLeadLag: init', {
      strategyId: this.id,
      side: this._side,
      mode: this._mode,
      venues: this._venues.join(','),
      signalThresholdBps: this._signalThresholdBps,
      minSignalStrength: this._minSignalStrength,
      minSignalConfidence: this._minSignalConfidence,
      requireSignalForEntry: this._requireSignalForEntry,
      allowTaker: this._allowTaker,
    });
  }

  protected gather(snapshot: StrategySnapshot): CexLeadLagData | undefined {
    if (!snapshot.cryptoPrice || !snapshot.eventStartMs) return undefined;

    const expiresMs = snapshot.market.expirationMs;
    if (this._currentExpirationMs !== expiresMs) {
      this._currentExpirationMs = expiresMs;
      this._marketEventStartMs = snapshot.eventStartMs;
      this._ewma = null;
      this._tradeCount = 0;
      this._lastTradeTimestampMs = 0;
      this._lastDiagMs = 0;
    }

    this._updateEwma(snapshot);
    if (this._ewma === null || this._tradeCount < this._minTradesForMid) return undefined;
    if (snapshot.nowMs - this._marketEventStartMs < this._warmupSec * 1_000) return undefined;

    const currentPrice = snapshot.cryptoPrice.chainlink?.price ?? snapshot.cryptoPrice.currentPrice;
    const targetPrice = snapshot.cryptoPrice.targetPrice;
    if (!targetPrice || targetPrice <= 0 || currentPrice <= 0) return undefined;

    const tauSec = Math.max(0, (expiresMs - snapshot.nowMs) / 1_000);
    const upFair = binaryUpFairCents(currentPrice, targetPrice, this._sigmaAnnual, tauSec);
    const baseFairCents = this._side === 'up' ? upFair : 100 - upFair;

    const signal = snapshot.cryptoSignals?.evaluate(this._signalId, {
      venues: this._venues,
      weights: this._weights,
      basisByVenue: this._basisByVenue,
      confidenceByScore: this._confidenceByScore,
      lookbackMs: this._signalLookbackMs,
      staleMs: this._signalStaleMs,
      thresholdBps: this._signalThresholdBps,
      minVenueCount: this._minVenueCount,
      maxSpreadBps: this._maxSpreadBps,
    });
    const signalDirectionForToken = this._side === 'up'
      ? signal?.direction ?? 'flat'
      : invertDirection(signal?.direction ?? 'flat');
    const signalStrong = Boolean(
      signal
      && !signal.stale
      && signal.direction !== 'flat'
      && signal.strength >= this._minSignalStrength
      && signal.confidence >= this._minSignalConfidence,
    );
    const signalFavorable = signalStrong && isUpDirection(signalDirectionForToken);
    const signalAdverse = signalStrong && signalDirectionForToken === 'down';
    const rawImpact = signal && this._mode !== 'defensive'
      ? Math.min(this._maxSignalImpactCents, signal.strength / 10 * this._signalImpactCents)
      : 0;
    const signalImpactCents = signalFavorable ? rawImpact : signalAdverse ? -rawImpact : 0;
    const adjustedFairCents = clamp(baseFairCents + signalImpactCents, 1, 99);

    const position = snapshot.portfolio?.getPosition(snapshot.instrumentId);
    const positionQty = position?.quantity.value() ?? new Decimal(0);
    const availableTokenQty = snapshot.portfolio?.availableTokenQuantity(snapshot.instrumentId) ?? new Decimal(0);
    const availableBalance = snapshot.portfolio?.balance.available().value() ?? new Decimal(0);
    const minOrderSize = snapshot.constraints?.minOrderSize.value() ?? new Decimal(0);
    const minOrderValue = snapshot.constraints?.minOrderValue.value() ?? new Decimal(1);
    const inventoryUnits = this._orderSize.gt(0) ? positionQty.div(this._orderSize).toNumber() : 0;

    return {
      side: this._side,
      mode: this._mode,
      signal,
      signalDirectionForToken,
      signalStrong,
      signalFavorable,
      signalAdverse,
      signalImpactCents,
      baseFairCents,
      adjustedFairCents,
      midCents: this._ewma,
      bestBidCents: this._bestBidCents(snapshot),
      bestAskCents: this._bestAskCents(snapshot),
      openBuyPriceCents: this._openBuyPriceCents(snapshot),
      tauSec,
      positionQty,
      availableTokenQty,
      availableBalance,
      minOrderSize,
      minOrderValue,
      inventoryUnits,
      hasInFlightFills: snapshot.hasInFlightFills || snapshot.matchedOrders.length > 0,
      nowMs: snapshot.nowMs,
      currentPrice,
      targetPrice,
    };
  }

  protected decide(data: CexLeadLagData, _reasons: ReadonlySet<TriggerReason>): CexLeadLagAction[] {
    if (data.hasInFlightFills) return [{ type: 'CANCEL' }];

    const hasPosition = data.positionQty.gt(0);
    if (hasPosition) {
      const exit = this._checkExit(data);
      if (exit) return [exit];
      this._logDiag(data, 'HOLD');
      return [{ type: 'CANCEL' }];
    }

    const entry = this._checkEntry(data);
    if (entry) return [entry];
    if (data.openBuyPriceCents !== undefined && data.signalFavorable && !data.signalAdverse) return [];
    return [{ type: 'CANCEL' }];
  }

  protected toIntents(actions: CexLeadLagAction[]): StrategyIntent[] {
    const intents: StrategyIntent[] = [];

    for (const action of actions) {
      intents.push({ type: 'CANCEL_ALL' });
      if (action.type === 'CANCEL') continue;

      intents.push({
        type: 'PLACE',
        side: action.type === 'BUY' ? 'BUY' : 'SELL',
        price: Price.of(new Decimal(action.price).div(100)),
        size: Quantity.of(action.size),
      });
    }

    return intents;
  }

  private _checkEntry(data: CexLeadLagData): CexLeadLagAction | undefined {
    if (data.tauSec < this._exitTauSec + 5) return undefined;
    if (data.tauSec > this._maxEntryTauSec) return undefined;
    if (data.inventoryUnits >= this._qMax) return undefined;
    if (data.signalAdverse) {
      this._logDiag(data, 'ADVERSE_SKIP');
      return undefined;
    }
    if (this._requireSignalForEntry && !data.signalFavorable) return undefined;
    if (data.adjustedFairCents < this._minFairCents || data.adjustedFairCents > this._maxFairCents) return undefined;

    const edgeToMid = data.adjustedFairCents - data.midCents;
    if (edgeToMid < this._minEdgeCents) return undefined;

    let bidPrice = Math.floor(data.adjustedFairCents - this._minEdgeCents);
    if (!this._allowTaker && data.bestAskCents !== undefined) {
      bidPrice = Math.min(bidPrice, Math.floor(data.bestAskCents) - 1);
    } else if (!this._allowTaker) {
      bidPrice = Math.min(bidPrice, Math.floor(data.midCents - this._baseSpreadCents));
    }
    bidPrice = Math.floor(clamp(bidPrice, 1, 98));
    if (bidPrice <= 0) return undefined;

    if (
      data.openBuyPriceCents !== undefined
      && data.adjustedFairCents - data.openBuyPriceCents >= this._minEdgeCents
      && Math.abs(bidPrice - data.openBuyPriceCents) <= this._makerRepriceThresholdCents
    ) {
      this._logDiag(data, 'HOLD_BID', {
        bid: data.openBuyPriceCents.toFixed(0),
        desiredBid: bidPrice,
        edgeToOpenBid: (data.adjustedFairCents - data.openBuyPriceCents).toFixed(2),
      });
      return undefined;
    }

    const buySize = this._buySizeForPrice(data, bidPrice);
    if (!buySize) return undefined;

    const cost = buySize.mul(bidPrice).div(100);
    if (data.availableBalance.lt(cost)) return undefined;

    this._logDiag(data, 'BUY', {
      bid: bidPrice,
      edgeToMid: edgeToMid.toFixed(2),
      size: buySize.toString(),
    });
    return { type: 'BUY', price: bidPrice, size: buySize };
  }

  private _buySizeForPrice(data: CexLeadLagData, priceCents: number): Decimal | undefined {
    const maxPositionQty = this._orderSize.mul(this._qMax);
    const remainingQty = maxPositionQty.minus(data.positionQty);
    if (remainingQty.lte(0)) return undefined;

    const price = new Decimal(priceCents).div(100);
    const minSizeForValue = data.minOrderValue.gt(0)
      ? data.minOrderValue.div(price).ceil()
      : new Decimal(0);
    const effectiveSize = Decimal.max(this._orderSize, data.minOrderSize, minSizeForValue);

    if (effectiveSize.gt(remainingQty)) return undefined;
    if (effectiveSize.mul(price).lt(data.minOrderValue)) return undefined;
    return effectiveSize;
  }

  private _checkExit(data: CexLeadLagData): CexLeadLagAction | undefined {
    const fairEdge = data.adjustedFairCents - data.midCents;
    const shouldExit =
      data.signalAdverse
      || fairEdge < -this._exitEdgeCents
      || data.tauSec < this._exitTauSec;

    if (!shouldExit || !data.availableTokenQty.gt(0)) return undefined;

    let askPrice = Math.floor(data.midCents - this._exitDiscountCents);
    if (this._allowTaker && data.bestBidCents !== undefined) {
      askPrice = Math.min(askPrice, Math.floor(data.bestBidCents));
    }
    askPrice = Math.floor(clamp(askPrice, 1, 99));

    const size = Decimal.min(this._orderSize, data.availableTokenQty);
    this._logDiag(data, data.signalAdverse ? 'ADVERSE_EXIT' : 'EXIT', {
      ask: askPrice,
      fairEdge: fairEdge.toFixed(2),
    });
    return { type: 'SELL', price: askPrice, size };
  }

  private _updateEwma(snapshot: StrategySnapshot): void {
    const tapeRecords = snapshot.tradeTape?.getAll();
    if (tapeRecords && tapeRecords.length > 0) {
      for (const trade of tapeRecords) {
        const tradeTs = trade.timestamp.toNumber();
        if (tradeTs <= this._lastTradeTimestampMs) continue;
        const priceCents = trade.price.value().toNumber() * 100;
        this._ewma = this._ewma === null
          ? priceCents
          : this._ewmaAlpha * priceCents + (1 - this._ewmaAlpha) * this._ewma;
        this._tradeCount++;
        this._lastTradeTimestampMs = tradeTs;
      }
    }

    if (this._ewma !== null || !snapshot.topOfBook) return;
    const bid = snapshot.topOfBook.bestBid?.value().toNumber();
    const ask = snapshot.topOfBook.bestAsk?.value().toNumber();
    if (bid !== undefined && ask !== undefined) {
      this._ewma = (bid + ask) / 2 * 100;
      this._tradeCount = Math.max(this._tradeCount, 1);
    }
  }

  private _bestBidCents(snapshot: StrategySnapshot): number | undefined {
    const value = snapshot.topOfBook?.bestBid?.value().toNumber();
    return value === undefined ? undefined : value * 100;
  }

  private _bestAskCents(snapshot: StrategySnapshot): number | undefined {
    const value = snapshot.topOfBook?.bestAsk?.value().toNumber();
    return value === undefined ? undefined : value * 100;
  }

  private _openBuyPriceCents(snapshot: StrategySnapshot): number | undefined {
    const order = snapshot.openOrders.find((item) => item.side === 'BUY');
    return order ? order.price.value().toNumber() * 100 : undefined;
  }

  private _logDiag(data: CexLeadLagData, action: string, extra?: Record<string, unknown>): void {
    if (data.nowMs - this._lastDiagMs < 5_000) return;
    this._lastDiagMs = data.nowMs;
    this._logger?.info('CexLeadLag: tick', {
      action,
      side: data.side,
      mode: data.mode,
      fair: data.baseFairCents.toFixed(2),
      adjFair: data.adjustedFairCents.toFixed(2),
      mid: data.midCents.toFixed(2),
      signalDir: data.signal?.direction ?? 'none',
      tokenSignalDir: data.signalDirectionForToken,
      signalValueBps: data.signal?.value.toFixed(3),
      signalStrength: data.signal?.strength.toFixed(2),
      signalConfidence: data.signal?.confidence.toFixed(3),
      signalImpact: data.signalImpactCents.toFixed(2),
      tau: data.tauSec.toFixed(0),
      inv: data.inventoryUnits.toFixed(2),
      chainlink: data.currentPrice.toFixed(2),
      strike: data.targetPrice.toFixed(2),
      ...extra,
    });
  }
}
