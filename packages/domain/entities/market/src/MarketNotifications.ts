/**
 * Доменные уведомления (Notification Events) Market entity
 *
 * @remarks
 * Это **notification events** по терминологии Fowler — факты, которые уже
 * произошли. Не event-sourcing events: не версионированы, нет apply(),
 * нет replay/rebuild. Назначение — оповещение других агрегатов (outbox pattern).
 *
 * ### Применение:
 * - `MarketClosedNotification` → OrderService отменяет открытые ордера
 * - `MarketResolvedNotification` → PortfolioService рассчитывает P&L и settlement
 *
 * ### Почему НЕТ event sourcing:
 * Market — 3-state FSM (ACTIVE → CLOSED → RESOLVED). Состояние всегда
 * полностью представлено текущим снапшотом. Event sourcing избыточен
 * для такой простой машины состояний.
 *
 * @example
 * ```typescript
 * const closed = market.close(Date.now());
 * const notifications = closed.pullNotifications();
 * // [{ type: 'MARKET_CLOSED', marketId, slug, occurredAt }]
 * await eventBus.publish(notifications);
 * ```
 */

import type { MarketId } from '@polymarket/ids';
import type { MarketSlug, OutcomeIndex } from './value-objects/index.js';

/**
 * MarketNotification — base interface всех доменных уведомлений Market
 *
 * @remarks
 * Явная маркировка notification (не event-sourcing event).
 * `occurredAt` обязателен — используется для упорядочивания в event bus.
 */
interface MarketNotificationBase {
  /** Тип уведомления — discriminant для union */
  readonly type: string;
  /** Время события в миллисекундах (Unix timestamp) */
  readonly occurredAt: number;
}

/**
 * MarketClosedNotification — рынок перешёл в состояние CLOSED
 *
 * @remarks
 * Эмитируется при успешном вызове `market.close(nowMs)`.
 * Подписчики: OrderService (отмена ордеров), TradingEngine (stop accepting).
 */
export interface MarketClosedNotification extends MarketNotificationBase {
  readonly type: 'MARKET_CLOSED';
  /** Идентификатор рынка */
  readonly marketId: MarketId;
  /** Слаг для логирования без дополнительного lookup */
  readonly slug: MarketSlug;
  readonly occurredAt: number;
}

/**
 * MarketResolvedNotification — рынок перешёл в состояние RESOLVED
 *
 * @remarks
 * Эмитируется при успешном вызове `market.resolve(outcomeIndex, nowMs)`.
 * Подписчики: PortfolioService (settlement позиций, расчёт P&L).
 */
export interface MarketResolvedNotification extends MarketNotificationBase {
  readonly type: 'MARKET_RESOLVED';
  /** Идентификатор рынка */
  readonly marketId: MarketId;
  /** Слаг для логирования без дополнительного lookup */
  readonly slug: MarketSlug;
  /** Индекс победившего исхода (0 = YES/UP, 1 = NO/DOWN) */
  readonly resolvedOutcomeIndex: OutcomeIndex;
  readonly occurredAt: number;
}

/**
 * MarketNotification — discriminated union всех уведомлений Market
 */
export type MarketNotification = MarketClosedNotification | MarketResolvedNotification;
