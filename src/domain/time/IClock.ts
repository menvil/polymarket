/**
 * IClock - контракт источника времени
 *
 * @remarks
 * Время - это dependency!
 * Стратегия НЕ создаёт время, она получает его из clock.
 *
 * - Время = dependency injection
 * - IClock = контракт источника времени
 * - 3 implementations: LiveClock, ReplayClock, PaperClock
 * - StrategyContextImpl получает clock via DI
 *
 * Implementations (все возвращают Date из now()):
 * - LiveClock: new Date() — реальное время (production, LIVE mode)
 * - ReplayClock: замороженное время из event.timestamp (replay, REPLAY mode)
 * - PaperClock: контролируемое время (testing, PAPER mode)
 *
 * ```
 * Стратегия НЕ создаёт время.
 * Время = dependency injection.
 * NO new Date() в StrategyContextImpl.
 * ```
 *
 * @example
 * ```typescript
 * // (НЕПРАВИЛЬНО):
 * class StrategyContextImpl {
 *   now(): Date {
 *    return new Date(); // ❌ nondeterministic
 *   }
 * }
 *
 * // (ПРАВИЛЬНО):
 * class StrategyContextImpl {
 *   constructor(
 *    private readonly clock: IClock // ✅ Dependency injection
 *   ) {}
 *
 *   now(): Date {
 *    return this.clock.now(); // ✅ deterministic
 *   }
 * }
 * ```
 *
 * @example
 * ```typescript
 * // LIVE mode:
 * const clock = new LiveClock();
 * const ctx = new StrategyContextImpl(adapter, 'LIVE', clock);
 * console.log(ctx.now()); // Real time
 *
 * // REPLAY mode:
 * const clock = new ReplayClock(new Date('2024-01-01'));
 * const ctx = new StrategyContextImpl(adapter, 'REPLAY', clock);
 * console.log(ctx.now()); // 2024-01-01 (frozen)
 *
 * clock.update(new Date('2024-01-02')); // Update from event
 * console.log(ctx.now()); // 2024-01-02 (frozen)
 *
 * // PAPER mode:
 * const clock = new PaperClock(new Date());
 * const ctx = new StrategyContextImpl(adapter, 'PAPER', clock);
 *
 * clock.tick(1000); // Advance 1 second
 * console.log(ctx.now()); // Time advanced
 * ```
 */
export interface IClock {
  /**
   * Получение текущего времени
   *
   * @returns Date — текущий timestamp
   *
   * @remarks
   * NO new Date() внутри стратегии!
   * Время инжектится через clock.
   *
   * Implementations (все возвращают Date):
   * - LiveClock: new Date() — реальное время
   * - ReplayClock: frozen Date из event.timestamp
   * - PaperClock: controllable Date для тестов
   *
   * Гарантирует deterministic replay
   * - Один event stream → одни timestamps
   * - Telemetry bit-for-bit deterministic
   * - NO race conditions с временем
   */
  now(): Date;
}
