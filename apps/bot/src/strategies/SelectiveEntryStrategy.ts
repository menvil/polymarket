/**
 * SelectiveEntryStrategy — buy-and-hold до settlement на основе delta% и zone filter.
 *
 * @remarks
 * Простейшая стратегия: один раз решить — покупать или нет.
 * Купить limit BUY (maker) и **держать до settlement**.
 * Без exit logic, без trail stop, без market making.
 *
 * ### Алгоритм:
 * 1. Ждём warmup (60s по умолчанию), накапливаем EWMA mid
 * 2. Проверяем условия входа (все должны быть true):
 *    - Mid в зоне [minZone, maxZone] (default 55-68¢)
 *    - |delta%| в диапазоне [minDelta, maxDelta] (default 0.03-0.12%)
 *    - Tau в диапазоне [minTau, maxTau] (default 120-210s)
 *    - Spread < maxSpread (default 4¢)
 *    - delta > 0 (BTC выше strike)
 * 3. Ставим limit BUY по mid - 1¢ (maker)
 * 4. Держим до settlement. Нет exit logic.
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
 * });
 * ```
 */
import { BaseStrategy } from '@polymarket/strategy';
import type { StrategySnapshot, StrategyIntent, TriggerReason } from '@polymarket/strategy';
import { Price, Quantity } from '@polymarket/value-objects';
import type { ILogger } from '@polymarket/logger';
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
  /** Направление: 'up' = покупаем UP токен (delta > 0), 'down' = покупаем DOWN токен (delta < 0). Default 'up'. */
  readonly side?: 'up' | 'down';
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
}

type SEAction =
  | { readonly type: 'BUY'; readonly price: number; readonly size: Decimal }
  | { readonly type: 'HOLD' };

// ── Реализация ────────────────────────────────────────────────────────────────

export class SelectiveEntryStrategy extends BaseStrategy<SEData, SEAction> {
  public readonly id: string;
  public readonly name = 'SelectiveEntryStrategy';

  private readonly _logger: ILogger | undefined;
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
  private readonly _side: 'up' | 'down';

  /** EWMA mid-price (центы) */
  private _ewma: number | null = null;
  private _tradeCount = 0;
  private _lastTradeTimestampMs = 0;

  /** Смена рынка */
  private _currentExpirationMs = 0;
  private _marketEventStartMs = 0;

  /** Вошли ли мы в этот рынок (поставили ордер) */
  private _entered = false;

  /** Время последнего диагностического лога (throttle) */
  private _lastDiagMs = 0;

  /** Время последнего gather-диагностического лога (throttle) */
  private _lastGatherDiagMs = 0;

  /** Счётчики фильтров (за текущий рынок) */
  private _rejectCounts = { noDelta: 0, deltaSign: 0, zone: 0, deltaRange: 0, tau: 0, spread: 0, balance: 0 };

  constructor(config: SelectiveEntryConfig, strategyId = 'selective-entry-1', logger?: ILogger) {
    super();
    this.id = strategyId;
    this._logger = logger;
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
    this._side = config.side ?? 'up';

    this._logger?.warn('SelectiveEntry: init', {
      side: this._side,
      zone: `${this._minZone}-${this._maxZone}`,
      delta: `${this._minDelta}-${this._maxDelta}%`,
      tau: `${this._minTau}-${this._maxTau}s`,
      maxSpread: this._maxSpread,
      warmup: this._warmupSec,
      bidOffset: this._bidOffset,
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
      this._entered = false;
      this._lastDiagMs = 0;
      this._rejectCounts = { noDelta: 0, deltaSign: 0, zone: 0, deltaRange: 0, tau: 0, spread: 0, balance: 0 };

      if (snapshot.eventStartMs) {
        this._marketEventStartMs = snapshot.eventStartMs;
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

    // EWMA из trade tape
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

    // Warmup
    const warmupElapsed = snapshot.nowMs - this._marketEventStartMs;
    if (warmupElapsed < this._warmupSec * 1000) {
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

    // Portfolio
    const position = snapshot.portfolio?.getPosition(snapshot.instrumentId);
    const positionQty = position?.quantity.value() ?? new Decimal(0);
    const availableBalance = snapshot.portfolio?.balance.available().value() ?? new Decimal(0);

    return {
      midCents: this._ewma,
      spreadCents,
      deltaPct,
      tauSec,
      hasPosition: positionQty.gt(0),
      hasPendingOrder: snapshot.hasInFlightFills || snapshot.matchedOrders.length > 0,
      availableBalance,
      nowMs: snapshot.nowMs,
      cryptoPrice,
      strikePrice,
    };
  }

  // ── decide ──────────────────────────────────────────────────────────────────

  protected decide(data: SEData, _reasons: ReadonlySet<TriggerReason>): SEAction[] {
    // Уже вошли или есть позиция/ордер → держим до settlement
    if (this._entered || data.hasPosition || data.hasPendingOrder) {
      return [{ type: 'HOLD' }];
    }

    const mid = Math.round(Math.max(2, Math.min(98, data.midCents)));

    // ── Проверяем каждый фильтр, запоминая причину отказа ──

    let rejectReason = '';

    // Для side='down' используем abs(delta) и проверяем что delta < 0 (BTC ниже strike)
    const deltaForSign = data.deltaPct;
    const absDelta = data.deltaPct !== undefined ? Math.abs(data.deltaPct) : undefined;
    const wrongSign = this._side === 'up' ? (deltaForSign !== undefined && deltaForSign <= 0)
                                           : (deltaForSign !== undefined && deltaForSign >= 0);

    if (data.deltaPct === undefined) {
      this._rejectCounts.noDelta++;
      rejectReason = 'no_delta';
    } else if (wrongSign) {
      this._rejectCounts.deltaSign++;
      rejectReason = `delta_wrong_sign(${data.deltaPct.toFixed(4)}%,need=${this._side})`;
    } else if (mid < this._minZone || mid > this._maxZone) {
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
    }

    // Диагностический лог каждые 10 секунд
    if (data.nowMs - this._lastDiagMs >= 10_000) {
      this._lastDiagMs = data.nowMs;
      this._logger?.info('SelectiveEntry: tick', {
        side: this._side,
        mid,
        delta: data.deltaPct !== undefined ? data.deltaPct.toFixed(4) + '%' : '?',
        tau: data.tauSec.toFixed(0) + 's',
        spread: data.spreadCents.toFixed(1),
        crypto: data.cryptoPrice?.toFixed(2),
        strike: data.strikePrice?.toFixed(2),
        reject: rejectReason || 'PASS',
        rejects: this._rejectCounts,
      });
    }

    if (rejectReason) return [{ type: 'HOLD' }];

    // Balance check
    const bidPrice = Math.max(1, mid - this._bidOffset);
    const cost = this._orderSize.mul(bidPrice).div(100);
    if (data.availableBalance.lt(cost)) {
      this._rejectCounts.balance++;
      return [{ type: 'HOLD' }];
    }

    // ── ENTRY: все фильтры пройдены, ставим limit BUY ──
    this._entered = true;

    this._logger?.warn('SelectiveEntry: BUY', {
      mid,
      bidPrice,
      delta: data.deltaPct!.toFixed(4) + '%',
      cryptoPrice: data.cryptoPrice?.toFixed(2),
      strike: data.strikePrice?.toFixed(2),
      tau: data.tauSec.toFixed(0),
      spread: data.spreadCents.toFixed(1),
      rejects: this._rejectCounts,
    });

    return [{ type: 'BUY', price: bidPrice, size: this._orderSize }];
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
      });
    }

    return intents;
  }
}
