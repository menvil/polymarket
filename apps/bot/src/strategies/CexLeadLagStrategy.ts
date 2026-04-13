import { BaseStrategy } from '@polymarket/strategy';
import type {
  CexVenue,
  CryptoSignalDirection,
  CryptoSignalResult,
  StrategyIntent,
  StrategySnapshot,
  TriggerReason,
} from '@polymarket/strategy';
import { Price, Quantity } from '@polymarket/value-objects';
import type { ILogger } from '@polymarket/logger';
import Decimal from 'decimal.js';

const SECONDS_PER_YEAR = 365.25 * 24 * 3600;

/**
 * Режим работы стратегии CEX Lead-Lag.
 *
 * - `defensive` — сигнал не влияет на fair value; входим только если
 *   модель даёт edge без учёта CEX-сигнала.
 * - `skewed` — сигнал смещает fair value на `signalImpactCents`; позволяет
 *   котировать агрессивнее при сильном сигнале.
 * - `hybrid` — аналог skewed, но может использоваться с доп. логикой.
 */
export type CexLeadLagMode = 'defensive' | 'skewed' | 'hybrid';

/**
 * Направление ставки: UP-токен (цена вырастет) или DOWN-токен (цена упадёт).
 */
export type CexLeadLagSide = 'up' | 'down';

/**
 * Конфигурация стратегии CexLeadLag.
 *
 * @remarks
 * Стратегия входит в позицию по UP или DOWN токену бинарного рынка,
 * используя:
 * 1. Fair value из формулы бинарного опциона (GBM без дивидендов).
 * 2. Опциональный CEX lead-lag сигнал для корректировки fair value.
 */
export interface CexLeadLagConfig {
  /** Размер одного ордера в токенах. */
  readonly orderSize: Decimal;
  /** Максимальное кол-во единиц инвентаря (в orderSize). */
  readonly qMax: number;
  /** Торгуем UP или DOWN токен. Default: "up". */
  readonly side?: CexLeadLagSide;
  /**
   * Режим влияния сигнала на котировки.
   * Default: "skewed".
   */
  readonly mode?: CexLeadLagMode;
  /** ID сигнала в CryptoSignalRegistry. Default: "cex_chainlink_lead_lag". */
  readonly signalId?: string;
  /** Список CEX-бирж для сигнала. Default: ['binance', 'coinbase', 'okx']. */
  readonly venues?: readonly CexVenue[];
  /** Веса бирж для взвешенного сигнала. */
  readonly weights?: Readonly<Record<string, number>>;
  /** Статический базис (USD) для каждой биржи. Вычитается из residual. */
  readonly basisByVenue?: Readonly<Record<string, number>>;
  /** Офлайн-калиброванный hit rate по score-бакетам [1..10]. */
  readonly confidenceByScore?: Readonly<Record<string, number>>;
  /** Минимальный порог сигнала в bps для признания direction != flat. Default: 0.5. */
  readonly signalThresholdBps?: number;
  /** Окно истории для momentum компоненты сигнала (ms). Default: 1000. */
  readonly signalLookbackMs?: number;
  /** Максимальный возраст данных биржи для признания сигнала свежим (ms). Default: 2000. */
  readonly signalStaleMs?: number;
  /** Минимальное кол-во активных бирж для сигнала. */
  readonly minVenueCount?: number;
  /** Максимальный спред на бирже (bps). Биржа с более широким спредом игнорируется. */
  readonly maxSpreadBps?: number;
  /** Минимальная сила сигнала [0..10] для входа. Default: 6. */
  readonly minSignalStrength?: number;
  /** Минимальная уверенность сигнала [0..1] для входа. Default: 0.55. */
  readonly minSignalConfidence?: number;
  /** Базовое смещение fair value при сигнале (¢). Default: 5. */
  readonly signalImpactCents?: number;
  /** Максимальное смещение fair value при сигнале (¢). Default: 10. */
  readonly maxSignalImpactCents?: number;
  /** Порог репрайса maker-ордера (¢). Default: 1. */
  readonly makerRepriceThresholdCents?: number;
  /** Требовать сигнал для входа. Default: true. */
  readonly requireSignalForEntry?: boolean;
  /** Разрешить taker-ордера (пересекать спред). Default: false. */
  readonly allowTaker?: boolean;
  /** Годовая волатильность для GBM fair value. Default: 0.60. */
  readonly sigmaAnnual?: number;
  /** Минимальное преимущество fair value над mid для входа (¢). Default: 2. */
  readonly minEdgeCents?: number;
  /** Минимальное преимущество для удержания позиции (¢). Default: 1. */
  readonly exitEdgeCents?: number;
  /** Базовый спред для расчёта bid-цены входа (¢). Default: 1. */
  readonly baseSpreadCents?: number;
  /** Скидка к mid при выходе — sell ниже mid на эту величину (¢). Default: 1. */
  readonly exitDiscountCents?: number;
  /** Секунды прогрева после начала рынка. Default: 10. */
  readonly warmupSec?: number;
  /** Alpha EWMA для расчёта mid по трейдам. Default: 0.3. */
  readonly ewmaAlpha?: number;
  /** Минимальное кол-во трейдов перед активацией. Default: 3. */
  readonly minTradesForMid?: number;
  /** Секунды до экспирации для принудительного выхода. Default: 20. */
  readonly exitTauSec?: number;
  /** Максимальный горизонт для входа (секунды). Default: 300. */
  readonly maxEntryTauSec?: number;
  /** Минимальный допустимый fair value (¢). Default: 1. */
  readonly minFairCents?: number;
  /** Максимальный допустимый fair value (¢). Default: 99. */
  readonly maxFairCents?: number;
}

/**
 * Данные тика для принятия торговых решений.
 */
interface CexLeadLagData {
  readonly side: CexLeadLagSide;
  readonly mode: CexLeadLagMode;
  /** Результат CEX-сигнала из registry, или undefined если сигнал недоступен. */
  readonly signal: CryptoSignalResult | undefined;
  /** Направление сигнала применительно к нашему токену (inverted для DOWN). */
  readonly signalDirectionForToken: CryptoSignalDirection;
  /** Сигнал достаточно сильный и уверенный. */
  readonly signalStrong: boolean;
  /** Сигнал благоприятен для входа (сторона совпадает с нашим токеном). */
  readonly signalFavorable: boolean;
  /** Сигнал направлен против позиции — нужно выходить. */
  readonly signalAdverse: boolean;
  /** Итоговое смещение fair value от сигнала (¢), со знаком. */
  readonly signalImpactCents: number;
  /** Fair value из GBM-формулы без учёта сигнала (¢). */
  readonly baseFairCents: number;
  /** Fair value с поправкой на сигнал (¢). */
  readonly adjustedFairCents: number;
  /** EWMA mid по трейдам (¢). */
  readonly midCents: number;
  readonly bestBidCents: number | undefined;
  readonly bestAskCents: number | undefined;
  /** Цена открытого BUY-ордера, если есть. */
  readonly openBuyPriceCents: number | undefined;
  /** Секунды до экспирации. */
  readonly tauSec: number;
  readonly positionQty: Decimal;
  readonly availableTokenQty: Decimal;
  readonly availableBalance: Decimal;
  readonly minOrderSize: Decimal;
  readonly minOrderValue: Decimal;
  /** Инвентарь в единицах orderSize. */
  readonly inventoryUnits: number;
  readonly hasInFlightFills: boolean;
  readonly nowMs: number;
  readonly currentPrice: number;
  readonly targetPrice: number;
}

/**
 * Торговые действия стратегии.
 *
 * - `BUY` — открыть/добавить позицию.
 * - `SELL` — закрыть позицию (выход).
 * - `CANCEL` — снять все активные ордера.
 */
type CexLeadLagAction =
  | { readonly type: 'BUY'; readonly price: number; readonly size: Decimal }
  | { readonly type: 'SELL'; readonly price: number; readonly size: Decimal }
  | { readonly type: 'CANCEL' };

/**
 * Аппроксимация CDF нормального распределения по Абрамовицу-Стегуну.
 *
 * @param x - z-score
 * @returns P(Z ≤ x) ∈ [0, 1]
 */
function normalCdf(x: number): number {
  if (x < -8) return 0;
  if (x > 8) return 1;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
  return 0.5 * (1 + sign * y);
}

/**
 * Вычисляет fair value UP-токена бинарного события по формуле GBM.
 *
 * @remarks
 * `P(S_T ≥ K) ≈ Φ(d)`
 * где `d = log(S / K) / (σ × √T)` — без дрейфа (упрощённая вероятная мера).
 *
 * @param price - Текущая цена базового актива
 * @param strike - Страйк события
 * @param sigmaAnnual - Годовая волатильность (напр. 0.60 = 60%)
 * @param tauSec - Секунды до экспирации
 * @returns Fair value в центах [1, 99]
 */
function binaryUpFairCents(price: number, strike: number, sigmaAnnual: number, tauSec: number): number {
  if (tauSec <= 0) return price >= strike ? 99 : 1;
  if (price <= 0 || strike <= 0 || sigmaAnnual <= 0) return 50;
  const tauYears = tauSec / SECONDS_PER_YEAR;
  const d = Math.log(price / strike) / (sigmaAnnual * Math.sqrt(tauYears));
  return clamp(normalCdf(d) * 100, 1, 99);
}

/**
 * Зажимает значение в диапазон [lower, upper].
 *
 * @param value - Входное значение
 * @param lower - Нижняя граница
 * @param upper - Верхняя граница
 * @returns Зажатое значение
 */
function clamp(value: number, lower: number, upper: number): number {
  return Math.max(lower, Math.min(upper, value));
}

/**
 * Безопасно извлекает число из number или Decimal.
 *
 * @param value - Число, Decimal или undefined
 * @param fallback - Значение по умолчанию при невалидном input
 * @returns Числовое значение
 */
function toNumber(value: number | Decimal | undefined, fallback: number): number {
  if (value instanceof Decimal) return value.toNumber();
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Возвращает `true`, если направление сигнала — UP.
 *
 * @param direction - Направление сигнала
 */
function isUpDirection(direction: CryptoSignalDirection): boolean {
  return direction === 'up';
}

/**
 * Инвертирует направление сигнала.
 *
 * @remarks
 * Используется при работе с DOWN-токеном: favorable CEX-рост
 * означает неблагоприятный сигнал для DOWN.
 *
 * @param direction - Исходное направление
 * @returns Инвертированное направление
 */
function invertDirection(direction: CryptoSignalDirection): CryptoSignalDirection {
  if (direction === 'up') return 'down';
  if (direction === 'down') return 'up';
  return 'flat';
}

/**
 * Стратегия, использующая CEX lead-lag сигнал для торговли
 * бинарными токенами Polymarket.
 *
 * @remarks
 * ### Принцип работы
 *
 * 1. **Fair value** вычисляется по упрощённой формуле бинарного опциона GBM:
 *    `P(S_T ≥ K) = Φ(log(S/K) / (σ √T))`.
 *    Chainlink-цена используется как предпочтительный источник (если доступна).
 *
 * 2. **CEX lead-lag сигнал** (`cex_chainlink_lead_lag`) отражает опережение
 *    futures/spot-рынков относительно Chainlink. При режиме `skewed`/`hybrid`
 *    сигнал смещает fair value на `[0..maxSignalImpactCents]` в сторону сигнала.
 *
 * 3. **Вход** — limit BUY ниже adjusted fair value на `minEdgeCents`.
 *    Требует `signalFavorable = true` при `requireSignalForEntry = true`.
 *
 * 4. **Удержание** — позиция держится пока `edge ≥ exitEdgeCents`
 *    и сигнал не adverse.
 *
 * 5. **Выход** — limit SELL по `mid - exitDiscountCents`.
 *    Триггеры: adverse сигнал, падение edge < exitEdgeCents, `tauSec < exitTauSec`.
 *
 * @example
 * ```typescript
 * const strategy = new CexLeadLagStrategy(
 *   {
 *     orderSize: new Decimal(10),
 *     qMax: 2,
 *     side: 'up',
 *     mode: 'skewed',
 *     requireSignalForEntry: true,
 *   },
 *   'cex-ll-btc',
 *   logger,
 * );
 * ```
 */
export class CexLeadLagStrategy extends BaseStrategy<CexLeadLagData, CexLeadLagAction> {
  public readonly id: string;
  public readonly name = 'CexLeadLagStrategy';

  private readonly _logger: ILogger | undefined;
  private readonly _orderSize: Decimal;
  private readonly _qMax: number;
  private readonly _side: CexLeadLagSide;
  private readonly _mode: CexLeadLagMode;
  private readonly _signalId: string;
  private readonly _venues: readonly CexVenue[];
  private readonly _weights: Readonly<Record<string, number>> | undefined;
  private readonly _basisByVenue: Readonly<Record<string, number>> | undefined;
  private readonly _confidenceByScore: Readonly<Record<string, number>> | undefined;
  private readonly _signalThresholdBps: number;
  private readonly _signalLookbackMs: number;
  private readonly _signalStaleMs: number;
  private readonly _minVenueCount: number | undefined;
  private readonly _maxSpreadBps: number | undefined;
  private readonly _minSignalStrength: number;
  private readonly _minSignalConfidence: number;
  private readonly _signalImpactCents: number;
  private readonly _maxSignalImpactCents: number;
  private readonly _makerRepriceThresholdCents: number;
  private readonly _requireSignalForEntry: boolean;
  private readonly _allowTaker: boolean;
  private readonly _sigmaAnnual: number;
  private readonly _minEdgeCents: number;
  private readonly _exitEdgeCents: number;
  private readonly _baseSpreadCents: number;
  private readonly _exitDiscountCents: number;
  private readonly _warmupSec: number;
  private readonly _ewmaAlpha: number;
  private readonly _minTradesForMid: number;
  private readonly _exitTauSec: number;
  private readonly _maxEntryTauSec: number;
  private readonly _minFairCents: number;
  private readonly _maxFairCents: number;

  private _ewma: number | null = null;
  private _tradeCount = 0;
  private _lastTradeTimestampMs = 0;
  private _currentExpirationMs = 0;
  private _marketEventStartMs = 0;
  private _lastDiagMs = 0;

  /**
   * @param config - Конфигурация стратегии
   * @param strategyId - Уникальный идентификатор экземпляра. Default: "cex-lead-lag-1"
   * @param logger - Опциональный логгер
   */
  constructor(config: CexLeadLagConfig, strategyId = 'cex-lead-lag-1', logger?: ILogger) {
    super();
    this.id = strategyId;
    this._logger = logger;
    this._orderSize = config.orderSize;
    this._qMax = config.qMax;
    this._side = config.side ?? 'up';
    this._mode = config.mode ?? 'skewed';
    this._signalId = config.signalId ?? 'cex_chainlink_lead_lag';
    this._venues = config.venues ?? ['binance', 'coinbase', 'okx'];
    this._weights = config.weights;
    this._basisByVenue = config.basisByVenue;
    this._confidenceByScore = config.confidenceByScore;
    this._signalThresholdBps = toNumber(config.signalThresholdBps, 0.5);
    this._signalLookbackMs = toNumber(config.signalLookbackMs, 1_000);
    this._signalStaleMs = toNumber(config.signalStaleMs, 2_000);
    this._minVenueCount = config.minVenueCount;
    this._maxSpreadBps = config.maxSpreadBps;
    this._minSignalStrength = toNumber(config.minSignalStrength, 6);
    this._minSignalConfidence = toNumber(config.minSignalConfidence, 0.55);
    this._signalImpactCents = toNumber(config.signalImpactCents, 5);
    this._maxSignalImpactCents = toNumber(config.maxSignalImpactCents, 10);
    this._makerRepriceThresholdCents = toNumber(config.makerRepriceThresholdCents, 1);
    this._requireSignalForEntry = config.requireSignalForEntry ?? true;
    this._allowTaker = config.allowTaker ?? false;
    this._sigmaAnnual = toNumber(config.sigmaAnnual, 0.60);
    this._minEdgeCents = toNumber(config.minEdgeCents, 2);
    this._exitEdgeCents = toNumber(config.exitEdgeCents, 1);
    this._baseSpreadCents = toNumber(config.baseSpreadCents, 1);
    this._exitDiscountCents = toNumber(config.exitDiscountCents, 1);
    this._warmupSec = toNumber(config.warmupSec, 10);
    this._ewmaAlpha = toNumber(config.ewmaAlpha, 0.3);
    this._minTradesForMid = toNumber(config.minTradesForMid, 3);
    this._exitTauSec = toNumber(config.exitTauSec, 20);
    this._maxEntryTauSec = toNumber(config.maxEntryTauSec, 300);
    this._minFairCents = toNumber(config.minFairCents, 1);
    this._maxFairCents = toNumber(config.maxFairCents, 99);

    this._logger?.warn('CexLeadLag: init', {
      strategyId: this.id,
      side: this._side,
      mode: this._mode,
      venues: this._venues.join(','),
      signalThresholdBps: this._signalThresholdBps,
      minSignalStrength: this._minSignalStrength,
      minSignalConfidence: this._minSignalConfidence,
      requireSignalForEntry: this._requireSignalForEntry,
      allowTaker: this._allowTaker,
    });
  }

  /**
   * Собирает данные тика из снапшота.
   *
   * @remarks
   * - При смене рынка (новый expirationMs) сбрасывает EWMA и счётчики.
   * - Обновляет EWMA mid по трейдам через `_updateEwma()`.
   * - Вычисляет `baseFairCents` из GBM и `adjustedFairCents` с поправкой сигнала.
   * - Возвращает `undefined` до прогрева или при недостатке трейдов.
   *
   * @param snapshot - Снапшот рынка
   * @returns Данные тика или `undefined`
   */
  protected gather(snapshot: StrategySnapshot): CexLeadLagData | undefined {
    if (!snapshot.cryptoPrice || !snapshot.eventStartMs) return undefined;

    const expiresMs = snapshot.market.expirationMs;
    if (this._currentExpirationMs !== expiresMs) {
      this._currentExpirationMs = expiresMs;
      this._marketEventStartMs = snapshot.eventStartMs;
      this._ewma = null;
      this._tradeCount = 0;
      this._lastTradeTimestampMs = 0;
      this._lastDiagMs = 0;
    }

    this._updateEwma(snapshot);
    if (this._ewma === null || this._tradeCount < this._minTradesForMid) return undefined;
    if (snapshot.nowMs - this._marketEventStartMs < this._warmupSec * 1_000) return undefined;

    const currentPrice = snapshot.cryptoPrice.chainlink?.price ?? snapshot.cryptoPrice.currentPrice;
    const targetPrice = snapshot.cryptoPrice.targetPrice;
    if (!targetPrice || targetPrice <= 0 || currentPrice <= 0) return undefined;

    const tauSec = Math.max(0, (expiresMs - snapshot.nowMs) / 1_000);
    const upFair = binaryUpFairCents(currentPrice, targetPrice, this._sigmaAnnual, tauSec);
    const baseFairCents = this._side === 'up' ? upFair : 100 - upFair;

    const signal = snapshot.cryptoSignals?.evaluate(this._signalId, {
      venues: this._venues,
      weights: this._weights,
      basisByVenue: this._basisByVenue,
      confidenceByScore: this._confidenceByScore,
      lookbackMs: this._signalLookbackMs,
      staleMs: this._signalStaleMs,
      thresholdBps: this._signalThresholdBps,
      minVenueCount: this._minVenueCount,
      maxSpreadBps: this._maxSpreadBps,
    });
    const signalDirectionForToken = this._side === 'up'
      ? signal?.direction ?? 'flat'
      : invertDirection(signal?.direction ?? 'flat');
    const signalStrong = Boolean(
      signal
      && !signal.stale
      && signal.direction !== 'flat'
      && signal.strength >= this._minSignalStrength
      && signal.confidence >= this._minSignalConfidence,
    );
    const signalFavorable = signalStrong && isUpDirection(signalDirectionForToken);
    const signalAdverse = signalStrong && signalDirectionForToken === 'down';
    const rawImpact = signal && this._mode !== 'defensive'
      ? Math.min(this._maxSignalImpactCents, signal.strength / 10 * this._signalImpactCents)
      : 0;
    const signalImpactCents = signalFavorable ? rawImpact : signalAdverse ? -rawImpact : 0;
    const adjustedFairCents = clamp(baseFairCents + signalImpactCents, 1, 99);

    const position = snapshot.portfolio?.getPosition(snapshot.instrumentId);
    const positionQty = position?.quantity.value() ?? new Decimal(0);
    const availableTokenQty = snapshot.portfolio?.availableTokenQuantity(snapshot.instrumentId) ?? new Decimal(0);
    const availableBalance = snapshot.portfolio?.balance.available().value() ?? new Decimal(0);
    const minOrderSize = snapshot.constraints?.minOrderSize.value() ?? new Decimal(0);
    const minOrderValue = snapshot.constraints?.minOrderValue.value() ?? new Decimal(1);
    const inventoryUnits = this._orderSize.gt(0) ? positionQty.div(this._orderSize).toNumber() : 0;

    return {
      side: this._side,
      mode: this._mode,
      signal,
      signalDirectionForToken,
      signalStrong,
      signalFavorable,
      signalAdverse,
      signalImpactCents,
      baseFairCents,
      adjustedFairCents,
      midCents: this._ewma,
      bestBidCents: this._bestBidCents(snapshot),
      bestAskCents: this._bestAskCents(snapshot),
      openBuyPriceCents: this._openBuyPriceCents(snapshot),
      tauSec,
      positionQty,
      availableTokenQty,
      availableBalance,
      minOrderSize,
      minOrderValue,
      inventoryUnits,
      hasInFlightFills: snapshot.hasInFlightFills || snapshot.matchedOrders.length > 0,
      nowMs: snapshot.nowMs,
      currentPrice,
      targetPrice,
    };
  }

  /**
   * Принимает торговые решения.
   *
   * @remarks
   * Логика:
   * - Есть in-flight fills → CANCEL.
   * - Есть позиция → проверить выход через `_checkExit()`.
   * - Нет позиции → проверить вход через `_checkEntry()`.
   * - Если BUY-ордер стоит и условия не ухудшились → не трогать (return []).
   *
   * @param data - Данные тика
   * @param _reasons - Причины триггера (не используются)
   * @returns Список действий
   */
  protected decide(data: CexLeadLagData, _reasons: ReadonlySet<TriggerReason>): CexLeadLagAction[] {
    if (data.hasInFlightFills) return [{ type: 'CANCEL' }];

    const hasPosition = data.positionQty.gt(0);
    if (hasPosition) {
      const exit = this._checkExit(data);
      if (exit) return [exit];
      this._logDiag(data, 'HOLD');
      return [{ type: 'CANCEL' }];
    }

    const entry = this._checkEntry(data);
    if (entry) return [entry];
    if (data.openBuyPriceCents !== undefined && data.signalFavorable && !data.signalAdverse) return [];
    return [{ type: 'CANCEL' }];
  }

  /**
   * Преобразует действия в торговые интенты.
   *
   * @remarks
   * Каждое действие предваряется `CANCEL_ALL`.
   * - `CANCEL` → только отмена.
   * - `BUY`/`SELL` → отмена + PLACE.
   *
   * @param actions - Список действий
   * @returns Список интентов
   */
  protected toIntents(actions: CexLeadLagAction[]): StrategyIntent[] {
    const intents: StrategyIntent[] = [];

    for (const action of actions) {
      intents.push({ type: 'CANCEL_ALL' });
      if (action.type === 'CANCEL') continue;

      intents.push({
        type: 'PLACE',
        side: action.type === 'BUY' ? 'BUY' : 'SELL',
        price: Price.of(new Decimal(action.price).div(100)),
        size: Quantity.of(action.size),
      });
    }

    return intents;
  }

  /**
   * Проверяет условия входа в позицию.
   *
   * @remarks
   * Условия входа:
   * - `tauSec ∈ (exitTauSec + 5, maxEntryTauSec]`
   * - `inventoryUnits < qMax`
   * - Нет adverse сигнала
   * - При `requireSignalForEntry = true` — нужен favorable сигнал
   * - `adjustedFairCents ∈ [minFairCents, maxFairCents]`
   * - `edge = adjustedFair - mid ≥ minEdgeCents`
   *
   * Если открытый BUY-ордер уже стоит близко к целевой цене
   * (в пределах `makerRepriceThresholdCents`) — не выставляем новый.
   *
   * @param data - Данные тика
   * @returns BUY-действие или `undefined`
   */
  private _checkEntry(data: CexLeadLagData): CexLeadLagAction | undefined {
    if (data.tauSec < this._exitTauSec + 5) return undefined;
    if (data.tauSec > this._maxEntryTauSec) return undefined;
    if (data.inventoryUnits >= this._qMax) return undefined;
    if (data.signalAdverse) {
      this._logDiag(data, 'ADVERSE_SKIP');
      return undefined;
    }
    if (this._requireSignalForEntry && !data.signalFavorable) return undefined;
    if (data.adjustedFairCents < this._minFairCents || data.adjustedFairCents > this._maxFairCents) return undefined;

    const edgeToMid = data.adjustedFairCents - data.midCents;
    if (edgeToMid < this._minEdgeCents) return undefined;

    let bidPrice = Math.floor(data.adjustedFairCents - this._minEdgeCents);
    if (!this._allowTaker && data.bestAskCents !== undefined) {
      bidPrice = Math.min(bidPrice, Math.floor(data.bestAskCents) - 1);
    } else if (!this._allowTaker) {
      bidPrice = Math.min(bidPrice, Math.floor(data.midCents - this._baseSpreadCents));
    }
    bidPrice = Math.floor(clamp(bidPrice, 1, 98));
    if (bidPrice <= 0) return undefined;

    if (
      data.openBuyPriceCents !== undefined
      && data.adjustedFairCents - data.openBuyPriceCents >= this._minEdgeCents
      && Math.abs(bidPrice - data.openBuyPriceCents) <= this._makerRepriceThresholdCents
    ) {
      this._logDiag(data, 'HOLD_BID', {
        bid: data.openBuyPriceCents.toFixed(0),
        desiredBid: bidPrice,
        edgeToOpenBid: (data.adjustedFairCents - data.openBuyPriceCents).toFixed(2),
      });
      return undefined;
    }

    const buySize = this._buySizeForPrice(data, bidPrice);
    if (!buySize) return undefined;

    const cost = buySize.mul(bidPrice).div(100);
    if (data.availableBalance.lt(cost)) return undefined;

    this._logDiag(data, 'BUY', {
      bid: bidPrice,
      edgeToMid: edgeToMid.toFixed(2),
      size: buySize.toString(),
    });
    return { type: 'BUY', price: bidPrice, size: buySize };
  }

  /**
   * Вычисляет размер BUY-ордера с учётом ограничений.
   *
   * @remarks
   * Итоговый размер = `max(orderSize, minOrderSize, minSizeForMinValue)`.
   * Если размер превышает оставшийся инвентарь до `qMax` — возвращает `undefined`.
   *
   * @param data - Данные тика
   * @param priceCents - Цена BUY-ордера (¢)
   * @returns Размер ордера или `undefined` если невозможно
   */
  private _buySizeForPrice(data: CexLeadLagData, priceCents: number): Decimal | undefined {
    const maxPositionQty = this._orderSize.mul(this._qMax);
    const remainingQty = maxPositionQty.minus(data.positionQty);
    if (remainingQty.lte(0)) return undefined;

    const price = new Decimal(priceCents).div(100);
    const minSizeForValue = data.minOrderValue.gt(0)
      ? data.minOrderValue.div(price).ceil()
      : new Decimal(0);
    const effectiveSize = Decimal.max(this._orderSize, data.minOrderSize, minSizeForValue);

    if (effectiveSize.gt(remainingQty)) return undefined;
    if (effectiveSize.mul(price).lt(data.minOrderValue)) return undefined;
    return effectiveSize;
  }

  /**
   * Проверяет условия выхода из позиции.
   *
   * @remarks
   * Выход происходит при любом из:
   * - Adverse сигнал
   * - `fairEdge < -exitEdgeCents` (fair value упал ниже mid)
   * - `tauSec < exitTauSec`
   *
   * При `allowTaker = true` — sell по best bid (taker).
   * Иначе — sell по `mid - exitDiscountCents` (maker).
   *
   * @param data - Данные тика
   * @returns SELL-действие или `undefined`
   */
  private _checkExit(data: CexLeadLagData): CexLeadLagAction | undefined {
    const fairEdge = data.adjustedFairCents - data.midCents;
    const shouldExit =
      data.signalAdverse
      || fairEdge < -this._exitEdgeCents
      || data.tauSec < this._exitTauSec;

    if (!shouldExit || !data.availableTokenQty.gt(0)) return undefined;

    let askPrice = Math.floor(data.midCents - this._exitDiscountCents);
    if (this._allowTaker && data.bestBidCents !== undefined) {
      askPrice = Math.min(askPrice, Math.floor(data.bestBidCents));
    }
    askPrice = Math.floor(clamp(askPrice, 1, 99));

    const size = Decimal.min(this._orderSize, data.availableTokenQty);
    this._logDiag(data, data.signalAdverse ? 'ADVERSE_EXIT' : 'EXIT', {
      ask: askPrice,
      fairEdge: fairEdge.toFixed(2),
    });
    return { type: 'SELL', price: askPrice, size };
  }

  /**
   * Обновляет EWMA mid на основе новых трейдов из TradeTape.
   *
   * @remarks
   * Если трейдов ещё нет, инициализирует EWMA из mid топбука.
   *
   * @param snapshot - Снапшот рынка
   */
  private _updateEwma(snapshot: StrategySnapshot): void {
    const tapeRecords = snapshot.tradeTape?.getAll();
    if (tapeRecords && tapeRecords.length > 0) {
      for (const trade of tapeRecords) {
        const tradeTs = trade.timestamp.toNumber();
        if (tradeTs <= this._lastTradeTimestampMs) continue;
        const priceCents = trade.price.value().toNumber() * 100;
        this._ewma = this._ewma === null
          ? priceCents
          : this._ewmaAlpha * priceCents + (1 - this._ewmaAlpha) * this._ewma;
        this._tradeCount++;
        this._lastTradeTimestampMs = tradeTs;
      }
    }

    if (this._ewma !== null || !snapshot.topOfBook) return;
    const bid = snapshot.topOfBook.bestBid?.value().toNumber();
    const ask = snapshot.topOfBook.bestAsk?.value().toNumber();
    if (bid !== undefined && ask !== undefined) {
      this._ewma = (bid + ask) / 2 * 100;
      this._tradeCount = Math.max(this._tradeCount, 1);
    }
  }

  /**
   * Возвращает лучший bid из топбука в центах.
   *
   * @param snapshot - Снапшот рынка
   * @returns Цена bid (¢) или `undefined`
   */
  private _bestBidCents(snapshot: StrategySnapshot): number | undefined {
    const value = snapshot.topOfBook?.bestBid?.value().toNumber();
    return value === undefined ? undefined : value * 100;
  }

  /**
   * Возвращает лучший ask из топбука в центах.
   *
   * @param snapshot - Снапшот рынка
   * @returns Цена ask (¢) или `undefined`
   */
  private _bestAskCents(snapshot: StrategySnapshot): number | undefined {
    const value = snapshot.topOfBook?.bestAsk?.value().toNumber();
    return value === undefined ? undefined : value * 100;
  }

  /**
   * Возвращает цену открытого BUY-ордера в центах, если есть.
   *
   * @param snapshot - Снапшот рынка
   * @returns Цена открытого BUY-ордера (¢) или `undefined`
   */
  private _openBuyPriceCents(snapshot: StrategySnapshot): number | undefined {
    const order = snapshot.openOrders.find((item) => item.side === 'BUY');
    return order ? order.price.value().toNumber() * 100 : undefined;
  }

  /**
   * Логирует диагностику тика не чаще чем раз в 5 секунд.
   *
   * @param data - Данные тика
   * @param action - Метка действия (BUY, HOLD, EXIT и т.д.)
   * @param extra - Дополнительные поля для лога
   */
  private _logDiag(data: CexLeadLagData, action: string, extra?: Record<string, unknown>): void {
    if (data.nowMs - this._lastDiagMs < 5_000) return;
    this._lastDiagMs = data.nowMs;
    this._logger?.info('CexLeadLag: tick', {
      action,
      side: data.side,
      mode: data.mode,
      fair: data.baseFairCents.toFixed(2),
      adjFair: data.adjustedFairCents.toFixed(2),
      mid: data.midCents.toFixed(2),
      signalDir: data.signal?.direction ?? 'none',
      tokenSignalDir: data.signalDirectionForToken,
      signalValueBps: data.signal?.value.toFixed(3),
      signalStrength: data.signal?.strength.toFixed(2),
      signalConfidence: data.signal?.confidence.toFixed(3),
      signalImpact: data.signalImpactCents.toFixed(2),
      tau: data.tauSec.toFixed(0),
      inv: data.inventoryUnits.toFixed(2),
      chainlink: data.currentPrice.toFixed(2),
      strike: data.targetPrice.toFixed(2),
      ...extra,
    });
  }
}
