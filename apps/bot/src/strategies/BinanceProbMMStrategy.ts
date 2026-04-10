import { BaseStrategy } from '@polymarket/strategy';
import type { StrategyIntent, StrategySnapshot, TriggerReason } from '@polymarket/strategy';
import { Price, Quantity } from '@polymarket/value-objects';
import type { ILogger } from '@polymarket/logger';
import Decimal from 'decimal.js';

interface Kline {
  readonly openTime: number;
  readonly closeTime: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

interface HorizonStats {
  readonly mu: number;
  readonly sigma: number;
}

export interface BinanceProbMMConfig {
  readonly orderSize: Decimal;
  readonly qMax: number;
  readonly lookbackDays?: number;
  readonly maxHorizonMinutes?: number;
  readonly useDrift?: boolean;
  readonly minEdgeCents?: number;
  readonly baseSpreadCents?: number;
  readonly maxSpreadCents?: number;
  readonly inventorySkew?: number;
  readonly unwindSec?: number;
  readonly warmupSec?: number;
  readonly ewmaAlpha?: number;
  readonly minTradesForMid?: number;
  readonly minModelSamples?: number;
  readonly binanceSymbol?: string;
  readonly binanceBaseUrl?: string;
}

interface BPMMData {
  readonly fairValueCents: number | null;
  readonly probToken: number | null;
  readonly midCents: number;
  readonly tauSec: number;
  readonly inventoryUnits: number;
  readonly positionQty: Decimal;
  readonly availableTokenQty: Decimal;
  readonly availableBalance: Decimal;
  readonly hasInFlightFills: boolean;
  readonly minOrderSize: Decimal | undefined;
  readonly minOrderValue: Decimal | undefined;
  readonly currentPrice: number;
  readonly targetPrice: number;
  readonly modelReady: boolean;
}

type BPMMAction =
  | { readonly type: 'QUOTE'; readonly bid: number; readonly ask: number; readonly bidSize: Decimal; readonly askSize: Decimal }
  | { readonly type: 'UNWIND'; readonly ask: number; readonly askSize: Decimal }
  | { readonly type: 'STOP' };

const DEFAULT_TIMEOUT_MS = 15_000;
const BINANCE_LIMIT = 1000;

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

function calcLogReturns(prices: readonly number[], step: number): number[] {
  const returns: number[] = [];
  for (let i = step; i < prices.length; i++) {
    const prev = prices[i - step]!;
    const curr = prices[i]!;
    if (prev <= 0 || curr <= 0) continue;
    returns.push(Math.log(curr / prev));
  }
  return returns;
}

function calcMean(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error('cannot calculate mean of empty array');
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function calcSigma(values: readonly number[]): number {
  if (values.length < 2) {
    throw new Error('not enough data to calculate sigma');
  }
  const mean = calcMean(values);
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const sigma = Math.sqrt(variance);
  if (!Number.isFinite(sigma) || sigma <= 0) {
    throw new Error('sigma is invalid or zero');
  }
  return sigma;
}

async function fetchKlines(
  baseUrl: string,
  symbol: string,
  interval: string,
  fromMs: number,
  toMs: number,
): Promise<Kline[]> {
  const klines: Kline[] = [];
  let startTime = fromMs;

  while (startTime < toMs) {
    const url = new URL('/api/v3/klines', baseUrl);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', interval);
    url.searchParams.set('startTime', String(startTime));
    url.searchParams.set('endTime', String(toMs));
    url.searchParams.set('limit', String(BINANCE_LIMIT));

    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Binance klines API error: ${response.status} ${text}`);
    }

    const raw = await response.json() as unknown[];
    const batch = Array.isArray(raw)
      ? raw.map((item): Kline => {
        const row = item as unknown[];
        return {
          openTime: Number(row[0]),
          open: Number(row[1]),
          high: Number(row[2]),
          low: Number(row[3]),
          close: Number(row[4]),
          volume: Number(row[5]),
          closeTime: Number(row[6]),
        };
      })
      : [];

    if (batch.length === 0) break;

    klines.push(...batch);
    startTime = batch[batch.length - 1]!.closeTime + 1;

    if (batch.length < BINANCE_LIMIT) break;
  }

  return klines;
}

function inferBinanceSymbol(asset: string | undefined): string | undefined {
  if (!asset) return undefined;
  const normalized = asset.trim().toUpperCase();
  if (!normalized) return undefined;
  return `${normalized}USD`;
}

function isUpLikeOutcome(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized === 'up' || normalized === 'yes';
}

function isDownLikeOutcome(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized === 'down' || normalized === 'no';
}

export class BinanceProbMMStrategy extends BaseStrategy<BPMMData, BPMMAction> {
  public readonly id: string;
  public readonly name = 'BinanceProbMMStrategy';

  private readonly _logger: ILogger | undefined;
  private readonly _orderSize: Decimal;
  private readonly _qMax: number;
  private readonly _lookbackDays: number;
  private readonly _maxHorizonMinutes: number;
  private readonly _useDrift: boolean;
  private readonly _minEdgeCents: number;
  private readonly _baseSpreadCents: number;
  private readonly _maxSpreadCents: number;
  private readonly _inventorySkew: number;
  private readonly _unwindSec: number;
  private readonly _warmupSec: number;
  private readonly _ewmaAlpha: number;
  private readonly _minTradesForMid: number;
  private readonly _minModelSamples: number;
  private readonly _binanceSymbolOverride: string | undefined;
  private readonly _binanceBaseUrl: string;

  private _ewma: number | null = null;
  private _tradeCount = 0;
  private _lastTradeTimestampMs = 0;
  private _marketEventStartMs = 0;
  private _currentMarketKey: string | null = null;
  private _isUpToken = true;

  private _statsByHorizon = new Map<number, HorizonStats>();
  private _modelReady = false;
  private _modelLoading = false;
  private _modelError: string | null = null;
  private _modelLogSuppressed = false;
  private _currentQuestion = '';

  constructor(config: BinanceProbMMConfig, strategyId = 'binance-prob-mm-1', logger?: ILogger) {
    super();
    this.id = strategyId;
    this._logger = logger;
    this._orderSize = config.orderSize;
    this._qMax = config.qMax;
    this._lookbackDays = config.lookbackDays ?? 5;
    this._maxHorizonMinutes = config.maxHorizonMinutes ?? 15;
    this._useDrift = config.useDrift ?? false;
    this._minEdgeCents = config.minEdgeCents ?? 2;
    this._baseSpreadCents = config.baseSpreadCents ?? 1;
    this._maxSpreadCents = config.maxSpreadCents ?? 8;
    this._inventorySkew = config.inventorySkew ?? 1;
    this._unwindSec = config.unwindSec ?? 30;
    this._warmupSec = config.warmupSec ?? 10;
    this._ewmaAlpha = config.ewmaAlpha ?? 0.3;
    this._minTradesForMid = config.minTradesForMid ?? 5;
    this._minModelSamples = config.minModelSamples ?? 200;
    this._binanceSymbolOverride = config.binanceSymbol?.trim().toUpperCase() || undefined;
    this._binanceBaseUrl = config.binanceBaseUrl ?? 'https://api.binance.com';

    this._logger?.warn('BinanceProbMM: init', {
      strategyId: this.id,
      qMax: this._qMax,
      lookbackDays: this._lookbackDays,
      maxHorizonMinutes: this._maxHorizonMinutes,
      useDrift: this._useDrift,
      minEdgeCents: this._minEdgeCents,
      baseSpreadCents: this._baseSpreadCents,
      maxSpreadCents: this._maxSpreadCents,
      inventorySkew: this._inventorySkew,
      unwindSec: this._unwindSec,
      binanceSymbol: this._binanceSymbolOverride ?? 'auto',
    });
  }

  protected gather(snapshot: StrategySnapshot): BPMMData | undefined {
    if (!snapshot.cryptoPrice) return undefined;
    if (!snapshot.eventStartMs) return undefined;

    const currentPrice = snapshot.cryptoPrice.currentPrice;
    const targetPrice = snapshot.cryptoPrice.targetPrice;
    if (currentPrice <= 0 || !targetPrice || targetPrice <= 0) {
      return undefined;
    }

    const marketId = String(snapshot.market.id ?? '');
    const marketKey = `${marketId}:${snapshot.market.expirationMs}:${snapshot.eventStartMs}`;
    if (this._currentMarketKey !== marketKey) {
      this._resetForNewMarket(snapshot, marketKey);
      this._startModelBuild(snapshot, marketKey);
    }

    const tapeRecords = snapshot.tradeTape?.getAll();
    if (tapeRecords && tapeRecords.length > 0) {
      for (const trade of tapeRecords) {
        const tradeTs = trade.timestamp.toNumber();
        if (tradeTs <= this._lastTradeTimestampMs) continue;
        const priceNum = trade.price.value().toNumber() * 100;
        this._ewma = this._ewma === null
          ? priceNum
          : this._ewmaAlpha * priceNum + (1 - this._ewmaAlpha) * this._ewma;
        this._tradeCount++;
        this._lastTradeTimestampMs = tradeTs;
      }
    }

    if (this._ewma === null && snapshot.topOfBook) {
      const bid = snapshot.topOfBook.bestBid?.value().toNumber();
      const ask = snapshot.topOfBook.bestAsk?.value().toNumber();
      if (bid !== undefined && ask !== undefined) {
        this._ewma = ((bid + ask) / 2) * 100;
        this._tradeCount = Math.max(this._tradeCount, 1);
      }
    }

    if (this._ewma === null || this._tradeCount < this._minTradesForMid) {
      return undefined;
    }

    if ((snapshot.nowMs - this._marketEventStartMs) < this._warmupSec * 1000) {
      return undefined;
    }

    const tauSec = Math.max(0, (snapshot.market.expirationMs - snapshot.nowMs) / 1000);
    const horizonMinutes = Math.max(1, Math.min(this._maxHorizonMinutes, Math.ceil(tauSec / 60)));

    let fairValueCents: number | null = null;
    let probToken: number | null = null;
    if (this._modelReady) {
      const stats = this._statsByHorizon.get(horizonMinutes);
      if (stats) {
        const mu = this._useDrift ? stats.mu : 0;
        const pBelowOrEqual = this._probabilityCloseAtOrBelowTarget(currentPrice, targetPrice, mu, stats.sigma);
        const pUp = 1 - pBelowOrEqual;
        probToken = this._isUpToken ? pUp : 1 - pUp;
        fairValueCents = Math.max(1, Math.min(99, probToken * 100));
      }
    } else if (this._modelError && !this._modelLogSuppressed) {
      this._modelLogSuppressed = true;
      this._logger?.error('BinanceProbMM: model unavailable', { error: this._modelError });
    }

    const portfolio = snapshot.portfolio;
    const positionQty = portfolio?.getPosition(snapshot.instrumentId)?.quantity.value() ?? new Decimal(0);
    const availableTokenQty = portfolio?.availableTokenQuantity(snapshot.instrumentId) ?? new Decimal(0);
    const availableBalance = portfolio?.balance.available().value() ?? new Decimal(0);
    const inventoryUnits = this._orderSize.gt(0) ? positionQty.div(this._orderSize).toNumber() : 0;

    return {
      fairValueCents,
      probToken,
      midCents: this._ewma,
      tauSec,
      inventoryUnits,
      positionQty,
      availableTokenQty,
      availableBalance,
      hasInFlightFills: snapshot.hasInFlightFills || snapshot.matchedOrders.length > 0,
      minOrderSize: snapshot.constraints?.minOrderSize.value(),
      minOrderValue: snapshot.constraints?.minOrderValue.value(),
      currentPrice,
      targetPrice,
      modelReady: this._modelReady,
    };
  }

  protected decide(data: BPMMData, _reasons: ReadonlySet<TriggerReason>): BPMMAction[] {
    if (data.hasInFlightFills) return [];

    if (!data.modelReady || data.fairValueCents === null || data.probToken === null) {
      return [{ type: 'STOP' }];
    }

    const mid = Math.round(Math.max(1, Math.min(99, data.midCents)));

    if (data.tauSec <= this._unwindSec) {
      if (!data.availableTokenQty.gt(0)) {
        return [{ type: 'STOP' }];
      }

      let askSize = Decimal.min(this._orderSize, data.availableTokenQty);
      if (data.minOrderSize) {
        askSize = this.adjustSellSize(askSize, data.availableTokenQty, data.minOrderSize);
      }

      const ask = Math.max(1, Math.min(99, mid));
      if (!this._passesMinOrderValue(ask, askSize, data.minOrderValue)) {
        return [{ type: 'STOP' }];
      }

      return [{ type: 'UNWIND', ask, askSize }];
    }

    const edge = data.fairValueCents - mid;
    if (Math.abs(edge) < this._minEdgeCents && !data.availableTokenQty.gt(0)) {
      return [{ type: 'STOP' }];
    }

    const spreadBoost = Math.min(
      this._maxSpreadCents - this._baseSpreadCents,
      Math.max(0, Math.round(Math.abs(edge) / 2)),
    );
    const halfSpread = Math.max(
      this._baseSpreadCents,
      Math.min(this._maxSpreadCents, this._baseSpreadCents + spreadBoost),
    );

    const reservation = data.fairValueCents - this._inventorySkew * data.inventoryUnits;
    let bid = Math.floor(reservation - halfSpread);
    let ask = Math.ceil(reservation + halfSpread);
    bid = Math.max(1, Math.min(98, bid));
    ask = Math.max(bid + 1, Math.min(99, ask));

    let bidSize = new Decimal(0);
    let askSize = new Decimal(0);

    if (data.inventoryUnits < this._qMax) {
      const cost = this._orderSize.mul(bid).div(100);
      if (data.availableBalance.gte(cost)) {
        bidSize = data.minOrderSize ? Decimal.max(this._orderSize, data.minOrderSize) : this._orderSize;
        if (!this._passesMinOrderValue(bid, bidSize, data.minOrderValue)) {
          bidSize = new Decimal(0);
        }
      }
    }

    if (data.availableTokenQty.gt(0)) {
      askSize = Decimal.min(this._orderSize, data.availableTokenQty);
      if (data.minOrderSize) {
        askSize = this.adjustSellSize(askSize, data.availableTokenQty, data.minOrderSize);
      }
      if (!this._passesMinOrderValue(ask, askSize, data.minOrderValue)) {
        askSize = new Decimal(0);
      }
    }

    if (Math.abs(edge) < this._minEdgeCents) {
      bidSize = new Decimal(0);
    }

    if (edge <= -this._minEdgeCents) {
      bidSize = new Decimal(0);
    }

    if (edge >= this._minEdgeCents && askSize.gt(0) && data.availableTokenQty.lte(this._orderSize)) {
      askSize = new Decimal(0);
    }

    if (bidSize.lte(0) && askSize.lte(0)) {
      return [{ type: 'STOP' }];
    }

    return [{
      type: 'QUOTE',
      bid,
      ask,
      bidSize,
      askSize,
    }];
  }

  protected toIntents(actions: BPMMAction[]): StrategyIntent[] {
    const intents: StrategyIntent[] = [];

    for (const action of actions) {
      intents.push({ type: 'CANCEL_ALL' });

      if (action.type === 'STOP') {
        continue;
      }

      if (action.type === 'UNWIND') {
        if (action.askSize.gt(0)) {
          intents.push({
            type: 'PLACE',
            side: 'SELL',
            price: Price.of(new Decimal(action.ask).div(100)),
            size: Quantity.of(action.askSize),
          });
        }
        continue;
      }

      if (action.bidSize.gt(0)) {
        intents.push({
          type: 'PLACE',
          side: 'BUY',
          price: Price.of(new Decimal(action.bid).div(100)),
          size: Quantity.of(action.bidSize),
        });
      }

      if (action.askSize.gt(0)) {
        intents.push({
          type: 'PLACE',
          side: 'SELL',
          price: Price.of(new Decimal(action.ask).div(100)),
          size: Quantity.of(action.askSize),
        });
      }
    }

    return intents;
  }

  public getMetrics(): Record<string, unknown> {
    return {
      modelReady: this._modelReady,
      modelLoading: this._modelLoading,
      modelError: this._modelError,
      statsLoaded: this._statsByHorizon.size,
      marketKey: this._currentMarketKey,
    };
  }

  private _resetForNewMarket(snapshot: StrategySnapshot, marketKey: string): void {
    this._currentMarketKey = marketKey;
    this._currentQuestion = snapshot.market.question;
    this._marketEventStartMs = snapshot.eventStartMs ?? 0;
    this._ewma = null;
    this._tradeCount = 0;
    this._lastTradeTimestampMs = 0;
    this._statsByHorizon = new Map();
    this._modelReady = false;
    this._modelLoading = false;
    this._modelError = null;
    this._modelLogSuppressed = false;
    const outcomes = Array.isArray(snapshot.market.outcomes)
      ? snapshot.market.outcomes
      : [];
    const matchedOutcome = outcomes.find(
      (outcome: { token: unknown; name: string; index: number }) =>
        String(outcome.token) === String(snapshot.instrumentId),
    );

    if (matchedOutcome) {
      if (isUpLikeOutcome(matchedOutcome.name)) {
        this._isUpToken = true;
      } else if (isDownLikeOutcome(matchedOutcome.name)) {
        this._isUpToken = false;
      } else {
        this._isUpToken = matchedOutcome.index === 0;
      }
    } else {
      this._isUpToken = true;
    }

    this._logger?.warn('BinanceProbMM: new market', {
      strategyId: this.id,
      question: this._currentQuestion,
      instrumentId: String(snapshot.instrumentId),
      outcomeSide: this._isUpToken ? 'UP' : 'DOWN',
      eventStart: this._marketEventStartMs > 0 ? new Date(this._marketEventStartMs).toISOString() : 'unknown',
      expiry: new Date(snapshot.market.expirationMs).toISOString(),
      marketKey,
    });
  }

  private _startModelBuild(snapshot: StrategySnapshot, marketKey: string): void {
    if (this._modelLoading || this._modelReady) return;

    const eventStartMs = snapshot.eventStartMs;
    const asset = snapshot.cryptoPrice?.asset;
    const symbol = this._binanceSymbolOverride ?? inferBinanceSymbol(asset);

    if (!eventStartMs || !symbol) {
      this._modelError = 'missing eventStartMs or Binance symbol';
      return;
    }

    this._modelLoading = true;
    const lookbackMs = this._lookbackDays * 24 * 60 * 60 * 1000;
    const fromMs = eventStartMs - lookbackMs;
    const toMs = eventStartMs - 1;

    this._logger?.warn('BinanceProbMM: building model', {
      strategyId: this.id,
      question: this._currentQuestion,
      outcomeSide: this._isUpToken ? 'UP' : 'DOWN',
      symbol,
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      eventStart: new Date(eventStartMs).toISOString(),
    });

    void (async () => {
      try {
        const klines = await fetchKlines(this._binanceBaseUrl, symbol, '1m', fromMs, toMs);
        const prices = klines.map(kline => kline.close).filter(price => price > 0);

        if (prices.length < this._minModelSamples) {
          throw new Error(`not enough klines: ${prices.length} < ${this._minModelSamples}`);
        }

        const stats = new Map<number, HorizonStats>();
        for (let step = 1; step <= this._maxHorizonMinutes; step++) {
          const returns = calcLogReturns(prices, step);
          if (returns.length < this._minModelSamples) {
            throw new Error(`not enough returns for horizon ${step}: ${returns.length}`);
          }
          const mu = calcMean(returns);
          const sigma = calcSigma(returns);
          stats.set(step, { mu, sigma });
        }

        if (this._currentMarketKey !== marketKey) {
          return;
        }

        this._statsByHorizon = stats;
        this._modelReady = true;
        this._modelError = null;
        this._logger?.warn('BinanceProbMM: model built', {
          strategyId: this.id,
          question: this._currentQuestion,
          outcomeSide: this._isUpToken ? 'UP' : 'DOWN',
          symbol,
          eventStart: new Date(eventStartMs).toISOString(),
          lookbackDays: this._lookbackDays,
          klines: prices.length,
          horizons: stats.size,
          useDrift: this._useDrift,
        });
      } catch (error) {
        if (this._currentMarketKey !== marketKey) {
          return;
        }
        this._modelError = error instanceof Error ? error.message : String(error);
        this._logger?.error('BinanceProbMM: model build failed', {
          strategyId: this.id,
          question: this._currentQuestion,
          outcomeSide: this._isUpToken ? 'UP' : 'DOWN',
          symbol,
          eventStart: new Date(eventStartMs).toISOString(),
          error: this._modelError,
        });
      } finally {
        if (this._currentMarketKey === marketKey) {
          this._modelLoading = false;
        }
      }
    })();
  }

  private _probabilityCloseAtOrBelowTarget(
    currentPrice: number,
    targetPrice: number,
    mu: number,
    sigma: number,
  ): number {
    const logReturnTarget = Math.log(targetPrice / currentPrice);
    const z = (logReturnTarget - mu) / sigma;
    return normalCdf(z);
  }

  private _passesMinOrderValue(priceCents: number, size: Decimal, minOrderValue: Decimal | undefined): boolean {
    if (!minOrderValue || size.lte(0)) return size.gt(0);
    return size.mul(priceCents).div(100).gte(minOrderValue);
  }
}
