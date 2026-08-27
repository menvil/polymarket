/**
 * CrowdDeviationStrategy — покупка UP-токена когда толпа торгует ниже исторической нормы.
 *
 * @remarks
 * Идея: для каждой пары `(delta, tau)` строим исторический baseline (средневзвешенный `crowdAvg`)
 * из edge-таблицы. Когда текущая цена толпы отклоняется от baseline вниз на ≥ `entryDevCents` центов —
 * это сигнал "толпа паникует" или "неликвидность". При delta ≥ `minDeltaDollars` (BTC выше strike)
 * покупаем UP-токен, так как исторически в этой ситуации UP-токен выигрывает чаще.
 *
 * ### Алгоритм:
 * 1. Загружаем edge-таблицу, строим baseline: `B[deltaStep][tauStep] = Σ(crowdAvg × n) / Σn`.
 * 2. На каждом тике: `deviation = midCents − B[bucketDelta][bucketTau] × 100`.
 * 3. Если `deviation ≤ −entryDevCents` AND `delta ≥ minDeltaDollars` AND `tauSec ≥ minTauSec`
 *    AND фильтры regime/residual проходят → ставим maker-BUY.
 * 4. При получении fill → держим до expiry.
 *
 * ### Почему это работает:
 * Из OOS бэктеста May 1-6 (61 трейд, dev≤-30¢, delta≥+25$):
 * - 65.6% win rate, ср. P&L +22.4¢ на трейд, итог +$136.80 при $10/трейд.
 * - Лучший кластер: delta=+50$ → 100% WR (9 трейдов), +$44.30.
 *
 * @example
 * ```typescript
 * const strategy = new CrowdDeviationStrategy({
 *   tableFile: 'tables/edge-table-5min-full-mar-apr-up.json',
 *   entryDevCents: 30,
 *   minDeltaDollars: 25,
 *   minTauSec: 30,
 *   orderSize: new Decimal(10),
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
 * Параметры CrowdDeviationStrategy.
 *
 * @param tableFile - Путь к JSON edge-таблице (для вычисления baseline)
 * @param entryDevCents - Минимальное отклонение толпы вниз от baseline (центы, default 30)
 * @param minDeltaDollars - Минимальный delta BTC − strike в $ для входа (default 25)
 * @param maxDeltaDollars - Максимальный delta в $ (default 200)
 * @param minTauSec - Минимальный tau до expiry в секундах (default 30)
 * @param maxTauSec - Максимальный tau (default 300)
 * @param regimeFilter - Фильтр режима BTC: 'up'|'flat'|'down'|'all' (default 'all')
 * @param residualFilter - Фильтр CEX residual: 'pos' (cex > chainlink), 'neg', 'all' (default 'all')
 * @param residualMinBps - Минимальный средний residual (CEX − Chainlink) в bps для входа (default 0 = отключён).
 *   Пример: residualMinBps=50 → входим только когда средняя CEX цена выше Chainlink на ≥0.5%.
 *   Измеряет ВЕЛИЧИНУ разрыва, а не просто знак — корректный способ обнаружить опережение CEX.
 * @param minEntryPriceCents - Минимальная цена UP-токена в стакане для входа (центы, default 0 = отключён).
 *   Фильтрует ситуации где толпа голосует против UP (дешёвые токены < порога).
 *   Калибровочный анализ (May 1-13 OOS) показал: WR 30% без фильтра → 57%+ при ≥45¢.
 * @param cexVenues - Источники CEX цен для residual-голосования (default: ['polymarket_binance'])
 * @param cexMinVenueCount - Минимум бирж которые должны согласиться (default: 1)
 * @param orderSize - Размер ордера в токенах
 * @param bidOffsetCents - Скидка от mid для limit BUY (default 1)
 * @param warmupSec - Период прогрева перед торговлей (default 0)
 * @param postOnly - Ставить post-only ордера (default true)
 */
export interface CrowdDeviationConfig {
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
  readonly warmupSec?: number;
  readonly postOnly?: boolean;
  readonly makerRepriceAfterSec?: number;
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
  /** Residual первой доступной биржи (bps), для логирования. */
  readonly cexResidualBps: number | undefined;
  /** Количество бирж с данными. */
  readonly cexVenueTotalCount: number;
  /** Количество бирж выше chainlink (residual > 0). */
  readonly cexVenueAboveCount: number;
  /** Средний residual по всем доступным биржам (bps). Вычисляется всегда когда есть CEX данные. */
  readonly cexAvgResidualBps: number | undefined;
  readonly hasPosition: boolean;
  readonly hasOpenOrder: boolean;
  readonly hasInFlightFill: boolean;
  readonly availableBalance: Decimal;
  readonly nowMs: number;
  readonly openOrderPriceCents: number | null;
  readonly openOrderAgeSec: number | null;
}

type CDAction =
  | { readonly type: 'BUY'; readonly price: number; readonly size: Decimal }
  | { readonly type: 'HOLD' }
  | { readonly type: 'CANCEL' };

/** Baseline: B[deltaStep][tauStep] = взвешенный avg crowdAvg (0-1) */
type BaselineMap = Map<string, number>;

// ── Реализация ────────────────────────────────────────────────────────────────

export class CrowdDeviationStrategy extends BaseStrategy<CDData, CDAction> {
  public readonly id: StrategyId;
  public readonly name = 'CrowdDeviationStrategy';

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
  private readonly _warmupSec: number;
  private readonly _postOnly: boolean;
  private readonly _makerRepriceAfterSec: number;

  private readonly _baseline: BaselineMap;
  private readonly _deltaStep: number;
  private readonly _tauStep: number;

  private readonly _regimeDetector: RegimeDetector;

  /** EWMA mid-price (центы) */
  private _ewma: number | null = null;
  private _tradeCount = 0;
  private _lastTradeTimestampMs = 0;

  private _currentExpirationMs = 0;
  private _marketEventStartMs = 0;
  private _pendingPlace = false;
  private _repricePending = false;
  private _lastDiagMs = 0;
  private _lastRejectReason = '';
  private _strikePrice: number | undefined;
  private _strikeLoggedMs = 0;

  constructor(
    config: CrowdDeviationConfig,
    strategyId: StrategyId = unsafeStrategyId('crowd-deviation-1'),
    logger?: ILogger,
    journal?: IDecisionJournal,
  ) {
    super();
    this.id = strategyId;
    this._logger = logger;
    this._journal = journal;

    this._entryDevCents = config.entryDevCents ?? 30;
    this._minDelta = config.minDeltaDollars ?? 25;
    this._maxDelta = config.maxDeltaDollars ?? 200;
    this._minTau = config.minTauSec ?? 30;
    this._maxTau = config.maxTauSec ?? 300;
    this._regimeFilter = config.regimeFilter ?? 'all';
    this._residualFilter = config.residualFilter ?? 'all';
    this._residualMinBps = config.residualMinBps ?? 0;
    this._minEntryPriceCents = config.minEntryPriceCents ?? 0;
    this._cexVenues = config.cexVenues ?? ['polymarket_binance'];
    this._cexMinVenueCount = config.cexMinVenueCount ?? 1;
    this._orderSize = config.orderSize;
    this._bidOffset = config.bidOffsetCents ?? 1;
    this._warmupSec = config.warmupSec ?? 0;
    this._postOnly = config.postOnly ?? true;
    this._makerRepriceAfterSec = config.makerRepriceAfterSec ?? 5;

    const { baseline, deltaStep, tauStep } = CrowdDeviationStrategy._loadBaseline(config.tableFile);
    this._baseline = baseline;
    this._deltaStep = deltaStep;
    this._tauStep = tauStep;

    this._regimeDetector = new RegimeDetector({ thresholdPerMin: 10, windowMs: 60_000 });

    this._logger?.warn('CrowdDeviation: init', {
      entryDevCents: this._entryDevCents,
      minDelta: this._minDelta,
      maxDelta: this._maxDelta,
      minTau: this._minTau,
      maxTau: this._maxTau,
      regimeFilter: this._regimeFilter,
      residualFilter: this._residualFilter,
      residualMinBps: this._residualMinBps,
      minEntryPriceCents: this._minEntryPriceCents,
      cexVenues: this._cexVenues.join(','),
      cexMinVenueCount: this._cexMinVenueCount,
      orderSize: this._orderSize.toString(),
      bidOffset: this._bidOffset,
      warmupSec: this._warmupSec,
      baselineCells: this._baseline.size,
    });
  }

  /**
   * Загружает edge-таблицу и строит baseline `B[δ][τ] = Σ(crowdAvg×n) / Σn`.
   *
   * @param tableFile - Путь к JSON-файлу таблицы
   * @returns Baseline-карта, шаги бакетирования
   */
  private static _loadBaseline(tableFile: string): {
    baseline: BaselineMap;
    deltaStep: number;
    tauStep: number;
  } {
    const raw = JSON.parse(readFileSync(tableFile, 'utf-8')) as {
      meta: { bucketing: { deltaStep: number; tauStep: number } };
      zones: Array<{
        key: { delta: number; tau: number };
        train: { crowdAvg: number; n: number };
      }>;
    };

    const { deltaStep, tauStep } = raw.meta.bucketing;
    const accumulator = new Map<string, { sumWN: number; sumN: number }>();

    for (const zone of raw.zones) {
      const k = `${zone.key.delta}:${zone.key.tau}`;
      const acc = accumulator.get(k) ?? { sumWN: 0, sumN: 0 };
      acc.sumWN += zone.train.crowdAvg * zone.train.n;
      acc.sumN += zone.train.n;
      accumulator.set(k, acc);
    }

    const baseline: BaselineMap = new Map();
    for (const [k, acc] of accumulator) {
      if (acc.sumN > 0) baseline.set(k, acc.sumWN / acc.sumN);
    }

    return { baseline, deltaStep, tauStep };
  }

  /**
   * Возвращает baseline (0-1) для заданных delta и tau в секундах.
   *
   * @param deltaDollars - Delta BTC-strike в долларах (сырое значение)
   * @param tauSec - Время до expiry в секундах
   * @returns Baseline цена (0-1) или undefined если нет данных
   */
  private _getBaseline(deltaDollars: number, tauSec: number): number | undefined {
    const deltaKey = Math.floor(deltaDollars / this._deltaStep) * this._deltaStep;
    const tauKey = Math.floor(tauSec / this._tauStep) * this._tauStep;
    return this._baseline.get(`${deltaKey}:${tauKey}`);
  }

  // ── gather ──────────────────────────────────────────────────────────────────

  protected gather(snapshot: StrategySnapshot): CDData | undefined {
    const expiresMs = snapshot.market.expirationMs;

    // Смена рынка → сброс
    if (this._currentExpirationMs !== expiresMs) {
      this._currentExpirationMs = expiresMs;
      this._ewma = null;
      this._tradeCount = 0;
      this._lastTradeTimestampMs = 0;
      this._pendingPlace = false;
      this._repricePending = false;
      this._lastDiagMs = 0;
      this._strikePrice = undefined;
      this._strikeLoggedMs = 0;

      if (snapshot.eventStartMs !== undefined) {
        this._marketEventStartMs = snapshot.eventStartMs.toNumber();
        this._logger?.warn('CrowdDeviation: new market', {
          expiresMs,
          eventStartMs: this._marketEventStartMs,
          instrumentId: snapshot.instrumentId,
        });
      } else {
        this._logger?.warn('CrowdDeviation: no eventStartMs, skipping');
        return undefined;
      }
    }

    if (this._marketEventStartMs <= 0) return undefined;

    // Warmup
    const warmupElapsed = snapshot.nowMs - this._marketEventStartMs;
    if (warmupElapsed < this._warmupSec * 1000) return undefined;

    // EWMA из trade tape
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

    // Fallback на topOfBook если нет trades
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

    const tauSec = Math.max(0, (expiresMs - snapshot.nowMs) / 1000);
    const midCents = this._ewma;

    // Spread из book
    let spreadCents = 99;
    let bestBidCents: number | null = null;
    let bestAskCents: number | null = null;
    if (snapshot.topOfBook) {
      const bid = snapshot.topOfBook.bestBid?.value().toNumber();
      const ask = snapshot.topOfBook.bestAsk?.value().toNumber();
      if (bid !== undefined && ask !== undefined) {
        spreadCents = (ask - bid) * 100;
        bestBidCents = bid * 100;
        bestAskCents = ask * 100;
      }
    }
    const tickSizeCents = (snapshot.constraints?.tickSize.value().toNumber() ?? 0.01) * 100;

    // Delta = chainlink - strike
    let deltaDollars: number | undefined;
    if (snapshot.cryptoPrice) {
      const cur = snapshot.cryptoPrice.currentPrice;
      const target = snapshot.cryptoPrice.targetPrice;
      if (cur > 0 && target && target > 0) {
        deltaDollars = cur - target;

        // Логируем страйк один раз в начале рынка и ещё раз через 10s (когда chainlink стабилизировался)
        if (this._strikePrice === undefined) {
          this._strikePrice = target;
          this._logger?.warn('CrowdDeviation: strike locked', {
            strike: target.toFixed(2),
            chainlink: cur.toFixed(2),
            delta: deltaDollars.toFixed(2),
          });
        } else if (
          snapshot.nowMs - this._marketEventStartMs > 10_000 &&
          snapshot.nowMs - this._strikeLoggedMs > 60_000
        ) {
          this._strikeLoggedMs = snapshot.nowMs;
          this._logger?.info('CrowdDeviation: strike confirm', {
            strike: this._strikePrice.toFixed(2),
            chainlink: cur.toFixed(2),
            delta: deltaDollars.toFixed(2),
            tau: tauSec.toFixed(0),
          });
        }
      }
    }

    // Режим BTC
    const regimeResult = this._regimeDetector.classify(snapshot.cryptoPriceHistory, snapshot.nowMs);
    const regime = regimeResult?.regime;

    // CEX residual: (CEX − Chainlink) / Chainlink × 10000 bps. Вычисляется всегда.
    let cexResidualBps: number | undefined;
    let cexAvgResidualBps: number | undefined;
    let cexVenueAboveCount = 0;
    let cexVenueTotalCount = 0;
    if (snapshot.cryptoPriceHistory) {
      const clPoints = snapshot.cryptoPriceHistory.getRecent('polymarket_chainlink', 5_000, snapshot.nowMs);
      const clPrice = clPoints.length > 0 ? clPoints[clPoints.length - 1]!.price : undefined;
      if (clPrice !== undefined && clPrice > 0) {
        let sumResidual = 0;
        for (const venue of this._cexVenues) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const vPoints = snapshot.cryptoPriceHistory.getRecent(venue as any, 5_000, snapshot.nowMs);
          const vPrice = vPoints.length > 0 ? vPoints[vPoints.length - 1]!.price : undefined;
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

    // Deviation от baseline
    let deviation: number | undefined;
    let baseline: number | undefined;
    if (deltaDollars !== undefined) {
      baseline = this._getBaseline(deltaDollars, tauSec);
      if (baseline !== undefined) {
        deviation = midCents - baseline * 100;
      }
    }

    // Позиция и ордера
    const primaryPos = snapshot.portfolio?.getPosition(snapshot.instrumentId);
    const primaryQty = primaryPos?.quantity.value() ?? new Decimal(0);
    const availableBalance = snapshot.portfolio?.balance.available().value() ?? new Decimal(0);
    const openOrder = snapshot.openOrders[0];
    const openOrderPriceCents = openOrder ? openOrder.price.value().toNumber() * 100 : null;
    const openOrderAgeSec = openOrder
      ? Math.max(0, (snapshot.nowMs - openOrder.timestamp.toNumber()) / 1000)
      : null;

    return {
      instrumentId: String(snapshot.instrumentId),
      midCents,
      bestBidCents,
      bestAskCents,
      spreadCents,
      tickSizeCents,
      deltaDollars,
      tauSec,
      regime,
      deviation,
      baseline,
      cexResidualBps,
      cexAvgResidualBps,
      cexVenueAboveCount,
      cexVenueTotalCount,
      hasPosition: primaryQty.gt(0),
      hasOpenOrder: snapshot.openOrders.length > 0,
      hasInFlightFill: snapshot.hasInFlightFills || snapshot.matchedOrders.length > 0,
      availableBalance,
      nowMs: snapshot.nowMs,
      openOrderPriceCents,
      openOrderAgeSec,
    };
  }

  // ── decide ──────────────────────────────────────────────────────────────────

  protected decide(data: CDData, _reasons: ReadonlySet<TriggerReason>): CDAction[] {
    if (data.hasInFlightFill) return [{ type: 'HOLD' }];

    if (data.hasOpenOrder || data.hasPosition) this._pendingPlace = false;
    if (!data.hasOpenOrder) this._repricePending = false;

    // Есть ордер → проверяем, нужно ли cancel или reprice
    if (data.hasOpenOrder) return this._evaluateOpenOrder(data);

    // Есть позиция → держим до expiry
    if (data.hasPosition) return [{ type: 'HOLD' }];

    // Guard double-entry
    if (this._pendingPlace) return [{ type: 'HOLD' }];

    // ── Проверяем условия входа ──
    const rejectReason = this._checkEntryConditions(data);
    this._logDiag(data, rejectReason);

    if (rejectReason) {
      // Логируем первый rejected tick с полным состоянием для диагностики
      if (this._lastRejectReason !== rejectReason) {
        this._lastRejectReason = rejectReason;
        this._journal?.recordDecision({
          marketId: data.instrumentId,
          strategyId: this.id,
          ts: data.nowMs,
          action: 'SKIP',
          rejectReason,
          state: this._buildDecisionState(data),
        });
      }
      return [{ type: 'HOLD' }];
    }
    this._lastRejectReason = '';

    // Balance check
    const bidPrice = this._computeBidPrice(data);
    if (bidPrice === null) return [{ type: 'HOLD' }];

    const cost = this._orderSize.mul(bidPrice).div(100);
    if (data.availableBalance.lt(cost)) return [{ type: 'HOLD' }];

    // ── ENTRY ──
    this._pendingPlace = true;
    this._logger?.warn('CrowdDeviation: BUY', {
      mid: data.midCents.toFixed(1),
      baseline: (data.baseline! * 100).toFixed(1),
      deviation: data.deviation!.toFixed(1),
      strike: this._strikePrice?.toFixed(2) ?? 'n/a',
      chainlink: data.deltaDollars !== undefined && this._strikePrice !== undefined
        ? (this._strikePrice + data.deltaDollars).toFixed(2)
        : 'n/a',
      delta: data.deltaDollars!.toFixed(0),
      tau: data.tauSec.toFixed(0),
      regime: data.regime ?? 'unknown',
      residual: data.cexAvgResidualBps?.toFixed(1) ?? 'n/a',
      cexVotes: `${data.cexVenueAboveCount}/${data.cexVenueTotalCount}`,
      bidPrice,
    });

    this._journal?.recordDecision({
      marketId: data.instrumentId,
      strategyId: this.id,
      ts: data.nowMs,
      action: 'BUY',
      bidPrice,
      orderSize: this._orderSize.toString(),
      effectiveSide: 'up',
      state: this._buildDecisionState(data),
    });

    return [{ type: 'BUY', price: bidPrice, size: this._orderSize }];
  }

  /**
   * Проверяет все условия входа.
   *
   * @param data - Данные тика
   * @returns Причина отказа или пустая строка если всё ОК
   */
  private _checkEntryConditions(data: CDData): string {
    if (data.deltaDollars === undefined) return 'no_delta';
    if (data.deviation === undefined || data.baseline === undefined) return 'no_baseline';

    if (data.deltaDollars < this._minDelta) {
      return `delta_low(${data.deltaDollars.toFixed(0)}<${this._minDelta})`;
    }
    if (data.deltaDollars > this._maxDelta) {
      return `delta_high(${data.deltaDollars.toFixed(0)}>${this._maxDelta})`;
    }
    if (data.tauSec < this._minTau) {
      return `tau_low(${data.tauSec.toFixed(0)}<${this._minTau})`;
    }
    if (data.tauSec > this._maxTau) {
      return `tau_high(${data.tauSec.toFixed(0)}>${this._maxTau})`;
    }
    if (data.deviation > -this._entryDevCents) {
      return `dev_low(${data.deviation.toFixed(1)}>-${this._entryDevCents})`;
    }
    if (this._regimeFilter !== 'all') {
      if (data.regime === undefined) return 'no_regime';
      if (data.regime !== this._regimeFilter) {
        return `regime(${data.regime}!=${this._regimeFilter})`;
      }
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
      if (data.cexAvgResidualBps < this._residualMinBps) {
        return `residual_bps(${data.cexAvgResidualBps.toFixed(1)}<${this._residualMinBps})`;
      }
    }
    if (this._minEntryPriceCents > 0) {
      if (data.midCents < this._minEntryPriceCents) {
        return `price_low(${data.midCents.toFixed(1)}<${this._minEntryPriceCents})`;
      }
    }

    return '';
  }

  /**
   * Собирает снимок состояния для записи в журнал.
   *
   * @param data - Данные тика
   * @returns Объект с диагностическими полями
   */
  private _buildDecisionState(data: CDData): Record<string, unknown> {
    return {
      tau: data.tauSec,
      delta: data.deltaDollars,
      strike: this._strikePrice,
      chainlink: data.deltaDollars !== undefined && this._strikePrice !== undefined
        ? this._strikePrice + data.deltaDollars
        : undefined,
      mid: data.midCents,
      baseline: data.baseline !== undefined ? data.baseline * 100 : undefined,
      deviation: data.deviation,
      regime: data.regime,
      cexVotes: `${data.cexVenueAboveCount}/${data.cexVenueTotalCount}`,
      spread: data.spreadCents,
      bestBid: data.bestBidCents,
      bestAsk: data.bestAskCents,
    };
  }

  /**
   * Переоценивает открытый ордер, возвращает CANCEL если условия ухудшились или нужен reprice.
   */
  private _evaluateOpenOrder(data: CDData): CDAction[] {
    // Cancel если tau вышел за нижнюю границу
    if (data.tauSec < this._minTau) {
      this._logger?.warn('CrowdDeviation: CANCEL — tau exit', { tau: data.tauSec.toFixed(0) });
      return [{ type: 'CANCEL' }];
    }

    // Cancel если delta вышла за диапазон
    if (data.deltaDollars !== undefined) {
      if (data.deltaDollars < this._minDelta || data.deltaDollars > this._maxDelta) {
        this._logger?.warn('CrowdDeviation: CANCEL — delta exit', { delta: data.deltaDollars.toFixed(0) });
        return [{ type: 'CANCEL' }];
      }
    }

    // Reprice если ордер устарел и можно улучшить цену
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
        this._logger?.warn('CrowdDeviation: CANCEL — reprice', {
          current: data.openOrderPriceCents,
          target: targetBid,
          age: data.openOrderAgeSec.toFixed(1),
        });
        return [{ type: 'CANCEL' }];
      }
    }

    return [{ type: 'HOLD' }];
  }

  /**
   * Вычисляет цену bid для maker-ордера.
   *
   * @param data - Данные тика
   * @returns Цена в центах или null если нет данных
   */
  private _computeBidPrice(data: CDData): number | null {
    const tick = Math.max(1, Math.round(data.tickSizeCents));

    if (data.bestBidCents === null || data.bestAskCents === null) {
      return Math.max(1, Math.round(Math.max(2, Math.min(98, data.midCents))) - this._bidOffset);
    }

    const spread = data.bestAskCents - data.bestBidCents;
    if (spread <= tick) return Math.max(1, data.bestBidCents);

    const improvedBid = data.bestBidCents + tick;
    const makerSafeBid = data.bestAskCents - tick;
    return Math.max(1, Math.min(improvedBid, makerSafeBid));
  }

  /**
   * Диагностический лог каждые 10 секунд.
   */
  private _logDiag(data: CDData, rejectReason: string): void {
    if (data.nowMs - this._lastDiagMs < 10_000) return;
    this._lastDiagMs = data.nowMs;
    this._logger?.info('CrowdDeviation: tick', {
      mid: data.midCents.toFixed(1),
      baseline: data.baseline !== undefined ? (data.baseline * 100).toFixed(1) : 'n/a',
      dev: data.deviation?.toFixed(1) ?? 'n/a',
      delta: data.deltaDollars?.toFixed(0) ?? '?',
      tau: data.tauSec.toFixed(0),
      regime: data.regime ?? 'unknown',
      residual: data.cexAvgResidualBps?.toFixed(1) ?? 'n/a',
      spread: data.spreadCents.toFixed(1),
      reject: rejectReason || 'PASS',
    });
  }

  // ── toIntents ───────────────────────────────────────────────────────────────

  protected toIntents(actions: CDAction[]): StrategyIntent[] {
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
        price: OutcomePrice.of(new Decimal(action.price).div(100)),
        size: Quantity.of(action.size),
        postOnly: this._postOnly,
      });
    }
    return intents;
  }
}
