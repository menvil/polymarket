/**
 * StrategyExecutor - ТУПОЙ исполнитель интентов
 *
 * @remarks
 * КРИТИЧНО v2: NO логики принятия решений!
 *
 * Алгоритм:
 * 1. for each intent
 * 2. switch (intent.type)
 * 3. ctx.method()
 * 4. catch errors (НО НЕ фильтруй intents!)
 *
 * Что Executor НЕ делает:
 * - НЕ знает про state стратегии
 * - НЕ фильтрует intents (например, по risk limits)
 * - НЕ принимает решений
 * - НЕ модифицирует intents
 *
 * Executor = просто вызывает ctx методы.
 * Никакой умной логики!
 *
 * @example
 * ```typescript
 * const logger = new ConsoleLogger();
 * const executor = new StrategyExecutor(logger);
 *
 * const intents: StrategyIntent[] = [
 *   {
 *     type: 'PlaceOrder',
 *     params: {
 *       tokenId: '0xabc',
 *       side: 'buy',
 *       price: 0.52,
 *       size: 100,
 *     },
 *     reason: 'Initial quote',
 *   },
 *   {
 *     type: 'Noop',
 *   },
 * ];
 *
 * executor.execute(intents, ctx);
 * // → ctx.placeLimitOrder() вызван для PlaceOrder
 * // → ничего не делаем для Noop
 * ```
 */

import type { IStrategyExecutor } from '../../domain/strategies/IStrategyExecutor.js';
import type { StrategyIntent } from '../../domain/strategies/StrategyIntent.js';
import type { StrategyContext } from '../../domain/strategies/StrategyContext.js';
import {
  isPlaceOrderIntent,
  isCancelOrderIntent,
  isNoopIntent,
} from '../../domain/strategies/StrategyIntent.js';
import type { ILogger } from '../../domain/ports/ILogger.js';

/**
 * StrategyExecutor - dumb intent executor
 *
 * @remarks
 * КРИТИЧНО v2:
 * - ТУПОЙ switch (switch по intent.type)
 * - NO логики принятия решений
 * - NO фильтрации intents
 * - NO знания о state стратегии
 *
 * Единственная responsibility:
 * - Перебрать intents
 * - Вызвать ctx.method() для каждого intent
 * - Catch errors (логируем, но НЕ бросаем)
 *
 * Почему Executor НЕ бросает ошибки:
 * - Один failed intent НЕ должен ломать всю стратегию
 * - Strategy продолжает работать даже если один intent failed
 * - Ошибки логируются, но execution продолжается
 *
 * @example
 * ```typescript
 * const executor = new StrategyExecutor(logger);
 *
 * // Execute intents:
 * executor.execute([
 *   { type: 'PlaceOrder', params: { ... } },
 *   { type: 'CancelOrder', orderId: '123' },
 *   { type: 'Noop' },
 * ], ctx);
 *
 * // → PlaceOrder: ctx.placeLimitOrder() called
 * // → CancelOrder: ctx.cancelOrder() called
 * // → Noop: nothing
 * ```
 */
export class StrategyExecutor implements IStrategyExecutor {
  /**
   * @param logger - Logger for error reporting
   *
   * @remarks
   * Logger используется ТОЛЬКО для ошибок при execution.
   * Executor НЕ логирует интенты (это telemetry job).
   * Executor НЕ логирует успешные executions (silent success).
   */
  constructor(private readonly logger: ILogger) {}

  /**
   * Execute intents
   *
   * @param intents - Array of intents
   * @param ctx - Strategy context
   *
   * @remarks
   * КРИТИЧНО v2: ТУПОЙ switch!
   * v4.2 (Фаза 4): Executor = boundary между domain и infrastructure
   * - Propagate strategyId из intent в params
   * - NO логики принятия решений
   *
   * Алгоритм:
   * 1. for each intent
   * 2. switch (intent.type) via type guards
   * 3. augment params with strategyId (v4.2)
   * 4. ctx.method()
   * 5. catch errors (логируем, продолжаем)
   *
   * NO логики, NO фильтрации, NO валидации.
   * Просто propagate metadata и вызываем ctx методы.
   */
  execute(intents: StrategyIntent[], ctx: StrategyContext): void {
    for (const intent of intents) {
      try {
        // ТУПОЙ switch - NO логики!
        if (isPlaceOrderIntent(intent)) {
          // PlaceOrder: вызываем ctx.placeLimitOrder()
          // v4.2: Propagate strategyId из intent в params

          // ✅ INFO: Логируем размещение ордера
          this.logger.info('[StrategyExecutor] 📤 Placing order', {
            strategyId: intent.strategyId?.substring(0, 20) + '...',
            side: intent.params.side.toUpperCase(),
            price: intent.params.price.toFixed(4),
            size: intent.params.size,
            reason: intent.reason,
          });

          ctx.placeLimitOrder({
            ...intent.params,
            strategyId: intent.strategyId, // ✅ Executor = boundary (domain → infrastructure)
          });
        } else if (isCancelOrderIntent(intent)) {
          // CancelOrder: вызываем ctx.cancelOrder()
          ctx.cancelOrder(intent.orderId);
        } else if (isNoopIntent(intent)) {
          // Noop: ничего не делаем
          // Do nothing (by design)
        } else {
          // Unknown intent type (exhaustiveness check)
          const _exhaustive: never = intent;
          this.logger.error('[StrategyExecutor] Unknown intent type', _exhaustive);
        }
      } catch (error) {
        // Error during execution: логируем, но НЕ бросаем
        // Один failed intent НЕ должен ломать всю стратегию
        this.logger.error('[StrategyExecutor] Failed to execute intent', {
          intent,
          error,
        });
      }
    }
  }
}
