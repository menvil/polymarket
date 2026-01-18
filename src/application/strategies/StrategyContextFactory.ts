/**
 * StrategyContextFactory - factory для создания StrategyContext с правильным clock
 *
 * @remarks
 * v4: Инжектит правильный clock в зависимости от mode.
 *
 * Auto-selection logic:
 * - LIVE → LiveClock (Date.now())
 * - PAPER → PaperClock (controllable time, starts from current time)
 * - REPLAY → ReplayClock (frozen time, starts from epoch)
 *
 * Manual override:
 * - Можно передать собственный clock (для тестов)
 *
 * @example
 * ```typescript
 * // Auto-select clock (production):
 * const liveCtx = StrategyContextFactory.create(
 *   executionAdapter,
 *   'LIVE'
 * );
 * // → LiveClock injected
 *
 * // Auto-select clock (testing):
 * const paperCtx = StrategyContextFactory.create(
 *   executionAdapter,
 *   'PAPER'
 * );
 * // → PaperClock injected (starts from Date.now())
 *
 * // Manual override (advanced):
 * const customClock = new PaperClock(new Date('2024-01-01'));
 * const testCtx = StrategyContextFactory.create(
 *   executionAdapter,
 *   'PAPER',
 *   customClock // override
 * );
 * // → customClock used
 * ```
 */

import { StrategyContextImpl } from './StrategyContextImpl.js';
import { LiveClock } from '../../infrastructure/time/LiveClock.js';
import { PaperClock } from '../../infrastructure/time/PaperClock.js';
import { ReplayClock } from '../../infrastructure/time/ReplayClock.js';
import type { IClock } from '../../domain/time/IClock.js';
import type { Environment } from '../../domain/execution/Environment.js';
import type { StrategyContext } from '../../domain/strategies/StrategyContext.js';
import type { IExecutionAdapter } from '../../domain/ports/IExecutionAdapter.js';
import type { IOrderbookProjector } from '../../domain/services/orderbook/OrderbookProjector.js';

/**
 * StrategyContextFactory - smart factory with clock auto-selection
 *
 * @remarks
 * КРИТИЧНО v4:
 * - Auto-selects clock based on environment
 * - LiveClock для LIVE (production)
 * - PaperClock для PAPER (testing)
 * - ReplayClock для REPLAY (backtest)
 *
 * Почему factory pattern:
 * - Упрощает создание context (NO manual clock selection)
 * - Гарантирует правильный clock для каждого environment
 * - Позволяет override для тестов
 *
 * @example
 * ```typescript
 * // Production (LIVE):
 * const ctx = StrategyContextFactory.create(adapter, 'LIVE');
 * // → LiveClock (Date.now())
 *
 * // Testing (PAPER):
 * const ctx = StrategyContextFactory.create(adapter, 'PAPER');
 * // → PaperClock (controllable)
 *
 * // Backtest (REPLAY):
 * const ctx = StrategyContextFactory.create(adapter, 'REPLAY');
 * // → ReplayClock (frozen, will be updated by replay system)
 * ```
 */
export class StrategyContextFactory {
  /**
   * Create StrategyContext with auto-selected clock
   *
   * @param executionAdapter - Execution adapter (for placing/cancelling orders)
   * @param environment - Execution mode (LIVE/PAPER/REPLAY)
   * @param orderbookProjector - Orderbook projector для dynamic pricing (v5 БЛОКЕР 2)
   * @param clock - Optional clock override (for advanced testing)
   * @returns StrategyContext with injected clock
   *
   * @remarks
   * v4 auto-selection:
   * - LIVE → LiveClock
   * - PAPER → PaperClock (starts from Date.now())
   * - REPLAY → ReplayClock (starts from epoch, will be updated)
   *
   * v5 (БЛОКЕР 2):
   * - orderbookProjector теперь обязательный параметр для dynamic pricing
   *
   * Manual override (optional):
   * - Передай собственный clock для custom behaviour
   * - Полезно для тестов с specific timestamps
   *
   * @example
   * ```typescript
   * // Auto-select:
   * const ctx = StrategyContextFactory.create(adapter, 'LIVE', orderbookProjector);
   * // → LiveClock
   *
   * // Manual override:
   * const fixedClock = new PaperClock(new Date('2024-01-01T00:00:00Z'));
   * const ctx = StrategyContextFactory.create(adapter, 'PAPER', orderbookProjector, fixedClock);
   * // → fixedClock used
   * ```
   */
  static create(
    executionAdapter: IExecutionAdapter,
    environment: Environment,
    orderbookProjector: IOrderbookProjector, // ✅ v5 (БЛОКЕР 2): Dynamic pricing
    clock?: IClock // Optional override
  ): StrategyContext {
    // Auto-select clock if not provided
    const selectedClock = clock ?? this.createClockForEnvironment(environment);

    return new StrategyContextImpl(executionAdapter, environment, selectedClock, orderbookProjector);
  }

  /**
   * Create clock for environment (auto-selection)
   *
   * @param environment - Execution mode
   * @returns Clock instance for this environment
   *
   * @remarks
   * v4 auto-selection logic:
   * - LIVE: LiveClock (Date.now(), production)
   * - PAPER: PaperClock (controllable, starts from Date.now())
   * - REPLAY: ReplayClock (frozen, starts from epoch)
   *
   * ReplayClock starts from epoch (timestamp = 0):
   * - Replay system will update clock on each event
   * - clock.update(event.timestamp) called by replay system
   * - Ensures deterministic timestamps
   *
   * PaperClock starts from Date.now():
   * - Tests can advance time with clock.tick(ms)
   * - Tests can set absolute time with clock.setTime(date)
   * - Convenient for testing without manual time setup
   *
   * @example
   * ```typescript
   * // LIVE:
   * const liveClock = StrategyContextFactory.createClockForEnvironment('LIVE');
   * // → LiveClock (Date.now())
   *
   * // PAPER:
   * const paperClock = StrategyContextFactory.createClockForEnvironment('PAPER');
   * // → PaperClock (starts from Date.now())
   * paperClock.tick(1000); // Advance by 1 second
   *
   * // REPLAY:
   * const replayClock = StrategyContextFactory.createClockForEnvironment('REPLAY');
   * // → ReplayClock (starts from epoch)
   * replayClock.update(new Date('2024-01-01')); // Updated by replay system
   * ```
   */
  private static createClockForEnvironment(environment: Environment): IClock {
    switch (environment) {
      case 'LIVE':
        // Production: real wall clock
        return new LiveClock();

      case 'PAPER':
        // Testing: controllable clock (starts from current time)
        return new PaperClock(new Date()); // Start from now

      case 'REPLAY':
        // Backtest: frozen clock (starts from epoch, will be updated by replay system)
        return new ReplayClock(new Date(0)); // Start from epoch

      default: {
        const _exhaustive: never = environment;
        throw new Error(`Unknown environment: ${_exhaustive}`);
      }
    }
  }
}
