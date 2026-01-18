/**
 * IStrategyExecutor - контракт исполнителя интентов
 *
 * @remarks
 * КРИТИЧНО v2: Executor = ТУПОЙ switch
 *
 * Executor:
 * - Проходит по intents
 * - Вызывает ctx методы
 * - NO логики принятия решений
 * - NO фильтрации intents
 * - NO знания о state стратегии
 *
 * Жёсткое правило v2:
 * Если Executor знает про state → ты восстановил Orchestrator.
 * Executor = просто вызывает ctx.method() для каждого intent.
 *
 * Почему Executor не фильтрует intents:
 * - Фильтрация = логика принятия решений (НЕ для Executor!)
 * - Если нужна фильтрация → отдельный слой (risk manager)
 * - Executor = тупо исполняет (switch по intent.type)
 *
 * @example
 * ```typescript
 * class StrategyExecutor implements IStrategyExecutor {
 *   execute(intents: StrategyIntent[], ctx: StrategyContext): void {
 *     for (const intent of intents) {
 *       // ТУПОЙ switch - NO логики!
 *       if (isPlaceOrderIntent(intent)) {
 *         ctx.placeLimitOrder(intent.params); // ✅ просто вызываем ctx
 *       } else if (isCancelOrderIntent(intent)) {
 *         ctx.cancelOrder(intent.orderId); // ✅ просто вызываем ctx
 *       }
 *       // NO фильтрации, NO валидации, NO логики
 *     }
 *   }
 * }
 *
 * // ❌ НЕПРАВИЛЬНО (Executor знает про state):
 * class BadExecutor implements IStrategyExecutor {
 *   execute(intents: StrategyIntent[], ctx: StrategyContext): void {
 *     // ❌ Executor знает про risk limits
 *     if (intents.length > 10) {
 *       throw new Error('Too many intents'); // ❌ принятие решений
 *     }
 *
 *     for (const intent of intents) {
 *       // ❌ Executor фильтрует intents
 *       if (intent.type === 'PlaceOrder' && intent.params.size > 1000) {
 *         continue; // ❌ фильтрация
 *       }
 *       // ...
 *     }
 *   }
 * }
 * ```
 */

import type { StrategyIntent } from './StrategyIntent.js';
import type { StrategyContext } from './StrategyContext.js';

/**
 * IStrategyExecutor interface
 *
 * @remarks
 * Executor = тупой switch.
 * NO логики, NO фильтрации, NO знания о state.
 *
 * Единственная responsibility:
 * - Перебрать intents
 * - Вызвать ctx.method() для каждого intent
 * - Catch errors (но НЕ фильтровать intents!)
 *
 * Executor НЕ знает:
 * - Про state стратегии
 * - Про risk limits
 * - Про balance
 * - Про market conditions
 *
 * Executor = просто вызывает ctx методы.
 */
export interface IStrategyExecutor {
  /**
   * Execute intents
   *
   * @param intents - Array of intents to execute
   * @param ctx - Strategy context (sandbox)
   *
   * @remarks
   * КРИТИЧНО v2: Тупой switch по intent.type.
   * NO логики принятия решений.
   * NO фильтрации intents.
   * NO знания о state стратегии.
   *
   * Алгоритм:
   * 1. for each intent
   * 2. switch (intent.type)
   * 3. ctx.method()
   * 4. catch errors (логируем, но НЕ фильтруем!)
   *
   * Почему void (не Promise):
   * - ctx методы синхронные (placeLimitOrder возвращает orderId сразу)
   * - Async operations происходят внутри ctx (fire-and-forget)
   * - Результаты приходят через ExecutionEvent
   *
   * @example
   * ```typescript
   * const intents: StrategyIntent[] = [
   *   { type: 'PlaceOrder', params: { ... }, reason: 'Initial quote' },
   *   { type: 'Noop' },
   * ];
   *
   * executor.execute(intents, ctx);
   * // → ctx.placeLimitOrder() вызван
   * // → orderId возвращён
   * // → async operation в фоне
   * // → ExecutionEvent придёт позже
   * ```
   */
  execute(intents: StrategyIntent[], ctx: StrategyContext): void;
}
