/**
 * DirtyTracker — отслеживает какие стратегии требуют пересчёта и почему.
 *
 * @remarks
 * ### Назначение:
 * Является центральным звеном между state stores и StrategyScheduler.
 * Когда state store обновляется (TopOfBook, Trade, Fill, OrderUpdate),
 * он вызывает `markDirty(strategyId, reason)`.
 * StrategyScheduler проверяет `isDirty()` и `hasPriorityTrigger()`
 * чтобы решить, пора ли вызывать tick().
 *
 * ### Семантика:
 * - `markDirty()` — накапливает reasons (Set: несколько BOOK подряд = один BOOK)
 * - `isDirty()` — есть хотя бы один reason
 * - `getReasons()` — все накопленные reasons (передаются в tick())
 * - `clearDirty()` — сбрасывает после tick() (стратегия обработала данные)
 * - `hasPriorityTrigger()` — есть ли reason из priorityTriggers (bypass throttle)
 * - `remove()` — полная очистка при unregister стратегии
 *
 * ### Потокобезопасность:
 * Однопоточный (Node.js event loop). markDirty и clearDirty
 * не пересекаются — clearDirty вызывается только из _processQueue
 * после shift из очереди.
 *
 * @example
 * ```typescript
 * const tracker = new DirtyTracker();
 *
 * tracker.markDirty('strategy-1', 'BOOK');
 * tracker.markDirty('strategy-1', 'TRADE');
 * tracker.isDirty('strategy-1');              // true
 * tracker.getReasons('strategy-1');           // Set { 'BOOK', 'TRADE' }
 * tracker.hasPriorityTrigger('strategy-1', new Set(['FILL'])); // false
 *
 * tracker.clearDirty('strategy-1');
 * tracker.isDirty('strategy-1');              // false
 * ```
 */
import type { TriggerReason } from './types/TriggerReason.js';

export class DirtyTracker {
  /** strategyId → Set<TriggerReason> */
  private readonly _dirty = new Map<string, Set<TriggerReason>>();

  /**
   * Помечает стратегию как dirty с указанной причиной.
   *
   * @param strategyId - ID стратегии
   * @param reason - Что изменилось (BOOK, TRADE, FILL, ORDER_UPDATE, TIMER)
   *
   * @remarks
   * Reasons накапливаются: несколько BOOK подряд → один BOOK в Set.
   * Несколько разных reasons → все в Set.
   */
  public markDirty(strategyId: string, reason: TriggerReason): void {
    let reasons = this._dirty.get(strategyId);
    if (reasons === undefined) {
      reasons = new Set<TriggerReason>();
      this._dirty.set(strategyId, reasons);
    }
    reasons.add(reason);
  }

  /**
   * Проверяет есть ли хотя бы один reason для стратегии.
   *
   * @param strategyId - ID стратегии
   * @returns true если стратегия dirty (есть данные для пересчёта)
   */
  public isDirty(strategyId: string): boolean {
    const reasons = this._dirty.get(strategyId);
    return reasons !== undefined && reasons.size > 0;
  }

  /**
   * Возвращает все накопленные reasons для стратегии.
   *
   * @param strategyId - ID стратегии
   * @returns ReadonlySet с reasons. Пустой Set если стратегия не dirty.
   *
   * @remarks
   * Возвращает **копию** — модификация не влияет на внутреннее состояние.
   * Передаётся в tick() чтобы стратегия знала что именно изменилось.
   */
  public getReasons(strategyId: string): ReadonlySet<TriggerReason> {
    const reasons = this._dirty.get(strategyId);
    if (reasons === undefined || reasons.size === 0) {
      return _EMPTY_SET;
    }
    return new Set(reasons);
  }

  /**
   * Сбрасывает dirty флаг стратегии.
   *
   * @param strategyId - ID стратегии
   *
   * @remarks
   * Вызывается StrategyScheduler после tick() — стратегия обработала данные.
   * Если новые события придут во время execute() — markDirty снова поставит флаг.
   */
  public clearDirty(strategyId: string): void {
    const reasons = this._dirty.get(strategyId);
    if (reasons !== undefined) {
      reasons.clear();
    }
  }

  /**
   * Проверяет есть ли priority trigger среди накопленных reasons.
   *
   * @param strategyId - ID стратегии
   * @param priorities - Набор priority triggers из ScheduleConfig
   * @returns true если хотя бы один reason входит в priorities
   *
   * @remarks
   * Priority triggers (обычно FILL) игнорируют minIntervalMs throttle.
   * Стратегия получает tick немедленно — без ожидания.
   */
  public hasPriorityTrigger(
    strategyId: string,
    priorities: ReadonlySet<TriggerReason>,
  ): boolean {
    const reasons = this._dirty.get(strategyId);
    if (reasons === undefined || reasons.size === 0) return false;
    for (const reason of reasons) {
      if (priorities.has(reason)) return true;
    }
    return false;
  }

  /**
   * Полностью удаляет стратегию из трекинга.
   *
   * @param strategyId - ID стратегии
   *
   * @remarks
   * Вызывается при unregister стратегии из StrategyScheduler.
   * После remove() isDirty/getReasons возвращают false/empty.
   */
  public remove(strategyId: string): void {
    this._dirty.delete(strategyId);
  }
}

/** Singleton пустой Set для getReasons() — не аллоцируем каждый раз */
const _EMPTY_SET: ReadonlySet<TriggerReason> = new Set();
