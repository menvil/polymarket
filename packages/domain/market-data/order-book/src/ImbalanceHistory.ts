/**
 * История дисбаланса стакана ордеров
 *
 * @remarks
 * Хранит rolling-историю значений imbalance стакана с временными метками.
 * При превышении maxSize удаляет самые старые записи (FIFO).
 *
 * ### Использование:
 * Запись imbalance при каждом обновлении стакана позволяет:
 * - Анализировать тренды давления (bullish/bearish pressure)
 * - Вычислять средний дисбаланс за период
 * - Определять дельту (изменение) дисбаланса за период
 *
 * ### Почему maxSize вместо TTL:
 * В high-frequency контексте память важнее времени.
 * TTL-based eviction усложняет логику. Вместо этого
 * используем getWindow() для фильтрации по времени.
 */

import Decimal from 'decimal.js';
import { addDecimal, subtractDecimal, divideDecimal } from '@polymarket/math';
import { Result, Ok, Err } from '@polymarket/result';
import { ValidationError } from '@polymarket/errors';

/**
 * Точка истории дисбаланса
 *
 * @example
 * ```typescript
 * const point: ImbalancePoint = {
 *   timestampMs: Date.now(),
 *   imbalance: new Decimal('0.304'),
 * };
 * ```
 */
export interface ImbalancePoint {
  /** Временная метка в миллисекундах */
  readonly timestampMs: number;
  /** Значение дисбаланса в диапазоне [-1, +1] */
  readonly imbalance: Decimal;
}

/**
 * Rolling-история значений дисбаланса стакана
 *
 * @remarks
 * Максимальный размер по умолчанию — 1000 записей.
 * При превышении удаляются самые старые.
 *
 * @example
 * ```typescript
 * const historyResult = ImbalanceHistory.create(500);
 * if (!historyResult.ok) throw historyResult.error;
 * const history = historyResult.value;
 *
 * const imbalanceResult = book.getImbalance();
 * if (imbalanceResult.ok) history.record(imbalanceResult.value, Date.now());
 *
 * const avg = history.getAverage(); // Decimal | undefined
 * const delta = history.getDelta(5000); // Decimal | undefined
 * ```
 */
export class ImbalanceHistory {
  private static readonly DEFAULT_MAX_SIZE = 1000;

  private readonly _maxSize: number;
  private readonly _points: ImbalancePoint[];

  /**
   * Приватный конструктор — используйте ImbalanceHistory.create()
   */
  private constructor(maxSize: number) {
    this._maxSize = maxSize;
    this._points = [];
  }

  /**
   * Создаёт новую историю дисбаланса
   *
   * @param maxSize - Максимальный размер истории (по умолчанию 1000)
   * @returns `Result` с новой `ImbalanceHistory` либо `ValidationError`, если `maxSize`
   *   невалиден
   *
   * @example
   * ```typescript
   * const result = ImbalanceHistory.create(500);
   * if (!result.ok) throw result.error;
   * const history = result.value;
   * ```
   */
  public static create(maxSize?: number): Result<ImbalanceHistory, ValidationError> {
    const size = maxSize ?? ImbalanceHistory.DEFAULT_MAX_SIZE;
    if (!Number.isInteger(size) || size <= 0) {
      return Err(
        new ValidationError(
          `ImbalanceHistory: maxSize must be a positive integer, got ${size}`,
          { context: { maxSize: size } },
        ),
      );
    }
    return Ok(new ImbalanceHistory(size));
  }

  /**
   * Записывает новое значение дисбаланса
   *
   * @param imbalance - Значение дисбаланса [-1, +1] как Decimal
   * @param timestampMs - Временная метка в миллисекундах
   *
   * @remarks
   * При превышении maxSize самая старая запись удаляется (FIFO).
   * Принимает Decimal напрямую — типичный вызов: `record(book.getImbalance(), Date.now())`.
   *
   * @example
   * ```typescript
   * history.record(book.getImbalance(), Date.now());
   * ```
   */
  public record(imbalance: Decimal, timestampMs: number): void {
    if (this._points.length >= this._maxSize) {
      this._points.shift(); // FIFO: удаляем самую старую
    }
    this._points.push({ imbalance, timestampMs });
  }

  /**
   * Возвращает все записи истории
   *
   * @returns Readonly массив всех точек истории
   */
  public getAll(): readonly ImbalancePoint[] {
    return this._points;
  }

  /**
   * Возвращает записи в заданном временном окне
   *
   * @param fromMs - Начало окна (включительно) в миллисекундах
   * @param toMs - Конец окна (включительно) в миллисекундах
   * @returns Отфильтрованные точки истории
   *
   * @example
   * ```typescript
   * const lastHour = history.getWindow(Date.now() - 3600_000, Date.now());
   * ```
   */
  public getWindow(fromMs: number, toMs: number): readonly ImbalancePoint[] {
    return this._points.filter(
      (p) => p.timestampMs >= fromMs && p.timestampMs <= toMs
    );
  }

  /**
   * Вычисляет среднее значение дисбаланса
   *
   * @param windowMs - Длительность окна в миллисекундах (если не указано — все записи)
   * @param nowMs - Текущее время в мс (по умолчанию Date.now()). Передавайте clock.now().toNumber() для бэктеста.
   * @returns Среднее значение как Decimal или undefined если нет записей
   *
   * @example
   * ```typescript
   * const avgLast10s = history.getAverage(10_000, clock.now().toNumber()); // детерминированно
   * const avgAll = history.getAverage();                                    // все записи
   * ```
   */
  public getAverage(windowMs?: number, nowMs?: number): Decimal | undefined {
    const now = nowMs ?? Date.now();
    const points =
      windowMs !== undefined
        ? this.getWindow(now - windowMs, now)
        : this._points;

    if (points.length === 0) return undefined;

    const sum = points.reduce((acc, p) => addDecimal(acc, p.imbalance), new Decimal(0));
    return divideDecimal(sum, new Decimal(points.length));
  }

  /**
   * Вычисляет дельту дисбаланса за период
   *
   * @param windowMs - Длительность окна в миллисекундах
   * @param nowMs - Текущее время в мс (по умолчанию Date.now()). Передавайте clock.now().toNumber() для бэктеста.
   * @returns last - first в окне как Decimal, или undefined если менее 2 записей
   *
   * @remarks
   * Положительная дельта → дисбаланс растёт (усиливается давление bid).
   * Отрицательная дельта → дисбаланс падает (усиливается давление ask).
   *
   * @example
   * ```typescript
   * const delta = history.getDelta(5000, clock.now().toNumber()); // детерминированно
   * if (delta?.greaterThan(0.1)) {
   *   // резкий рост давления bid
   * }
   * ```
   */
  public getDelta(windowMs: number, nowMs?: number): Decimal | undefined {
    const now = nowMs ?? Date.now();
    const points = this.getWindow(now - windowMs, now);

    if (points.length < 2) return undefined;

    const first = points[0]!;
    const last = points[points.length - 1]!;
    return subtractDecimal(last.imbalance, first.imbalance);
  }

  /**
   * Возвращает количество записей в истории
   *
   * @returns Количество точек истории
   */
  public size(): number {
    return this._points.length;
  }

  /**
   * Проверяет, пустая ли история
   *
   * @returns True если нет записей
   */
  public isEmpty(): boolean {
    return this._points.length === 0;
  }
}
