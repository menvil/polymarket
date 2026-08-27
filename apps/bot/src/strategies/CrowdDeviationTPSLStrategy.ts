/**
 * CrowdDeviationTPSLStrategy — CrowdDeviation с ранним выходом по TP/SL.
 *
 * @remarks
 * Идентична CrowdDeviationStrategy в части входа. Ключевое отличие:
 * после фила вместо hold-to-expiry отслеживает mid-price и закрывает
 * позицию если цена достигла TP или SL.
 *
 * ### Параметры TP/SL:
 * - `takeProfitCents` — закрыть в плюс если mid вырос на ≥TP от entry (центы, 0=выключено)
 * - `stopLossCents`   — закрыть в минус если mid упал  на ≥SL от entry (центы, 0=выключено)
 *
 * ### Выход по SL/TP — simulated FOK:
 * Ставим SELL-taker по `bestBid`. Если через 2с не заполнен → отменяем и перевыставляем
 * по актуальной цене. Повторяем до заполнения или истечения рынка.
 *
 * ### First-touch analysis (May 7-13, dev≥15¢, price≥45¢, regime=up):
 * | TP¢ | SL¢ | P(TP first) | EV/trade $5 |
 * |-----|-----|-------------|-------------|
 * |  20 |  15 |     66%     |  +$0.40     |
 * |  25 |   5 |     46%     |  +$0.43     |
 * |  20 |  10 |     57%     |  +$0.35     |
 *
 * @example
 * ```typescript
 * const strategy = new CrowdDeviationTPSLStrategy({
 *   tableFile: 'tables/edge-table-5min-apr-d10-t15-up.json',
 *   entryDevCents: 15,
 *   minEntryPriceCents: 45,
 *   takeProfitCents: 20,
 *   stopLossCents: 15,
 *   orderSize: new Decimal(5),
 * });
 * ```
 */
import { readFileSync } from 'fs';
import { BaseStrategy } from '@polymarket/strategy';
import type { StrategySnapshot, StrategyIntent, TriggerReason } from '@polymarket/strategy';
import { OutcomePrice, Quantity } from '@polymarket/value-objects';
import type { ILogger } from '@polymarket/logger';
import type { IDecisionJournal } from '@polymarket/ports';
import type { StrategyId } from '@polymarket/ids';
import { unsafeStrategyId } from '@polymarket/ids';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- внутренний Decimal-конвент apps/bot/strategies/*, см. docs/architecture/boundary-contract.md, Решение 11
import Decimal from 'decimal.js';
import { RegimeDetector } from './calibrated-crowd/RegimeDetector.js';
import type { Regime } from './calibrated-crowd/EdgeTable.js';

// ── Конфигурация ──────────────────────────────────────────────────────────────

/**
 * Параметры CrowdDeviationTPSLStrategy.
 * Все параметры входа идентичны CrowdDeviationConfig.
 *
 * @param takeProfitCents - Закрыть в плюс если mid ≥ entryPrice + TP (0 = отключён)
 * @param stopLossCents   - Закрыть в минус если mid ≤ entryPrice − SL (0 = отключён)
 * @param sellOffsetCents - Отступ от ask при выставлении SELL (default 1)
 */
export interface CrowdDeviationTPSLConfig {
  readonly tableFile: string;
  readonly entryDevCents?: number;
  readonly minDeltaDollars?: number;
  readonly maxDeltaDollars?: number;
  readonly minTauSec?: number;
  readonly maxTauSec?: number;
  readonly regimeFilter?: 'up' | 'flat' | 'down' | 'all';
  readonly residualFilter?: 'pos' | 'neg' | 'all';
  readonly residualMinBps?: number;
  readonly minEntryPriceCents?: number;
  readonly cexVenues?: readonly string[];
  readonly cexMinVenueCount?: number;
  readonly orderSize: Decimal;
  readonly bidOffsetCents?: number;
  readonly sellOffsetCents?: number;
  readonly warmupSec?: number;
  readonly postOnly?: boolean;
  readonly makerRepriceAfterSec?: number;
  readonly takeProfitCents?: number;
  readonly stopLossCents?: number;
}

// ── Внутренние типы ───────────────────────────────────────────────────────────

interface CDData {
  readonly instrumentId: string;
  readonly midCents: number;
  readonly bestBidCents: number | null;
  readonly bestAskCents: number | null;
  readonly spreadCents: number;
  readonly tickSizeCents: number;
  readonly deltaDollars: number | undefined;
  readonly tauSec: number;
  readonly regime: Regime | undefined;
  readonly deviation: number | undefined;
  readonly baseline: number | undefined;
  readonly cexResidualBps: number | undefined;
  readonly cexVenueTotalCount: number;
  readonly cexVenueAboveCount: number;
  readonly cexAvgResidualBps: number | undefined;
  readonly hasPosition: boolean;
  readonly hasOpenOrder: boolean;
  readonly hasInFlightFill: boolean;
  readonly availableBalance: Decimal;
  /** Токены доступные для SELL (с учётом fee deduction при BUY). Используется для размера SELL. */
  readonly availableTokenQty: Decimal;
  readonly nowMs: number;
  readonly openOrderPriceCents: number | null;
  readonly openOrderAgeSec: number | null;
}

type CDAction =
  | { readonly type: 'BUY';   readonly price: number; readonly size: Decimal }
  | { readonly type: 'SELL';  readonly price: number; readonly size: Decimal }
  | { readonly type: 'HOLD' }
  | { readonly type: 'CANCEL' };

type BaselineMap = Map<string, number>;

// ── Реализация ────────────────────────────────────────────────────────────────

export class CrowdDeviationTPSLStrategy extends BaseStrategy<CDData, CDAction> {
  public readonly id: StrategyId;
  public readonly name = 'CrowdDeviationTPSLStrategy';

  private readonly _logger: ILogger | undefined;
  private readonly _journal: IDecisionJournal | undefined;

  private readonly _entryDevCents: number;
  private readonly _minDelta: number;
  private readonly _maxDelta: number;
  private readonly _minTau: number;
  private readonly _maxTau: number;
  private readonly _regimeFilter: 'up' | 'flat' | 'down' | 'all';
  private readonly _residualFilter: 'pos' | 'neg' | 'all';
  private readonly _residualMinBps: number;
  private readonly _minEntryPriceCents: number;
  private readonly _cexVenues: readonly string[];
  private readonly _cexMinVenueCount: number;
  private readonly _orderSize: Decimal;
  private readonly _bidOffset: number;
  // _sellOffset unused: SL/TP SELL always places at price=1 (market-like taker fill)
  private readonly _warmupSec: number;
  private readonly _postOnly: boolean;
  private readonly _makerRepriceAfterSec: number;
  private readonly _takeProfitCents: number;
  private readonly _stopLossCents: number;

  private readonly _baseline: BaselineMap;
  private readonly _deltaStep: number;
  private readonly _tauStep: number;
  private readonly _regimeDetector: RegimeDetector;

  /**
   * После rejection биржи ждём минимум столько мс перед повторной отправкой SELL,
   * чтобы ордер успел появиться в openOrders (иначе пошлём дубль).
   */
  private static readonly _SELL_CONFIRM_GRACE_MS = 3_000;

  /**
   * FOK-style exit: если SELL-ордер открыт дольше этого времени и не заполнен —
   * отменяем и выставляем снова по актуальному bid. Simulated Fill-or-Kill.
   * Taker SELL должен заполняться за 1 snapshot (~200ms), поэтому порог минимальный.
   */
  private static readonly _EXIT_ORDER_MAX_AGE_SEC = 0.5;

  private _ewma: number | null = null;
  private _tradeCount = 0;
  private _lastTradeTimestampMs = 0;
  private _currentExpirationMs = 0;
  private _marketEventStartMs = 0;
  private _pendingPlace = false;
  private _pendingSell = false;
  /** Метка времени последней эмиссии SELL intent — для grace period */
  private _pendingSellEmittedTs = 0;
  /** true когда открытый ордер является SELL-выходом (не трогаем cancel/reprice) */
  private _isExitOrder = false;
  private _repricePending = false;
  private _lastDiagMs = 0;
  private _lastRejectReason = '';
  private _strikePrice: number | undefined;
  private _strikeLoggedMs = 0;
  /** Цена входа (центы) — запоминается при BUY, сбрасывается при смене рынка */
  private _entryPriceCents: number | null = null;

  constructor(
    config: CrowdDeviationTPSLConfig,
    strategyId: StrategyId = unsafeStrategyId('crowd-deviation-tpsl-1'),
    logger?: ILogger,
    journal?: IDecisionJournal,
  ) {
    super();
    this.id = strategyId;
    this._logger = logger;
    this._journal = journal;

    this._entryDevCents   = config.entryDevCents   ?? 30;
    this._minDelta        = config.minDeltaDollars  ?? 25;
    this._maxDelta        = config.maxDeltaDollars  ?? 200;
    this._minTau          = config.minTauSec        ?? 30;
    this._maxTau          = config.maxTauSec        ?? 300;
    this._regimeFilter    = config.regimeFilter     ?? 'all';
    this._residualFilter  = config.residualFilter   ?? 'all';
    this._residualMinBps  = config.residualMinBps   ?? 0;
    this._minEntryPriceCents = config.minEntryPriceCents ?? 0;
    this._cexVenues       = config.cexVenues        ?? ['polymarket_binance'];
    this._cexMinVenueCount = config.cexMinVenueCount ?? 1;
    this._orderSize       = config.orderSize;
    this._bidOffset       = config.bidOffsetCents   ?? 1;
    this._warmupSec       = config.warmupSec        ?? 0;
    this._postOnly        = config.postOnly         ?? true;
    this._makerRepriceAfterSec = config.makerRepriceAfterSec ?? 5;
    this._takeProfitCents = config.takeProfitCents  ?? 0;
    this._stopLossCents   = config.stopLossCents    ?? 0;

    const { baseline, deltaStep, tauStep } = CrowdDeviationTPSLStrategy._loadBaseline(config.tableFile);
    this._baseline  = baseline;
    this._deltaStep = deltaStep;
    this._tauStep   = tauStep;

    this._regimeDetector = new RegimeDetector({ thresholdPerMin: 10, windowMs: 60_000 });

    this._logger?.warn('CrowdDeviationTPSL: init', {
      entryDevCents: this._entryDevCents,
      minEntryPriceCents: this._minEntryPriceCents,
      takeProfitCents: this._takeProfitCents,
      stopLossCents: this._stopLossCents,
      regimeFilter: this._regimeFilter,
      residualFilter: this._residualFilter,
    });
  }

  private static _loadBaseline(tableFile: string): {
    baseline: BaselineMap; deltaStep: number; tauStep: number;
  } {
    const raw = JSON.parse(readFileSync(tableFile, 'utf-8')) as {
      meta: { bucketing: { deltaStep: number; tauStep: number } };
      zones: Array<{ key: { delta: number; tau: number }; train: { crowdAvg: number; n: number } }>;
    };
    const { deltaStep, tauStep } = raw.meta.bucketing;
    const acc = new Map<string, { sumWN: number; sumN: number }>();
    for (const zone of raw.zones) {
      const k = `${zone.key.delta}:${zone.key.tau}`;
      const a = acc.get(k) ?? { sumWN: 0, sumN: 0 };
      a.sumWN += zone.train.crowdAvg * zone.train.n;
      a.sumN  += zone.train.n;
      acc.set(k, a);
    }
    const baseline: BaselineMap = new Map();
    for (const [k, a] of acc) {
      if (a.sumN > 0) baseline.set(k, a.sumWN / a.sumN);
    }
    return { baseline, deltaStep, tauStep };
  }

  private _getBaseline(deltaDollars: number, tauSec: number): number | undefined {
    const dk = Math.floor(deltaDollars / this._deltaStep) * this._deltaStep;
    const tk = Math.floor(tauSec      / this._tauStep)   * this._tauStep;
    return this._baseline.get(`${dk}:${tk}`);
  }

  // ── gather ──────────────────────────────────────────────────────────────────

  protected gather(snapshot: StrategySnapshot): CDData | undefined {
    const expiresMs = snapshot.market.expirationMs;

    if (this._currentExpirationMs !== expiresMs) {
      this._currentExpirationMs  = expiresMs;
      this._ewma                 = null;
      this._tradeCount           = 0;
      this._lastTradeTimestampMs = 0;
      this._pendingPlace         = false;
      this._pendingSell          = false;
      this._pendingSellEmittedTs = 0;
      this._isExitOrder          = false;
      this._repricePending       = false;
      this._lastDiagMs           = 0;
      this._strikePrice          = undefined;
      this._strikeLoggedMs       = 0;
      this._entryPriceCents      = null;

      if (snapshot.eventStartMs !== undefined) {
        this._marketEventStartMs = snapshot.eventStartMs.toNumber();
        this._logger?.warn('CrowdDeviationTPSL: new market', {
          expiresMs, instrumentId: snapshot.instrumentId,
        });
      } else {
        this._logger?.warn('CrowdDeviationTPSL: no eventStartMs, skipping');
        return undefined;
      }
    }

    if (this._marketEventStartMs <= 0) return undefined;

    const warmupElapsed = snapshot.nowMs - this._marketEventStartMs;
    if (warmupElapsed < this._warmupSec * 1000) return undefined;

    const tapeRecords = snapshot.tradeTape?.getAll();
    if (tapeRecords && tapeRecords.length > 0) {
      for (const trade of tapeRecords) {
        const tradeTs = trade.timestamp.toNumber();
        if (tradeTs <= this._lastTradeTimestampMs) continue;
        const priceNum = trade.price.value().toNumber() * 100;
        this._ewma = this._ewma === null ? priceNum : 0.3 * priceNum + 0.7 * this._ewma;
        this._tradeCount++;
        this._lastTradeTimestampMs = tradeTs;
      }
    }

    if (this._tradeCount < 3 && snapshot.topOfBook) {
      const bid = snapshot.topOfBook.bestBid?.value().toNumber();
      const ask = snapshot.topOfBook.bestAsk?.value().toNumber();
      if (bid !== undefined && ask !== undefined) {
        const bookMid = ((bid + ask) / 2) * 100;
        this._ewma = this._ewma === null ? bookMid : 0.5 * bookMid + 0.5 * this._ewma;
        this._tradeCount++;
      }
    }

    if (this._ewma === null || this._tradeCount < 3) return undefined;

    const tauSec   = Math.max(0, (expiresMs - snapshot.nowMs) / 1000);
    const midCents = this._ewma;

    let spreadCents = 99;
    let bestBidCents: number | null = null;
    let bestAskCents: number | null = null;
    if (snapshot.topOfBook) {
      const bid = snapshot.topOfBook.bestBid?.value().toNumber();
      const ask = snapshot.topOfBook.bestAsk?.value().toNumber();
      if (bid !== undefined && ask !== undefined) {
        spreadCents   = (ask - bid) * 100;
        bestBidCents  = bid * 100;
        bestAskCents  = ask * 100;
      }
    }
    const tickSizeCents = (snapshot.constraints?.tickSize.value().toNumber() ?? 0.01) * 100;

    let deltaDollars: number | undefined;
    if (snapshot.cryptoPrice) {
      const cur    = snapshot.cryptoPrice.currentPrice;
      const target = snapshot.cryptoPrice.targetPrice;
      if (cur > 0 && target && target > 0) {
        deltaDollars = cur - target;
        if (this._strikePrice === undefined) {
          this._strikePrice = target;
          this._logger?.warn('CrowdDeviationTPSL: strike locked', {
            strike: target.toFixed(2), delta: deltaDollars.toFixed(2),
          });
        } else if (
          snapshot.nowMs - this._marketEventStartMs > 10_000 &&
          snapshot.nowMs - this._strikeLoggedMs > 60_000
        ) {
          this._strikeLoggedMs = snapshot.nowMs;
          this._logger?.info('CrowdDeviationTPSL: strike confirm', {
            strike: this._strikePrice.toFixed(2), delta: deltaDollars.toFixed(2), tau: tauSec.toFixed(0),
          });
        }
      }
    }

    const regimeResult = this._regimeDetector.classify(snapshot.cryptoPriceHistory, snapshot.nowMs);
    const regime = regimeResult?.regime;

    let cexResidualBps: number | undefined;
    let cexAvgResidualBps: number | undefined;
    let cexVenueAboveCount = 0;
    let cexVenueTotalCount = 0;
    if (snapshot.cryptoPriceHistory) {
      const clPoints = snapshot.cryptoPriceHistory.getRecent('polymarket_chainlink', 5_000, snapshot.nowMs);
      const clPrice  = clPoints.length > 0 ? clPoints[clPoints.length - 1]!.price : undefined;
      if (clPrice !== undefined && clPrice > 0) {
        let sumResidual = 0;
        for (const venue of this._cexVenues) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const vPoints = snapshot.cryptoPriceHistory.getRecent(venue as any, 5_000, snapshot.nowMs);
          const vPrice  = vPoints.length > 0 ? vPoints[vPoints.length - 1]!.price : undefined;
          if (vPrice !== undefined) {
            const residual = ((vPrice - clPrice) / clPrice) * 10_000;
            if (cexResidualBps === undefined) cexResidualBps = residual;
            sumResidual += residual;
            cexVenueTotalCount++;
            if (residual > 0) cexVenueAboveCount++;
          }
        }
        if (cexVenueTotalCount > 0) cexAvgResidualBps = sumResidual / cexVenueTotalCount;
      }
    }

    let deviation: number | undefined;
    let baseline: number | undefined;
    if (deltaDollars !== undefined) {
      baseline  = this._getBaseline(deltaDollars, tauSec);
      if (baseline !== undefined) deviation = midCents - baseline * 100;
    }

    const primaryPos = snapshot.portfolio?.getPosition(snapshot.instrumentId);
    const primaryQty = primaryPos?.quantity.value() ?? new Decimal(0);
    const availableBalance = snapshot.portfolio?.balance.available().value() ?? new Decimal(0);
    const availableTokenQty = snapshot.portfolio?.availableTokenQuantity(snapshot.instrumentId) ?? new Decimal(0);
    const openOrder        = snapshot.openOrders[0];
    const openOrderPriceCents = openOrder ? openOrder.price.value().toNumber() * 100 : null;
    const openOrderAgeSec     = openOrder
      ? Math.max(0, (snapshot.nowMs - openOrder.timestamp.toNumber()) / 1000)
      : null;

    return {
      instrumentId: String(snapshot.instrumentId),
      midCents, bestBidCents, bestAskCents, spreadCents, tickSizeCents,
      deltaDollars, tauSec, regime, deviation, baseline,
      cexResidualBps, cexVenueTotalCount, cexVenueAboveCount, cexAvgResidualBps,
      hasPosition:      primaryQty.gt(0),
      hasOpenOrder:     snapshot.openOrders.length > 0,
      hasInFlightFill:  snapshot.hasInFlightFills || snapshot.matchedOrders.length > 0,
      availableBalance, availableTokenQty, nowMs: snapshot.nowMs,
      openOrderPriceCents, openOrderAgeSec,
    };
  }

  // ── decide ──────────────────────────────────────────────────────────────────

  protected decide(data: CDData, _reasons: ReadonlySet<TriggerReason>): CDAction[] {
    if (data.hasInFlightFill) return [{ type: 'HOLD' }];

    if (data.hasOpenOrder || data.hasPosition) this._pendingPlace = false;
    if (!data.hasOpenOrder) {
      this._repricePending = false;
      // Открытого ордера нет → SELL-ордер либо исполнился, либо был отклонён.
      // Сбрасываем флаг выхода чтобы _evaluateOpenOrder снова применялся к BUY.
      this._isExitOrder = false;
    }

    if (data.hasOpenOrder) {
      if (this._isExitOrder) {
        // FOK-style: ордер не заполнился за один snapshot-цикл → снимаем и ставим заново
        // немедленно в том же тике. toIntents() генерирует [CANCEL_ALL, PLACE] за один вызов.
        // Цена 1¢: CLOB исполнит по лучшему доступному bid (price improvement).
        if (
          data.openOrderAgeSec !== null &&
          data.openOrderAgeSec >= CrowdDeviationTPSLStrategy._EXIT_ORDER_MAX_AGE_SEC
        ) {
          this._pendingSellEmittedTs = data.nowMs;
          this._logger?.warn('CrowdDeviationTPSL: FOK re-place SELL', {
            age: data.openOrderAgeSec.toFixed(2),
            mid: data.midCents.toFixed(1),
            entry: this._entryPriceCents?.toFixed(1),
          });
          this._journal?.recordDecision({
            marketId: data.instrumentId, strategyId: this.id, ts: data.nowMs,
            action: 'SELL', rejectReason: `fok_retry(age=${data.openOrderAgeSec.toFixed(2)}s)`,
            state: this._buildDecisionState(data),
          });
          const fOKSize = data.availableTokenQty.gt(0) ? data.availableTokenQty : this._orderSize;
          return [{ type: 'SELL', price: 1, size: fOKSize }];
        }
        return [{ type: 'HOLD' }];
      }
      return this._evaluateOpenOrder(data);
    }

    // Есть позиция → проверяем TP/SL, иначе держим
    if (data.hasPosition) return this._evaluatePosition(data);

    if (this._pendingPlace) return [{ type: 'HOLD' }];

    const rejectReason = this._checkEntryConditions(data);
    this._logDiag(data, rejectReason);

    if (rejectReason) {
      if (this._lastRejectReason !== rejectReason) {
        this._lastRejectReason = rejectReason;
        this._journal?.recordDecision({
          marketId: data.instrumentId, strategyId: this.id, ts: data.nowMs,
          action: 'SKIP', rejectReason, state: this._buildDecisionState(data),
        });
      }
      return [{ type: 'HOLD' }];
    }
    this._lastRejectReason = '';

    const bidPrice = this._computeBidPrice(data);
    if (bidPrice === null) return [{ type: 'HOLD' }];

    const cost = this._orderSize.mul(bidPrice).div(100);
    if (data.availableBalance.lt(cost)) return [{ type: 'HOLD' }];

    // Запоминаем цену входа для TP/SL
    this._entryPriceCents = data.midCents;
    this._pendingPlace = true;

    this._logger?.warn('CrowdDeviationTPSL: BUY', {
      mid: data.midCents.toFixed(1),
      baseline: (data.baseline! * 100).toFixed(1),
      deviation: data.deviation!.toFixed(1),
      delta: data.deltaDollars!.toFixed(0),
      tau: data.tauSec.toFixed(0),
      regime: data.regime ?? 'unknown',
      tp: this._takeProfitCents || 'off',
      sl: this._stopLossCents || 'off',
      bidPrice,
    });

    this._journal?.recordDecision({
      marketId: data.instrumentId, strategyId: this.id, ts: data.nowMs,
      action: 'BUY', bidPrice, orderSize: this._orderSize.toString(),
      effectiveSide: 'up', state: this._buildDecisionState(data),
    });

    return [{ type: 'BUY', price: bidPrice, size: this._orderSize }];
  }

  /**
   * Проверяет TP/SL для открытой позиции.
   *
   * @remarks
   * ### FOK-style retry (simulated Fill-or-Kill):
   * 1. Эмитируем SELL по актуальному `bestBid` (taker, postOnly=false).
   * 2. Если через `_EXIT_ORDER_MAX_AGE_SEC` (2с) ордер не заполнен →
   *    CANCEL + сброс `_pendingSell` → следующий тик перевыставляет по свежему bid.
   * 3. Повторяем до заполнения или истечения рынка.
   *
   * ### Grace period при rejection биржи:
   * - После эмиссии SELL ждём `_SELL_CONFIRM_GRACE_MS` (3с) пока ордер
   *   появится в openOrders. Если по истечении grace period ордера нет —
   *   сбрасываем `_pendingSell` и повторяем. ExecutionEngine throttle-ит
   *   повторные попытки через `_exchangeRejectionCooldowns` (30s).
   *
   * @param data - Данные тика с позицией
   * @returns SELL или HOLD
   */
  private _evaluatePosition(data: CDData): CDAction[] {
    // Grace period: ждём подтверждения ордера в openOrders
    if (this._pendingSell) {
      const elapsed = data.nowMs - this._pendingSellEmittedTs;
      if (elapsed < CrowdDeviationTPSLStrategy._SELL_CONFIRM_GRACE_MS) {
        return [{ type: 'HOLD' }];
      }
      // Grace period истёк, ордера нет → rejection или иная ошибка → retry
      this._pendingSell = false;
      this._logger?.warn('CrowdDeviationTPSL: SELL unconfirmed — retry', {
        elapsedMs: elapsed.toFixed(0),
        entry: this._entryPriceCents?.toFixed(1),
        mid: data.midCents.toFixed(1),
      });
      this._journal?.recordDecision({
        marketId: data.instrumentId, strategyId: this.id, ts: data.nowMs,
        action: 'SKIP', rejectReason: `sell_retry(unconfirmed,elapsed=${elapsed.toFixed(0)}ms)`,
        state: this._buildDecisionState(data),
      });
    }

    const entry = this._entryPriceCents;
    if (entry === null) return [{ type: 'HOLD' }];

    const mid = data.midCents;

    // Используем availableTokenQty вместо _orderSize: fee deduction при BUY уменьшает
    // реальную позицию (feeInTokens = feeUSDC / price). Если SELL запрашивает больше чем
    // доступно — portfolio.reserveTokensForOrder возвращает Err, ордер не создаётся,
    // sell_retry(unconfirmed) зацикливается до экспирации рынка.
    const sellSize = data.availableTokenQty.gt(0) ? data.availableTokenQty : this._orderSize;

    if (this._takeProfitCents > 0 && mid >= entry + this._takeProfitCents) {
      this._pendingSell = true;
      this._pendingSellEmittedTs = data.nowMs;
      this._isExitOrder = true;
      const sellPrice = this._computeSellPrice(data);
      this._logger?.warn('CrowdDeviationTPSL: SELL — TP hit', {
        entry: entry.toFixed(1), mid: mid.toFixed(1),
        tp: this._takeProfitCents, gain: (mid - entry).toFixed(1),
        sellPrice, sellSize: sellSize.toNumber(),
      });
      this._journal?.recordDecision({
        marketId: data.instrumentId, strategyId: this.id, ts: data.nowMs,
        action: 'SELL', rejectReason: `take_profit(entry=${entry.toFixed(1)},mid=${mid.toFixed(1)},tp=${this._takeProfitCents})`,
        state: this._buildDecisionState(data),
      });
      return [{ type: 'SELL', price: sellPrice, size: sellSize }];
    }

    if (this._stopLossCents > 0 && mid <= entry - this._stopLossCents) {
      this._pendingSell = true;
      this._pendingSellEmittedTs = data.nowMs;
      this._isExitOrder = true;
      const sellPrice = this._computeSellPrice(data);
      this._logger?.warn('CrowdDeviationTPSL: SELL — SL hit', {
        entry: entry.toFixed(1), mid: mid.toFixed(1),
        sl: this._stopLossCents, loss: (entry - mid).toFixed(1),
        sellPrice, sellSize: sellSize.toNumber(),
      });
      this._journal?.recordDecision({
        marketId: data.instrumentId, strategyId: this.id, ts: data.nowMs,
        action: 'SELL', rejectReason: `stop_loss(entry=${entry.toFixed(1)},mid=${mid.toFixed(1)},sl=${this._stopLossCents})`,
        state: this._buildDecisionState(data),
      });
      return [{ type: 'SELL', price: sellPrice, size: sellSize }];
    }

    return [{ type: 'HOLD' }];
  }

  private _checkEntryConditions(data: CDData): string {
    if (data.deltaDollars === undefined) return 'no_delta';
    if (data.deviation === undefined || data.baseline === undefined) return 'no_baseline';
    if (data.deltaDollars < this._minDelta)   return `delta_low(${data.deltaDollars.toFixed(0)}<${this._minDelta})`;
    if (data.deltaDollars > this._maxDelta)   return `delta_high(${data.deltaDollars.toFixed(0)}>${this._maxDelta})`;
    if (data.tauSec < this._minTau)           return `tau_low(${data.tauSec.toFixed(0)}<${this._minTau})`;
    if (data.tauSec > this._maxTau)           return `tau_high(${data.tauSec.toFixed(0)}>${this._maxTau})`;
    if (data.deviation > -this._entryDevCents) return `dev_low(${data.deviation.toFixed(1)}>-${this._entryDevCents})`;
    // Минимальное число активных CEX-бирж — независимо от residualFilter.
    // Без этой проверки cexMinVenueCount игнорировался при residualFilter=all.
    if (this._cexMinVenueCount > 0 && this._cexVenues.length > 0) {
      if (data.cexVenueTotalCount < this._cexMinVenueCount) {
        return `cex_venues_low(${data.cexVenueTotalCount}<${this._cexMinVenueCount})`;
      }
    }
    if (this._regimeFilter !== 'all') {
      if (data.regime === undefined) return 'no_regime';
      if (data.regime !== this._regimeFilter)  return `regime(${data.regime}!=${this._regimeFilter})`;
    }
    if (this._residualFilter !== 'all') {
      if (data.cexVenueTotalCount === 0) return 'no_residual';
      if (this._residualFilter === 'pos' && data.cexVenueAboveCount < this._cexMinVenueCount) {
        return `residual_votes(${data.cexVenueAboveCount}/${data.cexVenueTotalCount}<${this._cexMinVenueCount})`;
      }
      if (this._residualFilter === 'neg' && (data.cexVenueTotalCount - data.cexVenueAboveCount) < this._cexMinVenueCount) {
        return `residual_votes_neg(${data.cexVenueAboveCount}/${data.cexVenueTotalCount})`;
      }
    }
    if (this._residualMinBps > 0) {
      if (data.cexAvgResidualBps === undefined) return 'no_residual_bps';
      if (data.cexAvgResidualBps < this._residualMinBps) return `residual_bps(${data.cexAvgResidualBps.toFixed(1)}<${this._residualMinBps})`;
    }
    if (this._minEntryPriceCents > 0 && data.midCents < this._minEntryPriceCents) {
      return `price_low(${data.midCents.toFixed(1)}<${this._minEntryPriceCents})`;
    }
    return '';
  }

  private _buildDecisionState(data: CDData): Record<string, unknown> {
    return {
      tau: data.tauSec, delta: data.deltaDollars, strike: this._strikePrice,
      mid: data.midCents,
      baseline: data.baseline !== undefined ? data.baseline * 100 : undefined,
      deviation: data.deviation, regime: data.regime,
      cexVotes: `${data.cexVenueAboveCount}/${data.cexVenueTotalCount}`,
      spread: data.spreadCents, bestBid: data.bestBidCents, bestAsk: data.bestAskCents,
      entryPrice: this._entryPriceCents,
    };
  }

  private _evaluateOpenOrder(data: CDData): CDAction[] {
    if (data.tauSec < this._minTau) {
      this._logger?.warn('CrowdDeviationTPSL: CANCEL — tau exit', { tau: data.tauSec.toFixed(0) });
      return [{ type: 'CANCEL' }];
    }
    if (data.deltaDollars !== undefined) {
      if (data.deltaDollars < this._minDelta || data.deltaDollars > this._maxDelta) {
        this._logger?.warn('CrowdDeviationTPSL: CANCEL — delta exit', { delta: data.deltaDollars.toFixed(0) });
        return [{ type: 'CANCEL' }];
      }
    }
    if (
      !this._repricePending &&
      data.openOrderPriceCents !== null &&
      data.openOrderAgeSec !== null &&
      data.openOrderAgeSec >= this._makerRepriceAfterSec
    ) {
      const targetBid = this._computeBidPrice(data);
      const tick = Math.max(1, Math.round(data.tickSizeCents));
      if (targetBid !== null && targetBid >= data.openOrderPriceCents + tick) {
        this._repricePending = true;
        this._logger?.warn('CrowdDeviationTPSL: CANCEL — reprice', {
          current: data.openOrderPriceCents, target: targetBid, age: data.openOrderAgeSec.toFixed(1),
        });
        return [{ type: 'CANCEL' }];
      }
    }
    return [{ type: 'HOLD' }];
  }

  private _computeBidPrice(data: CDData): number | null {
    const tick = Math.max(1, Math.round(data.tickSizeCents));
    if (data.bestBidCents === null || data.bestAskCents === null) {
      return Math.max(1, Math.round(Math.max(2, Math.min(98, data.midCents))) - this._bidOffset);
    }
    const spread = data.bestAskCents - data.bestBidCents;
    if (spread <= tick) return Math.max(1, data.bestBidCents);
    const improvedBid   = data.bestBidCents + tick;
    const makerSafeBid  = data.bestAskCents - tick;
    return Math.max(1, Math.min(improvedBid, makerSafeBid));
  }

  /**
   * Вычисляет цену SELL для выхода по TP/SL.
   *
   * @remarks
   * Возвращает минимальную цену (1¢) — simulated market order.
   * На CLOB Polymarket тейкер-сделка исполняется по цене лучшего bid в книге
   * (price improvement), а не по нашей заявленной цене 1¢.
   * Это гарантирует немедленный taker-fill и максимальную цену из доступных.
   *
   * @returns 1 (минимальная допустимая цена, market-like fill)
   */
  private _computeSellPrice(_data: CDData): number {
    return 1;
  }

  private _logDiag(data: CDData, rejectReason: string): void {
    if (data.nowMs - this._lastDiagMs < 10_000) return;
    this._lastDiagMs = data.nowMs;
    this._logger?.info('CrowdDeviationTPSL: tick', {
      mid: data.midCents.toFixed(1),
      baseline: data.baseline !== undefined ? (data.baseline * 100).toFixed(1) : 'n/a',
      dev: data.deviation?.toFixed(1) ?? 'n/a',
      delta: data.deltaDollars?.toFixed(0) ?? '?',
      tau: data.tauSec.toFixed(0),
      regime: data.regime ?? 'unknown',
      entry: this._entryPriceCents?.toFixed(1) ?? 'none',
      reject: rejectReason || 'PASS',
    });
  }

  // ── toIntents ───────────────────────────────────────────────────────────────

  protected toIntents(actions: CDAction[]): StrategyIntent[] {
    const intents: StrategyIntent[] = [];
    for (const action of actions) {
      if (action.type === 'HOLD') continue;
      if (action.type === 'CANCEL') { intents.push({ type: 'CANCEL_ALL' }); continue; }
      intents.push({ type: 'CANCEL_ALL' });
      if (action.type === 'BUY') {
        intents.push({
          type: 'PLACE', side: 'BUY',
          price: OutcomePrice.of(new Decimal(action.price).div(100)),
          size:  Quantity.of(action.size),
          postOnly: this._postOnly,
        });
      } else if (action.type === 'SELL') {
        intents.push({
          type: 'PLACE', side: 'SELL',
          price: OutcomePrice.of(new Decimal(action.price).div(100)),
          size:  Quantity.of(action.size),
          postOnly: false,
        });
      }
    }
    return intents;
  }
}
