/**
 * StrategyContext - sandbox для стратегии
 *
 * @remarks
 * ctx = ЕДИНСТВЕННЫЙ шлюз стратегии в мир.
 *
 * Стратегия НЕ может:
 * - Делать REST/WS напрямую
 * - Читать Order aggregate напрямую
 * - Публиковать в EventBus напрямую
 * - Делать console.log (только telemetry)
 * - Создавать время через new Date() (только ctx.now())
 *
 * Если стратегия может что-то сделать без ctx — это баг архитектуры.
 *
 * v4 changes:
 * - now() возвращает время из IClock (dependency injection)
 * - NO new Date() внутри стратегии
 * - Время = dependency (LiveClock/ReplayClock/PaperClock)
 *
 * @example
 * ```typescript
 * // Внутри стратегии:
 * class DumbStrategy implements IStrategy {
 *   onExecutionEvent(event: StrategyEvent, ctx: StrategyContext): StrategyIntent[] {
 *     // ✅ Используем ctx для всего:
 *     const orderId = ctx.placeLimitOrder({ ... }); // Размещение ордера
 *     const now = ctx.now(); // Время (deterministic!)
 *     const mode = ctx.mode; // Режим работы
 *
 *     // ❌ ЗАПРЕЩЕНО:
 *     // new Date() - NO direct time creation
 *     // fetch() - NO direct REST calls
 *     // console.log() - NO logging
 *     // eventBus.publish() - NO direct event bus access
 *
 *     return intents;
 *   }
 * }
 * ```
 */

import type { Environment } from '../execution/Environment.js';
import type { OrderDisplayData, FillRecordDisplayData } from '../../infrastructure/ui/types.js';

/**
 * PlaceLimitOrderParams - параметры лимитного ордера
 *
 * @remarks
 * v4.2 (Фаза 4): strategyId для multi-strategy изоляции
 * strategyId = domain correlation (связь params → intent → event)
 */
export interface PlaceLimitOrderParams {
  /** Token ID (market identifier) */
  tokenId: string;

  /** Order side */
  side: 'buy' | 'sell';

  /** Limit price */
  price: number;

  /** Order size */
  size: number;

  /** Strategy ID (v4.2: для multi-strategy изоляции, optional для обратной совместимости) */
  strategyId?: string;
}

/**
 * StrategyContext - thin façade sandbox interface
 *
 * @remarks
 * КРИТИЧНО v3: StrategyContext = thin façade, НЕ god-object!
 *
 * v3 changes:
 * - Удалены fill detection методы (теперь в FillEngine)
 * - Удалены trade accumulation методы (теперь в MarketState)
 * - Остался только thin façade для стратегии
 *
 * Делегирует:
 * - getBestBid/Ask → MarketState
 * - placeOrder/cancelOrder → ExecutionAdapter
 * - now() → Clock
 *
 * НЕ делает сам:
 * - Fill detection (это FillEngine)
 * - Orderbook updates (это MarketState)
 * - Order state tracking (это InMemoryOrderState)
 */
export interface StrategyContext {
  /**
   * Execution mode
   *
   * @remarks
   * LIVE: production, real exchange
   * PAPER: simulated trading
   * REPLAY: replay from logs
   */
  readonly mode: Environment;

  /**
   * Current timestamp
   *
   * @returns Current timestamp from IClock
   *
   * @remarks
   * КРИТИЧНО v4: НЕ используй Date.now() напрямую!
   * Используй ctx.now() для deterministic replay.
   *
   * v4: now() → clock.now() (dependency injection)
   * - LiveClock: возвращает Date.now() (production)
   * - ReplayClock: возвращает frozen timestamp (replay)
   * - PaperClock: возвращает controllable timestamp (testing)
   *
   * Гарантирует:
   * - Deterministic replay (bit-for-bit)
   * - NO race conditions с временем
   * - Testable (PaperClock)
   *
   * @example
   * ```typescript
   * // ✅ ПРАВИЛЬНО:
   * const timestamp = ctx.now(); // Deterministic
   * this.emitTelemetry(ctx, { timestamp, ... });
   *
   * // ❌ НЕПРАВИЛЬНО:
   * const timestamp = new Date(); // Nondeterministic!
   * ```
   */
  now(): Date;

  /**
   * Place limit order
   *
   * @param params - Order parameters
   * @returns Order ID
   *
   * @remarks
   * Отправляет order через execution infrastructure.
   * Результат придёт через onExecutionEvent (OrderAccepted/OrderRejected).
   *
   * Асинхронность:
   * - Метод синхронный (возвращает ID сразу)
   * - Результат придёт через ExecutionEvent
   * - FSM обработает event → state change
   *
   * @example
   * ```typescript
   * const orderId = ctx.placeLimitOrder({
   *   tokenId: '0x123',
   *   side: 'buy',
   *   price: 0.52,
   *   size: 100,
   * });
   * // orderId = '123abc' (биржевой ID)
   *
   * // Позже придёт event:
   * // OrderAccepted { orderId: '123abc', ... }
   * // или
   * // OrderRejected { orderId: '123abc', reason: '...' }
   * ```
   */
  placeLimitOrder(params: PlaceLimitOrderParams): string;

  /**
   * Cancel order
   *
   * @param orderId - Order ID to cancel
   *
   * @remarks
   * Отправляет cancel request.
   * Результат придёт через onExecutionEvent (OrderCancelled).
   *
   * Асинхронность:
   * - Метод синхронный (void)
   * - Результат придёт через ExecutionEvent
   * - FSM обработает event → state change
   *
   * @example
   * ```typescript
   * ctx.cancelOrder('123abc');
   *
   * // Позже придёт event:
   * // OrderCancelled { orderId: '123abc', ... }
   * ```
   */
  cancelOrder(orderId: string): void;

  /**
   * Get best bid price from orderbook
   *
   * @param tokenId - Token ID (asset ID)
   * @returns Best bid price или null если нет данных
   *
   * @remarks
   * КРИТИЧНО v5 (БЛОКЕР 2): Orderbook integration!
   *
   * Используется стратегиями для размещения ордеров на реальных уровнях:
   * - Buy order: на уровне best_ask (или чуть выше для maker)
   * - Sell order: на уровне best_bid + spread (для прибыли)
   *
   * Данные обновляются через OrderbookProjector от WebSocket.
   * Если нет данных (null) → стратегия должна пропустить тик.
   *
   * v3: Делегирует MarketState (НЕ хранит данные сам)
   *
   * @example
   * ```typescript
   * const bestBid = ctx.getBestBid(tokenId);
   * const bestAsk = ctx.getBestAsk(tokenId);
   *
   * if (bestBid && bestAsk) {
   *   // Buy на уровне best_ask
   *   ctx.placeLimitOrder({
   *     tokenId,
   *     side: 'buy',
   *     price: bestAsk, // или bestAsk + 0.001 для maker
   *     size: 10,
   *   });
   *
   *   // После fill: sell выше цены покупки
   *   const sellPrice = bestBid + 0.02; // +2 cents spread
   *   ctx.placeLimitOrder({
   *     tokenId,
   *     side: 'sell',
   *     price: sellPrice,
   *     size: 10,
   *   });
   * }
   * ```
   */
  getBestBid(tokenId: string): number | null;

  /**
   * Get best ask price from orderbook
   *
   * @param tokenId - Token ID (asset ID)
   * @returns Best ask price или null если нет данных
   *
   * @remarks
   * См. getBestBid() для деталей использования.
   * v3: Делегирует MarketState (НЕ хранит данные сам)
   */
  getBestAsk(tokenId: string): number | null;

  /**
   * Register active order (for event-driven fill detection)
   *
   * @param order - Order information
   *
   * @remarks
   * v5.5: Event-driven fill detection!
   * Called after receiving OrderAccepted.
   * Stores order information for fill detection on trade/orderbook events.
   *
   * @example
   * ```typescript
   * // In DumbStrategy after OrderAccepted:
   * ctx.registerActiveOrder({
   *   orderId: event.orderId,
   *   strategyId: this.config.id,
   *   tokenId: this.config.tokenId,
   *   side: 'buy',
   *   price: event.price,
   *   size: this.config.size,
   *   outcomeName: 'YES'
   * });
   * ```
   */
  registerActiveOrder(order: {
    orderId: string;
    strategyId: string;
    tokenId: string;
    side: 'buy' | 'sell';
    price: number;
    size: number;
    outcomeName?: string;
  }): void;

  /**
   * Clear active order (after fill or cancel)
   *
   * @remarks
   * v5.5: Called after OrderFilled or OrderCancelled.
   * Clears tracked order information.
   *
   * @example
   * ```typescript
   * // In DumbStrategy after OrderFilled:
   * ctx.clearActiveOrder();
   * ```
   */
  clearActiveOrder(): void;

  /**
   * v6.3: GATEKEEPER - Check if strategy has pending orders
   *
   * @returns true if strategy has any pending orders on exchange
   *
   * @remarks
   * **КРИТИЧНО**: Единственный источник истины для "можно ли генерировать новый intent".
   *
   * Источник истины = OrderReconciliationService.trackedOrders
   * (orders accepted by exchange, not yet filled/cancelled)
   *
   * Strategy MUST call this before generating new intent:
   * - If returns true → BLOCK intent generation (already have pending order)
   * - If returns false → OK to generate intent (no pending orders)
   *
   * This prevents:
   * - Multiple orders accumulating on exchange
   * - Race conditions with OrderAccepted events
   * - Desync between strategy state and exchange state
   *
   * @example
   * ```typescript
   * // In DumbStrategy.generateInitialOrderIntent():
   * if (ctx.hasPendingOrders()) {
   *   this.emitTelemetry(ctx, {
   *     category: 'WARNING',
   *     type: 'INTENT_BLOCKED',
   *     payload: { reason: 'Already have pending orders on exchange' }
   *   });
   *   return []; // BLOCK
   * }
   *
   * // OK to generate intent
   * return [{ type: 'PlaceOrder', ... }];
   * ```
   */
  hasPendingOrders(): boolean;

  /**
   * v6.3: Untrack filled/cancelled order
   *
   * @param orderId - Order ID to untrack
   *
   * @remarks
   * **КРИТИЧНО**: Вызывается Strategy ПЕРЕД генерацией reverse order intent!
   *
   * Проблема без этого:
   * 1. OrderFilled публикуется
   * 2. Strategy.handleOrderFilled() → generateReverseOrderIntent()
   * 3. hasPendingOrders() → true (filled order ещё в Map!)
   * 4. Reverse intent блокируется ✗
   * 5. main.ts untrackOrder() вызывается (уже поздно)
   *
   * Решение: Strategy untrack filled order САМА перед генерацией reverse intent.
   *
   * @example
   * ```typescript
   * // In DumbStrategy.handleOrderFilled():
   * case 'OrderFilled':
   *   ctx.untrackOrder(event.orderId); // ✅ Untrack СРАЗУ!
   *   return this.generateReverseOrderIntent(ctx); // ✅ hasPendingOrders() → false
   * ```
   */
  untrackOrder(orderId: string): void;

  /**
   * v7.4: Get current inventory from PortfolioProjector
   *
   * @param tokenId - Token ID (market identifier)
   * @returns Current inventory (cumulative position quantity)
   *
   * @remarks
   * **КРИТИЧНО v7.4**: MUST GET POSITIONS FROM POLYMARKET AND CALCULATE INVENTORY!
   *
   * This method queries PortfolioProjector which accumulates OrderFilled events:
   * - BUY fills: increase inventory
   * - SELL fills: decrease inventory
   * - Returns cumulative position (5+5+5 = 15, not just last fill size!)
   *
   * **Problem before v7.4**:
   * DumbStrategy.getInventoryFromState() only tracked lastFillSize (ONE fill).
   * After 3 BUY fills of 5 shares each, it returned 5 instead of 15.
   * This caused Strategy to keep generating BUY orders instead of SELL orders.
   *
   * **Solution v7.4**:
   * Strategy now queries REAL cumulative inventory from PortfolioProjector.
   * This ensures Strategy sees the correct position and generates SELL orders.
   *
   * @example
   * ```typescript
   * // In DumbStrategy.onTick():
   * const inventory = ctx.getInventory(this.config.tokenId);
   *
   * if (inventory === 0 && !hasPendingOrders) {
   *   // CASE A: No inventory → generate BUY order
   *   return [{ type: 'PlaceOrder', side: 'buy', ... }];
   * }
   *
   * if (inventory > 0 && !hasPendingOrders) {
   *   // CASE C: Have inventory → generate SELL order
   *   return [{ type: 'PlaceOrder', side: 'sell', size: inventory, ... }];
   * }
   * ```
   */
  getInventory(tokenId: string): number;

  /**
   * Get position with averageCost (для profitable SELL pricing)
   *
   * @param tokenId - Token ID
   * @returns Position с averageCost, realizedPnL, quantity или null если нет позиции
   *
   * @remarks
   * ✅ v7.7.14: КРИТИЧНО для прибыльной продажи!
   *
   * Strategy использует averageCost для определения цены SELL:
   * - Sell price = averageCost * 1.04 (4% profit)
   * - Гарантирует прибыльность (не продаем дешевле чем купили!)
   *
   * averageCost - это approximation FIFO:
   * - Если купил 10 @ 0.50 и 5 @ 0.55
   * - averageCost = (10*0.50 + 5*0.55) / 15 = 0.517
   * - Продажа по 0.517 * 1.04 = 0.537 гарантирует прибыль!
   *
   * @example
   * ```typescript
   * // In DumbStrategy CASE C:
   * const position = ctx.getPosition(this.config.tokenId);
   * if (!position) return []; // No position yet
   *
   * const sellPrice = position.averageCost * 1.04; // 4% profit
   * return [{
   *   type: 'PlaceOrder',
   *   side: 'sell',
   *   price: sellPrice,
   *   size: position.quantity
   * }];
   * ```
   */
  getPosition(tokenId: string): { quantity: number; averageCost: number; realizedPnL: number } | null;

  /**
   * Get minimum order size from market constraints
   *
   * @param tokenId - Token ID (market identifier)
   * @returns Minimum order size for this market (exchange limit)
   *
   * @remarks
   * ✅ v7.7.15: Минимальный размер ордера на бирже.
   *
   * Используется для определения "пустой" позиции:
   * - Если inventory < minOrderSize → можно покупать (CASE A)
   * - Если inventory >= minOrderSize → нужно продавать (CASE C)
   *
   * Обычно = 1 для Polymarket, но может быть больше для некоторых рынков.
   *
   * @example
   * ```typescript
   * // In DumbStrategy:
   * const minOrderSize = ctx.getMinOrderSize(this.config.tokenId);
   * const inventory = ctx.getInventory(this.config.tokenId);
   *
   * if (inventory < minOrderSize && !hasPendingOrders) {
   *   // CASE A: inventory below minimum → generate BUY order
   *   return [{ type: 'PlaceOrder', side: 'buy', ... }];
   * }
   * ```
   */
  getMinOrderSize(tokenId: string): number;

  /**
   * Get list of open orders for this strategy
   *
   * @returns Array of open orders (from MetricsProjector)
   *
   * @remarks
   * ✅ v7.7.16: Strategy self-sufficiency!
   *
   * Strategy получает РЕАЛЬНОЕ состояние ордеров с биржи.
   * Используется для:
   * - Snapshot перед PlaceOrder (запоминаем orderIds)
   * - Обнаружение новых ордеров (подтверждение размещения)
   * - Обнаружение исчезновения ордеров (fill/cancel)
   *
   * Данные обновляются через OrderReconciliationService каждые 4 секунды.
   *
   * @example
   * ```typescript
   * // In DumbStrategy before PlaceOrder:
   * const orders = ctx.getOrders();
   * this.snapshot = {
   *   orderIds: orders.map(o => o.id),
   *   timestamp: ctx.now().getTime()
   * };
   *
   * // Later on StrategyTick:
   * const currentOrders = ctx.getOrders();
   * const newOrders = currentOrders.filter(o => !this.snapshot.orderIds.includes(o.id));
   * if (newOrders.length > 0) {
   *   console.log("✅ New order confirmed!");
   * }
   * ```
   */
  getOrders(): OrderDisplayData[];

  /**
   * Get list of all fills/trades for this strategy
   *
   * @returns Array of fills (from MetricsProjector)
   *
   * @remarks
   * ✅ v7.7.16: Strategy self-sufficiency!
   *
   * Strategy получает ВСЕ fills/trades.
   * Используется для:
   * - Snapshot перед PlaceOrder (запоминаем fillIds)
   * - Обнаружение новых fills (ордер исполнился)
   * - Расчёт inventory из трейдов (SUM(BUY) - SUM(SELL))
   *
   * Данные обновляются через OrderReconciliationService каждые 4 секунды.
   *
   * @example
   * ```typescript
   * // In DumbStrategy:
   * const fills = ctx.getFills();
   *
   * // Calculate inventory from fills:
   * let inventory = 0;
   * for (const fill of fills) {
   *   if (fill.side === 'BUY') {
   *     inventory += fill.size;
   *   } else if (fill.side === 'SELL') {
   *     inventory -= fill.size;
   *   }
   * }
   * inventory = Math.floor(inventory * 100) / 100; // Truncate to 2 decimals
   * ```
   */
  getFills(): FillRecordDisplayData[];

  // ✅ v3: MOST fill detection методы УДАЛЕНЫ!
  // - emitVirtualFill() → УДАЛЕНО (теперь в FillEngine)
  // - getFilledVolume() → УДАЛЕНО (теперь в FillEngine)
  // - addTrade() → УДАЛЕНО (теперь в MarketState)
  // - checkOrderbookFill() → УДАЛЕНО (теперь в FillEngine)
  // - logFillHistory() → УДАЛЕНО (не нужно в thin façade)
  //
  // ✅ v5.5: registerActiveOrder() и clearActiveOrder() ВОССТАНОВЛЕНЫ!
  // Нужны для event-driven fill detection в live mode.
  //
  // ✅ v7.4: getInventory() ДОБАВЛЕН!
  // Strategy ОБЯЗАНА получать inventory с Polymarket через PortfolioProjector!
  //
  // ✅ v7.7.15: getMinOrderSize() ДОБАВЛЕН!
  // Strategy получает минимальный размер ордера из market constraints!
}
