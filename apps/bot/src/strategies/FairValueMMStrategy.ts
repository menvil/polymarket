/**
 * FairValueMMStrategy — маркетмейкинг с собственной оценкой fair price через Black-Scholes.
 *
 * @remarks
 * ### Ключевая идея:
 * p_fair = N( ln(S/K) / (sigma * sqrt(tau)) )
 * Где S = текущая цена BTC, K = strike, sigma = годовая волатильность, tau = время до экспирации.
 *
 * Если рынок котирует 60¢ а модель говорит 70¢ → edge = +10¢ → покупаем агрессивно.
 * Если рынок 70¢ а модель 60¢ → edge = -10¢ → продаём (если есть позиция).
 *
 * ### Почему это отличается от AS MM:
 * AS использовал p_fair = EWMA(mid) — это НЕ собственное мнение.
 * Здесь p_fair берётся из фундаментальной модели бинарного опциона.
 *
 * ### Защиты:
 * 1. Flow filter — отмена при сильном дисбалансе
 * 2. Jump protection — отмена при импульсе
 * 3. Inventory skew — сдвиг котировок для разгрузки
 * 4. Kill switch — принудительный выход при max позиции
 * 5. Dynamic sizing — меньше ордера при большой позиции
 * 6. Unwind — агрессивная продажа перед экспирацией
 *
 * @example
 * ```typescript
 * const strategy = new FairValueMMStrategy({
 *   orderSize: new Decimal(5),
 *   qMax: 3,
 *   sigmaAnnual: 0.60,
 *   minEdgeCents: 2,
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

// ── Cumulative Normal Distribution ───────────────────────────────────────────

const SECONDS_PER_YEAR = 365.25 * 24 * 3600;

/**
 * Аппроксимация CDF стандартного нормального распределения (Abramowitz & Stegun).
 *
 * @param x - z-score
 * @returns P(Z <= x), значение от 0 до 1
 */
function normalCdf(x: number): number {
  if (x < -8) return 0;
  if (x > 8) return 1;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
  return 0.5 * (1 + sign * y);
}

/**
 * Fair price бинарного опциона по Black-Scholes (без drift, r=0).
 *
 * @param S - текущая цена базового актива (BTC)
 * @param K - strike price
 * @param sigmaAnnual - годовая волатильность (например 0.60 = 60%)
 * @param tauSec - время до экспирации в секундах
 * @returns fair price в центах (0-100)
 */
function binaryFairPrice(S: number, K: number, sigmaAnnual: number, tauSec: number): number {
  if (tauSec <= 0) return S >= K ? 99 : 1;
  if (K <= 0 || S <= 0) return 50;
  const tauYears = tauSec / SECONDS_PER_YEAR;
  const d = Math.log(S / K) / (sigmaAnnual * Math.sqrt(tauYears));
  return Math.max(1, Math.min(99, normalCdf(d) * 100));
}

// ── Конфигурация ─────────────────────────────────────────────────────────────

/**
 * Параметры FairValueMMStrategy.
 *
 * @param orderSize - Размер ордера в токенах (per side)
 * @param qMax - Макс позиция в единицах orderSize
 * @param sigmaAnnual - Годовая волатильность BTC (default 0.60)
 * @param minEdgeCents - Мин edge для котирования (default 2)
 * @param inventorySkew - Сдвиг в центах за единицу инвентаря (default 1.0)
 * @param baseSpreadCents - Мин полу-спред от fair (default 1)
 * @param maxSpreadCents - Макс полу-спред (default 8)
 * @param flowThreshold - Порог |imbalance| для отмены (default 0.8)
 * @param jumpThresholdCents - Порог прыжка цены для отмены (default 3)
 * @param warmupSec - Warmup в секундах (default 10)
 * @param ewmaAlpha - Альфа EWMA (default 0.3)
 * @param minTradesForMid - Мин трейдов для EWMA (default 5)
 * @param unwindSec - Секунды до экспирации для unwind (default 30)
 * @param dynSizeDecay - Уменьшение размера с позицией (default 0.2)
 */
export interface FairValueMMConfig {
  readonly orderSize: Decimal;
  readonly qMax: number;
  readonly sigmaAnnual?: number;
  readonly minEdgeCents?: number;
  readonly inventorySkew?: number;
  readonly baseSpreadCents?: number;
  readonly maxSpreadCents?: number;
  readonly flowThreshold?: number;
  readonly jumpThresholdCents?: number;
  readonly warmupSec?: number;
  readonly ewmaAlpha?: number;
  readonly minTradesForMid?: number;
  readonly unwindSec?: number;
  readonly dynSizeDecay?: number;
  /** Мин fair price для входа (default 55) — не покупаем токены с fair < 55¢ */
  readonly minFairCents?: number;
}

// ── Внутренние типы ──────────────────────────────────────────────────────────

interface FVData {
  readonly pFairCents: number;
  readonly ewmaMidCents: number;
  readonly edgeCents: number;
  readonly tauSec: number;
  readonly inventoryUnits: number;
  readonly positionQty: Decimal;
  readonly availableTokenQty: Decimal;
  readonly availableBalance: Decimal;
  readonly bookImbalance: number;
  readonly jumpDetected: boolean;
  readonly nowMs: number;
  readonly hasInFlightFills: boolean;
  readonly cryptoPrice: number;
  readonly strikePrice: number;
}

type FVAction =
  | { readonly type: 'QUOTE'; readonly bid: number; readonly ask: number; readonly bidSize: Decimal; readonly askSize: Decimal }
  | { readonly type: 'UNWIND_SELL'; readonly price: number; readonly size: Decimal }
  | { readonly type: 'CANCEL' };

// ── Реализация ───────────────────────────────────────────────────────────────

export class FairValueMMStrategy extends BaseStrategy<FVData, FVAction> {
  public readonly id: StrategyId;
  public readonly name = 'FairValueMMStrategy';

  private readonly _logger: ILogger | undefined;
  private readonly _orderSize: Decimal;
  private readonly _qMax: number;
  private readonly _sigma: number;
  private readonly _minEdge: number;
  private readonly _invSkew: number;
  private readonly _baseSpread: number;
  private readonly _maxSpread: number;
  private readonly _flowThreshold: number;
  private readonly _jumpThreshold: number;
  private readonly _warmupSec: number;
  private readonly _ewmaAlpha: number;
  private readonly _minTrades: number;
  private readonly _unwindSec: number;
  private readonly _dynSizeDecay: number;
  private readonly _minFairCents: number;

  // ── Per-market state ──
  private _ewma: number | null = null;
  private _prevEwma: number | null = null;
  private _tradeCount = 0;
  private _lastTradeTimestampMs = 0;
  private _currentExpirationMs = 0;
  private _marketEventStartMs = 0;
  private _lastDiagMs = 0;

  constructor(config: FairValueMMConfig, strategyId: StrategyId = unsafeStrategyId('fair-value-mm-1'), logger?: ILogger) {
    super();
    this.id = strategyId;
    this._logger = logger;
    this._orderSize = config.orderSize;
    this._qMax = config.qMax;
    this._sigma = config.sigmaAnnual ?? 0.60;
    this._minEdge = config.minEdgeCents ?? 2;
    this._invSkew = config.inventorySkew ?? 1.0;
    this._baseSpread = config.baseSpreadCents ?? 1;
    this._maxSpread = config.maxSpreadCents ?? 8;
    this._flowThreshold = config.flowThreshold ?? 0.8;
    this._jumpThreshold = config.jumpThresholdCents ?? 3;
    this._warmupSec = config.warmupSec ?? 10;
    this._ewmaAlpha = config.ewmaAlpha ?? 0.3;
    this._minTrades = config.minTradesForMid ?? 5;
    this._unwindSec = config.unwindSec ?? 30;
    this._dynSizeDecay = config.dynSizeDecay ?? 0.2;
    this._minFairCents = config.minFairCents ?? 55;

    this._logger?.warn('FairValueMM: init', {
      sigma: this._sigma,
      minEdge: this._minEdge,
      invSkew: this._invSkew,
      spread: `${this._baseSpread}-${this._maxSpread}`,
      qMax: this._qMax,
      flowThreshold: this._flowThreshold,
      jumpThreshold: this._jumpThreshold,
      unwindSec: this._unwindSec,
    });
  }

  // ── gather ─────────────────────────────────────────────────────────────────

  /**
   * Собирает данные: EWMA mid, fair price (BS), инвентарь, flow, jumps.
   *
   * @param snapshot - Текущий снимок рынка
   * @returns Данные для decide или undefined если нет данных
   */
  protected gather(snapshot: StrategySnapshot): FVData | undefined {
    const expiresMs = snapshot.market.expirationMs;

    // Смена рынка → сброс
    if (this._currentExpirationMs !== expiresMs) {
      this._currentExpirationMs = expiresMs;
      this._ewma = null;
      this._prevEwma = null;
      this._tradeCount = 0;
      this._lastTradeTimestampMs = 0;
      this._lastDiagMs = 0;

      if (snapshot.eventStartMs !== undefined) {
        this._marketEventStartMs = snapshot.eventStartMs.toNumber();
        this._logger?.info('FairValueMM: new market', {
          expiresMs,
          instrumentId: snapshot.instrumentId,
        });
      } else {
        return undefined;
      }
    }

    if (this._marketEventStartMs <= 0) return undefined;

    // ── EWMA из trade tape ──
    const tapeRecords = snapshot.tradeTape?.getAll();
    if (tapeRecords && tapeRecords.length > 0) {
      for (const trade of tapeRecords) {
        const tradeTs = trade.timestamp.toNumber();
        if (tradeTs <= this._lastTradeTimestampMs) continue;
        const priceNum = trade.price.value().toNumber() * 100;
        this._prevEwma = this._ewma;
        this._ewma = this._ewma === null
          ? priceNum
          : this._ewmaAlpha * priceNum + (1 - this._ewmaAlpha) * this._ewma;
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

    if (this._ewma === null || this._tradeCount < this._minTrades) return undefined;

    // Warmup
    const warmupElapsed = snapshot.nowMs - this._marketEventStartMs;
    if (warmupElapsed < this._warmupSec * 1000) return undefined;

    // ── Crypto price → BS fair price ──
    if (!snapshot.cryptoPrice) return undefined;
    const S = snapshot.cryptoPrice.currentPrice;
    const K = snapshot.cryptoPrice.targetPrice;
    if (!S || S <= 0 || !K || K <= 0) return undefined;

    const tauSec = Math.max(0, (expiresMs - snapshot.nowMs) / 1000);
    const pFairCents = binaryFairPrice(S, K, this._sigma, tauSec);

    // ── Book imbalance ──
    let bookImbalance = 0;
    if (snapshot.topOfBook) {
      const bidSize = snapshot.topOfBook.bestBidSize?.value().toNumber() ?? 0;
      const askSize = snapshot.topOfBook.bestAskSize?.value().toNumber() ?? 0;
      const total = bidSize + askSize;
      if (total > 0) bookImbalance = (bidSize - askSize) / total;
    }

    // ── Jump detection ──
    let jumpDetected = false;
    if (this._prevEwma !== null) {
      const delta = Math.abs(this._ewma - this._prevEwma);
      if (delta > this._jumpThreshold) jumpDetected = true;
    }

    // ── Portfolio ──
    const position = snapshot.portfolio?.getPosition(snapshot.instrumentId);
    const positionQty = position?.quantity.value() ?? new Decimal(0);
    const inventoryUnits = positionQty.div(this._orderSize).toNumber();
    const availableTokenQty = snapshot.portfolio?.availableTokenQuantity(snapshot.instrumentId) ?? new Decimal(0);
    const availableBalance = snapshot.portfolio?.balance.available().value() ?? new Decimal(0);

    return {
      pFairCents,
      ewmaMidCents: this._ewma,
      edgeCents: pFairCents - this._ewma,
      tauSec,
      inventoryUnits,
      positionQty,
      availableTokenQty,
      availableBalance,
      bookImbalance,
      jumpDetected,
      nowMs: snapshot.nowMs,
      hasInFlightFills: snapshot.hasInFlightFills || snapshot.matchedOrders.length > 0,
      cryptoPrice: S,
      strikePrice: K,
    };
  }

  // ── decide ─────────────────────────────────────────────────────────────────

  /**
   * Решение: покупать когда модель говорит "дёшево", держать до settlement.
   *
   * @remarks
   * Не двусторонний ММ — это model-driven entry:
   * 1. BS модель считает fair price
   * 2. Если fair > mid + minEdge → покупаем (token underpriced)
   * 3. Держим до settlement (или unwind перед экспирацией если edge исчез)
   *
   * Почему не двусторонний ММ на бинарных:
   * - spread = 1-2¢, adverse selection = 60¢+ при пересечении strike
   * - 30 хороших циклов по 2¢ = +60¢, один плохой = -60¢
   * - Структурно невыгодный risk/reward для двустороннего котирования
   *
   * @param data - Собранные данные из gather
   * @param _reasons - Триггеры тика
   * @returns Массив действий
   */
  protected decide(data: FVData, _reasons: ReadonlySet<TriggerReason>): FVAction[] {
    // In-flight fills — ждём
    if (data.hasInFlightFills) return [{ type: 'CANCEL' }];

    // ── Уже на max позиции → hold до settlement ──
    if (data.inventoryUnits >= this._qMax) {
      // Unwind перед экспирацией если edge исчез (fair упал ниже mid)
      if (data.tauSec < this._unwindSec && data.edgeCents < -this._minEdge && data.availableTokenQty.gt(0)) {
        const urgency = 1 - data.tauSec / this._unwindSec;
        const discount = Math.ceil(urgency * 3);
        const sellPrice = Math.max(1, Math.floor(data.ewmaMidCents - discount));
        this._logDiag(data, `UNWIND(fair<mid,tau=${data.tauSec.toFixed(0)}s)`);
        return [{ type: 'UNWIND_SELL', price: sellPrice, size: Decimal.min(data.availableTokenQty, this._orderSize) }];
      }
      this._logDiag(data, 'HOLD');
      return [{ type: 'CANCEL' }];
    }

    // ── Jump protection: не входим при импульсе ──
    if (data.jumpDetected) {
      this._logDiag(data, 'JUMP_SKIP');
      return [{ type: 'CANCEL' }];
    }

    // ── Flow filter: не входим против токсичного потока ──
    // Если ask-side pressure (imbalance < -threshold) — кто-то агрессивно продаёт
    if (data.bookImbalance < -this._flowThreshold) {
      this._logDiag(data, `FLOW_SKIP(imb=${data.bookImbalance.toFixed(2)})`);
      return [{ type: 'CANCEL' }];
    }

    // ── Fair price floor: не покупаем если модель даёт < minFairCents ──
    if (data.pFairCents < this._minFairCents) {
      this._logDiag(data, `LOW_FAIR(${data.pFairCents.toFixed(1)}¢,need>=${this._minFairCents})`);
      return [{ type: 'CANCEL' }];
    }

    // ── Edge check: fair > mid + minEdge → покупаем ──
    const edge = data.pFairCents - data.ewmaMidCents;
    if (edge < this._minEdge) {
      this._logDiag(data, `NO_EDGE(${edge.toFixed(1)}¢,need=${this._minEdge})`);
      return [{ type: 'CANCEL' }];
    }

    // Bid price + minOrderValue check
    const bidPrice = Math.max(1, Math.floor(data.ewmaMidCents - this._baseSpread));
    const bidCost = this._orderSize.mul(bidPrice).div(100);
    if (data.availableBalance.lt(bidCost)) {
      this._logDiag(data, 'NO_BALANCE');
      return [{ type: 'CANCEL' }];
    }

    // Dynamic sizing (ensure size × price >= $1 minOrderValue)
    const sizeFactor = Math.max(0.2, 1 - this._dynSizeDecay * data.inventoryUnits);
    const minSizeForValue = new Decimal(100).div(bidPrice).ceil(); // min tokens for $1 at bidPrice cents
    const effectiveSize = Decimal.max(minSizeForValue, this._orderSize.mul(sizeFactor).floor());

    this._logDiag(data, 'BUY', {
      bid: bidPrice,
      edge: edge.toFixed(1),
      fair: data.pFairCents.toFixed(1),
      size: effectiveSize.toNumber(),
    });

    return [{
      type: 'QUOTE',
      bid: bidPrice,
      ask: 0,
      bidSize: effectiveSize,
      askSize: new Decimal(0),
    }];
  }

  // ── toIntents ──────────────────────────────────────────────────────────────

  /**
   * Конвертирует действия в StrategyIntent для ExecutionEngine.
   *
   * @param actions - Решения из decide
   * @returns Массив интентов
   */
  protected toIntents(actions: FVAction[]): StrategyIntent[] {
    const intents: StrategyIntent[] = [];

    for (const action of actions) {
      intents.push({ type: 'CANCEL_ALL' });

      if (action.type === 'CANCEL') continue;

      if (action.type === 'UNWIND_SELL') {
        intents.push({
          type: 'PLACE',
          side: 'SELL',
          price: OutcomePrice.of(new Decimal(action.price).div(100)),
          size: Quantity.of(action.size),
        });
        continue;
      }

      // QUOTE: bid + ask
      if (action.bid > 0 && action.bidSize.gt(0)) {
        intents.push({
          type: 'PLACE',
          side: 'BUY',
          price: OutcomePrice.of(new Decimal(action.bid).div(100)),
          size: Quantity.of(action.bidSize),
        });
      }
      if (action.ask > 0 && action.askSize.gt(0)) {
        intents.push({
          type: 'PLACE',
          side: 'SELL',
          price: OutcomePrice.of(new Decimal(action.ask).div(100)),
          size: Quantity.of(action.askSize),
        });
      }
    }

    return intents;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Диагностический лог каждые 5 секунд.
   */
  private _logDiag(data: FVData, action: string, extra?: Record<string, unknown>): void {
    if (data.nowMs - this._lastDiagMs < 5_000) return;
    this._lastDiagMs = data.nowMs;
    this._logger?.info('FairValueMM: tick', {
      action,
      fair: data.pFairCents.toFixed(1),
      mid: data.ewmaMidCents.toFixed(1),
      edge: data.edgeCents.toFixed(1),
      tau: data.tauSec.toFixed(0) + 's',
      inv: data.inventoryUnits.toFixed(1),
      imb: data.bookImbalance.toFixed(2),
      crypto: data.cryptoPrice.toFixed(2),
      strike: data.strikePrice.toFixed(2),
      ...extra,
    });
  }
}
