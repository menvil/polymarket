/**
 * MarketTradingPolicy — политика допустимых операций над рынком
 *
 * @remarks
 * Отвечает на вопрос «можно ли выполнить операцию сейчас?»
 *
 * ### Разделение ответственности:
 * - `Market` (entity) — знает FSM-правила: ACTIVE→CLOSED→RESOLVED
 * - `MarketTradingPolicy` — знает бизнес-правила с учётом времени:
 *   когда рынок можно закрыть, когда можно торговать
 *
 * ### Почему expiration не в Market:
 * Market.close() и Market.resolve() выполняют FSM-переход.
 * КОГДА переход допустим по бизнес-правилам — ответственность Policy.
 * Это позволяет форс-клозить рынок (admin action) без изменения entity.
 *
 * ### Правила:
 * - `canTrade`: рынок ACTIVE + не истёк → можно торговать
 * - `canClose`: рынок ACTIVE + истёк → пора закрывать (стандартный lifecycle)
 * - `canForceClose`: рынок ACTIVE → можно закрыть (admin, dispute, emergency)
 * - `canResolve`: рынок CLOSED → можно разрешить
 *
 * @example
 * ```typescript
 * const now = Date.now();
 *
 * if (MarketTradingPolicy.canTrade(market, now)) {
 *   await orderService.submit(order);
 * }
 *
 * if (MarketTradingPolicy.canClose(market, now)) {
 *   const closed = market.close(now);
 *   await eventBus.publish(closed.pullEvents());
 * }
 * ```
 */

import { Market } from './Market.js';

/**
 * MarketTradingPolicy — статический класс для проверки бизнес-правил операций
 *
 * @remarks
 * Намеренно реализован как static-only класс.
 * Все методы — чистые функции: принимают Market + nowMs, возвращают boolean.
 */
export class MarketTradingPolicy {
  private constructor() {
    throw new Error('MarketTradingPolicy is a static utility class and cannot be instantiated');
  }

  /**
   * Можно ли торговать на рынке прямо сейчас
   *
   * @param market - Market entity
   * @param nowMs - Текущее время в миллисекундах
   * @returns true если рынок ACTIVE и ещё не истёк
   *
   * @example
   * ```typescript
   * if (MarketTradingPolicy.canTrade(market, Date.now())) {
   *   await submitOrder(order);
   * }
   * ```
   */
  public static canTrade(market: Market, nowMs: number): boolean {
    return market.isActive() && !market.isExpiredAt(nowMs);
  }

  /**
   * Можно ли закрыть рынок (стандартный lifecycle — после истечения)
   *
   * @param market - Market entity
   * @param nowMs - Текущее время в миллисекундах
   * @returns true если рынок ACTIVE и уже истёк
   *
   * @remarks
   * Стандартный close — только когда рынок истёк.
   * Для досрочного закрытия (admin/dispute) используйте `canForceClose`.
   *
   * @example
   * ```typescript
   * if (MarketTradingPolicy.canClose(market, Date.now())) {
   *   const closed = market.close(Date.now());
   * }
   * ```
   */
  public static canClose(market: Market, nowMs: number): boolean {
    return market.isActive() && market.isExpiredAt(nowMs);
  }

  /**
   * Можно ли закрыть рынок досрочно (admin/dispute action)
   *
   * @param market - Market entity
   * @returns true если рынок ACTIVE (не истёк — не требуется)
   *
   * @remarks
   * Используется для форс-клоза: инвалидация рынка, технические сбои.
   * Не проверяет expiration — это исключительная ситуация.
   *
   * @example
   * ```typescript
   * if (MarketTradingPolicy.canForceClose(market)) {
   *   const closed = market.close(Date.now());
   * }
   * ```
   */
  public static canForceClose(market: Market): boolean {
    return market.isActive();
  }

  /**
   * Можно ли разрешить рынок
   *
   * @param market - Market entity
   * @returns true если рынок CLOSED
   *
   * @remarks
   * Resolve возможен только после close.
   * FSM-инвариант: CLOSED → RESOLVED.
   *
   * @example
   * ```typescript
   * if (MarketTradingPolicy.canResolve(market)) {
   *   const resolved = market.resolve(winnerIndex, Date.now());
   * }
   * ```
   */
  public static canResolve(market: Market): boolean {
    return market.isClosed();
  }
}
