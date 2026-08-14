import type { IHighResolutionClock } from './IHighResolutionClock.js';

/**
 * Live-реализация {@link IHighResolutionClock}: wall-clock baseline +
 * monotonic elapsed (`process.hrtime.bigint()`).
 *
 * @remarks
 * Гибридные часы. При создании фиксируется пара origins, снятых вместе:
 *
 * ```text
 * wallOriginMs      = Date.now()               // абсолютный Unix-якорь
 * monotonicOriginNs = process.hrtime.bigint()  // monotonic-точка отсчёта
 * ```
 *
 * Каждый вызов измеряет elapsed monotonic-время от origin и прибавляет его
 * к wall-якорю:
 *
 * ```text
 * elapsedNs       = process.hrtime.bigint() - monotonicOriginNs
 * absoluteEpochNs = wallOriginMs * 1_000_000 + elapsedNs
 * ```
 *
 * `process.hrtime.bigint()` здесь НИКОГДА не трактуется как Unix-время —
 * его произвольный monotonic origin используется только для измерения
 * elapsed. Это единственное canonical-место обращения к hrtime в системе.
 *
 * Свойства:
 * - sub-millisecond precision реальна (наносекундная шкала hrtime);
 * - значение монотонно не убывает (hrtime monotonic по контракту Node);
 * - NTP-коррекции wall-clock ПОСЛЕ создания часов не влияют на показания —
 *   стандартный trade-off гибридных часов: когерентность и монотонность
 *   внутри runtime важнее пост-фактум синхронизации со стеночными часами.
 *
 * Для paper/replay/тестов используй {@link FixedHighResolutionClock}.
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
  /** Абсолютный Unix-якорь (мс), снятый при создании часов. */
  private readonly _wallOriginMs: number;
  /** Monotonic-точка отсчёта elapsed (`process.hrtime.bigint()` на создании). */
  private readonly _monotonicOriginNs: bigint;

  constructor() {
    this._wallOriginMs = Date.now();
    this._monotonicOriginNs = process.hrtime.bigint();
  }

  /**
   * Возвращает абсолютные epoch-наносекунды: wall-якорь + monotonic elapsed.
   *
   * @returns Неотрицательные наносекунды от Unix epoch
   */
  public nowEpochNanoseconds(): bigint {
    const elapsedNs = process.hrtime.bigint() - this._monotonicOriginNs;
    return BigInt(this._wallOriginMs) * 1_000_000n + elapsedNs;
  }
}
