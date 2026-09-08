/**
 * CryptoProbStrategy — directional торговля на основе P(UP) из крипто-цены.
 *
 * @remarks
 * Использует эмпирическую таблицу P(UP | delta%, tau) построенную на Chainlink crypto_price
 * vs priceToBeat. Торгует directional: покупает когда P(UP) высокая, продаёт когда падает.
 *
 * ### Алгоритм:
 * 1. **ENTRY (maker)**: P(UP) >= entryProb → ставим limit BUY по floor(fairValue - minEdge) в стакан.
 *    fairValue = P(UP) × 100 центов. Мы maker — экономим на комиссиях.
 * 2. **HOLD**: entryProb > P(UP) >= exitProb — держим позицию, ничего не делаем
 * 3. **EXIT (taker)**: P(UP) < exitProb → агрессивный SELL по mid - exitDiscount
 * 4. **TIME EXIT**: tau < exitTauSec → агрессивный SELL
 * 5. **RE-ENTRY**: После выхода, если edge снова появляется — покупаем заново.
 *    Нет блокировки re-entry. Edge-check сам по себе фильтрует плохие входы.
 *
 * @example
 * ```typescript
 * const strategy = new CryptoProbStrategy({
 *   orderSize: new Decimal(5),
 *   qMax: 5,
 *   entryProb: 60,  // покупаем при P(UP) >= 60%
 *   exitProb: 40,   // продаём при P(UP) < 40%
 *   minEdgeCents: 3, // P(UP)*100 - price >= 3¢
 *   exitTauSec: 30,
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

// ── P(UP | delta%, tau) таблица ─────────────────────────────────────────────
// Построена на 938 BTC 5-мин рынках (Chainlink crypto_price vs priceToBeat).

const CRYPTO_DELTA_BUCKETS = [-0.5, -0.3, -0.2, -0.15, -0.1, -0.05, -0.02, 0, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5];
const CRYPTO_TAU_BUCKETS = [30, 60, 90, 120, 150, 180, 210, 240, 270, 300];

const CRYPTO_PROB_TABLE: readonly (readonly number[])[] = [
  /* -0.50% */ [0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00],
  /* -0.30% */ [0.00, 0.00, 0.00, 0.02, 0.07, 0.04, 0.11, 0.12, 0.04, 0.04],
  /* -0.20% */ [0.00, 0.00, 0.00, 0.01, 0.00, 0.02, 0.01, 0.03, 0.13, 0.03],
  /* -0.15% */ [0.00, 0.01, 0.02, 0.03, 0.09, 0.08, 0.10, 0.12, 0.13, 0.13],
  /* -0.10% */ [0.05, 0.08, 0.14, 0.13, 0.11, 0.13, 0.16, 0.21, 0.19, 0.17],
  /* -0.05% */ [0.06, 0.10, 0.15, 0.19, 0.25, 0.26, 0.30, 0.30, 0.36, 0.30],
  /* -0.02% */ [0.21, 0.30, 0.33, 0.34, 0.38, 0.44, 0.38, 0.40, 0.43, 0.49],
  /* +0.00% */ [0.43, 0.47, 0.45, 0.51, 0.49, 0.52, 0.48, 0.49, 0.47, 0.55],
  /* +0.02% */ [0.75, 0.63, 0.66, 0.63, 0.68, 0.67, 0.57, 0.60, 0.59, 0.60],
  /* +0.05% */ [0.93, 0.82, 0.78, 0.77, 0.76, 0.74, 0.75, 0.68, 0.62, 0.60],
  /* +0.10% */ [0.99, 0.93, 0.87, 0.85, 0.83, 0.81, 0.83, 0.79, 0.76, 0.70],
  /* +0.15% */ [1.00, 0.97, 0.93, 0.91, 0.90, 0.85, 0.83, 0.81, 0.82, 0.76],
  /* +0.20% */ [1.00, 0.99, 0.98, 0.95, 0.93, 0.92, 0.90, 0.86, 0.96, 0.94],
  /* +0.30% */ [1.00, 1.00, 1.00, 1.00, 1.00, 0.98, 0.99, 0.99, 0.94, 0.98],
  /* +0.50% */ [1.00, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00, 0.99, 0.96],
];

/**
 * Lookup P(UP) по delta% и tau (секунды).
 *
 * @param deltaPct - (crypto_price - priceToBeat) / priceToBeat × 100
 * @param tauSec - Секунды до resolution
 * @returns P(UP) ∈ [0, 1] или undefined если tau > 300
 */
function lookupCryptoProbUp(deltaPct: number, tauSec: number): number | undefined {
  if (tauSec > 300) return undefined;

  let deltaIdx = 0;
  for (let i = 0; i < CRYPTO_DELTA_BUCKETS.length; i++) {
    if (deltaPct <= CRYPTO_DELTA_BUCKETS[i]!) {
      deltaIdx = i;
      break;
    }
    deltaIdx = i;
  }

  let tauIdx = 0;
  for (let i = 0; i < CRYPTO_TAU_BUCKETS.length; i++) {
    if (tauSec <= CRYPTO_TAU_BUCKETS[i]!) {
      tauIdx = i;
      break;
    }
    tauIdx = i;
  }

  return CRYPTO_PROB_TABLE[deltaIdx]![tauIdx]!;
}

// ── Конфигурация ──────────────────────────────────────────────────────────────

/**
 * Параметры CryptoProbStrategy.
 *
 * @param orderSize - Размер одного ордера в токенах
 * @param qMax - Максимальная позиция в единицах orderSize
 * @param entryProb - Минимальная P(UP) в % для входа (default 60)
 * @param exitProb - P(UP) ниже которой выходим в % (default 40)
 * @param minEdgeCents - Минимальный edge: P(UP)*100 - marketPrice >= minEdge (default 0)
 * @param exitTauSec - Принудительный выход если tau < этого (default 30)
 * @param warmupSec - Секунды ожидания перед торговлей (default 10)
 * @param exitDiscountCents - Дисконт при агрессивной продаже (default 1)
 * @param minBidZoneCents - Нижняя граница зоны покупки (default 0 — без зоны)
 * @param maxBidZoneCents - Верхняя граница зоны покупки (default 100 — без зоны)
 * @param minDeltaPct - Минимальный |delta%| для входа (default 0 — без фильтра)
 * @param maxEntryTauSec - Максимальный tau при входе (default 300 — без фильтра)
 * @param minEntryProb - Минимальный P(UP) % для входа, поверх entryProb (default 0 — без фильтра)
 */
export interface CryptoProbConfig {
  readonly orderSize: Decimal;
  readonly qMax: number;
  readonly entryProb?: number;
  readonly exitProb?: number;
  readonly minEdgeCents?: number;
  readonly exitTauSec?: number;
  readonly warmupSec?: number;
  readonly exitDiscountCents?: number;
  readonly minBidZoneCents?: number;
  readonly maxBidZoneCents?: number;
  readonly minDeltaPct?: number;
  readonly maxEntryTauSec?: number;
  readonly minEntryProb?: number;
}

// ── Внутренние типы ───────────────────────────────────────────────────────────

interface CPData {
  readonly probUp: number | undefined;
  readonly deltaPct: number | undefined;
  readonly cryptoPrice: number | undefined;
  readonly strikePrice: number | undefined;
  readonly midCents: number;
  readonly tauSec: number;
  readonly positionQty: Decimal;
  readonly availableTokenQty: Decimal;
  readonly availableBalance: Decimal;
  readonly inventoryUnits: number;
  readonly hasInFlightFills: boolean;
  readonly nowMs: number;
}

type CPAction =
  | { readonly type: 'BUY'; readonly price: number; readonly size: Decimal }
  | { readonly type: 'SELL'; readonly price: number; readonly size: Decimal }
  | { readonly type: 'STOP' };

// ── Реализация ────────────────────────────────────────────────────────────────

export class CryptoProbStrategy extends BaseStrategy<CPData, CPAction> {
  public readonly id: StrategyId;
  public readonly name = 'CryptoProbStrategy';

  private readonly _logger: ILogger | undefined;
  private readonly _orderSize: Decimal;
  private readonly _qMax: number;
  private readonly _entryProb: number;
  private readonly _exitProb: number;
  private readonly _minEdgeCents: number;
  private readonly _exitTauSec: number;
  private readonly _warmupSec: number;
  private readonly _exitDiscountCents: number;
  private readonly _minBidZoneCents: number;
  private readonly _maxBidZoneCents: number;
  private readonly _minDeltaPct: number;
  private readonly _maxEntryTauSec: number;
  private readonly _minEntryProb: number;

  /** EWMA mid-price (центы) */
  private _ewma: number | null = null;
  private _tradeCount = 0;
  private _lastTradeTimestampMs = 0;

  /** Смена рынка */
  private _currentExpirationMs = 0;
  private _marketEventStartMs = 0;

  /** Количество выходов за этот рынок (для диагностики) */
  private _exitCount = 0;

  /** Состояние последнего входа (для логирования при exit) */
  private _entryDeltaPct = 0;
  private _entryMidCents = 0;
  private _entryBidPrice = 0;
  private _entryMs = 0;
  private _entryTauSec = 0;
  private _entryCryptoPrice = 0;
  private _entryProbUp = 0;

  constructor(config: CryptoProbConfig, strategyId: StrategyId = unsafeStrategyId('crypto-prob-1'), logger?: ILogger) {
    super();
    this.id = strategyId;
    this._logger = logger;
    this._orderSize = config.orderSize;
    this._qMax = config.qMax;
    this._entryProb = (config.entryProb ?? 60) / 100;
    this._exitProb = (config.exitProb ?? 40) / 100;
    this._minEdgeCents = config.minEdgeCents ?? 0;
    this._exitTauSec = config.exitTauSec ?? 30;
    this._warmupSec = config.warmupSec ?? 10;
    this._exitDiscountCents = config.exitDiscountCents ?? 1;
    this._minBidZoneCents = config.minBidZoneCents ?? 0;
    this._maxBidZoneCents = config.maxBidZoneCents ?? 100;
    this._minDeltaPct = config.minDeltaPct ?? 0;
    this._maxEntryTauSec = config.maxEntryTauSec ?? 300;
    this._minEntryProb = (config.minEntryProb ?? 0) / 100;

    this._logger?.warn('CryptoProb: init', {
      entryProb: (this._entryProb * 100).toFixed(0) + '%',
      exitProb: (this._exitProb * 100).toFixed(0) + '%',
      minEdge: this._minEdgeCents,
      exitTau: this._exitTauSec,
      zone: `${this._minBidZoneCents}-${this._maxBidZoneCents}`,
      minDelta: this._minDeltaPct,
      maxEntryTau: this._maxEntryTauSec,
      minEntryProb: (this._minEntryProb * 100).toFixed(0) + '%',
    });
  }

  // ── gather ──────────────────────────────────────────────────────────────────

  protected gather(snapshot: StrategySnapshot): CPData | undefined {
    const expiresMs = snapshot.market.expiresAt.toNumber();

    // Смена рынка → сброс
    if (this._currentExpirationMs !== expiresMs) {
      this._currentExpirationMs = expiresMs;
      this._ewma = null;
      this._tradeCount = 0;
      this._lastTradeTimestampMs = 0;
      this._exitCount = 0;
      this._entryMs = 0;

      if (snapshot.eventStartMs !== undefined) {
        this._marketEventStartMs = snapshot.eventStartMs.toNumber();
      } else {
        return undefined;
      }
    }

    if (this._marketEventStartMs <= 0) return undefined;

    const tauSec = Math.max(0, (expiresMs - snapshot.nowMs) / 1000);

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

    if (this._ewma === null || this._tradeCount < 3) return undefined;

    // Warmup
    if ((snapshot.nowMs - this._marketEventStartMs) < this._warmupSec * 1000) {
      return undefined;
    }

    // P(UP) и delta из crypto price
    let probUp: number | undefined;
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
        probUp = lookupCryptoProbUp(deltaPct, tauSec);
      }
    }

    // Portfolio
    const position = snapshot.portfolio?.getPosition(snapshot.instrumentId);
    const positionQty = position?.quantity.value() ?? new Decimal(0);
    const availableTokenQty = snapshot.portfolio?.availableTokenQuantity(snapshot.instrumentId) ?? new Decimal(0);
    const availableBalance = snapshot.portfolio?.balance.available().value() ?? new Decimal(0);
    const orderSizeNum = this._orderSize.toNumber();
    const inventoryUnits = orderSizeNum > 0 ? positionQty.toNumber() / orderSizeNum : 0;

    return {
      probUp,
      deltaPct,
      cryptoPrice,
      strikePrice,
      midCents: this._ewma,
      tauSec,
      positionQty,
      availableTokenQty,
      availableBalance,
      inventoryUnits,
      hasInFlightFills: snapshot.hasInFlightFills || snapshot.matchedOrders.length > 0,
      nowMs: snapshot.nowMs,
    };
  }

  // ── decide ──────────────────────────────────────────────────────────────────

  protected decide(data: CPData, _reasons: ReadonlySet<TriggerReason>): CPAction[] {
    if (data.hasInFlightFills) return [];

    const hasPosition = data.positionQty.gt(0);
    const mid = Math.round(Math.max(2, Math.min(98, data.midCents)));

    // ── EXIT: P(UP) упала ниже порога или время заканчивается ──
    if (hasPosition) {
      const exitAction = this._checkExit(data, mid);
      if (exitAction) return [exitAction];

      // Держим позицию — P(UP) между exitProb и entryProb
      return [{ type: 'STOP' }];
    }

    // ── ENTRY: limit BUY в стакан по fairValue - minEdge ──
    return this._checkEntry(data, mid);
  }

  /**
   * Проверяет условия выхода из позиции.
   *
   * @remarks
   * Агрессивный выход: SELL по mid - exitDiscountCents.
   * Срабатывает когда P(UP) < exitProb или tau < exitTauSec.
   * Re-entry разрешён — после продажи можно снова купить если edge появится.
   *
   * @param data - Собранные данные рынка
   * @param mid - Текущая EWMA mid price в центах
   * @returns CPAction для выхода или undefined если держим
   */
  private _checkExit(data: CPData, mid: number): CPAction | undefined {
    let reason = '';

    if (data.probUp !== undefined && data.probUp < this._exitProb) {
      reason = `prob=${(data.probUp * 100).toFixed(0)}%<${(this._exitProb * 100).toFixed(0)}%`;
    } else if (data.tauSec < this._exitTauSec) {
      reason = `tau=${data.tauSec.toFixed(0)}<${this._exitTauSec}`;
    } else {
      return undefined;
    }

    if (!data.availableTokenQty.gt(0)) return { type: 'STOP' };

    this._exitCount++;
    const ask = Math.max(1, mid - this._exitDiscountCents);
    const askSize = Decimal.min(this._orderSize, data.availableTokenQty);

    const holdSec = this._entryMs > 0 ? (data.nowMs - this._entryMs) / 1000 : 0;
    const deltaShift = (data.deltaPct ?? 0) - this._entryDeltaPct;
    const pnlCents = ask - this._entryBidPrice;

    this._logger?.warn('CryptoProb: EXIT', {
      reason,
      // Текущее состояние
      probUp: data.probUp !== undefined ? (data.probUp * 100).toFixed(0) + '%' : '?',
      delta: data.deltaPct?.toFixed(4) + '%',
      cryptoPrice: data.cryptoPrice?.toFixed(2),
      mid,
      ask,
      tau: data.tauSec.toFixed(0),
      // Сравнение с входом
      entryBid: this._entryBidPrice,
      entryDelta: this._entryDeltaPct.toFixed(4) + '%',
      entryProb: (this._entryProbUp * 100).toFixed(0) + '%',
      entryMid: this._entryMidCents,
      entryTau: this._entryTauSec.toFixed(0),
      entryCrypto: this._entryCryptoPrice.toFixed(2),
      // Дельты
      deltaShift: deltaShift.toFixed(4) + '%',
      midShift: mid - this._entryMidCents,
      pnlCents,
      holdSec: holdSec.toFixed(0) + 's',
      exits: this._exitCount,
    });

    return { type: 'SELL', price: ask, size: askSize };
  }

  /**
   * Проверяет условия входа и ставит limit BUY в стакан.
   *
   * @remarks
   * Цена BUY = floor(fairValue - minEdgeCents).
   * fairValue = P(UP) × 100 центов.
   * Мы maker — ставим в стакан, а не берём по рынку.
   * Re-entry разрешён: если после выхода edge снова появляется — покупаем.
   *
   * @param data - Собранные данные рынка
   * @param mid - Текущая EWMA mid price в центах (для zone filter)
   * @returns Массив CPAction (BUY или пусто)
   */
  private _checkEntry(data: CPData, mid: number): CPAction[] {
    // Нет P(UP) данных → ничего
    if (data.probUp === undefined) return [{ type: 'STOP' }];

    // Мало времени → не входим
    if (data.tauSec < this._exitTauSec + 30) return [{ type: 'STOP' }];

    // Слишком рано → не входим (много времени = большой риск разворота)
    if (data.tauSec > this._maxEntryTauSec) return [];

    // P(UP) достаточно высокая?
    if (data.probUp < this._entryProb) return [];

    // Минимальный P(UP) фильтр (поверх entryProb, для отсечения слабых сигналов)
    if (this._minEntryProb > 0 && data.probUp < this._minEntryProb) return [];

    // Минимальный |delta%| фильтр (маленькая дельта = рынок на ноже)
    if (this._minDeltaPct > 0 && data.deltaPct !== undefined && Math.abs(data.deltaPct) < this._minDeltaPct) return [];

    // fairValue и bid price: ставим в стакан как maker
    const fairValue = data.probUp * 100;
    const bidPrice = Math.floor(fairValue - this._minEdgeCents);

    // Bid price должен быть разумным
    if (bidPrice < 1 || bidPrice > 98) return [];

    // Zone filter (по цене нашего бида, не по mid)
    if (bidPrice < this._minBidZoneCents || bidPrice > this._maxBidZoneCents) return [];

    // Edge check: fairValue - bidPrice >= minEdge (всегда true по конструкции, но для ясности)
    // Реальный edge = fairValue - bidPrice, всегда >= minEdgeCents

    // Inventory check
    if (data.inventoryUnits >= this._qMax) return [];

    // Balance check (по цене нашего бида)
    const cost = this._orderSize.mul(bidPrice).div(100);
    if (data.availableBalance.lt(cost)) return [];

    // Сохраняем состояние входа для диагностики при exit
    this._entryDeltaPct = data.deltaPct ?? 0;
    this._entryMidCents = mid;
    this._entryBidPrice = bidPrice;
    this._entryMs = data.nowMs;
    this._entryTauSec = data.tauSec;
    this._entryCryptoPrice = data.cryptoPrice ?? 0;
    this._entryProbUp = data.probUp;

    this._logger?.warn('CryptoProb: BID', {
      probUp: (data.probUp * 100).toFixed(0) + '%',
      delta: data.deltaPct?.toFixed(4) + '%',
      cryptoPrice: data.cryptoPrice?.toFixed(2),
      strike: data.strikePrice?.toFixed(2),
      deltaAbs: data.cryptoPrice && data.strikePrice
        ? (data.cryptoPrice - data.strikePrice).toFixed(2)
        : '?',
      fairValue: fairValue.toFixed(1),
      bidPrice,
      mid,
      edge: (fairValue - bidPrice).toFixed(1),
      tau: data.tauSec.toFixed(0),
      inv: data.inventoryUnits,
    });

    return [{ type: 'BUY', price: bidPrice, size: this._orderSize }];
  }

  // ── toIntents ───────────────────────────────────────────────────────────────

  protected toIntents(actions: CPAction[]): StrategyIntent[] {
    const intents: StrategyIntent[] = [];

    for (const action of actions) {
      if (action.type === 'STOP') {
        intents.push({ type: 'CANCEL_ALL' });
        continue;
      }

      intents.push({ type: 'CANCEL_ALL' });

      if (action.type === 'BUY') {
        intents.push({
          type: 'PLACE',
          side: 'BUY',
          price: OutcomePrice.of(new Decimal(action.price).div(100)),
          size: Quantity.of(action.size),
        });
      } else {
        intents.push({
          type: 'PLACE',
          side: 'SELL',
          price: OutcomePrice.of(new Decimal(action.price).div(100)),
          size: Quantity.of(action.size),
        });
      }
    }

    return intents;
  }
}
