/**
 * Детектор «стенок» в стакане CEX-биржи.
 *
 * @remarks
 * Stateless-модуль: принимает снапшот стакана, возвращает список обнаруженных стенок.
 *
 * ### Алгоритм:
 * 1. Вычислить mid = (bestBid + bestAsk) / 2.
 * 2. Разбить уровни на бэнды шириной `bandSizePct` от mid.
 * 3. Суммировать объём в каждом бэнде.
 * 4. Вычислить среднее по всем непустым бэндам и стандартное отклонение.
 * 5. Бэнд с density > mean × wallThresholdFactor
 *    и totalSize >= minWallSize считать «стенкой».
 * 6. Возвращать все найденные стенки.
 *
 * @example
 * ```typescript
 * const walls = WallDetector.detect(bids, asks, nowMs, {
 *   bandSizePct: 0.002,
 *   wallThresholdFactor: 3,
 *   minWallSize: 300_000,
 * });
 * ```
 */

import type { DetectedWall, WallSide } from './types.js';

/** Параметры детектора стенок. */
export interface WallDetectorParams {
  /** Ширина бэнда как доля от mid. По умолчанию 0.002. */
  readonly bandSizePct: number;
  /** Коэффициент превышения среднего для признания стенкой. По умолчанию 3.0. */
  readonly wallThresholdFactor: number;
  /** Минимальный абсолютный объём стенки. По умолчанию 300 000. */
  readonly minWallSize: number;
}

/** Уровень стакана в сыром виде (цена, объём). */
export type RawLevel = readonly [price: number, size: number];

/**
 * Stateless детектор стенок в стакане ордеров.
 */
export class WallDetector {
  /**
   * Обнаруживает стенки в стакане ордеров.
   *
   * @param bids - Уровни покупки (price, size), отсортированные по убыванию цены
   * @param asks - Уровни продажи (price, size), отсортированные по возрастанию цены
   * @param nowMs - Текущее время (Unix ms)
   * @param params - Параметры детектора
   * @returns Список обнаруженных стенок (пустой если ничего не найдено)
   *
   * @remarks
   * Если стакан пустой или нельзя вычислить mid — возвращает [].
   * Стенки со стороны bid означают поддержку (цена держится),
   * со стороны ask — сопротивление (цена давится вниз).
   *
   * @example
   * ```typescript
   * const walls = WallDetector.detect(
   *   [[65000, 10], [64900, 500000], [64800, 5]],
   *   [[65100, 8], [65200, 3]],
   *   Date.now(),
   *   { bandSizePct: 0.002, wallThresholdFactor: 3, minWallSize: 300_000 }
   * );
   * // walls[0] = { side: 'bid', centerPrice: 64900, totalSize: 500000, ... }
   * ```
   */
  public static detect(
    bids: readonly RawLevel[],
    asks: readonly RawLevel[],
    nowMs: number,
    params: WallDetectorParams,
  ): DetectedWall[] {
    if (bids.length === 0 && asks.length === 0) return [];

    const bestBid = bids[0]?.[0];
    const bestAsk = asks[0]?.[0];
    if (bestBid === undefined || bestAsk === undefined) return [];
    if (bestBid >= bestAsk) return [];

    const mid = (bestBid + bestAsk) / 2;
    const { bandSizePct, wallThresholdFactor, minWallSize } = params;
    const bandWidth = mid * bandSizePct;

    const bidBands = WallDetector._buildBands(bids, bandWidth);
    const askBands = WallDetector._buildBands(asks, bandWidth);

    const allDensities = [
      ...Array.from(bidBands.values()),
      ...Array.from(askBands.values()),
    ].map((b) => b.totalSize);

    if (allDensities.length === 0) return [];

    const mean = allDensities.reduce((s, v) => s + v, 0) / allDensities.length;
    const threshold = mean * wallThresholdFactor;

    const walls: DetectedWall[] = [];

    for (const [centerKey, band] of bidBands) {
      const center = Number(centerKey);
      if (band.totalSize >= threshold && band.totalSize >= minWallSize) {
        walls.push({
          side: 'bid',
          priceLow: center - bandWidth / 2,
          priceHigh: center + bandWidth / 2,
          centerPrice: center,
          totalSize: band.totalSize,
          densityFactor: mean > 0 ? band.totalSize / mean : 0,
          detectedAtMs: nowMs,
        });
      }
    }

    for (const [centerKey, band] of askBands) {
      const center = Number(centerKey);
      if (band.totalSize >= threshold && band.totalSize >= minWallSize) {
        walls.push({
          side: 'ask',
          priceLow: center - bandWidth / 2,
          priceHigh: center + bandWidth / 2,
          centerPrice: center,
          totalSize: band.totalSize,
          densityFactor: mean > 0 ? band.totalSize / mean : 0,
          detectedAtMs: nowMs,
        });
      }
    }

    return walls;
  }

  /**
   * Группирует уровни стакана в бэнды фиксированной ширины.
   *
   * @param levels - Уровни (price, size)
   * @param bandWidth - Ширина бэнда в единицах цены
   * @returns Map от centerPrice (округлённый) к суммарному объёму бэнда
   *
   * @remarks
   * Center бэнда = Math.round(price / bandWidth) * bandWidth.
   * Таким образом каждый уровень попадает ровно в один бэнд.
   */
  private static _buildBands(
    levels: readonly RawLevel[],
    bandWidth: number,
  ): Map<number, { totalSize: number }> {
    const bands = new Map<number, { totalSize: number }>();
    for (const [price, size] of levels) {
      if (size <= 0 || !Number.isFinite(price) || !Number.isFinite(size)) continue;
      const center = Math.round(price / bandWidth) * bandWidth;
      const existing = bands.get(center);
      if (existing) {
        existing.totalSize += size;
      } else {
        bands.set(center, { totalSize: size });
      }
    }
    return bands;
  }
}

/**
 * Формирует ключ стенки для ConsumptionTracker.
 *
 * @param side - Сторона стакана
 * @param centerPrice - Центральная цена бэнда
 * @returns Строковый ключ вида `bid:65000` или `ask:65200`
 */
export function wallKey(side: WallSide, centerPrice: number): string {
  return `${side}:${Math.round(centerPrice)}`;
}
