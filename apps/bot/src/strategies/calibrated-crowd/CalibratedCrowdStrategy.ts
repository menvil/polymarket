/**
 * CalibratedCrowdStrategy — торговля по 4D-таблице `(delta, tau, crowd, regime)`.
 *
 * @remarks
 * Идея:
 * 1. На каждом тике считаем `delta=chainlink−strike`, `tau`, `midCents`, `regime`.
 * 2. Ищем зону в `EdgeTable`. Если зона `SKIP` или `composite<minComposite` — ничего.
 * 3. Auto-selection стороны по `zone.signal` + `zone.kelly.side`:
 *    - `BUY` + `UP`  → maker-BUY на primary-инструменте (UP-токене).
 *    - `SELL` + `DOWN` → maker-BUY на complementary-инструменте (DOWN-токене);
 *      требует `snapshot.complementaryInstrumentId` / `complementaryAsset` /
 *      `complementaryTopOfBook`. Интент помечается `targetInstrumentId` / `targetAsset`.
 *    Maker-first: post bid = bestBid+1¢. Taker только в паник-выходе.
 * 4. По умолчанию HOLD-TO-EXPIRY (бэктест показал это лучший policy: +41 vs +1.98).
 *    Опционально можно включить флаги risk-exit:
 *    - `exitOnRegimeFlip`: выход если режим перешёл в противоположный
 *    - `exitOnWeightDrop`: выход если composite упал ниже `weightDropThreshold`
 *    - `exitOnTauTimeout`: принудительный выход при `tau < exitTauSec`
 *    - `exitOnEdgeClosure`: выход если `|edge| < edgeClosureCents`
 *
 * @example
 * ```typescript
 * const strategy = new CalibratedCrowdStrategy({
 *   edgeTablePath: 'tables/edge-table-5min.json',
 *   minComposite: 0.3,
 *   maxPositionFraction: 0.1,  // не более 10% капитала в одной позиции
 *   warmupSec: 15,
 *   // risk-exits — все выключены по умолчанию
 *   exitOnTauTimeout: true,  // опционально
 *   exitTauSec: 15,
 * });
 * ```
 */
import { BaseStrategy } from '@polymarket/strategy';
import { placeTarget } from '@polymarket/strategy';
import type {
  CexVenue,
  CryptoSignalDirection,
  CryptoSignalResult,
  StrategySnapshot,
  StrategyIntent,
} from '@polymarket/strategy';
import { Price, Quantity } from '@polymarket/value-objects';
import type { ILogger } from '@polymarket/logger';
import type { IDecisionJournal } from '@polymarket/ports';
import type { OrderId, InstrumentId, AssetId, StrategyId } from '@polymarket/ids';
import { unsafeStrategyId } from '@polymarket/ids';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- внутренний Decimal-конвент apps/bot/strategies/*, см. docs/architecture/boundary-contract.md, Решение 11
import Decimal from 'decimal.js';
import { calculatePolymarketTakerFeeNumber } from '@polymarket/fill/polymarket-fee';
import { EdgeTable, type EdgeZone, type Regime } from './EdgeTable.js';
import { RegimeDetector } from './RegimeDetector.js';

/**
 * Сторона, на которую стратегия реально размещает ордер.
 *
 * - `UP` — primary инструмент (snapshot.instrumentId), срабатывает при `zone.signal='BUY' & kelly.side='UP'`.
 * - `DOWN` — complementary инструмент, срабатывает при `zone.signal='SELL' & kelly.side='DOWN'`
 *   (недооценён DOWN-токен; покупаем его вместо того чтобы шортить UP).
 */
type EntrySide = 'UP' | 'DOWN';

// ── Конфигурация ──────────────────────────────────────────────────────────────

/**
 * Параметры стратегии.
 */
export interface CalibratedCrowdConfig {
  /** Путь к JSON-таблице (результат `scripts/build-edge-table.ts`). */
  readonly edgeTablePath: string;

  /** Как интерпретировать таблицу: strict = только signal BUY, relaxed = по raw edge. */
  readonly crowdGate?: 'strict' | 'relaxed';

  /** Relaxed: минимальный n независимых samples/markets в зоне (default 20). */
  readonly relaxedMinN?: number;

  /** Relaxed: минимальный train edge `pHat - entryPrice`, д.ед. (default 0.03). */
  readonly relaxedMinEdge?: number;

  /** Relaxed: минимальный нижний CI edge `pLow - entryPrice`, д.ед. (default 0.02). */
  readonly relaxedMinCiEdge?: number;

  /** Relaxed: требовать OOS passes=true, если OOS есть (default false). */
  readonly relaxedRequireOos?: boolean;
  /**
   * Relaxed: какие стороны можно выбирать по raw edge.
   * `table` сохраняет старое поведение: только zone.signal/kelly.side.
   */
  readonly relaxedEntrySide?: 'table' | 'up' | 'down' | 'both';

  /** Фиксированный размер ордера в shares; если задан, Kelly используется только как диагностика. */
  readonly orderShares?: number;

  /**
   * Максимально допустимое превышение текущей цены входа над историческим средним `crowdAvg` зоны (в центах).
   * Защита от входа когда рынок значительно дороже/дешевле, чем при калибровке сигнала.
   * Для UP-входа: `entryBid ≤ crowdAvg*100 + maxPremiumCents`.
   * Для DOWN-входа: `entryBid ≤ (100 - crowdAvg*100) + maxPremiumCents`.
   * `undefined` — фильтр отключён (default).
   */
  readonly maxPremiumCents?: number;

  /** Минимальный composite-вес зоны для торговли (default 0.3). */
  readonly minComposite?: number;

  /** Максимальная доля баланса в одну позицию (default 0.1 = 10%). */
  readonly maxPositionFraction?: number;

  /**
   * Жёсткий cap на число токенов в одной позиции (для малого капитала).
   * Применяется ПОСЛЕ Kelly-fraction. `undefined` → без капа.
   */
  readonly maxSharesPerMarket?: number;

  /** Warmup (сек) с момента открытия рынка до старта торгов (default 15). */
  readonly warmupSec?: number;

  /** Минимум точек истории цены для классификации режима (default 5). */
  readonly regimeMinPoints?: number;
  /** Порог $/min между flat и up/down (default 10). */
  readonly regimeThresholdPerMin?: number;
  /** Окно для slope (default 60_000 ms). */
  readonly regimeWindowMs?: number;

  /** Opt-in: выход на смену режима на противоположный. */
  readonly exitOnRegimeFlip?: boolean;
  /** Opt-in: выход если composite в текущей зоне упал ниже этого порога. */
  readonly exitOnWeightDrop?: boolean;
  /** Порог для exitOnWeightDrop (default 0.1). */
  readonly weightDropThreshold?: number;
  /** Opt-in: принудительный выход когда `tau < exitTauSec`. */
  readonly exitOnTauTimeout?: boolean;
  /** Порог tau (сек) для exitOnTauTimeout (default 15). */
  readonly exitTauSec?: number;
  /** Opt-in: выход при закрытии edge (|edge| < edgeClosureCents). */
  readonly exitOnEdgeClosure?: boolean;
  /** Порог в центах (default 1.5). */
  readonly edgeClosureCents?: number;

  /** Разрешить taker-панику (cross spread на выходе) при `tau < panicTauSec`. */
  readonly allowPanicTaker?: boolean;
  /** Порог для паник-тейкера (default 5 сек). */
  readonly panicTauSec?: number;
  /** Режим выхода: hold (default) | signal-normalized. */
  readonly exitMode?: 'hold' | 'signal-normalized';
  /** Для signal-normalized: выход если |predBps| <= threshold. */
  readonly normalizeThresholdBps?: number;
  /** Максимальное время удержания сигнальной позиции. */
  readonly maxSignalHoldMs?: number;
  /** Выходить если CEX signal стал stale / unavailable. */
  readonly exitOnSignalStale?: boolean;
  /** Выходить если CEX signal перевернулся против позиции. */
  readonly exitOnSignalFlip?: boolean;
  /** Пока токен ещё не доступен для продажи, после этого delay hedge уже не делаем. */
  readonly tokenAvailabilityDelayMs?: number;
  /** Если основной токен ещё недоступен — разрешить hedge противоположным токеном. */
  readonly hedgeWhenUnavailable?: boolean;
  /** Минимальный locked profit на share для hedge. */
  readonly minLockedProfitCents?: number;

  /** CEX-фильтр входа: off | agree | not-adverse (default off). */
  readonly cexFilterMode?: 'off' | 'agree' | 'not-adverse';
  /** ID сигнала в CryptoSignalRegistry (default cex_chainlink_lead_lag). */
  readonly cexSignalId?: string;
  /** CEX venues для сигнала (default binance,coinbase,okx). */
  readonly cexVenues?: readonly CexVenue[];
  /** Optional weights для CEX signal registry. */
  readonly cexWeights?: Readonly<Record<string, number>>;
  /** Optional intercept in USD for offline linear CEX signal registry models. */
  readonly cexLinearInterceptUsd?: number;
  /** Optional basisByVenue для CEX signal registry. */
  readonly cexBasisByVenue?: Readonly<Record<string, number>>;
  /** Optional offline confidence buckets для CEX signal registry. */
  readonly cexConfidenceByScore?: Readonly<Record<string, number>>;
  /** Порог direction != flat в bps (default 0.5). */
  readonly cexThresholdBps?: number;
  /** Lookback окна CEX momentum в ms (default 1000). */
  readonly cexLookbackMs?: number;
  /** Минимум samples для rolling-basis CEX signal. */
  readonly minBasisSamples?: number;
  /** Максимальный возраст CEX/Chainlink данных в ms (default 2000). */
  readonly cexStaleMs?: number;
  /** Минимальное число свежих venues. */
  readonly cexMinVenueCount?: number;
  /** Максимальный spread venue в bps. */
  readonly cexMaxSpreadBps?: number;
  /** Если true, stale/absent CEX блокирует вход (default true для включенного фильтра). */
  readonly cexRequireFresh?: boolean;
  /** Логировать каждое ENTRY-решение в application logger (default true). */
  readonly logEntries?: boolean;
}

// ── Внутренние типы ───────────────────────────────────────────────────────────

/**
 * Side-specific данные конкретного инструмента (primary UP или complementary DOWN).
 *
 * @remarks
 * Собирается в `gather()` для обоих инструментов; в `decide()` выбирается один по
 * `zone.signal` (для ENTRY) или по `_entrySide` (для EXIT).
 */
interface SideData {
  readonly side: EntrySide;
  readonly instrumentId: string;
  /** Для complementary — id и asset для PlaceIntent.targetInstrumentId/targetAsset. */
  readonly targetInstrumentId: InstrumentId | undefined;
  readonly targetAsset: AssetId | undefined;
  readonly bestBidCents: number | undefined;
  readonly bestAskCents: number | undefined;
  readonly positionQty: Decimal;
  readonly availableTokenQty: Decimal;
  readonly hasInFlightFills: boolean;
  readonly openBuyAtCents: number | undefined;
  readonly openSellAtCents: number | undefined;
  readonly matchedBuyAtCents: number | undefined;
  readonly matchedSellAtCents: number | undefined;
  readonly openOrderIds: readonly OrderId[];
  readonly hasOpenOrders: boolean;
  readonly hasMatchedBuy: boolean;
  readonly hasMatchedSell: boolean;
}

interface CCData {
  readonly instrumentId: string;
  readonly zone: EdgeZone | undefined;
  readonly regime: Regime | undefined;
  readonly deltaDollars: number | undefined;
  readonly tauSec: number;
  readonly midCents: number;
  readonly rawMidCents: number;
  /** Primary (UP) top-of-book — используется для midCents/deltaDollars lookup. */
  readonly bestBidCents: number | undefined;
  readonly bestAskCents: number | undefined;
  readonly primary: SideData;
  readonly complementary: SideData | undefined;
  readonly availableBalance: Decimal;
  readonly hasFilledEntryThisMarket: boolean;
  readonly cexSignal: CryptoSignalResult | undefined;
  readonly cexDirectionForToken: CryptoSignalDirection | undefined;
  readonly cexFresh: boolean;
  readonly minOrderValue: Decimal;
  readonly minOrderSize: Decimal;
  readonly nowMs: number;
}

type CCAction =
  | {
      readonly type: 'POST_BID';
      readonly bidCents: number;
      readonly size: Decimal;
      readonly postOnly: boolean;
      readonly targetInstrumentId?: InstrumentId;
      readonly targetAsset?: AssetId;
    }
  | {
      readonly type: 'POST_ASK';
      readonly askCents: number;
      readonly size: Decimal;
      readonly taker: boolean;
      readonly targetInstrumentId?: InstrumentId;
      readonly targetAsset?: AssetId;
    }
  | { readonly type: 'CANCEL_OPEN'; readonly orderIds: readonly OrderId[] }
  | { readonly type: 'STOP' };

type CCJournalAction = 'BUY' | 'SELL' | 'HOLD' | 'SKIP' | 'CANCEL';

interface CCOrderDiagnostic {
  readonly bidCents?: number;
  readonly askCents?: number;
  readonly size?: Decimal;
  readonly taker?: boolean;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

const PENDING_ORDER_GRACE_MS = 5_000;

// ── Реализация ────────────────────────────────────────────────────────────────

export class CalibratedCrowdStrategy extends BaseStrategy<CCData, CCAction> {
  public readonly id: StrategyId;
  public readonly name = 'CalibratedCrowdStrategy';

  private readonly _logger: ILogger | undefined;
  private readonly _journal: IDecisionJournal | undefined;
  private readonly _table: EdgeTable;
  private readonly _regimeDetector: RegimeDetector;

  private readonly _crowdGate: 'strict' | 'relaxed';
  private readonly _relaxedMinN: number;
  private readonly _relaxedMinEdge: number;
  private readonly _relaxedMinCiEdge: number;
  private readonly _relaxedRequireOos: boolean;
  private readonly _relaxedEntrySide: 'table' | 'up' | 'down' | 'both';
  private readonly _orderShares: number | undefined;
  private readonly _maxPremiumCents: number | undefined;
  private readonly _minComposite: number;
  private readonly _maxPositionFraction: number;
  private readonly _maxSharesPerMarket: number | undefined;
  private readonly _warmupSec: number;

  private readonly _exitOnRegimeFlip: boolean;
  private readonly _exitOnWeightDrop: boolean;
  private readonly _weightDropThreshold: number;
  private readonly _exitOnTauTimeout: boolean;
  private readonly _exitTauSec: number;
  private readonly _exitOnEdgeClosure: boolean;
  private readonly _edgeClosureCents: number;

  private readonly _allowPanicTaker: boolean;
  private readonly _panicTauSec: number;
  private readonly _exitMode: 'hold' | 'signal-normalized';
  private readonly _normalizeThresholdBps: number;
  private readonly _maxSignalHoldMs: number;
  private readonly _exitOnSignalStale: boolean;
  private readonly _exitOnSignalFlip: boolean;
  private readonly _tokenAvailabilityDelayMs: number;
  private readonly _hedgeWhenUnavailable: boolean;
  private readonly _minLockedProfitCents: number;

  private readonly _cexFilterMode: 'off' | 'agree' | 'not-adverse';
  private readonly _cexSignalId: string;
  private readonly _cexVenues: readonly CexVenue[];
  private readonly _cexWeights: Readonly<Record<string, number>> | undefined;
  private readonly _cexLinearInterceptUsd: number | undefined;
  private readonly _cexBasisByVenue: Readonly<Record<string, number>> | undefined;
  private readonly _cexConfidenceByScore: Readonly<Record<string, number>> | undefined;
  private readonly _cexThresholdBps: number;
  private readonly _cexLookbackMs: number;
  private readonly _cexMinBasisSamples: number;
  private readonly _cexStaleMs: number;
  private readonly _cexMinVenueCount: number | undefined;
  private readonly _cexMaxSpreadBps: number | undefined;
  private readonly _cexRequireFresh: boolean;
  private readonly _logEntries: boolean;

  // ── per-market state ────────────────────────────────────────────────────────
  private _currentExpirationMs = 0;
  private _marketEventStartMs = 0;
  private _inPosition = false;
  private _hasFilledEntryThisMarket = false;
  private _entryRegime: Regime | undefined;
  private _entryEdgeCents = 0;
  /**
   * Сторона на которой сейчас открыта / размещается позиция.
   * Фиксируется при ENTRY, используется при EXIT чтобы не перепутать инструмент.
   */
  private _entrySide: EntrySide | undefined;
  private _entryPlacedAtMs = 0;
  private _entryPriceCents = 0;
  private _entrySize = new Decimal(0);
  private _entryPostOnly = true;
  private _pendingEntryAtMs = 0;
  private _pendingEntryPriceCents = 0;
  private _pendingEntrySide: EntrySide | undefined;
  private _pendingExitAtMs = 0;
  private _pendingExitPriceCents = 0;
  private _pendingExitSide: EntrySide | undefined;

  constructor(
    config: CalibratedCrowdConfig,
    strategyId: StrategyId = unsafeStrategyId('calibrated-crowd-1'),
    logger?: ILogger,
    journal?: IDecisionJournal,
  ) {
    super();
    this.id = strategyId;
    this._logger = logger;
    this._journal = journal;

    this._table = EdgeTable.fromFile(config.edgeTablePath);
    this._regimeDetector = new RegimeDetector({
      thresholdPerMin: config.regimeThresholdPerMin ?? this._table.meta.bucketing.regimeThreshold,
      windowMs: config.regimeWindowMs,
      minPoints: config.regimeMinPoints,
    });

    this._crowdGate = config.crowdGate ?? 'strict';
    this._relaxedMinN = config.relaxedMinN ?? 20;
    this._relaxedMinEdge = config.relaxedMinEdge ?? 0.03;
    this._relaxedMinCiEdge = config.relaxedMinCiEdge ?? 0.02;
    this._relaxedRequireOos = config.relaxedRequireOos ?? false;
    this._relaxedEntrySide = config.relaxedEntrySide ?? 'table';
    this._orderShares = config.orderShares;
    this._maxPremiumCents = config.maxPremiumCents;
    this._minComposite = config.minComposite ?? 0.3;
    this._maxPositionFraction = config.maxPositionFraction ?? 0.1;
    this._maxSharesPerMarket = config.maxSharesPerMarket;
    this._warmupSec = config.warmupSec ?? 15;

    this._exitOnRegimeFlip = config.exitOnRegimeFlip ?? false;
    this._exitOnWeightDrop = config.exitOnWeightDrop ?? false;
    this._weightDropThreshold = config.weightDropThreshold ?? 0.1;
    this._exitOnTauTimeout = config.exitOnTauTimeout ?? false;
    this._exitTauSec = config.exitTauSec ?? 15;
    this._exitOnEdgeClosure = config.exitOnEdgeClosure ?? false;
    this._edgeClosureCents = config.edgeClosureCents ?? 1.5;

    this._allowPanicTaker = config.allowPanicTaker ?? false;
    this._panicTauSec = config.panicTauSec ?? 5;
    this._exitMode = config.exitMode ?? 'hold';
    this._normalizeThresholdBps = config.normalizeThresholdBps ?? 0.25;
    this._maxSignalHoldMs = config.maxSignalHoldMs ?? 60_000;
    this._exitOnSignalStale = config.exitOnSignalStale ?? true;
    this._exitOnSignalFlip = config.exitOnSignalFlip ?? true;
    this._tokenAvailabilityDelayMs = config.tokenAvailabilityDelayMs ?? 0;
    this._hedgeWhenUnavailable = config.hedgeWhenUnavailable ?? false;
    this._minLockedProfitCents = config.minLockedProfitCents ?? 0;

    this._cexFilterMode = config.cexFilterMode ?? 'off';
    this._cexSignalId = config.cexSignalId ?? 'cex_chainlink_lead_lag';
    this._cexVenues = config.cexVenues ?? ['binance', 'coinbase', 'okx'];
    this._cexWeights = config.cexWeights;
    this._cexLinearInterceptUsd = config.cexLinearInterceptUsd;
    this._cexBasisByVenue = config.cexBasisByVenue;
    this._cexConfidenceByScore = config.cexConfidenceByScore;
    this._cexThresholdBps = config.cexThresholdBps ?? 0.5;
    this._cexLookbackMs = config.cexLookbackMs ?? 1_000;
    this._cexMinBasisSamples = config.minBasisSamples ?? 3;
    this._cexStaleMs = config.cexStaleMs ?? 2_000;
    this._cexMinVenueCount = config.cexMinVenueCount;
    this._cexMaxSpreadBps = config.cexMaxSpreadBps;
    this._cexRequireFresh = config.cexRequireFresh ?? this._cexFilterMode !== 'off';
    this._logEntries = config.logEntries ?? true;

    this._logger?.warn('CalibratedCrowd: loaded', {
      path: config.edgeTablePath,
      zones: this._table.size,
      crowdGate: this._crowdGate,
      relaxed: {
        minN: this._relaxedMinN,
        minEdge: this._relaxedMinEdge,
        minCiEdge: this._relaxedMinCiEdge,
        requireOos: this._relaxedRequireOos,
        entrySide: this._relaxedEntrySide,
      },
      minComposite: this._minComposite,
      orderShares: this._orderShares,
      maxPositionFraction: this._maxPositionFraction,
      cexFilterMode: this._cexFilterMode,
      cex: this._cexFilterMode === 'off' ? undefined : {
        signalId: this._cexSignalId,
        venues: this._cexVenues.join(','),
        thresholdBps: this._cexThresholdBps,
        staleMs: this._cexStaleMs,
      },
      exits: {
        mode: this._exitMode,
        regimeFlip: this._exitOnRegimeFlip,
        weightDrop: this._exitOnWeightDrop,
        tauTimeout: this._exitOnTauTimeout,
        edgeClosure: this._exitOnEdgeClosure,
        normalizeThresholdBps: this._normalizeThresholdBps,
        maxSignalHoldMs: this._maxSignalHoldMs,
        tokenAvailabilityDelayMs: this._tokenAvailabilityDelayMs,
        hedgeWhenUnavailable: this._hedgeWhenUnavailable,
        minLockedProfitCents: this._minLockedProfitCents,
      },
    });
  }

  // ── gather ──────────────────────────────────────────────────────────────────

  protected gather(snapshot: StrategySnapshot): CCData | undefined {
    const expiresMs = snapshot.market.expirationMs;

    // Смена рынка → сброс состояния.
    if (this._currentExpirationMs !== expiresMs) {
      this._currentExpirationMs = expiresMs;
      this._inPosition = false;
      this._hasFilledEntryThisMarket = false;
      this._entryRegime = undefined;
      this._entryEdgeCents = 0;
      this._entrySide = undefined;
      this._entryPlacedAtMs = 0;
      this._entryPriceCents = 0;
      this._entrySize = new Decimal(0);
      this._entryPostOnly = true;
      this._pendingEntryAtMs = 0;
      this._pendingEntryPriceCents = 0;
      this._pendingEntrySide = undefined;
      this._pendingExitAtMs = 0;
      this._pendingExitPriceCents = 0;
      this._pendingExitSide = undefined;

      if (snapshot.eventStartMs !== undefined) {
        this._marketEventStartMs = snapshot.eventStartMs.toNumber();
      } else {
        return undefined;
      }
    }
    if (this._marketEventStartMs <= 0) return undefined;

    // Warmup после ротации рынка.
    if ((snapshot.nowMs - this._marketEventStartMs) < this._warmupSec * 1000) {
      return undefined;
    }

    const tauSec = Math.max(0, (expiresMs - snapshot.nowMs) / 1000);

    // Top-of-book: нужен и для mid, и для maker-цен.
    const bestBid = snapshot.topOfBook?.bestBid?.value().toNumber();
    const bestAsk = snapshot.topOfBook?.bestAsk?.value().toNumber();
    const bestBidCents = bestBid !== undefined ? bestBid * 100 : undefined;
    const bestAskCents = bestAsk !== undefined ? bestAsk * 100 : undefined;

    let rawMidCents: number;
    let midCents: number;
    if (bestBidCents !== undefined && bestAskCents !== undefined) {
      rawMidCents = (bestBidCents + bestAskCents) / 2;
      // Edge-таблица строится по Math.round((bid+ask)/2), поэтому live lookup
      // должен использовать такой же feature, а не half-cent mid.
      midCents = Math.round(rawMidCents);
    } else {
      return undefined; // без book не торгуем
    }

    // Crypto price для delta и regime.
    let deltaDollars: number | undefined;
    const cp = snapshot.cryptoPrice;
    if (cp && cp.targetPrice && cp.currentPrice > 0) {
      deltaDollars = cp.currentPrice - cp.targetPrice;
    }

    const regimeInfo = this._regimeDetector.classify(snapshot.cryptoPriceHistory, snapshot.nowMs);
    const regime = regimeInfo?.regime;

    // Lookup зоны.
    let zone: EdgeZone | undefined;
    if (deltaDollars !== undefined && regime !== undefined) {
      zone = this._table.lookup({ deltaDollars, tauSec, midCents, regime });
    }

    const cexSignal = this._evaluateCexSignal(snapshot);
    const cexDirectionForToken = cexSignal?.direction;
    const cexFresh = Boolean(cexSignal && (!this._cexRequireFresh || !cexSignal.stale));

    // Portfolio / balance.
    const portfolio = snapshot.portfolio;
    const availableBalance = portfolio?.balance.available().value() ?? new Decimal(0);

    const primary = this._buildSideData(
      'UP',
      snapshot.instrumentId,
      undefined,
      undefined,
      bestBidCents,
      bestAskCents,
      portfolio,
      snapshot.openOrders,
      snapshot.matchedOrders,
      snapshot.hasInFlightFills,
    );

    const compId = snapshot.complementaryInstrumentId;
    const compAsset = snapshot.complementaryAsset;
    let complementary: SideData | undefined;
    if (compId !== undefined && compAsset !== undefined) {
      const compBestBid = snapshot.complementaryTopOfBook?.bestBid?.value().toNumber();
      const compBestAsk = snapshot.complementaryTopOfBook?.bestAsk?.value().toNumber();
      complementary = this._buildSideData(
        'DOWN',
        compId,
        compId,
        compAsset,
        compBestBid !== undefined ? compBestBid * 100 : undefined,
        compBestAsk !== undefined ? compBestAsk * 100 : undefined,
        portfolio,
        snapshot.complementaryOpenOrders ?? [],
        snapshot.complementaryMatchedOrders ?? [],
        snapshot.hasComplementaryInFlightFills ?? false,
      );
    }

    const anyPosition = primary.positionQty.gt(0) || primary.availableTokenQty.gt(0) || primary.hasInFlightFills
      || (complementary?.positionQty.gt(0) ?? false)
      || (complementary?.availableTokenQty.gt(0) ?? false)
      || (complementary?.hasInFlightFills ?? false);

    if (anyPosition) {
      this._inPosition = true;
      this._hasFilledEntryThisMarket = true;
      this._pendingEntryAtMs = 0;
      this._pendingEntryPriceCents = 0;
      this._pendingEntrySide = undefined;
      // Если _entrySide ещё не известен (перезагрузка/warmup с уже открытой позицией) — восстановим.
      if (this._entrySide === undefined) {
        if (primary.positionQty.gt(0) || primary.availableTokenQty.gt(0) || primary.hasInFlightFills) {
          this._entrySide = 'UP';
        } else if (complementary) {
          this._entrySide = 'DOWN';
        }
      }
    } else {
      // В signal-normalized режиме pending maker-ордер не должен считаться позицией:
      // иначе начнём крутить EXIT-логику до реального fill.
      this._inPosition = false;
      if (
        !primary.hasOpenOrders
        && !primary.hasMatchedBuy
        && !primary.hasMatchedSell
        && !(complementary?.hasOpenOrders ?? false)
        && !(complementary?.hasMatchedBuy ?? false)
        && !(complementary?.hasMatchedSell ?? false)
        && (this._pendingEntryAtMs <= 0 || (snapshot.nowMs - this._pendingEntryAtMs) >= PENDING_ORDER_GRACE_MS)
      ) {
        this._pendingEntryAtMs = 0;
        this._pendingEntryPriceCents = 0;
        this._pendingEntrySide = undefined;
      }
      this._pendingExitAtMs = 0;
      this._pendingExitPriceCents = 0;
      this._pendingExitSide = undefined;
    }

    return {
      instrumentId: String(snapshot.instrumentId),
      zone,
      regime,
      deltaDollars,
      tauSec,
      midCents,
      rawMidCents,
      bestBidCents,
      bestAskCents,
      primary,
      complementary,
      availableBalance,
      hasFilledEntryThisMarket: this._hasFilledEntryThisMarket,
      cexSignal,
      cexDirectionForToken,
      cexFresh,
      minOrderValue: snapshot.constraints?.minOrderValue.value() ?? new Decimal(1),
      minOrderSize: snapshot.constraints?.minOrderSize.value() ?? new Decimal(5),
      nowMs: snapshot.nowMs,
    };
  }

  /**
   * Собрать {@link SideData} для конкретного инструмента (UP или DOWN).
   *
   * @param side - какую сторону собираем
   * @param instrumentId - InstrumentId инструмента
   * @param targetInstrumentId - для DOWN это `instrumentId`; для UP — `undefined` (primary не требует target в PlaceIntent)
   * @param targetAsset - AssetId для PlaceIntent, `undefined` для UP
   * @param bestBidCents - лучший bid в центах
   * @param bestAskCents - лучший ask в центах
   * @param portfolio - portfolio snapshot (может быть undefined до первого fill)
   * @param openOrders - open-ордера этой стратегии на этом инструменте
   * @param hasInFlightFills - MATCHED-ордера в пути
   */
  private _buildSideData(
    side: EntrySide,
    instrumentId: InstrumentId,
    targetInstrumentId: InstrumentId | undefined,
    targetAsset: AssetId | undefined,
    bestBidCents: number | undefined,
    bestAskCents: number | undefined,
    portfolio: StrategySnapshot['portfolio'],
    openOrders: StrategySnapshot['openOrders'],
    matchedOrders: readonly import('@polymarket/order').Order[],
    hasInFlightFills: boolean,
  ): SideData {
    const positionQty = portfolio?.getPosition(instrumentId)?.quantity?.value() ?? new Decimal(0);
    const availableTokenQty = portfolio?.availableTokenQuantity(instrumentId) ?? new Decimal(0);

    let openBuyAtCents: number | undefined;
    let openSellAtCents: number | undefined;
    let matchedBuyAtCents: number | undefined;
    let matchedSellAtCents: number | undefined;
    const openOrderIds: OrderId[] = [];
    for (const o of openOrders) {
      openOrderIds.push(o.id);
      const cents = Math.round(o.price.value().toNumber() * 100);
      if (o.side === 'BUY') openBuyAtCents = cents;
      else if (o.side === 'SELL') openSellAtCents = cents;
    }
    for (const o of matchedOrders) {
      const cents = Math.round(o.price.value().toNumber() * 100);
      if (o.side === 'BUY') matchedBuyAtCents = cents;
      else if (o.side === 'SELL') matchedSellAtCents = cents;
    }

    return {
      side,
      instrumentId: String(instrumentId),
      targetInstrumentId,
      targetAsset,
      bestBidCents,
      bestAskCents,
      positionQty,
      availableTokenQty,
      hasInFlightFills,
      openBuyAtCents,
      openSellAtCents,
      matchedBuyAtCents,
      matchedSellAtCents,
      openOrderIds,
      hasOpenOrders: openOrders.length > 0,
      hasMatchedBuy: matchedBuyAtCents !== undefined,
      hasMatchedSell: matchedSellAtCents !== undefined,
    };
  }

  // ── decide ──────────────────────────────────────────────────────────────────

  protected decide(data: CCData): CCAction[] {
    // Любой in-flight fill на обеих сторонах → не трогаем.
    const anyInFlight = data.primary.hasInFlightFills || (data.complementary?.hasInFlightFills ?? false);

    // ── Режим EXIT: мы в позиции ─────────────────────────────────────────────
    // Используем сторону которую зафиксировали при входе.
    const exitTarget = this._resolveExitTarget(data);
    if (this._inPosition && exitTarget) {
      const exitReason = this._checkExitConditions(data);
      if (exitReason) {
        if (exitTarget.availableTokenQty.gt(0)) {
          const takerExit = this._exitMode === 'signal-normalized'
            || (this._allowPanicTaker && data.tauSec < this._panicTauSec);
          const ask = this._computeExitPriceCents(exitTarget, takerExit);
          if (ask === undefined) {
            this._recordDecision(data, 'CANCEL', 'exit-price-unavailable');
            return [{ type: 'STOP' }];
          }

          let size = this._ensureMinSize(exitTarget.availableTokenQty, ask, data.minOrderValue);
          if (size === undefined) {
            this._recordDecision(data, 'CANCEL', 'exit-size-unavailable', { askCents: ask });
            return [{ type: 'STOP' }];
          }
          size = Decimal.min(size, exitTarget.availableTokenQty);

          if (exitTarget.openSellAtCents === ask) {
            this._recordDecision(data, 'HOLD', 'open-sell-same-price', { askCents: ask, size, taker: takerExit });
            return [];
          }
          if (exitTarget.hasMatchedSell) {
            this._recordDecision(data, 'HOLD', 'matched-sell-pending', { askCents: exitTarget.matchedSellAtCents, size, taker: takerExit });
            return [];
          }
          if (
            takerExit
            && this._pendingExitSide === exitTarget.side
            && (data.nowMs - this._pendingExitAtMs) < PENDING_ORDER_GRACE_MS
          ) {
            this._recordDecision(data, 'HOLD', 'exit-pending', {
              askCents: this._pendingExitPriceCents || ask,
              size,
              taker: takerExit,
            });
            return [];
          }

          this._logger?.warn('CalibratedCrowd: EXIT', {
            side: exitTarget.side,
            reason: exitReason,
            ask,
            taker: takerExit,
            tau: data.tauSec.toFixed(0),
            compositeNow: data.zone?.weights.composite.toFixed(2) ?? 'n/a',
            regimeNow: data.regime ?? 'n/a',
            regimeEntry: this._entryRegime ?? 'n/a',
            cexDirection: data.cexDirectionForToken,
            cexValueBps: data.cexSignal?.value.toFixed(3),
          });

          this._pendingExitAtMs = data.nowMs;
          this._pendingExitPriceCents = ask;
          this._pendingExitSide = exitTarget.side;
          this._recordDecision(data, 'SELL', exitReason, { askCents: ask, size, taker: takerExit });
          return [{
            type: 'POST_ASK',
            askCents: ask,
            size,
            taker: takerExit,
            targetInstrumentId: exitTarget.targetInstrumentId,
            targetAsset: exitTarget.targetAsset,
          }];
        }

        const hedgeExit = this._buildHedgeExit(data, exitReason);
        if (hedgeExit) return hedgeExit;
      }
      this._recordDecision(data, 'HOLD', exitTarget.availableTokenQty.gt(0) ? 'hold-to-expiry' : 'token-unavailable');
      return [{ type: 'STOP' }];
    }

    if (anyInFlight) {
      const cancelIds: OrderId[] = [
        ...data.primary.openOrderIds,
        ...(data.complementary?.openOrderIds ?? []),
      ];
      if (cancelIds.length > 0) {
        this._recordDecision(data, 'CANCEL', 'in-flight-fills');
        return [{ type: 'CANCEL_OPEN', orderIds: cancelIds }];
      }
      this._recordDecision(data, 'HOLD', 'in-flight-fills');
      return [];
    }

    // ── Режим ENTRY: нет позиции ─────────────────────────────────────────────
    if (this._hasFilledEntryThisMarket) {
      this._recordDecision(data, 'HOLD', 'entry-already-filled-this-market');
      return [{ type: 'STOP' }];
    }

    const zone = data.zone;
    if (!zone) {
      this._recordDecision(data, 'SKIP', 'no-edge-zone');
      return [{ type: 'STOP' }];
    }

    // Выбираем сторону на основании zone.signal/kelly.side.
    const entryTarget = this._resolveEntryTarget(data, zone);
    if (!entryTarget) {
      this._recordDecision(data, 'SKIP', 'zone-side-unsupported');
      return [{ type: 'STOP' }];
    }

    const bid = this._computeEntryBidCents(entryTarget);
    if (bid === undefined) {
      this._recordDecision(data, 'SKIP', 'entry-bid-unavailable');
      return [{ type: 'STOP' }];
    }

    const zoneRejectReason = this._entryZoneRejectReason(zone, bid, entryTarget.side);
    if (zoneRejectReason) {
      this._recordDecision(data, 'SKIP', zoneRejectReason);
      return [{ type: 'STOP' }];
    }
    if (this._maxPremiumCents !== undefined) {
      const crowdAvgCents = zone.train.crowdAvg * 100;
      const historicalBid = entryTarget.side === 'UP' ? crowdAvgCents : (100 - crowdAvgCents);
      if (bid > historicalBid + this._maxPremiumCents) {
        this._recordDecision(data, 'SKIP', 'price-above-crowd-avg');
        return [{ type: 'STOP' }];
      }
    }
    if (zone.weights.composite < this._minComposite) {
      this._recordDecision(data, 'SKIP', 'composite-below-min');
      return [{ type: 'STOP' }];
    }
    if (this._orderShares === undefined && zone.kelly.size <= 0) {
      this._recordDecision(data, 'SKIP', 'kelly-size-zero');
      return [{ type: 'STOP' }];
    }

    const cexRejectReason = this._cexEntryRejectReason(data, entryTarget.side);
    if (cexRejectReason) {
      this._recordDecision(data, 'SKIP', cexRejectReason);
      return [{ type: 'STOP' }];
    }

    if (entryTarget.hasMatchedBuy) {
      this._recordDecision(data, 'HOLD', 'matched-buy-pending', { bidCents: entryTarget.matchedBuyAtCents });
      return [];
    }

    let size: Decimal;
    if (this._orderShares !== undefined) {
      size = new Decimal(this._orderShares).floor();
    } else {
      // Размер позиции: fraction капитала, ограниченный maxPositionFraction.
      const fraction = Math.min(zone.kelly.size, this._maxPositionFraction);
      const notional = data.availableBalance.mul(fraction);
      if (notional.lte(0)) {
        this._recordDecision(data, 'SKIP', 'notional-zero');
        return [{ type: 'STOP' }];
      }

      // tokens = notional / (bid/100) (цена bid в центах → $)
      size = notional.div(new Decimal(bid).div(100)).floor();
    }

    // Cap по числу токенов на рынок (если задан).
    const sharesCap = this._maxSharesPerMarket !== undefined
      ? new Decimal(this._maxSharesPerMarket)
      : null;

    // Подогнать под minOrderSize — жёсткий constraint биржи.
    // Если Kelly просит меньше minOrderSize, поднимаем до minOrderSize (если
    // bump не нарушает sharesCap и хватает капитала). Иначе SKIP зону.
    if (size.lt(data.minOrderSize)) {
      const bumped = data.minOrderSize;
      if (sharesCap && bumped.gt(sharesCap)) {
        this._recordDecision(data, 'SKIP', 'min-order-size-above-shares-cap', { bidCents: bid, size: bumped });
        return [{ type: 'STOP' }];
      }
      const bumpedCost = bumped.mul(new Decimal(bid).div(100));
      if (bumpedCost.gt(data.availableBalance)) {
        this._recordDecision(data, 'SKIP', 'insufficient-balance-for-min-order-size', { bidCents: bid, size: bumped });
        return [{ type: 'STOP' }];
      }
      size = bumped;
    }

    // Cap сверху — после bump.
    if (sharesCap) size = Decimal.min(size, sharesCap);

    // Гарантируем minOrderValue — на больших bid (≈ $1) size=5 уже > $1, так что no-op.
    size = this._ensureMinSize(size, bid, data.minOrderValue) ?? new Decimal(0);
    if (size.lt(data.minOrderSize)) {
      this._recordDecision(data, 'SKIP', 'size-below-min-order-size', { bidCents: bid, size });
      return [{ type: 'STOP' }];
    }

    // Хватает ли денег под size по bid?
    const cost = size.mul(new Decimal(bid).div(100));
    if (cost.gt(data.availableBalance)) {
      this._recordDecision(data, 'SKIP', 'insufficient-balance', { bidCents: bid, size });
      return [{ type: 'STOP' }];
    }

    // Если уже стоит BUY на этой же цене — держим ордер, ничего не делаем.
    if (entryTarget.openBuyAtCents === bid) {
      this._rememberPendingEntry(entryTarget.side, bid, data.nowMs, size, data.regime);
      this._recordDecision(data, 'HOLD', 'open-buy-same-price', { bidCents: bid, size });
      return [];
    }

    if (
      this._pendingEntrySide === entryTarget.side
      && (data.nowMs - this._pendingEntryAtMs) < PENDING_ORDER_GRACE_MS
    ) {
      this._recordDecision(data, 'HOLD', 'entry-pending', {
        bidCents: this._pendingEntryPriceCents || bid,
        size,
      });
      return [];
    }

    this._rememberPendingEntry(entryTarget.side, bid, data.nowMs, size, data.regime);
    this._entryEdgeCents = zone.train.edge * 100;
    void this._entryEdgeCents; // сохраняем для будущей диагностики/метрик

    // Effective entry probability для логов: для UP — pHat; для DOWN — 1-pHat.
    const effPHat = entryTarget.side === 'UP' ? zone.train.pHat : 1 - zone.train.pHat;
    const effEntryEdgeCents = (effPHat - bid / 100) * 100;

    if (this._logEntries) {
      this._logger?.warn('CalibratedCrowd: ENTRY', {
        side: entryTarget.side,
        signal: zone.signal,
        bid,
        size: size.toFixed(0),
        delta: data.deltaDollars?.toFixed(1),
        tau: data.tauSec.toFixed(0),
        mid: data.midCents.toFixed(1),
        regime: data.regime,
        composite: zone.weights.composite.toFixed(2),
        kellySize: zone.kelly.size.toFixed(3),
        edgeCents: (zone.train.edge * 100).toFixed(1),
        entryEdgeCents: effEntryEdgeCents.toFixed(1),
        n: zone.train.n,
        cexDirection: data.cexDirectionForToken,
        cexValueBps: data.cexSignal?.value.toFixed(3),
      });
    }

    this._recordDecision(data, 'BUY', undefined, { bidCents: bid, size });
    return [{
      type: 'POST_BID',
      bidCents: bid,
      size,
      postOnly: true,
      targetInstrumentId: entryTarget.targetInstrumentId,
      targetAsset: entryTarget.targetAsset,
    }];
  }

  /**
   * Выбрать целевую сторону (primary UP или complementary DOWN) для ENTRY
   * по сигналу зоны. Возвращает undefined если зона указывает на DOWN, но
   * complementary инструмент не зарегистрирован / top-of-book недоступен.
   *
   * @param data - текущие CCData
   * @param zone - кандидат зона
   */
  private _resolveEntryTarget(data: CCData, zone: EdgeZone): SideData | undefined {
    if (this._crowdGate === 'relaxed' && this._relaxedEntrySide !== 'table') {
      return this._resolveRelaxedEntryTarget(data, zone);
    }

    if (zone.signal === 'BUY' && zone.kelly.side === 'UP') return data.primary;
    if (zone.signal === 'SELL' && zone.kelly.side === 'DOWN') {
      const comp = data.complementary;
      if (!comp || comp.bestBidCents === undefined || comp.bestAskCents === undefined) {
        return undefined;
      }
      return comp;
    }
    return undefined;
  }

  private _resolveRelaxedEntryTarget(data: CCData, zone: EdgeZone): SideData | undefined {
    let best: { readonly side: SideData; readonly edgeHat: number } | undefined;

    const consider = (side: SideData | undefined): void => {
      if (!side || side.bestBidCents === undefined || side.bestAskCents === undefined) return;
      const bid = this._computeEntryBidCents(side);
      if (bid === undefined) return;
      if (this._entryZoneRejectReason(zone, bid, side.side)) return;

      const edgeHat = this._entryEdgeHat(zone, bid, side.side);
      if (!best || edgeHat > best.edgeHat) {
        best = { side, edgeHat };
      }
    };

    if (this._relaxedEntrySide === 'up' || this._relaxedEntrySide === 'both') {
      consider(data.primary);
    }
    if (this._relaxedEntrySide === 'down' || this._relaxedEntrySide === 'both') {
      consider(data.complementary);
    }

    return best?.side;
  }

  /**
   * Определить сторону EXIT по зафиксированному при входе `_entrySide`.
   *
   * @remarks
   * Если `_entrySide` не выставлен (первый тик после рестарта), пытаемся
   * восстановить из SideData с ненулевой позицией.
   */
  private _resolveExitTarget(data: CCData): SideData | undefined {
    if (this._entrySide === 'DOWN') return data.complementary;
    if (this._entrySide === 'UP') return data.primary;
    if (data.primary.availableTokenQty.gt(0) || data.primary.positionQty.gt(0)) {
      return data.primary;
    }
    if (data.complementary && (data.complementary.availableTokenQty.gt(0) || data.complementary.positionQty.gt(0))) {
      return data.complementary;
    }
    return undefined;
  }

  private _recordDecision(
    data: CCData,
    action: CCJournalAction,
    rejectReason?: string,
    order?: CCOrderDiagnostic,
  ): void {
    const state = this._serializeDecisionState(data, order);
    this._journal?.recordDecision({
      marketId: data.instrumentId,
      strategyId: this.id,
      ts: data.nowMs,
      action,
      state,
      rejectReason,
      bidPrice: order?.bidCents,
      askPrice: order?.askCents,
      orderSize: order?.size?.toString(),
      effectiveSide: action === 'BUY' || action === 'SELL'
        ? (this._entrySide === 'DOWN' ? 'down' : 'up')
        : undefined,
    });

    this._logger?.debug('CalibratedCrowd: decision', {
      action,
      rejectReason,
      bidPrice: order?.bidCents,
      askPrice: order?.askCents,
      orderSize: order?.size?.toString(),
      ...state,
    });
  }

  /** Сериализация SideData для journal/log. */
  private _serializeSide(side: SideData): Record<string, unknown> {
    return {
      side: side.side,
      instrumentId: side.instrumentId,
      bestBidCents: side.bestBidCents !== undefined ? round(side.bestBidCents, 6) : undefined,
      bestAskCents: side.bestAskCents !== undefined ? round(side.bestAskCents, 6) : undefined,
      positionQty: side.positionQty.toString(),
      availableTokenQty: side.availableTokenQty.toString(),
      openBuyAtCents: side.openBuyAtCents,
      openSellAtCents: side.openSellAtCents,
      matchedBuyAtCents: side.matchedBuyAtCents,
      matchedSellAtCents: side.matchedSellAtCents,
      openOrderIds: side.openOrderIds.map(String),
      hasOpenOrders: side.hasOpenOrders,
      hasInFlightFills: side.hasInFlightFills,
      hasMatchedBuy: side.hasMatchedBuy,
      hasMatchedSell: side.hasMatchedSell,
    };
  }

  private _rememberPendingEntry(
    side: EntrySide,
    bid: number,
    nowMs: number,
    size: Decimal,
    regime: Regime | undefined,
  ): void {
    this._entrySide = side;
    this._entryRegime = regime;
    this._entryPlacedAtMs = nowMs;
    this._entryPriceCents = bid;
    this._entrySize = size;
    this._entryPostOnly = true;
    this._pendingEntryAtMs = nowMs;
    this._pendingEntryPriceCents = bid;
    this._pendingEntrySide = side;
  }

  private _serializeDecisionState(
    data: CCData,
    order?: CCOrderDiagnostic,
  ): Record<string, unknown> {
    const z = data.zone;
    const sharesCap = this._maxSharesPerMarket;
    const orderSize = order?.size;
    const orderPriceCents = order?.bidCents ?? order?.askCents;
    const orderNotional = orderSize && orderPriceCents !== undefined
      ? orderSize.mul(new Decimal(orderPriceCents).div(100))
      : undefined;

    return {
      instrumentId: data.instrumentId,
      nowMs: data.nowMs,
      tauSec: round(data.tauSec, 3),
      deltaDollars: data.deltaDollars !== undefined ? round(data.deltaDollars, 6) : undefined,
      regime: data.regime,
      midCents: data.midCents,
      rawMidCents: round(data.rawMidCents, 6),
      bestBidCents: data.bestBidCents !== undefined ? round(data.bestBidCents, 6) : undefined,
      bestAskCents: data.bestAskCents !== undefined ? round(data.bestAskCents, 6) : undefined,
      entrySide: this._entrySide,
      primary: this._serializeSide(data.primary),
      complementary: data.complementary ? this._serializeSide(data.complementary) : undefined,
      hasFilledEntryThisMarket: data.hasFilledEntryThisMarket,
      availableBalance: data.availableBalance.toString(),
      minOrderSize: data.minOrderSize.toString(),
      minOrderValue: data.minOrderValue.toString(),
      config: {
        crowdGate: this._crowdGate,
        relaxedMinN: this._relaxedMinN,
        relaxedMinEdge: this._relaxedMinEdge,
        relaxedMinCiEdge: this._relaxedMinCiEdge,
        relaxedRequireOos: this._relaxedRequireOos,
        orderShares: this._orderShares,
        minComposite: this._minComposite,
        maxPositionFraction: this._maxPositionFraction,
        maxSharesPerMarket: sharesCap,
        cexFilterMode: this._cexFilterMode,
        exitMode: this._exitMode,
        normalizeThresholdBps: this._normalizeThresholdBps,
        maxSignalHoldMs: this._maxSignalHoldMs,
        exitOnSignalStale: this._exitOnSignalStale,
        exitOnSignalFlip: this._exitOnSignalFlip,
        tokenAvailabilityDelayMs: this._tokenAvailabilityDelayMs,
        hedgeWhenUnavailable: this._hedgeWhenUnavailable,
        minLockedProfitCents: this._minLockedProfitCents,
      },
      zone: z ? {
        key: z.key,
        signal: z.signal,
        kellySide: z.kelly.side,
        kellySize: round(z.kelly.size, 6),
        composite: round(z.weights.composite, 6),
        edgeCents: round(z.train.edge * 100, 6),
        entryEdgeCents: order?.bidCents !== undefined
          ? round((z.train.pHat - order.bidCents / 100) * 100, 6)
          : undefined,
        entryCiEdgeCents: order?.bidCents !== undefined
          ? round((z.train.pLow - order.bidCents / 100) * 100, 6)
          : undefined,
        n: z.train.n,
        pHat: round(z.train.pHat, 6),
        pLow: round(z.train.pLow, 6),
        pHigh: round(z.train.pHigh, 6),
        crowdAvgCents: round(z.train.crowdAvg * 100, 6),
        spreadAvgCents: round(z.train.spreadAvg, 6),
        oos: z.oos ? {
          n: z.oos.n,
          pHat: round(z.oos.pHat, 6),
          edgeCents: round(z.oos.edge * 100, 6),
          passes: z.oos.passes,
        } : null,
      } : undefined,
      cex: data.cexSignal ? {
        id: data.cexSignal.id,
        direction: data.cexSignal.direction,
        tokenDirection: data.cexDirectionForToken,
        valueBps: round(data.cexSignal.value, 6),
        strength: round(data.cexSignal.strength, 6),
        confidence: round(data.cexSignal.confidence.toNumber(), 6),
        stale: data.cexSignal.stale,
        fresh: data.cexFresh,
        ageMs: data.nowMs - data.cexSignal.tsMs,
        components: data.cexSignal.components,
      } : undefined,
      order: orderPriceCents !== undefined || orderSize !== undefined ? {
        bidCents: order?.bidCents,
        askCents: order?.askCents,
        size: orderSize?.toString(),
        notional: orderNotional?.toString(),
        taker: order?.taker,
        sharesCapExceeded: sharesCap !== undefined && orderSize !== undefined
          ? orderSize.gt(sharesCap)
          : false,
      } : undefined,
    };
  }

  /**
   * Проверить зону на допустимость для входа.
   *
   * @param zone - зона из EdgeTable
   * @param entryBidCents - предполагаемая цена входа (центы) на *целевом* инструменте
   * @param side - сторона входа (UP → primary, DOWN → complementary)
   *
   * @remarks
   * В relaxed-режиме train.pHat/pLow в таблице выражены в терминах UP-токена.
   * Для DOWN-входа нужно перевести: `pHat_DOWN = 1 - pHat_UP`,
   * `pLow_DOWN = 1 - pHigh_UP`.
   */
  private _entryZoneRejectReason(zone: EdgeZone, entryBidCents: number, side: EntrySide): string | undefined {
    if (this._crowdGate === 'strict') {
      const isBuyUp = zone.signal === 'BUY' && zone.kelly.side === 'UP' && side === 'UP';
      const isSellDown = zone.signal === 'SELL' && zone.kelly.side === 'DOWN' && side === 'DOWN';
      return isBuyUp || isSellDown ? undefined : 'zone-not-actionable';
    }

    if (zone.train.n < this._relaxedMinN) return 'relaxed-n-below-min';
    const entry = entryBidCents / 100;
    const pHat = side === 'UP' ? zone.train.pHat : 1 - zone.train.pHat;
    const pLow = side === 'UP' ? zone.train.pLow : 1 - zone.train.pHigh;
    const edgeHat = pHat - entry;
    if (edgeHat < this._relaxedMinEdge) return 'relaxed-edge-below-min';
    const ciEdge = pLow - entry;
    if (ciEdge < this._relaxedMinCiEdge) return 'relaxed-ci-edge-below-min';
    if (this._relaxedRequireOos && !zone.oos?.passes) return 'relaxed-oos-not-passed';
    return undefined;
  }

  private _entryEdgeHat(zone: EdgeZone, entryBidCents: number, side: EntrySide): number {
    const pHat = side === 'UP' ? zone.train.pHat : 1 - zone.train.pHat;
    return pHat - entryBidCents / 100;
  }

  private _evaluateCexSignal(snapshot: StrategySnapshot): CryptoSignalResult | undefined {
    if (this._cexFilterMode === 'off') return undefined;
    return snapshot.cryptoSignals?.evaluate(this._cexSignalId, {
      venues: this._cexVenues,
      weights: this._cexWeights,
      linearInterceptUsd: this._cexLinearInterceptUsd,
      basisByVenue: this._cexBasisByVenue,
      confidenceByScore: this._cexConfidenceByScore,
      lookbackMs: this._cexLookbackMs,
      minBasisSamples: this._cexMinBasisSamples,
      staleMs: this._cexStaleMs,
      thresholdBps: this._cexThresholdBps,
      minVenueCount: this._cexMinVenueCount,
      maxSpreadBps: this._cexMaxSpreadBps,
    });
  }

  private _cexEntryRejectReason(data: CCData, side: EntrySide): string | undefined {
    if (this._cexFilterMode === 'off') return undefined;
    if (!data.cexSignal) return 'cex-signal-unavailable';
    if (this._cexRequireFresh && !data.cexFresh) return 'cex-signal-stale';

    const direction = this._cexDirectionForEntrySide(data.cexSignal.direction, side);
    if (this._cexFilterMode === 'agree') {
      return direction === 'up' ? undefined : 'cex-not-agree';
    }
    return direction === 'down' ? 'cex-adverse' : undefined;
  }

  private _cexDirectionForEntrySide(direction: CryptoSignalDirection, side: EntrySide): CryptoSignalDirection {
    if (side === 'UP' || direction === 'flat') return direction;
    return direction === 'up' ? 'down' : 'up';
  }

  /** Проверить все opt-in exit-условия. */
  private _checkExitConditions(data: CCData): string | undefined {
    if (this._exitMode === 'signal-normalized') {
      const signalExit = this._checkSignalNormalizedExit(data);
      if (signalExit) return signalExit;
    }
    if (this._exitOnTauTimeout && data.tauSec < this._exitTauSec) {
      return 'tau-timeout';
    }
    if (this._exitOnRegimeFlip && this._entryRegime && data.regime) {
      const opposite = (this._entryRegime === 'up' && data.regime === 'down')
        || (this._entryRegime === 'down' && data.regime === 'up');
      if (opposite) return 'regime-flip';
    }
    if (this._exitOnWeightDrop && data.zone) {
      if (data.zone.weights.composite < this._weightDropThreshold) return 'weight-drop';
    }
    if (this._exitOnEdgeClosure && data.zone) {
      const edgeCentsNow = data.zone.train.edge * 100;
      if (Math.abs(edgeCentsNow) < this._edgeClosureCents) return 'edge-closure';
    }
    return undefined;
  }

  private _checkSignalNormalizedExit(data: CCData): string | undefined {
    const elapsedMs = this._entryPlacedAtMs > 0 ? data.nowMs - this._entryPlacedAtMs : 0;
    if (elapsedMs >= this._maxSignalHoldMs) return 'signal-max-hold';

    if (!data.cexSignal || (this._cexRequireFresh && !data.cexFresh)) {
      return this._exitOnSignalStale ? 'signal-stale' : undefined;
    }

    const direction = this._cexDirectionForEntrySide(data.cexSignal.direction, this._entrySide ?? 'UP');
    if (Math.abs(data.cexSignal.value) <= this._normalizeThresholdBps || direction === 'flat') {
      return 'signal-normalized';
    }
    if (this._exitOnSignalFlip && direction === 'down') {
      return 'signal-flip';
    }
    return undefined;
  }

  /** Maker-first bid: bestBid+1¢ если спред позволяет, иначе bestBid. */
  private _computeEntryBidCents(side: SideData): number | undefined {
    if (side.bestBidCents === undefined || side.bestAskCents === undefined) return undefined;
    const aggressive = Math.round(side.bestBidCents) + 1;
    const bid = aggressive < Math.round(side.bestAskCents) ? aggressive : Math.round(side.bestBidCents);
    return Math.max(1, Math.min(99, bid));
  }

  /**
   * Exit-цена. Maker: bestAsk-1¢ (если спред позволяет), иначе bestAsk.
   * Панический тейкер: bestBid (немедленный выход cross-spread).
   */
  private _computeExitPriceCents(side: SideData, taker: boolean): number | undefined {
    if (side.bestBidCents === undefined || side.bestAskCents === undefined) return undefined;
    if (taker) {
      return Math.max(1, Math.min(99, Math.round(side.bestBidCents)));
    }
    const aggressive = Math.round(side.bestAskCents) - 1;
    const ask = aggressive > Math.round(side.bestBidCents) ? aggressive : Math.round(side.bestAskCents);
    return Math.max(1, Math.min(99, ask));
  }

  private _buildHedgeExit(data: CCData, exitReason: string): CCAction[] | undefined {
    if (this._exitMode !== 'signal-normalized' || !this._hedgeWhenUnavailable) {
      this._recordDecision(data, 'HOLD', 'exit-wait-token-availability');
      return [{ type: 'STOP' }];
    }

    const elapsedMs = this._entryPlacedAtMs > 0 ? data.nowMs - this._entryPlacedAtMs : Number.POSITIVE_INFINITY;
    if (elapsedMs >= this._tokenAvailabilityDelayMs) {
      this._recordDecision(data, 'HOLD', 'await-available-token-after-delay');
      return [{ type: 'STOP' }];
    }

    const hedgeTarget = this._resolveHedgeTarget(data);
    if (!hedgeTarget || hedgeTarget.bestAskCents === undefined) {
      this._recordDecision(data, 'HOLD', 'hedge-side-unavailable');
      return [{ type: 'STOP' }];
    }

    const hedgePriceCents = Math.max(1, Math.min(99, Math.round(hedgeTarget.bestAskCents)));
    const targetShares = this._effectiveEntryShares(data);
    if (targetShares.lte(0)) {
      this._recordDecision(data, 'HOLD', 'hedge-target-shares-zero');
      return [{ type: 'STOP' }];
    }

    const hedgeSize = this._grossHedgeSharesForTargetShares(targetShares, hedgePriceCents);
    if (hedgeSize.lt(data.minOrderSize)) {
      this._recordDecision(data, 'HOLD', 'hedge-below-min-order-size', { bidCents: hedgePriceCents, size: hedgeSize, taker: true });
      return [{ type: 'STOP' }];
    }

    const hedgeNotional = hedgeSize.mul(new Decimal(hedgePriceCents).div(100));
    if (hedgeNotional.lt(data.minOrderValue)) {
      this._recordDecision(data, 'HOLD', 'hedge-below-min-order-value', { bidCents: hedgePriceCents, size: hedgeSize, taker: true });
      return [{ type: 'STOP' }];
    }
    if (hedgeNotional.gt(data.availableBalance)) {
      this._recordDecision(data, 'HOLD', 'hedge-insufficient-balance', { bidCents: hedgePriceCents, size: hedgeSize, taker: true });
      return [{ type: 'STOP' }];
    }

    const lockedProfitCents = this._lockedProfitCents(targetShares, hedgeSize, hedgePriceCents);
    if (lockedProfitCents < this._minLockedProfitCents) {
      this._recordDecision(data, 'HOLD', 'hedge-profit-below-threshold', { bidCents: hedgePriceCents, size: hedgeSize, taker: true });
      return [{ type: 'STOP' }];
    }

    if (hedgeTarget.openBuyAtCents === hedgePriceCents) {
      this._recordDecision(data, 'HOLD', 'open-hedge-buy-same-price', { bidCents: hedgePriceCents, size: hedgeSize, taker: true });
      return [];
    }

    this._logger?.warn('CalibratedCrowd: HEDGE', {
      entrySide: this._entrySide ?? 'n/a',
      hedgeSide: hedgeTarget.side,
      reason: exitReason,
      bid: hedgePriceCents,
      size: hedgeSize.toFixed(4),
      lockedProfitCents: lockedProfitCents.toFixed(3),
      elapsedMs,
      cexDirection: data.cexDirectionForToken,
      cexValueBps: data.cexSignal?.value.toFixed(3),
    });

    this._recordDecision(data, 'BUY', `${exitReason}-hedge`, {
      bidCents: hedgePriceCents,
      size: hedgeSize,
      taker: true,
    });
    return [{
      type: 'POST_BID',
      bidCents: hedgePriceCents,
      size: hedgeSize,
      postOnly: false,
      targetInstrumentId: hedgeTarget.targetInstrumentId,
      targetAsset: hedgeTarget.targetAsset,
    }];
  }

  private _resolveHedgeTarget(data: CCData): SideData | undefined {
    if (this._entrySide === 'UP') return data.complementary;
    if (this._entrySide === 'DOWN') return data.primary;
    return undefined;
  }

  private _effectiveEntryShares(data: CCData): Decimal {
    const exitTarget = this._resolveExitTarget(data);
    if (exitTarget?.positionQty.gt(0)) return exitTarget.positionQty;
    if (this._entrySize.gt(0)) return this._entrySize;
    if (this._entrySide === 'UP') return data.primary.positionQty;
    if (this._entrySide === 'DOWN') return data.complementary?.positionQty ?? new Decimal(0);
    return new Decimal(0);
  }

  private _grossHedgeSharesForTargetShares(targetShares: Decimal, hedgePriceCents: number): Decimal {
    const hedgePrice = hedgePriceCents / 100;
    const netRatio = Math.max(0.0001, 1 - 0.072 * (1 - hedgePrice));
    return targetShares.div(netRatio).toDecimalPlaces(4, Decimal.ROUND_UP);
  }

  private _lockedProfitCents(targetShares: Decimal, hedgeGrossShares: Decimal, hedgePriceCents: number): number {
    const entryPrice = this._entryPriceCents / 100;
    const hedgePrice = hedgePriceCents / 100;

    const entryFeeDollars = this._entryPostOnly
      ? 0
      : calculatePolymarketTakerFeeNumber(this._entrySize.toNumber(), entryPrice);
    const entryFeeShares = entryPrice > 0 ? new Decimal(entryFeeDollars).div(entryPrice) : new Decimal(0);
    const entryNetShares = Decimal.max(new Decimal(0), this._entrySize.minus(entryFeeShares));

    const hedgeFeeDollars = calculatePolymarketTakerFeeNumber(hedgeGrossShares.toNumber(), hedgePrice);
    const hedgeFeeShares = hedgePrice > 0 ? new Decimal(hedgeFeeDollars).div(hedgePrice) : new Decimal(0);
    const hedgeNetShares = Decimal.max(new Decimal(0), hedgeGrossShares.minus(hedgeFeeShares));

    const guaranteedPayout = Decimal.min(entryNetShares, hedgeNetShares, targetShares);
    const entryCost = this._entrySize.mul(entryPrice).plus(entryFeeDollars);
    const hedgeCost = hedgeGrossShares.mul(hedgePrice).plus(hedgeFeeDollars);
    const perSharePnl = guaranteedPayout.minus(entryCost).minus(hedgeCost)
      .div(Decimal.max(this._entrySize, new Decimal(1)));
    return perSharePnl.mul(100).toNumber();
  }

  /**
   * Подогнать размер под `minOrderValue`. Возвращает undefined если не получится.
   */
  private _ensureMinSize(
    size: Decimal,
    priceCents: number,
    minOrderValue: Decimal,
  ): Decimal | undefined {
    const priceDollars = new Decimal(priceCents).div(100);
    if (priceDollars.lte(0)) return undefined;
    if (size.mul(priceDollars).gte(minOrderValue)) return size;
    const minSize = minOrderValue.div(priceDollars).ceil();
    return minSize;
  }

  // ── toIntents ───────────────────────────────────────────────────────────────

  protected toIntents(actions: CCAction[]): StrategyIntent[] {
    const intents: StrategyIntent[] = [];
    for (const a of actions) {
      if (a.type === 'STOP') {
        intents.push({ type: 'CANCEL_ALL' });
        continue;
      }
      if (a.type === 'CANCEL_OPEN') {
        for (const orderId of a.orderIds) {
          intents.push({ type: 'CANCEL', orderId });
        }
        continue;
      }
      intents.push({ type: 'CANCEL_ALL' });
      // Атомарная пара target-полей: либо оба, либо ни одного (placeTarget).
      const target = placeTarget(a.targetInstrumentId, a.targetAsset);
      if (a.type === 'POST_BID') {
        const base = {
          type: 'PLACE' as const,
          side: 'BUY' as const,
          price: Price.of(new Decimal(a.bidCents).div(100)),
          size: Quantity.of(a.size),
          postOnly: a.postOnly,
        };
        intents.push(target ? { ...base, ...target } : base);
      } else {
        const base = {
          type: 'PLACE' as const,
          side: 'SELL' as const,
          price: Price.of(new Decimal(a.askCents).div(100)),
          size: Quantity.of(a.size),
          postOnly: !a.taker,
        };
        intents.push(target ? { ...base, ...target } : base);
      }
    }
    return intents;
  }
}
