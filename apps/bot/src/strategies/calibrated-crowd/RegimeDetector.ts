/**
 * RegimeDetector — классификация тренда BTC по slope $/min за 60s.
 *
 * @remarks
 * Режим — одна из трёх меток, используемых как 4-е измерение таблицы зон:
 * - `up`   — slope > +threshold
 * - `flat` — |slope| < threshold
 * - `down` — slope < −threshold
 *
 * Slope считается тем же способом, которым строится edge-таблица:
 * `(currentPrice − priceAtOrBeforeWindowStart) / Δt`.
 *
 * **Почему приоритет chainlink:**
 *   таблица зон строилась по Chainlink oracle (тот же источник, что даёт
 *   резолюцию Polymarket). Binance — fallback если chainlink молчит.
 *
 * @example
 * ```typescript
 * const detector = new RegimeDetector({ asset: 'btc', thresholdPerMin: 10, windowMs: 60_000 });
 * const regime = detector.classify(snapshot.cryptoPriceHistory, snapshot.nowMs);
 * // → 'up' | 'flat' | 'down' | undefined (если истории мало)
 * ```
 */
import type {
  CryptoPriceHistoryView,
  CryptoPriceSource,
} from '@polymarket/strategy';
import type { Regime } from './EdgeTable.js';

/**
 * Конфигурация детектора.
 *
 * @param thresholdPerMin - Порог $/min: |slope| ниже → flat (default 10)
 * @param windowMs - Окно истории в ms (default 60_000)
 * @param minPoints - Минимум точек в окне истории (default 5)
 * @param sources - Источники цен по приоритету (default chainlink → binance)
 */
export interface RegimeDetectorConfig {
  readonly thresholdPerMin?: number;
  readonly windowMs?: number;
  readonly minPoints?: number;
  readonly sources?: readonly CryptoPriceSource[];
}

/** Результат диагностики — для логирования. */
export interface RegimeClassification {
  readonly regime: Regime;
  readonly slopePerMin: number;
  readonly source: CryptoPriceSource;
  readonly points: number;
}

export class RegimeDetector {
  private readonly _threshold: number;
  private readonly _windowMs: number;
  private readonly _minPoints: number;
  private readonly _sources: readonly CryptoPriceSource[];

  constructor(config: RegimeDetectorConfig = {}) {
    this._threshold = config.thresholdPerMin ?? 10;
    this._windowMs = config.windowMs ?? 60_000;
    this._minPoints = config.minPoints ?? 5;
    const defaultSources: readonly CryptoPriceSource[] = ['polymarket_chainlink', 'polymarket_binance'];
    this._sources = config.sources ?? defaultSources;
  }

  /**
   * Классифицировать режим по истории.
   *
   * @param history - `snapshot.cryptoPriceHistory` (живёт по asset, переживает rotation)
   * @param nowMs - Опорное время (`snapshot.nowMs`). Привязывает окно к настоящему
   *   моменту, исключая устаревшие/будущие точки (анти look-ahead в бэктесте).
   * @returns Режим + диагностика, или `undefined` если данных мало
   */
  classify(history: CryptoPriceHistoryView | undefined, nowMs?: number): RegimeClassification | undefined {
    if (!history) return undefined;

    for (const source of this._sources) {
      // Берём небольшой запас, чтобы найти точку <= now-windowMs, как в
      // scripts/analyze-crowd-calibration.ts::computeTrendSlope().
      const points = history.getRecent(source, this._windowMs + 5_000, nowMs);
      if (points.length < this._minPoints) continue;

      const slope = tableCompatibleSlopePerMin(points, this._windowMs);
      if (slope === undefined) continue;

      let regime: Regime;
      if (slope > this._threshold) regime = 'up';
      else if (slope < -this._threshold) regime = 'down';
      else regime = 'flat';

      return { regime, slopePerMin: slope, source, points: points.length };
    }
    return undefined;
  }
}

// ── Table-compatible slope helper ────────────────────────────────────────────

/**
 * Наклон, совместимый с генератором edge-таблицы, возвращается в $/min.
 *
 * @returns slope ($/min) или undefined если точки одинаковы по времени
 */
function tableCompatibleSlopePerMin(
  points: readonly { readonly price: number; readonly exchangeTsMs: number }[],
  windowMs: number,
): number | undefined {
  const n = points.length;
  if (n < 2) return undefined;

  const current = points[n - 1]!;
  const targetTs = current.exchangeTsMs - windowMs;
  let base: typeof current | undefined;
  for (let i = n - 1; i >= 0; i--) {
    if (points[i]!.exchangeTsMs <= targetTs) {
      base = points[i];
      break;
    }
  }
  base ??= points[0];

  const dtMin = (current.exchangeTsMs - base.exchangeTsMs) / 60_000;
  if (dtMin <= 0) return undefined;
  return (current.price - base.price) / dtMin;
}
