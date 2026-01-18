import type { Environment } from './Environment.js';

// Re-export Environment for backward compatibility
export type { Environment };

/**
 * ExecutionContext - контекст исполнения для event envelope
 *
 * @remarks
 * Propagate через EventEnvelope
 *
 * Decision Layer использует это для:
 * - LIVE: real risk checks, real PnL tracking
 * - PAPER: fake fills, fake balance
 * - REPLAY: deterministic replay, NO external calls
 *
 * v4.2 (Фаза 4): strategyId для multi-strategy изоляции
 *
 * @example
 * ```typescript
 * const liveContext: ExecutionContext = {
 *   environment: 'LIVE',
 *   accountId: 'main-account',
 *   strategyId: 'dumb-market-123'
 * };
 *
 * const paperContext: ExecutionContext = {
 *   environment: 'PAPER',
 *   accountId: 'paper-1',
 *   strategyId: 'dumb-market-456'
 * };
 *
 * const replayContext: ExecutionContext = {
 *   environment: 'REPLAY',
 *   accountId: 'backtest-2024-01-01',
 *   strategyId: 'dumb-market-789'
 * };
 * ```
 */
export interface ExecutionContext {
  readonly environment: Environment;
  readonly accountId: string; // Какой аккаунт (может быть "paper-1", "backtest-xyz")
  readonly strategyId?: string; // v4.2: для multi-strategy изоляции (optional для обратной совместимости)
}
