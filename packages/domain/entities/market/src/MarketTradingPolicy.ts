/**
 * MarketTradingPolicy — политика торговых операций над рынком
 *
 * @remarks
 * Отвечает на вопрос «в каком торговом состоянии находится рынок прямо сейчас?»
 *
 * ### Разделение ответственности:
 * - `Market` (entity) — FSM-правила: ACTIVE→CLOSED→RESOLVED
 * - `MarketTradingPolicy` — бизнес-правила с учётом времени:
 *   когда рынок торгуется, истёк, готов к закрытию, разрешению
 *
 * ### Почему expiration не в Market:
 * Market.close() выполняет FSM-переход.
 * КОГДА он допустим по бизнес-правилам — ответственность Policy.
 * Это позволяет форс-клозить рынок (admin/dispute) независимо от expiration.
 *
 * ### TradingState vs boolean checks:
 * `getTradingState()` возвращает одно состояние вместо 3–4 boolean-вызовов.
 * Discriminated union позволяет exhaustive switch — компилятор поймает
 * новые состояния. Четыре отдельных boolean'а этого не гарантируют.
 *
 * @example
 * ```typescript
 * switch (MarketTradingPolicy.getTradingState(market, Date.now())) {
 *   case 'TRADING':  return orderService.accept(order);
 *   case 'EXPIRED':  return scheduler.scheduleClose(market);
 *   case 'CLOSED':   return resolver.awaitOutcome(market);
 *   case 'RESOLVED': return settlement.process(market);
 * }
 * ```
 */

import { Market } from './Market.js';

/**
 * TradingState — торговое состояние рынка с учётом времени
 *
 * @remarks
 * Объединяет MarketState (FSM) + expiration в одно представление.
 * Используется для принятия торговых решений.
 *
 * | TradingState | MarketState | isExpiredAt |
 * |-------------|-------------|-------------|
 * | TRADING     | ACTIVE      | false       |
 * | EXPIRED     | ACTIVE      | true        |
 * | CLOSED      | CLOSED      | —           |
 * | RESOLVED    | RESOLVED    | —           |
 */
export type TradingState = 'TRADING' | 'EXPIRED' | 'CLOSED' | 'RESOLVED';

/**
 * ForceCloseDecision — решение о допустимости досрочного закрытия рынка
 *
 * @remarks
 * Возвращается `evaluateForceClose()` вместо `boolean`.
 * В случае отказа содержит конкретную причину — для логирования и UI.
 *
 * @example
 * ```typescript
 * const decision = MarketTradingPolicy.evaluateForceClose(market);
 * if (decision.allowed) {
 *   const closed = market.close(Date.now());
 * } else {
 *   logger.warn('Force-close rejected', { reason: decision.reason });
 * }
 * ```
 */
export type ForceCloseDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'MARKET_ALREADY_CLOSED' | 'MARKET_ALREADY_RESOLVED' };

/**
 * MarketTradingPolicy — статический класс торговой политики
 *
 * @remarks
 * Намеренно реализован как static-only класс.
 * Все методы — чистые функции: без side effects, без мутаций.
 */
export class MarketTradingPolicy {
  private constructor() {
    throw new Error('MarketTradingPolicy is a static utility class and cannot be instantiated');
  }

  /**
   * Возвращает торговое состояние рынка в заданный момент времени
   *
   * @param market - Market entity
   * @param nowMs - Текущее время в миллисекундах
   * @returns TradingState — единственная точка входа для торговых решений
   *
   * @remarks
   * Используйте exhaustive switch для обработки всех случаев.
   * TypeScript гарантирует покрытие при добавлении новых состояний.
   *
   * @example
   * ```typescript
   * const now = Date.now();
   * switch (MarketTradingPolicy.getTradingState(market, now)) {
   *   case 'TRADING':  return orderService.accept(order);
   *   case 'EXPIRED':  return scheduler.scheduleClose(market);
   *   case 'CLOSED':   return resolver.awaitOutcome(market);
   *   case 'RESOLVED': return settlement.process(market);
   * }
   * ```
   */
  public static getTradingState(market: Market, nowMs: number): TradingState {
    if (market.isResolved()) return 'RESOLVED';
    if (market.isClosed()) return 'CLOSED';
    // ACTIVE: делим на TRADING (не истёк) и EXPIRED (истёк)
    return market.isExpiredAt(nowMs) ? 'EXPIRED' : 'TRADING';
  }

  /**
   * Оценивает допустимость досрочного закрытия рынка (admin/dispute action)
   *
   * @param market - Market entity
   * @returns ForceCloseDecision — решение с причиной отказа если недопустимо
   *
   * @remarks
   * Единственный метод без `nowMs` — форс-клоз не зависит от времени.
   * Это исключительная операция: инвалидация рынка, технические сбои.
   * Для стандартного закрытия по expiration проверяйте `getTradingState === 'EXPIRED'`.
   *
   * @example
   * ```typescript
   * const decision = MarketTradingPolicy.evaluateForceClose(market);
   * if (decision.allowed) {
   *   const closed = market.close(Date.now());
   *   await eventBus.publish(closed.pullNotifications());
   * } else {
   *   logger.warn('Force-close rejected', { reason: decision.reason });
   * }
   * ```
   */
  public static evaluateForceClose(market: Market): ForceCloseDecision {
    if (market.isResolved()) return { allowed: false, reason: 'MARKET_ALREADY_RESOLVED' };
    if (market.isClosed()) return { allowed: false, reason: 'MARKET_ALREADY_CLOSED' };
    return { allowed: true };
  }
}
