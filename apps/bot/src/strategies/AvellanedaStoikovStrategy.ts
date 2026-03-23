/**
 * AvellanedaStoikovStrategy — маркет-мейкерская стратегия на основе модели Avellaneda-Stoikov.
 *
 * @remarks
 * ### Модель
 * Reservation price в logit-пространстве:
 *   `r_x = logit(mid) - (q / qMax) × γ × σ² × τ`
 *
 * Optimal spread в logit-пространстве:
 *   `δ = γ × σ² × τ + 2/κ + jumpPremium`
 *
 * Bid/Ask:
 *   `bid = sigmoid(r_x - δ/2) × 100` (центы → USDC)
 *   `ask = sigmoid(r_x + δ/2) × 100`
 *
 * ### Калибровка
 * σ (волатильность), κ (интенсивность исполнения), jump premium —
 * калиброваны per-minute-bucket на 10M реальных трейдов Polymarket (Oct 2025 – Jan 2026).
 * Две таблицы: 5-минутные рынки (6 бакетов) и 15-минутные (16 бакетов).
 *
 * ### Inventory management
 * - Skew reservation price по текущей позиции: длинная → bid уже, ask шире (хотим продать)
 * - Позиция ограничена ±qMax
 * - Одновременно BUY и SELL ордера (двусторонний маркет-мейкинг)
 *
 * ### Time staging
 * - Последние 30 секунд: spread × 3 (защита от экспирации)
 * - Последние 10 секунд: полная остановка котирования
 *
 * ### EWMA mid-price
 * Экспоненциально-взвешенное скользящее среднее последней цены из trade tape.
 * Alpha = 0.3 → ~70% вес недавним ценам.
 *
 * @example
 * ```typescript
 * const as = new AvellanedaStoikovStrategy({
 *   gamma: new Decimal('0.05'),
 *   qMax: 5,
 *   orderSize: new Decimal('10'),
 *   marketDuration: '5m',
 * });
 * await scheduler.register({ strategy: as, instrumentId, asset, accountId, market });
 * ```
 */
import { BaseStrategy } from '@polymarket/strategy';
import type { StrategySnapshot, StrategyIntent, TriggerReason } from '@polymarket/strategy';
import { Price, Quantity } from '@polymarket/value-objects';
import type { ILogger } from '@polymarket/logger';
import Decimal from 'decimal.js';

// ── Калибровочные таблицы ───────────────────────────────────────────────────
// Рассчитаны на 10M трейдов Polymarket (Oct 2025 – Jan 2026).
// Bucket 0 = последняя минута до экспирации, bucket N = N-я минута от конца.

/**
 * Калибровка для 5-минутных рынков (6 бакетов).
 *
 * @remarks
 * Волатильность в последнюю минуту в 3.8× выше чем за 5 минут до конца.
 * Jump premium в 9.4× выше. κ (интенсивность) ниже → ордера реже исполняются.
 */
const CALIBRATION_5M = {
  sigma: { 0: 0.35, 1: 0.2345, 2: 0.1391, 3: 0.1122, 4: 0.0990, 5: 0.0921 } as Record<number, number>,
  kappa: { 0: 3.0, 1: 3.5931, 2: 4.7366, 3: 5.3699, 4: 5.8737, 5: 5.8503 } as Record<number, number>,
  jump:  { 0: 0.10, 1: 0.074, 2: 0.026, 3: 0.015, 4: 0.012, 5: 0.010 } as Record<number, number>,
  maxBucket: 5,
} as const;

/**
 * Калибровка для 15-минутных рынков (16 бакетов).
 *
 * @remarks
 * Более гранулярные данные. σ падает с 0.35 до 0.045 за 15 минут.
 */
const CALIBRATION_15M = {
  sigma: {
    0: 0.35, 1: 0.2406, 2: 0.1396, 3: 0.1123, 4: 0.0964, 5: 0.0875,
    6: 0.0740, 7: 0.0678, 8: 0.0633, 9: 0.0582, 10: 0.0539,
    11: 0.0488, 12: 0.0473, 13: 0.0448, 14: 0.0434, 15: 0.0451,
  } as Record<number, number>,
  kappa: {
    0: 3.0, 1: 2.7745, 2: 3.7609, 3: 4.1191, 4: 4.3816, 5: 4.4907,
    6: 4.5170, 7: 4.7409, 8: 4.9127, 9: 4.8939, 10: 5.2233,
    11: 5.1396, 12: 5.2240, 13: 5.4542, 14: 5.7160, 15: 5.3238,
  } as Record<number, number>,
  jump: {
    0: 0.10, 1: 0.0916, 2: 0.0326, 3: 0.0200, 4: 0.0150, 5: 0.0119,
    6: 0.0093, 7: 0.0079, 8: 0.0073, 9: 0.0066, 10: 0.0060,
    11: 0.0053, 12: 0.0054, 13: 0.0052, 14: 0.0054, 15: 0.0061,
  } as Record<number, number>,
  maxBucket: 15,
} as const;

// ── Математические утилиты (logit-space) ────────────────────────────────────

/** logit(p) = ln(p / (1 - p)), p ∈ (0, 1) */
function logit(p: number): number {
  return Math.log(p / (1 - p));
}

/** sigmoid(x) = 1 / (1 + exp(-x)), возвращает (0, 1) */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Линейная интерполяция значения из калибровочной таблицы.
 *
 * @param table - Таблица bucket → value
 * @param bucket - Минутный бакет (может быть дробным)
 * @param maxBucket - Максимальный бакет в таблице
 * @returns Интерполированное значение
 */
function interpolate(table: Record<number, number>, bucket: number, maxBucket: number): number {
  if (bucket <= 0) return table[0]!;
  if (bucket >= maxBucket) return table[maxBucket]!;
  const lo = Math.floor(bucket);
  const hi = Math.ceil(bucket);
  if (lo === hi) return table[lo]!;
  const vLo = table[lo]!;
  const vHi = table[hi]!;
  return vLo + (bucket - lo) * (vHi - vLo);
}

// ── Конфигурация стратегии ──────────────────────────────────────────────────

/**
 * Параметры AvellanedaStoikovStrategy.
 *
 * @param gamma - Risk aversion parameter (γ). Выше → шире спреды, меньше позиция.
 *   Типичные значения: 0.01 (агрессивный) – 0.20 (консервативный).
 * @param qMax - Максимальная позиция в одну сторону (в единицах orderSize).
 *   qMax=5, orderSize=10 → максимальная длинная позиция = 50 токенов.
 * @param orderSize - Размер одного ордера (bid и ask).
 * @param marketDuration - Длительность рынка: '5m' | '15m'. Определяет калибровочную таблицу.
 * @param spreadMult - Множитель спреда (по умолчанию 1.0). >1 = шире спреды.
 * @param ewmaAlpha - Alpha для EWMA mid-price (по умолчанию 0.3).
 * @param stagedWideSec - Секунды до экспирации для 3× wide spread (по умолчанию 30).
 * @param stagedStopSec - Секунды до экспирации для полной остановки (по умолчанию 10).
 * @param minTradesForMid - Минимальное кол-во трейдов для расчёта EWMA (по умолчанию 5).
 */
export interface ASStrategyConfig {
  readonly gamma: Decimal;
  readonly qMax: number;
  readonly orderSize: Decimal;
  readonly marketDuration: '5m' | '15m';
  readonly spreadMult?: Decimal;
  readonly ewmaAlpha?: number;
  readonly stagedWideSec?: number;
  readonly stagedStopSec?: number;
  readonly minTradesForMid?: number;
}

// ── Типы gather/decide ──────────────────────────────────────────────────────

/** Данные, извлечённые из snapshot для принятия решений */
interface ASData {
  /** EWMA mid-price из trade tape (в USDC, 0..1) */
  readonly ewmaMid: number;
  /** Текущая позиция в единицах orderSize (>0 длинная, <0 короткая) */
  readonly inventoryUnits: number;
  /** Секунды до экспирации */
  readonly tauSec: number;
  /** Минутный бакет (tauSec / 60, округлённый) */
  readonly minuteBucket: number;
  /** Доступный баланс USDC */
  readonly availableBalance: Decimal;
  /** Текущая позиция в токенах (для SELL sizing) */
  readonly positionQty: Decimal;
  /** Есть ли in-flight fills */
  readonly hasInFlightFills: boolean;
  /** Минимальный размер ордера */
  readonly minOrderSize: Decimal | undefined;
}

/** Действие стратегии: разместить bid, ask, или обе стороны */
type ASAction =
  | { readonly type: 'QUOTE'; readonly bid: number; readonly ask: number; readonly bidSize: Decimal; readonly askSize: Decimal }
  | { readonly type: 'STOP' };

// ── Реализация ──────────────────────────────────────────────────────────────

export class AvellanedaStoikovStrategy extends BaseStrategy<ASData, ASAction> {
  public readonly id: string;
  public readonly name = 'AvellanedaStoikovStrategy';

  private readonly _config: ASStrategyConfig;
  private readonly _logger: ILogger | undefined;
  private readonly _calibration: {
    readonly sigma: Record<number, number>;
    readonly kappa: Record<number, number>;
    readonly jump: Record<number, number>;
    readonly maxBucket: number;
  };
  private readonly _gamma: number;
  private readonly _qMax: number;
  private readonly _spreadMult: number;
  private readonly _ewmaAlpha: number;
  private readonly _stagedWideSec: number;
  private readonly _stagedStopSec: number;
  private readonly _minTradesForMid: number;

  /** EWMA mid-price (в центах, 0–100). Обновляется при каждом tick. */
  private _ewma: number | null = null;
  /** Количество трейдов, обработанных для EWMA */
  private _tradeCount = 0;
  /** Timestamp последнего трейда, использованного для EWMA (для инкрементального обновления) */
  private _lastTradeTimestampMs = 0;

  /**
   * @param config - Параметры AS-стратегии
   * @param strategyId - Уникальный ID экземпляра (по умолчанию 'as-mm-1')
   * @param logger - Логгер для диагностики
   */
  constructor(config: ASStrategyConfig, strategyId = 'as-mm-1', logger?: ILogger) {
    super();
    this._config = config;
    this.id = strategyId;
    this._logger = logger;
    this._calibration = config.marketDuration === '15m' ? CALIBRATION_15M : CALIBRATION_5M;
    this._gamma = config.gamma.toNumber();
    this._qMax = config.qMax;
    this._spreadMult = config.spreadMult?.toNumber() ?? 1.0;
    this._ewmaAlpha = config.ewmaAlpha ?? 0.3;
    this._stagedWideSec = config.stagedWideSec ?? 30;
    this._stagedStopSec = config.stagedStopSec ?? 10;
    this._minTradesForMid = config.minTradesForMid ?? 5;
  }

  // ── gather ──────────────────────────────────────────────────────────────────

  /**
   * Извлекает данные из snapshot: EWMA mid, inventory, time-to-expiry.
   *
   * @param snapshot - Readonly snapshot состояния
   * @returns ASData или undefined если данных недостаточно
   *
   * @remarks
   * EWMA обновляется инкрементально: при каждом tick обрабатываются только
   * новые трейды из tape (по timestamp). Это предотвращает пересчёт на
   * каждый book update.
   */
  protected gather(snapshot: StrategySnapshot): ASData | undefined {
    // Время до экспирации
    const expiresMs = snapshot.market.expirationMs;
    const tauSec = Math.max(0, (expiresMs - snapshot.nowMs) / 1000);

    // Обновляем EWMA из trade tape (инкрементально)
    const tapeRecords = snapshot.tradeTape?.getAll();
    if (tapeRecords && tapeRecords.length > 0) {
      for (const trade of tapeRecords) {
        const tradeTs = trade.timestamp.toNumber();
        if (tradeTs <= this._lastTradeTimestampMs) continue;
        const priceNum = trade.price.value().toNumber() * 100; // USDC → центы
        if (this._ewma === null) {
          this._ewma = priceNum;
        } else {
          this._ewma = this._ewmaAlpha * priceNum + (1 - this._ewmaAlpha) * this._ewma;
        }
        this._tradeCount++;
        this._lastTradeTimestampMs = tradeTs;
      }
    }

    // Fallback на topOfBook mid если нет трейдов
    if (this._ewma === null && snapshot.topOfBook) {
      const bid = snapshot.topOfBook.bestBid?.value().toNumber();
      const ask = snapshot.topOfBook.bestAsk?.value().toNumber();
      if (bid !== undefined && ask !== undefined) {
        this._ewma = ((bid + ask) / 2) * 100;
        this._tradeCount++;
      }
    }

    if (this._ewma === null || this._tradeCount < this._minTradesForMid) {
      return undefined;
    }

    // Позиция: количество токенов и inventory в единицах orderSize
    const position = snapshot.portfolio?.getPosition(snapshot.instrumentId);
    const rawQty = position?.quantity.value() ?? new Decimal(0);
    const orderSizeNum = this._config.orderSize.toNumber();
    const inventoryUnits = orderSizeNum > 0 ? rawQty.toNumber() / orderSizeNum : 0;

    const availableBalance = snapshot.portfolio?.balance.available().value() ?? new Decimal(0);
    const minuteBucket = tauSec / 60;

    const hasInFlightFills = snapshot.hasInFlightFills || snapshot.matchedOrders.length > 0;

    return {
      ewmaMid: this._ewma,
      inventoryUnits,
      tauSec,
      minuteBucket,
      availableBalance,
      positionQty: rawQty,
      hasInFlightFills,
      minOrderSize: snapshot.constraints?.minOrderSize.value(),
    };
  }

  // ── decide ──────────────────────────────────────────────────────────────────

  /**
   * Вычисляет bid/ask по модели Avellaneda-Stoikov.
   *
   * @param data - Данные из gather
   * @param _reasons - Причины тика (не используются)
   * @returns Массив ASAction: QUOTE с ценами или STOP если near-expiry
   *
   * @remarks
   * ### Формулы в logit-пространстве:
   * 1. `midClamped = clamp(ewma, 2, 98)` — ограничиваем от экстремальных цен
   * 2. `x = logit(midClamped / 100)` — в logit-space
   * 3. `s2t = σ² × τ` — variance × time
   * 4. `skew = (q / qMax) × γ × s2t` — inventory adjustment
   * 5. `r_x = x - skew` — reservation price (logit)
   * 6. `spread = (γ × s2t + 2/κ + jump) × spreadMult × stagingFactor`
   * 7. `bid = sigmoid(r_x - spread/2) × 100`, `ask = sigmoid(r_x + spread/2) × 100`
   */
  protected decide(data: ASData, _reasons: ReadonlySet<TriggerReason>): ASAction[] {
    // ── Stop near expiry ──────────────────────────────────────────────────
    if (data.tauSec < this._stagedStopSec) {
      this._logger?.info('AS: STOP — too close to expiry', { tauSec: data.tauSec });
      return [{ type: 'STOP' }];
    }

    // ── In-flight fills → пропускаем тик ──────────────────────────────────
    if (data.hasInFlightFills) {
      this._logger?.debug('AS: skip — in-flight fills');
      return [];
    }

    // ── AS model ──────────────────────────────────────────────────────────
    const midClamped = Math.max(2, Math.min(98, data.ewmaMid));
    const x = logit(midClamped / 100);

    const sigma = interpolate(this._calibration.sigma, data.minuteBucket, this._calibration.maxBucket);
    const kappa = interpolate(this._calibration.kappa, data.minuteBucket, this._calibration.maxBucket);
    const jump = interpolate(this._calibration.jump, data.minuteBucket, this._calibration.maxBucket);

    const s2t = sigma * sigma * data.tauSec;

    // Inventory skew: длинная позиция → reservation price вниз → ask уже (хотим продать).
    // На Polymarket нет шортов → q ∈ [0, qMax]. Без позиции skew = 0 (нейтральное котирование).
    const q = Math.max(0, Math.min(this._qMax, data.inventoryUnits));
    const skew = this._qMax > 0 ? (q / this._qMax) * this._gamma * s2t : 0;
    const r_x = x - skew;

    // Optimal spread
    let spread_x = (this._gamma * s2t + 2 / kappa + jump) * this._spreadMult;

    // Staged wide: 3× wider near expiry
    if (data.tauSec < this._stagedWideSec) {
      spread_x *= 3;
    }

    // Bid/ask в центах (1–99)
    let bid = Math.max(1, Math.min(99, Math.floor(sigmoid(r_x - spread_x / 2) * 100)));
    let ask = Math.max(1, Math.min(99, Math.ceil(sigmoid(r_x + spread_x / 2) * 100)));

    // Crossing prevention
    if (bid >= ask) {
      ask = bid + 1;
      if (ask > 99) { bid = 98; ask = 99; }
    }

    // Position limits: не котируем сторону если на лимите
    const canBid = data.inventoryUnits < this._qMax;

    // Размеры ордеров
    let bidSize = canBid ? this._config.orderSize : new Decimal(0);

    // Ask: на Polymarket нельзя шортить — SELL только если есть токены.
    // askSize = min(orderSize, positionQty). Если позиция 0 → askSize = 0.
    let askSize = data.positionQty.gt(0)
      ? Decimal.min(this._config.orderSize, data.positionQty)
      : new Decimal(0);

    // Пропускаем если оба ордера нулевые
    if (bidSize.isZero() && askSize.isZero()) {
      this._logger?.debug('AS: skip — both sides at position limit');
      return [];
    }

    // Balance check для bid
    const bidCost = bidSize.mul(new Decimal(bid).div(100));
    if (bidCost.gt(data.availableBalance)) {
      // Уменьшаем размер bid по доступному балансу
      const maxAffordable = data.availableBalance.div(new Decimal(bid).div(100)).floor();
      if (maxAffordable.lt(data.minOrderSize ?? new Decimal(1))) {
        bidSize = new Decimal(0);
      } else {
        bidSize = maxAffordable;
      }
    }

    if (bidSize.isZero() && askSize.isZero()) {
      this._logger?.debug('AS: skip — insufficient balance and no ask');
      return [];
    }

    this._logger?.debug('AS: QUOTE', {
      mid: midClamped.toFixed(1),
      bid,
      ask,
      spread: ask - bid,
      sigma: sigma.toFixed(4),
      kappa: kappa.toFixed(2),
      inventory: q.toFixed(1),
      tauSec: data.tauSec.toFixed(0),
      minuteBucket: data.minuteBucket.toFixed(1),
      skew: skew.toFixed(4),
      bidSize: bidSize.toFixed(1),
      askSize: askSize.toFixed(1),
    });

    return [{
      type: 'QUOTE',
      bid,
      ask,
      bidSize,
      askSize,
    }];
  }

  // ── toIntents ───────────────────────────────────────────────────────────────

  /**
   * Преобразует ASAction в StrategyIntent[].
   *
   * @param actions - Действия из decide()
   * @returns CANCEL_ALL + PLACE bid + PLACE ask
   *
   * @remarks
   * Каждый тик: CANCEL_ALL (отменить старые котировки) → PLACE новые.
   * Polymarket не поддерживает AMEND, поэтому cancel+place — единственный способ
   * обновить котировки.
   */
  protected toIntents(actions: ASAction[]): StrategyIntent[] {
    const intents: StrategyIntent[] = [];

    for (const action of actions) {
      if (action.type === 'STOP') {
        intents.push({ type: 'CANCEL_ALL' });
        continue;
      }

      // CANCEL_ALL перед новыми котировками
      intents.push({ type: 'CANCEL_ALL' });

      // Bid (BUY)
      if (action.bidSize.gt(0)) {
        const bidPrice = new Decimal(action.bid).div(100);
        intents.push({
          type: 'PLACE',
          side: 'BUY',
          price: Price.of(bidPrice),
          size: Quantity.of(action.bidSize),
        });
      }

      // Ask (SELL)
      if (action.askSize.gt(0)) {
        const askPrice = new Decimal(action.ask).div(100);
        intents.push({
          type: 'PLACE',
          side: 'SELL',
          price: Price.of(askPrice),
          size: Quantity.of(action.askSize),
        });
      }
    }

    return intents;
  }

  // ── Метрики ─────────────────────────────────────────────────────────────────

  /**
   * Возвращает текущие метрики стратегии.
   *
   * @returns EWMA mid, trade count, gamma, qMax
   */
  public override getMetrics(): Record<string, unknown> {
    return {
      ewma: this._ewma,
      tradeCount: this._tradeCount,
      gamma: this._gamma,
      qMax: this._qMax,
      spreadMult: this._spreadMult,
      marketDuration: this._config.marketDuration,
    };
  }

  /**
   * Сброс EWMA при переключении рынка.
   *
   * @remarks
   * Вызывается оркестрацией при смене рынка (новый instrumentId).
   * Без сброса EWMA будет содержать цены старого рынка.
   */
  public resetEwma(): void {
    this._ewma = null;
    this._tradeCount = 0;
    this._lastTradeTimestampMs = 0;
  }
}
