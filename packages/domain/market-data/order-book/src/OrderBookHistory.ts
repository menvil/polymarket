/**
 * История снапшотов стакана ордеров (Order Book History)
 *
 * @remarks
 * Rolling-хранилище полных снапшотов стакана с комбинированной политикой вытеснения.
 * В отличие от `ImbalanceHistory` (только скаляр), хранит полное состояние стакана:
 * все bid/ask уровни на момент записи.
 *
 * ### Политика вытеснения (retention):
 * Поддерживает два независимых ограничения — срабатывает любое из них:
 * - `maxCount` — максимальное количество снапшотов (FIFO при превышении)
 * - `maxAgeMs` — максимальный возраст снапшота в мс (авто-вытеснение при каждом `record()`)
 *
 * Примеры конфигурации:
 * - только count: `{ maxCount: 1000 }` — последние 1000 снапшотов
 * - только время: `{ maxAgeMs: 300_000 }` — последние 5 минут
 * - оба: `{ maxCount: 10_000, maxAgeMs: 300_000 }` — до 10000 записей, но не старше 5 минут
 *
 * ### Временная метка записи:
 * Используется `recordedAtMs` — момент вызова `record()` на локальной машине,
 * а не `snapshot.timestamp` (биржевое время, может быть `undefined`).
 * Это делает вытеснение детерминированным и не зависящим от биржевых задержек.
 *
 * ### Почему не TTL как в TradeTape:
 * `TradeTape` требует ручного вызова `evictBefore()` — это подходит для трейдов,
 * которые приходят редко. Стакан обновляется постоянно, поэтому авто-вытеснение
 * при каждом `record()` предпочтительнее.
 *
 * @example
 * ```typescript
 * // Последние 5 минут ИЛИ не более 10000 снапшотов:
 * const history = OrderBookHistory.create({ maxCount: 10_000, maxAgeMs: 300_000 });
 *
 * // При каждом обновлении стакана:
 * history.record(book.toSnapshot());
 *
 * // Получить последние 60 секунд:
 * const recent = history.getRecent(60_000);
 *
 * // Получить последние 100 снапшотов:
 * const last100 = history.getLast(100);
 *
 * // Самый свежий снапшот:
 * const latest = history.getLatest();
 * ```
 */

import type { IClock } from '@polymarket/time';
import type { OrderBookSnapshot } from './OrderBook.js';

/**
 * Политика хранения снапшотов стакана.
 *
 * @remarks
 * Хотя бы одно из полей должно быть задано.
 * Если заданы оба — вытеснение происходит при нарушении любого из ограничений.
 */
export interface OrderBookRetentionPolicy {
  /**
   * Максимальное количество снапшотов.
   * При превышении удаляется самый старый (FIFO).
   */
  readonly maxCount?: number;
  /**
   * Максимальный возраст снапшота в мс.
   * При `record()` автоматически удаляются снапшоты старше `now - maxAgeMs`.
   */
  readonly maxAgeMs?: number;
}

/**
 * Внутренняя запись: снапшот + момент времени его записи.
 *
 * @remarks
 * `recordedAtMs` — локальное время вызова `record()`.
 * Используется для вытеснения по возрасту и фильтрации по временным окнам.
 */
interface StoredSnapshot {
  readonly snapshot: OrderBookSnapshot;
  readonly recordedAtMs: number;
}

/**
 * Rolling-история полных снапшотов стакана ордеров.
 *
 * @remarks
 * Создаётся через `OrderBookHistory.create()` с валидацией политики.
 * Потокобезопасна только в однопоточной среде Node.js.
 *
 * @example
 * ```typescript
 * const history = OrderBookHistory.create({ maxCount: 1000, maxAgeMs: 60_000 });
 * history.record(book.toSnapshot());
 * const recent = history.getRecent(30_000);
 * ```
 */
export class OrderBookHistory {
  private readonly _maxCount: number | undefined;
  private readonly _maxAgeMs: number | undefined;
  private readonly _snapshots: StoredSnapshot[];

  private constructor(policy: OrderBookRetentionPolicy, private readonly _clock: IClock) {
    this._maxCount = policy.maxCount;
    this._maxAgeMs = policy.maxAgeMs;
    this._snapshots = [];
  }

  /**
   * Создаёт новую историю снапшотов с заданной политикой хранения.
   *
   * @param policy - Политика вытеснения (maxCount и/или maxAgeMs)
   * @param clock - Источник времени для детерминированной работы (используется как fallback в record/getRecent)
   * @returns Новый экземпляр OrderBookHistory
   *
   * @throws {RangeError} Если политика пустая или содержит невалидные значения
   *
   * @example
   * ```typescript
   * const history = OrderBookHistory.create({ maxCount: 1000 }, clock);
   * const history = OrderBookHistory.create({ maxAgeMs: 300_000 }, clock);
   * const history = OrderBookHistory.create({ maxCount: 10_000, maxAgeMs: 300_000 }, clock);
   * ```
   */
  public static create(policy: OrderBookRetentionPolicy, clock: IClock): OrderBookHistory {
    if (policy.maxCount === undefined && policy.maxAgeMs === undefined) {
      throw new RangeError('OrderBookHistory: retention policy must specify maxCount and/or maxAgeMs');
    }
    if (policy.maxCount !== undefined && (!Number.isInteger(policy.maxCount) || policy.maxCount <= 0)) {
      throw new RangeError(`OrderBookHistory: maxCount must be a positive integer, got ${policy.maxCount}`);
    }
    if (policy.maxAgeMs !== undefined && (!Number.isFinite(policy.maxAgeMs) || policy.maxAgeMs <= 0)) {
      throw new RangeError(`OrderBookHistory: maxAgeMs must be a positive number, got ${policy.maxAgeMs}`);
    }
    return new OrderBookHistory(policy, clock);
  }

  /**
   * Записывает снапшот стакана в историю.
   *
   * @param snapshot - Снапшот стакана (из `OrderBook.toSnapshot()`)
   * @param nowMs - Текущее время в мс (по умолчанию `Date.now()`). Передавайте `clock.now().getTime()` для детерминированности.
   *
   * @remarks
   * Алгоритм:
   * 1. Вытесняем снапшоты старше `maxAgeMs` (если задано)
   * 2. Добавляем новый снапшот
   * 3. Вытесняем самый старый если превышен `maxCount` (если задано)
   *
   * @example
   * ```typescript
   * history.record(book.toSnapshot());
   * history.record(book.toSnapshot(), clock.now().getTime()); // детерминированно
   * ```
   */
  public record(snapshot: OrderBookSnapshot, nowMs?: number): void {
    const ts = nowMs ?? this._clock.now().getTime();

    // Шаг 1: вытесняем по возрасту (снапшоты в хронологическом порядке — сканируем с начала)
    this._evictOld(ts);

    // Шаг 2: добавляем новый снапшот
    this._snapshots.push({ snapshot, recordedAtMs: ts });

    // Шаг 3: вытесняем самый старый если превышен лимит по количеству
    if (this._maxCount !== undefined && this._snapshots.length > this._maxCount) {
      this._snapshots.shift();
    }
  }

  /**
   * Возвращает самый последний снапшот.
   *
   * @returns Последний записанный снапшот или `undefined` если история пуста
   *
   * @example
   * ```typescript
   * const latest = history.getLatest();
   * if (latest) {
   *   const spread = latest.asks[0]?.price.value().minus(latest.bids[0]?.price.value());
   * }
   * ```
   */
  public getLatest(): OrderBookSnapshot | undefined {
    return this._snapshots[this._snapshots.length - 1]?.snapshot;
  }

  /**
   * Возвращает последние N снапшотов.
   *
   * @param n - Количество снапшотов (от самого нового)
   * @returns Массив снапшотов в хронологическом порядке (старые → новые)
   *
   * @example
   * ```typescript
   * const last10 = history.getLast(10);
   * ```
   */
  public getLast(n: number): readonly OrderBookSnapshot[] {
    const count = Math.floor(n);
    if (count <= 0) return [];
    return this._snapshots.slice(-count).map((s) => s.snapshot);
  }

  /**
   * Возвращает снапшоты за последние N миллисекунд.
   *
   * @param durationMs - Длительность окна в мс
   * @param nowMs - Текущее время в мс (по умолчанию `Date.now()`)
   * @returns Снапшоты в хронологическом порядке
   *
   * @example
   * ```typescript
   * const lastMinute = history.getRecent(60_000);
   * const last5Min   = history.getRecent(300_000, clock.now().getTime());
   * ```
   */
  public getRecent(durationMs: number, nowMs?: number): readonly OrderBookSnapshot[] {
    const now = nowMs ?? this._clock.now().getTime();
    return this.getWindow(now - durationMs, now);
  }

  /**
   * Возвращает снапшоты в заданном временном окне.
   *
   * @param fromMs - Начало окна (включительно) в мс
   * @param toMs - Конец окна (включительно) в мс
   * @returns Снапшоты в хронологическом порядке
   *
   * @example
   * ```typescript
   * const window = history.getWindow(Date.now() - 300_000, Date.now());
   * ```
   */
  public getWindow(fromMs: number, toMs: number): readonly OrderBookSnapshot[] {
    return this._snapshots
      .filter((s) => s.recordedAtMs >= fromMs && s.recordedAtMs <= toMs)
      .map((s) => s.snapshot);
  }

  /**
   * Возвращает все снапшоты в истории.
   *
   * @returns Все снапшоты в хронологическом порядке
   */
  public getAll(): readonly OrderBookSnapshot[] {
    return this._snapshots.map((s) => s.snapshot);
  }

  /**
   * Возвращает количество снапшотов в истории.
   *
   * @returns Текущий размер истории
   */
  public size(): number {
    return this._snapshots.length;
  }

  /**
   * Проверяет, пустая ли история.
   *
   * @returns `true` если снапшотов нет
   */
  public isEmpty(): boolean {
    return this._snapshots.length === 0;
  }

  // ── Приватные методы ──────────────────────────────────────────────────────

  /**
   * Вытесняет снапшоты старше `maxAgeMs` от текущего момента.
   *
   * @param nowMs - Текущее время в мс
   *
   * @remarks
   * Снапшоты хранятся в хронологическом порядке (append-only),
   * поэтому сканирование с начала до первого «живого» снапшота — O(k),
   * где k — количество вытесненных записей. В steady state k ≈ 0.
   */
  private _evictOld(nowMs: number): void {
    if (this._maxAgeMs === undefined) return;

    const cutoff = nowMs - this._maxAgeMs;
    let i = 0;
    while (i < this._snapshots.length && this._snapshots[i].recordedAtMs < cutoff) {
      i++;
    }
    if (i > 0) {
      this._snapshots.splice(0, i);
    }
  }
}
