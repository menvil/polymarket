/**
 * Минимальный порт high-resolution monotonic-источника времени.
 *
 * @remarks
 * Используется `MessageMetadataGenerator` ТОЛЬКО для вычисления
 * sub-millisecond компонент metadata (`microsecondOfMillisecond`,
 * `nanosecondOfMicrosecond`). Wall-clock время (`createdAt`,
 * `createdAtUnixSeconds`, `millisecondOfSecond`) читается из канонического
 * `IClock` — этот порт его НЕ заменяет и НЕ ломает существующую
 * deterministic-модель времени (live/paper/replay).
 *
 * Контракт сознательно минимален (никакого time-framework):
 * один метод, значение — monotonic наносекунды от произвольного origin
 * (как `process.hrtime.bigint()`). Абсолютная привязка к wall-clock
 * НЕ требуется: генератор берёт только остаток внутри миллисекунды.
 *
 * Реализации:
 * - {@link SystemHighResolutionClock} — live Node runtime
 *   (`process.hrtime.bigint()`);
 * - {@link FixedHighResolutionClock} — детерминированный fake для
 *   тестов/paper/replay (управляемое значение).
 *
 * BigInt живёт ТОЛЬКО внутри реализации high-resolution расчёта —
 * в public `MessageMetadata` выходят обычные number-поля.
 *
 * @example
 * ```typescript
 * const hr: IHighResolutionClock = new SystemHighResolutionClock();
 * const ns: bigint = hr.nowNanoseconds();
 * ```
 */
export interface IHighResolutionClock {
  /**
   * Возвращает текущее monotonic-время в наносекундах.
   *
   * @returns Наносекунды от произвольного origin (неотрицательный bigint)
   *
   * @remarks
   * Гарантии контракта: значение неотрицательно и не убывает между
   * последовательными вызовами внутри одного runtime.
   */
  nowNanoseconds(): bigint;
}
