/**
 * SelectiveEntryStrategy — buy-and-hold до settlement на основе delta% и zone filter.
 *
 * @remarks
 * Стратегия непрерывно оценивает рынок и управляет ордером:
 * - Если условия входа выполняются и нет ордера → ставим BUY
 * - Если условия ухудшились и ордер стоит → снимаем (CANCEL)
 * - Если условия вернулись → ставим снова
 * - Если получили fill (полный или partial) → держим до settlement
 * - Если partial fill + ордер стоит + условия плохие → cancel остаток
 *
 * ### Алгоритм:
 * 1. Ждём warmup (60s по умолчанию), накапливаем EWMA mid обоих токенов (alpha=0.3 per trade)
 *    В конце warmup фиксируем snapshot (EWMA, delta) для momentum/acceleration фильтров.
 * 2. Auto-selection (side='auto', default):
 *    - delta > 0 (BTC выше strike) → покупаем UP (primary) токен
 *    - delta < 0 (BTC ниже strike) → покупаем DOWN (comp) токен
 * 3. Проверяем условия входа (все должны быть true):
 *    - Mid выбранного токена в зоне [minZone, maxZone] (default 55-68¢)
 *    - |delta%| в диапазоне [minDelta, maxDelta] (default 0.03-0.12%)
 *    - Tau в диапазоне [minTau, maxTau] (default 120-210s)
 *    - Spread < maxSpread (default 4¢)
 *    - (optional) Rise >= minRiseCents — momentum: EWMA растёт с момента warmup
 *    - (optional) UP+DOWN discrepancy <= compMaxDiscrepancyCents — оба токена согласованы
 *    - (optional) Direction-aware delta acceleration > minDeltaAccel — BTC уходит от strike
 *    - (optional) Veto если rise ниже vetoRiseBelowCents или comp discrepancy выше vetoCompDiscrepancyAboveCents
 * 4. Ставим limit BUY по mid - 1¢ (maker)
 * 5. На каждом тике переоцениваем: если ордер стоит и фильтры не проходят → CANCEL
 * 6. Держим позицию до settlement. Нет exit logic.
 *
 * ### Почему это работает:
 * При mid=62¢ и P(UP)≈75%, EV = 0.75×38 - 0.25×62 = +13¢/trade.
 * Нет overfit на exit logic, нет adverse selection (одна сделка).
 *
 * @example
 * ```typescript
 * const strategy = new SelectiveEntryStrategy({
 *   orderSize: new Decimal(5),
 *   minZoneCents: 55, maxZoneCents: 68,
 *   minDeltaPct: 0.03, maxDeltaPct: 0.12,
 *   minTauSec: 120, maxTauSec: 210,
 *   minRiseCents: 3,
 * });
 * ```
 */
import { BaseStrategy } from '@polymarket/strategy';
import { placeTarget } from '@polymarket/strategy';
import type { StrategySnapshot, StrategyIntent, TriggerReason } from '@polymarket/strategy';
import { OutcomePrice, Quantity } from '@polymarket/value-objects';
import type { ILogger } from '@polymarket/logger';
import type { InstrumentId, AssetId, StrategyId } from '@polymarket/ids';
import { unsafeStrategyId } from '@polymarket/ids';
import type { IDecisionJournal } from '@polymarket/ports';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- внутренний Decimal-конвент apps/bot/strategies/*, см. docs/architecture/boundary-contract.md, Решение 11
import Decimal from 'decimal.js';

// ── Конфигурация ──────────────────────────────────────────────────────────────

/**
 * Параметры SelectiveEntryStrategy.
 *
 * @param orderSize - Размер ордера в токенах
 * @param minZoneCents - Нижняя граница зоны покупки (default 55)
 * @param maxZoneCents - Верхняя граница зоны покупки (default 68)
 * @param minDeltaPct - Минимальный delta% для входа (default 0.03)
 * @param maxDeltaPct - Максимальный delta% для входа (default 0.12)
 * @param minTauSec - Минимальный tau для входа (default 120)
 * @param maxTauSec - Максимальный tau для входа (default 210)
 * @param maxSpreadCents - Максимальный spread для входа (default 4)
 * @param warmupSec - Секунды ожидания перед торговлей (default 60)
 * @param bidOffsetCents - Скидка от mid для limit BUY (default 1)
 */
export interface SelectiveEntryConfig {
  readonly orderSize: Decimal;
  readonly minZoneCents?: number;
  readonly maxZoneCents?: number;
  readonly minDeltaPct?: number;
  readonly maxDeltaPct?: number;
  readonly minTauSec?: number;
  readonly maxTauSec?: number;
  readonly maxSpreadCents?: number;
  readonly warmupSec?: number;
  readonly bidOffsetCents?: number;
  /**
   * Направление: 'up' = покупаем UP токен (delta > 0), 'down' = покупаем DOWN токен (delta < 0),
   * 'auto' = автоматический выбор по знаку delta (положительный → UP, отрицательный → DOWN).
   * Default 'auto'.
   */
  readonly side?: 'up' | 'down' | 'auto';

  // ── Новые фильтры (ablation study) ──

  /**
   * Минимальный рост EWMA с момента warmup snapshot (центы).
   * rise = ewma_now - ewma_at_warmup_end. Undefined = отключён.
   *
   * @remarks Momentum-фильтр: если mid растёт после warmup, тренд подтверждён.
   */
  readonly minRiseCents?: number;

  /**
   * Ждать X% жизни рынка перед принятием решения. Undefined = использовать warmupSec + tauSec.
   *
   * @remarks waitPct=0.4 на 5-мин рынке = 120s. Больше информации → лучше прогноз.
   */
  readonly waitPct?: number;

  /**
   * Максимальная дискрепанция UP+DOWN от 100¢. Undefined = отключён.
   *
   * @remarks Если |upMid + downMid - 100| > threshold → рынок не согласован, сигнал ненадёжный.
   */
  readonly compMaxDiscrepancyCents?: number;

  /**
   * Требовать delta acceleration > 0 (BTC уходит от strike, а не возвращается).
   * Для нового числового порога используйте minDeltaAccel.
   * Default false.
   */
  readonly requireDeltaAccel?: boolean;
  /**
   * Минимальное direction-aware delta acceleration для входа:
   * UP использует delta_now - delta_at_warmup, DOWN использует обратный знак.
   * Undefined + requireDeltaAccel=true сохраняет старое raw-поведение: deltaAccel > 0.
   */
  readonly minDeltaAccel?: number;
  /**
   * Мягкий veto: если rise известен и ниже порога, вход запрещён.
   * В отличие от minRiseCents, отсутствие rise не блокирует вход.
   */
  readonly vetoRiseBelowCents?: number;
  /**
   * Мягкий veto: если comp discrepancy известна и выше порога, вход запрещён.
   * В отличие от compMaxDiscrepancyCents, отсутствие comp-data не блокирует вход.
   */
  readonly vetoCompDiscrepancyAboveCents?: number;
  /** true = price from live orderbook, false = legacy mid-offset pricing. Default true. */
  readonly useBookAnchoredMakerPricing?: boolean;
  /** true = place entry orders as post-only. Default true. */
  readonly postOnly?: boolean;
  /** Reprice stale maker order after N seconds by cancelling and re-entering on the next tick. Default 5. */
  readonly makerRepriceAfterSec?: number;
}

// ── Внутренние типы ───────────────────────────────────────────────────────────

interface SEData {
  readonly midCents: number;
  readonly spreadCents: number;
  readonly bestBidCents: number | null;
  readonly bestAskCents: number | null;
  readonly compSpreadCents: number | null;
  readonly compBestBidCents: number | null;
  readonly compBestAskCents: number | null;
  readonly tickSizeCents: number;
  readonly deltaPct: number | undefined;
  readonly tauSec: number;
  /** Есть позиция (full или partial fill получен) */
  readonly hasPosition: boolean;
  /** Есть отменяемый ордер на бирже (LIVE status) */
  readonly hasOpenOrder: boolean;
  /** Fill в пути (MATCHED/MINED) — нельзя отменить, ждём */
  readonly hasInFlightFill: boolean;
  readonly availableBalance: Decimal;
  readonly nowMs: number;
  readonly cryptoPrice: number | undefined;
  readonly strikePrice: number | undefined;
  /** EWMA комплементарного токена (центы). null если нет данных. */
  readonly compMidCents: number | null;
  /** ID комплементарного инструмента (для auto-selection). */
  readonly complementaryInstrumentId: InstrumentId | undefined;
  /** AssetId комплементарного инструмента (для auto-selection). */
  readonly complementaryAsset: AssetId | undefined;
  /** Rise = ewma_now - ewma_at_warmup (центы). null если нет snapshot. */
  readonly riseCents: number | null;
  /** Delta acceleration = delta_now - delta_at_warmup. null если нет snapshot. */
  readonly deltaAccel: number | null;
  /** Дискрепанция UP+DOWN: |upMid + downMid - 100|. null если нет comp data. */
  readonly compDiscrepancy: number | null;
  /** Текущая цена открытого ордера стратегии (центы). */
  readonly openOrderPriceCents: number | null;
  /** Возраст открытого ордера стратегии в секундах. */
  readonly openOrderAgeSec: number | null;
  /** true если видимый открытый ордер стоит на комплементарном токене. */
  readonly openOrderOnComplementary: boolean;
}

type SEAction =
  | {
      readonly type: 'BUY';
      readonly price: number;
      readonly size: Decimal;
      /** Если покупаем комплементарный токен — ID целевого инструмента */
      readonly targetInstrumentId?: InstrumentId;
      /** Если покупаем комплементарный токен — AssetId целевого инструмента */
      readonly targetAsset?: AssetId;
    }
  | { readonly type: 'HOLD' }
  | { readonly type: 'CANCEL' };

// ── Реализация ────────────────────────────────────────────────────────────────

export class SelectiveEntryStrategy extends BaseStrategy<SEData, SEAction> {
  public readonly id: StrategyId;
  public readonly name = 'SelectiveEntryStrategy';

  private readonly _logger: ILogger | undefined;
  private readonly _journal: IDecisionJournal | undefined;
  private readonly _orderSize: Decimal;
  private readonly _minZone: number;
  private readonly _maxZone: number;
  private readonly _minDelta: number;
  private readonly _maxDelta: number;
  private readonly _minTau: number;
  private readonly _maxTau: number;
  private readonly _maxSpread: number;
  private readonly _warmupSec: number;
  private readonly _bidOffset: number;
  private readonly _side: 'up' | 'down' | 'auto';
  private readonly _minRise: number | undefined;
  private readonly _waitPct: number | undefined;
  private readonly _compMaxDiscrep: number | undefined;
  private readonly _minDeltaAccel: number | undefined;
  private readonly _useDirectionalDeltaAccel: boolean;
  private readonly _deltaAccelCancelThreshold: number | undefined;
  private readonly _vetoRiseBelow: number | undefined;
  private readonly _vetoCompDiscrepancyAbove: number | undefined;
  private readonly _useBookAnchoredMakerPricing: boolean;
  private readonly _postOnly: boolean;
  private readonly _makerRepriceAfterSec: number;

  /** EWMA mid-price (центы) — основной токен */
  private _ewma: number | null = null;
  private _tradeCount = 0;
  private _lastTradeTimestampMs = 0;

  /** EWMA mid-price (центы) — комплементарный токен */
  private _compEwma: number | null = null;
  private _compTradeCount = 0;
  private _compLastTradeTimestampMs = 0;

  /** Snapshot at warmup end (для rise и deltaAccel) */
  private _ewmaAtWarmup: number | null = null;
  private _deltaAtWarmup: number | null = null;
  private _warmupSnapshotCaptured = false;

  /** Смена рынка */
  private _currentExpirationMs = 0;
  private _marketEventStartMs = 0;
  private _marketDurationMs = 0;
  /** ID текущего рынка (для журнала) */
  private _currentMarketId = '';

  /**
   * Guard от double-entry: ставится в true когда decide() возвращает BUY,
   * сбрасывается когда ордер появляется в snapshot (hasOpenOrder) или fill получен.
   * Закрывает окно между решением BUY и появлением ордера в repo (~600ms HTTP roundtrip).
   */
  private _pendingPlace = false;

  /** Время последнего диагностического лога (throttle) */
  private _lastDiagMs = 0;

  /** Время последнего gather-диагностического лога (throttle) */
  private _lastGatherDiagMs = 0;

  /** Счётчики фильтров (за текущий рынок) */
  private _rejectCounts = { noDelta: 0, deltaSign: 0, zone: 0, deltaRange: 0, tau: 0, spread: 0, balance: 0, rise: 0, riseVeto: 0, compDiscrep: 0, compDiscrepVeto: 0, deltaAccel: 0 };
  private _buyAttempts = 0;
  private _cancelAfterPlace = 0;
  private _repricePending = false;

  constructor(config: SelectiveEntryConfig, strategyId: StrategyId = unsafeStrategyId('selective-entry-1'), logger?: ILogger, journal?: IDecisionJournal) {
    super();
    this.id = strategyId;
    this._logger = logger;
    this._journal = journal;
    this._orderSize = config.orderSize;
    this._minZone = config.minZoneCents ?? 55;
    this._maxZone = config.maxZoneCents ?? 68;
    this._minDelta = config.minDeltaPct ?? 0.03;
    this._maxDelta = config.maxDeltaPct ?? 0.12;
    this._minTau = config.minTauSec ?? 120;
    this._maxTau = config.maxTauSec ?? 210;
    this._maxSpread = config.maxSpreadCents ?? 4;
    this._warmupSec = config.warmupSec ?? 60;
    this._bidOffset = config.bidOffsetCents ?? 1;
    this._side = config.side ?? 'auto';
    this._minRise = config.minRiseCents;
    this._waitPct = config.waitPct;
    this._compMaxDiscrep = config.compMaxDiscrepancyCents;
    const requireDeltaAccel = config.requireDeltaAccel ?? false;
    this._useDirectionalDeltaAccel = config.minDeltaAccel !== undefined;
    this._minDeltaAccel = config.minDeltaAccel ?? (requireDeltaAccel ? 0 : undefined);
    this._deltaAccelCancelThreshold = this._minDeltaAccel !== undefined
      ? this._minDeltaAccel - 0.01
      : undefined;
    this._vetoRiseBelow = config.vetoRiseBelowCents;
    this._vetoCompDiscrepancyAbove = config.vetoCompDiscrepancyAboveCents;
    this._useBookAnchoredMakerPricing = config.useBookAnchoredMakerPricing ?? true;
    this._postOnly = config.postOnly ?? true;
    this._makerRepriceAfterSec = config.makerRepriceAfterSec ?? 5;

    this._logger?.warn('SelectiveEntry: init', {
      side: this._side,
      zone: `${this._minZone}-${this._maxZone}`,
      delta: `${this._minDelta}-${this._maxDelta}%`,
      tau: `${this._minTau}-${this._maxTau}s`,
      maxSpread: this._maxSpread,
      warmup: this._warmupSec,
      bidOffset: this._bidOffset,
      minRise: this._minRise ?? 'off',
      vetoRiseBelow: this._vetoRiseBelow ?? 'off',
      waitPct: this._waitPct ?? 'off',
      compMaxDiscrep: this._compMaxDiscrep ?? 'off',
      vetoCompDiscrepAbove: this._vetoCompDiscrepancyAbove ?? 'off',
      deltaAccel: this._minDeltaAccel !== undefined ? `>${this._minDeltaAccel}` : 'off',
      deltaAccelMode: this._minDeltaAccel !== undefined
        ? (this._useDirectionalDeltaAccel ? 'directional' : 'legacy_raw')
        : 'off',
      deltaAccelCancelBelow: this._deltaAccelCancelThreshold ?? 'off',
      bookAnchoredMakerPricing: this._useBookAnchoredMakerPricing ? 'on' : 'off',
      postOnly: this._postOnly ? 'on' : 'off',
      makerRepriceAfterSec: this._makerRepriceAfterSec,
    });
  }

  public get stats(): { buyAttempts: number; cancelAfterPlace: number } {
    return {
      buyAttempts: this._buyAttempts,
      cancelAfterPlace: this._cancelAfterPlace,
    };
  }

  // ── gather ──────────────────────────────────────────────────────────────────

  protected gather(snapshot: StrategySnapshot): SEData | undefined {
    const expiresMs = snapshot.market.expirationMs;

    // Смена рынка → сброс
    if (this._currentExpirationMs !== expiresMs) {
      this._currentExpirationMs = expiresMs;
      this._ewma = null;
      this._tradeCount = 0;
      this._lastTradeTimestampMs = 0;
      this._compEwma = null;
      this._compTradeCount = 0;
      this._compLastTradeTimestampMs = 0;
      this._ewmaAtWarmup = null;
      this._deltaAtWarmup = null;
      this._warmupSnapshotCaptured = false;
      this._pendingPlace = false;
      this._lastDiagMs = 0;
      this._rejectCounts = { noDelta: 0, deltaSign: 0, zone: 0, deltaRange: 0, tau: 0, spread: 0, balance: 0, rise: 0, riseVeto: 0, compDiscrep: 0, compDiscrepVeto: 0, deltaAccel: 0 };
      this._buyAttempts = 0;
      this._cancelAfterPlace = 0;
      this._repricePending = false;

      if (snapshot.eventStartMs !== undefined) {
        const eventStartMs = snapshot.eventStartMs.toNumber();
        this._marketEventStartMs = eventStartMs;
        this._marketDurationMs = expiresMs - eventStartMs;
        this._currentMarketId = String(snapshot.instrumentId);
        this._logger?.warn('SelectiveEntry: new market', {
          expiresMs,
          eventStartMs,
          instrumentId: snapshot.instrumentId,
        });
      } else {
        this._logger?.warn('SelectiveEntry: no eventStartMs, skipping market');
        return undefined;
      }
    }

    if (this._marketEventStartMs <= 0) {
      this._logger?.warn('SelectiveEntry: marketEventStartMs not set');
      return undefined;
    }

    // EWMA из trade tape (fixed alpha=0.3 per trade)
    const tapeRecords = snapshot.tradeTape?.getAll();
    if (tapeRecords && tapeRecords.length > 0) {
      for (const trade of tapeRecords) {
        const tradeTs = trade.timestamp.toNumber();
        if (tradeTs <= this._lastTradeTimestampMs) continue;
        const priceNum = trade.price.value().toNumber() * 100;
        this._ewma = this._ewma === null
          ? priceNum
          : 0.3 * priceNum + 0.7 * this._ewma;
        this._tradeCount++;
        this._lastTradeTimestampMs = tradeTs;
      }
    }

    // Fallback на topOfBook (работает и при _ewma !== null для набора tradeCount)
    if (this._tradeCount < 3 && snapshot.topOfBook) {
      const bid = snapshot.topOfBook.bestBid?.value().toNumber();
      const ask = snapshot.topOfBook.bestAsk?.value().toNumber();
      if (bid !== undefined && ask !== undefined) {
        const bookMid = ((bid + ask) / 2) * 100;
        this._ewma = this._ewma === null ? bookMid : 0.5 * bookMid + 0.5 * this._ewma;
        this._tradeCount++;
      }
    }

    // ── Комплементарный токен EWMA (fixed alpha=0.3, для auto-selection) ──
    const compTapeRecords = snapshot.complementaryTradeTape?.getAll();
    if (compTapeRecords && compTapeRecords.length > 0) {
      for (const trade of compTapeRecords) {
        const tradeTs = trade.timestamp.toNumber();
        if (tradeTs <= this._compLastTradeTimestampMs) continue;
        const priceNum = trade.price.value().toNumber() * 100;
        this._compEwma = this._compEwma === null
          ? priceNum
          : 0.3 * priceNum + 0.7 * this._compEwma;
        this._compTradeCount++;
        this._compLastTradeTimestampMs = tradeTs;
      }
    }

    if (this._ewma === null || this._tradeCount < 3) {
      const now = snapshot.nowMs;
      if (now - this._lastGatherDiagMs >= 5_000) {
        this._lastGatherDiagMs = now;
        this._logger?.info('SelectiveEntry: gather waiting', {
          ewma: this._ewma?.toFixed(1) ?? 'null',
          tradeCount: this._tradeCount,
          hasTape: !!snapshot.tradeTape,
          tapeSize: snapshot.tradeTape?.getAll().length ?? 0,
          hasBook: !!snapshot.topOfBook,
          bestBid: snapshot.topOfBook?.bestBid?.value().toNumber(),
          bestAsk: snapshot.topOfBook?.bestAsk?.value().toNumber(),
        });
      }
      return undefined;
    }

    const tauSec = Math.max(0, (expiresMs - snapshot.nowMs) / 1000);

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
    let compSpreadCents: number | null = null;
    let compBestBidCents: number | null = null;
    let compBestAskCents: number | null = null;
    if (snapshot.complementaryTopOfBook) {
      const bid = snapshot.complementaryTopOfBook.bestBid?.value().toNumber();
      const ask = snapshot.complementaryTopOfBook.bestAsk?.value().toNumber();
      if (bid !== undefined && ask !== undefined) {
        compSpreadCents = (ask - bid) * 100;
        compBestBidCents = bid * 100;
        compBestAskCents = ask * 100;
      }
    }
    const tickSizeCents = (snapshot.constraints?.tickSize.value().toNumber() ?? 0.01) * 100;

    // Delta% из crypto price
    let deltaPct: number | undefined;
    let cryptoPrice: number | undefined;
    let strikePrice: number | undefined;
    if (snapshot.cryptoPrice) {
      const currentPrice = snapshot.cryptoPrice.currentPrice;
      const targetPrice = snapshot.cryptoPrice.targetPrice;
      if (currentPrice > 0 && targetPrice && targetPrice > 0) {
        cryptoPrice = currentPrice;
        strikePrice = targetPrice;
        deltaPct = ((currentPrice - targetPrice) / targetPrice) * 100;
      }
    }

    // Warmup + waitPct
    const warmupElapsed = snapshot.nowMs - this._marketEventStartMs;
    const warmupMs = this._warmupSec * 1000;
    if (warmupElapsed < warmupMs) {
      const now = snapshot.nowMs;
      if (now - this._lastGatherDiagMs >= 5_000) {
        this._lastGatherDiagMs = now;
        this._logger?.info('SelectiveEntry: warmup', {
          elapsed: (warmupElapsed / 1000).toFixed(0) + 's',
          need: this._warmupSec + 's',
          ewma: this._ewma?.toFixed(1),
          tradeCount: this._tradeCount,
        });
      }
      return undefined;
    }

    // Фиксируем snapshot в момент окончания warmup (для rise и deltaAccel)
    if (!this._warmupSnapshotCaptured) {
      this._warmupSnapshotCaptured = true;
      this._ewmaAtWarmup = this._ewma;
      this._deltaAtWarmup = deltaPct ?? null;
    }

    // waitPct: если задан, ждём X% жизни рынка (вместо tau фильтра)
    if (this._waitPct !== undefined && this._marketDurationMs > 0) {
      const pctElapsed = (snapshot.nowMs - this._marketEventStartMs) / this._marketDurationMs;
      if (pctElapsed < this._waitPct) {
        return undefined;
      }
    }

    // Вычисляем новые сигналы
    const riseCents = this._ewmaAtWarmup !== null ? this._ewma - this._ewmaAtWarmup : null;
    const deltaAccel = (deltaPct !== undefined && this._deltaAtWarmup !== null)
      ? deltaPct - this._deltaAtWarmup
      : null;
    const compDiscrepancy = this._compEwma !== null
      ? Math.abs(this._ewma + this._compEwma - 100)
      : null;

    // Portfolio — проверяем обе позиции (primary и comp)
    const primaryPos = snapshot.portfolio?.getPosition(snapshot.instrumentId);
    const compPos = snapshot.complementaryInstrumentId
      ? snapshot.portfolio?.getPosition(snapshot.complementaryInstrumentId)
      : undefined;
    const primaryQty = primaryPos?.quantity.value() ?? new Decimal(0);
    const compQty = compPos?.quantity.value() ?? new Decimal(0);
    const availableBalance = snapshot.portfolio?.balance.available().value() ?? new Decimal(0);
    const openOrder = snapshot.openOrders[0] ?? snapshot.complementaryOpenOrders?.[0];
    const openOrderOnComplementary =
      snapshot.openOrders.length === 0 &&
      (snapshot.complementaryOpenOrders?.length ?? 0) > 0;
    const openOrderPriceCents = openOrder ? openOrder.price.value().toNumber() * 100 : null;
    const openOrderAgeSec = openOrder
      ? Math.max(0, (snapshot.nowMs - openOrder.timestamp.toNumber()) / 1000)
      : null;

    return {
      midCents: this._ewma,
      spreadCents,
      bestBidCents,
      bestAskCents,
      compSpreadCents,
      compBestBidCents,
      compBestAskCents,
      tickSizeCents,
      deltaPct,
      tauSec,
      hasPosition: primaryQty.gt(0) || compQty.gt(0),
      hasOpenOrder: snapshot.openOrders.length > 0 || (snapshot.complementaryOpenOrders?.length ?? 0) > 0,
      hasInFlightFill:
        snapshot.hasInFlightFills ||
        snapshot.matchedOrders.length > 0 ||
        (snapshot.hasComplementaryInFlightFills ?? false) ||
        ((snapshot.complementaryMatchedOrders?.length ?? 0) > 0),
      availableBalance,
      nowMs: snapshot.nowMs,
      cryptoPrice,
      strikePrice,
      compMidCents: this._compEwma,
      complementaryInstrumentId: snapshot.complementaryInstrumentId,
      complementaryAsset: snapshot.complementaryAsset,
      riseCents,
      deltaAccel,
      compDiscrepancy,
      openOrderPriceCents,
      openOrderAgeSec,
      openOrderOnComplementary,
    };
  }

  // ── decide ──────────────────────────────────────────────────────────────────

  protected decide(data: SEData, _reasons: ReadonlySet<TriggerReason>): SEAction[] {
    // Fill в пути (MATCHED/MINED) → ждём, ничего не делаем
    if (data.hasInFlightFill) {
      return [{ type: 'HOLD' }];
    }

    // Ордер появился в snapshot → сбрасываем pending guard
    if (data.hasOpenOrder || data.hasPosition) {
      this._pendingPlace = false;
    }
    if (!data.hasOpenOrder) {
      this._repricePending = false;
    }

    // Есть открытый ордер → переоцениваем фильтры, cancel если условия ушли
    if (data.hasOpenOrder) {
      return this._evaluateOpenOrder(data);
    }

    // Есть позиция (fill получен), нет открытого ордера → hold до settlement
    if (data.hasPosition) {
      return [{ type: 'HOLD' }];
    }

    // Guard: BUY уже решён, ждём пока ордер появится в snapshot (~600ms HTTP roundtrip)
    if (this._pendingPlace) {
      return [{ type: 'HOLD' }];
    }

    // ── Определяем направление (auto-selection) ──
    // side='auto': delta > 0 → buy UP (primary), delta < 0 → buy DOWN (comp)
    // side='up'/'down': фиксированное направление
    let effectiveSide: 'up' | 'down';
    if (this._side === 'auto') {
      if (data.deltaPct === undefined) {
        this._rejectCounts.noDelta++;
        this._logDiag(data, 'auto', 'no_delta');
        return [{ type: 'HOLD' }];
      }
      effectiveSide = data.deltaPct > 0 ? 'up' : 'down';
    } else {
      effectiveSide = this._side;
    }

    // Для comp покупки — используем comp EWMA как mid price
    const buyingComp = effectiveSide === 'down';
    const mid = buyingComp
      ? (data.compMidCents !== null
          ? Math.round(Math.max(2, Math.min(98, data.compMidCents)))
          : null)
      : Math.round(Math.max(2, Math.min(98, data.midCents)));

    // Нет данных о цене comp токена
    if (mid === null) {
      this._rejectCounts.noDelta++;
      this._logDiag(data, effectiveSide, 'no_comp_ewma');
      return [{ type: 'HOLD' }];
    }

    // ── Проверяем каждый фильтр ──
    const absDelta = data.deltaPct !== undefined ? Math.abs(data.deltaPct) : undefined;
    const effectiveSpread = buyingComp
      ? (data.compSpreadCents ?? data.spreadCents)
      : data.spreadCents;
    const effectiveDeltaAccel = this._effectiveDeltaAccel(data, effectiveSide);
    let rejectReason = '';

    if (data.deltaPct === undefined) {
      this._rejectCounts.noDelta++;
      rejectReason = 'no_delta';
    } else if (this._side !== 'auto') {
      // Для фиксированного side проверяем знак delta
      const wrongSign = this._side === 'up'
        ? data.deltaPct <= 0
        : data.deltaPct >= 0;
      if (wrongSign) {
        this._rejectCounts.deltaSign++;
        rejectReason = `delta_wrong_sign(${data.deltaPct.toFixed(4)}%,need=${this._side})`;
      }
    }

    if (!rejectReason) {
      if (buyingComp && this._postOnly && (data.compBestBidCents === null || data.compBestAskCents === null)) {
        rejectReason = 'no_comp_book_for_post_only';
      } else if (mid < this._minZone || mid > this._maxZone) {
        this._rejectCounts.zone++;
        rejectReason = `zone(mid=${mid},need=${this._minZone}-${this._maxZone})`;
      } else if (absDelta! < this._minDelta || absDelta! > this._maxDelta) {
        this._rejectCounts.deltaRange++;
        rejectReason = `delta(${absDelta!.toFixed(4)}%,need=${this._minDelta}-${this._maxDelta})`;
      } else if (data.tauSec < this._minTau || data.tauSec > this._maxTau) {
        this._rejectCounts.tau++;
        rejectReason = `tau(${data.tauSec.toFixed(0)}s,need=${this._minTau}-${this._maxTau})`;
      } else if (effectiveSpread > this._maxSpread) {
        this._rejectCounts.spread++;
        rejectReason = `spread(${effectiveSpread.toFixed(1)},max=${this._maxSpread})`;
      } else if (this._minRise !== undefined && (data.riseCents === null || data.riseCents < this._minRise)) {
        this._rejectCounts.rise++;
        rejectReason = `rise(${data.riseCents?.toFixed(1) ?? '?'},need>=${this._minRise})`;
      } else if (this._vetoRiseBelow !== undefined && data.riseCents !== null && data.riseCents < this._vetoRiseBelow) {
        this._rejectCounts.riseVeto++;
        rejectReason = `rise_veto(${data.riseCents.toFixed(1)},min=${this._vetoRiseBelow})`;
      } else if (this._compMaxDiscrep !== undefined && (data.compDiscrepancy === null || data.compDiscrepancy > this._compMaxDiscrep)) {
        this._rejectCounts.compDiscrep++;
        rejectReason = `compDiscrep(${data.compDiscrepancy?.toFixed(1) ?? '?'},max=${this._compMaxDiscrep})`;
      } else if (this._vetoCompDiscrepancyAbove !== undefined && data.compDiscrepancy !== null && data.compDiscrepancy > this._vetoCompDiscrepancyAbove) {
        this._rejectCounts.compDiscrepVeto++;
        rejectReason = `compDiscrep_veto(${data.compDiscrepancy.toFixed(1)},max=${this._vetoCompDiscrepancyAbove})`;
      } else if (this._minDeltaAccel !== undefined && (effectiveDeltaAccel === null || effectiveDeltaAccel <= this._minDeltaAccel)) {
        this._rejectCounts.deltaAccel++;
        rejectReason = `deltaAccel(${effectiveDeltaAccel?.toFixed(4) ?? '?'},need>${this._minDeltaAccel})`;
      }
    }

    this._logDiag(data, effectiveSide, rejectReason, mid);

    if (rejectReason) return [{ type: 'HOLD' }];

    // Balance check
    const bidPrice = this._computeEntryBidPrice(data, buyingComp, mid);
    if (bidPrice === null) {
      return [{ type: 'HOLD' }];
    }
    const cost = this._orderSize.mul(bidPrice).div(100);
    if (data.availableBalance.lt(cost)) {
      this._rejectCounts.balance++;
      return [{ type: 'HOLD' }];
    }

    // ── ENTRY: все фильтры пройдены ──
    this._pendingPlace = true;

    if (buyingComp) {
      // Покупаем комплементарный (DOWN) токен
      if (!data.complementaryInstrumentId || !data.complementaryAsset) {
        this._pendingPlace = false;
        this._logger?.warn('SelectiveEntry: SKIP comp (no comp instrument data)');
        return [{ type: 'HOLD' }];
      }

      this._logger?.warn('SelectiveEntry: BUY_COMPLEMENTARY', {
        compMid: mid,
        bidPrice,
        delta: data.deltaPct!.toFixed(4) + '%',
        tau: data.tauSec.toFixed(0),
        spread: data.spreadCents.toFixed(1),
        rise: data.riseCents?.toFixed(1),
        dAccel: data.deltaAccel?.toFixed(4),
        dAccelEffective: effectiveDeltaAccel?.toFixed(4),
        rejects: this._rejectCounts,
      });
      this._journal?.recordDecision({
        marketId: this._currentMarketId, strategyId: this.id, ts: data.nowMs,
        action: 'BUY_COMP', state: this._serializeState(data),
        rejectCounts: { ...this._rejectCounts },
        bidPrice, orderSize: this._orderSize.toString(), effectiveSide: 'down',
      });
      this._buyAttempts++;

      return [{
        type: 'BUY',
        price: bidPrice,
        size: this._orderSize,
        targetInstrumentId: data.complementaryInstrumentId,
        targetAsset: data.complementaryAsset,
      }];
    }

    // Покупаем основной (UP) токен
    this._logger?.warn('SelectiveEntry: BUY', {
      mid,
      bidPrice,
      delta: data.deltaPct!.toFixed(4) + '%',
      tau: data.tauSec.toFixed(0),
      spread: data.spreadCents.toFixed(1),
      rise: data.riseCents?.toFixed(1),
      dAccel: data.deltaAccel?.toFixed(4),
      dAccelEffective: effectiveDeltaAccel?.toFixed(4),
      rejects: this._rejectCounts,
    });
    this._journal?.recordDecision({
      marketId: this._currentMarketId, strategyId: this.id, ts: data.nowMs,
      action: 'BUY', state: this._serializeState(data),
      rejectCounts: { ...this._rejectCounts },
      bidPrice, orderSize: this._orderSize.toString(), effectiveSide: 'up',
    });
    this._buyAttempts++;

    return [{ type: 'BUY', price: bidPrice, size: this._orderSize }];
  }

  /**
   * Переоценивает фильтры для открытого ордера.
   *
   * @remarks
   * Вызывается когда ордер стоит на бирже (open или partial fill с остатком).
   * Проверяем ключевые фильтры (zone, delta range, tau, spread, deltaAccel).
   * Если хотя бы один не проходит → CANCEL.
   * Баланс не проверяем (ордер уже размещён).
   * Жёсткие minRise/compMaxDiscrepancy не перепроверяем; мягкие veto-фильтры
   * проверяем только когда данные известны.
   * Если условия по-прежнему хорошие, ордер "старый" и можно улучшить maker-цену,
   * то возвращаем CANCEL. Новый BUY будет поставлен уже на следующем тике.
   */
  private _evaluateOpenOrder(data: SEData): SEAction[] {
    // Определяем направление (аналогично decide)
    let effectiveSide: 'up' | 'down';
    if (this._side === 'auto') {
      if (data.deltaPct === undefined) return [{ type: 'HOLD' }]; // нет данных — не отменяем
      effectiveSide = data.deltaPct > 0 ? 'up' : 'down';
    } else {
      effectiveSide = this._side;
    }

    const buyingComp = effectiveSide === 'down';
    const mid = buyingComp
      ? (data.compMidCents !== null
          ? Math.round(Math.max(2, Math.min(98, data.compMidCents)))
          : null)
      : Math.round(Math.max(2, Math.min(98, data.midCents)));

    if (mid === null) return [{ type: 'HOLD' }]; // нет данных — не отменяем

    // Проверяем жёсткие фильтры
    const absDelta = data.deltaPct !== undefined ? Math.abs(data.deltaPct) : undefined;
    const effectiveSpread = buyingComp
      ? (data.compSpreadCents ?? data.spreadCents)
      : data.spreadCents;
    const effectiveDeltaAccel = this._effectiveDeltaAccel(data, effectiveSide);
    let cancelReason = '';

    if (data.openOrderOnComplementary !== buyingComp) {
      cancelReason = `open_order_wrong_side(${data.openOrderOnComplementary ? 'comp' : 'primary'}->${buyingComp ? 'comp' : 'primary'})`;
    }

    if (data.deltaPct === undefined) {
      // Нет delta — не отменяем, данные могут восстановиться
    } else if (!cancelReason && this._side !== 'auto') {
      const wrongSign = this._side === 'up' ? data.deltaPct <= 0 : data.deltaPct >= 0;
      if (wrongSign) cancelReason = `delta_sign_reversed(${data.deltaPct.toFixed(4)}%)`;
    }

    if (!cancelReason) {
      if (mid < this._minZone || mid > this._maxZone) {
        cancelReason = `zone_exit(mid=${mid},need=${this._minZone}-${this._maxZone})`;
      } else if (absDelta !== undefined && (absDelta < this._minDelta || absDelta > this._maxDelta)) {
        cancelReason = `delta_exit(${absDelta.toFixed(4)}%,need=${this._minDelta}-${this._maxDelta})`;
      } else if (data.tauSec < this._minTau) {
        // Только нижняя граница tau: рынок заканчивается слишком скоро
        cancelReason = `tau_exit(${data.tauSec.toFixed(0)}s,min=${this._minTau})`;
      } else if (effectiveSpread > this._maxSpread * 2) {
        // Spread: cancel только при 2x порога (иначе шум)
        cancelReason = `spread_exit(${effectiveSpread.toFixed(1)},max=${this._maxSpread * 2})`;
      } else if (this._vetoRiseBelow !== undefined && data.riseCents !== null && data.riseCents < this._vetoRiseBelow) {
        cancelReason = `rise_veto_exit(${data.riseCents.toFixed(1)},min=${this._vetoRiseBelow})`;
      } else if (this._vetoCompDiscrepancyAbove !== undefined && data.compDiscrepancy !== null && data.compDiscrepancy > this._vetoCompDiscrepancyAbove) {
        cancelReason = `compDiscrep_veto_exit(${data.compDiscrepancy.toFixed(1)},max=${this._vetoCompDiscrepancyAbove})`;
      } else if (this._deltaAccelCancelThreshold !== undefined && effectiveDeltaAccel !== null && effectiveDeltaAccel < this._deltaAccelCancelThreshold) {
        cancelReason = `deltaAccel_reversal(${effectiveDeltaAccel.toFixed(4)},min=${this._deltaAccelCancelThreshold})`;
      }
    }

    if (cancelReason) {
      this._cancelAfterPlace++;
      this._logger?.warn('SelectiveEntry: CANCEL open order — conditions deteriorated', {
        cancelReason,
        mid,
        delta: data.deltaPct?.toFixed(4),
        tau: data.tauSec.toFixed(0),
        spread: data.spreadCents.toFixed(1),
        dAccel: data.deltaAccel?.toFixed(4),
        hasPosition: data.hasPosition,
      });
      this._journal?.recordDecision({
        marketId: this._currentMarketId, strategyId: this.id, ts: data.nowMs,
        action: 'CANCEL', state: this._serializeState(data),
        rejectReason: cancelReason, rejectCounts: { ...this._rejectCounts },
        effectiveSide,
      });
      return [{ type: 'CANCEL' }];
    }

    if (
      !this._repricePending &&
      data.openOrderPriceCents !== null &&
      data.openOrderAgeSec !== null &&
      data.openOrderAgeSec >= this._makerRepriceAfterSec
    ) {
      const targetBidPrice = this._computeEntryBidPrice(data, buyingComp, mid);
      const tick = Math.max(1, Math.round(data.tickSizeCents));

      if (targetBidPrice !== null && targetBidPrice >= data.openOrderPriceCents + tick) {
        this._repricePending = true;
        this._logger?.warn('SelectiveEntry: CANCEL open order — maker reprice', {
          currentPrice: data.openOrderPriceCents,
          targetPrice: targetBidPrice,
          ageSec: data.openOrderAgeSec.toFixed(1),
          mid,
          delta: data.deltaPct?.toFixed(4),
          tau: data.tauSec.toFixed(0),
          spread: data.spreadCents.toFixed(1),
          effectiveSide,
        });
        this._journal?.recordDecision({
          marketId: this._currentMarketId, strategyId: this.id, ts: data.nowMs,
          action: 'CANCEL', state: this._serializeState(data),
          rejectReason: `reprice(${data.openOrderPriceCents}->${targetBidPrice},age=${data.openOrderAgeSec.toFixed(1)}s)`,
          rejectCounts: { ...this._rejectCounts },
          effectiveSide,
        });
        return [{ type: 'CANCEL' }];
      }
    }

    return [{ type: 'HOLD' }];
  }

  /**
   * Диагностический лог каждые 10 секунд.
   */
  private _logDiag(data: SEData, effectiveSide: string, rejectReason: string, mid?: number | null): void {
    if (data.nowMs - this._lastDiagMs < 10_000) return;
    this._lastDiagMs = data.nowMs;
    const effectiveDeltaAccel = effectiveSide === 'up' || effectiveSide === 'down'
      ? this._effectiveDeltaAccel(data, effectiveSide)
      : null;
    this._logger?.info('SelectiveEntry: tick', {
      side: this._side === 'auto' ? `auto→${effectiveSide}` : this._side,
      mid: mid ?? Math.round(data.midCents),
      compMid: data.compMidCents?.toFixed(1) ?? 'n/a',
      delta: data.deltaPct !== undefined ? data.deltaPct.toFixed(4) + '%' : '?',
      tau: data.tauSec.toFixed(0) + 's',
      spread: data.spreadCents.toFixed(1),
      compSpread: data.compSpreadCents?.toFixed(1) ?? 'n/a',
      rise: data.riseCents?.toFixed(1) ?? 'n/a',
      dAccel: data.deltaAccel?.toFixed(4) ?? 'n/a',
      dAccelEffective: effectiveDeltaAccel?.toFixed(4) ?? 'n/a',
      cDisc: data.compDiscrepancy?.toFixed(1) ?? 'n/a',
      reject: rejectReason || 'PASS',
      rejects: this._rejectCounts,
    });
    // Журнал: периодический diagnostic
    this._journal?.recordDecision({
      marketId: this._currentMarketId,
      strategyId: this.id,
      ts: data.nowMs,
      action: 'HOLD',
      state: this._serializeState(data),
      rejectReason: rejectReason || undefined,
      rejectCounts: { ...this._rejectCounts },
      effectiveSide,
    });
  }

  /**
   * Сериализует SEData для журнала решений.
   */
  private _serializeState(data: SEData): Record<string, unknown> {
    return {
      midCents: data.midCents,
      spreadCents: data.spreadCents,
      deltaPct: data.deltaPct,
      tauSec: data.tauSec,
      cryptoPrice: data.cryptoPrice,
      strikePrice: data.strikePrice,
      compMidCents: data.compMidCents,
      riseCents: data.riseCents,
      deltaAccel: data.deltaAccel,
      compDiscrepancy: data.compDiscrepancy,
      availableBalance: data.availableBalance.toFixed(2),
      bestBidCents: data.bestBidCents,
      bestAskCents: data.bestAskCents,
      compBestBidCents: data.compBestBidCents,
      compBestAskCents: data.compBestAskCents,
      compSpreadCents: data.compSpreadCents,
      tickSizeCents: data.tickSizeCents,
      openOrderPriceCents: data.openOrderPriceCents,
      openOrderAgeSec: data.openOrderAgeSec,
      openOrderOnComplementary: data.openOrderOnComplementary,
    };
  }

  private _effectiveDeltaAccel(data: SEData, effectiveSide: 'up' | 'down'): number | null {
    if (data.deltaAccel === null) return null;

    if (!this._useDirectionalDeltaAccel) {
      return data.deltaAccel;
    }

    return effectiveSide === 'up' ? data.deltaAccel : -data.deltaAccel;
  }

  private _computeEntryBidPrice(data: SEData, buyingComp: boolean, strategyCapPrice: number): number | null {
    if (!this._useBookAnchoredMakerPricing) {
      return Math.max(1, strategyCapPrice - this._bidOffset);
    }

    const tick = Math.max(1, Math.round(data.tickSizeCents));
    const bestBid = buyingComp ? data.compBestBidCents : data.bestBidCents;
    const bestAsk = buyingComp ? data.compBestAskCents : data.bestAskCents;

    if (bestBid === null || bestAsk === null) {
      return Math.max(1, strategyCapPrice);
    }

    const spread = bestAsk - bestBid;
    if (spread <= 0) {
      return Math.max(1, Math.min(bestBid, strategyCapPrice));
    }

    if (spread <= tick) {
      return Math.max(1, Math.min(bestBid, strategyCapPrice));
    }

    const improvedBid = bestBid + tick;
    const makerSafeBid = bestAsk - tick;
    return Math.max(1, Math.min(improvedBid, makerSafeBid, strategyCapPrice));
  }

  // ── toIntents ───────────────────────────────────────────────────────────────

  protected toIntents(actions: SEAction[]): StrategyIntent[] {
    const intents: StrategyIntent[] = [];

    for (const action of actions) {
      if (action.type === 'HOLD') continue;

      if (action.type === 'CANCEL') {
        intents.push({ type: 'CANCEL_ALL' });
        continue;
      }

      // BUY: cancel existing + place new
      intents.push({ type: 'CANCEL_ALL' });
      // Атомарная пара target-полей: либо оба, либо ни одного (placeTarget).
      const target = placeTarget(action.targetInstrumentId, action.targetAsset);
      const base = {
        type: 'PLACE' as const,
        side: 'BUY' as const,
        price: OutcomePrice.of(new Decimal(action.price).div(100)),
        size: Quantity.of(action.size),
        postOnly: this._postOnly,
      };
      intents.push(target ? { ...base, ...target } : base);
    }

    return intents;
  }
}
