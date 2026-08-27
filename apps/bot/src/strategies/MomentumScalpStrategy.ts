/**
 * MomentumScalpStrategy — направленная стратегия на momentum в binary рынках.
 *
 * @remarks
 * Покупает токены по 75-94¢ в последние минуты перед экспирацией
 * при подтверждённом momentum (velocity) и контролируемом давлении.
 * Hold to settlement или TP/SL.
 *
 * Из исследования EXP-02: $8.77/день, 91.3% winning days.
 *
 * ### Логика:
 * - Velocity = изменение цены за последние 30с (центы/30с)
 * - Pressure = доля uptick'ов за последние 5с
 * - Вход: mid в [75-94], tau < maxMinutesFromEnd, velocity в [4-7], pressure в [-0.4, 0.6]
 * - Выход: TP +5¢, SL -5¢, timeout 60с, или hold to settlement
 *
 * @example
 * ```typescript
 * const strategy = new MomentumScalpStrategy({
 *   orderSize: new Decimal(5),
 *   priceMinCents: 75,
 *   priceMaxCents: 94,
 * });
 * ```
 */
import { BaseStrategy } from '@polymarket/strategy';
import type { StrategySnapshot, StrategyIntent, TriggerReason } from '@polymarket/strategy';
import { OutcomePrice, Quantity } from '@polymarket/value-objects';
import type { ILogger } from '@polymarket/logger';
import type { StrategyId } from '@polymarket/ids';
import { unsafeStrategyId } from '@polymarket/ids';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- внутренний Decimal-конвент apps/bot/strategies/*, см. docs/architecture/boundary-contract.md, Решение 11
import Decimal from 'decimal.js';

// ── Конфигурация ──────────────────────────────────────────────────────────────

export interface MomentumScalpConfig {
  readonly orderSize: Decimal;
  /** Минимальная цена mid для входа (центы). Default 75. */
  readonly priceMinCents?: number;
  /** Максимальная цена mid для входа (центы). Default 94. */
  readonly priceMaxCents?: number;
  /** Максимальное время до экспирации для входа (сек). Default 180. */
  readonly maxTauSec?: number;
  /** Минимальное время до экспирации (сек, не входить совсем близко к концу). Default 30. */
  readonly minTauSec?: number;
  /** Минимальная velocity для входа (центы/30с). Default 4. */
  readonly velocityMin?: number;
  /** Максимальная velocity для входа (центы/30с). Default 7. */
  readonly velocityMax?: number;
  /** Минимальная pressure ratio для входа. Default -0.4. */
  readonly pressureMin?: number;
  /** Максимальная pressure ratio для входа. Default 0.6. */
  readonly pressureMax?: number;
  /** Take profit (центы). Default 5. */
  readonly takeProfitCents?: number;
  /** Stop loss (центы). Default 5. */
  readonly stopLossCents?: number;
  /** Timeout для TP/SL (сек), после — hold to settlement. Default 60. */
  readonly tpTimeoutSec?: number;
  /** Warmup (сек). Default 30. */
  readonly warmupSec?: number;
  /** Максимум входов на рынок. Default 3. */
  readonly maxEntries?: number;
  /** Cooldown после exit (сек). Default 10. */
  readonly cooldownSec?: number;
}

// ── Внутренние типы ───────────────────────────────────────────────────────────

interface MSData {
  readonly midCents: number;
  readonly bestBidCents: number | undefined;
  readonly bestAskCents: number | undefined;
  readonly velocityCents30s: number;
  readonly pressureRatio: number;
  readonly tauSec: number;
  readonly hasPosition: boolean;
  readonly positionQty: Decimal;
  readonly availableTokenQty: Decimal;
  readonly avgEntryPriceCents: number;
  readonly availableBalance: Decimal;
  readonly nowMs: number;
}

type MSAction =
  | { readonly type: 'BUY'; readonly price: number; readonly size: Decimal }
  | { readonly type: 'SELL'; readonly price: number; readonly size: Decimal }
  | { readonly type: 'CANCEL_ALL' }
  | { readonly type: 'HOLD' };

// ── Реализация ────────────────────────────────────────────────────────────────

export class MomentumScalpStrategy extends BaseStrategy<MSData, MSAction> {
  public readonly id: StrategyId;
  public readonly name = 'MomentumScalpStrategy';

  private readonly _logger: ILogger | undefined;
  private readonly _orderSize: Decimal;
  private readonly _priceMin: number;
  private readonly _priceMax: number;
  private readonly _maxTauSec: number;
  private readonly _minTauSec: number;
  private readonly _velocityMin: number;
  private readonly _velocityMax: number;
  private readonly _pressureMin: number;
  private readonly _pressureMax: number;
  private readonly _tpCents: number;
  private readonly _slCents: number;
  private readonly _tpTimeoutSec: number;
  private readonly _warmupSec: number;
  private readonly _maxEntries: number;
  private readonly _cooldownSec: number;

  // ── State ─────────────────────────────────────────────────────────────────
  private _currentExpirationMs = 0;
  private _marketEventStartMs = 0;
  private _ewma: number | null = null;
  private _tradeCount = 0;
  private _lastTradeTimestampMs = 0;

  // ── Position tracking ─────────────────────────────────────────────────────
  private _wasLong = false;
  private _entryPriceCents = 0;
  private _entryMs = 0;
  private _entries = 0;
  private _lastExitMs = 0;
  private _wins = 0;
  private _losses = 0;
  private _totalPnlCents = 0;

  // ── OutcomePrice history для velocity ────────────────────────────────────────────
  private _priceHistory: { ms: number; cents: number }[] = [];

  constructor(config: MomentumScalpConfig, strategyId: StrategyId = unsafeStrategyId('mom-scalp-1'), logger?: ILogger) {
    super();
    this.id = strategyId;
    this._logger = logger;
    this._orderSize = config.orderSize;
    this._priceMin = config.priceMinCents ?? 75;
    this._priceMax = config.priceMaxCents ?? 94;
    this._maxTauSec = config.maxTauSec ?? 180;
    this._minTauSec = config.minTauSec ?? 30;
    this._velocityMin = config.velocityMin ?? 4;
    this._velocityMax = config.velocityMax ?? 7;
    this._pressureMin = config.pressureMin ?? -0.4;
    this._pressureMax = config.pressureMax ?? 0.6;
    this._tpCents = config.takeProfitCents ?? 5;
    this._slCents = config.stopLossCents ?? 5;
    this._tpTimeoutSec = config.tpTimeoutSec ?? 60;
    this._warmupSec = config.warmupSec ?? 30;
    this._maxEntries = config.maxEntries ?? 3;
    this._cooldownSec = config.cooldownSec ?? 10;

    this._logger?.warn('MomScalp: init', {
      priceZone: `${this._priceMin}-${this._priceMax}c`,
      tau: `${this._minTauSec}-${this._maxTauSec}s`,
      velocity: `${this._velocityMin}-${this._velocityMax}`,
      pressure: `${this._pressureMin} to ${this._pressureMax}`,
      tp: this._tpCents + 'c', sl: this._slCents + 'c',
    });
  }

  // ── gather ──────────────────────────────────────────────────────────────────

  protected gather(snapshot: StrategySnapshot): MSData | undefined {
    const expiresMs = snapshot.market.expirationMs;

    // Смена рынка → сброс
    if (this._currentExpirationMs !== expiresMs) {
      this._currentExpirationMs = expiresMs;
      this._ewma = null;
      this._tradeCount = 0;
      this._lastTradeTimestampMs = 0;
      this._wasLong = false;
      this._entryPriceCents = 0;
      this._entryMs = 0;
      this._entries = 0;
      this._lastExitMs = 0;
      this._wins = 0;
      this._losses = 0;
      this._totalPnlCents = 0;
      this._priceHistory = [];

      if (snapshot.eventStartMs !== undefined) {
        this._marketEventStartMs = snapshot.eventStartMs.toNumber();
      } else {
        return undefined;
      }
    }

    if (this._marketEventStartMs <= 0) return undefined;

    // EWMA из trade tape + price history
    const tapeRecords = snapshot.tradeTape?.getAll();
    if (tapeRecords && tapeRecords.length > 0) {
      for (const trade of tapeRecords) {
        const tradeTs = trade.timestamp.toNumber();
        if (tradeTs <= this._lastTradeTimestampMs) continue;
        const priceNum = trade.price.value().toNumber() * 100;
        this._ewma = this._ewma === null ? priceNum : 0.3 * priceNum + 0.7 * this._ewma;
        this._tradeCount++;
        this._lastTradeTimestampMs = tradeTs;
        this._priceHistory.push({ ms: tradeTs, cents: priceNum });
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

    if (this._ewma === null || this._tradeCount < 3) return undefined;

    // Warmup
    const warmupElapsed = snapshot.nowMs - this._marketEventStartMs;
    if (warmupElapsed < this._warmupSec * 1000) return undefined;

    const midCents = Math.round(Math.max(1, Math.min(99, this._ewma)));
    const tauSec = Math.max(0, (expiresMs - snapshot.nowMs) / 1000);

    // Обрезаем историю (60 сек)
    const cutoff = snapshot.nowMs - 60_000;
    this._priceHistory = this._priceHistory.filter(h => h.ms >= cutoff);

    // Velocity: изменение цены за последние 30с
    let velocityCents30s = 0;
    const velCutoff = snapshot.nowMs - 30_000;
    const recentPrices = this._priceHistory.filter(h => h.ms >= velCutoff);
    if (recentPrices.length >= 2) {
      velocityCents30s = recentPrices[recentPrices.length - 1]!.cents - recentPrices[0]!.cents;
    }

    // Pressure: доля uptick'ов за последние 5с
    let pressureRatio = 0;
    const presCutoff = snapshot.nowMs - 5_000;
    const presRecent = this._priceHistory.filter(h => h.ms >= presCutoff);
    if (presRecent.length >= 2) {
      let ups = 0;
      let total = 0;
      for (let i = 1; i < presRecent.length; i++) {
        const diff = presRecent[i]!.cents - presRecent[i - 1]!.cents;
        if (diff > 0) ups++;
        if (diff !== 0) total++;
      }
      pressureRatio = total > 0 ? (ups / total) * 2 - 1 : 0; // [-1, +1]
    }

    // TopOfBook
    let bestBidCents: number | undefined;
    let bestAskCents: number | undefined;
    if (snapshot.topOfBook) {
      const bid = snapshot.topOfBook.bestBid?.value().toNumber();
      const ask = snapshot.topOfBook.bestAsk?.value().toNumber();
      if (bid !== undefined) bestBidCents = bid * 100;
      if (ask !== undefined) bestAskCents = ask * 100;
    }

    // Portfolio
    const position = snapshot.portfolio?.getPosition(snapshot.instrumentId);
    const positionQty = position?.quantity.value() ?? new Decimal(0);
    const hasPosition = positionQty.gt(0);
    const avgEntryPriceCents = hasPosition ? position!.averageEntryPrice.value().toNumber() * 100 : 0;
    const availableBalance = snapshot.portfolio?.balance.available().value() ?? new Decimal(0);
    const availableTokenQty = snapshot.portfolio?.availableTokenQuantity(snapshot.instrumentId) ?? new Decimal(0);

    return {
      midCents, bestBidCents, bestAskCents,
      velocityCents30s, pressureRatio, tauSec,
      hasPosition, positionQty, availableTokenQty, avgEntryPriceCents,
      availableBalance, nowMs: snapshot.nowMs,
    };
  }

  // ── decide ──────────────────────────────────────────────────────────────────

  protected decide(data: MSData, _reasons: ReadonlySet<TriggerReason>): MSAction[] {
    // ── Detect BUY fill ──
    if (data.hasPosition && !this._wasLong) {
      this._wasLong = true;
      this._entryPriceCents = data.avgEntryPriceCents;
      this._entryMs = data.nowMs;
      this._logger?.warn('MomScalp: BUY filled', {
        entry: this._entryPriceCents.toFixed(0) + 'c',
        mid: data.midCents,
        vel: data.velocityCents30s.toFixed(1),
        pres: data.pressureRatio.toFixed(2),
        tau: data.tauSec.toFixed(0) + 's',
      });
    }

    // ── Detect SELL fill ──
    if (!data.hasPosition && this._wasLong) {
      const pnlCents = data.midCents - this._entryPriceCents; // приближение
      this._totalPnlCents += pnlCents;
      if (pnlCents > 0) this._wins++; else this._losses++;
      this._wasLong = false;
      this._lastExitMs = data.nowMs;
      this._logger?.warn('MomScalp: exit', {
        pnl: (pnlCents > 0 ? '+' : '') + pnlCents.toFixed(0) + 'c',
        wins: this._wins, losses: this._losses,
        totalPnl: this._totalPnlCents + 'c',
        entries: this._entries,
      });
    }

    // ── LONG state: управление позицией ──────────────────────────────────────
    if (data.hasPosition) {
      const currentValueCents = data.bestBidCents ?? data.midCents;
      const pnlCents = currentValueCents - this._entryPriceCents;
      const holdSec = (data.nowMs - this._entryMs) / 1000;

      // Near expiry — hold to settlement (не продаём, ждём результат)
      if (data.tauSec < this._minTauSec) {
        return [{ type: 'HOLD' }];
      }

      // Take profit
      if (pnlCents >= this._tpCents) {
        this._logger?.warn('MomScalp: TAKE PROFIT', {
          entry: this._entryPriceCents.toFixed(0), bid: currentValueCents,
          pnl: '+' + pnlCents.toFixed(0) + 'c',
        });
        const sellPrice = Math.max(20, Math.round(currentValueCents - 10));
        return [{ type: 'CANCEL_ALL' }, { type: 'SELL', price: sellPrice, size: data.availableTokenQty.gt(0) ? data.availableTokenQty : data.positionQty }];
      }

      // Stop loss
      if (pnlCents <= -this._slCents) {
        this._logger?.warn('MomScalp: STOP LOSS', {
          entry: this._entryPriceCents.toFixed(0), bid: currentValueCents,
          pnl: pnlCents.toFixed(0) + 'c',
        });
        const sellPrice = Math.max(20, Math.round(currentValueCents - 10));
        return [{ type: 'CANCEL_ALL' }, { type: 'SELL', price: sellPrice, size: data.availableTokenQty.gt(0) ? data.availableTokenQty : data.positionQty }];
      }

      // Timeout → hold to settlement (не продаём — momentum должен дотянуть)
      if (holdSec > this._tpTimeoutSec) {
        return [{ type: 'HOLD' }];
      }

      return [{ type: 'HOLD' }];
    }

    // ── FLAT state: ищем вход ────────────────────────────────────────────────

    // Max entries
    if (this._entries >= this._maxEntries) {
      return [{ type: 'CANCEL_ALL' }];
    }

    // Cooldown
    if (this._lastExitMs > 0 && data.nowMs - this._lastExitMs < this._cooldownSec * 1000) {
      return [{ type: 'CANCEL_ALL' }];
    }

    // Tau window: входим только в последние N секунд, но не слишком близко
    if (data.tauSec > this._maxTauSec || data.tauSec < this._minTauSec) {
      return [{ type: 'CANCEL_ALL' }];
    }

    // OutcomePrice zone
    if (data.midCents < this._priceMin || data.midCents > this._priceMax) {
      return [{ type: 'CANCEL_ALL' }];
    }

    // Velocity check
    if (data.velocityCents30s < this._velocityMin || data.velocityCents30s > this._velocityMax) {
      return [{ type: 'CANCEL_ALL' }];
    }

    // Pressure check
    if (data.pressureRatio < this._pressureMin || data.pressureRatio > this._pressureMax) {
      return [{ type: 'CANCEL_ALL' }];
    }

    // Balance check
    const bidPrice = data.midCents;
    const cost = this._orderSize.mul(bidPrice).div(100);
    if (data.availableBalance.lt(cost)) {
      return [{ type: 'CANCEL_ALL' }];
    }

    // ── BUY! ──
    this._entries++;
    this._logger?.warn('MomScalp: BUY signal', {
      mid: data.midCents,
      vel: data.velocityCents30s.toFixed(1),
      pres: data.pressureRatio.toFixed(2),
      tau: data.tauSec.toFixed(0) + 's',
      entry: this._entries,
    });

    return [
      { type: 'CANCEL_ALL' },
      { type: 'BUY', price: bidPrice, size: this._orderSize },
    ];
  }

  // ── toIntents ───────────────────────────────────────────────────────────────

  protected toIntents(actions: MSAction[]): StrategyIntent[] {
    const intents: StrategyIntent[] = [];

    for (const action of actions) {
      switch (action.type) {
        case 'CANCEL_ALL':
          intents.push({ type: 'CANCEL_ALL' });
          break;
        case 'BUY':
          intents.push({
            type: 'PLACE',
            side: 'BUY',
            price: OutcomePrice.of(new Decimal(action.price).div(100)),
            size: Quantity.of(action.size),
          });
          break;
        case 'SELL':
          intents.push({
            type: 'PLACE',
            side: 'SELL',
            price: OutcomePrice.of(new Decimal(action.price).div(100)),
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
