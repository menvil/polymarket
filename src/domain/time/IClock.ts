/**
 * IClock - контракт источника времени
 *
 * @remarks
 * КРИТИЧНО v4: Время - это dependency!
 * Стратегия НЕ создаёт время, она получает его из clock.
 *
 * Архитектурная проблема v3:
 * - v3: ctx.now() { return new Date(); } - nondeterministic
 * - Replay НЕ bit-for-bit (timestamp всегда новый)
 * - Два replay одного стрима → разные telemetry timestamps
 *
 * Решение v4:
 * - Время = dependency injection
 * - IClock = контракт источника времени
 * - 3 implementations: LiveClock, ReplayClock, PaperClock
 * - StrategyContextImpl получает clock via DI
 *
 * Implementations:
 * - LiveClock: Date.now() (production, LIVE mode)
 * - ReplayClock: event.timestamp (replay, REPLAY mode)
 * - PaperClock: controllable (testing, PAPER mode)
 *
 * Жёсткое правило v4:
 * ```
 * Стратегия НЕ создаёт время.
 * Время = dependency injection.
 * NO new Date() в StrategyContextImpl.
 * ```
 *
 * @example
 * ```typescript
 * // v3 (НЕПРАВИЛЬНО):
 * class StrategyContextImpl {
 *   now(): Date {
 *    return new Date(); // ❌ nondeterministic
 *   }
 * }
 *
 * // v4 (ПРАВИЛЬНО):
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
  * Получение текущего timestamp
   *
   * @returns Текущий timestamp
   *
   * @remarks
   * NO new Date() внутри стратегии!
   * Время инжектится через clock.
   *
   * Implementations:
   * - LiveClock: возвращает new Date() (в реальном времени)
   * - ReplayClock: возвращает frozen timestamp (в бектестах)
   * - PaperClock: возвращает controllable timestamp (в тестах)
   *
   * v4: Гарантирует deterministic replay
   * - Один event stream → одни timestamps
   * - Telemetry bit-for-bit deterministic
   * - NO race conditions с временем
   */
  now(): Date;
}
