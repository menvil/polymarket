import type { IHighResolutionClock } from './IHighResolutionClock.js';

/**
 * Детерминированная реализация {@link IHighResolutionClock} с управляемым
 * абсолютным значением — для тестов, paper и replay режимов.
 *
 * @remarks
 * Возвращает ровно то epoch-значение (наносекунды от Unix epoch), которое
 * задано конструктором/`set()`/`advance()` — никаких обращений к системным
 * таймерам. Это canonical deterministic-реализация high-resolution
 * источника: metadata полностью воспроизводима (те же вызовы → те же
 * time-компоненты).
 *
 * Если режиму не нужна sub-millisecond precision — high-resolution источник
 * генератору просто НЕ передают: все time-поля берутся из `IClock`, а
 * micro/nano — честные нули (наносекунды не выдумываются). Точный
 * runtime-порядок сообщений в любом случае гарантирует `sequence`.
 *
 * @example
 * ```typescript
 * // 2026-08-14T00:41:27.123456789Z
 * const hr = new PaperHighResolutionClock(1_786_668_087_123_456_789n);
 * const generator = new MessageMetadataGenerator({
 *   clock: new PaperClock(new Date('2026-08-14T00:41:27.123Z')),
 *   highResolutionClock: hr,
 *   runId: unsafeRunId('testrun1'),
 * });
 *
 * hr.advance(1_000n); // +1 микросекунда
 * ```
 */
export class PaperHighResolutionClock implements IHighResolutionClock {
  private _epochNanoseconds: bigint;

  /**
   * Создаёт детерминированный high-resolution источник.
   *
   * @param initialEpochNanoseconds - Начальное абсолютное значение в
   *   наносекундах от Unix epoch (по умолчанию `0n` — сам epoch)
   * @throws {RangeError} Если значение отрицательное
   */
  constructor(initialEpochNanoseconds: bigint = 0n) {
    this._epochNanoseconds = PaperHighResolutionClock._requireNonNegative(initialEpochNanoseconds);
  }

  /**
   * Возвращает текущее управляемое абсолютное значение.
   *
   * @returns Заданные epoch-наносекунды (без чтения системных таймеров)
   */
  public nowEpochNanoseconds(): bigint {
    return this._epochNanoseconds;
  }

  /**
   * Устанавливает абсолютное значение источника.
   *
   * @param epochNanoseconds - Новое значение в наносекундах от Unix epoch
   * @throws {RangeError} Если значение отрицательное
   *
   * @example
   * ```typescript
   * hr.set(1_786_668_087_123_456_789n);
   * ```
   */
  public set(epochNanoseconds: bigint): void {
    this._epochNanoseconds = PaperHighResolutionClock._requireNonNegative(epochNanoseconds);
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
      throw new RangeError('PaperHighResolutionClock.advance() requires a non-negative delta');
    }
    this._epochNanoseconds += deltaNanoseconds;
  }

  /**
   * Валидация неотрицательности значения.
   *
   * @param epochNanoseconds - Проверяемое значение
   * @returns То же значение при успехе
   * @throws {RangeError} Если значение отрицательное
   */
  private static _requireNonNegative(epochNanoseconds: bigint): bigint {
    if (epochNanoseconds < 0n) {
      throw new RangeError('PaperHighResolutionClock requires a non-negative epoch nanoseconds value');
    }
    return epochNanoseconds;
  }
}
