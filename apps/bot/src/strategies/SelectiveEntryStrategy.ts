/**
 * SelectiveEntryStrategy — buy-and-hold до settlement на основе delta% и zone filter.
 *
 * @remarks
 * Простейшая стратегия: один раз решить — покупать или нет.
 * Купить limit BUY (maker) и **держать до settlement**.
 * Без exit logic, без trail stop, без market making.
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
 *    - (optional) Delta acceleration > 0 — BTC уходит от strike
 * 4. Ставим limit BUY по mid - 1¢ (maker)
 * 5. Держим до settlement. Нет exit logic.
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
import type { StrategySnapshot, StrategyIntent, TriggerReason } from '@polymarket/strategy';
import { Price, Quantity } from '@polymarket/value-objects';
import type { ILogger } from '@polymarket/logger';
import type { InstrumentId, AssetId } from '@polymarket/ids';
import type { IDecisionJournal } from '@polymarket/ports';
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
   * Default false.
   */
  readonly requireDeltaAccel?: boolean;
}

// ── Внутренние типы ───────────────────────────────────────────────────────────

interface SEData {
  readonly midCents: number;
  readonly spreadCents: number;
  readonly deltaPct: number | undefined;
  readonly tauSec: number;
  readonly hasPosition: boolean;
  readonly hasPendingOrder: boolean;
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
  | { readonly type: 'HOLD' };

// ── Реализация ────────────────────────────────────────────────────────────────

export class SelectiveEntryStrategy extends BaseStrategy<SEData, SEAction> {
  public readonly id: string;
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
  private readonly _requireDeltaAccel: boolean;

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

  /** Вошли ли мы в этот рынок (поставили ордер) */
  private _entered = false;

  /** Время последнего диагностического лога (throttle) */
  private _lastDiagMs = 0;

  /** Время последнего gather-диагностического лога (throttle) */
  private _lastGatherDiagMs = 0;

  /** Счётчики фильтров (за текущий рынок) */
  private _rejectCounts = { noDelta: 0, deltaSign: 0, zone: 0, deltaRange: 0, tau: 0, spread: 0, balance: 0, rise: 0, compDiscrep: 0, deltaAccel: 0 };

  constructor(config: SelectiveEntryConfig, strategyId = 'selective-entry-1', logger?: ILogger, journal?: IDecisionJournal) {
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
    this._requireDeltaAccel = config.requireDeltaAccel ?? false;

    this._logger?.warn('SelectiveEntry: init', {
      side: this._side,
      zone: `${this._minZone}-${this._maxZone}`,
      delta: `${this._minDelta}-${this._maxDelta}%`,
      tau: `${this._minTau}-${this._maxTau}s`,
      maxSpread: this._maxSpread,
      warmup: this._warmupSec,
      bidOffset: this._bidOffset,
      minRise: this._minRise ?? 'off',
      waitPct: this._waitPct ?? 'off',
      compMaxDiscrep: this._compMaxDiscrep ?? 'off',
      deltaAccel: this._requireDeltaAccel ? 'on' : 'off',
    });
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
      this._entered = false;
      this._lastDiagMs = 0;
      this._rejectCounts = { noDelta: 0, deltaSign: 0, zone: 0, deltaRange: 0, tau: 0, spread: 0, balance: 0, rise: 0, compDiscrep: 0, deltaAccel: 0 };

      if (snapshot.eventStartMs) {
        this._marketEventStartMs = snapshot.eventStartMs;
        this._marketDurationMs = expiresMs - snapshot.eventStartMs;
        this._currentMarketId = String(snapshot.instrumentId);
        this._logger?.warn('SelectiveEntry: new market', {
          expiresMs,
          eventStartMs: snapshot.eventStartMs,
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
    if (snapshot.topOfBook) {
      const bid = snapshot.topOfBook.bestBid?.value().toNumber();
      const ask = snapshot.topOfBook.bestAsk?.value().toNumber();
      if (bid !== undefined && ask !== undefined) {
        spreadCents = (ask - bid) * 100;
      }
    }

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

    return {
      midCents: this._ewma,
      spreadCents,
      deltaPct,
      tauSec,
      hasPosition: primaryQty.gt(0) || compQty.gt(0),
      hasPendingOrder: snapshot.hasInFlightFills || snapshot.matchedOrders.length > 0,
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
    };
  }

  // ── decide ──────────────────────────────────────────────────────────────────

  protected decide(data: SEData, _reasons: ReadonlySet<TriggerReason>): SEAction[] {
    // Уже вошли или есть позиция/ордер → держим до settlement
    if (this._entered || data.hasPosition || data.hasPendingOrder) {
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
      if (mid < this._minZone || mid > this._maxZone) {
        this._rejectCounts.zone++;
        rejectReason = `zone(mid=${mid},need=${this._minZone}-${this._maxZone})`;
      } else if (absDelta! < this._minDelta || absDelta! > this._maxDelta) {
        this._rejectCounts.deltaRange++;
        rejectReason = `delta(${absDelta!.toFixed(4)}%,need=${this._minDelta}-${this._maxDelta})`;
      } else if (data.tauSec < this._minTau || data.tauSec > this._maxTau) {
        this._rejectCounts.tau++;
        rejectReason = `tau(${data.tauSec.toFixed(0)}s,need=${this._minTau}-${this._maxTau})`;
      } else if (data.spreadCents > this._maxSpread) {
        this._rejectCounts.spread++;
        rejectReason = `spread(${data.spreadCents.toFixed(1)},max=${this._maxSpread})`;
      } else if (this._minRise !== undefined && (data.riseCents === null || data.riseCents < this._minRise)) {
        this._rejectCounts.rise++;
        rejectReason = `rise(${data.riseCents?.toFixed(1) ?? '?'},need>=${this._minRise})`;
      } else if (this._compMaxDiscrep !== undefined && (data.compDiscrepancy === null || data.compDiscrepancy > this._compMaxDiscrep)) {
        this._rejectCounts.compDiscrep++;
        rejectReason = `compDiscrep(${data.compDiscrepancy?.toFixed(1) ?? '?'},max=${this._compMaxDiscrep})`;
      } else if (this._requireDeltaAccel && (data.deltaAccel === null || data.deltaAccel <= 0)) {
        this._rejectCounts.deltaAccel++;
        rejectReason = `deltaAccel(${data.deltaAccel?.toFixed(4) ?? '?'},need>0)`;
      }
    }

    this._logDiag(data, effectiveSide, rejectReason, mid);

    if (rejectReason) return [{ type: 'HOLD' }];

    // Balance check
    const bidPrice = Math.max(1, mid - this._bidOffset);
    const cost = this._orderSize.mul(bidPrice).div(100);
    if (data.availableBalance.lt(cost)) {
      this._rejectCounts.balance++;
      return [{ type: 'HOLD' }];
    }

    // ── ENTRY: все фильтры пройдены ──

    if (buyingComp) {
      // Покупаем комплементарный (DOWN) токен
      if (!data.complementaryInstrumentId || !data.complementaryAsset) {
        this._logger?.warn('SelectiveEntry: SKIP comp (no comp instrument data)');
        return [{ type: 'HOLD' }];
      }

      this._entered = true;

      this._logger?.warn('SelectiveEntry: BUY_COMPLEMENTARY', {
        compMid: mid,
        bidPrice,
        delta: data.deltaPct!.toFixed(4) + '%',
        tau: data.tauSec.toFixed(0),
        spread: data.spreadCents.toFixed(1),
        rise: data.riseCents?.toFixed(1),
        dAccel: data.deltaAccel?.toFixed(4),
        rejects: this._rejectCounts,
      });
      this._journal?.recordDecision({
        marketId: this._currentMarketId, strategyId: this.id, ts: data.nowMs,
        action: 'BUY_COMP', state: this._serializeState(data),
        rejectCounts: { ...this._rejectCounts },
        bidPrice, orderSize: this._orderSize.toString(), effectiveSide: 'down',
      });

      return [{
        type: 'BUY',
        price: bidPrice,
        size: this._orderSize,
        targetInstrumentId: data.complementaryInstrumentId,
        targetAsset: data.complementaryAsset,
      }];
    }

    // Покупаем основной (UP) токен
    this._entered = true;

    this._logger?.warn('SelectiveEntry: BUY', {
      mid,
      bidPrice,
      delta: data.deltaPct!.toFixed(4) + '%',
      tau: data.tauSec.toFixed(0),
      spread: data.spreadCents.toFixed(1),
      rise: data.riseCents?.toFixed(1),
      dAccel: data.deltaAccel?.toFixed(4),
      rejects: this._rejectCounts,
    });
    this._journal?.recordDecision({
      marketId: this._currentMarketId, strategyId: this.id, ts: data.nowMs,
      action: 'BUY', state: this._serializeState(data),
      rejectCounts: { ...this._rejectCounts },
      bidPrice, orderSize: this._orderSize.toString(), effectiveSide: 'up',
    });

    return [{ type: 'BUY', price: bidPrice, size: this._orderSize }];
  }

  /**
   * Диагностический лог каждые 10 секунд.
   */
  private _logDiag(data: SEData, effectiveSide: string, rejectReason: string, mid?: number | null): void {
    if (data.nowMs - this._lastDiagMs < 10_000) return;
    this._lastDiagMs = data.nowMs;
    this._logger?.info('SelectiveEntry: tick', {
      side: this._side === 'auto' ? `auto→${effectiveSide}` : this._side,
      mid: mid ?? Math.round(data.midCents),
      compMid: data.compMidCents?.toFixed(1) ?? 'n/a',
      delta: data.deltaPct !== undefined ? data.deltaPct.toFixed(4) + '%' : '?',
      tau: data.tauSec.toFixed(0) + 's',
      spread: data.spreadCents.toFixed(1),
      rise: data.riseCents?.toFixed(1) ?? 'n/a',
      dAccel: data.deltaAccel?.toFixed(4) ?? 'n/a',
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
    };
  }

  // ── toIntents ───────────────────────────────────────────────────────────────

  protected toIntents(actions: SEAction[]): StrategyIntent[] {
    const intents: StrategyIntent[] = [];

    for (const action of actions) {
      if (action.type === 'HOLD') continue;

      intents.push({ type: 'CANCEL_ALL' });
      intents.push({
        type: 'PLACE',
        side: 'BUY',
        price: Price.of(new Decimal(action.price).div(100)),
        size: Quantity.of(action.size),
        targetInstrumentId: action.targetInstrumentId,
        targetAsset: action.targetAsset,
      });
    }

    return intents;
  }
}
