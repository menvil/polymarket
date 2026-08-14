import type { IHighResolutionClock } from './IHighResolutionClock.js';

/**
 * Live-реализация {@link IHighResolutionClock} поверх `process.hrtime.bigint()`.
 *
 * @remarks
 * Единственное canonical-место обращения к `process.hrtime.bigint()` в
 * message-системе: producers и Domain НИКОГДА не зовут его напрямую —
 * high-resolution источник инкапсулирован здесь и инъецируется в
 * `MessageMetadataGenerator` composition root-ом live runtime.
 *
 * `process.hrtime.bigint()` — monotonic счётчик наносекунд от произвольного
 * origin (не wall-clock). Генератор использует только остаток внутри
 * миллисекунды, поэтому произвольность origin не влияет на семантику полей
 * metadata.
 *
 * Для paper/replay/тестов используй {@link FixedHighResolutionClock} —
 * детерминированный источник без обращения к системному таймеру.
 *
 * @example
 * ```typescript
 * // Composition root live-режима:
 * const generator = new MessageMetadataGenerator({
 *   clock: new LiveClock(),
 *   highResolutionClock: new SystemHighResolutionClock(),
 * });
 * ```
 */
export class SystemHighResolutionClock implements IHighResolutionClock {
  /**
   * Возвращает monotonic-наносекунды Node runtime.
   *
   * @returns Значение `process.hrtime.bigint()`
   */
  public nowNanoseconds(): bigint {
    return process.hrtime.bigint();
  }
}
