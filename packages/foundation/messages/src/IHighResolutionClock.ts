/**
 * Порт high-resolution источника АБСОЛЮТНОГО времени (Unix epoch).
 *
 * @remarks
 * Используется `MessageMetadataGenerator` как ЕДИНЫЙ источник момента
 * создания сообщения: из одного значения `nowEpochNanoseconds()` выводятся
 * ВСЕ time-поля metadata (`createdAt`, `createdAtUnixSeconds`,
 * `millisecondOfSecond`, `microsecondOfMillisecond`,
 * `nanosecondOfMicrosecond`) — поля не могут описывать разные моменты.
 *
 * Контракт СОЗНАТЕЛЬНО абсолютный: наносекунды от Unix epoch
 * (1970-01-01T00:00:00Z), а НЕ monotonic-значение с произвольным origin.
 * Голый `process.hrtime.bigint()` этому контракту НЕ соответствует — его
 * origin не связан с wall-clock, и его остаток внутри миллисекунды не
 * является micro/nano-фракцией текущей Unix-миллисекунды. Live-реализация
 * ({@link LiveHighResolutionClock}) поэтому якорит monotonic-источник на
 * wall-clock baseline и использует hrtime только для измерения elapsed.
 *
 * Реализации:
 * - {@link LiveHighResolutionClock} — live Node runtime
 *   (wall-origin + monotonic elapsed);
 * - {@link PaperHighResolutionClock} — детерминированный источник для
 *   тестов/paper/replay (управляемое абсолютное значение).
 *
 * BigInt живёт ТОЛЬКО внутри high-resolution расчёта — в public
 * `MessageMetadata` выходят обычные number-поля.
 *
 * @example
 * ```typescript
 * const hr: IHighResolutionClock = new LiveHighResolutionClock();
 * const epochNs: bigint = hr.nowEpochNanoseconds();
 * // 1786668087_123_456_789n → 2026-08-14T00:41:27.123456789Z
 * ```
 */
export interface IHighResolutionClock {
  /**
   * Возвращает текущее абсолютное время в наносекундах от Unix epoch.
   *
   * @returns Неотрицательные epoch-наносекунды (bigint)
   *
   * @remarks
   * Гарантии контракта: значение неотрицательно и не убывает между
   * последовательными вызовами внутри одного runtime (monotonic
   * non-decreasing).
   */
  nowEpochNanoseconds(): bigint;
}
