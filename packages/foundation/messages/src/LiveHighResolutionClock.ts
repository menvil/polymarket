import type { IHighResolutionClock } from './IHighResolutionClock.js';

/**
 * Максимально допустимая ширина anchor-bracket-а (нс), при которой пара
 * origins принимается без повторной попытки.
 * @internal
 */
const MAX_ANCHOR_BRACKET_NS = 100_000n; // 100 µs

/**
 * Количество попыток снять узкую пару origins (защита от preemption
 * между чтениями двух разных OS-часов).
 * @internal
 */
const ANCHOR_ATTEMPTS = 3;

/**
 * Live-реализация {@link IHighResolutionClock}: wall-clock baseline +
 * monotonic elapsed (`process.hrtime.bigint()`).
 *
 * @remarks
 * Гибридные часы. Единого атомарного источника epoch-наносекунд в Node нет
 * (`Date.now()` — миллисекунды wall-clock; `hrtime` — monotonic с
 * произвольным origin), поэтому пара origins снимается **bracket-ом**:
 *
 * ```text
 * before  = process.hrtime.bigint()
 * wallMs  = Date.now()
 * after   = process.hrtime.bigint()
 *
 * wallOriginMs      = wallMs
 * monotonicOriginNs = before + (after - before) / 2   // середина bracket-а
 * ```
 *
 * Момент чтения wall-значения принимается за середину bracket-а — ошибка
 * спаривания двух разных часов ограничена половиной ширины bracket-а
 * (обычно ≪ 1 µs). Аномально широкий bracket (preemption/GC между
 * чтениями) детектится и пара снимается повторно (до {@link ANCHOR_ATTEMPTS}
 * попыток, берётся самый узкий bracket) — систематический перекос origins
 * не переживает конструктор.
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
 * Свойства и честные границы точности:
 * - sub-millisecond precision реальна (наносекундная шкала hrtime);
 * - значение монотонно не убывает (hrtime monotonic по контракту Node);
 * - ошибка спаривания origins ≤ полуширины bracket-а (см. выше);
 * - абсолютная привязка к wall-clock ограничена разрешением `Date.now()`
 *   (миллисекунда): sub-ms компоненты точны ОТНОСИТЕЛЬНО якоря, «фаза»
 *   якоря внутри его миллисекунды неизвестна by design;
 * - NTP-коррекции wall-clock ПОСЛЕ создания часов не влияют на показания —
 *   стандартный trade-off гибридных часов: когерентность и монотонность
 *   внутри runtime важнее пост-фактум синхронизации со стеночными часами.
 *
 * Для paper/replay/тестов используй {@link PaperHighResolutionClock}.
 *
 * @example
 * ```typescript
 * // Composition root live-режима:
 * const generator = new MessageMetadataGenerator({
 *   clock: new LiveClock(),
 *   highResolutionClock: new LiveHighResolutionClock(),
 * });
 * ```
 */
export class LiveHighResolutionClock implements IHighResolutionClock {
  /** Абсолютный Unix-якорь (мс), снятый при создании часов. */
  private readonly _wallOriginMs: number;
  /** Monotonic-точка, соответствующая моменту чтения wall-якоря (середина bracket-а). */
  private readonly _monotonicOriginNs: bigint;

  constructor() {
    let bestWallMs = 0;
    let bestMidNs = 0n;
    let bestWidthNs: bigint | undefined;

    for (let attempt = 0; attempt < ANCHOR_ATTEMPTS; attempt++) {
      const before = process.hrtime.bigint();
      const wallMs = Date.now();
      const after = process.hrtime.bigint();
      const width = after - before;

      if (bestWidthNs === undefined || width < bestWidthNs) {
        bestWidthNs = width;
        bestWallMs = wallMs;
        bestMidNs = before + width / 2n;
      }
      if (width <= MAX_ANCHOR_BRACKET_NS) {
        break;
      }
    }

    this._wallOriginMs = bestWallMs;
    this._monotonicOriginNs = bestMidNs;
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
