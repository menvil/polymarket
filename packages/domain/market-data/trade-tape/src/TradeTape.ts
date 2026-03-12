/**
 * Лента трейдов (Trade Tape)
 *
 * @remarks
 * Append-only хранилище `TapeRecord` с встроенной политикой хранения.
 * Используется для накопления истории рыночных принтов и последующего анализа.
 *
 * ### Принцип работы:
 * - `append(record)` добавляет запись и автоматически вытесняет устаревшие
 * - Политика: `maxAgeMs` (возраст) и/или `maxCount` (количество)
 * - `getWindow()` / `getRecent()` — гибкая выборка по временным окнам
 * - `evictBefore()` — явное управление памятью
 *
 * ### Почему не Map<Timestamp, TapeRecord>:
 * Несколько трейдов могут иметь одинаковый timestamp (в рамках одной миллисекунды).
 * Поэтому используем простой массив с естественным порядком добавления.
 *
 * ### Bounded context:
 * TradeTape — это market-data, не accounting.
 * Не знает о Fill, Order, Portfolio, VenueTradeId.
 * Данные для аналитики и построения сигналов.
 *
 * @example
 * ```typescript
 * const tape = TradeTape.create({ maxCount: 1000, maxAgeMs: 300_000 });
 * tape.append({ price, size, side: 'BUY', timestamp });
 *
 * const recent = tape.getRecent(60_000);
 * const metrics = TradeFlowCalculator.compute(recent);
 * ```
 */

import type { TapeRecord, TapeRetentionPolicy } from './TapeRecord.js';

/**
 * Лента трейдов с политикой хранения
 *
 * @remarks
 * Создаётся через `TradeTape.create(policy)`.
 * `append()` автоматически вытесняет устаревшие записи согласно политике.
 */
export class TradeTape {
  private readonly _records: TapeRecord[];

  /**
   * Приватный конструктор — используйте TradeTape.create()
   */
  private constructor(private readonly _policy: TapeRetentionPolicy) {
    this._records = [];
  }

  /**
   * Создаёт новую ленту трейдов с заданной политикой хранения
   *
   * @param policy - Политика хранения (maxCount и/или maxAgeMs)
   * @returns Новый экземпляр TradeTape
   *
   * @throws {RangeError} Если ни maxCount ни maxAgeMs не заданы
   *
   * @example
   * ```typescript
   * const tape = TradeTape.create({ maxCount: 1000 });
   * const tape2 = TradeTape.create({ maxAgeMs: 300_000 });
   * const tape3 = TradeTape.create({ maxCount: 500, maxAgeMs: 60_000 });
   * ```
   */
  public static create(policy: TapeRetentionPolicy): TradeTape {
    if (policy.maxCount === undefined && policy.maxAgeMs === undefined) {
      throw new RangeError('TradeTape: retention policy must specify maxCount and/or maxAgeMs');
    }
    return new TradeTape(policy);
  }

  /**
   * Добавляет запись трейда в ленту
   *
   * @param record - Запись трейда для добавления
   *
   * @remarks
   * Порядок вытеснения:
   * 1. Устаревшие по возрасту (maxAgeMs) — вытесняются из головы массива
   * 2. Новая запись добавляется в хвост
   * 3. Превышение maxCount — вытесняется самая старая запись (FIFO)
   *
   * Время вытеснения по возрасту берётся из `record.timestamp` (детерминировано).
   *
   * @example
   * ```typescript
   * tape.append({ price, size, side: 'BUY', timestamp });
   * ```
   */
  public append(record: TapeRecord): void {
    // Шаг 1: вытеснить устаревшие по возрасту
    if (this._policy.maxAgeMs !== undefined) {
      const cutoff = record.timestamp.toNumber() - this._policy.maxAgeMs;
      let i = 0;
      while (i < this._records.length && this._records[i].timestamp.toNumber() < cutoff) {
        i++;
      }
      if (i > 0) this._records.splice(0, i);
    }

    // Шаг 2: добавить новую запись
    this._records.push(record);

    // Шаг 3: FIFO по maxCount
    if (this._policy.maxCount !== undefined && this._records.length > this._policy.maxCount) {
      this._records.shift();
    }
  }

  /**
   * Возвращает все записи в ленте
   *
   * @returns Readonly массив всех записей в хронологическом порядке
   */
  public getAll(): readonly TapeRecord[] {
    return this._records;
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
    return this._records.filter((r) => {
      const ms = r.timestamp.toNumber();
      return ms >= fromMs && ms <= toMs;
    });
  }

  /**
   * Возвращает записи за последние N миллисекунд
   *
   * @param durationMs - Длительность окна в миллисекундах
   * @param nowMs - Текущее время (по умолчанию Date.now())
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
    const now = nowMs ?? Date.now();
    return this.getWindow(now - durationMs, now);
  }

  /**
   * Удаляет записи старше заданного момента времени
   *
   * @param cutoffMs - Граница отсечения в миллисекундах (исключительно)
   * @returns Количество удалённых записей
   *
   * @remarks
   * Используется для явного управления памятью.
   * При использовании политики maxAgeMs, `append()` уже делает это автоматически.
   *
   * @example
   * ```typescript
   * const evicted = tape.evictBefore(Date.now() - 3600_000);
   * console.log(`Evicted ${evicted} old records`);
   * ```
   */
  public evictBefore(cutoffMs: number): number {
    const before = this._records.length;
    // Уплотняем массив на месте: без промежуточного буфера
    let writeIdx = 0;
    for (let i = 0; i < this._records.length; i++) {
      if (this._records[i].timestamp.toNumber() >= cutoffMs) {
        this._records[writeIdx++] = this._records[i];
      }
    }
    this._records.length = writeIdx;
    return before - this._records.length;
  }

  /**
   * Возвращает количество записей в ленте
   *
   * @returns Количество записей
   */
  public size(): number {
    return this._records.length;
  }

  /**
   * Проверяет, пустая ли лента
   *
   * @returns True если нет записей
   */
  public isEmpty(): boolean {
    return this._records.length === 0;
  }
}
