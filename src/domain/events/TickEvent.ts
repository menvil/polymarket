/**
 * StrategyTick - периодическое событие времени
 *
 * @remarks
 * Emit'ится StrategyRunner'ом по setInterval.
 * Позволяет стратегиям реагировать на течение времени.
 *
 * КРИТИЧНО: TickEvent должен быть частью union'а StrategyEvent
 * для детерминированного replay.
 *
 * @example
 * ```typescript
 * const tickEvent: StrategyTick = {
 *   type: 'StrategyTick',
 *   strategyId: 'dumb-strategy-1',
 *   timestamp: clock.now(), // Детерминированное время!
 * };
 * ```
 */
export interface StrategyTick {
  readonly type: 'StrategyTick';
  readonly strategyId: string;
  readonly timestamp: Date; // из ctx.now() → clock.now()
}
