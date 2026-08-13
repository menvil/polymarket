/**
 * Лента трейдов (Trade Tape)
 *
 * @remarks
 * Append-only хранилище `TapeRecord` с встроенной политикой хранения.
 * Используется для накопления истории рыночных принтов и последующего анализа.
 *
 * ### Принцип работы:
 * Тонкая обёртка над `RollingWindow<TapeRecord>` (`@polymarket/rolling-window`) — retention
 * (вытеснение по `maxAgeMs`/`maxCount`) и оконные запросы (`getRecent`/`getWindow`) целиком
 * делегированы туда; `TradeTape` добавляет только доменный тип (`TapeRecord`) и извлечение
 * временной метки (`record.timestamp.toNumber()`).
 *
 * ### Почему не Map<Timestamp, TapeRecord>:
 * Несколько трейдов могут иметь одинаковый timestamp (в рамках одной миллисекунды).
 * Поэтому используем простой массив с естественным порядком добавления (тем же принципом,
 * что и `RollingWindow` внутри).
 *
 * ### Bounded context:
 * TradeTape — это market-data, не accounting.
 * Не знает о Fill, Order, Portfolio, VenueTradeId.
 * Данные для аналитики и построения сигналов.
 *
 * @example
 * ```typescript
 * const result = TradeTape.create({ maxCount: 1000, maxAgeMs: 300_000 }, clock);
 * if (!result.ok) throw result.error;
 * const tape = result.value;
 *
 * tape.append({ price, size, side: 'BUY', timestamp });
 *
 * const recent = tape.getRecent(60_000);
 * const metrics = TradeFlowCalculator.compute(recent);
 * ```
 */

import type { IClock } from '@polymarket/time';
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import type { ValidationError } from '@polymarket/errors';
import { RollingWindow } from '@polymarket/rolling-window';
import type { TapeRecord, TapeRetentionPolicy } from './TapeRecord.js';

/**
 * Лента трейдов с политикой хранения
 *
 * @remarks
 * Создаётся через `TradeTape.create(policy, clock)`.
 * `append()` автоматически вытесняет устаревшие записи согласно политике.
 */
export class TradeTape {
  private constructor(private readonly _window: RollingWindow<TapeRecord>) {}

  /**
   * Создаёт новую ленту трейдов с заданной политикой хранения
   *
   * @param policy - Политика хранения (maxCount и/или maxAgeMs)
   * @param clock - Источник времени для детерминированной работы getRecent()
   * @returns `Result` с новой `TradeTape` либо `ValidationError`, если политика невалидна
   *
   * @example
   * ```typescript
   * const result = TradeTape.create({ maxCount: 500, maxAgeMs: 60_000 }, clock);
   * if (!result.ok) throw result.error;
   * const tape = result.value;
   * ```
   */
  public static create(policy: TapeRetentionPolicy, clock: IClock): Result<TradeTape, ValidationError> {
    const windowResult = RollingWindow.create<TapeRecord>(
      policy,
      clock,
      (record) => record.timestamp.toNumber(),
    );
    if (!windowResult.ok) {
      return Err(windowResult.error);
    }
    return Ok(new TradeTape(windowResult.value));
  }

  /**
   * Добавляет запись трейда в ленту
   *
   * @param record - Запись трейда для добавления
   *
   * @remarks
   * Вытеснение (по возрасту и/или количеству) делегировано `RollingWindow.append()`.
   *
   * @example
   * ```typescript
   * tape.append({ price, size, side: 'BUY', timestamp });
   * ```
   */
  public append(record: TapeRecord): void {
    this._window.append(record);
  }

  /**
   * Возвращает все записи в ленте
   *
   * @returns Readonly массив всех записей в хронологическом порядке
   */
  public getAll(): readonly TapeRecord[] {
    return this._window.getAll();
  }

  /**
   * Возвращает самую новую запись
   *
   * @returns Последняя добавленная запись или `undefined`, если лента пуста
   */
  public getLatest(): TapeRecord | undefined {
    return this._window.getLatest();
  }

  /**
   * Возвращает последние `n` записей
   *
   * @param n - Количество записей (от самой новой)
   * @returns Записи в хронологическом порядке (старые → новые)
   */
  public getLast(n: number): readonly TapeRecord[] {
    return this._window.getLast(n);
  }

  /**
   * Возвращает записи в заданном временном окне
   *
   * @param fromMs - Начало окна (включительно) в миллисекундах
   * @param toMs - Конец окна (включительно) в миллисекундах
   * @returns Отфильтрованные записи
   *
   * @example
   * ```typescript
   * const window = tape.getWindow(Date.now() - 300_000, Date.now());
   * ```
   */
  public getWindow(fromMs: number, toMs: number): readonly TapeRecord[] {
    return this._window.getWindow(fromMs, toMs);
  }

  /**
   * Возвращает записи за последние N миллисекунд
   *
   * @param durationMs - Длительность окна в миллисекундах
   * @param nowMs - Текущее время (по умолчанию `clock.now().getTime()`)
   * @returns Записи в заданном временном окне
   *
   * @remarks
   * nowMs позволяет тестировать метод без зависимости от системного времени.
   *
   * @example
   * ```typescript
   * const lastMinute = tape.getRecent(60_000);
   * const last5Min = tape.getRecent(300_000, fixedNow);
   * ```
   */
  public getRecent(durationMs: number, nowMs?: number): readonly TapeRecord[] {
    return this._window.getRecent(durationMs, nowMs);
  }

  /**
   * Возвращает количество записей в ленте
   *
   * @returns Количество записей
   */
  public size(): number {
    return this._window.size();
  }

  /**
   * Проверяет, пустая ли лента
   *
   * @returns True если нет записей
   */
  public isEmpty(): boolean {
    return this._window.isEmpty();
  }
}
