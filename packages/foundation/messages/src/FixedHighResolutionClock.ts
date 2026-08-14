import type { IHighResolutionClock } from './IHighResolutionClock.js';

/**
 * Детерминированная реализация {@link IHighResolutionClock} с управляемым
 * значением — для тестов, paper и replay режимов.
 *
 * @remarks
 * Возвращает ровно то значение, которое задано конструктором/`set()`/
 * `advance()` — никаких обращений к системным таймерам. Это canonical
 * «fake/test implementation» high-resolution источника: metadata остаётся
 * полностью детерминированной (те же вызовы → те же micro/nano компоненты).
 *
 * Режим «нет sub-millisecond precision» — значение по умолчанию `0n`:
 * генератор честно выдаёт `microsecondOfMillisecond = 0` и
 * `nanosecondOfMicrosecond = 0`, не выдумывая физические наносекунды.
 * Точный runtime-порядок сообщений в любом случае гарантирует `sequence`.
 *
 * @example
 * ```typescript
 * const hr = new FixedHighResolutionClock(456_789n); // 456 us, 789 ns внутри ms
 * const generator = new MessageMetadataGenerator({
 *   clock: new PaperClock(new Date('2026-08-14T00:00:00Z')),
 *   highResolutionClock: hr,
 *   runId: unsafeRunId('testrun1'),
 * });
 *
 * hr.advance(1_000n); // +1 микросекунда
 * ```
 */
export class FixedHighResolutionClock implements IHighResolutionClock {
  private _nanoseconds: bigint;

  /**
   * Создаёт детерминированный high-resolution источник.
   *
   * @param initialNanoseconds - Начальное значение в наносекундах (по умолчанию `0n`)
   * @throws {RangeError} Если значение отрицательное
   */
  constructor(initialNanoseconds: bigint = 0n) {
    this._nanoseconds = FixedHighResolutionClock._requireNonNegative(initialNanoseconds);
  }

  /**
   * Возвращает текущее управляемое значение.
   *
   * @returns Заданные наносекунды (без чтения системных таймеров)
   */
  public nowNanoseconds(): bigint {
    return this._nanoseconds;
  }

  /**
   * Устанавливает абсолютное значение источника.
   *
   * @param nanoseconds - Новое значение в наносекундах
   * @throws {RangeError} Если значение отрицательное
   *
   * @example
   * ```typescript
   * hr.set(123_456_789n);
   * ```
   */
  public set(nanoseconds: bigint): void {
    this._nanoseconds = FixedHighResolutionClock._requireNonNegative(nanoseconds);
  }

  /**
   * Продвигает значение вперёд.
   *
   * @param deltaNanoseconds - Прибавка в наносекундах (неотрицательная)
   * @throws {RangeError} Если прибавка отрицательная
   *
   * @example
   * ```typescript
   * hr.advance(1_000n); // +1 us
   * ```
   */
  public advance(deltaNanoseconds: bigint): void {
    if (deltaNanoseconds < 0n) {
      throw new RangeError('FixedHighResolutionClock.advance() requires a non-negative delta');
    }
    this._nanoseconds += deltaNanoseconds;
  }

  /**
   * Валидация неотрицательности значения.
   *
   * @param nanoseconds - Проверяемое значение
   * @returns То же значение при успехе
   * @throws {RangeError} Если значение отрицательное
   */
  private static _requireNonNegative(nanoseconds: bigint): bigint {
    if (nanoseconds < 0n) {
      throw new RangeError('FixedHighResolutionClock requires a non-negative nanoseconds value');
    }
    return nanoseconds;
  }
}
