/**
 * Трекер поглощения стенок (Consumption Tracker).
 *
 * @remarks
 * Stateful-модуль: хранит состояние каждой стенки между тиками.
 *
 * ### Алгоритм:
 * 1. При первом появлении стенки: запоминаем initialSize и время.
 * 2. При каждом тике: обновляем currentSize из свежего снапшота книги.
 * 3. Трейды в диапазоне стенки прибавляются к tradeVolumeInWindow.
 * 4. Старые записи (стенка исчезла дольше чем ttlMs назад) удаляются.
 * 5. Метрики: absorptionRatio = (initial - current) / initial.
 * 6. recentTradeVolume: объём трейдов за последние recentWindowMs (детекция замедления потока).
 *
 * @example
 * ```typescript
 * const tracker = new ConsumptionTracker({
 *   windowMs: 30_000,
 *   recentWindowMs: 8_000,
 *   ttlMs: 60_000,
 * });
 *
 * // каждый тик:
 * tracker.updateFromBook(currentWalls, nowMs);
 * tracker.recordTrades(trades, nowMs);
 * const metrics = tracker.computeMetrics(currentWalls, nowMs);
 * ```
 */

import type { DetectedWall, WallConsumptionMetrics, WallConsumptionState } from './types.js';
import { wallKey } from './WallDetector.js';

/** Параметры трекера поглощения. */
export interface ConsumptionTrackerParams {
  /** Полное окно накопления трейдов (мс). После этого tradeVolume обнуляется. */
  readonly windowMs: number;
  /**
   * Короткое окно для оценки текущего потока (мс).
   * Сравнивается с полным окном для детекции замедления.
   */
  readonly recentWindowMs: number;
  /** TTL записи: удаляем стенку если она не обновлялась дольше ttlMs (мс). */
  readonly ttlMs: number;
}

/** Запись трейда для трекинга поглощения. */
export interface TradeRecord {
  readonly price: number;
  readonly size: number;
  readonly timestampMs: number;
}

/**
 * Stateful трекер поглощения стенок.
 */
export class ConsumptionTracker {
  private readonly _windowMs: number;
  private readonly _recentWindowMs: number;
  private readonly _ttlMs: number;

  /**
   * Текущие состояния по ключу стенки.
   * Ключ = `${side}:${Math.round(centerPrice)}`.
   */
  private readonly _states = new Map<string, WallConsumptionState>();

  /**
   * Очередь трейдов с временными метками (для скользящего окна).
   * Хранятся только трейды, которые попали в диапазон хотя бы одной стенки.
   */
  private readonly _tradeQueue: Array<{ key: string; size: number; tsMs: number }> = [];

  /**
   * Создаёт новый трекер поглощения.
   *
   * @param params - Параметры окна и TTL
   *
   * @example
   * ```typescript
   * const tracker = new ConsumptionTracker({
   *   windowMs: 30_000,
   *   recentWindowMs: 8_000,
   *   ttlMs: 60_000,
   * });
   * ```
   */
  public constructor(params: ConsumptionTrackerParams) {
    this._windowMs = params.windowMs;
    this._recentWindowMs = params.recentWindowMs;
    this._ttlMs = params.ttlMs;
  }

  /**
   * Обновляет состояния стенок на основе свежего снапшота книги.
   *
   * @param currentWalls - Стенки, обнаруженные на текущем тике
   * @param nowMs - Текущее время (Unix ms)
   *
   * @remarks
   * - Новые стенки (ключа нет в state): инициализируем с initialSize = totalSize.
   * - Существующие стенки: обновляем currentSize.
   * - Стенки, отсутствующие в currentWalls дольше ttlMs: удаляем.
   * - Стенки, которые исчезли (currentSize → 0): считаем полностью поглощёнными.
   */
  public updateFromBook(currentWalls: readonly DetectedWall[], nowMs: number): void {
    const currentKeys = new Set<string>();

    for (const wall of currentWalls) {
      const key = wallKey(wall.side, wall.centerPrice);
      currentKeys.add(key);

      const existing = this._states.get(key);
      if (existing) {
        existing.currentSize = wall.totalSize;
        existing.lastUpdatedMs = nowMs;
      } else {
        this._states.set(key, {
          key,
          initialSize: wall.totalSize,
          currentSize: wall.totalSize,
          tradeVolumeInWindow: 0,
          firstSeenMs: nowMs,
          lastUpdatedMs: nowMs,
        });
      }
    }

    // Стенки не видны в текущем снапшоте: помечаем currentSize = 0 (исчезли)
    for (const [key, state] of this._states) {
      if (!currentKeys.has(key)) {
        if (state.currentSize > 0) {
          state.currentSize = 0;
          state.lastUpdatedMs = nowMs;
        }
        // Удаляем если прошло больше ttlMs с момента исчезновения
        if (nowMs - state.lastUpdatedMs > this._ttlMs) {
          this._states.delete(key);
        }
      }
    }
  }

  /**
   * Записывает трейды и атрибутирует объём к соответствующим стенкам.
   *
   * @param trades - Список трейдов за последний тик
   * @param activeWalls - Текущий список стенок (для определения диапазонов)
   * @param nowMs - Текущее время (Unix ms)
   *
   * @remarks
   * Трейд «попадает в стенку» если его цена находится в диапазоне [priceLow, priceHigh].
   * После добавления — вычищаем из очереди записи старше windowMs.
   */
  public recordTrades(
    trades: readonly TradeRecord[],
    activeWalls: readonly DetectedWall[],
    nowMs: number,
  ): void {
    for (const trade of trades) {
      for (const wall of activeWalls) {
        if (trade.price >= wall.priceLow && trade.price <= wall.priceHigh) {
          const key = wallKey(wall.side, wall.centerPrice);
          const state = this._states.get(key);
          if (state) {
            state.tradeVolumeInWindow += trade.size;
            this._tradeQueue.push({ key, size: trade.size, tsMs: trade.timestampMs });
          }
        }
      }
    }

    // Удаляем старые трейды из скользящего окна
    const cutoff = nowMs - this._windowMs;
    let i = 0;
    while (i < this._tradeQueue.length && this._tradeQueue[i].tsMs < cutoff) {
      const old = this._tradeQueue[i];
      const state = this._states.get(old.key);
      if (state) {
        state.tradeVolumeInWindow = Math.max(0, state.tradeVolumeInWindow - old.size);
      }
      i++;
    }
    if (i > 0) this._tradeQueue.splice(0, i);
  }

  /**
   * Вычисляет метрики поглощения для всех активных стенок.
   *
   * @param currentWalls - Текущий список обнаруженных стенок
   * @param nowMs - Текущее время (Unix ms)
   * @returns Метрики поглощения для каждой стенки
   *
   * @remarks
   * recentTradeVolume вычисляется напрямую из _tradeQueue за последние recentWindowMs мс.
   * Используется для детекции замедления потока: если recent << historic → поток упал.
   *
   * @example
   * ```typescript
   * const metrics = tracker.computeMetrics(walls, Date.now());
   * for (const m of metrics) {
   *   const decelerated = m.recentTradeVolume < m.tradeVolumeInWindow * 0.1;
   *   if (m.absorptionRatio < 0.2 && decelerated) console.log('Rejection signal!');
   * }
   * ```
   */
  public computeMetrics(
    currentWalls: readonly DetectedWall[],
    nowMs: number,
  ): WallConsumptionMetrics[] {
    const recentCutoff = nowMs - this._recentWindowMs;

    // Считаем recentTradeVolume по всем ключам за один проход по очереди
    const recentByKey = new Map<string, number>();
    for (const record of this._tradeQueue) {
      if (record.tsMs >= recentCutoff) {
        recentByKey.set(record.key, (recentByKey.get(record.key) ?? 0) + record.size);
      }
    }

    const result: WallConsumptionMetrics[] = [];

    for (const wall of currentWalls) {
      const key = wallKey(wall.side, wall.centerPrice);
      const state = this._states.get(key);
      if (!state) continue;

      const absorbed = state.initialSize - state.currentSize;
      const absorptionRatio = state.initialSize > 0
        ? Math.min(1, Math.max(0, absorbed / state.initialSize))
        : 0;

      result.push({
        wall,
        absorptionRatio,
        tradeVolumeInWindow: state.tradeVolumeInWindow,
        recentTradeVolume: recentByKey.get(key) ?? 0,
        ageMs: nowMs - state.firstSeenMs,
      });
    }

    return result;
  }

  /**
   * Очищает все состояния (при смене рынка).
   */
  public reset(): void {
    this._states.clear();
    this._tradeQueue.splice(0);
  }

  /** Количество отслеживаемых стенок (для диагностики). */
  public get trackedCount(): number {
    return this._states.size;
  }
}
