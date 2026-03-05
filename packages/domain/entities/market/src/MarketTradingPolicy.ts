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
   * Можно ли закрыть рынок досрочно (admin/dispute action)
   *
   * @param market - Market entity
   * @returns true если рынок ACTIVE (не проверяет expiration)
   *
   * @remarks
   * Единственный метод без `nowMs` — форс-клоз не зависит от времени.
   * Это исключительная операция: инвалидация рынка, технические сбои.
   * Для стандартного закрытия по expiration проверяйте `getTradingState === 'EXPIRED'`.
   *
   * @example
   * ```typescript
   * // Admin override: закрыть до истечения
   * if (MarketTradingPolicy.canForceClose(market)) {
   *   const closed = market.close(Date.now());
   * }
   * ```
   */
  public static canForceClose(market: Market): boolean {
    return market.isActive();
  }
}
