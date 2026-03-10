/**
 * IStrategy — публичный интерфейс для пользовательских стратегий.
 *
 * @remarks
 * Стратегия получает изолированный TradingAPI через StrategyContext.
 *
 * ### Жизненный цикл:
 * 1. `StrategyRunner.start(strategy)` → `strategy.initialize(ctx)`
 * 2. Стратегия подписывается на события через `ctx.api.subscribe()`
 * 3. При срабатывании лимита риска: `strategy.stop()` (через RiskOrchestrator)
 * 4. При явной остановке: `StrategyRunner.stop(strategyId)` → `strategy.stop()`
 *
 * @example
 * ```typescript
 * class SimpleQuoter implements IStrategy {
 *   readonly id = 'simple-quoter-1';
 *   readonly name = 'SimpleQuoter';
 *   private _ordersPlaced = 0;
 *
 *   async initialize(ctx: StrategyContext): Promise<Result<void, Error>> {
 *     ctx.api.subscribe('BOOK_UPDATED', async (event) => {
 *       // Логика размещения ордеров
 *       const result = await ctx.api.placeOrder({
 *         asset: marketId,
 *         side: 'BUY',
 *         price: event.topOfBook.bestAsk,
 *         size: Quantity.of(new Decimal('10')),
 *       });
 *       if (result.ok) this._ordersPlaced++;
 *     });
 *     return Ok(undefined);
 *   }
 *
 *   async stop(): Promise<void> {
 *     // cleanup: отменить открытые ордера и т.п.
 *   }
 *
 *   getMetrics() {
 *     return { ordersPlaced: this._ordersPlaced };
 *   }
 * }
 * ```
 */
import type { Result } from '@polymarket/result';
import type { StrategyContext } from './StrategyContext.js';

/**
 * Интерфейс торговой стратегии.
 *
 * @remarks
 * Реализуется пользовательскими стратегиями (не в этом пакете).
 * StrategyRunner управляет жизненным циклом.
 */
export interface IStrategy {
  /**
   * Уникальный идентификатор стратегии.
   *
   * @remarks
   * Используется для трекинга в `StrategyRunner._strategies` Map
   * и для изоляции ордеров в `TradingAPI`.
   */
  readonly id: string;

  /**
   * Человекочитаемое имя стратегии (для логирования).
   */
  readonly name: string;

  /**
   * Инициализация стратегии.
   *
   * @param context - StrategyContext с изолированным TradingAPI
   * @returns `Ok(undefined)` при успехе или `Err(Error)` при ошибке инициализации
   *
   * @remarks
   * Вызывается один раз при `StrategyRunner.start()`.
   * В этом методе стратегия должна подписаться на нужные события через `context.api.subscribe()`.
   *
   * Если `initialize()` вернул `Err`, StrategyRunner:
   * - Вызовет `context.api.unsubscribeAll()` для cleanup
   * - НЕ добавит стратегию в активные
   * - Вернёт ошибку вызывающей стороне
   */
  initialize(context: StrategyContext): Promise<Result<void, Error>>;

  /**
   * Остановка стратегии.
   *
   * @remarks
   * Вызывается при:
   * - Явном запросе: `StrategyRunner.stop(strategyId)`
   * - Срабатывании риск-лимита: `RiskOrchestrator` → `StrategyRunner.onRiskBreached()`
   * - Системной остановке: `StrategyRunner.stopAll()`
   *
   * После `stop()` StrategyRunner автоматически вызовет `tradingAPI.unsubscribeAll()`.
   */
  stop(): Promise<void>;

  /**
   * Текущие метрики стратегии.
   *
   * @returns Объект с метриками (формат на усмотрение стратегии)
   *
   * @remarks
   * Вызывается `StrategyRunner.getMetrics()` для мониторинга.
   * Должен быть безопасен для частых вызовов и не изменять состояние.
   */
  getMetrics(): Record<string, unknown>;
}
