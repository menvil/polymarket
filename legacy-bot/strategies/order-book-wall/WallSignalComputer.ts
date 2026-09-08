/**
 * Вычислитель торгового сигнала на основе метрик поглощения стенок.
 *
 * @remarks
 * Stateless-модуль: принимает метрики поглощения → возвращает WallSignal.
 *
 * ### Стратегия: Rejection (Отбой) — основной режим
 *
 * Сигнал REJECTION генерируется когда **одновременно** выполнены три условия:
 * 1. **Wall intact** (стенка цела): absorptionRatio < rejectionMaxAbsorption
 * 2. **OutcomePrice tested** (цена протестировала уровень): tradeVolumeInWindow >= minWallTestVolume
 * 3. **Flow decelerated** (поток замедлился): recentRate < historicRate × flowDecelerationFactor
 *
 * ```
 * historicRate = tradeVolumeInWindow / windowMs     (BTC/ms за полное окно)
 * recentRate   = recentTradeVolume / recentWindowMs (BTC/ms за короткое окно)
 * decelerated  = recentRate < historicRate × flowDecelerationFactor
 * ```
 *
 * ### Сила сигнала:
 * ```
 * wallPower        = clamp(densityFactor / 10, 0, 1)
 * intactScore      = 1 - (absorptionRatio / rejectionMaxAbsorption)  ∈ [0, 1]
 * decelerationScore = clamp(1 - flowRatio / flowDecelerationFactor, 0, 1)
 * strength = wallPower × intactScore × decelerationScore
 * ```
 *
 * ### BREAKOUT — только для сигнала выхода:
 * - absorptionRatio >= 0.5 → стенка сломана → BREAKOUT_DOWN/UP
 *
 * @example
 * ```typescript
 * const signal = WallSignalComputer.compute(metrics, {
 *   minWallAgeMs: 3_000,
 *   rejectionMaxAbsorption: 0.2,
 *   minWallTestVolume: 0.05,
 *   flowDecelerationFactor: 0.4,
 *   windowMs: 30_000,
 *   recentWindowMs: 8_000,
 * });
 * if (signal.type === 'REJECTION_DOWN') { // BID-стенка держится → цена вверх }
 * ```
 */

import type { WallConsumptionMetrics, WallSignal, WallSignalType } from './types.js';

/** Параметры вычислителя сигнала. */
export interface WallSignalComputerParams {
  /**
   * Минимальный возраст стенки (мс) перед тем, как считаем сигнал надёжным.
   * Защита от spoof-ордеров.
   */
  readonly minWallAgeMs: number;
  /**
   * Максимальная доля поглощения для сигнала rejection.
   * absorptionRatio > rejectionMaxAbsorption → стенка рушится, сигнала нет.
   * По умолчанию 0.2 (стенка должна быть > 80% целой).
   */
  readonly rejectionMaxAbsorption: number;
  /**
   * Минимальный объём трейдов (BTC) в зоне стенки за полное окно.
   * Требуется чтобы убедиться, что цена тестировала уровень.
   */
  readonly minWallTestVolume: number;
  /**
   * Коэффициент замедления потока: recentRate / historicRate < factor → замедление.
   * Чем ниже — тем строже требование замедления.
   */
  readonly flowDecelerationFactor: number;
  /** Полное окно трекинга трейдов (мс) — для нормировки historicRate. */
  readonly windowMs: number;
  /** Короткое окно для оценки текущего потока (мс) — для нормировки recentRate. */
  readonly recentWindowMs: number;
}

/** Порог поглощения для сигнала BREAKOUT (выход из позиции). */
const BREAKOUT_ABSORPTION_THRESHOLD = 0.5;

/**
 * Stateless вычислитель торгового сигнала.
 */
export class WallSignalComputer {
  /**
   * Вычисляет торговый сигнал из метрик поглощения стенок.
   *
   * @param metrics - Метрики поглощения всех активных стенок
   * @param params - Параметры классификации
   * @returns WallSignal — сигнал с типом и силой
   *
   * @remarks
   * Приоритеты:
   * 1. REJECTION (primary entry) — все три условия выполнены.
   * 2. BREAKOUT (exit trigger) — стенка сломана на 50%+.
   * 3. NEUTRAL — нет чёткого сигнала.
   *
   * При нескольких стенках одного типа — выбирается с максимальной силой.
   * REJECTION имеет приоритет над BREAKOUT (мы ищем отбой, не пробой).
   *
   * @example
   * ```typescript
   * const signal = WallSignalComputer.compute(metrics, params);
   * console.log(signal.type, signal.strength.toFixed(3));
   * ```
   */
  public static compute(
    metrics: readonly WallConsumptionMetrics[],
    params: WallSignalComputerParams,
  ): WallSignal {
    if (metrics.length === 0) {
      return { type: 'NEUTRAL', strength: 0 };
    }

    const {
      minWallAgeMs,
      rejectionMaxAbsorption,
      minWallTestVolume,
      flowDecelerationFactor,
      windowMs,
      recentWindowMs,
    } = params;

    let bestRejection: WallSignal | undefined;
    let bestBreakout: WallSignal | undefined;

    for (const m of metrics) {
      if (m.ageMs < minWallAgeMs) continue;

      const isAsk = m.wall.side === 'ask';

      // ── BREAKOUT: стенка значительно поглощена (сигнал выхода) ─────────────
      if (m.absorptionRatio >= BREAKOUT_ABSORPTION_THRESHOLD) {
        const signalType: WallSignalType = isAsk ? 'BREAKOUT_UP' : 'BREAKOUT_DOWN';
        const strength = WallSignalComputer._breakoutStrength(m);
        if (!bestBreakout || strength > bestBreakout.strength) {
          bestBreakout = { type: signalType, strength, sourceWall: m.wall, sourceMetrics: m };
        }
        continue;
      }

      // ── REJECTION: отбой от стенки (основной сигнал входа) ──────────────────

      // Условие 1: стенка цела
      if (m.absorptionRatio >= rejectionMaxAbsorption) continue;

      // Условие 2: цена протестировала уровень
      if (m.tradeVolumeInWindow < minWallTestVolume) continue;

      // Условие 3: поток трейдов замедлился
      const historicRate = windowMs > 0 ? m.tradeVolumeInWindow / windowMs : 0;
      const recentRate = recentWindowMs > 0 ? m.recentTradeVolume / recentWindowMs : 0;
      const flowRatio = historicRate > 0 ? recentRate / historicRate : 0;
      if (flowRatio >= flowDecelerationFactor) continue;

      const signalType: WallSignalType = isAsk ? 'REJECTION_UP' : 'REJECTION_DOWN';
      const strength = WallSignalComputer._rejectionStrength(
        m,
        rejectionMaxAbsorption,
        flowDecelerationFactor,
        flowRatio,
      );

      if (!bestRejection || strength > bestRejection.strength) {
        bestRejection = { type: signalType, strength, sourceWall: m.wall, sourceMetrics: m };
      }
    }

    // REJECTION имеет приоритет: это наш основной сигнал входа
    if (bestRejection) return bestRejection;
    if (bestBreakout) return bestBreakout;
    return { type: 'NEUTRAL', strength: 0 };
  }

  /**
   * Сила сигнала REJECTION.
   *
   * @remarks
   * strength = wallPower × intactScore × decelerationScore
   * - wallPower: плотность стенки (densityFactor / 10, макс 1)
   * - intactScore: насколько стенка цела (1 → нетронута, 0 → у порога)
   * - decelerationScore: насколько поток замедлился (1 → полностью остановился, 0 → у порога)
   */
  private static _rejectionStrength(
    m: WallConsumptionMetrics,
    rejectionMaxAbsorption: number,
    flowDecelerationFactor: number,
    flowRatio: number,
  ): number {
    const wallPower = Math.min(1, m.wall.densityFactor / 10);
    const intactScore = 1 - (m.absorptionRatio / Math.max(rejectionMaxAbsorption, 0.01));
    const decelerationScore = Math.min(1, 1 - flowRatio / Math.max(flowDecelerationFactor, 0.01));
    return Math.min(1, Math.max(0, wallPower * intactScore * decelerationScore));
  }

  /**
   * Сила сигнала BREAKOUT.
   *
   * @remarks
   * strength = absorptionExcess × densityScore
   * Чем выше поглощение и плотнее стенка — тем увереннее пробой.
   */
  private static _breakoutStrength(m: WallConsumptionMetrics): number {
    const absorptionExcess = Math.min(
      1,
      (m.absorptionRatio - BREAKOUT_ABSORPTION_THRESHOLD) /
        Math.max(1 - BREAKOUT_ABSORPTION_THRESHOLD, 0.01),
    );
    const densityScore = Math.min(1, m.wall.densityFactor / 10);
    return Math.min(1, Math.max(0, absorptionExcess * densityScore));
  }
}
