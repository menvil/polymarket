/**
 * Порт таймеров для StrategyScheduler — детерминизм в replay/backtest.
 *
 * @remarks
 * ### Зачем:
 * Прямые вызовы `setTimeout`/`setInterval` в business-оркестрации делают
 * поведение недетерминированным в backtest: `ReplayClock` двигает время
 * мгновенно, а wall-clock таймеры продолжают ждать реальные миллисекунды.
 * Порт позволяет:
 * - в production использовать Node-таймеры ({@link NodeSchedulerTimer});
 * - в replay/backtest — детерминированный адаптер
 *   ({@link DeterministicSchedulerTimer}), который срабатывает при явном
 *   продвижении виртуального времени.
 *
 * ### Handle-модель:
 * `TimerHandle` — непрозрачный токен `{ id }`, который выдаёт реализация.
 * Никаких `NodeJS.Timeout` в сигнатурах порта — вызывающий код не зависит
 * от платформы и не требует кастов.
 *
 * @example
 * ```typescript
 * const timer: ISchedulerTimer = new NodeSchedulerTimer();
 * const handle = timer.setTimeout(() => doWork(), 100);
 * timer.clearTimeout(handle);
 * ```
 */

/** Непрозрачный токен таймера (выдаётся реализацией порта). */
export interface TimerHandle {
  /** Внутренний ID таймера в рамках реализации. */
  readonly id: number;
}

/**
 * Порт таймеров планировщика.
 *
 * @remarks
 * Семантика соответствует Node `setTimeout`/`setInterval`, но handle —
 * непрозрачный {@link TimerHandle}. `clear*` с неизвестным/уже отменённым
 * handle — безопасный no-op.
 */
export interface ISchedulerTimer {
  /**
   * Планирует однократный вызов callback через delayMs.
   *
   * @param callback - Функция для вызова
   * @param delayMs - Задержка в миллисекундах (>= 0)
   * @returns Handle для отмены через {@link ISchedulerTimer.clearTimeout}
   */
  setTimeout(callback: () => void, delayMs: number): TimerHandle;

  /**
   * Отменяет запланированный однократный вызов.
   *
   * @param handle - Handle из {@link ISchedulerTimer.setTimeout}
   */
  clearTimeout(handle: TimerHandle): void;

  /**
   * Планирует периодический вызов callback каждые intervalMs.
   *
   * @param callback - Функция для вызова
   * @param intervalMs - Интервал в миллисекундах (> 0)
   * @returns Handle для отмены через {@link ISchedulerTimer.clearInterval}
   */
  setInterval(callback: () => void, intervalMs: number): TimerHandle;

  /**
   * Отменяет периодический вызов.
   *
   * @param handle - Handle из {@link ISchedulerTimer.setInterval}
   */
  clearInterval(handle: TimerHandle): void;
}

/**
 * Production-адаптер: Node-таймеры с `unref()` (не держат event loop).
 *
 * @remarks
 * Handle-таблицы внутренние (`Map<number, NodeJS.Timeout>`), наружу выдаётся
 * только `{ id }` — ноль кастов, ноль платформенных типов в порту.
 *
 * @example
 * ```typescript
 * const timer = new NodeSchedulerTimer();
 * const h = timer.setInterval(() => heartbeat(), 5000);
 * timer.clearInterval(h);
 * ```
 */
export class NodeSchedulerTimer implements ISchedulerTimer {
  private _nextId = 1;
  private readonly _timeouts = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly _intervals = new Map<number, ReturnType<typeof setInterval>>();

  public setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const id = this._nextId++;
    const native = setTimeout(() => {
      this._timeouts.delete(id);
      callback();
    }, delayMs);
    native.unref?.();
    this._timeouts.set(id, native);
    return { id };
  }

  public clearTimeout(handle: TimerHandle): void {
    const native = this._timeouts.get(handle.id);
    if (native !== undefined) {
      clearTimeout(native);
      this._timeouts.delete(handle.id);
    }
  }

  public setInterval(callback: () => void, intervalMs: number): TimerHandle {
    const id = this._nextId++;
    const native = setInterval(callback, intervalMs);
    native.unref?.();
    this._intervals.set(id, native);
    return { id };
  }

  public clearInterval(handle: TimerHandle): void {
    const native = this._intervals.get(handle.id);
    if (native !== undefined) {
      clearInterval(native);
      this._intervals.delete(handle.id);
    }
  }
}

/** Внутренняя запись детерминированного таймера. */
interface ScheduledEntry {
  readonly id: number;
  /** Время срабатывания (virtual ms). */
  dueAtMs: number;
  /** Интервал повторения (undefined для однократных). */
  readonly intervalMs: number | undefined;
  readonly callback: () => void;
  /** Порядковый номер вставки — детерминированный tie-break при равном dueAt. */
  readonly seq: number;
}

/**
 * Детерминированный адаптер таймеров для replay/backtest.
 *
 * @remarks
 * Таймеры срабатывают ТОЛЬКО при явном продвижении виртуального времени
 * (`advanceTo(nowMs)` / `advance(deltaMs)`), в детерминированном порядке:
 * сначала по `dueAtMs`, затем по порядку постановки (`seq`). Повтор одного
 * replay с одинаковыми входами даёт одинаковую последовательность вызовов.
 *
 * Интеграция с `ReplayClock`: backtest-цикл после каждого события вызывает
 * `advanceTo(clock.now().getTime())` — просроченные heartbeat/deferred
 * таймеры срабатывают синхронно, без ожидания wall-clock.
 *
 * @example
 * ```typescript
 * const timer = new DeterministicSchedulerTimer(0);
 * timer.setTimeout(() => console.log('fired'), 100);
 * timer.advanceTo(100); // → 'fired' (синхронно)
 * ```
 */
export class DeterministicSchedulerTimer implements ISchedulerTimer {
  private _nextId = 1;
  private _nextSeq = 1;
  private _nowMs: number;
  private readonly _entries = new Map<number, ScheduledEntry>();

  /**
   * @param startMs - Начальное виртуальное время (epoch ms, по умолчанию 0)
   */
  constructor(startMs = 0) {
    this._nowMs = startMs;
  }

  /** Текущее виртуальное время (ms). */
  public get nowMs(): number {
    return this._nowMs;
  }

  public setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const id = this._nextId++;
    this._entries.set(id, {
      id,
      dueAtMs: this._nowMs + Math.max(0, delayMs),
      intervalMs: undefined,
      callback,
      seq: this._nextSeq++,
    });
    return { id };
  }

  public clearTimeout(handle: TimerHandle): void {
    this._entries.delete(handle.id);
  }

  public setInterval(callback: () => void, intervalMs: number): TimerHandle {
    const id = this._nextId++;
    const interval = Math.max(1, intervalMs);
    this._entries.set(id, {
      id,
      dueAtMs: this._nowMs + interval,
      intervalMs: interval,
      callback,
      seq: this._nextSeq++,
    });
    return { id };
  }

  public clearInterval(handle: TimerHandle): void {
    this._entries.delete(handle.id);
  }

  /**
   * Продвигает виртуальное время до nowMs и синхронно исполняет просроченные таймеры.
   *
   * @param nowMs - Новое виртуальное время (ms); движение назад игнорируется
   *
   * @remarks
   * Порядок исполнения детерминирован: (dueAtMs, seq). Интервальные таймеры
   * перепланируются и могут сработать несколько раз за один advance.
   * Исключение из callback НЕ прерывает остальные таймеры (логировать должен
   * сам callback — у адаптера нет logger-зависимости).
   *
   * ### Zero-delay edge case:
   * Guard — строго `nowMs < this._nowMs` (не `<=`). Таймер, поставленный
   * с `delayMs=0` в ТЕКУЩИЙ момент (`dueAtMs === this._nowMs`), обязан
   * сработать при следующем `advanceTo(this._nowMs)` — даже когда время
   * формально не продвигается. Прежний guard `nowMs <= this._nowMs` считал
   * такой вызов no-op и молча терял due-таймер.
   */
  public advanceTo(nowMs: number): void {
    if (nowMs < this._nowMs) return;

    // Цикл: на каждом шаге берём самый ранний просроченный таймер.
    // Пере-сканирование после каждого срабатывания корректно обрабатывает
    // таймеры, поставленные из callback других таймеров.
    for (;;) {
      let next: ScheduledEntry | undefined;
      for (const entry of this._entries.values()) {
        if (entry.dueAtMs > nowMs) continue;
        if (
          next === undefined ||
          entry.dueAtMs < next.dueAtMs ||
          (entry.dueAtMs === next.dueAtMs && entry.seq < next.seq)
        ) {
          next = entry;
        }
      }
      if (next === undefined) break;

      // Время «догоняет» момент срабатывания до вызова callback.
      this._nowMs = Math.max(this._nowMs, next.dueAtMs);
      if (next.intervalMs !== undefined) {
        next.dueAtMs = next.dueAtMs + next.intervalMs;
      } else {
        this._entries.delete(next.id);
      }
      try {
        next.callback();
      } catch {
        // Изоляция: сбой одного callback не прерывает остальные таймеры.
      }
    }

    this._nowMs = nowMs;
  }

  /**
   * Продвигает виртуальное время на deltaMs вперёд.
   *
   * @param deltaMs - Смещение (ms, > 0)
   */
  public advance(deltaMs: number): void {
    this.advanceTo(this._nowMs + deltaMs);
  }
}
