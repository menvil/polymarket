/**
 * @polymarket/strategy — Управление жизненным циклом торговых стратегий.
 *
 * @remarks
 * ### Содержимое пакета:
 *
 * **Интерфейсы:**
 * - `IStrategy` — контракт пользовательской стратегии
 * - `StrategyContext` — контекст инициализации (передаётся в initialize())
 * - `ITradingAPI` — фасад торговых операций для стратегии
 * - `IStrategyRunner` — полный интерфейс менеджера стратегий
 *
 * **Реализации:**
 * - `TradingAPI` — изолированный торговый API (один экземпляр на стратегию)
 * - `StrategyRunner` — менеджер жизненного цикла стратегий
 *
 * **Типы:**
 * - `PlaceOrderParams` — параметры размещения ордера
 * - `TradingAPIDeps` — зависимости TradingAPI
 * - `StrategyRunnerDeps` — зависимости StrategyRunner
 *
 * @example
 * ```typescript
 * import type { IStrategy, StrategyContext } from '@polymarket/strategy';
 * import { StrategyRunner } from '@polymarket/strategy';
 * import { Ok } from '@polymarket/result';
 *
 * class SimpleQuoter implements IStrategy {
 *   readonly id = 'simple-quoter-1';
 *   readonly name = 'SimpleQuoter';
 *   private _ordersPlaced = 0;
 *
 *   async initialize(ctx: StrategyContext) {
 *     ctx.api.subscribe('BOOK_UPDATED', async (event) => {
 *       await ctx.api.placeOrder({ ... });
 *       this._ordersPlaced++;
 *     });
 *     return Ok(undefined);
 *   }
 *
 *   async stop() { await ctx.api.cancelAll(); }
 *   getMetrics() { return { ordersPlaced: this._ordersPlaced }; }
 * }
 *
 * const runner = new StrategyRunner({ ... });
 * await runner.start(new SimpleQuoter());
 * ```
 *
 * @packageDocumentation
 */

// Интерфейсы
export type { IStrategy } from './IStrategy.js';
export type { StrategyContext } from './StrategyContext.js';
export type { ITradingAPI, PlaceOrderParams } from './ITradingAPI.js';
export type { IStrategyRunner } from './IStrategyRunner.js';

// Реализации
export { TradingAPI } from './TradingAPI.js';
export type { TradingAPIDeps } from './TradingAPI.js';
export { StrategyRunner } from './StrategyRunner.js';
export type { StrategyRunnerDeps } from './StrategyRunner.js';
