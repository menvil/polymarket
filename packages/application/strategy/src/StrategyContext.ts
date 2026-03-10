/**
 * StrategyContext — контекст, передаваемый стратегии при инициализации.
 *
 * @remarks
 * Единственное, что StrategyRunner передаёт в `strategy.initialize()`.
 * Стратегия получает изолированный TradingAPI для всех взаимодействий с системой.
 */
import type { ITradingAPI } from './ITradingAPI.js';

/**
 * Контекст инициализации стратегии.
 *
 * @example
 * ```typescript
 * class MyStrategy implements IStrategy {
 *   async initialize(ctx: StrategyContext): Promise<Result<void, Error>> {
 *     ctx.api.subscribe('BOOK_UPDATED', async (event) => {
 *       // обрабатываем обновление стакана
 *     });
 *     return Ok(undefined);
 *   }
 * }
 * ```
 */
export interface StrategyContext {
  /**
   * Изолированный TradingAPI для этой стратегии.
   *
   * @remarks
   * Каждая стратегия получает свой экземпляр TradingAPI с уникальным strategyId.
   * Это обеспечивает:
   * - Изоляцию подписок: `unsubscribeAll()` удаляет только подписки этой стратегии
   * - Правильную маршрутизацию ордеров в PlaceOrderUseCase
   * - Фильтрацию открытых ордеров: `getOpenOrders()` вернёт только её ордера
   * - Контекстное логирование по стратегии
   */
  readonly api: ITradingAPI;
}
