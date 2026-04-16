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
import type { OrderId } from '@polymarket/ids';
import type { ILogger } from '@polymarket/logger';
import type { IDecisionJournal } from '@polymarket/ports';
import Decimal from 'decimal.js';

const SECONDS_PER_YEAR = 365.25 * 24 * 3600;

/**
 * Режим работы стратегии CEX Lead-Lag.
 *
 * @remarks
 * В signal-first архитектуре все режимы торгуют одинаково — через
 * residual/lag между CEX и Chainlink. Поле mode сохранено для совместимости
 * и возможного расширения (например, агрессивность sizing по режиму).
 *
 * - `defensive` — ранее: сигнал не влиял на fair value. Сейчас: reserved.
 * - `skewed` — ранее: сигнал смещал fair value. Сейчас: default signal-first.
 * - `hybrid` — зарезервировано для будущего использования.
 */
export type CexLeadLagMode = 'defensive' | 'skewed' | 'hybrid';

/**
 * Направление ставки: UP-токен (цена вырастет) или DOWN-токен (цена упадёт).
 */
export type CexLeadLagSide = 'up' | 'down';

/**
 * Конфигурация стратегии CexLeadLag (signal-first).
 *
 * @remarks
 * Стратегия торгует ожидаемый репрайс Polymarket, вызванный устойчивым
 * лагом между CEX consensus и Chainlink. Вход разрешён только при
 * наличии достаточного netExpectedEdgeCents после штрафов за исполнение.
 *
 * GBM-компонент (sigmaAnnual) используется ТОЛЬКО как вспомогательный
 * инструмент оценки чувствительности вероятности к движению underlying
 * (probabilitySensitivityCentsPerBps). Он не является источником fair value.
 */
export interface CexLeadLagConfig {
  /** Размер одного ордера в токенах. */
  readonly orderSize: Decimal;
  /** Максимальное кол-во единиц инвентаря (в orderSize). */
  readonly qMax: number;
  /** Торгуем UP или DOWN токен. Default: "up". */
  readonly side?: CexLeadLagSide;
  /**
   * Режим. Default: "skewed". В текущей реализации поведение одинаково
   * для всех режимов — стратегия signal-first.
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
  /** Максимальный возраст Chainlink-цены для принятия решений (ms). Default: 5000. */
  readonly chainlinkStaleMs?: number;
  /** Минимальное кол-во активных бирж для сигнала. */
  readonly minVenueCount?: number;
  /** Максимальный спред на бирже (bps). Биржа с более широким спредом игнорируется. */
  readonly maxSpreadBps?: number;
  /** Минимальная сила сигнала [0..10] для входа. Default: 6. */
  readonly minSignalStrength?: number;
  /** Минимальная уверенность сигнала [0..1] для входа. Default: 0.55. */
  readonly minSignalConfidence?: number;
  /** Порог репрайса maker-ордера (¢). Default: 1. */
  readonly makerRepriceThresholdCents?: number;
  /** Требовать сигнал для входа. Default: true. */
  readonly requireSignalForEntry?: boolean;
  /** Разрешить taker-ордера (пересекать спред). Default: false. */
  readonly allowTaker?: boolean;
  /**
   * Годовая волатильность — ТОЛЬКО как rough sensitivity helper.
   *
   * @remarks
   * Используется исключительно для оценки probabilitySensitivityCentsPerBps:
   * насколько изменение underlying на 1 bps сдвигает вероятность бинарного исхода.
   * Не является источником fair value или точной вероятности.
   * Default: 0.60 (60%).
   */
  readonly sigmaAnnual?: number;
  /**
   * Минимальный netExpectedEdgeCents для входа (¢).
   *
   * @remarks
   * Порог проверяется уже ПОСЛЕ вычета executionPenaltyCents.
   * Default: 2.
   */
  readonly minEdgeCents?: number;
  /**
   * Порог для выхода по отрицательному edge (¢).
   *
   * @remarks
   * Выход происходит при netExpectedEdgeCents <= -exitEdgeCents.
   * Default: 1.
   */
  readonly exitEdgeCents?: number;
  /** Базовый спред для расчёта bid-цены входа (¢). Default: 1. */
  readonly baseSpreadCents?: number;
  /** Скидка к tradeEwma при выходе — sell ниже ewma на эту величину (¢). Default: 1. */
  readonly exitDiscountCents?: number;
  /**
   * Дополнительное проскальзывание от best bid для аварийных выходов
   * (stop-loss/adverse/tau), чтобы SELL пересекал книгу. Default: 2.
   */
  readonly emergencyExitSlippageCents?: number;
  /**
   * Максимальное расстояние (¢) от последнего выхода, выше которого
   * повторный вход запрещён. 0 = отключено. Default: 5.
   */
  readonly maxChaseAboveExitCents?: number;
  /**
   * Жёсткий стоп-лосс: выходим если tradeEwma упал ниже цены входа на эту
   * величину (¢). 0 = отключено. Default: 10.
   */
  readonly stopLossCents?: number;
  /**
   * Время (мс) после срабатывания стоп-лосса, в течение которого новый
   * вход запрещён. 0 = отключено. Default: 60000.
   */
  readonly stopLossCooldownMs?: number;
  /**
   * Прибыль от цены входа (¢), при которой активируется break-even floor.
   *
   * @remarks
   * Когда `peakPriceCents - entryPriceCents >= breakEvenTriggerCents`,
   * нижний стоп поднимается до `entryPriceCents + breakEvenOffsetCents`.
   * Default: 3.
   */
  readonly breakEvenTriggerCents?: number;
  /**
   * Смещение break-even стопа выше цены входа (¢).
   *
   * @remarks
   * Стоп-floor устанавливается в `entryPriceCents + breakEvenOffsetCents`
   * после активации break-even. Default: 0.5.
   */
  readonly breakEvenOffsetCents?: number;
  /**
   * Базовое trailing distance как доля от накопленной прибыли (profit-from-entry).
   *
   * @remarks
   * `trailingDistance = (peakPriceCents - entryPriceCents) × trailingStartMultiplier`.
   * Значение 0.5 означает: защищаем 50% накопленной прибыли.
   * Default: 0.5.
   */
  readonly trailingStartMultiplier?: number;
  /**
   * Минимальное trailing distance (¢).
   *
   * @remarks
   * Ограничивает снизу результат всех tightening-умножений.
   * Default: 2.
   */
  readonly minTrailingDistanceCents?: number;
  /**
   * Секунды до экспирации, с которых начинается tau-tightening trailing stop.
   *
   * @remarks
   * При tauSec >= tauTighteningStartSec multiplier = 1.0 (без tightening).
   * Ниже порога multiplier линейно снижается до tauTighteningMinMultiplier.
   * Default: 60.
   */
  readonly tauTighteningStartSec?: number;
  /**
   * Минимальный tau-tightening multiplier для trailing distance.
   *
   * @remarks
   * Нижний предел линейной интерполяции tau-tightening. Default: 0.4.
   */
  readonly tauTighteningMinMultiplier?: number;
  /**
   * Применять signal-tightening при коллапсе сигнала. Default: true.
   */
  readonly signalTighteningOnCollapse?: boolean;
  /**
   * Применять signal-tightening при adverse сигнале. Default: true.
   */
  readonly signalTighteningOnAdverse?: boolean;
  /**
   * Multiplier trailing distance при signal-tightening. Default: 0.7.
   */
  readonly signalTighteningMultiplier?: number;
  /**
   * Включить profit-protect trailing stop. Default: true.
   *
   * @remarks
   * При false используется только hard stop-loss без trailing logic.
   */
  readonly profitProtectTrailingEnabled?: boolean;
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
  /**
   * Минимальная длительность сигнала (ms) перед входом.
   *
   * @remarks
   * Фильтрует тиковый шум: одиночный всплеск residual на одном тике не даёт вход.
   * Снижение до 0 означает вход при первом сильном сигнале без ожидания persistence.
   * Default: 150.
   */
  readonly minSignalPersistenceMs?: number;
}

/**
 * Данные тика для принятия торговых решений (signal-first архитектура).
 *
 * @remarks
 * Центральный объект принятия решений — не adjustedFairCents, а:
 * - `residualBps` — величина lag между CEX consensus и Chainlink
 * - `signalPersistenceMs` — сколько мс сигнал держится в одном направлении
 * - `venueAgreement` — доля бирж, согласованных по направлению
 * - `probabilitySensitivityCentsPerBps` — оценка sensitivity (не fair value!)
 * - `signalExpectedMoveCents` — ожидаемое движение вероятности в центах
 * - `executionPenaltyCents` — штраф за исполнение (спред, tau, stale Chainlink)
 * - `netExpectedEdgeCents` — итоговый edge после штрафов
 */
interface CexLeadLagData {
  readonly marketId: string;
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

  /** EWMA mid по трейдам (¢) — reference price, не fair value. */
  readonly tradeEwmaCents: number;
  readonly bestBidCents: number | undefined;
  readonly bestAskCents: number | undefined;
  /** Цена открытого BUY-ордера, если есть. */
  readonly openBuyPriceCents: number | undefined;
  /** ID открытого BUY-ордера для selective cancel. */
  readonly openBuyOrderId: OrderId | undefined;

  /** Секунды до экспирации. */
  readonly tauSec: number;
  readonly positionQty: Decimal;
  readonly availableTokenQty: Decimal;
  readonly availableBalance: Decimal;
  readonly minOrderSize: Decimal;
  readonly minOrderValue: Decimal;
  /** Инвентарь в единицах orderSize. */
  readonly inventoryUnits: number;
  /**
   * Fill прилетел по WS, но ещё не обработан локально.
   * CANCEL оправдан — снимаем открытые ордера пока не видим актуальное состояние.
   */
  readonly hasInFlightFills: boolean;
  /**
   * BUY-ордер MATCHED на бирже — fill неизбежен, ждём его.
   * CANCEL бессмысленен: ордер уже исполнен, cancel будет проигнорирован
   * CancelOrderUseCase и только выставит ненужный cooldown в ExecutionEngine.
   */
  readonly hasMatchedOrders: boolean;

  readonly nowMs: number;
  readonly currentPrice: number;
  readonly chainlinkPrice: number;
  readonly chainlinkTimestampMs: number;
  readonly chainlinkAgeMs: number;
  readonly chainlinkStale: boolean;
  readonly targetPrice: number;

  /**
   * Знаковый residual (bps): CEX consensus vs Chainlink применительно к нашему токену.
   * Положительный → сигнал благоприятен (UP для up-токена), отрицательный → adverse.
   */
  readonly residualBps: number;
  /** Абсолютная величина residual (bps). */
  readonly residualMagnitudeBps: number;
  /** Сколько мс сигнал держится в одном направлении без смены знака. */
  readonly signalPersistenceMs: number;
  /** Доля CEX-бирж, согласованных по направлению [0..1]. */
  readonly venueAgreement: number;

  /**
   * Оценка: на сколько центов сдвигается вероятность при движении underlying на 1 bps.
   *
   * @remarks
   * Это sensitivity-helper, не fair value. Зависит от distance-to-strike и tau.
   * Вычисляется через числовое дифференцирование binaryUpProbability.
   */
  readonly probabilitySensitivityCentsPerBps: number;
  /**
   * Ожидаемое движение вероятности от сигнала (¢).
   *
   * @remarks
   * = |residualBps| × probabilitySensitivityCentsPerBps × signalQuality01
   */
  readonly signalExpectedMoveCents: number;
  /**
   * Штраф за исполнение (¢).
   *
   * @remarks
   * Учитывает спред, tau, возраст Chainlink.
   */
  readonly executionPenaltyCents: number;
  /**
   * Итоговый ожидаемый edge после штрафов (¢).
   *
   * @remarks
   * = signedSignalMoveCents − executionPenaltyCents
   * Положительный → вход обоснован, отрицательный → вход запрещён/выход.
   */
  readonly netExpectedEdgeCents: number;

  readonly venues: Record<string, unknown>;
}

/**
 * Торговые действия стратегии.
 *
 * - `BUY` — открыть/добавить позицию.
 * - `SELL` — закрыть позицию (выход).
 * - `CANCEL` — снять все активные ордера.
 */
type CexLeadLagAction =
  | { readonly type: 'BUY'; readonly price: number; readonly size: Decimal; readonly cancelOrderId?: OrderId }
  | { readonly type: 'SELL'; readonly price: number; readonly size: Decimal }
  | { readonly type: 'CANCEL' };

// ─────────────────────────────────────────────────────────────────────────────
// Математические вспомогательные функции
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Аппроксимация CDF нормального распределения через erf (Абрамович-Стегун 7.1.26).
 *
 * @remarks
 * Формула: Φ(x) = 0.5 × (1 + sign × erf(|x/√2|))
 *
 * Алгоритм:
 * 1. Вычисляем z = x / √2 для преобразования в аргумент erf.
 * 2. Применяем полиномиальную аппроксимацию erf с коэффициентами A&S.
 * 3. Возвращаем нормализованный результат через 0.5 × (1 + sign × erf).
 *
 * Погрешность: |ε| < 1.5×10⁻⁷ (максимальная по всему диапазону).
 *
 * @param x - z-score нормального распределения
 * @returns P(Z ≤ x) ∈ [0, 1]
 *
 * @example
 * ```typescript
 * normalCdf(0)   // ≈ 0.5
 * normalCdf(1)   // ≈ 0.8413
 * normalCdf(-1)  // ≈ 0.1587
 * normalCdf(2)   // ≈ 0.9772
 * ```
 */
export function normalCdf(x: number): number {
  if (x < -8) return 0;
  if (x > 8) return 1;

  const z = x / Math.sqrt(2);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = z < 0 ? -1 : 1;
  const absZ = Math.abs(z);
  const t = 1 / (1 + p * absZ);

  const erf =
    1 -
    (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) *
      t *
      Math.exp(-absZ * absZ));

  return 0.5 * (1 + sign * erf);
}

/**
 * Зажимает значение в диапазон [lower, upper].
 *
 * @param x - Входное значение
 * @param min - Нижняя граница
 * @param max - Верхняя граница
 * @returns Зажатое значение
 */
function clampNumber(x: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, x));
}

/**
 * Вычисляет нейтральную вероятность P(S_T ≥ K) по GBM без дрейфа.
 *
 * @remarks
 * Используется ТОЛЬКО как sensitivity helper — не как fair value.
 *
 * Формула: z = (ln(S/K) − 0.5σ²T) / (σ√T)  → P = Φ(z)
 *
 * Отличие от простого Φ(ln(S/K)/(σ√T)):
 * включает drift-correction −0.5σ²T в числителе, что даёт
 * нейтральную (риск-нейтральную) вероятность исхода.
 *
 * @param price - Текущая цена базового актива
 * @param strike - Страйк события
 * @param sigmaAnnual - Годовая волатильность (например, 0.60 = 60%)
 * @param tauSec - Секунды до экспирации
 * @returns Вероятность ∈ [0.01, 0.99]
 *
 * @example
 * ```typescript
 * binaryUpProbability(100_000, 100_000, 0.6, 300) // ≈ 0.47 (ATM, short tau)
 * binaryUpProbability(102_000, 100_000, 0.6, 300) // > 0.5 (in-the-money)
 * ```
 */
export function binaryUpProbability(
  price: number,
  strike: number,
  sigmaAnnual: number,
  tauSec: number,
): number {
  if (tauSec <= 0) return price >= strike ? 0.99 : 0.01;
  if (price <= 0 || strike <= 0 || sigmaAnnual <= 0) return 0.5;

  const tauYears = tauSec / SECONDS_PER_YEAR;
  const denom = sigmaAnnual * Math.sqrt(tauYears);
  if (denom <= 0) return price >= strike ? 0.99 : 0.01;

  const z =
    (Math.log(price / strike) - 0.5 * sigmaAnnual * sigmaAnnual * tauYears) /
    denom;

  return clampNumber(normalCdf(z), 0.01, 0.99);
}

/**
 * Оценивает чувствительность вероятности к движению underlying на 1 bps.
 *
 * @remarks
 * Используется как LOCAL SENSITIVITY ESTIMATOR, не как fair value.
 *
 * Алгоритм:
 * 1. Вычислить base probability при текущей цене.
 * 2. Вычислить bumped probability при цене × 1.0001 (+1 bps).
 * 3. Вернуть |delta| × 100 (в центах).
 *
 * Значение показывает: если underlying сдвинется на 1 bps от Chainlink,
 * вероятность UP-исхода изменится примерно на это количество центов.
 *
 * @param price - Текущая цена
 * @param strike - Страйк
 * @param sigmaAnnual - Годовая волатильность
 * @param tauSec - Секунды до экспирации
 * @returns Чувствительность (¢/bps), всегда >= 0
 *
 * @example
 * ```typescript
 * // ATM при коротком tau — высокая чувствительность:
 * probabilitySensitivityCentsPerBps(100_000, 100_000, 0.6, 60) // ≈ 0.05–0.15
 * // Далеко OTM — низкая:
 * probabilitySensitivityCentsPerBps(80_000, 100_000, 0.6, 300) // < 0.01
 * ```
 */
export function probabilitySensitivityCentsPerBps(
  price: number,
  strike: number,
  sigmaAnnual: number,
  tauSec: number,
): number {
  if (price <= 0 || strike <= 0 || sigmaAnnual <= 0 || tauSec <= 0) return 0;

  const base = binaryUpProbability(price, strike, sigmaAnnual, tauSec);
  const bumped = binaryUpProbability(price * 1.0001, strike, sigmaAnnual, tauSec);

  return Math.abs((bumped - base) * 100);
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

// ─────────────────────────────────────────────────────────────────────────────
// Стратегия
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Signal-first стратегия на основе CEX lead-lag относительно Chainlink.
 *
 * @remarks
 * ### Гипотеза стратегии
 *
 * Когда несколько качественных CEX-источников устойчиво и согласованно
 * сдвигаются в одну сторону быстрее, чем обновляется Chainlink, а Polymarket
 * ещё не полностью встроил это ожидаемое обновление в цену бинарного исхода,
 * возникает кратковременный предсказуемый edge. Стратегия торгует только тот
 * edge, который остаётся положительным после учёта времени, спреда, исполнения
 * и риска adverse selection.
 *
 * ### Архитектура решения
 *
 * 1. **Residual** (`residualBps`) — lag между CEX consensus и Chainlink.
 *    Это основная входная переменная, а не GBM fair value.
 *
 * 2. **Signal quality** — residual оценивается через:
 *    - persistence (сколько мс сигнал держится)
 *    - venue agreement (доля согласованных бирж)
 *    - strength/confidence из signal registry
 *
 * 3. **Monetizability** — насколько residual конвертируется в edge на Polymarket:
 *    - `probabilitySensitivityCentsPerBps` — sensitivity к движению underlying
 *    - `signalExpectedMoveCents` = |residual| × sensitivity × signalQuality
 *    - `executionPenaltyCents` — штраф за спред, tau, stale Chainlink
 *    - `netExpectedEdgeCents` = signalExpectedMoveCents − executionPenaltyCents
 *
 * 4. **Entry** — только при netExpectedEdgeCents >= minEdgeCents.
 *
 * 5. **Exit** — при adverse signal, collapse, negative edge, или tau.
 *
 * ### Что намеренно упрощено
 *
 * - `sigmaAnnual` — фиксированная константа (rough approximation).
 *   TODO: заменить на rolling realized vol или regime-based sigma.
 * - `_entryPriceCents` / `_lastExitPriceCents` — восстанавливаются эвристически
 *   из pending order price / EWMA fallback.
 *   TODO: перевести на fill-derived weighted average prices (см. комментарий в decide()).
 *
 * @example
 * ```typescript
 * const strategy = new CexLeadLagStrategy(
 *   { orderSize: new Decimal(10), qMax: 2, side: 'up' },
 *   'cex-ll-btc',
 *   logger,
 * );
 * ```
 */
export class CexLeadLagStrategy extends BaseStrategy<CexLeadLagData, CexLeadLagAction> {
  public readonly id: string;
  public readonly name = 'CexLeadLagStrategy';

  private readonly _logger: ILogger | undefined;
  private readonly _journal: IDecisionJournal | undefined;
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
  private readonly _chainlinkStaleMs: number;
  private readonly _minVenueCount: number | undefined;
  private readonly _maxSpreadBps: number | undefined;
  private readonly _minSignalStrength: number;
  private readonly _minSignalConfidence: number;
  private readonly _makerRepriceThresholdCents: number;
  private readonly _requireSignalForEntry: boolean;
  private readonly _allowTaker: boolean;
  private readonly _sigmaAnnual: number;
  private readonly _minEdgeCents: number;
  private readonly _exitEdgeCents: number;
  private readonly _baseSpreadCents: number;
  private readonly _exitDiscountCents: number;
  private readonly _emergencyExitSlippageCents: number;
  private readonly _maxChaseAboveExitCents: number;
  private readonly _stopLossCents: number;
  private readonly _stopLossCooldownMs: number;
  private readonly _breakEvenTriggerCents: number;
  private readonly _breakEvenOffsetCents: number;
  private readonly _trailingStartMultiplier: number;
  private readonly _minTrailingDistanceCents: number;
  private readonly _tauTighteningStartSec: number;
  private readonly _tauTighteningMinMultiplier: number;
  private readonly _signalTighteningOnCollapse: boolean;
  private readonly _signalTighteningOnAdverse: boolean;
  private readonly _signalTighteningMultiplier: number;
  private readonly _profitProtectTrailingEnabled: boolean;
  private readonly _warmupSec: number;
  private readonly _ewmaAlpha: number;
  private readonly _minTradesForMid: number;
  private readonly _exitTauSec: number;
  private readonly _maxEntryTauSec: number;
  private readonly _minSignalPersistenceMs: number;

  // ── Mutable state ─────────────────────────────────────────────────────────
  private _ewma: number | null = null;
  private _tradeCount = 0;
  private _lastTradeTimestampMs = 0;
  private _currentExpirationMs = 0;
  private _marketEventStartMs = 0;
  private _lastDiagMs = 0;
  private _lastChainlinkStaleLogMs = 0;

  /**
   * Цена входа в текущую позицию (¢), или null если позиции нет.
   *
   * @remarks
   * TODO: заменить эвристику на fill-derived weighted average price.
   * Текущая логика использует pending order price / EWMA fallback и
   * ненадёжна при partial fills, multiple fills и price improvement.
   */
  private _entryPriceCents: number | null = null;

  /**
   * Цена последнего выхода (¢) для anti-chase защиты.
   *
   * @remarks
   * TODO: заменить эвристику на fill-derived weighted average price.
   */
  private _lastExitPriceCents: number | null = null;

  /** Размер позиции на предыдущем тике — для определения момента входа/выхода. */
  private _prevPositionQty: Decimal = new Decimal(0);
  /** Последняя bid-цена BUY-ордера, выставленного стратегией. */
  private _pendingEntryPriceCents: number | null = null;
  /** Время последнего срабатывания стоп-лосса (ms). null если не было. */
  private _stopLossTriggeredAtMs: number | null = null;
  private _currentMarketId = '';
  private _lastJournalDecisionMs = 0;

  /** Время начала текущего сигнального режима (ms). null если flat. */
  private _signalStartedAtMs: number | null = null;
  /** Направление сигнала на предыдущем тике. */
  private _lastSignalDirection: CryptoSignalDirection = 'flat';
  /** Знаковый residual bps на предыдущем тике. */
  private _lastResidualBps = 0;

  /**
   * Был ли сигнал favorable на предыдущем тике decide().
   * Используется для определения перехода SIGNAL_ON/SIGNAL_OFF.
   */
  private _prevSignalFavorable = false;
  /**
   * Был ли сигнал adverse на предыдущем тике decide().
   * Используется для определения перехода SIGNAL_ADVERSE.
   */
  private _prevSignalAdverse = false;
  /**
   * EWMA mid (¢) в момент последнего выставления BUY-ордера.
   * Используется для расчёта drift при снятии ордера.
   */
  private _lastPlacedMidCents: number | null = null;
  /**
   * Residual (bps) в момент SIGNAL_ON — для расчёта gapClosedBps при SIGNAL_OFF.
   * Всегда абсолютная величина (> 0).
   */
  private _signalOnResidualBps: number | null = null;
  /**
   * Цена Chainlink (USD) в момент SIGNAL_ON — для расчёта chainlinkMoveUsd при SIGNAL_OFF.
   */
  private _signalOnChainlinkPrice: number | null = null;
  /**
   * Timestamp SIGNAL_ON (ms) — для расчёта durationMs при SIGNAL_OFF.
   */
  private _signalOnTs: number | null = null;

  /** Пиковая EWMA mid со времени входа (¢). null если нет позиции. */
  private _peakPriceCents: number | null = null;
  /** Пиковый netExpectedEdgeCents со времени входа. null если нет позиции. */
  private _peakNetExpectedEdgeCents: number | null = null;
  /** Пиковый residualMagnitudeBps со времени входа. null если нет позиции. */
  private _peakResidualMagnitudeBps: number | null = null;
  /**
   * Текущий уровень trailing stop (¢). null если не активирован.
   *
   * @remarks
   * Монотонно возрастает — trailing stop может только подниматься, но не опускаться.
   */
  private _trailingStopCents: number | null = null;

  /**
   * @param config - Конфигурация стратегии
   * @param strategyId - Уникальный идентификатор экземпляра. Default: "cex-lead-lag-1"
   * @param logger - Опциональный логгер
   * @param journal - Опциональный журнал решений
   */
  constructor(
    config: CexLeadLagConfig,
    strategyId = 'cex-lead-lag-1',
    logger?: ILogger,
    journal?: IDecisionJournal,
  ) {
    super();
    this.id = strategyId;
    this._logger = logger;
    this._journal = journal;
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
    this._chainlinkStaleMs = toNumber(config.chainlinkStaleMs, 5_000);
    this._minVenueCount = config.minVenueCount;
    this._maxSpreadBps = config.maxSpreadBps;
    this._minSignalStrength = toNumber(config.minSignalStrength, 6);
    this._minSignalConfidence = toNumber(config.minSignalConfidence, 0.55);
    this._makerRepriceThresholdCents = toNumber(config.makerRepriceThresholdCents, 1);
    this._requireSignalForEntry = config.requireSignalForEntry ?? true;
    this._allowTaker = config.allowTaker ?? false;
    this._sigmaAnnual = toNumber(config.sigmaAnnual, 0.60);
    this._minEdgeCents = toNumber(config.minEdgeCents, 2);
    this._exitEdgeCents = toNumber(config.exitEdgeCents, 1);
    this._baseSpreadCents = toNumber(config.baseSpreadCents, 1);
    this._exitDiscountCents = toNumber(config.exitDiscountCents, 1);
    this._emergencyExitSlippageCents = Math.max(0, toNumber(config.emergencyExitSlippageCents, 2));
    this._maxChaseAboveExitCents = toNumber(config.maxChaseAboveExitCents, 5);
    this._stopLossCents = toNumber(config.stopLossCents, 5);
    this._stopLossCooldownMs = toNumber(config.stopLossCooldownMs, 60_000);
    this._breakEvenTriggerCents = toNumber(config.breakEvenTriggerCents, 2);
    this._breakEvenOffsetCents = toNumber(config.breakEvenOffsetCents, 1);
    this._trailingStartMultiplier = toNumber(config.trailingStartMultiplier, 0.5);
    this._minTrailingDistanceCents = Math.max(0.5, toNumber(config.minTrailingDistanceCents, 2));
    this._tauTighteningStartSec = toNumber(config.tauTighteningStartSec, 60);
    this._tauTighteningMinMultiplier = clampNumber(toNumber(config.tauTighteningMinMultiplier, 0.4), 0.1, 1);
    this._signalTighteningOnCollapse = config.signalTighteningOnCollapse ?? false;
    this._signalTighteningOnAdverse = config.signalTighteningOnAdverse ?? true;
    this._signalTighteningMultiplier = clampNumber(toNumber(config.signalTighteningMultiplier, 0.7), 0.1, 1);
    this._profitProtectTrailingEnabled = config.profitProtectTrailingEnabled ?? true;
    this._warmupSec = toNumber(config.warmupSec, 10);
    this._ewmaAlpha = toNumber(config.ewmaAlpha, 0.3);
    this._minTradesForMid = toNumber(config.minTradesForMid, 3);
    this._exitTauSec = toNumber(config.exitTauSec, 20);
    this._maxEntryTauSec = toNumber(config.maxEntryTauSec, 300);
    this._minSignalPersistenceMs = Math.max(0, toNumber(config.minSignalPersistenceMs, 1));

    this._logger?.warn('CexLeadLag: init (signal-first)', {
      strategyId: this.id,
      side: this._side,
      mode: this._mode,
      venues: this._venues.join(','),
      signalThresholdBps: this._signalThresholdBps,
      minSignalStrength: this._minSignalStrength,
      minSignalConfidence: this._minSignalConfidence,
      requireSignalForEntry: this._requireSignalForEntry,
      allowTaker: this._allowTaker,
      minEdgeCents: this._minEdgeCents,
      exitEdgeCents: this._exitEdgeCents,
      maxChaseAboveExitCents: this._maxChaseAboveExitCents,
      stopLossCents: this._stopLossCents,
      stopLossCooldownMs: this._stopLossCooldownMs,
      emergencyExitSlippageCents: this._emergencyExitSlippageCents,
      chainlinkStaleMs: this._chainlinkStaleMs,
      sigmaAnnual: this._sigmaAnnual,
      note: 'sigmaAnnual is sensitivity-helper only, not fair value source',
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // gather() — signal-first data collection
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Собирает данные тика из снапшота (signal-first архитектура).
   *
   * @remarks
   * Алгоритм:
   * 1. При смене рынка сбрасывает EWMA, счётчики, signal persistence state.
   * 2. Обновляет EWMA mid по трейдам.
   * 3. Проверяет валидность Chainlink, strike, tau.
   * 4. Оценивает signal, computing residualBps, persistence, venue agreement.
   * 5. Вычисляет probabilitySensitivity, signalExpectedMoveCents,
   *    executionPenaltyCents, netExpectedEdgeCents.
   *
   * Возвращает undefined до прогрева, при недостатке трейдов или
   * невалидных ценах.
   *
   * @param snapshot - Снапшот рынка
   * @returns Signal-first данные тика или undefined
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
      this._lastChainlinkStaleLogMs = 0;
      this._entryPriceCents = null;
      this._lastExitPriceCents = null;
      this._prevPositionQty = new Decimal(0);
      this._pendingEntryPriceCents = null;
      this._stopLossTriggeredAtMs = null;
      this._currentMarketId = String(snapshot.instrumentId);
      this._lastJournalDecisionMs = 0;
      this._signalStartedAtMs = null;
      this._lastSignalDirection = 'flat';
      this._lastResidualBps = 0;
      this._prevSignalFavorable = false;
      this._prevSignalAdverse = false;
      this._lastPlacedMidCents = null;
      this._signalOnResidualBps = null;
      this._signalOnChainlinkPrice = null;
      this._signalOnTs = null;
      this._peakPriceCents = null;
      this._peakNetExpectedEdgeCents = null;
      this._peakResidualMagnitudeBps = null;
      this._trailingStopCents = null;
    }

    this._updateEwma(snapshot);
    if (this._ewma === null || this._tradeCount < this._minTradesForMid) return undefined;
    if (snapshot.nowMs - this._marketEventStartMs < this._warmupSec * 1_000) return undefined;

    const chainlink = snapshot.cryptoPrice.chainlink;
    if (!chainlink || !Number.isFinite(chainlink.price) || chainlink.price <= 0) return undefined;

    const chainlinkAgeMs = snapshot.nowMs - chainlink.timestampMs;
    const chainlinkStale = chainlinkAgeMs < 0 || chainlinkAgeMs > this._chainlinkStaleMs;

    if (chainlinkStale && snapshot.nowMs - this._lastChainlinkStaleLogMs >= 5_000) {
      this._lastChainlinkStaleLogMs = snapshot.nowMs;
      this._logger?.warn('CexLeadLag: stale Chainlink price', {
        chainlinkPrice: chainlink.price,
        chainlinkTs: new Date(chainlink.timestampMs).toISOString(),
        chainlinkAgeMs,
        chainlinkStaleMs: this._chainlinkStaleMs,
      });
    }

    const currentPrice = chainlink.price;
    const targetPrice = snapshot.cryptoPrice.targetPrice;
    if (!targetPrice || targetPrice <= 0 || currentPrice <= 0) return undefined;

    const tauSec = Math.max(0, (expiresMs - snapshot.nowMs) / 1_000);

    // ── Signal evaluation ───────────────────────────────────────────────────
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

    const signalDirectionForToken =
      this._side === 'up'
        ? signal?.direction ?? 'flat'
        : invertDirection(signal?.direction ?? 'flat');

    const signalStrong = Boolean(
      signal &&
      !signal.stale &&
      signal.direction !== 'flat' &&
      signal.strength >= this._minSignalStrength &&
      signal.confidence >= this._minSignalConfidence,
    );

    const signalFavorable = signalStrong && signalDirectionForToken === 'up';
    const signalAdverse = signalStrong && signalDirectionForToken === 'down';

    // ── Signal integrity check ──────────────────────────────────────────────
    // Проверяем, что знак signal.value совпадает с direction.
    // Мы уничтожаем raw знак через Math.abs() и восстанавливаем его через
    // signalDirectionForToken — если контракт сигнала когда-нибудь нарушится,
    // это предотвращает тихую порчу данных.
    if (signal && signal.value !== 0) {
      const rawSign = Math.sign(signal.value);
      const dirSign =
        signal.direction === 'up' ? 1 :
        signal.direction === 'down' ? -1 : 0;
      if (rawSign !== 0 && dirSign !== 0 && rawSign !== dirSign) {
        this._logger?.warn('CexLeadLag: signal direction/value mismatch', {
          direction: signal.direction,
          value: signal.value,
          signalId: signal.id,
          ts: new Date(snapshot.nowMs).toISOString(),
        });
      }
    }

    // ── Residual computation ────────────────────────────────────────────────
    // signal.value — это residual в bps (CEX consensus − Chainlink).
    // Знак определяется относительно нашего токена: положительный = favorable.
    const residualBpsRaw = Number(signal?.value ?? 0);
    const residualBps =
      signalDirectionForToken === 'up'
        ? Math.abs(residualBpsRaw)
        : signalDirectionForToken === 'down'
          ? -Math.abs(residualBpsRaw)
          : 0;

    const signalPersistenceMs = this._updateSignalPersistence(
      signalDirectionForToken,
      residualBps,
      snapshot.nowMs,
    );

    const venueAgreement = this._venueAgreementByResidual(snapshot, currentPrice);

    // ── Probability sensitivity (sensitivity-helper, not fair value) ────────
    const probSensitivity = probabilitySensitivityCentsPerBps(
      currentPrice,
      targetPrice,
      this._sigmaAnnual,
      tauSec,
    );

    // ── Signal quality and expected move ───────────────────────────────────
    const signalStrength01 = signalStrong ? Math.min(1, signal!.strength / 10) : 0;
    const signalConfidence01 = signalStrong ? Math.min(1, signal!.confidence) : 0;

    const signalExpectedMoveCents =
      signalStrong && signalDirectionForToken !== 'flat'
        ? this._signalExpectedMoveCents({
            residualBps,
            probabilitySensitivityCentsPerBps: probSensitivity,
            signalStrength01,
            signalConfidence01,
            venueAgreement,
            signalPersistenceMs,
          })
        : 0;

    const bestBidCents = this._bestBidCents(snapshot);
    const bestAskCents = this._bestAskCents(snapshot);

    const executionPenaltyCents = this._executionPenaltyCents({
      bestBidCents,
      bestAskCents,
      tauSec,
      chainlinkAgeMs,
    });

    // Знаковый ожидаемый сдвиг: положительный для favourable, отрицательный для adverse
    const signedSignalMoveCents =
      signalDirectionForToken === 'up'
        ? signalExpectedMoveCents
        : signalDirectionForToken === 'down'
          ? -signalExpectedMoveCents
          : 0;

    const netExpectedEdgeCents = signedSignalMoveCents - executionPenaltyCents;

    // ── Portfolio / constraints ─────────────────────────────────────────────
    const position = snapshot.portfolio?.getPosition(snapshot.instrumentId);
    const positionQty = position?.quantity.value() ?? new Decimal(0);
    const availableTokenQty =
      snapshot.portfolio?.availableTokenQuantity(snapshot.instrumentId) ?? new Decimal(0);
    const availableBalance =
      snapshot.portfolio?.balance.available().value() ?? new Decimal(0);
    const minOrderSize = snapshot.constraints?.minOrderSize.value() ?? new Decimal(0);
    const minOrderValue = snapshot.constraints?.minOrderValue.value() ?? new Decimal(1);
    const inventoryUnits =
      this._orderSize.gt(0) ? positionQty.div(this._orderSize).toNumber() : 0;

    return {
      marketId: this._currentMarketId || String(snapshot.instrumentId),
      side: this._side,
      mode: this._mode,

      signal,
      signalDirectionForToken,
      signalStrong,
      signalFavorable,
      signalAdverse,

      tradeEwmaCents: this._ewma,
      bestBidCents,
      bestAskCents,
      openBuyPriceCents: this._openBuyPriceCents(snapshot),
      openBuyOrderId: this._openBuyOrderId(snapshot),

      tauSec,
      positionQty,
      availableTokenQty,
      availableBalance,
      minOrderSize,
      minOrderValue,
      inventoryUnits,
      hasInFlightFills: snapshot.hasInFlightFills,
      hasMatchedOrders: snapshot.matchedOrders.length > 0,

      nowMs: snapshot.nowMs,
      currentPrice,
      chainlinkPrice: chainlink.price,
      chainlinkTimestampMs: chainlink.timestampMs,
      chainlinkAgeMs,
      chainlinkStale,
      targetPrice,

      residualBps,
      residualMagnitudeBps: Math.abs(residualBps),
      signalPersistenceMs,
      venueAgreement,
      probabilitySensitivityCentsPerBps: probSensitivity,
      signalExpectedMoveCents,
      executionPenaltyCents,
      netExpectedEdgeCents,

      venues: this._venueState(snapshot),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // decide() — signal-first decision core
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Принимает торговые решения на основе signal-first логики.
   *
   * @remarks
   * Порядок проверок:
   * 1. Stale Chainlink → CANCEL (no new info for decision).
   * 2. Matched orders → HOLD (ордер исполнен, ждём fill — CANCEL бессмысленен).
   * 3. In-flight fills → CANCEL (fill прилетел по WS, ещё не обработан).
   * 4. Отслеживаем переходы позиции для фиксации entry/exit price.
   * 5. Есть позиция → проверяем exit через `_checkExitSignalFirst()`.
   * 6. Нет позиции → проверяем entry через `_checkEntrySignalFirst()`.
   *
   * @param data - Данные тика
   * @param _reasons - Причины триггера (не используются)
   * @returns Список действий
   */
  protected decide(
    data: CexLeadLagData,
    _reasons: ReadonlySet<TriggerReason>,
  ): CexLeadLagAction[] {
    // Отслеживаем переходы сигнала (SIGNAL_ON / SIGNAL_OFF / SIGNAL_ADVERSE)
    // до любых торговых решений, чтобы зафиксировать состояние в момент перехода.
    this._emitSignalTransitions(data);

    if (data.chainlinkStale) {
      this._logDiag(data, 'CANCEL', {
        reason: 'STALE_CHAINLINK',
        chainlinkAgeMs: data.chainlinkAgeMs,
        chainlinkStaleThresholdMs: this._chainlinkStaleMs,
        chainlinkTs: new Date(data.chainlinkTimestampMs).toISOString(),
        openBuyPriceCents: data.openBuyPriceCents?.toFixed(2) ?? 'none',
        hasPosition: data.positionQty.gt(0),
        positionQty: data.positionQty.toString(),
      });
      this._recordJournalDecision(data, 'CANCEL', { rejectReason: 'STALE_CHAINLINK' });
      this._emitCancelAnalytics(data, 'STALE_CHAINLINK');
      return [{ type: 'CANCEL' }];
    }

    // MATCHED ордер: fill неизбежен — CANCEL бессмысленен и выставит cooldown
    // в ExecutionEngine. Просто ждём WS fill event.
    if (data.hasMatchedOrders) {
      this._logDiag(data, 'HOLD', {
        reason: 'MATCHED_ORDER_AWAITING_FILL',
        note: 'BUY order is MATCHED on exchange — fill is guaranteed, waiting for WS event',
        positionQty: data.positionQty.toString(),
        availableTokenQty: data.availableTokenQty.toString(),
        openBuyPriceCents: data.openBuyPriceCents?.toFixed(2) ?? 'none',
        tradeEwmaCents: data.tradeEwmaCents.toFixed(2),
      });
      return [];
    }

    if (data.hasInFlightFills) {
      this._logDiag(data, 'CANCEL', {
        reason: 'IN_FLIGHT_FILLS',
        note: 'Fill received via WS but not yet processed locally — cancelling open orders',
        positionQty: data.positionQty.toString(),
        availableTokenQty: data.availableTokenQty.toString(),
        openBuyPriceCents: data.openBuyPriceCents?.toFixed(2) ?? 'none',
        tradeEwmaCents: data.tradeEwmaCents.toFixed(2),
      }, true);
      this._recordJournalDecision(data, 'CANCEL', { rejectReason: 'IN_FLIGHT_FILLS' });
      this._emitCancelAnalytics(data, 'IN_FLIGHT_FILLS');
      return [{ type: 'CANCEL' }];
    }

    // ── Position transition tracking ────────────────────────────────────────
    // TODO: Replace heuristic entry/exit price tracking with fill-derived
    // weighted average prices. Current logic uses pending order price / EWMA
    // fallback and is not reliable for:
    // - partial fills
    // - multiple fills
    // - price improvement
    // - slippage
    const wasFlat = this._prevPositionQty.eq(0);
    const hasPosition = data.positionQty.gt(0);
    const isFlat = !hasPosition;

    if (wasFlat && hasPosition) {
      this._entryPriceCents = this._pendingEntryPriceCents ?? data.tradeEwmaCents;
      this._pendingEntryPriceCents = null;
      // Инициализируем peak-state в момент входа
      this._peakPriceCents = data.tradeEwmaCents;
      this._peakNetExpectedEdgeCents = data.netExpectedEdgeCents;
      this._peakResidualMagnitudeBps = data.residualMagnitudeBps;
      this._trailingStopCents = null;
    } else if (!wasFlat && isFlat) {
      this._lastExitPriceCents = data.tradeEwmaCents;
      this._entryPriceCents = null;
      this._pendingEntryPriceCents = null;
      // Сбрасываем peak-state при выходе из позиции
      this._peakPriceCents = null;
      this._peakNetExpectedEdgeCents = null;
      this._peakResidualMagnitudeBps = null;
      this._trailingStopCents = null;
    }

    this._prevPositionQty = data.positionQty;

    if (hasPosition) {
      this._updatePositionExtrema(data);
      this._updateTrailingStop(data);
      const exit = this._checkExitSignalFirst(data);
      if (exit) return [exit];

      this._logDiag(data, 'HOLD', {
        reason: 'POSITION_HELD_SIGNAL_FIRST',
        // Почему не выходим (stop levels vs current price)
        stopGuards: {
          hardStopLevel: this._entryPriceCents !== null
            ? (this._entryPriceCents - this._stopLossCents).toFixed(2)
            : 'none',
          trailingStop: this._trailingStopCents?.toFixed(2) ?? 'none',
          ewmaVsEntry: this._entryPriceCents !== null
            ? (data.tradeEwmaCents - this._entryPriceCents).toFixed(2)
            : 'none',
          ewmaVsTrailing: this._trailingStopCents !== null
            ? (data.tradeEwmaCents - this._trailingStopCents).toFixed(2)
            : 'none',
          tauSec: data.tauSec.toFixed(0),
          exitTauSec: this._exitTauSec,
        },
        signalEdge: {
          netExpectedEdgeCents: data.netExpectedEdgeCents.toFixed(2),
          residualBps: data.residualBps.toFixed(2),
          signalPersistenceMs: data.signalPersistenceMs,
          signalStrong: data.signalStrong,
          signalAdverse: data.signalAdverse,
        },
        position: {
          qty: data.positionQty.toString(),
          availableTokenQty: data.availableTokenQty.toString(),
          entryPriceCents: this._entryPriceCents?.toFixed(2) ?? 'none',
          peakPriceCents: this._peakPriceCents?.toFixed(2) ?? 'none',
          pnlFromEntryCents: this._entryPriceCents !== null
            ? (data.tradeEwmaCents - this._entryPriceCents).toFixed(2)
            : 'none',
        },
      });
      this._recordJournalDecision(data, 'HOLD', {
        reason: 'POSITION_HELD_SIGNAL_FIRST',
      });
      return [];
    }

    const entry = this._checkEntrySignalFirst(data);
    if (entry) {
      if (entry.type === 'BUY') this._pendingEntryPriceCents = entry.price;
      return [entry];
    }

    // Существующий BUY-ордер стоит и условия не ухудшились — не трогать
    if (
      data.openBuyPriceCents !== undefined &&
      data.signalFavorable &&
      data.netExpectedEdgeCents >= this._minEdgeCents
    ) {
      return [];
    }

    const blockers = this._entryBlockersSignalFirst(data);

    if (data.openBuyPriceCents === undefined) {
      this._logDiag(data, 'SKIP', { reason: 'NO_ENTRY', blockers });
      this._recordJournalDecision(data, 'SKIP', { rejectReason: 'NO_ENTRY', blockers });
      return [];
    }

    this._logDiag(data, 'CANCEL', {
      reason: 'NO_ENTRY',
      blockers,
      openBuy: {
        priceCents: data.openBuyPriceCents?.toFixed(2) ?? 'none',
        driftFromEwmaCents: data.openBuyPriceCents !== undefined
          ? (data.tradeEwmaCents - data.openBuyPriceCents).toFixed(2)
          : 'none',
      },
      signalEdge: {
        signalFavorable: data.signalFavorable,
        signalStrong: data.signalStrong,
        netExpectedEdgeCents: data.netExpectedEdgeCents.toFixed(2),
        residualBps: data.residualBps.toFixed(2),
      },
    }, true);
    this._recordJournalDecision(data, 'CANCEL', { rejectReason: 'NO_ENTRY', blockers });
    this._emitCancelAnalytics(data, 'NO_ENTRY');
    return [{ type: 'CANCEL' }];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // toIntents() — selective cancel
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Преобразует действия в торговые интенты.
   *
   * @remarks
   * Политика отмены:
   * - `CANCEL` (явный) → CANCEL_ALL (аварийный сброс)
   * - `BUY` с cancelOrderId → CANCEL(orderId) + PLACE (selective reprice)
   * - `BUY` без cancelOrderId → PLACE (новый ордер)
   * - `SELL` → CANCEL_ALL + PLACE SELL (сначала снять BUY, потом продать)
   *
   * TODO: Когда venue поддержит AMEND/REPLACE — заменить CANCEL+PLACE на атомарный amend.
   *
   * @param actions - Список действий
   * @returns Список интентов
   */
  protected toIntents(actions: CexLeadLagAction[]): StrategyIntent[] {
    const intents: StrategyIntent[] = [];

    for (const action of actions) {
      if (action.type === 'CANCEL') {
        // Аварийный полный cancel (stale chainlink, in-flight fills, etc.)
        intents.push({ type: 'CANCEL_ALL' });
        continue;
      }

      if (action.type === 'SELL') {
        // При выходе снимаем все ордера (в т.ч. открытый BUY) перед SELL
        intents.push({ type: 'CANCEL_ALL' });
        intents.push({
          type: 'PLACE',
          side: 'SELL',
          price: Price.of(new Decimal(action.price).div(100)),
          size: Quantity.of(action.size),
        });
        continue;
      }

      if (action.type === 'BUY') {
        // Selective cancel: отменяем только конкретный BUY-ордер при reprice
        if (action.cancelOrderId !== undefined) {
          intents.push({ type: 'CANCEL', orderId: action.cancelOrderId });
        }
        intents.push({
          type: 'PLACE',
          side: 'BUY',
          price: Price.of(new Decimal(action.price).div(100)),
          size: Quantity.of(action.size),
        });
      }
    }

    return intents;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Signal persistence tracking
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Обновляет и возвращает persistence сигнала в ms.
   *
   * @remarks
   * Алгоритм:
   * 1. Сравниваем текущее direction и знак residual с предыдущим тиком.
   * 2. Если совпадают — persistence продолжается.
   * 3. При смене направления или знака — сбрасываем `_signalStartedAtMs`.
   * 4. Для flat — обнуляем persistence полностью.
   *
   * @param direction - Направление сигнала для нашего токена
   * @param residualBps - Знаковый residual (bps) для нашего токена
   * @param nowMs - Текущее время (ms)
   * @returns Persistence в ms (0 для flat или при смене направления)
   */
  private _updateSignalPersistence(
    direction: CryptoSignalDirection,
    residualBps: number,
    nowMs: number,
  ): number {
    const sameDirection =
      direction !== 'flat' &&
      direction === this._lastSignalDirection &&
      Math.sign(residualBps) === Math.sign(this._lastResidualBps || residualBps);

    if (!sameDirection) {
      this._signalStartedAtMs = direction === 'flat' ? null : nowMs;
    }

    this._lastSignalDirection = direction;
    this._lastResidualBps = residualBps;

    if (direction === 'flat' || this._signalStartedAtMs === null) return 0;
    return Math.max(0, nowMs - this._signalStartedAtMs);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Layered stop-loss helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Обновляет пиковые значения позиции на каждом тике.
   *
   * @remarks
   * Вызывается только пока есть открытая позиция. Три поля обновляются
   * монотонно вверх: `_peakPriceCents`, `_peakNetExpectedEdgeCents`,
   * `_peakResidualMagnitudeBps`.
   *
   * @param data - Данные тика
   */
  private _updatePositionExtrema(data: CexLeadLagData): void {
    if (this._peakPriceCents === null || data.tradeEwmaCents > this._peakPriceCents) {
      this._peakPriceCents = data.tradeEwmaCents;
    }
    if (
      this._peakNetExpectedEdgeCents === null ||
      data.netExpectedEdgeCents > this._peakNetExpectedEdgeCents
    ) {
      this._peakNetExpectedEdgeCents = data.netExpectedEdgeCents;
    }
    if (
      this._peakResidualMagnitudeBps === null ||
      data.residualMagnitudeBps > this._peakResidualMagnitudeBps
    ) {
      this._peakResidualMagnitudeBps = data.residualMagnitudeBps;
    }
  }

  /**
   * Вычисляет базовое trailing distance по накопленной прибыли.
   *
   * @remarks
   * Формула: `(peak − entry) × trailingStartMultiplier`, но не ниже
   * `minTrailingDistanceCents`. Значение 0.5 означает: защищаем 50% прибыли.
   *
   * @param peak - Пиковая цена EWMA (¢)
   * @returns Trailing distance (¢) >= minTrailingDistanceCents
   */
  private _baseTrailingDistanceForPrice(peak: number): number {
    if (this._entryPriceCents === null) return this._minTrailingDistanceCents;
    const profitFromEntry = peak - this._entryPriceCents;
    return Math.max(
      this._minTrailingDistanceCents,
      profitFromEntry * this._trailingStartMultiplier,
    );
  }

  /**
   * Вычисляет tau-tightening multiplier для trailing distance.
   *
   * @remarks
   * Алгоритм:
   * - tauSec >= tauTighteningStartSec → multiplier = 1.0 (без tightening)
   * - tauSec < tauTighteningStartSec → линейно до tauTighteningMinMultiplier
   *
   * @param tauSec - Секунды до экспирации
   * @returns Multiplier ∈ [tauTighteningMinMultiplier, 1]
   */
  private _tauTighteningMultiplier(tauSec: number): number {
    if (tauSec >= this._tauTighteningStartSec) return 1;
    const ratio = tauSec / this._tauTighteningStartSec;
    return Math.max(this._tauTighteningMinMultiplier, ratio);
  }

  /**
   * Применяет signal-tightening к trailing distance.
   *
   * @remarks
   * Уменьшает trailing distance при коллапсе сигнала или adverse direction,
   * позволяя стопу подтянуться ближе к цене при ухудшении сигнала.
   *
   * @param trailingDistance - Текущий trailing distance (¢)
   * @param data - Данные тика
   * @returns Уменьшенный или исходный trailing distance (¢)
   */
  private _applySignalTightening(trailingDistance: number, data: CexLeadLagData): number {
    const collapse =
      !data.signalStrong ||
      data.signalPersistenceMs < 150 ||
      data.venueAgreement < 0.5;
    const tighten =
      (this._signalTighteningOnCollapse && collapse) ||
      (this._signalTighteningOnAdverse && data.signalAdverse);
    if (!tighten) return trailingDistance;
    return Math.max(
      this._minTrailingDistanceCents,
      Math.round(trailingDistance * this._signalTighteningMultiplier),
    );
  }

  /**
   * Вычисляет уровень динамического trailing stop (¢).
   *
   * @remarks
   * Алгоритм:
   * 1. Вычислить stop floor = entry − stopLossCents (hard stop).
   * 2. При profitFromEntry >= breakEvenTriggerCents → поднять floor до entry + breakEvenOffsetCents.
   * 3. Если profit ниже порога → вернуть floor (только hard stop, trailing не активирован).
   * 4. Иначе: base distance = `_baseTrailingDistanceForPrice(peak)`.
   * 5. Применить tau-tightening multiplier.
   * 6. Применить signal-tightening если нужно.
   * 7. Вернуть max(stopFloor, peak − trailingDistance).
   *
   * @param data - Данные тика
   * @returns Уровень стопа (¢) или null если entry неизвестен
   */
  private _computeDynamicTrailingStop(data: CexLeadLagData): number | null {
    if (this._entryPriceCents === null) return null;
    if (this._peakPriceCents === null) return null;

    const entry = this._entryPriceCents;
    const peak = this._peakPriceCents;
    const profitFromEntry = peak - entry;

    let stopFloor = entry - this._stopLossCents;
    if (profitFromEntry >= this._breakEvenTriggerCents) {
      stopFloor = entry + this._breakEvenOffsetCents;
    }

    // До достижения break-even — только hard stop floor, trailing не активируется
    if (profitFromEntry < this._breakEvenTriggerCents) {
      return stopFloor;
    }

    let trailingDistance = this._baseTrailingDistanceForPrice(peak);
    const tauMultiplier = this._tauTighteningMultiplier(data.tauSec);
    trailingDistance = Math.max(
      this._minTrailingDistanceCents,
      trailingDistance * tauMultiplier,
    );
    trailingDistance = this._applySignalTightening(trailingDistance, data);

    const trailingStop = peak - trailingDistance;
    return Math.max(stopFloor, trailingStop);
  }

  /**
   * Монотонно обновляет `_trailingStopCents` вверх.
   *
   * @remarks
   * Trailing stop может только подниматься, но не опускаться.
   * При `profitProtectTrailingEnabled = false` — ничего не делает.
   *
   * @param data - Данные тика
   */
  private _updateTrailingStop(data: CexLeadLagData): void {
    if (!this._profitProtectTrailingEnabled) return;
    const computed = this._computeDynamicTrailingStop(data);
    if (computed === null) return;
    if (this._trailingStopCents === null || computed > this._trailingStopCents) {
      this._trailingStopCents = computed;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Venue agreement
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Вычисляет долю CEX-бирж с одинаковым знаком residual относительно Chainlink.
   *
   * @remarks
   * Алгоритм:
   * 1. Для каждой активной биржи вычислить residual = (mid − basis − chainlinkPrice) / chainlinkPrice × 10000 bps.
   * 2. Игнорировать stale (ageMs > _signalStaleMs) и wide-spread биржи.
   * 3. Игнорировать биржи с |residual| < signalThresholdBps (нет значимого lag).
   * 4. Вернуть долю доминирующего знака.
   *
   * Измеряет то, что утверждает гипотеза стратегии:
   * сколько бирж согласованно отстоят от Chainlink в одну сторону,
   * а не внутренний импульс каждой биржи по отдельности.
   *
   * @param snapshot - Снапшот рынка
   * @param chainlinkPrice - Текущая цена Chainlink для вычисления residual
   * @returns Доля согласованных бирж [0..1]
   */
  private _venueAgreementByResidual(
    snapshot: StrategySnapshot,
    chainlinkPrice: number,
  ): number {
    if (chainlinkPrice <= 0) return 0;

    const signs: number[] = [];

    for (const venue of this._venues) {
      const state = snapshot.cryptoVenueState?.get(venue);
      if (!state) continue;
      if (!Number.isFinite(state.mid) || state.mid <= 0) continue;

      const ageMs = snapshot.nowMs - state.lastReceivedTsMs;
      if (ageMs > this._signalStaleMs) continue;

      if (
        this._maxSpreadBps !== undefined &&
        Number.isFinite(state.spreadBps) &&
        state.spreadBps > this._maxSpreadBps
      ) {
        continue;
      }

      const basis = this._basisByVenue?.[venue] ?? 0;
      const adjustedMid = state.mid - basis;
      const residualBps = ((adjustedMid - chainlinkPrice) / chainlinkPrice) * 10_000;

      // Игнорируем биржи, где lag ниже порога шума
      if (Math.abs(residualBps) < this._signalThresholdBps) continue;

      signs.push(Math.sign(residualBps));
    }

    if (signs.length === 0) return 0;

    const up = signs.filter((x) => x > 0).length;
    const down = signs.filter((x) => x < 0).length;

    return Math.max(up, down) / signs.length;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Signal quality and expected move
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Вычисляет ожидаемое движение вероятности от сигнала (¢).
   *
   * @remarks
   * Формула: |residualBps| × sensitivity × quality01
   *
   * Signal quality01 — взвешенная оценка качества сигнала:
   * - 40% strength
   * - 30% confidence
   * - 20% venue agreement
   * - 10% persistence
   *
   * @param args - Параметры сигнала
   * @returns Ожидаемое движение (¢), всегда >= 0
   */
  private _signalExpectedMoveCents(args: {
    residualBps: number;
    probabilitySensitivityCentsPerBps: number;
    signalStrength01: number;
    signalConfidence01: number;
    venueAgreement: number;
    signalPersistenceMs: number;
  }): number {
    const persistence01 = Math.min(1, args.signalPersistenceMs / 1500);

    const quality01 =
      args.signalStrength01 * 0.40 +
      args.signalConfidence01 * 0.30 +
      args.venueAgreement * 0.20 +
      persistence01 * 0.10;

    return (
      Math.abs(args.residualBps) *
      args.probabilitySensitivityCentsPerBps *
      quality01
    );
  }

  /**
   * Вычисляет штраф за исполнение (¢).
   *
   * @remarks
   * Компоненты штрафа:
   * - Широкий спред → +1.5¢ (≥3¢) или +0.75¢ (≥2¢)
   * - Нет данных книги → +1¢
   * - Близко к экспирации: tau ≤ 20с → +2¢, ≤ 40с → +1¢
   * - Stale Chainlink (>2.5s) → +0.5¢
   *
   * @param data - Параметры исполнения
   * @returns Штраф (¢), всегда >= 0
   */
  private _executionPenaltyCents(data: {
    bestBidCents?: number;
    bestAskCents?: number;
    tauSec: number;
    chainlinkAgeMs: number;
  }): number {
    let penalty = 0;

    if (data.bestBidCents !== undefined && data.bestAskCents !== undefined) {
      const spread = data.bestAskCents - data.bestBidCents;
      if (spread >= 3) penalty += 1.5;
      else if (spread >= 2) penalty += 0.75;
    } else {
      penalty += 1;
    }

    if (data.tauSec <= 20) penalty += 2;
    else if (data.tauSec <= 40) penalty += 1;

    if (data.chainlinkAgeMs > 2500) penalty += 0.5;

    return penalty;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Entry logic
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Проверяет условия входа (signal-first).
   *
   * @remarks
   * Гипотеза входа:
   * "Observed lag между CEX consensus и Chainlink должен привести к
   * монетизируемому репрайсу Polymarket, который переживёт штрафы за
   * время, спред, исполнение и adverse selection."
   *
   * Обязательные условия:
   * - tauSec ∈ (exitTauSec + 5, maxEntryTauSec]
   * - inventoryUnits < qMax
   * - signalStrong = true
   * - signalFavorable = true (при requireSignalForEntry)
   * - signalPersistenceMs ≥ 300ms
   * - venueAgreement ≥ 0.66
   * - netExpectedEdgeCents ≥ minEdgeCents
   * - нет cooldown после stop-loss
   * - не chase выше lastExitPrice + maxChaseAboveExitCents
   *
   * @param data - Данные тика
   * @returns BUY-действие или undefined
   */
  private _checkEntrySignalFirst(
    data: CexLeadLagData,
  ): CexLeadLagAction | undefined {
    if (data.tauSec < this._exitTauSec + 5) return undefined;
    if (data.tauSec > this._maxEntryTauSec) return undefined;
    if (data.inventoryUnits >= this._qMax) return undefined;

    if (this._requireSignalForEntry && !data.signalFavorable) return undefined;
    if (!data.signalStrong) return undefined;
    if (data.signalPersistenceMs < this._minSignalPersistenceMs) return undefined;
    if (data.venueAgreement < 0.66) return undefined;
    if (data.netExpectedEdgeCents < this._minEdgeCents) return undefined;

    if (
      this._stopLossCooldownMs > 0 &&
      this._stopLossTriggeredAtMs !== null &&
      data.nowMs - this._stopLossTriggeredAtMs < this._stopLossCooldownMs
    ) {
      return undefined;
    }

    if (
      this._maxChaseAboveExitCents > 0 &&
      this._lastExitPriceCents !== null
    ) {
      const estimatedBid = this._candidateEntryBidPriceSignalFirst(data);
      if (estimatedBid > this._lastExitPriceCents + this._maxChaseAboveExitCents) {
        return undefined;
      }
    }

    const bidPrice = this._candidateEntryBidPriceSignalFirst(data);
    if (bidPrice <= 0) return undefined;

    // Не перебивать существующий ордер если он в пределах порога reprice
    if (
      data.openBuyPriceCents !== undefined &&
      Math.abs(bidPrice - data.openBuyPriceCents) <= this._makerRepriceThresholdCents &&
      data.netExpectedEdgeCents >= this._minEdgeCents
    ) {
      return undefined;
    }

    const buySize = this._buySizeSignalFirst(data);
    if (!buySize) return undefined;

    const cost = buySize.mul(bidPrice).div(100);
    if (data.availableBalance.lt(cost)) return undefined;

    this._logDiag(data, 'BUY', {
      reason: 'SIGNAL_FIRST_ENTRY',
      bid: bidPrice,
      residualBps: data.residualBps.toFixed(2),
      signalPersistenceMs: data.signalPersistenceMs,
      venueAgreement: data.venueAgreement.toFixed(3),
      probabilitySensitivityCentsPerBps: data.probabilitySensitivityCentsPerBps.toFixed(4),
      signalExpectedMoveCents: data.signalExpectedMoveCents.toFixed(2),
      executionPenaltyCents: data.executionPenaltyCents.toFixed(2),
      netExpectedEdgeCents: data.netExpectedEdgeCents.toFixed(2),
      size: buySize.toString(),
    }, true);

    this._recordJournalDecision(data, 'BUY', {
      reason: 'SIGNAL_FIRST_ENTRY',
      bidPrice,
      orderSize: buySize.toString(),
      effectiveSide: data.side,
    });

    // Сохраняем mid в момент выставления BUY-ордера для последующего drift-анализа
    // при снятии ордера (_emitCancelAnalytics) и signal-event tracking.
    this._lastPlacedMidCents = data.tradeEwmaCents;

    // Если делаем selective reprice — записываем cancel старого ордера
    if (data.openBuyOrderId !== undefined && data.openBuyPriceCents !== undefined) {
      this._emitCancelAnalytics(data, 'REPRICE');
    }

    return {
      type: 'BUY',
      price: bidPrice,
      size: buySize,
      // Selective cancel: если уже есть BUY-ордер — отменить именно его
      cancelOrderId: data.openBuyOrderId,
    };
  }

  /**
   * Вычисляет candidate bid-цену для входа (execution-aware).
   *
   * @remarks
   * Алгоритм:
   * 1. Базовая цена = tradeEwmaCents − baseSpreadCents.
   * 2. Если нет taker и есть best ask — cap по bestAsk − 1¢.
   * 3. При высоком edge (>= minEdge + 2) — добавляем +1¢ агрессии.
   *
   * Цена строится от реальной книги, а не от модельного adjustedFairCents.
   *
   * @param data - Данные тика
   * @returns Bid-цена (¢) ∈ [1, 98]
   */
  private _candidateEntryBidPriceSignalFirst(data: CexLeadLagData): number {
    let bidPrice = Math.floor(data.tradeEwmaCents - this._baseSpreadCents);

    if (!this._allowTaker && data.bestAskCents !== undefined) {
      bidPrice = Math.min(bidPrice, Math.floor(data.bestAskCents) - 1);
    }

    if (data.netExpectedEdgeCents >= this._minEdgeCents + 2) {
      bidPrice += 1;
    }

    return Math.floor(clampNumber(bidPrice, 1, 98));
  }

  /**
   * Вычисляет размер BUY-ордера с масштабированием по edge.
   *
   * @remarks
   * Алгоритм:
   * 1. Базовый размер = orderSize.
   * 2. При высоком edge (>= minEdge + 2) → ×1.5.
   * 3. При очень высоком edge (>= minEdge + 4) → ×2.
   * 4. Cap по оставшемуся до maxPositionQty.
   * 5. Проверка ограничений minOrderSize, minOrderValue, availableBalance.
   *
   * TODO: Округление по реальному step size когда он будет доступен
   * через InstrumentConstraints. Текущий toDecimalPlaces(2) — эвристика.
   *
   * @param data - Данные тика
   * @returns Размер ордера или undefined если невозможно
   */
  private _buySizeSignalFirst(
    data: CexLeadLagData,
  ): Decimal | undefined {
    const maxPositionQty = this._orderSize.mul(this._qMax);
    const remainingQty = maxPositionQty.minus(data.positionQty);
    if (remainingQty.lte(0)) return undefined;

    let multiplier = new Decimal(1);
    if (data.netExpectedEdgeCents >= this._minEdgeCents + 2) multiplier = new Decimal(1.5);
    if (data.netExpectedEdgeCents >= this._minEdgeCents + 4) multiplier = new Decimal(2);

    const targetSize = this._orderSize.mul(multiplier);
    const size = Decimal.min(targetSize, remainingQty);

    if (size.lt(data.minOrderSize)) return undefined;

    const bidPrice = this._candidateEntryBidPriceSignalFirst(data);
    const price = new Decimal(bidPrice).div(100);

    const minSizeForValue = data.minOrderValue.gt(0)
      ? data.minOrderValue.div(price)
      : new Decimal(0);

    const effectiveSize = Decimal.max(size, data.minOrderSize, minSizeForValue)
      .toDecimalPlaces(2, Decimal.ROUND_DOWN);

    if (effectiveSize.gt(remainingQty)) return undefined;
    if (effectiveSize.mul(price).gt(data.availableBalance)) return undefined;

    return effectiveSize;
  }

  /**
   * Формирует список блокеров входа для диагностики.
   *
   * @param data - Данные тика
   * @returns Массив строк с причинами блокировки
   */
  private _entryBlockersSignalFirst(data: CexLeadLagData): string[] {
    const blockers: string[] = [];

    if (data.chainlinkStale) blockers.push('stale_chainlink');
    if (data.tauSec < this._exitTauSec + 5) blockers.push('too_close_to_expiry');
    if (data.tauSec > this._maxEntryTauSec) blockers.push('too_early');
    if (data.inventoryUnits >= this._qMax) blockers.push('inventory_limit');

    if (!data.signalStrong) blockers.push('weak_signal');
    if (this._requireSignalForEntry && !data.signalFavorable) blockers.push('not_favorable');
    if (data.signalPersistenceMs < 300) blockers.push('low_persistence');
    if (data.venueAgreement < 0.66) blockers.push('low_venue_agreement');
    if (data.netExpectedEdgeCents < this._minEdgeCents) blockers.push('net_edge_below_threshold');

    if (
      this._stopLossCooldownMs > 0 &&
      this._stopLossTriggeredAtMs !== null &&
      data.nowMs - this._stopLossTriggeredAtMs < this._stopLossCooldownMs
    ) {
      blockers.push('stop_loss_cooldown');
    }

    const bidPrice = this._candidateEntryBidPriceSignalFirst(data);
    if (bidPrice <= 0) blockers.push('invalid_bid');

    const buySize = bidPrice > 0 ? this._buySizeSignalFirst(data) : undefined;
    if (!buySize) blockers.push('size_or_balance_constraint');

    return blockers.length > 0 ? blockers : ['unknown'];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Exit logic
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Проверяет условия выхода (signal-first).
   *
   * @remarks
   * Гипотеза выхода:
   * Удержание позиции обосновано только пока текущи�� EV положительный.
   * Бумажная прибыль сама по себе не основание держать позицию.
   *
   * ### Активные триггеры выхода:
   * - `HARD_STOP` — tradeEwma < entryPrice − stopLossCents
   * - `TRAILING_STOP` — tradeEwma < trailingStopCents
   * - `TAU_EXIT` — tauSec < exitTauSec
   *
   * ### Выключенные триггеры (намеренно):
   * - `ADVERSE_SIGNAL` — закомментирован: позиция держится до stop/tau
   * - `SIGNAL_COLLAPSE` — закомментирован: позиция держится до stop/tau
   * - `NEGATIVE_NET_EDGE` — закомментирован: позиция держится до stop/tau
   *
   * ### SELL_IN_FLIGHT:
   * Если shouldExit=true, но `availableTokenQty=0` — SELL ордер уже выставлен,
   * токены зарезервированы. Стратегия логирует HOLD(SELL_IN_FLIGHT) и ждёт fill.
   *
   * @param data - Данные тика
   * @returns SELL-действие или undefined если выход не нужен
   */
  private _checkExitSignalFirst(
    data: CexLeadLagData,
  ): CexLeadLagAction | undefined {
    const hardStopHit =
      this._stopLossCents > 0 &&
      this._entryPriceCents !== null &&
      data.tradeEwmaCents < this._entryPriceCents - this._stopLossCents;

    const trailingStopHit =
      this._profitProtectTrailingEnabled &&
      this._trailingStopCents !== null &&
      data.tradeEwmaCents < this._trailingStopCents;

    // signalCollapsed / signalAdverse / negativeEdge — выключены намеренно:
    // стратегия удерживает позицию до hard/trailing stop или tau exit.
    // const signalCollapsed = !data.signalStrong || data.signalPersistenceMs < 150 || data.venueAgreement < 0.5;

    const shouldExit =
      hardStopHit ||
      trailingStopHit ||
      // data.signalAdverse ||
      // data.netExpectedEdgeCents <= -this._exitEdgeCents ||
      // signalCollapsed ||
      data.tauSec < this._exitTauSec;

    if (!shouldExit) {
      return undefined;
    }

    // SELL ордер уже выставлен — токены зарезервированы, ждём fill
    if (!data.availableTokenQty.gt(0)) {
      if (data.positionQty.gt(0)) {
        this._logDiag(data, 'HOLD', {
          reason: 'SELL_IN_FLIGHT',
          note: 'Exit condition met but tokens are reserved (SELL order pending fill)',
          positionQty: data.positionQty.toString(),
          availableTokenQty: data.availableTokenQty.toString(),
          exitTrigger: hardStopHit ? 'HARD_STOP' : trailingStopHit ? 'TRAILING_STOP' : 'TAU_EXIT',
          entryPriceCents: this._entryPriceCents?.toFixed(2) ?? 'none',
          trailingStopCents: this._trailingStopCents?.toFixed(2) ?? 'none',
          tradeEwmaCents: data.tradeEwmaCents.toFixed(2),
        });
      }
      return undefined;
    }

    if (!data.positionQty.gt(0)) {
      return undefined;
    }

    const exitReason =
      hardStopHit ? 'HARD_STOP' :
      trailingStopHit ? 'TRAILING_STOP' :
      // data.signalAdverse ? 'ADVERSE_SIGNAL' :
      data.tauSec < this._exitTauSec ? 'TAU_EXIT' :
      // signalCollapsed ? 'SIGNAL_COLLAPSE' :
      'NEGATIVE_NET_EDGE';

    let askPrice = Math.floor(data.tradeEwmaCents - this._exitDiscountCents);

    const emergencyExit =
      exitReason === 'HARD_STOP' ||
      exitReason === 'TRAILING_STOP' ||
      // exitReason === 'ADVERSE_SIGNAL' ||  // закомментировано вместе с ADVERSE_SIGNAL exit
      exitReason === 'TAU_EXIT';

    if (emergencyExit && data.bestBidCents !== undefined) {
      askPrice = Math.max(1, Math.floor(data.bestBidCents - this._emergencyExitSlippageCents));
    } else if (this._allowTaker && data.bestBidCents !== undefined) {
      askPrice = Math.min(askPrice, Math.floor(data.bestBidCents));
    }

    askPrice = Math.floor(clampNumber(askPrice, 1, 99));

    const size = Decimal.min(this._orderSize, data.availableTokenQty)
      .toDecimalPlaces(2, Decimal.ROUND_DOWN);

    if (!size.gt(0)) {
      this._logDiag(data, 'EXIT_SKIP_DUST', {
        availableTokenQty: data.availableTokenQty.toString(),
      });
      return undefined;
    }

    if (hardStopHit) this._stopLossTriggeredAtMs = data.nowMs;

    this._logDiag(data, 'SELL', {
      reason: exitReason,
      ask: askPrice,
      size: size.toString(),
      emergencyExit,
      // Детали триггера выхода
      exitConditions: {
        hardStopHit,
        trailingStopHit,
        tauExit: data.tauSec < this._exitTauSec,
      },
      // Уровни стопов для диагностики
      stopLevels: {
        entryPriceCents: this._entryPriceCents?.toFixed(2) ?? 'none',
        tradeEwmaCents: data.tradeEwmaCents.toFixed(2),
        peakPriceCents: this._peakPriceCents?.toFixed(2) ?? 'none',
        trailingStopCents: this._trailingStopCents?.toFixed(2) ?? 'none',
        hardStopLevelCents: this._entryPriceCents !== null
          ? (this._entryPriceCents - this._stopLossCents).toFixed(2)
          : 'none',
        pnlFromEntryCents: this._entryPriceCents !== null
          ? (data.tradeEwmaCents - this._entryPriceCents).toFixed(2)
          : 'none',
        pnlFromPeakCents: this._peakPriceCents !== null
          ? (data.tradeEwmaCents - this._peakPriceCents).toFixed(2)
          : 'none',
      },
      signalEdge: {
        residualBps: data.residualBps.toFixed(2),
        signalPersistenceMs: data.signalPersistenceMs,
        venueAgreement: data.venueAgreement.toFixed(3),
        signalExpectedMoveCents: data.signalExpectedMoveCents.toFixed(2),
        executionPenaltyCents: data.executionPenaltyCents.toFixed(2),
        netExpectedEdgeCents: data.netExpectedEdgeCents.toFixed(2),
      },
    });

    this._recordJournalDecision(data, 'SELL', {
      reason: exitReason,
      askPrice,
      orderSize: size.toString(),
      effectiveSide: data.side,
    });

    return { type: 'SELL', price: askPrice, size };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Market data helpers
  // ─────────────────────────────────────────────────────────────────────────

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
   * @returns Цена bid (¢) или undefined
   */
  private _bestBidCents(snapshot: StrategySnapshot): number | undefined {
    const value = snapshot.topOfBook?.bestBid?.value().toNumber();
    return value === undefined ? undefined : value * 100;
  }

  /**
   * Возвращает лучший ask из топбука в центах.
   *
   * @param snapshot - Снапшот рынка
   * @returns Цена ask (¢) или undefined
   */
  private _bestAskCents(snapshot: StrategySnapshot): number | undefined {
    const value = snapshot.topOfBook?.bestAsk?.value().toNumber();
    return value === undefined ? undefined : value * 100;
  }

  /**
   * Возвращает цену открытого BUY-ордера в центах, если есть.
   *
   * @param snapshot - Снапшот рынка
   * @returns Цена открытого BUY-ордера (¢) или undefined
   */
  private _openBuyPriceCents(snapshot: StrategySnapshot): number | undefined {
    const order = snapshot.openOrders.find((item) => item.side === 'BUY');
    return order ? order.price.value().toNumber() * 100 : undefined;
  }

  /**
   * Возвращает ID открытого BUY-ордера для selective cancel.
   *
   * @param snapshot - Снапшот рынка
   * @returns OrderId или undefined если нет открытого BUY
   */
  private _openBuyOrderId(snapshot: StrategySnapshot): OrderId | undefined {
    const order = snapshot.openOrders.find((item) => item.side === 'BUY');
    return order?.id;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Logging and diagnostics
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Возвращает состояние CEX-бирж для диагностики.
   *
   * @param snapshot - Снапшот рынка
   * @returns Словарь состояний по venue
   */
  private _venueState(snapshot: StrategySnapshot): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const venue of this._venues) {
      const state = snapshot.cryptoVenueState?.get(venue);
      if (!state) {
        result[venue] = { available: false };
        continue;
      }
      result[venue] = {
        available: true,
        bid: state.bid,
        ask: state.ask,
        mid: state.mid,
        microprice: state.microprice,
        spreadBps: state.spreadBps,
        imbalanceTop: state.imbalanceTop,
        recentTradePressure: state.recentTradePressure,
        bookAgeMs: snapshot.nowMs - state.lastBookTsMs,
        receivedAgeMs: snapshot.nowMs - state.lastReceivedTsMs,
      };
    }
    return result;
  }

  /**
   * Формирует полный state snapshot для journal decisions.
   *
   * @remarks
   * Центральный диагностический блок: signalEdge вместо fair-value метрик.
   *
   * @param data - Данные тика
   * @returns Словарь состояния
   */
  private _decisionState(data: CexLeadLagData): Record<string, unknown> {
    const priceDelta = data.currentPrice - data.targetPrice;
    return {
      tsIso: new Date(data.nowMs).toISOString(),
      side: data.side,
      mode: data.mode,
      book: {
        bestBidCents: data.bestBidCents ?? null,
        bestAskCents: data.bestAskCents ?? null,
        tradeEwmaCents: data.tradeEwmaCents,
        spreadCents: data.bestBidCents !== undefined && data.bestAskCents !== undefined
          ? data.bestAskCents - data.bestBidCents
          : null,
        openBuyPriceCents: data.openBuyPriceCents ?? null,
      },
      // Центральный объект принятия решений — signal edge, не fair value
      signalEdge: {
        residualBps: data.residualBps,
        residualMagnitudeBps: data.residualMagnitudeBps,
        signalPersistenceMs: data.signalPersistenceMs,
        venueAgreement: data.venueAgreement,
        probabilitySensitivityCentsPerBps: data.probabilitySensitivityCentsPerBps,
        signalExpectedMoveCents: data.signalExpectedMoveCents,
        executionPenaltyCents: data.executionPenaltyCents,
        netExpectedEdgeCents: data.netExpectedEdgeCents,
      },
      signal: {
        id: data.signal?.id ?? null,
        direction: data.signal?.direction ?? null,
        tokenDirection: data.signalDirectionForToken,
        value: data.signal?.value ?? null,
        unit: data.signal?.unit ?? null,
        strength: data.signal?.strength ?? null,
        confidence: data.signal?.confidence ?? null,
        stale: data.signal?.stale ?? null,
        ageMs: data.signal ? data.nowMs - data.signal.tsMs : null,
        strong: data.signalStrong,
        favorable: data.signalFavorable,
        adverse: data.signalAdverse,
        components: data.signal?.components ?? {},
      },
      venues: data.venues,
      price: {
        chainlink: data.chainlinkPrice,
        chainlinkTs: new Date(data.chainlinkTimestampMs).toISOString(),
        chainlinkAgeMs: data.chainlinkAgeMs,
        chainlinkStale: data.chainlinkStale,
        strike: data.targetPrice,
        deltaToStrike: priceDelta,
        deltaToStrikeBps: priceDelta / data.targetPrice * 10_000,
      },
      position: {
        entryPriceCents: this._entryPriceCents,
        lastExitCents: this._lastExitPriceCents,
        peakPriceCents: this._peakPriceCents,
        peakNetExpectedEdgeCents: this._peakNetExpectedEdgeCents,
        peakResidualMagnitudeBps: this._peakResidualMagnitudeBps,
        trailingStopCents: this._trailingStopCents,
        qty: data.positionQty.toString(),
        availableTokenQty: data.availableTokenQty.toString(),
        inventoryUnits: data.inventoryUnits,
      },
      constraints: {
        minOrderSize: data.minOrderSize.toString(),
        minOrderValue: data.minOrderValue.toString(),
        availableBalance: data.availableBalance.toString(),
      },
      thresholds: this._decisionThresholds(),
      tauSec: data.tauSec,
    };
  }

  /**
   * Записывает решение в journal.
   *
   * @param data - Данные тика
   * @param action - Тип действия
   * @param extra - Дополнительные поля
   */
  private _recordJournalDecision(
    data: CexLeadLagData,
    action: 'BUY' | 'SELL' | 'CANCEL' | 'HOLD' | 'SKIP',
    extra?: {
      readonly rejectReason?: string;
      readonly blockers?: readonly string[];
      readonly bidPrice?: number;
      readonly askPrice?: number;
      readonly orderSize?: string;
      readonly effectiveSide?: string;
      readonly reason?: string;
    },
  ): void {
    if (action !== 'BUY' && action !== 'SELL' && data.nowMs - this._lastJournalDecisionMs < 5_000) return;
    this._lastJournalDecisionMs = data.nowMs;
    this._journal?.recordDecision({
      marketId: data.marketId,
      strategyId: this.id,
      ts: data.nowMs,
      action,
      state: {
        ...this._decisionState(data),
        reason: extra?.reason,
        blockers: extra?.blockers,
      },
      rejectReason: extra?.rejectReason,
      bidPrice: extra?.bidPrice,
      askPrice: extra?.askPrice,
      orderSize: extra?.orderSize,
      effectiveSide: extra?.effectiveSide,
    });
  }

  /**
   * Отслеживает и записывает переходы состояния сигнала.
   *
   * @remarks
   * Алгоритм:
   * 1. Если сигнал стал favorable (был нет) → SIGNAL_ON, сохраняем snapshot (residual, chainlink, ts).
   * 2. Если сигнал был favorable но перестал (не adverse) → SIGNAL_OFF с gap-метриками:
   *    - `gapClosedBps` = residualAtOn − residualNow: > 0 = Chainlink догнал CEX (сигнал реальный)
   *    - `gapClosedPct` = gapClosedBps / residualAtOn
   *    - `chainlinkMoveUsd` / `chainlinkMoveBps` = движение Chainlink за жизнь сигнала
   *    - `durationMs` = время от ON до OFF
   * 3. Если сигнал стал adverse при открытой позиции → SIGNAL_ADVERSE с теми же gap-метриками.
   * 4. Обновляет `_prevSignalFavorable` / `_prevSignalAdverse` для следующего тика.
   *
   * Вызывается в начале decide() до любых торговых решений.
   *
   * @param data - Данные тика
   */
  private _emitSignalTransitions(data: CexLeadLagData): void {
    if (!this._journal) return;

    const openOrderPriceCents = data.openBuyPriceCents;
    const driftSinceOrderCents =
      openOrderPriceCents !== undefined && this._lastPlacedMidCents !== null
        ? data.tradeEwmaCents - this._lastPlacedMidCents
        : undefined;

    const base = {
      marketId: data.marketId,
      ts: data.nowMs,
      direction: data.signalDirectionForToken as 'up' | 'down' | 'flat',
      residualBps: data.residualBps,
      signalStrength: data.signal?.strength ?? 0,
      signalConfidence: data.signal?.confidence ?? 0,
      persistenceMs: data.signalPersistenceMs,
      midCents: data.tradeEwmaCents,
      chainlinkPrice: data.chainlinkPrice,
      netExpectedEdgeCents: data.netExpectedEdgeCents,
      openOrderPriceCents,
      driftSinceOrderCents,
    };

    if (!this._prevSignalFavorable && data.signalFavorable) {
      // Сохраняем snapshot SIGNAL_ON для последующего gap-анализа в SIGNAL_OFF
      this._signalOnResidualBps = Math.abs(data.residualBps);
      this._signalOnChainlinkPrice = data.chainlinkPrice;
      this._signalOnTs = data.nowMs;
      this._journal.recordSignalEvent({ ...base, event: 'SIGNAL_ON' });

    } else if (this._prevSignalFavorable && !data.signalFavorable && !data.signalAdverse) {
      this._journal.recordSignalEvent({
        ...base,
        event: 'SIGNAL_OFF',
        ...this._buildGapMetrics(data),
      });
      // Сбрасываем snapshot после закрытия сигнала
      this._signalOnResidualBps = null;
      this._signalOnChainlinkPrice = null;
      this._signalOnTs = null;
    }

    if (!this._prevSignalAdverse && data.signalAdverse && data.positionQty.gt(0)) {
      this._journal.recordSignalEvent({
        ...base,
        event: 'SIGNAL_ADVERSE',
        ...this._buildGapMetrics(data),
      });
    }

    this._prevSignalFavorable = data.signalFavorable;
    this._prevSignalAdverse = data.signalAdverse;
  }

  /**
   * Вычисляет gap-метрики для SIGNAL_OFF / SIGNAL_ADVERSE.
   *
   * @remarks
   * Показывает насколько Chainlink реально двинулся к CEX за время жизни сигнала.
   * Используется для оценки качества сигнала: был ли он реальным lead-lag или шумом.
   *
   * Алгоритм:
   * 1. `gapClosedBps` = residualAtOn − |residualNow|:
   *    - > 0: Chainlink закрыл часть gap (сигнал реальный)
   *    - < 0: gap расширился (ложный сигнал или разворот)
   * 2. `gapClosedPct` = gapClosedBps / residualAtOn (0..1 = частичное/полное закрытие)
   * 3. `chainlinkMoveUsd` = chainlinkNow − chainlinkAtOn
   * 4. `chainlinkMoveBps` = нормировано на начальную Chainlink-цену
   * 5. `durationMs` = ts_now − ts_on
   *
   * @param data - Данные текущего тика
   * @returns Объект с gap-метриками, или пустой объект если нет snapshot SIGNAL_ON
   */
  private _buildGapMetrics(
    data: CexLeadLagData,
  ): {
    residualAtOn?: number;
    chainlinkAtOn?: number;
    gapClosedBps?: number;
    gapClosedPct?: number;
    chainlinkMoveUsd?: number;
    chainlinkMoveBps?: number;
    durationMs?: number;
  } {
    if (
      this._signalOnResidualBps === null ||
      this._signalOnChainlinkPrice === null ||
      this._signalOnTs === null
    ) {
      return {};
    }

    const residualNow = Math.abs(data.residualBps);
    const gapClosedBps = this._signalOnResidualBps - residualNow;
    const gapClosedPct = this._signalOnResidualBps > 0
      ? gapClosedBps / this._signalOnResidualBps
      : 0;
    const chainlinkMoveUsd = data.chainlinkPrice - this._signalOnChainlinkPrice;
    const chainlinkMoveBps = this._signalOnChainlinkPrice > 0
      ? (chainlinkMoveUsd / this._signalOnChainlinkPrice) * 10_000
      : 0;

    return {
      residualAtOn: this._signalOnResidualBps,
      chainlinkAtOn: this._signalOnChainlinkPrice,
      gapClosedBps,
      gapClosedPct,
      chainlinkMoveUsd,
      chainlinkMoveBps,
      durationMs: data.nowMs - this._signalOnTs,
    };
  }

  /**
   * Записывает снятие открытого BUY-ордера с контекстом drift.
   *
   * @remarks
   * Вызывается перед каждым `return [{ type: 'CANCEL' }]` в decide()
   * если на момент снятия есть открытый BUY-ордер.
   *
   * @param data - Данные тика
   * @param reason - Причина снятия (STALE_CHAINLINK, NO_ENTRY, IN_FLIGHT_FILLS)
   */
  private _emitCancelAnalytics(data: CexLeadLagData, reason: string): void {
    if (!this._journal || data.openBuyOrderId === undefined || data.openBuyPriceCents === undefined) {
      return;
    }

    const midAtPlacement = this._lastPlacedMidCents ?? data.openBuyPriceCents;
    const signalAtCancel: 'favorable' | 'adverse' | 'flat' | 'stale' =
      data.chainlinkStale ? 'stale' :
      data.signalFavorable ? 'favorable' :
      data.signalAdverse ? 'adverse' : 'flat';

    this._journal.recordCancel({
      marketId: data.marketId,
      ts: data.nowMs,
      orderId: String(data.openBuyOrderId),
      reason,
      orderPriceCents: data.openBuyPriceCents,
      midAtPlacementCents: midAtPlacement,
      midAtCancelCents: data.tradeEwmaCents,
      driftCents: data.tradeEwmaCents - midAtPlacement,
      signalAtCancel,
      netEdgeAtCancel: data.netExpectedEdgeCents,
    });
  }

  /**
   * Возвращает ключевые пороги для диагностики.
   *
   * @returns Словарь порогов
   */
  private _decisionThresholds(): Record<string, unknown> {
    return {
      requireSignalForEntry: this._requireSignalForEntry,
      minSignalStrength: this._minSignalStrength,
      minSignalConfidence: this._minSignalConfidence,
      minEdgeCents: this._minEdgeCents,
      exitEdgeCents: this._exitEdgeCents,
      qMax: this._qMax,
      orderSize: this._orderSize.toString(),
      allowTaker: this._allowTaker,
      exitTauSec: this._exitTauSec,
      maxEntryTauSec: this._maxEntryTauSec,
      stopLossCents: this._stopLossCents,
      stopLossCooldownMs: this._stopLossCooldownMs,
      emergencyExitSlippageCents: this._emergencyExitSlippageCents,
      chainlinkStaleMs: this._chainlinkStaleMs,
      profitProtectTrailingEnabled: this._profitProtectTrailingEnabled,
      breakEvenTriggerCents: this._breakEvenTriggerCents,
      breakEvenOffsetCents: this._breakEvenOffsetCents,
      trailingStartMultiplier: this._trailingStartMultiplier,
      minTrailingDistanceCents: this._minTrailingDistanceCents,
      tauTighteningStartSec: this._tauTighteningStartSec,
      tauTighteningMinMultiplier: this._tauTighteningMinMultiplier,
      sigmaAnnualNote: 'sensitivity-helper only, not fair value source',
    };
  }

  /**
   * Логирует диагностику тика не чаще чем раз в 5 секунд.
   *
   * @remarks
   * Логи содержат signalEdge-метрики вместо устаревших fair-value метрик
   * (baseFairCents, adjustedFairCents, signalImpactCents).
   *
   * @param data - Данные тика
   * @param action - Метка действия
   * @param extra - Дополнительные поля
   * @param force - Принудительный вывод без throttle
   */
  private _logDiag(
    data: CexLeadLagData,
    action: string,
    extra?: Record<string, unknown>,
    force = false,
  ): void {
    if (!force && data.nowMs - this._lastDiagMs < 5_000) return;
    this._lastDiagMs = data.nowMs;
    const priceDelta = data.currentPrice - data.targetPrice;
    this._logger?.info('CexLeadLag: decision', {
      action,
      ts: new Date(data.nowMs).toISOString(),
      side: data.side,
      book: {
        bestBidCents: data.bestBidCents?.toFixed(2) ?? 'none',
        bestAskCents: data.bestAskCents?.toFixed(2) ?? 'none',
        tradeEwmaCents: data.tradeEwmaCents.toFixed(2),
        spreadCents: data.bestBidCents !== undefined && data.bestAskCents !== undefined
          ? (data.bestAskCents - data.bestBidCents).toFixed(2)
          : 'none',
        openBuyPriceCents: data.openBuyPriceCents?.toFixed(2) ?? 'none',
      },
      // Signal-first edge metrics (replaces baseFairCents / adjustedFairCents)
      signalEdge: {
        residualBps: data.residualBps.toFixed(2),
        signalPersistenceMs: data.signalPersistenceMs,
        venueAgreement: data.venueAgreement.toFixed(3),
        probabilitySensitivityCentsPerBps: data.probabilitySensitivityCentsPerBps.toFixed(4),
        signalExpectedMoveCents: data.signalExpectedMoveCents.toFixed(2),
        executionPenaltyCents: data.executionPenaltyCents.toFixed(2),
        netExpectedEdgeCents: data.netExpectedEdgeCents.toFixed(2),
      },
      signal: {
        id: data.signal?.id ?? 'none',
        direction: data.signal?.direction ?? 'none',
        tokenDirection: data.signalDirectionForToken,
        value: data.signal?.value.toFixed(3) ?? 'none',
        unit: data.signal?.unit ?? 'none',
        strength: data.signal?.strength.toFixed(2) ?? 'none',
        confidence: data.signal?.confidence.toFixed(3) ?? 'none',
        stale: data.signal?.stale ?? 'none',
        ageMs: data.signal ? data.nowMs - data.signal.tsMs : 'none',
        strong: data.signalStrong,
        favorable: data.signalFavorable,
        adverse: data.signalAdverse,
        components: data.signal?.components ?? {},
      },
      price: {
        chainlink: data.chainlinkPrice.toFixed(2),
        chainlinkTs: new Date(data.chainlinkTimestampMs).toISOString(),
        chainlinkAgeMs: data.chainlinkAgeMs,
        chainlinkStale: data.chainlinkStale,
        strike: data.targetPrice.toFixed(2),
        deltaToStrike: priceDelta.toFixed(2),
        deltaToStrikeBps: (priceDelta / data.targetPrice * 10_000).toFixed(3),
      },
      position: {
        entryPriceCents: this._entryPriceCents?.toFixed(0) ?? 'none',
        lastExitCents: this._lastExitPriceCents?.toFixed(0) ?? 'none',
        peakPriceCents: this._peakPriceCents?.toFixed(0) ?? 'none',
        trailingStopCents: this._trailingStopCents?.toFixed(1) ?? 'none',
        qty: data.positionQty.toString(),
        availableTokenQty: data.availableTokenQty.toString(),
        inventoryUnits: data.inventoryUnits.toFixed(2),
      },
      tauSec: data.tauSec.toFixed(0),
      ...extra,
    });
  }
}
