/**
 * OscillationMMStrategy — осцилляционный маркет-мейкер для binary рынков.
 *
 * @remarks
 * Зарабатывает на micro-oscillations цены вокруг mid.
 * Покупаем на mid-offset, продаём на entry+profit, повторяем.
 * При trending рынке — быстрый stop-loss и cooldown.
 *
 * ### State Machine:
 * ```
 * FLAT ──(bid filled)──→ CONFIRMING ──(pass)──→ LONG ──(ask filled)──→ FLAT (profit)
 *   ↑                       │ adverse             │
 *   ├───(emergency exit)────┘                     │
 *   └───(stop/timeout)────────────────────────────┘
 * ```
 *
 * ### Защита от adverse selection:
 * - **Confirmation window**: после fill ждём 2-5 сек и проверяем сигналы.
 *   Если adverse selection (bestBid < entry - N, OFI sell, downticks) → emergency exit с минимальным убытком.
 * - OFI фильтр: не входим при sell pressure
 * - AAS фильтр: не входим при consecutive downticks
 * - Drop фильтр: не входим если mid упал от пика
 * - Cooldown после stop-loss
 * - Stop-loss по реальному bestBid (не EWMA)
 *
 * @example
 * ```typescript
 * const strategy = new OscillationMMStrategy({
 *   orderSize: new Decimal(5),
 *   entryOffsetCents: 2, profitTargetCents: 3, stopLossCents: 5,
 * });
 * ```
 */
import { BaseStrategy } from '@polymarket/strategy';
import type { StrategySnapshot, StrategyIntent, TriggerReason } from '@polymarket/strategy';
import { Price, Quantity } from '@polymarket/value-objects';
import type { ILogger } from '@polymarket/logger';
import type { StrategyId } from '@polymarket/ids';
import { unsafeStrategyId } from '@polymarket/ids';
import Decimal from 'decimal.js';

// ── Конфигурация ──────────────────────────────────────────────────────────────

export interface OscillationMMConfig {
  readonly orderSize: Decimal;
  /** Смещение bid от EWMA mid (центы). Default 2. */
  readonly entryOffsetCents?: number;
  /** Цель прибыли от entry price (центы). Default 3. */
  readonly profitTargetCents?: number;
  /** Максимальный убыток (центы, по bestBid). Default 5. */
  readonly stopLossCents?: number;
  /** Макс. время удержания позиции (сек). Default 120. */
  readonly maxHoldSec?: number;
  /** Пауза после stop-loss (сек). Default 15. */
  readonly cooldownSec?: number;
  /** Макс. round-trips на один рынок. Default 10. */
  readonly maxRoundTrips?: number;
  /** Не торговать в последние N сек до экспирации. Default 120. */
  readonly minTauSec?: number;
  /** Warmup (сек). Default 30. */
  readonly warmupSec?: number;
  /** Кол-во трейдов для OFI расчёта. Default 10. */
  readonly ofiWindow?: number;
  /** Мин. OFI для входа (0-1). Default 0 (отключён). */
  readonly ofiEntryThreshold?: number;
  /** Макс. OFI для OFI-based exit (0-1). 0 = отключён. Default 0. */
  readonly ofiExitThreshold?: number;
  /** Consecutive downticks для блокировки входа. 0 = отключён. Default 0. */
  readonly aasThreshold?: number;
  /** Макс. падение mid от пика (центы). 0 = отключён. Default 0. */
  readonly maxDropCents?: number;
  /** Окно для отслеживания пика mid (сек). Default 30. */
  readonly dropWindowSec?: number;
  /** Confirmation window после fill (сек). Default 3. */
  readonly confirmationSec?: number;
  /** Тайтовый stop-loss во время confirmation (центы). Default 2. */
  readonly confirmStopCents?: number;
  /** OFI порог для adverse detection в confirmation. Default 0.35. */
  readonly confirmOfiThreshold?: number;
  /** Consecutive downticks для adverse detection в confirmation. Default 2. */
  readonly confirmAasThreshold?: number;
  /** Буфер ниже bestBid для stop-sell (центы). Default 2. */
  readonly exitSlippageCents?: number;
  /** Через сколько сек пересылать stop-sell по текущей цене. Default 3. */
  readonly exitRepriceSec?: number;
  /** Макс. убыток — после этого sell@1¢ (гарантированный exit). Default 15. */
  readonly maxLossCents?: number;
}

// ── Внутренние типы ───────────────────────────────────────────────────────────

interface OMMData {
  readonly midCents: number;
  readonly spreadCents: number;
  readonly bestBidCents: number | undefined;
  readonly bestAskCents: number | undefined;
  readonly ofi: number;
  readonly consecutiveDownticks: number;
  readonly tauSec: number;
  readonly hasPosition: boolean;
  readonly positionQty: Decimal;
  readonly avgEntryPriceCents: number;
  readonly availableBalance: Decimal;
  readonly nowMs: number;
  readonly recentPeakCents: number;
}

type OMMAction =
  | { readonly type: 'PLACE_BID'; readonly price: number; readonly size: Decimal }
  | { readonly type: 'PLACE_ASK'; readonly price: number; readonly size: Decimal }
  | { readonly type: 'STOP_SELL'; readonly price: number; readonly size: Decimal }
  | { readonly type: 'CANCEL_ALL' }
  | { readonly type: 'HOLD' };

// ── Реализация ────────────────────────────────────────────────────────────────

export class OscillationMMStrategy extends BaseStrategy<OMMData, OMMAction> {
  public readonly id: StrategyId;
  public readonly name = 'OscillationMMStrategy';

  private readonly _logger: ILogger | undefined;
  private readonly _orderSize: Decimal;
  private readonly _entryOffset: number;
  private readonly _profitTarget: number;
  private readonly _stopLoss: number;
  private readonly _maxHoldSec: number;
  private readonly _cooldownSec: number;
  private readonly _maxRoundTrips: number;
  private readonly _minTauSec: number;
  private readonly _warmupSec: number;
  private readonly _ofiWindow: number;
  private readonly _ofiEntryThreshold: number;
  private readonly _ofiExitThreshold: number;
  private readonly _aasThreshold: number;
  private readonly _maxDropCents: number;
  private readonly _dropWindowSec: number;
  private readonly _confirmationSec: number;
  private readonly _confirmStopCents: number;

  // ── EWMA state ────────────────────────────────────────────────────────────
  private _ewma: number | null = null;
  private _tradeCount = 0;
  private _lastTradeTimestampMs = 0;

  // ── Market lifecycle ──────────────────────────────────────────────────────
  private _currentExpirationMs = 0;
  private _marketEventStartMs = 0;

  // ── Position tracking ─────────────────────────────────────────────────────
  private _wasLong = false;
  private _confirming = false;
  private _entryPriceCents = 0;
  private _entryMs = 0;
  private _profitAskPlaced = false;
  private _stopSellPending = false;

  // ── Round-trip tracking ───────────────────────────────────────────────────
  private _roundTrips = 0;
  private _lastStopMs = 0;
  private _wins = 0;
  private _losses = 0;
  private _totalPnlCents = 0;

  // ── Peak tracking ─────────────────────────────────────────────────────────
  private _midHistory: { ms: number; cents: number }[] = [];

  // ── Diagnostics ───────────────────────────────────────────────────────────
  private _lastDiagMs = 0;
  private _lastGatherDiagMs = 0;
  private _rejectCounts = { ofi: 0, aas: 0, drop: 0, spread: 0, balance: 0, cooldown: 0 };
  private _emergencyExits = 0;

  constructor(config: OscillationMMConfig, strategyId: StrategyId = unsafeStrategyId('osc-mm-1'), logger?: ILogger) {
    super();
    this.id = strategyId;
    this._logger = logger;
    this._orderSize = config.orderSize;
    this._entryOffset = config.entryOffsetCents ?? 2;
    this._profitTarget = config.profitTargetCents ?? 3;
    this._stopLoss = config.stopLossCents ?? 5;
    this._maxHoldSec = config.maxHoldSec ?? 120;
    this._cooldownSec = config.cooldownSec ?? 15;
    this._maxRoundTrips = config.maxRoundTrips ?? 10;
    this._minTauSec = config.minTauSec ?? 120;
    this._warmupSec = config.warmupSec ?? 30;
    this._ofiWindow = config.ofiWindow ?? 10;
    this._ofiEntryThreshold = config.ofiEntryThreshold ?? 0;
    this._ofiExitThreshold = config.ofiExitThreshold ?? 0;
    this._aasThreshold = config.aasThreshold ?? 0;
    this._maxDropCents = config.maxDropCents ?? 0;
    this._dropWindowSec = config.dropWindowSec ?? 30;
    this._confirmationSec = config.confirmationSec ?? 3;
    this._confirmStopCents = config.confirmStopCents ?? 2;

    this._logger?.warn('OscMM: init', {
      entry: this._entryOffset + 'c',
      profit: this._profitTarget + 'c',
      stop: this._stopLoss + 'c',
      maxHold: this._maxHoldSec + 's',
      cooldown: this._cooldownSec + 's',
      maxRT: this._maxRoundTrips,
      ofiEntry: this._ofiEntryThreshold,
      ofiExit: this._ofiExitThreshold,
      aas: this._aasThreshold,
      maxDrop: this._maxDropCents + 'c',
      confirm: this._confirmationSec + 's',
      confirmStop: this._confirmStopCents + 'c',
    });
  }

  // ── gather ──────────────────────────────────────────────────────────────────

  protected gather(snapshot: StrategySnapshot): OMMData | undefined {
    const expiresMs = snapshot.market.expirationMs;

    // Смена рынка → сброс
    if (this._currentExpirationMs !== expiresMs) {
      this._currentExpirationMs = expiresMs;
      this._ewma = null;
      this._tradeCount = 0;
      this._lastTradeTimestampMs = 0;
      this._wasLong = false;
      this._confirming = false;
      this._entryPriceCents = 0;
      this._entryMs = 0;
      this._profitAskPlaced = false;
      this._stopSellPending = false;
      this._roundTrips = 0;
      this._lastStopMs = 0;
      this._wins = 0;
      this._losses = 0;
      this._totalPnlCents = 0;
      this._midHistory = [];
      this._lastDiagMs = 0;
      this._lastGatherDiagMs = 0;
      this._rejectCounts = { ofi: 0, aas: 0, drop: 0, spread: 0, balance: 0, cooldown: 0 };
      this._emergencyExits = 0;

      if (snapshot.eventStartMs !== undefined) {
        this._marketEventStartMs = snapshot.eventStartMs.toNumber();
        this._logger?.warn('OscMM: new market', { expiresMs, instrumentId: snapshot.instrumentId });
      } else {
        return undefined;
      }
    }

    if (this._marketEventStartMs <= 0) return undefined;

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

    // Fallback на topOfBook
    if (this._ewma === null && snapshot.topOfBook) {
      const bid = snapshot.topOfBook.bestBid?.value().toNumber();
      const ask = snapshot.topOfBook.bestAsk?.value().toNumber();
      if (bid !== undefined && ask !== undefined) {
        this._ewma = ((bid + ask) / 2) * 100;
        this._tradeCount++;
      }
    }

    if (this._ewma === null || this._tradeCount < 3) {
      if (snapshot.nowMs - this._lastGatherDiagMs >= 5_000) {
        this._lastGatherDiagMs = snapshot.nowMs;
        this._logger?.info('OscMM: gather waiting', { ewma: this._ewma?.toFixed(1) ?? 'null', tradeCount: this._tradeCount });
      }
      return undefined;
    }

    // Warmup
    const warmupElapsed = snapshot.nowMs - this._marketEventStartMs;
    if (warmupElapsed < this._warmupSec * 1000) {
      if (snapshot.nowMs - this._lastGatherDiagMs >= 5_000) {
        this._lastGatherDiagMs = snapshot.nowMs;
        this._logger?.info('OscMM: warmup', { elapsed: (warmupElapsed / 1000).toFixed(0) + 's', need: this._warmupSec + 's' });
      }
      return undefined;
    }

    const midCents = Math.round(Math.max(2, Math.min(98, this._ewma)));
    const tauSec = Math.max(0, (expiresMs - snapshot.nowMs) / 1000);

    // OFI из tape: доля uptick'ов среди последних N изменений цены
    let ofi = 0.5;
    if (tapeRecords && tapeRecords.length >= 2) {
      let ups = 0;
      let downs = 0;
      for (let i = tapeRecords.length - 1; i >= 1 && (ups + downs) < this._ofiWindow; i--) {
        const curr = tapeRecords[i]!.price.value().toNumber();
        const prev = tapeRecords[i - 1]!.price.value().toNumber();
        if (curr > prev) ups++;
        else if (curr < prev) downs++;
      }
      ofi = (ups + downs) > 0 ? ups / (ups + downs) : 0.5;
    }

    // Consecutive downticks
    let consecutiveDownticks = 0;
    if (tapeRecords && tapeRecords.length >= 2) {
      for (let i = tapeRecords.length - 1; i >= 1; i--) {
        const curr = tapeRecords[i]!.price.value().toNumber();
        const prev = tapeRecords[i - 1]!.price.value().toNumber();
        if (curr < prev) consecutiveDownticks++;
        else break;
      }
    }

    // Spread и bestBid/bestAsk
    let spreadCents = 99;
    let bestBidCents: number | undefined;
    let bestAskCents: number | undefined;
    if (snapshot.topOfBook) {
      const bid = snapshot.topOfBook.bestBid?.value().toNumber();
      const ask = snapshot.topOfBook.bestAsk?.value().toNumber();
      if (bid !== undefined && ask !== undefined) {
        spreadCents = (ask - bid) * 100;
        bestBidCents = bid * 100;
        bestAskCents = ask * 100;
      }
    }

    // Portfolio
    const position = snapshot.portfolio?.getPosition(snapshot.instrumentId);
    const positionQty = position?.quantity.value() ?? new Decimal(0);
    const hasPosition = positionQty.gt(0);
    const avgEntryPriceCents = hasPosition ? position!.averageEntryPrice.value().toNumber() * 100 : 0;
    const availableBalance = snapshot.portfolio?.balance.available().value() ?? new Decimal(0);

    // Peak tracking
    this._midHistory.push({ ms: snapshot.nowMs, cents: midCents });
    const cutoff = snapshot.nowMs - this._dropWindowSec * 1000;
    this._midHistory = this._midHistory.filter(h => h.ms >= cutoff);
    const recentPeakCents = this._midHistory.reduce((max, h) => Math.max(max, h.cents), midCents);

    return {
      midCents, spreadCents, bestBidCents, bestAskCents,
      ofi, consecutiveDownticks, tauSec,
      hasPosition, positionQty, avgEntryPriceCents,
      availableBalance, nowMs: snapshot.nowMs, recentPeakCents,
    };
  }

  // ── decide ──────────────────────────────────────────────────────────────────

  protected decide(data: OMMData, _reasons: ReadonlySet<TriggerReason>): OMMAction[] {
    // ── Detect FLAT→CONFIRMING transition (bid filled) ──
    if (data.hasPosition && !this._wasLong) {
      this._wasLong = true;
      this._confirming = true;
      this._entryPriceCents = data.avgEntryPriceCents;
      this._entryMs = data.nowMs;
      this._profitAskPlaced = false;
      this._logger?.warn('OscMM: BUY filled → CONFIRMING', {
        entry: this._entryPriceCents.toFixed(0) + 'c',
        mid: data.midCents,
        ofi: data.ofi.toFixed(2),
        aas: data.consecutiveDownticks,
        roundTrip: this._roundTrips + 1,
      });
    }

    // ── Detect LONG/CONFIRMING→FLAT transition (sell filled) ──
    if (!data.hasPosition && this._wasLong) {
      // Приближённый PnL: profitAsk → profit, confirm exit → small loss, stop → big loss
      const approxPnlCents = this._profitAskPlaced
        ? this._profitTarget
        : -(this._confirming ? this._confirmStopCents : this._stopLoss);
      this._totalPnlCents += approxPnlCents;
      if (approxPnlCents > 0) this._wins++; else this._losses++;
      this._roundTrips++;
      this._wasLong = false;
      this._confirming = false;
      this._profitAskPlaced = false;
      this._stopSellPending = false;
      this._logger?.warn('OscMM: exit', {
        pnl: approxPnlCents > 0 ? '+' + approxPnlCents : String(approxPnlCents),
        wins: this._wins, losses: this._losses,
        emergencyExits: this._emergencyExits,
        roundTrips: this._roundTrips,
        totalPnl: this._totalPnlCents + 'c',
      });
    }

    // ── Near expiry: закрываем всё ──
    if (data.tauSec < this._minTauSec) {
      if (data.hasPosition) {
        return this._aggressiveSell(data, 'EXPIRY');
      }
      return [{ type: 'CANCEL_ALL' }];
    }

    // ── EXITING state: sell уже стоит, ждём fill или settlement ────────
    if (data.hasPosition && this._stopSellPending) {
      return [{ type: 'HOLD' }];
    }

    // ── CONFIRMING state: проверяем adverse selection после fill ─────────
    if (data.hasPosition && this._confirming) {
      const confirmElapsed = (data.nowMs - this._entryMs) / 1000;
      const currentValueCents = data.bestBidCents ?? data.midCents;
      const dropFromEntry = this._entryPriceCents - currentValueCents;

      // Adverse detection: ТОЛЬКО по post-fill price action.
      const isAdverse = dropFromEntry >= this._confirmStopCents;

      if (isAdverse) {
        this._emergencyExits++;
        this._logger?.warn('OscMM: EMERGENCY EXIT (adverse)', {
          entry: this._entryPriceCents.toFixed(0),
          bid: currentValueCents?.toFixed(0),
          drop: dropFromEntry.toFixed(1) + 'c',
          elapsed: confirmElapsed.toFixed(1) + 's',
        });
        return this._startExit(data, 'ADVERSE');
      }

      // Confirmation window прошло → promote to LONG
      if (confirmElapsed >= this._confirmationSec) {
        this._confirming = false;
        this._logger?.warn('OscMM: CONFIRMED → LONG', {
          entry: this._entryPriceCents.toFixed(0),
          mid: data.midCents,
          ofi: data.ofi.toFixed(2),
          elapsed: confirmElapsed.toFixed(1) + 's',
        });
        // Fall through to LONG state below to place profit ask
      } else {
        // Still confirming — hold, no orders
        return [{ type: 'HOLD' }];
      }
    }

    // ── LONG state ──────────────────────────────────────────────────────────
    if (data.hasPosition) {
      const currentValueCents = data.bestBidCents ?? data.midCents;
      const unrealizedPnlCents = currentValueCents - this._entryPriceCents;
      const holdTimeSec = (data.nowMs - this._entryMs) / 1000;

      // Stop-loss
      if (unrealizedPnlCents <= -this._stopLoss) {
        this._logger?.warn('OscMM: STOP LOSS', {
          entry: this._entryPriceCents.toFixed(0), bid: currentValueCents?.toFixed(0),
          pnl: unrealizedPnlCents.toFixed(0) + 'c',
        });
        return this._startExit(data, 'STOP');
      }

      // Max hold time
      if (holdTimeSec > this._maxHoldSec) {
        this._logger?.warn('OscMM: TIMEOUT', {
          entry: this._entryPriceCents.toFixed(0), mid: data.midCents,
          hold: holdTimeSec.toFixed(0) + 's', pnl: unrealizedPnlCents.toFixed(0) + 'c',
        });
        return this._startExit(data, 'TIMEOUT');
      }

      // OFI-based early exit
      if (this._ofiExitThreshold > 0 && data.ofi < this._ofiExitThreshold) {
        this._logger?.warn('OscMM: OFI EXIT', {
          ofi: data.ofi.toFixed(2), entry: this._entryPriceCents.toFixed(0),
          pnl: unrealizedPnlCents.toFixed(0) + 'c',
        });
        return this._startExit(data, 'OFI');
      }

      // Place profit-taking ask (один раз)
      if (!this._profitAskPlaced) {
        const askPrice = Math.min(99, Math.round(this._entryPriceCents + this._profitTarget));
        this._profitAskPlaced = true;
        return [{ type: 'CANCEL_ALL' }, { type: 'PLACE_ASK', price: askPrice, size: data.positionQty }];
      }

      // Holding — diagnostic log
      if (data.nowMs - this._lastDiagMs >= 10_000) {
        this._lastDiagMs = data.nowMs;
        this._logger?.info('OscMM: holding', {
          entry: this._entryPriceCents.toFixed(0), mid: data.midCents,
          pnl: unrealizedPnlCents.toFixed(0) + 'c', hold: holdTimeSec.toFixed(0) + 's',
          ofi: data.ofi.toFixed(2),
        });
      }
      return [{ type: 'HOLD' }];
    }

    // ── FLAT state ──────────────────────────────────────────────────────────

    // Round-trip limit
    if (this._roundTrips >= this._maxRoundTrips) {
      return [{ type: 'CANCEL_ALL' }];
    }

    // Cooldown после stop
    if (this._lastStopMs > 0 && data.nowMs - this._lastStopMs < this._cooldownSec * 1000) {
      this._rejectCounts.cooldown++;
      return [{ type: 'CANCEL_ALL' }];
    }

    // ── Entry condition checks ──
    let rejectReason = '';

    if (this._ofiEntryThreshold > 0 && data.ofi < this._ofiEntryThreshold) {
      this._rejectCounts.ofi++;
      rejectReason = `ofi(${data.ofi.toFixed(2)}<${this._ofiEntryThreshold})`;
    } else if (this._aasThreshold > 0 && data.consecutiveDownticks >= this._aasThreshold) {
      this._rejectCounts.aas++;
      rejectReason = `aas(${data.consecutiveDownticks}↓)`;
    } else if (this._maxDropCents > 0 && data.recentPeakCents - data.midCents > this._maxDropCents) {
      this._rejectCounts.drop++;
      rejectReason = `drop(${data.recentPeakCents - data.midCents}c)`;
    } else if (data.spreadCents > 6) {
      this._rejectCounts.spread++;
      rejectReason = `spread(${data.spreadCents.toFixed(1)}c)`;
    }

    // Diagnostic log
    if (data.nowMs - this._lastDiagMs >= 10_000) {
      this._lastDiagMs = data.nowMs;
      this._logger?.info('OscMM: tick', {
        mid: data.midCents, ofi: data.ofi.toFixed(2),
        tau: data.tauSec.toFixed(0) + 's', spread: data.spreadCents.toFixed(1),
        drop: data.recentPeakCents - data.midCents,
        rt: `${this._roundTrips}/${this._maxRoundTrips}`,
        w: this._wins, l: this._losses,
        reject: rejectReason || 'PASS',
        rejects: this._rejectCounts,
      });
    }

    if (rejectReason) return [{ type: 'CANCEL_ALL' }];

    // Balance check
    const bidPrice = Math.max(1, Math.round(data.midCents - this._entryOffset));
    const cost = this._orderSize.mul(bidPrice).div(100);
    if (data.availableBalance.lt(cost)) {
      this._rejectCounts.balance++;
      return [{ type: 'CANCEL_ALL' }];
    }

    // ── Place bid ──
    return [
      { type: 'CANCEL_ALL' },
      { type: 'PLACE_BID', price: bidPrice, size: this._orderSize },
    ];
  }

  // ── Exit management ─────────────────────────────────────────────────────────

  /**
   * Начинает процесс выхода из позиции.
   * Ставит sell по bestBid - slippage. Переводит в EXITING state.
   */
  private _startExit(data: OMMData, reason: string): OMMAction[] {
    this._stopSellPending = true;
    this._lastStopMs = data.nowMs;
    this._profitAskPlaced = false;
    return this._placeSell(data, reason);
  }

  // _chaseExit removed — v1 behavior: HOLD after sell placed

  /**
   * Агрессивная продажа: sell по bestBid - slippage для гарантированного fill.
   *
   * @remarks
   * Не используем price=1¢ — ExecutionEngine отклоняет ордера с value < minOrderValue.
   * С size=5, price должен быть >= 20¢ ($1 / 5 токенов). Используем bestBid.
   */
  private _aggressiveSell(data: OMMData, reason: string): OMMAction[] {
    const currentBid = data.bestBidCents ?? data.midCents;
    const sellPrice = Math.max(20, Math.round(currentBid - 10));
    this._logger?.warn(`OscMM: aggressive sell (${reason})`, {
      entry: this._entryPriceCents.toFixed(0),
      bid: currentBid?.toFixed(0),
      sellAt: sellPrice,
    });
    return [{ type: 'CANCEL_ALL' }, { type: 'STOP_SELL', price: sellPrice, size: data.positionQty }];
  }

  /**
   * Market sell: ставит sell значительно ниже bestBid для гарантированного fill.
   *
   * @remarks
   * Price improvement в PaperFillSimulator: fill по max(orderPrice, bestBid).
   * Ставим цену ниже bestBid на 10¢ чтобы заполнилось даже если bestBid
   * упадёт на следующем тике. Минимум 20¢ (minOrderValue $1 / 5 токенов).
   */
  private _placeSell(data: OMMData, reason: string): OMMAction[] {
    const currentBid = data.bestBidCents ?? data.midCents;
    // Market sell: цена ниже bestBid на 10¢, но >= 20¢ для minOrderValue
    const sellPrice = Math.max(20, Math.round(currentBid - 10));
    this._logger?.warn(`OscMM: market sell (${reason})`, {
      entry: this._entryPriceCents.toFixed(0),
      bid: currentBid?.toFixed(0),
      sellAt: sellPrice,
    });
    return [{ type: 'CANCEL_ALL' }, { type: 'STOP_SELL', price: sellPrice, size: data.positionQty }];
  }

  // ── toIntents ───────────────────────────────────────────────────────────────

  protected toIntents(actions: OMMAction[]): StrategyIntent[] {
    const intents: StrategyIntent[] = [];

    for (const action of actions) {
      switch (action.type) {
        case 'CANCEL_ALL':
          intents.push({ type: 'CANCEL_ALL' });
          break;
        case 'PLACE_BID':
          intents.push({
            type: 'PLACE',
            side: 'BUY',
            price: Price.of(new Decimal(action.price).div(100)),
            size: Quantity.of(action.size),
          });
          break;
        case 'PLACE_ASK':
        case 'STOP_SELL':
          intents.push({
            type: 'PLACE',
            side: 'SELL',
            price: Price.of(new Decimal(action.price).div(100)),
            size: Quantity.of(action.size),
          });
          break;
        case 'HOLD':
          break;
      }
    }

    return intents;
  }
}
