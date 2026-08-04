/**
 * Универсальный retention-буфer, ограниченный по количеству и/или возрасту элементов.
 *
 * @remarks
 * Обобщает паттерн, независимо продублированный трижды в кодовой базе: `TradeTape`
 * (`@polymarket/trade-tape`), `OrderBookHistory` (`@polymarket/order-book`) и
 * `pruneAndCap()` (`packages/application/market-state/src/CryptoMarketDataStore.ts`).
 * Все три сошлись к одной форме — append + вытеснение по `maxAgeMs`/`maxCount` — что и
 * стало основанием вынести абстракцию в `packages/foundation/`.
 *
 * ### Допущение о порядке поступления
 * `append()` предполагает, что элементы поступают в неубывающем порядке по
 * `getTimestampMs` — вытеснение по возрасту сканирует буфер с головы и не
 * пересортировывает при единичном out-of-order элементе. Это унаследованное допущение
 * всех трёх прообразов (см. `TradeTape` — "почему не Map"), а не новый риск.
 *
 * ### Семантика вытеснения по возрасту
 * Cutoff вычисляется от временной метки ТОЛЬКО ЧТО добавленного элемента (не от
 * `clock.now()`), тем же способом, что и `TradeTape.append()`/`pruneAndCap()` — это
 * делает вытеснение детерминированным при replay исторических данных. Элемент с
 * возрастом РОВНО `maxAgeMs` не вытесняется (строгое `<`, не `<=`) — граница
 * зафиксирована тестами.
 *
 * @example
 * ```typescript
 * const result = RollingWindow.create<TapeRecord>(
 *   { maxCount: 1000, maxAgeMs: 300_000 },
 *   clock,
 *   (record) => record.timestamp.toNumber(),
 * );
 * if (!result.ok) throw result.error;
 * const window = result.value;
 *
 * window.append(record);
 * const lastMinute = window.getRecent(60_000);
 * ```
 */

import { Result, Ok, Err } from '@polymarket/result';
import { ValidationError } from '@polymarket/errors';
import type { IClock } from '@polymarket/time';

/**
 * Политика вытеснения элементов из `RollingWindow`.
 *
 * @remarks
 * Хотя бы одно поле должно быть задано — проверяется в `RollingWindow.create()`.
 * Если заданы оба, вытеснение срабатывает при нарушении любого из ограничений.
 */
export interface RetentionPolicy {
  /**
   * Максимальное количество элементов.
   * При превышении самый старый элемент вытесняется (FIFO).
   */
  readonly maxCount?: number;
  /**
   * Максимальный возраст элемента в миллисекундах.
   * Устаревшие элементы вытесняются при каждом `append()`.
   */
  readonly maxAgeMs?: number;
}

/**
 * Retention-буфер общего назначения: append + вытеснение по `maxCount`/`maxAgeMs`.
 *
 * @remarks
 * Создаётся через `RollingWindow.create()`. Не потокобезопасен вне однопоточной
 * среды Node.js.
 */
export class RollingWindow<T> {
  private readonly _items: T[];

  private constructor(
    private readonly _policy: RetentionPolicy,
    private readonly _clock: IClock,
    private readonly _getTimestampMs: (item: T) => number,
  ) {
    this._items = [];
  }

  /**
   * Создаёт новый `RollingWindow` с заданной политикой хранения.
   *
   * @param policy - Политика вытеснения (`maxCount` и/или `maxAgeMs`)
   * @param clock - Источник времени для `getRecent()` по умолчанию
   * @param getTimestampMs - Извлекает временную метку (мс) из элемента; используется и
   *   для вытеснения по возрасту, и для оконных запросов (`getWindow`/`getRecent`)
   * @returns `Result` с `RollingWindow<T>` либо `ValidationError` при невалидной политике
   *
   * @example
   * ```typescript
   * const result = RollingWindow.create<Trade>(
   *   { maxAgeMs: 60_000 },
   *   clock,
   *   (trade) => trade.timestamp.toNumber(),
   * );
   * ```
   */
  public static create<T>(
    policy: RetentionPolicy,
    clock: IClock,
    getTimestampMs: (item: T) => number,
  ): Result<RollingWindow<T>, ValidationError> {
    if (policy.maxCount === undefined && policy.maxAgeMs === undefined) {
      return Err(
        new ValidationError(
          'RollingWindow: retention policy must specify maxCount and/or maxAgeMs',
          { context: { policy } },
        ),
      );
    }
    if (
      policy.maxCount !== undefined &&
      (!Number.isInteger(policy.maxCount) || policy.maxCount <= 0)
    ) {
      return Err(
        new ValidationError(
          `RollingWindow: maxCount must be a positive integer, got ${policy.maxCount}`,
          { context: { maxCount: policy.maxCount } },
        ),
      );
    }
    if (
      policy.maxAgeMs !== undefined &&
      (!Number.isFinite(policy.maxAgeMs) || policy.maxAgeMs <= 0)
    ) {
      return Err(
        new ValidationError(
          `RollingWindow: maxAgeMs must be a positive number, got ${policy.maxAgeMs}`,
          { context: { maxAgeMs: policy.maxAgeMs } },
        ),
      );
    }
    return Ok(new RollingWindow<T>(policy, clock, getTimestampMs));
  }

  /**
   * Добавляет элемент и применяет политику вытеснения.
   *
   * @param item - Элемент для добавления
   *
   * @remarks
   * Порядок:
   * 1. Вытеснение по возрасту (если задан `maxAgeMs`) — cutoff считается от
   *    `getTimestampMs(item)` добавляемого элемента, не от `clock.now()`.
   * 2. Добавление элемента в конец.
   * 3. Вытеснение самого старого элемента, если превышен `maxCount`.
   *
   * @example
   * ```typescript
   * window.append(record);
   * ```
   */
  public append(item: T): void {
    if (this._policy.maxAgeMs !== undefined) {
      const cutoff = this._getTimestampMs(item) - this._policy.maxAgeMs;
      let i = 0;
      while (i < this._items.length && this._getTimestampMs(this._items[i]!) < cutoff) {
        i++;
      }
      if (i > 0) this._items.splice(0, i);
    }

    this._items.push(item);

    if (this._policy.maxCount !== undefined && this._items.length > this._policy.maxCount) {
      this._items.shift();
    }
  }

  /**
   * Возвращает самый новый элемент.
   *
   * @returns Последний добавленный элемент или `undefined`, если буфер пуст
   */
  public getLatest(): T | undefined {
    return this._items[this._items.length - 1];
  }

  /**
   * Возвращает элементы за последние `durationMs` миллисекунд.
   *
   * @param durationMs - Длительность окна в миллисекундах
   * @param nowMs - Текущее время в мс (по умолчанию `clock.now().getTime()`)
   * @returns Элементы в хронологическом порядке
   *
   * @example
   * ```typescript
   * const lastMinute = window.getRecent(60_000);
   * const deterministic = window.getRecent(60_000, clock.now().getTime());
   * ```
   */
  public getRecent(durationMs: number, nowMs?: number): readonly T[] {
    const now = nowMs ?? this._clock.now().getTime();
    return this.getWindow(now - durationMs, now);
  }

  /**
   * Возвращает последние `n` элементов.
   *
   * @param n - Количество элементов (от самого нового)
   * @returns Элементы в хронологическом порядке (старые → новые)
   */
  public getLast(n: number): readonly T[] {
    const count = Math.floor(n);
    if (count <= 0) return [];
    return this._items.slice(-count);
  }

  /**
   * Возвращает элементы в заданном временном окне.
   *
   * @param fromMs - Начало окна (включительно) в мс
   * @param toMs - Конец окна (включительно) в мс
   * @returns Отфильтрованные элементы в хронологическом порядке
   */
  public getWindow(fromMs: number, toMs: number): readonly T[] {
    return this._items.filter((item) => {
      const ts = this._getTimestampMs(item);
      return ts >= fromMs && ts <= toMs;
    });
  }

  /**
   * Возвращает все элементы буфера.
   *
   * @returns Все элементы в хронологическом порядке
   */
  public getAll(): readonly T[] {
    return this._items;
  }

  /**
   * Возвращает количество элементов в буфере.
   *
   * @returns Текущий размер буфера
   */
  public size(): number {
    return this._items.length;
  }

  /**
   * Проверяет, пуст ли буфер.
   *
   * @returns `true`, если элементов нет
   */
  public isEmpty(): boolean {
    return this._items.length === 0;
  }
}
