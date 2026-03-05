/**
 * Доменные события Market entity
 *
 * @remarks
 * События — факты, которые уже произошли в жизненном цикле рынка.
 *
 * ### Notification Events (по Fowler):
 * - Именуются в прошедшем времени: MARKET_CLOSED, MARKET_RESOLVED
 * - Содержат минимальный контекст произошедшего
 * - Не содержат команды или запросы — только данные о факте
 * - Реализуют `MarketDomainEvent` — явная маркировка типа
 *
 * ### Отличие от команд:
 * - Команда (`close()`, `resolve()`) — намерение, может выбросить ошибку
 * - Событие — факт, применяется к уже изменившемуся состоянию
 *
 * ### Применение:
 * - `MarketClosedEvent` → application-слой отменяет открытые ордера на рынке
 * - `MarketResolvedEvent` → application-слой рассчитывает P&L и settlement позиций
 *
 * @example
 * ```typescript
 * const closed = market.close(Date.now());
 * const events = closed.pullEvents(); // [MarketClosedEvent]
 * await eventBus.publish(events);
 *
 * // Другой агрегат реагирует:
 * // OrderService.onMarketClosed(event.marketId) → cancel open orders
 * // PortfolioService.onMarketResolved(event.marketId) → settlement
 * ```
 */

import type { MarketId } from '@polymarket/ids';
import type { MarketSlug, OutcomeIndex } from './value-objects/index.js';

/**
 * MarketDomainEvent — base interface для всех доменных событий Market
 *
 * @remarks
 * Явная маркировка notification event.
 * Все поля readonly — события иммутабельны.
 * `occurredAt` обязателен для всех событий (используется для ordering в event bus).
 */
export interface MarketDomainEvent {
  /** Тип события — discriminant для union */
  readonly type: string;
  /** Время события в миллисекундах (Unix timestamp) */
  readonly occurredAt: number;
}

/**
 * MarketClosedEvent — рынок перешёл в состояние CLOSED
 *
 * @remarks
 * Эмитируется при успешном вызове `market.close(nowMs)`.
 * Подписчики: OrderService (отмена открытых ордеров), TradingEngine (stop accepting orders).
 */
export interface MarketClosedEvent extends MarketDomainEvent {
  readonly type: 'MARKET_CLOSED';
  /** Идентификатор рынка */
  readonly marketId: MarketId;
  /** Слаг для логирования и отображения без дополнительного lookup */
  readonly slug: MarketSlug;
  readonly occurredAt: number;
}

/**
 * MarketResolvedEvent — рынок перешёл в состояние RESOLVED с конкретным исходом
 *
 * @remarks
 * Эмитируется при успешном вызове `market.resolve(outcomeIndex, nowMs)`.
 * Подписчики: PortfolioService (settlement позиций, расчёт P&L).
 */
export interface MarketResolvedEvent extends MarketDomainEvent {
  readonly type: 'MARKET_RESOLVED';
  /** Идентификатор рынка */
  readonly marketId: MarketId;
  /** Слаг для логирования и отображения без дополнительного lookup */
  readonly slug: MarketSlug;
  /** Индекс победившего исхода (0 = YES/UP, 1 = NO/DOWN) */
  readonly resolvedOutcomeIndex: OutcomeIndex;
  readonly occurredAt: number;
}

/**
 * MarketEvent — discriminated union всех доменных событий Market
 */
export type MarketEvent = MarketClosedEvent | MarketResolvedEvent;
