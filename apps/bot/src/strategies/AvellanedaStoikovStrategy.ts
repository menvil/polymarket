/**
 * AvellanedaStoikovStrategy — маркет-мейкерская стратегия на основе модели Avellaneda-Stoikov.
 *
 * @remarks
 * ### Модель
 * Reservation price в logit-пространстве:
 *   `r_x = logit(mid) - (q / qMax) × γ × σ² × τ`
 *
 * Optimal spread в logit-пространстве:
 *   `δ = (γ × σ² × τ + jump) × spreadMult`
 *
 * Bid/Ask:
 *   `bid = sigmoid(r_x - δ/2) × 100` (центы → USDC)
 *   `ask = sigmoid(r_x + δ/2) × 100`
 *
 * ### Калибровка (опциональная)
 * σ (волатильность), jump premium — калиброваны per-minute-bucket.
 * Если длительность рынка не совпадает с калибровочной таблицей —
 * используются дефолтные значения (sigma=0.10, jump=0.02).
 *
 * ### Inventory management
 * - Skew reservation price по текущей позиции: длинная → bid уже, ask шире (хотим продать)
 * - Dynamic Q schedule: qMax уменьшается по фазам (набираем → разгружаем)
 * - На Polymarket нет шортов → позиция ∈ [0, qMax]
 * - SELL только при наличии токенов
 *
 * ### Unwind phase (ключевой механизм)
 * За `unwindSec` секунд до экспирации стратегия переходит в режим разгрузки:
 * - **Новые BUY запрещены** — только продаём оставшийся инвентори
 * - **Ask прогрессивно снижается**: `discount = progress × maxDiscountCents`
 *   где `progress = 1 - tauSec/unwindSec` (0 в начале unwind → 1 у экспирации)
 * - Цель: **выйти из позиции до settlement**, потеря 1-3¢ на агрессивной продаже
 *   лучше чем потеря ~50¢ на settlement DOWN рынка
 * - За `hardStopSec` (5с) — полный STOP, ордера не успеют исполниться
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
 *   unwindSec: 60,
 *   unwindMaxDiscountCents: 3,
 * });
 * as.setMarketDuration(5 * 60 * 1000); // 5 минут
 * ```
 */
import { BaseStrategy } from '@polymarket/strategy';
import type { StrategySnapshot, StrategyIntent, TriggerReason } from '@polymarket/strategy';
import { Price, Quantity } from '@polymarket/value-objects';
import type { ILogger } from '@polymarket/logger';
import type { StrategyId } from '@polymarket/ids';
import { unsafeStrategyId } from '@polymarket/ids';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- внутренний Decimal-конвент apps/bot/strategies/*, см. docs/architecture/boundary-contract.md, Решение 11
import Decimal from 'decimal.js';
import { readFileSync } from 'fs';

// ── Калибровочные таблицы (опциональные) ──────────────────────────────────────
// Рассчитаны на 10M трейдов Polymarket (Oct 2025 – Jan 2026).
// Bucket 0 = последняя минута до экспирации, bucket N = N-я минута от конца.

/** Тип калибровочной таблицы */
interface CalibrationTable {
  readonly sigma: Record<number, number>;
  readonly jump: Record<number, number>;
  readonly maxBucket: number;
}

/**
 * Калибровка для 5-минутных рынков (6 бакетов).
 *
 * @remarks
 * Волатильность в последнюю минуту в 3.8× выше чем за 5 минут до конца.
 */
const CALIBRATION_5M: CalibrationTable = {
  sigma: { 0: 0.35, 1: 0.2345, 2: 0.1391, 3: 0.1122, 4: 0.0990, 5: 0.0921 },
  jump:  { 0: 0.10, 1: 0.074, 2: 0.026, 3: 0.015, 4: 0.012, 5: 0.010 },
  maxBucket: 5,
};

/**
 * Калибровка для 15-минутных рынков (16 бакетов).
 */
const CALIBRATION_15M: CalibrationTable = {
  sigma: {
    0: 0.35, 1: 0.2406, 2: 0.1396, 3: 0.1123, 4: 0.0964, 5: 0.0875,
    6: 0.0740, 7: 0.0678, 8: 0.0633, 9: 0.0582, 10: 0.0539,
    11: 0.0488, 12: 0.0473, 13: 0.0448, 14: 0.0434, 15: 0.0451,
  },
  jump: {
    0: 0.10, 1: 0.0916, 2: 0.0326, 3: 0.0200, 4: 0.0150, 5: 0.0119,
    6: 0.0093, 7: 0.0079, 8: 0.0073, 9: 0.0066, 10: 0.0060,
    11: 0.0053, 12: 0.0054, 13: 0.0052, 14: 0.0054, 15: 0.0061,
  },
  maxBucket: 15,
};

/** Реестр калибровочных таблиц по длительности рынка в минутах */
const CALIBRATION_REGISTRY: ReadonlyMap<number, CalibrationTable> = new Map([
  [5, CALIBRATION_5M],
  [15, CALIBRATION_15M],
]);

/** Допуск в минутах для определения длительности рынка */
const DURATION_TOLERANCE_MIN = 1;

/** Дефолтные значения sigma/jump когда калибровочная таблица не найдена */
const DEFAULT_SIGMA = 0.10;
const DEFAULT_JUMP = 0.02;

/**
 * Подбирает калибровочную таблицу по длительности рынка.
 *
 * @param durationMs - Длительность рынка в миллисекундах
 * @returns Калибровочная таблица или null если нет подходящей (будут использованы дефолты)
 */
function findCalibration(durationMs: number): CalibrationTable | null {
  const durationMin = durationMs / 60_000;
  for (const [nominalMin, table] of CALIBRATION_REGISTRY) {
    if (Math.abs(durationMin - nominalMin) <= DURATION_TOLERANCE_MIN) {
      return table;
    }
  }
  return null;
}

// ── Эмпирическая таблица P(UP | delta%, tau) ──────────────────────────────
// Построена на 938 BTC 5-мин рынках (Chainlink crypto_price vs priceToBeat).
// delta% = (crypto_price - priceToBeat) / priceToBeat × 100
// tau = секунды до resolution

/** Бакеты delta% для lookup */
const CRYPTO_DELTA_BUCKETS = [-0.5, -0.3, -0.2, -0.15, -0.1, -0.05, -0.02, 0, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5];
/** Бакеты tau (секунды) для lookup */
const CRYPTO_TAU_BUCKETS = [30, 60, 90, 120, 150, 180, 210, 240, 270, 300];

/**
 * Встроенная P(UP) таблица: [deltaIdx][tauIdx] = probability (0-1).
 * deltaIdx соответствует CRYPTO_DELTA_BUCKETS, tauIdx — CRYPTO_TAU_BUCKETS.
 */
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

  // Найти ближайший deltaIdx
  let deltaIdx = 0;
  for (let i = 0; i < CRYPTO_DELTA_BUCKETS.length; i++) {
    if (deltaPct <= CRYPTO_DELTA_BUCKETS[i]!) {
      deltaIdx = i;
      break;
    }
    deltaIdx = i;
  }

  // Найти ближайший tauIdx
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
 * Фаза dynamic Q schedule.
 *
 * @param until - Доля прошедшего времени рынка (0..1). Фаза активна пока elapsed/duration < until.
 * @param qMax - Максимальная позиция в этой фазе (в единицах orderSize).
 *
 * @example
 * ```typescript
 * dynamicQ: [
 *   { until: 0.4, qMax: 10 },  // 0–40%: набираем
 *   { until: 0.7, qMax: 5 },   // 40–70%: сбалансировано
 *   { until: 1.0, qMax: 3 },   // 70–100%: разгружаем
 * ]
 * ```
 */
export interface DynamicQPhase {
  readonly until: number;
  readonly qMax: number;
}

/**
 * Параметры AvellanedaStoikovStrategy.
 *
 * @param gamma - Risk aversion parameter (γ). Выше → шире спреды, меньше позиция.
 *   Типичные значения: 0.01 (агрессивный) – 0.20 (консервативный).
 * @param qMax - Максимальная позиция в одну сторону (в единицах orderSize).
 * @param orderSize - Размер одного ордера (bid и ask).
 * @param spreadMult - Множитель спреда (по умолчанию 1.0). >1 = шире спреды.
 * @param skewMult - Множитель inventory skew (по умолчанию 1.0). >1 = агрессивнее продаёт.
 * @param dynamicQ - Фазы уменьшения qMax по времени (опционально).
 * @param unwindSec - Секунды до экспирации для начала агрессивной разгрузки (по умолчанию 60).
 * @param unwindMaxDiscountCents - Максимальный дисконт ask от mid в центах при unwind (по умолчанию 3).
 * @param hardStopSec - Секунды до экспирации для полной остановки (по умолчанию 5).
 * @param ewmaAlpha - Alpha для EWMA mid-price (по умолчанию 0.3).
 * @param minTradesForMid - Минимальное кол-во трейдов для расчёта EWMA (по умолчанию 5).
 */
export interface ASStrategyConfig {
  readonly gamma: Decimal;
  readonly qMax: number;
  readonly orderSize: Decimal;
  readonly spreadMult?: Decimal;
  /** Множитель inventory skew относительно gamma. skewMult=4 → skew_gamma = gamma×4. По умолчанию 1.0. */
  readonly skewMult?: number;
  /**
   * Dynamic Q schedule: уменьшаем qMax по мере приближения к экспирации.
   * Если задан — переопределяет фиксированный qMax на основе доли прошедшего времени.
   */
  readonly dynamicQ?: readonly DynamicQPhase[];
  /**
   * Секунды до экспирации для начала aggressive unwind.
   * В этой фазе: BUY запрещён, ask прогрессивно снижается к/ниже mid.
   * По умолчанию 60 (1 минута).
   */
  readonly unwindSec?: number;
  /**
   * Максимальный дисконт ask от mid (в центах) при полном unwind progress.
   * При progress=0 дисконт=0 (ask = нормальная AS цена), при progress=1 дисконт=maxDiscountCents.
   * По умолчанию 3 (продаём до mid-3¢).
   */
  readonly unwindMaxDiscountCents?: number;
  /**
   * Stop-loss в центах: если mid упал ниже avgEntry на stopLossCents — немедленный dump инвентори.
   * После dump спред расширяется (×2) для более осторожного re-entry.
   * По умолчанию 0 (отключён). Рекомендуемое значение: 3–5.
   *
   * @example
   * ```typescript
   * // Купили по 50¢, mid упал до 46¢ → loss = 4¢ > stopLossCents=3 → dump
   * stopLossCents: 3
   * ```
   */
  readonly stopLossCents?: number;
  /**
   * Множитель спреда после stop-loss dump. Спред шире → re-entry ниже.
   * По умолчанию 2.0.
   */
  readonly stopLossSpreadMult?: number;
  /**
   * Regime detection: определяем trending/ranging по range последних N трейдов.
   *
   * @remarks
   * - Trending рынок (range > trendThreshold): цена быстро двигается → расширяем спред
   *   чтобы не набирать инвентори против тренда (adverse selection protection).
   * - Ranging рынок (range < rangeThreshold): цена стоит на месте → сужаем спред
   *   чтобы стоять ближе к рынку и получать больше fills.
   * - Между порогами: neutral (спред × 1.0).
   *
   * На основе EXP-114 (+1.6%) и EXP-35 price range vol (+8%).
   */
  readonly regimeWindow?: number;
  /** Порог trending режима в центах. range > threshold → trending. По умолчанию 3. */
  readonly regimeTrendThreshold?: number;
  /** Порог ranging режима в центах. range < threshold → ranging. По умолчанию 1. */
  readonly regimeRangeThreshold?: number;
  /** Множитель спреда в trending режиме. По умолчанию 1.5. */
  readonly regimeTrendSpreadMult?: number;
  /** Множитель спреда в ranging режиме. По умолчанию 0.8. */
  readonly regimeRangeSpreadMult?: number;
  /** Warmup: не торгуем первые N секунд рынка — ждём накопления EWMA и regime данных. По умолчанию 0 (отключён). */
  readonly warmupSec?: number;
  /**
   * Jump widen: расширяем спред после резкого скачка цены.
   * Если |price - prevPrice| >= jumpThreshold центов → спред × jumpWidenFactor на jumpCooldownTrades трейдов.
   * По умолчанию 0 (отключён).
   */
  readonly jumpThreshold?: number;
  /** Множитель спреда при jump widen. По умолчанию 2.0. */
  readonly jumpWidenFactor?: number;
  /** Кол-во трейдов cooldown после jump. По умолчанию 5. */
  readonly jumpCooldownTrades?: number;
  /**
   * Profit hold: снижаем inventory skew при нереализованной прибыли.
   * Если ewmaMid - avgEntry > threshold → skew × profitHoldSkewReduction.
   * Не торопимся продавать прибыльную позицию.
   * По умолчанию 0 (отключён).
   */
  readonly profitHoldThreshold?: number;
  /** Множитель skew при прибыльной позиции. По умолчанию 0.5 (вдвое меньше). */
  readonly profitHoldSkewReduction?: number;
  /**
   * Dynamic gamma: увеличиваем gamma пропорционально размеру позиции.
   * effectiveGamma = gamma × (1 + dynGammaSlope × |q| / qMax).
   * Больше позиция → выше risk aversion → шире спред.
   * По умолчанию 0 (отключён, фиксированный gamma).
   */
  readonly dynGammaSlope?: number;
  readonly ewmaAlpha?: number;
  readonly minTradesForMid?: number;

  // ── Market quality filter (warmup gate) ───────────────────────────────────
  /**
   * Мета-адаптация: фильтр качества рынка при выходе из warmup.
   *
   * @remarks
   * После warmup периода оцениваем рынок по метрикам.
   * Решение принимается ОДИН раз (при выходе из warmup) и необратимо для рынка.
   * Для непрерывного контроля условий используйте `conditionCheck*` параметры.
   */

  /**
   * Максимальный price range (волатильность) в центах за warmup.
   * Если range > maxWarmupVolCents → skip market (слишком trending).
   * По умолчанию 0 (отключён).
   */
  readonly maxWarmupVolCents?: number;
  /**
   * Минимальная trade intensity (трейдов в секунду) за warmup.
   * Если trades/warmupSec < minWarmupTradesPerSec → skip market (неликвидный).
   * По умолчанию 0 (отключён).
   */
  readonly minWarmupTradesPerSec?: number;
  /**
   * Максимальный bid-ask spread в центах для входа.
   * Если spread > maxSpreadCents → skip market.
   * По умолчанию 0 (отключён).
   */
  readonly maxSpreadCents?: number;
  /**
   * Максимальный |imbalance| стакана при warmup для входа.
   * Если |imbalance| > maxWarmupImbalance → skip market (слишком однонаправленный).
   * Диапазон 0-1. По умолчанию 0 (отключён).
   */
  readonly maxWarmupImbalance?: number;

  // ── Continuous condition check (торгуем/паузим в реальном времени) ─────────
  /**
   * Непрерывный контроль условий рынка.
   *
   * @remarks
   * В отличие от warmup-фильтра (одноразовый, необратимый skip),
   * condition check работает **каждый тик**:
   * - Условия ОК → торгуем (нормальный AS quoting)
   * - Условия нарушены → ПАУЗА (снимаем ордера, ждём)
   * - Условия восстановились → снова торгуем
   *
   * Это позволяет «отсиживаться» когда рынок опасен (начало рынка = каша,
   * внезапный тренд, сужение ликвидности) и возвращаться когда стабилизируется.
   */

  /**
   * Максимальный spread в центах для торговли (continuous).
   * Если spread > conditionCheckSpreadCents → пауза.
   * По умолчанию 0 (отключён).
   */
  readonly conditionCheckSpreadCents?: number;
  /**
   * Максимальный price range (волатильность) последних N трейдов в центах (continuous).
   * Если range > conditionCheckVolCents → пауза.
   * По умолчанию 0 (отключён).
   */
  readonly conditionCheckVolCents?: number;
  /**
   * Минимальная глубина стакана (top-3 bid+ask суммарно) для торговли.
   * Если topDepth < conditionCheckMinDepth → пауза (книга слишком тонкая).
   * По умолчанию 0 (отключён).
   */
  readonly conditionCheckMinDepth?: number;
  /**
   * Пропускать первые N секунд рынка (cooldown начальной каши).
   * Отличается от warmupSec: warmup копит EWMA данные,
   * cooldown — это чистое ожидание стабилизации.
   * По умолчанию 0 (отключён). Рекомендуемое: 30-60с.
   */
  readonly conditionCheckCooldownSec?: number;

  // ── Adaptive regime (continuous parameter scaling) ────────────────────────
  /**
   * Адаптивный режим: плавное масштабирование параметров по состоянию рынка.
   *
   * @remarks
   * Вычисляется «comfort score» 0..1 на основе текущих метрик рынка:
   * - volatility (price range) → низкая = комфортно
   * - book depth → глубокий = комфортно
   * - book imbalance → сбалансированный = комфортно
   * - trade flow → высокий = комфортно
   *
   * Score масштабирует:
   * - **gamma**: `effectiveGamma *= 1 + adaptiveScale × (1 - score)`
   *   (некомфортно → выше risk aversion → шире спред)
   * - **orderSize**: `effectiveOrderSize *= score_clamped`
   *   (некомфортно → меньше ставка)
   *
   * В отличие от бинарных фильтров, это **плавная** адаптация.
   * По умолчанию 0 (отключён).
   */
  readonly adaptiveScale?: number;
  /**
   * Минимальная доля orderSize при адаптивном масштабировании.
   * Не даёт orderSize упасть ниже minOrderSize × orderSize.
   * По умолчанию 0.2 (20% от базового).
   */
  readonly adaptiveMinOrderRatio?: number;

  // ── Runtime: book-aware adjustments ────────────────────────────────────────

  /**
   * Imbalance spread factor: расширяем спред пропорционально перекосу стакана.
   * `spreadMult *= (1 + imbalanceSpreadFactor × |imbalance|)`
   * Перекошенный стакан = больший риск adverse selection → шире спред.
   * По умолчанию 0 (отключён).
   */
  readonly imbalanceSpreadFactor?: number;
  /**
   * Depth spread factor: расширяем спред при тонком стакане.
   * `spreadMult *= (1 + depthSpreadFactor / max(topDepth, minDepth))`
   * Тонкий стакан = мало ликвидности = больше slippage risk.
   * По умолчанию 0 (отключён).
   */
  readonly depthSpreadFactor?: number;
  /**
   * OFI (Order Flow Imbalance): смещаем EWMA mid в сторону давления покупателей.
   * Больше upticks → mid вверх → bid/ask вверх (торгуем «с потоком»).
   * ofiWindow: кол-во последних трейдов для OFI. По умолчанию 0 (отключён).
   * ofiWeight: макс. смещение mid в центах. По умолчанию 1.0.
   */
  readonly ofiWindow?: number;
  readonly ofiWeight?: number;

  // ── Anti-adverse-selection ──────────────────────────────────────────────────

  /**
   * Порог последовательных тиков для отмены уязвимой стороны.
   * N upticks подряд → cancel ask (покупатели агрессивны, наш ask будет picked off).
   * N downticks подряд → cancel bid (продавцы агрессивны).
   * По умолчанию 0 (отключён).
   */
  readonly aasConsecutiveThreshold?: number;

  /**
   * OFI-порог для односторонней котировки.
   * OFI > (1 - ofiSkipThreshold) → skip ask (сильный buy pressure).
   * OFI < ofiSkipThreshold → skip bid (сильный sell pressure).
   * По умолчанию 0 (отключён). Рекомендуемые значения: 0.15-0.3.
   */
  readonly ofiSkipThreshold?: number;

  // ── Trailing stop (гибрид MM + momentum) ────────────────────────────────

  /**
   * Базовая дистанция trailing stop в центах. 0 = отключён.
   * Когда у нас позиция > 0: отслеживаем пик цены, stop = peak - trail.
   * При срабатывании стопа — агрессивная продажа.
   */
  readonly trailDistanceCents?: number;
  /**
   * Зона уверенности (в центах). Когда mid выше этого порога — trail расширяется.
   * По умолчанию 75.
   */
  readonly trailWideZoneCents?: number;
  /**
   * Узкий trailing stop при просадке (цена ниже entry).
   * Быстро режем потери когда рынок идёт против нас.
   * По умолчанию = trailDistanceCents (симметричный).
   */
  readonly trailTightCents?: number;
  /**
   * Расширенная дистанция trailing stop в зоне уверенности.
   * По умолчанию trailDistanceCents × 2.
   */
  readonly trailWideDistanceCents?: number;
  /**
   * Зона settlement (в центах). Mid выше этого → держим до settlement, не продаём.
   * По умолчанию 90.
   */
  readonly trailHoldZoneCents?: number;
  /**
   * Минимальная цена mid для выставления bid (не покупаем дешёвое). По умолчанию 0.
   */
  readonly minBidZoneCents?: number;
  /**
   * Максимальная цена mid для выставления bid (не покупаем дорогое). По умолчанию 100.
   */
  readonly maxBidZoneCents?: number;

  // ── Probability table (edge filter) ──────────────────────────────────────────
  /**
   * Путь к JSON файлу с эмпирической таблицей P(UP | price_bucket, tau_bucket).
   * Формат: { table: [{ priceBucket, tauBucket, pUp, fairValueCents, total }] }
   * По умолчанию undefined (отключён).
   */
  readonly probTablePath?: string;
  /**
   * Минимальный edge (fairValue - bidPrice) в центах для разрешения BUY.
   * По умолчанию 5.
   */
  readonly probTableMinEdge?: number;
  /**
   * Минимальное количество наблюдений в бакете для доверия таблице.
   * По умолчанию 100.
   */
  readonly probTableMinN?: number;
  /**
   * Режим работы probability table:
   * - 'veto': блокирует bid если edge < minEdge (bid=0)
   * - 'shift': сдвигает bid вниз до fairValue - minEdge
   * По умолчанию 'veto'.
   */
  readonly probTableMode?: 'veto' | 'shift';

  // ── Crypto-informed trading (entry + exit по реальной цене BTC) ──────────
  /**
   * Порог P(UP) для выхода из позиции.
   * Если P(UP | cryptoDelta%, tau) < threshold → агрессивная продажа.
   * По умолчанию 0 (отключён). Рекомендуемое: 30-40.
   */
  readonly cryptoExitProbThreshold?: number;
  /**
   * Дисконт в центах при crypto exit (продаём агрессивнее).
   * ask = mid - discountCents. По умолчанию 1.
   */
  readonly cryptoExitDiscountCents?: number;
  /**
   * Минимальный edge в центах для входа (crypto-informed entry).
   * Покупаем только если P(UP)*100 - bidPrice >= cryptoEntryMinEdge.
   * Например: P(UP)=65%, bid=60¢, edge=5¢ >= minEdge=3 → покупаем.
   * По умолчанию 0 (отключён — обычный AS entry). Рекомендуемое: 2-5.
   */
  readonly cryptoEntryMinEdge?: number;
  /**
   * Минимальная P(UP) для входа (crypto-informed entry).
   * Покупаем только если P(UP) >= cryptoEntryMinProb / 100.
   * Например: cryptoEntryMinProb=60 → покупаем только если P(UP) >= 60%.
   * По умолчанию 0 (отключён). Рекомендуемое: 55-65.
   */
  readonly cryptoEntryMinProb?: number;

  // ── Dynamic sizing по цене ──────────────────────────────────────────────────
  /**
   * Dynamic sizing: масштабируем orderSize в зависимости от цены (вероятности).
   *
   * @remarks
   * Формула BUY: `bidSize = orderSize × (mid / 50) ^ dynSizeAlpha`
   * - mid=70 (UP вероятен) → size × 1.4 (при alpha=1.0)
   * - mid=30 (DOWN вероятен) → size × 0.6
   * - mid=50 → size × 1.0 (нейтрально)
   *
   * Формула SELL: `askSize = orderSize × ((100 - mid) / 50) ^ dynSizeAlpha`
   * - Зеркально: чем дороже токен, тем больше готовы продать.
   *
   * По умолчанию 0 (отключён, фиксированный orderSize).
   */
  readonly dynSizeAlpha?: number;
  /**
   * Минимальный множитель dynamic sizing. Не даём orderSize упасть ниже этой доли.
   * По умолчанию 0.3 (30% от базового).
   */
  readonly dynSizeMinRatio?: number;
  /**
   * Максимальный множитель dynamic sizing. Не даём orderSize вырасти выше этой доли.
   * По умолчанию 2.0 (200% от базового).
   */
  readonly dynSizeMaxRatio?: number;
}

// ── Типы gather/decide ──────────────────────────────────────────────────────

/** Данные, извлечённые из snapshot для принятия решений */
interface ASData {
  /** EWMA mid-price из trade tape (в центах, 0–100) */
  readonly ewmaMid: number;
  /** Текущая позиция в единицах orderSize (≥0, шортов нет) */
  readonly inventoryUnits: number;
  /** Секунды до экспирации */
  readonly tauSec: number;
  /** Минутный бакет (tauSec / 60) */
  readonly minuteBucket: number;
  /** Доступный баланс USDC */
  readonly availableBalance: Decimal;
  /** Общая позиция в токенах (для inventory skew) */
  readonly positionQty: Decimal;
  /** Доступные для продажи токены (positionQty - reserved) */
  readonly availableTokenQty: Decimal;
  /** Есть ли in-flight fills */
  readonly hasInFlightFills: boolean;
  /** Текущее время (nowMs из snapshot) */
  readonly nowMs: number;
  /** Средняя цена входа в центах (0 если нет позиции) */
  readonly avgEntryPriceCents: number;
  /** Price range последних N трейдов в центах (max - min). Для regime detection. */
  readonly priceRangeCents: number;
  /** Jump widen активен (скачок цены → спред расширен). */
  readonly jumpWidenActive: boolean;
  /** Book imbalance [-1, +1]: >0 = bid-heavy, <0 = ask-heavy */
  readonly bookImbalance: number;
  /** Суммарная глубина top-3 уровней стакана (bid + ask) */
  readonly topDepth: number;
  /** OFI: доля upticks в последних N трейдах (0-1, 0.5 = нейтральный) */
  readonly ofi: number;
  /** Continuous condition check: условия не выполнены → пауза (STOP) */
  readonly conditionsPaused: boolean;
  /** Comfort score 0..1: 1 = идеальные условия, 0 = максимально некомфортно */
  readonly comfortScore: number;
  /** Кол-во последовательных upticks (для AAS) */
  readonly consecutiveUpticks: number;
  /** Кол-во последовательных downticks (для AAS) */
  readonly consecutiveDownticks: number;
  /** Минимальный размер ордера */
  readonly minOrderSize: Decimal | undefined;
  /** Минимальная стоимость ордера (price × size >= minOrderValue) */
  readonly minOrderValue: Decimal | undefined;
  /** P(UP) по crypto_price vs priceToBeat и tau. undefined = нет данных. */
  readonly cryptoProbUp: number | undefined;
}

/** Действие стратегии: разместить bid, ask, или обе стороны */
type ASAction =
  | { readonly type: 'QUOTE'; readonly bid: number; readonly ask: number; readonly bidSize: Decimal; readonly askSize: Decimal }
  | { readonly type: 'STOP' };

// ── Реализация ──────────────────────────────────────────────────────────────

export class AvellanedaStoikovStrategy extends BaseStrategy<ASData, ASAction> {
  public readonly id: StrategyId;
  public readonly name = 'AvellanedaStoikovStrategy';

  private readonly _config: ASStrategyConfig;
  private readonly _logger: ILogger | undefined;
  private readonly _gamma: number;
  private readonly _qMax: number;
  private readonly _spreadMult: number;
  private readonly _skewMult: number;
  private readonly _dynamicQ: readonly DynamicQPhase[] | undefined;
  private readonly _unwindSec: number;
  private readonly _unwindMaxDiscountCents: number;
  private readonly _stopLossCents: number;
  private readonly _stopLossSpreadMult: number;
  private readonly _ewmaAlpha: number;
  private readonly _minTradesForMid: number;
  private readonly _regimeWindow: number;
  private readonly _regimeTrendThreshold: number;
  private readonly _regimeRangeThreshold: number;
  private readonly _regimeTrendSpreadMult: number;
  private readonly _regimeRangeSpreadMult: number;
  private readonly _warmupSec: number;
  private readonly _jumpThreshold: number;
  private readonly _jumpWidenFactor: number;
  private readonly _jumpCooldownTrades: number;
  private readonly _profitHoldThreshold: number;
  private readonly _profitHoldSkewReduction: number;
  private readonly _dynGammaSlope: number;

  /**
   * Калибровочная таблица для текущего рынка (null = используем дефолты).
   * undefined = ещё не определена (первый тик).
   */
  private _calibration: CalibrationTable | null | undefined = undefined;
  /** expirationMs рынка для которого определена калибровка (сброс при смене рынка) */
  private _calibratedMarketExpirationMs = 0;
  /** eventStartMs текущего рынка (для dynamic Q и unwind timing) */
  private _marketEventStartMs = 0;
  /** Длительность рынка в ms */
  private _marketDurationMs = 0;

  /** EWMA mid-price (в центах, 0–100). Обновляется при каждом tick. */
  private _ewma: number | null = null;
  /** Количество трейдов, обработанных для EWMA */
  private _tradeCount = 0;
  /** Timestamp последнего трейда для EWMA (инкрементальное обновление) */
  private _lastTradeTimestampMs = 0;

  /**
   * Режим "пост-стоплосс": после dump инвентори, спред расширен для осторожного re-entry.
   * Сбрасывается когда позиция = 0 (чистый re-entry) или при смене рынка.
   */
  private _stopLossTriggered = false;

  /** Jump widen: оставшееся кол-во трейдов с расширенным спредом */
  private _jumpWidenRemaining = 0;
  /** Предыдущая цена трейда (для детекции скачков) */
  private _prevTradePrice: number | null = null;

  // ── Market quality filter state ────────────────────────────────────────────
  /** Рынок не прошёл фильтр качества → пропускаем все тики */
  private _skipMarket = false;
  /** Фильтр качества уже был применён для текущего рынка */
  private _marketQualityChecked = false;
  /** Config: max vol */
  private readonly _maxWarmupVolCents: number;
  /** Config: min trade intensity */
  private readonly _minWarmupTradesPerSec: number;
  /** Config: max spread */
  private readonly _maxSpreadCents: number;
  /** Config: max warmup imbalance */
  private readonly _maxWarmupImbalance: number;
  /** Config: imbalance → spread multiplier */
  private readonly _imbalanceSpreadFactor: number;
  /** Config: depth → spread multiplier */
  private readonly _depthSpreadFactor: number;
  /** Config: OFI window (trades) */
  private readonly _ofiWindow: number;
  /** Config: OFI weight (cents) */
  private readonly _ofiWeight: number;

  // ── Continuous condition check ──────────────────────────────────────────────
  private readonly _conditionCheckSpreadCents: number;
  private readonly _conditionCheckVolCents: number;
  private readonly _conditionCheckMinDepth: number;
  private readonly _conditionCheckCooldownSec: number;
  /** Текущее состояние: true = условия ОК, торгуем; false = пауза */
  private _conditionsOk = true;
  /** Кол-во тиков подряд в паузе (для логирования, не спамим каждый тик) */
  private _pauseTicks = 0;

  // ── Adaptive regime ──────────────────────────────────────────────────────
  private readonly _adaptiveScale: number;
  private readonly _adaptiveMinOrderRatio: number;

  // ── Anti-adverse-selection ─────────────────────────────────────────────
  private readonly _aasConsecutiveThreshold: number;
  private readonly _ofiSkipThreshold: number;

  // ── Trailing stop ─────────────────────────────────────────────────────
  private readonly _trailDistanceCents: number;
  private readonly _trailWideZoneCents: number;
  private readonly _trailWideDistanceCents: number;
  private readonly _trailHoldZoneCents: number;
  private readonly _minBidZoneCents: number;
  private readonly _maxBidZoneCents: number;
  private readonly _trailTightCents: number;
  private readonly _dynSizeAlpha: number;
  private readonly _dynSizeMinRatio: number;
  private readonly _dynSizeMaxRatio: number;

  // ── Crypto-informed trading ───────────────────────────────────────────────
  private readonly _cryptoExitProbThreshold: number;
  private readonly _cryptoExitDiscountCents: number;
  private readonly _cryptoEntryMinEdge: number;
  private readonly _cryptoEntryMinProb: number;

  // ── Probability table ──────────────────────────────────────────────────────
  /** Загруженная таблица: key = "priceBucket:tauBucket" → { fairValueCents, total } */
  private readonly _probTable: Map<string, { fairValueCents: number; total: number }> | null;
  private readonly _probTableMinEdge: number;
  private readonly _probTableMinN: number;
  private readonly _probTableMode: 'veto' | 'shift';
  private readonly _probTableBucketPrice: number;
  private readonly _probTableBucketTau: number;

  /** Пик цены с момента открытия позиции */
  private _trailPeakCents = 0;
  /** Цена входа для trailing (средняя цена покупки) */
  private _trailEntryCents = 0;
  /** Trail stop SELL выставлен, но ещё не исполнен — блокируем BUY */
  private _trailStopPending = false;
  /** Crypto exit сработал → блокируем BUY до конца рынка */
  private _cryptoExitTriggered = false;

  /**
   * @param config - Параметры AS-стратегии
   * @param strategyId - Уникальный ID экземпляра (по умолчанию 'as-mm-1')
   * @param logger - Логгер для диагностики
   */
  constructor(config: ASStrategyConfig, strategyId: StrategyId = unsafeStrategyId('as-mm-1'), logger?: ILogger) {
    super();
    this._config = config;
    this.id = strategyId;
    this._logger = logger;
    this._gamma = config.gamma.toNumber();
    this._qMax = config.qMax;
    this._spreadMult = config.spreadMult?.toNumber() ?? 1.0;
    this._skewMult = config.skewMult ?? 1.0;
    this._dynamicQ = config.dynamicQ;
    this._unwindSec = config.unwindSec ?? 60;
    this._unwindMaxDiscountCents = config.unwindMaxDiscountCents ?? 3;
    this._stopLossCents = config.stopLossCents ?? 0;
    this._stopLossSpreadMult = config.stopLossSpreadMult ?? 2.0;
    this._ewmaAlpha = config.ewmaAlpha ?? 0.3;
    this._minTradesForMid = config.minTradesForMid ?? 5;
    this._regimeWindow = config.regimeWindow ?? 20;
    this._regimeTrendThreshold = config.regimeTrendThreshold ?? 3;
    this._regimeRangeThreshold = config.regimeRangeThreshold ?? 1;
    this._regimeTrendSpreadMult = config.regimeTrendSpreadMult ?? 1.5;
    this._regimeRangeSpreadMult = config.regimeRangeSpreadMult ?? 0.8;
    this._warmupSec = config.warmupSec ?? 0;
    this._jumpThreshold = config.jumpThreshold ?? 0;
    this._jumpWidenFactor = config.jumpWidenFactor ?? 2.0;
    this._jumpCooldownTrades = config.jumpCooldownTrades ?? 5;
    this._profitHoldThreshold = config.profitHoldThreshold ?? 0;
    this._profitHoldSkewReduction = config.profitHoldSkewReduction ?? 0.5;
    this._dynGammaSlope = config.dynGammaSlope ?? 0;
    this._maxWarmupVolCents = config.maxWarmupVolCents ?? 0;
    this._minWarmupTradesPerSec = config.minWarmupTradesPerSec ?? 0;
    this._maxSpreadCents = config.maxSpreadCents ?? 0;
    this._maxWarmupImbalance = config.maxWarmupImbalance ?? 0;
    this._imbalanceSpreadFactor = config.imbalanceSpreadFactor ?? 0;
    this._depthSpreadFactor = config.depthSpreadFactor ?? 0;
    this._ofiWindow = config.ofiWindow ?? 0;
    this._ofiWeight = config.ofiWeight ?? 1.0;
    this._conditionCheckSpreadCents = config.conditionCheckSpreadCents ?? 0;
    this._conditionCheckVolCents = config.conditionCheckVolCents ?? 0;
    this._conditionCheckMinDepth = config.conditionCheckMinDepth ?? 0;
    this._conditionCheckCooldownSec = config.conditionCheckCooldownSec ?? 0;
    this._adaptiveScale = config.adaptiveScale ?? 0;
    this._adaptiveMinOrderRatio = config.adaptiveMinOrderRatio ?? 0.2;
    this._aasConsecutiveThreshold = config.aasConsecutiveThreshold ?? 0;
    this._ofiSkipThreshold = config.ofiSkipThreshold ?? 0;
    this._trailDistanceCents = config.trailDistanceCents ?? 0;
    this._trailWideZoneCents = config.trailWideZoneCents ?? 75;
    this._trailTightCents = config.trailTightCents ?? this._trailDistanceCents;
    this._trailWideDistanceCents = config.trailWideDistanceCents ?? (this._trailDistanceCents * 2);
    this._trailHoldZoneCents = config.trailHoldZoneCents ?? 90;
    this._minBidZoneCents = config.minBidZoneCents ?? 0;
    this._maxBidZoneCents = config.maxBidZoneCents ?? 100;
    this._dynSizeAlpha = config.dynSizeAlpha ?? 0;
    this._dynSizeMinRatio = config.dynSizeMinRatio ?? 0.3;
    this._dynSizeMaxRatio = config.dynSizeMaxRatio ?? 2.0;
    this._cryptoExitProbThreshold = config.cryptoExitProbThreshold ?? 0;
    this._cryptoExitDiscountCents = config.cryptoExitDiscountCents ?? 1;
    this._cryptoEntryMinEdge = config.cryptoEntryMinEdge ?? 0;
    this._cryptoEntryMinProb = config.cryptoEntryMinProb ?? 0;

    // ── Probability table loading ───────────────────────────────────────────
    this._probTableMinEdge = config.probTableMinEdge ?? 5;
    this._probTableMinN = config.probTableMinN ?? 100;
    this._probTableMode = config.probTableMode ?? 'veto';
    this._probTableBucketPrice = 10; // default, will be overridden from file
    this._probTableBucketTau = 60;
    if (config.probTablePath) {
      try {
        const raw = JSON.parse(readFileSync(config.probTablePath, 'utf8'));
        this._probTableBucketPrice = raw.config?.bucketPriceCents ?? 10;
        this._probTableBucketTau = raw.config?.bucketTauSec ?? 60;
        const tbl = new Map<string, { fairValueCents: number; total: number }>();
        for (const row of raw.table) {
          tbl.set(`${row.priceBucket}:${row.tauBucket}`, {
            fairValueCents: row.fairValueCents,
            total: row.total,
          });
        }
        this._probTable = tbl;
        this._logger?.info('AS: Probability table loaded', {
          path: config.probTablePath,
          buckets: tbl.size,
          mode: this._probTableMode,
          minEdge: this._probTableMinEdge,
          minN: this._probTableMinN,
        });
      } catch (e) {
        this._logger?.warn('AS: Failed to load probability table, disabling', { error: String(e) });
        this._probTable = null;
      }
    } else {
      this._probTable = null;
    }
  }

  // ── gather ──────────────────────────────────────────────────────────────────

  /**
   * Извлекает данные из snapshot: EWMA mid, inventory, time-to-expiry.
   *
   * @param snapshot - Readonly snapshot состояния
   * @returns ASData или undefined если данных недостаточно
   *
   * @remarks
   * Возвращает undefined (пропуск тика) если:
   * - Нет eventStartMs (не можем определить timing)
   * - Недостаточно трейдов для EWMA
   * - Нет market data
   *
   * Калибровочная таблица опциональна — при отсутствии используются дефолты.
   */
  protected gather(snapshot: StrategySnapshot): ASData | undefined {
    const expiresMs = snapshot.market.expirationMs;

    // Автоопределение калибровки при смене рынка
    if (this._calibratedMarketExpirationMs !== expiresMs) {
      this._calibratedMarketExpirationMs = expiresMs;
      this._ewma = null;
      this._tradeCount = 0;
      this._lastTradeTimestampMs = 0;
      this._stopLossTriggered = false;
      this._jumpWidenRemaining = 0;
      this._prevTradePrice = null;
      this._skipMarket = false;
      this._marketQualityChecked = false;
      this._conditionsOk = true;
      this._pauseTicks = 0;
      this._trailPeakCents = 0;
      this._trailEntryCents = 0;
      this._trailStopPending = false;
      this._cryptoExitTriggered = false;

      if (snapshot.eventStartMs !== undefined) {
        const eventStartMs = snapshot.eventStartMs.toNumber();
        const durationMs = expiresMs - eventStartMs;
        this._marketEventStartMs = eventStartMs;
        this._marketDurationMs = durationMs;
        this._calibration = findCalibration(durationMs);
        const durationMin = (durationMs / 60_000).toFixed(1);
        if (this._calibration) {
          this._logger?.info('AS: calibration table matched', {
            durationMin,
            maxBucket: this._calibration.maxBucket,
          });
        } else {
          this._logger?.info('AS: no calibration table, using defaults', {
            durationMin,
            sigma: DEFAULT_SIGMA,
            jump: DEFAULT_JUMP,
          });
        }
      } else {
        this._logger?.warn('AS: no eventStartMs in snapshot, skipping market');
        return undefined;
      }
    }

    // Нет eventStartMs → пропуск
    if (this._marketDurationMs <= 0) return undefined;

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

        // Jump detection: скачок цены → расширяем спред на cooldown трейдов
        if (this._jumpThreshold > 0 && this._prevTradePrice !== null) {
          if (Math.abs(priceNum - this._prevTradePrice) >= this._jumpThreshold) {
            this._jumpWidenRemaining = this._jumpCooldownTrades;
          }
        }
        this._prevTradePrice = priceNum;
        if (this._jumpWidenRemaining > 0) this._jumpWidenRemaining--;
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

    // Warmup: не торгуем первые N секунд — ждём накопления данных для regime/EWMA
    if (this._warmupSec > 0 && (snapshot.nowMs - this._marketEventStartMs) < this._warmupSec * 1000) {
      return undefined;
    }

    // Market quality filter: пропущенный рынок → skip навсегда
    if (this._skipMarket) return undefined;

    // Проверяем качество рынка один раз (при выходе из warmup)
    if (!this._marketQualityChecked) {
      this._marketQualityChecked = true;
      const skipReason = this._checkMarketQuality(snapshot, tapeRecords);
      if (skipReason) {
        this._skipMarket = true;
        this._logger?.info('AS: SKIP market — failed quality filter', { reason: skipReason });
        return undefined;
      }
    }

    // Позиция: количество токенов и inventory в единицах orderSize
    const position = snapshot.portfolio?.getPosition(snapshot.instrumentId);
    const rawQty = position?.quantity.value() ?? new Decimal(0);
    const availableTokenQty = snapshot.portfolio?.availableTokenQuantity(snapshot.instrumentId) ?? new Decimal(0);
    const orderSizeNum = this._config.orderSize.toNumber();
    const inventoryUnits = orderSizeNum > 0 ? rawQty.toNumber() / orderSizeNum : 0;

    // Средняя цена входа в центах (для stop-loss)
    const avgEntryPriceCents = position && !position.isClosed()
      ? position.averageEntryPrice.value().toNumber() * 100
      : 0;

    const availableBalance = snapshot.portfolio?.balance.available().value() ?? new Decimal(0);
    const minuteBucket = tauSec / 60;

    const hasInFlightFills = snapshot.hasInFlightFills || snapshot.matchedOrders.length > 0;

    // Regime detection: price range последних N трейдов в центах
    let priceRangeCents = 0;
    if (this._regimeWindow > 0 && tapeRecords && tapeRecords.length > 0) {
      const window = Math.min(this._regimeWindow, tapeRecords.length);
      const recentTrades = tapeRecords.slice(-window);
      let minPrice = Infinity;
      let maxPrice = -Infinity;
      for (const trade of recentTrades) {
        const p = trade.price.value().toNumber() * 100; // USDC → центы
        if (p < minPrice) minPrice = p;
        if (p > maxPrice) maxPrice = p;
      }
      priceRangeCents = maxPrice - minPrice;
    }

    // Book imbalance и depth из стакана
    let bookImbalance = 0;
    let topDepth = 0;
    const latestBook = snapshot.bookHistory?.getLatest();
    if (latestBook && latestBook.bids.length > 0 && latestBook.asks.length > 0) {
      // Top-3 imbalance (weighted)
      const topBids = latestBook.bids.slice(0, 3);
      const topAsks = latestBook.asks.slice(0, 3);
      let bidSum = 0;
      let askSum = 0;
      for (const l of topBids) bidSum += l.quantity.value().toNumber();
      for (const l of topAsks) askSum += l.quantity.value().toNumber();
      topDepth = bidSum + askSum;
      if (topDepth > 0) bookImbalance = (bidSum - askSum) / topDepth;
    } else if (snapshot.topOfBook) {
      // Fallback на topOfBook sizes
      const bs = snapshot.topOfBook.bestBidSize?.value().toNumber() ?? 0;
      const as = snapshot.topOfBook.bestAskSize?.value().toNumber() ?? 0;
      topDepth = bs + as;
      if (topDepth > 0) bookImbalance = (bs - as) / topDepth;
    }

    // OFI: доля upticks в последних N трейдах
    let ofi = 0.5;
    if (this._ofiWindow > 0 && tapeRecords && tapeRecords.length >= 2) {
      const window = Math.min(this._ofiWindow, tapeRecords.length - 1);
      const recentTrades = tapeRecords.slice(-window - 1);
      let upticks = 0;
      let total = 0;
      for (let i = 1; i < recentTrades.length; i++) {
        const prev = recentTrades[i - 1]!.price.value().toNumber();
        const curr = recentTrades[i]!.price.value().toNumber();
        if (curr > prev) upticks++;
        total++;
      }
      ofi = total > 0 ? upticks / total : 0.5;
    }

    // ── Consecutive ticks (для anti-adverse-selection) ──────────────────────
    let consecutiveUpticks = 0;
    let consecutiveDownticks = 0;
    if (this._aasConsecutiveThreshold > 0 && tapeRecords && tapeRecords.length >= 2) {
      // Считаем с конца ленты: сколько последовательных тиков в одну сторону
      for (let i = tapeRecords.length - 1; i >= 1; i--) {
        const curr = tapeRecords[i]!.price.value().toNumber();
        const prev = tapeRecords[i - 1]!.price.value().toNumber();
        if (curr > prev) {
          if (consecutiveDownticks > 0) break; // Направление изменилось
          consecutiveUpticks++;
        } else if (curr < prev) {
          if (consecutiveUpticks > 0) break;
          consecutiveDownticks++;
        }
        // curr === prev — пропускаем, не ломаем серию
      }
    }

    // ── Crypto price exit: вычисляем P(UP) по реальной цене BTC ──────────
    let cryptoProbUp: number | undefined;
    const needsCryptoProb = this._cryptoExitProbThreshold > 0 || this._cryptoEntryMinProb > 0;
    if (needsCryptoProb && snapshot.cryptoPrice) {
      const currentPrice = snapshot.cryptoPrice.currentPrice;
      const targetPrice = snapshot.cryptoPrice.targetPrice;
      if (currentPrice > 0 && targetPrice && targetPrice > 0) {
        const deltaPct = ((currentPrice - targetPrice) / targetPrice) * 100;
        cryptoProbUp = lookupCryptoProbUp(deltaPct, tauSec);
      }
    }

    // ── Continuous condition check ───────────────────────────────────────────
    const conditionsPaused = this._checkContinuousConditions(snapshot, priceRangeCents, topDepth);

    // ── Comfort score: 0..1 по текущим метрикам рынка ────────────────────
    const comfortScore = this._computeComfortScore(snapshot, priceRangeCents, topDepth, bookImbalance);

    return {
      ewmaMid: this._ewma,
      inventoryUnits,
      tauSec,
      minuteBucket,
      availableBalance,
      positionQty: rawQty,
      availableTokenQty,
      hasInFlightFills,
      nowMs: snapshot.nowMs,
      avgEntryPriceCents,
      priceRangeCents,
      jumpWidenActive: this._jumpWidenRemaining > 0,
      bookImbalance,
      topDepth,
      ofi,
      conditionsPaused,
      comfortScore,
      consecutiveUpticks,
      consecutiveDownticks,
      minOrderSize: snapshot.constraints?.minOrderSize.value(),
      minOrderValue: snapshot.constraints?.minOrderValue.value(),
      cryptoProbUp,
    };
  }

  // ── decide ──────────────────────────────────────────────────────────────────

  /**
   * Вычисляет bid/ask: нормальное котирование или aggressive unwind.
   *
   * @param data - Данные из gather
   * @param _reasons - Причины тика (не используются)
   * @returns Массив ASAction: QUOTE с ценами, STOP, или пустой (пропуск)
   *
   * @remarks
   * ### Режимы работы (приоритет сверху вниз):
   *
   * **1. Stop-loss** (mid < avgEntry - stopLossCents): немедленный dump.
   *   - Продаём ВСЕ по mid или ниже
   *   - После dump: _stopLossTriggered=true → спред ×2 на re-entry
   *   - Сбрасывается когда позиция = 0
   *
   * **2. Unwind** (tauSec < unwindSec): агрессивная разгрузка перед экспирацией.
   *   - BUY запрещён
   *   - progress = (unwindSec - tauSec) / unwindSec, идёт 0→1
   *   - ask = mid - floor(progress × maxDiscountCents)
   *   - Продаём ВСЕ доступные токены, до самого конца
   *
   * **3. Normal**: стандартное AS котирование.
   *   - Формулы в logit-пространстве
   *   - Если _stopLossTriggered — спред ×stopLossSpreadMult (осторожный re-entry)
   */
  protected decide(data: ASData, _reasons: ReadonlySet<TriggerReason>): ASAction[] {
    // ── Continuous condition check: пауза → снимаем ордера ────────────────
    if (data.conditionsPaused) {
      return [{ type: 'STOP' }];
    }

    // ── In-flight fills → пропускаем тик ──────────────────────────────────
    if (data.hasInFlightFills) {
      this._logger?.debug('AS: skip — in-flight fills');
      return [];
    }

    // ── Stop-loss: немедленный dump при unrealized loss > порога ──────────
    // Сбрасываем флаг когда позиция = 0 (чистый re-entry)
    if (this._stopLossTriggered && data.positionQty.isZero()) {
      this._stopLossTriggered = false;
      this._logger?.info('AS: stop-loss flag reset — position flat');
    }

    if (this._stopLossCents > 0 && data.avgEntryPriceCents > 0 && data.positionQty.gt(0)) {
      const unrealizedLossCents = data.avgEntryPriceCents - data.ewmaMid;
      if (unrealizedLossCents >= this._stopLossCents) {
        return this._decideStopLoss(data, unrealizedLossCents);
      }
    }

    // ── Trailing stop: гибрид MM + momentum ─────────────────────────────
    // Если trailing включён и есть позиция — переходим в trail mode.
    // Trail mode заменяет и unwind, и normal quoting для стороны sell.
    if (this._trailDistanceCents > 0 && (data.positionQty.gt(0) || this._trailStopPending)) {
      return this._decideTrailingStop(data);
    }

    // ── Crypto price exit: P(UP) упала ниже порога → агрессивная продажа ──
    // Также: если уже был crypto exit и ещё есть позиция → продолжаем продавать
    if (this._cryptoExitProbThreshold > 0 && data.positionQty.gt(0)) {
      const shouldExit = (data.cryptoProbUp !== undefined && data.cryptoProbUp < this._cryptoExitProbThreshold / 100)
                       || this._cryptoExitTriggered;
      if (shouldExit) {
        return this._decideCryptoExit(data);
      }
    }

    // ── Unwind phase: агрессивная разгрузка перед экспирацией ─────────────
    // Продаём до самого конца — нет hard stop. Чем ближе к концу, тем агрессивнее.
    if (data.tauSec < this._unwindSec) {
      return this._decideUnwind(data);
    }

    // ── Normal AS quoting ────────────────────────────────────────────────
    return this._decideNormal(data);
  }

  /**
   * Нормальное AS котирование: bid + ask по модели.
   *
   * @param data - Данные из gather
   * @returns QUOTE action или пустой массив
   */
  private _decideNormal(data: ASData): ASAction[] {
    const midClamped = Math.max(2, Math.min(98, data.ewmaMid));
    const x = logit(midClamped / 100);

    // Калибровочные параметры (таблица или дефолты)
    const { sigma, jump } = this._getCalibrationParams(data.minuteBucket);

    const s2t = sigma * sigma * data.tauSec;

    // Dynamic Q: qMax меняется по фазам
    const effectiveQMax = this._getEffectiveQMax(data.nowMs);

    // Dynamic gamma: увеличиваем risk aversion пропорционально позиции
    const q = Math.max(0, Math.min(effectiveQMax, data.inventoryUnits));
    let effectiveGamma = (this._dynGammaSlope > 0 && effectiveQMax > 0)
      ? this._gamma * (1 + this._dynGammaSlope * q / effectiveQMax)
      : this._gamma;

    // Adaptive regime: comfort score масштабирует gamma
    // Некомфортный рынок (score→0) → gamma выше → спред шире → осторожнее
    if (this._adaptiveScale > 0) {
      effectiveGamma *= 1 + this._adaptiveScale * (1 - data.comfortScore);
    }

    // Inventory skew (с profit hold: снижаем skew при нереализованной прибыли)
    let skewAdjust = 1.0;
    if (this._profitHoldThreshold > 0 && data.avgEntryPriceCents > 0 && data.positionQty.gt(0)) {
      const unrealizedPnlCents = data.ewmaMid - data.avgEntryPriceCents;
      if (unrealizedPnlCents > this._profitHoldThreshold) {
        skewAdjust = this._profitHoldSkewReduction;
      }
    }
    const skew = effectiveQMax > 0
      ? (q / effectiveQMax) * effectiveGamma * this._skewMult * s2t * skewAdjust
      : 0;
    const r_x = x - skew;

    // Spread: γ×σ²×τ + jump (без 2/κ)
    // Множители: stop-loss (re-entry), regime (trending/ranging), jump widen (скачок цены)
    let regimeMult = 1.0;
    if (this._regimeWindow > 0) {
      if (data.priceRangeCents >= this._regimeTrendThreshold) {
        regimeMult = this._regimeTrendSpreadMult;
      } else if (data.priceRangeCents <= this._regimeRangeThreshold) {
        regimeMult = this._regimeRangeSpreadMult;
      }
    }
    const jumpMult = data.jumpWidenActive ? this._jumpWidenFactor : 1.0;

    // Imbalance spread: перекошенный стакан → шире спред
    const imbalanceMult = this._imbalanceSpreadFactor > 0
      ? 1 + this._imbalanceSpreadFactor * Math.abs(data.bookImbalance)
      : 1.0;

    // Depth spread: тонкий стакан → шире спред
    const depthMult = (this._depthSpreadFactor > 0 && data.topDepth > 0)
      ? 1 + this._depthSpreadFactor / data.topDepth
      : 1.0;

    const spreadMultiplier = this._stopLossTriggered
      ? this._spreadMult * this._stopLossSpreadMult * regimeMult * jumpMult * imbalanceMult * depthMult
      : this._spreadMult * regimeMult * jumpMult * imbalanceMult * depthMult;
    const spread_x = (effectiveGamma * s2t + jump) * spreadMultiplier;

    // OFI mid shift: смещаем reservation price в сторону давления покупателей
    let ofiShift = 0;
    if (this._ofiWindow > 0 && this._ofiWeight > 0) {
      // ofi=0.5 → нейтральный, ofi=1 → все upticks, ofi=0 → все downticks
      // shift в logit-space: (ofi - 0.5) * weight / 100 (центы → probability space)
      ofiShift = (data.ofi - 0.5) * this._ofiWeight * 0.02;
    }
    const r_x_adjusted = r_x + ofiShift;

    // Bid/ask в центах (1–99)
    let bid = Math.max(1, Math.min(99, Math.floor(sigmoid(r_x_adjusted - spread_x / 2) * 100)));
    let ask = Math.max(1, Math.min(99, Math.ceil(sigmoid(r_x_adjusted + spread_x / 2) * 100)));

    // Crossing prevention
    if (bid >= ask) {
      ask = bid + 1;
      if (ask > 99) { bid = 98; ask = 99; }
    }

    // Probability table: veto/shift bid
    if (this._probTable) {
      const ptResult = this._applyProbTable(bid, data.tauSec);
      if (ptResult.blocked) {
        bid = 1; // будет заблокирован через canBid=false ниже
      } else {
        bid = ptResult.bid;
        // Re-check crossing после shift
        if (bid >= ask) {
          ask = bid + 1;
          if (ask > 99) { bid = 98; ask = 99; }
        }
      }
    }

    // Position limits
    const midCents = data.ewmaMid;
    const zoneBlocked = midCents < this._minBidZoneCents || midCents > this._maxBidZoneCents;
    const probTableBlocked = this._probTable !== null && bid <= 1 && data.inventoryUnits < effectiveQMax;

    // Crypto-informed entry: два фильтра
    // 1) cryptoEntryMinEdge: P(UP)*100 - bid >= minEdge (сравнение с ценой)
    // 2) cryptoEntryMinProb: P(UP) >= threshold (абсолютный порог вероятности)
    let cryptoEntryBlocked = false;
    if (this._cryptoEntryMinEdge > 0 && data.cryptoProbUp !== undefined) {
      const fairValueCents = data.cryptoProbUp * 100;
      const edge = fairValueCents - bid;
      if (edge < this._cryptoEntryMinEdge) {
        cryptoEntryBlocked = true;
      }
    }
    if (this._cryptoEntryMinProb > 0 && data.cryptoProbUp !== undefined) {
      if (data.cryptoProbUp < this._cryptoEntryMinProb / 100) {
        cryptoEntryBlocked = true;
      }
    }

    const canBid = data.inventoryUnits < effectiveQMax && !zoneBlocked && !probTableBlocked && !cryptoEntryBlocked && !this._cryptoExitTriggered;

    // Adaptive regime: comfort score масштабирует orderSize (только если adaptiveMinOrderRatio < 1)
    // Некомфортный рынок → меньшие ордера (минимум adaptiveMinOrderRatio от базового)
    let effectiveOrderSize = this._config.orderSize;
    if (this._adaptiveScale > 0 && this._adaptiveMinOrderRatio < 1 && data.comfortScore < 1) {
      const sizeRatio = this._adaptiveMinOrderRatio + (1 - this._adaptiveMinOrderRatio) * data.comfortScore;
      effectiveOrderSize = this._config.orderSize.mul(sizeRatio).floor();
      if (effectiveOrderSize.lt(1)) effectiveOrderSize = new Decimal(1);
    }

    // Dynamic sizing по цене: дороже mid → больше BUY (высокая P(UP)),
    // дешевле mid → меньше BUY (низкая P(UP)). SELL — зеркально.
    let effectiveBidSize = effectiveOrderSize;
    let effectiveAskSize = effectiveOrderSize;
    if (this._dynSizeAlpha > 0 && midCents > 1 && midCents < 99) {
      const bidRatio = Math.min(this._dynSizeMaxRatio,
        Math.max(this._dynSizeMinRatio, Math.pow(midCents / 50, this._dynSizeAlpha)));
      const askRatio = Math.min(this._dynSizeMaxRatio,
        Math.max(this._dynSizeMinRatio, Math.pow((100 - midCents) / 50, this._dynSizeAlpha)));
      effectiveBidSize = effectiveOrderSize.mul(bidRatio).floor();
      effectiveAskSize = effectiveOrderSize.mul(askRatio).floor();
      if (effectiveBidSize.lt(1)) effectiveBidSize = new Decimal(1);
      if (effectiveAskSize.lt(1)) effectiveAskSize = new Decimal(1);
    }

    let bidSize = canBid ? effectiveBidSize : new Decimal(0);

    // Ask: SELL только если есть доступные токены
    let askSize = data.availableTokenQty.gt(0)
      ? Decimal.min(effectiveAskSize, data.availableTokenQty)
      : new Decimal(0);

    // Anti-adverse-selection: подавляем уязвимую сторону при направленном потоке
    if (this._aasConsecutiveThreshold > 0) {
      // N+ upticks подряд → покупатели агрессивны → наш ask будет picked off → cancel ask
      if (data.consecutiveUpticks >= this._aasConsecutiveThreshold && !askSize.isZero()) {
        this._logger?.debug('AS: AAS skip ask — uptick run', { upticks: data.consecutiveUpticks });
        askSize = new Decimal(0);
      }
      // N+ downticks → продавцы агрессивны → наш bid будет picked off → cancel bid
      if (data.consecutiveDownticks >= this._aasConsecutiveThreshold && !bidSize.isZero()) {
        this._logger?.debug('AS: AAS skip bid — downtick run', { downticks: data.consecutiveDownticks });
        bidSize = new Decimal(0);
      }
    }

    // OFI skip: сильный давление одной стороны → не котируем уязвимую
    if (this._ofiSkipThreshold > 0) {
      // Сильный buy pressure (ofi > 1-threshold) → skip ask
      if (data.ofi > (1 - this._ofiSkipThreshold) && !askSize.isZero()) {
        this._logger?.debug('AS: OFI skip ask — strong buy pressure', { ofi: data.ofi.toFixed(2) });
        askSize = new Decimal(0);
      }
      // Сильный sell pressure (ofi < threshold) → skip bid
      if (data.ofi < this._ofiSkipThreshold && !bidSize.isZero()) {
        this._logger?.debug('AS: OFI skip bid — strong sell pressure', { ofi: data.ofi.toFixed(2) });
        bidSize = new Decimal(0);
      }
    }

    if (bidSize.isZero() && askSize.isZero()) {
      this._logger?.debug('AS: skip — both sides at position limit');
      return [];
    }

    // minOrderValue / balance checks
    ({ bidSize, askSize } = this._applyOrderChecks(data, bid, ask, bidSize, askSize));

    if (bidSize.isZero() && askSize.isZero()) {
      this._logger?.debug('AS: skip — insufficient balance and no ask');
      return [];
    }

    this._logger?.debug('AS: QUOTE (normal)', {
      mid: midClamped.toFixed(1),
      bid,
      ask,
      spread: ask - bid,
      sigma: sigma.toFixed(4),
      inventory: q.toFixed(1),
      effectiveQMax,
      tauSec: data.tauSec.toFixed(0),
      skew: skew.toFixed(4),
      bidSize: bidSize.toFixed(1),
      askSize: askSize.toFixed(1),
      regime: regimeMult !== 1.0 ? (regimeMult > 1 ? 'trending' : 'ranging') : 'neutral',
      priceRange: data.priceRangeCents.toFixed(1),
      regimeMult: regimeMult.toFixed(2),
    });

    return [{
      type: 'QUOTE',
      bid,
      ask,
      bidSize,
      askSize,
    }];
  }

  /**
   * Unwind: агрессивная разгрузка инвентори перед экспирацией.
   *
   * @param data - Данные из gather
   * @returns QUOTE (только SELL), STOP, или пустой массив
   *
   * @remarks
   * Progress идёт от 0 (начало unwind) до 1 (экспирация):
   * - progress=0: ask = mid (продаём по рыночной цене)
   * - progress=0.5: ask = mid - 1.5¢ (при maxDiscount=3)
   * - progress=1: ask = mid - 3¢ (максимальная агрессия)
   *
   * Продаём ВСЕ доступные токены за раз (не ограничиваем orderSize).
   */

  /**
   * Stop-loss dump: немедленная продажа всего инвентори при убытке > порога.
   *
   * @param data - Данные из gather
   * @param lossCents - Текущий unrealized loss в центах (положительное число)
   * @returns QUOTE action с агрессивным ask
   *
   * @remarks
   * ### Trailing stop — гибрид MM + momentum
   *
   * Когда есть позиция и trailing включён:
   * 1. Обновляем peak price (максимум mid с момента входа)
   * 2. Вычисляем trail distance по зоне:
   *    - base zone (<trailWideZone): trailDistanceCents
   *    - wide zone (≥trailWideZone, <holdZone): trailWideDistanceCents
   *    - hold zone (≥holdZone): не продаём, ждём settlement
   * 3. stopPrice = peak - trailDistance (никогда не опускается)
   * 4. Если mid ≤ stopPrice → агрессивная продажа
   * 5. Если mid > stopPrice → hold (не продаём), можно bid для добора
   *
   * @param data - Данные из gather
   * @returns QUOTE с trailing-stop поведением
   */
  private _decideTrailingStop(data: ASData): ASAction[] {
    const mid = data.ewmaMid;
    const entry = data.avgEntryPriceCents;

    // Trail stop pending, но позиция закрыта → SELL исполнился
    if (this._trailStopPending && data.inventoryUnits <= 0) {
      this._logger?.info('AS: TRAIL STOP filled, position closed');
      this._trailPeakCents = 0;
      this._trailEntryCents = 0;
      this._trailStopPending = false;
      // Возвращаемся к обычному MM — вернёт пустой массив, decide() пойдёт в _decideNormal
      return [];
    }

    // Инициализация entry и peak при первом вызове
    if (this._trailEntryCents === 0) {
      this._trailEntryCents = entry;
    }
    if (this._trailPeakCents === 0) {
      this._trailPeakCents = mid;
    }
    // Обновляем peak (только вверх)
    if (mid > this._trailPeakCents) {
      this._trailPeakCents = mid;
    }

    // ── Асимметричный trail distance ──────────────────────────────────────
    // Выше entry (в прибыли): широкий trail → даём расти
    // Ниже entry (в убытке): узкий trail → быстро режем
    // В зоне уверенности (peak >= wideZone): ещё шире
    // В зоне settlement (peak >= holdZone): держим до конца
    let trailDist: number;
    const inProfit = mid >= this._trailEntryCents;

    if (this._trailPeakCents >= this._trailHoldZoneCents && data.tauSec > 5) {
      // Зона settlement — не продаём, ждём конца
      this._logger?.debug('AS: TRAIL hold zone', {
        peak: this._trailPeakCents.toFixed(1), mid: mid.toFixed(1),
      });
      return [{ type: 'STOP' }]; // Снимаем ордера, ждём settlement
    } else if (inProfit && this._trailPeakCents >= this._trailWideZoneCents) {
      trailDist = this._trailWideDistanceCents; // Зона уверенности — широкий trail
    } else if (inProfit) {
      trailDist = this._trailDistanceCents; // В прибыли — нормальный trail
    } else if (this._trailTightCents <= 0) {
      // trailTightCents=0 → не выходим при убытке, ждём settlement
      trailDist = Infinity;
    } else {
      trailDist = this._trailTightCents; // В убытке — узкий trail, быстро выходим
    }

    // В прибыли: stop от peak (lock-in gains).
    // В убытке: если tight < trailDist (асимметричный) → stop от ENTRY (peak ratcheting опасен).
    //           если tight >= trailDist (симметричный) → stop от peak (lock-in spike profits).
    const useEntryBasedStop = !inProfit && this._trailTightCents < this._trailDistanceCents;
    const stopPrice = useEntryBasedStop
      ? this._trailEntryCents - trailDist
      : this._trailPeakCents - trailDist;

    // Trailing stop сработал → агрессивная продажа
    if (mid <= stopPrice || this._trailStopPending) {
      if (data.availableTokenQty.isZero()) {
        // SELL уже в книге или позиция закрыта
        if (data.inventoryUnits <= 0) {
          // Позиция закрыта (SELL исполнился) → сбрасываем trail state
          this._trailPeakCents = 0;
          this._trailEntryCents = 0;
          this._trailStopPending = false;
          this._logger?.info('AS: TRAIL STOP filled, position closed');
        }
        return [];
      }
      const askPrice = Math.max(1, Math.floor(mid));
      this._logger?.info('AS: TRAIL STOP triggered', {
        entry: this._trailEntryCents.toFixed(1),
        peak: this._trailPeakCents.toFixed(1),
        mid: mid.toFixed(1),
        stop: stopPrice.toFixed(1),
        pnlCents: (mid - this._trailEntryCents).toFixed(1),
        pending: this._trailStopPending,
      });
      // НЕ сбрасываем peak/entry — только когда SELL реально исполнится
      this._trailStopPending = true;
      return [{
        type: 'QUOTE',
        bid: 1,
        ask: askPrice,
        bidSize: new Decimal(0),
        askSize: data.availableTokenQty,
      }];
    }

    // Hold — не продаём. Bid только если цена идёт ВВЕРХ (подтверждение направления).
    // Не добираем когда в убытке — не усредняем down.
    // Не покупаем если trail stop pending (ждём исполнения SELL).
    const effectiveQMax = this._getEffectiveQMax(data.nowMs);
    const canBid = !this._trailStopPending
      && inProfit
      && data.inventoryUnits < effectiveQMax
      && mid >= this._minBidZoneCents && mid <= this._maxBidZoneCents;

    this._logger?.debug('AS: TRAIL holding', {
      entry: this._trailEntryCents.toFixed(1),
      peak: this._trailPeakCents.toFixed(1),
      mid: mid.toFixed(1),
      stop: stopPrice.toFixed(1),
      trail: trailDist,
      inProfit,
    });

    const bidPrice = canBid ? Math.max(1, Math.floor(mid - 1)) : 1;
    const bidSize = canBid ? this._config.orderSize : new Decimal(0);
    return [{
      type: 'QUOTE',
      bid: bidPrice,
      ask: 99,
      bidSize,
      askSize: new Decimal(0),
    }];
  }

  /**
   * Продаём по mid - (lossCents / 2) — готовы отдать часть loss чтобы выйти быстрее.
   * После dump устанавливаем _stopLossTriggered → спред расширен при re-entry.
   */
  private _decideStopLoss(data: ASData, lossCents: number): ASAction[] {
    // Нечего продать (всё в open orders)
    if (data.availableTokenQty.isZero()) {
      this._logger?.debug('AS: STOP-LOSS — waiting for open SELL to fill');
      return [];
    }

    this._stopLossTriggered = true;

    const midClamped = Math.max(2, Math.min(98, data.ewmaMid));
    // Продаём по mid или чуть ниже (половина loss как дисконт для быстрого исполнения)
    const discount = Math.min(Math.floor(lossCents / 2), 5);
    const ask = Math.max(1, Math.round(midClamped) - discount);

    let askSize = data.availableTokenQty;

    // minOrderValue check
    const minOV = data.minOrderValue ?? new Decimal(1);
    const askPrice = new Decimal(ask).div(100);
    if (askSize.mul(askPrice).lt(minOV)) {
      const minAskSize = minOV.div(askPrice).ceil();
      if (minAskSize.lte(data.availableTokenQty)) {
        askSize = minAskSize;
      } else {
        return [];
      }
    }

    this._logger?.info('AS: STOP-LOSS DUMP', {
      mid: midClamped.toFixed(1),
      avgEntry: data.avgEntryPriceCents.toFixed(1),
      loss: lossCents.toFixed(1),
      ask,
      discount,
      askSize: askSize.toFixed(1),
      tauSec: data.tauSec.toFixed(0),
    });

    return [{
      type: 'QUOTE',
      bid: 1,
      ask,
      bidSize: new Decimal(0),
      askSize,
    }];
  }

  /**
   * Crypto price exit: P(UP) упала ниже порога → продаём агрессивно.
   *
   * @remarks
   * Когда реальная цена BTC (Chainlink) показывает что рынок скорее DOWN,
   * продаём позицию немедленно по best bid минус дисконт. Фиксируем маленький
   * убыток вместо полной потери при DOWN resolution.
   *
   * Не блокируем BUY полностью — позволяем normal quoting после выхода.
   */
  private _decideCryptoExit(data: ASData): ASAction[] {
    // Нечего продать
    if (data.availableTokenQty.isZero()) {
      return [];
    }

    const midClamped = Math.max(2, Math.min(98, data.ewmaMid));
    const ask = Math.max(1, Math.round(midClamped) - this._cryptoExitDiscountCents);

    let askSize = data.availableTokenQty;

    // minOrderValue check
    const minOV = data.minOrderValue ?? new Decimal(1);
    const askPrice = new Decimal(ask).div(100);
    if (askSize.mul(askPrice).lt(minOV)) {
      const minAskSize = minOV.div(askPrice).ceil();
      if (minAskSize.lte(data.availableTokenQty)) {
        askSize = minAskSize;
      } else {
        return [];
      }
    }

    // Блокируем BUY до конца рынка после crypto exit
    this._cryptoExitTriggered = true;

    this._logger?.info('AS: CRYPTO EXIT — P(UP) below threshold, blocking re-entry', {
      probUp: data.cryptoProbUp?.toFixed(2),
      threshold: (this._cryptoExitProbThreshold / 100).toFixed(2),
      mid: midClamped.toFixed(1),
      ask,
      askSize: askSize.toFixed(1),
      tauSec: data.tauSec.toFixed(0),
    });

    return [{
      type: 'QUOTE',
      bid: 1,
      ask,
      bidSize: new Decimal(0),
      askSize,
    }];
  }

  private _decideUnwind(data: ASData): ASAction[] {
    // Если нет инвентори — мы flat, цель достигнута
    if (data.availableTokenQty.isZero() && data.positionQty.isZero()) {
      this._logger?.info('AS: UNWIND complete — flat, stopping', { tauSec: data.tauSec });
      return [{ type: 'STOP' }];
    }

    // Нечего продать (всё зарезервировано в open orders) — ждём fill
    if (data.availableTokenQty.isZero()) {
      this._logger?.debug('AS: UNWIND — waiting for open SELL to fill', { tauSec: data.tauSec });
      return [];
    }

    const midClamped = Math.max(2, Math.min(98, data.ewmaMid));

    // progress: 0 в начале unwind → 1 у экспирации
    const progress = Math.max(0, Math.min(1, (this._unwindSec - data.tauSec) / this._unwindSec));

    // Дисконт от mid: чем ближе к концу, тем ниже цена
    const discountCents = Math.floor(progress * this._unwindMaxDiscountCents);
    const ask = Math.max(1, Math.round(midClamped) - discountCents);

    // Продаём ВСЕ доступные токены
    let askSize = data.availableTokenQty;

    // minOrderValue check
    const minOV = data.minOrderValue ?? new Decimal(1);
    const askPrice = new Decimal(ask).div(100);
    if (askSize.mul(askPrice).lt(minOV)) {
      const minAskSize = minOV.div(askPrice).ceil();
      if (minAskSize.lte(data.availableTokenQty)) {
        askSize = minAskSize;
      } else {
        // Слишком мало токенов для минимального ордера — skip
        this._logger?.debug('AS: UNWIND — too few tokens for min order value');
        return [];
      }
    }

    this._logger?.info('AS: UNWIND', {
      mid: midClamped.toFixed(1),
      ask,
      discount: discountCents,
      progress: progress.toFixed(2),
      askSize: askSize.toFixed(1),
      tauSec: data.tauSec.toFixed(0),
      positionQty: data.positionQty.toFixed(1),
    });

    // Bid=1 (фиктивный, bidSize=0 → не будет размещён)
    return [{
      type: 'QUOTE',
      bid: 1,
      ask,
      bidSize: new Decimal(0),
      askSize,
    }];
  }

  /**
   * Проверяет bid по probability table и применяет veto/shift.
   *
   * @param bid - Цена bid в центах
   * @param tauSec - Секунды до экспирации
   * @returns { bid: скорректированный bid, blocked: true если veto заблокировал }
   */
  private _applyProbTable(bid: number, tauSec: number): { bid: number; blocked: boolean } {
    if (!this._probTable) return { bid, blocked: false };

    const pb = Math.floor(bid / this._probTableBucketPrice) * this._probTableBucketPrice;
    const tb = Math.floor(tauSec / this._probTableBucketTau) * this._probTableBucketTau;
    const key = `${pb}:${tb}`;
    const bucket = this._probTable.get(key);

    // Нет данных или мало наблюдений — не мешаем стратегии
    if (!bucket || bucket.total < this._probTableMinN) return { bid, blocked: false };

    const edge = bucket.fairValueCents - bid;

    if (edge >= this._probTableMinEdge) {
      return { bid, blocked: false };
    }

    if (this._probTableMode === 'veto') {
      this._logger?.debug('AS: probTable VETO bid', {
        bid, tauSec: Math.round(tauSec), fv: bucket.fairValueCents, edge: edge.toFixed(1), n: bucket.total,
      });
      return { bid, blocked: true };
    }

    // Shift: сдвигаем bid вниз до fairValue - minEdge
    const shiftedBid = Math.floor(bucket.fairValueCents - this._probTableMinEdge);
    if (shiftedBid < 1) {
      return { bid, blocked: true };
    }
    this._logger?.debug('AS: probTable SHIFT bid', {
      origBid: bid, newBid: shiftedBid, tauSec: Math.round(tauSec),
      fv: bucket.fairValueCents, edge: (bucket.fairValueCents - shiftedBid).toFixed(1),
    });
    return { bid: shiftedBid, blocked: false };
  }

  /**
   * Применяет проверки minOrderValue и баланса к bid/ask размерам.
   *
   * @param data - Данные из gather
   * @param bid - Bid цена в центах
   * @param ask - Ask цена в центах
   * @param bidSize - Начальный размер bid
   * @param askSize - Начальный размер ask
   * @returns Скорректированные размеры
   */
  private _applyOrderChecks(
    data: ASData,
    bid: number,
    ask: number,
    bidSize: Decimal,
    askSize: Decimal,
  ): { bidSize: Decimal; askSize: Decimal } {
    const minOV = data.minOrderValue ?? new Decimal(1);
    const bidPrice = new Decimal(bid).div(100);
    const askPrice = new Decimal(ask).div(100);

    // minOrderValue check для bid
    if (bidSize.gt(0) && bidSize.mul(bidPrice).lt(minOV)) {
      const minBidSize = minOV.div(bidPrice).ceil();
      if (minBidSize.lte(this._config.orderSize.mul(2))) {
        bidSize = minBidSize;
      } else {
        bidSize = new Decimal(0);
      }
    }

    // minOrderValue check для ask
    if (askSize.gt(0) && askSize.mul(askPrice).lt(minOV)) {
      const minAskSize = minOV.div(askPrice).ceil();
      if (minAskSize.lte(data.availableTokenQty)) {
        askSize = minAskSize;
      } else {
        askSize = new Decimal(0);
      }
    }

    // Balance check для bid
    if (bidSize.gt(0)) {
      const bidCost = bidSize.mul(bidPrice);
      if (bidCost.gt(data.availableBalance)) {
        const maxAffordable = data.availableBalance.div(bidPrice).floor();
        if (maxAffordable.mul(bidPrice).lt(minOV)) {
          bidSize = new Decimal(0);
        } else {
          bidSize = maxAffordable;
        }
      }
    }

    return { bidSize, askSize };
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

  // ── Вспомогательные методы ─────────────────────────────────────────────────

  /**
   * Возвращает sigma и jump для текущего minute bucket.
   * Если калибровочная таблица есть — интерполирует, иначе дефолты.
   *
   * @param minuteBucket - Минутный бакет (tauSec / 60)
   * @returns { sigma, jump }
   */
  private _getCalibrationParams(minuteBucket: number): { sigma: number; jump: number } {
    if (this._calibration) {
      return {
        sigma: interpolate(this._calibration.sigma, minuteBucket, this._calibration.maxBucket),
        jump: interpolate(this._calibration.jump, minuteBucket, this._calibration.maxBucket),
      };
    }
    return { sigma: DEFAULT_SIGMA, jump: DEFAULT_JUMP };
  }

  /**
   * Определяет текущий effectiveQMax на основе фазы dynamic Q schedule.
   *
   * @param nowMs - Текущее время (из snapshot.nowMs)
   * @returns Текущий qMax. Если dynamicQ не задан — возвращает фиксированный _qMax.
   *
   * @remarks
   * Elapsed fraction = (nowMs - eventStartMs) / durationMs, clamp [0, 1].
   * Ищем первую фазу где elapsed < phase.until.
   */
  private _getEffectiveQMax(nowMs: number): number {
    if (!this._dynamicQ || this._dynamicQ.length === 0 || this._marketDurationMs <= 0) {
      return this._qMax;
    }

    const elapsed = Math.max(0, Math.min(1, (nowMs - this._marketEventStartMs) / this._marketDurationMs));

    for (const phase of this._dynamicQ) {
      if (elapsed < phase.until) {
        return phase.qMax;
      }
    }

    return this._dynamicQ[this._dynamicQ.length - 1]!.qMax;
  }

  // ── Market quality filter ───────────────────────────────────────────────────

  /**
   * Оценивает качество рынка после warmup периода.
   *
   * @param snapshot - Текущий snapshot
   * @param tapeRecords - Записи trade tape (или undefined)
   * @returns Причина отказа (строка) или null если рынок прошёл фильтр
   *
   * @remarks
   * Три метрики (любая может заблокировать рынок):
   * 1. **Warmup volatility**: price range за warmup > maxWarmupVolCents → trending рынок
   * 2. **Trade intensity**: trades/sec за warmup < minWarmupTradesPerSec → неликвидный
   * 3. **Spread width**: текущий bid-ask spread > maxSpreadCents → плохие условия
   */
  private _checkMarketQuality(
    snapshot: StrategySnapshot,
    tapeRecords: readonly { price: { value(): Decimal }; timestamp: { toNumber(): number } }[] | undefined,
  ): string | null {
    const hasAnyFilter = this._maxWarmupVolCents > 0
      || this._minWarmupTradesPerSec > 0
      || this._maxSpreadCents > 0
      || this._maxWarmupImbalance > 0;
    if (!hasAnyFilter) return null;

    // 1. Warmup volatility: price range в центах
    if (this._maxWarmupVolCents > 0 && tapeRecords && tapeRecords.length > 0) {
      let minP = Infinity;
      let maxP = -Infinity;
      for (const t of tapeRecords) {
        const p = t.price.value().toNumber() * 100;
        if (p < minP) minP = p;
        if (p > maxP) maxP = p;
      }
      const rangeCents = maxP - minP;
      if (rangeCents > this._maxWarmupVolCents) {
        return `warmupVol=${rangeCents.toFixed(1)}c > max=${this._maxWarmupVolCents}c`;
      }
    }

    // 2. Trade intensity: trades per second за warmup
    if (this._minWarmupTradesPerSec > 0 && this._warmupSec > 0) {
      const intensity = this._tradeCount / this._warmupSec;
      if (intensity < this._minWarmupTradesPerSec) {
        return `tradeIntensity=${intensity.toFixed(2)}/s < min=${this._minWarmupTradesPerSec}/s`;
      }
    }

    // 3. Spread width: текущий bid-ask spread в центах
    if (this._maxSpreadCents > 0 && snapshot.topOfBook) {
      const bid = snapshot.topOfBook.bestBid?.value().toNumber();
      const ask = snapshot.topOfBook.bestAsk?.value().toNumber();
      if (bid !== undefined && ask !== undefined) {
        const spreadCents = (ask - bid) * 100;
        if (spreadCents > this._maxSpreadCents) {
          return `spread=${spreadCents.toFixed(1)}c > max=${this._maxSpreadCents}c`;
        }
      }
    }

    // 4. Book imbalance: перекос стакана
    if (this._maxWarmupImbalance > 0) {
      const latestBook = snapshot.bookHistory?.getLatest();
      if (latestBook && latestBook.bids.length > 0 && latestBook.asks.length > 0) {
        const topBids = latestBook.bids.slice(0, 3);
        const topAsks = latestBook.asks.slice(0, 3);
        let bidSum = 0;
        let askSum = 0;
        for (const l of topBids) bidSum += l.quantity.value().toNumber();
        for (const l of topAsks) askSum += l.quantity.value().toNumber();
        const total = bidSum + askSum;
        if (total > 0) {
          const imb = Math.abs(bidSum - askSum) / total;
          if (imb > this._maxWarmupImbalance) {
            return `imbalance=${imb.toFixed(2)} > max=${this._maxWarmupImbalance}`;
          }
        }
      }
    }

    return null;
  }

  /**
   * Непрерывная проверка условий рынка (каждый тик).
   *
   * @param snapshot - Текущий snapshot
   * @param priceRangeCents - Price range последних N трейдов (уже рассчитан в gather)
   * @param topDepth - Глубина стакана top-3 (уже рассчитана в gather)
   * @returns true если условия нарушены (пауза), false если всё ОК (торгуем)
   *
   * @remarks
   * В отличие от warmup-фильтра, этот метод:
   * - Вызывается **каждый тик** (не один раз)
   * - **Обратим**: пауза → условия восстановились → торгуем снова
   * - Проверяет runtime-условия: spread, vol, depth
   * - Cooldown (первые N секунд рынка = каша, не торгуем)
   */
  private _checkContinuousConditions(
    snapshot: StrategySnapshot,
    priceRangeCents: number,
    topDepth: number,
  ): boolean {
    const hasAnyCheck = this._conditionCheckSpreadCents > 0
      || this._conditionCheckVolCents > 0
      || this._conditionCheckMinDepth > 0
      || this._conditionCheckCooldownSec > 0;
    if (!hasAnyCheck) {
      // Без condition check — всегда торгуем
      if (!this._conditionsOk) {
        this._conditionsOk = true;
        this._pauseTicks = 0;
      }
      return false;
    }

    let reason: string | null = null;

    // 1. Cooldown: первые N секунд рынка — ожидаем стабилизации
    if (this._conditionCheckCooldownSec > 0) {
      const elapsedSec = (snapshot.nowMs - this._marketEventStartMs) / 1000;
      if (elapsedSec < this._conditionCheckCooldownSec) {
        reason = `cooldown: ${elapsedSec.toFixed(0)}s < ${this._conditionCheckCooldownSec}s`;
      }
    }

    // 2. Spread: текущий bid-ask слишком широкий
    if (!reason && this._conditionCheckSpreadCents > 0 && snapshot.topOfBook) {
      const bid = snapshot.topOfBook.bestBid?.value().toNumber();
      const ask = snapshot.topOfBook.bestAsk?.value().toNumber();
      if (bid !== undefined && ask !== undefined) {
        const spreadCents = (ask - bid) * 100;
        if (spreadCents > this._conditionCheckSpreadCents) {
          reason = `spread=${spreadCents.toFixed(1)}c > ${this._conditionCheckSpreadCents}c`;
        }
      }
    }

    // 3. Volatility: price range последних N трейдов слишком большой
    if (!reason && this._conditionCheckVolCents > 0 && priceRangeCents > this._conditionCheckVolCents) {
      reason = `vol=${priceRangeCents.toFixed(1)}c > ${this._conditionCheckVolCents}c`;
    }

    // 4. Depth: стакан слишком тонкий
    if (!reason && this._conditionCheckMinDepth > 0 && topDepth < this._conditionCheckMinDepth) {
      reason = `depth=${topDepth.toFixed(1)} < ${this._conditionCheckMinDepth}`;
    }

    if (reason) {
      // Переход в паузу
      if (this._conditionsOk) {
        this._conditionsOk = false;
        this._pauseTicks = 0;
        this._logger?.info('AS: PAUSE — conditions violated', { reason });
      }
      this._pauseTicks++;
      // Логируем каждые 10 тиков чтобы не спамить
      if (this._pauseTicks % 10 === 0) {
        this._logger?.debug('AS: still paused', { reason, ticks: this._pauseTicks });
      }
      return true;
    }

    // Условия ОК — возобновляем торговлю
    if (!this._conditionsOk) {
      this._conditionsOk = true;
      this._logger?.info('AS: RESUME — conditions restored', { pausedTicks: this._pauseTicks });
      this._pauseTicks = 0;
    }
    return false;
  }

  // ── Comfort score ──────────────────────────────────────────────────────────

  /**
   * Вычисляет непрерывный «комфорт-скор» рынка 0..1.
   *
   * @remarks
   * ### Метрики (каждая нормализована в 0..1):
   * 1. **Волатильность**: priceRangeCents → low = комфортно.
   *    `volScore = clamp(1 - range / 4, 0, 1)` (≥4¢ → 0, 0¢ → 1)
   * 2. **Глубина стакана**: topDepth (суммарный объём top-3 уровней).
   *    `depthScore = clamp(depth / 200, 0, 1)` (≥200 → 1, 0 → 0)
   * 3. **Баланс стакана**: |bookImbalance| → balanced = комфортно.
   *    `balanceScore = 1 - |imbalance|` (0 = перекос, 1 = сбалансирован)
   * 4. **Торговый поток**: tradeCount / elapsed → высокий = комфортно.
   *    `flowScore = clamp(tps / 1.0, 0, 1)` (≥1 trade/sec → 1, 0 → 0)
   *
   * Итог: среднее арифметическое четырёх компонент.
   *
   * @param snapshot - Текущий снэпшот рынка (для nowMs)
   * @param priceRangeCents - Диапазон цен последних N трейдов (в центах)
   * @param topDepth - Суммарный объём top-3 bid + ask уровней
   * @param bookImbalance - Перекос стакана (-1..1)
   * @returns Comfort score 0..1 (1 = идеальные условия)
   */
  private _computeComfortScore(
    snapshot: StrategySnapshot,
    priceRangeCents: number,
    topDepth: number,
    bookImbalance: number,
  ): number {
    if (this._adaptiveScale <= 0) return 1; // Disabled → всегда комфортно

    // Нормализация калибрована под post-filter рынки (sp≤2, fv≤4, tps≥0.5).
    // «Нормальные» значения дают score ~0.85-0.95, score падает только при
    // реальном ухудшении условий в процессе торговли.

    // 1. Волатильность: range ≥ 6¢ → 0, ≤1¢ → 1 (фильтр пропускает ≤4¢)
    const volScore = Math.max(0, Math.min(1, 1 - Math.max(0, priceRangeCents - 1) / 5));

    // 2. Глубина: ≥ 50 единиц → 1 (реальные Polymarket стаканы ~20-100)
    const depthScore = Math.max(0, Math.min(1, topDepth / 50));

    // 3. Баланс стакана: |imbalance| ≤ 0.3 → 1, ≥ 0.8 → 0
    const balanceScore = Math.max(0, Math.min(1, (0.8 - Math.abs(bookImbalance)) / 0.5));

    // 4. Торговый поток (trades per second за последние ~warmup секунд)
    const elapsedSec = (snapshot.nowMs - this._marketEventStartMs) / 1000;
    const tps = elapsedSec > 0 ? this._tradeCount / elapsedSec : 0;
    // tps ≥ 0.5 → 1 (наш фильтр гарантирует ≥0.5 при входе)
    const flowScore = Math.max(0, Math.min(1, tps / 0.5));

    return (volScore + depthScore + balanceScore + flowScore) / 4;
  }

  // ── Метрики ─────────────────────────────────────────────────────────────────

  /**
   * Возвращает текущие метрики стратегии.
   *
   * @returns EWMA mid, trade count, gamma, qMax, calibration/unwind status
   */
  public override getMetrics(): Record<string, unknown> {
    return {
      ewma: this._ewma,
      tradeCount: this._tradeCount,
      gamma: this._gamma,
      qMax: this._qMax,
      dynamicQ: !!this._dynamicQ,
      spreadMult: this._spreadMult,
      skewMult: this._skewMult,
      unwindSec: this._unwindSec,
      unwindMaxDiscountCents: this._unwindMaxDiscountCents,
      hasCalibration: this._calibration !== null && this._calibration !== undefined,
      regimeWindow: this._regimeWindow,
      regimeTrendThreshold: this._regimeTrendThreshold,
      regimeRangeThreshold: this._regimeRangeThreshold,
    };
  }
}
